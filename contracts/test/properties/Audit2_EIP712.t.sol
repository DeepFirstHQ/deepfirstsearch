// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BudgetVault} from "../../src/safe/BudgetVault.sol";

/// @notice EIP-712 consistency between the contract and the SDK (sdk/src/wallet/intent.ts).
///         The SDK field list below is a verbatim copy of `INTENT_TYPES.Intent`. The digest and signature vector were
///         produced by the SDK itself (`hashTypedData` + `signIntent`, viem 2.57.3) with the inputs used in
///         `test_SdkVectorIsAcceptedByTheVault`; if either side changes, this file fails.
contract Audit2_EIP712Test is Test {
    struct Field {
        string name;
        string typ;
    }

    // Verbatim from sdk/src/wallet/intent.ts INTENT_TYPES.Intent (order matters).
    function _sdkFields() internal pure returns (Field[] memory f) {
        f = new Field[](11);
        f[0] = Field("agent", "address");
        f[1] = Field("counterparty", "address");
        f[2] = Field("burner", "address");
        f[3] = Field("token", "address");
        f[4] = Field("maxPerTx", "uint128");
        f[5] = Field("maxPerPeriod", "uint128");
        f[6] = Field("trancheCap", "uint128");
        f[7] = Field("period", "uint32");
        f[8] = Field("validAfter", "uint64");
        f[9] = Field("expiry", "uint64");
        f[10] = Field("nonce", "uint256");
    }

    // Values computed by the SDK (scratch script run during the audit, see report).
    bytes32 constant SDK_TYPEHASH = 0xac9a8436a1a5c4cb91e51da261f794df288e84bab0170750f4b6c30edaf691d1;
    bytes32 constant SDK_DIGEST = 0x08099bd274ef88839dadd92e077bea74c975be233373a49897219b101ac55bcf;
    bytes constant SDK_SIG =
        hex"39c993831ee9c1dd147d13586928737f65424ccd619ecaed1a64de5b0b2064276e782ba4dd46ac73f394e0aa2b54e04397979be200388552e8dbec8430b808e01c";
    address constant SDK_OWNER = 0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7; // key 0xa11ce
    address constant SDK_VAULT = 0x000000000000000000000000000000000000da5f;
    address constant SDK_TOKEN = 0x4444444444444444444444444444444444444444;

    function _sdkIntent() internal pure returns (BudgetVault.Intent memory) {
        return BudgetVault.Intent({
            agent: 0x1111111111111111111111111111111111111111,
            counterparty: 0x2222222222222222222222222222222222222222,
            burner: 0x3333333333333333333333333333333333333333,
            token: SDK_TOKEN,
            maxPerTx: 50_000_000,
            maxPerPeriod: 200_000_000,
            trancheCap: 25_000_000,
            period: 86400,
            validAfter: 7,
            expiry: 4_000_000_000,
            nonce: 42
        });
    }

    function test_TypehashMatchesSdkFieldList() public {
        Field[] memory f = _sdkFields();
        bytes memory s = "Intent(";
        for (uint256 i; i < f.length; ++i) {
            s = bytes.concat(s, bytes(f[i].typ), " ", bytes(f[i].name), i + 1 < f.length ? bytes(",") : bytes(")"));
        }
        BudgetVault v = new BudgetVault(address(1), IERC20(SDK_TOKEN), address(2), address(3), 5_000, 1 hours);
        assertEq(keccak256(s), v.INTENT_TYPEHASH(), "typehash string != SDK field list");
        assertEq(SDK_TYPEHASH, v.INTENT_TYPEHASH(), "typehash != SDK-computed typehash");
    }

    /// The struct hash order (`_structHash`) must follow the typehash order. Computed independently here.
    function test_StructHashOrderMatchesTypehash() public {
        BudgetVault v = new BudgetVault(address(1), IERC20(SDK_TOKEN), address(2), address(3), 5_000, 1 hours);
        BudgetVault.Intent memory i = _sdkIntent();
        bytes32 sh = keccak256(
            abi.encode(
                v.INTENT_TYPEHASH(),
                i.agent,
                i.counterparty,
                i.burner,
                i.token,
                i.maxPerTx,
                i.maxPerPeriod,
                i.trancheCap,
                i.period,
                i.validAfter,
                i.expiry,
                i.nonce
            )
        );
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Deep First Search Agent Safe"),
                keccak256("1"),
                block.chainid,
                address(v)
            )
        );
        assertEq(v.intentId(i), keccak256(abi.encodePacked("\x19\x01", domain, sh)));
    }

    /// End to end: a signature produced by the SDK's `signIntent` is accepted, and the id equals the SDK digest.
    function test_SdkVectorIsAcceptedByTheVault() public {
        assertEq(block.chainid, 31337);
        deployCodeTo(
            "BudgetVault.sol:BudgetVault",
            abi.encode(SDK_OWNER, SDK_TOKEN, address(2), address(3), uint16(5_000), uint32(1 hours)),
            SDK_VAULT
        );
        BudgetVault v = BudgetVault(SDK_VAULT);
        assertEq(v.intentId(_sdkIntent()), SDK_DIGEST, "intentId != SDK digest");
        bytes32 id = v.proposeIntent(_sdkIntent(), SDK_SIG);
        assertEq(id, SDK_DIGEST);
    }

    /// Changing any single field (incl. the new `burner`) changes the id, so a signature cannot be reused for it.
    function testFuzz_EveryFieldIsSigned(uint8 which, address a) public {
        BudgetVault v = new BudgetVault(address(1), IERC20(SDK_TOKEN), address(2), address(3), 5_000, 1 hours);
        BudgetVault.Intent memory i = _sdkIntent();
        bytes32 base = v.intentId(i);
        uint256 x = uint160(a);
        which = uint8(bound(which, 0, 10));
        if (which == 0) {
            vm.assume(a != i.agent);
            i.agent = a;
        } else if (which == 1) {
            vm.assume(a != i.counterparty);
            i.counterparty = a;
        } else if (which == 2) {
            vm.assume(a != i.burner);
            i.burner = a;
        } else if (which == 3) {
            vm.assume(a != i.token);
            i.token = a;
        } else if (which == 4) {
            vm.assume(uint128(x) != i.maxPerTx);
            i.maxPerTx = uint128(x);
        } else if (which == 5) {
            vm.assume(uint128(x) != i.maxPerPeriod);
            i.maxPerPeriod = uint128(x);
        } else if (which == 6) {
            vm.assume(uint128(x) != i.trancheCap);
            i.trancheCap = uint128(x);
        } else if (which == 7) {
            vm.assume(uint32(x) != i.period);
            i.period = uint32(x);
        } else if (which == 8) {
            vm.assume(uint64(x) != i.validAfter);
            i.validAfter = uint64(x);
        } else if (which == 9) {
            vm.assume(uint64(x) != i.expiry);
            i.expiry = uint64(x);
        } else {
            vm.assume(x != i.nonce);
            i.nonce = x;
        }
        assertTrue(v.intentId(i) != base);
    }
}
