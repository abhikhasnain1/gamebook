import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { useState } from "react";
import type { MediaPlacementRecord } from "../types/projectV2";

export interface OutlineAnnotation {
  id: string;
  kind: string;
  label: string;
}

interface PageOutlineProps {
  placement: MediaPlacementRecord;
  placementLabel: string;
  annotations: OutlineAnnotation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onPlacementChange: (patch: Partial<MediaPlacementRecord>) => void;
}

export function PageOutline({
  placement,
  placementLabel,
  annotations,
  selectedId,
  onSelect,
  onPlacementChange,
}: PageOutlineProps) {
  const [collapsed, setCollapsed] = useState(false);
  const placementSelected = selectedId === placement.id;
  return (
    <aside className={`page-outline${collapsed ? " is-collapsed" : ""}`} aria-label="Page outline">
      <header>
        {!collapsed && <h2>Outline</h2>}
        <button
          type="button"
          className="outline-collapse"
          aria-label={collapsed ? "Expand page outline" : "Collapse page outline"}
          data-tooltip={collapsed ? "Expand outline" : "Collapse outline"}
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? <PanelRightOpen /> : <PanelRightClose />}
        </button>
      </header>
      {!collapsed && <>
      <ul aria-label="Page objects">
        <li>
          <button
            type="button"
            aria-pressed={placementSelected}
            onClick={() => onSelect(placement.id)}
          >
            <span>{placementLabel}</span>
            <small>Screenshot placement, layer {placement.zIndex}</small>
          </button>
        </li>
        {annotations.map((annotation) => (
          <li key={annotation.id}>
            <button
              type="button"
              aria-pressed={selectedId === annotation.id}
              onClick={() => onSelect(annotation.id)}
            >
              <span>{annotation.label}</span>
              <small>{annotation.kind} annotation</small>
            </button>
          </li>
        ))}
      </ul>
      {placementSelected ? (
        <fieldset>
          <legend>Screenshot geometry</legend>
          <NumberControl label="X position" value={placement.left} onChange={(left) => onPlacementChange({ left })} />
          <NumberControl label="Y position" value={placement.top} onChange={(top) => onPlacementChange({ top })} />
          <NumberControl label="Horizontal scale" value={placement.scaleX} minimum={0.01} step={0.01} onChange={(scaleX) => onPlacementChange({ scaleX })} />
          <NumberControl label="Vertical scale" value={placement.scaleY} minimum={0.01} step={0.01} onChange={(scaleY) => onPlacementChange({ scaleY })} />
          <NumberControl label="Rotation in degrees" value={placement.angle} minimum={0} maximum={359.99} step={1} onChange={(angle) => onPlacementChange({ angle })} />
          <NumberControl label="Layer" value={placement.zIndex} step={1} onChange={(zIndex) => onPlacementChange({ zIndex: Math.round(zIndex) })} />
        </fieldset>
      ) : null}
      </>}
    </aside>
  );
}

interface NumberControlProps {
  label: string;
  value: number;
  minimum?: number;
  maximum?: number;
  step?: number;
  onChange: (value: number) => void;
}

function NumberControl({
  label,
  value,
  minimum,
  maximum,
  step = 1,
  onChange,
}: NumberControlProps) {
  return (
    <label>
      <span>{label}</span>
      <input
        type="number"
        value={Number(value.toFixed(4))}
        min={minimum}
        max={maximum}
        step={step}
        onChange={(event) => {
          const next = Number(event.currentTarget.value);
          if (Number.isFinite(next)) onChange(next);
        }}
      />
    </label>
  );
}
