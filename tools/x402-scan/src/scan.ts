import { ATTACKS, DEFAULTS, type Expected } from "./attacks.js";
import { startAttackServer } from "./server.js";

/** What the dev wires: a function that makes one paid request through their client to the given URL. */
export type PayingFetch = (url: string) => Promise<unknown>;

export type AttackResult = {
  id: string;
  title: string;
  threat: string;
  pass: boolean;
  detail: string;
  fix: string;
  control: boolean;
};

export type ScanReport = {
  results: AttackResult[];
  /** Safety tests failed (the control is excluded). */
  failures: number;
  /** Safety tests run (excludes the control). */
  tests: number;
  grade: "A" | "B" | "C" | "D" | "F" | "n/a";
  /** True when the control passed and no safety test failed. */
  safe: boolean;
};

function grade(failures: number, tests: number, controlOk: boolean): ScanReport["grade"] {
  if (!controlOk) return "n/a";
  if (failures === 0) return "A";
  const ratio = failures / Math.max(tests, 1);
  if (ratio <= 0.2) return "B";
  if (ratio <= 0.4) return "C";
  if (ratio <= 0.6) return "D";
  return "F";
}

/**
 * Runs the adversarial battery against a buyer client and reports what it falls for. The client is pointed at a local
 * attack server (one fixed origin, so a payee-pinning client can be configured for it) that presents each tampered 402
 * in turn; the scanner reads what the client signed. Nothing is settled, no chain is touched.
 *
 * Pass a FACTORY that creates a fresh client per attack, so a stateful client (nonce tracking, a cache of settled
 * calls) can't let one attack suppress the next and look safe by accident. Wire the client to pay the honest baseline
 * (payee `DEFAULTS.payTo`, 0.01 USDC, Base Sepolia, on the scanner's origin) with your normal settings:
 *
 * ```ts
 * const report = await scan(() => createMyClient().fetch, { port: 8788 });
 * ```
 */
export async function scan(makePayingFetch: () => PayingFetch | Promise<PayingFetch>, opts: { expected?: Partial<Expected>; port?: number } = {}): Promise<ScanReport> {
  const expected: Expected = { ...DEFAULTS, ...opts.expected };
  const port = opts.port ?? 8788;
  const results: AttackResult[] = [];
  for (const attack of ATTACKS) {
    // Same origin (so a payee-pinning client can be configured for it), distinct path per attack (so a client cannot
    // reuse a cached response from an earlier attack).
    const server = await startAttackServer(attack.requirement(expected), { port, path: `/probe/${attack.id}` });
    try {
      const payingFetch = await makePayingFetch(); // a fresh client for this attack, so prior attacks can't suppress it
      await payingFetch(server.url).catch(() => undefined); // a refusal (throw) is the safe outcome
    } finally {
      const v = attack.verdict(server.signed, expected);
      results.push({ id: attack.id, title: attack.title, threat: attack.threat, pass: v.pass, detail: v.detail, fix: attack.fix, control: !!attack.control });
      await server.close();
    }
  }
  const controlOk = results.find((r) => r.control)?.pass ?? false;
  const safetyResults = results.filter((r) => !r.control);
  const failures = safetyResults.filter((r) => !r.pass).length;
  return { results, failures, tests: safetyResults.length, grade: grade(failures, safetyResults.length, controlOk), safe: controlOk && failures === 0 };
}

/** A plain-text report, for a CLI or a log. */
export function formatReport(report: ScanReport): string {
  const lines: string[] = [];
  const mark = (r: AttackResult) => (r.control ? (r.pass ? "·" : "!") : r.pass ? "✓" : "✗");
  for (const r of report.results) {
    lines.push(`${mark(r)} ${r.title}${r.control ? " (control)" : ""}`);
    lines.push(`    ${r.detail}`);
    if (!r.pass && !r.control) lines.push(`    fix: ${r.fix}`);
  }
  lines.push("");
  lines.push(report.grade === "n/a"
    ? "Grade: n/a — the control failed, so wire your client to pay the baseline first."
    : `Grade: ${report.grade} — ${report.failures} of ${report.tests} safety checks failed.`);
  return lines.join("\n");
}
