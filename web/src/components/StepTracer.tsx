import { useEffect, useMemo, useState } from "react";

import { POINTER, show, snapshots, type Trace, type TraceValue } from "../lib/trace.ts";

type ListValue = Extract<TraceValue, { t: "list" | "tuple" | "set" }>;
const isList = (v: TraceValue): v is ListValue => typeof v === "object" && v !== null && v.t !== "dict";

/** Lists of plain values as boxes, with index-like integers as pointers underneath. */
function ArrayView({ name, v, vars }: { name: string; v: ListValue; vars: Record<string, TraceValue> }) {
  const pointers = Object.entries(vars).filter(([k, x]) => POINTER.test(k) && typeof x === "number" && Number.isInteger(x) && x >= 0 && x < v.v.length);
  return (
    <div className="space-y-1">
      <div className="font-mono text-xs text-muted">{name}</div>
      <div className="flex flex-wrap gap-0.5" role="list" aria-label={`${name}: ${show(v)}`}>
        {v.v.map((x, idx) => (
          <div key={idx} role="listitem" className="min-w-8 text-center">
            <div className="rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-sm">{typeof x === "object" && x !== null ? "…" : show(x)}</div>
            <div className="text-[10px] text-muted tabular-nums">{idx}</div>
            <div className="text-[10px] font-semibold text-accent">{pointers.filter(([, p]) => p === idx).map(([k]) => k).join(",")}</div>
          </div>
        ))}
        {v.n > v.v.length && <div className="self-start px-1 text-xs text-muted">… {v.n - v.v.length} more</div>}
      </div>
    </div>
  );
}

export function StepTracer({ trace, source }: { trace: Trace; source: string }) {
  const snaps = useMemo(() => snapshots(trace), [trace]);
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4); // steps per second
  const last = trace.steps.length - 1;

  useEffect(() => {
    if (!playing) return;
    if (i >= last) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setI((x) => Math.min(last, x + 1)), 1000 / speed);
    return () => clearTimeout(t);
  }, [playing, i, last, speed]);

  if (last < 0) return <p className="text-sm text-muted">The program finished without running any traced line.</p>;
  const step = trace.steps[i]!;
  const vars = snaps[i]!;
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const lists = Object.entries(vars).filter((e): e is [string, ListValue] => isList(e[1]) && e[1].v.every((x) => typeof x !== "object" || x === null));
  const btn = "rounded border border-line px-2 py-1 text-sm disabled:opacity-50";

  return (
    <div className="space-y-3" data-testid="tracer"
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") setI((x) => Math.min(last, x + 1));
        if (e.key === "ArrowLeft") setI((x) => Math.max(0, x - 1));
      }}>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Playback">
        <button type="button" className={btn} onClick={() => setI(0)} disabled={i === 0}>⏮ Start</button>
        <button type="button" className={btn} onClick={() => setI((x) => Math.max(0, x - 1))} disabled={i === 0}>◀ Back</button>
        <button type="button" className={btn} onClick={() => setPlaying((p) => !p)} disabled={i >= last && !playing} aria-pressed={playing}>
          {playing ? "⏸ Pause" : "▶ Play"}
        </button>
        <button type="button" className={btn} onClick={() => setI((x) => Math.min(last, x + 1))} disabled={i >= last}>Step ▶</button>
        <label className="ml-2 flex items-center gap-1 text-sm text-muted">
          Speed
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="rounded border border-line bg-canvas px-1 py-0.5">
            {[1, 2, 4, 8, 16].map((s) => <option key={s} value={s}>{s}×</option>)}
          </select>
        </label>
        <span className="text-sm text-muted tabular-nums" aria-live="polite" data-testid="tracer-position">
          Step {i + 1} of {last + 1} · line {step.l}{step.f !== "<module>" ? ` in ${step.f}()` : ""}
        </span>
      </div>
      <input type="range" min={0} max={last} value={i} onChange={(e) => setI(Number(e.target.value))} className="w-full" aria-label="Step" />
      <div className="grid gap-3 md:grid-cols-2">
        <ol className="max-h-80 overflow-auto rounded border border-line font-mono text-xs" aria-label="Code">
          {lines.map((text, idx) => (
            <li key={idx} aria-current={idx + 1 === step.l ? "step" : undefined}
              className={`flex gap-2 px-2 ${idx + 1 === step.l ? "bg-accent text-on-accent" : ""}`}>
              <span className="w-8 shrink-0 select-none text-right opacity-60">{idx + 1}</span>
              <span className="whitespace-pre">{text || " "}</span>
            </li>
          ))}
        </ol>
        <div className="space-y-3">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded border border-line p-2 font-mono text-xs" aria-label="Variables">
            {Object.keys(vars).length === 0 && <dd className="col-span-2 text-muted">No variables yet.</dd>}
            {Object.entries(vars).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className={step.d[k] !== undefined ? "font-semibold text-accent" : ""}>{k}</dt>
                <dd className="break-all">{show(v)}</dd>
              </div>
            ))}
          </dl>
          {lists.slice(0, 3).map(([k, v]) => <ArrayView key={k} name={k} v={v} vars={vars} />)}
        </div>
      </div>
      {trace.capped && <p className="text-sm" role="status">Trace capped: {trace.capped}. Later steps are not shown.</p>}
      {trace.error && i === last && <p className="text-sm text-hard-fg">The program stopped with {trace.error}.</p>}
      {i === last && trace.stdout && (
        <div>
          <div className="text-xs text-muted">Output</div>
          <pre className="max-h-32 overflow-auto rounded bg-surface p-2 font-mono text-xs">{trace.stdout}</pre>
        </div>
      )}
    </div>
  );
}
