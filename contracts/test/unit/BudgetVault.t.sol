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
    address burnerAddr = makeAddr("burner");
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
            burner: burnerAddr,
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
        assertTrue(vault.isBurner(burner));
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

contract Mock1271Wallet {
    address public immutable SIGNER;

    constructor(address signer) {
        SIGNER = signer;
    }

    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        (uint8 v, bytes32 r, bytes32 s) = (uint8(sig[64]), bytes32(sig[0:32]), bytes32(sig[32:64]));
        return ecrecover(hash, v, r, s) == SIGNER ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

contract OwnerSignatureKindsTest is VaultFixture {
    /// An EIP-7702-delegated owner has code; its own key must still authorize intents even if the delegate
    /// does not implement ERC-1271 (found by the Base mainnet fork test).
    function test_DelegatedEoaOwnerCanStillSignWithItsKey() public {
        vm.etch(owner, abi.encodePacked(hex"ef0100", address(0xdead)));
        assertGt(owner.code.length, 0);
        BudgetVault.Intent memory i = _intent(1);
        bytes32 id = vault.proposeIntent(i, _sign(i, ownerKey));
        assertEq(id, vault.intentId(i));
    }

    function test_DelegatedEoaOwnerStillRejectsOtherKeys() public {
        vm.etch(owner, abi.encodePacked(hex"ef0100", address(0xdead)));
        (, uint256 attackerKey) = makeAddrAndKey("attacker");
        BudgetVault.Intent memory i = _intent(1);
        bytes memory forged = _sign(i, attackerKey);
        vm.expectRevert(BudgetVault.BadSignature.selector);
        vault.proposeIntent(i, forged);
    }

    function test_ContractOwnerSignsWithErc1271() public {
        (address signer, uint256 signerKey) = makeAddrAndKey("safeSigner");
        Mock1271Wallet wallet = new Mock1271Wallet(signer);
        BudgetVault v = factory.create(address(wallet), bytes32("1271"), DELAY);
        BudgetVault.Intent memory i = _intent(1);
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(signerKey, v.intentId(i));
        v.proposeIntent(i, abi.encodePacked(r, s, sv));

        (, uint256 attackerKey) = makeAddrAndKey("attacker");
        i.nonce = 2;
        (sv, r, s) = vm.sign(attackerKey, v.intentId(i));
        vm.expectRevert(BudgetVault.BadSignature.selector);
        v.proposeIntent(i, abi.encodePacked(r, s, sv));
    }
}

/// Edge cases and input validation, one per branch (pre-audit coverage).
contract BudgetVaultEdgeCasesTest is VaultFixture {
    function test_ConstructorRejectsBadConfig() public {
        vm.expectRevert(BudgetVault.BadIntent.selector);
        new BudgetVault(address(0), usdc, jar, ops, 5_000, DELAY);
        vm.expectRevert(BudgetVault.BadIntent.selector);
        new BudgetVault(owner, usdc, address(0), ops, 5_000, DELAY);
        vm.expectRevert(BudgetVault.BadIntent.selector);
        new BudgetVault(owner, usdc, jar, ops, 10_001, DELAY);
        vm.expectRevert(BudgetVault.BadIntent.selector);
        new BudgetVault(owner, usdc, jar, address(0), 5_000, DELAY);
        vm.expectRevert(BudgetVault.BadDelay.selector);
        new BudgetVault(owner, usdc, jar, ops, 5_000, 1 minutes);
        vm.expectRevert(BudgetVault.BadDelay.selector);
        new BudgetVault(owner, usdc, jar, ops, 5_000, 8 days);
        // All fees to the jar needs no operations wallet.
        new BudgetVault(owner, usdc, jar, address(0), 10_000, DELAY);
    }

    function test_ProposeRejectsMalformedIntents() public {
        BudgetVault.Intent[] memory bad = new BudgetVault.Intent[](7);
        for (uint256 k; k < bad.length; ++k) {
            bad[k] = _intent(100 + k);
        }
        bad[0].agent = address(0);
        bad[1].counterparty = address(0);
        bad[2].token = address(0xBEEF);
        bad[3].period = 0;
        bad[4].maxPerTx = 0;
        bad[5].maxPerTx = bad[5].maxPerPeriod + 1;
        bad[6].expiry = uint64(block.timestamp);
        for (uint256 k; k < bad.length; ++k) {
            bytes memory sig = _sign(bad[k], ownerKey);
            vm.expectRevert(BudgetVault.BadIntent.selector);
            vault.proposeIntent(bad[k], sig);
        }
    }

    function test_ValidAfterLaterThanDelayWins() public {
        BudgetVault.Intent memory i = _intent(1);
        i.validAfter = uint64(block.timestamp + 2 days);
        bytes32 id = vault.proposeIntent(i, _sign(i, ownerKey));
        assertEq(vault.getIntent(id).activeAt, i.validAfter);
        assertTrue(vault.nonceUsed(1));
        assertFalse(vault.nonceUsed(2));
    }

    function test_FeeIsOneTenthOfAPercent() public view {
        assertEq(vault.feeFor(1_000e6), 1e6);
        assertEq(vault.feeFor(999), 0);
    }

    function test_UnknownIntentReverts() public {
        bytes32 nope = keccak256("nope");
        vm.startPrank(owner);
        vm.expectRevert(BudgetVault.UnknownIntent.selector);
        vault.reduceIntent(nope, 1, 1, 1, 1);
        vm.expectRevert(BudgetVault.UnknownIntent.selector);
        vault.revokeIntent(nope);
        vm.stopPrank();
        vm.prank(agent);
        vm.expectRevert(BudgetVault.UnknownIntent.selector);
        vault.pay(nope, merchant, 1e6);
        vm.expectRevert(BudgetVault.UnknownBurner.selector);
        vault.sweepBurner(makeAddr("stranger"), 1, 0, 1, bytes32(0), "");
    }

    function test_DelayBoundsAndNoPendingChange() public {
        vm.startPrank(owner);
        vm.expectRevert(BudgetVault.BadDelay.selector);
        vault.setActivationDelay(1 minutes);
        vm.expectRevert(BudgetVault.BadDelay.selector);
        vault.setActivationDelay(8 days);
        vm.stopPrank();
        vm.expectRevert(BudgetVault.NoPendingDelay.selector);
        vault.applyActivationDelay();
    }

    function test_BurnerRules() public {
        bytes32 id1 = _activeIntent();
        BudgetVault.Intent memory i2 = _intent(2);
        bytes32 id2 = vault.proposeIntent(i2, _sign(i2, ownerKey));
        skip(DELAY);
        address burner = makeAddr("burner");
        vm.startPrank(agent);
        vm.expectRevert(BudgetVault.NotSignedBurner.selector);
        vault.fundBurner(id1, address(0), 1e6);
        vm.expectRevert(BudgetVault.NotSignedBurner.selector);
        vault.fundBurner(id1, makeAddr("attackerBurner"), 1e6);
        vault.fundBurner(id1, burner, 1e6);
        // A second (renewed) intent signed for the same payer can keep funding it (S-M-2).
        vault.fundBurner(id2, burner, 1e6);
        vm.stopPrank();
    }

    function test_PeriodWindowResets() public {
        bytes32 id = _activeIntent();
        vm.startPrank(agent);
        for (uint256 k; k < 4; ++k) {
            vault.pay(id, merchant, 5e6);
        }
        vm.expectRevert(BudgetVault.OverPeriod.selector);
        vault.pay(id, merchant, 1e6);
        skip(1 days);
        vault.pay(id, merchant, 5e6);
        vm.stopPrank();
        assertEq(usdc.balanceOf(merchant), 25e6);
    }
}
