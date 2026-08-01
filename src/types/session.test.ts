import { describe, expect, it } from "vitest";
import {
  defaultScreenshotLayout,
  pageFromCapture,
  parseSession,
  type GamebookSession,
} from "./session";

const screenshotDataUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l0HzsAAAAABJRU5ErkJggg==";

function baselineSession(): GamebookSession {
  return {
    formatVersion: 1,
    id: "fixture-session-v1-basic",
    title: "Fixture Version 1 Project",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    activePageId: "fixture-page-1",
    pages: [
      {
        id: "fixture-page-1",
        title: "Legacy title",
        createdAt: "2026-08-01T00:00:00.000Z",
        monitorName: "Synthetic QA Display",
        sourceWidth: 320,
        sourceHeight: 180,
        screenshotDataUrl,
        screenshotLayout: {
          left: 144,
          top: 96,
          scaleX: 2,
          scaleY: 2,
          angle: 7,
        },
        annotations: {
          objects: [
            {
              type: "rect",
              left: 200,
              top: 120,
              width: 140,
              height: 80,
              data: { role: "annotation", kind: "box", id: "fixture-box-1" },
            },
            {
              type: "textbox",
              left: 420,
              top: 220,
              width: 240,
              height: 120,
              text: "Deterministic fixture note",
              data: { role: "annotation", kind: "note", id: "fixture-note-1" },
            },
          ],
        },
        thumbnailDataUrl: screenshotDataUrl,
        extractedText: "Deterministic fixture note",
        backgroundColor: "#f7f7f5",
      },
    ],
  };
}

describe("version 1 session compatibility", () => {
  it("preserves the screenshot baseline contract while normalizing page order", () => {
    const session = parseSession(JSON.stringify(baselineSession()));
    const page = session.pages[0];

    expect(session.formatVersion).toBe(1);
    expect(session.id).toBe("fixture-session-v1-basic");
    expect(session.activePageId).toBe("fixture-page-1");
    expect(page).toMatchObject({
      id: "fixture-page-1",
      title: "1",
      monitorName: "Synthetic QA Display",
      sourceWidth: 320,
      sourceHeight: 180,
      screenshotLayout: {
        left: 144,
        top: 96,
        scaleX: 2,
        scaleY: 2,
        angle: 7,
      },
      extractedText: "Deterministic fixture note",
      backgroundColor: "#f7f7f5",
    });
    expect(page.screenshotDataUrl).toBe(screenshotDataUrl);
    expect(page.annotations.objects.map((object) => object.data)).toEqual([
      { role: "annotation", kind: "box", id: "fixture-box-1" },
      { role: "annotation", kind: "note", id: "fixture-note-1" },
    ]);
  });

  it("backfills legacy page defaults without mutating source pixels or annotations", () => {
    const legacy = baselineSession();
    legacy.pages = legacy.pages.map((page) => {
      const { backgroundColor, screenshotLayout, ...rest } = page;
      void backgroundColor;
      void screenshotLayout;
      return rest as typeof page;
    });

    const parsed = parseSession(JSON.stringify(legacy));

    expect(parsed.pages[0].screenshotLayout).toEqual(
      defaultScreenshotLayout(320, 180),
    );
    expect(parsed.pages[0].backgroundColor).toBe("#f7f7f5");
    expect(parsed.pages[0].screenshotDataUrl).toBe(screenshotDataUrl);
    expect(parsed.pages[0].annotations.objects).toHaveLength(2);
  });

  it("creates capture pages with monitor metadata and deterministic default layout", () => {
    const page = pageFromCapture(
      {
        dataUrl: screenshotDataUrl,
        thumbnailDataUrl: "data:image/jpeg;base64,dGh1bWI=",
        capturedAt: "2026-08-01T00:00:00.000Z",
        monitorName: "Synthetic QA Display",
        width: 1920,
        height: 1080,
        monitorX: -1920,
        monitorY: 0,
      },
      3,
    );

    expect(page.title).toBe("3");
    expect(page.monitorName).toBe("Synthetic QA Display");
    expect(page.sourceWidth).toBe(1920);
    expect(page.sourceHeight).toBe(1080);
    expect(page.screenshotDataUrl).toBe(screenshotDataUrl);
    expect(page.thumbnailDataUrl).toBe("data:image/jpeg;base64,dGh1bWI=");
    expect(page.screenshotLayout).toEqual(defaultScreenshotLayout(1920, 1080));
    expect(page.annotations.objects).toEqual([]);
    expect(page.extractedText).toBe("");
  });

  it("rejects unsupported project formats before compatibility normalization", () => {
    expect(() =>
      parseSession(JSON.stringify({ formatVersion: 2, pages: [] })),
    ).toThrow("This project format is not supported.");
  });
});
