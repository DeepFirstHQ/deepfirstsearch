import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { recoverTypedDataAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deriveBurnerKey, burnerPayers } from "../src/wallet/burner.js";
import {
  checkStealthAddress,
  computeStealthKey,
  encodeMetaAddress,
  generateStealthAddress,
} from "../src/wallet/stealth.js";
import { signExactAuthorization, TRANSFER_WITH_AUTHORIZATION_TYPES, usdcDomain } from "../src/x402/exactEvm.js";
import { merchant, payer, USDC } from "./fixtures.js";

const seed = new Uint8Array(32).fill(7);
const vault: Address = "0x5555555555555555555555555555555555555555";

describe("burner payers", () => {
  it("are deterministic per merchant and different across merchants", () => {
    const a1 = deriveBurnerKey({ ownerSeed: seed, vault, chainId: 84532, counterparty: "0x1111111111111111111111111111111111111111" });
    const a2 = deriveBurnerKey({ ownerSeed: seed, vault, chainId: 84532, counterparty: "0x1111111111111111111111111111111111111111" });
    const b = deriveBurnerKey({ ownerSeed: seed, vault, chainId: 84532, counterparty: "0x2222222222222222222222222222222222222222" });
    const rotated = deriveBurnerKey({ ownerSeed: seed, vault, chainId: 84532, counterparty: "0x1111111111111111111111111111111111111111", epoch: 1 });
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1).not.toBe(rotated);
  });

  it("refuses short seeds", () => {
    expect(() => deriveBurnerKey({ ownerSeed: new Uint8Array(16), vault, chainId: 1, counterparty: vault })).toThrow();
  });

  it("caches one account per merchant", () => {
    const get = burnerPayers(seed, vault);
    expect(get(merchant(), 84532).address).toBe(get(merchant(), 84532).address);
    expect(get(merchant(), 84532).address).not.toBe(get(merchant({ payTo: "0x2222222222222222222222222222222222222222" }), 84532).address);
  });
});

describe("ERC-5564 stealth addresses", () => {
  it("round-trips: the recipient finds the payment and controls the address", () => {
    const spendingPriv = secp256k1.utils.randomSecretKey();
    const viewingPriv = secp256k1.utils.randomSecretKey();
    const spendingPub = secp256k1.getPublicKey(spendingPriv, true);
    const meta = encodeMetaAddress(spendingPub, secp256k1.getPublicKey(viewingPriv, true));

    const { stealthAddress, ephemeralPublicKey, viewTag } = generateStealthAddress(meta);
    expect(
      checkStealthAddress({ stealthAddress, ephemeralPublicKey, viewTag, viewingPrivateKey: viewingPriv, spendingPublicKey: spendingPub }),
    ).toBe(true);

    const key = computeStealthKey({ ephemeralPublicKey, viewingPrivateKey: viewingPriv, spendingPrivateKey: spendingPriv });
    expect(privateKeyToAccount(key).address).toBe(stealthAddress);

    // Someone else's viewing key does not match.
    expect(
      checkStealthAddress({
        stealthAddress,
        ephemeralPublicKey,
        viewTag,
        viewingPrivateKey: secp256k1.utils.randomSecretKey(),
        spendingPublicKey: spendingPub,
      }),
    ).toBe(false);
  });

  it("gives a different address for every payment", () => {
    const meta = encodeMetaAddress(
      secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true),
      secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true),
    );
    expect(generateStealthAddress(meta).stealthAddress).not.toBe(generateStealthAddress(meta).stealthAddress);
  });
});

describe("EIP-3009 signing", () => {
  it("signs with the pinned domain and a short validity window", async () => {
    const { authorization, signature } = await signExactAuthorization({
      account: payer,
      asset: USDC,
      to: "0x1111111111111111111111111111111111111111",
      value: 10_000n,
      validForSeconds: 60,
      nowSeconds: 1_000_000,
    });
    const recovered = await recoverTypedDataAddress({
      domain: usdcDomain(USDC),
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from as Address,
        to: authorization.to as Address,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce as `0x${string}`,
      },
      signature,
    });
    expect(recovered).toBe(payer.address);
    expect(BigInt(authorization.validBefore) - 1_000_000n).toBe(60n);
  });
});
