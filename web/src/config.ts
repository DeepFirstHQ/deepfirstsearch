// Single source of truth for token facts shown on the page.
// Must stay in sync with docs/TOKENOMICS.md and contracts/script/DeployGenesis.s.sol.

export const TICKER = "$DEPTH";

export const TOTAL_SUPPLY = 1_000_000_000;

export type Allocation = {
  name: string;
  pct: number;
  terms: string;
  color: string;
};

// Colors: validated categorical palette (dark surface #0b0b0d), fixed order.
export const ALLOCATIONS: Allocation[] = [
  {
    name: "Airdrop to real users",
    pct: 25,
    terms: "Wallet-only claim, no email or KYC · sybil-filtered · unclaimed tokens are burned",
    color: "#3987e5",
  },
  {
    name: "Fixed rewards pool",
    pct: 25,
    terms: "Halves every 2 years for 8 years · whatever is unspent is burned",
    color: "#d95926",
  },
  {
    name: "Public fair auction",
    pct: 15,
    terms: "One clearing price for everyone · minimum raise or full refund · per-wallet cap",
    color: "#199e70",
  },
  {
    name: "Founder",
    pct: 12,
    terms: "Locked on-chain: nothing for 12 months, then 36 months linear",
    color: "#c98500",
  },
  {
    name: "Contributors",
    pct: 3,
    terms: "Same lock as the founder: 12 months, then 36 months linear",
    color: "#d55181",
  },
  {
    name: "Foundation",
    pct: 10,
    terms: "Vests over 5 years on-chain (at most 2% of supply per year) · multisig",
    color: "#008300",
  },
  {
    name: "Protocol-owned liquidity",
    pct: 10,
    terms: "Paired with auction proceeds · LP position burned",
    color: "#9085e9",
  },
];

if (ALLOCATIONS.reduce((sum, a) => sum + a.pct, 0) !== 100) {
  throw new Error("Allocations must sum to 100%");
}
