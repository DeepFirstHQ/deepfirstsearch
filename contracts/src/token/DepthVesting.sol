// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {VestingWallet} from "@openzeppelin/contracts/finance/VestingWallet.sol";

/// @title Non-transferable vesting wallet
/// @notice OpenZeppelin's VestingWallet with ownership frozen. Upstream, the beneficiary can transfer ownership of
///         the wallet, which lets unvested tokens be sold over the counter. Here both `transferOwnership` and
///         `renounceOwnership` revert, so the beneficiary can only ever receive tokens as they vest.
/// @dev Schedule: nothing is releasable before `start`, then linear until `start + duration`. For "12-month lock,
///      then 36 months linear", deploy with start = TGE + 365 days and duration = 3 * 365 days. Use a Safe as the
///      beneficiary so signers can be rotated without moving the vesting position.
contract DepthVesting is VestingWallet {
    error OwnershipFrozen();

    constructor(address beneficiary, uint64 startTimestamp, uint64 durationSeconds)
        VestingWallet(beneficiary, startTimestamp, durationSeconds)
    {}

    function transferOwnership(address) public pure override {
        revert OwnershipFrozen();
    }

    function renounceOwnership() public pure override {
        revert OwnershipFrozen();
    }
}
