#!/usr/bin/env node
/**
 * Audits every dependency a pull request adds or changes, using public npm metadata only. Nothing is installed or
 * run. Input: the JSON written by guard.mjs (DEPS_OUT). Flags the usual signs of a supply-chain attack:
 *
 *   block   install scripts in the requested version; a name one or two edits away from a dependency we already use
 *           (typosquat); a package or version that doesn't exist; a deprecated version
 *   review  a package created less than 90 days ago or a version published less than 14 days ago; fewer than
 *           5,000 weekly downloads; a single maintainer; no repository link; a version range instead of an exact pin
 *
 *   DEPS_IN=deps.json [APPROVED=1] node scripts/pr-guard/deps-audit.mjs
 */
import { readFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const DAY = 86_400_000;

export function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** Names of every dependency already in the repository's lockfiles on main. */
export function knownNames() {
  const names = new Set();
  const files = execFileSync("git", ["ls-files", "*package-lock.json"], { encoding: "utf8" }).split("\n").filter(Boolean);
  for (const f of files) {
    try {
      for (const k of Object.keys(JSON.parse(readFileSync(f, "utf8")).packages ?? {})) {
        const m = /node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(k);
        if (m) names.add(m[1]);
      }
    } catch {}
  }
  return names;
}

// The version a spec points to. An exact or ^/~ version that doesn't exist resolves to nothing (blocks); only tags
// and other ranges fall back to the latest release, which is what npm would install today.
const pickVersion = (meta, spec) => {
  if (meta.versions?.[spec]) return spec;
  const exact = /^[\^~]?(\d+\.\d+\.\d+(?:-[\w.]+)?)$/.exec(spec);
  if (exact) return meta.versions?.[exact[1]] ? exact[1] : undefined;
  return meta["dist-tags"]?.[spec] ?? meta["dist-tags"]?.latest;
};

export async function audit(deps, { fetchJson, known, now = Date.now() }) {
  const findings = [];
  const add = (level, d, what) => findings.push({ level, dep: `${d.name}@${d.spec}`, file: d.file, what });
  for (const d of deps) {
    if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(d.name)) { add("block", d, "not a valid npm package name"); continue; }
    if (!known.has(d.name)) {
      for (const k of known) {
        const dist = distance(d.name.toLowerCase(), k.toLowerCase());
        if (dist > 0 && dist <= 2 && Math.min(d.name.length, k.length) >= 4) { add("block", d, `name is ${dist} edit(s) from '${k}', which we already use (typosquat?)`); break; }
      }
    }
    if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(d.spec)) add("review", d, "not pinned to an exact version");
    let meta;
    try { meta = await fetchJson(`https://registry.npmjs.org/${d.name.replace("/", "%2F")}`); } catch (e) { add("block", d, `registry lookup failed: ${e.message}`); continue; }
    if (!meta?.versions) { add("block", d, "package does not exist on npm"); continue; }
    const version = pickVersion(meta, d.spec);
    const v = meta.versions[version];
    if (!v) { add("block", d, `version ${d.spec} does not exist`); continue; }
    if (v.deprecated) add("block", d, `version ${version} is deprecated: ${String(v.deprecated).slice(0, 80)}`);
    const scripts = Object.keys(v.scripts ?? {}).filter((k) => /^(pre|post)?install$|^prepare$/.test(k));
    if (scripts.length || v.hasInstallScript) add("block", d, `version ${version} runs install scripts (${scripts.join(", ") || "hasInstallScript"})`);
    const created = Date.parse(meta.time?.created ?? ""), published = Date.parse(meta.time?.[version] ?? "");
    if (now - created < 90 * DAY) add("review", d, `package created ${Math.round((now - created) / DAY)} days ago`);
    if (now - published < 14 * DAY) add("review", d, `version ${version} published ${Math.round((now - published) / DAY)} days ago`);
    if ((meta.maintainers ?? []).length <= 1) add("review", d, "single maintainer");
    if (!v.repository && !meta.repository) add("review", d, "no repository link");
    try {
      const dl = await fetchJson(`https://api.npmjs.org/downloads/point/last-week/${d.name.replace("/", "%2F")}`);
      if ((dl?.downloads ?? 0) < 5000) add("review", d, `${dl?.downloads ?? 0} downloads last week`);
    } catch { add("review", d, "download count unavailable"); }
  }
  return findings;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const deps = JSON.parse(readFileSync(process.env.DEPS_IN ?? "deps.json", "utf8"));
  const approved = process.env.APPROVED === "1";
  const fetchJson = async (u) => { const r = await fetch(u, { signal: AbortSignal.timeout(15_000) }); if (r.status === 404) return null; if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };
  const findings = deps.length ? await audit(deps, { fetchJson, known: knownNames() }) : [];
  const blocking = findings.filter((f) => f.level === "block" || (f.level === "review" && !approved));
  const out = [
    `## Dependency audit: ${!deps.length ? "✅ no dependency changes" : blocking.length ? "❌ blocked" : "✅ passed"}`,
    ...findings.map((f) => `- ${f.level === "block" ? "⛔" : "🔎"} \`${f.dep}\` (${f.file}): ${f.what}`),
  ].join("\n");
  console.log(out);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, out + "\n");
  process.exit(blocking.length ? 1 : 0);
}
