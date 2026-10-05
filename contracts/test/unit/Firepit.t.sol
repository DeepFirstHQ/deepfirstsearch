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

        // The codehash of a Firepit does not depend on constructor args, so it can be pinned before the token exists.
        Firepit probe = new Firepit(IBurnableToken(address(1)), address(1), 100_000e18);
        jar = new FeeJar(initializer, address(probe).codehash);

        address[] memory r = new address[](1);
        uint256[] memory a = new uint256[](1);
        r[0] = searcher;
        a[0] = 1_000_000_000e18;
        depth = new DepthToken(r, a);
        pit = new Firepit(IBurnableToken(address(depth)), address(jar), 100_000e18);

        vm.prank(initializer);
        jar.setReleaser(address(pit));

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

    function test_ReleaserCanBeSetOnlyOnceAndOnlyToRealFirepitCode() public {
        vm.prank(initializer);
        vm.expectRevert(FeeJar.AlreadySet.selector);
        jar.setReleaser(address(pit));

        FeeJar fresh = new FeeJar(initializer, address(pit).codehash);
        vm.prank(initializer);
        vm.expectRevert(FeeJar.WrongReleaserCode.selector);
        fresh.setReleaser(address(usdc));

        // A genuine Firepit pointing at a different jar is rejected too.
        vm.prank(initializer);
        vm.expectRevert(FeeJar.WrongJar.selector);
        fresh.setReleaser(address(pit));
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
