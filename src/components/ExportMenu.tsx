import { FileImage, Files, FileText, FileType } from "lucide-react";

export type ExportKind = "png" | "pdf" | "markdown" | "text";

interface ExportMenuProps {
  open: boolean;
  onExport: (kind: ExportKind) => void;
}

export function ExportMenu({ open, onExport }: ExportMenuProps) {
  if (!open) return null;
  return (
    <div className="export-menu" role="menu">
      <button type="button" role="menuitem" data-tooltip="Export the current page as PNG" data-tooltip-side="left" onClick={() => onExport("png")}>
        <FileImage /><span><strong>PNG</strong><small>Current page</small></span>
      </button>
      <button type="button" role="menuitem" data-tooltip="Export all pages as one PDF" data-tooltip-side="left" onClick={() => onExport("pdf")}>
        <Files /><span><strong>PDF</strong><small>All pages</small></span>
      </button>
      <button type="button" role="menuitem" data-tooltip="Export notes with rendered page images" data-tooltip-side="left" onClick={() => onExport("markdown")}>
        <FileType /><span><strong>Markdown</strong><small>All pages + images</small></span>
      </button>
      <button type="button" role="menuitem" data-tooltip="Export all textbox content as plain text" data-tooltip-side="left" onClick={() => onExport("text")}>
        <FileText /><span><strong>Plain text</strong><small>All text notes</small></span>
      </button>
    </div>
  );
}
