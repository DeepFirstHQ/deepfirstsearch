import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, buildTree } from "./build.mjs";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";

const CSV = `account,amount
0x1111111111111111111111111111111111111111,100
0x2222222222222222222222222222222222222222,0.5
`;

test("parses whole and fractional amounts into 18-decimal units", () => {
  const rows = parseCsv(CSV);
  assert.equal(rows[0][1], 100n * 10n ** 18n);
  assert.equal(rows[1][1], 5n * 10n ** 17n);
});

test("every proof verifies against the root with the contract's leaf types", () => {
  const { tree, proofs } = buildTree(parseCsv(CSV));
  for (const [account, { index, amount, proof }] of Object.entries(proofs)) {
    assert.ok(StandardMerkleTree.verify(tree.root, ["uint256", "address", "uint256"], [index, account, amount], proof));
  }
});

test("rejects duplicates, bad addresses and zero amounts", () => {
  assert.throws(() => parseCsv(`0x1111111111111111111111111111111111111111,1\n0x1111111111111111111111111111111111111111,2`), /duplicate/);
  assert.throws(() => parseCsv(`0x123,1`), /bad address/);
  assert.throws(() => parseCsv(`0x1111111111111111111111111111111111111111,0`), /zero amount/);
});
