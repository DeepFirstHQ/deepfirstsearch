# Tokenomics: $DEPTH

**A supply that only goes down.**

Draft v0.2 · 5 October 2026 · Pre-launch. No token exists. Nothing here is an offer to sell or a solicitation to buy any asset.

> These numbers are the single source of truth for `web/src/config.ts` and `contracts/script/DeployGenesis.s.sol`. If you change one, change all three.

## 1. Supply

| | |
|---|---|
| Ticker | **$DEPTH** |
| Total supply | **1,000,000,000**, minted once in the token constructor |
| Minting | **Impossible.** The contract has no mint function and no owner |
| Upgradeability | **None.** No proxy |
| Direction | Supply can only **decrease**, through burns that lower `totalSupply` (not transfers to a dead address) |
| Chain | Base (Ethereum L2), as a transparent ERC-20 with EIP-2612 permit. Not a privacy coin |

## 2. Allocation

| Allocation | % | Tokens | Contract | Terms |
|---|---:|---:|---|---|
| Airdrop to real users | 25 | 250,000,000 | `MerkleAirdrop` | Wallet-only claim with no email or KYC. Criteria weighted by real usage and sybil-filtered. The snapshot is not announced in advance. 180-day claim window, then **anyone can burn what is unclaimed** |
| Fixed rewards pool | 25 | 250,000,000 | `RewardsPool` | Releases 125M, 62.5M, 31.25M and 15.625M over four 2-year epochs. Pays only for work. After 8 years **anyone can burn the remainder** |
| Public fair auction | 15 | 150,000,000 | Auction contract (to be built) | One clearing price for everyone, minimum raise or full refund, per-wallet cap. Excludes the US, Argentina, Ontario and sanctioned jurisdictions |
| Protocol-owned liquidity | 10 | 100,000,000 | LP | Paired with auction proceeds. **The LP position is burned** |
| **Founder** | **12** | **120,000,000** | `DepthVesting` | **Nothing for 12 months, then 36 months linear (4 years total). The vesting contract cannot be transferred; the beneficiary is a public multisig Safe** |
| Contributors | 3 | 30,000,000 | `DepthVesting` | Same schedule as the founder |
| Foundation | 10 | 100,000,000 | `DepthVesting` | Linear over 5 years, which caps on-chain spending at 2% of supply per year. Beneficiary is a multisig |
| Venture capital | **0** | 0 | — | None: no private round, no side letters, no refund rights |
| **Total** | **100** | **1,000,000,000** | | |

At launch, the airdrop (25%) is claimable, and the launch reserve (25%) sits in a public multisig Safe until the auction and liquidity contracts exist, then goes to them. The founder, contributors and rewards pool hold nothing liquid on day one; the foundation vests linearly from TGE.

## 3. The burn: fee jar and firepit

1. **Agent Safe charges 0.1%** in USDC on every agent payment and burner top-up, paid on top of the amount.
2. **An immutable split** set in `BudgetVaultFactory` sends 50% of that fee to the **FeeJar** and 50% to operations.
3. **Anyone can claim the whole jar** by burning `threshold()` $DEPTH in the **Firepit**. The auction opens at TGE from the 10,000,000 ceiling, so fees collected before launch are not sold for the floor. The FeeJar connects to the Firepit once, through a public 14-day timelock.
4. **The threshold doubles** after every claim and **halves every 3 days** without one. It always stays between **10,000 and 10,000,000 $DEPTH**. The `maxThreshold` argument protects claimers against front-running.

**Why this design**
- No swap, so no sandwich on a trade. Claims are still a public race: `maxThreshold` caps what a claimer burns if someone claims first.
- No oracle, so nothing to manipulate.
- No admin, so no discretion over when or how much is burned.
- Searchers compete, so the jar is claimed roughly when its USDC is worth the $DEPTH burned.
- It copies Uniswap's 2025 *UNIfication* mechanism.

**Rules**
- **Allowed fee sources:** only Agent Safe, the SDK and (later) private inference. Any future privacy pool has **no fee path** to the jar or the team (legal separation, ADR-004).
- **Revenue only:** the jar is never funded from treasury principal or borrowed money.
- **Mechanism, not yield:** the burn activates on a working network and is never described as a return.
- **No extras:** no transfer taxes, reflections or rebasing.

## 4. Unlocks against burns
- At TGE, team, contributors and foundation unlock **nothing**. The foundation releases about 0.17% of supply per month on-chain. The founder and contributors start after month 12.
- A **monthly public report** covers burned supply, vested supply, net change, and the balances of every privileged wallet.

## 5. Rewards
- Paid only from the fixed pool, **only for work** (keepers, integrations, security), and never more than has vested.
- No emissions and no staking yield.

## 6. What we will never do
- Mint a single new token. The contract makes this impossible.
- Give anyone better terms than the public.
- Sign a hidden market-maker loan. Any market-making agreement will be published.
- Launch the token before the protocol has real revenue.
- Describe the token as an investment, or promise returns or price.
- Make the token itself private. Privacy lives in the application.

## 7. Lineage

| Borrowed from | What we copy |
|---|---|
| Hyperliquid | No VC; large airdrop to real users; burn funded by real fees |
| Uniswap UNIfication | Burn-to-claim fee jar (Firepit) |
| Bitcoin | A supply nobody can change |
| Pepe | No owner; liquidity burned |

| Avoided | Failure mode |
|---|---|
| WLD, Aleo, STRK | Low float, high FDV, unlock cliffs |
| JUP | Unlocks outrunning buybacks |
| SafeMoon | "Deflationary" transfer taxes |
| OM | Silent minting, concentrated supply |
| Movement, Nillion | Hidden market-maker deals |
| OZ `VestingWallet` as shipped | Transferable vesting positions (sold over the counter). Ours are frozen |

Evidence: [research/04-tokenomics-models.md](./research/04-tokenomics-models.md) and [research/03-failures.md](./research/03-failures.md).
