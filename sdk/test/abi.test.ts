import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUDGET_VAULT_FACTORY_ABI, BUDGET_VAULT_FULL_ABI, FEE_JAR_ABI } from "../src/contracts/abi.js";

const OUT = join(__dirname, "../../contracts/out");
const abi = (n: string) => JSON.parse(readFileSync(join(OUT, `${n}.sol/${n}.json`), "utf8")).abi;

describe.skipIf(!existsSync(join(OUT, "BudgetVault.sol/BudgetVault.json")))("exported ABIs", () => {
  it("match the compiled contracts (run scripts/gen-abi.mjs after changing them)", () => {
    expect(BUDGET_VAULT_FULL_ABI).toEqual(abi("BudgetVault"));
    expect(BUDGET_VAULT_FACTORY_ABI).toEqual(abi("BudgetVaultFactory"));
    expect(FEE_JAR_ABI).toEqual(abi("FeeJar"));
  });
});
