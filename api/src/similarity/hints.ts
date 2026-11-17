import { tokenize, type Lang, type Token } from "./lexer.ts";

/**
 * Pattern hints (docs/INSIGHTS.md, M4): common causes of slow code, found in
 * the token stream. They are hints, never the verdict: the page shows them
 * under "worth checking", next to the measured class.
 */
export interface Hint {
  line: number;
  kind: "nested-loops" | "sort-in-loop" | "pop-front" | "list-membership" | "string-concat" | "unmemoized-recursion";
  message: string;
}

interface Loop {
  start: number; // index of the for/while token
  line: number;
  scan: string | null; // for-loops: what a full pass goes over (a collection, or the bound in i < X)
  end: number; // index of the token that ends the body
}

const LOOP = new Set(["for", "while"]);
const IGNORE = new Set(["i", "j", "k", "x", "y", "v", "_", "int", "auto", "long", "size", "length", "len", "range", "in", "true", "True"]);

/** The index just past the bracket group starting at toks[i] (which must open one). */
function closeOf(toks: Token[], i: number): number {
  const open = toks[i]!.t, close = open === "(" ? ")" : open === "{" ? "}" : "]";
  let d = 0;
  for (let j = i; j < toks.length; j++) {
    if (toks[j]!.t === open) d++;
    else if (toks[j]!.t === close && --d === 0) return j + 1;
  }
  return toks.length;
}

/**
 * What a for-loop header scans in full, or null: "a" for `for x in a`,
 * `for i in range(len(a))`, `for (auto x : a)`, `for (i = 0; i < a.size(); ...)`;
 * "n" for `range(n)` / `i < n`. Loops starting elsewhere (j = i + 1) also count:
 * that is still a scan to the same bound.
 */
function scanTarget(head: Token[], py: boolean): string | null {
  const name = (ts: Token[]) => ts.filter((t) => t.k === "V" && !IGNORE.has(t.t)).at(0)?.t ?? null;
  if (py) {
    const at = head.findIndex((t) => t.k === "in");
    if (at < 0) return null;
    const rest = head.slice(at + 1).filter((t) => t.t !== ":");
    if (rest[0]?.t === "range") return name(rest.slice(1).filter((t) => t.t !== "len"));
    return rest[0]?.k === "V" && rest.length === 1 ? rest[0].t : null;
  }
  const colon = head.findIndex((t) => t.t === ":");
  if (colon >= 0) return head[colon + 1]?.k === "V" ? head[colon + 1]!.t : null;
  const lt = head.findIndex((t) => t.t === "<" || t.t === "<=");
  return lt >= 0 ? name(head.slice(lt + 1)) : null;
}

function loops(toks: Token[], py: boolean): Loop[] {
  const out: Loop[] = [];
  for (let i = 0; i < toks.length; i++) {
    if (!LOOP.has(toks[i]!.k)) continue;
    let headEnd: number, end: number;
    if (py) {
      headEnd = i;
      while (headEnd < toks.length && toks[headEnd]!.k !== "NL") headEnd++;
      // The body: from the INDENT after the header to its matching DEDENT.
      let j = headEnd + 1, d = 0;
      if (toks[j]?.k !== "INDENT") continue;
      for (; j < toks.length; j++) {
        if (toks[j]!.k === "INDENT") d++;
        else if (toks[j]!.k === "DEDENT" && --d === 0) break;
      }
      end = j;
    } else {
      if (toks[i + 1]?.t !== "(") continue;
      headEnd = closeOf(toks, i + 1);
      if (toks[headEnd]?.t === "{") end = closeOf(toks, headEnd);
      else {
        end = headEnd;
        while (end < toks.length && toks[end]!.t !== ";") end++;
      }
    }
    out.push({ start: i, line: toks[i]!.line, scan: toks[i]!.k === "for" ? scanTarget(toks.slice(i + 1, headEnd), py) : null, end });
  }
  return out;
}

export function hints(lang: Lang, src: string): Hint[] {
  const toks = tokenize(lang, src);
  const py = lang === "python";
  const ls = loops(toks, py);
  const out: Hint[] = [];
  const seen = new Set<string>();
  const add = (h: Hint) => {
    const key = `${h.kind}:${h.line}`;
    if (!seen.has(key) && out.length < 8) {
      seen.add(key);
      out.push(h);
    }
  };
  const byStart = new Map(ls.map((l) => [l.start, l]));
  const inLoop = (i: number) => ls.filter((l) => l.start < i && i < l.end);

  // Variables that hold lists / strings (for the Python patterns).
  const lists = new Set<string>(), strings = new Set<string>();
  for (let i = 0; i + 2 < toks.length; i++) {
    if (toks[i]!.k === "V" && toks[i + 1]!.t === "=") {
      if (toks[i + 2]!.t === "[" || toks[i + 2]!.t === "list") lists.add(toks[i]!.t);
      if (toks[i + 2]!.k === "S") strings.add(toks[i]!.t);
    }
    if (!py && toks[i]!.t === "String" && toks[i + 1]!.k === "V") strings.add(toks[i + 1]!.t);
  }

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!, outer = inLoop(i);
    if (outer.length === 0) continue;
    // A loop over the same collection (or bound) as an enclosing loop.
    const me = byStart.get(i);
    if (me?.scan) {
      const same = outer.find((o) => o !== me && o.scan === me.scan);
      if (same) {
        add({ line: t.line, kind: "nested-loops", message: `This loop and the one on line ${same.line} both scan all of \`${me.scan}\`: together about n² steps.` });
      }
    }
    const next = toks[i + 1], next2 = toks[i + 2];
    if ((t.t === "sort" || t.t === "sorted") && next?.t === "(") {
      add({ line: t.line, kind: "sort-in-loop", message: "Sorting inside a loop repeats an n log n sort on every iteration." });
    }
    if (py && t.t === "pop" && next?.t === "(" && next2?.k === "N" && next2.t === "0") {
      add({ line: t.line, kind: "pop-front", message: "`pop(0)` shifts every remaining element; `collections.deque.popleft()` takes constant time." });
    }
    if (py && t.t === "in" && next?.k === "V" && lists.has(next.t) && toks[i - 1]?.t !== "for" && !(toks.slice(Math.max(0, i - 4), i).some((x) => x.t === "for"))) {
      add({ line: t.line, kind: "list-membership", message: `\`in ${next.t}\` scans the whole list each time; a set answers in constant time.` });
    }
    if (t.k === "V" && strings.has(t.t) && next?.t === "+=") {
      add({ line: t.line, kind: "string-concat", message: `Growing the string \`${t.t}\` with += in a loop can copy it on every iteration; collect pieces and join once.` });
    }
  }

  // A function that calls itself two or more times, with no memoization in sight.
  const memo = /^(lru_cache|cache|memo\w*|dp|seen|cached|visited)$/;
  for (let i = 0; i + 1 < toks.length; i++) {
    const t = toks[i]!;
    const isDef = py ? t.t === "def" && toks[i + 1]!.k === "V" : t.k === "V" && toks[i + 1]!.t === "(" && i > 0 && /^(int|long|void|bool|double|auto|V|static|public|private|function)$/.test(toks[i - 1]!.k);
    if (!isDef) continue;
    const name = py ? toks[i + 1]!.t : t.t;
    if (name === "main") continue;
    let bodyStart: number, bodyEnd: number;
    if (py) {
      let j = i;
      while (j < toks.length && toks[j]!.k !== "NL") j++;
      if (toks[j + 1]?.k !== "INDENT") continue;
      let d = 0, k = j + 1;
      for (; k < toks.length; k++) {
        if (toks[k]!.k === "INDENT") d++;
        else if (toks[k]!.k === "DEDENT" && --d === 0) break;
      }
      bodyStart = j + 1;
      bodyEnd = k;
    } else {
      const afterParams = closeOf(toks, i + 1);
      if (toks[afterParams]?.t !== "{") continue;
      bodyStart = afterParams;
      bodyEnd = closeOf(toks, afterParams);
    }
    const body = toks.slice(bodyStart, bodyEnd);
    const calls = body.filter((x, n) => x.t === name && body[n + 1]?.t === "(").length;
    const decorated = toks.slice(Math.max(0, i - 6), i).some((x) => memo.test(x.t));
    if (calls >= 2 && !decorated && !body.some((x) => memo.test(x.t))) {
      add({ line: t.line, kind: "unmemoized-recursion", message: `\`${name}\` calls itself ${calls} times per call with no memoization: the calls can grow exponentially.` });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}
