import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { adapterFor, listAdapters } from "../src/adapters.js";

describe("built-in client adapters", () => {
  it("lists the official clients", () => {
    expect(listAdapters()).toContain("@x402/fetch");
    expect(listAdapters()).toContain("@x402/axios");
  });

  it("rejects an unknown client with the known list", async () => {
    await expect(adapterFor("@no/such")).rejects.toThrow(/no built-in adapter.*@x402\/fetch/s);
  });

  it("explains how to install the client when it is not resolvable from the directory", async () => {
    // A directory with no x402 packages installed: the adapter should fail with an install hint, not a cryptic error.
    await expect(adapterFor("@x402/fetch", tmpdir())).rejects.toThrow(/npm i @x402\/fetch/);
  });

  it("accepts short aliases", async () => {
    // "fetch" is an alias for "@x402/fetch"; from a bare dir it still reaches the install-hint path (not "unknown").
    await expect(adapterFor("fetch", tmpdir())).rejects.toThrow(/npm i @x402\/fetch/);
  });
});
