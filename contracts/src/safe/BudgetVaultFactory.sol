// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BudgetVault} from "./BudgetVault.sol";

/// @title Agent Safe factory
/// @notice Deploys one BudgetVault per (owner, salt) with CREATE2. No admin: the fee routing below is fixed forever.
///         50% of the 0.1% fee goes to the FeeJar (burned through the Firepit) and 50% to the operations wallet.
contract BudgetVaultFactory {
    uint16 public constant JAR_SHARE_BPS = 5_000;

    IERC20 public immutable USDC;
    address public immutable FEE_JAR;
    address public immutable OPS;

    event VaultCreated(address indexed owner, address vault, bytes32 salt);

    error ZeroAddress();

    constructor(IERC20 usdc, address feeJar, address ops) {
        if (address(usdc) == address(0) || feeJar == address(0) || ops == address(0)) revert ZeroAddress();
        USDC = usdc;
        FEE_JAR = feeJar;
        OPS = ops;
    }

    function create(address owner, bytes32 salt, uint32 activationDelay) external returns (BudgetVault vault) {
        vault = new BudgetVault{salt: _salt(owner, salt)}(owner, USDC, FEE_JAR, OPS, JAR_SHARE_BPS, activationDelay);
        emit VaultCreated(owner, address(vault), salt);
    }

    function predict(address owner, bytes32 salt, uint32 activationDelay) external view returns (address) {
        bytes memory init = bytes.concat(
            type(BudgetVault).creationCode, abi.encode(owner, USDC, FEE_JAR, OPS, JAR_SHARE_BPS, activationDelay)
        );
        bytes32 hash = keccak256(abi.encodePacked(bytes1(0xff), address(this), _salt(owner, salt), keccak256(init)));
        return address(uint160(uint256(hash)));
    }

    // Binding the owner into the salt stops anyone from squatting another owner's vault address.
    function _salt(address owner, bytes32 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(owner, salt));
    }
}
