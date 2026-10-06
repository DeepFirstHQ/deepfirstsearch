// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {MockUSDC} from "./MockUSDC.sol";

/// @notice MockUSDC plus the FiatToken v2.2 blacklist and pause semantics that matter for the audit:
///         every balance movement reverts while paused, or when msg.sender, `from` or `to` is blacklisted.
contract MockFiatUSDC is MockUSDC {
    mapping(address => bool) public isBlacklisted;
    bool public paused;

    function blacklist(address a) external {
        isBlacklisted[a] = true;
    }

    function unBlacklist(address a) external {
        isBlacklisted[a] = false;
    }

    function setPaused(bool p) external {
        paused = p;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!paused, "Pausable: paused");
        require(!isBlacklisted[msg.sender], "Blacklistable: account is blacklisted");
        require(!isBlacklisted[from], "Blacklistable: account is blacklisted");
        require(!isBlacklisted[to], "Blacklistable: account is blacklisted");
        super._update(from, to, value);
    }
}

/// @notice A second ERC-20 (e.g. bridged USDbC on Base) sent to a vault by mistake.
contract MockOtherToken is MockUSDC {}
