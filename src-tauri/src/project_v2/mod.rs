mod archive;
mod migration;
mod model;
mod workspace;

use std::sync::Arc;

use tauri::{Manager, State, WebviewWindow};

pub use model::{
    CacheEvictionResult, ExternalChangeChoice, MaterializedAssetResult, MigrationProjectResult,
    OpenProjectResult, SaveProjectResult,
};
pub use workspace::ProjectV2Manager;

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

pub fn initialize(app: &tauri::App) -> Result<(), String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve the app data folder: {error}"))?;
    app.state::<Arc<ProjectV2Manager>>().initialize(&root)
}
