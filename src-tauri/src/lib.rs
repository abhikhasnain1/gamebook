use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chrono::Utc;
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use image::{
    codecs::{jpeg::JpegEncoder, png::PngEncoder},
    ExtendedColorType, ImageEncoder,
};
use serde::{Deserialize, Serialize};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use xcap::Monitor;

static CAPTURE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

const OVERLAY_WIDTH_RATIO: f64 = 0.89;
const OVERLAY_HEIGHT_RATIO: f64 = 0.88;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CapturePayload {
    data_url: String,
    thumbnail_data_url: String,
    captured_at: String,
    monitor_name: String,
    width: u32,
    height: u32,
    monitor_x: i32,
    monitor_y: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarkdownPage {
    title: String,
    text: String,
    image_data_url: String,
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve the app data folder: {error}"))?;
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Could not create the app data folder: {error}"))?;
    Ok(dir)
}

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

fn capture_monitor(app: &AppHandle) -> Result<CapturePayload, String> {
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

    let thumbnail = image::imageops::thumbnail(&capture, 224, 126);
    let thumbnail_rgb = image::DynamicImage::ImageRgba8(thumbnail).to_rgb8();
    let mut thumbnail_jpeg = Vec::new();
    JpegEncoder::new_with_quality(&mut thumbnail_jpeg, 68)
        .encode(
            thumbnail_rgb.as_raw(),
            thumbnail_rgb.width(),
            thumbnail_rgb.height(),
            ExtendedColorType::Rgb8,
        )
        .map_err(|error| format!("Could not encode the capture thumbnail: {error}"))?;

    Ok(CapturePayload {
        data_url: format!("data:image/png;base64,{}", BASE64.encode(png)),
        thumbnail_data_url: format!(
            "data:image/jpeg;base64,{}",
            BASE64.encode(thumbnail_jpeg)
        ),
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
            Ok(payload) => {
                let _ = app.emit_to("main", "capture-created", payload.clone());
                show_editor_for_capture(&app, &payload);
            }
            Err(message) => {
                show_editor(&app);
                let _ = app.emit_to("main", "capture-error", message);
            }
        }
        CAPTURE_IN_PROGRESS.store(false, Ordering::SeqCst);
    });
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let capture = MenuItemBuilder::with_id("capture", "Capture  Ctrl+Shift+F12").build(app)?;
    let show = MenuItemBuilder::with_id("show", "Open Gamebook").build(app)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&capture, &show, &separator, &quit])
        .build()?;

    let mut builder = TrayIconBuilder::new()
        .tooltip("Gamebook - Ctrl+Shift+F12 to capture")
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
    builder.build(app)?;
    Ok(())
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

#[tauri::command]
async fn autosave_project(app: AppHandle, content: serde_json::Value) -> Result<(), String> {
    let path = data_dir(&app)?.join("autosave.gamebook");
    tauri::async_runtime::spawn_blocking(move || {
        write_compressed(&path, &content, Compression::fast())
    })
    .await
    .map_err(|error| format!("Autosave worker failed: {error}"))?
}

#[tauri::command]
fn load_autosave(app: AppHandle) -> Result<Option<String>, String> {
    let path = data_dir(&app)?.join("autosave.gamebook");
    if !path.exists() {
        return Ok(None);
    }
    read_project(&path).map(Some)
}

#[tauri::command]
fn save_project(
    window: WebviewWindow,
    content: serde_json::Value,
    current_path: Option<String>,
    suggested_name: String,
) -> Result<Option<String>, String> {
    let path = match current_path {
        Some(path) => PathBuf::from(path),
        None => match rfd::FileDialog::new()
            .set_parent(&window)
            .add_filter("Gamebook project", &["gamebook"])
            .set_file_name(format!("{suggested_name}.gamebook"))
            .save_file()
        {
            Some(path) => path,
            None => return Ok(None),
        },
    };
    write_compressed(&path, &content, Compression::default())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
fn open_project(window: WebviewWindow) -> Result<Option<(String, String)>, String> {
    let Some(path) = rfd::FileDialog::new()
        .set_parent(&window)
        .add_filter("Gamebook project", &["gamebook"])
        .pick_file()
    else {
        return Ok(None);
    };
    let content = read_project(&path)?;
    Ok(Some((path.to_string_lossy().into_owned(), content)))
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
    let capture_shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::F12);
    let handler_shortcut = capture_shortcut;

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_editor(app);
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if shortcut == &handler_shortcut && event.state() == ShortcutState::Pressed {
                        trigger_capture(app.clone());
                    }
                })
                .build(),
        )
        .setup(move |app| {
            app.global_shortcut().register(capture_shortcut)?;
            build_tray(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            hide_overlay,
            quit_app,
            request_capture,
            autosave_project,
            load_autosave,
            save_project,
            open_project,
            save_binary_export,
            save_text_export,
            save_markdown_export
        ])
        .run(tauri::generate_context!())
        .expect("error while running Gamebook");
}

#[cfg(test)]
mod tests {
    use super::{decode_data_url, overlay_bounds, safe_stem};

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
}
