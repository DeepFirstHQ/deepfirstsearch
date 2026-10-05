// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IFirepitView {
    function FEE_JAR() external view returns (address);
}

/// @title Fee jar
/// @notice Collects protocol fees (USDC). Has no owner and no withdraw function: the only way out is `release`,
///         callable solely by the Firepit, which first burns $DEPTH.
/// @dev The jar exists before the token, so Agent Safe can earn fees before any token is launched. The Firepit is
///      connected exactly once by `INITIALIZER`, and only if its runtime code matches `RELEASER_CODEHASH` (the audited
///      Firepit bytecode). Remaining trust: the initializer picks the Firepit instance, so anyone should check that
///      `Firepit.DEPTH()` is the official token before relying on it. The `ReleaserSet` event makes this public.
///      Only Agent Safe, SDK and inference fees may be routed here, never fees from any privacy pool.
contract FeeJar {
    using SafeERC20 for IERC20;

    address public immutable INITIALIZER;
    bytes32 public immutable RELEASER_CODEHASH;
    address public releaser;

    event ReleaserSet(address indexed releaser);
    event Released(address indexed asset, address indexed to, uint256 amount);

    error NotInitializer();
    error AlreadySet();
    error WrongReleaserCode();
    error WrongJar();
    error NotReleaser();
    error ZeroAddress();

    constructor(address initializer, bytes32 releaserCodehash) {
        if (initializer == address(0)) revert ZeroAddress();
        INITIALIZER = initializer;
        RELEASER_CODEHASH = releaserCodehash;
    }

    function setReleaser(address newReleaser) external {
        if (msg.sender != INITIALIZER) revert NotInitializer();
        if (releaser != address(0)) revert AlreadySet();
        if (newReleaser == address(0)) revert ZeroAddress();
        if (newReleaser.codehash != RELEASER_CODEHASH) revert WrongReleaserCode();
        if (IFirepitView(newReleaser).FEE_JAR() != address(this)) revert WrongJar();
        releaser = newReleaser;
        emit ReleaserSet(newReleaser);
    }

    /// @notice Sends the jar's full balance of each asset to `to`.
    function release(address[] calldata assets, address to) external {
        if (msg.sender != releaser) revert NotReleaser();
        for (uint256 i; i < assets.length; ++i) {
            uint256 amount = IERC20(assets[i]).balanceOf(address(this));
            if (amount == 0) continue;
            emit Released(assets[i], to, amount);
            IERC20(assets[i]).safeTransfer(to, amount);
        }
    }
}
