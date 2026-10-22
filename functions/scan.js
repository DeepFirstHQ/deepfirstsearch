// Hosted x402 lint — Cloudflare Pages Function at /scan.
// Paste an x402 endpoint URL and see the traps in its 402 terms, server-side, no install.
// Read-only: one GET, redirects not followed, body size-capped, 15s timeout. Workers fetch cannot reach
// private networks in production, which blocks SSRF to internal hosts. Mirrors `x402-scan lint`.

const USDC = {
  "eip155:8453": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "eip155:84532": "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
};
const MAX_BODY_BYTES = 256 * 1024;
const MAX_HEADER_CHARS = 128 * 1024;

function b64decode(s) {
  try {
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function readRequired(headerValue, body) {
  const tryParse = (s) => {
    if (!s) return undefined;
    try {
      const decoded = /^[A-Za-z0-9+/=]+$/.test(s.trim()) ? b64decode(s.trim()) : s;
      if (decoded == null) return undefined;
      const o = JSON.parse(decoded);
      return Array.isArray(o?.accepts) ? o : undefined;
    } catch {
      return undefined;
    }
  };
  return tryParse(headerValue) ?? tryParse(body);
}

function lintRequirement(a, f) {
  const extra = a.extra ?? {};
  const primaryType = String(extra.primaryType ?? extra.type ?? "");
  const method = String(extra.assetTransferMethod ?? "");
  if (/permit/i.test(primaryType) || /permit/i.test(method)) {
    f.push({ level: "danger", code: "permit", message: "asks the buyer to sign an ERC-2612 Permit (an approval, often unlimited). A buyer should never sign a Permit from a 402; the exact scheme uses TransferWithAuthorization." });
  }
  const knownUsdc = Object.values(USDC).includes(String(a.asset ?? "").toLowerCase());
  if (extra.decimals !== undefined && knownUsdc && Number(extra.decimals) !== 6) {
    f.push({ level: "danger", code: "declared_decimals", message: `declares extra.decimals=${extra.decimals} for USDC (which has 6). A buyer that prices with the declared decimals can be tricked into signing far more than it thinks.` });
  } else if (extra.decimals !== undefined) {
    f.push({ level: "warn", code: "declared_decimals", message: `declares its own extra.decimals=${extra.decimals}; a buyer should price from a local table for known assets, not this field.` });
  }
  const timeout = Number(a.maxTimeoutSeconds ?? 0);
  if (timeout > 3600) f.push({ level: "warn", code: "long_timeout", message: `authorization validity is ${Math.round(timeout / 86400)} days; a buyer should cap it to minutes.` });
  if (!extra.name || !extra.version) f.push({ level: "info", code: "missing_domain", message: "no EIP-712 name/version in extra; a buyer should pin the token's domain locally rather than trust the server." });
}

export function lintRequired(required) {
  const f = [];
  const accepts = required.accepts ?? [];
  if (accepts.length === 0) return [{ level: "info", code: "no_terms", message: "no payment requirements found" }];
  if (accepts.length > 1) f.push({ level: "info", code: "multi_option", message: `${accepts.length} payment options offered; a buyer should pin which network and asset it will pay` });
  const networks = new Set(accepts.map((a) => a.network));
  if (networks.size > 1) f.push({ level: "warn", code: "multi_network", message: `offers payment on ${[...networks].join(", ")}; a buyer that signs the first option may pay on an unexpected chain` });
  for (const a of accepts) lintRequirement(a, f);
  return f;
}

async function readCapped(res, max) {
  if (!res.body) return (await res.text().catch(() => "")).slice(0, max);
  const reader = res.body.getReader();
  const chunks = [];
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
  const total = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    if (off >= size) break;
    total.set(c.subarray(0, Math.min(c.length, size - off)), off);
    off += c.length;
  }
  return new TextDecoder().decode(total).slice(0, max);
}

export async function lintUrl(target) {
  const res = await fetch(target, {
    method: "GET",
    headers: { "user-agent": "x402-scan-hosted (+https://deepfirstsearch.com/x402-scan)" },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const body = await readCapped(res, MAX_BODY_BYTES);
  if (res.status !== 402) {
    return { url: target, status: res.status, dangers: 0, findings: [{ level: "info", code: "no_402", message: `HTTP ${res.status}: no payment required (the endpoint showed no 402 to this request)` }] };
  }
  const headerValue = (res.headers.get("PAYMENT-REQUIRED") ?? res.headers.get("payment-required"))?.slice(0, MAX_HEADER_CHARS) ?? null;
  const required = readRequired(headerValue, body);
  if (!required) return { url: target, status: 402, dangers: 0, findings: [{ level: "warn", code: "unreadable", message: "402 returned, but its payment terms could not be read (no PAYMENT-REQUIRED header or accepts body)" }] };
  const findings = lintRequired(required);
  return { url: target, status: 402, dangers: findings.filter((x) => x.level === "danger").length, findings };
}

// --- HTML ---

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const STYLE = `<style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#000;color:#f5f5f7;font:17px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;padding:env(safe-area-inset-top,0) 20px env(safe-area-inset-bottom,0)}main{max-width:760px;margin:0 auto;padding:48px 0 120px}a{color:#94b8ff}h1{font-size:clamp(30px,6vw,48px);letter-spacing:-.03em;line-height:1.05;margin:0 0 8px}.sub{color:#a1a1a6;margin:0 0 28px}form{display:flex;gap:8px;flex-wrap:wrap;margin:20px 0}input[type=url]{flex:1;min-width:240px;padding:12px 14px;border-radius:10px;border:1px solid rgba(255,255,255,.18);background:#0b0b0d;color:#f5f5f7;font-size:16px}button{padding:12px 20px;border-radius:10px;border:0;background:#94b8ff;color:#000;font-weight:600;font-size:16px;cursor:pointer}code{font:0.9em ui-monospace,Menlo,monospace;background:#141418;padding:2px 6px;border-radius:6px}.f{border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:14px 16px;margin:10px 0}.danger{border-color:rgba(255,120,120,.5)}.mark{font-weight:700;margin-right:8px}.d{color:#ff8a8a}.w{color:#ffcf5a}.i{color:#a1a1a6}.grade{font-size:22px;margin:20px 0}.cta{border-top:1px solid rgba(255,255,255,.12);margin-top:40px;padding-top:24px}pre{background:#0b0b0d;border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:16px;overflow-x:auto}</style>`;

function page(bodyHtml) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="referrer" content="no-referrer"><title>x402 endpoint lint · Deep First Search</title>${STYLE}</head><body><main>${bodyHtml}</main></body></html>`;
}

const form = (value = "") => `<form method="get" action="/scan"><input type="url" name="url" placeholder="https://api.example.com/paid" value="${esc(value)}" required><button type="submit">Lint it</button></form>`;

function formPage() {
  return page(`<h1>Lint an x402 endpoint</h1><p class="sub">Paste a URL that returns <code>402 Payment Required</code>. We read its payment terms server-side and flag the traps that fool a naive buyer — no install, nothing signed.</p>${form()}<p class="sub">To grade a buyer <em>client</em> (does it pin the payee, cap the price?), run <code>npx @deepfirstsearch/x402-scan client @x402/fetch</code>.</p>`);
}

function resultPage(target, report) {
  const icon = (l) => (l === "danger" ? `<span class="mark d">✗</span>` : l === "warn" ? `<span class="mark w">!</span>` : `<span class="mark i">·</span>`);
  const rows = report.findings.map((f) => `<div class="f${f.level === "danger" ? " danger" : ""}">${icon(f.level)}<code>${esc(f.code)}</code> — ${esc(f.message)}</div>`).join("");
  const verdict = report.status !== 402
    ? `<p class="grade">HTTP ${report.status} — the endpoint showed no 402 to this request.</p>`
    : report.dangers > 0
      ? `<p class="grade"><span class="d">${report.dangers} dangerous trap(s)</span> in this 402.</p>`
      : `<p class="grade">No dangerous traps in this 402's terms.</p>`;
  const cta = `<div class="cta"><p>The fix for everything flagged above is a payee-pinning, budgeted policy layer that runs before any signature — <a href="/developers">Agent Safe</a>. And grade your own buyer client, not just this endpoint:</p><pre>npx @deepfirstsearch/x402-scan client @x402/fetch</pre></div>`;
  return page(`<h1>x402 endpoint lint</h1><p class="sub">${esc(target)}</p>${form(target)}${verdict}${rows}${cta}`);
}

function errorPage(target, message) {
  return page(`<h1>x402 endpoint lint</h1>${form(target)}<p class="grade w">! ${esc(message)}</p>`);
}

export async function onRequestGet(context) {
  const reqUrl = new URL(context.request.url);
  const target = reqUrl.searchParams.get("url");
  const headers = { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store" };
  if (!target) return new Response(formPage(), { headers });
  let t;
  try {
    t = new URL(target);
  } catch {
    return new Response(errorPage(target, "That doesn't look like a URL."), { status: 400, headers });
  }
  if (t.protocol !== "http:" && t.protocol !== "https:") {
    return new Response(errorPage(target, "Only http and https URLs can be linted."), { status: 400, headers });
  }
  if (/^\[?[0-9a-f:.]+\]?$/i.test(t.hostname) && !/[a-z]/i.test(t.hostname.replace(/^\[|\]$/g, ""))) {
    // raw IP literal — refuse (named hosts only), a small extra SSRF guard on top of the runtime's private-network block
    return new Response(errorPage(target, "Please use a hostname, not a raw IP address."), { status: 400, headers });
  }
  try {
    const report = await lintUrl(t.toString());
    return new Response(resultPage(target, report), { headers });
  } catch (e) {
    return new Response(errorPage(target, `Could not reach that endpoint: ${e?.message ?? e}`), { status: 502, headers });
  }
}
