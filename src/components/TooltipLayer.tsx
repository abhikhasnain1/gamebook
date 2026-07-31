import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type TooltipSide = "top" | "right" | "bottom" | "left";

interface TooltipState {
  anchor: HTMLElement;
  label: string;
  side: TooltipSide;
}

interface TooltipPosition {
  left: number;
  top: number;
}

export function TooltipLayer() {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [position, setPosition] = useState<TooltipPosition | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const delayRef = useRef<number | null>(null);

  const hide = useCallback(() => {
    if (delayRef.current) window.clearTimeout(delayRef.current);
    delayRef.current = null;
    setTooltip(null);
    setPosition(null);
  }, []);

  const show = useCallback((anchor: HTMLElement, immediate: boolean) => {
    const label = anchor.dataset.tooltip?.trim();
    if (!label) return;
    if (delayRef.current) window.clearTimeout(delayRef.current);
    const side = isTooltipSide(anchor.dataset.tooltipSide)
      ? anchor.dataset.tooltipSide
      : "top";
    const reveal = () => {
      setPosition(null);
      setTooltip({ anchor, label, side });
    };
    if (immediate) reveal();
    else delayRef.current = window.setTimeout(reveal, 360);
  }, []);

  useEffect(() => {
    const tooltipTarget = (target: EventTarget | null) =>
      target instanceof Element
        ? target.closest<HTMLElement>("[data-tooltip]")
        : null;

    const onPointerOver = (event: PointerEvent) => {
      const target = tooltipTarget(event.target);
      const previous = tooltipTarget(event.relatedTarget);
      if (target && target !== previous) show(target, false);
    };
    const onPointerOut = (event: PointerEvent) => {
      const target = tooltipTarget(event.target);
      const next = tooltipTarget(event.relatedTarget);
      if (target && target !== next) hide();
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = tooltipTarget(event.target);
      if (target) show(target, true);
    };
    const onFocusOut = (event: FocusEvent) => {
      const target = tooltipTarget(event.target);
      const next = tooltipTarget(event.relatedTarget);
      if (target && target !== next) hide();
    };

    document.addEventListener("pointerover", onPointerOver);
    document.addEventListener("pointerout", onPointerOut);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("keydown", hide, true);
    window.addEventListener("blur", hide);
    window.addEventListener("resize", hide);
    window.addEventListener("scroll", hide, true);
    return () => {
      document.removeEventListener("pointerover", onPointerOver);
      document.removeEventListener("pointerout", onPointerOut);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("keydown", hide, true);
      window.removeEventListener("blur", hide);
      window.removeEventListener("resize", hide);
      window.removeEventListener("scroll", hide, true);
      if (delayRef.current) window.clearTimeout(delayRef.current);
    };
  }, [hide, show]);

  useLayoutEffect(() => {
    const bubble = tooltipRef.current;
    if (!tooltip || !bubble || !tooltip.anchor.isConnected) return;
    const anchor = tooltip.anchor.getBoundingClientRect();
    const bounds = bubble.getBoundingClientRect();
    const gap = 9;
    let left = anchor.left + anchor.width / 2 - bounds.width / 2;
    let top = anchor.top - bounds.height - gap;
    if (tooltip.side === "bottom") top = anchor.bottom + gap;
    if (tooltip.side === "right") {
      left = anchor.right + gap;
      top = anchor.top + anchor.height / 2 - bounds.height / 2;
    }
    if (tooltip.side === "left") {
      left = anchor.left - bounds.width - gap;
      top = anchor.top + anchor.height / 2 - bounds.height / 2;
    }
    setPosition({
      left: clamp(left, 8, window.innerWidth - bounds.width - 8),
      top: clamp(top, 8, window.innerHeight - bounds.height - 8),
    });
  }, [tooltip]);

  if (!tooltip) return null;
  return createPortal(
    <div
      ref={tooltipRef}
      className="app-tooltip"
      role="tooltip"
      style={{
        left: position?.left ?? -1000,
        top: position?.top ?? -1000,
        visibility: position ? "visible" : "hidden",
      }}
    >
      {tooltip.label}
    </div>,
    document.body,
  );
}

function isTooltipSide(value?: string): value is TooltipSide {
  return value === "top" || value === "right" || value === "bottom" || value === "left";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
