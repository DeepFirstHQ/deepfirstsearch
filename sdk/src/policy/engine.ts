import { getAddress } from "viem";
import type { SealedPlan } from "../guard/plan.js";
import type { PaymentRequired, PaymentRequirements } from "../x402/schemas.js";
import { pinnedAsset, type PinnedAsset } from "./networks.js";
import type { Merchant, MerchantRegistry } from "./registry.js";

export type PolicyConfig = {
  /** CAIP-2 networks the agent may pay on, e.g. ["eip155:8453"]. */
  allowedNetworks: string[];
  /** Accepted range for the server's maxTimeoutSeconds. */
  timeoutBounds?: { min: number; max: number };
  /** Payments above this amount (atomic units) need a human. */
  approvalThreshold?: bigint;
  /** Off-chain mirror of the vault's period budget. The vault enforces it on-chain too. */
  periodBudget?: { amount: bigint; periodMs: number };
  /** Asset pins for extra networks (e.g. a local test chain). Never sourced from a server. */
  assets?: Record<string, PinnedAsset>;
};

export type Approved = {
  requirement: PaymentRequirements;
  merchant: Merchant;
  asset: PinnedAsset;
  amount: bigint;
};

export type Decision =
  | ({ kind: "allow"; reasons: string[] } & Approved)
  | ({ kind: "needsApproval"; reasons: string[] } & Approved)
  | { kind: "deny"; reasons: string[] };

export type EvaluateInput = {
  url: string;
  required: PaymentRequired;
  plan: SealedPlan;
  spentInPeriod: bigint;
  now: number;
};

const DEFAULT_TIMEOUT = { min: 10, max: 300 };

/**
 * Deterministic payment policy. It runs outside the model and treats the whole 402 response as untrusted input:
 * the payee, asset, network, price and timeout a server asks for are only accepted when they match what the owner
 * configured. The model can propose a payment; only this function can approve one.
 */
export function evaluate(config: PolicyConfig, registry: MerchantRegistry, input: EvaluateInput): Decision {
  const { url, required, plan } = input;
  if (required.x402Version !== 2) return deny(`unsupported x402 version ${required.x402Version}`);

  const merchant = registry.forUrl(url);
  if (!merchant) return deny(`origin ${new URL(url).origin} is not an approved merchant`);
  if (!plan.covers(merchant.origin, input.now)) return deny("merchant is not in the sealed plan, or the plan expired");

  const bounds = config.timeoutBounds ?? DEFAULT_TIMEOUT;
  const rejected: string[] = [];
  const candidates: { r: PaymentRequirements; asset: PinnedAsset; amount: bigint }[] = [];

  for (const r of required.accepts) {
    const why = checkRequirement(r, merchant, config, bounds);
    if (why) {
      rejected.push(why);
      continue;
    }
    candidates.push({ r, asset: pinnedAsset(r.network, config.assets)!, amount: BigInt(r.amount) });
  }
  if (candidates.length === 0) return deny(...(rejected.length ? rejected : ["server offered no payment options"]));

  const best = candidates.reduce((a, b) => (b.amount < a.amount ? b : a));
  const amount = best.amount;
  const reasons: string[] = [];

  if (amount <= 0n) return deny("amount must be positive");
  if (amount > merchant.maxPerTx) return deny(`amount ${amount} exceeds merchant cap ${merchant.maxPerTx}`);
  if (merchant.pricePin !== undefined) {
    const ceiling = merchant.pricePin + (merchant.pricePin * BigInt(merchant.toleranceBps ?? 0)) / 10_000n;
    if (amount > ceiling) return deny(`amount ${amount} is above the pinned price ${merchant.pricePin}`);
  }
  if (amount > plan.remaining(merchant.origin)) return deny("amount exceeds what is left in the sealed plan");
  if (config.periodBudget && input.spentInPeriod + amount > config.periodBudget.amount) {
    return deny("amount exceeds the period budget");
  }

  const approved = { requirement: best.r, merchant, asset: best.asset, amount };
  if (config.approvalThreshold !== undefined && amount > config.approvalThreshold) {
    reasons.push(`amount ${amount} is above the approval threshold`);
    return { kind: "needsApproval", reasons, ...approved };
  }
  return { kind: "allow", reasons, ...approved };
}

/** Server-controlled values appear in denial reasons only as short, plain tokens (SDK-L-3). */
function show(v: unknown): string {
  const t = String(v).replace(/[^A-Za-z0-9:._-]/g, "").slice(0, 42);
  return t.length ? t : "(invalid)";
}

function checkRequirement(
  r: PaymentRequirements,
  merchant: Merchant,
  config: PolicyConfig,
  bounds: { min: number; max: number },
): string | undefined {
  if (r.scheme !== "exact") return `scheme ${show(r.scheme)} is not supported`;
  if (!config.allowedNetworks.includes(r.network)) return `network ${show(r.network)} is not allowed`;
  if (r.network !== merchant.network) return `network ${show(r.network)} does not match the merchant's network`;
  const pinned = pinnedAsset(r.network, config.assets);
  if (!pinned) return `no pinned asset for ${show(r.network)}`;
  if (r.asset.toLowerCase() !== pinned.asset.toLowerCase()) return `asset ${show(r.asset)} is not the pinned USDC`;
  const method = r.extra?.assetTransferMethod ?? "eip3009";
  if (method !== "eip3009") return `transfer method ${show(method)} is not supported`;
  if (r.extra?.name !== undefined && r.extra.name !== pinned.domain.name) return "EIP-712 domain name does not match the pin";
  if (r.extra?.version !== undefined && r.extra.version !== pinned.domain.version) {
    return "EIP-712 domain version does not match the pin";
  }
  if (getAddress(r.payTo) !== merchant.payTo) return `payTo ${show(r.payTo)} is not the merchant's registered address`;
  
  const mBounds = merchant.maxTimeoutSeconds ? { min: bounds.min, max: merchant.maxTimeoutSeconds } : bounds;
  if (r.maxTimeoutSeconds < mBounds.min || r.maxTimeoutSeconds > mBounds.max) {
    return `maxTimeoutSeconds ${r.maxTimeoutSeconds} is outside [${mBounds.min}, ${mBounds.max}]`;
  }
  return undefined;
}

function deny(...reasons: string[]): Decision {
  return { kind: "deny", reasons };
}
