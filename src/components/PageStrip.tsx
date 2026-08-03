import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { EditorPage } from "../types/projectV2";

interface PageStripProps {
  pages: EditorPage[];
  activePageId: string | null;
  onSelect: (pageId: string) => void;
  onRemove: (pageId: string) => void;
  onDuplicate: (pageId: string) => void;
  onReorder: (sourcePageId: string, targetPageId: string) => void;
}

export function PageStrip({
  pages,
  activePageId,
  onSelect,
  onRemove,
  onDuplicate,
  onReorder,
}: PageStripProps) {
  const [draggedPageId, setDraggedPageId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const draggedIndex = pages.findIndex((page) => page.id === draggedPageId);

  function handleDragStart(event: DragStartEvent) {
    setDraggedPageId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    const source = String(event.active.id);
    const target = event.over ? String(event.over.id) : null;
    setDraggedPageId(null);
    if (target && source !== target) onReorder(source, target);
  }

  return (
    <nav className="page-strip" aria-label="Gamebook pages">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragCancel={() => setDraggedPageId(null)}
        onDragEnd={handleDragEnd}
      >
        <div className="page-strip-scroll">
          <SortableContext
            items={pages.map((page) => page.id)}
            strategy={horizontalListSortingStrategy}
          >
            {pages.map((page, index) => (
              <SortablePage
                key={page.id}
                page={page}
                index={index}
                active={page.id === activePageId}
                onSelect={onSelect}
                onRemove={onRemove}
              />
            ))}
          </SortableContext>
          {activePageId && (
            <button
              type="button"
              className="add-page"
              data-tooltip="New page from this screenshot"
              data-tooltip-side="top"
              aria-label="New clean page from current screenshot"
              onClick={() => onDuplicate(activePageId)}
            >
              <Plus />
            </button>
          )}
        </div>
        <DragOverlay dropAnimation={{ duration: 170, easing: "ease-out" }}>
          {draggedPageId && draggedIndex >= 0 ? (
            <PagePreview page={pages[draggedIndex]} index={draggedIndex} />
          ) : null}
        </DragOverlay>
      </DndContext>
      <div className="page-count">{pages.length} {pages.length === 1 ? "page" : "pages"}</div>
    </nav>
  );
}

function SortablePage({
  page,
  index,
  active,
  onSelect,
  onRemove,
}: {
  page: EditorPage;
  index: number;
  active: boolean;
  onSelect: (pageId: string) => void;
  onRemove: (pageId: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: page.id });

  return (
    <div
      ref={setNodeRef}
      className={[
        "page-tab",
        active ? "is-active" : "",
        isDragging ? "is-dragging" : "",
      ].filter(Boolean).join(" ")}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <button
        type="button"
        className="page-drag-handle"
        data-tooltip={`Reorder page ${index + 1}`}
        data-tooltip-side="top"
        aria-label={`Reorder page ${index + 1}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical />
      </button>
      <button
        type="button"
        className="page-select"
        data-tooltip={`Open page ${index + 1}`}
        data-tooltip-side="top"
        onClick={() => onSelect(page.id)}
      >
        {page.thumbnailUrl ?? page.sourceUrl ? (
          <img
            src={page.thumbnailUrl ?? page.sourceUrl ?? undefined}
            alt=""
            draggable={false}
            decoding="async"
            loading="lazy"
          />
        ) : (
          <span className="page-thumbnail-placeholder" aria-hidden="true" />
        )}
        <span>{index + 1}</span>
      </button>
      <button
        type="button"
        className="remove-page"
        data-tooltip={`Delete page ${index + 1}`}
        data-tooltip-side="top"
        aria-label={`Delete page ${index + 1}`}
        onClick={() => onRemove(page.id)}
      >
        <Trash2 />
      </button>
    </div>
  );
}

function PagePreview({ page, index }: { page: EditorPage; index: number }) {
  return (
    <div className="page-tab drag-overlay is-active" aria-hidden="true">
      <span className="page-drag-handle"><GripVertical /></span>
      <span className="page-select">
        {page.thumbnailUrl ?? page.sourceUrl ? (
          <img
            src={page.thumbnailUrl ?? page.sourceUrl ?? undefined}
            alt=""
            draggable={false}
            decoding="async"
          />
        ) : (
          <span className="page-thumbnail-placeholder" aria-hidden="true" />
        )}
        <span>{index + 1}</span>
      </span>
    </div>
  );
}
