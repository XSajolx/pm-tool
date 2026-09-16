import { useEffect, useRef, useState } from "react";
import type { SignatureType } from "../lib/api.js";
import { cn } from "../lib/utils.js";

export interface SignatureValue {
  signatureType: SignatureType;
  name: string;
  title: string;
  image: string | null;
}

/**
 * Row 158: type your name or draw with mouse / finger. Drawing is captured on
 * a canvas and exported as a PNG data URL; typing is shown in a script face.
 */
export function SignaturePad({ value, onChange, accent = "#4f46e5" }: { value: SignatureValue; onChange: (v: SignatureValue) => void; accent?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [hasInk, setHasInk] = useState(false);
  const tab = value.signatureType;

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ratio = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = 160;
    if (c.width !== Math.round(w * ratio)) {
      c.width = Math.round(w * ratio);
      c.height = Math.round(h * ratio);
      const ctx = c.getContext("2d");
      if (ctx) {
        ctx.scale(ratio, ratio);
        ctx.lineWidth = 2.2;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.strokeStyle = "#0f172a";
      }
    }
  }, [tab]);

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const start = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    const { x, y } = pos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const { x, y } = pos(e);
    ctx.lineTo(x, y);
    ctx.stroke();
    if (!hasInk) setHasInk(true);
  };
  const end = () => {
    if (!drawing.current) return;
    drawing.current = false;
    const c = canvasRef.current;
    if (c) onChange({ ...value, signatureType: "drawn", image: c.toDataURL("image/png") });
  };
  const clear = () => {
    const c = canvasRef.current;
    const ctx = c?.getContext("2d");
    if (c && ctx) ctx.clearRect(0, 0, c.width, c.height);
    setHasInk(false);
    onChange({ ...value, image: null });
  };

  return (
    <div>
      <div className="flex gap-1 rounded-md bg-slate-100 p-1 text-xs font-medium">
        {(["typed", "drawn"] as const).map((k) => (
          <button key={k} type="button" onClick={() => onChange({ ...value, signatureType: k })} className={cn("flex-1 rounded px-2 py-1 transition", tab === k ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800")}>
            {k === "typed" ? "Type" : "Draw"}
          </button>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <input value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} placeholder="Full legal name" className="rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-500" />
        <input value={value.title} onChange={(e) => onChange({ ...value, title: e.target.value })} placeholder="Title / role (optional)" className="rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-500" />
      </div>
      {tab === "typed" ? (
        <div className="mt-3 flex h-[110px] items-center rounded-md border border-dashed border-slate-300 bg-slate-50 px-4">
          {value.name.trim() ? <span className="font-serif text-3xl italic text-slate-800" style={{ color: accent }}>{value.name.trim()}</span> : <span className="text-sm text-slate-400">Your typed name appears here as your signature</span>}
        </div>
      ) : (
        <div className="relative mt-3">
          <canvas
            ref={canvasRef}
            onPointerDown={start}
            onPointerMove={move}
            onPointerUp={end}
            onPointerLeave={end}
            onPointerCancel={end}
            className="h-[160px] w-full touch-none rounded-md border border-dashed border-slate-300 bg-slate-50"
            style={{ cursor: "crosshair" }}
          />
          {!hasInk && <span className="pointer-events-none absolute left-4 top-4 text-sm text-slate-400">Sign here with your mouse or finger</span>}
          <button type="button" onClick={clear} className="absolute bottom-2 right-2 rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50">Clear</button>
        </div>
      )}
    </div>
  );
}
