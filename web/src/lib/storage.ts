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
