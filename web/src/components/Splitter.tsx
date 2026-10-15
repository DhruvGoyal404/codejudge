import { useRef, type KeyboardEvent, type PointerEvent, type RefObject } from "react";

interface SplitterProps {
  /** "vertical": a vertical bar between left and right panes; "horizontal": between top and bottom. */
  orientation: "vertical" | "horizontal";
  /** Size of the first pane in percent of the container. */
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  /** The element whose size the percentage refers to. */
  container: RefObject<HTMLElement | null>;
  label: string;
}

/**
 * A resize handle (WAI-ARIA window splitter): drag with the pointer, or focus
 * it and use the arrow keys (Shift for bigger steps), Home and End.
 */
export function Splitter({ orientation, value, min, max, onChange, container, label }: SplitterProps) {
  const dragging = useRef(false);
  const clamp = (v: number) => Math.round(Math.min(max, Math.max(min, v)) * 10) / 10;
  const vertical = orientation === "vertical";

  const fromPointer = (e: PointerEvent<HTMLDivElement>) => {
    const box = container.current?.getBoundingClientRect();
    if (!box) return;
    const pct = vertical ? ((e.clientX - box.left) / box.width) * 100 : ((e.clientY - box.top) / box.height) * 100;
    onChange(clamp(pct));
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 10 : 2;
    const back = vertical ? "ArrowLeft" : "ArrowUp";
    const fwd = vertical ? "ArrowRight" : "ArrowDown";
    let next: number | null = null;
    if (e.key === back) next = value - step;
    else if (e.key === fwd) next = value + step;
    else if (e.key === "Home") next = min;
    else if (e.key === "End") next = max;
    if (next !== null) {
      e.preventDefault();
      onChange(clamp(next));
    }
  };

  return (
    <div
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onKeyDown={onKey}
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => dragging.current && fromPointer(e)}
      onPointerUp={(e) => {
        dragging.current = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      className={`group relative shrink-0 touch-none bg-line hover:bg-accent focus-visible:bg-accent ${
        vertical ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize"
      }`}
    >
      {/* A wider invisible grab area around the thin line. */}
      <span aria-hidden className={vertical ? "absolute inset-y-0 -left-1.5 -right-1.5" : "absolute inset-x-0 -top-1.5 -bottom-1.5"} />
    </div>
  );
}
