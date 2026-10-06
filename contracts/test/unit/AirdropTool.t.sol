// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {DepthToken} from "../../src/token/DepthToken.sol";
import {MerkleAirdrop} from "../../src/distribution/MerkleAirdrop.sol";
import {IBurnableToken} from "../../src/interfaces/IBurnableToken.sol";

/// @notice Proves that proofs produced by tools/airdrop (OpenZeppelin StandardMerkleTree) claim on MerkleAirdrop.
contract AirdropToolTest is Test {
    string constant FIXTURE = "test/fixtures/airdrop-sample/";

    function test_ToolProofsClaimOnChain() public {
        string memory tree = vm.readFile(string.concat(FIXTURE, "tree.json"));
        bytes32 root = abi.decode(vm.parseJson(tree, ".tree[0]"), (bytes32));

        // The airdrop is deployed first, against the predicted token address, like DeployGenesis does.
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        MerkleAirdrop airdrop = new MerkleAirdrop(IBurnableToken(predicted), root, uint64(block.timestamp + 30 days));
        address[] memory to = new address[](2);
        uint256[] memory amt = new uint256[](2);
        (to[0], amt[0]) = (address(airdrop), 250_000_000e18);
        (to[1], amt[1]) = (makeAddr("rest"), 750_000_000e18);
        DepthToken token = new DepthToken(to, amt);
        assertEq(address(token), predicted);

        string memory proofs = vm.readFile(string.concat(FIXTURE, "proofs.json"));
        address account = 0x2222222222222222222222222222222222222222;
        string memory key = ".0x2222222222222222222222222222222222222222";
        uint256 index = vm.parseJsonUint(proofs, string.concat(key, ".index"));
        uint256 amount = vm.parseJsonUint(proofs, string.concat(key, ".amount"));
        bytes32[] memory proof = vm.parseJsonBytes32Array(proofs, string.concat(key, ".proof"));
        assertEq(amount, 250.5e18);

        airdrop.claim(index, account, amount, proof);
        assertEq(token.balanceOf(account), amount);
        vm.expectRevert(MerkleAirdrop.AlreadyClaimed.selector);
        airdrop.claim(index, account, amount, proof);
    }
}
