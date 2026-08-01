import {
  FabricImage,
  classRegistry,
  type Abortable,
  type FabricObjectProps,
  type SerializedImageProps,
  type TOptions,
} from "fabric";
import {
  normalizePlacement,
  type MediaPlacementRecord,
  type PlacementAnchor,
} from "./mediaPlacementGeometry";

export interface SerializedMediaPlacement extends MediaPlacementRecord {
  type: "MediaPlacement";
  placementVersion: 1;
}

export class MediaPlacement extends FabricImage {
  static override type = "MediaPlacement";

  readonly placementId: string;
  readonly evidenceId: string;
  zIndex: number;
  cropRecord?: MediaPlacementRecord["crop"];
  posterTimestampUs?: number;

  constructor(record: MediaPlacementRecord, surface = createPosterSurface(record.evidenceId)) {
    const stable = normalizePlacement(record);
    super(surface, {
      left: stable.left,
      top: stable.top,
      scaleX: stable.scaleX,
      scaleY: stable.scaleY,
      angle: stable.angle,
      originX: "left",
      originY: "top",
      cropX: stable.crop?.x ?? 0,
      cropY: stable.crop?.y ?? 0,
      width: stable.crop?.width ?? surface.width,
      height: stable.crop?.height ?? surface.height,
      lockScalingFlip: true,
      objectCaching: false,
      perPixelTargetFind: true,
      stroke: "#111827",
      strokeWidth: 2,
      strokeUniform: true,
      cornerColor: "#ffffff",
      cornerStrokeColor: "#007f73",
      borderColor: "#007f73",
      transparentCorners: false,
    });
    this.placementId = stable.id;
    this.evidenceId = stable.evidenceId;
    this.zIndex = stable.zIndex;
    this.cropRecord = stable.crop;
    this.posterTimestampUs = stable.posterTimestampUs;
  }

  toPlacementRecord(): MediaPlacementRecord {
    return normalizePlacement({
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
    return {
      type: "MediaPlacement",
      placementVersion: 1,
      ...this.toPlacementRecord(),
    };
  }

  static override fromObject<T extends TOptions<SerializedImageProps>>(
    object: T,
    _options?: Abortable,
  ): Promise<MediaPlacement> {
    const serialized = object as unknown as SerializedMediaPlacement;
    if (serialized.placementVersion !== 1) {
      return Promise.reject(new Error("Unsupported MediaPlacement version"));
    }
    return Promise.resolve(new MediaPlacement(serialized));
  }
}

export function createPosterSurface(evidenceId: string): HTMLCanvasElement {
  const surface = document.createElement("canvas");
  surface.width = 640;
  surface.height = 360;
  const context = surface.getContext("2d");
  if (!context) throw new Error("2D canvas is unavailable");

  context.fillStyle = "#101820";
  context.fillRect(0, 0, 640, 360);
  const colors = ["#00a896", "#f4d35e", "#ee6352", "#4d7cfe"];
  colors.forEach((color, index) => {
    context.fillStyle = color;
    context.fillRect(index * 160, 0, 160, 225);
  });
  context.fillStyle = "#f8fafc";
  context.font = "700 30px system-ui";
  context.fillText("DETERMINISTIC POSTER", 32, 284);
  context.font = "22px ui-monospace";
  context.fillText(evidenceId, 32, 324);
  context.fillStyle = "#101820";
  for (let index = 0; index < 12; index += 1) {
    context.fillRect(24 + index * 50, 196 + (index % 2) * 8, 28, 28);
  }
  return surface;
}

classRegistry.setClass(MediaPlacement);

export type MediaPlacementOptions = Partial<FabricObjectProps>;
