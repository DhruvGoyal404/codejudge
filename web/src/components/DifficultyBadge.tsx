import type { Difficulty } from "../api.ts";

const STYLE: Record<Difficulty, string> = {
  easy: "bg-easy-bg text-easy-fg",
  medium: "bg-medium-bg text-medium-fg",
  hard: "bg-hard-bg text-hard-fg",
};
const LABEL: Record<Difficulty, string> = { easy: "Easy", medium: "Medium", hard: "Hard" };

export function DifficultyBadge({ difficulty }: { difficulty: Difficulty }) {
  return (
    <span data-testid="difficulty" data-difficulty={difficulty} className={`inline-block rounded px-1.5 py-0.5 text-xs font-semibold ${STYLE[difficulty]}`}>
      {LABEL[difficulty]}
    </span>
  );
}

export function TagChip({ tag, onClick, active = false }: { tag: string; onClick?: () => void; active?: boolean }) {
  const cls = `inline-block rounded-full px-2 py-0.5 text-xs ${active ? "bg-accent text-on-accent" : "bg-chip-bg text-chip-fg"}`;
  if (!onClick) return <span className={cls}>{tag}</span>;
  return (
    <button type="button" onClick={onClick} className={`${cls} hover:underline`} aria-pressed={active} title={active ? `Remove the ${tag} filter` : `Show only ${tag} problems`}>
      {tag}
    </button>
  );
}
