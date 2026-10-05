// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title Deep First Search token ($DEPTH)
/// @notice Fixed supply, minted once in the constructor. There is no owner, no mint function, no pause,
///         no blacklist, no transfer tax and no upgrade path. Supply can only go down, through burns.
contract DepthToken is ERC20, ERC20Burnable, ERC20Permit {
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;

    error LengthMismatch();
    error ZeroRecipient();
    error ZeroAmount();
    error WrongTotal(uint256 total);

    constructor(address[] memory recipients, uint256[] memory amounts)
        ERC20("Deep First Search", "DEPTH")
        ERC20Permit("Deep First Search")
    {
        if (recipients.length != amounts.length) revert LengthMismatch();
        uint256 total = 0;
        for (uint256 i; i < recipients.length; ++i) {
            if (recipients[i] == address(0)) revert ZeroRecipient();
            if (amounts[i] == 0) revert ZeroAmount();
            total += amounts[i];
            _mint(recipients[i], amounts[i]);
        }
        if (total != TOTAL_SUPPLY) revert WrongTotal(total);
    }
}
