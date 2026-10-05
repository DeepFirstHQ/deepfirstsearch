// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BudgetVault} from "../../src/safe/BudgetVault.sol";
import {BudgetVaultFactory} from "../../src/safe/BudgetVaultFactory.sol";
import {FeeJar} from "../../src/fees/FeeJar.sol";
import {Firepit} from "../../src/fees/Firepit.sol";

interface IUSDC is IERC20 {
    function name() external view returns (string memory);
    function version() external view returns (string memory);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external;
}

/// @notice Pre-mainnet check against Base mainnet state: Circle's real USDC (FiatToken v2.2), its EIP-712 domain and
///         the `bytes signature` EIP-3009 overloads the vault and the x402 `exact` scheme rely on.
/// @dev Skipped unless BASE_FORK_RPC is set, e.g. `BASE_FORK_RPC=https://mainnet.base.org forge test --mt Fork`.
contract BaseMainnetForkTest is Test {
    IUSDC constant USDC = IUSDC(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    bytes32 constant TRANSFER_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    uint32 constant DELAY = 1 hours;

    BudgetVaultFactory factory;
    FeeJar jar;
    BudgetVault vault;
    address owner;
    uint256 ownerKey;
    address burner;
    uint256 burnerKey;
    address agent = makeAddr("agent");
    address merchant = makeAddr("merchant");
    address ops = makeAddr("opsSafe");
    address initializer = makeAddr("initializerSafe");

    function setUp() public {
        string memory rpc = vm.envOr("BASE_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        assertEq(block.chainid, 8453);
        (owner, ownerKey) = makeAddrAndKey("owner");
        (burner, burnerKey) = makeAddrAndKey("burner");

        jar = new FeeJar(initializer, keccak256(type(Firepit).runtimeCode));
        factory = new BudgetVaultFactory(USDC, address(jar), ops);
        vault = factory.create(owner, bytes32("fork"), DELAY);
        deal(address(USDC), address(vault), 1_000e6);
        assertEq(USDC.balanceOf(address(vault)), 1_000e6);
    }

    function test_Fork_UsdcDomainMatchesSdkPins() public view {
        // The SDK pins these for eip155:8453 (PINNED_USDC); a mismatch would break every signature.
        assertEq(USDC.name(), "USD Coin");
        assertEq(USDC.version(), "2");
        assertEq(USDC.DOMAIN_SEPARATOR(), _usdcDomain());
    }

    function test_Fork_PayChargesFeeInRealUsdc() public {
        bytes32 id = _activeIntent();
        vm.prank(agent);
        vault.pay(id, merchant, 10e6);
        assertEq(USDC.balanceOf(merchant), 10e6);
        // 0.1% fee, split 50/50 between the jar and operations.
        assertEq(USDC.balanceOf(address(jar)), 5_000);
        assertEq(USDC.balanceOf(ops), 5_000);
    }

    function test_Fork_BurnerPaysMerchantWithEip3009() public {
        bytes32 id = _activeIntent();
        vm.prank(agent);
        vault.fundBurner(id, burner, 20e6);
        assertEq(USDC.balanceOf(burner), 20e6);

        // What an x402 facilitator submits for the `exact` scheme: the burner's transfer authorization.
        bytes32 nonce = keccak256("x402-payment-1");
        bytes memory sig = _sign3009(TRANSFER_TYPEHASH, burner, merchant, 5e6, nonce);
        USDC.transferWithAuthorization(burner, merchant, 5e6, 0, vm.getBlockTimestamp() + 120, nonce, sig);
        assertEq(USDC.balanceOf(merchant), 5e6);
    }

    function test_Fork_SweepBurnerWithReceiveAuthorization() public {
        bytes32 id = _activeIntent();
        vm.prank(agent);
        vault.fundBurner(id, burner, 20e6);
        uint256 before = USDC.balanceOf(address(vault));

        bytes32 nonce = keccak256("sweep-1");
        bytes memory sig = _sign3009(RECEIVE_TYPEHASH, burner, address(vault), 20e6, nonce);
        vault.sweepBurner(burner, 20e6, 0, vm.getBlockTimestamp() + 120, nonce, sig);
        assertEq(USDC.balanceOf(burner), 0);
        assertEq(USDC.balanceOf(address(vault)), before + 20e6);
    }

    function test_Fork_TrancheCapHoldsWithRealUsdc() public {
        bytes32 id = _activeIntent();
        vm.startPrank(agent);
        vault.fundBurner(id, burner, 40e6);
        vm.expectRevert(BudgetVault.OverTranche.selector);
        vault.fundBurner(id, burner, 20e6);
        vm.stopPrank();
    }

    function _activeIntent() internal returns (bytes32 id) {
        BudgetVault.Intent memory i = BudgetVault.Intent({
            agent: agent,
            counterparty: merchant,
            token: address(USDC),
            maxPerTx: 50e6,
            maxPerPeriod: 200e6,
            trancheCap: 50e6,
            period: 1 days,
            validAfter: 0,
            expiry: uint64(block.timestamp + 30 days),
            nonce: 1
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, vault.intentId(i));
        id = vault.proposeIntent(i, abi.encodePacked(r, s, v));
        skip(DELAY);
    }

    function _usdcDomain() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("USD Coin"),
                keccak256("2"),
                block.chainid,
                address(USDC)
            )
        );
    }

    function _sign3009(bytes32 typehash, address from, address to, uint256 value, bytes32 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(typehash, from, to, value, 0, vm.getBlockTimestamp() + 120, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _usdcDomain(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(burnerKey, digest);
        return abi.encodePacked(r, s, v);
    }
}
