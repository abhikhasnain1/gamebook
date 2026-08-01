import type { MediaPlacementRecord } from "./mediaPlacementGeometry";

interface MediaPlacementOutlineProps {
  placements: MediaPlacementRecord[];
  selectedId: string;
  onSelect: (id: string) => void;
  onChange: (id: string, patch: Partial<MediaPlacementRecord>) => void;
}

export function MediaPlacementOutline({
  placements,
  selectedId,
  onSelect,
  onChange,
}: MediaPlacementOutlineProps) {
  const selected = placements.find((placement) => placement.id === selectedId);

  return (
    <aside className="spike-outline" aria-label="Page outline">
      <h2>Outline</h2>
      <ul aria-label="Media placements">
        {placements.map((placement) => (
          <li key={placement.id}>
            <button
              type="button"
              aria-pressed={placement.id === selectedId}
              onClick={() => onSelect(placement.id)}
            >
              <span>{placement.evidenceId}</span>
              <small>Media placement, layer {placement.zIndex}</small>
            </button>
          </li>
        ))}
      </ul>
      {selected ? (
        <fieldset>
          <legend>{selected.evidenceId} geometry</legend>
          <NumberControl label="X" value={selected.left} onChange={(left) => onChange(selected.id, { left })} />
          <NumberControl label="Y" value={selected.top} onChange={(top) => onChange(selected.id, { top })} />
          <NumberControl label="Scale X" value={selected.scaleX} step={0.05} minimum={0.05} onChange={(scaleX) => onChange(selected.id, { scaleX })} />
          <NumberControl label="Scale Y" value={selected.scaleY} step={0.05} minimum={0.05} onChange={(scaleY) => onChange(selected.id, { scaleY })} />
          <NumberControl label="Rotation" value={selected.angle} onChange={(angle) => onChange(selected.id, { angle })} />
          <NumberControl label="Layer" value={selected.zIndex} onChange={(zIndex) => onChange(selected.id, { zIndex: Math.round(zIndex) })} />
          <NumberControl
            label="Poster time (microseconds)"
            value={selected.posterTimestampUs ?? 0}
            minimum={0}
            step={1000}
            onChange={(posterTimestampUs) => onChange(selected.id, { posterTimestampUs: Math.round(posterTimestampUs) })}
          />
          <div className="spike-crop-grid" aria-label="Crop rectangle">
            <NumberControl label="Crop X" value={selected.crop?.x ?? 0} minimum={0} onChange={(x) => updateCrop(selected, { x }, onChange)} />
            <NumberControl label="Crop Y" value={selected.crop?.y ?? 0} minimum={0} onChange={(y) => updateCrop(selected, { y }, onChange)} />
            <NumberControl label="Crop width" value={selected.crop?.width ?? 640} minimum={1} onChange={(width) => updateCrop(selected, { width }, onChange)} />
            <NumberControl label="Crop height" value={selected.crop?.height ?? 360} minimum={1} onChange={(height) => updateCrop(selected, { height }, onChange)} />
          </div>
        </fieldset>
      ) : null}
    </aside>
  );
}

interface NumberControlProps {
  label: string;
  value: number;
  minimum?: number;
  step?: number;
  onChange: (value: number) => void;
}

function NumberControl({ label, value, minimum, step = 1, onChange }: NumberControlProps) {
  return (
    <label>
      <span>{label}</span>
      <input
        type="number"
        value={value}
        min={minimum}
        step={step}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
    </label>
  );
}

function updateCrop(
  placement: MediaPlacementRecord,
  patch: Partial<NonNullable<MediaPlacementRecord["crop"]>>,
  onChange: MediaPlacementOutlineProps["onChange"],
) {
  onChange(placement.id, {
    crop: {
      x: 0,
      y: 0,
      width: 640,
      height: 360,
      ...placement.crop,
      ...patch,
    },
  });
}
