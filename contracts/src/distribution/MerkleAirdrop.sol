// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {BitMaps} from "@openzeppelin/contracts/utils/structs/BitMaps.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IBurnableToken} from "../interfaces/IBurnableToken.sol";

/// @title Wallet-only airdrop
/// @notice Claims need only a Merkle proof: no email, no KYC, no signature from us. Anyone may submit a claim, and
///         the tokens always go to the account in the leaf. After the deadline, anyone can burn what was not claimed.
/// @dev Leaves are `keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))))`, the format produced by
///      OpenZeppelin's StandardMerkleTree for the types (uint256, address, uint256).
contract MerkleAirdrop {
    using BitMaps for BitMaps.BitMap;
    using SafeERC20 for IBurnableToken;

    IBurnableToken public immutable TOKEN;
    bytes32 public immutable MERKLE_ROOT;
    uint64 public immutable DEADLINE;

    BitMaps.BitMap private _claimed;

    event Claimed(uint256 indexed index, address indexed account, uint256 amount);
    event UnclaimedBurned(uint256 amount);

    error ClaimWindowClosed();
    error ClaimWindowOpen();
    error AlreadyClaimed();
    error InvalidProof();
    error ZeroAddress();

    constructor(IBurnableToken token, bytes32 merkleRoot, uint64 deadline) {
        if (address(token) == address(0)) revert ZeroAddress();
        TOKEN = token;
        MERKLE_ROOT = merkleRoot;
        DEADLINE = deadline;
    }

    function isClaimed(uint256 index) external view returns (bool) {
        return _claimed.get(index);
    }

    function claim(uint256 index, address account, uint256 amount, bytes32[] calldata proof) external {
        if (block.timestamp > DEADLINE) revert ClaimWindowClosed();
        if (_claimed.get(index)) revert AlreadyClaimed();
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))));
        if (!MerkleProof.verifyCalldata(proof, MERKLE_ROOT, leaf)) revert InvalidProof();

        _claimed.set(index);
        emit Claimed(index, account, amount);
        TOKEN.safeTransfer(account, amount);
    }

    /// @notice After the deadline, burns every unclaimed token. Callable by anyone.
    function burnUnclaimed() external {
        if (block.timestamp <= DEADLINE) revert ClaimWindowOpen();
        uint256 amount = TOKEN.balanceOf(address(this));
        emit UnclaimedBurned(amount);
        TOKEN.burn(amount);
    }
}
