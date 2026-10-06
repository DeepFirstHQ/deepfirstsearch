# Deployments

## Base Sepolia (testnet, chain id 84532)

### Current: v0.4 (2026-10-06)
Includes the fixes from the second internal review: fees owed to each recipient are flushed independently, the agent cannot spend fees the vault still owes, `invalidateNonce` is idempotent, intents cannot name a protocol address as payee or payer, intents that would expire before they activate are rejected, and the Firepit only arms once it is connected and its start time has passed. Source verified on Blockscout.

| Contract | Address |
|---|---|
| FeeJar | [`0x4ae59cf9462d1601de4fc5aa4538d376e93a79f2`](https://base-sepolia.blockscout.com/address/0x4ae59cf9462d1601de4fc5aa4538d376e93a79f2) |
| BudgetVaultFactory | [`0xf245d3cb8700a804432ea50b253a923b4b32c0c7`](https://base-sepolia.blockscout.com/address/0xf245d3cb8700a804432ea50b253a923b4b32c0c7) |
| Demo vault | [`0x80214aF99261820a930f7F93148B37bBF5C30b3c`](https://base-sepolia.blockscout.com/address/0x80214aF99261820a930f7F93148B37bBF5C30b3c) |
| x402 payments through v0.4 (6 of 6 settled; merchant received exactly 6 × 0.01 USDC) | [first](https://sepolia.basescan.org/tx/0x92464e274c6e8b972d79215c8043c06fc4b79b312979678330d975306b4d0b54) · [last](https://sepolia.basescan.org/tx/0xc38524c7e6646f939ec1d590e62d27560080b51db08f82d56424c0b2b74fd23d) |

### v0.3 (2026-10-06)
Includes every fix from the first internal pre-audit: intents sign the payer address, fees never block payments, the FeeJar releaser goes through a public timelock, and more (see `docs/assessments/SECURITY.md`). Source verified on Blockscout.

| Contract | Address |
|---|---|
| FeeJar | [`0xc8B733b06e89c8BbC1bA9D79C701608fdA125485`](https://base-sepolia.blockscout.com/address/0xc8B733b06e89c8BbC1bA9D79C701608fdA125485) |
| BudgetVaultFactory | [`0xe0A23185976DF496AF0467aC47043d0e7B464930`](https://base-sepolia.blockscout.com/address/0xe0A23185976DF496AF0467aC47043d0e7B464930) |
| Demo vault | [`0x876f3B7cDFdfcbf263AA6876DB1FCc2979f44ec6`](https://base-sepolia.blockscout.com/address/0x876f3B7cDFdfcbf263AA6876DB1FCc2979f44ec6) |
| x402 payment through v0.3 (payer signed in the intent) | [tx](https://sepolia.basescan.org/tx/0xc2f0fcf1d3276307f8a20bf987c0ccc20386026deddb78cb214ad56f85783179) |

### v0.2 (2026-10-05)
Includes the C-08 fix: EIP-7702 owners can sign with their own key. Source verified on Blockscout.

| Contract | Address |
|---|---|
| FeeJar | [`0x537fB40b39033d34175C6165859a4ec5Eb600548`](https://base-sepolia.blockscout.com/address/0x537fB40b39033d34175C6165859a4ec5Eb600548) |
| BudgetVaultFactory | [`0x6B56b9667414421be7bAB88D8800f3b551A89B39`](https://base-sepolia.blockscout.com/address/0x6B56b9667414421be7bAB88D8800f3b551A89B39) |
| USDC (Circle, testnet) | [`0x036CbD53842c5426634e7929541eC2318f3dCF7e`](https://base-sepolia.blockscout.com/address/0x036CbD53842c5426634e7929541eC2318f3dCF7e) |

### v0.1 (2026-10-05): first deployment, which made the first live payment
Deployed with `contracts/script/DeployAgentSafe.s.sol`. Source verified on Blockscout.

| Contract | Address |
|---|---|
| FeeJar | [`0xf1a033111cc49603B3da62A406C0e544D98e99bF`](https://base-sepolia.blockscout.com/address/0xf1a033111cc49603B3da62A406C0e544D98e99bF) |
| BudgetVaultFactory | [`0x48b2E4e63497540Ae975dC839A42D220ca171798`](https://base-sepolia.blockscout.com/address/0x48b2E4e63497540Ae975dC839A42D220ca171798) |
| USDC (Circle, testnet) | [`0x036CbD53842c5426634e7929541eC2318f3dCF7e`](https://base-sepolia.blockscout.com/address/0x036CbD53842c5426634e7929541eC2318f3dCF7e) |

Testnet setup:
- On testnet, the FeeJar initializer and the operations wallet are the deployer EOA, and no Firepit is connected (there is no token yet).
- On mainnet both roles will be multisig Safes.

#### Live demo vault (v0.1)

| | |
|---|---|
| BudgetVault | [`0x2f64603173A5f6016D6f1b5CE443Cf1c5BC10B27`](https://base-sepolia.blockscout.com/address/0x2f64603173A5f6016D6f1b5CE443Cf1c5BC10B27) |
| Owner-signed intent | [tx](https://sepolia.basescan.org/tx/0x94907b3f9ebdc15ed462b3823a63757692e7654c8d18e9ae8fe779c5c92b00b0) |
| First x402 payment (0.01 USDC, settled by the public facilitator) | [tx](https://sepolia.basescan.org/tx/0x28c60778fcc40110440ec7fb7c944ad28fa90d5a5c26f639a5001c2736d85e5b) |

Intent limits:
- per payment: 0.05 USDC
- per day: 0.5 USDC
- payer tranche: 0.1 USDC
- one merchant only

Reproduce with `sdk/examples/sepolia-live.ts` (`setup`, then `pay` after the 1-hour activation timelock). The payment goes through the public x402 testnet facilitator (`https://x402.org/facilitator`).

## Token launch rehearsal (Base Sepolia, testnet — no value)

A full run of `contracts/script/DeployGenesis.s.sol` on testnet, deployed 2026-10-05 and verified on Blockscout or Sourcify.

**This is not a token launch.** No $DEPTH exists on any mainnet, and these testnet tokens have no value.

On testnet the beneficiaries are testnet EOAs. On mainnet they will be multisig Safes, and the founder's will be Nicolas Tursi's.

| Contract | Address | Holds |
|---|---|---|
| DepthToken (fixed supply, no owner) | [`0xDAa1Cb9ED18685770BA6f2058486b36f76A591C9`](https://base-sepolia.blockscout.com/address/0xDAa1Cb9ED18685770BA6f2058486b36f76A591C9) | 1,000,000,000 total, minted once |
| Founder vesting (12%) | [`0xa676f0000ec7526a518ba35692C0Ec9E8Eb5c427`](https://base-sepolia.blockscout.com/address/0xa676f0000ec7526a518ba35692C0Ec9E8Eb5c427) | 120,000,000 |
| Contributors vesting (3%) | [`0xa930Eb534573b774C5d8Bd4a09C49D8445572844`](https://base-sepolia.blockscout.com/address/0xa930Eb534573b774C5d8Bd4a09C49D8445572844) | 30,000,000 |
| Foundation vesting (10%) | [`0xc9267c2b9FB618CFBa40A7C1D1F57caA9Ca0C404`](https://base-sepolia.blockscout.com/address/0xc9267c2b9FB618CFBa40A7C1D1F57caA9Ca0C404) | 100,000,000 |
| MerkleAirdrop (25%) | [`0xcBf281724D73910E754bC4456471E58931894271`](https://base-sepolia.blockscout.com/address/0xcBf281724D73910E754bC4456471E58931894271) | 250,000,000 |
| RewardsPool (25%) | [`0xFDcaBd22de4059756EfEc7EF50fC07c8233A7FCB`](https://base-sepolia.blockscout.com/address/0xFDcaBd22de4059756EfEc7EF50fC07c8233A7FCB) | 250,000,000 |
| Firepit | [`0x283F904a1888124EC8b3C92A89eA0642971648E9`](https://base-sepolia.blockscout.com/address/0x283F904a1888124EC8b3C92A89eA0642971648E9) | connected to the v0.2 FeeJar ([tx](https://sepolia.basescan.org/tx/0x4f58fee2d40d46d10723d3c78c3d63d948cfca1553b375804872a680f6c8bcd1)) |
| Launch reserve (25%) | testnet EOA | 250,000,000, until the auction and LP contracts exist |

Checked on-chain after deployment:
- `totalSupply()` is exactly 1,000,000,000 DEPTH, and the deployer holds 0 after genesis.
- Founder vesting: `start()` is 2027-10-06 (TGE + 1 year) and `duration()` is 3 years. `releasable()` is **0**, and `transferOwnership()` **reverts**, so the vesting contract cannot be transferred. The beneficiary will be a public multisig Safe whose signers are published.
- The airdrop proof built with `tools/airdrop` claimed on-chain ([tx](https://sepolia.basescan.org/tx/0x80664e2eb75fcf272b882899318717a8ca40741e362f815e0b2b576547428953)).

## Base mainnet (chain id 8453)

### Beta: v0.4 (2026-10-06). Unaudited.
Same code as the v0.4 testnet deployment. Two internal reviews, no independent audit yet. Use small amounts: the beta starts with the founder's own funds, then invited design partners. The public launch and any limit increase wait for the independent audit and its fix review (see `docs/MAINNET.md`).

| Contract | Address |
|---|---|
| FeeJar | [`0xa375245D25bdB557801Ad07A50c19b3442cA3Ae4`](https://base.blockscout.com/address/0xa375245D25bdB557801Ad07A50c19b3442cA3Ae4) ([tx](https://basescan.org/tx/0x49f822aed7d406532829a34e3c6e49a4a3643052e4aed178f2c50ebc984626e1)) |
| BudgetVaultFactory | [`0xDe17e1B889efa4671852e0b268e100967A7a257E`](https://base.blockscout.com/address/0xDe17e1B889efa4671852e0b268e100967A7a257E) ([tx](https://basescan.org/tx/0x7ee0b71299037569b06a3017898ef348832efb64576e09250c648fbda3385bc3)) |
| INITIALIZER and OPS (Safe v1.4.1, 1 of 1, founder's wallet) | [`0xcAE428c91f02Cca313DB1f83874543e41Cf33c60`](https://base.blockscout.com/address/0xcAE428c91f02Cca313DB1f83874543e41Cf33c60) |
| USDC (Circle) | [`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`](https://base.blockscout.com/address/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) |

- **First real x402 payments on mainnet (2026-10-06):** a vault funded with 1 USDC by the founder, 3 payments of 0.01 USDC settled to the merchant ([1](https://basescan.org/tx/0xf38e3a73b733ab7c44ec5bc542d4baeb60679cb79c305a10fa2f0b705ac06526) · [2](https://basescan.org/tx/0x2a26014ce442639e3d03b064272355d175a8135d7024fbf32bf801df9173f385) · [3](https://basescan.org/tx/0xeb38b7eec3cda9a5e3055e4cea89385aeb16bc54b92e9aa31ee339c7116b151f)). Reconciled on-chain: the merchant received exactly 0.03 USDC, the vault funded one 0.05 tranche plus a 0.00005 fee split 50/50 between the FeeJar and OPS, no double payment.
- Source verified on [Sourcify](https://sourcify.dev) (bytecode match), built from commit `732ef44`.
- Post-deploy checks passed: the factory's `USDC()`, `FEE_JAR()` and `OPS()`, the jar's `INITIALIZER()`, and `releaser()` = `0x0`.
- The deployer EOA `0xe81d982fD80ADCb5Bae5A105E2EE94Dd683d8C19` holds no role.
- Before the token launch or any public opening, the Safe moves to 2 of 3 signers with a hardware wallet.
