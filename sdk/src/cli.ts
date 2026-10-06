#!/usr/bin/env node
import { createInterface } from "node:readline";
import { ownerCli, type Io } from "./cli/owner.js";
import { demo } from "./cli/demo.js";

const ask = (q: string, hidden = false) =>
  new Promise<string>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    if (hidden) (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s) => {
      if (s.startsWith(q)) process.stderr.write(q);
    };
    rl.question(q, (a) => {
      rl.close();
      if (hidden) process.stderr.write("\n");
      resolve(a);
    });
  });

const io: Io = { out: (s) => console.log(s), err: (s) => console.error(s), ...(process.stdin.isTTY ? { ask } : {}) };
const [group, ...rest] = process.argv.slice(2);
if (group !== "owner" && group !== "demo") {
  console.error("usage: agent-pay demo                         a 10-second offline tour: one payment, four attacks refused\n       agent-pay owner <command> [options]   vaults and budgets on Base (agent-pay owner help)");
  process.exit(1);
}
try {
  process.exitCode = group === "demo" ? await demo(io, Boolean(process.stdout.isTTY)) : await ownerCli(rest, process.env, io);
} catch (e) {
  console.error(`agent-pay: ${(e as Error).message.split("\n")[0]}`);
  process.exitCode = 1;
}
