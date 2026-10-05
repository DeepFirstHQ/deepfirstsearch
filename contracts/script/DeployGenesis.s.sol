// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {DepthToken} from "../src/token/DepthToken.sol";
import {DepthVesting} from "../src/token/DepthVesting.sol";
import {MerkleAirdrop} from "../src/distribution/MerkleAirdrop.sol";
import {RewardsPool} from "../src/distribution/RewardsPool.sol";
import {Firepit} from "../src/fees/Firepit.sol";
import {IBurnableToken} from "../src/interfaces/IBurnableToken.sol";

/// @notice Token generation event. Every allocation is minted straight into its contract; the deployer ends with 0.
/// @dev Allocation (must match docs/TOKENOMICS.md and web/src/config.ts):
///      airdrop 25% · rewards 25% · launch reserve 25% (15% auction + 10% liquidity, held by a Safe until the auction
///      and LP contracts exist) · founder 12% · contributors 3% · foundation 10%.
///      After broadcasting, the FeeJar initializer Safe calls `FeeJar.setReleaser(firepit)`.
contract DeployGenesis is Script {
    uint256 constant SUPPLY = 1_000_000_000e18;
    uint64 constant YEAR = 365 days;

    struct Config {
        address founderSafe;
        address contributorsSafe;
        address foundationSafe;
        address distributorSafe;
        address launchReserveSafe;
        address feeJar;
        bytes32 airdropRoot;
        uint64 tge;
        uint64 claimDeadline;
    }

    function _config() internal view returns (Config memory c) {
        c.founderSafe = vm.envAddress("FOUNDER_SAFE");
        c.contributorsSafe = vm.envAddress("CONTRIBUTORS_SAFE");
        c.foundationSafe = vm.envAddress("FOUNDATION_SAFE");
        c.distributorSafe = vm.envAddress("DISTRIBUTOR_SAFE");
        c.launchReserveSafe = vm.envAddress("LAUNCH_RESERVE_SAFE");
        c.feeJar = vm.envAddress("FEE_JAR");
        c.airdropRoot = vm.envBytes32("AIRDROP_ROOT");
        c.tge = uint64(vm.envOr("TGE", block.timestamp));
        c.claimDeadline = c.tge + 180 days;
    }

    function run() external {
        Config memory c = _config();
        vm.startBroadcast();
        // The broadcasting account (from --account), not the script contract.
        (, address deployer,) = vm.readCallers();
        uint256 n = vm.getNonce(deployer);
        // Contracts that need the token address are deployed first, against its predicted address.
        IBurnableToken token = IBurnableToken(vm.computeCreateAddress(deployer, n + 6));

        DepthVesting founder = new DepthVesting(c.founderSafe, c.tge + YEAR, 3 * YEAR);
        DepthVesting contributors = new DepthVesting(c.contributorsSafe, c.tge + YEAR, 3 * YEAR);
        DepthVesting foundation = new DepthVesting(c.foundationSafe, c.tge, 5 * YEAR);
        MerkleAirdrop airdrop = new MerkleAirdrop(token, c.airdropRoot, c.claimDeadline);
        RewardsPool rewards = new RewardsPool(token, c.distributorSafe, c.tge);
        Firepit firepit = new Firepit(token, c.feeJar, 100_000e18);

        address[] memory to = new address[](6);
        uint256[] memory amt = new uint256[](6);
        (to[0], amt[0]) = (address(airdrop), 250_000_000e18);
        (to[1], amt[1]) = (address(rewards), 250_000_000e18);
        (to[2], amt[2]) = (c.launchReserveSafe, 250_000_000e18);
        (to[3], amt[3]) = (address(founder), 120_000_000e18);
        (to[4], amt[4]) = (address(contributors), 30_000_000e18);
        (to[5], amt[5]) = (address(foundation), 100_000_000e18);
        DepthToken depth = new DepthToken(to, amt);
        vm.stopBroadcast();

        require(address(depth) == address(token), "token address prediction failed");
        require(depth.totalSupply() == SUPPLY, "supply");
        require(depth.balanceOf(deployer) == 0, "deployer must hold nothing");
        require(depth.balanceOf(address(founder)) == SUPPLY * 12 / 100, "founder");

        console.log("DEPTH", address(depth));
        console.log("FounderVesting", address(founder));
        console.log("ContributorsVesting", address(contributors));
        console.log("FoundationVesting", address(foundation));
        console.log("MerkleAirdrop", address(airdrop));
        console.log("RewardsPool", address(rewards));
        console.log("Firepit", address(firepit));
    }
}
