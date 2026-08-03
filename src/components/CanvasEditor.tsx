import {
  Canvas,
  Circle,
  Ellipse,
  FabricImage,
  FabricObject,
  PencilBrush,
  Point,
  Polygon,
  Rect,
  Textbox,
  util,
  type TPointerEventInfo,
} from "fabric";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  attachTextInputContainer,
  applyPageBackground,
  composePage,
  createCropExtraction,
  enlivenPageAnnotations,
  extractText,
  getScreenshotObject,
  isAnnotationObject,
  normalizeAnnotationObject,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  renderPageToDataUrl,
  snapshotAnnotations,
  snapshotMediaPlacement,
  tagObject,
  type TaggedObject,
} from "../lib/canvasPage";
import {
  Connector,
  detachBindingsForObject,
  getObjectAnchors,
  snapConnectorEndpoint,
  syncConnectorBindings,
} from "../lib/Connector";
import { NoteTextbox } from "../lib/NoteTextbox";
import { MediaPlacement } from "../lib/MediaPlacement";
import {
  KEYBOARD_PAN_PIXELS,
  PointerPanSession,
  ViewportController,
  resolveArrowIntent,
  viewportStateLabel,
  type ViewportState,
} from "../lib/viewportController";
import type {
  AnnotationSnapshot,
  ToolId,
} from "../types/session";
import type {
  EditorPage,
  EditorPageContentPatch,
  MediaPlacementRecord,
} from "../types/projectV2";
import { TextFormatBar, type TextFormatAction } from "./TextFormatBar";
import {
  PageOutline,
  type OutlineAnnotation,
} from "./PageOutline";
import { ViewportControls } from "./ViewportControls";
import {
  ObjectStyleBar,
  type SelectionStyle,
} from "./ObjectStyleBar";

export interface CanvasEditorHandle {
  exportCurrent: (multiplier?: number) => string | null;
  renderPage: (page: EditorPage, multiplier?: number) => Promise<string>;
  undo: () => void;
  redo: () => void;
  deleteSelection: () => void;
  isTextEditing: () => boolean;
  flush: () => EditorPageContentPatch | null;
}

interface CanvasEditorProps {
  page: EditorPage;
  tool: ToolId;
  color: string;
  strokeWidth: number;
  onToolChange: (tool: ToolId) => void;
  onPageChange: (pageId: string, patch: EditorPageContentPatch) => void;
  onClose: () => void;
  onError: (message: string) => void;
}

interface DrawState {
  start: Point;
  preview: FabricObject | null;
  tool: ToolId;
  cropSource?: FabricImage;
}

interface EditorSnapshot {
  annotations: AnnotationSnapshot;
  placement: MediaPlacementRecord;
}

interface FormatBarState {
  left: number;
  top: number;
  placement: "above" | "below";
  fontSize: number;
}

const NOTE_WIDTH = 340;
const NOTE_HEIGHT = 150;

export const CanvasEditor = forwardRef<CanvasEditorHandle, CanvasEditorProps>(
  function CanvasEditor(
    {
      page,
      tool,
      color,
      strokeWidth,
      onToolChange,
      onPageChange,
      onClose,
      onError,
    },
    ref,
  ) {
    const elementRef = useRef<HTMLCanvasElement>(null);
    const viewportRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<Canvas | null>(null);
    const pageRef = useRef(page);
    const toolRef = useRef(tool);
    const colorRef = useRef(color);
    const widthRef = useRef(strokeWidth);
    const drawRef = useRef<DrawState | null>(null);
    const drawFrameRef = useRef<number | null>(null);
    const pendingDrawPointRef = useRef<Point | null>(null);
    const suspendedRef = useRef(false);
    const preserveEditingRef = useRef(false);
    const commitIdleRef = useRef<number | null>(null);
    const pendingSnapshotRef = useRef<EditorSnapshot | null>(null);
    const textCheckpointTimerRef = useRef<number | null>(null);
    const toolbarFrameRef = useRef<number | null>(null);
    const historyRef = useRef<EditorSnapshot[]>([]);
    const historySerializedRef = useRef<string[]>([]);
    const historyIndexRef = useRef(-1);
    const viewportControllerRef = useRef<ViewportController | null>(null);
    const panSessionRef = useRef(new PointerPanSession());
    const spacePressedRef = useRef(false);
    const bulletHandlersRef = useRef(
      new WeakMap<Textbox, { textarea: HTMLTextAreaElement; handler: EventListener }>(),
    );
    const textHistoryRef = useRef(new WeakMap<Textbox, string>());
    const [viewportState, setViewportState] = useState<ViewportState>({
      mode: "fit",
      zoom: 1,
      zoomPercent: 100,
      transform: [1, 0, 0, 1, 0, 0],
      sceneCenterX: PAGE_WIDTH / 2,
      sceneCenterY: PAGE_HEIGHT / 2,
    });
    const [outlinePlacement, setOutlinePlacement] = useState(page.placement);
    const [outlineAnnotations, setOutlineAnnotations] = useState<OutlineAnnotation[]>([]);
    const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
    const [formatBar, setFormatBar] = useState<FormatBarState | null>(null);
    const [selectionStyle, setSelectionStyle] = useState<SelectionStyle | null>(
      null,
    );

    pageRef.current = page;
    toolRef.current = tool;
    colorRef.current = color;
    widthRef.current = strokeWidth;

    function captureSnapshot(canvas: Canvas): EditorSnapshot {
      return {
        annotations: snapshotAnnotations(canvas),
        placement: snapshotMediaPlacement(canvas, pageRef.current.placement),
      };
    }

    function refreshOutline(canvas: Canvas) {
      setOutlinePlacement(snapshotMediaPlacement(canvas, pageRef.current.placement));
      setOutlineAnnotations(
        canvas
          .getObjects()
          .filter(isAnnotationObject)
          .flatMap((object, index) => {
            const data = (object as TaggedObject).data;
            if (!data?.id) return [];
            const text = object instanceof Textbox ? object.text.trim() : "";
            return [
              {
                id: data.id,
                kind: data.kind ?? object.type.toLowerCase(),
                label: text || `${data.kind ?? "Annotation"} ${index + 1}`,
              },
            ];
          }),
      );
    }

    function collectPagePatch(
      snapshot?: EditorSnapshot,
    ): EditorPageContentPatch | null {
      const canvas = canvasRef.current;
      if (!canvas || suspendedRef.current) return null;
      const currentSnapshot = snapshot ?? captureSnapshot(canvas);
      return {
        annotations: currentSnapshot.annotations,
        placement: currentSnapshot.placement,
        thumbnailUrl: canvasToLogicalPageDataUrl(canvas, {
          format: "jpeg",
          quality: 0.62,
          multiplier: 0.12,
        }),
        extractedText: extractText(canvas),
        backgroundColor: pageRef.current.backgroundColor,
      };
    }

    function cancelCommit() {
      if (commitIdleRef.current === null) return;
      window.cancelIdleCallback(commitIdleRef.current);
      commitIdleRef.current = null;
    }

    function commitPage(snapshot = pendingSnapshotRef.current) {
      if (!canvasRef.current || suspendedRef.current) return;
      if (snapshot) pendingSnapshotRef.current = snapshot;
      cancelCommit();
      commitIdleRef.current = window.requestIdleCallback(() => {
        commitIdleRef.current = null;
        const committedSnapshot = pendingSnapshotRef.current;
        const patch = collectPagePatch(committedSnapshot ?? undefined);
        if (patch) onPageChange(pageRef.current.id, patch);
        pendingSnapshotRef.current = null;
      }, { timeout: 1200 });
    }

    function checkpoint() {
      const canvas = canvasRef.current;
      if (!canvas || suspendedRef.current) return;
      const snapshot = captureSnapshot(canvas);
      refreshOutline(canvas);
      const serialized = JSON.stringify(snapshot);
      const currentSerialized = historySerializedRef.current[historyIndexRef.current];
      if (currentSerialized === serialized) {
        commitPage(snapshot);
        return;
      }
      historyRef.current = historyRef.current.slice(0, historyIndexRef.current + 1);
      historySerializedRef.current = historySerializedRef.current.slice(
        0,
        historyIndexRef.current + 1,
      );
      historyRef.current.push(snapshot);
      historySerializedRef.current.push(serialized);
      if (historyRef.current.length > 60) {
        historyRef.current.shift();
        historySerializedRef.current.shift();
      }
      historyIndexRef.current = historyRef.current.length - 1;
      commitPage(snapshot);
    }

    function scheduleTextCheckpoint() {
      cancelCommit();
      if (textCheckpointTimerRef.current) {
        window.clearTimeout(textCheckpointTimerRef.current);
      }
      textCheckpointTimerRef.current = window.setTimeout(() => {
        textCheckpointTimerRef.current = null;
        checkpoint();
      }, 320);
    }

    function flushTextCheckpoint() {
      if (textCheckpointTimerRef.current === null) return;
      window.clearTimeout(textCheckpointTimerRef.current);
      textCheckpointTimerRef.current = null;
      checkpoint();
    }

    async function restoreSnapshot(snapshot: EditorSnapshot) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      suspendedRef.current = true;
      canvas.getObjects().filter(isAnnotationObject).forEach((object) => canvas.remove(object));
      const screenshot = getScreenshotObject(canvas);
      if (screenshot instanceof MediaPlacement) {
        screenshot.applyPlacementRecord(snapshot.placement);
      }
      const sourceUrl = pageRef.current.sourceUrl;
      if (!sourceUrl) throw new Error("The screenshot asset is not materialized.");
      const objects = await enlivenPageAnnotations(snapshot.annotations, sourceUrl);
      objects.forEach((enlivenedObject) => {
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
      canvas.discardActiveObject();
      canvas.requestRenderAll();
      suspendedRef.current = false;
      setFormatBar(null);
      setSelectedObjectId(null);
      refreshOutline(canvas);
      commitPage();
    }

    function undo() {
      if (historyIndexRef.current <= 0) return;
      historyIndexRef.current -= 1;
      void restoreSnapshot(historyRef.current[historyIndexRef.current]);
    }

    function redo() {
      if (historyIndexRef.current >= historyRef.current.length - 1) return;
      historyIndexRef.current += 1;
      void restoreSnapshot(historyRef.current[historyIndexRef.current]);
    }

    function deleteSelection() {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const active = canvas.getActiveObjects().filter(isAnnotationObject);
      if (!active.length) return;
      suspendedRef.current = true;
      active.forEach((object) => {
        const objectId = (object as TaggedObject).data?.id;
        if (objectId) detachBindingsForObject(canvas, objectId);
        canvas.remove(object);
      });
      suspendedRef.current = false;
      canvas.discardActiveObject();
      syncConnectorBindings(canvas);
      canvas.requestRenderAll();
      setFormatBar(null);
      checkpoint();
    }

    function queueToolbarUpdate() {
      if (toolbarFrameRef.current) cancelAnimationFrame(toolbarFrameRef.current);
      toolbarFrameRef.current = requestAnimationFrame(updateFloatingToolbar);
    }

    function updateFloatingToolbar() {
      toolbarFrameRef.current = null;
      const canvas = canvasRef.current;
      const viewport = viewportRef.current;
      const active = canvas?.getActiveObject();
      if (
        !canvas ||
        !viewport ||
        !(active instanceof Textbox) ||
        !active.isEditing
      ) {
        setFormatBar(null);
        return;
      }

      const canvasRect = canvas.upperCanvasEl.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      const bounds = active.getBoundingRect();
      const transform = canvas.viewportTransform;
      const displayScale = transform[0];
      const relativeLeft = canvasRect.left - viewportRect.left;
      const relativeTop = canvasRect.top - viewportRect.top;
      const halfToolbarWidth = 188;
      const center = clamp(
        relativeLeft + transform[4] + (bounds.left + bounds.width / 2) * displayScale,
        halfToolbarWidth + 8,
        viewport.clientWidth - halfToolbarWidth - 8,
      );
      const above = relativeTop + transform[5] + bounds.top * displayScale - 10;
      const below =
        relativeTop +
        transform[5] +
        (bounds.top + bounds.height) * displayScale +
        10;
      const placement = above >= 48 || below > viewport.clientHeight - 48 ? "above" : "below";
      setFormatBar({
        left: center,
        top: placement === "above" ? above : below,
        placement,
        fontSize: getActiveFontSize(active),
      });
    }

    function configureBulletContinuation(text: Textbox) {
      const textarea = text.hiddenTextarea;
      if (!textarea) return;
      const existing = bulletHandlersRef.current.get(text);
      if (existing?.textarea === textarea) return;
      if (existing) existing.textarea.removeEventListener("beforeinput", existing.handler, true);

      const handler: EventListener = (rawEvent) => {
        const event = rawEvent as InputEvent;
        if (
          !text.isEditing ||
          (event.inputType !== "insertLineBreak" &&
            event.inputType !== "insertParagraph")
        ) {
          return;
        }
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const value = textarea.value;
        const lineStart = value.lastIndexOf("\n", start - 1) + 1;
        const lineEndIndex = value.indexOf("\n", start);
        const lineEnd = lineEndIndex === -1 ? value.length : lineEndIndex;
        const lineBeforeCursor = value.slice(lineStart, start);
        const match = lineBeforeCursor.match(/^(\s*)\u2022\s(.*)$/);
        if (!match) return;

        event.preventDefault();
        event.stopImmediatePropagation();
        let nextValue: string;
        let nextCursor: number;
        if (!match[2].trim() && start === lineEnd) {
          nextValue = value.slice(0, lineStart) + value.slice(start);
          nextCursor = lineStart;
        } else {
          const insert = `\n${match[1]}\u2022 `;
          nextValue = value.slice(0, start) + insert + value.slice(end);
          nextCursor = start + insert.length;
        }
        textarea.value = nextValue;
        textarea.setSelectionRange(nextCursor, nextCursor);
        (
          text as Textbox & { hiddenTextarea: HTMLTextAreaElement }
        ).onInput(new Event("input"));
        queueToolbarUpdate();
      };
      textarea.addEventListener("beforeinput", handler, true);
      bulletHandlersRef.current.set(text, { textarea, handler });
      textHistoryRef.current.set(text, text.text);
    }

    function focusTextEditor(text: Textbox) {
      requestAnimationFrame(() => {
        if (!text.canvas || !text.isEditing) return;
        text.hiddenTextarea?.focus({ preventScroll: true });
        text.initDelayedCursor();
        text.renderCursorOrSelection();
        text.canvas.requestRenderAll();
        queueToolbarUpdate();
      });
    }

    function normalizeListInput(text: Textbox) {
      const previous = textHistoryRef.current.get(text);
      const current = text.text;
      if (previous === undefined) {
        textHistoryRef.current.set(text, current);
        return;
      }

      let prefix = 0;
      while (
        prefix < previous.length &&
        prefix < current.length &&
        previous[prefix] === current[prefix]
      ) {
        prefix += 1;
      }
      let suffix = 0;
      while (
        suffix < previous.length - prefix &&
        suffix < current.length - prefix &&
        previous[previous.length - suffix - 1] === current[current.length - suffix - 1]
      ) {
        suffix += 1;
      }
      const inserted = current.slice(prefix, current.length - suffix);
      if (inserted !== "\n") {
        textHistoryRef.current.set(text, current);
        return;
      }

      const cursor = text.selectionStart;
      const previousLineEnd = cursor - 1;
      const previousLineStart = current.lastIndexOf("\n", previousLineEnd - 1) + 1;
      const previousLine = current.slice(previousLineStart, previousLineEnd);
      const match = previousLine.match(/^(\s*)\u2022\s(.*)$/);
      if (!match) {
        textHistoryRef.current.set(text, current);
        return;
      }

      if (match[2].trim()) {
        const marker = `${match[1]}\u2022 `;
        text.insertChars(marker, undefined, cursor);
        text.selectionStart = cursor + marker.length;
        text.selectionEnd = text.selectionStart;
      } else {
        text.removeChars(previousLineStart, cursor);
        text.selectionStart = previousLineStart;
        text.selectionEnd = previousLineStart;
      }
      text.initDimensions();
      text.setCoords();
      if (text.hiddenTextarea) text.hiddenTextarea.value = text.text;
      text._updateTextarea();
      textHistoryRef.current.set(text, text.text);
    }

    useImperativeHandle(ref, () => ({
      exportCurrent: (multiplier = 2) =>
        canvasRef.current
          ? canvasToLogicalPageDataUrl(canvasRef.current, {
              format: "png",
              multiplier,
            })
          : null,
      renderPage: renderPageToDataUrl,
      undo,
      redo,
      deleteSelection,
      isTextEditing: () => {
        const active = canvasRef.current?.getActiveObject();
        return active instanceof Textbox && active.isEditing;
      },
      flush: () => {
        flushTextCheckpoint();
        cancelCommit();
        const patch = collectPagePatch();
        if (patch) onPageChange(pageRef.current.id, patch);
        pendingSnapshotRef.current = null;
        return patch;
      },
    }));

    useEffect(() => {
      const element = elementRef.current;
      if (!element) return;
      const canvas = new Canvas(element, {
        width: PAGE_WIDTH,
        height: PAGE_HEIGHT,
        renderOnAddRemove: false,
        preserveObjectStacking: true,
        selectionColor: "rgba(30, 122, 108, .12)",
        selectionBorderColor: "#1e7a6c",
      });
      canvasRef.current = canvas;
      const viewport = viewportRef.current;
      const viewportSize = {
        width: Math.max(1, viewport?.clientWidth ?? PAGE_WIDTH),
        height: Math.max(1, viewport?.clientHeight ?? PAGE_HEIGHT),
      };
      canvas.setDimensions(viewportSize);
      viewportControllerRef.current = new ViewportController(
        canvas,
        viewportSize,
        setViewportState,
      );

      const brush = new PencilBrush(canvas);
      brush.color = colorRef.current;
      brush.width = widthRef.current;
      canvas.freeDrawingBrush = brush;

      const updateSelection = () => {
        const active = canvas.getActiveObject() as TaggedObject | undefined;
        setSelectedObjectId(active?.data?.id ?? null);
        queueToolbarUpdate();
        setSelectionStyle(readSelectionStyle(canvas));
        refreshAnchorGuides(canvas);
        canvas.requestRenderAll();
      };
      const onObjectModified = (event: { target?: FabricObject }) => {
        if (event.target instanceof NoteTextbox) {
          event.target.boxHeight = Math.max(64, event.target.height);
        }
        syncConnectorBindings(canvas, event.target);
        refreshAnchorGuides(canvas);
        setSelectionStyle(readSelectionStyle(canvas));
        queueToolbarUpdate();
        canvas.requestRenderAll();
        refreshOutline(canvas);
        checkpoint();
      };
      const onObjectResizing = (event: { target?: FabricObject }) => {
        cancelCommit();
        if (event.target instanceof NoteTextbox) {
          event.target.boxHeight = Math.max(64, event.target.height);
        }
        syncConnectorBindings(canvas, event.target);
      };
      const onObjectMoving = (event: { target?: FabricObject }) => {
        cancelCommit();
        keepObjectOnPage(event.target);
        syncConnectorBindings(canvas, event.target);
      };
      const onObjectTransforming = (event: { target?: FabricObject }) => {
        cancelCommit();
        syncConnectorBindings(canvas, event.target);
      };
      const onPathCreated = (event: { path?: FabricObject }) => {
        if (!event.path) return;
        tagObject(event.path, { role: "annotation", kind: "pen" });
        canvas.setActiveObject(event.path);
        preserveEditingRef.current = true;
        toolRef.current = "select";
        onToolChange("select");
        canvas.requestRenderAll();
        checkpoint();
      };
      const onTextChanged = (event: { target?: FabricObject }) => {
        if (event.target instanceof Textbox) normalizeListInput(event.target);
        canvas.requestRenderAll();
        queueToolbarUpdate();
        scheduleTextCheckpoint();
      };
      const onEditingEntered = (event: { target?: FabricObject }) => {
        if (event.target instanceof Textbox) {
          configureBulletContinuation(event.target);
          focusTextEditor(event.target);
        }
        queueToolbarUpdate();
      };
      const onEditingExited = () => {
        setFormatBar(null);
        flushTextCheckpoint();
      };
      const onMouseDoubleClick = (event: TPointerEventInfo) => {
        if (!(event.target instanceof NoteTextbox)) return;
        canvas.setActiveObject(event.target);
        if (!event.target.isEditing) event.target.enterEditing(event.e);
        focusTextEditor(event.target);
      };

      canvas.on("selection:created", updateSelection);
      canvas.on("selection:updated", updateSelection);
      canvas.on("selection:cleared", updateSelection);
      canvas.on("object:modified", onObjectModified);
      canvas.on("object:moving", onObjectMoving);
      canvas.on("object:scaling", onObjectTransforming);
      canvas.on("object:rotating", onObjectTransforming);
      canvas.on("object:resizing", onObjectResizing);
      canvas.on("path:created", onPathCreated);
      canvas.on("text:changed", onTextChanged);
      canvas.on("text:selection:changed", updateSelection);
      canvas.on("text:editing:entered", onEditingEntered);
      canvas.on("text:editing:exited", onEditingExited);
      canvas.on("mouse:dblclick", onMouseDoubleClick);

      const onMouseDown = (event: TPointerEventInfo) => {
        cancelCommit();
        if (
          "button" in event.e &&
          panSessionRef.current.start(
            event.e.button,
            spacePressedRef.current,
            new Point(event.e.clientX, event.e.clientY),
          )
        ) {
          event.e.preventDefault();
          return;
        }
        const activeTool = toolRef.current;
        if (activeTool === "select" || activeTool === "pen") return;
        const point = canvas.getScenePoint(event.e);
        canvas.discardActiveObject();
        setFormatBar(null);
        if (activeTool === "crop") {
          const screenshot = getScreenshotObject(canvas);
          if (!screenshot) return;
          const local = sceneToImageLocal(screenshot, point);
          if (!isInsideImage(screenshot, local)) return;
          drawRef.current = {
            start: clampImageLocal(screenshot, local),
            preview: null,
            tool: activeTool,
            cropSource: screenshot,
          };
          return;
        }
        drawRef.current = { start: point, preview: null, tool: activeTool };
        if (isConnectorTool(activeTool)) refreshAnchorGuides(canvas, true);
      };

      const onMouseMove = (event: TPointerEventInfo) => {
        if (panSessionRef.current.active) {
          if (!("clientX" in event.e)) return;
          const delta = panSessionRef.current.move(
            new Point(event.e.clientX, event.e.clientY),
          );
          if (delta) viewportControllerRef.current?.panContentBy(delta.x, delta.y);
          return;
        }
        const drawing = drawRef.current;
        if (!drawing) return;
        pendingDrawPointRef.current = canvas.getScenePoint(event.e);
        if (drawFrameRef.current !== null) return;
        drawFrameRef.current = requestAnimationFrame(() => {
          drawFrameRef.current = null;
          const currentDrawing = drawRef.current;
          const point = pendingDrawPointRef.current;
          if (!currentDrawing || !point) return;
          updateDrawingPreview(
            canvas,
            currentDrawing,
            point,
            colorRef.current,
            widthRef.current,
          );
        });
      };

      const onMouseUp = (event: TPointerEventInfo) => {
        if (panSessionRef.current.active) {
          panSessionRef.current.end();
          return;
        }
        const drawing = drawRef.current;
        if (!drawing) {
          if (pendingSnapshotRef.current) commitPage();
          return;
        }
        if (drawFrameRef.current !== null) {
          cancelAnimationFrame(drawFrameRef.current);
          drawFrameRef.current = null;
        }
        pendingDrawPointRef.current = null;
        const sceneEnd = canvas.getScenePoint(event.e);
        drawRef.current = null;
        if (drawing.preview) canvas.remove(drawing.preview);

        if (drawing.tool === "crop" && drawing.cropSource) {
          const end = clampImageLocal(
            drawing.cropSource,
            sceneToImageLocal(drawing.cropSource, sceneEnd),
          );
          const sourceScale = drawing.cropSource.getObjectScaling();
          const displayWidth = Math.abs(end.x - drawing.start.x) * sourceScale.x;
          const displayHeight = Math.abs(end.y - drawing.start.y) * sourceScale.y;
          if (displayWidth < 12 || displayHeight < 12) {
            canvas.requestRenderAll();
            return;
          }
          try {
            const extraction = createCropFromSelection(
              drawing.cropSource,
              drawing.start,
              end,
            );
            placeCropExtraction(extraction, drawing.cropSource);
            canvas.add(extraction);
            canvas.setActiveObject(extraction);
            keepObjectOnPage(extraction);
            extraction.setCoords();
            preserveEditingRef.current = true;
            toolRef.current = "select";
            onToolChange("select");
            canvas.requestRenderAll();
            checkpoint();
          } catch (error) {
            onError(`Could not create crop: ${String(error)}`);
          }
          return;
        }

        const end = sceneEnd;

        const moved = Math.hypot(end.x - drawing.start.x, end.y - drawing.start.y);
        if (drawing.tool === "text") {
          if (moved < 12) {
            canvas.requestRenderAll();
            return;
          }
          const bounds = dragBounds(drawing.start, end, 120, 72);
          addNote(canvas, bounds, colorRef.current);
          preserveEditingRef.current = true;
          toolRef.current = "select";
          onToolChange("select");
          checkpoint();
          return;
        }

        if (moved < 4) {
          canvas.requestRenderAll();
          return;
        }
        const shape = createShape(
          drawing.tool,
          drawing.start,
          end,
          colorRef.current,
          widthRef.current,
        );
        if (shape) {
          canvas.add(shape);
          if (shape instanceof Connector) {
            snapConnectorEndpoint(canvas, shape, "start", drawing.start);
            snapConnectorEndpoint(canvas, shape, "end", end);
          }
          canvas.setActiveObject(shape);
        }
        if (drawing.tool === "callout") {
          const note = addNote(
            canvas,
            {
              left: clamp(end.x + 20, 24, PAGE_WIDTH - NOTE_WIDTH - 24),
              top: clamp(
                end.y - NOTE_HEIGHT / 2,
                82,
                PAGE_HEIGHT - NOTE_HEIGHT - 24,
              ),
              width: NOTE_WIDTH,
              height: NOTE_HEIGHT,
            },
            colorRef.current,
          );
          if (shape instanceof Connector) {
            note.setCoords();
            snapConnectorEndpoint(canvas, shape, "end", end);
            syncConnectorBindings(canvas);
          }
          preserveEditingRef.current = true;
          toolRef.current = "select";
          onToolChange("select");
        } else if (shape) {
          preserveEditingRef.current = true;
          toolRef.current = "select";
          onToolChange("select");
        }
        refreshAnchorGuides(canvas);
        canvas.requestRenderAll();
        checkpoint();
      };

      canvas.on("mouse:down", onMouseDown);
      canvas.on("mouse:move", onMouseMove);
      canvas.on("mouse:up", onMouseUp);

      const resizeObserver = new ResizeObserver(() => {
        const currentViewport = viewportRef.current;
        if (!currentViewport) return;
        const size = {
          width: Math.max(1, currentViewport.clientWidth),
          height: Math.max(1, currentViewport.clientHeight),
        };
        canvas.setDimensions(size);
        viewportControllerRef.current?.resize(size);
        canvas.calcOffset();
        queueToolbarUpdate();
      });
      if (viewportRef.current) resizeObserver.observe(viewportRef.current);

      return () => {
        cancelCommit();
        if (textCheckpointTimerRef.current) {
          window.clearTimeout(textCheckpointTimerRef.current);
        }
        if (drawFrameRef.current !== null) {
          cancelAnimationFrame(drawFrameRef.current);
        }
        if (toolbarFrameRef.current) cancelAnimationFrame(toolbarFrameRef.current);
        resizeObserver.disconnect();
        viewportControllerRef.current = null;
        panSessionRef.current.end();
        canvas.dispose();
        canvasRef.current = null;
      };
    }, []);

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      suspendedRef.current = true;
      canvas.clear();
      setFormatBar(null);
      setSelectionStyle(null);
      const controller = new AbortController();
      void composePage(canvas, page, controller.signal)
        .then(() => {
          if (controller.signal.aborted) return;
          suspendedRef.current = false;
          const initialSnapshot = captureSnapshot(canvas);
          historyRef.current = [initialSnapshot];
          historySerializedRef.current = [JSON.stringify(initialSnapshot)];
          historyIndexRef.current = 0;
          refreshOutline(canvas);
          setOutlinePlacement(page.placement);
          setSelectedObjectId(null);
          viewportControllerRef.current?.fit();
          canvas.requestRenderAll();
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) {
            suspendedRef.current = false;
            onError(`Could not load page: ${String(error)}`);
          }
        });
      return () => controller.abort();
    }, [page.id]);

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      applyPageBackground(canvas, page.backgroundColor);
    }, [page.backgroundColor]);

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.isDrawingMode = tool === "pen";
      canvas.selection = tool === "select";
      canvas.skipTargetFind = tool !== "select";
      canvas.defaultCursor = tool === "select" ? "default" : "crosshair";
      const interruptedDrawing = drawRef.current;
      if (interruptedDrawing?.preview) canvas.remove(interruptedDrawing.preview);
      if (drawFrameRef.current !== null) {
        cancelAnimationFrame(drawFrameRef.current);
        drawFrameRef.current = null;
      }
      pendingDrawPointRef.current = null;
      drawRef.current = null;

      if (preserveEditingRef.current) {
        preserveEditingRef.current = false;
      } else {
        const active = canvas.getActiveObject();
        if (active instanceof Textbox && active.isEditing) active.exitEditing();
        canvas.discardActiveObject();
        setFormatBar(null);
      }
      refreshAnchorGuides(canvas, isConnectorTool(tool));
      canvas.requestRenderAll();
    }, [tool]);

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas?.freeDrawingBrush) return;
      canvas.freeDrawingBrush.color = color;
      const selected = canvas.getActiveObjects().filter(isAnnotationObject);
      if (!selected.length) return;
      suspendedRef.current = true;
      selected.forEach((object) => {
        if (object instanceof NoteTextbox) {
          object.set({ fill: color });
          object.boxBorderColor = color;
          object.dirty = true;
        } else {
          object.set({ stroke: color, dirty: true });
        }
        object.setCoords();
        syncConnectorBindings(canvas, object);
      });
      suspendedRef.current = false;
      canvas.requestRenderAll();
      setSelectionStyle(readSelectionStyle(canvas));
      checkpoint();
    }, [color]);

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas?.freeDrawingBrush) return;
      canvas.freeDrawingBrush.width = strokeWidth;
      const selected = canvas.getActiveObjects().filter(isAnnotationObject);
      if (!selected.length) return;
      suspendedRef.current = true;
      selected.forEach((object) => {
        if (object instanceof NoteTextbox) {
          object.boxBorderWidth = strokeWidth;
          object.dirty = true;
        } else {
          object.set({ strokeWidth, dirty: true });
        }
        object.setCoords();
        syncConnectorBindings(canvas, object);
      });
      suspendedRef.current = false;
      canvas.requestRenderAll();
      setSelectionStyle(readSelectionStyle(canvas));
      checkpoint();
    }, [strokeWidth]);

    useEffect(() => {
      const onKeyDown = (event: KeyboardEvent) => {
        const target = event.target as HTMLElement;
        if (target.matches("input, textarea, [contenteditable='true']")) return;
        const canvas = canvasRef.current;
        const active = canvas?.getActiveObject();
        if (event.code === "Space") {
          spacePressedRef.current = true;
          event.preventDefault();
          return;
        }
        const arrowIntent = resolveArrowIntent(event.key, {
          spacePressed: spacePressedRef.current,
          shiftPressed: event.shiftKey,
        });
        if (arrowIntent && canvas) {
          event.preventDefault();
          if (arrowIntent.kind === "pan") {
            viewportControllerRef.current?.panViewBy(
              arrowIntent.dx,
              arrowIntent.dy,
            );
          } else if (active && !(active instanceof Textbox && active.isEditing)) {
            active.set({
              left: active.left + arrowIntent.dx,
              top: active.top + arrowIntent.dy,
            });
            keepObjectOnPage(active);
            active.setCoords();
            syncConnectorBindings(canvas, active);
            canvas.requestRenderAll();
            checkpoint();
          }
          return;
        }
        if (event.key === "Escape") {
          if (active instanceof Textbox && active.isEditing) {
            active.exitEditing();
            canvas?.requestRenderAll();
            queueToolbarUpdate();
          } else {
            onClose();
          }
        } else if (active instanceof Textbox && active.isEditing) {
          return;
        } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
          event.preventDefault();
          event.shiftKey ? redo() : undo();
        } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
          event.preventDefault();
          redo();
        } else if (event.key === "Delete" || event.key === "Backspace") {
          event.preventDefault();
          deleteSelection();
        }
      };
      const onKeyUp = (event: KeyboardEvent) => {
        if (event.code === "Space") spacePressedRef.current = false;
      };
      const onBlur = () => {
        spacePressedRef.current = false;
        panSessionRef.current.end();
      };
      window.addEventListener("keydown", onKeyDown);
      window.addEventListener("keyup", onKeyUp);
      window.addEventListener("blur", onBlur);
      return () => {
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("keyup", onKeyUp);
        window.removeEventListener("blur", onBlur);
      };
    }, [onClose]);

    function formatText(action: TextFormatAction) {
      const canvas = canvasRef.current;
      const text = canvas?.getActiveObject();
      if (!canvas || !(text instanceof Textbox)) return;

      if (action === "bullet") {
        toggleBullets(text);
        textHistoryRef.current.set(text, text.text);
      } else if (action.startsWith("align-")) {
        text.set({ textAlign: action.slice(6) as "left" | "center" | "right" });
      } else {
        const style =
          action === "bold"
            ? {
                fontWeight:
                  getActiveTextStyle(text, "fontWeight") === "bold"
                    ? "normal"
                    : "bold",
              }
            : action === "italic"
              ? {
                  fontStyle:
                    getActiveTextStyle(text, "fontStyle") === "italic"
                      ? "normal"
                      : "italic",
                }
              : { underline: !getActiveTextStyle(text, "underline") };
        applyTextStyle(text, style);
      }
      text.initDimensions();
      text.setCoords();
      canvas.requestRenderAll();
      queueToolbarUpdate();
      checkpoint();
    }

    function changeFontSize(fontSize: number) {
      const canvas = canvasRef.current;
      const text = canvas?.getActiveObject();
      if (!canvas || !(text instanceof Textbox)) return;
      applyTextStyle(text, { fontSize: clamp(Math.round(fontSize), 8, 144) });
      text.initDimensions();
      text.setCoords();
      canvas.requestRenderAll();
      queueToolbarUpdate();
      checkpoint();
    }

    function changeSelectedAppearance(
      property: "stroke" | "fill" | "width" | "radius" | "transparent",
      value?: string | number,
    ) {
      const canvas = canvasRef.current;
      const object = canvas?.getActiveObject();
      if (!canvas || !object || !isAnnotationObject(object)) return;
      suspendedRef.current = true;
      if (object instanceof NoteTextbox) {
        if (property === "stroke") object.boxBorderColor = String(value);
        if (property === "fill") object.backgroundColor = String(value);
        if (property === "width") object.boxBorderWidth = Number(value);
        if (property === "radius") object.boxCornerRadius = Number(value);
        if (property === "transparent") object.backgroundColor = "";
      } else {
        if (property === "stroke") object.set({ stroke: String(value) });
        if (property === "fill") object.set({ fill: String(value) });
        if (property === "width") object.set({ strokeWidth: Number(value) });
        if (property === "radius" && object instanceof Rect) {
          object.set({ rx: Number(value), ry: Number(value) });
        }
        if (property === "transparent") object.set({ fill: "rgba(0,0,0,0)" });
      }
      object.dirty = true;
      object.setCoords();
      suspendedRef.current = false;
      syncConnectorBindings(canvas, object);
      canvas.requestRenderAll();
      setSelectionStyle(readSelectionStyle(canvas));
      checkpoint();
    }

    function selectOutlineObject(id: string) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const object = canvas
        .getObjects()
        .find((candidate) => (candidate as TaggedObject).data?.id === id);
      if (!object) return;
      canvas.setActiveObject(object);
      setSelectedObjectId(id);
      canvas.requestRenderAll();
    }

    function changeOutlinePlacement(patch: Partial<MediaPlacementRecord>) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const placement = getScreenshotObject(canvas);
      if (!(placement instanceof MediaPlacement)) return;
      try {
        placement.applyPlacementRecord({
          ...placement.toPlacementRecord(),
          ...patch,
        });
        keepObjectOnPage(placement);
        syncConnectorBindings(canvas, placement);
        canvas.requestRenderAll();
        refreshOutline(canvas);
        checkpoint();
      } catch (error) {
        onError(String(error));
      }
    }

    function setZoom(percent: number) {
      try {
        viewportControllerRef.current?.setZoomPercent(percent);
        queueToolbarUpdate();
      } catch (error) {
        onError(String(error));
      }
    }

    return (
      <div className="canvas-editor-layout">
        <div className="editor-viewport" ref={viewportRef}>
          {formatBar && (
            <TextFormatBar
              left={formatBar.left}
              top={formatBar.top}
              placement={formatBar.placement}
              fontSize={formatBar.fontSize}
              onFormat={formatText}
              onFontSizeChange={changeFontSize}
            />
          )}
          {selectionStyle && (
            <ObjectStyleBar
              style={selectionStyle}
              onStrokeColorChange={(value) =>
                changeSelectedAppearance("stroke", value)
              }
              onFillColorChange={(value) =>
                changeSelectedAppearance("fill", value)
              }
              onTransparent={() => changeSelectedAppearance("transparent")}
              onBorderWidthChange={(value) =>
                changeSelectedAppearance("width", value)
              }
              onCornerRadiusChange={(value) =>
                changeSelectedAppearance("radius", value)
              }
            />
          )}
          <div className="canvas-scaled-frame">
            <canvas ref={elementRef} />
          </div>
          <ViewportControls
            state={viewportState}
            onFit={() => viewportControllerRef.current?.fit()}
            onReset={() => viewportControllerRef.current?.reset()}
            onZoom={setZoom}
            onPan={(dx, dy) =>
              viewportControllerRef.current?.panViewBy(
                dx * KEYBOARD_PAN_PIXELS,
                dy * KEYBOARD_PAN_PIXELS,
              )
            }
          />
          <div className="sr-only" role="status" aria-live="polite">
            {viewportStateLabel(viewportState)}
          </div>
        </div>
        <PageOutline
          placement={outlinePlacement}
          placementLabel={`Screenshot on page ${page.title}`}
          annotations={outlineAnnotations}
          selectedId={selectedObjectId}
          onSelect={selectOutlineObject}
          onPlacementChange={changeOutlinePlacement}
        />
      </div>
    );
  },
);

function canvasToLogicalPageDataUrl(
  canvas: Canvas,
  options: {
    format: "png" | "jpeg";
    quality?: number;
    multiplier: number;
  },
): string {
  const width = canvas.getWidth();
  const height = canvas.getHeight();
  const transform = [...canvas.viewportTransform] as [number, number, number, number, number, number];
  try {
    canvas.setDimensions({ width: PAGE_WIDTH, height: PAGE_HEIGHT });
    canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
    canvas.requestRenderAll();
    return canvas.toDataURL(options);
  } finally {
    canvas.setDimensions({ width, height });
    canvas.setViewportTransform(transform);
    canvas.calcOffset();
    canvas.requestRenderAll();
  }
}

function updateDrawingPreview(
  canvas: Canvas,
  drawing: DrawState,
  scenePoint: Point,
  color: string,
  strokeWidth: number,
): void {
  if (drawing.tool === "crop" && drawing.cropSource) {
    if (drawing.preview) canvas.remove(drawing.preview);
    const end = clampImageLocal(
      drawing.cropSource,
      sceneToImageLocal(drawing.cropSource, scenePoint),
    );
    drawing.preview = createCropPreview(drawing.cropSource, drawing.start, end);
    drawing.preview.set({ selectable: false, evented: false, opacity: 0.72 });
    canvas.add(drawing.preview);
    canvas.requestRenderAll();
    return;
  }

  if (!drawing.preview) {
    drawing.preview =
      drawing.tool === "text"
        ? createTextPreview(drawing.start, scenePoint, color)
        : createShape(drawing.tool, drawing.start, scenePoint, color, strokeWidth);
    if (!drawing.preview) return;
    drawing.preview.set({
      selectable: false,
      evented: false,
      opacity: 0.72,
      objectCaching: false,
    });
    canvas.add(drawing.preview);
  } else if (drawing.preview instanceof Connector) {
    drawing.preview.setSceneEndpoints(drawing.start, scenePoint);
  } else {
    const left = Math.min(drawing.start.x, scenePoint.x);
    const top = Math.min(drawing.start.y, scenePoint.y);
    const width = Math.max(2, Math.abs(scenePoint.x - drawing.start.x));
    const height = Math.max(2, Math.abs(scenePoint.y - drawing.start.y));
    if (drawing.preview instanceof Ellipse) {
      drawing.preview.set({ left, top, rx: width / 2, ry: height / 2 });
    } else if (drawing.preview instanceof Rect) {
      drawing.preview.set({ left, top, width, height });
    }
    drawing.preview.dirty = true;
    drawing.preview.setCoords();
  }
  canvas.requestRenderAll();
}

function createShape(
  tool: ToolId,
  start: Point,
  end: Point,
  color: string,
  strokeWidth: number,
): FabricObject | null {
  const common = {
    stroke: color,
    strokeWidth,
    fill: "rgba(0,0,0,0)",
    strokeUniform: true,
    opacity: 0.95,
    cornerColor: "#ffffff",
    cornerStrokeColor: "#1e7a6c",
    borderColor: "#1e7a6c",
    transparentCorners: false,
  };
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const width = Math.max(2, Math.abs(end.x - start.x));
  const height = Math.max(2, Math.abs(end.y - start.y));

  if (tool === "line") {
    return tagObject(
      new Connector([start.x, start.y, end.x, end.y], common),
      { role: "annotation", kind: "line", connector: {} },
    );
  }
  if (tool === "box") {
    return tagObject(
      new Rect({
        left,
        top,
        width,
        height,
        originX: "left",
        originY: "top",
        ...common,
      }),
      { role: "annotation", kind: "box" },
    );
  }
  if (tool === "circle") {
    return tagObject(
      new Ellipse({
        left,
        top,
        rx: width / 2,
        ry: height / 2,
        originX: "left",
        originY: "top",
        ...common,
      }),
      { role: "annotation", kind: "circle" },
    );
  }
  if (tool === "arrow" || tool === "callout") {
    return tagObject(
      new Connector([start.x, start.y, end.x, end.y], common),
      { role: "annotation", kind: tool, connector: {} },
    );
  }
  return null;
}

function createTextPreview(start: Point, end: Point, accent: string): Rect {
  const bounds = dragBounds(start, end, 2, 2);
  return new Rect({
    ...bounds,
    originX: "left",
    originY: "top",
    fill: "rgba(255,255,255,.78)",
    stroke: accent,
    strokeWidth: 2,
    strokeDashArray: [10, 7],
    strokeUniform: true,
  });
}

function sceneToImageLocal(image: FabricImage, point: Point): Point {
  return point.transform(util.invertTransform(image.calcTransformMatrix()));
}

function clampImageLocal(image: FabricImage, point: Point): Point {
  return new Point(
    clamp(point.x, -image.width / 2, image.width / 2),
    clamp(point.y, -image.height / 2, image.height / 2),
  );
}

function isInsideImage(image: FabricImage, point: Point): boolean {
  return (
    point.x >= -image.width / 2 &&
    point.x <= image.width / 2 &&
    point.y >= -image.height / 2 &&
    point.y <= image.height / 2
  );
}

function createCropPreview(
  source: FabricImage,
  start: Point,
  end: Point,
): Polygon {
  const bounds = localSelectionBounds(start, end);
  const matrix = source.calcTransformMatrix();
  const points = [
    new Point(bounds.left, bounds.top),
    new Point(bounds.right, bounds.top),
    new Point(bounds.right, bounds.bottom),
    new Point(bounds.left, bounds.bottom),
  ].map((point) => point.transform(matrix));
  return new Polygon(points, {
    fill: "rgba(30, 122, 108, .13)",
    stroke: "#1e7a6c",
    strokeWidth: 3,
    strokeDashArray: [12, 8],
    strokeUniform: true,
    objectCaching: false,
    excludeFromExport: true,
  });
}

function createCropFromSelection(
  source: FabricImage,
  start: Point,
  end: Point,
): FabricImage {
  const bounds = localSelectionBounds(start, end);
  return createCropExtraction(source, {
    x: bounds.left + source.width / 2,
    y: bounds.top + source.height / 2,
    width: bounds.width,
    height: bounds.height,
  });
}

function placeCropExtraction(crop: FabricImage, source: FabricImage): void {
  const cropCenter = new Point(
    crop.cropX + crop.width / 2 - source.width / 2,
    crop.cropY + crop.height / 2 - source.height / 2,
  ).transform(source.calcTransformMatrix());
  crop.set({
    left: cropCenter.x,
    top: cropCenter.y,
    angle: source.angle,
    scaleX: Math.abs(source.scaleX),
    scaleY: Math.abs(source.scaleY),
    flipX: source.flipX,
    flipY: source.flipY,
  });
  crop.setCoords();

  const initial = crop.getBoundingRect();
  const fitScale = Math.min(1, 580 / initial.width, 480 / initial.height);
  if (fitScale < 1) {
    crop.set({
      scaleX: crop.scaleX * fitScale,
      scaleY: crop.scaleY * fitScale,
    });
    crop.setCoords();
  }

  const sourceBounds = source.getBoundingRect();
  const cropBounds = crop.getBoundingRect();
  const margin = 24;
  const gap = 32;
  const candidates = [
    {
      left: sourceBounds.left + sourceBounds.width + gap,
      top: clamp(sourceBounds.top, margin, PAGE_HEIGHT - cropBounds.height - margin),
    },
    {
      left: clamp(sourceBounds.left, margin, PAGE_WIDTH - cropBounds.width - margin),
      top: sourceBounds.top + sourceBounds.height + gap,
    },
    {
      left: sourceBounds.left - cropBounds.width - gap,
      top: clamp(sourceBounds.top, margin, PAGE_HEIGHT - cropBounds.height - margin),
    },
    {
      left: clamp(sourceBounds.left, margin, PAGE_WIDTH - cropBounds.width - margin),
      top: sourceBounds.top - cropBounds.height - gap,
    },
  ];
  const placement = candidates.find(
    ({ left, top }) =>
      left >= margin &&
      top >= margin &&
      left + cropBounds.width <= PAGE_WIDTH - margin &&
      top + cropBounds.height <= PAGE_HEIGHT - margin,
  ) ?? {
    left: clamp(
      sourceBounds.left + sourceBounds.width + gap,
      margin,
      PAGE_WIDTH - cropBounds.width - margin,
    ),
    top: clamp(
      sourceBounds.top,
      margin,
      PAGE_HEIGHT - cropBounds.height - margin,
    ),
  };
  crop.set({
    left: crop.left + placement.left - cropBounds.left,
    top: crop.top + placement.top - cropBounds.top,
  });
  crop.setCoords();
}

function localSelectionBounds(start: Point, end: Point) {
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const right = Math.max(start.x, end.x);
  const bottom = Math.max(start.y, end.y);
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

function addNote(
  canvas: Canvas,
  bounds: { left: number; top: number; width: number; height: number },
  accent: string,
): NoteTextbox {
  const note = tagObject(
    new NoteTextbox("", {
      left: bounds.left,
      top: bounds.top,
      originX: "left",
      originY: "top",
      width: bounds.width,
      boxHeight: bounds.height,
      minWidth: 120,
      fontFamily: "Segoe UI, sans-serif",
      fontSize: 26,
      lineHeight: 1.28,
      fill: "#202328",
      backgroundColor: "#fffdf3",
      boxBorderColor: accent,
      boxBorderWidth: 2,
      boxCornerRadius: 0,
      contentPadding: 16,
      padding: 4,
      borderColor: accent,
      cornerColor: "#ffffff",
      cornerStrokeColor: accent,
      transparentCorners: false,
      editingBorderColor: accent,
      splitByGrapheme: false,
      hiddenTextareaContainer: canvas.upperCanvasEl.parentElement,
    }),
    { role: "annotation", kind: "note" },
  );
  canvas.add(note);
  canvas.setActiveObject(note);
  note.enterEditing();
  note.selectionStart = 0;
  note.selectionEnd = 0;
  requestAnimationFrame(() => {
    if (!note.isEditing) return;
    note.hiddenTextarea?.focus({ preventScroll: true });
    note.initDelayedCursor();
    note.renderCursorOrSelection();
    canvas.requestRenderAll();
  });
  canvas.requestRenderAll();
  return note;
}

function dragBounds(
  start: Point,
  end: Point,
  minimumWidth: number,
  minimumHeight: number,
) {
  const directionX = end.x >= start.x ? 1 : -1;
  const directionY = end.y >= start.y ? 1 : -1;
  const width = Math.max(minimumWidth, Math.abs(end.x - start.x));
  const height = Math.max(minimumHeight, Math.abs(end.y - start.y));
  return {
    left: clamp(directionX > 0 ? start.x : start.x - width, 12, PAGE_WIDTH - width - 12),
    top: clamp(directionY > 0 ? start.y : start.y - height, 72, PAGE_HEIGHT - height - 12),
    width,
    height,
  };
}

function keepObjectOnPage(target?: FabricObject): void {
  if (!target) return;
  const bounds = target.getBoundingRect();
  let deltaX = 0;
  let deltaY = 0;
  if (bounds.width <= PAGE_WIDTH - 24) {
    if (bounds.left < 12) deltaX = 12 - bounds.left;
    if (bounds.left + bounds.width > PAGE_WIDTH - 12) {
      deltaX = PAGE_WIDTH - 12 - bounds.left - bounds.width;
    }
  }
  if (bounds.height <= PAGE_HEIGHT - 24) {
    if (bounds.top < 12) deltaY = 12 - bounds.top;
    if (bounds.top + bounds.height > PAGE_HEIGHT - 12) {
      deltaY = PAGE_HEIGHT - 12 - bounds.top - bounds.height;
    }
  }
  if (deltaX || deltaY) {
    target.set({ left: target.left + deltaX, top: target.top + deltaY });
    target.setCoords();
  }
}

function getActiveTextStyle(
  text: Textbox,
  property: "fontWeight" | "fontStyle" | "underline",
): unknown {
  if (text.isEditing) {
    const end = Math.max(text.selectionEnd, text.selectionStart + 1);
    const selection = text.getSelectionStyles(text.selectionStart, end, true)[0];
    if (selection && property in selection) return selection[property];
  }
  return text[property];
}

function getActiveFontSize(text: Textbox): number {
  const value = text.isEditing
    ? text.getSelectionStyles(
        text.selectionStart,
        Math.max(text.selectionEnd, text.selectionStart + 1),
        true,
      )[0]?.fontSize
    : undefined;
  return Math.round(Number(value ?? text.fontSize ?? 26));
}

function applyTextStyle(text: Textbox, style: Record<string, unknown>): void {
  if (text.isEditing && text.selectionStart !== text.selectionEnd) {
    text.setSelectionStyles(style);
  } else {
    text.set(style);
  }
}

function toggleBullets(text: Textbox): void {
  const originalText = text.text;
  const originalStart = text.selectionStart;
  const originalEnd = text.selectionEnd;
  const lines = originalText.split("\n");
  const originalLines = [...lines];
  const startLine = offsetToLine(originalText, originalStart);
  const endLine = offsetToLine(
    originalText,
    originalEnd > originalStart ? originalEnd - 1 : originalEnd,
  );
  const selected = lines.slice(startLine, endLine + 1);
  const allBulleted = selected.every((line) => /^(\s*)\u2022\s/.test(line));
  for (let index = startLine; index <= endLine; index += 1) {
    if (allBulleted) {
      lines[index] = lines[index].replace(/^(\s*)\u2022\s/, "$1");
    } else if (!/^(\s*)\u2022\s/.test(lines[index])) {
      lines[index] = `${lines[index].match(/^\s*/)?.[0] ?? ""}\u2022 ${lines[index].trimStart()}`;
    }
  }
  text.set({ text: lines.join("\n") });
  if (originalStart === originalEnd) {
    const originalLineStart = lineOffset(originalLines, startLine);
    const indentation = originalLines[startLine].match(/^\s*/)?.[0].length ?? 0;
    const markerPosition = originalLineStart + indentation;
    const delta = allBulleted && originalStart > markerPosition ? -2 : allBulleted ? 0 : 2;
    const cursor = clamp(originalStart + delta, lineOffset(lines, startLine), lineOffset(lines, startLine) + lines[startLine].length);
    text.selectionStart = cursor;
    text.selectionEnd = cursor;
  } else {
    text.selectionStart = lineOffset(lines, startLine);
    text.selectionEnd = lineOffset(lines, endLine) + lines[endLine].length;
  }
  text.initDimensions();
  if (text.hiddenTextarea) text.hiddenTextarea.value = text.text;
  text._updateTextarea();
}

function offsetToLine(value: string, offset: number): number {
  return value.slice(0, Math.max(0, offset)).split("\n").length - 1;
}

function lineOffset(lines: string[], lineIndex: number): number {
  return lines.slice(0, lineIndex).reduce((total, line) => total + line.length + 1, 0);
}

function readSelectionStyle(canvas: Canvas): SelectionStyle | null {
  const object = canvas.getActiveObject();
  if (!object || !isAnnotationObject(object)) return null;
  const kind = (object as TaggedObject).data?.kind ?? "object";
  if (object instanceof NoteTextbox) {
    return {
      kind: "Text box",
      strokeColor: object.boxBorderColor || "#a9adb2",
      fillColor: object.backgroundColor || "#ffffff",
      borderWidth: object.boxBorderWidth,
      cornerRadius: Math.round(object.boxCornerRadius || 0),
      canFill: true,
      canRound: true,
      transparent: isTransparentColor(object.backgroundColor),
    };
  }
  const canFill = object instanceof Rect || object instanceof Ellipse;
  const fillColor = typeof object.fill === "string" ? object.fill : "#ffffff";
  return {
    kind,
    strokeColor: typeof object.stroke === "string" ? object.stroke : "#202328",
    fillColor: isTransparentColor(fillColor) ? "#ffffff" : fillColor,
    borderWidth: Math.round(object.strokeWidth ?? 0),
    cornerRadius: object instanceof Rect ? Math.round(object.rx ?? 0) : 0,
    canFill,
    canRound: object instanceof Rect,
    transparent: canFill && isTransparentColor(fillColor),
  };
}

function isTransparentColor(value: string | null | undefined): boolean {
  return (
    !value ||
    value === "transparent" ||
    value === "rgba(0,0,0,0)" ||
    value === "rgba(0, 0, 0, 0)"
  );
}

function isConnectorTool(tool: ToolId): boolean {
  return tool === "line" || tool === "arrow" || tool === "callout";
}

function refreshAnchorGuides(canvas: Canvas, force = false): void {
  canvas
    .getObjects()
    .filter(
      (object) =>
        (object as TaggedObject).data?.role === "system" &&
        (object as TaggedObject).data?.kind === "anchor-guide",
    )
    .forEach((object) => canvas.remove(object));

  const active = canvas.getActiveObject();
  if (!force && !(active instanceof Connector)) return;
  const zoom = Math.max(canvas.getZoom(), 0.1);
  const radius = 5.5 / zoom;
  canvas.getObjects().forEach((object) => {
    const data = (object as TaggedObject).data;
    if (
      object instanceof Connector ||
      data?.role === "system" ||
      !data?.id
    ) {
      return;
    }
    getObjectAnchors(object).forEach(({ point }) => {
      canvas.add(
        tagObject(
          new Circle({
            left: point.x,
            top: point.y,
            originX: "center",
            originY: "center",
            radius,
            fill: "#ffffff",
            stroke: "#1e7a6c",
            strokeWidth: 2 / zoom,
            selectable: false,
            evented: false,
            excludeFromExport: true,
            objectCaching: false,
          }),
          { role: "system", kind: "anchor-guide" },
        ),
      );
    });
  });
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
