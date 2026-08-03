import {
  FabricImage,
  Shadow,
  classRegistry,
  type Abortable,
  type ImageSource,
  type SerializedImageProps,
  type TOptions,
} from "fabric";
import {
  normalizePlacement,
  type MediaPlacementRecord,
} from "../types/projectV2";

export type PlacementAnchor = "top" | "right" | "bottom" | "left";

export class MediaPlacement extends FabricImage {
  static override type = "MediaPlacement";

  readonly placementId: string;
  readonly evidenceId: string;
  zIndex: number;
  cropRecord?: MediaPlacementRecord["crop"];
  posterTimestampUs?: number;
  private readonly sourceWidth: number;
  private readonly sourceHeight: number;

  constructor(record: MediaPlacementRecord, source: ImageSource) {
    const stable = normalizePlacement(record);
    const sourceWidth = sourceWidthOf(source);
    const sourceHeight = sourceHeightOf(source);
    super(source, {
      left: stable.left,
      top: stable.top,
      scaleX: stable.scaleX,
      scaleY: stable.scaleY,
      angle: stable.angle,
      originX: "left",
      originY: "top",
      cropX: stable.crop?.x ?? 0,
      cropY: stable.crop?.y ?? 0,
      width: stable.crop?.width ?? sourceWidth,
      height: stable.crop?.height ?? sourceHeight,
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
    this.placementId = stable.id;
    this.evidenceId = stable.evidenceId;
    this.sourceWidth = sourceWidth;
    this.sourceHeight = sourceHeight;
    this.zIndex = stable.zIndex;
    this.cropRecord = stable.crop;
    this.posterTimestampUs = stable.posterTimestampUs;
  }

  applyPlacementRecord(record: MediaPlacementRecord): void {
    const stable = normalizePlacement(record);
    if (stable.id !== this.placementId || stable.evidenceId !== this.evidenceId) {
      throw new Error("Placement identity cannot change.");
    }
    this.cropRecord = stable.crop;
    this.posterTimestampUs = stable.posterTimestampUs;
    this.zIndex = stable.zIndex;
    this.set({
      left: stable.left,
      top: stable.top,
      scaleX: stable.scaleX,
      scaleY: stable.scaleY,
      angle: stable.angle,
      cropX: stable.crop?.x ?? 0,
      cropY: stable.crop?.y ?? 0,
      width: stable.crop?.width ?? this.sourceWidth,
      height: stable.crop?.height ?? this.sourceHeight,
    });
    this.setCoords();
  }

  toPlacementRecord(): MediaPlacementRecord {
    return normalizePlacement({
      type: "MediaPlacement",
      placementVersion: 1,
      id: this.placementId,
      evidenceId: this.evidenceId,
      left: this.left,
      top: this.top,
      scaleX: this.scaleX,
      scaleY: this.scaleY,
      angle: this.angle,
      crop: this.cropRecord,
      posterTimestampUs: this.posterTimestampUs,
      zIndex: this.zIndex,
    });
  }

  connectorPoint(anchor: PlacementAnchor) {
    const [topLeft, topRight, bottomRight, bottomLeft] = this.getCoords();
    if (anchor === "top") return topLeft.midPointFrom(topRight);
    if (anchor === "right") return topRight.midPointFrom(bottomRight);
    if (anchor === "bottom") return bottomRight.midPointFrom(bottomLeft);
    return bottomLeft.midPointFrom(topLeft);
  }

  override toObject(_propertiesToInclude: any[] = []): any {
    return this.toPlacementRecord();
  }

  static override fromObject<T extends TOptions<SerializedImageProps>>(
    object: T,
    _options?: Abortable,
  ): Promise<MediaPlacement> {
    const record = object as unknown as MediaPlacementRecord;
    if (record.placementVersion !== 1) {
      return Promise.reject(new Error("Unsupported MediaPlacement version"));
    }
    return Promise.resolve(new MediaPlacement(record, createEmptySurface(record)));
  }
}

export async function loadMediaPlacement(
  record: MediaPlacementRecord,
  sourceUrl: string,
  signal?: AbortSignal,
): Promise<MediaPlacement> {
  const source = await FabricImage.fromURL(sourceUrl, {
    signal,
    crossOrigin: "anonymous",
  });
  return new MediaPlacement(record, source.getElement());
}

function createEmptySurface(record: MediaPlacementRecord): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(record.crop?.width ?? 1);
  canvas.height = Math.ceil(record.crop?.height ?? 1);
  return canvas;
}

function sourceWidthOf(source: ImageSource): number {
  if (source instanceof HTMLVideoElement) return source.videoWidth;
  return "width" in source ? Number(source.width) : 1;
}

function sourceHeightOf(source: ImageSource): number {
  if (source instanceof HTMLVideoElement) return source.videoHeight;
  return "height" in source ? Number(source.height) : 1;
}

classRegistry.setClass(MediaPlacement);
