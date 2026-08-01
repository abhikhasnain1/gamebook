import { Image, Pause, Play, SkipBack, SkipForward } from "lucide-react";
import type { DecodedFrameRef, PlaybackState } from "./mediaPlayback";

interface PlaybackControlPlacement {
  id: string;
  sourceName: string;
  state: PlaybackState;
}

interface MediaPlaybackControlsProps {
  placements: PlaybackControlPlacement[];
  selectedId: string;
  durationUs: number;
  exactFrames: DecodedFrameRef[];
  status: string;
  onSelect: (id: string) => void;
  onPlay: (id: string) => void;
  onPause: (id: string) => void;
  onSeek: (id: string, timestampUs: number) => void;
  onExactFrame: (id: string, frame: DecodedFrameRef) => void;
  onPoster: (id: string) => void;
}

export function MediaPlaybackControls({
  placements,
  selectedId,
  durationUs,
  exactFrames,
  status,
  onSelect,
  onPlay,
  onPause,
  onSeek,
  onExactFrame,
  onPoster,
}: MediaPlaybackControlsProps) {
  const selected = placements.find((placement) => placement.id === selectedId) ?? placements[0];
  if (!selected) return null;
  const state = selected.state;
  const framePosition = closestFrameIndex(exactFrames, state.sampleIndex);
  const previousFrame = exactFrames[Math.max(0, framePosition - 1)];
  const nextFrame = exactFrames[Math.min(exactFrames.length - 1, framePosition + 1)];

  return (
    <aside className="playback-panel" aria-label="Media playback controls">
      <h2>Playback</h2>
      <div className="playback-placement-tabs" role="group" aria-label="Media placements">
        {placements.map((placement) => (
          <button
            key={placement.id}
            type="button"
            aria-pressed={placement.id === selected.id}
            onClick={() => onSelect(placement.id)}
          >
            <span>{placement.sourceName}</span>
            <small>{modeLabel(placement.state.mode)}</small>
          </button>
        ))}
      </div>

      <section className="playback-current" aria-labelledby="playback-source-heading">
        <h3 id="playback-source-heading">{selected.sourceName}</h3>
        <div className="playback-actions">
          <button
            type="button"
            title={state.mode === "playing" ? "Pause" : "Play"}
            aria-label={`${state.mode === "playing" ? "Pause" : "Play"} ${selected.sourceName}`}
            onClick={() => state.mode === "playing" ? onPause(selected.id) : onPlay(selected.id)}
          >
            {state.mode === "playing" ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
          </button>
          <button
            type="button"
            title="Previous exact frame"
            aria-label={`Previous exact frame for ${selected.sourceName}`}
            onClick={() => previousFrame && onExactFrame(selected.id, previousFrame)}
            disabled={!previousFrame}
          >
            <SkipBack aria-hidden="true" />
          </button>
          <button
            type="button"
            title="Next exact frame"
            aria-label={`Next exact frame for ${selected.sourceName}`}
            onClick={() => nextFrame && onExactFrame(selected.id, nextFrame)}
            disabled={!nextFrame}
          >
            <SkipForward aria-hidden="true" />
          </button>
          <button
            type="button"
            title="Restore poster"
            aria-label={`Restore poster for ${selected.sourceName}`}
            onClick={() => onPoster(selected.id)}
          >
            <Image aria-hidden="true" />
          </button>
        </div>

        <label className="playback-seek">
          <span>Source time</span>
          <input
            type="range"
            min={0}
            max={durationUs}
            step={1_000}
            value={Math.min(durationUs, state.timestampUs)}
            onChange={(event) => onSeek(selected.id, Number(event.currentTarget.value))}
          />
        </label>

        <dl className="playback-state">
          <div>
            <dt>State</dt>
            <dd>{modeLabel(state.mode)}</dd>
          </div>
          <div>
            <dt>Source time</dt>
            <dd>{formatTime(state.timestampUs)}</dd>
          </div>
          <div>
            <dt>Decoded sample</dt>
            <dd>{state.sampleIndex ?? "Poster"}</dd>
          </div>
        </dl>
        {state.error ? <p role="alert">{state.error}</p> : null}
      </section>
      <p className="playback-status" role="status" aria-live="polite">{status}</p>
    </aside>
  );
}

function closestFrameIndex(frames: DecodedFrameRef[], sampleIndex: number | null): number {
  if (!frames.length) return -1;
  if (sampleIndex === null) return 0;
  let closest = 0;
  frames.forEach((frame, index) => {
    if (Math.abs(frame.sampleIndex - sampleIndex) < Math.abs(frames[closest].sampleIndex - sampleIndex)) {
      closest = index;
    }
  });
  return closest;
}

function modeLabel(mode: PlaybackState["mode"]): string {
  if (mode === "playing") return "Playing";
  if (mode === "exact") return "Exact frame";
  if (mode === "error") return "Error";
  return "Poster";
}

function formatTime(timestampUs: number): string {
  const totalMilliseconds = Math.round(timestampUs / 1_000);
  const seconds = Math.floor(totalMilliseconds / 1_000);
  const milliseconds = totalMilliseconds % 1_000;
  return `${seconds}.${String(milliseconds).padStart(3, "0")} s`;
}
