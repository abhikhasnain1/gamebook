use std::{
    collections::{BTreeMap, HashMap},
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime},
};

use chrono::{DateTime, Utc};
use serde_json::Value;
use tauri::http::{header, Method, Request, Response, StatusCode};

#[cfg(windows)]
use super::archive::windows_extended_path;
use super::{
    archive::{
        flush_directory, materialize_asset, open_archive_lazy, read_record_from_file,
        replace_visible_archive, source_path_fingerprint, source_signature, validate_archive,
        write_replacement_archive,
    },
    model::{
        record_entry_name, CacheEvictionResult, ExternalChangeChoice, Manifest,
        MaterializedAssetResult, OpenProjectResult, RecoveryJournalDocument, SaveJournalDocument,
        SaveProjectResult, SourceSignature, WorkspaceLockDocument, WorkspaceRegistryDocument,
        WorkspaceRegistryEntry, WorkspaceStateDocument, MAX_JSON_BYTES, TOKEN_TTL_SECONDS,
    },
};

const LOCK_HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(30);
const SAVE_SPACE_MARGIN_BYTES: u64 = 64 * 1024 * 1024;
const MAX_FULL_PROTOCOL_RESPONSE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_PROTOCOL_RANGE_BYTES: u64 = 16 * 1024 * 1024;
static WORKSPACE_SCHEMA_VALIDATOR: OnceLock<Result<jsonschema::Validator, String>> =
    OnceLock::new();

#[derive(Default)]
pub struct ProjectV2Manager {
    inner: Mutex<ManagerState>,
}

#[derive(Default)]
struct ManagerState {
    root: Option<PathBuf>,
    application_instance_id: Option<String>,
    workspaces: HashMap<String, WorkspaceRuntime>,
    tokens: HashMap<String, AssetToken>,
    operations: HashMap<String, Arc<AtomicBool>>,
}

#[derive(Clone)]
struct WorkspaceRuntime {
    workspace_id: String,
    root: PathBuf,
    source_path: PathBuf,
    source_file: Arc<File>,
    source_fingerprint: String,
    source_signature: SourceSignature,
    manifest: Manifest,
    manifest_value: Value,
    loaded_records: BTreeMap<String, Value>,
    state: WorkspaceStateDocument,
    recovery_sequence: u64,
    closed: bool,
}

struct AssetToken {
    workspace_id: String,
    digest: String,
    operation: &'static str,
    file: Arc<File>,
    mime_type: String,
    byte_length: u64,
    last_access: Instant,
}

struct SaveAttempt<'a> {
    workspace_id: &'a str,
    save_id: &'a str,
    operation_id: &'a str,
    source_fingerprint: &'a str,
    state_before_save: &'a WorkspaceStateDocument,
}

impl ProjectV2Manager {
    pub fn initialize(&self, app_data_dir: &Path) -> Result<(), String> {
        fs::create_dir_all(app_data_dir)
            .map_err(|error| format!("app-data-create-failed: {error}"))?;
        let root = app_data_dir.join("version-2-workspaces");
        fs::create_dir_all(&root)
            .map_err(|error| format!("workspace-root-create-failed: {error}"))?;
        validate_non_reparse_path(&root)?;
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "workspace-state-poisoned".to_string())?;
        if let Some(existing) = &state.root {
            if existing == &root {
                return Ok(());
            }
            return Err("workspace-manager-already-initialized".to_string());
        }
        state.root = Some(root);
        state.application_instance_id = Some(random_id("application-instance")?);
        Ok(())
    }

    pub fn open_path(&self, source: &Path) -> Result<OpenProjectResult, String> {
        let archive = open_archive_lazy(source)?;
        let source_fingerprint = source_path_fingerprint(source)?;
        let canonical_source = fs::canonicalize(source)
            .map_err(|error| format!("source-canonicalization-failed: {error}"))?;
        let mut manager = self
            .inner
            .lock()
            .map_err(|_| "workspace-state-poisoned".to_string())?;
        let root = initialized_root(&manager)?.clone();
        let application_instance_id = manager
            .application_instance_id
            .clone()
            .ok_or_else(|| "workspace-manager-not-initialized".to_string())?;
        if let Some(workspace) = manager
            .workspaces
            .values()
            .find(|workspace| {
                workspace.source_fingerprint == source_fingerprint && !workspace.closed
            })
            .cloned()
        {
            write_lock(
                &workspace.root,
                &workspace.workspace_id,
                &workspace.source_fingerprint,
                &application_instance_id,
            )?;
            return Ok(OpenProjectResult {
                workspace_id: workspace.workspace_id,
                project_id: workspace.manifest.project_id.clone(),
                manifest: workspace.manifest_value,
                records: workspace.loaded_records.into_values().collect(),
                reused_workspace: true,
                copy_detected: false,
                recovery_required: workspace.state.state != "clean",
            });
        }
        let mut registry = read_registry(&root)?;
        let existing = registry
            .workspaces
            .iter()
            .find(|entry| entry.source_fingerprint == source_fingerprint)
            .cloned();
        let copy_detected = registry.workspaces.iter().any(|entry| {
            entry.source_fingerprint != source_fingerprint
                && entry.project_id == archive.manifest.project_id
                && entry.manifest_sha256 == archive.manifest_sha256
        });
        let reused_workspace = existing.is_some();
        let workspace_id = existing
            .as_ref()
            .map(|entry| entry.workspace_id.clone())
            .unwrap_or(random_id("workspace")?);
        let workspace_root = root.join(&workspace_id);
        fs::create_dir_all(&workspace_root)
            .map_err(|error| format!("workspace-create-failed: {error}"))?;
        validate_workspace_root(&workspace_root, &root)?;

        let mut recovery_required = inspect_existing_lock(
            &workspace_root.join("workspace.lock.json"),
            &workspace_id,
            &source_fingerprint,
            &application_instance_id,
        )?;
        let working_dir = workspace_root.join("working");
        fs::create_dir_all(&working_dir)
            .map_err(|error| format!("workspace-create-failed: {error}"))?;

        let now = Utc::now().to_rfc3339();
        let state_path = workspace_root.join("workspace-state.json");
        let workspace_state = if state_path.exists() {
            match read_workspace_document::<WorkspaceStateDocument>(&state_path) {
                Ok(value)
                    if value.workspace_id == workspace_id
                        && value.project_id == archive.manifest.project_id
                        && value.source_fingerprint == source_fingerprint =>
                {
                    value
                }
                Err(_) => {
                    recovery_required = true;
                    let corrupt = workspace_root.join(format!(
                        "workspace-state.corrupt.{}.json",
                        Utc::now().format("%Y%m%dT%H%M%S%.3fZ")
                    ));
                    fs::rename(&state_path, corrupt)
                        .map_err(|error| format!("workspace-state-preserve-failed: {error}"))?;
                    let mut value = clean_workspace_state(
                        &workspace_id,
                        &archive.manifest.project_id,
                        &source_fingerprint,
                        &now,
                    );
                    value.state = "recovery-pending".to_string();
                    add_protected_class(&mut value, "recovery");
                    value
                }
                Ok(_) => {
                    recovery_required = true;
                    let corrupt = workspace_root.join(format!(
                        "workspace-state.corrupt.{}.json",
                        Utc::now().format("%Y%m%dT%H%M%S%.3fZ")
                    ));
                    fs::rename(&state_path, corrupt)
                        .map_err(|error| format!("workspace-state-preserve-failed: {error}"))?;
                    let mut value = clean_workspace_state(
                        &workspace_id,
                        &archive.manifest.project_id,
                        &source_fingerprint,
                        &now,
                    );
                    value.state = "recovery-pending".to_string();
                    add_protected_class(&mut value, "recovery");
                    value
                }
            }
        } else {
            clean_workspace_state(
                &workspace_id,
                &archive.manifest.project_id,
                &source_fingerprint,
                &now,
            )
        };
        if !working_dir.join("manifest.json").exists()
            || (!recovery_required && workspace_state.state == "clean")
        {
            stage_open_archive(&working_dir, &archive)?;
        }
        write_workspace_document(&state_path, &workspace_state)?;
        write_lock(
            &workspace_root,
            &workspace_id,
            &source_fingerprint,
            &application_instance_id,
        )?;

        if existing.is_none() {
            registry.workspaces.push(WorkspaceRegistryEntry {
                workspace_id: workspace_id.clone(),
                project_id: archive.manifest.project_id.clone(),
                source_fingerprint: source_fingerprint.clone(),
                manifest_sha256: archive.manifest_sha256.clone(),
            });
            write_json_atomic(&root.join("registry.json"), &registry)?;
        }

        let recovery_sequence = read_recovery_sequence(&workspace_root).unwrap_or(0);
        let (effective_manifest, effective_manifest_value, loaded_records) = if recovery_required {
            load_workspace_overlay(&working_dir, &archive)?
        } else {
            (
                archive.manifest.clone(),
                archive.manifest_value.clone(),
                archive.records.clone(),
            )
        };
        let project_id = effective_manifest.project_id.clone();
        let records = loaded_records.values().cloned().collect();
        manager.workspaces.insert(
            workspace_id.clone(),
            WorkspaceRuntime {
                workspace_id: workspace_id.clone(),
                root: workspace_root,
                source_path: canonical_source,
                source_file: Arc::new(
                    File::open(source).map_err(|error| format!("archive-open-failed: {error}"))?,
                ),
                source_fingerprint,
                source_signature: archive.source_signature,
                manifest: effective_manifest,
                manifest_value: effective_manifest_value.clone(),
                loaded_records,
                state: workspace_state,
                recovery_sequence,
                closed: false,
            },
        );
        Ok(OpenProjectResult {
            workspace_id,
            project_id,
            manifest: effective_manifest_value,
            records,
            reused_workspace,
            copy_detected,
            recovery_required,
        })
    }

    pub fn stage_document(&self, workspace_id: &str, document: Value) -> Result<(), String> {
        super::archive::validate_project_document(&document)?;
        let mut manager = self
            .inner
            .lock()
            .map_err(|_| "workspace-state-poisoned".to_string())?;
        let application_instance_id = manager
            .application_instance_id
            .clone()
            .ok_or_else(|| "workspace-manager-not-initialized".to_string())?;
        let workspace = open_workspace_mut(&mut manager, workspace_id)?;
        let working = workspace.root.join("working");
        let (relative, dirty_id) =
            if document.get("formatVersion").and_then(Value::as_u64) == Some(2) {
                let manifest: Manifest = serde_json::from_value(document.clone())
                    .map_err(|error| format!("manifest-invalid: {error}"))?;
                if manifest.project_id != workspace.manifest.project_id {
                    return Err("project-identity-change-forbidden".to_string());
                }
                workspace.manifest = manifest;
                workspace.manifest_value = document.clone();
                ("manifest.json".to_string(), "manifest".to_string())
            } else {
                let record_type = document
                    .get("recordType")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "record-type-missing".to_string())?;
                let id = document
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "record-id-missing".to_string())?;
                (record_entry_name(record_type, id)?, id.to_string())
            };
        let bytes = serde_json::to_vec(&document)
            .map_err(|error| format!("workspace-record-serialize-failed: {error}"))?;
        if bytes.len() as u64 > MAX_JSON_BYTES {
            return Err("record-size-limit".to_string());
        }
        write_bytes_atomic(&working.join(posix_to_path(&relative)), &bytes)?;
        if relative != "manifest.json" {
            workspace.loaded_records.insert(relative, document);
        }
        if !workspace.state.dirty_record_ids.contains(&dirty_id) {
            workspace.state.dirty_record_ids.push(dirty_id);
        }
        workspace.state.state = "dirty".to_string();
        add_protected_class(&mut workspace.state, "unsaved");
        workspace.state.updated_at = Utc::now().to_rfc3339();
        write_workspace_document(
            &workspace.root.join("workspace-state.json"),
            &workspace.state,
        )?;
        write_lock(
            &workspace.root,
            &workspace.workspace_id,
            &workspace.source_fingerprint,
            &application_instance_id,
        )
    }

    pub fn autosave(&self, workspace_id: &str) -> Result<(), String> {
        let mut manager = self
            .inner
            .lock()
            .map_err(|_| "workspace-state-poisoned".to_string())?;
        let application_instance_id = manager
            .application_instance_id
            .clone()
            .ok_or_else(|| "workspace-manager-not-initialized".to_string())?;
        let workspace = open_workspace_mut(&mut manager, workspace_id)?;
        workspace.recovery_sequence += 1;
        let journal = RecoveryJournalDocument {
            record_type: "recovery-journal".to_string(),
            journal_version: 1,
            workspace_id: workspace.workspace_id.clone(),
            sequence: workspace.recovery_sequence,
            written_at: Utc::now().to_rfc3339(),
            operation: "autosave".to_string(),
            record_ids: workspace.state.dirty_record_ids.clone(),
            asset_digests: workspace.state.new_asset_digests.clone(),
            status: "committed".to_string(),
        };
        write_workspace_document(&workspace.root.join("recovery-journal.json"), &journal)?;
        workspace.state.state = "recovery-pending".to_string();
        add_protected_class(&mut workspace.state, "recovery");
        workspace.state.updated_at = Utc::now().to_rfc3339();
        write_workspace_document(
            &workspace.root.join("workspace-state.json"),
            &workspace.state,
        )?;
        write_lock(
            &workspace.root,
            &workspace.workspace_id,
            &workspace.source_fingerprint,
            &application_instance_id,
        )
    }

    pub fn materialize(
        &self,
        workspace_id: &str,
        digest: &str,
        operation_id: &str,
    ) -> Result<MaterializedAssetResult, String> {
        let (source_file, cache, asset) = {
            let manager = self
                .inner
                .lock()
                .map_err(|_| "workspace-state-poisoned".to_string())?;
            let workspace = open_workspace(&manager, workspace_id)?;
            let asset = workspace
                .manifest
                .assets
                .iter()
                .find(|asset| asset.digest == digest)
                .cloned()
                .ok_or_else(|| "asset-not-found".to_string())?;
            let source_file = workspace
                .source_file
                .try_clone()
                .map_err(|error| format!("archive-open-failed: {error}"))?;
            let cache = workspace.root.join("cache").join("assets");
            (source_file, cache, asset)
        };
        fs::create_dir_all(&cache).map_err(|error| format!("workspace-create-failed: {error}"))?;
        validate_non_reparse_path(cache.parent().unwrap_or(&cache))?;
        let available = available_space(&cache)?;
        if available < asset.byte_length.saturating_add(SAVE_SPACE_MARGIN_BYTES) {
            return Err("insufficient-space".to_string());
        }
        let cancelled = {
            let mut manager = self
                .inner
                .lock()
                .map_err(|_| "workspace-state-poisoned".to_string())?;
            operation_flag(&mut manager, operation_id)?
        };
        let path = match materialize_asset(source_file, &cache, &asset, &cancelled) {
            Ok(value) => value,
            Err(error) => {
                self.finish_operation(operation_id);
                return Err(error);
            }
        };
        let token = match random_secret_hex() {
            Ok(value) => value,
            Err(error) => {
                self.finish_operation(operation_id);
                return Err(error);
            }
        };
        let result = MaterializedAssetResult {
            token: token.clone(),
            digest: asset.digest.clone(),
            mime_type: asset.mime_type.clone(),
            byte_length: asset.byte_length,
            expires_after_seconds: TOKEN_TTL_SECONDS,
        };
        let verified_file = match File::open(&path)
            .map_err(|error| format!("materialized-asset-open-failed: {error}"))
            .and_then(|file| {
                let length = file
                    .metadata()
                    .map_err(|error| format!("materialized-asset-open-failed: {error}"))?
                    .len();
                if length == asset.byte_length {
                    Ok(file)
                } else {
                    Err("materialized-asset-invalid".to_string())
                }
            }) {
            Ok(file) => file,
            Err(error) => {
                self.finish_operation(operation_id);
                return Err(error);
            }
        };
        let mut manager = self
            .inner
            .lock()
            .map_err(|_| "workspace-state-poisoned".to_string())?;
        manager.operations.remove(operation_id);
        manager.tokens.retain(|_, value| {
            value.last_access.elapsed() <= Duration::from_secs(TOKEN_TTL_SECONDS)
        });
        manager.tokens.insert(
            token,
            AssetToken {
                workspace_id: workspace_id.to_string(),
                digest: asset.digest,
                operation: "read",
                file: Arc::new(verified_file),
                mime_type: asset.mime_type,
                byte_length: asset.byte_length,
                last_access: Instant::now(),
            },
        );
        Ok(result)
    }

    pub fn current_source_path(&self, workspace_id: &str) -> Result<PathBuf, String> {
        let manager = self
            .inner
            .lock()
            .map_err(|_| "workspace-state-poisoned".to_string())?;
        Ok(open_workspace(&manager, workspace_id)?.source_path.clone())
    }

    pub fn read_record(
        &self,
        workspace_id: &str,
        record_type: &str,
        id: &str,
    ) -> Result<Value, String> {
        let name = record_entry_name(record_type, id)?;
        let (source_file, workspace_path) = {
            let manager = self
                .inner
                .lock()
                .map_err(|_| "workspace-state-poisoned".to_string())?;
            let workspace = open_workspace(&manager, workspace_id)?;
            ensure_record_listed(&workspace.manifest, record_type, id)?;
            if let Some(record) = workspace.loaded_records.get(&name) {
                return Ok(record.clone());
            }
            (
                workspace
                    .source_file
                    .try_clone()
                    .map_err(|error| format!("archive-open-failed: {error}"))?,
                workspace.root.join("working").join(posix_to_path(&name)),
            )
        };
        let record = if workspace_path.is_file() {
            let value: Value = read_json(&workspace_path)?;
            super::archive::validate_project_document(&value)?;
            value
        } else {
            read_record_from_file(source_file, record_type, id)?
        };
        let mut manager = self
            .inner
            .lock()
            .map_err(|_| "workspace-state-poisoned".to_string())?;
        open_workspace_mut(&mut manager, workspace_id)?
            .loaded_records
            .insert(name, record.clone());
        Ok(record)
    }

    pub fn save_to(
        &self,
        workspace_id: &str,
        destination: &Path,
        external_change_choice: ExternalChangeChoice,
        operation_id: &str,
    ) -> Result<SaveProjectResult, String> {
        let (
            source,
            source_file,
            workspace_root,
            source_signature_at_open,
            source_fingerprint,
            asset_bytes,
        ) = {
            let manager = self
                .inner
                .lock()
                .map_err(|_| "workspace-state-poisoned".to_string())?;
            let workspace = open_workspace(&manager, workspace_id)?;
            (
                workspace.source_path.clone(),
                workspace
                    .source_file
                    .try_clone()
                    .map_err(|error| format!("archive-open-failed: {error}"))?,
                workspace.root.clone(),
                workspace.source_signature.clone(),
                workspace.source_fingerprint.clone(),
                workspace
                    .manifest
                    .assets
                    .iter()
                    .try_fold(0_u64, |total, asset| total.checked_add(asset.byte_length))
                    .ok_or_else(|| "project-size-limit".to_string())?,
            )
        };
        let destination = canonical_destination(destination)?;
        let same_source = paths_equal(&source, &destination);
        if same_source {
            let source_changed = match open_archive_lazy(&source) {
                Ok(visible) => {
                    source_signature(&source, &visible.manifest_sha256)? != source_signature_at_open
                }
                Err(_) => true,
            };
            if source_changed {
                match external_change_choice {
                    ExternalChangeChoice::Cancel => {
                        self.mark_external_change(workspace_id)?;
                        return Err("external-source-changed".to_string());
                    }
                    ExternalChangeChoice::SaveAs => {
                        self.mark_external_change(workspace_id)?;
                        return Err("save-as-destination-required".to_string());
                    }
                    ExternalChangeChoice::Replace => {}
                }
            }
        }

        let save_id = random_id("save")?;
        let temporary = sibling_temporary(&destination, &save_id)?;
        let estimated = asset_bytes
            .checked_add(estimate_output_bytes(&workspace_root.join("working"))?)
            .ok_or_else(|| "project-size-limit".to_string())?;
        let available = available_space(destination.parent().unwrap_or(Path::new(".")))?;
        if available < estimated.saturating_add(SAVE_SPACE_MARGIN_BYTES) {
            return Err("insufficient-space".to_string());
        }

        let (cancelled, state_before_save) = {
            let mut manager = self
                .inner
                .lock()
                .map_err(|_| "workspace-state-poisoned".to_string())?;
            let state_before_save = open_workspace(&manager, workspace_id)?.state.clone();
            let cancelled = operation_flag(&mut manager, operation_id)?;
            let transition = if let Some(workspace) = manager.workspaces.get_mut(workspace_id) {
                workspace.state.state = "saving".to_string();
                workspace.state.updated_at = Utc::now().to_rfc3339();
                write_workspace_document(
                    &workspace.root.join("workspace-state.json"),
                    &workspace.state,
                )
            } else {
                Err("workspace-not-open".to_string())
            };
            match transition {
                Ok(()) => (cancelled, state_before_save),
                Err(error) => {
                    if let Some(workspace) = manager.workspaces.get_mut(workspace_id) {
                        workspace.state = state_before_save;
                    }
                    manager.operations.remove(operation_id);
                    return Err(error);
                }
            }
        };
        let attempt = SaveAttempt {
            workspace_id,
            save_id: &save_id,
            operation_id,
            source_fingerprint: &source_fingerprint,
            state_before_save: &state_before_save,
        };

        if let Err(error) = self.write_save_journal(
            workspace_id,
            SaveJournalDocument {
                record_type: "save-journal".to_string(),
                journal_version: 1,
                workspace_id: workspace_id.to_string(),
                save_id: save_id.clone(),
                phase: "writing".to_string(),
                started_at: Utc::now().to_rfc3339(),
                source_fingerprint: source_fingerprint.clone(),
                replacement_validated: false,
                visible_archive_reopened: false,
                directory_flush_supported: None,
            },
        ) {
            return Err(self.abort_save(&attempt, "failed", error));
        }

        let write_result = write_replacement_archive(
            Some(source_file),
            &workspace_root.join("working"),
            &temporary,
            &cancelled,
        );
        let validated = match write_result {
            Ok(value) => value,
            Err(error) => {
                let _ = fs::remove_file(&temporary);
                let phase = if error == "operation-cancelled" {
                    "cancelled"
                } else {
                    "failed"
                };
                return Err(self.abort_save(&attempt, phase, error));
            }
        };
        if cancelled.load(Ordering::Relaxed) {
            let _ = fs::remove_file(&temporary);
            return Err(self.abort_save(&attempt, "cancelled", "operation-cancelled".to_string()));
        }

        let replaced_existing = match replace_visible_archive(&temporary, &destination) {
            Ok(value) => value,
            Err(error) => {
                let _ = fs::remove_file(&temporary);
                return Err(self.abort_save(&attempt, "failed", error));
            }
        };
        let directory_flush_supported =
            flush_directory(destination.parent().unwrap_or_else(|| Path::new(".")));
        let reopened = match validate_archive(&destination) {
            Ok(value) => value,
            Err(error) => {
                return Err(self.abort_save(
                    &attempt,
                    "failed",
                    format!("visible-archive-reopen-failed: {error}"),
                ));
            }
        };
        if reopened.manifest.project_id != validated.manifest.project_id {
            return Err(self.abort_save(
                &attempt,
                "failed",
                "visible-archive-reopen-failed".to_string(),
            ));
        }

        let new_fingerprint = source_path_fingerprint(&destination)?;
        let new_signature = reopened.source_signature.clone();
        let result = SaveProjectResult {
            operation_id: operation_id.to_string(),
            save_id: save_id.clone(),
            replaced_existing,
            directory_flush_supported,
            visible_archive_reopened: true,
        };
        let workspace_commit = {
            let mut manager = self
                .inner
                .lock()
                .map_err(|_| "workspace-state-poisoned".to_string())?;
            let commit = (|| -> Result<(), String> {
                let root = initialized_root(&manager)?.clone();
                let workspace = open_workspace_mut(&mut manager, workspace_id)?;
                workspace.source_path = destination;
                workspace.source_file = Arc::new(
                    File::open(&workspace.source_path)
                        .map_err(|error| format!("archive-open-failed: {error}"))?,
                );
                workspace.source_fingerprint = new_fingerprint.clone();
                workspace.source_signature = new_signature;
                workspace.manifest = reopened.manifest;
                workspace.manifest_value = reopened.manifest_value;
                workspace.state.source_fingerprint = new_fingerprint.clone();
                workspace.state.state = "clean".to_string();
                workspace.state.dirty_record_ids.clear();
                workspace.state.new_asset_digests.clear();
                workspace.state.protected_classes.clear();
                workspace.state.updated_at = Utc::now().to_rfc3339();
                write_workspace_document(
                    &workspace.root.join("workspace-state.json"),
                    &workspace.state,
                )?;
                let complete = SaveJournalDocument {
                    record_type: "save-journal".to_string(),
                    journal_version: 1,
                    workspace_id: workspace_id.to_string(),
                    save_id,
                    phase: "complete".to_string(),
                    started_at: Utc::now().to_rfc3339(),
                    source_fingerprint: new_fingerprint.clone(),
                    replacement_validated: true,
                    visible_archive_reopened: true,
                    directory_flush_supported: Some(directory_flush_supported),
                };
                write_workspace_document(&workspace.root.join("save-journal.json"), &complete)?;
                update_registry_for_workspace(&root, workspace, &validated.manifest_sha256)
            })();
            manager.operations.remove(operation_id);
            commit
        };
        workspace_commit.map_err(|error| format!("save-workspace-commit-failed: {error}"))?;
        Ok(result)
    }

    pub fn cancel(&self, operation_id: &str) -> bool {
        let Ok(manager) = self.inner.lock() else {
            return false;
        };
        let Some(flag) = manager.operations.get(operation_id) else {
            return false;
        };
        flag.store(true, Ordering::Relaxed);
        true
    }

    pub fn close(&self, workspace_id: &str) -> Result<(), String> {
        let mut manager = self
            .inner
            .lock()
            .map_err(|_| "workspace-state-poisoned".to_string())?;
        let workspace = manager
            .workspaces
            .get_mut(workspace_id)
            .ok_or_else(|| "workspace-not-open".to_string())?;
        workspace.closed = true;
        manager
            .tokens
            .retain(|_, token| token.workspace_id != workspace_id);
        Ok(())
    }

    pub fn evict_clean_cache(
        &self,
        byte_limit: u64,
        operation_id: &str,
    ) -> Result<CacheEvictionResult, String> {
        let (mut entries, cancelled) = {
            let mut manager = self
                .inner
                .lock()
                .map_err(|_| "workspace-state-poisoned".to_string())?;
            let cancelled = operation_flag(&mut manager, operation_id)?;
            let mut entries = Vec::new();
            for workspace in manager.workspaces.values() {
                if !workspace.closed || workspace.state.state != "clean" {
                    continue;
                }
                let cache = workspace.root.join("cache").join("assets");
                let Ok(files) = fs::read_dir(cache) else {
                    continue;
                };
                for file in files.flatten() {
                    let Ok(metadata) = file.metadata() else {
                        continue;
                    };
                    if metadata.is_file()
                        && !file.file_name().to_string_lossy().ends_with(".partial")
                    {
                        entries.push((
                            file.path(),
                            metadata.len(),
                            metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                        ));
                    }
                }
            }
            (entries, cancelled)
        };
        entries.sort_by_key(|(_, _, modified)| *modified);
        let bytes_before = entries.iter().map(|(_, bytes, _)| *bytes).sum::<u64>();
        let mut bytes_after = bytes_before;
        let mut evicted_entries = 0;
        let eviction_result = (|| -> Result<(), String> {
            for (path, bytes, _) in entries {
                if bytes_after <= byte_limit || cancelled.load(Ordering::Relaxed) {
                    break;
                }
                validate_non_reparse_path(path.parent().unwrap_or(&path))?;
                fs::remove_file(&path)
                    .map_err(|error| format!("cache-eviction-failed: {error}"))?;
                bytes_after = bytes_after.saturating_sub(bytes);
                evicted_entries += 1;
            }
            Ok(())
        })();
        self.finish_operation(operation_id);
        eviction_result?;
        Ok(CacheEvictionResult {
            bytes_before,
            bytes_after,
            evicted_entries,
            cancelled: cancelled.load(Ordering::Relaxed),
        })
    }

    pub fn recovery_documents(&self) -> Result<Vec<Value>, String> {
        let manager = self
            .inner
            .lock()
            .map_err(|_| "workspace-state-poisoned".to_string())?;
        let root = initialized_root(&manager)?;
        let registry = read_registry(root)?;
        let mut documents = Vec::new();
        for entry in registry.workspaces {
            let workspace = root.join(&entry.workspace_id);
            let path = workspace.join("workspace-state.json");
            if let Ok(value) = read_workspace_document::<Value>(&path) {
                if value.get("state").and_then(Value::as_str) != Some("clean") {
                    documents.push(redact_workspace_document(value));
                }
            } else if path.exists() {
                documents.push(json_recovery_summary(
                    &entry.workspace_id,
                    &entry.project_id,
                    "corrupt-state",
                ));
            }
        }
        Ok(documents)
    }

    pub fn media_response(&self, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
        match self.try_media_response(request) {
            Ok(response) => response,
            Err((status, message)) => Response::builder()
                .status(status)
                .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
                .header(header::CACHE_CONTROL, "no-store")
                .body(message.as_bytes().to_vec())
                .unwrap_or_else(|_| Response::new(Vec::new())),
        }
    }

    fn try_media_response(
        &self,
        request: &Request<Vec<u8>>,
    ) -> Result<Response<Vec<u8>>, (StatusCode, &'static str)> {
        if request.method() != Method::GET && request.method() != Method::HEAD {
            return Err((StatusCode::METHOD_NOT_ALLOWED, "Media request denied."));
        }
        let token_text = request
            .uri()
            .path()
            .strip_prefix('/')
            .filter(|value| !value.contains('/'))
            .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .ok_or((StatusCode::NOT_FOUND, "Media request denied."))?;
        let (file, mime_type, byte_length) = {
            let mut manager = self
                .inner
                .lock()
                .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Media unavailable."))?;
            manager.tokens.retain(|_, value| {
                value.last_access.elapsed() <= Duration::from_secs(TOKEN_TTL_SECONDS)
            });
            let token = manager
                .tokens
                .get_mut(token_text)
                .ok_or((StatusCode::NOT_FOUND, "Media request denied."))?;
            if token.operation != "read" || token.digest.len() != 64 {
                return Err((StatusCode::NOT_FOUND, "Media request denied."));
            }
            token.last_access = Instant::now();
            (
                token.file.clone(),
                token.mime_type.clone(),
                token.byte_length,
            )
        };
        let range = request
            .headers()
            .get(header::RANGE)
            .and_then(|value| value.to_str().ok())
            .map(|value| parse_single_range(value, byte_length))
            .transpose()?;
        if request.method() == Method::GET
            && range.is_none()
            && byte_length > MAX_FULL_PROTOCOL_RESPONSE_BYTES
        {
            return Err((
                StatusCode::RANGE_NOT_SATISFIABLE,
                "A byte range is required.",
            ));
        }
        let (start, end, status) = range
            .map(|(start, end)| (start, end, StatusCode::PARTIAL_CONTENT))
            .unwrap_or((0, byte_length.saturating_sub(1), StatusCode::OK));
        let response_length = if byte_length == 0 { 0 } else { end - start + 1 };
        if range.is_some() && response_length > MAX_PROTOCOL_RANGE_BYTES {
            return Err((
                StatusCode::RANGE_NOT_SATISFIABLE,
                "Requested byte range is too large.",
            ));
        }
        let body = if request.method() == Method::HEAD || response_length == 0 {
            Vec::new()
        } else {
            let mut file = file
                .try_clone()
                .map_err(|_| (StatusCode::NOT_FOUND, "Media request denied."))?;
            file.seek(SeekFrom::Start(start))
                .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Media unavailable."))?;
            let mut bytes = Vec::with_capacity(response_length as usize);
            file.take(response_length)
                .read_to_end(&mut bytes)
                .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Media unavailable."))?;
            if bytes.len() as u64 != response_length {
                return Err((StatusCode::INTERNAL_SERVER_ERROR, "Media unavailable."));
            }
            bytes
        };
        let mut builder = Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, mime_type)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::CACHE_CONTROL, "private, no-store")
            .header(header::CONTENT_LENGTH, response_length.to_string())
            .header("Cross-Origin-Resource-Policy", "same-origin")
            .header("X-Content-Type-Options", "nosniff");
        if status == StatusCode::PARTIAL_CONTENT {
            builder = builder.header(
                header::CONTENT_RANGE,
                format!("bytes {start}-{end}/{byte_length}"),
            );
        }
        builder
            .body(body)
            .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Media unavailable."))
    }

    fn mark_external_change(&self, workspace_id: &str) -> Result<(), String> {
        let mut manager = self
            .inner
            .lock()
            .map_err(|_| "workspace-state-poisoned".to_string())?;
        let workspace = open_workspace_mut(&mut manager, workspace_id)?;
        workspace.state.state = "external-change".to_string();
        workspace.state.updated_at = Utc::now().to_rfc3339();
        write_workspace_document(
            &workspace.root.join("workspace-state.json"),
            &workspace.state,
        )
    }

    fn write_save_journal(
        &self,
        workspace_id: &str,
        journal: SaveJournalDocument,
    ) -> Result<(), String> {
        let manager = self
            .inner
            .lock()
            .map_err(|_| "workspace-state-poisoned".to_string())?;
        let workspace = open_workspace(&manager, workspace_id)?;
        write_workspace_document(&workspace.root.join("save-journal.json"), &journal)
    }

    fn write_failed_save_journal(
        &self,
        workspace_id: &str,
        save_id: &str,
        source_fingerprint: &str,
        state_before_save: &WorkspaceStateDocument,
        phase: &str,
    ) -> Result<(), String> {
        let journal = SaveJournalDocument {
            record_type: "save-journal".to_string(),
            journal_version: 1,
            workspace_id: workspace_id.to_string(),
            save_id: save_id.to_string(),
            phase: phase.to_string(),
            started_at: Utc::now().to_rfc3339(),
            source_fingerprint: source_fingerprint.to_string(),
            replacement_validated: false,
            visible_archive_reopened: false,
            directory_flush_supported: None,
        };
        let mut manager = self
            .inner
            .lock()
            .map_err(|_| "workspace-state-poisoned".to_string())?;
        let workspace = open_workspace_mut(&mut manager, workspace_id)?;
        write_workspace_document(&workspace.root.join("save-journal.json"), &journal)?;
        workspace.state = state_before_save.clone();
        workspace.state.updated_at = Utc::now().to_rfc3339();
        write_workspace_document(
            &workspace.root.join("workspace-state.json"),
            &workspace.state,
        )
    }

    fn abort_save(&self, attempt: &SaveAttempt<'_>, phase: &str, original_error: String) -> String {
        let recovery_result = self.write_failed_save_journal(
            attempt.workspace_id,
            attempt.save_id,
            attempt.source_fingerprint,
            attempt.state_before_save,
            phase,
        );
        self.finish_operation(attempt.operation_id);
        match recovery_result {
            Ok(()) => original_error,
            Err(recovery_error) => {
                format!("save-recovery-failed: {original_error}; {recovery_error}")
            }
        }
    }

    fn finish_operation(&self, operation_id: &str) {
        if let Ok(mut manager) = self.inner.lock() {
            manager.operations.remove(operation_id);
        }
    }

    #[cfg(test)]
    pub fn stage_asset_bytes(
        &self,
        workspace_id: &str,
        digest: &str,
        extension: &str,
        bytes: &[u8],
    ) -> Result<(), String> {
        if super::archive::sha256_bytes(bytes) != digest {
            return Err("asset-digest-mismatch".to_string());
        }
        let mut manager = self
            .inner
            .lock()
            .map_err(|_| "workspace-state-poisoned".to_string())?;
        let workspace = open_workspace_mut(&mut manager, workspace_id)?;
        let path = workspace
            .root
            .join("working")
            .join("assets")
            .join(&digest[..2])
            .join(format!("{digest}.{extension}"));
        write_bytes_atomic(&path, bytes)?;
        if !workspace
            .state
            .new_asset_digests
            .iter()
            .any(|value| value == digest)
        {
            workspace.state.new_asset_digests.push(digest.to_string());
        }
        workspace.state.state = "dirty".to_string();
        add_protected_class(&mut workspace.state, "unsaved");
        write_workspace_document(
            &workspace.root.join("workspace-state.json"),
            &workspace.state,
        )
    }
}

fn initialized_root(manager: &ManagerState) -> Result<&PathBuf, String> {
    manager
        .root
        .as_ref()
        .ok_or_else(|| "workspace-manager-not-initialized".to_string())
}

fn open_workspace<'a>(
    manager: &'a ManagerState,
    workspace_id: &str,
) -> Result<&'a WorkspaceRuntime, String> {
    let workspace = manager
        .workspaces
        .get(workspace_id)
        .ok_or_else(|| "workspace-not-open".to_string())?;
    if workspace.closed {
        Err("workspace-closed".to_string())
    } else {
        Ok(workspace)
    }
}

fn open_workspace_mut<'a>(
    manager: &'a mut ManagerState,
    workspace_id: &str,
) -> Result<&'a mut WorkspaceRuntime, String> {
    let workspace = manager
        .workspaces
        .get_mut(workspace_id)
        .ok_or_else(|| "workspace-not-open".to_string())?;
    if workspace.closed {
        Err("workspace-closed".to_string())
    } else {
        Ok(workspace)
    }
}

fn clean_workspace_state(
    workspace_id: &str,
    project_id: &str,
    source_fingerprint: &str,
    now: &str,
) -> WorkspaceStateDocument {
    WorkspaceStateDocument {
        record_type: "workspace-state".to_string(),
        workspace_version: 1,
        workspace_id: workspace_id.to_string(),
        project_id: project_id.to_string(),
        source_fingerprint: source_fingerprint.to_string(),
        state: "clean".to_string(),
        created_at: now.to_string(),
        updated_at: now.to_string(),
        dirty_record_ids: Vec::new(),
        new_asset_digests: Vec::new(),
        protected_classes: Vec::new(),
    }
}

fn stage_open_archive(
    working_dir: &Path,
    archive: &super::model::ValidatedArchive,
) -> Result<(), String> {
    write_bytes_atomic(
        &working_dir.join("manifest.json"),
        &serde_json::to_vec(&archive.manifest_value)
            .map_err(|error| format!("manifest-serialize-failed: {error}"))?,
    )?;
    for (name, value) in &archive.records {
        write_bytes_atomic(
            &working_dir.join(posix_to_path(name)),
            &serde_json::to_vec(value)
                .map_err(|error| format!("record-serialize-failed: {error}"))?,
        )?;
    }
    Ok(())
}

fn load_workspace_overlay(
    working_dir: &Path,
    archive: &super::model::ValidatedArchive,
) -> Result<(Manifest, Value, BTreeMap<String, Value>), String> {
    let manifest_value: Value = read_json(&working_dir.join("manifest.json"))?;
    super::archive::validate_project_document(&manifest_value)?;
    let manifest: Manifest = serde_json::from_value(manifest_value.clone())
        .map_err(|error| format!("manifest-invalid: {error}"))?;
    if manifest.project_id != archive.manifest.project_id {
        return Err("workspace-project-identity-mismatch".to_string());
    }
    let mut records = archive.records.clone();
    for (_, record_type, ids) in manifest.record_order.lists() {
        for id in ids {
            let name = record_entry_name(record_type, id)?;
            let path = working_dir.join(posix_to_path(&name));
            if !path.is_file() {
                continue;
            }
            let value: Value = read_json(&path)?;
            super::archive::validate_project_document(&value)?;
            if value.get("recordType").and_then(Value::as_str) != Some(record_type)
                || value.get("id").and_then(Value::as_str) != Some(id.as_str())
            {
                return Err(format!("record-identity-mismatch: {name}"));
            }
            records.insert(name, value);
        }
    }
    Ok((manifest, manifest_value, records))
}

fn ensure_record_listed(manifest: &Manifest, record_type: &str, id: &str) -> Result<(), String> {
    if manifest
        .record_order
        .lists()
        .iter()
        .any(|(_, candidate_type, ids)| {
            *candidate_type == record_type && ids.iter().any(|value| value == id)
        })
    {
        Ok(())
    } else {
        Err("record-not-listed".to_string())
    }
}

fn read_registry(root: &Path) -> Result<WorkspaceRegistryDocument, String> {
    let path = root.join("registry.json");
    if !path.exists() {
        return Ok(WorkspaceRegistryDocument {
            registry_version: 1,
            workspaces: Vec::new(),
        });
    }
    let registry: WorkspaceRegistryDocument = read_json(&path)?;
    validate_registry(&registry)?;
    Ok(registry)
}

fn validate_registry(registry: &WorkspaceRegistryDocument) -> Result<(), String> {
    if registry.registry_version != 1 || registry.workspaces.len() > 250_000 {
        return Err("workspace-registry-invalid".to_string());
    }
    let mut workspace_ids = std::collections::HashSet::new();
    let mut source_fingerprints = std::collections::HashSet::new();
    for entry in &registry.workspaces {
        validate_opaque(&entry.workspace_id)?;
        validate_opaque(&entry.project_id)?;
        if !is_sha256(&entry.source_fingerprint)
            || !is_sha256(&entry.manifest_sha256)
            || !workspace_ids.insert(entry.workspace_id.as_str())
            || !source_fingerprints.insert(entry.source_fingerprint.as_str())
        {
            return Err("workspace-registry-invalid".to_string());
        }
    }
    Ok(())
}

fn update_registry_for_workspace(
    root: &Path,
    workspace: &WorkspaceRuntime,
    manifest_sha256: &str,
) -> Result<(), String> {
    let mut registry = read_registry(root)?;
    registry
        .workspaces
        .retain(|entry| entry.workspace_id != workspace.workspace_id);
    registry.workspaces.push(WorkspaceRegistryEntry {
        workspace_id: workspace.workspace_id.clone(),
        project_id: workspace.manifest.project_id.clone(),
        source_fingerprint: workspace.source_fingerprint.clone(),
        manifest_sha256: manifest_sha256.to_string(),
    });
    write_json_atomic(&root.join("registry.json"), &registry)
}

fn write_lock(
    workspace_root: &Path,
    workspace_id: &str,
    source_fingerprint: &str,
    application_instance_id: &str,
) -> Result<(), String> {
    let lock = WorkspaceLockDocument {
        record_type: "workspace-lock".to_string(),
        lock_version: 1,
        workspace_id: workspace_id.to_string(),
        process_id: std::process::id(),
        application_instance_id: application_instance_id.to_string(),
        source_fingerprint: source_fingerprint.to_string(),
        heartbeat_at: Utc::now().to_rfc3339(),
    };
    write_workspace_document(&workspace_root.join("workspace.lock.json"), &lock)
}

fn inspect_existing_lock(
    path: &Path,
    workspace_id: &str,
    source_fingerprint: &str,
    application_instance_id: &str,
) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }
    let Ok(lock) = read_workspace_document::<WorkspaceLockDocument>(path) else {
        return Ok(true);
    };
    if lock.workspace_id != workspace_id || lock.source_fingerprint != source_fingerprint {
        return Ok(true);
    }
    if lock.process_id == std::process::id()
        && lock.application_instance_id == application_instance_id
    {
        return Ok(false);
    }
    if process_is_alive(lock.process_id) {
        return Err("workspace-live-lock".to_string());
    }
    let heartbeat = DateTime::parse_from_rfc3339(&lock.heartbeat_at)
        .map_err(|_| "workspace-lock-malformed".to_string())?
        .with_timezone(&Utc);
    if Utc::now()
        .signed_duration_since(heartbeat)
        .to_std()
        .unwrap_or_default()
        < LOCK_HEARTBEAT_TIMEOUT
    {
        return Err("workspace-owner-not-expired".to_string());
    }
    Ok(true)
}

#[cfg(windows)]
fn process_is_alive(process_id: u32) -> bool {
    use windows::Win32::{
        Foundation::CloseHandle,
        System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    };
    const STILL_ACTIVE: u32 = 259;
    let Ok(handle) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) })
    else {
        return false;
    };
    let mut code = 0_u32;
    let alive = unsafe { GetExitCodeProcess(handle, &mut code).is_ok() } && code == STILL_ACTIVE;
    let _ = unsafe { CloseHandle(handle) };
    alive
}

#[cfg(not(windows))]
fn process_is_alive(process_id: u32) -> bool {
    process_id == std::process::id()
}

fn operation_flag(
    manager: &mut ManagerState,
    operation_id: &str,
) -> Result<Arc<AtomicBool>, String> {
    validate_opaque(operation_id)?;
    if manager.operations.contains_key(operation_id) {
        return Err("operation-already-running".to_string());
    }
    let flag = Arc::new(AtomicBool::new(false));
    manager
        .operations
        .insert(operation_id.to_string(), flag.clone());
    Ok(flag)
}

fn add_protected_class(state: &mut WorkspaceStateDocument, class: &str) {
    if !state.protected_classes.iter().any(|value| value == class) {
        state.protected_classes.push(class.to_string());
    }
}

fn read_recovery_sequence(root: &Path) -> Result<u64, String> {
    Ok(
        read_workspace_document::<RecoveryJournalDocument>(&root.join("recovery-journal.json"))?
            .sequence,
    )
}

fn json_recovery_summary(workspace_id: &str, project_id: &str, state: &str) -> Value {
    serde_json::json!({
        "workspaceId": workspace_id,
        "projectId": project_id,
        "state": state
    })
}

fn redact_workspace_document(mut value: Value) -> Value {
    if let Some(object) = value.as_object_mut() {
        object.remove("sourceFingerprint");
    }
    value
}

fn parse_single_range(value: &str, size: u64) -> Result<(u64, u64), (StatusCode, &'static str)> {
    let value = value
        .strip_prefix("bytes=")
        .ok_or((StatusCode::RANGE_NOT_SATISFIABLE, "Invalid byte range."))?;
    if value.contains(',') || size == 0 {
        return Err((StatusCode::RANGE_NOT_SATISFIABLE, "Invalid byte range."));
    }
    let (start, end) = value
        .split_once('-')
        .ok_or((StatusCode::RANGE_NOT_SATISFIABLE, "Invalid byte range."))?;
    let (start, end) = if start.is_empty() {
        let suffix = end
            .parse::<u64>()
            .ok()
            .filter(|value| *value > 0)
            .ok_or((StatusCode::RANGE_NOT_SATISFIABLE, "Invalid byte range."))?;
        (size.saturating_sub(suffix.min(size)), size - 1)
    } else {
        let start = start
            .parse::<u64>()
            .map_err(|_| (StatusCode::RANGE_NOT_SATISFIABLE, "Invalid byte range."))?;
        let end = if end.is_empty() {
            size - 1
        } else {
            end.parse::<u64>()
                .map_err(|_| (StatusCode::RANGE_NOT_SATISFIABLE, "Invalid byte range."))?
        };
        (start, end.min(size - 1))
    };
    if start >= size || start > end {
        return Err((StatusCode::RANGE_NOT_SATISFIABLE, "Invalid byte range."));
    }
    Ok((start, end))
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    left.to_string_lossy()
        .eq_ignore_ascii_case(&right.to_string_lossy())
}

fn canonical_destination(path: &Path) -> Result<PathBuf, String> {
    let parent = path
        .parent()
        .ok_or_else(|| "destination-parent-missing".to_string())?;
    let parent =
        fs::canonicalize(parent).map_err(|error| format!("destination-parent-invalid: {error}"))?;
    let name = path
        .file_name()
        .ok_or_else(|| "destination-name-missing".to_string())?;
    if name.to_string_lossy().contains(['/', '\\', ':']) {
        return Err("destination-name-invalid".to_string());
    }
    Ok(parent.join(name))
}

fn sibling_temporary(destination: &Path, save_id: &str) -> Result<PathBuf, String> {
    validate_opaque(save_id)?;
    let parent = destination
        .parent()
        .ok_or_else(|| "destination-parent-missing".to_string())?;
    let name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "destination-name-invalid".to_string())?;
    Ok(parent.join(format!(".{name}.{save_id}.replacement")))
}

fn estimate_output_bytes(working: &Path) -> Result<u64, String> {
    fn visit(path: &Path, total: &mut u64) -> Result<(), String> {
        for entry in
            fs::read_dir(path).map_err(|error| format!("workspace-read-failed: {error}"))?
        {
            let entry = entry.map_err(|error| format!("workspace-read-failed: {error}"))?;
            let metadata = entry
                .metadata()
                .map_err(|error| format!("workspace-read-failed: {error}"))?;
            if metadata.is_dir() {
                visit(&entry.path(), total)?;
            } else if metadata.is_file()
                && entry.path().extension().and_then(|value| value.to_str()) == Some("json")
            {
                *total = total
                    .checked_add(metadata.len())
                    .ok_or_else(|| "project-size-limit".to_string())?;
            }
        }
        Ok(())
    }
    let mut total = 0;
    visit(working, &mut total)?;
    Ok(total)
}

#[cfg(windows)]
fn available_space(path: &Path) -> Result<u64, String> {
    use windows::{core::PCWSTR, Win32::Storage::FileSystem::GetDiskFreeSpaceExW};
    let wide = windows_extended_path(path)?;
    let mut available = 0_u64;
    unsafe {
        GetDiskFreeSpaceExW(PCWSTR(wide.as_ptr()), Some(&mut available), None, None)
            .map_err(|error| format!("space-check-failed: {error}"))?;
    }
    Ok(available)
}

#[cfg(not(windows))]
fn available_space(_path: &Path) -> Result<u64, String> {
    Ok(u64::MAX)
}

fn validate_workspace_root(path: &Path, root: &Path) -> Result<(), String> {
    let path = fs::canonicalize(path)
        .map_err(|error| format!("workspace-canonicalization-failed: {error}"))?;
    let root = fs::canonicalize(root)
        .map_err(|error| format!("workspace-canonicalization-failed: {error}"))?;
    if !path.starts_with(&root) {
        return Err("workspace-boundary-invalid".to_string());
    }
    validate_non_reparse_path(&path)
}

fn validate_non_reparse_path(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        let Ok(metadata) = fs::symlink_metadata(ancestor) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            return Err("workspace-reparse-rejected".to_string());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err("workspace-reparse-rejected".to_string());
            }
        }
    }
    Ok(())
}

fn write_json_atomic<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec(value)
        .map_err(|error| format!("workspace-json-serialize-failed: {error}"))?;
    write_bytes_atomic(path, &bytes)
}

fn write_workspace_document<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let value = serde_json::to_value(value)
        .map_err(|error| format!("workspace-json-serialize-failed: {error}"))?;
    let validator = workspace_schema_validator()?;
    validator
        .validate(&value)
        .map_err(|error| format!("workspace-schema-validation-failed: {error}"))?;
    write_json_atomic(path, &value)
}

fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "workspace-path-parent-missing".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("workspace-create-failed: {error}"))?;
    validate_non_reparse_path(parent)?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("document"),
        random_secret_hex()?
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| format!("workspace-temporary-create-failed: {error}"))?;
    let result = file
        .write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("workspace-write-failed: {error}"));
    drop(file);
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    let commit_result = if path.exists() {
        replace_visible_archive(&temporary, path).map(|_| ())
    } else {
        fs::rename(&temporary, path).map_err(|error| format!("workspace-commit-failed: {error}"))
    };
    if let Err(error) = commit_result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(())
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    if fs::metadata(path)
        .map_err(|error| format!("workspace-json-read-failed: {error}"))?
        .len()
        > MAX_JSON_BYTES
    {
        return Err("workspace-json-size-limit".to_string());
    }
    let bytes = fs::read(path).map_err(|error| format!("workspace-json-read-failed: {error}"))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("workspace-json-invalid: {error}"))
}

fn read_workspace_document<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    let value: Value = read_json(path)?;
    let validator = workspace_schema_validator()?;
    validator
        .validate(&value)
        .map_err(|error| format!("workspace-schema-validation-failed: {error}"))?;
    serde_json::from_value(value).map_err(|error| format!("workspace-json-invalid: {error}"))
}

fn workspace_schema_validator() -> Result<&'static jsonschema::Validator, String> {
    WORKSPACE_SCHEMA_VALIDATOR
        .get_or_init(|| {
            let schema: Value = serde_json::from_str(include_str!(
                "../../../docs/schemas/workspace-v1.schema.json"
            ))
            .map_err(|error| format!("workspace-schema-invalid: {error}"))?;
            jsonschema::draft202012::new(&schema)
                .map_err(|error| format!("workspace-schema-invalid: {error}"))
        })
        .as_ref()
        .map_err(Clone::clone)
}

fn random_id(prefix: &str) -> Result<String, String> {
    Ok(format!("{prefix}-{}", &random_secret_hex()?[..32]))
}

fn random_secret_hex() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| format!("random-generation-failed: {error}"))?;
    Ok(hex_lower(&bytes))
}

fn validate_opaque(value: &str) -> Result<(), String> {
    if (3..=96).contains(&value.len())
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b'-'))
        })
    {
        Ok(())
    } else {
        Err("opaque-id-invalid".to_string())
    }
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
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

fn posix_to_path(name: &str) -> PathBuf {
    name.split('/').collect()
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    use std::fs::OpenOptions;
    #[cfg(windows)]
    use std::os::windows::fs::OpenOptionsExt;
    use std::{
        fs::{self, File},
        io::Write,
        path::{Path, PathBuf},
        sync::{atomic::AtomicBool, Arc},
        time::{Instant, SystemTime},
    };

    use serde_json::{json, Value};
    use tauri::http::{header, Method, Request, StatusCode};
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

    use super::{
        operation_flag, parse_single_range, random_secret_hex, AssetToken, ExternalChangeChoice,
        ProjectV2Manager, MAX_FULL_PROTOCOL_RESPONSE_BYTES,
    };
    use crate::project_v2::archive::{sha256_bytes, validate_archive, write_replacement_archive};

    #[test]
    fn generates_256_bit_opaque_tokens() {
        let first = random_secret_hex().unwrap();
        let second = random_secret_hex().unwrap();
        assert_eq!(first.len(), 64);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(first, second);
        assert!(!first.contains(['/', '\\', ':']));
    }

    #[test]
    fn validates_single_byte_ranges() {
        assert_eq!(parse_single_range("bytes=0-9", 100).unwrap(), (0, 9));
        assert_eq!(parse_single_range("bytes=90-", 100).unwrap(), (90, 99));
        assert_eq!(parse_single_range("bytes=-10", 100).unwrap(), (90, 99));
        assert_eq!(
            parse_single_range("bytes=100-101", 100).unwrap_err().0,
            StatusCode::RANGE_NOT_SATISFIABLE
        );
        assert!(parse_single_range("bytes=0-1,4-5", 100).is_err());
    }

    #[test]
    fn permits_head_metadata_for_assets_larger_than_the_full_get_limit() {
        let root = temp_test_dir("v2-large-head");
        fs::create_dir_all(&root).unwrap();
        let asset_path = root.join("large-asset.mp4");
        let file = File::create(&asset_path).unwrap();
        let byte_length = MAX_FULL_PROTOCOL_RESPONSE_BYTES + 1;
        file.set_len(byte_length).unwrap();

        let token = "a".repeat(64);
        let manager = ProjectV2Manager::default();
        manager.inner.lock().unwrap().tokens.insert(
            token.clone(),
            AssetToken {
                workspace_id: "workspace-large-head".to_string(),
                digest: "b".repeat(64),
                operation: "read",
                file: Arc::new(file),
                mime_type: "video/mp4".to_string(),
                byte_length,
                last_access: Instant::now(),
            },
        );

        let head = Request::builder()
            .method(Method::HEAD)
            .uri(format!("gamebook-media://asset/{token}"))
            .body(Vec::new())
            .unwrap();
        let head_response = manager.media_response(&head);
        assert_eq!(head_response.status(), StatusCode::OK);
        assert!(head_response.body().is_empty());
        assert_eq!(
            head_response.headers().get(header::CONTENT_LENGTH).unwrap(),
            byte_length.to_string().as_str()
        );

        let get = Request::builder()
            .method(Method::GET)
            .uri(format!("gamebook-media://asset/{token}"))
            .body(Vec::new())
            .unwrap();
        assert_eq!(
            manager.media_response(&get).status(),
            StatusCode::RANGE_NOT_SATISFIABLE
        );

        drop(manager);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn completes_the_version_two_workspace_archive_round_trip() {
        let root = temp_test_dir("v2-round-trip");
        let source = root.join("source.gamebook");
        let copied = root.join("copied.gamebook");
        let destination = root.join("saved.gamebook");
        fs::create_dir_all(&root).unwrap();
        let asset = b"synthetic-screenshot-pixels";
        write_fixture_archive(&source, "Synthetic project", asset);
        fs::copy(&source, &copied).unwrap();
        let source_before = fs::read(&source).unwrap();

        let manager = ProjectV2Manager::default();
        manager.initialize(&root.join("app-data")).unwrap();
        let opened = manager.open_path(&source).unwrap();
        assert!(!opened.reused_workspace);
        assert!(!opened.copy_detected);
        assert!(!opened.recovery_required);
        assert_eq!(opened.records.len(), 2);
        let secondary = manager
            .read_record(&opened.workspace_id, "page", "page-secondary")
            .unwrap();
        assert_eq!(secondary.get("title").and_then(Value::as_str), Some("2"));
        let serialized = serde_json::to_string(&opened).unwrap();
        assert!(!serialized.contains(source.to_string_lossy().as_ref()));
        assert!(!serialized.contains("version-2-workspaces"));

        let reused = manager.open_path(&source).unwrap();
        assert!(reused.reused_workspace);
        assert_eq!(reused.workspace_id, opened.workspace_id);
        let copy = manager.open_path(&copied).unwrap();
        assert!(copy.copy_detected);
        assert_ne!(copy.workspace_id, opened.workspace_id);

        let (source_file, working) = {
            let state = manager.inner.lock().unwrap();
            let workspace = state.workspaces.get(&opened.workspace_id).unwrap();
            (
                workspace.source_file.try_clone().unwrap(),
                workspace.root.join("working"),
            )
        };
        let cancelled_output = root.join("cancelled.replacement");
        let cancelled = AtomicBool::new(true);
        assert_eq!(
            write_replacement_archive(Some(source_file), &working, &cancelled_output, &cancelled,)
                .unwrap_err(),
            "operation-cancelled"
        );
        assert!(!cancelled_output.exists());
        assert_eq!(fs::read(&source).unwrap(), source_before);

        let digest = sha256_bytes(asset);
        let materialized = manager
            .materialize(&opened.workspace_id, &digest, "materialize-round-trip")
            .unwrap();
        assert_eq!(materialized.token.len(), 64);
        assert_eq!(materialized.byte_length, asset.len() as u64);
        let request = Request::builder()
            .method(Method::GET)
            .uri(format!("gamebook-media://asset/{}", materialized.token))
            .header(header::RANGE, "bytes=2-8")
            .body(Vec::new())
            .unwrap();
        let response = manager.media_response(&request);
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body(), &asset[2..=8]);
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_RANGE)
                .unwrap()
                .to_str()
                .unwrap(),
            format!("bytes 2-8/{}", asset.len())
        );
        let denied_method = Request::builder()
            .method(Method::POST)
            .uri(format!("gamebook-media://asset/{}", materialized.token))
            .body(Vec::new())
            .unwrap();
        assert_eq!(
            manager.media_response(&denied_method).status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
        let denied_path = Request::builder()
            .method(Method::GET)
            .uri(format!(
                "gamebook-media://asset/{}/extra",
                materialized.token
            ))
            .body(Vec::new())
            .unwrap();
        assert_eq!(
            manager.media_response(&denied_path).status(),
            StatusCode::NOT_FOUND
        );
        manager
            .stage_asset_bytes(&opened.workspace_id, &digest, "png", asset)
            .unwrap();

        let mut page = opened
            .records
            .iter()
            .find(|record| record.get("recordType") == Some(&Value::String("page".to_string())))
            .unwrap()
            .clone();
        page["notes"] = Value::String("Saved through the workspace journal.".to_string());
        manager.stage_document(&opened.workspace_id, page).unwrap();
        manager.autosave(&opened.workspace_id).unwrap();
        let recovery = manager.recovery_documents().unwrap();
        assert_eq!(recovery.len(), 1);
        assert!(recovery[0].get("sourceFingerprint").is_none());

        let saved = manager
            .save_to(
                &opened.workspace_id,
                &destination,
                ExternalChangeChoice::SaveAs,
                "save-round-trip",
            )
            .unwrap();
        assert!(!saved.replaced_existing);
        assert!(saved.visible_archive_reopened);
        assert_eq!(fs::read(&source).unwrap(), source_before);
        let validated = validate_archive(&destination).unwrap();
        assert_eq!(validated.manifest.title, "Synthetic project");
        assert!(validated.records.values().any(|record| {
            record.get("notes").and_then(Value::as_str)
                == Some("Saved through the workspace journal.")
        }));

        manager.close(&opened.workspace_id).unwrap();
        assert_eq!(
            manager.media_response(&request).status(),
            StatusCode::NOT_FOUND
        );
        let evicted = manager.evict_clean_cache(0, "evict-round-trip").unwrap();
        assert_eq!(evicted.bytes_after, 0);
        assert_eq!(evicted.evicted_entries, 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn save_preflight_preserves_state_and_operation_registry() {
        let root = temp_test_dir("v2-save-preflight");
        let source = root.join("source.gamebook");
        let destination = root.join("saved.gamebook");
        fs::create_dir_all(&root).unwrap();
        write_fixture_archive(&source, "Save preflight project", b"save-preflight-asset");

        let manager = ProjectV2Manager::default();
        manager.initialize(&root.join("app-data")).unwrap();
        let opened = manager.open_path(&source).unwrap();
        let mut page = opened
            .records
            .iter()
            .find(|record| record.get("recordType").and_then(Value::as_str) == Some("page"))
            .unwrap()
            .clone();
        page["notes"] = Value::String("Unsaved preflight note".to_string());
        manager.stage_document(&opened.workspace_id, page).unwrap();
        let state_before = {
            let state = manager.inner.lock().unwrap();
            state
                .workspaces
                .get(&opened.workspace_id)
                .unwrap()
                .state
                .clone()
        };

        let invalid = root.join("missing-parent").join("saved.gamebook");
        assert!(manager
            .save_to(
                &opened.workspace_id,
                &invalid,
                ExternalChangeChoice::SaveAs,
                "save-invalid-destination",
            )
            .unwrap_err()
            .starts_with("destination-parent-invalid:"));
        {
            let state = manager.inner.lock().unwrap();
            let workspace = state.workspaces.get(&opened.workspace_id).unwrap();
            assert_eq!(workspace.state.state, state_before.state);
            assert_eq!(
                workspace.state.dirty_record_ids,
                state_before.dirty_record_ids
            );
            assert_eq!(
                workspace.state.protected_classes,
                state_before.protected_classes
            );
            assert!(state.operations.is_empty());
        }

        {
            let mut state = manager.inner.lock().unwrap();
            operation_flag(&mut state, "save-duplicate-operation").unwrap();
        }
        assert_eq!(
            manager
                .save_to(
                    &opened.workspace_id,
                    &destination,
                    ExternalChangeChoice::SaveAs,
                    "save-duplicate-operation",
                )
                .unwrap_err(),
            "operation-already-running"
        );
        {
            let mut state = manager.inner.lock().unwrap();
            let workspace = state.workspaces.get(&opened.workspace_id).unwrap();
            assert_eq!(workspace.state.state, state_before.state);
            assert_eq!(
                workspace.state.dirty_record_ids,
                state_before.dirty_record_ids
            );
            assert_eq!(state.operations.len(), 1);
            state.operations.remove("save-duplicate-operation");
        }
        assert!(!destination.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn materialization_rejects_digest_mismatch_without_partial_visibility() {
        let root = temp_test_dir("v2-materialize-digest");
        let source = root.join("source.gamebook");
        fs::create_dir_all(&root).unwrap();
        let expected = b"expected-screenshot";
        let actual = b"tampered-screenshot";
        let digest = sha256_bytes(expected);
        write_fixture_archive_with_declared_asset(
            &source,
            "Digest mismatch project",
            actual,
            &digest,
        );

        let manager = ProjectV2Manager::default();
        manager.initialize(&root.join("app-data")).unwrap();
        let opened = manager.open_path(&source).unwrap();
        assert_eq!(
            manager
                .materialize(&opened.workspace_id, &digest, "materialize-digest-mismatch")
                .unwrap_err(),
            "asset-digest-mismatch"
        );
        let state = manager.inner.lock().unwrap();
        let cache = state
            .workspaces
            .get(&opened.workspace_id)
            .unwrap()
            .root
            .join("cache")
            .join("assets");
        assert!(!cache.join(&digest).exists());
        assert!(state.operations.is_empty());
        drop(state);
        assert!(!fs::read_dir(&cache)
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().ends_with(".partial")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn classifies_live_fresh_dead_and_malformed_workspace_locks() {
        let root = temp_test_dir("v2-lock-classification");
        let app_data = root.join("app-data");
        let source = root.join("source.gamebook");
        fs::create_dir_all(&root).unwrap();
        write_fixture_archive(&source, "Lock project", b"lock-screenshot");

        let owner = ProjectV2Manager::default();
        owner.initialize(&app_data).unwrap();
        let opened = owner.open_path(&source).unwrap();
        let workspace_root = {
            let state = owner.inner.lock().unwrap();
            state
                .workspaces
                .get(&opened.workspace_id)
                .unwrap()
                .root
                .clone()
        };

        let contender = ProjectV2Manager::default();
        contender.initialize(&app_data).unwrap();
        assert_eq!(
            contender.open_path(&source).unwrap_err(),
            "workspace-live-lock"
        );
        owner.close(&opened.workspace_id).unwrap();

        let source_fingerprint = {
            let state = owner.inner.lock().unwrap();
            state
                .workspaces
                .get(&opened.workspace_id)
                .unwrap()
                .source_fingerprint
                .clone()
        };
        fs::write(
            workspace_root.join("workspace.lock.json"),
            serde_json::to_vec(&json!({
                "recordType": "workspace-lock",
                "lockVersion": 1,
                "workspaceId": opened.workspace_id,
                "processId": 4294967294_u32,
                "applicationInstanceId": "application-instance-ended",
                "sourceFingerprint": source_fingerprint,
                "heartbeatAt": chrono::Utc::now().to_rfc3339()
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            contender.open_path(&source).unwrap_err(),
            "workspace-owner-not-expired"
        );

        fs::write(
            workspace_root.join("workspace.lock.json"),
            b"{malformed lock",
        )
        .unwrap();
        let recovered = contender.open_path(&source).unwrap();
        assert!(recovered.recovery_required);
        assert_eq!(recovered.workspace_id, opened.workspace_id);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_registry_entries_that_could_escape_the_workspace_root() {
        let root = temp_test_dir("v2-registry-boundary");
        let app_data = root.join("app-data");
        fs::create_dir_all(&root).unwrap();
        let manager = ProjectV2Manager::default();
        manager.initialize(&app_data).unwrap();
        fs::write(
            app_data.join("version-2-workspaces").join("registry.json"),
            serde_json::to_vec(&json!({
                "registryVersion": 1,
                "workspaces": [{
                    "workspaceId": "../outside",
                    "projectId": "project-registry-boundary",
                    "sourceFingerprint": "0".repeat(64),
                    "manifestSha256": "1".repeat(64)
                }]
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            manager.recovery_documents().unwrap_err(),
            "opaque-id-invalid"
        );
        assert!(!root.join("outside").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn cache_eviction_failure_releases_the_operation_handle() {
        let root = temp_test_dir("v2-cache-failure");
        let source = root.join("source.gamebook");
        fs::create_dir_all(&root).unwrap();
        let asset = b"read-only-cache-asset";
        write_fixture_archive(&source, "Cache failure project", asset);

        let manager = ProjectV2Manager::default();
        manager.initialize(&root.join("app-data")).unwrap();
        let opened = manager.open_path(&source).unwrap();
        let digest = sha256_bytes(asset);
        manager
            .materialize(&opened.workspace_id, &digest, "materialize-read-only")
            .unwrap();
        let cache_path = {
            let state = manager.inner.lock().unwrap();
            state
                .workspaces
                .get(&opened.workspace_id)
                .unwrap()
                .root
                .join("cache")
                .join("assets")
                .join(format!("{digest}.png"))
        };
        manager.close(&opened.workspace_id).unwrap();
        let exclusive_handle = OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&cache_path)
            .unwrap();
        assert!(manager
            .evict_clean_cache(0, "evict-read-only-cache")
            .unwrap_err()
            .starts_with("cache-eviction-failed:"));
        assert!(manager.inner.lock().unwrap().operations.is_empty());

        drop(exclusive_handle);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn external_change_requires_an_explicit_choice_and_preserves_both_sources() {
        let root = temp_test_dir("v2-external-change");
        let source = root.join("source.gamebook");
        let save_as = root.join("save-as.gamebook");
        fs::create_dir_all(&root).unwrap();
        let asset = b"original-screenshot";
        write_fixture_archive(&source, "Original project", asset);

        let manager = ProjectV2Manager::default();
        manager.initialize(&root.join("app-data")).unwrap();
        let opened = manager.open_path(&source).unwrap();
        write_fixture_archive(&source, "Externally changed project", asset);
        let external_bytes = fs::read(&source).unwrap();

        let error = manager
            .save_to(
                &opened.workspace_id,
                &source,
                ExternalChangeChoice::Cancel,
                "save-external-cancel",
            )
            .unwrap_err();
        assert_eq!(error, "external-source-changed");
        assert_eq!(fs::read(&source).unwrap(), external_bytes);

        let saved = manager
            .save_to(
                &opened.workspace_id,
                &save_as,
                ExternalChangeChoice::SaveAs,
                "save-external-as",
            )
            .unwrap();
        assert!(saved.visible_archive_reopened);
        assert_eq!(fs::read(&source).unwrap(), external_bytes);
        assert_eq!(
            validate_archive(&save_as).unwrap().manifest.title,
            "Original project"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stale_lock_and_corrupt_state_preserve_recoverable_workspace_changes() {
        let root = temp_test_dir("v2-stale-recovery");
        let app_data = root.join("app-data");
        let source = root.join("source.gamebook");
        fs::create_dir_all(&root).unwrap();
        write_fixture_archive(&source, "Recoverable project", b"recoverable-screenshot");

        let first = ProjectV2Manager::default();
        first.initialize(&app_data).unwrap();
        let opened = first.open_path(&source).unwrap();
        let mut page = opened
            .records
            .iter()
            .find(|record| record.get("recordType").and_then(Value::as_str) == Some("page"))
            .unwrap()
            .clone();
        page["notes"] = Value::String("Unsaved recovery note".to_string());
        first.stage_document(&opened.workspace_id, page).unwrap();
        first.autosave(&opened.workspace_id).unwrap();
        let (workspace_root, source_fingerprint) = {
            let state = first.inner.lock().unwrap();
            let workspace = state.workspaces.get(&opened.workspace_id).unwrap();
            (workspace.root.clone(), workspace.source_fingerprint.clone())
        };
        first.close(&opened.workspace_id).unwrap();

        fs::write(
            workspace_root.join("workspace.lock.json"),
            serde_json::to_vec(&json!({
                "recordType": "workspace-lock",
                "lockVersion": 1,
                "workspaceId": opened.workspace_id.clone(),
                "processId": 4294967294_u32,
                "applicationInstanceId": "application-instance-ended",
                "sourceFingerprint": source_fingerprint,
                "heartbeatAt": "2020-01-01T00:00:00.000Z"
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            workspace_root.join("workspace-state.json"),
            b"{corrupt workspace state",
        )
        .unwrap();

        let second = ProjectV2Manager::default();
        second.initialize(&app_data).unwrap();
        let summaries = second.recovery_documents().unwrap();
        assert!(summaries.iter().any(|summary| {
            summary.get("workspaceId").and_then(Value::as_str) == Some(opened.workspace_id.as_str())
                && summary.get("state").and_then(Value::as_str) == Some("corrupt-state")
                && summary.get("sourceFingerprint").is_none()
        }));
        let recovered = second.open_path(&source).unwrap();
        assert!(recovered.recovery_required);
        assert_eq!(recovered.workspace_id, opened.workspace_id);
        assert!(recovered.records.iter().any(|record| {
            record.get("notes").and_then(Value::as_str) == Some("Unsaved recovery note")
        }));
        assert!(fs::read_dir(&workspace_root)
            .unwrap()
            .flatten()
            .any(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("workspace-state.corrupt.")
            }));
        fs::remove_dir_all(root).unwrap();
    }

    fn write_fixture_archive(path: &Path, title: &str, asset: &[u8]) {
        write_fixture_archive_with_declared_asset(path, title, asset, &sha256_bytes(asset));
    }

    fn write_fixture_archive_with_declared_asset(
        path: &Path,
        title: &str,
        asset: &[u8],
        digest: &str,
    ) {
        if path.exists() {
            fs::remove_file(path).unwrap();
        }
        let manifest = json!({
            "formatVersion": 2,
            "minimumReaderVersion": 2,
            "projectId": "project-workspace-fixture",
            "title": title,
            "createdAt": "2026-08-03T00:00:00.000Z",
            "updatedAt": "2026-08-03T00:00:01.000Z",
            "activePageId": "page-primary",
            "recordOrder": {
                "pages": ["page-primary", "page-secondary"],
                "evidence": ["evidence-primary", "evidence-secondary"],
                "timelines": [],
                "findings": [],
                "tags": [],
                "collections": [],
                "relationships": [],
                "sessions": [],
                "trash": []
            },
            "assets": [{
                "digest": digest,
                "byteLength": asset.len(),
                "mediaClass": "image",
                "mimeType": "image/png",
                "extension": "png",
                "storageMethod": "stored"
            }]
        });
        let evidence = json!({
            "recordType": "evidence",
            "recordVersion": 1,
            "id": "evidence-primary",
            "title": "Synthetic screenshot",
            "createdAt": "2026-08-03T00:00:00.000Z",
            "updatedAt": "2026-08-03T00:00:00.000Z",
            "kind": "screenshot",
            "sessionId": null,
            "tagIds": [],
            "provenance": { "origin": "capture", "parentEvidenceIds": [], "importedAt": null, "originalFilename": null },
            "assetDigest": digest,
            "image": { "width": 320, "height": 180, "colorSpace": "srgb", "monitorLabel": "Synthetic display" }
        });
        let mut evidence_secondary = evidence.clone();
        evidence_secondary["id"] = Value::String("evidence-secondary".to_string());
        evidence_secondary["title"] = Value::String("Second screenshot".to_string());
        let page = json!({
            "recordType": "page",
            "recordVersion": 1,
            "id": "page-primary",
            "title": "1",
            "createdAt": "2026-08-03T00:00:00.000Z",
            "updatedAt": "2026-08-03T00:00:01.000Z",
            "primaryEvidenceId": "evidence-primary",
            "backgroundColor": "#f7f7f5",
            "placements": [{
                "type": "MediaPlacement",
                "placementVersion": 1,
                "id": "placement-primary",
                "evidenceId": "evidence-primary",
                "left": 68,
                "top": 112,
                "scaleX": 1,
                "scaleY": 1,
                "angle": 0,
                "zIndex": 0
            }],
            "annotations": [],
            "annotationOrder": [],
            "connectors": [],
            "notes": ""
        });
        let mut page_secondary = page.clone();
        page_secondary["id"] = Value::String("page-secondary".to_string());
        page_secondary["title"] = Value::String("2".to_string());
        page_secondary["primaryEvidenceId"] = Value::String("evidence-secondary".to_string());
        page_secondary["placements"][0]["id"] = Value::String("placement-secondary".to_string());
        page_secondary["placements"][0]["evidenceId"] =
            Value::String("evidence-secondary".to_string());
        let file = File::create(path).unwrap();
        let mut writer = ZipWriter::new(file);
        let json_options =
            SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        let asset_options =
            SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        for (name, value) in [
            ("manifest.json", manifest),
            ("records/evidence/evidence-primary.json", evidence),
            (
                "records/evidence/evidence-secondary.json",
                evidence_secondary,
            ),
            ("records/pages/page-primary.json", page),
            ("records/pages/page-secondary.json", page_secondary),
        ] {
            writer.start_file(name, json_options).unwrap();
            writer
                .write_all(&serde_json::to_vec(&value).unwrap())
                .unwrap();
        }
        writer
            .start_file(
                format!("assets/{}/{}.png", &digest[..2], digest),
                asset_options,
            )
            .unwrap();
        writer.write_all(asset).unwrap();
        writer.finish().unwrap().sync_all().unwrap();
    }

    fn temp_test_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("gamebook-{name}-{nonce}"))
    }
}
