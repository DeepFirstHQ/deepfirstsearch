// Builds the airdrop Merkle tree from a CSV of `account,amount` (amount in whole DEPTH or with decimals).
//   node build.mjs <input.csv> <out-dir> [--decimals 18]
// Writes <out-dir>/tree.json (the full OpenZeppelin dump) and <out-dir>/proofs.json ({account: {index, amount, proof}}).
// The leaf format matches MerkleAirdrop.claim: keccak256(bytes.concat(keccak256(abi.encode(index, account, amount)))).
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

export function parseCsv(text, decimals = 18) {
  const rows = [];
  const seen = new Set();
  for (const [n, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || /^account\s*,/i.test(line)) continue;
    const [account, amount] = line.split(",").map((s) => s.trim());
    if (!/^0x[0-9a-fA-F]{40}$/.test(account)) throw new Error(`line ${n + 1}: bad address ${account}`);
    const key = account.toLowerCase();
    if (seen.has(key)) throw new Error(`line ${n + 1}: duplicate address ${account}`);
    seen.add(key);
    rows.push([account, toUnits(amount, decimals, n + 1)]);
  }
  if (rows.length === 0) throw new Error("no rows");
  return rows;
}

function toUnits(value, decimals, line) {
  if (!/^\d+(\.\d+)?$/.test(value ?? "")) throw new Error(`line ${line}: bad amount ${value}`);
  const [whole, frac = ""] = value.split(".");
  if (frac.length > decimals) throw new Error(`line ${line}: too many decimals`);
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  if (units === 0n) throw new Error(`line ${line}: zero amount`);
  return units;
}

export function buildTree(rows) {
  const values = rows.map(([account, amount], index) => [index, account, amount]);
  const tree = StandardMerkleTree.of(values, ["uint256", "address", "uint256"]);
  const proofs = {};
  for (const [i, v] of tree.entries()) {
    proofs[v[1]] = { index: Number(v[0]), amount: v[2].toString(), proof: tree.getProof(i) };
  }
  const total = rows.reduce((s, [, a]) => s + a, 0n);
  return { tree, proofs, total };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [input, outDir] = process.argv.slice(2);
  const dIdx = process.argv.indexOf("--decimals");
  const decimals = dIdx > 0 ? Number(process.argv[dIdx + 1]) : 18;
  if (!input || !outDir) {
    console.error("usage: node build.mjs <input.csv> <out-dir> [--decimals 18]");
    process.exit(1);
  }
  const { tree, proofs, total } = buildTree(parseCsv(readFileSync(input, "utf8"), decimals));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/tree.json`, JSON.stringify(tree.dump(), (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  writeFileSync(`${outDir}/proofs.json`, JSON.stringify(proofs, null, 2));
  console.log(JSON.stringify({ root: tree.root, accounts: Object.keys(proofs).length, total: total.toString() }));
}
