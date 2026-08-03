import type { AnnotationSnapshot } from "./session";

export interface ProjectV2AssetRecord {
  digest: string;
  byteLength: number;
  mediaClass: "image" | "video" | "audio" | "binary";
  mimeType:
    | "image/png"
    | "image/jpeg"
    | "video/mp4"
    | "audio/mp4"
    | "application/octet-stream";
  extension: "png" | "jpg" | "mp4" | "m4a" | "bin";
  storageMethod: "stored";
}

export interface ProjectV2DerivedPreviewRecord {
  evidenceId: string;
  kind: "thumbnail" | "poster";
  sourceDigest: string;
  previewDigest: string;
}

export interface MediaPlacementRecord {
  type: "MediaPlacement";
  placementVersion: 1;
  id: string;
  evidenceId: string;
  left: number;
  top: number;
  scaleX: number;
  scaleY: number;
  angle: number;
  crop?: { x: number; y: number; width: number; height: number };
  posterTimestampUs?: number;
  zIndex: number;
}

export interface ProjectV2AnnotationRecord {
  id: string;
  kind: "pen" | "arrow" | "callout" | "line" | "box" | "circle" | "text" | "note";
  scope: { kind: "page" };
  semanticText: string;
  fabricObject: Record<string, unknown>;
}

export interface ProjectV2ConnectorRecord {
  id: string;
  start: { objectId: string; anchor: "top" | "right" | "bottom" | "left" };
  end: { objectId: string; anchor: "top" | "right" | "bottom" | "left" };
}

export interface ProjectV2PageRecord {
  recordType: "page";
  recordVersion: 1;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  primaryEvidenceId: string | null;
  backgroundColor: string;
  placements: MediaPlacementRecord[];
  annotations: ProjectV2AnnotationRecord[];
  annotationOrder: string[];
  connectors: ProjectV2ConnectorRecord[];
  notes: string;
}

export interface ProjectV2ScreenshotEvidenceRecord {
  recordType: "evidence";
  recordVersion: 1;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  kind: "screenshot";
  sessionId: null;
  tagIds: string[];
  provenance: {
    origin: "capture" | "import" | "migration" | "derived";
    parentEvidenceIds: string[];
    importedAt: string | null;
    originalFilename: string | null;
  };
  assetDigest: string;
  image: {
    width: number;
    height: number;
    colorSpace: "srgb";
    monitorLabel: string | null;
  };
}

export interface ProjectV2Manifest {
  formatVersion: 2;
  minimumReaderVersion: 2;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  activePageId: string | null;
  recordOrder: {
    pages: string[];
    evidence: string[];
    timelines: string[];
    findings: string[];
    tags: string[];
    collections: string[];
    relationships: string[];
    sessions: string[];
    trash: string[];
  };
  assets: ProjectV2AssetRecord[];
  derivedPreviews?: ProjectV2DerivedPreviewRecord[];
}

export interface EditorPage {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  evidenceId: string;
  assetDigest: string;
  monitorName: string;
  sourceWidth: number;
  sourceHeight: number;
  sourceUrl: string | null;
  thumbnailUrl: string | null;
  placement: MediaPlacementRecord;
  annotations: AnnotationSnapshot;
  extractedText: string;
  backgroundColor: string;
}

export type EditorPageContentPatch = Pick<
  EditorPage,
  "placement" | "annotations" | "thumbnailUrl" | "extractedText" | "backgroundColor"
>;

export interface EditorProject {
  formatVersion: 2;
  workspaceId: string;
  requiresSaveAs: boolean;
  manifest: ProjectV2Manifest;
  pages: EditorPage[];
  evidence: Record<string, ProjectV2ScreenshotEvidenceRecord>;
}

export interface NativeProjectV2Result {
  workspaceId: string;
  projectId: string;
  manifest: unknown;
  records: unknown[];
}

export function editorProjectFromNative(
  result: NativeProjectV2Result,
  requiresSaveAs = false,
): EditorProject {
  const manifest = requireManifest(result.manifest);
  if (manifest.projectId !== result.projectId) {
    throw new Error("Project identity does not match the native workspace.");
  }
  const records = result.records
    .map(optionalProjectRecord)
    .filter(
      (
        record,
      ): record is ProjectV2PageRecord | ProjectV2ScreenshotEvidenceRecord =>
        record !== null,
    );
  const evidence = Object.fromEntries(
    records
      .filter(isScreenshotEvidence)
      .map((record) => [record.id, record]),
  );
  const pagesById = new Map(
    records.filter(isPageRecord).map((record) => [record.id, record]),
  );
  const pages = manifest.recordOrder.pages.map((id) => {
    const page = pagesById.get(id);
    if (!page) throw new Error(`Page record is missing: ${id}`);
    const placement = page.placements.find(
      (candidate) => candidate.evidenceId === page.primaryEvidenceId,
    );
    if (!placement) throw new Error(`Primary screenshot placement is missing: ${id}`);
    const source = evidence[placement.evidenceId];
    if (!source) throw new Error(`Screenshot evidence is missing: ${placement.evidenceId}`);
    const annotationsById = new Map(page.annotations.map((annotation) => [annotation.id, annotation]));
    return {
      id: page.id,
      title: page.title,
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
      evidenceId: source.id,
      assetDigest: source.assetDigest,
      monitorName: source.image.monitorLabel ?? "Display",
      sourceWidth: source.image.width,
      sourceHeight: source.image.height,
      sourceUrl: null,
      thumbnailUrl: null,
      placement: normalizePlacement(placement),
      annotations: {
        objects: page.annotationOrder.map((annotationId) => {
          const annotation = annotationsById.get(annotationId);
          if (!annotation) throw new Error(`Annotation record is missing: ${annotationId}`);
          return editorFabricObject(annotation);
        }),
      },
      extractedText: page.notes,
      backgroundColor: page.backgroundColor,
    } satisfies EditorPage;
  });
  return {
    formatVersion: 2,
    workspaceId: result.workspaceId,
    requiresSaveAs,
    manifest,
    pages,
    evidence,
  };
}

export function editorProjectDocuments(project: EditorProject): unknown[] {
  const now = project.manifest.updatedAt;
  const pages = project.pages.map((page) => editorPageRecord(page, now));
  const manifest: ProjectV2Manifest = {
    ...project.manifest,
    title: project.manifest.title,
    activePageId: project.manifest.activePageId,
    recordOrder: {
      ...project.manifest.recordOrder,
      pages: pages.map((page) => page.id),
      evidence: orderedUnique([
        ...project.manifest.recordOrder.evidence,
        ...project.pages.map((page) => page.evidenceId),
      ]),
    },
    assets: deduplicateAssets(project.manifest.assets),
  };
  const orderedEvidence = manifest.recordOrder.evidence.flatMap((id) => {
    const record = project.evidence[id];
    return record ? [record] : [];
  });
  return [manifest, ...orderedEvidence, ...pages];
}

export function editorPageRecord(page: EditorPage, updatedAt: string): ProjectV2PageRecord {
  const annotations = page.annotations.objects.map(annotationRecord);
  return {
    recordType: "page",
    recordVersion: 1,
    id: page.id,
    title: page.title,
    createdAt: page.createdAt,
    updatedAt,
    primaryEvidenceId: page.evidenceId,
    backgroundColor: page.backgroundColor,
    placements: [normalizePlacement(page.placement)],
    annotations,
    annotationOrder: annotations.map((annotation) => annotation.id),
    connectors: annotations.flatMap(connectorRecord),
    notes: page.extractedText,
  };
}

export function normalizePlacement(value: MediaPlacementRecord): MediaPlacementRecord {
  const placement: MediaPlacementRecord = {
    type: "MediaPlacement",
    placementVersion: 1,
    id: requireId(value.id, "placement"),
    evidenceId: requireId(value.evidenceId, "evidence"),
    left: finite(value.left, "left"),
    top: finite(value.top, "top"),
    scaleX: positive(value.scaleX, "scaleX"),
    scaleY: positive(value.scaleY, "scaleY"),
    angle: normalizeAngle(value.angle),
    zIndex: integer(value.zIndex, "zIndex"),
  };
  if (value.crop) {
    placement.crop = {
      x: nonNegative(value.crop.x, "crop.x"),
      y: nonNegative(value.crop.y, "crop.y"),
      width: positive(value.crop.width, "crop.width"),
      height: positive(value.crop.height, "crop.height"),
    };
  }
  if (value.posterTimestampUs !== undefined) {
    placement.posterTimestampUs = integer(
      nonNegative(value.posterTimestampUs, "posterTimestampUs"),
      "posterTimestampUs",
    );
  }
  return placement;
}

function annotationRecord(object: Record<string, unknown>): ProjectV2AnnotationRecord {
  const fabricObject = structuredClone(object);
  const data = requireObject(fabricObject.data, "annotation data");
  const id = requireId(data.id, "annotation");
  const declaredKind = typeof data.kind === "string" ? data.kind : "note";
  if (declaredKind === "crop") {
    delete fabricObject.src;
    delete fabricObject.crossOrigin;
  }
  return {
    id,
    kind: annotationKind(declaredKind, fabricObject.type),
    scope: { kind: "page" },
    semanticText: typeof fabricObject.text === "string" ? fabricObject.text : "",
    fabricObject,
  };
}

function connectorRecord(annotation: ProjectV2AnnotationRecord): ProjectV2ConnectorRecord[] {
  const data = requireObject(annotation.fabricObject.data, "annotation data");
  const connector = optionalObject(data.connector);
  const start = optionalEndpoint(connector?.start);
  const end = optionalEndpoint(connector?.end);
  return start && end ? [{ id: annotation.id, start, end }] : [];
}

function editorFabricObject(annotation: ProjectV2AnnotationRecord): Record<string, unknown> {
  const object = structuredClone(annotation.fabricObject);
  const data = optionalObject(object.data) ?? {};
  object.data = {
    ...data,
    id: annotation.id,
    kind: data.kind ?? annotation.kind,
    role: "annotation",
  };
  return object;
}

function requireManifest(value: unknown): ProjectV2Manifest {
  const manifest = requireObject(value, "manifest");
  if (manifest.formatVersion !== 2 || manifest.minimumReaderVersion !== 2) {
    throw new Error("This project format is not supported.");
  }
  requireObject(manifest.recordOrder, "record order");
  if (!Array.isArray(manifest.assets)) throw new Error("Project assets are invalid.");
  return manifest as unknown as ProjectV2Manifest;
}

function optionalProjectRecord(
  value: unknown,
): ProjectV2PageRecord | ProjectV2ScreenshotEvidenceRecord | null {
  const record = optionalObject(value);
  if (record?.recordType === "page") {
    return record as unknown as ProjectV2PageRecord;
  }
  if (record?.recordType === "evidence") {
    return record as unknown as ProjectV2ScreenshotEvidenceRecord;
  }
  return null;
}

function isPageRecord(
  value: ProjectV2PageRecord | ProjectV2ScreenshotEvidenceRecord,
): value is ProjectV2PageRecord {
  return value.recordType === "page";
}

function isScreenshotEvidence(
  value: ProjectV2PageRecord | ProjectV2ScreenshotEvidenceRecord,
): value is ProjectV2ScreenshotEvidenceRecord {
  return value.recordType === "evidence" && value.kind === "screenshot";
}

function annotationKind(
  declared: string,
  fabricType: unknown,
): ProjectV2AnnotationRecord["kind"] {
  if (["pen", "arrow", "callout", "line", "box", "circle", "text", "note"].includes(declared)) {
    return declared as ProjectV2AnnotationRecord["kind"];
  }
  if (declared === "crop") return "box";
  const type = typeof fabricType === "string" ? fabricType.toLowerCase() : "";
  if (type === "path") return "pen";
  if (type === "rect") return "box";
  if (type === "circle" || type === "ellipse") return "circle";
  if (type === "textbox" || type === "i-text") return "text";
  return "note";
}

function optionalEndpoint(value: unknown): ProjectV2ConnectorRecord["start"] | null {
  const endpoint = optionalObject(value);
  if (!endpoint || typeof endpoint.objectId !== "string") return null;
  if (!isAnchor(endpoint.anchor)) return null;
  return { objectId: endpoint.objectId, anchor: endpoint.anchor };
}

function isAnchor(value: unknown): value is ProjectV2ConnectorRecord["start"]["anchor"] {
  return value === "top" || value === "right" || value === "bottom" || value === "left";
}

function deduplicateAssets(assets: ProjectV2AssetRecord[]): ProjectV2AssetRecord[] {
  return [...new Map(assets.map((asset) => [asset.digest, asset])).values()];
}

function orderedUnique(values: string[]): string[] {
  return [...new Set(values)];
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  const result = optionalObject(value);
  if (!result) throw new Error(`${label} is invalid.`);
  return result;
}

function optionalObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,95}$/.test(value)) {
    throw new Error(`${label} id is invalid.`);
  }
  return value;
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`);
  return value;
}

function positive(value: number, label: string): number {
  const result = finite(value, label);
  if (result <= 0) throw new Error(`${label} must be positive.`);
  return result;
}

function nonNegative(value: number, label: string): number {
  const result = finite(value, label);
  if (result < 0) throw new Error(`${label} must not be negative.`);
  return result;
}

function integer(value: number, label: string): number {
  const result = finite(value, label);
  if (!Number.isInteger(result)) throw new Error(`${label} must be an integer.`);
  return result;
}

function normalizeAngle(value: number): number {
  return ((finite(value, "angle") % 360) + 360) % 360;
}
