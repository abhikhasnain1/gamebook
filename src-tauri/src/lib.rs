use std::{
    fs,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

#[cfg(test)]
use std::io::Read;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chrono::Utc;
#[cfg(test)]
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use image::{codecs::png::PngEncoder, ExtendedColorType, ImageEncoder};
use serde::{Deserialize, Serialize};
use tauri::{
    menu::{MenuBuilder, MenuItem, MenuItemBuilder, PredefinedMenuItem},
    tray::{TrayIcon, TrayIconBuilder},
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::ShortcutState;
use xcap::Monitor;

mod project_v2;
mod recording_ui;
mod settings;

static CAPTURE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

const OVERLAY_WIDTH_RATIO: f64 = 0.89;
const OVERLAY_HEIGHT_RATIO: f64 = 0.88;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CapturePayload {
    capture_id: String,
    captured_at: String,
    monitor_name: String,
    width: u32,
    height: u32,
    monitor_x: i32,
    monitor_y: i32,
}

struct CapturedMonitor {
    png: Vec<u8>,
    captured_at: String,
    monitor_name: String,
    width: u32,
    height: u32,
    monitor_x: i32,
    monitor_y: i32,
}

struct TrayController {
    capture_item: MenuItem<tauri::Wry>,
    recording_item: MenuItem<tauri::Wry>,
    tray_icon: TrayIcon<tauri::Wry>,
    screenshot_shortcut: Mutex<String>,
    recording_active: Mutex<bool>,
}

impl TrayController {
    fn set_screenshot_shortcut(&self, shortcut: &str) {
        if let Ok(mut current) = self.screenshot_shortcut.lock() {
            *current = shortcut.to_string();
        }
        let _ = self
            .capture_item
            .set_text(format!("Capture screenshot  {shortcut}"));
        if !self
            .recording_active
            .lock()
            .map(|active| *active)
            .unwrap_or(false)
        {
            let _ = self
                .tray_icon
                .set_tooltip(Some(format!("Gamebook - {shortcut} to capture")));
        }
    }

    fn set_recording(&self, state: Option<&recording_ui::RecordingHudState>) {
        if let Ok(mut active) = self.recording_active.lock() {
            *active = state.is_some();
        }
        if let Some(state) = state {
            let status = format!(
                "Recording {} elapsed; {} remaining; video {}; system audio {}; microphone {}",
                format_duration(state.elapsed_seconds),
                format_duration(state.remaining_seconds),
                state.video_state.replace('-', " "),
                state.system_audio_state.replace('-', " "),
                state.microphone_state.replace('-', " ")
            );
            let _ = self.recording_item.set_text(&status);
            let _ = self
                .tray_icon
                .set_tooltip(Some(format!("Gamebook - {status}")));
        } else {
            let _ = self.recording_item.set_text("Recording inactive");
            let shortcut = self
                .screenshot_shortcut
                .lock()
                .map(|value| value.clone())
                .unwrap_or_else(|_| "Ctrl+Shift+F12".to_string());
            let _ = self
                .tray_icon
                .set_tooltip(Some(format!("Gamebook - {shortcut} to capture")));
        }
    }
}

fn format_duration(seconds: u64) -> String {
    format!("{:02}:{:02}", seconds / 60, seconds % 60)
}

pub(crate) fn set_recording_tray_status(
    app: &AppHandle,
    state: Option<&recording_ui::RecordingHudState>,
) {
    if let Some(controller) = app.try_state::<TrayController>() {
        controller.set_recording(state);
    }
}

pub(crate) fn set_tray_screenshot_shortcut(app: &AppHandle, shortcut: &str) {
    if let Some(controller) = app.try_state::<TrayController>() {
        controller.set_screenshot_shortcut(shortcut);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarkdownPage {
    title: String,
    text: String,
    image_data_url: String,
}

#[cfg(test)]
fn write_compressed(
    path: &Path,
    content: &serde_json::Value,
    compression: Compression,
) -> Result<(), String> {
    let file = fs::File::create(path)
        .map_err(|error| format!("Could not create {}: {error}", path.display()))?;
    let mut encoder = GzEncoder::new(file, compression);
    serde_json::to_writer(&mut encoder, content)
        .map_err(|error| format!("Could not serialize {}: {error}", path.display()))?;
    encoder
        .finish()
        .map_err(|error| format!("Could not finish {}: {error}", path.display()))?;
    Ok(())
}

#[cfg(test)]
fn read_project(path: &Path) -> Result<String, String> {
    let file = fs::File::open(path)
        .map_err(|error| format!("Could not open {}: {error}", path.display()))?;
    let mut decoder = GzDecoder::new(file);
    let mut content = String::new();
    match decoder.read_to_string(&mut content) {
        Ok(_) => Ok(content),
        Err(_) => fs::read_to_string(path)
            .map_err(|error| format!("Could not read {}: {error}", path.display())),
    }
}

fn capture_monitor(app: &AppHandle) -> Result<CapturedMonitor, String> {
    let monitor = app
        .get_webview_window("main")
        .and_then(|window| window.cursor_position().ok())
        .and_then(|position| Monitor::from_point(position.x as i32, position.y as i32).ok())
        .or_else(|| {
            Monitor::all().ok().and_then(|monitors| {
                monitors
                    .into_iter()
                    .find(|monitor| monitor.is_primary().unwrap_or(false))
            })
        })
        .ok_or_else(|| "No display is available to capture.".to_string())?;

    let monitor_name = monitor
        .friendly_name()
        .or_else(|_| monitor.name())
        .unwrap_or_else(|_| "Display".to_string());
    let capture = monitor
        .capture_image()
        .map_err(|error| format!("Screen capture failed: {error}"))?;
    let width = capture.width();
    let height = capture.height();
    let monitor_x = monitor.x().unwrap_or_default();
    let monitor_y = monitor.y().unwrap_or_default();

    let mut png = Vec::new();
    PngEncoder::new(&mut png)
        .write_image(capture.as_raw(), width, height, ExtendedColorType::Rgba8)
        .map_err(|error| format!("Could not encode the capture: {error}"))?;

    Ok(CapturedMonitor {
        png,
        captured_at: Utc::now().to_rfc3339(),
        monitor_name,
        width,
        height,
        monitor_x,
        monitor_y,
    })
}

fn overlay_bounds(
    monitor_x: i32,
    monitor_y: i32,
    monitor_width: u32,
    monitor_height: u32,
) -> (PhysicalPosition<i32>, PhysicalSize<u32>) {
    let width = (monitor_width as f64 * OVERLAY_WIDTH_RATIO).round() as u32;
    let height = (monitor_height as f64 * OVERLAY_HEIGHT_RATIO).round() as u32;
    let x = monitor_x + (monitor_width.saturating_sub(width) / 2) as i32;
    let y = monitor_y + (monitor_height.saturating_sub(height) / 2) as i32;
    (
        PhysicalPosition::new(x, y),
        PhysicalSize::new(width, height),
    )
}

fn place_editor(
    window: &tauri::WebviewWindow,
    monitor_x: i32,
    monitor_y: i32,
    monitor_width: u32,
    monitor_height: u32,
) {
    let (position, size) = overlay_bounds(monitor_x, monitor_y, monitor_width, monitor_height);
    let _ = window.set_fullscreen(false);
    let _ = window.unmaximize();
    let _ = window.set_size(size);
    let _ = window.set_position(position);
    let _ = window.set_always_on_top(true);
}

fn show_editor(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let monitor = window
            .current_monitor()
            .ok()
            .flatten()
            .or_else(|| window.primary_monitor().ok().flatten());
        if let Some(monitor) = monitor {
            place_editor(
                &window,
                monitor.position().x,
                monitor.position().y,
                monitor.size().width,
                monitor.size().height,
            );
        } else {
            let _ = window.set_fullscreen(false);
            let _ = window.unmaximize();
            let _ = window.set_size(PhysicalSize::new(1280, 760));
            let _ = window.center();
        }
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn show_editor_for_capture(app: &AppHandle, capture: &CapturePayload) {
    if let Some(window) = app.get_webview_window("main") {
        place_editor(
            &window,
            capture.monitor_x,
            capture.monitor_y,
            capture.width,
            capture.height,
        );
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn trigger_capture(app: AppHandle) {
    if CAPTURE_IN_PROGRESS.swap(true, Ordering::SeqCst) {
        return;
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }

    thread::spawn(move || {
        thread::sleep(Duration::from_millis(140));
        match capture_monitor(&app) {
            Ok(capture) => {
                let manager = app.state::<Arc<project_v2::ProjectV2Manager>>();
                match manager.register_pending_capture(capture.png) {
                    Ok(capture_id) => {
                        let payload = CapturePayload {
                            capture_id,
                            captured_at: capture.captured_at,
                            monitor_name: capture.monitor_name,
                            width: capture.width,
                            height: capture.height,
                            monitor_x: capture.monitor_x,
                            monitor_y: capture.monitor_y,
                        };
                        let _ = app.emit_to("main", "capture-created", payload.clone());
                        show_editor_for_capture(&app, &payload);
                    }
                    Err(message) => {
                        show_editor(&app);
                        let _ = app.emit_to("main", "capture-error", message);
                    }
                }
            }
            Err(message) => {
                show_editor(&app);
                let _ = app.emit_to("main", "capture-error", message);
            }
        }
        CAPTURE_IN_PROGRESS.store(false, Ordering::SeqCst);
    });
}

fn build_tray(app: &tauri::App, screenshot_shortcut: &str) -> tauri::Result<TrayController> {
    let capture = MenuItemBuilder::with_id(
        "capture",
        format!("Capture screenshot  {screenshot_shortcut}"),
    )
    .build(app)?;
    let recording = MenuItemBuilder::with_id("recording-status", "Recording inactive")
        .enabled(false)
        .build(app)?;
    let show = MenuItemBuilder::with_id("show", "Open Gamebook").build(app)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&capture, &recording, &show, &separator, &quit])
        .build()?;

    let mut builder = TrayIconBuilder::with_id("gamebook-tray")
        .tooltip(format!("Gamebook - {screenshot_shortcut} to capture"))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "capture" => trigger_capture(app.clone()),
            "show" => {
                show_editor(app);
                let _ = app.emit_to("main", "overlay-opened", ());
            }
            "quit" => app.exit(0),
            _ => {}
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    let tray_icon = builder.build(app)?;
    Ok(TrayController {
        capture_item: capture,
        recording_item: recording,
        tray_icon,
        screenshot_shortcut: Mutex::new(screenshot_shortcut.to_string()),
        recording_active: Mutex::new(false),
    })
}

#[tauri::command]
fn hide_overlay(app: AppHandle) -> Result<(), String> {
    app.get_webview_window("main")
        .ok_or_else(|| "The editor window is unavailable.".to_string())?
        .hide()
        .map_err(|error| format!("Could not hide the editor: {error}"))
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn request_capture(app: AppHandle) {
    trigger_capture(app);
}

fn decode_data_url(value: &str) -> Result<Vec<u8>, String> {
    let encoded = value.split_once(',').map(|(_, data)| data).unwrap_or(value);
    BASE64
        .decode(encoded)
        .map_err(|error| format!("Could not decode export data: {error}"))
}

#[tauri::command]
fn save_binary_export(
    window: WebviewWindow,
    data_base64: String,
    extension: String,
    description: String,
    suggested_name: String,
) -> Result<Option<String>, String> {
    let Some(path) = rfd::FileDialog::new()
        .set_parent(&window)
        .add_filter(&description, &[&extension])
        .set_file_name(format!("{suggested_name}.{extension}"))
        .save_file()
    else {
        return Ok(None);
    };
    fs::write(&path, decode_data_url(&data_base64)?)
        .map_err(|error| format!("Could not write {}: {error}", path.display()))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
fn save_text_export(
    window: WebviewWindow,
    content: String,
    extension: String,
    description: String,
    suggested_name: String,
) -> Result<Option<String>, String> {
    let Some(path) = rfd::FileDialog::new()
        .set_parent(&window)
        .add_filter(&description, &[&extension])
        .set_file_name(format!("{suggested_name}.{extension}"))
        .save_file()
    else {
        return Ok(None);
    };
    fs::write(&path, content)
        .map_err(|error| format!("Could not write {}: {error}", path.display()))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

fn safe_stem(value: &str) -> String {
    let result: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect();
    result.trim_matches('-').to_string()
}

#[tauri::command]
fn save_markdown_export(
    window: WebviewWindow,
    title: String,
    pages: Vec<MarkdownPage>,
    suggested_name: String,
) -> Result<Option<String>, String> {
    let Some(path) = rfd::FileDialog::new()
        .set_parent(&window)
        .add_filter("Markdown document", &["md"])
        .set_file_name(format!("{suggested_name}.md"))
        .save_file()
    else {
        return Ok(None);
    };

    let file_stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .map(safe_stem)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "gamebook".to_string());
    let assets_name = format!("{file_stem}-assets");
    let assets_path = path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(&assets_name);
    fs::create_dir_all(&assets_path)
        .map_err(|error| format!("Could not create {}: {error}", assets_path.display()))?;

    let mut markdown = format!("# {title}\n\n");
    for (index, page) in pages.iter().enumerate() {
        let image_name = format!("page-{:02}.png", index + 1);
        fs::write(
            assets_path.join(&image_name),
            decode_data_url(&page.image_data_url)?,
        )
        .map_err(|error| format!("Could not write {image_name}: {error}"))?;
        markdown.push_str(&format!(
            "## {}\n\n![{}]({}/{})\n\n{}\n\n",
            page.title, page.title, assets_name, image_name, page.text
        ));
    }
    fs::write(&path, markdown)
        .map_err(|error| format!("Could not write {}: {error}", path.display()))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

pub fn run() {
    tauri::Builder::default()
        .manage(Arc::new(project_v2::ProjectV2Manager::default()))
        .manage(settings::SettingsManager::default())
        .manage(recording_ui::ShortcutManager::default())
        .manage(recording_ui::RecordingUiManager::default())
        .register_uri_scheme_protocol("gamebook-media", |window, request| {
            let manager = window
                .app_handle()
                .state::<Arc<project_v2::ProjectV2Manager>>();
            manager.media_response(&request)
        })
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_editor(app);
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    match app
                        .state::<recording_ui::ShortcutManager>()
                        .action_for(shortcut)
                    {
                        Some(recording_ui::ShortcutAction::Screenshot) => {
                            trigger_capture(app.clone());
                        }
                        Some(recording_ui::ShortcutAction::Video) => {
                            let _ = app
                                .state::<recording_ui::RecordingUiManager>()
                                .handle_video_shortcut(app);
                        }
                        None => {}
                    }
                })
                .build(),
        )
        .setup(move |app| {
            project_v2::initialize(app).map_err(std::io::Error::other)?;
            let app_data = app.path().app_data_dir().map_err(std::io::Error::other)?;
            app.state::<settings::SettingsManager>()
                .initialize(&app_data)
                .map_err(std::io::Error::other)?;
            let current_settings = app
                .state::<settings::SettingsManager>()
                .current()
                .map_err(std::io::Error::other)?;
            let screenshot_shortcut = current_settings
                .settings
                .pointer("/shortcuts/screenshot")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("Ctrl+Shift+F12");
            let tray = build_tray(app, screenshot_shortcut)?;
            app.manage(tray);

            let hud_window = WebviewWindowBuilder::new(
                app,
                "recording-hud",
                WebviewUrl::App("index.html?surface=recording-hud".into()),
            )
            .title("Gamebook recording status")
            .inner_size(390.0, 104.0)
            .resizable(false)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .visible(false)
            .shadow(false)
            .build()?;
            app.state::<recording_ui::RecordingUiManager>()
                .initialize(&hud_window)
                .map_err(std::io::Error::other)?;

            let shortcut_notices = app
                .state::<recording_ui::ShortcutManager>()
                .initialize(app.handle(), &current_settings.settings);
            app.state::<settings::SettingsManager>()
                .append_shortcut_notices(shortcut_notices)
                .map_err(std::io::Error::other)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            hide_overlay,
            quit_app,
            request_capture,
            project_v2::create_project_v2,
            project_v2::recover_project_v2_workspace,
            project_v2::open_project_for_editor,
            project_v2::claim_screenshot_capture,
            project_v2::open_project_v2,
            project_v2::migrate_project_v1,
            project_v2::inspect_project_v2_repair,
            project_v2::read_project_v2_record,
            project_v2::stage_project_v2_document,
            project_v2::autosave_project_v2_workspace,
            project_v2::materialize_project_v2_asset,
            project_v2::save_project_v2,
            project_v2::cancel_project_v2_operation,
            project_v2::close_project_v2_workspace,
            project_v2::evict_project_v2_clean_cache,
            project_v2::list_project_v2_recovery,
            project_v2::list_project_v2_trash,
            project_v2::review_project_v2_trash_impact,
            project_v2::trash_project_v2_records,
            project_v2::restore_project_v2_trash,
            project_v2::empty_project_v2_trash,
            settings::load_global_settings,
            settings::update_global_settings,
            settings::reset_global_settings,
            settings::import_global_settings,
            settings::export_global_settings,
            recording_ui::set_global_shortcuts_suspended,
            recording_ui::preview_recording_hud,
            recording_ui::request_recording_stop,
            save_binary_export,
            save_text_export,
            save_markdown_export
        ])
        .run(tauri::generate_context!())
        .expect("error while running Gamebook");
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf, time::SystemTime};

    use flate2::Compression;
    use serde_json::json;

    use super::{
        decode_data_url, overlay_bounds, read_project, safe_stem, write_compressed, CapturePayload,
    };

    #[test]
    fn decodes_plain_and_prefixed_base64() {
        assert_eq!(decode_data_url("SGVsbG8=").unwrap(), b"Hello");
        assert_eq!(
            decode_data_url("data:text/plain;base64,SGVsbG8=").unwrap(),
            b"Hello"
        );
    }

    #[test]
    fn creates_portable_asset_stems() {
        assert_eq!(safe_stem("North Pass: 2 / Notes"), "North-Pass--2---Notes");
        assert_eq!(safe_stem("  "), "");
    }

    #[test]
    fn leaves_context_visible_around_the_overlay() {
        let (position, size) = overlay_bounds(0, 0, 3440, 1440);
        assert_eq!(position, tauri::PhysicalPosition::new(189, 86));
        assert_eq!(size, tauri::PhysicalSize::new(3062, 1267));

        let (position, size) = overlay_bounds(-1920, 0, 1920, 1080);
        assert_eq!(position, tauri::PhysicalPosition::new(-1815, 65));
        assert_eq!(size, tauri::PhysicalSize::new(1709, 950));
    }

    #[test]
    fn capture_events_expose_only_an_opaque_claim_id_and_metadata() {
        let payload = CapturePayload {
            capture_id: "a".repeat(64),
            captured_at: "2026-08-03T00:00:00Z".to_string(),
            monitor_name: "Display 1".to_string(),
            width: 1920,
            height: 1080,
            monitor_x: 0,
            monitor_y: 0,
        };
        let value = serde_json::to_value(payload).unwrap();
        assert_eq!(value["captureId"], "a".repeat(64));
        let serialized = serde_json::to_string(&value).unwrap();
        assert!(!serialized.contains("dataUrl"));
        assert!(!serialized.contains("thumbnail"));
        assert!(!serialized.contains("base64"));
        assert!(!serialized.contains("png"));
    }

    #[test]
    fn reads_compressed_and_plain_version_one_projects() {
        let dir = temp_test_dir("read-project");
        fs::create_dir_all(&dir).unwrap();
        let compressed_path = dir.join("compressed.gamebook");
        let plain_path = dir.join("plain.gamebook");
        let content = json!({
            "formatVersion": 1,
            "id": "fixture-session-v1-basic",
            "pages": []
        });

        write_compressed(&compressed_path, &content, Compression::fast()).unwrap();
        fs::write(
            &plain_path,
            r#"{"formatVersion":1,"id":"plain-version-one","pages":[]}"#,
        )
        .unwrap();

        assert_eq!(
            read_project(&compressed_path).unwrap(),
            r#"{"formatVersion":1,"id":"fixture-session-v1-basic","pages":[]}"#,
        );
        assert_eq!(
            read_project(&plain_path).unwrap(),
            r#"{"formatVersion":1,"id":"plain-version-one","pages":[]}"#,
        );

        fs::remove_dir_all(dir).unwrap();
    }

    fn temp_test_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("gamebook-{name}-{nonce}"))
    }
}
