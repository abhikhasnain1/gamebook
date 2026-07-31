import {
  Control,
  FabricObject,
  Line,
  Point,
  classRegistry,
  util,
  type Canvas,
  type Abortable,
  type FabricObjectProps,
  type SerializedObjectProps,
  type StaticCanvas,
  type TMat2D,
  type TOptions,
  type Transform,
} from "fabric";

export type AnchorName = "top" | "right" | "bottom" | "left";
export type ConnectorEnd = "start" | "end";

export interface AnchorBinding {
  objectId: string;
  anchor: AnchorName;
}

export interface ConnectorBindings {
  start?: AnchorBinding;
  end?: AnchorBinding;
}

interface ConnectorData {
  role?: "system" | "screenshot" | "annotation";
  kind?: string;
  id?: string;
  connector?: ConnectorBindings;
}

type ConnectableObject = FabricObject & { data?: ConnectorData };

function distanceToSegment(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }

  const projection = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared),
  );
  const nearestX = start.x + projection * dx;
  const nearestY = start.y + projection * dy;

  return Math.hypot(point.x - nearestX, point.y - nearestY);
}

interface SerializedConnectorProps extends SerializedObjectProps {
  connectorVersion: 2;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export class Connector extends FabricObject {
  static override type = "Connector";

  x1 = 0;
  y1 = 0;
  x2 = 0;
  y2 = 0;

  constructor(
    points: [number, number, number, number] = [0, 0, 0, 0],
    options: Partial<FabricObjectProps> = {},
  ) {
    super({
      ...options,
      originX: "center",
      originY: "center",
      hasBorders: false,
      lockScalingX: true,
      lockScalingY: true,
      lockRotation: true,
      objectCaching: false,
      noScaleCache: true,
      cornerStyle: "circle",
      cornerSize: 15,
      touchCornerSize: 28,
      cornerColor: "#ffffff",
      cornerStrokeColor: "#1e7a6c",
      transparentCorners: false,
      padding: 9,
    });
    this.setSceneEndpoints(
      new Point(points[0], points[1]),
      new Point(points[2], points[3]),
    );
  }

  static override createControls(): { controls: Record<string, Control> } {
    return {
      controls: {
        start: endpointControl("start"),
        end: endpointControl("end"),
      },
    };
  }

  override _render(ctx: CanvasRenderingContext2D): void {
    const data = (this as ConnectableObject).data;
    const dx = this.x2 - this.x1;
    const dy = this.y2 - this.y1;
    const distance = Math.hypot(dx, dy);
    if (distance < 0.01) return;

    const unitX = dx / distance;
    const unitY = dy / distance;
    const strokeWidth = Math.max(1, this.strokeWidth);
    const color = typeof this.stroke === "string" ? this.stroke : "#ef4444";
    const hasArrowhead = data?.kind !== "line";
    const naturalHeadLength = 15 + strokeWidth * 1.6;
    const headLength = hasArrowhead
      ? Math.min(naturalHeadLength, distance * 0.55)
      : 0;
    const halfWidth = Math.min(
      6 + strokeWidth * 0.7,
      Math.max(strokeWidth, headLength * 0.58),
    );
    const overlap = Math.min(strokeWidth * 0.45, headLength * 0.18);
    const shaftEndX = hasArrowhead
      ? this.x2 - unitX * Math.max(0, headLength - overlap)
      : this.x2;
    const shaftEndY = hasArrowhead
      ? this.y2 - unitY * Math.max(0, headLength - overlap)
      : this.y2;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = strokeWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.setLineDash(this.strokeDashArray ?? []);
    ctx.beginPath();
    ctx.moveTo(this.x1, this.y1);
    ctx.lineTo(shaftEndX, shaftEndY);
    ctx.stroke();

    if (!hasArrowhead) {
      ctx.restore();
      return;
    }

    const baseX = this.x2 - unitX * headLength;
    const baseY = this.y2 - unitY * headLength;
    const perpendicularX = -unitY * halfWidth;
    const perpendicularY = unitX * halfWidth;
    ctx.beginPath();
    ctx.moveTo(this.x2, this.y2);
    ctx.lineTo(baseX + perpendicularX, baseY + perpendicularY);
    ctx.lineTo(baseX - perpendicularX, baseY - perpendicularY);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  }

  setSceneEndpoints(start: Point, end: Point): void {
    const centerX = (start.x + end.x) / 2;
    const centerY = (start.y + end.y) / 2;
    this.set({
      left: centerX,
      top: centerY,
      width: Math.max(1, Math.abs(end.x - start.x)),
      height: Math.max(1, Math.abs(end.y - start.y)),
      originX: "center",
      originY: "center",
      angle: 0,
      scaleX: 1,
      scaleY: 1,
      flipX: false,
      flipY: false,
    });
    this.x1 = start.x - centerX;
    this.y1 = start.y - centerY;
    this.x2 = end.x - centerX;
    this.y2 = end.y - centerY;
    this.dirty = true;
    this.setCoords();
  }

  getSceneEndpoint(end: ConnectorEnd): Point {
    const local = end === "start"
      ? new Point(this.x1, this.y1)
      : new Point(this.x2, this.y2);
    return local.transform(this.calcTransformMatrix());
  }

  override containsPoint(point: Point): boolean {
    const start = this.getSceneEndpoint("start");
    const end = this.getSceneEndpoint("end");
    const zoom = Math.max(this.canvas?.getZoom() ?? 1, 0.1);
    const screenTolerance = Math.max(9, this.strokeWidth / 2 + 6);

    return distanceToSegment(point, start, end) <= screenTolerance / zoom;
  }

  override toObject(propertiesToInclude: any[] = []): SerializedConnectorProps {
    const start = this.getSceneEndpoint("start");
    const end = this.getSceneEndpoint("end");
    return {
      ...super.toObject(propertiesToInclude),
      connectorVersion: 2,
      x1: start.x,
      y1: start.y,
      x2: end.x,
      y2: end.y,
    } as SerializedConnectorProps;
  }

  static override fromObject<T extends TOptions<SerializedObjectProps>>(
    object: T,
    _options?: Abortable,
  ): Promise<Connector> {
    const serialized = object as T & Partial<SerializedConnectorProps>;
    if (serialized.connectorVersion !== 2) {
      const legacy = new Line(
        [serialized.x1 ?? 0, serialized.y1 ?? 0, serialized.x2 ?? 0, serialized.y2 ?? 0],
        serialized as Partial<FabricObjectProps>,
      );
      const points = legacy.calcLinePoints();
      const matrix = legacy.calcTransformMatrix();
      const start = new Point(points.x1, points.y1).transform(matrix);
      const end = new Point(points.x2, points.y2).transform(matrix);
      const {
        left: _legacyLeft,
        top: _legacyTop,
        width: _legacyWidth,
        height: _legacyHeight,
        originX: _legacyOriginX,
        originY: _legacyOriginY,
        angle: _legacyAngle,
        scaleX: _legacyScaleX,
        scaleY: _legacyScaleY,
        flipX: _legacyFlipX,
        flipY: _legacyFlipY,
        ...legacyStyle
      } = serialized;
      return Promise.resolve(
        new Connector(
          [start.x, start.y, end.x, end.y],
          legacyStyle as Partial<FabricObjectProps>,
        ),
      );
    }
    const {
      connectorVersion: _connectorVersion,
      x1 = 0,
      y1 = 0,
      x2 = 0,
      y2 = 0,
      left: _left,
      top: _top,
      width: _width,
      height: _height,
      originX: _originX,
      originY: _originY,
      angle: _angle,
      scaleX: _scaleX,
      scaleY: _scaleY,
      flipX: _flipX,
      flipY: _flipY,
      ...style
    } = serialized;
    return Promise.resolve(
      new Connector([x1, y1, x2, y2], style as Partial<FabricObjectProps>),
    );
  }
}

function endpointControl(end: ConnectorEnd): Control {
  return new Control({
    actionName: "endpoint",
    cursorStyle: "crosshair",
    positionHandler: (
      _dimensions: Point,
      _finalMatrix: TMat2D,
      object: FabricObject,
    ) => {
      const connector = object as Connector;
      const local =
        end === "start"
          ? new Point(connector.x1, connector.y1)
          : new Point(connector.x2, connector.y2);
      const viewport = object.canvas?.viewportTransform ?? [1, 0, 0, 1, 0, 0];
      return local.transform(
        util.multiplyTransformMatrices(viewport, object.calcTransformMatrix()),
      );
    },
    actionHandler: (
      _event: Event,
      transform: Transform,
      x: number,
      y: number,
    ) => {
      const connector = transform.target as Connector;
      const canvas = connector.canvas;
      const dragged = new Point(x, y);
      const snapped = canvas
        ? findNearestAnchor(canvas, dragged, connector)
        : null;
      const fixed = connector.getSceneEndpoint(end === "start" ? "end" : "start");
      const endpoint = snapped?.point ?? dragged;
      if (end === "start") connector.setSceneEndpoints(endpoint, fixed);
      else connector.setSceneEndpoints(fixed, endpoint);
      setBinding(connector, end, snapped?.binding);
      canvas?.requestRenderAll();
      return true;
    },
  });
}

export function isConnector(object: FabricObject): object is Connector {
  return object instanceof Connector;
}

export function getObjectAnchors(
  object: FabricObject,
): Array<{ name: AnchorName; point: Point }> {
  const [topLeft, topRight, bottomRight, bottomLeft] = object.getCoords();
  if (!topLeft || !topRight || !bottomRight || !bottomLeft) return [];
  return [
    { name: "top", point: topLeft.midPointFrom(topRight) },
    { name: "right", point: topRight.midPointFrom(bottomRight) },
    { name: "bottom", point: bottomRight.midPointFrom(bottomLeft) },
    { name: "left", point: bottomLeft.midPointFrom(topLeft) },
  ];
}

export function findNearestAnchor(
  canvas: StaticCanvas | Canvas,
  point: Point,
  connector?: Connector,
): { point: Point; binding: AnchorBinding; target: FabricObject } | null {
  const zoom = "getZoom" in canvas ? canvas.getZoom() : 1;
  const threshold = 24 / Math.max(zoom, 0.1);
  let nearest:
    | { point: Point; binding: AnchorBinding; target: FabricObject; distance: number }
    | null = null;

  for (const object of canvas.getObjects()) {
    const data = (object as ConnectableObject).data;
    if (
      object === connector ||
      object instanceof Connector ||
      data?.role === "system" ||
      !data?.id
    ) {
      continue;
    }
    for (const anchor of getObjectAnchors(object)) {
      const distance = point.distanceFrom(anchor.point);
      if (distance <= threshold && (!nearest || distance < nearest.distance)) {
        nearest = {
          point: anchor.point,
          binding: { objectId: data.id, anchor: anchor.name },
          target: object,
          distance,
        };
      }
    }
  }
  return nearest;
}

export function snapConnectorEndpoint(
  canvas: StaticCanvas | Canvas,
  connector: Connector,
  end: ConnectorEnd,
  point = connector.getSceneEndpoint(end),
): void {
  const snapped = findNearestAnchor(canvas, point, connector);
  if (!snapped) {
    setBinding(connector, end, undefined);
    return;
  }
  const fixed = connector.getSceneEndpoint(end === "start" ? "end" : "start");
  if (end === "start") connector.setSceneEndpoints(snapped.point, fixed);
  else connector.setSceneEndpoints(fixed, snapped.point);
  setBinding(connector, end, snapped.binding);
}

export function detachBindingsForObject(
  canvas: StaticCanvas | Canvas,
  objectId: string,
): void {
  canvas.getObjects().forEach((object) => {
    if (!(object instanceof Connector)) return;
    const data = (object as ConnectableObject).data;
    if (data?.connector?.start?.objectId === objectId) {
      delete data.connector.start;
    }
    if (data?.connector?.end?.objectId === objectId) {
      delete data.connector.end;
    }
  });
}

export function syncConnectorBindings(
  canvas: StaticCanvas | Canvas,
  changedObject?: FabricObject,
): void {
  const objects = canvas.getObjects();
  const changedData = changedObject && (changedObject as ConnectableObject).data;
  if (changedObject && !(changedObject instanceof Connector) && changedData?.id) {
    const changedId = changedData.id;
    const anchors = new Map(
      getObjectAnchors(changedObject).map(({ name, point }) => [name, point]),
    );
    objects.forEach((object) => {
      if (!(object instanceof Connector)) return;
      const bindings = (object as ConnectableObject).data?.connector;
      if (!bindings) return;
      const startBinding = bindings.start;
      const endBinding = bindings.end;
      let start = object.getSceneEndpoint("start");
      let end = object.getSceneEndpoint("end");
      let changed = false;
      if (startBinding && startBinding.objectId === changedId) {
        start = anchors.get(startBinding.anchor) ?? start;
        changed = true;
      }
      if (endBinding && endBinding.objectId === changedId) {
        end = anchors.get(endBinding.anchor) ?? end;
        changed = true;
      }
      if (changed) object.setSceneEndpoints(start, end);
    });
    return;
  }

  const byId = new Map<string, FabricObject>();
  objects.forEach((object) => {
    const id = (object as ConnectableObject).data?.id;
    if (id) byId.set(id, object);
  });

  const connectors = changedObject instanceof Connector ? [changedObject] : objects;
  connectors.forEach((object) => {
    if (!(object instanceof Connector)) return;
    const bindings = (object as ConnectableObject).data?.connector;
    if (!bindings?.start && !bindings?.end) return;
    let start = object.getSceneEndpoint("start");
    let end = object.getSceneEndpoint("end");
    if (bindings.start) {
      const target = byId.get(bindings.start.objectId);
      const anchor = target && getObjectAnchors(target).find(
        (candidate) => candidate.name === bindings.start?.anchor,
      );
      if (anchor) start = anchor.point;
    }
    if (bindings.end) {
      const target = byId.get(bindings.end.objectId);
      const anchor = target && getObjectAnchors(target).find(
        (candidate) => candidate.name === bindings.end?.anchor,
      );
      if (anchor) end = anchor.point;
    }
    object.setSceneEndpoints(start, end);
  });
}

function setBinding(
  connector: Connector,
  end: ConnectorEnd,
  binding?: AnchorBinding,
): void {
  const data = ((connector as ConnectableObject).data ??= {});
  data.connector ??= {};
  if (binding) data.connector[end] = binding;
  else delete data.connector[end];
}

classRegistry.setClass(Connector);
