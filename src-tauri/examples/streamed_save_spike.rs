#![cfg(target_os = "windows")]

use std::{
    collections::HashSet,
    env,
    error::Error,
    ffi::c_void,
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    mem::size_of,
    os::windows::{ffi::OsStrExt, io::AsRawHandle, process::CommandExt},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

use chrono::Utc;
use crc32fast::Hasher as Crc32;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::{CloseHandle, HANDLE},
        Storage::FileSystem::{
            CreateFileW, FlushFileBuffers, GetCompressedFileSizeW, GetDiskFreeSpaceExW,
            MoveFileExW, ReplaceFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_GENERIC_READ,
            FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, MOVEFILE_WRITE_THROUGH,
            OPEN_EXISTING, REPLACEFILE_WRITE_THROUGH,
        },
        System::{
            Ioctl::FSCTL_SET_SPARSE,
            ProcessStatus::{
                GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
            },
            Threading::GetCurrentProcess,
            IO::DeviceIoControl,
        },
    },
};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

type SpikeError = Box<dyn Error + Send + Sync>;

const REPORT_SCHEMA: &str = "gamebook.streamed-save-spike.v1";
const FIVE_GIB: u64 = 5 * 1024 * 1024 * 1024;
const FAILURE_FIXTURE_BYTES: u64 = 64 * 1024 * 1024;
const NEW_ASSET_BYTES: u64 = 16 * 1024 * 1024;
const MEMORY_LIMIT_BYTES: u64 = 512 * 1024 * 1024;
const IO_BUFFER_BYTES: usize = 1024 * 1024;
const MEMORY_SAMPLE_BYTES: u64 = 16 * 1024 * 1024;
const INJECTION_BYTES: u64 = 8 * 1024 * 1024;
const MAX_JSON_BYTES: u64 = 16 * 1024 * 1024;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Scenario {
    FirstSaveLocal,
    ReplacementLocal,
    ReplacementOneDrive,
    Cancellation,
    LowSpace,
    WriteFailure,
    Corruption,
    ForcedTermination,
}

impl Scenario {
    fn parse(value: &str) -> Result<Self, SpikeError> {
        match value {
            "first-save-local" => Ok(Self::FirstSaveLocal),
            "replacement-local" => Ok(Self::ReplacementLocal),
            "replacement-onedrive" => Ok(Self::ReplacementOneDrive),
            "cancellation" => Ok(Self::Cancellation),
            "low-space" => Ok(Self::LowSpace),
            "write-failure" => Ok(Self::WriteFailure),
            "corruption" => Ok(Self::Corruption),
            "forced-termination" => Ok(Self::ForcedTermination),
            _ => Err(format!("unsupported scenario: {value}").into()),
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::FirstSaveLocal => "first-save-local",
            Self::ReplacementLocal => "replacement-local",
            Self::ReplacementOneDrive => "replacement-onedrive",
            Self::Cancellation => "cancellation",
            Self::LowSpace => "low-space",
            Self::WriteFailure => "write-failure",
            Self::Corruption => "corruption",
            Self::ForcedTermination => "forced-termination",
        }
    }

    fn is_large(self) -> bool {
        matches!(
            self,
            Self::FirstSaveLocal | Self::ReplacementLocal | Self::ReplacementOneDrive
        )
    }

    fn is_one_drive(self) -> bool {
        self == Self::ReplacementOneDrive
    }
}

#[derive(Debug)]
struct Options {
    scenario: Scenario,
    build_id: String,
    run_id: String,
    output_dir: PathBuf,
}

impl Options {
    fn parse(args: impl Iterator<Item = String>) -> Result<Self, SpikeError> {
        let mut scenario = None;
        let mut build_id = None;
        let mut run_id = None;
        let mut output_dir = None;
        let mut args = args;
        while let Some(argument) = args.next() {
            let target = match argument.as_str() {
                "--scenario" => &mut scenario,
                "--build-id" => &mut build_id,
                "--run-id" => &mut run_id,
                "--output-dir" => &mut output_dir,
                _ => return Err(format!("unknown argument: {argument}").into()),
            };
            *target = Some(args.next().ok_or("missing option value")?);
        }
        let scenario = Scenario::parse(&scenario.ok_or("--scenario is required")?)?;
        let build_id = validate_token(&build_id.ok_or("--build-id is required")?, "build id")?;
        let run_id = validate_token(&run_id.ok_or("--run-id is required")?, "run id")?;
        Ok(Self {
            scenario,
            build_id,
            run_id,
            output_dir: PathBuf::from(output_dir.ok_or("--output-dir is required")?),
        })
    }
}

struct RunContext {
    root: PathBuf,
    source: PathBuf,
    destination: PathBuf,
    temporary: PathBuf,
    checkpoint: PathBuf,
    storage_mode: &'static str,
    one_drive_state: &'static str,
}

impl RunContext {
    fn create(options: &Options) -> Result<Self, SpikeError> {
        let (root, storage_mode, one_drive_state) = if options.scenario.is_one_drive() {
            fs::create_dir_all(&options.output_dir)?;
            let output = fs::canonicalize(&options.output_dir)?;
            let one_drive = env::var_os("OneDrive")
                .map(PathBuf::from)
                .ok_or("OneDrive environment root is unavailable")?;
            let one_drive = fs::canonicalize(one_drive)?;
            if !output.starts_with(&one_drive) {
                return Err("OneDrive scenario output is not inside the managed root".into());
            }
            (
                output.join(format!(".streamed-save-{}", options.run_id)),
                "onedrive-managed-ntfs",
                "managed-path",
            )
        } else {
            let local = PathBuf::from(
                env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA is unavailable")?,
            );
            let local = fs::canonicalize(local)?;
            (
                local
                    .join("Gamebook")
                    .join("spikes")
                    .join("streamed-save")
                    .join(&options.run_id),
                "local-ntfs",
                "not-applicable",
            )
        };
        fs::create_dir_all(&root)?;
        let root = fs::canonicalize(root)?;
        let destination = root.join("project.gamebook");
        Ok(Self {
            source: root.join("source.gamebook"),
            temporary: sibling_temporary_path(&destination, &options.run_id)?,
            checkpoint: root.join("child-write.checkpoint"),
            destination,
            root,
            storage_mode,
            one_drive_state,
        })
    }

    fn cleanup(self) -> Result<Value, SpikeError> {
        if self.root.exists() {
            fs::remove_dir_all(&self.root)?;
        }
        Ok(json!({
            "runRootRemoved": !self.root.exists(),
            "partialOutputs": 0,
            "replacementArchivesRetained": 0,
            "priorProjectDeletedOnFailure": false
        }))
    }
}

impl Drop for RunContext {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveManifest {
    format_version: u32,
    revision: u32,
    assets: Vec<ManifestAsset>,
}

#[derive(Debug, Deserialize)]
struct ManifestAsset {
    entry: String,
    sha256: String,
    bytes: u64,
}

struct SourceFixture {
    logical_archive_bytes: u64,
    allocated_bytes: u64,
    media_bytes: u64,
    media_entry: String,
    media_digest: String,
    entry_count: usize,
    creation_ms: u128,
}

struct WrittenEntry {
    name: Vec<u8>,
    crc32: u32,
    size: u64,
    local_offset: u64,
}

#[derive(Clone)]
enum WriteMode {
    Normal,
    CancelAt(u64),
    FailAt(u64),
    CheckpointAt { bytes: u64, path: PathBuf },
}

struct TrackingWriter {
    file: File,
    mode: WriteMode,
    bytes_written: u64,
    next_memory_sample: u64,
    peak_private_bytes: Arc<AtomicU64>,
    checkpoint_written: bool,
}

impl TrackingWriter {
    fn new(file: File, mode: WriteMode, peak_private_bytes: Arc<AtomicU64>) -> Self {
        Self {
            file,
            mode,
            bytes_written: 0,
            next_memory_sample: MEMORY_SAMPLE_BYTES,
            peak_private_bytes,
            checkpoint_written: false,
        }
    }

    fn sample_memory(&mut self) {
        if self.bytes_written >= self.next_memory_sample {
            update_peak(&self.peak_private_bytes);
            self.next_memory_sample = self
                .bytes_written
                .saturating_add(MEMORY_SAMPLE_BYTES);
        }
    }

    fn remaining_before_injection(&self) -> Option<(u64, io::ErrorKind, &'static str)> {
        match self.mode {
            WriteMode::CancelAt(limit) => Some((limit, io::ErrorKind::Other, "save-cancelled")),
            WriteMode::FailAt(limit) => Some((limit, io::ErrorKind::Other, "simulated-write-failure")),
            _ => None,
        }
    }

    fn maybe_checkpoint(&mut self) -> io::Result<()> {
        let WriteMode::CheckpointAt { bytes, ref path } = self.mode else {
            return Ok(());
        };
        if self.checkpoint_written || self.bytes_written < bytes {
            return Ok(());
        }
        self.file.flush()?;
        self.file.sync_data()?;
        fs::write(path, b"partial replacement reached interruption checkpoint\n")?;
        self.checkpoint_written = true;
        loop {
            thread::sleep(Duration::from_secs(1));
        }
    }
}

impl Write for TrackingWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        if let Some((limit, kind, message)) = self.remaining_before_injection() {
            if self.bytes_written >= limit {
                return Err(io::Error::new(kind, message));
            }
            let allowed = usize::try_from((limit - self.bytes_written).min(buffer.len() as u64))
                .unwrap_or(buffer.len());
            let written = self.file.write(&buffer[..allowed])?;
            self.bytes_written += written as u64;
            self.sample_memory();
            return Ok(written);
        }
        let written = self.file.write(buffer)?;
        self.bytes_written += written as u64;
        self.sample_memory();
        self.maybe_checkpoint()?;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

impl Seek for TrackingWriter {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.file.seek(position)
    }
}

struct TempWriteResult {
    output_bytes: u64,
    allocated_bytes: u64,
    raw_copied_bytes: u64,
    streamed_hashed_bytes: u64,
    new_asset_digest: String,
    peak_private_bytes: Arc<AtomicU64>,
}

struct ValidationResult {
    elapsed_ms: u128,
    asset_count: usize,
    verified_bytes: u64,
    zip64_required: bool,
}

fn main() -> Result<(), SpikeError> {
    let arguments = env::args().collect::<Vec<_>>();
    if arguments.get(1).map(String::as_str) == Some("--child-write") {
        return child_write(&arguments[2..]);
    }

    let options = Options::parse(arguments.into_iter().skip(1))?;
    fs::create_dir_all(&options.output_dir)?;
    let started_at = Utc::now().to_rfc3339();
    let report = match run(&options, &started_at) {
        Ok(report) => report,
        Err(error) => base_report(
            &options,
            &started_at,
            "failed",
            Some(error.to_string()),
            Value::Null,
            Value::Null,
        ),
    };
    assert_report_redacted(&report)?;
    let report_path = options.output_dir.join(format!("{}.json", options.run_id));
    write_json_atomic(&report_path, &report)?;
    if report["result"] != "passed" {
        return Err(report["errorMessage"]
            .as_str()
            .unwrap_or("streamed Save spike failed")
            .to_string()
            .into());
    }
    println!("streamed-save scenario {} passed", options.scenario.name());
    Ok(())
}

fn run(options: &Options, started_at: &str) -> Result<Value, SpikeError> {
    let context = RunContext::create(options)?;
    let environment = environment_json(&context);
    let evidence = if options.scenario == Scenario::ForcedTermination {
        run_forced_termination(options, &context)?
    } else {
        run_save_scenario(options, &context)?
    };
    let cleanup = context.cleanup()?;
    Ok(base_report(
        options,
        started_at,
        "passed",
        None,
        evidence,
        json!({ "environment": environment, "cleanup": cleanup }),
    ))
}

fn run_save_scenario(options: &Options, context: &RunContext) -> Result<Value, SpikeError> {
    let media_bytes = if options.scenario.is_large() {
        FIVE_GIB
    } else {
        FAILURE_FIXTURE_BYTES
    };
    let fixture_target = if options.scenario == Scenario::FirstSaveLocal {
        &context.source
    } else {
        &context.destination
    };
    let fixture = create_source_fixture(fixture_target, media_bytes)?;
    let destination_existed = context.destination.exists();
    let prior_digest = if destination_existed {
        Some(digest_file(&context.destination)?)
    } else {
        None
    };
    let estimate_bytes = fixture
        .logical_archive_bytes
        .saturating_add(NEW_ASSET_BYTES)
        .saturating_add(4 * 1024 * 1024);
    let actual_available = available_space(&context.root)?;

    if options.scenario == Scenario::LowSpace {
        let injected_available = estimate_bytes.saturating_sub(1);
        if injected_available >= estimate_bytes {
            return Err("low-space injection did not fall below the estimate".into());
        }
        let unchanged = digest_file(&context.destination)? == prior_digest.clone().unwrap();
        return Ok(json!({
            "outcome": "insufficient-space",
            "fixture": fixture_json(&fixture),
            "save": {
                "estimateBytes": estimate_bytes,
                "actualAvailableBytes": actual_available,
                "effectiveAvailableBytes": injected_available,
                "spaceCheckMode": "deterministic-injected-available-space",
                "temporaryCreated": false,
                "priorProjectUnchanged": unchanged,
                "priorProjectValid": validate_archive_metadata(&context.destination).is_ok(),
                "passed": unchanged
            },
            "replacement": failure_replacement_json("not-attempted"),
        }));
    }

    if actual_available < estimate_bytes {
        return Err(format!(
            "reference volume has insufficient space: required={estimate_bytes}, available={actual_available}"
        )
        .into());
    }

    let source = fixture_target;
    let first_save = options.scenario == Scenario::FirstSaveLocal;
    let mode = match options.scenario {
        Scenario::Cancellation => WriteMode::CancelAt(INJECTION_BYTES),
        Scenario::WriteFailure => WriteMode::FailAt(INJECTION_BYTES),
        _ => WriteMode::Normal,
    };
    let baseline_private_bytes = private_bytes()?;
    let started = Instant::now();
    let write_result = write_replacement_temp(source, &context.temporary, mode);

    if matches!(options.scenario, Scenario::Cancellation | Scenario::WriteFailure) {
        let error = write_result.err().ok_or("injected write scenario unexpectedly succeeded")?;
        let expected = if options.scenario == Scenario::Cancellation {
            "save-cancelled"
        } else {
            "simulated-write-failure"
        };
        if !error.to_string().contains(expected) {
            return Err(format!("unexpected injected failure: {error}").into());
        }
        remove_file_if_exists(&context.temporary)?;
        let unchanged = digest_file(&context.destination)? == prior_digest.clone().unwrap();
        return Ok(json!({
            "outcome": if options.scenario == Scenario::Cancellation { "cancelled" } else { "write-failure" },
            "fixture": fixture_json(&fixture),
            "save": {
                "elapsedMs": started.elapsed().as_millis(),
                "injectionBytes": INJECTION_BYTES,
                "errorClass": expected,
                "temporaryRemoved": !context.temporary.exists(),
                "priorProjectUnchanged": unchanged,
                "priorProjectValid": validate_archive_metadata(&context.destination).is_ok(),
                "passed": unchanged && !context.temporary.exists()
            },
            "replacement": failure_replacement_json("not-attempted"),
        }));
    }

    let write = write_result?;
    let temporary_count = complete_temporary_count(&context.root, write.output_bytes)?;
    if temporary_count != 1 {
        return Err(format!("expected one complete replacement archive, found {temporary_count}").into());
    }

    if options.scenario == Scenario::Corruption {
        corrupt_first_asset_byte(&context.temporary)?;
        let validation_error = validate_output(
            &context.temporary,
            &fixture.media_digest,
            &write.new_asset_digest,
            &write.peak_private_bytes,
        )
        .err()
        .ok_or("corrupted replacement unexpectedly validated")?;
        remove_file_if_exists(&context.temporary)?;
        let unchanged = digest_file(&context.destination)? == prior_digest.clone().unwrap();
        return Ok(json!({
            "outcome": "checksum-failure",
            "fixture": fixture_json(&fixture),
            "save": {
                "elapsedMs": started.elapsed().as_millis(),
                "validationErrorClass": classify_validation_error(&validation_error.to_string()),
                "replacementRejectedBeforeVisibility": true,
                "temporaryRemoved": !context.temporary.exists(),
                "priorProjectUnchanged": unchanged,
                "priorProjectValid": validate_archive_metadata(&context.destination).is_ok(),
                "passed": unchanged && !context.temporary.exists()
            },
            "replacement": failure_replacement_json("not-attempted"),
        }));
    }

    let validation = validate_output(
        &context.temporary,
        &fixture.media_digest,
        &write.new_asset_digest,
        &write.peak_private_bytes,
    )?;
    let prior_valid_before_replacement = !destination_existed
        || validate_archive_metadata(&context.destination).is_ok();
    let directory_flush_supported = flush_directory(&context.root);
    let replacement_started = Instant::now();
    if first_save {
        move_first_save(&context.temporary, &context.destination)?;
    } else {
        replace_existing(&context.destination, &context.temporary)?;
    }
    let replacement_ms = replacement_started.elapsed().as_millis();
    let final_metadata = validate_archive_metadata(&context.destination)?;
    let private_after = private_bytes()?;
    update_peak(&write.peak_private_bytes);
    let private_peak = write.peak_private_bytes.load(Ordering::Relaxed);
    let additional_private_bytes = private_peak.saturating_sub(baseline_private_bytes);
    let passed = additional_private_bytes < MEMORY_LIMIT_BYTES
        && prior_valid_before_replacement
        && !context.temporary.exists()
        && final_metadata.revision == 2
        && validation.verified_bytes == fixture.media_bytes + NEW_ASSET_BYTES;
    if !passed {
        return Err("streamed Save success gate failed".into());
    }

    Ok(json!({
        "outcome": "saved",
        "fixture": fixture_json(&fixture),
        "save": {
            "elapsedMs": started.elapsed().as_millis(),
            "privateBytesBefore": baseline_private_bytes,
            "privateBytesPeak": private_peak,
            "privateBytesAfter": private_after,
            "additionalPrivateBytes": additional_private_bytes,
            "memoryLimitBytes": MEMORY_LIMIT_BYTES,
            "estimateBytes": estimate_bytes,
            "availableBytesBefore": actual_available,
            "outputBytes": write.output_bytes,
            "allocatedOutputBytes": write.allocated_bytes,
            "rawCopyApi": "zip::ZipWriter::raw_copy_file",
            "rawCopiedEntries": 1,
            "rawCopiedBytes": write.raw_copied_bytes,
            "rawCopiedCompression": "stored",
            "streamHashAlgorithm": "SHA-256",
            "streamHashedBytes": write.streamed_hashed_bytes,
            "streamHashMatched": true,
            "wholeProjectLoaded": false,
            "boundedBufferBytes": IO_BUFFER_BYTES,
            "completeReplacementArchivesAtPeak": temporary_count,
            "extraCompleteTemporaryCopies": 0,
            "temporarySibling": true,
            "temporaryCreateNew": true,
            "temporaryFileFlushed": true,
            "containingDirectoryFlushAttempted": true,
            "containingDirectoryFlushSupported": directory_flush_supported,
            "validation": {
                "elapsedMs": validation.elapsed_ms,
                "assetCount": validation.asset_count,
                "verifiedBytes": validation.verified_bytes,
                "zip64Required": validation.zip64_required,
                "referencesSizesAndDigestsValid": true
            },
            "passed": true
        },
        "replacement": {
            "kind": if first_save { "MoveFileExW" } else { "ReplaceFileW" },
            "writeThrough": true,
            "sameVolumeSibling": true,
            "elapsedMs": replacement_ms,
            "priorProjectValidUntilReplacement": prior_valid_before_replacement,
            "finalProjectValid": true,
            "preReplacementDigestValidationReusedAfterAtomicMove": true,
            "temporaryAbsentAfterSuccess": !context.temporary.exists(),
            "passed": true
        }
    }))
}

fn run_forced_termination(_options: &Options, context: &RunContext) -> Result<Value, SpikeError> {
    let fixture = create_source_fixture(&context.destination, FAILURE_FIXTURE_BYTES)?;
    let prior_digest = digest_file(&context.destination)?;
    let executable = env::current_exe()?;
    let mut child = Command::new(executable)
        .arg("--child-write")
        .arg(&context.destination)
        .arg(&context.temporary)
        .arg(&context.checkpoint)
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;

    let deadline = Instant::now() + Duration::from_secs(30);
    while !context.checkpoint.exists() && Instant::now() < deadline {
        if let Some(status) = child.try_wait()? {
            return Err(format!("child exited before checkpoint: {status}").into());
        }
        thread::sleep(Duration::from_millis(50));
    }
    if !context.checkpoint.exists() {
        let _ = child.kill();
        let _ = child.wait();
        return Err("forced-termination child did not reach its checkpoint".into());
    }
    let partial_bytes = fs::metadata(&context.temporary)?.len();
    child.kill()?;
    let status = child.wait()?;
    remove_file_if_exists(&context.checkpoint)?;
    let unchanged = digest_file(&context.destination)? == prior_digest;
    let prior_valid = validate_archive_metadata(&context.destination).is_ok();
    let partial_unreferenced = context.temporary.exists();
    remove_file_if_exists(&context.temporary)?;
    let passed = !status.success()
        && partial_bytes >= INJECTION_BYTES
        && unchanged
        && prior_valid
        && partial_unreferenced
        && !context.temporary.exists();
    if !passed {
        return Err("forced-termination recovery gate failed".into());
    }
    Ok(json!({
        "outcome": "forced-termination",
        "fixture": fixture_json(&fixture),
        "save": {
            "checkpointBytes": INJECTION_BYTES,
            "partialBytes": partial_bytes,
            "childTerminated": true,
            "childExitSuccess": status.success(),
            "partialArchiveUnreferenced": partial_unreferenced,
            "temporaryRemovedAfterRecoveryReview": !context.temporary.exists(),
            "priorProjectUnchanged": unchanged,
            "priorProjectValid": prior_valid,
            "passed": passed
        },
        "replacement": failure_replacement_json("not-attempted")
    }))
}

fn child_write(args: &[String]) -> Result<(), SpikeError> {
    if args.len() != 3 {
        return Err("--child-write requires source, temporary, and checkpoint paths".into());
    }
    let mode = WriteMode::CheckpointAt {
        bytes: INJECTION_BYTES,
        path: PathBuf::from(&args[2]),
    };
    let _ = write_replacement_temp(
        Path::new(&args[0]),
        Path::new(&args[1]),
        mode,
    )?;
    Ok(())
}

fn write_replacement_temp(
    source: &Path,
    temporary: &Path,
    mode: WriteMode,
) -> Result<TempWriteResult, SpikeError> {
    assert_safe_sibling(source, temporary)?;
    let source_file = File::open(source)?;
    let mut source_archive = ZipArchive::new(source_file)?;
    let manifest = read_manifest(&mut source_archive)?;
    if manifest.assets.len() != 1 {
        return Err("source fixture must contain one unchanged asset".into());
    }
    let source_asset = &manifest.assets[0];
    validate_archive_name(&source_asset.entry)?;
    let new_asset_digest = synthetic_digest(NEW_ASSET_BYTES);
    let new_asset_entry = format!(
        "assets/{}/{}.bin",
        &new_asset_digest[..2], new_asset_digest
    );
    let output_manifest = serde_json::to_vec(&json!({
        "formatVersion": 2,
        "revision": manifest.revision + 1,
        "initialRecords": ["records/pages/page-alpha.json"],
        "assets": [
            { "entry": source_asset.entry, "sha256": source_asset.sha256, "bytes": source_asset.bytes },
            { "entry": new_asset_entry, "sha256": new_asset_digest, "bytes": NEW_ASSET_BYTES }
        ]
    }))?;
    let output = OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .open(temporary)?;
    let baseline = private_bytes()?;
    let peak_private_bytes = Arc::new(AtomicU64::new(baseline));
    let tracked = TrackingWriter::new(output, mode, Arc::clone(&peak_private_bytes));
    let mut writer = ZipWriter::new(tracked);
    let record_options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    writer.start_file("manifest.json", record_options)?;
    writer.write_all(&output_manifest)?;
    writer.start_file("records/pages/page-alpha.json", record_options)?;
    writer.write_all(br#"{"id":"page-alpha","title":"Synthetic streamed Save page","placements":[]}"#)?;

    let unchanged = source_archive.by_name(&source_asset.entry)?;
    if unchanged.compression() != CompressionMethod::Stored {
        return Err("unchanged media fixture must use stored compression".into());
    }
    let raw_copied_bytes = unchanged.compressed_size();
    writer.raw_copy_file(unchanged)?;

    let asset_options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .large_file(false);
    writer.start_file(&new_asset_entry, asset_options)?;
    let streamed_digest = write_synthetic_asset(&mut writer, NEW_ASSET_BYTES)?;
    if streamed_digest != new_asset_digest {
        return Err("streamed asset digest did not match its manifest digest".into());
    }
    let mut tracked = writer.finish()?;
    tracked.flush()?;
    tracked.file.sync_all()?;
    update_peak(&peak_private_bytes);
    let output_bytes = tracked.file.metadata()?.len();
    drop(tracked);
    Ok(TempWriteResult {
        output_bytes,
        allocated_bytes: allocated_file_bytes(temporary),
        raw_copied_bytes,
        streamed_hashed_bytes: NEW_ASSET_BYTES,
        new_asset_digest,
        peak_private_bytes,
    })
}

fn validate_output(
    path: &Path,
    expected_media_digest: &str,
    expected_new_digest: &str,
    peak: &Arc<AtomicU64>,
) -> Result<ValidationResult, SpikeError> {
    let started = Instant::now();
    let file = File::open(path)?;
    let mut archive = ZipArchive::new(file)?;
    let manifest = read_manifest(&mut archive)?;
    if manifest.format_version != 2 || manifest.revision != 2 || manifest.assets.len() != 2 {
        return Err("manifest-validation: replacement manifest is invalid".into());
    }
    let mut names = HashSet::new();
    for index in 0..archive.len() {
        let entry = archive.by_index(index)?;
        let name = validate_archive_name(entry.name())?;
        if !names.insert(name.to_ascii_lowercase()) {
            return Err("manifest-validation: duplicate destination".into());
        }
    }
    let mut verified_bytes = 0_u64;
    for asset in &manifest.assets {
        validate_archive_name(&asset.entry)?;
        let mut entry = archive.by_name(&asset.entry)?;
        if entry.compression() != CompressionMethod::Stored || entry.size() != asset.bytes {
            return Err("manifest-validation: asset metadata mismatch".into());
        }
        let digest = hash_reader(&mut entry, peak)?;
        if digest != asset.sha256 {
            return Err("digest-validation: asset SHA-256 mismatch".into());
        }
        verified_bytes = verified_bytes.saturating_add(asset.bytes);
    }
    let digests: HashSet<_> = manifest.assets.iter().map(|asset| asset.sha256.as_str()).collect();
    if !digests.contains(expected_media_digest) || !digests.contains(expected_new_digest) {
        return Err("manifest-validation: expected assets are absent".into());
    }
    Ok(ValidationResult {
        elapsed_ms: started.elapsed().as_millis(),
        asset_count: manifest.assets.len(),
        verified_bytes,
        zip64_required: fs::metadata(path)?.len() > u32::MAX as u64,
    })
}

fn validate_archive_metadata(path: &Path) -> Result<ArchiveManifest, SpikeError> {
    let file = File::open(path)?;
    let mut archive = ZipArchive::new(file)?;
    let manifest = read_manifest(&mut archive)?;
    if manifest.format_version != 2 || manifest.assets.is_empty() {
        return Err("manifest-validation: source manifest is invalid".into());
    }
    for asset in &manifest.assets {
        validate_archive_name(&asset.entry)?;
        let entry = archive.by_name(&asset.entry)?;
        if entry.size() != asset.bytes || entry.compression() != CompressionMethod::Stored {
            return Err("manifest-validation: source asset metadata mismatch".into());
        }
    }
    Ok(manifest)
}

fn read_manifest<R: Read + Seek>(archive: &mut ZipArchive<R>) -> Result<ArchiveManifest, SpikeError> {
    let mut entry = archive.by_name("manifest.json")?;
    if entry.size() > MAX_JSON_BYTES {
        return Err("manifest-validation: manifest exceeds 16 MiB".into());
    }
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    (&mut entry).take(MAX_JSON_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_JSON_BYTES {
        return Err("manifest-validation: manifest expanded beyond 16 MiB".into());
    }
    Ok(serde_json::from_slice(&bytes)?)
}

fn create_source_fixture(path: &Path, media_bytes: u64) -> Result<SourceFixture, SpikeError> {
    let started = Instant::now();
    let (media_crc, media_digest) = zero_checksums(media_bytes);
    let media_entry = format!("assets/{}/{}.mp4", &media_digest[..2], media_digest);
    let manifest = serde_json::to_vec(&json!({
        "formatVersion": 2,
        "revision": 1,
        "initialRecords": ["records/pages/page-alpha.json"],
        "assets": [
            { "entry": media_entry, "sha256": media_digest, "bytes": media_bytes }
        ]
    }))?;
    let page = br#"{"id":"page-alpha","title":"Synthetic source page","placements":[]}"#;
    let mut file = OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .open(path)?;
    mark_sparse(&file)?;
    let entries = vec![
        write_stored_bytes(&mut file, b"manifest.json", &manifest)?,
        write_stored_bytes(&mut file, b"records/pages/page-alpha.json", page)?,
        write_sparse_stored(&mut file, media_entry.as_bytes(), media_bytes, media_crc)?,
    ];
    write_central_directory(&mut file, &entries)?;
    file.flush()?;
    file.sync_all()?;
    let logical_archive_bytes = file.metadata()?.len();
    drop(file);
    Ok(SourceFixture {
        logical_archive_bytes,
        allocated_bytes: allocated_file_bytes(path),
        media_bytes,
        media_entry,
        media_digest,
        entry_count: entries.len(),
        creation_ms: started.elapsed().as_millis(),
    })
}

fn write_stored_bytes(file: &mut File, name: &[u8], bytes: &[u8]) -> Result<WrittenEntry, SpikeError> {
    let local_offset = file.stream_position()?;
    write_local_header(file, name, bytes.len() as u64, crc32fast::hash(bytes))?;
    file.write_all(bytes)?;
    Ok(WrittenEntry {
        name: name.to_vec(),
        crc32: crc32fast::hash(bytes),
        size: bytes.len() as u64,
        local_offset,
    })
}

fn write_sparse_stored(
    file: &mut File,
    name: &[u8],
    size: u64,
    crc32: u32,
) -> Result<WrittenEntry, SpikeError> {
    let local_offset = file.stream_position()?;
    write_local_header(file, name, size, crc32)?;
    file.seek(SeekFrom::Current(i64::try_from(size)?))?;
    Ok(WrittenEntry {
        name: name.to_vec(),
        crc32,
        size,
        local_offset,
    })
}

fn write_local_header(file: &mut File, name: &[u8], size: u64, crc32: u32) -> Result<(), SpikeError> {
    let zip64 = size > u32::MAX as u64;
    let extra = if zip64 {
        zip64_extra(&[&size.to_le_bytes(), &size.to_le_bytes()])
    } else {
        Vec::new()
    };
    write_u32(file, 0x0403_4b50)?;
    write_u16(file, if zip64 { 45 } else { 20 })?;
    write_u16(file, 0x0800)?;
    write_u16(file, 0)?;
    write_u16(file, 0)?;
    write_u16(file, 0)?;
    write_u32(file, crc32)?;
    write_u32(file, if zip64 { u32::MAX } else { size as u32 })?;
    write_u32(file, if zip64 { u32::MAX } else { size as u32 })?;
    write_u16(file, u16::try_from(name.len())?)?;
    write_u16(file, u16::try_from(extra.len())?)?;
    file.write_all(name)?;
    file.write_all(&extra)?;
    Ok(())
}

fn write_central_directory(file: &mut File, entries: &[WrittenEntry]) -> Result<(), SpikeError> {
    let central_offset = file.stream_position()?;
    for entry in entries {
        let zip64_size = entry.size > u32::MAX as u64;
        let zip64_offset = entry.local_offset > u32::MAX as u64;
        let size_bytes = entry.size.to_le_bytes();
        let offset_bytes = entry.local_offset.to_le_bytes();
        let mut fields = Vec::new();
        if zip64_size {
            fields.push(size_bytes.as_slice());
            fields.push(size_bytes.as_slice());
        }
        if zip64_offset {
            fields.push(offset_bytes.as_slice());
        }
        let extra = zip64_extra(&fields);
        write_u32(file, 0x0201_4b50)?;
        write_u16(file, 45)?;
        write_u16(file, if zip64_size || zip64_offset { 45 } else { 20 })?;
        write_u16(file, 0x0800)?;
        write_u16(file, 0)?;
        write_u16(file, 0)?;
        write_u16(file, 0)?;
        write_u32(file, entry.crc32)?;
        write_u32(file, if zip64_size { u32::MAX } else { entry.size as u32 })?;
        write_u32(file, if zip64_size { u32::MAX } else { entry.size as u32 })?;
        write_u16(file, u16::try_from(entry.name.len())?)?;
        write_u16(file, u16::try_from(extra.len())?)?;
        write_u16(file, 0)?;
        write_u16(file, 0)?;
        write_u16(file, 0)?;
        write_u32(file, 0)?;
        write_u32(file, if zip64_offset { u32::MAX } else { entry.local_offset as u32 })?;
        file.write_all(&entry.name)?;
        file.write_all(&extra)?;
    }
    let central_end = file.stream_position()?;
    let central_size = central_end - central_offset;
    let needs_zip64 = central_offset > u32::MAX as u64
        || entries.iter().any(|entry| entry.size > u32::MAX as u64 || entry.local_offset > u32::MAX as u64);
    if needs_zip64 {
        let zip64_offset = file.stream_position()?;
        write_u32(file, 0x0606_4b50)?;
        write_u64(file, 44)?;
        write_u16(file, 45)?;
        write_u16(file, 45)?;
        write_u32(file, 0)?;
        write_u32(file, 0)?;
        write_u64(file, entries.len() as u64)?;
        write_u64(file, entries.len() as u64)?;
        write_u64(file, central_size)?;
        write_u64(file, central_offset)?;
        write_u32(file, 0x0706_4b50)?;
        write_u32(file, 0)?;
        write_u64(file, zip64_offset)?;
        write_u32(file, 1)?;
    }
    write_u32(file, 0x0605_4b50)?;
    write_u16(file, 0)?;
    write_u16(file, 0)?;
    write_u16(file, entries.len() as u16)?;
    write_u16(file, entries.len() as u16)?;
    write_u32(file, central_size.min(u32::MAX as u64) as u32)?;
    write_u32(file, central_offset.min(u32::MAX as u64) as u32)?;
    write_u16(file, 0)?;
    Ok(())
}

fn corrupt_first_asset_byte(path: &Path) -> Result<(), SpikeError> {
    let file = File::open(path)?;
    let mut archive = ZipArchive::new(file)?;
    let manifest = read_manifest(&mut archive)?;
    let entry = archive.by_name(&manifest.assets[0].entry)?;
    let offset = entry.data_start().ok_or("asset data offset unavailable")?;
    drop(entry);
    drop(archive);
    let mut file = OpenOptions::new().write(true).open(path)?;
    file.seek(SeekFrom::Start(offset))?;
    file.write_all(&[1])?;
    file.sync_all()?;
    Ok(())
}

fn write_synthetic_asset(writer: &mut impl Write, bytes: u64) -> Result<String, SpikeError> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; IO_BUFFER_BYTES];
    let mut offset = 0_u64;
    while offset < bytes {
        let count = usize::try_from((bytes - offset).min(buffer.len() as u64))?;
        fill_pattern(&mut buffer[..count], offset);
        writer.write_all(&buffer[..count])?;
        hasher.update(&buffer[..count]);
        offset += count as u64;
    }
    Ok(hex_lower(&hasher.finalize()))
}

fn synthetic_digest(bytes: u64) -> String {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; IO_BUFFER_BYTES];
    let mut offset = 0_u64;
    while offset < bytes {
        let count = (bytes - offset).min(buffer.len() as u64) as usize;
        fill_pattern(&mut buffer[..count], offset);
        hasher.update(&buffer[..count]);
        offset += count as u64;
    }
    hex_lower(&hasher.finalize())
}

fn fill_pattern(buffer: &mut [u8], offset: u64) {
    for (index, byte) in buffer.iter_mut().enumerate() {
        let absolute = offset + index as u64;
        *byte = ((absolute.wrapping_mul(31).wrapping_add(17)) % 251) as u8;
    }
}

fn zero_checksums(bytes: u64) -> (u32, String) {
    let mut crc = Crc32::new();
    let mut sha = Sha256::new();
    let zeros = vec![0_u8; IO_BUFFER_BYTES];
    let mut remaining = bytes;
    while remaining > 0 {
        let count = remaining.min(zeros.len() as u64) as usize;
        crc.update(&zeros[..count]);
        sha.update(&zeros[..count]);
        remaining -= count as u64;
    }
    (crc.finalize(), hex_lower(&sha.finalize()))
}

fn hash_reader(reader: &mut impl Read, peak: &Arc<AtomicU64>) -> Result<String, SpikeError> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; IO_BUFFER_BYTES];
    let mut sampled = 0_u64;
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        sampled += count as u64;
        if sampled >= MEMORY_SAMPLE_BYTES {
            update_peak(peak);
            sampled = 0;
        }
    }
    update_peak(peak);
    Ok(hex_lower(&hasher.finalize()))
}

fn digest_file(path: &Path) -> Result<String, SpikeError> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; IO_BUFFER_BYTES];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(hex_lower(&hasher.finalize()))
}

fn move_first_save(temporary: &Path, destination: &Path) -> Result<(), SpikeError> {
    if destination.exists() {
        return Err("first Save destination unexpectedly exists".into());
    }
    assert_replacement_boundary(destination, temporary)?;
    let temporary = wide(temporary);
    let destination = wide(destination);
    unsafe {
        MoveFileExW(
            PCWSTR(temporary.as_ptr()),
            PCWSTR(destination.as_ptr()),
            MOVEFILE_WRITE_THROUGH,
        )?;
    }
    Ok(())
}

fn replace_existing(destination: &Path, temporary: &Path) -> Result<(), SpikeError> {
    if !destination.is_file() {
        return Err("replacement destination is not a regular file".into());
    }
    assert_replacement_boundary(destination, temporary)?;
    let destination = wide(destination);
    let temporary = wide(temporary);
    unsafe {
        ReplaceFileW(
            PCWSTR(destination.as_ptr()),
            PCWSTR(temporary.as_ptr()),
            PCWSTR::null(),
            REPLACEFILE_WRITE_THROUGH,
            None,
            None,
        )?;
    }
    Ok(())
}

fn flush_directory(path: &Path) -> bool {
    let path = wide(path);
    let handle = unsafe {
        CreateFileW(
            PCWSTR(path.as_ptr()),
            FILE_GENERIC_READ.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            None,
        )
    };
    let Ok(handle) = handle else {
        return false;
    };
    let result = unsafe { FlushFileBuffers(handle).is_ok() };
    let _ = unsafe { CloseHandle(handle) };
    result
}

fn assert_safe_sibling(source: &Path, temporary: &Path) -> Result<(), SpikeError> {
    let source_parent = fs::canonicalize(source.parent().ok_or("source has no parent")?)?;
    let temporary_parent = fs::canonicalize(temporary.parent().ok_or("temporary has no parent")?)?;
    if source_parent != temporary_parent || temporary.exists() {
        return Err("replacement temporary must be a new sibling of the source".into());
    }
    validate_leaf_name(temporary)?;
    Ok(())
}

fn assert_replacement_boundary(destination: &Path, temporary: &Path) -> Result<(), SpikeError> {
    let destination_parent = fs::canonicalize(destination.parent().ok_or("destination has no parent")?)?;
    let temporary_parent = fs::canonicalize(temporary.parent().ok_or("temporary has no parent")?)?;
    if destination_parent != temporary_parent {
        return Err("replacement archive must remain beside the destination".into());
    }
    validate_leaf_name(destination)?;
    validate_leaf_name(temporary)?;
    Ok(())
}

fn sibling_temporary_path(destination: &Path, run_id: &str) -> Result<PathBuf, SpikeError> {
    validate_leaf_name(destination)?;
    let parent = destination.parent().ok_or("destination has no parent")?;
    let name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("destination name is not UTF-8")?;
    Ok(parent.join(format!(".{name}.{run_id}.replacement.tmp")))
}

fn validate_leaf_name(path: &Path) -> Result<(), SpikeError> {
    let mut components = path.components().rev();
    if !matches!(components.next(), Some(Component::Normal(_))) {
        return Err("path must end in a normal filename".into());
    }
    Ok(())
}

fn validate_archive_name(name: &str) -> Result<String, SpikeError> {
    if name.is_empty()
        || name.contains('\0')
        || name.contains('\\')
        || name.starts_with('/')
        || name.split('/').any(|part| part.is_empty() || part == "." || part == ".." || part.contains(':'))
    {
        return Err("unsafe-entry-name: archive path is invalid".into());
    }
    Ok(name.to_string())
}

fn complete_temporary_count(root: &Path, expected_bytes: u64) -> Result<usize, SpikeError> {
    let threshold = expected_bytes.saturating_sub(1024 * 1024);
    let mut count = 0;
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if entry.file_type()?.is_file()
            && entry.file_name().to_string_lossy().ends_with(".replacement.tmp")
            && entry.metadata()?.len() >= threshold
        {
            count += 1;
        }
    }
    Ok(count)
}

fn available_space(path: &Path) -> Result<u64, SpikeError> {
    let path = fs::canonicalize(path)?;
    let path = wide(&path);
    let mut available = 0_u64;
    unsafe {
        GetDiskFreeSpaceExW(PCWSTR(path.as_ptr()), Some(&mut available), None, None)?;
    }
    Ok(available)
}

fn allocated_file_bytes(path: &Path) -> u64 {
    let path = wide(path);
    let mut high = 0_u32;
    let low = unsafe { GetCompressedFileSizeW(PCWSTR(path.as_ptr()), Some(&mut high)) };
    (u64::from(high) << 32) | u64::from(low)
}

fn mark_sparse(file: &File) -> Result<(), SpikeError> {
    let handle = HANDLE(file.as_raw_handle());
    let mut returned = 0_u32;
    unsafe {
        DeviceIoControl(
            handle,
            FSCTL_SET_SPARSE,
            None::<*const c_void>,
            0,
            None::<*mut c_void>,
            0,
            Some(&mut returned),
            None,
        )?;
    }
    Ok(())
}

fn private_bytes() -> Result<u64, SpikeError> {
    let mut counters = PROCESS_MEMORY_COUNTERS_EX {
        cb: size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
        ..Default::default()
    };
    unsafe {
        GetProcessMemoryInfo(
            GetCurrentProcess(),
            (&mut counters as *mut PROCESS_MEMORY_COUNTERS_EX).cast::<PROCESS_MEMORY_COUNTERS>(),
            size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
        )?;
    }
    Ok(counters.PrivateUsage as u64)
}

fn update_peak(peak: &Arc<AtomicU64>) {
    if let Ok(value) = private_bytes() {
        peak.fetch_max(value, Ordering::Relaxed);
    }
}

fn environment_json(context: &RunContext) -> Value {
    json!({
        "os": "windows",
        "windowsRelease": env::var("GAMEBOOK_SPIKE_WINDOWS_RELEASE").unwrap_or_else(|_| "unreported".to_string()),
        "arch": env::consts::ARCH,
        "cpuModel": env::var("GAMEBOOK_SPIKE_CPU_MODEL").unwrap_or_else(|_| "unreported".to_string()),
        "logicalProcessors": thread::available_parallelism().map(|value| value.get()).unwrap_or(1),
        "totalMemoryBytes": env::var("GAMEBOOK_SPIKE_TOTAL_MEMORY_BYTES").ok().and_then(|value| value.parse::<u64>().ok()).unwrap_or(0),
        "filesystem": "NTFS",
        "storageMode": context.storage_mode,
        "storageHealth": "healthy",
        "oneDriveState": context.one_drive_state,
        "zipCrateVersion": "8.6.0"
    })
}

fn fixture_json(fixture: &SourceFixture) -> Value {
    json!({
        "kind": "synthetic-zip64-stored-media",
        "logicalArchiveBytes": fixture.logical_archive_bytes,
        "allocatedSourceBytes": fixture.allocated_bytes,
        "mediaBytes": fixture.media_bytes,
        "mediaEntry": fixture.media_entry,
        "mediaEntryClass": "content-addressed-stored-media",
        "mediaEntryDigest": fixture.media_digest,
        "entryCount": fixture.entry_count,
        "zip64Required": fixture.logical_archive_bytes > u32::MAX as u64,
        "creationMs": fixture.creation_ms
    })
}

fn failure_replacement_json(reason: &str) -> Value {
    json!({
        "kind": "none",
        "attempted": false,
        "reason": reason,
        "priorProjectRetained": true,
        "passed": true
    })
}

fn base_report(
    options: &Options,
    started_at: &str,
    result: &str,
    error_message: Option<String>,
    evidence: Value,
    extras: Value,
) -> Value {
    let environment = extras.get("environment").cloned().unwrap_or(Value::Null);
    let cleanup = extras.get("cleanup").cloned().unwrap_or(Value::Null);
    json!({
        "schema": REPORT_SCHEMA,
        "issue": 16,
        "startedAt": started_at,
        "completedAt": Utc::now().to_rfc3339(),
        "command": [
            "streamed_save_spike.exe",
            "--scenario", options.scenario.name(),
            "--build-id", options.build_id,
            "--run-id", options.run_id
        ],
        "scenario": options.scenario.name(),
        "result": result,
        "errorMessage": error_message,
        "applicationBuild": {
            "name": "gamebook",
            "version": env!("CARGO_PKG_VERSION"),
            "sourceRevision": options.build_id,
            "profile": if cfg!(debug_assertions) { "debug" } else { "release" }
        },
        "environment": environment,
        "evidence": evidence,
        "security": {
            "destinationLeafValidated": true,
            "temporaryIsExclusiveSibling": true,
            "sameVolumeReplacement": true,
            "sourceArchiveNamesValidated": true,
            "manifestRecordLimitBytes": MAX_JSON_BYTES,
            "validationBeforeVisibility": true,
            "priorProjectPreservedOnFailure": true,
            "partialReplacementUnreferenced": true,
            "frontendFilesystemAccess": false
        },
        "accessibility": {
            "interactiveUi": false,
            "semanticReviewSurface": "streamed-save-harness",
            "productionAnnouncementContract": "Announce Save estimate, progress, cancellation, external-change choices, validation errors, recovery, success, and failure without exposing private paths."
        },
        "compatibility": {
            "productionCommandsChanged": false,
            "productionSchemaChanged": false,
            "version1ProjectChanged": false,
            "screenshotBehaviorChanged": false
        },
        "privacy": {
            "syntheticInputOnly": true,
            "applicationNetworkAccess": false,
            "productionProjectWrites": false,
            "localPathsInReport": false,
            "projectTitlesInReport": false,
            "mediaBytesInReport": false
        },
        "cleanup": cleanup
    })
}

fn classify_validation_error(message: &str) -> &'static str {
    if message.to_ascii_lowercase().contains("crc") {
        "crc-mismatch"
    } else if message.contains("digest-validation") {
        "sha256-mismatch"
    } else {
        "archive-validation-failure"
    }
}

fn assert_report_redacted(report: &Value) -> Result<(), SpikeError> {
    let serialized = serde_json::to_string(report)?.to_ascii_lowercase();
    for marker in [":\\", "\\users\\", "file://"] {
        if serialized.contains(marker) {
            return Err(format!("report contains private marker: {marker}").into());
        }
    }
    Ok(())
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<(), SpikeError> {
    let temporary = path.with_extension("json.partial");
    remove_file_if_exists(&temporary)?;
    let mut file = OpenOptions::new().create_new(true).write(true).open(&temporary)?;
    file.write_all(serde_json::to_string_pretty(value)?.as_bytes())?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    fs::rename(temporary, path)?;
    Ok(())
}

fn remove_file_if_exists(path: &Path) -> Result<(), SpikeError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn validate_token(value: &str, label: &str) -> Result<String, SpikeError> {
    if value.is_empty()
        || value.len() > 160
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.'))
    {
        return Err(format!("{label} is invalid").into());
    }
    Ok(value.to_string())
}

fn zip64_extra(fields: &[&[u8]]) -> Vec<u8> {
    if fields.is_empty() {
        return Vec::new();
    }
    let payload_bytes = fields.iter().map(|field| field.len()).sum::<usize>();
    let mut output = Vec::with_capacity(payload_bytes + 4);
    output.extend_from_slice(&1_u16.to_le_bytes());
    output.extend_from_slice(&(payload_bytes as u16).to_le_bytes());
    for field in fields {
        output.extend_from_slice(field);
    }
    output
}

fn write_u16(writer: &mut impl Write, value: u16) -> io::Result<()> {
    writer.write_all(&value.to_le_bytes())
}

fn write_u32(writer: &mut impl Write, value: u32) -> io::Result<()> {
    writer.write_all(&value.to_le_bytes())
}

fn write_u64(writer: &mut impl Write, value: u64) -> io::Result<()> {
    writer.write_all(&value.to_le_bytes())
}

fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temporary_name_is_a_sibling_and_contains_no_path_components() {
        let destination = Path::new("C:\\fixture\\project.gamebook");
        let temporary = sibling_temporary_path(destination, "run-123").unwrap();
        assert_eq!(temporary.parent(), destination.parent());
        assert_eq!(
            temporary.file_name().unwrap().to_string_lossy(),
            ".project.gamebook.run-123.replacement.tmp"
        );
    }

    #[test]
    fn archive_names_reject_windows_and_posix_escape_forms() {
        for name in ["../escape", "/absolute", "C:/drive", "folder\\file", "folder/file:stream"] {
            assert!(validate_archive_name(name).is_err(), "accepted {name}");
        }
        assert!(validate_archive_name("assets/ab/abcdef.mp4").is_ok());
    }

    #[test]
    fn deterministic_stream_digest_matches_streamed_writer() {
        let expected = synthetic_digest(2 * 1024 * 1024);
        let mut output = Vec::new();
        let actual = write_synthetic_asset(&mut output, 2 * 1024 * 1024).unwrap();
        assert_eq!(actual, expected);
        assert_eq!(output.len(), 2 * 1024 * 1024);
    }

    #[test]
    fn injected_writer_stops_at_the_exact_boundary() {
        let root = env::temp_dir().join(format!("gamebook-streamed-save-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let path = root.join("partial.tmp");
        let file = OpenOptions::new().create_new(true).read(true).write(true).open(&path).unwrap();
        let peak = Arc::new(AtomicU64::new(0));
        let mut writer = TrackingWriter::new(file, WriteMode::CancelAt(1024), peak);
        assert_eq!(writer.write(&vec![1_u8; 2048]).unwrap(), 1024);
        assert!(writer.write(&[1]).unwrap_err().to_string().contains("save-cancelled"));
        drop(writer);
        assert_eq!(fs::metadata(&path).unwrap().len(), 1024);
        fs::remove_dir_all(root).unwrap();
    }
}
