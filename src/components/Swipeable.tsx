import { useEffect, useRef, useState, type ReactNode } from "react";

// Swipe left to delete, like iOS Mail: a short swipe reveals a Delete button, a long swipe
// deletes in one motion. Touch only — with a mouse, dragging is how you select text, so on
// desktop delete stays in the editor.
//
// Built on touch events with a non-passive touchmove: once a drag is clearly sideways we
// preventDefault so the page doesn't scroll, and a clearly vertical drag is left alone to
// scroll. (CSS touch-action alone isn't reliable in iOS Safari inside a scrolling list.)
const OPEN = -88; // how far a short swipe rests open (the button's width)
const DECIDE = 8; // px of movement before deciding sideways vs. scroll

export function Swipeable({ onDelete, label = "Delete", className = "", children }: { onDelete: () => void; label?: string; className?: string; children: ReactNode }) {
  const [x, setXState] = useState(0);
  const xNow = useRef(0); // the latest offset — handlers read this, not a possibly stale render
  const setX = (v: number) => {
    xNow.current = v;
    setXState(v);
  };
  const [animate, setAnimate] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const swiped = useRef(false);
  const deleteRef = useRef(onDelete);
  deleteRef.current = onDelete;

  const settle = (to: number, then?: () => void) => {
    setAnimate(true);
    setX(to);
    if (then) window.setTimeout(then, 180);
  };
  const settleRef = useRef(settle);
  settleRef.current = settle;

  useEffect(() => {
    const el = layer.current;
    if (!el) return;
    let start: { x: number; y: number; base: number } | null = null;
    let mode: "undecided" | "swipe" | "scroll" = "undecided";

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return void (start = null);
      const t = e.touches[0];
      start = { x: t.clientX, y: t.clientY, base: xNow.current };
      mode = "undecided";
      swiped.current = false;
      setAnimate(false);
    };
    const onMove = (e: TouchEvent) => {
      if (!start || mode === "scroll") return;
      const t = e.touches[0];
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (mode === "undecided") {
        if (Math.abs(dx) < DECIDE && Math.abs(dy) < DECIDE) return;
        mode = Math.abs(dx) > Math.abs(dy) ? "swipe" : "scroll";
        if (mode === "scroll") return;
      }
      e.preventDefault(); // sideways: this gesture is ours, don't scroll
      swiped.current = true;
      setX(Math.min(0, start.base + dx));
    };
    const onEnd = () => {
      const was = mode;
      start = null;
      mode = "undecided";
      if (was !== "swipe") return;
      const width = box.current?.offsetWidth || 400;
      const at = xNow.current;
      if (at < -width * 0.45) settleRef.current(-width, () => deleteRef.current());
      else if (at < OPEN / 2) settleRef.current(OPEN);
      else settleRef.current(0);
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, []);

  return (
    // Rounding follows the surrounding card (so a lone row in a card keeps its corners) unless given.
    <div ref={box} className={`relative overflow-hidden ${/\brounded/.test(className) ? "" : "rounded-[inherit]"} ${className}`}>
      {x < 0 && (
        <div className="absolute inset-0 flex items-stretch justify-end bg-danger">
          <button type="button" onClick={() => settle(-(box.current?.offsetWidth || 400), onDelete)} className="flex w-[88px] flex-col items-center justify-center gap-0.5 text-[12px] font-semibold text-white">
            <span aria-hidden className="text-[18px] leading-none">🗑</span>
            {label}
          </button>
        </div>
      )}
      <div
        ref={layer}
        style={{ transform: `translateX(${x}px)`, transition: animate ? "transform 180ms ease-out" : "none", touchAction: "pan-y" }}
        // Opaque only while moved, so at rest the row looks exactly as it did.
        className={`relative rounded-[inherit] ${x !== 0 ? "bg-surface" : ""}`}
        onClickCapture={(e) => {
          // The tap that ends a swipe isn't a tap on the card; a tap on an open card closes it.
          const at = xNow.current;
          if (swiped.current || at !== 0) {
            e.preventDefault();
            e.stopPropagation();
            swiped.current = false;
            if (at !== 0 && at > OPEN - 1) settle(0);
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}
