// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BudgetVault} from "../../src/safe/BudgetVault.sol";
import {BudgetVaultFactory} from "../../src/safe/BudgetVaultFactory.sol";
import {FeeJar} from "../../src/fees/FeeJar.sol";
import {Firepit} from "../../src/fees/Firepit.sol";
import {DepthToken} from "../../src/token/DepthToken.sol";
import {MerkleAirdrop} from "../../src/distribution/MerkleAirdrop.sol";
import {RewardsPool} from "../../src/distribution/RewardsPool.sol";
import {IBurnableToken} from "../../src/interfaces/IBurnableToken.sol";
import {MockFiatUSDC} from "../mocks/MockFiatUSDC.sol";

/// @dev Answers the two views FeeJar reads when a releaser is proposed.
contract FakeReleaser {
    address public immutable FEE_JAR;
    address public immutable DEPTH;

    constructor(address jar, address depth) {
        FEE_JAR = jar;
        DEPTH = depth;
    }
}

/// @notice Every constructor and setup guard rejects a bad deployment, and the FeeJar refuses a releaser whose code
///         changed after it was proposed.
contract ConstructorChecksTest is Test {
    IERC20 usdc = IERC20(address(new MockFiatUSDC()));
    address jar = makeAddr("jar");
    address ops = makeAddr("ops");
    address owner = makeAddr("owner");
    IBurnableToken token = IBurnableToken(makeAddr("token"));

    function test_BudgetVaultRejectsBadConfig() public {
        vm.expectRevert(BudgetVault.BadIntent.selector);
        new BudgetVault(address(0), usdc, jar, ops, 5_000, 1 hours);
        vm.expectRevert(BudgetVault.BadIntent.selector);
        new BudgetVault(owner, IERC20(address(0)), jar, ops, 5_000, 1 hours);
        vm.expectRevert(BudgetVault.BadIntent.selector);
        new BudgetVault(owner, usdc, address(0), ops, 5_000, 1 hours);
        vm.expectRevert(BudgetVault.BadIntent.selector);
        new BudgetVault(owner, usdc, jar, ops, 10_001, 1 hours);
        // A share below 100% sends the rest to OPS, so OPS must exist; at 100% it may be zero.
        vm.expectRevert(BudgetVault.BadIntent.selector);
        new BudgetVault(owner, usdc, jar, address(0), 9_999, 1 hours);
        new BudgetVault(owner, usdc, jar, address(0), 10_000, 1 hours);
        vm.expectRevert(BudgetVault.BadDelay.selector);
        new BudgetVault(owner, usdc, jar, ops, 5_000, 1 hours - 1);
        vm.expectRevert(BudgetVault.BadDelay.selector);
        new BudgetVault(owner, usdc, jar, ops, 5_000, 7 days + 1);
    }

    function test_FactoryRejectsZeroAddresses() public {
        vm.expectRevert(BudgetVaultFactory.ZeroAddress.selector);
        new BudgetVaultFactory(IERC20(address(0)), jar, ops);
        vm.expectRevert(BudgetVaultFactory.ZeroAddress.selector);
        new BudgetVaultFactory(usdc, address(0), ops);
        vm.expectRevert(BudgetVaultFactory.ZeroAddress.selector);
        new BudgetVaultFactory(usdc, jar, address(0));
    }

    function test_FeeJarRejectsZeroInitializerAndZeroReleaser() public {
        vm.expectRevert(FeeJar.ZeroAddress.selector);
        new FeeJar(address(0));
        FeeJar fj = new FeeJar(address(this));
        vm.expectRevert(FeeJar.ZeroAddress.selector);
        fj.proposeReleaser(address(0));
        vm.expectRevert(FeeJar.NoPendingReleaser.selector);
        fj.cancelReleaser();
    }

    /// The releaser that takes effect must be the exact code that was public during the 14-day review window.
    function test_FeeJarRefusesAReleaserWhoseCodeChanged() public {
        FeeJar fj = new FeeJar(address(this));
        FakeReleaser r = new FakeReleaser(address(fj), address(token));
        fj.proposeReleaser(address(r));
        skip(fj.RELEASER_DELAY());
        // Stand-in for a metamorphic contract: same address, different code.
        vm.etch(address(r), hex"00");
        vm.expectRevert(FeeJar.CodeChanged.selector);
        fj.acceptReleaser();
        assertEq(fj.releaser(), address(0));
    }

    function test_FirepitRejectsBadConfig() public {
        uint128 ok = 1_000_000e18;
        vm.expectRevert(Firepit.ZeroAddress.selector);
        new Firepit(IBurnableToken(address(0)), jar, ok, 0);
        vm.expectRevert(Firepit.ZeroAddress.selector);
        new Firepit(token, address(0), ok, 0);
        vm.expectRevert(Firepit.BadInitialThreshold.selector);
        new Firepit(token, jar, 10_000e18 - 1, 0);
        vm.expectRevert(Firepit.BadInitialThreshold.selector);
        new Firepit(token, jar, 10_000_000e18 + 1, 0);
    }

    function test_DepthTokenRejectsBadAllocations() public {
        address[] memory one = new address[](1);
        uint256[] memory two = new uint256[](2);
        vm.expectRevert(DepthToken.LengthMismatch.selector);
        new DepthToken(one, two);

        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1_000_000_000e18;
        vm.expectRevert(DepthToken.ZeroRecipient.selector);
        new DepthToken(one, amounts);

        one[0] = owner;
        amounts[0] = 0;
        vm.expectRevert(DepthToken.ZeroAmount.selector);
        new DepthToken(one, amounts);
    }

    function test_DistributionRejectsZeroAddresses() public {
        vm.expectRevert(MerkleAirdrop.ZeroAddress.selector);
        new MerkleAirdrop(
            IBurnableToken(address(0)), bytes32(uint256(1)), uint64(block.timestamp), uint64(block.timestamp + 1)
        );
        vm.expectRevert(RewardsPool.ZeroAddress.selector);
        new RewardsPool(IBurnableToken(address(0)), owner, uint64(block.timestamp));
        vm.expectRevert(RewardsPool.ZeroAddress.selector);
        new RewardsPool(token, address(0), uint64(block.timestamp));
    }

    /// A rewards start long in the past would release most of the pool at once (and let anyone burn it after the end).
    function test_RewardsPoolRejectsAStartInThePast() public {
        vm.warp(400 days);
        vm.expectRevert(RewardsPool.StartInPast.selector);
        new RewardsPool(token, owner, uint64(block.timestamp - 1 hours - 1));
        new RewardsPool(token, owner, uint64(block.timestamp - 1 hours));
    }
}
