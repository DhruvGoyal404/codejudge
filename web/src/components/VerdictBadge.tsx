import { VERDICT_LABEL, type Verdict } from "../api.ts";

const COLORS: Record<Verdict, string> = {
  AC: "bg-easy-bg text-easy-fg",
  WA: "bg-hard-bg text-hard-fg",
  CE: "bg-medium-bg text-medium-fg",
  RE: "bg-hard-bg text-hard-fg",
  TLE: "bg-medium-bg text-medium-fg",
  MLE: "bg-medium-bg text-medium-fg",
  OLE: "bg-medium-bg text-medium-fg",
  IE: "bg-chip-bg text-chip-fg",
};

export function VerdictBadge({ verdict, long = false }: { verdict: Verdict; long?: boolean }) {
  return (
    <span data-testid="verdict" data-verdict={verdict} className={`inline-block rounded px-2 py-0.5 font-mono text-sm font-semibold ${COLORS[verdict]}`}>
      {long ? `${verdict} · ${VERDICT_LABEL[verdict]}` : verdict}
    </span>
  );
}
