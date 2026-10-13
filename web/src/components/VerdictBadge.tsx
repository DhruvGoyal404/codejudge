import { VERDICT_LABEL, type Verdict } from "../api.ts";

const COLORS: Record<Verdict, string> = {
  AC: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-100",
  WA: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-100",
  CE: "bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100",
  RE: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-100",
  TLE: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-100",
  MLE: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-100",
  OLE: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-100",
  IE: "bg-zinc-200 text-zinc-800 dark:bg-zinc-700 dark:text-zinc-100",
};

export function VerdictBadge({ verdict, long = false }: { verdict: Verdict; long?: boolean }) {
  return (
    <span data-testid="verdict" data-verdict={verdict} className={`inline-block rounded px-2 py-0.5 font-mono text-sm font-semibold ${COLORS[verdict]}`}>
      {long ? `${verdict} · ${VERDICT_LABEL[verdict]}` : verdict}
    </span>
  );
}
