// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {BudgetVault} from "../../src/safe/BudgetVault.sol";
import {BudgetVaultFactory} from "../../src/safe/BudgetVaultFactory.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

contract VaultFixture is Test {
    MockUSDC usdc;
    BudgetVaultFactory factory;
    BudgetVault vault;
    address owner;
    uint256 ownerKey;
    address agent = makeAddr("agentSessionKey");
    address merchant = makeAddr("merchant");
    address jar = makeAddr("feeJar");
    address ops = makeAddr("ops");
    uint32 constant DELAY = 1 hours;

    function setUp() public virtual {
        (owner, ownerKey) = makeAddrAndKey("owner");
        usdc = new MockUSDC();
        factory = new BudgetVaultFactory(usdc, jar, ops);
        address predicted = factory.predict(owner, bytes32("v1"), DELAY);
        vault = factory.create(owner, bytes32("v1"), DELAY);
        assertEq(address(vault), predicted);
        usdc.mint(address(vault), 10_000e6);
    }

    function _intent(uint256 nonce) internal view returns (BudgetVault.Intent memory i) {
        i = BudgetVault.Intent({
            agent: agent,
            counterparty: merchant,
            token: address(usdc),
            maxPerTx: 5e6,
            maxPerPeriod: 20e6,
            trancheCap: 10e6,
            period: 1 days,
            validAfter: 0,
            expiry: uint64(block.timestamp + 30 days),
            nonce: nonce
        });
    }

    function _sign(BudgetVault.Intent memory i, uint256 key) internal view returns (bytes memory) {
        bytes32 id = vault.intentId(i);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, id);
        return abi.encodePacked(r, s, v);
    }

    function _activeIntent() internal returns (bytes32 id) {
        BudgetVault.Intent memory i = _intent(1);
        id = vault.proposeIntent(i, _sign(i, ownerKey));
        skip(DELAY);
    }
}

contract BudgetVaultTest is VaultFixture {
    function test_IntentNeedsOwnerSignature() public {
        BudgetVault.Intent memory i = _intent(1);
        (, uint256 attackerKey) = makeAddrAndKey("attacker");
        bytes memory forged = _sign(i, attackerKey);
        vm.expectRevert(BudgetVault.BadSignature.selector);
        vault.proposeIntent(i, forged);
    }

    function test_IntentIsTimelocked() public {
        BudgetVault.Intent memory i = _intent(1);
        bytes32 id = vault.proposeIntent(i, _sign(i, ownerKey));
        vm.prank(agent);
        vm.expectRevert(BudgetVault.IntentInactive.selector);
        vault.pay(id, merchant, 1e6);
        skip(DELAY);
        vm.prank(agent);
        vault.pay(id, merchant, 1e6);
        assertEq(usdc.balanceOf(merchant), 1e6);
    }

    function test_OwnerSignatureCannotBeReplayed() public {
        BudgetVault.Intent memory i = _intent(7);
        bytes memory sig = _sign(i, ownerKey);
        vault.proposeIntent(i, sig);
        vm.expectRevert(BudgetVault.NonceUsed.selector);
        vault.proposeIntent(i, sig);
    }

    function test_AgentCanOnlyPayTheCounterparty() public {
        bytes32 id = _activeIntent();
        vm.prank(agent);
        vm.expectRevert(BudgetVault.WrongCounterparty.selector);
        vault.pay(id, makeAddr("attacker"), 1e6);
    }

    function test_OnlyTheAgentKeyCanSpend() public {
        bytes32 id = _activeIntent();
        vm.prank(owner);
        vm.expectRevert(BudgetVault.NotAgent.selector);
        vault.pay(id, merchant, 1e6);
    }

    function test_PerTxAndPerPeriodLimits() public {
        bytes32 id = _activeIntent();
        vm.startPrank(agent);
        vm.expectRevert(BudgetVault.OverPerTx.selector);
        vault.pay(id, merchant, 5e6 + 1);
        for (uint256 k; k < 4; ++k) {
            vault.pay(id, merchant, 5e6);
        }
        vm.expectRevert(BudgetVault.OverPeriod.selector);
        vault.pay(id, merchant, 1);
        skip(1 days);
        vault.pay(id, merchant, 5e6);
        vm.stopPrank();
    }

    function test_FeeIsSplitBetweenJarAndOps() public {
        bytes32 id = _activeIntent();
        vm.prank(agent);
        vault.pay(id, merchant, 5e6);
        assertEq(usdc.balanceOf(jar), 2_500);
        assertEq(usdc.balanceOf(ops), 2_500);
        assertEq(usdc.balanceOf(address(vault)), 10_000e6 - 5e6 - 5_000);
    }

    function test_OwnerRestrictionsAreInstant() public {
        bytes32 id = _activeIntent();
        vm.prank(owner);
        vault.reduceIntent(id, 1e6, 2e6, 1e6, uint64(block.timestamp + 1 days));
        vm.prank(agent);
        vm.expectRevert(BudgetVault.OverPerTx.selector);
        vault.pay(id, merchant, 2e6);

        vm.prank(owner);
        vm.expectRevert(BudgetVault.NotAReduction.selector);
        vault.reduceIntent(id, 5e6, 20e6, 10e6, uint64(block.timestamp + 1 days));

        vm.prank(owner);
        vault.setPaused(true);
        vm.prank(agent);
        vm.expectRevert(BudgetVault.IsPaused.selector);
        vault.pay(id, merchant, 1e6);

        vm.prank(owner);
        vault.setPaused(false);
        vm.prank(owner);
        vault.revokeIntent(id);
        vm.prank(agent);
        vm.expectRevert(BudgetVault.IntentInactive.selector);
        vault.pay(id, merchant, 1e6);
    }

    function test_OwnerCanWithdrawEvenWhilePaused() public {
        vm.startPrank(owner);
        vault.setPaused(true);
        vault.withdraw(owner, 10_000e6);
        vm.stopPrank();
        assertEq(usdc.balanceOf(owner), 10_000e6);
    }

    function test_AgentCannotChangeAnything() public {
        bytes32 id = _activeIntent();
        vm.startPrank(agent);
        vm.expectRevert(BudgetVault.NotOwner.selector);
        vault.reduceIntent(id, 1, 1, 1, 1);
        vm.expectRevert(BudgetVault.NotOwner.selector);
        vault.setPaused(false);
        vm.expectRevert(BudgetVault.NotOwner.selector);
        vault.setActivationDelay(1 hours);
        vm.expectRevert(BudgetVault.NotOwner.selector);
        vault.withdraw(agent, 1);
        vm.stopPrank();
    }

    function test_ShorterDelayWaitsOutCurrentDelay() public {
        vm.startPrank(owner);
        vault.setActivationDelay(2 days);
        vault.setActivationDelay(1 hours);
        vm.stopPrank();
        assertEq(vault.activationDelay(), 2 days);
        vm.expectRevert(BudgetVault.TooEarly.selector);
        vault.applyActivationDelay();
        skip(2 days);
        vault.applyActivationDelay();
        assertEq(vault.activationDelay(), 1 hours);
    }

    function test_BurnerTranchesAreCappedAndBound() public {
        bytes32 id = _activeIntent();
        address burner = makeAddr("burner");
        vm.startPrank(agent);
        vault.fundBurner(id, burner, 5e6);
        vault.fundBurner(id, burner, 5e6);
        vm.expectRevert(BudgetVault.OverTranche.selector);
        vault.fundBurner(id, burner, 1);
        vm.stopPrank();
        assertEq(vault.burnerIntent(burner), id);
    }

    function test_SweepBurnerWithReceiveAuthorization() public {
        bytes32 id = _activeIntent();
        (address burner, uint256 burnerKey) = makeAddrAndKey("burner");
        vm.prank(agent);
        vault.fundBurner(id, burner, 5e6);

        bytes32 nonce = keccak256("sweep-1");
        uint256 validBefore = block.timestamp + 10 minutes;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                usdc.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), burner, address(vault), 5e6, 0, validBefore, nonce
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(burnerKey, digest);
        uint256 before = usdc.balanceOf(address(vault));
        vault.sweepBurner(burner, 5e6, 0, validBefore, nonce, abi.encodePacked(r, s, v));
        assertEq(usdc.balanceOf(address(vault)), before + 5e6);
    }

    function testFuzz_SpendNeverExceedsPeriodBudget(uint256[8] memory amounts) public {
        bytes32 id = _activeIntent();
        uint256 total;
        vm.startPrank(agent);
        for (uint256 k; k < amounts.length; ++k) {
            uint256 amt = bound(amounts[k], 1, 5e6);
            try vault.pay(id, merchant, amt) {
                total += amt;
            } catch {}
        }
        vm.stopPrank();
        assertLe(total, 20e6);
        assertEq(usdc.balanceOf(merchant), total);
    }
}
