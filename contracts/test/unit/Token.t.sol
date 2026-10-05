// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {DepthToken} from "../../src/token/DepthToken.sol";
import {DepthVesting} from "../../src/token/DepthVesting.sol";

contract DepthTokenTest is Test {
    DepthToken token;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        address[] memory r = new address[](2);
        uint256[] memory a = new uint256[](2);
        (r[0], r[1]) = (alice, bob);
        (a[0], a[1]) = (600_000_000e18, 400_000_000e18);
        token = new DepthToken(r, a);
    }

    function test_FixedSupplyMintedOnce() public view {
        assertEq(token.totalSupply(), 1_000_000_000e18);
        assertEq(token.balanceOf(alice), 600_000_000e18);
        assertEq(token.symbol(), "DEPTH");
        assertEq(token.decimals(), 18);
    }

    function test_HasNoMintOrOwnerFunction() public {
        (bool okMint,) = address(token).call(abi.encodeWithSignature("mint(address,uint256)", alice, 1));
        (bool okOwner,) = address(token).call(abi.encodeWithSignature("owner()"));
        assertFalse(okMint);
        assertFalse(okOwner);
    }

    function test_RevertWhen_TotalIsWrong() public {
        address[] memory r = new address[](1);
        uint256[] memory a = new uint256[](1);
        r[0] = alice;
        a[0] = 1;
        vm.expectRevert(abi.encodeWithSelector(DepthToken.WrongTotal.selector, 1));
        new DepthToken(r, a);
    }

    function testFuzz_BurnOnlyLowersSupply(uint256 amount) public {
        amount = bound(amount, 0, token.balanceOf(alice));
        uint256 before = token.totalSupply();
        vm.prank(alice);
        token.burn(amount);
        assertEq(token.totalSupply(), before - amount);
    }
}

contract DepthVestingTest is Test {
    DepthToken token;
    DepthVesting vesting;
    address founder = makeAddr("founderSafe");
    uint64 tge;
    uint256 constant ALLOCATION = 120_000_000e18;

    function setUp() public {
        tge = uint64(block.timestamp);
        vesting = new DepthVesting(founder, tge + 365 days, 3 * 365 days);
        address[] memory r = new address[](2);
        uint256[] memory a = new uint256[](2);
        (r[0], r[1]) = (address(vesting), address(this));
        (a[0], a[1]) = (ALLOCATION, 1_000_000_000e18 - ALLOCATION);
        token = new DepthToken(r, a);
    }

    function test_NothingReleasableDuringFirstYear() public {
        vm.warp(tge + 365 days);
        assertEq(vesting.releasable(address(token)), 0);
        vesting.release(address(token));
        assertEq(token.balanceOf(founder), 0);
    }

    function test_LinearAfterLockAndFullAtEnd() public {
        vm.warp(tge + 365 days + (3 * 365 days) / 2);
        assertEq(vesting.releasable(address(token)), ALLOCATION / 2);
        vm.warp(tge + 4 * 365 days);
        vesting.release(address(token));
        assertEq(token.balanceOf(founder), ALLOCATION);
    }

    function test_AnyoneCanTriggerReleaseButOnlyBeneficiaryReceives() public {
        vm.warp(tge + 2 * 365 days);
        vm.prank(makeAddr("stranger"));
        vesting.release(address(token));
        assertGt(token.balanceOf(founder), 0);
    }

    function test_CannotSellPositionByTransferringOwnership() public {
        vm.prank(founder);
        vm.expectRevert(DepthVesting.OwnershipFrozen.selector);
        vesting.transferOwnership(makeAddr("buyer"));
        vm.prank(founder);
        vm.expectRevert(DepthVesting.OwnershipFrozen.selector);
        vesting.renounceOwnership();
    }

    function testFuzz_ReleaseNeverExceedsSchedule(uint256 t) public {
        t = bound(t, tge, tge + 6 * 365 days);
        vm.warp(t);
        vesting.release(address(token));
        uint256 expected;
        uint256 start = tge + 365 days;
        if (t > start) expected = t >= start + 3 * 365 days ? ALLOCATION : (ALLOCATION * (t - start)) / (3 * 365 days);
        assertEq(token.balanceOf(founder), expected);
    }
}
