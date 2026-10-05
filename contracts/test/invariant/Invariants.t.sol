// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {DepthToken} from "../../src/token/DepthToken.sol";
import {FeeJar} from "../../src/fees/FeeJar.sol";
import {Firepit} from "../../src/fees/Firepit.sol";
import {BudgetVault} from "../../src/safe/BudgetVault.sol";
import {BudgetVaultFactory} from "../../src/safe/BudgetVaultFactory.sol";
import {IBurnableToken} from "../../src/interfaces/IBurnableToken.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/// @dev Random sequence of agent spends, burner top-ups, firepit claims, burns and time jumps.
contract Handler is Test {
    DepthToken public depth;
    MockUSDC public usdc;
    Firepit public pit;
    FeeJar public jar;
    BudgetVault public vault;
    bytes32 public id;
    address public agent;
    address public merchant;

    uint256 public lastSupply;
    bool public supplyIncreased;
    // Outflow per window, tracked independently of the vault's own accounting.
    mapping(uint256 window => uint256) public outflow;
    uint256 public maxWindowOutflow;

    constructor(DepthToken d, MockUSDC u, Firepit p, FeeJar j, BudgetVault v, bytes32 i, address a, address m) {
        depth = d;
        usdc = u;
        pit = p;
        jar = j;
        vault = v;
        id = i;
        agent = a;
        merchant = m;
        lastSupply = d.totalSupply();
        depth.approve(address(pit), type(uint256).max);
    }

    function _track() internal {
        uint256 s = depth.totalSupply();
        if (s > lastSupply) supplyIncreased = true;
        lastSupply = s;
    }

    function _window() internal view returns (uint256) {
        BudgetVault.IntentState memory st = vault.getIntent(id);
        return (block.timestamp - st.activeAt) / st.intent.period;
    }

    function pay(uint256 amount) external {
        amount = bound(amount, 1, 6e6);
        vm.prank(agent);
        try vault.pay(id, merchant, amount) {
            outflow[_window()] += amount;
            if (outflow[_window()] > maxWindowOutflow) maxWindowOutflow = outflow[_window()];
        } catch {}
        _track();
    }

    function fundBurner(uint256 amount, uint8 which) external {
        amount = bound(amount, 1, 6e6);
        address burner = address(uint160(0xB000 + (which % 4)));
        vm.prank(agent);
        try vault.fundBurner(id, burner, amount) {
            outflow[_window()] += amount;
            if (outflow[_window()] > maxWindowOutflow) maxWindowOutflow = outflow[_window()];
        } catch {}
        _track();
    }

    function claimJar() external {
        address[] memory assets = new address[](1);
        assets[0] = address(usdc);
        uint256 t = pit.threshold();
        if (depth.balanceOf(address(this)) < t) return;
        pit.release(assets, address(this), t);
        _track();
    }

    function burn(uint256 amount) external {
        amount = bound(amount, 0, depth.balanceOf(address(this)));
        depth.burn(amount);
        _track();
    }

    function warp(uint256 secs) external {
        skip(bound(secs, 0, 3 days));
    }
}

contract InvariantsTest is StdInvariant, Test {
    Handler handler;
    BudgetVault vault;
    Firepit pit;
    MockUSDC usdc;
    FeeJar jar;
    DepthToken depth;
    address agent = makeAddr("agent");
    address merchant = makeAddr("merchant");

    function setUp() public {
        (address owner, uint256 ownerKey) = makeAddrAndKey("owner");
        usdc = new MockUSDC();

        Firepit probe = new Firepit(IBurnableToken(address(1)), address(1), 100_000e18);
        jar = new FeeJar(address(this), address(probe).codehash);

        address[] memory r = new address[](1);
        uint256[] memory a = new uint256[](1);
        r[0] = address(this);
        a[0] = 1_000_000_000e18;
        depth = new DepthToken(r, a);
        pit = new Firepit(IBurnableToken(address(depth)), address(jar), 100_000e18);
        jar.setReleaser(address(pit));

        BudgetVaultFactory factory = new BudgetVaultFactory(usdc, address(jar), makeAddr("ops"));
        vault = factory.create(owner, bytes32(0), 1 hours);
        usdc.mint(address(vault), 1_000_000e6);

        BudgetVault.Intent memory i = BudgetVault.Intent({
            agent: agent,
            counterparty: merchant,
            token: address(usdc),
            maxPerTx: 5e6,
            maxPerPeriod: 20e6,
            trancheCap: 10e6,
            period: 1 days,
            validAfter: 0,
            expiry: uint64(block.timestamp + 3650 days),
            nonce: 1
        });
        bytes32 id = _propose(i, ownerKey);
        skip(1 hours);

        handler = new Handler(depth, usdc, pit, jar, vault, id, agent, merchant);
        depth.transfer(address(handler), depth.balanceOf(address(this)));
        targetContract(address(handler));
    }

    function _propose(BudgetVault.Intent memory i, uint256 key) internal returns (bytes32 id) {
        id = vault.intentId(i);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, id);
        vault.proposeIntent(i, abi.encodePacked(r, s, v));
    }

    function invariant_SupplyNeverIncreases() public view {
        assertFalse(handler.supplyIncreased());
        assertLe(handler.depth().totalSupply(), 1_000_000_000e18);
    }

    function invariant_AgentNeverExceedsPeriodBudget() public view {
        assertLe(handler.maxWindowOutflow(), 20e6);
    }

    function invariant_ThresholdWithinBounds() public view {
        assertGe(pit.threshold(), pit.FLOOR());
        assertLe(pit.threshold(), pit.CEIL());
    }

    function invariant_IntentLimitsNeverWidened() public view {
        BudgetVault.IntentState memory st = vault.getIntent(handler.id());
        assertEq(st.intent.maxPerTx, 5e6);
        assertEq(st.intent.maxPerPeriod, 20e6);
        assertEq(st.intent.counterparty, handler.merchant());
    }
}
