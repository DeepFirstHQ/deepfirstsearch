// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IBurnableToken} from "../interfaces/IBurnableToken.sol";

/// @title Fixed rewards pool with halving releases
/// @notice Holds a fixed 250M allocation. Rewards are only ever paid from this pool; no token is ever minted.
///         Four epochs of two years release 125M, 62.5M, 31.25M and 15.625M linearly. Tokens leave the pool only when
///         the distributor pays real work. After eight years, anyone can burn whatever is left, including the
///         15.625M tail that is never scheduled.
contract RewardsPool {
    using SafeERC20 for IBurnableToken;

    uint256 public constant EPOCH = 730 days;
    uint256 public constant EPOCHS = 4;
    uint256 public constant FIRST_EPOCH_BUDGET = 125_000_000e18;

    IBurnableToken public immutable TOKEN;
    address public immutable DISTRIBUTOR;
    uint64 public immutable START;

    uint256 public claimed;

    event Paid(address indexed to, uint256 amount);
    event RemainderBurned(uint256 amount);

    error NotDistributor();
    error ExceedsVested(uint256 requested, uint256 available);
    error ProgramEnded();
    error ProgramRunning();
    error ZeroAddress();

    constructor(IBurnableToken token, address distributor, uint64 start) {
        if (address(token) == address(0) || distributor == address(0)) revert ZeroAddress();
        TOKEN = token;
        DISTRIBUTOR = distributor;
        START = start;
    }

    function end() public view returns (uint256) {
        return START + EPOCHS * EPOCH;
    }

    /// @notice Total amount released by the schedule at time `t`.
    function vested(uint256 t) public view returns (uint256 total) {
        if (t <= START) return 0;
        uint256 elapsed = t - START;
        uint256 budget = FIRST_EPOCH_BUDGET;
        for (uint256 i; i < EPOCHS; ++i) {
            if (elapsed < EPOCH) return total + (budget * elapsed) / EPOCH;
            total += budget;
            elapsed -= EPOCH;
            budget /= 2;
        }
    }

    function available() public view returns (uint256) {
        return vested(block.timestamp) - claimed;
    }

    function pay(address to, uint256 amount) external {
        if (msg.sender != DISTRIBUTOR) revert NotDistributor();
        if (block.timestamp >= end()) revert ProgramEnded();
        uint256 avail = available();
        if (amount > avail) revert ExceedsVested(amount, avail);
        claimed += amount;
        emit Paid(to, amount);
        TOKEN.safeTransfer(to, amount);
    }

    /// @notice Burns everything left once the program is over. Callable by anyone.
    function burnRemainder() external {
        if (block.timestamp < end()) revert ProgramRunning();
        uint256 amount = TOKEN.balanceOf(address(this));
        emit RemainderBurned(amount);
        TOKEN.burn(amount);
    }
}
