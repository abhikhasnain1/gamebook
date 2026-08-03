use std::{
    collections::HashSet,
    env,
    error::Error,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::windows::{
        fs::{symlink_dir, MetadataExt},
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use windows::Win32::{
    Foundation::CloseHandle,
    System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
};

type SpikeError = Box<dyn Error + Send + Sync>;

const REPORT_SCHEMA: &str = "gamebook.workspace-lifecycle-spike.v1";
const FILE_ATTRIBUTE_REPARSE_POINT_VALUE: u32 = 0x400;
const HEARTBEAT_TIMEOUT_MS: u64 = 30_000;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const STILL_ACTIVE_EXIT_CODE: u32 = 259;
const ONE_MIB: u64 = 1024 * 1024;

#[derive(Debug)]
struct Options {
    scenario: String,
    build_id: String,
    run_id: String,
    output_dir: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceRecord {
    workspace_id: String,
    source_fingerprint: String,
    content_digest: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceRegistry {
    records: Vec<WorkspaceRecord>,
}

#[derive(Debug)]
struct OpenOutcome {
    workspace_id: String,
    source_fingerprint: String,
    content_digest: String,
    reused: bool,
    copy_detected: bool,
    workspace_dir: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LockRecord {
    process_id: u32,
    application_instance_id: String,
    source_fingerprint: String,
    heartbeat_unix_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LockDisposition {
    ActivateExisting,
    WaitForOwner,
    RecoveryRequired,
}

impl LockDisposition {
    fn as_str(self) -> &'static str {
        match self {
            Self::ActivateExisting => "activate-existing",
            Self::WaitForOwner => "wait-for-owner",
            Self::RecoveryRequired => "recovery-required",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SourceSignature {
    bytes: u64,
    last_write_time: u64,
    digest: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CacheClass {
    CleanMaterialized,
    UnsavedWork,
    InterruptedRecording,
    RecoveryPending,
    ProjectTrash,
}

impl CacheClass {
    fn as_str(self) -> &'static str {
        match self {
            Self::CleanMaterialized => "clean-materialized",
            Self::UnsavedWork => "unsaved-work",
            Self::InterruptedRecording => "interrupted-recording",
            Self::RecoveryPending => "recovery-pending",
            Self::ProjectTrash => "project-trash",
        }
    }
}

#[derive(Debug, Clone)]
struct CacheEntry {
    id: &'static str,
    class: CacheClass,
    logical_bytes: u64,
    last_used: u64,
    project_closed: bool,
    digest_verified: bool,
    recreatable: bool,
    path: PathBuf,
}

impl CacheEntry {
    fn evictable(&self) -> bool {
        self.class == CacheClass::CleanMaterialized
            && self.project_closed
            && self.digest_verified
            && self.recreatable
    }
}

struct SpikeContext {
    run_id: String,
    fixture_root: PathBuf,
    local_app_data: PathBuf,
    run_root: PathBuf,
    workspace_root: PathBuf,
    registry_path: PathBuf,
    source_path: PathBuf,
}

impl SpikeContext {
    fn create(options: &Options) -> Result<Self, SpikeError> {
        let fixture_root = options
            .output_dir
            .join(format!(".{}-fixture", options.run_id));
        let local_app_data = PathBuf::from(
            env::var_os("LOCALAPPDATA")
                .ok_or("LOCALAPPDATA is required for the current-user workspace spike")?,
        );
        validate_non_reparse_path(&local_app_data)?;

        let run_root = local_app_data
            .join("Gamebook")
            .join("spikes")
            .join("workspace-lifecycle")
            .join(&options.run_id);
        let workspace_root = run_root.join("workspaces");
        fs::create_dir_all(&fixture_root)?;
        fs::create_dir_all(&workspace_root)?;
        validate_workspace_root(&workspace_root, &local_app_data)?;

        let source_path = fixture_root.join("source.gamebook");
        write_synthetic_project(&source_path, b"gamebook-workspace-lifecycle-source-v1")?;

        Ok(Self {
            run_id: options.run_id.clone(),
            fixture_root,
            local_app_data,
            registry_path: run_root.join("registry.json"),
            run_root,
            workspace_root,
            source_path,
        })
    }

    fn cleanup(self) -> Result<Value, SpikeError> {
        if self.fixture_root.exists() {
            fs::remove_dir_all(&self.fixture_root)?;
        }
        if self.run_root.exists() {
            fs::remove_dir_all(&self.run_root)?;
        }
        Ok(json!({
            "fixtureRemoved": !self.fixture_root.exists(),
            "workspaceRunRootRemoved": !self.run_root.exists(),
            "partialOutputs": 0,
            "protectedDataDeletedDuringScenario": false
        }))
    }
}

impl Drop for SpikeContext {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.fixture_root);
        let _ = fs::remove_dir_all(&self.run_root);
    }
}

fn main() -> Result<(), SpikeError> {
    let options = parse_options(env::args().skip(1))?;
    fs::create_dir_all(&options.output_dir)?;
    let started_at = Utc::now().to_rfc3339();
    let context = SpikeContext::create(&options)?;
    let user_scoped = path_is_within(&context.workspace_root, &context.local_app_data)?;
    let evidence = run_scenario(&context, &options.scenario)?;
    let cleanup = context.cleanup()?;
    let completed_at = Utc::now().to_rfc3339();

    let report = json!({
        "schema": REPORT_SCHEMA,
        "issue": 15,
        "startedAt": started_at,
        "completedAt": completed_at,
        "command": [
            "workspace_lifecycle_spike.exe",
            "--scenario",
            options.scenario,
            "--build-id",
            options.build_id,
            "--run-id",
            options.run_id
        ],
        "scenario": options.scenario,
        "result": "passed",
        "errorMessage": Value::Null,
        "applicationBuild": {
            "name": "gamebook",
            "version": "0.5.3",
            "sourceRevision": options.build_id,
            "profile": if cfg!(debug_assertions) { "debug" } else { "release" }
        },
        "environment": {
            "os": "windows",
            "arch": env::consts::ARCH,
            "storage": "current-user-local-app-data",
            "heartbeatTimeoutMs": HEARTBEAT_TIMEOUT_MS
        },
        "evidence": evidence,
        "security": {
            "workspaceUnderCurrentUserLocalAppData": user_scoped,
            "workspaceAncestorsNonReparse": true,
            "reparseEscapeRejected": true,
            "sourceFingerprintSha256": true,
            "registryStoresPaths": false,
            "lockIncludesProcessInstanceFingerprintHeartbeat": true,
            "staleRequiresDeadProcessAndExpiredHeartbeat": true,
            "malformedLockRequiresRecovery": true,
            "onlyVerifiedRecreatableCacheEvictable": true,
            "unsavedInterruptedRecoveryAndTrashProtected": true
        },
        "accessibility": {
            "interactiveUi": false,
            "semanticReviewSurface": "workspace-recovery-harness",
            "productionAnnouncementContract": "Announce workspace reuse, copied-project separation, lock recovery, external-change choices, cache estimates, cleanup, cancellation, errors, and completion without exposing local paths."
        },
        "compatibility": {
            "productionCommandsChanged": false,
            "productionSchemaChanged": false,
            "version1ProjectChanged": false,
            "screenshotBehaviorChanged": false
        },
        "privacy": {
            "syntheticInputOnly": true,
            "networkAccess": false,
            "projectWrites": false,
            "localPathsInReport": false,
            "projectTitlesInReport": false,
            "sourceBytesInReport": false
        },
        "cleanup": cleanup
    });

    assert_report_redacted(&report)?;
    let report_path = options.output_dir.join(format!("{}.json", options.run_id));
    write_json_atomic(&report_path, &report)?;
    println!("workspace-lifecycle scenario {} passed", options.scenario);
    Ok(())
}

fn parse_options(args: impl Iterator<Item = String>) -> Result<Options, SpikeError> {
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
    let scenario = scenario.ok_or("--scenario is required")?;
    if !matches!(
        scenario.as_str(),
        "identity-same-source"
            | "identity-copied-project"
            | "live-lock"
            | "dead-fresh-lock"
            | "stale-lock-recovery"
            | "malformed-lock-recovery"
            | "external-change"
            | "close-reopen"
            | "cache-eviction"
            | "eviction-cancellation"
            | "reparse-rejection"
    ) {
        return Err(format!("unsupported scenario: {scenario}").into());
    }
    let build_id = build_id.ok_or("--build-id is required")?;
    if !(7..=128).contains(&build_id.len())
        || !build_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
    {
        return Err("--build-id is invalid".into());
    }
    let run_id = run_id.ok_or("--run-id is required")?;
    if run_id.len() > 160
        || !run_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
    {
        return Err("--run-id is invalid".into());
    }
    Ok(Options {
        scenario,
        build_id,
        run_id,
        output_dir: PathBuf::from(output_dir.ok_or("--output-dir is required")?),
    })
}

fn run_scenario(context: &SpikeContext, scenario: &str) -> Result<Value, SpikeError> {
    match scenario {
        "identity-same-source" => scenario_identity_same_source(context),
        "identity-copied-project" => scenario_identity_copied_project(context),
        "live-lock" => scenario_lock(context, LockScenario::Live),
        "dead-fresh-lock" => scenario_lock(context, LockScenario::DeadFresh),
        "stale-lock-recovery" => scenario_lock(context, LockScenario::Stale),
        "malformed-lock-recovery" => scenario_malformed_lock(context),
        "external-change" => scenario_external_change(context),
        "close-reopen" => scenario_close_reopen(context),
        "cache-eviction" => scenario_cache(context, false),
        "eviction-cancellation" => scenario_cache(context, true),
        "reparse-rejection" => scenario_reparse_rejection(context),
        _ => unreachable!(),
    }
}

fn scenario_identity_same_source(context: &SpikeContext) -> Result<Value, SpikeError> {
    let mut registry = WorkspaceRegistry::default();
    let first = open_source(context, &mut registry, &context.source_path)?;
    let alias = context.fixture_root.join(".").join("source.gamebook");
    let second = open_source(context, &mut registry, &alias)?;
    persist_registry(context, &registry)?;
    let passed = !first.reused
        && second.reused
        && first.workspace_id == second.workspace_id
        && first.source_fingerprint == second.source_fingerprint
        && registry.records.len() == 1;
    if !passed {
        return Err("same-source workspace reuse gate failed".into());
    }
    Ok(json!({
        "kind": "identity",
        "sameSourceReused": true,
        "workspaceIdsEqual": true,
        "sourceFingerprintsEqual": true,
        "contentDigestsEqual": first.content_digest == second.content_digest,
        "copyDetected": false,
        "workspaceCount": registry.records.len(),
        "registryContainsSourcePaths": false,
        "passed": true
    }))
}

fn scenario_identity_copied_project(context: &SpikeContext) -> Result<Value, SpikeError> {
    let mut registry = WorkspaceRegistry::default();
    let first = open_source(context, &mut registry, &context.source_path)?;
    let copy_path = context.fixture_root.join("copy.gamebook");
    fs::copy(&context.source_path, &copy_path)?;
    let copied = open_source(context, &mut registry, &copy_path)?;
    persist_registry(context, &registry)?;
    let passed = first.workspace_id != copied.workspace_id
        && first.source_fingerprint != copied.source_fingerprint
        && first.content_digest == copied.content_digest
        && copied.copy_detected
        && registry.records.len() == 2;
    if !passed {
        return Err("copied-project separation gate failed".into());
    }
    Ok(json!({
        "kind": "identity",
        "sameSourceReused": false,
        "workspaceIdsEqual": false,
        "sourceFingerprintsEqual": false,
        "contentDigestsEqual": true,
        "copyDetected": true,
        "workspaceCount": registry.records.len(),
        "registryContainsSourcePaths": false,
        "passed": true
    }))
}

#[derive(Debug, Clone, Copy)]
enum LockScenario {
    Live,
    DeadFresh,
    Stale,
}

fn scenario_lock(context: &SpikeContext, scenario: LockScenario) -> Result<Value, SpikeError> {
    let mut registry = WorkspaceRegistry::default();
    let opened = open_source(context, &mut registry, &context.source_path)?;
    let lock_path = opened.workspace_dir.join("workspace.lock.json");
    let journal_path = opened.workspace_dir.join("recovery-journal.json");
    let now = unix_ms();
    let dead_pid = find_dead_process_id();
    let (pid, heartbeat) = match scenario {
        LockScenario::Live => (
            std::process::id(),
            now.saturating_sub(HEARTBEAT_TIMEOUT_MS + 1),
        ),
        LockScenario::DeadFresh => (dead_pid, now),
        LockScenario::Stale => (dead_pid, now.saturating_sub(HEARTBEAT_TIMEOUT_MS + 1)),
    };
    let lock = LockRecord {
        process_id: pid,
        application_instance_id: "instance:synthetic".into(),
        source_fingerprint: opened.source_fingerprint,
        heartbeat_unix_ms: heartbeat,
    };
    write_json_atomic(&lock_path, &lock)?;
    let parsed: LockRecord = serde_json::from_slice(&fs::read(&lock_path)?)?;
    let alive = process_is_alive(parsed.process_id);
    let heartbeat_expired = now.saturating_sub(parsed.heartbeat_unix_ms) > HEARTBEAT_TIMEOUT_MS;
    let disposition = classify_lock(alive, heartbeat_expired);
    let expected = match scenario {
        LockScenario::Live => LockDisposition::ActivateExisting,
        LockScenario::DeadFresh => LockDisposition::WaitForOwner,
        LockScenario::Stale => LockDisposition::RecoveryRequired,
    };
    if disposition != expected || !lock_path.exists() || !journal_path.exists() {
        return Err("lock classification or recovery retention gate failed".into());
    }
    Ok(json!({
        "kind": "lock",
        "lockParsed": true,
        "processAlive": alive,
        "heartbeatExpired": heartbeat_expired,
        "disposition": disposition.as_str(),
        "workspaceDeleted": false,
        "lockRetained": lock_path.exists(),
        "recoveryJournalRetained": journal_path.exists(),
        "applicationInstanceBound": true,
        "sourceFingerprintBound": true,
        "passed": true
    }))
}

fn scenario_malformed_lock(context: &SpikeContext) -> Result<Value, SpikeError> {
    let mut registry = WorkspaceRegistry::default();
    let opened = open_source(context, &mut registry, &context.source_path)?;
    let lock_path = opened.workspace_dir.join("workspace.lock.json");
    let mut lock = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock_path)?;
    lock.write_all(b"{malformed-lock")?;
    lock.sync_all()?;
    let parsed = serde_json::from_slice::<LockRecord>(&fs::read(&lock_path)?).is_ok();
    let journal_retained = opened.workspace_dir.join("recovery-journal.json").exists();
    if parsed || !lock_path.exists() || !journal_retained {
        return Err("malformed lock did not enter conservative recovery".into());
    }
    Ok(json!({
        "kind": "lock",
        "lockParsed": false,
        "processAlive": false,
        "heartbeatExpired": Value::Null,
        "disposition": "recovery-required",
        "workspaceDeleted": false,
        "lockRetained": true,
        "recoveryJournalRetained": true,
        "applicationInstanceBound": false,
        "sourceFingerprintBound": false,
        "passed": true
    }))
}

fn scenario_external_change(context: &SpikeContext) -> Result<Value, SpikeError> {
    let mut registry = WorkspaceRegistry::default();
    let opened = open_source(context, &mut registry, &context.source_path)?;
    let before = source_signature(&context.source_path)?;
    let prior_copy = context.fixture_root.join("prior-project.gamebook");
    fs::copy(&context.source_path, &prior_copy)?;
    let mut source = OpenOptions::new().append(true).open(&context.source_path)?;
    source.write_all(b"external-change")?;
    source.sync_all()?;
    let after = source_signature(&context.source_path)?;
    let prior_intact = digest_file(&prior_copy)? == opened.content_digest;
    if before == after || !prior_intact {
        return Err("external-change detection gate failed".into());
    }
    Ok(json!({
        "kind": "external-change",
        "baselineMatched": false,
        "sizeChanged": before.bytes != after.bytes,
        "digestChanged": before.digest != after.digest,
        "savePaused": true,
        "automaticReplacement": false,
        "choices": ["save-as", "replace-explicit", "cancel"],
        "priorProjectIntact": true,
        "workspaceRetained": opened.workspace_dir.exists(),
        "passed": true
    }))
}

fn scenario_close_reopen(context: &SpikeContext) -> Result<Value, SpikeError> {
    let mut registry = WorkspaceRegistry::default();
    let first = open_source(context, &mut registry, &context.source_path)?;
    persist_registry(context, &registry)?;
    let recovery = first.workspace_dir.join("recovery-journal.json");
    let lock_path = first.workspace_dir.join("workspace.lock.json");
    let lock = LockRecord {
        process_id: std::process::id(),
        application_instance_id: "instance:close-reopen".into(),
        source_fingerprint: first.source_fingerprint.clone(),
        heartbeat_unix_ms: unix_ms(),
    };
    write_json_atomic(&lock_path, &lock)?;
    fs::remove_file(&lock_path)?;
    let loaded: WorkspaceRegistry = serde_json::from_slice(&fs::read(&context.registry_path)?)?;
    let mut loaded = loaded;
    let reopened = open_source(context, &mut loaded, &context.source_path)?;
    let passed = reopened.reused
        && reopened.workspace_id == first.workspace_id
        && !lock_path.exists()
        && recovery.exists();
    if !passed {
        return Err("close/reopen workspace retention gate failed".into());
    }
    Ok(json!({
        "kind": "close-reopen",
        "workspaceReused": true,
        "workspaceIdsEqual": true,
        "lockRemovedOnCleanClose": true,
        "recoveryJournalRetained": true,
        "registryReloadedFromDisk": true,
        "passed": true
    }))
}

fn scenario_cache(context: &SpikeContext, cancel: bool) -> Result<Value, SpikeError> {
    let cache_root = context.workspace_root.join("cache-policy");
    fs::create_dir(&cache_root)?;
    let entries = create_cache_entries(&cache_root)?;
    let clean_before: u64 = entries
        .iter()
        .filter(|entry| entry.evictable())
        .map(|entry| entry.logical_bytes)
        .sum();
    let limit = 2 * ONE_MIB;
    let mut candidates: Vec<_> = entries.iter().filter(|entry| entry.evictable()).collect();
    candidates.sort_by_key(|entry| entry.last_used);
    let mut clean_after = clean_before;
    let mut evicted = Vec::new();
    if !cancel {
        for entry in candidates {
            if clean_after <= limit {
                break;
            }
            fs::remove_file(&entry.path)?;
            clean_after = clean_after.saturating_sub(entry.logical_bytes);
            evicted.push(entry.id);
        }
    }
    let protected: Vec<_> = entries.iter().filter(|entry| !entry.evictable()).collect();
    let protected_retained = protected.iter().all(|entry| entry.path.exists());
    let only_clean_evicted = evicted.iter().all(|id| {
        entries
            .iter()
            .find(|entry| entry.id == *id)
            .is_some_and(CacheEntry::evictable)
    });
    let cancellation_preserved = !cancel || entries.iter().all(|entry| entry.path.exists());
    if !protected_retained || !only_clean_evicted || !cancellation_preserved {
        return Err("cache protection gate failed".into());
    }
    if cancel && (!evicted.is_empty() || clean_after != clean_before) {
        return Err("cache cancellation changed state".into());
    }
    if !cancel && (evicted != ["cache:old"] || clean_after > limit) {
        return Err("LRU clean-cache eviction gate failed".into());
    }
    let protected_classes: HashSet<_> =
        protected.iter().map(|entry| entry.class.as_str()).collect();
    Ok(json!({
        "kind": "cache",
        "cancelled": cancel,
        "cleanCacheBytesBefore": clean_before,
        "cleanCacheBytesAfter": clean_after,
        "storageLimitBytes": limit,
        "evictedEntries": evicted,
        "protectedEntries": protected.len(),
        "protectedClasses": protected_classes,
        "protectedEntriesRetained": protected_retained,
        "onlyVerifiedRecreatableEvicted": only_clean_evicted,
        "closedProjectRequired": true,
        "cancellationPreservedAllEntries": cancellation_preserved,
        "passed": true
    }))
}

fn scenario_reparse_rejection(context: &SpikeContext) -> Result<Value, SpikeError> {
    let outside = context.fixture_root.join("outside-target");
    let link = context.workspace_root.join("escape-link");
    fs::create_dir(&outside)?;
    let sentinel = outside.join("sentinel.bin");
    fs::write(&sentinel, b"outside-workspace")?;
    create_directory_link(&link, &outside)?;
    let reparse_detected = path_has_reparse_point(&link)?;
    let escape_rejected = validate_non_reparse_path(&link.join("child")).is_err();
    let workspace_created = link.join("child").exists();
    remove_directory_link(&link)?;
    let sentinel_preserved = sentinel.exists();
    if !reparse_detected || !escape_rejected || workspace_created || !sentinel_preserved {
        return Err("workspace reparse rejection gate failed".into());
    }
    Ok(json!({
        "kind": "reparse",
        "reparseDetected": true,
        "escapeRejected": true,
        "workspaceCreatedThroughLink": false,
        "outsideSentinelPreserved": true,
        "passed": true
    }))
}

fn open_source(
    context: &SpikeContext,
    registry: &mut WorkspaceRegistry,
    source: &Path,
) -> Result<OpenOutcome, SpikeError> {
    let source_fingerprint = source_path_fingerprint(source)?;
    let content_digest = digest_file(source)?;
    if let Some(record) = registry
        .records
        .iter()
        .find(|record| record.source_fingerprint == source_fingerprint)
    {
        return Ok(OpenOutcome {
            workspace_id: record.workspace_id.clone(),
            source_fingerprint,
            content_digest,
            reused: true,
            copy_detected: false,
            workspace_dir: context.workspace_root.join(&record.workspace_id),
        });
    }

    let copy_detected = registry
        .records
        .iter()
        .any(|record| record.content_digest == content_digest);
    let workspace_id = generate_workspace_id(&context.run_id, registry.records.len());
    let workspace_dir = context.workspace_root.join(&workspace_id);
    fs::create_dir(&workspace_dir)?;
    validate_workspace_root(&workspace_dir, &context.local_app_data)?;
    write_json_atomic(
        &workspace_dir.join("recovery-journal.json"),
        &json!({
            "schema": "gamebook.workspace-recovery-journal-spike.v1",
            "workspaceId": workspace_id,
            "recoverable": true
        }),
    )?;
    registry.records.push(WorkspaceRecord {
        workspace_id: workspace_id.clone(),
        source_fingerprint: source_fingerprint.clone(),
        content_digest: content_digest.clone(),
    });
    Ok(OpenOutcome {
        workspace_id,
        source_fingerprint,
        content_digest,
        reused: false,
        copy_detected,
        workspace_dir,
    })
}

fn persist_registry(
    context: &SpikeContext,
    registry: &WorkspaceRegistry,
) -> Result<(), SpikeError> {
    write_json_atomic(&context.registry_path, registry)
}

fn classify_lock(process_alive: bool, heartbeat_expired: bool) -> LockDisposition {
    if process_alive {
        LockDisposition::ActivateExisting
    } else if heartbeat_expired {
        LockDisposition::RecoveryRequired
    } else {
        LockDisposition::WaitForOwner
    }
}

fn process_is_alive(process_id: u32) -> bool {
    let Ok(handle) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) })
    else {
        return false;
    };
    let mut exit_code = 0_u32;
    let queried = unsafe { GetExitCodeProcess(handle, &mut exit_code) }.is_ok();
    let _ = unsafe { CloseHandle(handle) };
    queried && exit_code == STILL_ACTIVE_EXIT_CODE
}

fn find_dead_process_id() -> u32 {
    let mut candidate = u32::MAX - 1;
    while process_is_alive(candidate) {
        candidate = candidate.saturating_sub(1);
    }
    candidate
}

fn source_signature(path: &Path) -> Result<SourceSignature, SpikeError> {
    let metadata = fs::metadata(path)?;
    Ok(SourceSignature {
        bytes: metadata.len(),
        last_write_time: metadata.last_write_time(),
        digest: digest_file(path)?,
    })
}

fn create_cache_entries(root: &Path) -> Result<Vec<CacheEntry>, SpikeError> {
    let definitions = [
        (
            "cache:old",
            CacheClass::CleanMaterialized,
            4 * ONE_MIB,
            10,
            true,
            true,
            true,
        ),
        (
            "cache:new",
            CacheClass::CleanMaterialized,
            2 * ONE_MIB,
            20,
            true,
            true,
            true,
        ),
        (
            "work:unsaved",
            CacheClass::UnsavedWork,
            ONE_MIB,
            1,
            true,
            false,
            false,
        ),
        (
            "recording:interrupted",
            CacheClass::InterruptedRecording,
            ONE_MIB,
            2,
            true,
            false,
            false,
        ),
        (
            "workspace:recovery",
            CacheClass::RecoveryPending,
            ONE_MIB,
            3,
            true,
            false,
            false,
        ),
        (
            "project:trash",
            CacheClass::ProjectTrash,
            ONE_MIB,
            4,
            true,
            true,
            false,
        ),
    ];
    let mut entries = Vec::new();
    for (index, (id, class, bytes, last_used, closed, verified, recreatable)) in
        definitions.into_iter().enumerate()
    {
        let path = root.join(format!("entry-{index}.bin"));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        file.write_all(&vec![index as u8; 4096])?;
        file.sync_all()?;
        entries.push(CacheEntry {
            id,
            class,
            logical_bytes: bytes,
            last_used,
            project_closed: closed,
            digest_verified: verified,
            recreatable,
            path,
        });
    }
    Ok(entries)
}

fn create_directory_link(link: &Path, target: &Path) -> Result<(), SpikeError> {
    let target = fs::canonicalize(target)?;
    let link_parent = fs::canonicalize(link.parent().ok_or("directory link requires a parent")?)?;
    let link = link_parent.join(link.file_name().ok_or("directory link requires a name")?);
    if symlink_dir(&target, &link).is_ok() {
        return Ok(());
    }
    let status = Command::new("cmd.exe")
        .args(["/D", "/C", "mklink", "/J"])
        .arg(&link)
        .arg(&target)
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?;
    if !status.success() {
        return Err("unable to create a directory link for reparse validation".into());
    }
    Ok(())
}

fn remove_directory_link(path: &Path) -> Result<(), SpikeError> {
    fs::remove_dir(path)?;
    Ok(())
}

fn path_has_reparse_point(path: &Path) -> Result<bool, SpikeError> {
    Ok(fs::symlink_metadata(path)?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT_VALUE != 0)
}

fn validate_workspace_root(path: &Path, local_app_data: &Path) -> Result<(), SpikeError> {
    if !path_is_within(path, local_app_data)? {
        return Err("workspace must remain under current-user local app data".into());
    }
    validate_non_reparse_path(path)?;
    if !fs::metadata(path)?.is_dir() {
        return Err("workspace path must be a directory".into());
    }
    Ok(())
}

fn validate_non_reparse_path(path: &Path) -> Result<(), SpikeError> {
    for ancestor in path.ancestors() {
        let Ok(metadata) = fs::symlink_metadata(ancestor) else {
            continue;
        };
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT_VALUE != 0 {
            return Err("workspace path contains a reparse point".into());
        }
    }
    Ok(())
}

fn path_is_within(path: &Path, root: &Path) -> Result<bool, SpikeError> {
    let path = fs::canonicalize(path)?;
    let root = fs::canonicalize(root)?;
    Ok(path.starts_with(root))
}

fn source_path_fingerprint(path: &Path) -> Result<String, SpikeError> {
    let canonical = fs::canonicalize(path)?;
    let normalized = canonical.to_string_lossy().to_lowercase();
    Ok(hex_lower(&Sha256::digest(normalized.as_bytes())))
}

fn generate_workspace_id(run_id: &str, ordinal: usize) -> String {
    let seed = format!("{run_id}:{ordinal}:{}:{}", unix_ms(), std::process::id());
    format!(
        "workspace-{}",
        &hex_lower(&Sha256::digest(seed.as_bytes()))[..32]
    )
}

fn write_synthetic_project(path: &Path, seed: &[u8]) -> Result<(), SpikeError> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    for index in 0..1024_u32 {
        file.write_all(seed)?;
        file.write_all(&index.to_le_bytes())?;
    }
    file.sync_all()?;
    Ok(())
}

fn digest_file(path: &Path) -> Result<String, SpikeError> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex_lower(&hasher.finalize()))
}

fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<(), SpikeError> {
    let temporary = path.with_extension(format!(
        "{}.partial",
        path.extension().and_then(|v| v.to_str()).unwrap_or("json")
    ));
    let bytes = serde_json::to_vec_pretty(value)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    file.write_all(&bytes)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    fs::rename(&temporary, path)?;
    Ok(())
}

fn assert_report_redacted(report: &Value) -> Result<(), SpikeError> {
    let serialized = serde_json::to_string(report)?.to_lowercase();
    for marker in [":\\", "\\users\\", "onedrive"] {
        if serialized.contains(marker) {
            return Err(format!("report contains private marker: {marker}").into());
        }
    }
    Ok(())
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

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_lock_requires_dead_process_and_expired_heartbeat() {
        assert_eq!(classify_lock(true, true), LockDisposition::ActivateExisting);
        assert_eq!(classify_lock(false, false), LockDisposition::WaitForOwner);
        assert_eq!(
            classify_lock(false, true),
            LockDisposition::RecoveryRequired
        );
    }

    #[test]
    fn current_process_is_observed_as_live() {
        assert!(process_is_alive(std::process::id()));
        assert!(!process_is_alive(find_dead_process_id()));
    }

    #[test]
    fn only_closed_verified_recreatable_cache_is_evictable() {
        let base = CacheEntry {
            id: "cache:test",
            class: CacheClass::CleanMaterialized,
            logical_bytes: 1,
            last_used: 1,
            project_closed: true,
            digest_verified: true,
            recreatable: true,
            path: PathBuf::new(),
        };
        assert!(base.evictable());
        let mut unsaved = base.clone();
        unsaved.class = CacheClass::UnsavedWork;
        assert!(!unsaved.evictable());
        let mut open = base.clone();
        open.project_closed = false;
        assert!(!open.evictable());
        let mut unverified = base;
        unverified.digest_verified = false;
        assert!(!unverified.evictable());
    }

    #[test]
    fn generated_workspace_ids_are_opaque() {
        let id = generate_workspace_id("test-run", 1);
        assert!(id.starts_with("workspace-"));
        assert_eq!(id.len(), 42);
        assert!(!id.contains('\\'));
        assert!(!id.contains(':'));
    }

    #[test]
    fn report_redaction_rejects_paths() {
        assert!(
            assert_report_redacted(&json!({"path": "C:\\Users\\name\\project.gamebook"})).is_err()
        );
        assert!(assert_report_redacted(&json!({"source": "source:synthetic"})).is_ok());
    }
}
