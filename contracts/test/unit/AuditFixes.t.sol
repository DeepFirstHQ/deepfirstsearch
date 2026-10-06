// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {BudgetVault} from "../../src/safe/BudgetVault.sol";
import {BudgetVaultFactory} from "../../src/safe/BudgetVaultFactory.sol";
import {MerkleAirdrop} from "../../src/distribution/MerkleAirdrop.sol";
import {IBurnableToken} from "../../src/interfaces/IBurnableToken.sol";
import {MockFiatUSDC} from "../mocks/MockFiatUSDC.sol";

contract StrayToken is ERC20 {
    constructor() ERC20("Stray", "STRAY") {
        _mint(msg.sender, 1e24);
    }
}

/// @notice Regression tests for the internal pre-audit findings (private/docs/internal-audit-*.md).
contract AuditFixesTest is Test {
    MockFiatUSDC usdc;
    BudgetVaultFactory factory;
    BudgetVault vault;
    address owner;
    uint256 ownerKey;
    address agent = makeAddr("agent");
    address merchant = makeAddr("merchant");
    address burner = makeAddr("burner");
    address jar = makeAddr("feeJar");
    address ops = makeAddr("ops");

    function setUp() public {
        (owner, ownerKey) = makeAddrAndKey("owner");
        usdc = new MockFiatUSDC();
        factory = new BudgetVaultFactory(usdc, jar, ops);
        vault = factory.create(owner, bytes32("v"), 1 hours);
        usdc.mint(address(vault), 1_000e6);
    }

    function _intent(uint256 nonce) internal view returns (BudgetVault.Intent memory) {
        return BudgetVault.Intent({
            agent: agent,
            counterparty: merchant,
            burner: burner,
            token: address(usdc),
            maxPerTx: 50e6,
            maxPerPeriod: 200e6,
            trancheCap: 50e6,
            period: 1 days,
            validAfter: 0,
            expiry: uint64(block.timestamp + 30 days),
            nonce: nonce
        });
    }

    function _propose(uint256 nonce) internal returns (bytes32 id) {
        BudgetVault.Intent memory i = _intent(nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, vault.intentId(i));
        id = vault.proposeIntent(i, abi.encodePacked(r, s, v));
    }

    /// S-M-1: a blacklisted fee recipient no longer blocks payments; the fee is owed and flushed later.
    function test_BlacklistedFeeRecipientDoesNotBlockPayments() public {
        bytes32 id = _propose(1);
        skip(1 hours);
        usdc.blacklist(ops);
        vm.prank(agent);
        vault.pay(id, merchant, 10e6);
        assertEq(usdc.balanceOf(merchant), 10e6);
        assertEq(usdc.balanceOf(jar), 5_000);
        assertEq(vault.owedOps(), 5_000);

        // The owner cannot withdraw the owed fee...
        uint256 free = usdc.balanceOf(address(vault)) - 5_000;
        vm.prank(owner);
        vm.expectRevert(BudgetVault.OwedFees.selector);
        vault.withdraw(owner, free + 1);
        // ...and anyone can flush it once the recipient can receive again.
        usdc.unBlacklist(ops);
        vault.flushFees();
        assertEq(usdc.balanceOf(ops), 5_000);
        assertEq(vault.owedOps(), 0);
        uint256 all = usdc.balanceOf(address(vault));
        vm.prank(owner);
        vault.withdraw(owner, all);
    }

    /// S-L-1: a stolen agent key cannot fund a payer address the owner did not sign.
    function test_AgentCannotFundAnUnsignedPayer() public {
        bytes32 id = _propose(1);
        skip(1 hours);
        vm.startPrank(agent);
        vm.expectRevert(BudgetVault.NotSignedBurner.selector);
        vault.fundBurner(id, makeAddr("attacker"), 10e6);
        vault.fundBurner(id, burner, 10e6);
        vm.stopPrank();
        assertEq(usdc.balanceOf(burner), 10e6);
    }

    /// S-M-2: renewing an intent for the same merchant and payer keeps working.
    function test_RenewedIntentCanFundTheSamePayer() public {
        bytes32 first = _propose(1);
        skip(1 hours);
        vm.prank(agent);
        vault.fundBurner(first, burner, 10e6);
        vm.prank(owner);
        vault.revokeIntent(first);
        bytes32 renewed = _propose(2);
        skip(1 hours);
        vm.prank(agent);
        vault.fundBurner(renewed, burner, 10e6);
        assertEq(usdc.balanceOf(burner), 20e6);
    }

    /// S-L-2: the owner can burn a nonce so a leaked signed intent can never be relayed.
    function test_OwnerCanInvalidateASignedIntent() public {
        BudgetVault.Intent memory i = _intent(7);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, vault.intentId(i));
        vm.prank(owner);
        vault.invalidateNonce(7);
        vm.expectRevert(BudgetVault.NonceUsed.selector);
        vault.proposeIntent(i, abi.encodePacked(r, s, v));
        vm.expectRevert(BudgetVault.NotOwner.selector);
        vault.invalidateNonce(8);
    }

    /// S-L-3: stray tokens can be rescued, USDC cannot be pulled through rescue.
    function test_OwnerCanRescueStrayTokensButNotUsdc() public {
        StrayToken stray = new StrayToken();
        stray.transfer(address(vault), 5e18);
        vm.startPrank(owner);
        vault.rescue(stray, owner, 5e18);
        vm.expectRevert(BudgetVault.CannotRescueUsdc.selector);
        vault.rescue(usdc, owner, 1);
        vm.stopPrank();
        assertEq(stray.balanceOf(owner), 5e18);
    }

    /// S-I: deploying someone's vault first no longer makes their own create revert.
    function test_CreateIsIdempotent() public {
        address victim = makeAddr("victim");
        vm.prank(makeAddr("griefer"));
        BudgetVault a = factory.create(victim, bytes32("x"), 1 hours);
        vm.prank(victim);
        BudgetVault b = factory.create(victim, bytes32("x"), 1 hours);
        assertEq(address(a), address(b));
        assertEq(a.OWNER(), victim);
    }

    /// T-L-2: an airdrop with a zero root or a past deadline cannot be deployed.
    function test_AirdropRejectsZeroRootAndPastDeadline() public {
        vm.expectRevert(MerkleAirdrop.BadConfig.selector);
        new MerkleAirdrop(IBurnableToken(address(1)), bytes32(0), uint64(block.timestamp + 1 days));
        vm.expectRevert(MerkleAirdrop.BadConfig.selector);
        new MerkleAirdrop(IBurnableToken(address(1)), keccak256("root"), uint64(block.timestamp));
    }
}
