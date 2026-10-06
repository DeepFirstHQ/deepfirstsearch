// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {DepthToken} from "../../src/token/DepthToken.sol";
import {DepthVesting} from "../../src/token/DepthVesting.sol";
import {Firepit} from "../../src/fees/Firepit.sol";
import {RewardsPool} from "../../src/distribution/RewardsPool.sol";
import {BudgetVault} from "../../src/safe/BudgetVault.sol";
import {IBurnableToken} from "../../src/interfaces/IBurnableToken.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/// @notice Symbolic proofs, run with Halmos (`halmos --function testProperty_`). Every parameter is symbolic, so each
///         property is proven for ALL inputs, not sampled like fuzzing. Foundry also runs them as fuzz tests.
contract SymbolicTest {
    // Plain cheatcode handle (no forge-std Test base) to stay compatible with Halmos.
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 constant SUPPLY = 1_000_000_000e18;
    bool public constant IS_TEST = true; // marks this as a test contract for Halmos

    /// The firepit price for burning is always within its published bounds, for any start and any elapsed time.
    function testProperty_firepitThresholdAlwaysBounded(uint128 initial, uint64 elapsed) public {
        vm.assume(initial >= 10_000e18 && initial <= 10_000_000e18);
        Firepit pit = new Firepit(IBurnableToken(address(0xBEEF)), address(0xCAFE), initial, uint64(block.timestamp));
        vm.warp(block.timestamp + elapsed);
        uint256 t = pit.threshold();
        assert(t >= pit.FLOOR());
        assert(t <= pit.CEIL());
    }

    /// The rewards schedule never releases more than its 234.375M scheduled total, and never decreases.
    function testProperty_rewardsVestedBoundedAndMonotonic(uint64 a, uint64 b) public {
        RewardsPool pool = new RewardsPool(IBurnableToken(address(0xBEEF)), address(0xD15), 1_000_000);
        vm.assume(a <= b);
        uint256 va = pool.vested(a);
        uint256 vb = pool.vested(b);
        assert(vb <= 234_375_000e18);
        assert(va <= vb);
    }

    /// Before its start, a vesting wallet releases nothing, whatever the time.
    function testProperty_vestingNothingBeforeStart(uint64 start, uint64 duration, uint64 now_) public {
        vm.assume(duration > 0 && start > 0 && now_ < start);
        address[] memory r = new address[](1);
        uint256[] memory a = new uint256[](1);
        DepthVesting v = new DepthVesting(address(0xF00), start, duration);
        r[0] = address(v);
        a[0] = SUPPLY;
        DepthToken token = new DepthToken(r, a);
        vm.warp(now_);
        assert(v.releasable(address(token)) == 0);
    }

    /// Burning never increases supply, and transfers never change it.
    function testProperty_supplyOnlyGoesDown(uint256 burnAmount, uint256 sendAmount) public {
        address[] memory r = new address[](1);
        uint256[] memory a = new uint256[](1);
        r[0] = address(this);
        a[0] = SUPPLY;
        DepthToken token = new DepthToken(r, a);
        vm.assume(burnAmount <= SUPPLY && sendAmount <= SUPPLY - burnAmount);
        token.burn(burnAmount);
        assert(token.totalSupply() == SUPPLY - burnAmount);
        token.transfer(address(0x1234), sendAmount);
        assert(token.totalSupply() == SUPPLY - burnAmount);
    }

    /// Only the owner can pause, withdraw, restrict or revoke: any other caller reverts.
    function testProperty_onlyOwnerControlsTheVault(address caller, bytes32 id) public {
        MockUSDC usdc = new MockUSDC();
        address owner = address(0xA11CE);
        vm.assume(caller != owner);
        BudgetVault vault = new BudgetVault(owner, usdc, address(0xFEE), address(0x0B5), 5_000, 1 hours);

        vm.startPrank(caller);
        (bool okPause,) = address(vault).call(abi.encodeCall(BudgetVault.setPaused, (true)));
        (bool okWithdraw,) = address(vault).call(abi.encodeCall(BudgetVault.withdraw, (caller, 1)));
        (bool okRevoke,) = address(vault).call(abi.encodeCall(BudgetVault.revokeIntent, (id)));
        (bool okDelay,) = address(vault).call(abi.encodeCall(BudgetVault.setActivationDelay, (2 hours)));
        vm.stopPrank();
        assert(!okPause && !okWithdraw && !okRevoke && !okDelay);
    }
}
