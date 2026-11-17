/**
 * Normalizing lexers for similarity detection (docs/INSIGHTS.md, M2).
 *
 * Output: a token stream where identifiers become "V", numbers "N", strings
 * and characters "S"; keywords and operators stay as they are. Comments,
 * whitespace, and boilerplate lines (#include, import, package, using) are
 * dropped. Renaming variables, changing literals, reformatting or editing
 * comments therefore changes nothing. Python also yields INDENT/DEDENT and
 * NL tokens, since its block structure is in the whitespace.
 */
export interface Token {
  k: string; // normalized kind
  line: number; // 1-based source line
  t: string; // the original text (hints read names; similarity uses k only)
}

export type Lang = "c" | "cpp" | "go" | "python" | "java" | "javascript";

const KEYWORDS: Record<Lang, string[]> = {
  c: "auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while bool true false NULL".split(" "),
  cpp: "alignas alignof auto bool break case catch char class const constexpr const_cast continue decltype default delete do double dynamic_cast else enum explicit extern false float for friend goto if inline int long mutable namespace new noexcept nullptr operator private protected public register reinterpret_cast return short signed sizeof static static_cast struct switch template this throw true try typedef typename union unsigned using virtual void volatile while vector map set pair string queue deque priority_queue stack unordered_map unordered_set".split(" "),
  java: "abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new null package private protected public return short static super switch synchronized this throw throws transient try void volatile while true false var String".split(" "),
  javascript: "await break case catch class const continue debugger default delete do else export extends false finally for function if import in instanceof let new null return super switch this throw true try typeof undefined var void while with yield of".split(" "),
  go: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil int int64 string byte rune bool float64 len append make".split(" "),
  python: "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield range len print int list dict set str".split(" "),
};

const OPS = ["<<=", ">>=", "**=", "//=", "...", "===", "!==", ">>>", "->", "::", "<<", ">>", "<=", ">=", "==", "!=", "&&", "||", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", ":=", "**", "//", "=>"];

/** Lines that are the same in every program of a language. */
const BOILERPLATE: Record<Lang, RegExp> = {
  c: /^\s*#/,
  cpp: /^\s*(#|using\s+namespace\b)/,
  java: /^\s*(import|package)\b/,
  javascript: /^\s*("use strict"|'use strict')/,
  go: /^\s*(package|import)\b/,
  python: /^\s*(import|from\s+\S+\s+import)\b/,
};

export function tokenize(lang: Lang, src: string): Token[] {
  const kw = new Set(KEYWORDS[lang]);
  const out: Token[] = [];
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const py = lang === "python";
  const indents = [0];
  let depth = 0; // open brackets: Python ignores newlines inside them
  let block: string | null = null; // the closing delimiter of a multi-line comment or string

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    const ln = li + 1;
    let i = 0;
    if (block === null && BOILERPLATE[lang].test(line) && !(lang === "go" && /^\s*import\s*\($/.test(line))) continue;
    if (py && block === null && depth === 0) {
      const body = line.trim();
      if (body === "" || body.startsWith("#")) continue;
      const ind = line.length - line.trimStart().length;
      if (ind > indents.at(-1)!) {
        indents.push(ind);
        out.push({ k: "INDENT", line: ln, t: "" });
      }
      while (ind < indents.at(-1)!) {
        indents.pop();
        out.push({ k: "DEDENT", line: ln, t: "" });
      }
    }
    while (i < line.length) {
      if (block !== null) {
        const end = line.indexOf(block, i);
        if (end < 0) {
          i = line.length;
          break;
        }
        i = end + block.length;
        block = null;
        continue;
      }
      const c = line[i]!;
      const rest = line.slice(i);
      if (c === " " || c === "\t") {
        i++;
      } else if (py ? c === "#" : rest.startsWith("//")) {
        break;
      } else if (!py && rest.startsWith("/*")) {
        block = "*/";
        i += 2;
      } else if (py && /^[rbfuRBFU]{0,2}("""|''')/.test(rest)) {
        const q = rest.match(/^[rbfuRBFU]{0,2}("""|''')/)!;
        out.push({ k: "S", line: ln, t: q[0] });
        block = q[1]!;
        i += q[0].length;
      } else if (c === '"' || c === "'" || c === "`" || (py && /^[rbfuRBFU]{1,2}["']/.test(rest))) {
        const start = i;
        while (/[rbfuRBFU]/.test(line[i]!)) i++;
        const q = line[i]!;
        i++;
        while (i < line.length && line[i] !== q) i += line[i] === "\\" ? 2 : 1;
        if (i >= line.length && q === "`") block = "`"; // JS/Go raw string spanning lines
        i++;
        out.push({ k: "S", line: ln, t: line.slice(start, i) });
      } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(line[i + 1] ?? ""))) {
        const m = rest.match(/^(0[xXbBoO][0-9a-fA-F_]+|[0-9_]*\.?[0-9_]+([eE][+-]?[0-9]+)?)[a-zA-Z]*/)!;
        i += m[0].length || 1;
        out.push({ k: "N", line: ln, t: m[0] });
      } else if (/[A-Za-z_$]/.test(c)) {
        const m = rest.match(/^[A-Za-z_$][A-Za-z0-9_$]*/)!;
        i += m[0].length;
        out.push({ k: kw.has(m[0]) ? m[0] : "V", line: ln, t: m[0] });
      } else {
        const op = OPS.find((o) => rest.startsWith(o)) ?? c;
        i += op.length;
        if ("([{".includes(op)) depth++;
        if (")]}".includes(op)) depth = Math.max(0, depth - 1);
        if (op !== ";" || !py) out.push({ k: op, line: ln, t: op });
      }
    }
    if (py && block === null && depth === 0 && out.length && out.at(-1)!.k !== "NL") out.push({ k: "NL", line: ln, t: "" });
  }
  return out;
}
