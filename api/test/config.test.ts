import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.ts";
import { devEnv } from "./helpers.ts";

const prod = {
  NODE_ENV: "production",
  PUBLIC_ORIGIN: "https://codejudge.dhruvgoyal.tech",
  GITHUB_REDIRECT_URI: "https://codejudge.dhruvgoyal.tech/api/auth/github/callback",
  TRUST_PROXY: "1",
  GITHUB_CLIENT_ID: "x",
  GITHUB_CLIENT_SECRET: "y",
};

describe("production configuration", () => {
  it("the deploy settings load: one trusted proxy hop, https origin", () => {
    const c = loadConfig({ ...devEnv(), ...prod });
    expect(c.TRUST_PROXY).toBe(1);
    expect(c.PUBLIC_ORIGIN).toBe("https://codejudge.dhruvgoyal.tech");
  });

  it.each([
    ["TRUST_PROXY unset", { TRUST_PROXY: undefined }, /TRUST_PROXY/],
    ["TRUST_PROXY=false", { TRUST_PROXY: "false" }, /TRUST_PROXY/],
    ["http origin", { PUBLIC_ORIGIN: "http://codejudge.dhruvgoyal.tech" }, /PUBLIC_ORIGIN/],
    ["no GitHub secret", { GITHUB_CLIENT_SECRET: undefined }, /GITHUB_CLIENT_SECRET/],
    ["the localhost callback default", { GITHUB_REDIRECT_URI: undefined }, /GITHUB_REDIRECT_URI/],
    ["a callback on another host", { GITHUB_REDIRECT_URI: "https://judge.dhruvgoyal.tech/api/auth/github/callback" }, /GITHUB_REDIRECT_URI/],
  ])("refuses to start with %s", (_name, override, message) => {
    const env: Record<string, string | undefined> = { ...devEnv(), ...prod, ...override };
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    expect(() => loadConfig(env)).toThrow(message);
  });
});
