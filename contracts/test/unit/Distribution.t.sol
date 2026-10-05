// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {DepthToken} from "../../src/token/DepthToken.sol";
import {MerkleAirdrop} from "../../src/distribution/MerkleAirdrop.sol";
import {RewardsPool} from "../../src/distribution/RewardsPool.sol";
import {IBurnableToken} from "../../src/interfaces/IBurnableToken.sol";

contract MerkleAirdropTest is Test {
    DepthToken token;
    MerkleAirdrop airdrop;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    bytes32 leafA;
    bytes32 leafB;
    uint64 deadline;

    function _leaf(uint256 i, address a, uint256 amt) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(i, a, amt))));
    }

    function setUp() public {
        leafA = _leaf(0, alice, 100e18);
        leafB = _leaf(1, bob, 200e18);
        bytes32 root = leafA < leafB ? keccak256(abi.encode(leafA, leafB)) : keccak256(abi.encode(leafB, leafA));
        deadline = uint64(block.timestamp + 90 days);

        // Predict the airdrop address so it can receive its allocation at genesis.
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        address[] memory r = new address[](2);
        uint256[] memory a = new uint256[](2);
        (r[0], r[1]) = (predicted, address(this));
        (a[0], a[1]) = (300e18, 1_000_000_000e18 - 300e18);
        token = new DepthToken(r, a);
        airdrop = new MerkleAirdrop(IBurnableToken(address(token)), root, deadline);
        assertEq(address(airdrop), predicted);
    }

    function _proof(bytes32 sibling) internal pure returns (bytes32[] memory p) {
        p = new bytes32[](1);
        p[0] = sibling;
    }

    function test_ClaimSendsToLeafAccountEvenIfRelayed() public {
        vm.prank(makeAddr("relayer"));
        airdrop.claim(0, alice, 100e18, _proof(leafB));
        assertEq(token.balanceOf(alice), 100e18);
        assertTrue(airdrop.isClaimed(0));
    }

    function test_RevertWhen_DoubleClaim() public {
        airdrop.claim(1, bob, 200e18, _proof(leafA));
        vm.expectRevert(MerkleAirdrop.AlreadyClaimed.selector);
        airdrop.claim(1, bob, 200e18, _proof(leafA));
    }

    function test_RevertWhen_AmountTampered() public {
        vm.expectRevert(MerkleAirdrop.InvalidProof.selector);
        airdrop.claim(0, alice, 1_000e18, _proof(leafB));
    }

    function test_RevertWhen_ClaimAfterDeadline() public {
        vm.warp(deadline + 1);
        vm.expectRevert(MerkleAirdrop.ClaimWindowClosed.selector);
        airdrop.claim(0, alice, 100e18, _proof(leafB));
    }

    function test_UnclaimedIsBurnedNotSwept() public {
        airdrop.claim(0, alice, 100e18, _proof(leafB));
        vm.expectRevert(MerkleAirdrop.ClaimWindowOpen.selector);
        airdrop.burnUnclaimed();

        vm.warp(deadline + 1);
        uint256 supply = token.totalSupply();
        airdrop.burnUnclaimed();
        assertEq(token.totalSupply(), supply - 200e18);
        assertEq(token.balanceOf(address(airdrop)), 0);
    }
}

contract RewardsPoolTest is Test {
    DepthToken token;
    RewardsPool pool;
    address distributor = makeAddr("distributorSafe");
    uint64 start;
    uint256 constant POOL = 250_000_000e18;

    function setUp() public {
        start = uint64(block.timestamp);
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        address[] memory r = new address[](2);
        uint256[] memory a = new uint256[](2);
        (r[0], r[1]) = (predicted, address(this));
        (a[0], a[1]) = (POOL, 1_000_000_000e18 - POOL);
        token = new DepthToken(r, a);
        pool = new RewardsPool(IBurnableToken(address(token)), distributor, start);
    }

    function test_HalvingSchedule() public view {
        uint256 e = pool.EPOCH();
        assertEq(pool.vested(start), 0);
        assertEq(pool.vested(start + e / 2), 62_500_000e18);
        assertEq(pool.vested(start + e), 125_000_000e18);
        assertEq(pool.vested(start + 2 * e), 187_500_000e18);
        assertEq(pool.vested(start + 3 * e), 218_750_000e18);
        assertEq(pool.vested(start + 4 * e), 234_375_000e18);
        assertEq(pool.vested(start + 10 * e), 234_375_000e18);
    }

    function test_OnlyDistributorPaysAndOnlyWhatVested() public {
        vm.warp(start + 30 days);
        uint256 avail = pool.available();
        vm.expectRevert(RewardsPool.NotDistributor.selector);
        pool.pay(address(this), 1);

        vm.prank(distributor);
        vm.expectRevert(abi.encodeWithSelector(RewardsPool.ExceedsVested.selector, avail + 1, avail));
        pool.pay(makeAddr("keeper"), avail + 1);

        vm.prank(distributor);
        pool.pay(makeAddr("keeper"), avail);
        assertEq(pool.available(), 0);
    }

    function test_RemainderIsBurnedAfterEightYears() public {
        vm.warp(start + 365 days);
        vm.prank(distributor);
        pool.pay(makeAddr("keeper"), 1_000e18);

        vm.expectRevert(RewardsPool.ProgramRunning.selector);
        pool.burnRemainder();

        vm.warp(pool.end());
        vm.prank(distributor);
        vm.expectRevert(RewardsPool.ProgramEnded.selector);
        pool.pay(makeAddr("keeper"), 1);

        uint256 supply = token.totalSupply();
        pool.burnRemainder();
        assertEq(token.totalSupply(), supply - (POOL - 1_000e18));
    }
}
