# Base mainnet runbook (Agent Safe)

The order is fixed; every step lists who does it.

## 0. Gate
- [ ] Independent review done. Every finding fixed or documented. Report published in `docs/audit/`.
- [ ] Tag `audit-v1` matches the deployed bytecode (the explorer verification proves it).

**Beta exception.** The capped beta (section 6) is deployed before this gate, labeled unaudited, after two internal reviews and a full rehearsal on a mainnet fork. For the beta, one Safe holds both roles with the founder's wallet as its only signer. Before the token launch or any public opening, its signers move to 2 of 3 with a hardware wallet (a change made from the Safe itself; no contract changes). The public launch and any limit increase still wait for this gate.

## 1. Safes (founder)
Create two Safes on Base at app.safe.global:

| Safe | Role | Suggested signers |
|---|---|---|
| `INITIALIZER` | Connects the Firepit to the FeeJar, once | 2 of 3: hardware wallet, phone wallet, offline backup |
| `OPS` | Receives 50% of the fees | 2 of 3 (it can use the same signers) |

Write down both addresses. Send one test transaction from each Safe before using it.

## 2. Deployer key (founder)
- Use a fresh EOA used only for deploying, with about US$5 of ETH on Base: `cast wallet import dfs-mainnet-deployer --interactive`.
- It ends with no role. The script refuses to run if either role is the deployer or not a contract.

## 3. Rehearsal (anyone, free)
Our own run wraps these steps in one script: it creates the Safe (Safe v1.4.1 factory), deploys and runs the section 5 checks on a local fork of Base, and then repeats the identical steps live.

```bash
cd contracts
BASE_FORK_RPC=https://mainnet.base.org forge test --mc BaseMainnetForkTest
INITIALIZER=<safe> OPS=<safe> forge script script/DeployAgentSafe.s.sol --fork-url https://mainnet.base.org --sender <deployer>
```

## 4. Deploy (founder runs it; nothing else changes)
```bash
INITIALIZER=<safe> OPS=<safe> forge script script/DeployAgentSafe.s.sol \
  --rpc-url https://mainnet.base.org --account dfs-mainnet-deployer --broadcast \
  --verify --verifier blockscout --verifier-url https://base.blockscout.com/api/
```

## 5. Post-deploy checks
- `cast call <factory> "USDC()(address)"` returns `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.
- `FEE_JAR()` and `OPS()` match. On the FeeJar, `INITIALIZER()` matches and `releaser()` is `0x0`.
- Source is verified on Blockscout. Addresses go in `docs/DEPLOYMENTS.md`, the SDK and the site.

## 6. Guarded launch
- Beta label everywhere (site, README, SDK docs), with a recommended maximum balance per vault during the beta.
- Our own funds first: one vault, real x402 payments for 2 weeks.
- Then invited testers only (design partners), for 4 to 8 weeks.
- Bug bounty live before opening it publicly (see SECURITY.md).

## 7. Monitoring
`.github/workflows/monitor.yml` checks the deployment every 6 hours (`sdk/scripts/monitor.ts`); a failing run is the alert.
- Watch factory `VaultCreated`, vault `Paid`, `BurnerFunded`, `Withdrawn` and FeeJar `ReleaserSet` events.
- Alert on any `ReleaserSet` (it happens once, ever) and on unusual volume.
- Incident playbook: owners can `setPaused(true)` and `withdraw` instantly. Publish an advisory. Contact SEAL 911 if funds are at risk.
