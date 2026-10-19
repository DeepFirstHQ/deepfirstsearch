import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import type { PayingFetch } from "./scan.js";

/**
 * A built-in adapter turns a published buyer client into the `() => PayingFetch` factory `scan()` expects, so a
 * developer can grade a client with one command and no wiring:
 *
 *   npx @deepfirstsearch/x402-scan client @x402/fetch
 *
 * We construct the client the standard, documented way with a throwaway key (nothing settles — the attack server is
 * local and only records what the client signs) and resolve the client's packages from the directory the command runs
 * in, so it grades the copy the project actually depends on.
 */
export type ClientFactory = () => PayingFetch | Promise<PayingFetch>;

/** Resolve-and-import a package (or subpath) from the user's project, not from where x402-scan is installed. */
function importerFrom(cwd: string): (name: string) => Promise<unknown> {
  const req = createRequire(join(cwd, "index.js"));
  return (name: string) => import(pathToFileURL(req.resolve(name)).href);
}

function installHint(cwd: string, pkgs: string, cause: unknown): Error {
  return new Error(
    `could not load the client's packages from ${cwd}.\n` +
      `Install them in this project first:\n  npm i ${pkgs}\n` +
      `then re-run the scan from the same directory.\n(${(cause as Error).message})`,
  );
}

async function officialFetch(cwd: string): Promise<ClientFactory> {
  const imp = importerFrom(cwd);
  let fetchMod: any, evmMod: any, accounts: any;
  try {
    fetchMod = await imp("@x402/fetch");
    evmMod = await imp("@x402/evm/exact/client");
    accounts = await imp("viem/accounts");
  } catch (e) {
    throw installHint(cwd, "@x402/fetch @x402/evm viem", e);
  }
  const { x402Client, wrapFetchWithPayment } = fetchMod;
  const { ExactEvmScheme } = evmMod;
  const { privateKeyToAccount, generatePrivateKey } = accounts;
  return () => {
    const client = x402Client.fromConfig({
      schemes: [{ network: "eip155:*", client: new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())) }],
    });
    const paying = wrapFetchWithPayment(fetch, client);
    return (url: string) => paying(url);
  };
}

async function officialAxios(cwd: string): Promise<ClientFactory> {
  const imp = importerFrom(cwd);
  let axiosMod: any, axiosLib: any, evmMod: any, accounts: any;
  try {
    axiosMod = await imp("@x402/axios");
    axiosLib = await imp("axios");
    evmMod = await imp("@x402/evm/exact/client");
    accounts = await imp("viem/accounts");
  } catch (e) {
    throw installHint(cwd, "@x402/axios @x402/evm viem axios", e);
  }
  const { x402Client, wrapAxiosWithPayment } = axiosMod;
  const axios = axiosLib.default ?? axiosLib;
  const { ExactEvmScheme } = evmMod;
  const { privateKeyToAccount, generatePrivateKey } = accounts;
  return () => {
    const client = x402Client.fromConfig({
      schemes: [{ network: "eip155:*", client: new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())) }],
    });
    const instance = wrapAxiosWithPayment(axios.create(), client);
    return (url: string) => instance.get(url);
  };
}

const ADAPTERS: Record<string, { aliases: string[]; make: (cwd: string) => Promise<ClientFactory> }> = {
  "@x402/fetch": { aliases: ["x402/fetch", "fetch"], make: officialFetch },
  "@x402/axios": { aliases: ["x402/axios", "axios"], make: officialAxios },
};

/** The client names `x402-scan client <name>` understands out of the box. */
export function listAdapters(): string[] {
  return Object.keys(ADAPTERS);
}

/** Build the factory for a named client, resolving its packages from `cwd` (defaults to the process working dir). */
export async function adapterFor(name: string, cwd: string = process.cwd()): Promise<ClientFactory> {
  const key =
    Object.keys(ADAPTERS).find((k) => k === name) ??
    Object.entries(ADAPTERS).find(([, v]) => v.aliases.includes(name))?.[0];
  if (!key) {
    throw new Error(`no built-in adapter for "${name}". Known clients: ${listAdapters().join(", ")}.`);
  }
  return ADAPTERS[key]!.make(cwd);
}
