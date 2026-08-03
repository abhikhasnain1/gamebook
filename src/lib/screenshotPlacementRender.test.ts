import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createCanvas, loadImage } from "canvas";
import {
  FabricImage,
  FabricObject,
  Shadow,
  StaticCanvas,
  util,
  type ImageSource,
} from "fabric";
import { describe, expect, it } from "vitest";
import type { EditorPage } from "../types/projectV2";
import { parseSession, type GamebookPage } from "../types/session";
import {
  applyPageBackground,
  attachTextInputContainer,
  normalizeAnnotationObject,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  tagObject,
  type TaggedObject,
} from "./canvasPage";
import { syncConnectorBindings } from "./Connector";
import { MediaPlacement } from "./MediaPlacement";

describe("version 2 screenshot placement render compatibility", () => {
  it(
    "keeps fewer than 0.1 percent of 1600x900 pixels above a per-channel difference of 8",
    async () => {
      const fixture = readFileSync(
        "src/test/fixtures/projects/version1/basic-screenshot.gamebook.fixture",
      );
      const session = parseSession(gunzipSync(fixture).toString("utf8"));
      const legacy = session.pages[0];
      const canonical: EditorPage = {
        id: legacy.id,
        title: legacy.title,
        createdAt: legacy.createdAt,
        updatedAt: session.updatedAt,
        evidenceId: "evidence-render-fixture",
        assetDigest: "a".repeat(64),
        monitorName: legacy.monitorName,
        sourceWidth: legacy.sourceWidth,
        sourceHeight: legacy.sourceHeight,
        sourceUrl: legacy.screenshotDataUrl,
        thumbnailUrl: null,
        placement: {
          type: "MediaPlacement",
          placementVersion: 1,
          id: `screenshot-${legacy.id}`,
          evidenceId: "evidence-render-fixture",
          ...legacy.screenshotLayout,
          angle: ((legacy.screenshotLayout.angle % 360) + 360) % 360,
          zIndex: 0,
        },
        annotations: legacy.annotations,
        extractedText: legacy.extractedText,
        backgroundColor: legacy.backgroundColor,
      };

      const legacyRender = await withTimeout(
        renderLegacyPage(legacy),
        "legacy render",
      );
      const canonicalRender = await withTimeout(
        renderCanonicalPage(canonical),
        "canonical render",
      );
      const comparison = await withTimeout(
        compareRenders(legacyRender, canonicalRender, 8),
        "pixel comparison",
      );

      expect(comparison).toMatchObject({
        width: 1600,
        height: 900,
        perChannelThreshold: 8,
        pixelsOverThreshold: 0,
        pixelsOverThresholdRatio: 0,
      });
      expect(comparison.pixelsOverThresholdRatio).toBeLessThan(0.001);
    },
    30_000,
  );
});

async function renderLegacyPage(page: GamebookPage): Promise<string> {
  const canvas = new StaticCanvas(document.createElement("canvas"), {
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    renderOnAddRemove: false,
  });
  applyPageBackground(canvas, page.backgroundColor);
  const source = await loadImage(page.screenshotDataUrl);
  const screenshot = new FabricImage(source as unknown as ImageSource);
  screenshot.set({
    ...page.screenshotLayout,
    originX: "left",
    originY: "top",
    stroke: "#b9bdc2",
    strokeWidth: 2,
    strokeUniform: true,
    lockScalingFlip: true,
    cornerColor: "#ffffff",
    cornerStrokeColor: "#1e7a6c",
    borderColor: "#1e7a6c",
    transparentCorners: false,
    cornerSize: 13,
    hoverCursor: "move",
    objectCaching: false,
    shadow: new Shadow({
      color: "rgba(24, 28, 32, .24)",
      blur: 18,
      offsetY: 6,
    }),
  });
  tagObject(screenshot, {
    role: "screenshot",
    kind: "screenshot",
    id: `screenshot-${page.id}`,
  });
  canvas.add(screenshot);
  const annotations = await util.enlivenObjects<FabricObject>(page.annotations.objects);
  annotations.forEach((enlivenedObject) => {
    const object = normalizeAnnotationObject(enlivenedObject);
    const data = (object as TaggedObject).data;
    tagObject(object, {
      ...data,
      role: "annotation",
      kind: data?.kind ?? object.type.toLowerCase(),
    });
    attachTextInputContainer(canvas, object);
    canvas.add(object);
  });
  syncConnectorBindings(canvas);
  canvas.requestRenderAll();
  const result = canvas.toDataURL({ format: "png", multiplier: 1 });
  canvas.dispose();
  return result;
}

async function renderCanonicalPage(page: EditorPage): Promise<string> {
  if (!page.sourceUrl) throw new Error("Canonical source is not materialized.");
  const canvas = new StaticCanvas(document.createElement("canvas"), {
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    renderOnAddRemove: false,
  });
  applyPageBackground(canvas, page.backgroundColor);
  const source = await loadImage(page.sourceUrl);
  const screenshot = new MediaPlacement(
    page.placement,
    source as unknown as ImageSource,
  );
  tagObject(screenshot, {
    role: "screenshot",
    kind: "screenshot",
    id: page.placement.id,
  });
  canvas.add(screenshot);
  const annotations = await util.enlivenObjects<FabricObject>(
    page.annotations.objects,
  );
  annotations.forEach((enlivenedObject) => {
    const object = normalizeAnnotationObject(enlivenedObject);
    const data = (object as TaggedObject).data;
    tagObject(object, {
      ...data,
      role: "annotation",
      kind: data?.kind ?? object.type.toLowerCase(),
    });
    attachTextInputContainer(canvas, object);
    canvas.add(object);
  });
  syncConnectorBindings(canvas);
  canvas.requestRenderAll();
  const result = canvas.toDataURL({ format: "png", multiplier: 1 });
  canvas.dispose();
  return result;
}

async function compareRenders(
  before: string,
  after: string,
  perChannelThreshold: number,
) {
  const beforePixels = await pixels(before);
  const afterPixels = await pixels(after);
  if (
    beforePixels.width !== afterPixels.width ||
    beforePixels.height !== afterPixels.height
  ) {
    throw new Error("Render dimensions do not match.");
  }
  let pixelsOverThreshold = 0;
  for (let offset = 0; offset < beforePixels.data.length; offset += 4) {
    if (
      Math.abs(beforePixels.data[offset] - afterPixels.data[offset]) > perChannelThreshold ||
      Math.abs(beforePixels.data[offset + 1] - afterPixels.data[offset + 1]) > perChannelThreshold ||
      Math.abs(beforePixels.data[offset + 2] - afterPixels.data[offset + 2]) > perChannelThreshold
    ) {
      pixelsOverThreshold += 1;
    }
  }
  return {
    width: beforePixels.width,
    height: beforePixels.height,
    perChannelThreshold,
    pixelsOverThreshold,
    pixelsOverThresholdRatio:
      pixelsOverThreshold / (beforePixels.width * beforePixels.height),
  };
}

async function pixels(dataUrl: string) {
  const image = await loadImage(dataUrl);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  return {
    width: image.width,
    height: image.height,
    data: context.getImageData(0, 0, image.width, image.height).data,
  };
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} did not finish within 8 seconds.`)),
          8_000,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
