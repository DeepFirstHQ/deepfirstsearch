import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

export type AuditEvent = {
  type:
    | "payment.denied"
    | "payment.approval_requested"
    | "payment.approval_refused"
    | "payment.signed"
    | "payment.settled"
    | "payment.settled_onchain"
    | "payment.settled_by_merchant"
    | "payment.expired_unused"
    | "payment.forgotten"
    | "payment.failed"
    | "payment.retry"
    | "plan.sealed";
  [key: string]: unknown;
};

export type AuditEntry = { seq: number; ts: number; prev: string; hash: string; event: AuditEvent };

const GENESIS = "0".repeat(64);

function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === "bigint") return v.toString();
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)));
    }
    return v;
  });
}

function entryHash(seq: number, ts: number, prev: string, event: AuditEvent): string {
  return createHash("sha256").update(canonical({ seq, ts, prev, event })).digest("hex");
}

/**
 * Tamper-evident, hash-chained log of every payment decision. Editing or deleting any entry breaks the chain.
 * It is the owner's record for audits and tax; nothing is sent anywhere. Pass `file` to append JSONL to disk.
 */
export class AuditLog {
  readonly entries: AuditEntry[] = [];

  constructor(private readonly file?: string) {}

  append(event: AuditEvent, ts = Date.now()): AuditEntry {
    const prev = this.entries.at(-1)?.hash ?? GENESIS;
    const seq = this.entries.length;
    const entry: AuditEntry = { seq, ts, prev, hash: entryHash(seq, ts, prev, event), event };
    this.entries.push(entry);
    if (this.file) appendFileSync(this.file, canonical(entry) + "\n", { mode: 0o600 });
    return entry;
  }
}

/** Returns the index of the first broken entry, or -1 if the whole chain is intact. */
export function verifyChain(entries: AuditEntry[]): number {
  let prev = GENESIS;
  for (const [i, e] of entries.entries()) {
    if (e.seq !== i || e.prev !== prev || e.hash !== entryHash(e.seq, e.ts, e.prev, e.event)) return i;
    prev = e.hash;
  }
  return -1;
}

export function parseJsonl(text: string): AuditEntry[] {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AuditEntry);
}
