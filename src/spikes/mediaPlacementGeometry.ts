export const MEDIA_PLACEMENT_SCHEMA = "gamebook.media-placement-geometry.v1";

export type PlacementAnchor = "top" | "right" | "bottom" | "left";

export interface PlacementCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MediaPlacementRecord {
  id: string;
  evidenceId: string;
  left: number;
  top: number;
  scaleX: number;
  scaleY: number;
  angle: number;
  crop?: PlacementCrop;
  posterTimestampUs?: number;
  zIndex: number;
}

export interface PlacementConnectorRecord {
  id: string;
  start: { placementId: string; anchor: PlacementAnchor };
  end: { annotationId: string; anchor: PlacementAnchor };
}

export interface PlacementPageRecord {
  id: string;
  placements: MediaPlacementRecord[];
  connectors: PlacementConnectorRecord[];
  annotationIds: string[];
}

export interface PlacementHarnessSnapshot {
  activePageId: string;
  pages: PlacementPageRecord[];
}

const FORBIDDEN_KEYS = new Set([
  "assetToken",
  "bitmap",
  "bytes",
  "canvas",
  "element",
  "frame",
  "image",
  "objectUrl",
  "path",
  "src",
  "video",
]);

export function normalizePlacement(
  input: MediaPlacementRecord,
): MediaPlacementRecord {
  const record: MediaPlacementRecord = {
    id: requireOpaqueId(input.id, "placement id"),
    evidenceId: requireOpaqueId(input.evidenceId, "evidence id"),
    left: finite(input.left, "left"),
    top: finite(input.top, "top"),
    scaleX: positive(input.scaleX, "scaleX"),
    scaleY: positive(input.scaleY, "scaleY"),
    angle: normalizeAngle(input.angle),
    zIndex: integer(input.zIndex, "zIndex"),
  };

  if (input.crop) {
    record.crop = {
      x: nonNegative(input.crop.x, "crop.x"),
      y: nonNegative(input.crop.y, "crop.y"),
      width: positive(input.crop.width, "crop.width"),
      height: positive(input.crop.height, "crop.height"),
    };
  }
  if (input.posterTimestampUs !== undefined) {
    record.posterTimestampUs = integer(
      nonNegative(input.posterTimestampUs, "posterTimestampUs"),
      "posterTimestampUs",
    );
  }
  assertStablePlacement(record);
  return record;
}

export function assertStablePlacement(value: unknown): asserts value is MediaPlacementRecord {
  assertStableValue(value, "placement");
  if (!isRecord(value)) throw new Error("placement must be a record");

  const allowed = new Set([
    "id",
    "evidenceId",
    "left",
    "top",
    "scaleX",
    "scaleY",
    "angle",
    "crop",
    "posterTimestampUs",
    "zIndex",
  ]);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length) {
    throw new Error(`placement contains unsupported state: ${unexpected.join(", ")}`);
  }
}

export function cloneSnapshot(
  snapshot: PlacementHarnessSnapshot,
): PlacementHarnessSnapshot {
  return structuredClone(snapshot);
}

export function updatePlacement(
  snapshot: PlacementHarnessSnapshot,
  pageId: string,
  placementId: string,
  patch: Partial<MediaPlacementRecord>,
): PlacementHarnessSnapshot {
  const next = cloneSnapshot(snapshot);
  const page = next.pages.find((candidate) => candidate.id === pageId);
  if (!page) throw new Error(`unknown page: ${pageId}`);
  const index = page.placements.findIndex((candidate) => candidate.id === placementId);
  if (index < 0) throw new Error(`unknown placement: ${placementId}`);
  page.placements[index] = normalizePlacement({ ...page.placements[index], ...patch });
  return next;
}

export function orderedCompositionIds(page: PlacementPageRecord): string[] {
  return [
    ...page.placements
      .slice()
      .sort((left, right) => left.zIndex - right.zIndex || left.id.localeCompare(right.id))
      .map((placement) => placement.id),
    ...page.annotationIds,
    ...page.connectors.map((connector) => connector.id),
  ];
}

export class PlacementHistory {
  private readonly entries: PlacementHarnessSnapshot[];
  private index = 0;

  constructor(initial: PlacementHarnessSnapshot) {
    this.entries = [cloneSnapshot(initial)];
  }

  current(): PlacementHarnessSnapshot {
    return cloneSnapshot(this.entries[this.index]);
  }

  push(snapshot: PlacementHarnessSnapshot): PlacementHarnessSnapshot {
    this.entries.splice(this.index + 1);
    this.entries.push(cloneSnapshot(snapshot));
    this.index = this.entries.length - 1;
    return this.current();
  }

  undo(): PlacementHarnessSnapshot {
    this.index = Math.max(0, this.index - 1);
    return this.current();
  }

  redo(): PlacementHarnessSnapshot {
    this.index = Math.min(this.entries.length - 1, this.index + 1);
    return this.current();
  }

  canUndo(): boolean {
    return this.index > 0;
  }

  canRedo(): boolean {
    return this.index < this.entries.length - 1;
  }
}

function assertStableValue(value: unknown, key: string): void {
  if (typeof value === "function") throw new Error(`${key} contains a function`);
  if (typeof Element !== "undefined" && value instanceof Element) {
    throw new Error(`${key} contains a DOM element`);
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    throw new Error(`${key} contains media bytes`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertStableValue(entry, `${key}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [childKey, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(childKey)) {
      throw new Error(`${key} contains forbidden key: ${childKey}`);
    }
    assertStableValue(child, `${key}.${childKey}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireOpaqueId(value: string, label: string): string {
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/i.test(value)) {
    throw new Error(`${label} must be an opaque identifier`);
  }
  return value;
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function nonNegative(value: number, label: string): number {
  if (finite(value, label) < 0) throw new Error(`${label} must not be negative`);
  return value;
}

function positive(value: number, label: string): number {
  if (finite(value, label) <= 0) throw new Error(`${label} must be positive`);
  return value;
}

function integer(value: number, label: string): number {
  if (!Number.isInteger(value)) throw new Error(`${label} must be an integer`);
  return value;
}

function normalizeAngle(value: number): number {
  const angle = finite(value, "angle") % 360;
  return angle < 0 ? angle + 360 : angle;
}
