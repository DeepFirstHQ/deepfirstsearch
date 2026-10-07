// Tests for the dependency audit with a fake registry (no network). Run: node --test scripts/pr-guard/deps-audit.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { audit, distance } from "./deps-audit.mjs";

const NOW = Date.parse("2026-10-07T00:00:00Z");
const old = "2018-01-01T00:00:00Z";
const pkg = (name, version, extra = {}) => ({
  name, "dist-tags": { latest: version }, maintainers: [{ name: "a" }, { name: "b" }], repository: { url: "git+https://github.com/x/y" },
  time: { created: old, [version]: old }, versions: { [version]: { name, version, ...extra.v } }, ...extra.meta,
});
const registry = {
  "https://registry.npmjs.org/zod": pkg("zod", "3.25.0"),
  "https://registry.npmjs.org/viemm": pkg("viemm", "2.0.0"),
  "https://registry.npmjs.org/helper-x": pkg("helper-x", "1.0.0", { v: { scripts: { postinstall: "node steal.js" } } }),
  "https://registry.npmjs.org/fresh-lib": pkg("fresh-lib", "0.0.1", { meta: { time: { created: "2026-10-01T00:00:00Z", "0.0.1": "2026-10-06T00:00:00Z" }, maintainers: [{ name: "a" }] } }),
};
const downloads = { zod: 9_000_000, viemm: 12, "helper-x": 40, "fresh-lib": 3 };
const fetchJson = async (u) => {
  if (u.startsWith("https://api.npmjs.org/")) return { downloads: downloads[decodeURIComponent(u.split("/").pop())] ?? 0 };
  return registry[u.replace("%2F", "/")] ?? null;
};
const run = (deps) => audit(deps.map((d) => ({ file: "x/package.json", ...d })), { fetchJson, known: new Set(["viem", "zod", "vitest"]), now: NOW });
const has = (f, level, re) => f.some((x) => x.level === level && re.test(x.what));

test("edit distance", () => { assert.equal(distance("viem", "viemm"), 1); assert.equal(distance("zod", "zod"), 0); });

test("an established, pinned dependency we already use passes", async () => {
  assert.deepEqual(await run([{ name: "zod", spec: "3.25.0" }]), []);
});

test("a typosquat of a dependency we use blocks", async () => {
  assert.ok(has(await run([{ name: "viemm", spec: "2.0.0" }]), "block", /edit\(s\) from 'viem'/));
});

test("install scripts in the requested version block", async () => {
  assert.ok(has(await run([{ name: "helper-x", spec: "1.0.0" }]), "block", /install scripts/));
});

test("brand-new, unpopular, single-maintainer, unpinned packages are flagged for review", async () => {
  const f = await run([{ name: "fresh-lib", spec: "^0.0.1" }]);
  for (const re of [/created \d+ days ago/, /published \d+ days ago/, /downloads last week/, /single maintainer/, /not pinned/]) assert.ok(has(f, "review", re), re.source);
});

test("a package or version that doesn't exist blocks", async () => {
  assert.ok(has(await run([{ name: "does-not-exist-xyz", spec: "1.0.0" }]), "block", /does not exist/));
  assert.ok(has(await run([{ name: "zod", spec: "9.9.9" }]), "block", /version 9\.9\.9 does not exist/));
});
