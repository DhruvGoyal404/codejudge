import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Link } from "react-router";

import { api, ApiError, type Insight, type InsightReport, type InsightStep } from "../api.ts";

/** "n^2" -> "n²", "2^(n/2)" -> "2^(n/2)" etc., for display as O(...). */
export function bigO(cls: string): string {
  const pretty = (c: string) => c.replace("n^2", "n²").replace("n^3", "n³").replace("2^(n/2)", "2ⁿᐟ²").replace("2^n", "2ⁿ");
  return cls
    .split(" or ")
    .map((c) => `O(${pretty(c)})`)
    .join(" or ");
}

const F: Record<string, (n: number) => number> = {
  "1": () => 1,
  "log n": (n) => Math.log2(n),
  n: (n) => n,
  "n log n": (n) => n * Math.log2(n),
  "n^2": (n) => n * n,
  "n^3": (n) => n * n * n,
  "2^(n/2)": (n) => 2 ** (n / 2),
  "2^n": (n) => 2 ** n,
};

const fmtN = (n: number) => (n >= 1e4 && Number.isInteger(Math.log10(n)) ? `10${String(Math.log10(n)).replace(/\d/g, (d) => "⁰¹²³⁴⁵⁶⁷⁸⁹"[+d]!)}` : n.toLocaleString());
const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s` : `${Math.round(ms)} ms`);

/** What the measurement says, in one sentence. */
function headline(r: InsightReport): string {
  const t = r.time;
  if (t.class === "fast") return "Your program runs too fast at every allowed size for its growth to show: time is not its problem.";
  if (t.class === "unclear") return `The measurements don't support a claim: ${t.reason ?? "no class fits clearly"}.`;
  return `Your solution's running time grows like ${bigO(t.class)}.`;
}

/** Why it hit the time limit (or would), from the fit. */
function limitNote(r: InsightReport): string | null {
  const last = r.steps?.at(-1);
  if (r.stopped_by === "TLE" && last) {
    const pred = r.predicted_ms;
    return (
      `It exceeded the ${fmtMs(r.time_limit_ms)} limit at n = ${fmtN(last.n)}` +
      (pred && r.max_n > last.n ? `; at the largest allowed size (n = ${fmtN(r.max_n)}) the fit predicts about ${fmtMs(pred)}.` : ".")
    );
  }
  if (r.predicted_ms && r.predicted_ms > r.time_limit_ms) {
    return `At the largest allowed size (n = ${fmtN(r.max_n)}) the fit predicts about ${fmtMs(r.predicted_ms)}, over the ${fmtMs(r.time_limit_ms)} limit.`;
  }
  return null;
}

/** Log-log chart of the measured CPU time per size, the fitted curve, and the limit. */
function GrowthChart({ r }: { r: InsightReport }) {
  const steps = (r.steps ?? []).filter((s) => s.cpu_ms > 0);
  if (steps.length < 2) return null;
  const W = 560, H = 240, L = 52, R = 12, T = 12, B = 34;
  const ns = steps.map((s) => s.n);
  const ys = [...steps.map((s) => s.cpu_ms), r.time_limit_ms];
  const x0 = Math.log10(Math.min(...ns)), x1 = Math.log10(Math.max(...ns));
  const y0 = Math.log10(Math.max(1, Math.min(...ys) * 0.8)), y1 = Math.log10(Math.max(...ys) * 1.25);
  const px = (n: number) => L + ((Math.log10(n) - x0) / (x1 - x0 || 1)) * (W - L - R);
  const py = (ms: number) => T + (1 - (Math.log10(Math.max(ms, 1)) - y0) / (y1 - y0 || 1)) * (H - T - B);
  const f = F[r.time.class.split(" or ").at(-1)!];
  const fit =
    f && r.time.class !== "fast" && r.time.class !== "unclear"
      ? Array.from({ length: 40 }, (_, i) => {
          const n = 10 ** (x0 + ((x1 - x0) * i) / 39);
          return `${i ? "L" : "M"}${px(n).toFixed(1)},${py(r.time.offset + r.time.scale * f(n)).toFixed(1)}`;
        }).join("")
      : null;
  const decades = (lo: number, hi: number) => Array.from({ length: Math.floor(hi) - Math.ceil(lo) + 1 }, (_, i) => Math.ceil(lo) + i);
  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-xl text-muted" role="img" aria-labelledby="growth-title growth-desc">
        <title id="growth-title">Measured CPU time by input size (log-log)</title>
        <desc id="growth-desc">
          {steps.map((s) => `n ${s.n}: ${s.cpu_ms} ms${s.status !== "OK" ? ` (${s.status})` : ""}`).join("; ")}
        </desc>
        {decades(x0, x1).map((d) => (
          <g key={`x${d}`}>
            <line x1={px(10 ** d)} x2={px(10 ** d)} y1={T} y2={H - B} stroke="currentColor" strokeOpacity={0.15} />
            <text x={px(10 ** d)} y={H - B + 16} textAnchor="middle" fontSize="11" fill="currentColor">{fmtN(10 ** d)}</text>
          </g>
        ))}
        {decades(y0, y1).map((d) => (
          <g key={`y${d}`}>
            <line x1={L} x2={W - R} y1={py(10 ** d)} y2={py(10 ** d)} stroke="currentColor" strokeOpacity={0.15} />
            <text x={L - 6} y={py(10 ** d) + 4} textAnchor="end" fontSize="11" fill="currentColor">{fmtMs(10 ** d)}</text>
          </g>
        ))}
        <line x1={L} x2={W - R} y1={py(r.time_limit_ms)} y2={py(r.time_limit_ms)} className="text-hard-fg" stroke="currentColor" strokeDasharray="5 4" />
        <text x={W - R} y={py(r.time_limit_ms) - 5} textAnchor="end" fontSize="11" className="text-hard-fg" fill="currentColor">time limit</text>
        {fit && <path d={fit} fill="none" className="text-accent" stroke="currentColor" strokeWidth={2} strokeOpacity={0.6} />}
        {steps.map((s) => (
          <circle key={s.n} cx={px(s.n)} cy={py(s.cpu_ms)} r={s.status === "OK" ? 3.5 : 5}
            className={s.status === "OK" ? "text-fg" : "text-hard-fg"} fill="currentColor" />
        ))}
        <text x={(L + W - R) / 2} y={H - 4} textAnchor="middle" fontSize="11" fill="currentColor">input size n</text>
      </svg>
      <figcaption className="text-xs text-muted">Dots: median CPU time per size. Line: the fitted {r.time.class === "fast" || r.time.class === "unclear" ? "curve (none: no claim)" : bigO(r.time.class)} curve.</figcaption>
    </figure>
  );
}

function Skeleton() {
  return (
    <div aria-busy="true" aria-live="polite" data-testid="insights-loading">
      <p className="text-sm text-muted">Measuring your program on growing inputs. Judging always goes first, so this can take a minute when the judge is busy.</p>
      <div className="mt-3 space-y-2" aria-hidden="true">
        <div className="h-5 w-2/3 animate-pulse rounded bg-surface" />
        <div className="h-40 w-full max-w-xl animate-pulse rounded bg-surface" />
      </div>
    </div>
  );
}

function Steps({ steps }: { steps: InsightStep[] }) {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-muted">Measurements ({steps.length} sizes)</summary>
      <div className="mt-2 max-h-64 overflow-auto">
        <table className="w-full text-left tabular-nums">
          <thead className="text-muted">
            <tr><th className="pr-4 font-normal">n</th><th className="pr-4 font-normal">CPU</th><th className="pr-4 font-normal">Memory</th><th className="font-normal">Status</th></tr>
          </thead>
          <tbody>
            {steps.map((s) => (
              <tr key={s.n}>
                <td className="pr-4">{s.n.toLocaleString()}</td>
                <td className="pr-4">{fmtMs(s.cpu_ms)}</td>
                <td className="pr-4">{(s.rss_kb / 1024).toFixed(1)} MB</td>
                <td>{s.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function Result({ r, reference, label }: { r: InsightReport; reference: string | null; label: string | null }) {
  if (r.status === "CE") return <p className="text-sm">The program didn't compile, so there was nothing to measure.</p>;
  const note = limitNote(r);
  const claim = r.time.class !== "fast" && r.time.class !== "unclear";
  const refClaim = reference && reference !== "fast" && reference !== "unclear";
  return (
    <div className="space-y-3" data-testid="insights-result">
      <p className="text-base font-medium" data-testid="insights-headline">{headline(r)}</p>
      {claim && (
        <p className="text-sm text-muted">
          Confidence {Math.round(r.time.confidence * 100)}%, from {r.steps?.length ?? 0} measured sizes{label ? ` (${label})` : ""}.
        </p>
      )}
      {refClaim && (
        <p className="text-sm" data-testid="insights-reference">
          The reference solution scales as <strong>{bigO(reference)}</strong>
          {claim && reference !== r.time.class ? "." : ", like yours."}
        </p>
      )}
      {reference === "fast" && (
        <p className="text-sm" data-testid="insights-reference">The reference solution is too fast at every allowed size for its growth to show.</p>
      )}
      {note && <p className="text-sm" data-testid="insights-limit">{note}</p>}
      <GrowthChart r={r} />
      {r.steps && <Steps steps={r.steps} />}
    </div>
  );
}

function Hints({ hints }: { hints: Insight["hints"] }) {
  if (!hints.length) return null;
  return (
    <div className="mt-4 border-t border-line pt-3" data-testid="insights-hints">
      <h3 className="text-sm font-semibold">Worth checking</h3>
      <p className="mb-2 text-xs text-muted">Patterns in your code that are often slow. Hints, not the verdict: the measurement above is.</p>
      <ul className="space-y-1 text-sm">
        {hints.map((h) => (
          <li key={`${h.kind}-${h.line}`}>
            <span className="mr-2 font-mono text-xs text-muted">line {h.line}</span>
            {h.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Insights on the submission page: only for the submission's owner (the API enforces it). */
export function InsightsPanel({ id }: { id: string }) {
  const qc = useQueryClient();
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (window.location.hash === "#insights") ref.current?.scrollIntoView({ block: "start" });
  }, []);
  const q = useQuery({
    queryKey: ["insight", id],
    queryFn: () => api.insight(id),
    refetchInterval: (query) => (query.state.data?.status === "queued" || query.state.data?.status === "running" ? 2000 : false),
  });
  const start = useMutation({
    mutationFn: () => api.analyze(id),
    onSuccess: (data: Insight) => qc.setQueryData(["insight", id], data),
  });
  const i = q.data;
  const startError =
    start.error instanceof ApiError && start.error.status === 429
      ? `Too many analyses; try again in ${start.error.retryAfter ?? 60} s.`
      : start.error?.message;

  return (
    <section id="insights" ref={ref} aria-labelledby="insights-h" className="scroll-mt-4 rounded border border-line p-4" data-testid="insights">
      <h2 id="insights-h" className="font-semibold">Insights</h2>
      <p className="mb-3 text-xs text-muted">How your solution's time grows with input size: measured in the sandbox, not guessed.</p>
      {q.isPending ? (
        <Skeleton />
      ) : q.isError ? (
        <p className="text-sm text-muted">Insights are unavailable right now.</p>
      ) : i!.status === "queued" || i!.status === "running" ? (
        <Skeleton />
      ) : i!.status === "done" && i!.report ? (
        <Result r={i!.report} reference={i!.reference} label={i!.label} />
      ) : !i!.eligible ? (
        <p className="text-sm text-muted">{i!.reason}</p>
      ) : (
        <div className="space-y-2">
          {i!.status === "failed" && <p className="text-sm">The last analysis didn't finish: {i!.error ?? "unknown error"}.</p>}
          <button type="button" onClick={() => start.mutate()} disabled={start.isPending}
            className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-on-accent disabled:opacity-60" data-testid="insights-start">
            {start.isPending ? "Starting…" : i!.status === "failed" ? "Try again" : "Analyze my solution"}
          </button>
          {startError && <p role="alert" className="text-sm text-hard-fg">{startError}</p>}
        </div>
      )}
      {i && <Hints hints={i.hints ?? []} />}
    </section>
  );
}

const ANALYZABLE = new Set(["AC", "TLE", "MLE"]);

/**
 * One line under a verdict on the problem page: the cached result, an
 * analysis in progress, or the button that starts one, and a link to the full
 * panel on the submission page.
 */
export function InsightsTeaser({ id, verdict }: { id: string; verdict: string }) {
  const qc = useQueryClient();
  const enabled = ANALYZABLE.has(verdict);
  const q = useQuery({
    queryKey: ["insight", id],
    queryFn: () => api.insight(id),
    enabled,
    refetchInterval: (query) => (query.state.data?.status === "queued" || query.state.data?.status === "running" ? 2000 : false),
  });
  const start = useMutation({ mutationFn: () => api.analyze(id), onSuccess: (data: Insight) => qc.setQueryData(["insight", id], data) });
  const i = q.data;
  if (!enabled || !i || !i.eligible) return null;
  const link = (
    <Link to={`/submissions/${id}#insights`} className="text-accent underline" data-testid="insights-link">
      View insights
    </Link>
  );
  const r = i.report;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="insights-teaser">
      {i.status === "done" && r ? (
        <>
          <span>
            <span className="text-muted">Measured: </span>
            {r.time.class === "fast" ? "too fast to show growth" : r.time.class === "unclear" ? "growth unclear" : `grows like ${bigO(r.time.class)}`}
          </span>
          {link}
        </>
      ) : i.status === "queued" || i.status === "running" ? (
        <>
          <span className="text-muted" aria-live="polite">Analyzing how your solution scales…</span>
          {link}
        </>
      ) : (
        <>
          <button type="button" onClick={() => start.mutate()} disabled={start.isPending}
            className="rounded border border-accent px-2 py-0.5 text-sm font-medium text-accent disabled:opacity-60" data-testid="insights-teaser-start">
            {start.isPending ? "Starting…" : "Analyze my solution"}
          </button>
          <span className="text-xs text-muted">See how its running time grows with input size.</span>
          {start.error && <span role="alert" className="text-hard-fg">{start.error instanceof ApiError && start.error.status === 429 ? "Too many analyses; try again in a minute." : start.error.message}</span>}
        </>
      )}
    </div>
  );
}

