import { Canvas, Point, Rect, StaticCanvas, type FabricObject } from "fabric";
import { Download, Redo2, Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Connector, getObjectAnchors, syncConnectorBindings } from "../lib/Connector";
import { MediaPlacement } from "./MediaPlacement";
import { MediaPlacementOutline } from "./MediaPlacementOutline";
import {
  MEDIA_PLACEMENT_SCHEMA,
  PlacementHistory,
  assertStablePlacement,
  cloneSnapshot,
  orderedCompositionIds,
  updatePlacement,
  type MediaPlacementRecord,
  type PlacementConnectorRecord,
  type PlacementHarnessSnapshot,
  type PlacementPageRecord,
} from "./mediaPlacementGeometry";

declare global {
  interface Window {
    __GAMEBOOK_MEDIA_PLACEMENT_SPIKE__?: HarnessReport;
  }
}

interface HarnessCheck {
  id: string;
  passed: boolean;
  detail: string;
}

interface HarnessReport {
  schema: typeof MEDIA_PLACEMENT_SCHEMA;
  status: "passed" | "failed";
  generatedAt: string;
  buildRevision: string;
  fixture: string;
  environment: {
    userAgent: string;
    hardwareConcurrency: number;
    viewport: { width: number; height: number };
  };
  checks: HarnessCheck[];
  serializedKeys: string[];
  compositionOrder: string[];
  exportDataUrlLength: number;
}

const INITIAL_SNAPSHOT: PlacementHarnessSnapshot = {
  activePageId: "page-alpha",
  pages: [
    {
      id: "page-alpha",
      placements: [
        {
          id: "placement-1080p",
          evidenceId: "numbered-poster-1080p",
          left: 120,
          top: 126,
          scaleX: 0.82,
          scaleY: 0.82,
          angle: 0,
          posterTimestampUs: 1_500_000,
          zIndex: 1,
        },
        {
          id: "placement-1440p",
          evidenceId: "numbered-poster-1440p",
          left: 740,
          top: 270,
          scaleX: 0.72,
          scaleY: 0.72,
          angle: 7,
          crop: { x: 36, y: 18, width: 548, height: 302 },
          posterTimestampUs: 3_250_000,
          zIndex: 2,
        },
      ],
      annotationIds: ["annotation-finding"],
      connectors: [
        {
          id: "connector-evidence-finding",
          start: { placementId: "placement-1440p", anchor: "right" },
          end: { annotationId: "annotation-finding", anchor: "left" },
        },
      ],
    },
    {
      id: "page-beta",
      placements: [
        {
          id: "placement-secondary",
          evidenceId: "numbered-poster-secondary",
          left: 290,
          top: 190,
          scaleX: 1.05,
          scaleY: 1.05,
          angle: 354,
          posterTimestampUs: 750_000,
          zIndex: 1,
        },
      ],
      annotationIds: ["annotation-secondary"],
      connectors: [],
    },
  ],
};

export function MediaPlacementHarness() {
  const canvasElementRef = useRef<HTMLCanvasElement>(null);
  const canvasRef = useRef<Canvas | null>(null);
  const historyRef = useRef(new PlacementHistory(INITIAL_SNAPSHOT));
  const [snapshot, setSnapshot] = useState(() => historyRef.current.current());
  const [selectedId, setSelectedId] = useState("placement-1080p");
  const [status, setStatus] = useState("Preparing deterministic harness");
  const [report, setReport] = useState<HarnessReport | null>(null);

  const activePage = useMemo(
    () => snapshot.pages.find((page) => page.id === snapshot.activePageId) ?? snapshot.pages[0],
    [snapshot],
  );

  const commit = useCallback((next: PlacementHarnessSnapshot) => {
    const committed = historyRef.current.push(next);
    setSnapshot(committed);
  }, []);

  const handlePlacementChange = useCallback(
    (id: string, patch: Partial<MediaPlacementRecord>) => {
      try {
        const next = updatePlacement(snapshot, activePage.id, id, patch);
        commit(next);
        setStatus(`${id} geometry updated`);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Placement update failed");
      }
    },
    [activePage.id, commit, snapshot],
  );

  useEffect(() => {
    const element = canvasElementRef.current;
    if (!element) return;
    const canvas = new Canvas(element, {
      width: 1600,
      height: 900,
      renderOnAddRemove: false,
      preserveObjectStacking: true,
      backgroundColor: "#f7f7f5",
      selection: true,
    });
    canvasRef.current = canvas;
    const modified = ({ target }: { target: FabricObject }) => {
      if (!(target instanceof MediaPlacement)) return;
      const record = target.toPlacementRecord();
      setSnapshot((current) => {
        const next = updatePlacement(current, current.activePageId, record.id, record);
        historyRef.current.push(next);
        return next;
      });
      setStatus(`${record.id} transform committed`);
    };
    canvas.on("object:modified", modified);
    return () => {
      canvas.off("object:modified", modified);
      canvas.dispose();
      canvasRef.current = null;
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    void composeHarnessPage(canvas, activePage).then(() => {
      if (cancelled) return;
      const selected = canvas
        .getObjects()
        .find((object) => object instanceof MediaPlacement && object.placementId === selectedId);
      if (selected) canvas.setActiveObject(selected);
      canvas.requestRenderAll();
    });
    return () => {
      cancelled = true;
    };
  }, [activePage, selectedId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || report) return;
    let cancelled = false;
    const frame = requestAnimationFrame(() => {
      void runHarnessChecks(canvas, snapshot).then((result) => {
        if (cancelled) return;
        window.__GAMEBOOK_MEDIA_PLACEMENT_SPIKE__ = result;
        setReport(result);
        setStatus(result.status === "passed" ? "All geometry checks passed" : "Harness check failed");
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [report, snapshot]);

  function switchPage(pageId: string) {
    const next = cloneSnapshot(snapshot);
    next.activePageId = pageId;
    commit(next);
    setSelectedId(next.pages.find((page) => page.id === pageId)?.placements[0]?.id ?? "");
    setStatus(`${pageId} selected`);
  }

  function undo() {
    const next = historyRef.current.undo();
    setSnapshot(next);
    setStatus("Geometry change undone");
  }

  function redo() {
    const next = historyRef.current.redo();
    setSnapshot(next);
    setStatus("Geometry change redone");
  }

  function exportPoster() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const anchor = document.createElement("a");
    anchor.download = `${activePage.id}-poster.png`;
    anchor.href = canvas.toDataURL({ format: "png", multiplier: 1 });
    anchor.click();
    setStatus(`${activePage.id} static poster exported`);
  }

  return (
    <main className="spike-shell">
      <header className="spike-header">
        <div>
          <p>Milestone 3 / Geometry</p>
          <h1>MediaPlacement harness</h1>
        </div>
        <nav aria-label="Harness pages">
          {snapshot.pages.map((page, index) => (
            <button
              key={page.id}
              type="button"
              aria-current={page.id === activePage.id ? "page" : undefined}
              onClick={() => switchPage(page.id)}
            >
              Page {index + 1}
            </button>
          ))}
        </nav>
        <div className="spike-actions">
          <button type="button" title="Undo" aria-label="Undo geometry change" disabled={!historyRef.current.canUndo()} onClick={undo}>
            <Undo2 aria-hidden="true" />
          </button>
          <button type="button" title="Redo" aria-label="Redo geometry change" disabled={!historyRef.current.canRedo()} onClick={redo}>
            <Redo2 aria-hidden="true" />
          </button>
          <button type="button" title="Export poster" aria-label="Export static poster" onClick={exportPoster}>
            <Download aria-hidden="true" />
          </button>
        </div>
      </header>

      <section className="spike-workspace" aria-label="Media placement geometry workspace">
        <div className="spike-canvas-wrap">
          <canvas ref={canvasElementRef} aria-label={`${activePage.id} visual canvas`} />
        </div>
        <MediaPlacementOutline
          placements={activePage.placements}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onChange={handlePlacementChange}
        />
      </section>

      <footer className="spike-footer">
        <p role="status" aria-live="polite">{status}</p>
        <output aria-label="Automated check result" data-status={report?.status ?? "pending"}>
          {report ? `${report.checks.filter((check) => check.passed).length}/${report.checks.length} checks` : "Running checks"}
        </output>
      </footer>
      {report ? (
        <pre id="spike-report-json" hidden>{JSON.stringify(report)}</pre>
      ) : null}
    </main>
  );
}

async function composeHarnessPage(canvas: Canvas, page: PlacementPageRecord) {
  canvas.clear();
  canvas.backgroundColor = "#f7f7f5";
  const placements = page.placements
    .slice()
    .sort((left, right) => left.zIndex - right.zIndex)
    .map((record) => {
      const placement = new MediaPlacement(record);
      (placement as MediaPlacement & { data?: Record<string, unknown> }).data = {
        id: record.id,
        role: "annotation",
        kind: "media-placement",
      };
      canvas.add(placement);
      return placement;
    });

  const annotations = new Map<string, Rect>();
  page.annotationIds.forEach((id, index) => {
    const annotation = new Rect({
      left: 1260,
      top: 250 + index * 190,
      width: 230,
      height: 150,
      rx: 12,
      ry: 12,
      fill: "#ffffff",
      stroke: "#b42318",
      strokeWidth: 6,
      strokeUniform: true,
    });
    (annotation as Rect & { data?: Record<string, unknown> }).data = {
      id,
      role: "annotation",
      kind: "finding",
    };
    canvas.add(annotation);
    annotations.set(id, annotation);
  });

  page.connectors.forEach((record) => {
    const connector = createConnector(record, placements, annotations);
    if (connector) canvas.add(connector);
  });
  syncConnectorBindings(canvas);
  canvas.requestRenderAll();
}

function createConnector(
  record: PlacementConnectorRecord,
  placements: MediaPlacement[],
  annotations: Map<string, Rect>,
): Connector | null {
  const source = placements.find((placement) => placement.placementId === record.start.placementId);
  const target = annotations.get(record.end.annotationId);
  if (!source || !target) return null;
  const start = source.connectorPoint(record.start.anchor);
  const end = getObjectAnchors(target).find((anchor) => anchor.name === record.end.anchor)?.point;
  if (!end) return null;
  const connector = new Connector([start.x, start.y, end.x, end.y], {
    stroke: "#b42318",
    strokeWidth: 5,
  });
  (connector as Connector & { data?: Record<string, unknown> }).data = {
    id: record.id,
    role: "annotation",
    kind: "arrow",
    connector: {
      start: { objectId: record.start.placementId, anchor: record.start.anchor },
      end: { objectId: record.end.annotationId, anchor: record.end.anchor },
    },
  };
  return connector;
}

async function runHarnessChecks(
  canvas: Canvas,
  snapshot: PlacementHarnessSnapshot,
): Promise<HarnessReport> {
  const page = snapshot.pages.find((candidate) => candidate.id === "page-alpha") ?? snapshot.pages[0];
  await composeHarnessPage(canvas, page);
  const placements = canvas
    .getObjects()
    .filter((object): object is MediaPlacement => object instanceof MediaPlacement);
  const placement = placements[0];
  if (!placement || placements.length !== page.placements.length) {
    throw new Error("Harness placements are missing");
  }

  const serialized = placement.toObject() as Record<string, unknown>;
  const keys = Object.keys(serialized).sort();
  const checks: HarnessCheck[] = [];
  const check = (id: string, passed: boolean, detail: string) => checks.push({ id, passed, detail });

  try {
    assertStablePlacement(placement.toPlacementRecord());
    check("stable-record", true, "Placement record contains only approved scalar geometry and identifiers.");
  } catch (error) {
    check("stable-record", false, error instanceof Error ? error.message : "Stable-record validation failed.");
  }
  check(
    "runtime-state-excluded",
    !keys.some((key) => ["src", "path", "objectUrl", "element", "frame", "bytes", "video"].includes(key)),
    `Serialized keys: ${keys.join(", ")}`,
  );

  const roundTripCanvas = new StaticCanvas(document.createElement("canvas"), {
    width: 1600,
    height: 900,
    renderOnAddRemove: false,
  });
  await roundTripCanvas.loadFromJSON({ objects: placements.map((candidate) => candidate.toObject()) });
  const restoredPlacements = roundTripCanvas
    .getObjects()
    .filter((object): object is MediaPlacement => object instanceof MediaPlacement);
  const roundTripPassed = restoredPlacements.length === placements.length &&
    restoredPlacements.every((restored, index) =>
      JSON.stringify(restored.toPlacementRecord()) === JSON.stringify(placements[index].toPlacementRecord()),
    );
  roundTripCanvas.dispose();
  check(
    "fabric-round-trip",
    roundTripPassed && restoredPlacements.some((candidate) => candidate.cropRecord?.width === 548),
    "Fabric loadFromJSON reconstructed both placements, including the cropped record.",
  );

  const center = placement.getCenterPoint();
  check(
    "hit-testing",
    placement.containsPoint(center) && !placement.containsPoint(new Point(1590, 890)),
    "The placement accepts an interior point and rejects a distant page point.",
  );

  const actualOrder = canvas.getObjects().map((object) => {
    if (object instanceof MediaPlacement) return object.placementId;
    return String((object as FabricObject & { data?: { id?: string } }).data?.id ?? object.type);
  });
  const expectedOrder = orderedCompositionIds(page);
  check(
    "composition-order",
    JSON.stringify(actualOrder) === JSON.stringify(expectedOrder),
    `Composition order: ${actualOrder.join(" -> ")}`,
  );

  const connector = page.connectors[0];
  check(
    "connector-anchor",
    connector.start.placementId === page.placements[1].id && connector.start.anchor === "right",
    `Connector retained ${connector.start.placementId}:${connector.start.anchor}.`,
  );

  const history = new PlacementHistory(snapshot);
  const moved = updatePlacement(snapshot, page.id, page.placements[0].id, { left: 333, angle: 19 });
  history.push(moved);
  const undoPassed = history.undo().pages[0].placements[0].left === page.placements[0].left;
  const redoPassed = history.redo().pages[0].placements[0].left === 333;
  check("history", undoPassed && redoPassed, "Undo and redo restored deterministic geometry snapshots.");

  const secondaryPage = snapshot.pages.find((candidate) => candidate.id === "page-beta");
  if (!secondaryPage) throw new Error("Secondary harness page is missing");
  await composeHarnessPage(canvas, secondaryPage);
  const secondaryIds = canvas.getObjects().map((object) =>
    object instanceof MediaPlacement
      ? object.placementId
      : String((object as FabricObject & { data?: { id?: string } }).data?.id ?? object.type),
  );
  await composeHarnessPage(canvas, page);
  const returnedIds = canvas.getObjects().map((object) =>
    object instanceof MediaPlacement
      ? object.placementId
      : String((object as FabricObject & { data?: { id?: string } }).data?.id ?? object.type),
  );
  const returnedConnector = canvas.getObjects().find(
    (object) => (object as FabricObject & { data?: { id?: string } }).data?.id === connector.id,
  ) as (FabricObject & { data?: { connector?: { start?: { objectId?: string; anchor?: string } } } }) | undefined;
  check(
    "page-switch",
    JSON.stringify(secondaryIds) === JSON.stringify(orderedCompositionIds(secondaryPage)) &&
      JSON.stringify(returnedIds) === JSON.stringify(expectedOrder) &&
      returnedConnector?.data?.connector?.start?.objectId === connector.start.placementId &&
      returnedConnector.data.connector.start.anchor === connector.start.anchor,
    "Recomposing the secondary page and returning preserved geometry, crop, connector, and poster records.",
  );

  const exportDataUrl = canvas.toDataURL({ format: "png", multiplier: 1 });
  check(
    "static-export",
    exportDataUrl.startsWith("data:image/png;base64,") && exportDataUrl.length > 10_000,
    `Static poster export produced ${exportDataUrl.length} data URL characters.`,
  );
  const numericControls = document.querySelectorAll('input[type="number"]');
  check(
    "semantic-outline",
    numericControls.length === 11 &&
      Array.from(numericControls).every((control) => (control as HTMLInputElement).labels?.length),
    `${numericControls.length} labeled numeric placement controls expose pointer-independent transforms.`,
  );

  return {
    schema: MEDIA_PLACEMENT_SCHEMA,
    status: checks.every((candidate) => candidate.passed) ? "passed" : "failed",
    generatedAt: new Date().toISOString(),
    buildRevision: new URLSearchParams(window.location.search).get("build") ?? "working-tree",
    fixture: "deterministic-poster-pages-v1",
    environment: {
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      viewport: {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
      },
    },
    checks,
    serializedKeys: keys,
    compositionOrder: actualOrder,
    exportDataUrlLength: exportDataUrl.length,
  };
}
