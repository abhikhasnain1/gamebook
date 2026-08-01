import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  RotateCcw,
  Scan,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  MAX_ZOOM_PERCENT,
  MIN_ZOOM_PERCENT,
  type ViewportState,
  viewportStateLabel,
} from "./viewportController";

interface ViewportControlsProps {
  state: ViewportState;
  onFit: () => void;
  onReset: () => void;
  onZoom: (percent: number) => void;
  onPan: (dx: number, dy: number) => void;
}

export function ViewportControls({ state, onFit, onReset, onZoom, onPan }: ViewportControlsProps) {
  const roundedZoom = Math.round(state.zoomPercent);

  return (
    <section className="viewport-controls" aria-label="Viewport controls">
      <div className="viewport-zoom-controls">
        <IconButton label="Fit page" title="Fit page" onClick={onFit}>
          <Scan aria-hidden="true" />
        </IconButton>
        <IconButton label="Reset zoom to 100 percent" title="Reset zoom" onClick={onReset}>
          <RotateCcw aria-hidden="true" />
        </IconButton>
        <IconButton
          label="Zoom out"
          title="Zoom out"
          disabled={roundedZoom <= MIN_ZOOM_PERCENT}
          onClick={() => onZoom(Math.max(MIN_ZOOM_PERCENT, roundedZoom - 25))}
        >
          <ZoomOut aria-hidden="true" />
        </IconButton>
        <label className="viewport-zoom-slider">
          <span>Zoom</span>
          <input
            aria-label="Set zoom percentage"
            type="range"
            min={MIN_ZOOM_PERCENT}
            max={MAX_ZOOM_PERCENT}
            step={1}
            value={roundedZoom}
            onChange={(event) => onZoom(Number(event.currentTarget.value))}
          />
          <output aria-label="Current zoom">{roundedZoom}%</output>
        </label>
        <IconButton
          label="Zoom in"
          title="Zoom in"
          disabled={roundedZoom >= MAX_ZOOM_PERCENT}
          onClick={() => onZoom(Math.min(MAX_ZOOM_PERCENT, roundedZoom + 25))}
        >
          <ZoomIn aria-hidden="true" />
        </IconButton>
      </div>

      <div className="viewport-pan-controls" role="group" aria-label="Pan viewport">
        <IconButton label="Pan viewport up" title="Pan viewport up" onClick={() => onPan(0, -1)}>
          <ArrowUp aria-hidden="true" />
        </IconButton>
        <IconButton label="Pan viewport left" title="Pan viewport left" onClick={() => onPan(-1, 0)}>
          <ArrowLeft aria-hidden="true" />
        </IconButton>
        <IconButton label="Pan viewport right" title="Pan viewport right" onClick={() => onPan(1, 0)}>
          <ArrowRight aria-hidden="true" />
        </IconButton>
        <IconButton label="Pan viewport down" title="Pan viewport down" onClick={() => onPan(0, 1)}>
          <ArrowDown aria-hidden="true" />
        </IconButton>
      </div>

      <p
        className="sr-only"
        role="status"
        aria-label="Viewport state"
        aria-live="polite"
      >
        {viewportStateLabel(state)}
      </p>
    </section>
  );
}

interface IconButtonProps {
  label: string;
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function IconButton({ label, title, disabled = false, onClick, children }: IconButtonProps) {
  return (
    <button type="button" aria-label={label} title={title} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}
