import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { MerchantRegistry, type Merchant } from "../src/policy/registry.js";
import type { PolicyConfig } from "../src/policy/engine.js";
import { commitPlan } from "../src/guard/plan.js";
import { encodeHeader } from "../src/x402/codec.js";
import { PINNED_USDC } from "../src/policy/networks.js";
import type { PaymentRequired, PaymentRequirements } from "../src/x402/schemas.js";

export const NETWORK = "eip155:84532";
export const USDC = PINNED_USDC[NETWORK]!;
export const MERCHANT_PAYTO: Address = "0x1111111111111111111111111111111111111111";
export const ATTACKER: Address = "0x9999999999999999999999999999999999999999";
export const ORIGIN = "https://api.pricing-intel.io";

export const payer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

export function merchant(overrides: Partial<Merchant> = {}): Merchant {
  return { origin: ORIGIN, payTo: MERCHANT_PAYTO, network: NETWORK, maxPerTx: 5_000_000n, pricePin: 10_000n, toleranceBps: 1_000, ...overrides };
}

export const policy: PolicyConfig = {
  allowedNetworks: [NETWORK],
  approvalThreshold: 1_000_000n,
  periodBudget: { amount: 20_000_000n, periodMs: 86_400_000 },
};

export function setup(m: Merchant = merchant()) {
  const registry = new MerchantRegistry([m]);
  const plan = commitPlan(registry, [{ origin: m.origin, maxSpend: 1_000_000n }], 3_600_000);
  return { registry, plan };
}

export function requirement(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK,
    amount: "10000",
    asset: USDC.asset,
    payTo: MERCHANT_PAYTO,
    maxTimeoutSeconds: 60,
    extra: { name: USDC.domain.name, version: USDC.domain.version, assetTransferMethod: "eip3009" },
    ...overrides,
  };
}

export function required(accepts: PaymentRequirements[] = [requirement()], version = 2): PaymentRequired {
  return { x402Version: version, accepts };
}

export function header402(body: PaymentRequired): string {
  return encodeHeader(body);
}
