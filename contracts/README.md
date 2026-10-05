# Deep First Search contracts

Solidity 0.8.30 · Foundry · OpenZeppelin v5.6.1 (pinned submodule) · target chain: Base.

| Contract | Purpose |
|---|---|
| `safe/BudgetVault.sol` | Agent Safe: owner-signed EIP-712 intents, timelocked activation, per-tx/per-period/tranche limits, instant restrict/revoke/pause, owner withdraw |
| `safe/BudgetVaultFactory.sol` | CREATE2 factory, no admin; fixed 50/50 fee split (FeeJar / ops) |
| `fees/FeeJar.sol` | Accumulates USDC fees; releasable only by the Firepit (codehash-pinned, set once) |
| `fees/Firepit.sol` | Burn `threshold()` $DEPTH to claim the jar; threshold doubles per claim, halves every 3 days, bounded [10k, 10M] |
| `token/DepthToken.sol` | $DEPTH: 1B minted once, ERC20 + Burnable + Permit, no owner, no mint |
| `token/DepthVesting.sol` | OZ VestingWallet with ownership frozen (positions cannot be sold OTC) |
| `distribution/MerkleAirdrop.sol` | Wallet-only claim; unclaimed tokens burned after the deadline |
| `distribution/RewardsPool.sol` | Fixed pool, 4 halving epochs over 8 years, remainder burned |

## Test

```bash
forge test                      # unit + fuzz (1,000 runs) + invariants
forge test --mc InvariantsTest -vv
uvx --from slither-analyzer slither . --config-file slither.config.json
```

## Deploy (Base Sepolia)

Keys never live in the repo:

```bash
cast wallet import deployer --interactive
cp .env.example .env            # RPC URLs + Basescan key only

# Phase 1: Agent Safe earns fees before any token exists
INITIALIZER=0x<safe> OPS=0x<safe> \
  forge script script/DeployAgentSafe.s.sol --rpc-url base_sepolia --account deployer --broadcast --verify

# Genesis (TGE), only after the launch plan's F3 tasks are complete
FOUNDER_SAFE=… CONTRIBUTORS_SAFE=… FOUNDATION_SAFE=… DISTRIBUTOR_SAFE=… LAUNCH_RESERVE_SAFE=… \
FEE_JAR=… AIRDROP_ROOT=… TGE=<unix> \
  forge script script/DeployGenesis.s.sol --rpc-url base_sepolia --account deployer --broadcast --verify
# then, from the INITIALIZER Safe: FeeJar.setReleaser(<Firepit>)
```

See `../docs/assessments/SECURITY.md` for the threat model and the trust assumptions (C-04, C-05).
