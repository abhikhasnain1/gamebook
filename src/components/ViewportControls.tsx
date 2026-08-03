import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Maximize2,
  RotateCcw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  MAX_ZOOM_PERCENT,
  MIN_ZOOM_PERCENT,
  type ViewportState,
} from "../lib/viewportController";

interface ViewportControlsProps {
  state: ViewportState;
  onFit: () => void;
  onReset: () => void;
  onZoom: (percent: number) => void;
  onPan: (dx: number, dy: number) => void;
}

export function ViewportControls({
  state,
  onFit,
  onReset,
  onZoom,
  onPan,
}: ViewportControlsProps) {
  const roundedZoom = Math.round(state.zoomPercent);
  return (
    <div className="viewport-controls" aria-label="Page view controls">
      <button type="button" onClick={onFit} aria-pressed={state.mode === "fit"} aria-label="Fit page" data-tooltip="Fit page">
        <Maximize2 />
      </button>
      <button type="button" onClick={onReset} aria-label="Reset view to 100 percent" data-tooltip="Reset view">
        <RotateCcw />
      </button>
      <button
        type="button"
        onClick={() => onZoom(Math.max(MIN_ZOOM_PERCENT, roundedZoom - 25))}
        disabled={roundedZoom <= MIN_ZOOM_PERCENT}
        aria-label="Zoom out"
        data-tooltip="Zoom out"
      >
        <ZoomOut />
      </button>
      <label className="viewport-zoom-input">
        <span className="sr-only">Zoom percentage</span>
        <input
          type="number"
          min={MIN_ZOOM_PERCENT}
          max={MAX_ZOOM_PERCENT}
          step={5}
          value={roundedZoom}
          onChange={(event) => onZoom(Number(event.currentTarget.value))}
        />
        <span aria-hidden="true">%</span>
      </label>
      <button
        type="button"
        onClick={() => onZoom(Math.min(MAX_ZOOM_PERCENT, roundedZoom + 25))}
        disabled={roundedZoom >= MAX_ZOOM_PERCENT}
        aria-label="Zoom in"
        data-tooltip="Zoom in"
      >
        <ZoomIn />
      </button>
      <span className="viewport-pan-controls" aria-label="Pan page view">
        <button type="button" onClick={() => onPan(-1, 0)} aria-label="Pan left" data-tooltip="Pan left"><ArrowLeft /></button>
        <button type="button" onClick={() => onPan(0, -1)} aria-label="Pan up" data-tooltip="Pan up"><ArrowUp /></button>
        <button type="button" onClick={() => onPan(0, 1)} aria-label="Pan down" data-tooltip="Pan down"><ArrowDown /></button>
        <button type="button" onClick={() => onPan(1, 0)} aria-label="Pan right" data-tooltip="Pan right"><ArrowRight /></button>
      </span>
    </div>
  );
}
