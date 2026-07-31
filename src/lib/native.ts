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
