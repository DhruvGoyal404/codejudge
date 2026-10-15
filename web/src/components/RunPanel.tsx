import { MAX_RUN_INPUT_BYTES, type RunStatus, type Sample } from "../api.ts";
import type { RunPhase } from "../lib/useRun.ts";
import { DiffView } from "./DiffView.tsx";
import { ErrorBanner } from "./Layout.tsx";

const RUN_LABEL: Record<RunStatus, string> = {
  OK: "Finished",
  CE: "Compilation Error",
  RE: "Runtime Error",
  TLE: "Time Limit Exceeded",
  MLE: "Memory Limit Exceeded",
  OLE: "Output Limit Exceeded",
  IE: "Internal Error",
};

function RunStatusBadge({ status }: { status: RunStatus }) {
  const ok = status === "OK";
  return (
    <span
      data-testid="run-status"
      data-status={status}
      className={`inline-block rounded px-2 py-0.5 font-mono text-sm font-semibold ${ok ? "bg-easy-bg text-easy-fg" : "bg-hard-bg text-hard-fg"}`}
    >
      {status} · {RUN_LABEL[status]}
    </span>
  );
}

const tokens = (s: string) => s.split(/\s+/).filter(Boolean);
const pre =
  "max-h-48 overflow-auto rounded bg-surface p-2 font-mono text-xs whitespace-pre";

interface RunPanelProps {
  samples: Sample[];
  input: string;
  onInput: (value: string) => void;
  run: RunPhase;
}

export function RunPanel({ samples, input, onInput, run }: RunPanelProps) {
  const tooBig = new TextEncoder().encode(input).length > MAX_RUN_INPUT_BYTES;
  const done = run.phase === "done" ? run : null;
  const sample = done ? samples.find((s) => s.input === done.input) : undefined;
  return (
    // Input and output side by side when the pane is wide enough (container
    // query: follows the splitter, not the window).
    <div className="@container" data-testid="run-panel">
      <div className="grid gap-3 @2xl:grid-cols-2">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted">Load:</span>
            {samples.map((s) => (
              <button
                key={s.name}
                type="button"
                onClick={() => onInput(s.input)}
                aria-pressed={input === s.input}
                className={`rounded-full px-2 py-0.5 text-xs ${input === s.input ? "bg-accent text-on-accent" : "bg-chip-bg text-chip-fg hover:underline"}`}
              >
                Sample {s.name}
              </button>
            ))}
          </div>
          <label className="block text-xs text-muted">
            Input <span className="text-muted">(max 64 KB)</span>
            <textarea
              value={input}
              onChange={(e) => onInput(e.target.value)}
              rows={6}
              spellCheck={false}
              className="mt-1 block w-full resize-y rounded border border-line bg-canvas p-2 font-mono text-xs text-fg"
              data-testid="run-input"
            />
          </label>
          {tooBig && <ErrorBanner>The input is larger than 64 KB, the limit for a run. Shorten it to run your code.</ErrorBanner>}
        </div>

        <div aria-live="polite" data-testid="run-output">
          {run.phase === "idle" && (
            <p className="text-sm text-muted">
              Run your code on this input with the Run button (Ctrl+'). Runs are
              not judged and do not count as submissions.
            </p>
          )}
          {(run.phase === "starting" || run.phase === "waiting") && (
            <p className="text-sm">
              <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />
              {run.phase === "waiting" && run.status === "running"
                ? "Running…"
                : "Queued…"}
            </p>
          )}
          {run.phase === "error" && <ErrorBanner>{run.message}</ErrorBanner>}
          {done && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-3">
                <RunStatusBadge status={done.result.status} />
                {done.result.status !== "CE" && (
                  <span className="text-xs text-muted tabular-nums">
                    CPU {done.result.cpu_ms} ms · memory{" "}
                    {(done.result.max_rss_kb / 1024).toFixed(1)} MB
                    {done.result.status === "RE" &&
                      ` · exit code ${done.result.exit_code}`}
                  </span>
                )}
              </div>
              {done.result.status === "CE" ? (
                <div>
                  <h3 className="mb-1 text-sm font-medium">Compiler output</h3>
                  <pre className={pre}>
                    {done.result.compile_output || "(no output)"}
                  </pre>
                </div>
              ) : (
                <>
                  <div>
                    <h3 className="mb-1 text-sm font-medium">Your output</h3>
                    <pre className={pre} data-testid="run-stdout">
                      {done.result.stdout || "(no output)"}
                    </pre>
                    {done.result.stdout_truncated && (
                      <p className="text-xs text-muted">Output cut at 64 KB.</p>
                    )}
                  </div>
                  {sample &&
                    (tokens(sample.output).join(" ") ===
                    tokens(done.result.stdout).join(" ") ? (
                      <p
                        className="text-sm text-easy-fg"
                        data-testid="run-matches"
                      >
                        ✓ Matches the expected output of sample {sample.name}.
                      </p>
                    ) : (
                      <div>
                        <h3 className="mb-1 text-sm font-medium">
                          Compared with sample {sample.name}
                        </h3>
                        <DiffView
                          expected={sample.output}
                          actual={done.result.stdout}
                          truncated={done.result.stdout_truncated}
                        />
                      </div>
                    ))}
                  {done.result.stderr && (
                    <details>
                      <summary className="cursor-pointer text-sm font-medium">
                        Standard error
                      </summary>
                      <pre className={`${pre} mt-1`}>{done.result.stderr}</pre>
                    </details>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
