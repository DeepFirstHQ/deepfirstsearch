// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IFirepitView {
    function FEE_JAR() external view returns (address);
    function DEPTH() external view returns (address);
}

/// @title Fee jar
/// @notice Collects protocol fees (USDC). Has no owner and no withdraw function: the only way out is `release`,
///         callable solely by the releaser (the Firepit, which first burns $DEPTH).
/// @dev The jar exists before the token, so Agent Safe can earn fees before any token is launched. The releaser is
///      connected exactly once, through a public timelock: `INITIALIZER` proposes a Firepit, anyone can inspect it
///      (its `DEPTH()` must be the official token) during `RELEASER_DELAY`, and anyone can then finalize it. There is
///      no bytecode pin, so an audited fix to the Firepit can never lock the jar. Remaining trust: the initializer
///      picks the instance, and the timelock exists so that a wrong pick is visible before it takes effect.
///      Only Agent Safe, SDK and inference fees may be routed here, never fees from any privacy pool.
contract FeeJar {
    using SafeERC20 for IERC20;

    uint64 public constant RELEASER_DELAY = 14 days;

    address public immutable INITIALIZER;
    address public releaser;
    address public pendingReleaser;
    uint64 public pendingEta;

    event ReleaserProposed(address indexed releaser, address indexed depth, uint64 eta);
    event ReleaserSet(address indexed releaser);
    event Released(address indexed asset, address indexed to, uint256 amount);

    error NotInitializer();
    error AlreadySet();
    error NoPendingReleaser();
    error TooEarly();
    error WrongJar();
    error NotReleaser();
    error ZeroAddress();

    constructor(address initializer) {
        if (initializer == address(0)) revert ZeroAddress();
        INITIALIZER = initializer;
    }

    /// @notice Proposes the releaser. A new proposal replaces the previous one and restarts the timelock.
    function proposeReleaser(address newReleaser) external {
        if (msg.sender != INITIALIZER) revert NotInitializer();
        if (releaser != address(0)) revert AlreadySet();
        if (newReleaser == address(0)) revert ZeroAddress();
        if (IFirepitView(newReleaser).FEE_JAR() != address(this)) revert WrongJar();
        uint64 eta = uint64(block.timestamp) + RELEASER_DELAY;
        pendingReleaser = newReleaser;
        pendingEta = eta;
        emit ReleaserProposed(newReleaser, IFirepitView(newReleaser).DEPTH(), eta);
    }

    /// @notice Finalizes the proposed releaser once the timelock has passed. Callable by anyone; permanent.
    function acceptReleaser() external {
        if (releaser != address(0)) revert AlreadySet();
        address r = pendingReleaser;
        if (r == address(0)) revert NoPendingReleaser();
        if (block.timestamp < pendingEta) revert TooEarly();
        releaser = r;
        pendingReleaser = address(0);
        pendingEta = 0;
        emit ReleaserSet(r);
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
