import { USDC, type PaymentRequired, type Requirement } from "./x402.js";

export type LintFinding = { level: "danger" | "warn" | "info"; code: string; message: string };
export type LintReport = { url: string; status: number; findings: LintFinding[]; required?: PaymentRequired };

/** Reads a 402's PAYMENT-REQUIRED header or body, with no signing and no payment. */
function readRequired(status: number, headerValue: string | null, body: string): PaymentRequired | undefined {
  const tryParse = (s: string | null): PaymentRequired | undefined => {
    if (!s) return undefined;
    try {
      const o = JSON.parse(/^[A-Za-z0-9+/=]+$/.test(s.trim()) ? Buffer.from(s, "base64").toString("utf8") : s);
      return Array.isArray(o?.accepts) ? (o as PaymentRequired) : undefined;
    } catch {
      return undefined;
    }
  };
  return tryParse(headerValue) ?? tryParse(body);
}

/** Flags the traps in a 402's own terms — the ones that fool a naive buyer. No client needed; runs on any live URL. */
export function lintRequired(required: PaymentRequired): LintFinding[] {
  const f: LintFinding[] = [];
  const accepts = required.accepts ?? [];
  if (accepts.length === 0) return [{ level: "info", code: "no_terms", message: "no payment requirements found" }];
  if (accepts.length > 1) f.push({ level: "info", code: "multi_option", message: `${accepts.length} payment options offered; a buyer should pin which network and asset it will pay` });
  const networks = new Set(accepts.map((a) => a.network));
  if (networks.size > 1) f.push({ level: "warn", code: "multi_network", message: `offers payment on ${[...networks].join(", ")}; a buyer that signs the first option may pay on an unexpected chain` });
  for (const a of accepts) lintRequirement(a, f);
  return f;
}

function lintRequirement(a: Requirement, f: LintFinding[]): void {
  const extra = (a.extra ?? {}) as Record<string, unknown>;
  const primaryType = String(extra.primaryType ?? extra.type ?? "");
  const method = String(extra.assetTransferMethod ?? "");
  if (/permit/i.test(primaryType) || /permit/i.test(method)) {
    f.push({ level: "danger", code: "permit", message: "asks the buyer to sign an ERC-2612 Permit (an approval, often unlimited). A buyer should never sign a Permit from a 402; the exact scheme uses TransferWithAuthorization." });
  }
  const knownUsdc = Object.values(USDC).includes(a.asset?.toLowerCase() as never);
  if (extra.decimals !== undefined && knownUsdc && Number(extra.decimals) !== 6) {
    f.push({ level: "danger", code: "declared_decimals", message: `declares extra.decimals=${extra.decimals} for USDC (which has 6). A buyer that prices with the declared decimals can be tricked into signing far more than it thinks.` });
  } else if (extra.decimals !== undefined) {
    f.push({ level: "warn", code: "declared_decimals", message: `declares its own extra.decimals=${extra.decimals}; a buyer should price from a local table for known assets, not this field.` });
  }
  const timeout = Number(a.maxTimeoutSeconds ?? 0);
  if (timeout > 3600) f.push({ level: "warn", code: "long_timeout", message: `authorization validity is ${Math.round(timeout / 86400)} days; a buyer should cap it to minutes.` });
  if (!extra.name || !extra.version) f.push({ level: "info", code: "missing_domain", message: "no EIP-712 name/version in extra; a buyer should pin the token's domain locally rather than trust the server." });
}

/** The most we read from an endpoint or its header; past this a payment challenge isn't legitimate, and we refuse to buffer it. */
const MAX_BODY_BYTES = 256 * 1024;
const MAX_HEADER_CHARS = 128 * 1024;

/** Reads at most `max` bytes of a response body, so a hostile endpoint can't make the tool buffer an unbounded response. */
async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return (await res.text().catch(() => "")).slice(0, max);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        size += value.length;
        if (size >= max) {
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
    }
  } catch {
    /* network/stream error: lint what we have */
  }
  return Buffer.concat(chunks).toString("utf8").slice(0, max);
}

/** Fetches a URL and lints the 402 it returns (if any). Read-only; redirects are not followed; the body is size-capped. */
export async function lint(url: string, opts: { method?: string; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<LintReport> {
  const res = await fetch(url, { method: opts.method ?? "GET", headers: opts.headers, redirect: "manual", signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
  const body = await readCapped(res, MAX_BODY_BYTES);
  if (res.status !== 402) {
    return { url, status: res.status, findings: [{ level: "info", code: "no_402", message: `HTTP ${res.status}: no payment required (the endpoint showed no 402 to this request)` }] };
  }
  const headerValue = (res.headers.get("PAYMENT-REQUIRED") ?? res.headers.get("payment-required"))?.slice(0, MAX_HEADER_CHARS) ?? null;
  const required = readRequired(res.status, headerValue, body);
  if (!required) return { url, status: 402, findings: [{ level: "warn", code: "unreadable", message: "402 returned, but its payment terms could not be read (no PAYMENT-REQUIRED header or accepts body)" }] };
  return { url, status: 402, findings: lintRequired(required), required };
}
