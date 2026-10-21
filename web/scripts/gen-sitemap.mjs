// Writes dist/sitemap.xml after `vite build`: the landing page, the problem
// list and one URL per public problem package (../problems/<slug>/problem.yaml).
// The origin is left as a Caddy template ({{env `CODEJUDGE_DOMAIN`}}), filled in
// when Caddy serves the file (deploy/Caddyfile), so no domain is in source.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const web = join(import.meta.dirname, "..");
const problemsDir = join(web, "..", "problems");
const ORIGIN = "https://{{env `CODEJUDGE_DOMAIN`}}";

const slugs = readdirSync(problemsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(problemsDir, d.name, "problem.yaml")))
  .map((d) => {
    const id = /^id:\s*(\S+)\s*$/m.exec(readFileSync(join(problemsDir, d.name, "problem.yaml"), "utf8"))?.[1];
    if (id !== d.name) throw new Error(`problems/${d.name}/problem.yaml: id ${id} does not match the directory`);
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`problems/${d.name}: slug ${id} is not URL-safe`);
    return id;
  })
  .sort();
if (slugs.length === 0) throw new Error(`no problem packages under ${problemsDir}`);

const paths = ["/", "/problems", ...slugs.map((s) => `/problems/${s}`)];
const xml = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...paths.map((p) => `  <url><loc>${ORIGIN}${p}</loc></url>`),
  "</urlset>",
  "",
].join("\n");
writeFileSync(join(web, "dist", "sitemap.xml"), xml);
console.log(`sitemap.xml: ${paths.length} URLs (${slugs.length} problems)`);
