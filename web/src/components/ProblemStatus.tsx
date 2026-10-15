import type { ProblemSummary } from "../api.ts";

/** Solved / attempted badge for the logged-in user (nothing when neither). */
export function ProblemStatus({ status }: { status: ProblemSummary["my_status"] }) {
  if (!status) return null;
  const solved = status === "solved";
  return (
    <span
      data-testid="problem-status"
      data-status={status}
      className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${
        solved ? "bg-easy-bg text-easy-fg" : "bg-medium-bg text-medium-fg"
      }`}
    >
      {solved ? "✓ Solved" : "Attempted"}
    </span>
  );
}
