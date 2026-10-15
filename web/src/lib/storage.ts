// localStorage can throw (private mode, quota, disabled storage): every
// access is wrapped and failures degrade to "not persisted".

export function load(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function save(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function loadJSON<T>(key: string, fallback: T): T {
  const raw = load(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const draftKey = (slug: string, lang: string) => `codejudge:draft:${slug}:${lang}`;

export const drafts = {
  get: (slug: string, lang: string) => load(draftKey(slug, lang)),
  set: (slug: string, lang: string, code: string) => save(draftKey(slug, lang), code),
};

export const theme = {
  get: (): "dark" | "light" | null => {
    const v = load("codejudge:theme");
    return v === "dark" || v === "light" ? v : null;
  },
  set: (v: "dark" | "light") => save("codejudge:theme", v),
};

export interface EditorSettings {
  fontSize: number;
  tabSize: number;
  wordWrap: boolean;
}

export interface Prefs {
  language: string | null;
  editor: EditorSettings;
  /** Problem page layout: statement width and editor height, in percent. */
  layout: { statement: number; editor: number };
}

export const DEFAULT_PREFS: Prefs = {
  language: null,
  editor: { fontSize: 14, tabSize: 4, wordWrap: false },
  layout: { statement: 45, editor: 65 },
};

const clamp = (x: unknown, lo: number, hi: number, d: number) => (typeof x === "number" && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d);

/** Saved preferences, validated field by field (a corrupt entry falls back to the defaults). */
export const prefs = {
  get(): Prefs {
    const raw = loadJSON<Partial<Prefs>>("codejudge:prefs", {});
    const e = (raw.editor ?? {}) as Partial<EditorSettings>;
    const l = (raw.layout ?? {}) as Partial<Prefs["layout"]>;
    return {
      language: typeof raw.language === "string" ? raw.language : null,
      editor: {
        fontSize: clamp(e.fontSize, 10, 24, DEFAULT_PREFS.editor.fontSize),
        tabSize: [2, 4, 8].includes(e.tabSize as number) ? (e.tabSize as number) : DEFAULT_PREFS.editor.tabSize,
        wordWrap: typeof e.wordWrap === "boolean" ? e.wordWrap : DEFAULT_PREFS.editor.wordWrap,
      },
      layout: {
        statement: clamp(l.statement, 20, 75, DEFAULT_PREFS.layout.statement),
        editor: clamp(l.editor, 25, 85, DEFAULT_PREFS.layout.editor),
      },
    };
  },
  set(p: Prefs) {
    return save("codejudge:prefs", JSON.stringify(p));
  },
};
