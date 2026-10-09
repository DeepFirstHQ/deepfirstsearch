#!/usr/bin/env node
// Newcomer check (#26): install the packages the way a user does (packed tarballs + the documented install line, in an
// empty ESM project) and run the docs' offline examples verbatim. Offline only: local mock merchants, throwaway keys,
// no funds, no chain. Usage: node scripts/newcomer/run.mjs  (after building sdk/ and the integrations).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const sh = (cmd, args, cwd, opts = {}) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });

// Pack each local package once, as npm would publish it.
const packDir = mkdtempSync(join(tmpdir(), "newcomer-pack-"));
const tarball = {};
for (const [name, dir] of [["@deepfirstsearch/agent-pay", "sdk"], ["@deepfirstsearch/agent-pay-ai-sdk", "integrations/ai-sdk"], ["@deepfirstsearch/agent-pay-langchain", "integrations/langchain"], ["@deepfirstsearch/agent-pay-agentkit", "integrations/agentkit"]]) {
  const out = sh("npm", ["pack", "--silent", "--pack-destination", packDir], join(ROOT, dir)).trim().split("\n").pop();
  tarball[name] = join(packDir, out);
}

/** The first ```ts block after a heading, verbatim. */
function snippet(file, heading) {
  const md = readFileSync(join(ROOT, file), "utf8");
  const at = md.indexOf(heading);
  if (at < 0) throw new Error(`${file}: heading not found: ${heading}`);
  const m = /```ts\n([\s\S]*?)```/.exec(md.slice(at));
  if (!m) throw new Error(`${file}: no ts block after ${heading}`);
  return m[1];
}

const CASES = [
  { name: "SDK: test without a chain", file: "docs/DEVELOPERS.md", heading: "## Test without a chain", install: ["@deepfirstsearch/agent-pay", "viem"], expect: [/\b200\b/, /payment denied/] },
  { name: "Vercel AI SDK offline", file: "integrations/ai-sdk/README.md", heading: "## Try it offline", install: ["@deepfirstsearch/agent-pay-ai-sdk", "@deepfirstsearch/agent-pay", "ai", "zod", "viem"], expect: [/payee_mismatch/], exactOptional: true },
  { name: "LangChain offline", file: "integrations/langchain/README.md", heading: "## Try it offline", install: ["@deepfirstsearch/agent-pay-langchain", "@deepfirstsearch/agent-pay", "@langchain/core", "@langchain/langgraph", "viem"], expect: [/payee_mismatch/], exactOptional: true },
  { name: "Coinbase AgentKit offline", file: "integrations/agentkit/README.md", heading: "## Try it offline", install: ["@deepfirstsearch/agent-pay-agentkit", "@deepfirstsearch/agent-pay", "@coinbase/agentkit", "viem@2.38.3", "zod@3"], expect: [/payee_mismatch/] },
];

let failed = 0;
for (const c of CASES) {
  const dir = mkdtempSync(join(tmpdir(), "newcomer-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "newcomer", private: true, type: "module" }));
    const specs = c.install.map((p) => tarball[p] ?? p);
    sh("npm", ["install", "--no-audit", "--no-fund", ...specs, "tsx", "typescript@5"], dir);
    writeFileSync(join(dir, "offline.ts"), snippet(c.file, c.heading));
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, exactOptionalPropertyTypes: Boolean(c.exactOptional), skipLibCheck: true, noEmit: true }, include: ["offline.ts"] }));
    sh("npx", ["tsc", "-p", "."], dir);
    const out = sh("npx", ["tsx", "offline.ts"], dir, { timeout: 120_000 });
    const missing = c.expect.filter((re) => !re.test(out));
    if (missing.length) throw new Error(`output did not match ${missing.join(", ")}:\n${out.slice(0, 800)}`);
    console.log(`ok   ${c.name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${c.name}\n${(e.stdout || "") + (e.stderr || "") || e.message}`.slice(0, 3000));
  }
}
process.exit(failed ? 1 : 0);
