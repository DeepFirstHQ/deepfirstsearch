/**
 * A real x402 payment on Base Sepolia (testnet only), end to end:
 *   owner-signed intent → BudgetVault funds the merchant's payer → SDK signs → public x402 facilitator settles.
 *
 *   npx tsx examples/sepolia-live.ts setup   # create the vault, fund it, sign the intent (then wait 1 h timelock)
 *   npx tsx examples/sepolia-live.ts pay     # pay a local x402 endpoint through https://x402.org/facilitator
 *
 * Secrets come from the environment and are never printed:
 *   OWNER_PK, AGENT_PK (testnet keys), MERCHANT (address), BURNER_SEED (32-byte hex), FACTORY (BudgetVaultFactory),
 *   STATE_FILE (where vault/intent ids are stored between steps).
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  hexToBytes,
  http,
  parseEther,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { createAgentPay, MerchantRegistry, burnerAddress, burnerPayers, signIntent, vaultFunder, PINNED_USDC, INTENT_TYPES } from "../src/index.js";

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};
const NETWORK = "eip155:84532";
const USDC = PINNED_USDC[NETWORK]!.asset;
const FACILITATOR = "https://x402.org/facilitator";
const RPC = process.env.RPC_URL ?? "https://sepolia.base.org";
const explorer = (tx: string) => `https://sepolia.basescan.org/tx/${tx}`;

const transport = http(RPC);
const pub = createPublicClient({ chain: baseSepolia, transport, pollingInterval: 1_000 });
const owner = privateKeyToAccount(env("OWNER_PK") as Hex);
const agent = privateKeyToAccount(env("AGENT_PK") as Hex);
const merchant = env("MERCHANT") as Address;
const factory = env("FACTORY") as Address;
const stateFile = env("STATE_FILE");

const FACTORY_ABI = [
  { type: "function", name: "create", stateMutability: "nonpayable", inputs: [{ name: "owner", type: "address" }, { name: "salt", type: "bytes32" }, { name: "activationDelay", type: "uint32" }], outputs: [{ type: "address" }] },
  { type: "function", name: "predict", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "salt", type: "bytes32" }, { name: "activationDelay", type: "uint32" }], outputs: [{ type: "address" }] },
] as const;
const VAULT_ABI = [
  {
    type: "function", name: "proposeIntent", stateMutability: "nonpayable",
    inputs: [{ name: "intent", type: "tuple", components: [
      ...INTENT_TYPES.Intent,
    ] }, { name: "ownerSignature", type: "bytes" }],
    outputs: [{ name: "id", type: "bytes32" }],
  },
] as const;

async function setup() {
  const ownerWallet = createWalletClient({ chain: baseSepolia, transport, account: owner });
  const salt = `0x${"0d".repeat(32)}` as Hex;
  const vault = await pub.readContract({ address: factory, abi: FACTORY_ABI, functionName: "predict", args: [owner.address, salt, 3600] });
  if ((await pub.getCode({ address: vault })) === undefined) {
    const tx = await ownerWallet.writeContract({ address: factory, abi: FACTORY_ABI, functionName: "create", args: [owner.address, salt, 3600] });
    await pub.waitForTransactionReceipt({ hash: tx });
    console.log(`vault created ${vault}  ${explorer(tx)}`);
  }
  const vaultBalance = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [vault] });
  if (vaultBalance < 500_000n) {
    const ownerBalance = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [owner.address] });
    const amount = ownerBalance < 900_000n ? ownerBalance : 900_000n;
    if (amount < 200_000n) throw new Error(`owner holds only ${ownerBalance} atomic test USDC; top up from the Circle faucet`);
    const fund = await ownerWallet.writeContract({ address: USDC, abi: erc20Abi, functionName: "transfer", args: [vault, amount] });
    await pub.waitForTransactionReceipt({ hash: fund });
    console.log(`vault funded with ${amount} atomic test USDC  ${explorer(fund)}`);
  } else console.log(`vault ${vault} already holds ${vaultBalance} atomic USDC`);

  const now = Math.floor(Date.now() / 1000);
  const intent = {
    agent: agent.address, counterparty: merchant,
    burner: burnerAddress({ ownerSeed: hexToBytes(env("BURNER_SEED") as Hex), vault, chainId: baseSepolia.id, counterparty: merchant }),
    token: USDC,
    maxPerTx: 50_000n, maxPerPeriod: 500_000n, trancheCap: 100_000n,
    period: 86_400, validAfter: 0n, expiry: BigInt(now + 30 * 86_400), nonce: BigInt(now),
  };
  const signature = await signIntent(owner, vault, baseSepolia.id, intent);
  const { result: id, request } = await pub.simulateContract({ address: vault, abi: VAULT_ABI, functionName: "proposeIntent", args: [intent, signature], account: owner });
  const ptx = await ownerWallet.writeContract(request);
  await pub.waitForTransactionReceipt({ hash: ptx });
  console.log(`intent proposed (active in 1 h)  ${explorer(ptx)}`);

  const gas = await ownerWallet.sendTransaction({ to: agent.address, value: parseEther("0.00005") });
  await pub.waitForTransactionReceipt({ hash: gas });
  writeFileSync(stateFile, JSON.stringify({ vault, intentId: id, activeAfter: now + 3600 }, null, 2));
  console.log(`agent gas funded; state saved. Run "pay" after ${new Date((now + 3600) * 1000).toISOString()}`);
}

async function pay() {
  if (!existsSync(stateFile)) throw new Error("run setup first");
  const { vault, intentId } = JSON.parse(readFileSync(stateFile, "utf8")) as { vault: Address; intentId: Hex };
  const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR });
  const requirement = {
    scheme: "exact", network: NETWORK, amount: "10000", asset: USDC, payTo: merchant, maxTimeoutSeconds: 120,
    extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" },
  };

  // A tiny x402 resource server built with the official codecs and the public testnet facilitator.
  const server = createServer(async (req, res) => {
    const sig = req.headers["payment-signature"];
    if (typeof sig !== "string") {
      res.writeHead(402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader({ x402Version: 2, accepts: [requirement] } as never) }).end();
      return;
    }
    const payload = decodePaymentSignatureHeader(sig);
    const verified = await facilitator.verify(payload as never, requirement as never);
    if (!verified.isValid) {
      console.error(`facilitator rejected the payment: ${verified.invalidReason} ${verified.invalidMessage ?? ""}`);
      res.writeHead(402).end(`verify failed: ${verified.invalidReason}`);
      return;
    }
    const settled = await facilitator.settle(payload as never, requirement as never);
    if (!settled.success) console.error(`facilitator could not settle: ${settled.errorReason ?? "unknown"} ${(settled as { errorMessage?: string }).errorMessage ?? ""}`);
    res.writeHead(settled.success ? 200 : 402, { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settled) }).end('{"data":"premium"}');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const pay = createAgentPay({
    registry: new MerchantRegistry([{ origin: url, payTo: merchant, network: NETWORK, maxPerTx: 50_000n, pricePin: 10_000n }]),
    policy: { allowedNetworks: [NETWORK] },
    payer: burnerPayers(hexToBytes(env("BURNER_SEED") as Hex), vault),
    session: { readsUntrustedInput: false, accessesSensitiveData: false, canPay: true },
    ensureFunded: vaultFunder({
      agent: createWalletClient({ chain: baseSepolia, transport, account: agent }),
      // OP-stack chain clients carry extra formatters; the funder only needs reads and receipts.
      publicClient: pub as unknown as PublicClient, vault, usdc: USDC, intents: { [merchant]: intentId }, tranche: 50_000n,
    }),
  });
  const plan = pay.commitPlan([{ origin: url, maxSpend: 50_000n }], 10 * 60_000);
  const res = await pay.fetch(`${url}/premium`, {}, { plan });
  console.log(`status ${res.status}; paid ${res.payment?.amount} atomic USDC to ${merchant}`);
  console.log(`settlement tx: ${explorer(res.payment!.settlement.transaction)}`);
  server.close();
}

const cmd = process.argv[2];
if (cmd === "setup") await setup();
else if (cmd === "pay") await pay();
else console.log("usage: sepolia-live.ts setup|pay");
