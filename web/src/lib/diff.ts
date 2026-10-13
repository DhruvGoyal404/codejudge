export type DiffLine = { kind: "same" | "expected" | "actual"; text: string };

const splitLines = (s: string) => {
  const t = s.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  return t === "" ? [] : t.split("\n");
};

/**
 * Line diff between expected and actual output (LCS). Inputs are sample
 * outputs capped at 4 KiB, so the O(n*m) table stays tiny. Trailing newlines
 * and CRLF are normalized, matching the judge's exact checker.
 */
export function lineDiff(expected: string, actual: string): DiffLine[] {
  const a = splitLines(expected);
  const b = splitLines(actual);
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: "expected", text: a[i++]! });
    } else {
      out.push({ kind: "actual", text: b[j++]! });
    }
  }
  while (i < n) out.push({ kind: "expected", text: a[i++]! });
  while (j < m) out.push({ kind: "actual", text: b[j++]! });
  return out;
}
