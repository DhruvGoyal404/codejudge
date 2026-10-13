import { lineDiff } from "../lib/diff.ts";

/** Expected vs actual output, line by line: "−" expected only, "+" yours only. */
export function DiffView({ expected, actual, truncated }: { expected: string; actual: string; truncated?: boolean }) {
  const lines = lineDiff(expected, actual);
  const same = lines.every((l) => l.kind === "same");
  return (
    <div data-testid="diff">
      <pre className="overflow-x-auto rounded border border-zinc-200 bg-zinc-50 p-2 font-mono text-xs leading-5 dark:border-zinc-800 dark:bg-zinc-900">
        {lines.length === 0 && <span className="text-zinc-500">(both empty)</span>}
        {lines.map((l, i) => (
          <div
            key={i}
            data-kind={l.kind}
            className={
              l.kind === "expected"
                ? "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200"
                : l.kind === "actual"
                  ? "bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-200"
                  : ""
            }
          >
            <span className="select-none pr-2 text-zinc-400">{l.kind === "expected" ? "−" : l.kind === "actual" ? "+" : " "}</span>
            {l.text === "" ? " " : l.text}
          </div>
        ))}
      </pre>
      <p className="mt-1 text-xs text-zinc-500">
        <span className="text-red-700 dark:text-red-300">− expected</span> · <span className="text-green-700 dark:text-green-300">+ your output</span>
        {same && " · lines match (difference is in whitespace or token format)"}
        {truncated && " · your output was truncated to 4 KB"}
      </p>
    </div>
  );
}
