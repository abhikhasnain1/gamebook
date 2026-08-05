import { useCallback, useEffect, useState } from "react";
import {
  exportGlobalSettings,
  importGlobalSettings,
  loadGlobalSettings,
  resetGlobalSettings,
  updateGlobalSettings,
  type GlobalSettings,
  type SettingsNotice,
} from "../lib/native";

export interface GlobalSettingsState {
  settings: GlobalSettings;
  notices: SettingsNotice[];
  writeProtected: boolean;
  loaded: boolean;
  save: (settings: GlobalSettings) => Promise<void>;
  reset: () => Promise<void>;
  importFile: () => Promise<boolean>;
  exportFile: () => Promise<boolean>;
}

export function useGlobalSettings(onError: (message: string) => void): GlobalSettingsState {
  const [settings, setSettings] = useState<GlobalSettings>(defaultBrowserSettings);
  const [notices, setNotices] = useState<SettingsNotice[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [writeProtected, setWriteProtected] = useState(false);

  const apply = useCallback((next: GlobalSettings, nextNotices: SettingsNotice[], protectedState = false) => {
    setSettings(next);
    setNotices(nextNotices);
    setWriteProtected(protectedState);
    document.documentElement.dataset.reducedMotion = next.accessibility.reducedMotion;
    document.documentElement.dataset.uiScale = String(next.accessibility.uiScalePercent);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadGlobalSettings()
      .then((result) => {
        if (cancelled) return;
        if (result) apply(result.settings, result.notices, result.writeProtected);
        else apply(defaultBrowserSettings(), []);
        setLoaded(true);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoaded(true);
          onError(String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [apply, onError]);

  return {
    settings,
    notices,
    writeProtected,
    loaded,
    save: async (next) => {
      const result = await updateGlobalSettings(next);
      if (result) apply(result.settings, result.notices, result.writeProtected);
    },
    reset: async () => {
      const result = await resetGlobalSettings();
      if (result) apply(result.settings, result.notices, result.writeProtected);
    },
    importFile: async () => {
      const result = await importGlobalSettings();
      if (!result) return false;
      apply(result.settings, result.notices, result.writeProtected);
      return true;
    },
    exportFile: exportGlobalSettings,
  };
}

export function defaultBrowserSettings(): GlobalSettings {
  return {
    settingsVersion: 1,
    capture: {
      target: "monitor-under-pointer",
      durationSeconds: 30,
      frameRateCap: 30,
      includeCursor: true,
      includeSystemAudio: true,
      includeMicrophone: false,
      systemAudioDisclosureVersion: null,
      microphoneConsentVersion: null,
    },
    shortcuts: { screenshot: "Ctrl+Shift+F12", video: "Ctrl+Shift+F11" },
    playback: { autoplay: true, volume: 1 },
    accessibility: { reducedMotion: "system", uiScalePercent: 100 },
    storage: { cacheLimitBytes: 5_368_709_120 },
    trash: { retentionDays: 30 },
    diagnostics: { localLogging: true, exportConsentVersion: null },
  };
}
