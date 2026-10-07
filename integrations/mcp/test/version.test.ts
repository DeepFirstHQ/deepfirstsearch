import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { VERSION } from "../src/server.js";

describe("version", () => {
  it("reports the package version to MCP clients", () => {
    expect(VERSION).toBe(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  });
});
