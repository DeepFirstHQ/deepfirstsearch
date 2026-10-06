// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {BudgetVault} from "../../src/safe/BudgetVault.sol";
import {BudgetVaultFactory} from "../../src/safe/BudgetVaultFactory.sol";
import {FeeJar} from "../../src/fees/FeeJar.sol";
import {Firepit} from "../../src/fees/Firepit.sol";
import {DepthToken} from "../../src/token/DepthToken.sol";
import {IBurnableToken} from "../../src/interfaces/IBurnableToken.sol";
import {MockFiatUSDC} from "../mocks/MockFiatUSDC.sol";

/// @dev Drives a vault with two intents that share one signed burner, a stolen-agent-key attacker trying to fund
///      arbitrary addresses, burner spends and sweeps, owner restrictions/withdrawals, fee-recipient blacklisting,
///      USDC pause, flushes and time jumps.
contract VaultHandler is Test {
    MockFiatUSDC public usdc;
    BudgetVault public vault;
    address public owner;
    address public agent;
    address public jar;
    address public ops;
    address public burner;
    uint256 internal burnerKey;
    address public attacker = makeAddr("attacker");
    address public sink = makeAddr("sink");
    address[2] public merchants;
    bytes32[2] public ids;
    uint128[2] public signedMaxPerPeriod;

    uint256 public minted;
    uint256 public feesCharged;
    uint256 public toBurnerFromVault;
    bool public trancheViolation;
    bool public windowViolation;
    bool public wrongRecipient;
    uint256 public maxWindowOut;
    uint256 internal nonceCtr;
    uint256 public nPay;
    uint256 public nFund;
    uint256 public nSweep;
    uint256 public nFlush;
    uint256 public nWithdraw;
    mapping(bytes32 id => mapping(uint256 window => uint256)) public windowOut;
    mapping(bytes32 id => mapping(uint256 window => uint256)) public windowOutWithFee;

    struct Config {
        MockFiatUSDC usdc;
        BudgetVault vault;
        address owner;
        address agent;
        address jar;
        address ops;
        address burner;
        uint256 burnerKey;
        address[2] merchants;
        bytes32[2] ids;
        uint128[2] maxPerPeriod;
        uint256 initial;
    }

    constructor(Config memory c) {
        usdc = c.usdc;
        vault = c.vault;
        owner = c.owner;
        agent = c.agent;
        jar = c.jar;
        ops = c.ops;
        burner = c.burner;
        burnerKey = c.burnerKey;
        merchants = c.merchants;
        ids = c.ids;
        signedMaxPerPeriod = c.maxPerPeriod;
        minted = c.initial;
    }

    function _window(bytes32 id) internal view returns (uint256) {
        BudgetVault.IntentState memory st = vault.getIntent(id);
        return (block.timestamp - st.activeAt) / st.intent.period;
    }

    function _record(uint256 w, uint256 amount) internal {
        bytes32 id = ids[w];
        uint256 win = _window(id);
        windowOut[id][win] += amount;
        windowOutWithFee[id][win] += amount + vault.feeFor(amount);
        feesCharged += vault.feeFor(amount);
        uint256 cap = signedMaxPerPeriod[w];
        if (windowOut[id][win] > cap) windowViolation = true;
        if (windowOutWithFee[id][win] > cap + vault.feeFor(cap)) windowViolation = true;
        if (windowOut[id][win] > maxWindowOut) maxWindowOut = windowOut[id][win];
    }

    function pay(uint256 w, uint256 amount, uint256 toSel) external {
        w = w % 2;
        amount = bound(amount, 1, 120e6);
        uint256 k = toSel % 6; // mostly the right merchant, sometimes the wrong one or an attacker
        address to = k <= 3 ? merchants[w] : k == 4 ? merchants[1 - w] : attacker;
        uint256 before = usdc.balanceOf(to);
        vm.prank(agent);
        try vault.pay(ids[w], to, amount) {
            if (to != merchants[w]) wrongRecipient = true;
            if (usdc.balanceOf(to) != before + amount) wrongRecipient = true;
            _record(w, amount);
            nPay++;
        } catch {}
    }

    function fundBurner(uint256 w, uint256 amount, uint256 sel) external {
        w = w % 2;
        amount = bound(amount, 1, 120e6);
        uint256 k = sel % 5;
        address b = k <= 1 ? burner : k == 2 ? attacker : k == 3 ? merchants[w] : address(vault);
        vm.prank(agent);
        try vault.fundBurner(ids[w], b, amount) {
            if (b != burner) wrongRecipient = true;
            if (usdc.balanceOf(b) > vault.getIntent(ids[w]).intent.trancheCap) trancheViolation = true;
            toBurnerFromVault += amount;
            _record(w, amount);
            nFund++;
        } catch {}
    }

    function burnerSpends(uint256 amount) external {
        uint256 bal = usdc.balanceOf(burner);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(burner);
        try usdc.transfer(sink, amount) {} catch {}
    }

    function sweep(uint256 amount, bytes32 nonce) external {
        uint256 bal = usdc.balanceOf(burner);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        bytes32 sh = keccak256(
            abi.encode(
                usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                burner,
                address(vault),
                amount,
                0,
                block.timestamp + 1 hours,
                nonce
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(burnerKey, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), sh)));
        vm.prank(attacker); // anyone can relay
        try vault.sweepBurner(burner, amount, 0, block.timestamp + 1 hours, nonce, abi.encodePacked(r, s, v)) {
            nSweep++;
        } catch {}
    }

    function donate(uint256 amount, bool toBurner) external {
        amount = bound(amount, 1, 50e6);
        usdc.mint(toBurner ? burner : address(vault), amount);
        minted += amount;
    }

    function ownerWithdraw(uint256 amount) external {
        amount = bound(amount, 0, usdc.balanceOf(address(vault)) / 20);
        vm.prank(owner);
        try vault.withdraw(owner, amount) {
            nWithdraw++;
        } catch {}
    }

    function ownerReduce(uint256 w, uint128 mpt, uint128 mpp, uint128 cap) external {
        if (w % 8 != 0) return; // rare, so spending stays reachable
        w = (w / 8) % 2;
        BudgetVault.Intent memory i = vault.getIntent(ids[w]).intent;
        mpp = uint128(bound(mpp, 0, i.maxPerPeriod));
        mpt = uint128(bound(mpt, 0, i.maxPerTx < mpp ? i.maxPerTx : mpp));
        cap = uint128(bound(cap, 0, i.trancheCap));
        vm.prank(owner);
        try vault.reduceIntent(ids[w], mpt, mpp, cap, i.expiry) {} catch {}
    }

    function ownerRevoke(uint256 w) external {
        if (w % 32 != 0) return; // rare
        w = w / 32;
        vm.prank(owner);
        vault.revokeIntent(ids[w % 2]);
    }

    function ownerPause(uint256 r) external {
        vm.prank(owner);
        vault.setPaused(r % 4 == 0);
    }

    function ownerInvalidate(uint256 n) external {
        vm.prank(owner);
        try vault.invalidateNonce(bound(n, 0, 64)) {} catch {}
        nonceCtr++;
    }

    function blacklistFeeRecipient(bool which, bool on) external {
        address a = which ? jar : ops;
        if (on && uint160(a) % 2 == block.timestamp % 2) usdc.blacklist(a);
        else usdc.unBlacklist(a);
    }

    function usdcPause(uint256 r) external {
        usdc.setPaused(r % 4 == 0);
    }

    function flush() external {
        try vault.flushFees() {
            nFlush++;
        } catch {}
    }

    function warp(uint256 dt) external {
        skip(bound(dt, 1, 2 days));
    }
}

contract FeeJarHandler is Test {
    FeeJar public jar;
    address public initializer;
    Firepit[3] public candidates;
    uint256 public lastProposeAt;
    address public lastProposed;
    bool public earlyAccept;
    bool public changedAfterSet;
    address public setOnce;

    constructor(FeeJar j, address init, Firepit[3] memory c) {
        jar = j;
        initializer = init;
        candidates = c;
    }

    function propose(uint256 k, bool asInitializer) external {
        address who = asInitializer && k % 4 == 0 ? initializer : msg.sender;
        vm.prank(who);
        try jar.proposeReleaser(address(candidates[k % 3])) {
            lastProposeAt = block.timestamp;
            lastProposed = address(candidates[k % 3]);
        } catch {}
    }

    function accept() external {
        try jar.acceptReleaser() {
            if (block.timestamp < lastProposeAt + 14 days || jar.releaser() != lastProposed) earlyAccept = true;
        } catch {}
        _track();
    }

    function warp(uint256 dt) external {
        skip(bound(dt, 1, 15 days));
        _track();
    }

    function _track() internal {
        address r = jar.releaser();
        if (setOnce == address(0)) setOnce = r;
        else if (r != setOnce) changedAfterSet = true;
    }
}

contract Audit2_InvariantsTest is StdInvariant, Test {
    VaultHandler h;
    FeeJarHandler fh;
    MockFiatUSDC usdc;
    BudgetVault vault;
    FeeJar feeJar;

    function setUp() public {
        VaultHandler.Config memory c;
        uint256 ownerKey;
        (c.owner, ownerKey) = makeAddrAndKey("owner");
        (c.burner, c.burnerKey) = makeAddrAndKey("burner");
        c.agent = makeAddr("agent");
        c.jar = makeAddr("jarAddr");
        c.ops = makeAddr("opsAddr");
        c.merchants = [makeAddr("m0"), makeAddr("m1")];
        usdc = new MockFiatUSDC();
        c.usdc = usdc;
        BudgetVaultFactory factory = new BudgetVaultFactory(usdc, c.jar, c.ops);
        vault = factory.create(c.owner, bytes32("inv"), 1 hours);
        c.vault = vault;
        usdc.mint(address(vault), 5_000e6);
        c.initial = 5_000e6;
        c.maxPerPeriod = [uint128(300e6), uint128(200e6)];
        uint128[2] memory caps = [uint128(50e6), uint128(80e6)];
        for (uint256 k; k < 2; ++k) {
            c.ids[k] = _proposeOne(c, ownerKey, caps[k], k);
        }
        skip(1 hours);
        h = new VaultHandler(c);
        _setUpJar();
        targetContract(address(h));
        targetContract(address(fh));
        bytes4[] memory sel = new bytes4[](15);
        sel[0] = VaultHandler.pay.selector;
        sel[1] = VaultHandler.pay.selector; // weight the spend paths
        sel[2] = VaultHandler.fundBurner.selector;
        sel[3] = VaultHandler.fundBurner.selector;
        sel[4] = VaultHandler.burnerSpends.selector;
        sel[5] = VaultHandler.sweep.selector;
        sel[6] = VaultHandler.donate.selector;
        sel[7] = VaultHandler.ownerWithdraw.selector;
        sel[8] = VaultHandler.ownerReduce.selector;
        sel[9] = VaultHandler.ownerRevoke.selector;
        sel[10] = VaultHandler.ownerPause.selector;
        sel[11] = VaultHandler.blacklistFeeRecipient.selector;
        sel[12] = VaultHandler.usdcPause.selector;
        sel[13] = VaultHandler.flush.selector;
        sel[14] = VaultHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
        bytes4[] memory fsel = new bytes4[](3);
        fsel[0] = FeeJarHandler.propose.selector;
        fsel[1] = FeeJarHandler.accept.selector;
        fsel[2] = FeeJarHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(fh), selectors: fsel}));
    }

    function _proposeOne(VaultHandler.Config memory c, uint256 ownerKey, uint128 cap, uint256 k)
        internal
        returns (bytes32)
    {
        BudgetVault.Intent memory i = BudgetVault.Intent({
            agent: c.agent,
            counterparty: c.merchants[k],
            burner: c.burner, // shared signed burner, different caps
            token: address(usdc),
            maxPerTx: 100e6,
            maxPerPeriod: c.maxPerPeriod[k],
            trancheCap: cap,
            period: 1 days,
            validAfter: 0,
            expiry: uint64(block.timestamp + 120 days),
            nonce: 1000 + k
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, vault.intentId(i));
        return vault.proposeIntent(i, abi.encodePacked(r, s, v));
    }

    function _setUpJar() internal {
        address initializer = makeAddr("initializer");
        feeJar = new FeeJar(initializer);
        address[] memory r = new address[](1);
        uint256[] memory a = new uint256[](1);
        r[0] = address(this);
        a[0] = 1_000_000_000e18;
        DepthToken d = new DepthToken(r, a);
        Firepit[3] memory c;
        for (uint256 k; k < 3; ++k) {
            c[k] = new Firepit(IBurnableToken(address(d)), address(feeJar), 10_000e18, 0);
        }
        fh = new FeeJarHandler(feeJar, initializer, c);
    }

    /// Per intent and window, outflow to counterparty + burners <= signed maxPerPeriod (and <= that + fee incl. fees).
    function invariant_WindowOutflowBounded() public view {
        assertFalse(h.windowViolation());
        assertLe(h.maxWindowOut(), 300e6);
    }

    /// Only the signed counterparty (pay) or the signed burner (fundBurner) ever receives from the agent paths.
    function invariant_OnlySignedRecipients() public view {
        assertFalse(h.wrongRecipient());
        assertEq(usdc.balanceOf(h.attacker()), 0);
    }

    /// Right after every successful fundBurner, the burner holds at most the intent's trancheCap.
    function invariant_TrancheCapAfterFunding() public view {
        assertFalse(h.trancheViolation());
    }

    /// Fees are either transferred or owed, never lost or double counted.
    function invariant_FeesTransferredOrOwed() public view {
        assertEq(usdc.balanceOf(h.jar()) + usdc.balanceOf(h.ops()) + vault.owedJar() + vault.owedOps(), h.feesCharged());
    }

    /// USDC is conserved across all actors (nothing is created or destroyed by the vault).
    function invariant_UsdcConserved() public view {
        uint256 sum = usdc.balanceOf(address(vault)) + usdc.balanceOf(h.burner()) + usdc.balanceOf(h.merchants(0))
            + usdc.balanceOf(h.merchants(1)) + usdc.balanceOf(h.sink()) + usdc.balanceOf(h.owner())
            + usdc.balanceOf(h.jar()) + usdc.balanceOf(h.ops()) + usdc.balanceOf(h.attacker());
        assertEq(sum, h.minted());
        assertEq(usdc.totalSupply(), h.minted());
    }

    /// Unless USDC is paused, the owner can always withdraw balance - owed, and never a unit more.
    function invariant_OwnerCanWithdrawAllButOwed() public {
        if (usdc.paused()) return;
        uint256 bal = usdc.balanceOf(address(vault));
        uint256 owed = vault.owedJar() + vault.owedOps();
        uint256 free = bal > owed ? bal - owed : 0;
        address o = h.owner();
        uint256 snap = vm.snapshotState();
        vm.prank(o);
        vault.withdraw(o, free);
        vm.prank(o);
        vm.expectRevert(BudgetVault.OwedFees.selector);
        vault.withdraw(o, free + 1);
        vm.revertToState(snap);
    }

    /// The FeeJar releaser is only set >= 14 days after the latest proposal, to the latest proposal, and never changes.
    function invariant_FeeJarReleaserTimelock() public view {
        assertFalse(fh.earlyAccept());
        assertFalse(fh.changedAfterSet());
        address r = feeJar.releaser();
        if (r != address(0)) assertEq(r, fh.setOnce());
    }

    /// The handler's success paths work (guards against a silently dead handler).
    function test_HandlerSmoke() public {
        h.pay(0, 10e6, 0);
        h.fundBurner(0, 10e6, 0);
        h.sweep(5e6, bytes32("x"));
        h.ownerWithdraw(1e6);
        h.flush();
        assertEq(h.nPay(), 1);
        assertEq(h.nFund(), 1);
        assertEq(h.nSweep(), 1);
    }
}
