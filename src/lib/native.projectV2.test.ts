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

  it("creates an unsaved workspace and claims captures without renderer media bytes", async () => {
    const {
      claimScreenshotCapture,
      createProjectV2,
      openProjectForEditor,
      recoverProjectV2Workspace,
    } = await import("./native");
    invoke
      .mockResolvedValueOnce({
        workspaceId: "workspace-unsaved",
        projectId: "project-unsaved",
        manifest: { formatVersion: 2 },
        records: [],
      })
      .mockResolvedValueOnce({
        workspaceId: "workspace-unsaved",
        projectId: "project-unsaved",
        manifest: { formatVersion: 2 },
        records: [],
      })
      .mockResolvedValueOnce({
        token: "a".repeat(64),
        digest: "b".repeat(64),
        mimeType: "image/png",
        byteLength: 42,
        expiresAfterSeconds: 600,
      })
      .mockResolvedValueOnce({
        outcome: "repair",
        report: { mode: "read-only", sourceMutated: false },
      });

    await createProjectV2();
    await recoverProjectV2Workspace("workspace-unsaved");
    await claimScreenshotCapture("workspace-unsaved", "c".repeat(64));
    await openProjectForEditor("open-alpha");

    expect(invoke).toHaveBeenNthCalledWith(1, "create_project_v2");
    expect(invoke).toHaveBeenNthCalledWith(2, "recover_project_v2_workspace", {
      workspaceId: "workspace-unsaved",
    });
    expect(invoke).toHaveBeenNthCalledWith(3, "claim_screenshot_capture", {
      workspaceId: "workspace-unsaved",
      captureId: "c".repeat(64),
    });
    expect(invoke).toHaveBeenNthCalledWith(4, "open_project_for_editor", {
      operationId: "open-alpha",
    });
    expect(JSON.stringify(invoke.mock.calls)).not.toMatch(
      /data:image|base64|pngBytes|workspacePath|archivePath/i,
    );
  });

  it("migrates and inspects repair without accepting paths or media bytes", async () => {
    const { inspectProjectV2Repair, migrateProjectV1 } = await import("./native");
    invoke
      .mockResolvedValueOnce({
        workspaceId: "workspace-migrated",
        report: {
          recordType: "migration-report",
          sourceMutated: false,
          messages: [
            {
              code: "migration-complete",
              severity: "info",
              recordId: null,
              detail: "Migration prepared one page record.",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        recordType: "repair-report",
        mode: "read-only",
        status: "recoverable",
        sourceMutated: false,
        inventedReplacements: false,
        messages: [],
      });

    const migration = await migrateProjectV1("migration-alpha");
    const repair = await inspectProjectV2Repair();

    expect(migration?.report.sourceMutated).toBe(false);
    expect(migration?.report.messages[0]).toMatchObject({
      code: "migration-complete",
      severity: "info",
      recordId: null,
    });
    expect(repair).toMatchObject({
      mode: "read-only",
      sourceMutated: false,
      inventedReplacements: false,
    });
    expect(invoke).toHaveBeenNthCalledWith(1, "migrate_project_v1", {
      operationId: "migration-alpha",
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "inspect_project_v2_repair");
    expect(JSON.stringify(invoke.mock.calls)).not.toMatch(/base64|path|destination/i);
  });
});
