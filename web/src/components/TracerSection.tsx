import { type Sample } from "../api.ts";
import { parseTrace } from "../lib/trace.ts";
import { useRun } from "../lib/useRun.ts";
import { StepTracer } from "./StepTracer.tsx";

/** Python step tracer on the first sample (docs/INSIGHTS.md, M3): opt-in, same sandbox and limits as a run. */
export function TracerSection({ slug, source, sample }: { slug: string; source: string; sample: Sample }) {
  const run = useRun();
  const st = run.state;
  const trace = st.phase === "done" && st.result.status === "OK" ? parseTrace(st.result.stdout) : null;
  return (
    <section aria-labelledby="tracer-h" className="rounded border border-line p-4" data-testid="tracer-section">
      <h2 id="tracer-h" className="font-semibold">Step through</h2>
      <p className="mb-3 text-xs text-muted">
        Runs your code on sample {sample.name} with a tracer: each line, and the variables it changed. At most 1000 steps.
      </p>
      {st.phase === "idle" || st.phase === "error" ? (
        <div className="space-y-2">
          <button type="button" className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-on-accent" onClick={() => run.start(slug, "python", source, sample.input, true)}>
            Step through sample {sample.name}
          </button>
          {st.phase === "error" && <p role="alert" className="text-sm text-hard-fg">{st.message}</p>}
        </div>
      ) : st.phase !== "done" ? (
        <p className="text-sm text-muted" aria-live="polite">Tracing…</p>
      ) : trace ? (
        <StepTracer trace={trace} source={source} />
      ) : (
        <p className="text-sm">
          {st.result.status === "OK" ? "The trace could not be read." : `The traced run ended with ${st.result.status}${st.result.reason ? `: ${st.result.reason}` : ""}.`}
        </p>
      )}
    </section>
  );
}
