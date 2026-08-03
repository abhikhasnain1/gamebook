import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

describe("version 2 native command boundary", () => {
  beforeAll(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
  });

  beforeEach(() => {
    invoke.mockReset();
  });

  it("opens and saves without accepting a filesystem path or asset bytes", async () => {
    const { openProjectV2, saveProjectV2 } = await import("./native");
    invoke
      .mockResolvedValueOnce({ workspaceId: "workspace-alpha", records: [] })
      .mockResolvedValueOnce({ operationId: "save-alpha", visibleArchiveReopened: true });

    await openProjectV2();
    await saveProjectV2("workspace-alpha", true, "save-as", "save-alpha");

    expect(invoke).toHaveBeenNthCalledWith(1, "open_project_v2");
    expect(invoke).toHaveBeenNthCalledWith(2, "save_project_v2", {
      workspaceId: "workspace-alpha",
      saveAs: true,
      externalChangeChoice: "save-as",
      operationId: "save-alpha",
    });
    expect(JSON.stringify(invoke.mock.calls)).not.toMatch(/base64|currentPath|destination/i);
  });

  it("materializes assets as scoped tokens and validates protocol URLs", async () => {
    const { materializeProjectV2Asset, projectV2MediaUrl } = await import("./native");
    const token = "a".repeat(64);
    invoke.mockResolvedValueOnce({
      token,
      digest: "b".repeat(64),
      mimeType: "image/png",
      byteLength: 32,
      expiresAfterSeconds: 600,
    });

    const result = await materializeProjectV2Asset(
      "workspace-alpha",
      "b".repeat(64),
      "materialize-alpha",
    );

    expect(result?.token).toBe(token);
    expect(projectV2MediaUrl(token)).toBe(`gamebook-media://asset/${token}`);
    expect(() => projectV2MediaUrl("../asset.png")).toThrow("Invalid project media token.");
    expect(invoke).toHaveBeenCalledWith("materialize_project_v2_asset", {
      workspaceId: "workspace-alpha",
      digest: "b".repeat(64),
      operationId: "materialize-alpha",
    });
  });
});
