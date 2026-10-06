// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {DeployGenesis} from "../../script/DeployGenesis.s.sol";
import {DeployAgentSafe} from "../../script/DeployAgentSafe.s.sol";
import {Firepit} from "../../src/fees/Firepit.sol";
import {FeeJar} from "../../src/fees/FeeJar.sol";
import {BudgetVaultFactory} from "../../src/safe/BudgetVaultFactory.sol";
import {IBurnableToken} from "../../src/interfaces/IBurnableToken.sol";

contract DeployScriptsTest is Test {
    function test_GenesisScriptAllocatesEverythingAndLeavesDeployerEmpty() public {
        vm.setEnv("INITIALIZER", vm.toString(makeAddr("initializer")));
        vm.setEnv("OPS", vm.toString(makeAddr("ops")));
        (FeeJar jar,) = new DeployAgentSafe().run();

        vm.setEnv("FOUNDER_SAFE", vm.toString(makeAddr("founder")));
        vm.setEnv("CONTRIBUTORS_SAFE", vm.toString(makeAddr("contributors")));
        vm.setEnv("FOUNDATION_SAFE", vm.toString(makeAddr("foundation")));
        vm.setEnv("DISTRIBUTOR_SAFE", vm.toString(makeAddr("distributor")));
        vm.setEnv("LAUNCH_RESERVE_SAFE", vm.toString(makeAddr("reserve")));
        vm.setEnv("FEE_JAR", vm.toString(address(jar)));
        vm.setEnv("AIRDROP_ROOT", vm.toString(keccak256("root")));
        // The script's own require() calls assert the allocation and the empty deployer.
        new DeployGenesis().run();
    }
}
