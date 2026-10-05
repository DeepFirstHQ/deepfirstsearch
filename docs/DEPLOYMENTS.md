# Deployments

## Base Sepolia (testnet, chain id 84532)

Deployed 2026-10-05 with `contracts/script/DeployAgentSafe.s.sol`. Source verified on Blockscout.

| Contract | Address |
|---|---|
| FeeJar | [`0xf1a033111cc49603B3da62A406C0e544D98e99bF`](https://base-sepolia.blockscout.com/address/0xf1a033111cc49603B3da62A406C0e544D98e99bF) |
| BudgetVaultFactory | [`0x48b2E4e63497540Ae975dC839A42D220ca171798`](https://base-sepolia.blockscout.com/address/0x48b2E4e63497540Ae975dC839A42D220ca171798) |
| USDC (Circle, testnet) | [`0x036CbD53842c5426634e7929541eC2318f3dCF7e`](https://base-sepolia.blockscout.com/address/0x036CbD53842c5426634e7929541eC2318f3dCF7e) |

Testnet setup:
- On testnet, the FeeJar initializer and the operations wallet are the deployer EOA, and no Firepit is connected (there is no token yet).
- On mainnet both roles will be multisig Safes.

### Live demo vault

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

## Base mainnet

Not deployed. Requires an independent security review first.
