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
        solved ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-100" : "bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100"
      }`}
    >
      {solved ? "✓ Solved" : "Attempted"}
    </span>
  );
}
