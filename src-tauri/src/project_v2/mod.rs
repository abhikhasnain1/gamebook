mod archive;
mod migration;
mod model;
mod trash;
mod workspace;

use std::{path::Path, sync::Arc};

use serde_json::json;
use tauri::{Manager, State, WebviewWindow};

pub use model::{
    CacheEvictionResult, ExternalChangeChoice, MaterializedAssetResult, MigrationProjectResult,
    OpenProjectResult, SaveProjectResult,
};
pub use trash::{TrashImpact, TrashMutationResult, TrashState, TrashTarget};
pub use workspace::ProjectV2Manager;

pub(crate) fn replace_file_atomic(temporary: &Path, destination: &Path) -> Result<(), String> {
    archive::replace_visible_archive(temporary, destination).map(|_| ())
}

#[tauri::command]
pub async fn create_project_v2(
    manager: State<'_, Arc<ProjectV2Manager>>,
) -> Result<OpenProjectResult, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.create_unsaved())
        .await
        .map_err(|error| format!("Version 2 project-create worker failed: {error}"))?
}

#[tauri::command]
pub async fn recover_project_v2_workspace(
    manager: State<'_, Arc<ProjectV2Manager>>,
    workspace_id: String,
) -> Result<OpenProjectResult, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.recover_unsaved(&workspace_id))
        .await
        .map_err(|error| format!("Version 2 recovery worker failed: {error}"))?
}

#[tauri::command]
pub async fn open_project_for_editor(
    window: WebviewWindow,
    manager: State<'_, Arc<ProjectV2Manager>>,
    operation_id: String,
) -> Result<Option<serde_json::Value>, String> {
    let Some(path) = rfd::FileDialog::new()
        .set_parent(&window)
        .add_filter("Gamebook project", &["gamebook"])
        .pick_file()
    else {
        return Ok(None);
    };
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        open_path_for_editor(&manager, &path, &operation_id)
    })
    .await
    .map_err(|error| format!("Project open worker failed: {error}"))?
    .map(Some)
}

fn open_path_for_editor(
    manager: &ProjectV2Manager,
    path: &Path,
    operation_id: &str,
) -> Result<serde_json::Value, String> {
    if archive::open_archive_lazy(path).is_ok() {
        return match manager.open_path(path) {
            Ok(project) => serde_json::to_value(project)
                .map(|project| json!({ "outcome": "opened", "project": project }))
                .map_err(|error| format!("editor-open-result-invalid: {error}")),
            Err(error) => Err(error),
        };
    }
    match manager.migrate_v1_path(path, operation_id) {
        Ok(project) => serde_json::to_value(project)
            .map(|project| json!({ "outcome": "migrated", "project": project }))
            .map_err(|error| format!("editor-open-result-invalid: {error}")),
        Err(error) if error == "operation-cancelled" => Err(error),
        Err(error) if error == "future-version-rejected" => Ok(json!({
            "outcome": "future-version-rejected",
            "code": "future-version-rejected"
        })),
        Err(_) => migration::inspect_repair(path)
            .map(|report| json!({ "outcome": "repair", "report": report })),
    }
}

#[tauri::command]
pub fn claim_screenshot_capture(
    manager: State<'_, Arc<ProjectV2Manager>>,
    workspace_id: String,
    capture_id: String,
) -> Result<MaterializedAssetResult, String> {
    manager.claim_pending_capture(&workspace_id, &capture_id)
}

#[tauri::command]
pub async fn open_project_v2(
    window: WebviewWindow,
    manager: State<'_, Arc<ProjectV2Manager>>,
) -> Result<Option<OpenProjectResult>, String> {
    let Some(path) = rfd::FileDialog::new()
        .set_parent(&window)
        .add_filter("Gamebook project", &["gamebook"])
        .pick_file()
    else {
        return Ok(None);
    };
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.open_path(&path))
        .await
        .map_err(|error| format!("Version 2 open worker failed: {error}"))?
        .map(Some)
}

#[tauri::command]
pub async fn migrate_project_v1(
    window: WebviewWindow,
    manager: State<'_, Arc<ProjectV2Manager>>,
    operation_id: String,
) -> Result<Option<MigrationProjectResult>, String> {
    let Some(path) = rfd::FileDialog::new()
        .set_parent(&window)
        .add_filter("Gamebook project", &["gamebook"])
        .pick_file()
    else {
        return Ok(None);
    };
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.migrate_v1_path(&path, &operation_id))
        .await
        .map_err(|error| format!("Version 1 migration worker failed: {error}"))?
        .map(Some)
}

#[tauri::command]
pub async fn inspect_project_v2_repair(
    window: WebviewWindow,
) -> Result<Option<serde_json::Value>, String> {
    let Some(path) = rfd::FileDialog::new()
        .set_parent(&window)
        .add_filter("Gamebook project", &["gamebook"])
        .pick_file()
    else {
        return Ok(None);
    };
    tauri::async_runtime::spawn_blocking(move || migration::inspect_repair(&path))
        .await
        .map_err(|error| format!("Project repair inspection worker failed: {error}"))?
        .map(Some)
}

#[tauri::command]
pub async fn stage_project_v2_document(
    manager: State<'_, Arc<ProjectV2Manager>>,
    workspace_id: String,
    document: serde_json::Value,
) -> Result<(), String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.stage_document(&workspace_id, document))
        .await
        .map_err(|error| format!("Version 2 document-stage worker failed: {error}"))?
}

#[tauri::command]
pub async fn read_project_v2_record(
    manager: State<'_, Arc<ProjectV2Manager>>,
    workspace_id: String,
    record_type: String,
    record_id: String,
) -> Result<serde_json::Value, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.read_record(&workspace_id, &record_type, &record_id)
    })
    .await
    .map_err(|error| format!("Version 2 record-read worker failed: {error}"))?
}

#[tauri::command]
pub async fn autosave_project_v2_workspace(
    manager: State<'_, Arc<ProjectV2Manager>>,
    workspace_id: String,
) -> Result<(), String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.autosave(&workspace_id))
        .await
        .map_err(|error| format!("Version 2 autosave worker failed: {error}"))?
}

#[tauri::command]
pub async fn materialize_project_v2_asset(
    manager: State<'_, Arc<ProjectV2Manager>>,
    workspace_id: String,
    digest: String,
    operation_id: String,
) -> Result<MaterializedAssetResult, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.materialize(&workspace_id, &digest, &operation_id)
    })
    .await
    .map_err(|error| format!("Asset materialization worker failed: {error}"))?
}

#[tauri::command]
pub async fn save_project_v2(
    window: WebviewWindow,
    manager: State<'_, Arc<ProjectV2Manager>>,
    workspace_id: String,
    save_as: bool,
    external_change_choice: ExternalChangeChoice,
    operation_id: String,
) -> Result<Option<SaveProjectResult>, String> {
    let destination = if save_as {
        rfd::FileDialog::new()
            .set_parent(&window)
            .add_filter("Gamebook project", &["gamebook"])
            .set_file_name("project.gamebook")
            .save_file()
    } else {
        Some(manager.current_source_path(&workspace_id)?)
    };
    let Some(destination) = destination else {
        return Ok(None);
    };
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.save_to(
            &workspace_id,
            &destination,
            external_change_choice,
            &operation_id,
        )
    })
    .await
    .map_err(|error| format!("Version 2 Save worker failed: {error}"))?
    .map(Some)
}

#[tauri::command]
pub fn cancel_project_v2_operation(
    manager: State<'_, Arc<ProjectV2Manager>>,
    operation_id: String,
) -> bool {
    manager.cancel(&operation_id)
}

#[tauri::command]
pub fn close_project_v2_workspace(
    manager: State<'_, Arc<ProjectV2Manager>>,
    workspace_id: String,
) -> Result<(), String> {
    manager.close(&workspace_id)
}

#[tauri::command]
pub async fn evict_project_v2_clean_cache(
    manager: State<'_, Arc<ProjectV2Manager>>,
    byte_limit: u64,
    operation_id: String,
) -> Result<CacheEvictionResult, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.evict_clean_cache(byte_limit, &operation_id)
    })
    .await
    .map_err(|error| format!("Cache eviction worker failed: {error}"))?
}

#[tauri::command]
pub fn list_project_v2_recovery(
    manager: State<'_, Arc<ProjectV2Manager>>,
) -> Result<Vec<serde_json::Value>, String> {
    manager.recovery_documents()
}

#[tauri::command]
pub async fn list_project_v2_trash(
    manager: State<'_, Arc<ProjectV2Manager>>,
    workspace_id: String,
) -> Result<TrashState, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.trash_state(&workspace_id))
        .await
        .map_err(|error| format!("Project Trash read worker failed: {error}"))?
}

#[tauri::command]
pub async fn review_project_v2_trash_impact(
    manager: State<'_, Arc<ProjectV2Manager>>,
    workspace_id: String,
    targets: Vec<TrashTarget>,
) -> Result<TrashImpact, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.trash_impact(&workspace_id, &targets))
        .await
        .map_err(|error| format!("Project Trash review worker failed: {error}"))?
}

#[tauri::command]
pub async fn trash_project_v2_records(
    manager: State<'_, Arc<ProjectV2Manager>>,
    workspace_id: String,
    targets: Vec<TrashTarget>,
    retention_days: u64,
) -> Result<TrashMutationResult, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.trash_records(&workspace_id, &targets, retention_days)
    })
    .await
    .map_err(|error| format!("Project Trash transaction worker failed: {error}"))?
}

#[tauri::command]
pub async fn restore_project_v2_trash(
    manager: State<'_, Arc<ProjectV2Manager>>,
    workspace_id: String,
    transaction_id: String,
) -> Result<TrashMutationResult, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.restore_trash(&workspace_id, &transaction_id)
    })
    .await
    .map_err(|error| format!("Project Trash restore worker failed: {error}"))?
}

#[tauri::command]
pub async fn empty_project_v2_trash(
    manager: State<'_, Arc<ProjectV2Manager>>,
    workspace_id: String,
    transaction_ids: Option<Vec<String>>,
    eligible_only: bool,
) -> Result<TrashMutationResult, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.empty_trash(&workspace_id, transaction_ids.as_deref(), eligible_only)
    })
    .await
    .map_err(|error| format!("Project Trash cleanup worker failed: {error}"))?
}

pub fn initialize(app: &tauri::App) -> Result<(), String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve the app data folder: {error}"))?;
    app.state::<Arc<ProjectV2Manager>>().initialize(&root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, time::SystemTime};

    #[test]
    fn editor_open_preserves_valid_v2_workspace_lock_errors() {
        let root = std::env::temp_dir().join(format!(
            "gamebook-editor-open-lock-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let app_data = root.join("app-data");
        let owner = ProjectV2Manager::default();
        owner.initialize(&app_data).unwrap();
        let project = owner.create_unsaved().unwrap();
        let source = owner.current_source_path(&project.workspace_id).unwrap();

        let contender = ProjectV2Manager::default();
        contender.initialize(&app_data).unwrap();
        assert_eq!(
            open_path_for_editor(&contender, &source, "open-locked-project").unwrap_err(),
            "workspace-live-lock"
        );

        owner.close(&project.workspace_id).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
