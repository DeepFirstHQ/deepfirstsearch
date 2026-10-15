import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createAgentPay, MerchantRegistry, burnerPayers, type PolicyConfig } from "@deepfirstsearch/agent-pay";
import { startMockServer } from "@deepfirstsearch/agent-pay/testing";
import type { WorkflowOptions } from "./workflow.js";

const SELLER = "0x1111111111111111111111111111111111111111" as const;
const ATTACKER = "0x9999999999999999999999999999999999999999" as const;
const NETWORK = "eip155:84532"; // Base Sepolia; the mock sellers verify signatures locally and never touch a chain

/**
 * Everything the agent meets in the local run, on this machine, with no keys and no chain:
 * - an honest seller (`/prices` at 0.01 USDC, and `/premium` whose price moved above the owner's pin);
 * - a mirror of that seller whose 402 now names an attacker as payee (a hijacked server or DNS);
 * - a seller the owner never approved;
 * - a free source, and a dead one.
 */
export async function startLocalWorld() {
  const honest = await startMockServer({
    "/prices": { price: 10_000n, payTo: SELLER, body: '{"BTC":64210.5,"ETH":3120.2}' },
    "/premium": { price: 50_000n, payTo: SELLER, body: '{"report":"…"}' },
  });
  const mirror = await startMockServer({ "/prices": { price: 10_000n, payTo: SELLER, tamper: (r) => ({ ...r, payTo: ATTACKER }) } });
  const stranger = await startMockServer({ "/prices": { price: 10_000n, payTo: ATTACKER } });
  const free = createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end('{"USD_ARS":1180.5}'));
  await new Promise<void>((r) => free.listen(0, "127.0.0.1", r));
  const freeUrl = `http://127.0.0.1:${(free.address() as AddressInfo).port}`;
  const dead = createServer();
  await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
  const deadUrl = `http://127.0.0.1:${(dead.address() as AddressInfo).port}`;
  await new Promise((r) => dead.close(r)); // nothing listens there any more

  // The owner's setup, in code: who may be paid, at what price, and how much in total.
  const registry = new MerchantRegistry([
    { origin: honest.url, payTo: SELLER, network: NETWORK, maxPerTx: 50_000n, pricePin: 10_000n, label: "market data" },
    { origin: mirror.url, payTo: SELLER, network: NETWORK, maxPerTx: 50_000n, pricePin: 10_000n, label: "market data (mirror)" },
  ]);
  const policy: PolicyConfig = { allowedNetworks: [NETWORK], periodBudget: { amount: 1_000_000n, periodMs: 86_400_000 } };
  const pay = createAgentPay({
    registry,
    policy,
    // A throwaway payer: the mock sellers check signatures, no funds are needed. Real setups fund payers from a vault.
    payer: burnerPayers(new Uint8Array(32).fill(7), "0x5555555555555555555555555555555555555555"),
    session: { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true },
  });
  // The plan is sealed before the agent reads anything: at most 0.02 USDC to the market data seller this session.
  const plan = pay.commitPlan([{ origin: honest.url, maxSpend: 20_000n }, { origin: mirror.url, maxSpend: 20_000n }], 10 * 60_000);

  const options: WorkflowOptions = { pay, registry, policy, plan, timeoutMs: 5_000 };
  const urls = {
    paid: `${honest.url}/prices`,
    priceMoved: `${honest.url}/premium`,
    hijacked: `${mirror.url}/prices`,
    stranger: `${stranger.url}/prices`,
    free: `${freeUrl}/rates`,
    missing: `${honest.url}/missing`,
    dead: `${deadUrl}/prices`,
  };
  return {
    options,
    urls,
    /** Payment authorizations each server received (the attacker's mirror must stay at zero). */
    received: () => ({ honest: honest.received.length, mirror: mirror.received.length, stranger: stranger.received.length }),
    close: async () => {
      await Promise.all([honest.close(), mirror.close(), stranger.close(), new Promise((r) => free.close(r))]);
    },
  };
}
