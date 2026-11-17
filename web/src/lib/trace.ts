/**
 * The Python step tracer's output (runner/internal/worker/tracer.py) is the
 * traced program's stdout: untrusted. parseTrace accepts only the expected
 * shape within fixed caps and returns null for anything else; values are
 * only ever rendered as text.
 */
export type TraceValue = null | boolean | number | string | { t: "list" | "tuple" | "set"; v: TraceValue[]; n: number } | { t: "dict"; v: [TraceValue, TraceValue][]; n: number };

export interface TraceStep {
  l: number;
  f: string;
  d: Record<string, TraceValue>;
}

export interface Trace {
  steps: TraceStep[];
  stdout: string;
  capped: string | null;
  error: string | null;
}

const MAX_BYTES = 1 << 20;
const MAX_STEPS = 1000;

function isValue(v: unknown, depth = 0): v is TraceValue {
  if (v === null || typeof v === "boolean" || typeof v === "number" || typeof v === "string") return typeof v !== "string" || v.length <= 200;
  if (depth >= 3 || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.v) || typeof o.n !== "number" || o.v.length > 64) return false;
  if (o.t === "dict") return o.v.every((p) => Array.isArray(p) && p.length === 2 && isValue(p[0], depth + 1) && isValue(p[1], depth + 1));
  return (o.t === "list" || o.t === "tuple" || o.t === "set") && o.v.every((x) => isValue(x, depth + 1));
}

export function parseTrace(stdout: string): Trace | null {
  if (stdout.length > MAX_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return null;
  }
  const o = raw as Record<string, unknown>;
  if (!o || typeof o !== "object" || !Array.isArray(o.steps) || o.steps.length > MAX_STEPS || typeof o.stdout !== "string") return null;
  for (const s of o.steps as unknown[]) {
    const st = s as Record<string, unknown>;
    if (!st || typeof st.l !== "number" || typeof st.f !== "string" || !st.d || typeof st.d !== "object" || Array.isArray(st.d)) return null;
    const d = st.d as Record<string, unknown>;
    if (Object.keys(d).length > 40 || !Object.values(d).every((v) => isValue(v))) return null;
  }
  const str = (x: unknown) => (typeof x === "string" ? x.slice(0, 300) : null);
  return { steps: o.steps as TraceStep[], stdout: o.stdout.slice(0, 16384), capped: str(o.capped), error: str(o.error) };
}

/** Variables visible at each step: the diffs applied per function. */
export function snapshots(t: Trace): Record<string, TraceValue>[] {
  const frames = new Map<string, Record<string, TraceValue>>();
  return t.steps.map((s) => {
    const cur = { ...(frames.get(s.f) ?? {}), ...s.d };
    frames.set(s.f, cur);
    return cur;
  });
}

export function show(v: TraceValue): string {
  if (v === null) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") return String(v);
  const more = v.n > v.v.length ? `, … ${v.n - v.v.length} more` : "";
  if (v.t === "dict") return `{${v.v.map(([k, x]) => `${show(k)}: ${show(x)}`).join(", ")}${more}}`;
  const [o, c] = v.t === "list" ? ["[", "]"] : v.t === "tuple" ? ["(", ")"] : ["{", "}"];
  return `${o}${v.v.map(show).join(", ")}${more}${c}`;
}

/** Names that usually index into a list: drawn as pointers under it. */
export const POINTER = /^(i|j|k|l|r|lo|hi|left|right|mid|start|end|p|q|idx|pos|head|tail)$/;
