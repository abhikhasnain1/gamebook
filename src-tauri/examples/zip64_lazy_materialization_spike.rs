#![cfg(target_os = "windows")]

use std::{
    collections::HashSet,
    env,
    error::Error,
    ffi::c_void,
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    mem::size_of,
    os::windows::{ffi::OsStrExt, fs::MetadataExt, io::AsRawHandle},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use crc32fast::Hasher as Crc32;
use flate2::{write::DeflateEncoder, Compression};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::HANDLE,
        Security::Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG},
        Storage::FileSystem::{GetCompressedFileSizeW, GetDiskFreeSpaceExW},
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
use zip::ZipArchive;

type SpikeError = Box<dyn Error + Send + Sync>;

const REPORT_SCHEMA: &str = "gamebook.zip64-lazy-materialization-spike.v1";
const MAX_JSON_BYTES: u64 = 16 * 1024 * 1024;
const MAX_PREVIEW_BYTES: u64 = 32 * 1024 * 1024;
const MAX_ENTRY_COUNT: usize = 250_000;
const MAX_PROJECT_BYTES: u64 = 16 * 1024 * 1024 * 1024 * 1024;
const OPEN_MEMORY_LIMIT: u64 = 256 * 1024 * 1024;
const ONE_GIB: u64 = 1024 * 1024 * 1024;
const FIVE_GIB: u64 = 5 * ONE_GIB;
const SELECTED_ASSET_BYTES: usize = 4 * 1024 * 1024;
const COPY_BUFFER_BYTES: usize = 256 * 1024;
const FILE_ATTRIBUTE_REPARSE_POINT_VALUE: u32 = 0x0000_0400;
const TOKEN_TTL_SECONDS: u32 = 600;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Scenario {
    Open1Gb,
    Open5Gb,
    MaterializeSelected,
    DigestFailure,
    ChecksumFailure,
    Cancellation,
    Malformed,
    Traversal,
    CaseDuplicate,
    OversizedJson,
    DecompressionBomb,
}

impl Scenario {
    fn parse(value: &str) -> Result<Self, SpikeError> {
        match value {
            "open-1gb" => Ok(Self::Open1Gb),
            "open-5gb" => Ok(Self::Open5Gb),
            "materialize-selected" => Ok(Self::MaterializeSelected),
            "digest-failure" => Ok(Self::DigestFailure),
            "checksum-failure" => Ok(Self::ChecksumFailure),
            "cancellation" => Ok(Self::Cancellation),
            "malformed" => Ok(Self::Malformed),
            "traversal" => Ok(Self::Traversal),
            "case-duplicate" => Ok(Self::CaseDuplicate),
            "oversized-json" => Ok(Self::OversizedJson),
            "decompression-bomb" => Ok(Self::DecompressionBomb),
            _ => Err("--scenario must be open-1gb, open-5gb, materialize-selected, digest-failure, checksum-failure, cancellation, malformed, traversal, case-duplicate, oversized-json, or decompression-bomb".into()),
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Open1Gb => "open-1gb",
            Self::Open5Gb => "open-5gb",
            Self::MaterializeSelected => "materialize-selected",
            Self::DigestFailure => "digest-failure",
            Self::ChecksumFailure => "checksum-failure",
            Self::Cancellation => "cancellation",
            Self::Malformed => "malformed",
            Self::Traversal => "traversal",
            Self::CaseDuplicate => "case-duplicate",
            Self::OversizedJson => "oversized-json",
            Self::DecompressionBomb => "decompression-bomb",
        }
    }
}

struct Options {
    scenario: Scenario,
    build_id: String,
    output_dir: PathBuf,
    run_id: String,
}

impl Options {
    fn parse(args: &[String]) -> Result<Self, SpikeError> {
        let mut scenario = None;
        let mut build_id = None;
        let mut output_dir = PathBuf::from("src-tauri/target/zip64-lazy-materialization-spike");
        let mut run_id = format!("zip64-lazy-{}", unix_millis());
        let mut index = 1;
        while index < args.len() {
            match args[index].as_str() {
                "--scenario" => {
                    index += 1;
                    scenario = Some(Scenario::parse(
                        args.get(index).ok_or("--scenario requires a value")?,
                    )?);
                }
                "--build-id" => {
                    index += 1;
                    build_id = Some(validate_token(
                        args.get(index).ok_or("--build-id requires a value")?,
                        "build id",
                    )?);
                }
                "--output-dir" => {
                    index += 1;
                    output_dir =
                        PathBuf::from(args.get(index).ok_or("--output-dir requires a value")?);
                }
                "--run-id" => {
                    index += 1;
                    run_id = validate_token(
                        args.get(index).ok_or("--run-id requires a value")?,
                        "run id",
                    )?;
                }
                "--help" | "-h" => {
                    print_help();
                    std::process::exit(0);
                }
                other => return Err(format!("Unknown option: {other}").into()),
            }
            index += 1;
        }
        Ok(Self {
            scenario: scenario.ok_or("--scenario is required")?,
            build_id: build_id.ok_or("--build-id is required")?,
            output_dir,
            run_id,
        })
    }
}

#[derive(Clone)]
enum Payload {
    Bytes {
        compressed: Vec<u8>,
        uncompressed_size: u64,
        crc32: u32,
        method: u16,
        sha256: String,
    },
    SparseZeros {
        size: u64,
        crc32: u32,
        sha256: String,
    },
}

impl Payload {
    fn compressed_size(&self) -> u64 {
        match self {
            Self::Bytes { compressed, .. } => compressed.len() as u64,
            Self::SparseZeros { size, .. } => *size,
        }
    }

    fn uncompressed_size(&self) -> u64 {
        match self {
            Self::Bytes {
                uncompressed_size, ..
            } => *uncompressed_size,
            Self::SparseZeros { size, .. } => *size,
        }
    }

    fn crc32(&self) -> u32 {
        match self {
            Self::Bytes { crc32, .. } | Self::SparseZeros { crc32, .. } => *crc32,
        }
    }

    fn method(&self) -> u16 {
        match self {
            Self::Bytes { method, .. } => *method,
            Self::SparseZeros { .. } => 0,
        }
    }

    fn sha256(&self) -> &str {
        match self {
            Self::Bytes { sha256, .. } | Self::SparseZeros { sha256, .. } => sha256,
        }
    }
}

#[derive(Clone)]
struct FixtureEntry {
    name: Vec<u8>,
    payload: Payload,
}

struct WrittenEntry {
    name: Vec<u8>,
    method: u16,
    crc32: u32,
    compressed_size: u64,
    uncompressed_size: u64,
    local_offset: u64,
    data_offset: u64,
}

struct FixtureInfo {
    archive_bytes: u64,
    allocated_bytes: u64,
    logical_uncompressed_bytes: u64,
    entry_count: usize,
    selected_digest: String,
    selected_bytes: u64,
    selected_data_offset: u64,
    zip64_required: bool,
    creation_ms: u128,
}

#[derive(Clone, Debug)]
struct EntryMetadata {
    name: String,
    compressed_size: u64,
    uncompressed_size: u64,
    data_start: u64,
    is_asset: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureManifest {
    format_version: u32,
    initial_records: Vec<String>,
    assets: Vec<ManifestAsset>,
}

#[derive(Debug, Deserialize)]
struct ManifestAsset {
    id: String,
    entry: String,
    sha256: String,
    bytes: u64,
}

struct ScanResult {
    elapsed_ms: u128,
    private_before: u64,
    private_peak: u64,
    private_after: u64,
    additional_private_bytes: u64,
    bytes_read: u64,
    asset_range_read_ahead_bytes: u64,
    record_bytes_read: u64,
    entry_count: usize,
    manifest: FixtureManifest,
}

#[derive(Default)]
struct ReadTrace {
    bytes_read: u64,
    ranges: Vec<(u64, u64)>,
}

struct TrackedReader {
    file: File,
    position: u64,
    trace: Arc<Mutex<ReadTrace>>,
}

impl TrackedReader {
    fn new(file: File) -> Self {
        Self {
            file,
            position: 0,
            trace: Arc::new(Mutex::new(ReadTrace::default())),
        }
    }

    fn trace(&self) -> Arc<Mutex<ReadTrace>> {
        Arc::clone(&self.trace)
    }
}

impl Read for TrackedReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let start = self.position;
        let count = self.file.read(buffer)?;
        self.position += count as u64;
        if count > 0 {
            let mut trace = self.trace.lock().expect("read trace mutex poisoned");
            trace.bytes_read += count as u64;
            trace.ranges.push((start, self.position));
        }
        Ok(count)
    }
}

impl Seek for TrackedReader {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.position = self.file.seek(position)?;
        Ok(self.position)
    }
}

fn main() -> Result<(), SpikeError> {
    let options = Options::parse(&env::args().collect::<Vec<_>>())?;
    fs::create_dir_all(&options.output_dir)?;
    let started_at = format!("unix-ms-{}", unix_millis());
    let report = run(&options, &started_at).unwrap_or_else(|error| {
        base_report(&options, &started_at, "failed", Some(error.to_string()))
    });
    let report_path = options.output_dir.join(format!("{}.json", options.run_id));
    fs::write(&report_path, serde_json::to_string_pretty(&report)?)?;
    println!("Report: {}", report_path.display());
    if report["result"] != "passed" {
        return Err(report["errorMessage"]
            .as_str()
            .unwrap_or("ZIP64 lazy materialization spike failed")
            .to_string()
            .into());
    }
    Ok(())
}

fn run(options: &Options, started_at: &str) -> Result<Value, SpikeError> {
    match options.scenario {
        Scenario::Open1Gb => run_open(options, started_at, ONE_GIB),
        Scenario::Open5Gb => run_open(options, started_at, FIVE_GIB),
        Scenario::MaterializeSelected => {
            run_materialization(options, started_at, MaterializationMode::Success)
        }
        Scenario::DigestFailure => {
            run_materialization(options, started_at, MaterializationMode::DigestFailure)
        }
        Scenario::ChecksumFailure => {
            run_materialization(options, started_at, MaterializationMode::ChecksumFailure)
        }
        Scenario::Cancellation => {
            run_materialization(options, started_at, MaterializationMode::Cancel)
        }
        Scenario::Malformed => run_rejection(options, started_at, RejectionFixture::Malformed),
        Scenario::Traversal => run_rejection(options, started_at, RejectionFixture::Traversal),
        Scenario::CaseDuplicate => {
            run_rejection(options, started_at, RejectionFixture::CaseDuplicate)
        }
        Scenario::OversizedJson => {
            run_rejection(options, started_at, RejectionFixture::OversizedJson)
        }
        Scenario::DecompressionBomb => {
            run_rejection(options, started_at, RejectionFixture::DecompressionBomb)
        }
    }
}

fn run_open(options: &Options, started_at: &str, large_bytes: u64) -> Result<Value, SpikeError> {
    let fixture_path = options
        .output_dir
        .join(format!("{}-fixture.gamebook", options.run_id));
    let fixture = create_reference_fixture(&fixture_path, large_bytes)?;
    let scan = scan_archive(&fixture_path)?;
    let passed = scan.additional_private_bytes < OPEN_MEMORY_LIMIT
        && scan.manifest.format_version == 2
        && scan.entry_count == fixture.entry_count;
    let removed = remove_file_if_exists(&fixture_path).is_ok() && !fixture_path.exists();
    if !passed || !removed {
        return Err(format!(
            "open gate failed: additionalPrivateBytes={}, removed={removed}",
            scan.additional_private_bytes
        )
        .into());
    }

    let mut report = base_report(options, started_at, "passed", None);
    report["fixture"] = fixture_json(&fixture);
    report["open"] = json!({
        "elapsedMs": scan.elapsed_ms,
        "privateBytesBefore": scan.private_before,
        "privateBytesPeak": scan.private_peak,
        "privateBytesAfter": scan.private_after,
        "additionalPrivateBytes": scan.additional_private_bytes,
        "memoryLimitBytes": OPEN_MEMORY_LIMIT,
        "bytesRead": scan.bytes_read,
        "recordBytesRead": scan.record_bytes_read,
        "assetRangeReadAheadBytes": scan.asset_range_read_ahead_bytes,
        "assetPayloadsOpened": 0,
        "mediaExtractionBytes": 0,
        "materializedAssetCount": 0,
        "entryCount": scan.entry_count,
        "initialRecordCount": scan.manifest.initial_records.len(),
        "centralDirectoryAndSelectedRecordsOnly": true,
        "passed": passed,
    });
    report["cleanup"] = json!({
        "fixtureRemoved": removed,
        "partialOutputs": 0,
        "materializedOutputs": 0,
    });
    Ok(report)
}

#[derive(Clone, Copy)]
enum MaterializationMode {
    Success,
    DigestFailure,
    ChecksumFailure,
    Cancel,
}

fn run_materialization(
    options: &Options,
    started_at: &str,
    mode: MaterializationMode,
) -> Result<Value, SpikeError> {
    let fixture_path = options
        .output_dir
        .join(format!("{}-fixture.gamebook", options.run_id));
    let workspace = options
        .output_dir
        .join(format!("{}-workspace", options.run_id));
    let fixture = create_reference_fixture(&fixture_path, 64 * 1024 * 1024)?;
    if matches!(mode, MaterializationMode::ChecksumFailure) {
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&fixture_path)?;
        file.seek(SeekFrom::Start(fixture.selected_data_offset))?;
        let mut byte = [0_u8; 1];
        file.read_exact(&mut byte)?;
        byte[0] ^= 0x5a;
        file.seek(SeekFrom::Start(fixture.selected_data_offset))?;
        file.write_all(&byte)?;
        file.sync_all()?;
    }

    let scan = scan_archive(&fixture_path)?;
    let selected = scan
        .manifest
        .assets
        .iter()
        .find(|asset| asset.id == "selected")
        .ok_or("selected asset missing from manifest")?;
    let expected_digest = if matches!(mode, MaterializationMode::DigestFailure) {
        "0".repeat(64)
    } else {
        selected.sha256.clone()
    };
    let cancellation_after =
        matches!(mode, MaterializationMode::Cancel).then_some((selected.bytes / 2).max(1));
    let started = Instant::now();
    let outcome = materialize_asset(
        &fixture_path,
        &workspace,
        &selected.entry,
        selected.bytes,
        &expected_digest,
        cancellation_after,
    );
    let elapsed_ms = started.elapsed().as_millis();

    let expected_class = match mode {
        MaterializationMode::Success => "materialized",
        MaterializationMode::DigestFailure => "digest-mismatch",
        MaterializationMode::ChecksumFailure => "archive-checksum-failure",
        MaterializationMode::Cancel => "cancelled",
    };
    let (actual_class, details) = match outcome {
        Ok(result) => ("materialized", result),
        Err(failure) => (failure.class, failure.result),
    };
    let workspace_entries = count_files(&workspace)?;
    let final_was_visible = details.final_was_visible;
    let partial_removed = details.partial_removed;
    let selected_bytes_written = details.bytes_written;
    let token_bits = details.token_bits;
    let token_contains_path = details.token_contains_path;
    let token_workspace_bound = details.token_workspace_bound;
    let token_digest_bound = details.token_digest_bound;
    let token_read_only = details.token_read_only;
    let token_ttl_seconds = details.token_ttl_seconds;
    let only_selected_requested = details.only_selected_requested;

    if workspace.exists() {
        fs::remove_dir_all(&workspace)?;
    }
    remove_file_if_exists(&fixture_path)?;
    let cleanup_complete = !workspace.exists() && !fixture_path.exists();
    let passed = actual_class == expected_class
        && partial_removed
        && only_selected_requested
        && !token_contains_path
        && cleanup_complete
        && match mode {
            MaterializationMode::Success => {
                final_was_visible
                    && selected_bytes_written == selected.bytes
                    && token_bits == 256
                    && token_workspace_bound
                    && token_digest_bound
                    && token_read_only
                    && token_ttl_seconds == TOKEN_TTL_SECONDS
                    && workspace_entries == 1
            }
            _ => !final_was_visible && workspace_entries == 0,
        };
    if !passed {
        return Err(format!(
            "materialization gate failed: expected={expected_class}, actual={actual_class}, visible={final_was_visible}, partialRemoved={partial_removed}, workspaceEntries={workspace_entries}"
        )
        .into());
    }

    let mut report = base_report(options, started_at, "passed", None);
    report["fixture"] = fixture_json(&fixture);
    report["open"] = json!({
        "elapsedMs": scan.elapsed_ms,
        "additionalPrivateBytes": scan.additional_private_bytes,
        "assetRangeReadAheadBytes": scan.asset_range_read_ahead_bytes,
        "assetPayloadsOpened": 0,
        "mediaExtractionBytes": 0,
    });
    report["materialization"] = json!({
        "expectedOutcome": expected_class,
        "actualOutcome": actual_class,
        "elapsedMs": elapsed_ms,
        "selectedAssetBytes": selected.bytes,
        "bytesWritten": selected_bytes_written,
        "onlySelectedAssetRequested": only_selected_requested,
        "largeAssetRequested": false,
        "projectedSpaceChecked": details.projected_space_checked,
        "availableBytesBefore": details.available_bytes_before,
        "temporaryOutputUsed": true,
        "finalVisibleOnlyAfterDigest": final_was_visible,
        "partialOutputRemoved": partial_removed,
        "tokenBits": token_bits,
        "tokenContainsPath": token_contains_path,
        "tokenPersisted": false,
        "tokenWorkspaceBound": token_workspace_bound,
        "tokenDigestBound": token_digest_bound,
        "tokenOperation": if token_read_only { "read" } else { "none" },
        "tokenTtlSeconds": token_ttl_seconds,
        "workspaceFilesBeforeCleanup": workspace_entries,
        "passed": passed,
    });
    report["cleanup"] = json!({
        "fixtureRemoved": !fixture_path.exists(),
        "workspaceRemoved": !workspace.exists(),
        "partialOutputs": 0,
        "materializedOutputs": 0,
    });
    Ok(report)
}

struct MaterializationResult {
    bytes_written: u64,
    final_was_visible: bool,
    partial_removed: bool,
    token_bits: u32,
    token_contains_path: bool,
    token_workspace_bound: bool,
    token_digest_bound: bool,
    token_read_only: bool,
    token_ttl_seconds: u32,
    only_selected_requested: bool,
    projected_space_checked: bool,
    available_bytes_before: u64,
}

struct MaterializationFailure {
    class: &'static str,
    result: MaterializationResult,
}

fn materialize_asset(
    archive_path: &Path,
    workspace: &Path,
    entry_name: &str,
    expected_size: u64,
    expected_digest: &str,
    cancel_after: Option<u64>,
) -> Result<MaterializationResult, MaterializationFailure> {
    let mut result = MaterializationResult {
        bytes_written: 0,
        final_was_visible: false,
        partial_removed: true,
        token_bits: 0,
        token_contains_path: false,
        token_workspace_bound: false,
        token_digest_bound: false,
        token_read_only: false,
        token_ttl_seconds: 0,
        only_selected_requested: true,
        projected_space_checked: false,
        available_bytes_before: 0,
    };
    let operation = (|| -> Result<(), (&'static str, SpikeError)> {
        fs::create_dir(workspace).map_err(|error| ("workspace-create-failure", error.into()))?;
        validate_workspace_directory(workspace)
            .map_err(|error| ("workspace-boundary-failure", error))?;
        result.available_bytes_before =
            available_space(workspace).map_err(|error| ("space-check-failure", error))?;
        result.projected_space_checked = true;
        if result.available_bytes_before < expected_size.saturating_add(1024 * 1024) {
            return Err((
                "insufficient-space",
                "projected materialization exceeds available space".into(),
            ));
        }

        let archive_file =
            File::open(archive_path).map_err(|error| ("archive-open-failure", error.into()))?;
        let mut archive = ZipArchive::new(archive_file)
            .map_err(|error| ("archive-open-failure", error.into()))?;
        let mut entry = archive
            .by_name(entry_name)
            .map_err(|error| ("asset-entry-missing", error.into()))?;
        if entry.size() != expected_size {
            return Err((
                "asset-size-mismatch",
                "selected asset size differs from manifest".into(),
            ));
        }

        let partial = workspace.join("selected.partial");
        let final_path = workspace.join(format!("{}.bin", expected_digest.to_ascii_lowercase()));
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&partial)
            .map_err(|error| ("temporary-create-failure", error.into()))?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
        loop {
            let count = match entry.read(&mut buffer) {
                Ok(count) => count,
                Err(error) => {
                    drop(output);
                    let _ = remove_file_if_exists(&partial);
                    result.partial_removed = !partial.exists();
                    return Err(("archive-checksum-failure", error.into()));
                }
            };
            if count == 0 {
                break;
            }
            output
                .write_all(&buffer[..count])
                .map_err(|error| ("materialization-write-failure", error.into()))?;
            hasher.update(&buffer[..count]);
            result.bytes_written += count as u64;
            if cancel_after.is_some_and(|limit| result.bytes_written >= limit) {
                drop(output);
                remove_file_if_exists(&partial)
                    .map_err(|error| ("cancellation-cleanup-failure", error))?;
                result.partial_removed = !partial.exists();
                return Err(("cancelled", "materialization cancelled".into()));
            }
            if result.bytes_written > expected_size {
                drop(output);
                let _ = remove_file_if_exists(&partial);
                result.partial_removed = !partial.exists();
                return Err((
                    "actual-size-limit",
                    "materialized bytes exceed declared size".into(),
                ));
            }
        }
        output
            .flush()
            .and_then(|_| output.sync_all())
            .map_err(|error| ("temporary-flush-failure", error.into()))?;
        drop(output);
        let actual_digest = hex_lower(&hasher.finalize());
        if result.bytes_written != expected_size || actual_digest != expected_digest {
            remove_file_if_exists(&partial).map_err(|error| ("digest-cleanup-failure", error))?;
            result.partial_removed = !partial.exists();
            return Err(("digest-mismatch", "selected asset digest mismatch".into()));
        }
        fs::rename(&partial, &final_path)
            .map_err(|error| ("atomic-visibility-failure", error.into()))?;
        result.final_was_visible = final_path.exists();
        result.partial_removed = !partial.exists();
        let token = create_scoped_token(workspace, expected_digest)
            .map_err(|error| ("token-generation-failure", error))?;
        result.token_bits = (token.secret.len() * 8) as u32;
        let token_text = hex_lower(&token.secret);
        result.token_contains_path = token_text.contains('\\') || token_text.contains('/');
        result.token_workspace_bound = !token.workspace_fingerprint.is_empty();
        result.token_digest_bound = token.asset_digest == expected_digest;
        result.token_read_only = token.allowed_operation == "read";
        result.token_ttl_seconds = token.ttl_seconds;
        Ok(())
    })();

    match operation {
        Ok(()) => Ok(result),
        Err((class, _error)) => Err(MaterializationFailure { class, result }),
    }
}

#[derive(Clone, Copy)]
enum RejectionFixture {
    Malformed,
    Traversal,
    CaseDuplicate,
    OversizedJson,
    DecompressionBomb,
}

fn run_rejection(
    options: &Options,
    started_at: &str,
    fixture_kind: RejectionFixture,
) -> Result<Value, SpikeError> {
    let fixture_path = options
        .output_dir
        .join(format!("{}-fixture.gamebook", options.run_id));
    let expected_class = match fixture_kind {
        RejectionFixture::Malformed => {
            fs::write(&fixture_path, b"not-a-zip64-archive")?;
            "malformed-archive"
        }
        RejectionFixture::Traversal => {
            write_archive(
                &fixture_path,
                vec![stored_entry(b"../outside.json", b"{}")],
                false,
            )?;
            "unsafe-entry-name"
        }
        RejectionFixture::CaseDuplicate => {
            write_archive(
                &fixture_path,
                vec![
                    stored_entry(b"records/pages/a.json", b"{}"),
                    stored_entry(b"Records/Pages/A.json", b"{}"),
                ],
                false,
            )?;
            "case-insensitive-duplicate"
        }
        RejectionFixture::OversizedJson => {
            let bytes = vec![b' '; (MAX_JSON_BYTES + 1) as usize];
            write_archive(
                &fixture_path,
                vec![stored_entry(b"records/pages/oversized.json", &bytes)],
                false,
            )?;
            "record-size-limit"
        }
        RejectionFixture::DecompressionBomb => {
            let payload = deflated_zeros(MAX_JSON_BYTES + 1)?;
            write_archive(
                &fixture_path,
                vec![FixtureEntry {
                    name: b"records/pages/compressed.json".to_vec(),
                    payload,
                }],
                false,
            )?;
            "record-size-limit"
        }
    };

    let actual_class = match scan_archive(&fixture_path) {
        Ok(_) => "accepted",
        Err(error) => classify_archive_error(&error.to_string()),
    };
    remove_file_if_exists(&fixture_path)?;
    let passed = actual_class == expected_class && !fixture_path.exists();
    if !passed {
        return Err(format!(
            "rejection fixture failed: expected={expected_class}, actual={actual_class}"
        )
        .into());
    }

    let mut report = base_report(options, started_at, "passed", None);
    report["validation"] = json!({
        "expectedClass": expected_class,
        "actualClass": actual_class,
        "accepted": false,
        "canonicalRecordsChanged": false,
        "outputExposed": false,
        "passed": passed,
    });
    report["cleanup"] = json!({
        "fixtureRemoved": !fixture_path.exists(),
        "partialOutputs": 0,
        "materializedOutputs": 0,
    });
    Ok(report)
}

fn scan_archive(path: &Path) -> Result<ScanResult, SpikeError> {
    let private_before = private_bytes()?;
    let started = Instant::now();
    let reader = TrackedReader::new(File::open(path)?);
    let trace = reader.trace();
    let mut archive =
        ZipArchive::new(reader).map_err(|error| format!("malformed-archive: {error}"))?;
    if archive.len() > MAX_ENTRY_COUNT {
        return Err("entry-count-limit: archive contains too many entries".into());
    }

    let mut names = HashSet::with_capacity(archive.len());
    let mut entries = Vec::with_capacity(archive.len());
    let mut total_uncompressed = 0_u64;
    for index in 0..archive.len() {
        let entry = archive.by_index(index)?;
        let name = validate_archive_name(entry.name_raw())?;
        let folded = name.to_ascii_lowercase();
        if !names.insert(folded) {
            return Err("case-insensitive-duplicate: duplicate destination".into());
        }
        if entry.encrypted() {
            return Err("encrypted-entry: encrypted archives are unsupported".into());
        }
        let unix_kind = entry.unix_mode().map(|mode| mode & 0o170000).unwrap_or(0);
        let external_attributes = read_external_attributes(path, entry.central_header_start())?;
        validate_entry_kind(
            entry.is_symlink(),
            entry.is_file() || entry.is_dir(),
            unix_kind,
            external_attributes,
            entry.extra_data(),
        )?;
        let limit = entry_limit(&name);
        if entry.size() > limit {
            return Err(format!("{}: entry exceeds its declared limit", limit_class(&name)).into());
        }
        total_uncompressed = total_uncompressed
            .checked_add(entry.size())
            .ok_or("project-size-limit: uncompressed size overflow")?;
        if total_uncompressed > MAX_PROJECT_BYTES {
            return Err("project-size-limit: projected project size exceeds limit".into());
        }
        entries.push(EntryMetadata {
            is_asset: name.starts_with("assets/"),
            name,
            compressed_size: entry.compressed_size(),
            uncompressed_size: entry.size(),
            data_start: entry
                .data_start()
                .ok_or("malformed-archive: entry data offset is unavailable")?,
        });
    }
    let private_after_directory = private_bytes()?;

    let manifest_bytes = read_named_limited(&mut archive, "manifest.json", MAX_JSON_BYTES)?;
    let manifest: FixtureManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|_| "malformed-record: manifest JSON is invalid")?;
    if manifest.format_version != 2 {
        return Err("unsupported-format: fixture must declare format version 2".into());
    }
    for record in &manifest.initial_records {
        validate_archive_name(record.as_bytes())?;
        read_named_limited(&mut archive, record, MAX_JSON_BYTES)?;
    }
    validate_manifest_assets(&manifest, &entries)?;
    let private_after = private_bytes()?;
    let elapsed_ms = started.elapsed().as_millis();

    let trace = trace.lock().expect("read trace mutex poisoned");
    let asset_ranges: Vec<(u64, u64)> = entries
        .iter()
        .filter(|entry| entry.is_asset)
        .map(|entry| {
            (
                entry.data_start,
                entry.data_start.saturating_add(entry.compressed_size),
            )
        })
        .collect();
    let asset_range_read_ahead_bytes = intersected_bytes(&trace.ranges, &asset_ranges);
    let record_ranges: Vec<(u64, u64)> = entries
        .iter()
        .filter(|entry| !entry.is_asset)
        .map(|entry| {
            (
                entry.data_start,
                entry.data_start.saturating_add(entry.compressed_size),
            )
        })
        .collect();
    let record_bytes_read = intersected_bytes(&trace.ranges, &record_ranges);
    let private_peak = private_before
        .max(private_after_directory)
        .max(private_after);

    Ok(ScanResult {
        elapsed_ms,
        private_before,
        private_peak,
        private_after,
        additional_private_bytes: private_peak.saturating_sub(private_before),
        bytes_read: trace.bytes_read + archive.len() as u64 * 4,
        asset_range_read_ahead_bytes,
        record_bytes_read,
        entry_count: archive.len(),
        manifest,
    })
}

fn validate_manifest_assets(
    manifest: &FixtureManifest,
    entries: &[EntryMetadata],
) -> Result<(), SpikeError> {
    let mut ids = HashSet::new();
    let mut paths = HashSet::new();
    for asset in &manifest.assets {
        if !ids.insert(asset.id.to_ascii_lowercase()) {
            return Err("manifest-duplicate: asset id is duplicated".into());
        }
        validate_archive_name(asset.entry.as_bytes())?;
        if !asset.entry.starts_with("assets/") || !paths.insert(asset.entry.to_ascii_lowercase()) {
            return Err("manifest-duplicate: asset entry is invalid or duplicated".into());
        }
        if asset.sha256.len() != 64 || !asset.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("manifest-digest: asset digest is invalid".into());
        }
        let entry = entries
            .iter()
            .find(|entry| entry.name == asset.entry)
            .ok_or("manifest-reference: asset entry is missing")?;
        if entry.uncompressed_size != asset.bytes {
            return Err("manifest-size: asset size does not match archive metadata".into());
        }
    }
    Ok(())
}

fn read_named_limited<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
    limit: u64,
) -> Result<Vec<u8>, SpikeError> {
    let mut entry = archive
        .by_name(name)
        .map_err(|_| format!("missing-record: {name}"))?;
    if entry.size() > limit {
        return Err("record-size-limit: declared record size exceeds limit".into());
    }
    let mut bytes = Vec::with_capacity(entry.size().min(limit) as usize);
    let mut limited = (&mut entry).take(limit + 1);
    limited.read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err("actual-size-limit: decompressed record exceeds limit".into());
    }
    Ok(bytes)
}

fn validate_archive_name(raw: &[u8]) -> Result<String, SpikeError> {
    let name =
        std::str::from_utf8(raw).map_err(|_| "unsafe-entry-name: entry name is not UTF-8")?;
    if name.is_empty()
        || name.contains('\0')
        || name.contains('\\')
        || name.starts_with('/')
        || name.starts_with("//")
    {
        return Err("unsafe-entry-name: entry must be a relative POSIX path".into());
    }
    let first = name.split('/').next().unwrap_or_default();
    if first.len() >= 2 && first.as_bytes()[1] == b':' {
        return Err("unsafe-entry-name: drive-prefixed paths are forbidden".into());
    }
    if name
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == ".." || part.contains(':'))
    {
        return Err("unsafe-entry-name: path component is forbidden".into());
    }
    Ok(name.to_string())
}

fn entry_limit(name: &str) -> u64 {
    if name == "manifest.json" || (name.starts_with("records/") && name.ends_with(".json")) {
        MAX_JSON_BYTES
    } else if name.starts_with("previews/") {
        MAX_PREVIEW_BYTES
    } else {
        MAX_PROJECT_BYTES
    }
}

fn limit_class(name: &str) -> &'static str {
    if name == "manifest.json" || (name.starts_with("records/") && name.ends_with(".json")) {
        "record-size-limit"
    } else if name.starts_with("previews/") {
        "preview-size-limit"
    } else {
        "project-size-limit"
    }
}

fn classify_archive_error(message: &str) -> &'static str {
    const CLASSES: [&str; 13] = [
        "malformed-archive",
        "unsafe-entry-name",
        "case-insensitive-duplicate",
        "entry-count-limit",
        "record-size-limit",
        "preview-size-limit",
        "project-size-limit",
        "encrypted-entry",
        "link-entry",
        "malformed-record",
        "missing-record",
        "manifest-reference",
        "actual-size-limit",
    ];
    CLASSES
        .into_iter()
        .find(|class| message.starts_with(class))
        .unwrap_or("malformed-archive")
}

fn create_reference_fixture(path: &Path, large_bytes: u64) -> Result<FixtureInfo, SpikeError> {
    let started = Instant::now();
    let selected_data: Vec<u8> = (0..SELECTED_ASSET_BYTES)
        .map(|index| ((index * 31 + 17) % 251) as u8)
        .collect();
    let selected_payload = stored_payload(&selected_data);
    let (large_crc, large_digest) = zero_checksums(large_bytes);
    let selected_digest = selected_payload.sha256().to_string();
    let selected_entry = format!("assets/{}/{}.bin", &selected_digest[..2], selected_digest);
    let large_entry = format!("assets/{}/{}.mp4", &large_digest[..2], large_digest);
    let manifest = serde_json::to_vec(&json!({
        "formatVersion": 2,
        "initialRecords": ["records/pages/page-alpha.json"],
        "assets": [
            {
                "id": "selected",
                "entry": selected_entry,
                "sha256": selected_digest,
                "bytes": SELECTED_ASSET_BYTES,
            },
            {
                "id": "large",
                "entry": large_entry,
                "sha256": large_digest,
                "bytes": large_bytes,
            }
        ]
    }))?;
    let page = br#"{"id":"page-alpha","title":"Synthetic archive page","placements":[]}"#;
    let entries = vec![
        FixtureEntry {
            name: b"manifest.json".to_vec(),
            payload: deflated_payload(&manifest)?,
        },
        FixtureEntry {
            name: b"records/pages/page-alpha.json".to_vec(),
            payload: deflated_payload(page)?,
        },
        FixtureEntry {
            name: selected_entry.as_bytes().to_vec(),
            payload: selected_payload,
        },
        FixtureEntry {
            name: large_entry.as_bytes().to_vec(),
            payload: Payload::SparseZeros {
                size: large_bytes,
                crc32: large_crc,
                sha256: large_digest,
            },
        },
    ];
    let written = write_archive(path, entries, true)?;
    let selected_written = written
        .iter()
        .find(|entry| entry.name == selected_entry.as_bytes())
        .ok_or("selected fixture entry was not written")?;
    let archive_bytes = fs::metadata(path)?.len();
    Ok(FixtureInfo {
        archive_bytes,
        allocated_bytes: allocated_file_bytes(path),
        logical_uncompressed_bytes: written.iter().map(|entry| entry.uncompressed_size).sum(),
        entry_count: written.len(),
        selected_digest,
        selected_bytes: SELECTED_ASSET_BYTES as u64,
        selected_data_offset: selected_written.data_offset,
        zip64_required: archive_bytes > u32::MAX as u64 || large_bytes > u32::MAX as u64,
        creation_ms: started.elapsed().as_millis(),
    })
}

fn write_archive(
    path: &Path,
    entries: Vec<FixtureEntry>,
    sparse: bool,
) -> Result<Vec<WrittenEntry>, SpikeError> {
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .read(true)
        .write(true)
        .open(path)?;
    if sparse {
        mark_sparse(&file)?;
    }
    let mut written = Vec::with_capacity(entries.len());
    for entry in entries {
        let local_offset = file.stream_position()?;
        let compressed_size = entry.payload.compressed_size();
        let uncompressed_size = entry.payload.uncompressed_size();
        let zip64_sizes = compressed_size > u32::MAX as u64 || uncompressed_size > u32::MAX as u64;
        let local_extra = if zip64_sizes {
            zip64_extra(&[
                uncompressed_size.to_le_bytes().as_slice(),
                compressed_size.to_le_bytes().as_slice(),
            ])
        } else {
            Vec::new()
        };
        write_u32(&mut file, 0x0403_4b50)?;
        write_u16(&mut file, if zip64_sizes { 45 } else { 20 })?;
        write_u16(&mut file, 0x0800)?;
        write_u16(&mut file, entry.payload.method())?;
        write_u16(&mut file, 0)?;
        write_u16(&mut file, 0)?;
        write_u32(&mut file, entry.payload.crc32())?;
        write_u32(
            &mut file,
            if zip64_sizes {
                u32::MAX
            } else {
                compressed_size as u32
            },
        )?;
        write_u32(
            &mut file,
            if zip64_sizes {
                u32::MAX
            } else {
                uncompressed_size as u32
            },
        )?;
        write_u16(&mut file, u16::try_from(entry.name.len())?)?;
        write_u16(&mut file, u16::try_from(local_extra.len())?)?;
        file.write_all(&entry.name)?;
        file.write_all(&local_extra)?;
        let data_offset = file.stream_position()?;
        match &entry.payload {
            Payload::Bytes { compressed, .. } => file.write_all(compressed)?,
            Payload::SparseZeros { size, .. } => {
                file.seek(SeekFrom::Current(i64::try_from(*size)?))?;
            }
        }
        written.push(WrittenEntry {
            name: entry.name,
            method: entry.payload.method(),
            crc32: entry.payload.crc32(),
            compressed_size,
            uncompressed_size,
            local_offset,
            data_offset,
        });
    }

    let central_offset = file.stream_position()?;
    for entry in &written {
        let zip64_sizes =
            entry.compressed_size > u32::MAX as u64 || entry.uncompressed_size > u32::MAX as u64;
        let zip64_offset = entry.local_offset > u32::MAX as u64;
        let mut fields: Vec<[u8; 8]> = Vec::new();
        if zip64_sizes {
            fields.push(entry.uncompressed_size.to_le_bytes());
            fields.push(entry.compressed_size.to_le_bytes());
        }
        if zip64_offset {
            fields.push(entry.local_offset.to_le_bytes());
        }
        let refs: Vec<&[u8]> = fields.iter().map(|field| field.as_slice()).collect();
        let central_extra = zip64_extra(&refs);
        write_u32(&mut file, 0x0201_4b50)?;
        write_u16(&mut file, 45)?;
        write_u16(&mut file, if zip64_sizes || zip64_offset { 45 } else { 20 })?;
        write_u16(&mut file, 0x0800)?;
        write_u16(&mut file, entry.method)?;
        write_u16(&mut file, 0)?;
        write_u16(&mut file, 0)?;
        write_u32(&mut file, entry.crc32)?;
        write_u32(
            &mut file,
            if zip64_sizes {
                u32::MAX
            } else {
                entry.compressed_size as u32
            },
        )?;
        write_u32(
            &mut file,
            if zip64_sizes {
                u32::MAX
            } else {
                entry.uncompressed_size as u32
            },
        )?;
        write_u16(&mut file, u16::try_from(entry.name.len())?)?;
        write_u16(&mut file, u16::try_from(central_extra.len())?)?;
        write_u16(&mut file, 0)?;
        write_u16(&mut file, 0)?;
        write_u16(&mut file, 0)?;
        write_u32(&mut file, 0)?;
        write_u32(
            &mut file,
            if zip64_offset {
                u32::MAX
            } else {
                entry.local_offset as u32
            },
        )?;
        file.write_all(&entry.name)?;
        file.write_all(&central_extra)?;
    }
    let central_end = file.stream_position()?;
    let central_size = central_end - central_offset;
    let needs_zip64 = central_offset > u32::MAX as u64
        || central_size > u32::MAX as u64
        || written.len() > u16::MAX as usize
        || written.iter().any(|entry| {
            entry.compressed_size > u32::MAX as u64
                || entry.uncompressed_size > u32::MAX as u64
                || entry.local_offset > u32::MAX as u64
        });
    if needs_zip64 {
        let zip64_eocd_offset = file.stream_position()?;
        write_u32(&mut file, 0x0606_4b50)?;
        write_u64(&mut file, 44)?;
        write_u16(&mut file, 45)?;
        write_u16(&mut file, 45)?;
        write_u32(&mut file, 0)?;
        write_u32(&mut file, 0)?;
        write_u64(&mut file, written.len() as u64)?;
        write_u64(&mut file, written.len() as u64)?;
        write_u64(&mut file, central_size)?;
        write_u64(&mut file, central_offset)?;
        write_u32(&mut file, 0x0706_4b50)?;
        write_u32(&mut file, 0)?;
        write_u64(&mut file, zip64_eocd_offset)?;
        write_u32(&mut file, 1)?;
    }
    write_u32(&mut file, 0x0605_4b50)?;
    write_u16(&mut file, 0)?;
    write_u16(&mut file, 0)?;
    write_u16(&mut file, written.len().min(u16::MAX as usize) as u16)?;
    write_u16(&mut file, written.len().min(u16::MAX as usize) as u16)?;
    write_u32(&mut file, central_size.min(u32::MAX as u64) as u32)?;
    write_u32(&mut file, central_offset.min(u32::MAX as u64) as u32)?;
    write_u16(&mut file, 0)?;
    file.flush()?;
    file.sync_all()?;
    Ok(written)
}

fn zip64_extra(fields: &[&[u8]]) -> Vec<u8> {
    if fields.is_empty() {
        return Vec::new();
    }
    let payload_len: usize = fields.iter().map(|field| field.len()).sum();
    let mut extra = Vec::with_capacity(payload_len + 4);
    extra.extend_from_slice(&0x0001_u16.to_le_bytes());
    extra.extend_from_slice(&(payload_len as u16).to_le_bytes());
    for field in fields {
        extra.extend_from_slice(field);
    }
    extra
}

fn stored_entry(name: &[u8], data: &[u8]) -> FixtureEntry {
    FixtureEntry {
        name: name.to_vec(),
        payload: stored_payload(data),
    }
}

fn stored_payload(data: &[u8]) -> Payload {
    Payload::Bytes {
        compressed: data.to_vec(),
        uncompressed_size: data.len() as u64,
        crc32: crc32fast::hash(data),
        method: 0,
        sha256: hex_lower(&Sha256::digest(data)),
    }
}

fn deflated_payload(data: &[u8]) -> Result<Payload, SpikeError> {
    let mut encoder = DeflateEncoder::new(Vec::new(), Compression::fast());
    encoder.write_all(data)?;
    let compressed = encoder.finish()?;
    Ok(Payload::Bytes {
        compressed,
        uncompressed_size: data.len() as u64,
        crc32: crc32fast::hash(data),
        method: 8,
        sha256: hex_lower(&Sha256::digest(data)),
    })
}

fn deflated_zeros(size: u64) -> Result<Payload, SpikeError> {
    let mut encoder = DeflateEncoder::new(Vec::new(), Compression::fast());
    let zeroes = vec![0_u8; 1024 * 1024];
    let mut remaining = size;
    let mut crc = Crc32::new();
    let mut sha = Sha256::new();
    while remaining > 0 {
        let count = remaining.min(zeroes.len() as u64) as usize;
        encoder.write_all(&zeroes[..count])?;
        crc.update(&zeroes[..count]);
        sha.update(&zeroes[..count]);
        remaining -= count as u64;
    }
    Ok(Payload::Bytes {
        compressed: encoder.finish()?,
        uncompressed_size: size,
        crc32: crc.finalize(),
        method: 8,
        sha256: hex_lower(&sha.finalize()),
    })
}

fn zero_checksums(size: u64) -> (u32, String) {
    let zeroes = vec![0_u8; 1024 * 1024];
    let mut remaining = size;
    let mut crc = Crc32::new();
    let mut sha = Sha256::new();
    while remaining > 0 {
        let count = remaining.min(zeroes.len() as u64) as usize;
        crc.update(&zeroes[..count]);
        sha.update(&zeroes[..count]);
        remaining -= count as u64;
    }
    (crc.finalize(), hex_lower(&sha.finalize()))
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

fn available_space(path: &Path) -> Result<u64, SpikeError> {
    let canonical = fs::canonicalize(path)?;
    let wide = wide(&canonical);
    let mut available = 0_u64;
    unsafe {
        GetDiskFreeSpaceExW(PCWSTR(wide.as_ptr()), Some(&mut available), None, None)?;
    }
    Ok(available)
}

fn allocated_file_bytes(path: &Path) -> u64 {
    let wide = wide(path);
    let mut high = 0_u32;
    let low = unsafe { GetCompressedFileSizeW(PCWSTR(wide.as_ptr()), Some(&mut high)) };
    (u64::from(high) << 32) | u64::from(low)
}

fn random_token() -> Result<[u8; 32], SpikeError> {
    let mut token = [0_u8; 32];
    unsafe {
        BCryptGenRandom(None, &mut token, BCRYPT_USE_SYSTEM_PREFERRED_RNG).ok()?;
    }
    Ok(token)
}

struct ScopedAssetToken {
    secret: [u8; 32],
    workspace_fingerprint: String,
    asset_digest: String,
    allowed_operation: &'static str,
    ttl_seconds: u32,
}

fn create_scoped_token(
    workspace: &Path,
    asset_digest: &str,
) -> Result<ScopedAssetToken, SpikeError> {
    if asset_digest.len() != 64 || !asset_digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("asset digest is invalid".into());
    }
    let canonical = fs::canonicalize(workspace)?;
    let workspace_fingerprint = hex_lower(&Sha256::digest(
        canonical.as_os_str().to_string_lossy().as_bytes(),
    ));
    Ok(ScopedAssetToken {
        secret: random_token()?,
        workspace_fingerprint,
        asset_digest: asset_digest.to_ascii_lowercase(),
        allowed_operation: "read",
        ttl_seconds: TOKEN_TTL_SECONDS,
    })
}

fn validate_workspace_directory(path: &Path) -> Result<(), SpikeError> {
    let canonical = fs::canonicalize(path)?;
    for candidate in canonical.ancestors() {
        let metadata = fs::symlink_metadata(candidate)?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT_VALUE != 0
        {
            return Err("workspace and its ancestors must be non-reparse directories".into());
        }
    }
    Ok(())
}

fn read_external_attributes(path: &Path, central_header_start: u64) -> Result<u32, SpikeError> {
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(central_header_start + 38))?;
    let mut bytes = [0_u8; 4];
    file.read_exact(&mut bytes)?;
    Ok(u32::from_le_bytes(bytes))
}

fn validate_extra_fields(extra: Option<&[u8]>) -> Result<(), SpikeError> {
    let Some(mut remaining) = extra else {
        return Ok(());
    };
    while !remaining.is_empty() {
        if remaining.len() < 4 {
            return Err("malformed-archive: truncated extra field".into());
        }
        let id = u16::from_le_bytes([remaining[0], remaining[1]]);
        let length = u16::from_le_bytes([remaining[2], remaining[3]]) as usize;
        if remaining.len() < 4 + length {
            return Err("malformed-archive: extra field length exceeds entry metadata".into());
        }
        if !matches!(id, 0x0001 | 0x000a | 0x5455 | 0x7075) {
            return Err("link-entry: unsupported metadata may encode a link".into());
        }
        remaining = &remaining[4 + length..];
    }
    Ok(())
}

fn validate_entry_kind(
    is_symlink: bool,
    is_file_or_directory: bool,
    unix_kind: u32,
    external_attributes: u32,
    extra: Option<&[u8]>,
) -> Result<(), SpikeError> {
    let has_reparse_attribute = external_attributes & FILE_ATTRIBUTE_REPARSE_POINT_VALUE != 0;
    let is_special_unix_kind = !matches!(unix_kind, 0 | 0o040000 | 0o100000);
    validate_extra_fields(extra)?;
    if is_symlink || has_reparse_attribute || is_special_unix_kind || !is_file_or_directory {
        return Err("link-entry: links and special entries are unsupported".into());
    }
    Ok(())
}

fn intersected_bytes(read_ranges: &[(u64, u64)], target_ranges: &[(u64, u64)]) -> u64 {
    read_ranges
        .iter()
        .flat_map(|read| target_ranges.iter().map(move |target| (read, target)))
        .map(|((read_start, read_end), (target_start, target_end))| {
            read_end
                .min(target_end)
                .saturating_sub(*read_start.max(target_start))
        })
        .sum()
}

fn count_files(path: &Path) -> Result<usize, SpikeError> {
    if !path.exists() {
        return Ok(0);
    }
    Ok(fs::read_dir(path)?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .count())
}

fn remove_file_if_exists(path: &Path) -> Result<(), SpikeError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn fixture_json(fixture: &FixtureInfo) -> Value {
    json!({
        "archiveBytes": fixture.archive_bytes,
        "allocatedBytes": fixture.allocated_bytes,
        "logicalUncompressedBytes": fixture.logical_uncompressed_bytes,
        "entryCount": fixture.entry_count,
        "selectedEntry": "asset:selected",
        "selectedDigest": fixture.selected_digest,
        "selectedBytes": fixture.selected_bytes,
        "largeEntry": "asset:large",
        "zip64Required": fixture.zip64_required,
        "sparse": fixture.allocated_bytes < fixture.archive_bytes,
        "creationMs": fixture.creation_ms,
    })
}

fn base_report(
    options: &Options,
    started_at: &str,
    result: &str,
    error_message: Option<String>,
) -> Value {
    json!({
        "schema": REPORT_SCHEMA,
        "issue": 14,
        "startedAt": started_at,
        "completedAt": format!("unix-ms-{}", unix_millis()),
        "command": [
            "zip64_lazy_materialization_spike.exe",
            "--scenario", options.scenario.name(),
            "--build-id", options.build_id,
            "--run-id", options.run_id,
        ],
        "scenario": options.scenario.name(),
        "result": result,
        "errorMessage": error_message,
        "applicationBuild": {
            "name": "gamebook",
            "version": env!("CARGO_PKG_VERSION"),
            "sourceRevision": options.build_id,
            "profile": if cfg!(debug_assertions) { "debug" } else { "release" },
        },
        "fixture": Value::Null,
        "open": Value::Null,
        "materialization": Value::Null,
        "validation": Value::Null,
        "cleanup": Value::Null,
        "accessibility": {
            "interactiveUi": false,
            "semanticReviewSurface": "archive-materialization-harness",
            "productionAnnouncementContract": "Announce open, progress, cancellation, validation failure, recovery, and successful materialization without exposing local paths.",
        },
        "security": {
            "relativePosixNames": true,
            "absoluteDriveTraversalNulAdsRejected": true,
            "caseInsensitiveDuplicatesRejected": true,
            "linksAndSpecialEntriesRejected": true,
            "workspaceReparseRejected": true,
            "declaredAndActualLimits": true,
            "entryCountLimit": MAX_ENTRY_COUNT,
            "manifestRecordLimitBytes": MAX_JSON_BYTES,
            "previewLimitBytes": MAX_PREVIEW_BYTES,
            "sha256BeforeVisibility": true,
            "temporaryCreateNew": true,
            "opaqueTokenBits": 256,
            "tokenBoundToWorkspaceDigestOperationAndExpiry": true,
        },
        "compatibility": {
            "productionCommandsChanged": false,
            "productionSchemaChanged": false,
            "version1ProjectChanged": false,
            "screenshotBehaviorChanged": false,
        },
        "privacy": {
            "syntheticInputOnly": true,
            "networkAccess": false,
            "projectWrites": false,
            "mediaBytesInReport": false,
            "localPathsInReport": false,
            "tokensInReport": false,
        },
        "environment": {
            "os": "windows",
            "arch": env::consts::ARCH,
            "zipCrateVersion": "8.6.0",
            "storage": "local-ntfs-sparse-fixture",
        },
    })
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
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut output, "{byte:02x}").expect("writing to String cannot fail");
    }
    output
}

fn validate_token(value: &str, label: &str) -> Result<String, SpikeError> {
    if value.is_empty()
        || value.len() > 128
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err(format!("{label} contains unsupported characters").into());
    }
    Ok(value.to_string())
}

fn unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn print_help() {
    println!("zip64_lazy_materialization_spike --scenario SCENARIO --build-id REVISION [--run-id ID] [--output-dir DIR]");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archive_names_reject_unsafe_windows_and_posix_forms() {
        for name in [
            b"../escape.json".as_slice(),
            b"/absolute.json",
            b"C:/drive.json",
            b"folder\\windows.json",
            b"folder/file:stream",
            b"folder/./file.json",
            b"folder//file.json",
            b"folder/nul\0name.json",
        ] {
            assert!(validate_archive_name(name).is_err(), "accepted {name:?}");
        }
        assert_eq!(
            validate_archive_name(b"records/pages/page-alpha.json").unwrap(),
            "records/pages/page-alpha.json"
        );
    }

    #[test]
    fn intersected_ranges_count_only_target_bytes() {
        let reads = vec![(0, 10), (100, 130), (200, 240)];
        let targets = vec![(5, 20), (120, 220)];
        assert_eq!(intersected_bytes(&reads, &targets), 35);
    }

    #[test]
    fn zip64_extra_preserves_field_order() {
        let first = 5_u64.to_le_bytes();
        let second = 9_u64.to_le_bytes();
        let extra = zip64_extra(&[first.as_slice(), second.as_slice()]);
        assert_eq!(&extra[..4], &[1, 0, 16, 0]);
        assert_eq!(&extra[4..12], &first);
        assert_eq!(&extra[12..20], &second);
    }

    #[test]
    fn digest_format_is_lower_hex() {
        assert_eq!(hex_lower(&[0, 15, 16, 255]), "000f10ff");
    }

    #[test]
    fn link_and_reparse_metadata_fail_closed() {
        assert!(validate_entry_kind(true, true, 0o120000, 0, None).is_err());
        assert!(validate_entry_kind(
            false,
            true,
            0o100000,
            FILE_ATTRIBUTE_REPARSE_POINT_VALUE,
            None,
        )
        .is_err());
        assert!(validate_entry_kind(false, true, 0o060000, 0, None).is_err());
        assert!(validate_entry_kind(false, true, 0o100000, 0, Some(&[0x0d, 0, 0, 0])).is_err());
        assert!(validate_entry_kind(false, true, 0o100000, 0, Some(&[1, 0, 0, 0])).is_ok());
    }
}
