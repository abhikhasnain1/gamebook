import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { parseSession, type CapturePayload, type GamebookSession } from "../types/session";

export const isTauri = "__TAURI_INTERNALS__" in window;

export async function onCapture(
  handler: (capture: CapturePayload) => void,
): Promise<UnlistenFn> {
  if (!isTauri) return () => undefined;
  return listen<CapturePayload>("capture-created", ({ payload }) => handler(payload));
}

export interface ScreenshotCaptureEvent {
  captureId: string;
  capturedAt: string;
  monitorName: string;
  width: number;
  height: number;
  monitorX?: number;
  monitorY?: number;
}

export async function onScreenshotCapture(
  handler: (capture: ScreenshotCaptureEvent) => void,
): Promise<UnlistenFn> {
  if (!isTauri) return () => undefined;
  return listen<ScreenshotCaptureEvent>("capture-created", ({ payload }) =>
    handler(payload),
  );
}

export async function onCaptureError(
  handler: (message: string) => void,
): Promise<UnlistenFn> {
  if (!isTauri) return () => undefined;
  return listen<string>("capture-error", ({ payload }) => handler(payload));
}

export async function loadAutosave(): Promise<GamebookSession | null> {
  if (!isTauri) return null;
  const content = await invoke<string | null>("load_autosave");
  return content ? parseSession(content) : null;
}

export async function autosave(session: GamebookSession): Promise<void> {
  if (!isTauri) return;
  await invoke("autosave_project", { content: session });
}

export async function saveProject(
  session: GamebookSession,
  currentPath: string | null,
): Promise<string | null> {
  if (!isTauri) return null;
  return invoke<string | null>("save_project", {
    content: session,
    currentPath,
    suggestedName: fileStem(session.title),
  });
}

export async function openProject(): Promise<
  { path: string; session: GamebookSession } | null
> {
  if (!isTauri) return null;
  const result = await invoke<[string, string] | null>("open_project");
  if (!result) return null;
  return { path: result[0], session: parseSession(result[1]) };
}

export interface ProjectV2OpenResult {
  workspaceId: string;
  projectId: string;
  manifest: unknown;
  records: unknown[];
  reusedWorkspace: boolean;
  copyDetected: boolean;
  recoveryRequired: boolean;
}

export interface ProjectV2AssetResult {
  token: string;
  digest: string;
  mimeType: string;
  byteLength: number;
  expiresAfterSeconds: number;
}

export interface ProjectV2SaveResult {
  operationId: string;
  saveId: string;
  replacedExisting: boolean;
  directoryFlushSupported: boolean;
  visibleArchiveReopened: boolean;
  version1BackupCreated: boolean;
}

export interface ProjectReportMessage {
  code: string;
  severity: "info" | "warning" | "error";
  recordId: string | null;
  detail: string;
}

export interface ProjectV1MigrationReport {
  recordType: "migration-report";
  reportVersion: 1;
  migrationId: string;
  sourceFormat: "gzip-json-v1" | "plain-json-v1";
  targetFormat: "zip64-v2";
  sourceSha256: string;
  status: "passed" | "failed" | "cancelled";
  startedAt: string;
  completedAt: string | null;
  idMappings: unknown[];
  assetResults: unknown[];
  pageResults: unknown[];
  renderDiff: {
    width: 1600;
    height: 900;
    perChannelThreshold: 8;
    pixelsOverThresholdRatio: number;
    maximumAllowedRatio: 0.001;
    passed: true;
  };
  messages: ProjectReportMessage[];
  sourceMutated: false;
}

export interface ProjectV1MigrationResult extends ProjectV2OpenResult {
  report: ProjectV1MigrationReport;
  sourceFormat: "gzip-json-v1" | "plain-json-v1";
}

export interface ProjectV2RepairReport {
  recordType: "repair-report";
  reportVersion: 1;
  repairId: string;
  sourceSha256: string;
  formatVersion: number;
  mode: "read-only";
  status: "recoverable" | "unrecoverable" | "future-version-rejected";
  validRecordIds: string[];
  invalidRecordIds: string[];
  missingAssetDigests: string[];
  messages: ProjectReportMessage[];
  sourceMutated: false;
  inventedReplacements: false;
}

export interface ProjectV2CacheResult {
  bytesBefore: number;
  bytesAfter: number;
  evictedEntries: number;
  cancelled: boolean;
}

export interface ProjectV2RecoverySummary {
  workspaceId: string;
  projectId: string;
  state: string;
  protectedClasses?: string[];
}

export type ProjectV2ExternalChangeChoice = "cancel" | "save-as" | "replace";

export type EditorProjectOpenOutcome =
  | { outcome: "opened"; project: ProjectV2OpenResult }
  | { outcome: "migrated"; project: ProjectV1MigrationResult }
  | { outcome: "repair"; report: ProjectV2RepairReport }
  | { outcome: "future-version-rejected"; code: "future-version-rejected" };

export async function createProjectV2(): Promise<ProjectV2OpenResult | null> {
  if (!isTauri) return null;
  return invoke<ProjectV2OpenResult>("create_project_v2");
}

export async function recoverProjectV2Workspace(
  workspaceId: string,
): Promise<ProjectV2OpenResult | null> {
  if (!isTauri) return null;
  return invoke<ProjectV2OpenResult>("recover_project_v2_workspace", {
    workspaceId,
  });
}

export async function openProjectForEditor(
  operationId: string,
): Promise<EditorProjectOpenOutcome | null> {
  if (!isTauri) return null;
  return invoke<EditorProjectOpenOutcome | null>("open_project_for_editor", {
    operationId,
  });
}

export async function claimScreenshotCapture(
  workspaceId: string,
  captureId: string,
): Promise<ProjectV2AssetResult | null> {
  if (!isTauri) return null;
  return invoke<ProjectV2AssetResult>("claim_screenshot_capture", {
    workspaceId,
    captureId,
  });
}

export async function openProjectV2(): Promise<ProjectV2OpenResult | null> {
  if (!isTauri) return null;
  return invoke<ProjectV2OpenResult | null>("open_project_v2");
}

export async function migrateProjectV1(
  operationId: string,
): Promise<ProjectV1MigrationResult | null> {
  if (!isTauri) return null;
  return invoke<ProjectV1MigrationResult | null>("migrate_project_v1", { operationId });
}

export async function inspectProjectV2Repair(): Promise<ProjectV2RepairReport | null> {
  if (!isTauri) return null;
  return invoke<ProjectV2RepairReport | null>("inspect_project_v2_repair");
}

export async function readProjectV2Record(
  workspaceId: string,
  recordType: string,
  recordId: string,
): Promise<unknown> {
  if (!isTauri) return null;
  return invoke("read_project_v2_record", { workspaceId, recordType, recordId });
}

export async function stageProjectV2Document(
  workspaceId: string,
  document: unknown,
): Promise<void> {
  if (!isTauri) return;
  await invoke("stage_project_v2_document", { workspaceId, document });
}

export async function autosaveProjectV2Workspace(workspaceId: string): Promise<void> {
  if (!isTauri) return;
  await invoke("autosave_project_v2_workspace", { workspaceId });
}

export async function materializeProjectV2Asset(
  workspaceId: string,
  digest: string,
  operationId: string,
): Promise<ProjectV2AssetResult | null> {
  if (!isTauri) return null;
  return invoke<ProjectV2AssetResult>("materialize_project_v2_asset", {
    workspaceId,
    digest,
    operationId,
  });
}

export async function saveProjectV2(
  workspaceId: string,
  saveAs: boolean,
  externalChangeChoice: ProjectV2ExternalChangeChoice,
  operationId: string,
): Promise<ProjectV2SaveResult | null> {
  if (!isTauri) return null;
  return invoke<ProjectV2SaveResult | null>("save_project_v2", {
    workspaceId,
    saveAs,
    externalChangeChoice,
    operationId,
  });
}

export async function cancelProjectV2Operation(operationId: string): Promise<boolean> {
  if (!isTauri) return false;
  return invoke<boolean>("cancel_project_v2_operation", { operationId });
}

export async function closeProjectV2Workspace(workspaceId: string): Promise<void> {
  if (!isTauri) return;
  await invoke("close_project_v2_workspace", { workspaceId });
}

export async function evictProjectV2CleanCache(
  byteLimit: number,
  operationId: string,
): Promise<ProjectV2CacheResult | null> {
  if (!isTauri) return null;
  return invoke<ProjectV2CacheResult>("evict_project_v2_clean_cache", {
    byteLimit,
    operationId,
  });
}

export async function listProjectV2Recovery(): Promise<ProjectV2RecoverySummary[]> {
  if (!isTauri) return [];
  return invoke<ProjectV2RecoverySummary[]>("list_project_v2_recovery");
}

export function projectV2MediaUrl(token: string): string {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid project media token.");
  return `http://gamebook-media.localhost/${token}`;
}

export async function hideOverlay(): Promise<void> {
  if (!isTauri) return;
  await invoke("hide_overlay");
}

export async function quitApp(): Promise<void> {
  if (!isTauri) return;
  await invoke("quit_app");
}

export async function saveBinary(
  dataBase64: string,
  extension: "png" | "pdf",
  description: string,
  suggestedName: string,
): Promise<string | null> {
  if (!isTauri) return null;
  return invoke<string | null>("save_binary_export", {
    dataBase64,
    extension,
    description,
    suggestedName: fileStem(suggestedName),
  });
}

export async function saveText(
  content: string,
  extension: "txt",
  description: string,
  suggestedName: string,
): Promise<string | null> {
  if (!isTauri) return null;
  return invoke<string | null>("save_text_export", {
    content,
    extension,
    description,
    suggestedName: fileStem(suggestedName),
  });
}

export async function saveMarkdown(
  title: string,
  pages: Array<{ title: string; text: string; imageDataUrl: string }>,
): Promise<string | null> {
  if (!isTauri) return null;
  return invoke<string | null>("save_markdown_export", {
    title,
    pages,
    suggestedName: fileStem(title),
  });
}

export function fileStem(value: string): string {
  const stem = value
    .trim()
    .replace(/[^a-z0-9-_]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return stem || "gamebook";
}
