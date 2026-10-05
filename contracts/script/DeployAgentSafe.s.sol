// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FeeJar} from "../src/fees/FeeJar.sol";
import {Firepit} from "../src/fees/Firepit.sol";
import {BudgetVaultFactory} from "../src/safe/BudgetVaultFactory.sol";

/// @notice Phase 1 deployment: Agent Safe can start earning fees before any token exists.
/// Usage (keys never touch the repo):
///   cast wallet import deployer --interactive
///   INITIALIZER=0x<safe> OPS=0x<safe> forge script script/DeployAgentSafe.s.sol \
///     --rpc-url base_sepolia --account deployer --broadcast --verify
contract DeployAgentSafe is Script {
    address constant BASE_SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    function run() external returns (FeeJar jar, BudgetVaultFactory factory) {
        address usdc = block.chainid == 8453 ? BASE_USDC : BASE_SEPOLIA_USDC;
        address initializer = vm.envAddress("INITIALIZER");
        address ops = vm.envAddress("OPS");

        // Firepit has no immutables, so its runtime code (and codehash) is the same for every deployment.
        bytes32 firepitCodehash = keccak256(type(Firepit).runtimeCode);

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        if (block.chainid == 8453) {
            // Mainnet: both roles must be multisig Safes, never the deployer's key (docs/MAINNET.md).
            require(initializer.code.length > 0 && ops.code.length > 0, "INITIALIZER and OPS must be Safes");
            require(initializer != deployer && ops != deployer, "roles must not be the deployer");
            require(IERC20(usdc).totalSupply() > 0, "USDC not found");
        }
        jar = new FeeJar(initializer, firepitCodehash);
        factory = new BudgetVaultFactory(IERC20(usdc), address(jar), ops);
        vm.stopBroadcast();

        console.log("USDC", usdc);
        console.log("FeeJar", address(jar));
        console.log("BudgetVaultFactory", address(factory));
        console.logBytes32(firepitCodehash);
    }
}
