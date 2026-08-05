use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

use chrono::Utc;
use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::{State, WebviewWindow};

const SETTINGS_VERSION: u64 = 1;
const MAX_SETTINGS_BYTES: u64 = 1024 * 1024;

#[derive(Default)]
pub struct SettingsManager {
    inner: Mutex<SettingsState>,
}

#[derive(Default)]
struct SettingsState {
    path: Option<PathBuf>,
    settings: Option<Value>,
    notices: Vec<SettingsNotice>,
    future_settings_bytes: Option<Vec<u8>>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SettingsNotice {
    pub code: String,
    pub field: Option<String>,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSettingsResult {
    pub settings: Value,
    pub notices: Vec<SettingsNotice>,
    pub write_protected: bool,
}

impl SettingsManager {
    pub fn initialize(&self, app_data_dir: &Path) -> Result<(), String> {
        fs::create_dir_all(app_data_dir)
            .map_err(|error| format!("settings-directory-create-failed: {error}"))?;
        let path = app_data_dir.join("settings.json");
        let (settings, notices, should_write, future_settings_bytes) = if path.exists() {
            match read_settings_file(&path).and_then(|value| {
                reject_credentials(&value)?;
                normalize_settings(value, true)
            }) {
                Ok((settings, notices)) => (settings, notices, true, None),
                Err(error) if error == "settings-future-version" => (
                    default_settings(),
                    vec![notice(
                        "settings-future-version",
                        None,
                        "Settings from a newer Gamebook version were preserved. Defaults are active for this session.",
                    )],
                    false,
                    Some(read_settings_bytes(&path)?),
                ),
                Err(_) => {
                    preserve_corrupt_settings(&path)?;
                    (
                        default_settings(),
                        vec![notice(
                            "settings-corrupt-preserved",
                            None,
                            "The unreadable settings file was preserved and defaults were restored.",
                        )],
                        true,
                        None,
                    )
                }
            }
        } else {
            (default_settings(), Vec::new(), true, None)
        };
        if should_write {
            write_settings_atomic(&path, &settings)?;
        }
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "settings-state-poisoned".to_string())?;
        state.path = Some(path);
        state.settings = Some(settings);
        state.notices = notices;
        state.future_settings_bytes = future_settings_bytes;
        Ok(())
    }

    pub fn current(&self) -> Result<GlobalSettingsResult, String> {
        let state = self
            .inner
            .lock()
            .map_err(|_| "settings-state-poisoned".to_string())?;
        Ok(GlobalSettingsResult {
            settings: state
                .settings
                .clone()
                .ok_or_else(|| "settings-manager-not-initialized".to_string())?,
            notices: state.notices.clone(),
            write_protected: state.future_settings_bytes.is_some(),
        })
    }

    pub fn update(&self, value: Value) -> Result<GlobalSettingsResult, String> {
        reject_credentials(&value)?;
        let (settings, notices) = normalize_settings(value, false)?;
        self.replace(settings, notices)
    }

    pub fn reset(&self) -> Result<GlobalSettingsResult, String> {
        self.replace(
            default_settings(),
            vec![notice(
                "settings-reset",
                None,
                "Settings were reset to defaults.",
            )],
        )
    }

    pub fn import_path(&self, path: &Path) -> Result<GlobalSettingsResult, String> {
        self.ensure_writable()?;
        let value = read_settings_file(path)?;
        reject_credentials(&value)?;
        let (settings, mut notices) = normalize_settings(value, true)?;
        notices.push(notice("settings-imported", None, "Settings were imported."));
        self.replace(settings, notices)
    }

    pub fn export_path(&self, path: &Path) -> Result<(), String> {
        let state = self
            .inner
            .lock()
            .map_err(|_| "settings-state-poisoned".to_string())?;
        if let Some(bytes) = &state.future_settings_bytes {
            return write_settings_bytes_atomic(path, bytes);
        }
        let settings = state
            .settings
            .as_ref()
            .ok_or_else(|| "settings-manager-not-initialized".to_string())?;
        write_settings_atomic(path, settings)
    }

    fn replace(
        &self,
        settings: Value,
        notices: Vec<SettingsNotice>,
    ) -> Result<GlobalSettingsResult, String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "settings-state-poisoned".to_string())?;
        if state.future_settings_bytes.is_some() {
            return Err("settings-future-version-preserved".to_string());
        }
        let path = state
            .path
            .clone()
            .ok_or_else(|| "settings-manager-not-initialized".to_string())?;
        write_settings_atomic(&path, &settings)?;
        state.settings = Some(settings.clone());
        state.notices = notices.clone();
        Ok(GlobalSettingsResult {
            settings,
            notices,
            write_protected: false,
        })
    }

    fn ensure_writable(&self) -> Result<(), String> {
        let state = self
            .inner
            .lock()
            .map_err(|_| "settings-state-poisoned".to_string())?;
        if state.future_settings_bytes.is_some() {
            Err("settings-future-version-preserved".to_string())
        } else {
            Ok(())
        }
    }
}

#[tauri::command]
pub fn load_global_settings(
    window: WebviewWindow,
    manager: State<'_, SettingsManager>,
) -> Result<GlobalSettingsResult, String> {
    let result = manager.current()?;
    apply_ui_scale(&window, &result)?;
    Ok(result)
}

#[tauri::command]
pub fn update_global_settings(
    window: WebviewWindow,
    manager: State<'_, SettingsManager>,
    settings: Value,
) -> Result<GlobalSettingsResult, String> {
    let result = manager.update(settings)?;
    apply_ui_scale(&window, &result)?;
    Ok(result)
}

#[tauri::command]
pub fn reset_global_settings(
    window: WebviewWindow,
    manager: State<'_, SettingsManager>,
) -> Result<GlobalSettingsResult, String> {
    let result = manager.reset()?;
    apply_ui_scale(&window, &result)?;
    Ok(result)
}

#[tauri::command]
pub fn import_global_settings(
    window: WebviewWindow,
    manager: State<'_, SettingsManager>,
) -> Result<Option<GlobalSettingsResult>, String> {
    let Some(path) = rfd::FileDialog::new()
        .set_parent(&window)
        .add_filter("Gamebook settings", &["json"])
        .pick_file()
    else {
        return Ok(None);
    };
    let result = manager.import_path(&path)?;
    apply_ui_scale(&window, &result)?;
    Ok(Some(result))
}

#[tauri::command]
pub fn export_global_settings(
    window: WebviewWindow,
    manager: State<'_, SettingsManager>,
) -> Result<bool, String> {
    let Some(path) = rfd::FileDialog::new()
        .set_parent(&window)
        .add_filter("Gamebook settings", &["json"])
        .set_file_name("gamebook-settings.json")
        .save_file()
    else {
        return Ok(false);
    };
    manager.export_path(&path)?;
    Ok(true)
}

fn default_settings() -> Value {
    json!({
        "settingsVersion": SETTINGS_VERSION,
        "capture": {
            "target": "monitor-under-pointer",
            "durationSeconds": 30,
            "frameRateCap": 30,
            "includeCursor": true,
            "includeSystemAudio": true,
            "includeMicrophone": false,
            "systemAudioDisclosureVersion": null,
            "microphoneConsentVersion": null
        },
        "shortcuts": {
            "screenshot": "Ctrl+Shift+F12",
            "video": "Ctrl+Shift+F11"
        },
        "playback": { "autoplay": true, "volume": 1.0 },
        "accessibility": { "reducedMotion": "system", "uiScalePercent": 100 },
        "storage": { "cacheLimitBytes": 5_368_709_120_u64 },
        "trash": { "retentionDays": 30 },
        "diagnostics": { "localLogging": true, "exportConsentVersion": null }
    })
}

fn apply_ui_scale(window: &WebviewWindow, result: &GlobalSettingsResult) -> Result<(), String> {
    let percent = result
        .settings
        .pointer("/accessibility/uiScalePercent")
        .and_then(Value::as_u64)
        .ok_or_else(|| "settings-ui-scale-invalid".to_string())?;
    window
        .set_zoom(percent as f64 / 100.0)
        .map_err(|error| format!("settings-ui-scale-apply-failed: {error}"))
}

fn normalize_settings(
    value: Value,
    allow_migration: bool,
) -> Result<(Value, Vec<SettingsNotice>), String> {
    let source = value
        .as_object()
        .ok_or_else(|| "settings-root-invalid".to_string())?;
    let version = source
        .get("settingsVersion")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if version > SETTINGS_VERSION {
        return Err("settings-future-version".to_string());
    }
    if version < SETTINGS_VERSION && !allow_migration {
        return Err("settings-version-invalid".to_string());
    }

    let mut notices = Vec::new();
    let mut result = source.clone();
    let defaults = default_settings();
    let default_root = defaults.as_object().expect("default settings object");
    result.insert("settingsVersion".to_string(), json!(SETTINGS_VERSION));
    if version < SETTINGS_VERSION {
        notices.push(notice(
            "settings-migrated",
            Some("settingsVersion"),
            "Settings were migrated sequentially to version 1.",
        ));
    }

    normalize_section(
        &mut result,
        source,
        default_root,
        "capture",
        &mut notices,
        |section, defaults, notices| {
            enum_field(
                section,
                defaults,
                "target",
                &[
                    "monitor-under-pointer",
                    "selected-monitor",
                    "selected-window",
                ],
                "capture.target",
                notices,
            );
            integer_field(
                section,
                defaults,
                "durationSeconds",
                5,
                300,
                "capture.durationSeconds",
                notices,
            );
            integer_choices(
                section,
                defaults,
                "frameRateCap",
                &[30, 60],
                "capture.frameRateCap",
                notices,
            );
            boolean_field(
                section,
                defaults,
                "includeCursor",
                "capture.includeCursor",
                notices,
            );
            boolean_field(
                section,
                defaults,
                "includeSystemAudio",
                "capture.includeSystemAudio",
                notices,
            );
            boolean_field(
                section,
                defaults,
                "includeMicrophone",
                "capture.includeMicrophone",
                notices,
            );
            nullable_string_field(
                section,
                defaults,
                "systemAudioDisclosureVersion",
                64,
                "capture.systemAudioDisclosureVersion",
                notices,
            );
            nullable_string_field(
                section,
                defaults,
                "microphoneConsentVersion",
                64,
                "capture.microphoneConsentVersion",
                notices,
            );
            let microphone = section
                .get("includeMicrophone")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let consent = section
                .get("microphoneConsentVersion")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.is_empty());
            if microphone && !consent {
                section.insert("includeMicrophone".to_string(), Value::Bool(false));
                notices.push(notice(
                "microphone-disabled-without-consent",
                Some("capture.includeMicrophone"),
                "Microphone capture remained off because separate versioned consent is missing.",
            ));
            }
        },
    );
    normalize_section(
        &mut result,
        source,
        default_root,
        "shortcuts",
        &mut notices,
        |section, defaults, notices| {
            string_field(
                section,
                defaults,
                "screenshot",
                1,
                128,
                "shortcuts.screenshot",
                notices,
            );
            string_field(
                section,
                defaults,
                "video",
                1,
                128,
                "shortcuts.video",
                notices,
            );
        },
    );
    normalize_section(
        &mut result,
        source,
        default_root,
        "playback",
        &mut notices,
        |section, defaults, notices| {
            boolean_field(section, defaults, "autoplay", "playback.autoplay", notices);
            number_field(
                section,
                defaults,
                "volume",
                0.0,
                1.0,
                "playback.volume",
                notices,
            );
        },
    );
    normalize_section(
        &mut result,
        source,
        default_root,
        "accessibility",
        &mut notices,
        |section, defaults, notices| {
            enum_field(
                section,
                defaults,
                "reducedMotion",
                &["system", "reduce", "allow"],
                "accessibility.reducedMotion",
                notices,
            );
            integer_choices(
                section,
                defaults,
                "uiScalePercent",
                &[100, 150, 200],
                "accessibility.uiScalePercent",
                notices,
            );
        },
    );
    normalize_section(
        &mut result,
        source,
        default_root,
        "storage",
        &mut notices,
        |section, defaults, notices| {
            integer_field(
                section,
                defaults,
                "cacheLimitBytes",
                0,
                i64::MAX as u64,
                "storage.cacheLimitBytes",
                notices,
            );
        },
    );
    normalize_section(
        &mut result,
        source,
        default_root,
        "trash",
        &mut notices,
        |section, defaults, notices| {
            integer_field(
                section,
                defaults,
                "retentionDays",
                1,
                3650,
                "trash.retentionDays",
                notices,
            );
        },
    );
    normalize_section(
        &mut result,
        source,
        default_root,
        "diagnostics",
        &mut notices,
        |section, defaults, notices| {
            boolean_field(
                section,
                defaults,
                "localLogging",
                "diagnostics.localLogging",
                notices,
            );
            nullable_string_field(
                section,
                defaults,
                "exportConsentVersion",
                64,
                "diagnostics.exportConsentVersion",
                notices,
            );
        },
    );
    Ok((Value::Object(result), notices))
}

fn normalize_section<F>(
    result: &mut Map<String, Value>,
    source: &Map<String, Value>,
    defaults: &Map<String, Value>,
    name: &str,
    notices: &mut Vec<SettingsNotice>,
    normalize: F,
) where
    F: FnOnce(&mut Map<String, Value>, &Map<String, Value>, &mut Vec<SettingsNotice>),
{
    let default = defaults[name]
        .as_object()
        .expect("default settings section");
    let mut section = source
        .get(name)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_else(|| {
            notices.push(defaulted(name));
            default.clone()
        });
    normalize(&mut section, default, notices);
    result.insert(name.to_string(), Value::Object(section));
}

fn boolean_field(
    section: &mut Map<String, Value>,
    defaults: &Map<String, Value>,
    key: &str,
    path: &str,
    notices: &mut Vec<SettingsNotice>,
) {
    if section.get(key).and_then(Value::as_bool).is_none() {
        fallback(section, defaults, key, path, notices);
    }
}

fn integer_field(
    section: &mut Map<String, Value>,
    defaults: &Map<String, Value>,
    key: &str,
    min: u64,
    max: u64,
    path: &str,
    notices: &mut Vec<SettingsNotice>,
) {
    if !section
        .get(key)
        .and_then(Value::as_u64)
        .is_some_and(|value| value >= min && value <= max)
    {
        fallback(section, defaults, key, path, notices);
    }
}

fn integer_choices(
    section: &mut Map<String, Value>,
    defaults: &Map<String, Value>,
    key: &str,
    choices: &[u64],
    path: &str,
    notices: &mut Vec<SettingsNotice>,
) {
    if !section
        .get(key)
        .and_then(Value::as_u64)
        .is_some_and(|value| choices.contains(&value))
    {
        fallback(section, defaults, key, path, notices);
    }
}

fn number_field(
    section: &mut Map<String, Value>,
    defaults: &Map<String, Value>,
    key: &str,
    min: f64,
    max: f64,
    path: &str,
    notices: &mut Vec<SettingsNotice>,
) {
    if !section
        .get(key)
        .and_then(Value::as_f64)
        .is_some_and(|value| value.is_finite() && value >= min && value <= max)
    {
        fallback(section, defaults, key, path, notices);
    }
}

fn enum_field(
    section: &mut Map<String, Value>,
    defaults: &Map<String, Value>,
    key: &str,
    choices: &[&str],
    path: &str,
    notices: &mut Vec<SettingsNotice>,
) {
    if !section
        .get(key)
        .and_then(Value::as_str)
        .is_some_and(|value| choices.contains(&value))
    {
        fallback(section, defaults, key, path, notices);
    }
}

fn string_field(
    section: &mut Map<String, Value>,
    defaults: &Map<String, Value>,
    key: &str,
    min: usize,
    max: usize,
    path: &str,
    notices: &mut Vec<SettingsNotice>,
) {
    if !section
        .get(key)
        .and_then(Value::as_str)
        .is_some_and(|value| value.len() >= min && value.len() <= max)
    {
        fallback(section, defaults, key, path, notices);
    }
}

fn nullable_string_field(
    section: &mut Map<String, Value>,
    defaults: &Map<String, Value>,
    key: &str,
    max: usize,
    path: &str,
    notices: &mut Vec<SettingsNotice>,
) {
    let valid = section.get(key).is_some_and(|value| {
        value.is_null() || value.as_str().is_some_and(|text| text.len() <= max)
    });
    if !valid {
        fallback(section, defaults, key, path, notices);
    }
}

fn fallback(
    section: &mut Map<String, Value>,
    defaults: &Map<String, Value>,
    key: &str,
    path: &str,
    notices: &mut Vec<SettingsNotice>,
) {
    section.insert(key.to_string(), defaults[key].clone());
    notices.push(defaulted(path));
}

fn defaulted(path: &str) -> SettingsNotice {
    notice(
        "settings-field-defaulted",
        Some(path),
        &format!("Invalid {path} was replaced with its default."),
    )
}

fn notice(code: &str, field: Option<&str>, message: &str) -> SettingsNotice {
    SettingsNotice {
        code: code.to_string(),
        field: field.map(str::to_string),
        message: message.to_string(),
    }
}

fn reject_credentials(value: &Value) -> Result<(), String> {
    let forbidden: BTreeSet<&str> = [
        "apikey",
        "accesstoken",
        "refreshtoken",
        "password",
        "credential",
        "clientsecret",
        "privatekey",
        "token",
        "authtoken",
        "bearertoken",
        "secret",
        "signingkey",
        "secretkey",
    ]
    .into_iter()
    .collect();
    fn visit(value: &Value, forbidden: &BTreeSet<&str>) -> bool {
        match value {
            Value::Object(map) => map.iter().any(|(key, value)| {
                let normalized: String = key
                    .chars()
                    .filter(|character| character.is_ascii_alphanumeric())
                    .flat_map(char::to_lowercase)
                    .collect();
                forbidden.contains(normalized.as_str()) || visit(value, forbidden)
            }),
            Value::Array(values) => values.iter().any(|value| visit(value, forbidden)),
            _ => false,
        }
    }
    if visit(value, &forbidden) {
        Err("settings-credentials-forbidden".to_string())
    } else {
        Ok(())
    }
}

fn read_settings_file(path: &Path) -> Result<Value, String> {
    let bytes = read_settings_bytes(path)?;
    serde_json::from_slice(&bytes).map_err(|error| format!("settings-json-invalid: {error}"))
}

fn read_settings_bytes(path: &Path) -> Result<Vec<u8>, String> {
    let file = File::open(path).map_err(|error| format!("settings-open-failed: {error}"))?;
    let length = file
        .metadata()
        .map_err(|error| format!("settings-read-failed: {error}"))?
        .len();
    if length > MAX_SETTINGS_BYTES {
        return Err("settings-size-limit".to_string());
    }
    let mut bytes = Vec::with_capacity(length as usize);
    file.take(MAX_SETTINGS_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("settings-read-failed: {error}"))?;
    if bytes.len() as u64 > MAX_SETTINGS_BYTES {
        return Err("settings-size-limit".to_string());
    }
    Ok(bytes)
}

fn preserve_corrupt_settings(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "settings-directory-missing".to_string())?;
    let timestamp = Utc::now().format("%Y%m%dT%H%M%S%.3fZ");
    let mut candidate = parent.join(format!("settings.corrupt.{timestamp}.json"));
    let mut suffix = 1_u32;
    while candidate.exists() {
        candidate = parent.join(format!("settings.corrupt.{timestamp}.{suffix}.json"));
        suffix += 1;
    }
    fs::rename(path, candidate)
        .map_err(|error| format!("settings-corrupt-preserve-failed: {error}"))
}

fn write_settings_atomic(path: &Path, value: &Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("settings-serialize-failed: {error}"))?;
    bytes.push(b'\n');
    write_settings_bytes_atomic(path, &bytes)
}

fn write_settings_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "settings-directory-missing".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("settings-directory-create-failed: {error}"))?;
    if bytes.len() as u64 > MAX_SETTINGS_BYTES {
        return Err("settings-size-limit".to_string());
    }
    let temporary = parent.join(format!(
        ".settings.{}.tmp",
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| format!("settings-temporary-create-failed: {error}"))?;
    let result = (|| {
        file.write_all(bytes)
            .map_err(|error| format!("settings-write-failed: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("settings-flush-failed: {error}"))?;
        drop(file);
        crate::project_v2::replace_file_atomic(&temporary, path)
            .map_err(|error| format!("settings-replace-failed: {error}"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    #[test]
    fn defaults_invalid_fields_individually_and_preserves_unknown_values() {
        let value = json!({
            "settingsVersion": 0,
            "capture": {
                "target": "invalid",
                "durationSeconds": 90,
                "frameRateCap": 120,
                "includeCursor": true,
                "includeSystemAudio": false,
                "includeMicrophone": true,
                "microphoneConsentVersion": null,
                "futureCaptureField": "preserved"
            },
            "shortcuts": { "screenshot": "Ctrl+Shift+F12", "video": "Ctrl+Shift+F11" },
            "playback": { "autoplay": false, "volume": 2 },
            "accessibility": { "reducedMotion": "reduce", "uiScalePercent": 175 },
            "storage": { "cacheLimitBytes": 42 },
            "trash": { "retentionDays": 45 },
            "diagnostics": { "localLogging": false, "exportConsentVersion": null },
            "futureSection": { "kept": true }
        });
        let (settings, notices) = normalize_settings(value, true).unwrap();
        assert_eq!(settings["settingsVersion"], 1);
        assert_eq!(settings["capture"]["durationSeconds"], 90);
        assert_eq!(settings["capture"]["target"], "monitor-under-pointer");
        assert_eq!(settings["capture"]["frameRateCap"], 30);
        assert_eq!(settings["capture"]["includeMicrophone"], false);
        assert_eq!(settings["capture"]["futureCaptureField"], "preserved");
        assert_eq!(settings["playback"]["autoplay"], false);
        assert_eq!(settings["playback"]["volume"], 1.0);
        assert_eq!(settings["futureSection"]["kept"], true);
        assert!(notices
            .iter()
            .any(|notice| notice.code == "settings-migrated"));
        assert!(notices
            .iter()
            .any(|notice| notice.code == "microphone-disabled-without-consent"));
    }

    #[test]
    fn rejects_credentials_before_writing_settings() {
        let mut value = default_settings();
        value["processor"] = json!({ "apiKey": "must-not-be-written" });
        assert_eq!(
            reject_credentials(&value).unwrap_err(),
            "settings-credentials-forbidden"
        );
        for key in [
            "token",
            "authToken",
            "bearer_token",
            "secret",
            "signing-key",
        ] {
            let mut value = default_settings();
            value["processor"] = json!({ (key): "must-not-be-written" });
            assert_eq!(
                reject_credentials(&value).unwrap_err(),
                "settings-credentials-forbidden"
            );
        }
    }

    #[test]
    fn preserves_corruption_before_restoring_defaults() {
        let root = temp_test_dir("settings-corruption");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("settings.json"), b"{not-json").unwrap();
        let manager = SettingsManager::default();
        manager.initialize(&root).unwrap();
        let result = manager.current().unwrap();
        assert_eq!(result.settings["settingsVersion"], 1);
        assert_eq!(result.notices[0].code, "settings-corrupt-preserved");
        let preserved = fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("settings.corrupt.")
            })
            .count();
        assert_eq!(preserved, 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preserves_future_settings_without_overwriting_them() {
        let root = temp_test_dir("settings-future-version");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("settings.json");
        let future = br#"{"settingsVersion":2,"futurePreference":"untouched"}"#;
        fs::write(&path, future).unwrap();

        let manager = SettingsManager::default();
        manager.initialize(&root).unwrap();
        let result = manager.current().unwrap();

        assert_eq!(result.settings, default_settings());
        assert_eq!(result.notices[0].code, "settings-future-version");
        assert!(result.write_protected);
        assert_eq!(fs::read(&path).unwrap(), future);
        assert_eq!(
            manager.update(default_settings()).unwrap_err(),
            "settings-future-version-preserved"
        );
        assert_eq!(
            manager.reset().unwrap_err(),
            "settings-future-version-preserved"
        );
        let import = root.join("import.json");
        fs::write(&import, serde_json::to_vec(&default_settings()).unwrap()).unwrap();
        assert_eq!(
            manager.import_path(&import).unwrap_err(),
            "settings-future-version-preserved"
        );
        let export = root.join("export.json");
        manager.export_path(&export).unwrap();
        assert_eq!(fs::read(export).unwrap(), future);
        assert_eq!(fs::read(&path).unwrap(), future);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_import_does_not_replace_current_settings() {
        let root = temp_test_dir("settings-import");
        fs::create_dir_all(&root).unwrap();
        let manager = SettingsManager::default();
        manager.initialize(&root).unwrap();
        let before = manager.current().unwrap().settings;
        let import = root.join("bad.json");
        fs::write(&import, br#"{"settingsVersion":2}"#).unwrap();
        assert_eq!(
            manager.import_path(&import).unwrap_err(),
            "settings-future-version"
        );
        assert_eq!(manager.current().unwrap().settings, before);
        fs::remove_dir_all(root).unwrap();
    }

    fn temp_test_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("gamebook-{name}-{nonce}"))
    }
}
