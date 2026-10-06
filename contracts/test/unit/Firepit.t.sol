// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {DepthToken} from "../../src/token/DepthToken.sol";
import {FeeJar} from "../../src/fees/FeeJar.sol";
import {Firepit} from "../../src/fees/Firepit.sol";
import {IBurnableToken} from "../../src/interfaces/IBurnableToken.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

contract FirepitTest is Test {
    DepthToken depth;
    MockUSDC usdc;
    FeeJar jar;
    Firepit pit;
    address searcher;
    uint256 searcherKey;
    address initializer = makeAddr("initializerSafe");

    function setUp() public {
        (searcher, searcherKey) = makeAddrAndKey("searcher");
        usdc = new MockUSDC();

        jar = new FeeJar(initializer);

        address[] memory r = new address[](1);
        uint256[] memory a = new uint256[](1);
        r[0] = searcher;
        a[0] = 1_000_000_000e18;
        depth = new DepthToken(r, a);
        // The auction starts when the jar connects, after the 14-day releaser timelock.
        pit = new Firepit(IBurnableToken(address(depth)), address(jar), 100_000e18, uint64(block.timestamp + 14 days));

        vm.prank(initializer);
        jar.proposeReleaser(address(pit));
        skip(jar.RELEASER_DELAY());
        jar.acceptReleaser();

        usdc.mint(address(jar), 5_000e6);
        vm.prank(searcher);
        depth.approve(address(pit), type(uint256).max);
    }

    function _assets() internal view returns (address[] memory a) {
        a = new address[](1);
        a[0] = address(usdc);
    }

    function test_BurnToClaimTheJar() public {
        uint256 t = pit.threshold();
        uint256 supply = depth.totalSupply();
        vm.prank(searcher);
        pit.release(_assets(), searcher, t);
        assertEq(usdc.balanceOf(searcher), 5_000e6);
        assertEq(usdc.balanceOf(address(jar)), 0);
        assertEq(depth.totalSupply(), supply - t);
    }

    function test_ThresholdDoublesAfterClaimAndHalvesOverTime() public {
        uint256 t0 = pit.threshold();
        vm.prank(searcher);
        pit.release(_assets(), searcher, t0);
        assertEq(pit.threshold(), 2 * t0);
        skip(pit.HALF_LIFE());
        assertEq(pit.threshold(), t0);
        skip(pit.HALF_LIFE() / 2);
        assertEq(pit.threshold(), (t0 * 3) / 4);
        skip(365 days);
        assertEq(pit.threshold(), pit.FLOOR());
    }

    function test_RevertWhen_ThresholdAboveCallerLimit() public {
        uint256 t = pit.threshold();
        vm.prank(searcher);
        vm.expectRevert(abi.encodeWithSelector(Firepit.ThresholdTooHigh.selector, t, t - 1));
        pit.release(_assets(), searcher, t - 1);
    }

    function test_JarCannotBeDrainedDirectly() public {
        vm.expectRevert(FeeJar.NotReleaser.selector);
        jar.release(_assets(), address(this));
    }

    function test_ReleaserIsSetOnceThroughAPublicTimelock() public {
        vm.prank(initializer);
        vm.expectRevert(FeeJar.AlreadySet.selector);
        jar.proposeReleaser(address(pit));

        FeeJar fresh = new FeeJar(initializer);
        // Only the initializer proposes, and the Firepit must point at this jar.
        vm.expectRevert(FeeJar.NotInitializer.selector);
        fresh.proposeReleaser(address(pit));
        vm.prank(initializer);
        vm.expectRevert(FeeJar.WrongJar.selector);
        fresh.proposeReleaser(address(pit));

        Firepit mine = new Firepit(IBurnableToken(address(depth)), address(fresh), 100_000e18, uint64(block.timestamp));
        vm.expectRevert(FeeJar.NoPendingReleaser.selector);
        fresh.acceptReleaser();
        vm.prank(initializer);
        fresh.proposeReleaser(address(mine));
        assertEq(fresh.pendingReleaser(), address(mine));
        vm.expectRevert(FeeJar.TooEarly.selector);
        fresh.acceptReleaser();
        skip(fresh.RELEASER_DELAY());
        fresh.acceptReleaser(); // anyone can finalize
        assertEq(fresh.releaser(), address(mine));
        vm.prank(initializer);
        vm.expectRevert(FeeJar.AlreadySet.selector);
        fresh.proposeReleaser(address(mine));
    }

    /// T-H-1 / S-M-3: a patched Firepit (different bytecode) can still be connected; nothing locks the jar.
    function test_AnyFirepitVersionCanBeConnected() public {
        FeeJar fresh = new FeeJar(initializer);
        Firepit later =
            new Firepit(IBurnableToken(address(depth)), address(fresh), 5_000_000e18, uint64(block.timestamp));
        vm.prank(initializer);
        fresh.proposeReleaser(address(later));
        skip(fresh.RELEASER_DELAY());
        fresh.acceptReleaser();
        assertEq(fresh.releaser(), address(later));
    }

    /// T-M-1: nothing can be claimed before START, and the auction starts from the initial threshold, not the floor.
    /// T-M-1 / A2-M-1: the auction stays at its ceiling until the Firepit is connected AND START passed; only then
    /// does it start descending. Time spent in the FeeJar's releaser timelock never cheapens the first claim.
    function test_AuctionArmsOnlyWhenConnectedAndStarted() public {
        FeeJar fresh = new FeeJar(initializer);
        uint64 start = uint64(block.timestamp + 7 days);
        Firepit late = new Firepit(IBurnableToken(address(depth)), address(fresh), 10_000_000e18, start);
        vm.prank(initializer);
        fresh.proposeReleaser(address(late));
        skip(30 days); // well past START, but not yet connected
        assertEq(late.threshold(), 10_000_000e18);
        vm.expectRevert(Firepit.NotConnected.selector);
        late.arm();
        fresh.acceptReleaser();
        assertEq(late.threshold(), 10_000_000e18);
        late.arm();
        assertTrue(late.armed());
        skip(late.HALF_LIFE());
        assertEq(late.threshold(), 5_000_000e18);
    }

    function test_CannotArmBeforeStart() public {
        FeeJar fresh = new FeeJar(initializer);
        Firepit early = new Firepit(
            IBurnableToken(address(depth)), address(fresh), 10_000_000e18, uint64(block.timestamp + 30 days)
        );
        vm.prank(initializer);
        fresh.proposeReleaser(address(early));
        skip(fresh.RELEASER_DELAY());
        fresh.acceptReleaser();
        vm.expectRevert(Firepit.NotStarted.selector);
        early.arm();
        vm.prank(searcher);
        vm.expectRevert(Firepit.NotStarted.selector);
        early.release(_assets(), searcher, type(uint256).max);
    }

    function test_InitializerCanCancelAPendingProposal() public {
        FeeJar fresh = new FeeJar(initializer);
        Firepit p1 = new Firepit(IBurnableToken(address(depth)), address(fresh), 100_000e18, uint64(block.timestamp));
        vm.prank(initializer);
        fresh.proposeReleaser(address(p1));
        assertEq(fresh.pendingCodehash(), address(p1).codehash);
        vm.expectRevert(FeeJar.NotInitializer.selector);
        fresh.cancelReleaser();
        vm.prank(initializer);
        fresh.cancelReleaser();
        skip(fresh.RELEASER_DELAY());
        vm.expectRevert(FeeJar.NoPendingReleaser.selector);
        fresh.acceptReleaser();
    }

    function test_ReleaseWithPermitSurvivesFrontRunPermit() public {
        vm.prank(searcher);
        depth.approve(address(pit), 0);
        uint256 t = pit.threshold();
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                depth.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                        searcher,
                        address(pit),
                        t,
                        depth.nonces(searcher),
                        deadline
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(searcherKey, digest);

        // A front-runner submits the permit first; the release must still go through.
        depth.permit(searcher, address(pit), t, deadline, v, r, s);
        vm.prank(searcher);
        pit.releaseWithPermit(_assets(), searcher, t, deadline, v, r, s);
        assertEq(usdc.balanceOf(searcher), 5_000e6);
    }

    function testFuzz_ThresholdAlwaysWithinBounds(uint256 wait, uint8 claims) public {
        claims = uint8(bound(claims, 0, 20));
        for (uint256 i; i < claims; ++i) {
            uint256 t = pit.threshold();
            vm.prank(searcher);
            pit.release(_assets(), searcher, t);
            skip(bound(uint256(keccak256(abi.encode(wait, i))), 0, 10 days));
        }
        skip(bound(wait, 0, 1_000 days));
        uint256 th = pit.threshold();
        assertGe(th, pit.FLOOR());
        assertLe(th, pit.CEIL());
    }
}
