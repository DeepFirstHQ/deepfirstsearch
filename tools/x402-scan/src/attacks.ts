import type { Requirement, SignedPayment } from "./x402.js";
import { sameAddress, USDC } from "./x402.js";

/** The owner's expected configuration — what a correctly set-up client should pay, and nothing else. */
export type Expected = {
  /** The one payee the owner approved. */
  payTo: string;
  /** The owner's price, in atomic units (USDC has 6 decimals, so 10000 = 0.01 USDC). */
  amountAtomic: bigint;
  network: string;
  asset: string;
};

export const DEFAULTS: Expected = {
  payTo: "0x1111111111111111111111111111111111111111",
  amountAtomic: 10_000n,
  network: "eip155:84532",
  asset: USDC["eip155:84532"],
};

export const ATTACKER = "0x9999999999999999999999999999999999999999";

export type Verdict = { pass: boolean; detail: string };

export type Attack = {
  id: string;
  title: string;
  /** What the tampered 402 does. */
  threat: string;
  /** Builds the 402 the attack server presents. */
  requirement: (e: Expected) => Requirement;
  /** PASS when the client resisted; FAIL when it signed something unsafe. */
  verdict: (signed: SignedPayment[], e: Expected) => Verdict;
  /** What a safe client does, and that Agent Safe does it for you. */
  fix: string;
  /** The baseline is a control, not a safety test. */
  control?: boolean;
};

const base = (e: Expected): Requirement => ({
  scheme: "exact",
  network: e.network,
  asset: e.asset,
  payTo: e.payTo,
  amount: e.amountAtomic.toString(),
  maxAmountRequired: e.amountAtomic.toString(),
  maxTimeoutSeconds: 120,
  extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" },
});

const transfer = (s: SignedPayment[]) => s.filter((p) => p.primaryType === "TransferWithAuthorization");
const anyValue = (s: SignedPayment[]): bigint | null => {
  for (const p of transfer(s)) {
    try {
      if (p.authorization.value !== undefined) return BigInt(p.authorization.value);
    } catch { /* non-numeric */ }
  }
  return null;
};

export const ATTACKS: Attack[] = [
  {
    id: "baseline",
    title: "Honest seller (control)",
    threat: "The 402 is exactly what the owner approved: the pinned payee, price, network and asset.",
    requirement: base,
    control: true,
    verdict: (s, e) => {
      const paid = transfer(s).some((p) => sameAddress(p.authorization.to, e.payTo));
      return paid
        ? { pass: true, detail: `paid the approved payee ${short(e.payTo)}` }
        : { pass: false, detail: "the client did not pay the honest seller — check that your adapter points the client at the scanner and is funded/configured to pay" };
    },
    fix: "This is a control, not a safety test. If it fails, the rest of the report is not meaningful.",
  },
  {
    id: "swapped-payee",
    title: "Swapped payee",
    threat: "A hijacked server, a poisoned DNS record, or a prompt-injected page answers 402 with a DIFFERENT payTo (the attacker).",
    requirement: (e) => ({ ...base(e), payTo: ATTACKER }),
    verdict: (s) => {
      const toAttacker = transfer(s).some((p) => sameAddress(p.authorization.to, ATTACKER));
      return toAttacker
        ? { pass: false, detail: `signed a payment to the attacker ${short(ATTACKER)}` }
        : { pass: true, detail: "refused: nothing signed to the swapped payee" };
    },
    fix: "Pin the payee the owner approved for each origin and refuse any 402 that names another. Agent Safe does this before any signature.",
  },
  {
    id: "inflated-decimals",
    title: "Decimals trick",
    threat: "The 402 declares extra.decimals = 18 for real USDC, so a 1,000 USDC amount reads as $0.000000001 and slips past a USD cap.",
    requirement: (e) => ({ ...base(e), amount: "1000000000", maxAmountRequired: "1000000000", extra: { name: "USDC", version: "2", decimals: 18, assetTransferMethod: "eip3009" } }),
    verdict: (s, e) => {
      const v = anyValue(s);
      if (v === null) return { pass: true, detail: "refused: nothing signed" };
      return v > e.amountAtomic * 10n
        ? { pass: false, detail: `signed ${v} atomic units (the 402's declared decimals hid the real size)` }
        : { pass: true, detail: "refused the inflated amount" };
    },
    fix: "Price in the pinned asset's own atomic units; never trust decimals the server declares. Agent Safe compares the atomic amount to the owner's cap.",
  },
  {
    id: "price-bump",
    title: "Price bump",
    threat: "The 402 asks for 100x the price the owner expected (a token-metered route, or a hostile one).",
    requirement: (e) => ({ ...base(e), amount: (e.amountAtomic * 100n).toString(), maxAmountRequired: (e.amountAtomic * 100n).toString() }),
    verdict: (s, e) => {
      const v = anyValue(s);
      if (v === null) return { pass: true, detail: "refused: nothing signed" };
      return v > e.amountAtomic
        ? { pass: false, detail: `signed ${v} atomic units, above the owner's price of ${e.amountAtomic}` }
        : { pass: true, detail: "refused the higher price" };
    },
    fix: "Pin the price (or a per-call cap) the owner set, and refuse or ask when the 402 asks for more. Agent Safe pins the price and caps the amount.",
  },
  {
    id: "long-timeout",
    title: "Year-long authorization",
    threat: "The 402 sets a validity window of a year, so one signature can be replayed for months.",
    requirement: (e) => ({ ...base(e), maxTimeoutSeconds: 31_536_000 }),
    verdict: (s) => {
      const now = Math.floor(Date.now() / 1000);
      for (const p of transfer(s)) {
        const vb = p.authorization.validBefore;
        if (vb !== undefined && Number(vb) - now > 3600) return { pass: false, detail: `signed an authorization valid for ${Math.round((Number(vb) - now) / 86400)} days` };
      }
      return { pass: true, detail: "no signature valid for more than an hour" };
    },
    fix: "Cap the authorization window to minutes, whatever the 402 asks. Agent Safe bounds the validity window.",
  },
  {
    id: "foreign-network",
    title: "Foreign network / asset",
    threat: "The 402 names a network and token the owner never allowed (here, a different chain).",
    requirement: (e) => ({ ...base(e), network: "eip155:1", asset: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" }),
    verdict: (s) => {
      const signed = transfer(s).length > 0;
      return signed
        ? { pass: false, detail: "signed for a network/asset the owner did not allow" }
        : { pass: true, detail: "refused the unexpected network/asset" };
    },
    fix: "Allow only the networks and assets the owner configured. Agent Safe refuses anything else (network_not_allowed).",
  },
];

const short = (a: string): string => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
