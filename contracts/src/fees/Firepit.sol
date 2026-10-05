// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IBurnableToken} from "../interfaces/IBurnableToken.sol";

interface IFeeJar {
    function release(address[] calldata assets, address to) external;
}

/// @title Firepit: burn $DEPTH to claim the fee jar
/// @notice A buyback-and-burn with no swap, no oracle and no admin. Anyone can take everything in the FeeJar by
///         burning `threshold()` $DEPTH. The threshold works like a descending auction for the right to burn:
///         it doubles after every claim and halves every `HALF_LIFE` while nobody claims, always staying within
///         [FLOOR, CEIL]. Searchers compete, so the jar is claimed roughly when its value matches the burn.
/// @dev `DEPTH` and `FEE_JAR` are stored in storage instead of immutables so the runtime bytecode (and therefore the
///      codehash pinned by FeeJar) is identical for every deployment.
contract Firepit is ReentrancyGuard {
    uint256 public constant FLOOR = 10_000e18;
    uint256 public constant CEIL = 10_000_000e18;
    uint256 public constant HALF_LIFE = 3 days;

    // solhint-disable-next-line var-name-mixedcase
    IBurnableToken public DEPTH;
    // solhint-disable-next-line var-name-mixedcase
    address public FEE_JAR;

    uint128 public startThreshold;
    uint64 public lastRelease;

    event Released(address indexed burner, address indexed to, uint256 burned, uint256 nextStartThreshold);

    error ThresholdTooHigh(uint256 threshold, uint256 maxThreshold);
    error BadInitialThreshold();
    error ZeroAddress();

    constructor(IBurnableToken depth, address feeJar, uint128 initialThreshold) {
        if (address(depth) == address(0) || feeJar == address(0)) revert ZeroAddress();
        if (initialThreshold < FLOOR || initialThreshold > CEIL) revert BadInitialThreshold();
        DEPTH = depth;
        FEE_JAR = feeJar;
        startThreshold = initialThreshold;
        lastRelease = uint64(block.timestamp);
    }

    /// @notice Amount of $DEPTH that must be burned right now to claim the jar.
    function threshold() public view returns (uint256) {
        uint256 elapsed = block.timestamp - lastRelease;
        uint256 halvings = elapsed / HALF_LIFE;
        if (halvings >= 64) return FLOOR;
        uint256 s = uint256(startThreshold) >> halvings;
        // Linear interpolation toward the next halving keeps the price smooth between steps.
        s -= (s / 2) * (elapsed % HALF_LIFE) / HALF_LIFE;
        return s < FLOOR ? FLOOR : s;
    }

    /// @param assets Tokens to take from the jar (normally just USDC).
    /// @param to Receiver of the jar's contents.
    /// @param maxThreshold Most $DEPTH the caller accepts to burn; protects against front-running.
    function release(address[] calldata assets, address to, uint256 maxThreshold) external nonReentrant {
        _release(assets, to, maxThreshold);
    }

    /// @notice Same as `release`, with an EIP-2612 permit. A failed permit (for example one already used by a
    ///         front-runner) is ignored; the burn then relies on the existing allowance.
    function releaseWithPermit(
        address[] calldata assets,
        address to,
        uint256 maxThreshold,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        try IERC20Permit(address(DEPTH)).permit(msg.sender, address(this), maxThreshold, deadline, v, r, s) {} catch {}
        _release(assets, to, maxThreshold);
    }

    function _release(address[] calldata assets, address to, uint256 maxThreshold) private {
        uint256 t = threshold();
        if (t > maxThreshold) revert ThresholdTooHigh(t, maxThreshold);

        uint256 next = t * 2;
        if (next > CEIL) next = CEIL;
        // forge-lint: disable-next-line(unsafe-typecast)
        startThreshold = uint128(next); // next <= CEIL < 2^128
        lastRelease = uint64(block.timestamp);
        emit Released(msg.sender, to, t, next);

        // Effects are recorded first; the burn reverts the whole call if the caller cannot pay.
        DEPTH.burnFrom(msg.sender, t);
        IFeeJar(FEE_JAR).release(assets, to);
    }
}
