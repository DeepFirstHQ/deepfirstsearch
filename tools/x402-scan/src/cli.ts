#!/usr/bin/env node
import { lint, type LintFinding } from "./lint.js";

const USAGE = `x402-scan — safety checks for x402 buyer clients

  x402-scan lint <url>     Fetch a live endpoint and flag the traps in its 402 (no payment, no key).
                           Add -X POST and -d '<body>' for a POST route.

To attack your own client (does it pin the payee, resist the decimals trick, cap the price?), use the library:

  import { scan, formatReport } from "@deepfirstsearch/x402-scan";
  const report = await scan((url) => myPayingClient(url));
  console.log(formatReport(report));

See the README. The fix for everything it flags is a payee-pinning, budgeted policy layer (e.g. Agent Safe).`;

const icon = (l: LintFinding["level"]) => (l === "danger" ? "✗" : l === "warn" ? "!" : "·");

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd !== "lint" || rest.length === 0) {
    console.log(USAGE);
    return cmd && cmd !== "lint" ? 2 : 0;
  }
  let method = "GET";
  let body: string | undefined;
  const urls: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "-X") method = rest[++i] ?? "GET";
    else if (rest[i] === "-d") body = rest[++i];
    else urls.push(rest[i]!);
  }
  const url = urls[0];
  if (!url) {
    console.log(USAGE);
    return 2;
  }
  try {
    const report = await lint(url, { method, ...(body !== undefined ? { headers: { "content-type": "application/json" }, method: method === "GET" ? "POST" : method } : {}) });
    console.log(`x402-scan lint ${report.url} → HTTP ${report.status}\n`);
    for (const f of report.findings) console.log(`${icon(f.level)} [${f.code}] ${f.message}`);
    const dangers = report.findings.filter((f) => f.level === "danger").length;
    console.log(`\n${dangers > 0 ? `${dangers} dangerous trap(s) in this 402.` : "No dangerous traps in this 402's terms."}`);
    return dangers > 0 ? 1 : 0;
  } catch (e) {
    console.error(`x402-scan: ${(e as Error).message}`);
    return 1;
  }
}

main(process.argv.slice(2)).then((c) => process.exit(c));
