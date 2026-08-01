import { describe, expect, it } from "vitest";
import { sessionToText } from "./exporters";
import type { GamebookSession } from "../types/session";

function exportSession(): GamebookSession {
  return {
    formatVersion: 1,
    id: "export-order-session",
    title: "Regression Export",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    activePageId: "page-b",
    pages: [
      {
        id: "page-b",
        title: "2",
        createdAt: "2026-08-01T00:00:00.000Z",
        monitorName: "Synthetic QA Display",
        sourceWidth: 1600,
        sourceHeight: 900,
        screenshotDataUrl: "data:image/png;base64,Yg==",
        screenshotLayout: { left: 68, top: 112, scaleX: 1, scaleY: 1, angle: 0 },
        annotations: { objects: [] },
        thumbnailDataUrl: "data:image/jpeg;base64,Yg==",
        extractedText: "Second page note",
        backgroundColor: "#f7f7f5",
      },
      {
        id: "page-a",
        title: "1",
        createdAt: "2026-08-01T00:00:01.000Z",
        monitorName: "Synthetic QA Display",
        sourceWidth: 1600,
        sourceHeight: 900,
        screenshotDataUrl: "data:image/png;base64,YQ==",
        screenshotLayout: { left: 68, top: 112, scaleX: 1, scaleY: 1, angle: 0 },
        annotations: { objects: [] },
        thumbnailDataUrl: "data:image/jpeg;base64,YQ==",
        extractedText: "",
        backgroundColor: "#f7f7f5",
      },
    ],
  };
}

describe("current export ordering", () => {
  it("exports text in persisted page order and keeps empty-note placeholders", () => {
    expect(sessionToText(exportSession())).toBe(
      [
        "Regression Export",
        "=================",
        "",
        "1. 2",
        "----",
        "Second page note",
        "",
        "2. 1",
        "----",
        "(No text notes)",
        "",
      ].join("\n"),
    );
  });
});
