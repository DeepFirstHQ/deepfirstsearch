#!/usr/bin/env node
/**
 * PR guard: static checks on an outside contribution, run on the PR's diff as DATA. It never installs, imports or
 * executes anything from the PR. Used by .github/workflows/pr-guard.yml (pull_request_target, so the guard itself
 * always comes from main and a PR cannot edit it) and by scripts/pr-guard/sandbox-test.sh locally.
 *
 *   BASE_SHA=<base> HEAD_SHA=<head> [APPROVED=1] node scripts/pr-guard/guard.mjs
 *
 * Three levels:
 *   block   — never merge as is, even with approval: invisible/bidi Unicode, install-time scripts, symlinks, binaries,
 *             huge files, encoded blobs. A maintainer must rewrite that part themselves.
 *   review  — sensitive paths and dangerous APIs. Blocks until a maintainer reviews the exact commit and approves it
 *             (APPROVED=1, from the `maintainer-approved` label; the workflow drops the label on every new push).
 *   note    — informational.
 * Exit code 1 if anything blocks.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

// Paths whose changes can run code at install/build/CI time, move money, or ship to users.
const SENSITIVE_PATHS = [
  [/^\.github\//, "CI, workflows and repo settings"],
  [/(^|\/)package(-lock)?\.json$|(^|\/)(npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|\.npmrc|\.yarnrc(\.yml)?)$/, "dependencies, scripts or registry config"],
  [/(^|\/)(tsup|vite|vitest|rollup|webpack|esbuild|babel)\.config\.[cm]?[jt]s$|(^|\/)tsconfig[^/]*\.json$/, "build or test configuration"],
  [/^contracts\/(src|script)\/|(^|\/)foundry\.toml$|^\.gitmodules$/, "contracts, deploy scripts or submodules"],
  [/^sdk\/src\/(x402|policy|wallet|guard|contracts|cli)\//, "signing, policy, wallet or owner-CLI code"],
  [/^integrations\/[^/]+\/src\//, "integration runtime code"],
  [/^scripts\/|^sdk\/scripts\/|(^|\/)[^/]+\.(sh|bash|zsh|ps1|bat)$/, "scripts"],
  [/(^|\/)Dockerfile|(^|\/)\.env/, "container or environment files"],
];

const CODE = /\.(m?[jt]sx?|cjs|cts|sol|sh|bash|py|ya?ml|json|html)$/;
const TEST = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]s$/;

// Dangerous APIs in added code lines. Each needs a human to look at the exact line.
const DANGEROUS = [
  [/\bchild_process\b|\b(execSync|execFile|execFileSync|spawn|spawnSync|fork)\s*\(|\bexec\s*\(/, "process execution"],
  [/\beval\s*\(|\bnew\s+Function\s*\(|\bFunction\s*\(\s*["'`]|\bvm\.(run|Script|compile)|\bnode:vm\b|\bprocess\.binding\b|\bWebAssembly\.(instantiate|compile)/, "dynamic code execution"],
  [/\brequire\s*\(\s*[^"'`\s)]|\bimport\s*\(\s*[^"'`\s)]/, "import from a computed path"],
  [/\b(fetch|axios|got|request|undici)\s*\(\s*["'`]https?:\/\/(?!(127\.0\.0\.1|localhost|(?:[a-z0-9-]+\.)*example(?:\.com|\.org)?)(?=[\/:"'`]|$))/i, "network request to an outside host"],
  [/\bnode:(net|dgram|tls|dns|http2?|https)\b|\brequire\(\s*["'`](net|dgram|tls|dns|http2?|https)["'`]\)|\bnew\s+WebSocket\s*\(/, "raw network or socket access"],
  [/\bos\.homedir\b|\bhomedir\s*\(|process\.env\.HOME\b|["'`]~\/|\.ssh\b|\bid_rsa\b|\bid_ed25519\b|\bkeystores?\b|\.npmrc\b|\.netrc\b|\.aws\/|\.config\/gcloud|Library\/Keychains|\.foundry\b|\bprivate\//i, "access to home directory, credentials or keys"],
  [/process\.env(?!\.(NODE_ENV|CI|AGENT_PAY_[A-Z_]+|RPC_URL|PAYER_KEY|OWNER_PK|AGENT_PK|MERCHANT|BURNER_SEED|FACTORY|STATE_FILE|FEE_JAR|FROM_BLOCK|LOOKBACK_BLOCKS|LARGE_USDC|LOG_PAUSE_MS|TELEGRAM_[A-Z_]+|DISCORD_WEBHOOK_URL)\b)/, "environment variable access"],
  [/\b(atob|btoa)\s*\(|Buffer\.from\([^)]*["'`](base64|hex)["'`]\s*\)\s*\.toString\(\)|String\.fromCharCode\s*\(\s*\.\.\.|\\x[0-9a-f]{2}\\x[0-9a-f]{2}\\x[0-9a-f]{2}/i, "decoding hidden strings"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(mnemonic|seed phrase)\b/i, "key material"],
  [/\b(fs|fsp|promises)\.(rm|rmdir|unlink|writeFile|appendFile|chmod|chown|symlink|rename|cp)\w*\s*\(/, "filesystem writes or deletes"],
  [/\bsetTimeout\s*\(\s*["'`]|\bsetInterval\s*\(\s*["'`]/, "string-evaluated timer"],
  [/\b(curl|wget|nc|bash\s+-c|sh\s+-c|powershell)\b.*(\||https?:)/, "shell download or pipe"],
];
// Install-time hooks run on `npm install` for everyone who installs: never accepted from outside.
const LIFECYCLE = /"(preinstall|install|postinstall|preuninstall|postuninstall|prepare|prepublish|prepublishOnly|prepack|postpack)"\s*:/;
// Invisible and bidirectional characters (Trojan Source, homoglyph tricks).
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿­᠎]/;
const BLOB = /[A-Za-z0-9+/=_-]{160,}/;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_LINE = 400;

const DEP_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "overrides", "resolutions"];
const showJson = (rev, file) => { try { return JSON.parse(git("show", `${rev}:${file}`)); } catch { return null; } };
// Anything that isn't a plain registry version or range: git, URLs, local paths, GitHub shorthand, npm: aliases.
const NON_REGISTRY = /^(git|git\+|https?:|file:|link:|workspace:|npm:|github:|gitlab:|bitbucket:)|^[\w.-]+\/[\w.-]+(#.*)?$/;

/** Dependencies added or changed in one package.json, compared as parsed JSON (not line by line). */
export function dependencyChanges(baseRev, headRev, file) {
  const before = showJson(baseRev, file) ?? {}, after = showJson(headRev, file) ?? {};
  const out = [];
  for (const section of DEP_SECTIONS) {
    const a = before[section] ?? {}, b = after[section] ?? {};
    for (const [name, spec] of Object.entries(b)) {
      if (typeof spec !== "string") { out.push({ section, name, spec: JSON.stringify(spec), was: a[name] }); continue; }
      if (a[name] !== spec) out.push({ section, name, spec, was: a[name] });
    }
  }
  return out;
}

export function analyze(base, head) {
  const findings = [];
  const add = (level, file, line, what, text = "") => findings.push({ level, file, line, what, text: text.slice(0, 140) });
  const mergeBase = git("merge-base", base, head).trim();
  const deps = [];

  for (const row of git("diff", "--raw", "--no-renames", "-z", mergeBase, head).split("\0:").filter(Boolean)) {
    const [meta, file] = row.replace(/^:/, "").split("\0");
    if (!file) continue;
    const [, newMode, , newSha, status] = meta.split(" ");
    if (newMode === "120000") add("block", file, 0, "symlink added");
    if (newMode === "160000") add("review", file, 0, "submodule pointer changed");
    if (status === "D") { add("note", file, 0, "file deleted"); continue; }
    for (const [re, why] of SENSITIVE_PATHS) if (re.test(file)) { add("review", file, 0, `sensitive path: ${why}`); break; }
    if (/(^|\/)package\.json$/.test(file)) {
      for (const d of dependencyChanges(mergeBase, head, file)) {
        deps.push({ file, ...d });
        if (NON_REGISTRY.test(d.spec)) add("block", file, 0, `dependency ${d.name} comes from outside the npm registry`, d.spec);
        else add("review", file, 0, `${d.was === undefined ? "new" : "changed"} ${d.section} entry ${d.name}@${d.spec}${d.was ? ` (was ${d.was})` : ""}`);
      }
    }
    if (newSha && !/^0+$/.test(newSha) && newMode !== "160000") {
      const size = Number(git("cat-file", "-s", newSha).trim());
      if (size > MAX_FILE_BYTES) add("block", file, 0, `file is ${Math.round(size / 1024)} KiB (limit ${MAX_FILE_BYTES / 1024} KiB)`);
    }
  }

  const numstat = git("diff", "--numstat", "--no-renames", mergeBase, head);
  for (const l of numstat.split("\n").filter(Boolean)) {
    const [a, d, file] = l.split("\t");
    if (a === "-" && d === "-") add("block", file, 0, "binary file");
  }

  let file = "", line = 0;
  for (const l of git("diff", "-U0", "--no-renames", "--no-color", mergeBase, head).split("\n")) {
    if (l.startsWith("+++ ")) { file = l.slice(6); continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (!l.startsWith("+") || l.startsWith("+++")) continue;
    const text = l.slice(1);
    const isLock = /package-lock\.json$|yarn\.lock$|pnpm-lock\.yaml$/.test(file);
    if (INVISIBLE.test(text)) add("block", file, line, "invisible or bidirectional Unicode character", JSON.stringify(text));
    if (/package\.json$/.test(file) && LIFECYCLE.test(text)) add("block", file, line, "install-time lifecycle script", text);
    // Lockfile injection: a package resolved from anywhere but the public npm registry.
    const resolved = /"resolved"\s*:\s*"([^"]+)"/.exec(text);
    if (resolved && isLock && !/^https:\/\/registry\.npmjs\.org\//.test(resolved[1])) add("block", file, line, "lockfile resolves a package outside registry.npmjs.org", resolved[1]);
    if (isLock && /"(hasInstallScript)"\s*:\s*true/.test(text)) add("review", file, line, "a locked package has install scripts (blocked at install by --ignore-scripts; check why it's needed)", text.trim());
    if (!isLock && BLOB.test(text)) add("block", file, line, "long encoded blob", text);
    if (!isLock && CODE.test(file) && text.length > MAX_LINE) add("block", file, line, `line of ${text.length} characters (minified or obfuscated?)`, text);
    if (CODE.test(file) && !isLock) {
      for (const [re, why] of DANGEROUS) if (re.test(text)) add("review", file, line, `${why}${TEST.test(file) ? " (in a test: tests run in CI)" : ""}`, text.trim());
    }
    line++;
  }
  analyze.deps = deps;
  return findings;
}

function report(findings, approved) {
  const effective = findings.map((f) => ({ ...f, blocking: f.level === "block" || (f.level === "review" && !approved) }));
  const blocking = effective.filter((f) => f.blocking);
  const icon = { block: "⛔", review: "🔎", note: "ℹ️" };
  const lines = [
    `## PR guard: ${blocking.length ? "❌ blocked" : "✅ passed"}`,
    approved ? "Maintainer approval present for this exact commit: review-level findings are accepted." : "No maintainer approval for this commit yet: review-level findings block.",
    "",
    findings.length ? "| | File | Line | Finding | Text |\n|---|---|---|---|---|" : "No findings.",
    ...findings.map((f) => `| ${icon[f.level]} | \`${f.file}\` | ${f.line || ""} | ${f.what} | ${f.text ? "`" + f.text.replace(/[|`]/g, "'") + "`" : ""} |`),
  ];
  const out = lines.join("\n");
  console.log(out);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, out + "\n");
  return blocking.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { BASE_SHA, HEAD_SHA, APPROVED } = process.env;
  if (!BASE_SHA || !HEAD_SHA || !/^[0-9a-f]{7,40}$/.test(BASE_SHA) || !/^[0-9a-f]{7,40}$/.test(HEAD_SHA)) {
    console.error("set BASE_SHA and HEAD_SHA (hex commit ids)");
    process.exit(2);
  }
  const findings = analyze(BASE_SHA, HEAD_SHA);
  if (process.env.DEPS_OUT) writeFileSync(process.env.DEPS_OUT, JSON.stringify(analyze.deps ?? [], null, 1));
  process.exit(report(findings, APPROVED === "1"));
}
