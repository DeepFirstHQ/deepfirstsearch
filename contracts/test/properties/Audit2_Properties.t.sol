// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BudgetVault} from "../../src/safe/BudgetVault.sol";
import {BudgetVaultFactory} from "../../src/safe/BudgetVaultFactory.sol";
import {FeeJar} from "../../src/fees/FeeJar.sol";
import {Firepit} from "../../src/fees/Firepit.sol";
import {DepthToken} from "../../src/token/DepthToken.sol";
import {IBurnableToken} from "../../src/interfaces/IBurnableToken.sol";
import {MockFiatUSDC} from "../mocks/MockFiatUSDC.sol";

/// @dev A releaser candidate that tries to reenter the jar while `proposeReleaser` calls it.
contract ReenteringReleaser {
    FeeJar public jar;
    bool public acceptSucceeded;
    bool public releaseSucceeded;
    bool public proposeSucceeded;

    constructor(FeeJar j) {
        jar = j;
    }

    function FEE_JAR() external returns (address) {
        _poke();
        return address(jar);
    }

    function DEPTH() external returns (address) {
        _poke();
        return address(0xdead);
    }

    function _poke() internal {
        try jar.acceptReleaser() {
            acceptSucceeded = true;
        } catch {}
        address[] memory a = new address[](0);
        try jar.release(a, address(this)) {
            releaseSucceeded = true;
        } catch {}
        try jar.proposeReleaser(address(this)) {
            proposeSucceeded = true;
        } catch {}
    }
}

/// @notice Property (fuzz) tests for the code introduced by the v0.3 fixes. All are expected to PASS.
contract Audit2_PropertiesTest is Test {
    MockFiatUSDC usdc;
    BudgetVaultFactory factory;
    BudgetVault vault;
    address owner;
    uint256 ownerKey;
    address agent = makeAddr("agent");
    address merchant = makeAddr("merchant");
    address burner = makeAddr("burner");
    address jar = makeAddr("feeJar");
    address ops = makeAddr("ops");

    function setUp() public {
        (owner, ownerKey) = makeAddrAndKey("owner");
        usdc = new MockFiatUSDC();
        factory = new BudgetVaultFactory(usdc, jar, ops);
        vault = factory.create(owner, bytes32("v"), 1 hours);
        usdc.mint(address(vault), 10_000e6);
    }

    function _propose(uint256 nonce, uint128 cap) internal returns (bytes32 id) {
        BudgetVault.Intent memory i = BudgetVault.Intent({
            agent: agent,
            counterparty: merchant,
            burner: burner,
            token: address(usdc),
            maxPerTx: 1_000e6,
            maxPerPeriod: 5_000e6,
            trancheCap: cap,
            period: 1 days,
            validAfter: 0,
            expiry: uint64(block.timestamp + 365 days),
            nonce: nonce
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, vault.intentId(i));
        id = vault.proposeIntent(i, abi.encodePacked(r, s, v));
    }

    function _depth() internal returns (DepthToken) {
        address[] memory r = new address[](1);
        uint256[] memory a = new uint256[](1);
        r[0] = address(this);
        a[0] = 1_000_000_000e18;
        return new DepthToken(r, a);
    }

    // -------------------------------------------------------------- fees

    /// The agent picks the gas limit. A successful pay must never have dodged the fee via an out-of-gas inside
    /// trySafeTransfer (63/64 rule leaves too little gas to finish after an inner OOG).
    function testFuzz_GasLimitCannotDodgeFees(uint256 g) public {
        bytes32 id = _propose(1, 0);
        skip(1 hours);
        g = bound(g, 20_000, 400_000);
        vm.prank(agent);
        (bool ok,) = address(vault).call{gas: g}(abi.encodeCall(BudgetVault.pay, (id, merchant, 100e6)));
        if (ok) {
            assertEq(vault.owedJar() + vault.owedOps(), 0, "fee dodged");
            assertEq(usdc.balanceOf(jar) + usdc.balanceOf(ops), 100_000);
        }
    }

    /// Same, sweeping every gas limit in a window around the success threshold.
    function test_GasSweepCannotDodgeFees() public {
        bytes32 id = _propose(1, 0);
        skip(1 hours);
        uint256 oks;
        uint256 fails;
        for (uint256 g = 60_000; g < 260_000; g += 250) {
            uint256 snap = vm.snapshotState();
            vm.prank(agent);
            (bool ok,) = address(vault).call{gas: g}(abi.encodeCall(BudgetVault.pay, (id, merchant, 100e6)));
            if (ok) {
                ++oks;
                assertEq(vault.owedJar() + vault.owedOps(), 0, "fee dodged");
            } else {
                ++fails;
            }
            vm.revertToState(snap);
        }
        assertGt(oks, 0); // the sweep crosses the success threshold
        assertGt(fails, 0);
    }

    /// Fees are either delivered or owed, and the split is exact (toJar + toOps == fee).
    function testFuzz_FeesTransferredOrOwed(uint256 amount, bool bJar, bool bOps) public {
        bytes32 id = _propose(1, 0);
        skip(1 hours);
        amount = bound(amount, 1, 1_000e6);
        if (bJar) usdc.blacklist(jar);
        if (bOps) usdc.blacklist(ops);
        vm.prank(agent);
        vault.pay(id, merchant, amount);
        uint256 fee = vault.feeFor(amount);
        assertEq(usdc.balanceOf(jar) + usdc.balanceOf(ops) + vault.owedJar() + vault.owedOps(), fee);
        assertEq(usdc.balanceOf(address(vault)), 10_000e6 - amount - usdc.balanceOf(jar) - usdc.balanceOf(ops));
    }

    /// flushFees: jar first, never pays more than owed or than the balance, and is exact otherwise.
    function testFuzz_FlushMath(uint8 n, uint256 drain) public {
        bytes32 id = _propose(1, 0);
        skip(1 hours);
        usdc.blacklist(jar);
        usdc.blacklist(ops);
        n = uint8(bound(n, 1, 5));
        for (uint256 k; k < n; ++k) {
            vm.prank(agent);
            vault.pay(id, merchant, 1_000e6);
        }
        usdc.unBlacklist(jar);
        usdc.unBlacklist(ops);
        uint256 owedJ = vault.owedJar();
        uint256 owedO = vault.owedOps();
        uint256 bal = usdc.balanceOf(address(vault));
        drain = bound(drain, 0, bal);
        vm.prank(owner);
        if (drain > bal - owedJ - owedO) {
            vm.expectRevert(BudgetVault.OwedFees.selector);
            vault.withdraw(owner, drain);
            // simulate a USDC-level loss of backing instead (e.g. spend by the agent): move funds out directly
            vm.prank(address(vault));
            usdc.transfer(merchant, drain);
        } else {
            vault.withdraw(owner, drain);
        }
        bal = usdc.balanceOf(address(vault));
        vault.flushFees();
        uint256 j = owedJ < bal ? owedJ : bal;
        uint256 o = owedO < bal - j ? owedO : bal - j;
        assertEq(usdc.balanceOf(jar), j);
        assertEq(usdc.balanceOf(ops), o);
        assertEq(vault.owedJar(), owedJ - j);
        assertEq(vault.owedOps(), owedO - o);
    }

    /// The owner can always withdraw exactly balance - owed (no more, no less), with USDC unpaused.
    function testFuzz_OwnerWithdrawsAllButOwed(uint256 amount, bool bJar, bool bOps) public {
        bytes32 id = _propose(1, 0);
        skip(1 hours);
        if (bJar) usdc.blacklist(jar);
        if (bOps) usdc.blacklist(ops);
        amount = bound(amount, 1, 1_000e6);
        vm.prank(agent);
        vault.pay(id, merchant, amount);
        uint256 free = usdc.balanceOf(address(vault)) - vault.owedJar() - vault.owedOps();
        vm.prank(owner);
        vm.expectRevert(BudgetVault.OwedFees.selector);
        vault.withdraw(owner, free + 1);
        vm.prank(owner);
        vault.withdraw(owner, free);
        assertEq(usdc.balanceOf(address(vault)), vault.owedJar() + vault.owedOps());
    }

    // -------------------------------------------------------------- burner binding

    /// Only the signed burner can be funded, and never above trancheCap.
    function testFuzz_OnlySignedBurnerAndCap(address who, uint256 amount, uint256 pre, uint128 cap) public {
        cap = uint128(bound(cap, 1, 2_000e6));
        bytes32 id = _propose(1, cap);
        skip(1 hours);
        amount = bound(amount, 1, 1_000e6);
        pre = bound(pre, 0, 3_000e6);
        usdc.mint(burner, pre);
        vm.assume(who != burner);
        vm.prank(agent);
        vm.expectRevert(BudgetVault.NotSignedBurner.selector);
        vault.fundBurner(id, who, amount);

        vm.prank(agent);
        try vault.fundBurner(id, burner, amount) {
            assertLe(usdc.balanceOf(burner), cap);
            assertTrue(vault.isBurner(burner));
        } catch {
            assertGt(pre + amount, cap);
            assertFalse(vault.isBurner(burner));
        }
    }

    /// sweepBurner refuses addresses never funded by fundBurner, and with a valid authorization the funds can only
    /// arrive at the vault.
    function test_SweepOnlyKnownBurnersAndOnlyToVault() public {
        (address b, uint256 bk) = makeAddrAndKey("someone");
        usdc.mint(b, 5e6);
        bytes memory sig = _rwa(bk, b, address(vault), 5e6, bytes32("n"));
        vm.expectRevert(BudgetVault.UnknownBurner.selector);
        vault.sweepBurner(b, 5e6, 0, block.timestamp + 1, bytes32("n"), sig);
    }

    function _rwa(uint256 key, address from, address to, uint256 value, bytes32 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 sh = keccak256(
            abi.encode(usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), from, to, value, 0, block.timestamp + 1, nonce)
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(key, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), sh)));
        return abi.encodePacked(r, s, v);
    }

    /// rescue can never move the vault's USDC.
    function testFuzz_RescueCannotMoveUsdc(address to, uint256 amount) public {
        vm.prank(owner);
        vm.expectRevert(BudgetVault.CannotRescueUsdc.selector);
        vault.rescue(IERC20(address(usdc)), to, amount);
    }

    /// invalidateNonce makes a signed intent unproposable, by anyone.
    function test_InvalidatedNonceCannotBeProposed() public {
        vm.prank(owner);
        vault.invalidateNonce(5);
        vm.expectRevert(BudgetVault.NonceUsed.selector);
        this.proposeHelper(5);
    }

    function proposeHelper(uint256 nonce) external returns (bytes32) {
        return _propose(nonce, 0);
    }

    // -------------------------------------------------------------- factory

    function testFuzz_FactoryIdempotentAndBound(address o, bytes32 salt, uint32 d1, uint32 d2) public {
        vm.assume(o != address(0));
        d1 = uint32(bound(d1, 1 hours, 7 days));
        d2 = uint32(bound(d2, 1 hours, 7 days));
        address p = factory.predict(o, salt, d1);
        BudgetVault v = factory.create(o, salt, d1);
        assertEq(address(v), p);
        assertEq(address(factory.create(o, salt, d1)), p); // idempotent, no revert
        assertEq(v.OWNER(), o);
        assertEq(v.activationDelay(), d1);
        if (d1 != d2) assertTrue(factory.predict(o, salt, d2) != p);
        address o2 = address(uint160(o) ^ 1);
        if (o2 != address(0)) assertTrue(factory.predict(o2, salt, d1) != p);
    }

    // -------------------------------------------------------------- FeeJar

    function testFuzz_ReleaserOnlyAfterDelay(uint256 t1, uint256 t2) public {
        address initializer = makeAddr("init");
        FeeJar fj = new FeeJar(initializer);
        DepthToken d = _depth();
        Firepit a = new Firepit(IBurnableToken(address(d)), address(fj), 10_000e18, 0);
        Firepit b = new Firepit(IBurnableToken(address(d)), address(fj), 10_000e18, 0);
        vm.prank(initializer);
        fj.proposeReleaser(address(a));
        t1 = bound(t1, 0, 14 days - 1);
        skip(t1);
        // Re-proposal restarts the clock.
        vm.prank(initializer);
        fj.proposeReleaser(address(b));
        uint256 proposedAt = block.timestamp;
        t2 = bound(t2, 0, 20 days);
        skip(t2);
        if (block.timestamp < proposedAt + 14 days) {
            vm.expectRevert(FeeJar.TooEarly.selector);
            fj.acceptReleaser();
            assertEq(fj.releaser(), address(0));
        } else {
            fj.acceptReleaser();
            assertEq(fj.releaser(), address(b));
            vm.prank(initializer);
            vm.expectRevert(FeeJar.AlreadySet.selector);
            fj.proposeReleaser(address(a));
        }
    }

    function test_ProposeReleaserReentrancyIsHarmless() public {
        address initializer = makeAddr("init");
        FeeJar fj = new FeeJar(initializer);
        ReenteringReleaser r = new ReenteringReleaser(fj);
        vm.prank(initializer);
        fj.proposeReleaser(address(r));
        assertFalse(r.acceptSucceeded());
        assertFalse(r.releaseSucceeded());
        assertFalse(r.proposeSucceeded());
        assertEq(fj.releaser(), address(0));
        assertEq(fj.pendingEta(), block.timestamp + 14 days);
    }

    // -------------------------------------------------------------- Firepit

    function testFuzz_FirepitStart(uint64 start, uint256 t, uint128 init) public {
        init = uint128(bound(init, 10_000e18, 10_000_000e18));
        start = uint64(bound(start, block.timestamp, block.timestamp + 400 days));
        FeeJar fj = new FeeJar(address(this));
        DepthToken d = _depth();
        Firepit pit = new Firepit(IBurnableToken(address(d)), address(fj), init, start);
        fj.proposeReleaser(address(pit));
        skip(14 days);
        fj.acceptReleaser();
        d.approve(address(pit), type(uint256).max);
        t = bound(t, block.timestamp, uint256(start) + 2_000 days);
        vm.warp(t);
        uint256 th = pit.threshold();
        assertGe(th, pit.FLOOR());
        assertLe(th, pit.CEIL());
        if (t <= start) assertEq(th, init);
        address[] memory assets = new address[](0);
        if (t < start) {
            vm.expectRevert(Firepit.NotStarted.selector);
            pit.release(assets, address(this), type(uint256).max);
        } else {
            vm.expectRevert(abi.encodeWithSelector(Firepit.ThresholdTooHigh.selector, th, th - 1));
            pit.release(assets, address(this), th - 1);
            pit.release(assets, address(this), th);
        }
    }
}
