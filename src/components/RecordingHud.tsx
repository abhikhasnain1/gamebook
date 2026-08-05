import { Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  onRecordingHudState,
  requestRecordingStop,
  type RecordingHudState,
} from "../lib/native";

interface RecordingHudViewProps {
  state: RecordingHudState;
  onStop: () => void;
}

export function RecordingHudView({ state, onStop }: RecordingHudViewProps) {
  const [announcement, setAnnouncement] = useState("");
  const lastAnnouncement = useRef("");

  useEffect(() => {
    const bucket = Math.floor(state.remainingSeconds / 10);
    const signature = [
      state.state,
      state.videoState,
      state.systemAudioState,
      state.microphoneState,
      bucket,
    ].join(":");
    if (signature === lastAnnouncement.current) return;
    lastAnnouncement.current = signature;
    setAnnouncement(
      `${label(state.state)}. ${formatTime(state.remainingSeconds)} remaining. `
      + `Video ${label(state.videoState)}. System audio ${label(state.systemAudioState)}. `
      + `Microphone ${label(state.microphoneState)}.`,
    );
  }, [state]);

  return (
    <main className="recording-hud" aria-label="Recording status">
      <div className="recording-hud-summary">
        <strong>{label(state.state)}</strong>
        <time
          aria-label={`${formatTime(state.elapsedSeconds)} elapsed; ${formatTime(state.remainingSeconds)} remaining`}
        >
          {formatTime(state.elapsedSeconds)} / {formatTime(state.remainingSeconds)}
        </time>
      </div>
      <dl className="recording-hud-media">
        <div><dt>Video</dt><dd>{label(state.videoState)}</dd></div>
        <div><dt>System audio</dt><dd>{label(state.systemAudioState)}</dd></div>
        <div><dt>Microphone</dt><dd>{label(state.microphoneState)}</dd></div>
      </dl>
      <button type="button" className="recording-hud-stop" onClick={onStop}>
        <Square aria-hidden="true" /> Stop
      </button>
      <output className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </output>
    </main>
  );
}

export function RecordingHud() {
  const [state, setState] = useState<RecordingHudState | null>(null);

  useEffect(() => {
    let disposed = false;
    let unlisten: () => void = () => undefined;
    void onRecordingHudState((next) => {
      if (!disposed) setState(next);
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten();
    };
  }, []);

  if (!state) {
    return <main className="recording-hud recording-hud-waiting" aria-label="Recording status" />;
  }

  return (
    <RecordingHudView
      state={state}
      onStop={() => void requestRecordingStop(state.recordingId)}
    />
  );
}

function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function label(value: string): string {
  const text = value.replaceAll("-", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
