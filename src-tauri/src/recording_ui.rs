use std::{str::FromStr, sync::Mutex, thread, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Modifiers, Shortcut};

const HUD_PREVIEW_ID: &str = "recording-hud-preview";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShortcutAction {
    Screenshot,
    Video,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct ActiveShortcuts {
    screenshot: Option<Shortcut>,
    video: Option<Shortcut>,
}

impl ActiveShortcuts {
    fn values(self) -> Vec<Shortcut> {
        [self.screenshot, self.video]
            .into_iter()
            .flatten()
            .collect()
    }

    fn contains(self, shortcut: Shortcut) -> bool {
        self.screenshot == Some(shortcut) || self.video == Some(shortcut)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ShortcutPair {
    screenshot: Shortcut,
    video: Shortcut,
}

impl ShortcutPair {
    fn values(self) -> [Shortcut; 2] {
        [self.screenshot, self.video]
    }

    fn contains(self, shortcut: Shortcut) -> bool {
        self.screenshot == shortcut || self.video == shortcut
    }
}

#[derive(Default)]
struct ShortcutRuntimeState {
    active: ActiveShortcuts,
    suspended: bool,
}

#[derive(Default)]
pub struct ShortcutManager {
    inner: Mutex<ShortcutRuntimeState>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShortcutStartupNotice {
    pub field: &'static str,
    pub message: String,
}

impl ShortcutManager {
    pub fn initialize(&self, app: &AppHandle, settings: &Value) -> Vec<ShortcutStartupNotice> {
        let Ok(pair) = shortcut_pair(settings) else {
            return vec![ShortcutStartupNotice {
                field: "shortcuts",
                message: "The saved shortcuts are invalid. Use Settings to choose new shortcuts."
                    .to_string(),
            }];
        };

        let registrar = TauriShortcutRegistrar { app };
        let mut active = ActiveShortcuts::default();
        let mut notices = Vec::new();
        for (field, shortcut) in [
            ("shortcuts.screenshot", pair.screenshot),
            ("shortcuts.video", pair.video),
        ] {
            match registrar.register(shortcut) {
                Ok(()) => {
                    if field == "shortcuts.screenshot" {
                        active.screenshot = Some(shortcut);
                    } else {
                        active.video = Some(shortcut);
                    }
                }
                Err(_) => notices.push(ShortcutStartupNotice {
                    field,
                    message: format!(
                        "{} is unavailable. Choose another shortcut in Settings.",
                        display_shortcut(shortcut)
                    ),
                }),
            }
        }
        if let Ok(mut state) = self.inner.lock() {
            state.active = active;
        }
        notices
    }

    pub fn apply(&self, app: &AppHandle, settings: &Value) -> Result<(), String> {
        let desired = shortcut_pair(settings)?;
        let registrar = TauriShortcutRegistrar { app };
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "shortcut-state-poisoned".to_string())?;
        transition_shortcuts(&registrar, state.active, desired)?;
        state.active = ActiveShortcuts {
            screenshot: Some(desired.screenshot),
            video: Some(desired.video),
        };
        Ok(())
    }

    pub fn action_for(&self, shortcut: &Shortcut) -> Option<ShortcutAction> {
        let state = self.inner.lock().ok()?;
        if state.suspended {
            return None;
        }
        if state.active.screenshot.as_ref() == Some(shortcut) {
            Some(ShortcutAction::Screenshot)
        } else if state.active.video.as_ref() == Some(shortcut) {
            Some(ShortcutAction::Video)
        } else {
            None
        }
    }

    fn set_suspended(&self, suspended: bool) -> Result<(), String> {
        self.inner
            .lock()
            .map_err(|_| "shortcut-state-poisoned".to_string())?
            .suspended = suspended;
        Ok(())
    }
}

pub fn normalize_shortcut(value: &str) -> Result<Shortcut, String> {
    let portable = value
        .split('+')
        .map(|part| match part.trim().to_ascii_lowercase().as_str() {
            "windows" | "win" => "Super".to_string(),
            _ => part.trim().to_string(),
        })
        .collect::<Vec<_>>()
        .join("+");
    let shortcut =
        Shortcut::from_str(&portable).map_err(|_| "shortcut-format-invalid".to_string())?;
    if shortcut.mods.is_empty() {
        return Err("shortcut-modifier-required".to_string());
    }
    Ok(shortcut)
}

fn shortcut_pair(settings: &Value) -> Result<ShortcutPair, String> {
    let screenshot_text = settings
        .pointer("/shortcuts/screenshot")
        .and_then(Value::as_str)
        .ok_or_else(|| "screenshot-shortcut-missing".to_string())?;
    let video_text = settings
        .pointer("/shortcuts/video")
        .and_then(Value::as_str)
        .ok_or_else(|| "video-shortcut-missing".to_string())?;
    let screenshot = normalize_shortcut(screenshot_text)?;
    let video = normalize_shortcut(video_text)?;
    if screenshot == video {
        return Err("shortcut-conflict-between-actions".to_string());
    }
    Ok(ShortcutPair { screenshot, video })
}

trait ShortcutRegistrar {
    fn register(&self, shortcut: Shortcut) -> Result<(), String>;
    fn unregister(&self, shortcut: Shortcut) -> Result<(), String>;
}

struct TauriShortcutRegistrar<'a> {
    app: &'a AppHandle,
}

impl ShortcutRegistrar for TauriShortcutRegistrar<'_> {
    fn register(&self, shortcut: Shortcut) -> Result<(), String> {
        self.app
            .global_shortcut()
            .register(shortcut)
            .map_err(|error| error.to_string())
    }

    fn unregister(&self, shortcut: Shortcut) -> Result<(), String> {
        self.app
            .global_shortcut()
            .unregister(shortcut)
            .map_err(|error| error.to_string())
    }
}

fn transition_shortcuts<R: ShortcutRegistrar>(
    registrar: &R,
    current: ActiveShortcuts,
    desired: ShortcutPair,
) -> Result<(), String> {
    let additions: Vec<_> = desired
        .values()
        .into_iter()
        .filter(|shortcut| !current.contains(*shortcut))
        .collect();
    let removals: Vec<_> = current
        .values()
        .into_iter()
        .filter(|shortcut| !desired.contains(*shortcut))
        .collect();

    let mut registered = Vec::new();
    for shortcut in additions {
        if registrar.register(shortcut).is_err() {
            for staged in registered.into_iter().rev() {
                let _ = registrar.unregister(staged);
            }
            return Err(format!(
                "Shortcut {} is unavailable. The previous working shortcuts remain active.",
                display_shortcut(shortcut)
            ));
        }
        registered.push(shortcut);
    }

    let mut removed = Vec::new();
    for shortcut in removals {
        if registrar.unregister(shortcut).is_err() {
            for previous in removed.into_iter().rev() {
                let _ = registrar.register(previous);
            }
            for staged in registered.into_iter().rev() {
                let _ = registrar.unregister(staged);
            }
            return Err(
                "The shortcut change could not be completed. The previous working shortcuts were restored."
                    .to_string(),
            );
        }
        removed.push(shortcut);
    }
    Ok(())
}

fn display_shortcut(shortcut: Shortcut) -> String {
    let mut parts = Vec::new();
    if shortcut.mods.contains(Modifiers::CONTROL) {
        parts.push("Ctrl".to_string());
    }
    if shortcut.mods.contains(Modifiers::SHIFT) {
        parts.push("Shift".to_string());
    }
    if shortcut.mods.contains(Modifiers::ALT) {
        parts.push("Alt".to_string());
    }
    if shortcut.mods.contains(Modifiers::SUPER) {
        parts.push("Windows".to_string());
    }
    parts.push(shortcut.key.to_string());
    parts.join("+")
}

#[tauri::command]
pub fn set_global_shortcuts_suspended(
    manager: State<'_, ShortcutManager>,
    suspended: bool,
) -> Result<(), String> {
    manager.set_suspended(suspended)
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RecordingTargetKind {
    MonitorUnderPointer,
    SelectedMonitor,
    SelectedWindow,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingHudState {
    pub recording_id: String,
    pub state: String,
    pub elapsed_seconds: u64,
    pub remaining_seconds: u64,
    pub video_state: String,
    pub system_audio_state: String,
    pub microphone_state: String,
    pub target_kind: RecordingTargetKind,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RecordingHudPresentation {
    Visual,
    NonvisualFallback,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingHudResult {
    pub presentation: RecordingHudPresentation,
    pub reason: Option<String>,
    pub message: String,
}

#[derive(Default)]
struct RecordingUiState {
    content_protection_available: bool,
    active_recording_id: Option<String>,
    generation: u64,
}

#[derive(Default)]
pub struct RecordingUiManager {
    inner: Mutex<RecordingUiState>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum VideoShortcutIntent {
    Start,
    Stop(String),
}

impl RecordingUiManager {
    pub fn initialize(&self, window: &WebviewWindow) -> Result<(), String> {
        let available = window.set_content_protected(true).is_ok();
        self.inner
            .lock()
            .map_err(|_| "recording-ui-state-poisoned".to_string())?
            .content_protection_available = available;
        Ok(())
    }

    pub fn present(
        &self,
        app: &AppHandle,
        state: RecordingHudState,
    ) -> Result<(RecordingHudResult, u64), String> {
        validate_hud_state(&state)?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "recording-ui-state-poisoned".to_string())?;
        inner.generation = inner.generation.saturating_add(1);
        inner.active_recording_id = Some(state.recording_id.clone());
        let generation = inner.generation;
        let result = hud_presentation(state.target_kind, inner.content_protection_available);
        drop(inner);

        crate::set_recording_tray_status(app, Some(&state));
        let window = app
            .get_webview_window("recording-hud")
            .ok_or_else(|| "recording-hud-window-unavailable".to_string())?;
        match result.presentation {
            RecordingHudPresentation::Visual => {
                place_hud(app, &window)?;
                app.emit_to("recording-hud", "recording-hud-state", &state)
                    .map_err(|error| format!("recording-hud-event-failed: {error}"))?;
                window
                    .show()
                    .map_err(|error| format!("recording-hud-show-failed: {error}"))?;
            }
            RecordingHudPresentation::NonvisualFallback => {
                let _ = window.hide();
                app.emit_to("main", "recording-hud-fallback", &result)
                    .map_err(|error| format!("recording-hud-fallback-event-failed: {error}"))?;
            }
        }
        Ok((result, generation))
    }

    pub fn hide(&self, app: &AppHandle, expected_generation: Option<u64>) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "recording-ui-state-poisoned".to_string())?;
        if expected_generation.is_some_and(|value| value != inner.generation) {
            return Ok(());
        }
        inner.generation = inner.generation.saturating_add(1);
        inner.active_recording_id = None;
        drop(inner);
        crate::set_recording_tray_status(app, None);
        if let Some(window) = app.get_webview_window("recording-hud") {
            window
                .hide()
                .map_err(|error| format!("recording-hud-hide-failed: {error}"))?;
        }
        Ok(())
    }

    fn active_recording_id(&self) -> Result<Option<String>, String> {
        Ok(self
            .inner
            .lock()
            .map_err(|_| "recording-ui-state-poisoned".to_string())?
            .active_recording_id
            .clone())
    }

    pub fn handle_video_shortcut(&self, app: &AppHandle) -> Result<(), String> {
        match video_shortcut_intent(self.active_recording_id()?) {
            VideoShortcutIntent::Start => app
                .emit_to("main", "video-shortcut-pressed", ())
                .map_err(|error| format!("video-shortcut-event-failed: {error}")),
            VideoShortcutIntent::Stop(recording_id) => {
                emit_recording_stop(app, &recording_id)?;
                if recording_id == HUD_PREVIEW_ID {
                    self.hide(app, None)?;
                }
                Ok(())
            }
        }
    }
}

fn video_shortcut_intent(active_recording_id: Option<String>) -> VideoShortcutIntent {
    match active_recording_id {
        Some(recording_id) => VideoShortcutIntent::Stop(recording_id),
        None => VideoShortcutIntent::Start,
    }
}

fn emit_recording_stop(app: &AppHandle, recording_id: &str) -> Result<(), String> {
    app.emit_to("main", "video-recording-stop-requested", recording_id)
        .map_err(|error| format!("recording-stop-event-failed: {error}"))
}

fn validate_hud_state(state: &RecordingHudState) -> Result<(), String> {
    if state.recording_id.is_empty() || state.recording_id.len() > 128 {
        return Err("recording-hud-id-invalid".to_string());
    }
    for value in [
        &state.state,
        &state.video_state,
        &state.system_audio_state,
        &state.microphone_state,
    ] {
        if value.is_empty() || value.len() > 64 {
            return Err("recording-hud-state-invalid".to_string());
        }
    }
    Ok(())
}

fn hud_presentation(
    target: RecordingTargetKind,
    content_protection_available: bool,
) -> RecordingHudResult {
    if target == RecordingTargetKind::SelectedWindow {
        return RecordingHudResult {
            presentation: RecordingHudPresentation::NonvisualFallback,
            reason: Some("selected-window-exclusion-unavailable".to_string()),
            message: "Recording status moved to the Gamebook tray because visual HUD exclusion is not guaranteed for selected-window capture.".to_string(),
        };
    }
    if !content_protection_available {
        return RecordingHudResult {
            presentation: RecordingHudPresentation::NonvisualFallback,
            reason: Some("content-protection-unavailable".to_string()),
            message: "Recording status moved to the Gamebook tray because Windows capture exclusion is unavailable.".to_string(),
        };
    }
    RecordingHudResult {
        presentation: RecordingHudPresentation::Visual,
        reason: None,
        message: "The protected recording HUD is active.".to_string(),
    }
}

fn place_hud(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    let monitor = app
        .get_webview_window("main")
        .and_then(|main| main.current_monitor().ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten())
        .ok_or_else(|| "recording-hud-monitor-unavailable".to_string())?;
    let size = window
        .outer_size()
        .map_err(|error| format!("recording-hud-size-failed: {error}"))?;
    let x = monitor.position().x
        + monitor
            .size()
            .width
            .saturating_sub(size.width)
            .saturating_sub(24) as i32;
    let y = monitor.position().y + 24;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| format!("recording-hud-position-failed: {error}"))
}

#[tauri::command]
pub fn preview_recording_hud(
    app: AppHandle,
    manager: State<'_, RecordingUiManager>,
    target_kind: RecordingTargetKind,
    duration_seconds: u64,
    include_system_audio: bool,
    include_microphone: bool,
) -> Result<RecordingHudResult, String> {
    let elapsed_seconds = duration_seconds.min(3);
    let (result, generation) = manager.present(
        &app,
        RecordingHudState {
            recording_id: HUD_PREVIEW_ID.to_string(),
            state: "recording".to_string(),
            elapsed_seconds,
            remaining_seconds: duration_seconds.saturating_sub(elapsed_seconds),
            video_state: "recording".to_string(),
            system_audio_state: if include_system_audio {
                "recording"
            } else {
                "off"
            }
            .to_string(),
            microphone_state: if include_microphone {
                "recording"
            } else {
                "off"
            }
            .to_string(),
            target_kind,
        },
    )?;
    let app_for_hide = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(5));
        let manager = app_for_hide.state::<RecordingUiManager>();
        let _ = manager.hide(&app_for_hide, Some(generation));
    });
    Ok(result)
}

#[tauri::command]
pub fn request_recording_stop(
    app: AppHandle,
    manager: State<'_, RecordingUiManager>,
    recording_id: String,
) -> Result<(), String> {
    if manager.active_recording_id()?.as_deref() != Some(recording_id.as_str()) {
        return Err("recording-hud-target-stale".to_string());
    }
    emit_recording_stop(&app, &recording_id)?;
    if recording_id == HUD_PREVIEW_ID {
        manager.hide(&app, None)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{collections::HashSet, sync::Mutex};

    use super::*;

    #[derive(Default)]
    struct FakeRegistrar {
        registered: Mutex<HashSet<Shortcut>>,
        unavailable: Mutex<HashSet<Shortcut>>,
    }

    impl ShortcutRegistrar for FakeRegistrar {
        fn register(&self, shortcut: Shortcut) -> Result<(), String> {
            if self.unavailable.lock().unwrap().contains(&shortcut) {
                return Err("conflict".to_string());
            }
            self.registered.lock().unwrap().insert(shortcut);
            Ok(())
        }

        fn unregister(&self, shortcut: Shortcut) -> Result<(), String> {
            self.registered.lock().unwrap().remove(&shortcut);
            Ok(())
        }
    }

    fn shortcut(value: &str) -> Shortcut {
        normalize_shortcut(value).unwrap()
    }

    #[test]
    fn requires_a_modifier_and_distinct_valid_shortcuts() {
        assert_eq!(
            normalize_shortcut("F11").unwrap_err(),
            "shortcut-modifier-required"
        );
        assert!(normalize_shortcut("Ctrl+Shift+F11").is_ok());
        assert!(normalize_shortcut("Windows+Shift+F11").is_ok());
        let settings = serde_json::json!({
            "shortcuts": { "screenshot": "Ctrl+Shift+F11", "video": "Ctrl+Shift+F11" }
        });
        assert_eq!(
            shortcut_pair(&settings).unwrap_err(),
            "shortcut-conflict-between-actions"
        );
    }

    #[test]
    fn suspended_shortcuts_do_not_dispatch_while_typing() {
        let manager = ShortcutManager::default();
        let screenshot = shortcut("Ctrl+Shift+F12");
        manager.inner.lock().unwrap().active.screenshot = Some(screenshot);
        assert_eq!(
            manager.action_for(&screenshot),
            Some(ShortcutAction::Screenshot)
        );
        manager.set_suspended(true).unwrap();
        assert_eq!(manager.action_for(&screenshot), None);
        manager.set_suspended(false).unwrap();
        assert_eq!(
            manager.action_for(&screenshot),
            Some(ShortcutAction::Screenshot)
        );
    }

    #[test]
    fn registration_conflict_keeps_the_previous_pair_active() {
        let registrar = FakeRegistrar::default();
        let current = ActiveShortcuts {
            screenshot: Some(shortcut("Ctrl+Shift+F12")),
            video: Some(shortcut("Ctrl+Shift+F11")),
        };
        for value in current.values() {
            registrar.register(value).unwrap();
        }
        let unavailable = shortcut("Ctrl+Alt+F10");
        registrar.unavailable.lock().unwrap().insert(unavailable);
        let result = transition_shortcuts(
            &registrar,
            current,
            ShortcutPair {
                screenshot: shortcut("Ctrl+Alt+F9"),
                video: unavailable,
            },
        );
        assert!(result.unwrap_err().contains("previous working shortcuts"));
        let registered = registrar.registered.lock().unwrap();
        assert_eq!(registered.len(), 2);
        assert!(current
            .values()
            .iter()
            .all(|value| registered.contains(value)));
    }

    #[test]
    fn swapping_actions_reuses_the_registered_pair_without_a_gap() {
        let registrar = FakeRegistrar::default();
        let screenshot = shortcut("Ctrl+Shift+F12");
        let video = shortcut("Ctrl+Shift+F11");
        registrar.register(screenshot).unwrap();
        registrar.register(video).unwrap();
        transition_shortcuts(
            &registrar,
            ActiveShortcuts {
                screenshot: Some(screenshot),
                video: Some(video),
            },
            ShortcutPair {
                screenshot: video,
                video: screenshot,
            },
        )
        .unwrap();
        let registered = registrar.registered.lock().unwrap();
        assert_eq!(registered.len(), 2);
        assert!(registered.contains(&screenshot));
        assert!(registered.contains(&video));
    }

    #[test]
    fn selected_window_and_unavailable_protection_use_truthful_fallbacks() {
        let selected_window = hud_presentation(RecordingTargetKind::SelectedWindow, true);
        assert_eq!(
            selected_window.presentation,
            RecordingHudPresentation::NonvisualFallback
        );
        assert_eq!(
            selected_window.reason.as_deref(),
            Some("selected-window-exclusion-unavailable")
        );

        let unavailable = hud_presentation(RecordingTargetKind::MonitorUnderPointer, false);
        assert_eq!(
            unavailable.presentation,
            RecordingHudPresentation::NonvisualFallback
        );
        assert_eq!(
            unavailable.reason.as_deref(),
            Some("content-protection-unavailable")
        );

        let visual = hud_presentation(RecordingTargetKind::SelectedMonitor, true);
        assert_eq!(visual.presentation, RecordingHudPresentation::Visual);
        assert!(visual.reason.is_none());
    }

    #[test]
    fn video_shortcut_starts_when_idle_and_stops_the_active_recording() {
        assert_eq!(video_shortcut_intent(None), VideoShortcutIntent::Start);
        assert_eq!(
            video_shortcut_intent(Some(HUD_PREVIEW_ID.to_string())),
            VideoShortcutIntent::Stop(HUD_PREVIEW_ID.to_string())
        );
    }
}
