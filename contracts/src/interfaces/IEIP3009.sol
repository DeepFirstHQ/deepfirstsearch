// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice The subset of USDC (FiatToken v2.2) used by Agent Safe.
interface IEIP3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external;

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}
