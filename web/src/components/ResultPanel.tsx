import type { Sample, Submission } from "../api.ts";
import { stageLabel, type JudgeState } from "../lib/judgeState.ts";
import { DiffView } from "./DiffView.tsx";
import { ErrorBanner } from "./Layout.tsx";
import { VerdictBadge } from "./VerdictBadge.tsx";

const STEPS = ["Queued", "Compiling", "Testing", "Verdict"] as const;

function stepIndex(s: JudgeState): number {
  switch (s.phase) {
    case "queued":
      return 0;
    case "running":
      return s.progress?.stage === "testing" ? 2 : 1;
    case "done":
      return 3;
    default:
      return -1;
  }
}

export function ResultPanel({ state, samples }: { state: JudgeState; samples: Sample[] }) {
  if (state.phase === "idle") {
    return <p className="text-sm text-muted">Submit to judge your code on every test (Ctrl+Enter). The verdict appears here.</p>;
  }
  if (state.phase === "error") return <ErrorBanner>{state.message}</ErrorBanner>;

  const idx = stepIndex(state);
  return (
    <section aria-label="Judging result" data-testid="result" className="space-y-3">
      <ol className="flex flex-wrap items-center gap-2 text-xs" data-testid="stages">
        {STEPS.map((label, i) => (
          <li
            key={label}
            aria-current={i === idx ? "step" : undefined}
            className={`rounded-full px-2 py-0.5 ${
              i < idx ? "bg-surface text-fg" : i === idx ? "bg-accent text-on-accent" : "border border-line text-muted"
            }`}
          >
            {label}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-3">
        {state.phase === "done" && state.submission.verdict ? (
          <>
            <VerdictBadge verdict={state.submission.verdict} long />
            {state.submission.tests.length > 0 && (
              <span className="text-sm text-muted tabular-nums" data-testid="result-summary">
                {state.submission.tests.filter((t) => t.status === "AC").length}/{state.submission.tests.length} tests passed · max CPU{" "}
                {state.submission.max_cpu_ms ?? 0} ms · max memory {((state.submission.max_rss_kb ?? 0) / 1024).toFixed(1)} MB
              </span>
            )}
          </>
        ) : (
          <span className="text-sm" data-testid="stage-label" aria-live="polite">
            <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />
            {stageLabel(state)}
          </span>
        )}
        {(state.phase === "queued" || state.phase === "running") && state.reconnecting && (
          <span className="text-xs text-medium-fg" role="status">
            Connection lost — reconnecting…
          </span>
        )}
      </div>
      {state.phase === "running" && state.progress?.stage === "testing" && (
        <progress className="h-2 w-full" max={state.progress.total} value={state.progress.test} aria-label="Test progress" />
      )}
      {state.phase === "done" && <Details submission={state.submission} samples={samples} />}
    </section>
  );
}

function Details({ submission: s, samples }: { submission: Submission; samples: Sample[] }) {
  if (s.verdict === "CE") {
    return (
      <div>
        <h3 className="mb-1 text-sm font-medium">Compiler output</h3>
        <pre className="max-h-64 overflow-auto rounded bg-surface p-2 font-mono text-xs">{s.reason ?? "(no output)"}</pre>
      </div>
    );
  }
  const failed = s.tests.find((t) => t.status !== "AC");
  const failedSample = failed?.is_sample ? samples.find((x) => x.name === failed.name) : undefined;
  return (
    <div className="space-y-3">
      {s.verdict === "IE" && s.reason && <p className="text-sm text-muted">Internal error: {s.reason}</p>}
      {failed && failed.is_sample && failedSample && (
        <div data-testid="failed-sample" className="space-y-2">
          <h3 className="text-sm font-medium">
            Failed on sample {failed.name} ({failed.status})
          </h3>
          <div className="grid gap-2 md:grid-cols-2">
            <div>
              <div className="text-xs text-muted">Input</div>
              <pre className="max-h-40 overflow-auto rounded bg-surface p-2 font-mono text-xs">{failedSample.input}</pre>
            </div>
            <div>
              <div className="text-xs text-muted">Expected output</div>
              <pre className="max-h-40 overflow-auto rounded bg-surface p-2 font-mono text-xs">{failedSample.output}</pre>
            </div>
          </div>
          {failed.status === "WA" ? (
            <DiffView expected={failedSample.output} actual={failed.stdout ?? ""} truncated={failed.stdout_truncated ?? false} />
          ) : (
            <p className="text-xs text-muted">The program did not finish normally on this sample ({failed.status}).</p>
          )}
        </div>
      )}
      {failed && !failed.is_sample && (
        <p data-testid="failed-hidden" className="text-sm">
          Failed on hidden test #{failed.seq}: <span className="font-mono">{failed.status}</span>
        </p>
      )}
      <table className="w-full text-left text-sm" data-testid="tests-table">
        <thead className="text-xs text-muted">
          <tr>
            <th className="py-1 pr-2">Test</th>
            <th className="py-1 pr-2">Status</th>
            <th className="py-1 pr-2 text-right">CPU</th>
            <th className="py-1 text-right">Memory</th>
          </tr>
        </thead>
        <tbody>
          {s.tests.map((t) => (
            <tr key={t.seq} className="border-t border-line">
              <td className="py-1 pr-2 font-mono">
                #{t.seq}
                {t.is_sample && <span className="ml-1 text-xs text-muted">sample</span>}
              </td>
              <td className={`py-1 pr-2 font-mono ${t.status === "AC" ? "text-easy-fg" : "text-hard-fg"}`}>{t.status}</td>
              <td className="py-1 pr-2 text-right tabular-nums">{t.cpu_ms} ms</td>
              <td className="py-1 text-right tabular-nums">{(t.rss_kb / 1024).toFixed(1)} MB</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
