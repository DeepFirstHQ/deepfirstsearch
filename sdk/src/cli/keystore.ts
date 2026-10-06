import { createDecipheriv, pbkdf2Sync, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { bytesToHex, concat, hexToBytes, keccak256, type Hex } from "viem";

type V3 = {
  crypto?: V3Crypto;
  Crypto?: V3Crypto;
};
type V3Crypto = {
  cipher: string;
  ciphertext: string;
  cipherparams: { iv: string };
  kdf: "scrypt" | "pbkdf2";
  kdfparams: { dklen: number; salt: string; n?: number; r?: number; p?: number; c?: number; prf?: string };
  mac: string;
};

/** Decrypts a Web3 Secret Storage v3 keystore (Foundry `cast wallet import`, geth, MetaMask exports). */
export function decryptKeystore(path: string, password: string): Hex {
  const json = JSON.parse(readFileSync(path, "utf8")) as V3;
  const c = json.crypto ?? json.Crypto;
  if (!c) throw new Error("not a v3 keystore");
  if (c.cipher !== "aes-128-ctr") throw new Error(`unsupported cipher ${c.cipher}`);
  const salt = Buffer.from(c.kdfparams.salt, "hex");
  const dklen = c.kdfparams.dklen;
  let dk: Buffer;
  if (c.kdf === "scrypt") {
    const { n = 0, r = 8, p = 1 } = c.kdfparams;
    dk = scryptSync(password, salt, dklen, { N: n, r, p, maxmem: 256 * n * r + 1024 * 1024 });
  } else if (c.kdf === "pbkdf2") {
    if (c.kdfparams.prf !== "hmac-sha256") throw new Error("unsupported pbkdf2 prf");
    dk = pbkdf2Sync(password, salt, c.kdfparams.c ?? 0, dklen, "sha256");
  } else throw new Error(`unsupported kdf ${String(c.kdf)}`);
  const ciphertext = Buffer.from(c.ciphertext, "hex");
  const mac = hexToBytes(keccak256(concat([dk.subarray(16, 32), ciphertext])));
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(c.mac, "hex"))) throw new Error("wrong keystore password");
  const decipher = createDecipheriv("aes-128-ctr", dk.subarray(0, 16), Buffer.from(c.cipherparams.iv, "hex"));
  const key = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (key.length !== 32) throw new Error("unexpected key length");
  return bytesToHex(key);
}
