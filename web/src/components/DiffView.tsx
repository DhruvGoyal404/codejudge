import { lineDiff } from "../lib/diff.ts";

/** Expected vs actual output, line by line: "−" expected only, "+" yours only. */
export function DiffView({ expected, actual, truncated }: { expected: string; actual: string; truncated?: boolean }) {
  const lines = lineDiff(expected, actual);
  const same = lines.every((l) => l.kind === "same");
  return (
    <div data-testid="diff">
      <pre className="overflow-x-auto rounded border border-line bg-surface p-2 font-mono text-xs leading-5">
        {lines.length === 0 && <span className="text-muted">(both empty)</span>}
        {lines.map((l, i) => (
          <div
            key={i}
            data-kind={l.kind}
            className={
              l.kind === "expected"
                ? "bg-hard-bg text-hard-fg"
                : l.kind === "actual"
                  ? "bg-easy-bg text-easy-fg"
                  : ""
            }
          >
            <span className="select-none pr-2 text-muted">{l.kind === "expected" ? "−" : l.kind === "actual" ? "+" : " "}</span>
            {l.text === "" ? " " : l.text}
          </div>
        ))}
      </pre>
      <p className="mt-1 text-xs text-muted">
        <span className="text-hard-fg">− expected</span> · <span className="text-easy-fg">+ your output</span>
        {same && " · lines match (difference is in whitespace or token format)"}
        {truncated && " · your output was truncated to 4 KB"}
      </p>
    </div>
  );
}
