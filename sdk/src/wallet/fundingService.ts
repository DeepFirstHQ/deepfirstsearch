import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { getAddress, type Address, type LocalAccount } from "viem";
import type { Merchant, MerchantRegistry } from "../policy/registry.js";

/**
 * Privacy level 1: fund merchant payers from a regulated exchange account instead of the on-chain vault, so the
 * public chain shows "exchange hot wallet → fresh payer", not "your vault → fresh payer". The exchange (and lawful
 * authorities) can still see it; competitors and chain analysts cannot.
 *
 * Security model: this service runs in the OWNER's process, never in the agent's. It holds the exchange
 * credentials. The agent can only ask "top up the payer for merchant X". The service derives the payer address
 * itself, so a manipulated agent cannot redirect funds to an address of its choosing, and it applies its own
 * limits on top of everything else.
 */

/** Adapter to the owner's exchange (e.g. a withdrawal API). Returns an id for the audit trail. */
export type Withdraw = (to: Address, amountAtomic: bigint) => Promise<string>;

export type FundingLimits = {
  /** Largest single top-up, in atomic units. */
  maxPerTopUp: bigint;
  /** Total top-ups allowed in a rolling 24 hours, across all merchants. */
  maxPerDay: bigint;
};

export type TopUpResult = { ok: true; payer: Address; amount: bigint; ref: string } | { ok: false; reason: string };

export function createFundingService(opts: {
  registry: MerchantRegistry;
  /** The same payer derivation the agent uses (e.g. burnerPayers(seed, vault)). */
  payerFor: (merchant: Merchant, chainId: number) => LocalAccount;
  chainId: number;
  withdraw: Withdraw;
  limits: FundingLimits;
  now?: () => number;
}) {
  const now = opts.now ?? Date.now;
  const history: { at: number; amount: bigint }[] = [];

  async function topUp(origin: string, amount: bigint): Promise<TopUpResult> {
    let merchant: Merchant | undefined;
    try {
      merchant = opts.registry.forUrl(origin);
    } catch {
      merchant = undefined;
    }
    if (!merchant) return { ok: false, reason: "unknown merchant" };
    if (amount <= 0n || amount > opts.limits.maxPerTopUp) return { ok: false, reason: "amount outside per-top-up limit" };

    const dayAgo = now() - 86_400_000;
    const spent = history.filter((h) => h.at > dayAgo).reduce((s, h) => s + h.amount, 0n);
    if (spent + amount > opts.limits.maxPerDay) return { ok: false, reason: "daily funding limit reached" };

    // The destination is computed here, never taken from the request.
    const payer = getAddress(opts.payerFor(merchant, opts.chainId).address);
    history.push({ at: now(), amount });
    const ref = await opts.withdraw(payer, amount);
    return { ok: true, payer, amount, ref };
  }

  /** Minimal HTTP endpoint on localhost: POST { origin, amount } with a bearer token. */
  function listen(port: number, token: string): Promise<Server> {
    const expected = Buffer.from(`Bearer ${token}`);
    const server = createServer(async (req, res) => {
      const auth = Buffer.from(req.headers.authorization ?? "");
      if (req.method !== "POST" || auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
        res.writeHead(401).end();
        return;
      }
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1024) {
          res.writeHead(413).end();
          return;
        }
      }
      try {
        const { origin, amount } = JSON.parse(body) as { origin: string; amount: string };
        const result = await topUp(String(origin), BigInt(amount));
        res.writeHead(result.ok ? 200 : 403, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
      } catch {
        res.writeHead(400).end();
      }
    });
    return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
  }

  return { topUp, listen };
}

/** `ensureFunded` hook for the agent side: asks the owner's funding service, which decides. */
export function remoteFunder(url: string, token: string, opts: { minBalance?: (payer: Address) => Promise<bigint> } = {}) {
  return async (payer: LocalAccount, merchant: Merchant, amount: bigint): Promise<void> => {
    if (opts.minBalance && (await opts.minBalance(payer.address)) >= amount) return;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ origin: merchant.origin, amount: amount.toString() }),
    });
    if (!res.ok) throw new Error(`funding refused (${res.status}): ${await res.text()}`);
  };
}
