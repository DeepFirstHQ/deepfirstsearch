import {
  BaseError,
  ContractFunctionRevertedError,
  concat,
  encodeAbiParameters,
  encodePacked,
  size,
  encodeFunctionData,
  erc20Abi,
  stringToHex,
  toFunctionSelector,
  type Address,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type WalletClient,
} from "viem";
import { PaymentDeniedError, type Merchant, type RefusalCode } from "@deepfirstsearch/agent-pay";

/**
 * Zodiac Roles v2 on Base mainnet, from @gnosis-guild/zodiac 5.0.1 (CanonicalAddresses), checked on-chain with
 * eth_getCode. The Roles modifier is deployed per Safe as a proxy of the mastercopy through the ModuleProxyFactory.
 */
export const ZODIAC = {
  rolesV2Mastercopy: "0xf2964ce6161ce0e75964fe7927ce114cb0b283d5", // Roles 2.1.1
  moduleProxyFactory: "0x000000000000aDdB49795b0f9bA5BC298cDda236", // ModuleProxyFactory 1.2.0
} as const satisfies Record<string, Address>;

/** The subset of Roles v2 used here (signatures from zodiac-roles-sdk's rolesAbi). */
export const ROLES_ABI = [
  { type: "function", name: "setUp", stateMutability: "nonpayable", inputs: [{ name: "initParams", type: "bytes" }], outputs: [] },
  { type: "function", name: "enableModule", stateMutability: "nonpayable", inputs: [{ name: "module", type: "address" }], outputs: [] },
  { type: "function", name: "isModuleEnabled", stateMutability: "view", inputs: [{ name: "module", type: "address" }], outputs: [{ type: "bool" }] },
  {
    type: "function", name: "assignRoles", stateMutability: "nonpayable",
    inputs: [{ name: "module", type: "address" }, { name: "roleKeys", type: "bytes32[]" }, { name: "memberOf", type: "bool[]" }], outputs: [],
  },
  { type: "function", name: "scopeTarget", stateMutability: "nonpayable", inputs: [{ name: "roleKey", type: "bytes32" }, { name: "targetAddress", type: "address" }], outputs: [] },
  {
    type: "function", name: "scopeFunction", stateMutability: "nonpayable",
    inputs: [
      { name: "roleKey", type: "bytes32" },
      { name: "targetAddress", type: "address" },
      { name: "selector", type: "bytes4" },
      {
        name: "conditions", type: "tuple[]",
        components: [{ name: "parent", type: "uint8" }, { name: "paramType", type: "uint8" }, { name: "operator", type: "uint8" }, { name: "compValue", type: "bytes" }],
      },
      { name: "options", type: "uint8" },
    ],
    outputs: [],
  },
  {
    type: "function", name: "setAllowance", stateMutability: "nonpayable",
    inputs: [
      { name: "key", type: "bytes32" }, { name: "balance", type: "uint128" }, { name: "maxRefill", type: "uint128" },
      { name: "refill", type: "uint128" }, { name: "period", type: "uint64" }, { name: "timestamp", type: "uint64" },
    ],
    outputs: [],
  },
  {
    type: "function", name: "allowances", stateMutability: "view", inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ name: "refill", type: "uint128" }, { name: "maxRefill", type: "uint128" }, { name: "period", type: "uint64" }, { name: "balance", type: "uint128" }, { name: "timestamp", type: "uint64" }],
  },
  {
    type: "function", name: "execTransactionWithRole", stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" }, { name: "roleKey", type: "bytes32" }, { name: "shouldRevert", type: "bool" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
  { type: "error", name: "ConditionViolation", inputs: [{ name: "status", type: "uint8" }, { name: "info", type: "bytes32" }] },
  { type: "error", name: "NoMembership", inputs: [] },
  { type: "error", name: "NotAuthorized", inputs: [{ name: "module", type: "address" }] },
  { type: "error", name: "ModuleTransactionFailed", inputs: [] },
] as const;

/** Roles v2 enums (zodiac-roles-sdk). */
const ParameterType = { None: 0, Static: 1, Calldata: 5 } as const;
const Operator = { Pass: 0, And: 1, Or: 2, Matches: 5, EqualTo: 16, WithinAllowance: 28 } as const;
const ExecutionOptions = { None: 0 } as const;
/** Roles v2 `Status` values reported by ConditionViolation(status, info). */
export const ROLES_STATUS = [
  "Ok", "DelegateCallNotAllowed", "TargetAddressNotAllowed", "FunctionNotAllowed", "SendNotAllowed", "OrViolation",
  "NorViolation", "ParameterNotAllowed", "ParameterLessThanAllowed", "ParameterGreaterThanAllowed", "ParameterNotAMatch",
  "NotEveryArrayElementPasses", "NoArrayElementPasses", "ParameterNotSubsetOfAllowed", "BitmaskOverflow", "BitmaskNotAllowed",
  "CustomConditionViolation", "AllowanceExceeded", "CallAllowanceExceeded", "EtherAllowanceExceeded",
] as const;

export const roleKey = (name: string): Hex => stringToHex(name, { size: 32 });
/** The allowance that caps one agent's role: `<role>:daily` (the name predates periods other than a day). */
export const agentAllowanceKey = (role = "agent-pay"): Hex => roleKey(`${role}:daily`);
/** The allowance shared by every role in a team budget (a cost center): `budget:<name>`. */
export const budgetKey = (name: string): Hex => roleKey(`budget:${name}`);

const MAX_U128 = 2n ** 128n;
const DAY = 86_400;

export type AgentPayRole = {
  roles: Address;
  usdc: Address;
  agent: Address;
  /** The per-merchant payer addresses the agent may top up (the only `to` the transfer accepts). */
  payers: Address[];
  /** What the agent may move out of the Safe per period, in USDC atomic units. Enforced by a Roles allowance. */
  cap?: bigint;
  /** @deprecated Same as `cap`. */
  dailyCap?: bigint;
  /** Refill period in seconds (default one day), counted from when the Safe sets the allowance. */
  period?: number;
  role?: string;
  /**
   * A team budget this agent also draws from (see `teamBudgetCalls`). Every top-up must then fit both the agent's own
   * cap and what is left in the team budget, so one agent can't use up the whole team's money.
   */
  budget?: string;
};

export type SafeCall = { to: Address; data: Hex };

const rolesCall = (roles: Address, functionName: string, args: readonly unknown[]): SafeCall => ({
  to: roles,
  data: encodeFunctionData({ abi: ROLES_ABI, functionName: functionName as never, args: args as never }),
});

const checkCap = (cap: bigint | undefined, name: string): bigint => {
  if (cap === undefined || cap <= 0n || cap >= MAX_U128) throw new Error(`${name} out of range`);
  return cap;
};

const checkPeriod = (period: number | undefined): bigint => {
  const p = period ?? DAY;
  if (!Number.isInteger(p) || p <= 0) throw new Error("period must be a positive whole number of seconds");
  return BigInt(p);
};

/**
 * The calls the Safe (the Roles owner) executes to give the agent an x402 budget:
 * the agent may call USDC.transfer(to, amount) only with `to` in `payers` and `amount` within a refilling allowance
 * (and within its team budget, when it has one).
 * Nothing else: no other function, no other contract, no ETH, no delegatecall.
 */
export function agentPayRoleCalls(r: AgentPayRole): SafeCall[] {
  if (!r.payers.length) throw new Error("at least one payer");
  if (r.payers.length > 50) throw new Error("too many payers for one condition");
  if (r.cap !== undefined && r.dailyCap !== undefined && r.cap !== r.dailyCap) throw new Error("cap and dailyCap disagree");
  const cap = checkCap(r.cap ?? r.dailyCap, "cap");
  const period = checkPeriod(r.period);
  const role = r.role ?? "agent-pay";
  const key = roleKey(role);
  const own = agentAllowanceKey(role);
  const address = (a: Address) => encodeAbiParameters([{ type: "address" }], [a]);
  const within = (parent: number, k: Hex) => ({ parent, paramType: ParameterType.Static, operator: Operator.WithinAllowance, compValue: k });
  // Breadth-first: [0] calldata matches (to, amount); [1] to; [2] amount; then the children of [1] (the payers, when
  // `to` is an Or), then the children of [2] (both allowances, when there is a team budget).
  const conditions = [
    { parent: 0, paramType: ParameterType.Calldata, operator: Operator.Matches, compValue: "0x" as Hex },
    r.payers.length === 1
      ? { parent: 0, paramType: ParameterType.Static, operator: Operator.EqualTo, compValue: address(r.payers[0]!) }
      : { parent: 0, paramType: ParameterType.None, operator: Operator.Or, compValue: "0x" as Hex },
    r.budget === undefined ? within(0, own) : { parent: 0, paramType: ParameterType.None, operator: Operator.And, compValue: "0x" as Hex },
    ...(r.payers.length === 1 ? [] : r.payers.map((p) => ({ parent: 1, paramType: ParameterType.Static, operator: Operator.EqualTo, compValue: address(p) }))),
    ...(r.budget === undefined ? [] : [within(2, own), within(2, budgetKey(r.budget))]),
  ];
  return [
    rolesCall(r.roles, "scopeTarget", [key, r.usdc]),
    rolesCall(r.roles, "scopeFunction", [key, r.usdc, toFunctionSelector("transfer(address,uint256)"), conditions, ExecutionOptions.None]),
    rolesCall(r.roles, "setAllowance", [own, cap, cap, cap, period, 0n]),
    rolesCall(r.roles, "assignRoles", [r.agent, [key], [true]]),
  ];
}

/**
 * Several Safe calls as one Safe transaction, so the owners sign the whole change once: a delegatecall to Safe's
 * MultiSendCallOnly (1.4.1 on Base: 0x9641d764fc13c8B624c04430C7356C1C7C8102e2, from @safe-global/safe-deployments),
 * which can only make plain calls. Execute the result with operation = 1 (DelegateCall).
 */
export function batchCalls(calls: SafeCall[], multiSendCallOnly: Address): SafeCall & { operation: 1 } {
  if (!calls.length) throw new Error("no calls to batch");
  const packed = calls.map((c) => encodePacked(["uint8", "address", "uint256", "uint256", "bytes"], [0, c.to, 0n, BigInt(size(c.data)), c.data]));
  return {
    to: multiSendCallOnly,
    data: encodeFunctionData({
      abi: [{ type: "function", name: "multiSend", stateMutability: "payable", inputs: [{ name: "transactions", type: "bytes" }], outputs: [] }],
      functionName: "multiSend",
      args: [concat(packed)],
    }),
    operation: 1,
  };
}

/**
 * A team budget (a cost center): one allowance that several agents' roles draw from (`budget` in `agentPayRoleCalls`).
 * Calling it again changes the cap; it also lifts a freeze.
 */
export function teamBudgetCalls(b: { roles: Address; budget: string; cap: bigint; period?: number }): SafeCall[] {
  const cap = checkCap(b.cap, "cap");
  return [rolesCall(b.roles, "setAllowance", [budgetKey(b.budget), cap, cap, cap, checkPeriod(b.period), 0n])];
}

/**
 * Incident response: stops every top-up that draws from this allowance, right away, without touching anything else.
 * Pass `{ budget }` to freeze a whole team, or `{ role }` for one agent. Undo it with `teamBudgetCalls` or
 * `agentPayRoleCalls` (which set the cap again). Money already in a payer stays there: at most one tranche per payer.
 */
export function freezeCalls(f: { roles: Address } & ({ budget: string } | { role: string })): SafeCall[] {
  const k = "budget" in f ? budgetKey(f.budget) : agentAllowanceKey(f.role);
  return [rolesCall(f.roles, "setAllowance", [k, 0n, 0n, 0n, BigInt(DAY), 0n])];
}

/** Takes the role away from an agent (for example, a leaked key). Its next top-up fails on-chain. */
export function revokeAgentCalls(r: { roles: Address; agent: Address; role?: string }): SafeCall[] {
  return [rolesCall(r.roles, "assignRoles", [r.agent, [roleKey(r.role ?? "agent-pay")], [false]])];
}

export type AllowanceStatus = {
  /** What may be spent right now, after any refill due (atomic units). */
  available: bigint;
  /** The most the allowance holds (atomic units). 0 when frozen. */
  cap: bigint;
  /** Seconds per refill. */
  period: number;
  /** When the next refill lands (unix seconds), or null when it never refills. */
  nextRefillAt: number | null;
};

/**
 * Reads an allowance the way Roles v2 accrues it: the stored balance plus the refills due since its timestamp, capped.
 * For finance dashboards: how much a team or an agent can still spend today, and when it refills.
 */
export async function readAllowance(opts: { publicClient: PublicClient; roles: Address; key: Hex; now?: number }): Promise<AllowanceStatus> {
  const [refill, maxRefill, period, balance, timestamp] = await opts.publicClient.readContract({
    address: opts.roles, abi: ROLES_ABI, functionName: "allowances", args: [opts.key],
  });
  const now = BigInt(opts.now ?? Number((await opts.publicClient.getBlock()).timestamp));
  return accrue({ refill, maxRefill, period, balance, timestamp }, now);
}

/** Roles v2 AllowanceTracker._accruedAllowance, off-chain. */
export function accrue(a: { refill: bigint; maxRefill: bigint; period: bigint; balance: bigint; timestamp: bigint }, now: bigint): AllowanceStatus {
  let { balance, timestamp } = a;
  if (a.period !== 0n && now >= a.timestamp + a.period) {
    const intervals = (now - a.timestamp) / a.period;
    if (balance < a.maxRefill) {
      balance += a.refill * intervals;
      if (balance > a.maxRefill) balance = a.maxRefill;
    }
    timestamp = a.timestamp + intervals * a.period;
  }
  return {
    available: balance,
    cap: a.maxRefill,
    period: Number(a.period),
    nextRefillAt: a.period === 0n || a.refill === 0n ? null : Number(timestamp + a.period),
  };
}

export type SpendLine = { label: string; payer: Address; toppedUp: bigint; paid: bigint; payments: number; byPayee: Record<Address, bigint> };

/**
 * Monthly reconciliation from the chain alone: for each labeled payer (for example "research / Heurist"), what the Safe
 * sent it through Roles and what it paid out over x402, by payee. Every number is a USDC Transfer log, so it matches
 * the Safe's history and the payee's books. Large ranges are read in chunks of `chunk` blocks.
 */
export async function spendReport(opts: {
  publicClient: PublicClient;
  usdc: Address;
  safe: Address;
  payers: Record<string, Address>;
  fromBlock: bigint;
  toBlock?: bigint;
  chunk?: bigint;
}): Promise<{ lines: SpendLine[]; toppedUp: bigint; paid: bigint }> {
  const transfer = erc20Abi.find((x) => x.type === "event" && x.name === "Transfer")!;
  const to = opts.toBlock ?? (await opts.publicClient.getBlockNumber());
  const step = opts.chunk ?? 10_000n;
  const lines: SpendLine[] = [];
  for (const [label, payer] of Object.entries(opts.payers)) {
    const line: SpendLine = { label, payer, toppedUp: 0n, paid: 0n, payments: 0, byPayee: {} };
    for (let from = opts.fromBlock; from <= to; from += step) {
      const end = from + step - 1n < to ? from + step - 1n : to;
      const [ins, outs] = await Promise.all([
        opts.publicClient.getLogs({ address: opts.usdc, event: transfer, args: { from: opts.safe, to: payer }, fromBlock: from, toBlock: end }),
        opts.publicClient.getLogs({ address: opts.usdc, event: transfer, args: { from: payer }, fromBlock: from, toBlock: end }),
      ]);
      for (const l of ins) line.toppedUp += l.args.value!;
      for (const l of outs) {
        line.paid += l.args.value!;
        line.payments++;
        line.byPayee[l.args.to!] = (line.byPayee[l.args.to!] ?? 0n) + l.args.value!;
      }
    }
    lines.push(line);
  }
  return { lines, toppedUp: lines.reduce((s, l) => s + l.toppedUp, 0n), paid: lines.reduce((s, l) => s + l.paid, 0n) };
}

export type LedgerRow = {
  /** Block time, ISO 8601 (UTC). */
  date: string;
  block: bigint;
  tx: Hex;
  logIndex: number;
  /** `top-up`: the Safe funded a payer through Roles. `payment`: the payer paid a payee over x402. */
  type: "top-up" | "payment";
  /** The label given to the payer (for example "research / research1 / dataApi"). */
  label: string;
  from: Address;
  to: Address;
  /** USDC atomic units. */
  amount: bigint;
  /** For payments: the site that was paid, from the SDK's audit log (matched by settlement transaction), when given. */
  site?: string;
};

/**
 * One row per USDC movement, for accounting: every top-up from the Safe to a labeled payer and every payment from that
 * payer, with block time and transaction hash, in chain order. Pass the SDK's audit log entries (`AuditLog.entries`,
 * or `parseJsonl` of its file) to add the site each payment went to. Export it with `ledgerCsv`.
 */
export async function spendLedger(opts: {
  publicClient: PublicClient;
  usdc: Address;
  safe: Address;
  payers: Record<string, Address>;
  fromBlock: bigint;
  toBlock?: bigint;
  chunk?: bigint;
  audit?: readonly { event: { type: string; [key: string]: unknown } }[];
}): Promise<LedgerRow[]> {
  const transfer = erc20Abi.find((x) => x.type === "event" && x.name === "Transfer")!;
  const to = opts.toBlock ?? (await opts.publicClient.getBlockNumber());
  const step = opts.chunk ?? 10_000n;
  const sites = new Map<string, string>();
  for (const e of opts.audit ?? []) {
    if (e.event.type === "payment.settled" && typeof e.event.tx === "string" && e.event.tx && typeof e.event.origin === "string") {
      sites.set(e.event.tx.toLowerCase(), e.event.origin);
    }
  }
  const rows: Omit<LedgerRow, "date">[] = [];
  for (const [label, payer] of Object.entries(opts.payers)) {
    for (let from = opts.fromBlock; from <= to; from += step) {
      const end = from + step - 1n < to ? from + step - 1n : to;
      const [ins, outs] = await Promise.all([
        opts.publicClient.getLogs({ address: opts.usdc, event: transfer, args: { from: opts.safe, to: payer }, fromBlock: from, toBlock: end }),
        opts.publicClient.getLogs({ address: opts.usdc, event: transfer, args: { from: payer }, fromBlock: from, toBlock: end }),
      ]);
      for (const [type, logs] of [["top-up", ins], ["payment", outs]] as const) {
        for (const l of logs) {
          const site = type === "payment" ? sites.get(l.transactionHash!.toLowerCase()) : undefined;
          rows.push({
            block: l.blockNumber!, tx: l.transactionHash!, logIndex: l.logIndex!, type, label,
            from: l.args.from!, to: l.args.to!, amount: l.args.value!, ...(site ? { site } : {}),
          });
        }
      }
    }
  }
  rows.sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1));
  const times = new Map<bigint, string>();
  for (const b of new Set(rows.map((r) => r.block))) {
    const block = await opts.publicClient.getBlock({ blockNumber: b });
    times.set(b, new Date(Number(block.timestamp) * 1000).toISOString());
  }
  return rows.map((r) => ({ date: times.get(r.block)!, ...r }));
}

/**
 * The ledger as CSV (RFC 4180), amounts in USDC with 6 decimals. Text that a spreadsheet would read as a formula
 * (starting with =, +, -, @) is prefixed with an apostrophe.
 */
export function ledgerCsv(rows: readonly LedgerRow[]): string {
  const cell = (v: string) => {
    const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const usdc = (a: bigint) => `${a / 1_000_000n}.${(a % 1_000_000n).toString().padStart(6, "0")}`;
  const header = "date,block,tx_hash,type,label,from,to,amount_usdc,site";
  const lines = rows.map((r) => [r.date, String(r.block), r.tx, r.type, cell(r.label), r.from, r.to, usdc(r.amount), cell(r.site ?? "")].join(","));
  return [header, ...lines].join("\r\n") + "\r\n";
}

export type RolesFunderOptions = {
  /** Wallet client holding the agent's key (the address the role is assigned to). */
  agent: WalletClient;
  publicClient: PublicClient;
  /** The Safe's Roles modifier. */
  roles: Address;
  usdc: Address;
  role?: string;
  /** Top up to this many atomic units at a time (the Roles allowance still bounds every top-up on-chain). */
  tranche: bigint;
  /** Optional local allowlist: refuse before sending a transaction the role would reject anyway. */
  payers?: Address[];
  confirmations?: number;
};

/** What Roles said, as the SDK's refusal codes, so the agent knows what to do (wait for the refill, or ask its owner). */
function rolesRefusal(e: unknown): PaymentDeniedError | null {
  const err = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
  if (!(err instanceof ContractFunctionRevertedError) || !err.data) return null;
  const name = err.data.errorName;
  if (name === "ConditionViolation") {
    const status = ROLES_STATUS[Number(err.data.args?.[0])] ?? "Unknown";
    const code: RefusalCode = status === "AllowanceExceeded" ? "budget_exhausted" : "policy_denied";
    return new PaymentDeniedError([`Zodiac Roles refused the top-up: ${status}`], [code]);
  }
  if (name === "NoMembership" || name === "NotAuthorized") {
    return new PaymentDeniedError([`Zodiac Roles refused the top-up: ${name} (the agent does not hold the role)`], ["policy_denied"]);
  }
  return null;
}

/**
 * `ensureFunded` hook for `createAgentPay`: before a payment, if the merchant's payer holds less than the amount, the
 * agent tops it up from the Safe through Roles. The funds stay in the Safe until then; the role decides on-chain
 * who may receive them and how much per period, so a compromised agent key can't exceed it.
 * When Roles refuses (cap reached, budget frozen, role revoked), the payment fails with a PaymentDeniedError whose
 * code is `budget_exhausted` (wait for the refill) or `policy_denied` (ask the owner), and nothing is signed.
 */
export function rolesFunder(opts: RolesFunderOptions) {
  if (opts.tranche <= 0n) throw new Error("tranche must be positive");
  const key = roleKey(opts.role ?? "agent-pay");
  const allowed = opts.payers?.map((a) => a.toLowerCase());
  // One funding decision per payer at a time: parallel payments must not each read the same balance and top up twice.
  const locks = new Map<Address, Promise<unknown>>();

  const fund = async (payer: Address, topUp: bigint) => {
    let hash: Hex;
    try {
      hash = await opts.agent.writeContract({
        address: opts.roles,
        abi: ROLES_ABI,
        functionName: "execTransactionWithRole",
        args: [opts.usdc, 0n, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [payer, topUp] }), 0, key, true],
        account: opts.agent.account!,
        chain: opts.agent.chain,
      });
    } catch (e) {
      throw rolesRefusal(e) ?? e;
    }
    const receipt = await opts.publicClient.waitForTransactionReceipt({ hash, confirmations: opts.confirmations ?? 2 });
    if (receipt.status !== "success") throw new Error(`Roles top-up reverted (${hash})`);
  };

  const ensure = async (payer: LocalAccount, _merchant: Merchant, amount: bigint): Promise<void> => {
    if (amount <= 0n) throw new Error("amount must be positive");
    if (allowed && !allowed.includes(payer.address.toLowerCase())) {
      throw new PaymentDeniedError([`payer ${payer.address} is not in this role`], ["policy_denied"]);
    }
    const balance = await opts.publicClient.readContract({ address: opts.usdc, abi: erc20Abi, functionName: "balanceOf", args: [payer.address] });
    if (balance >= amount) return;
    const target = opts.tranche > amount ? opts.tranche : amount;
    await fund(payer.address, target - balance);
  };

  return (payer: LocalAccount, merchant: Merchant, amount: bigint): Promise<void> => {
    const previous = locks.get(payer.address) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => ensure(payer, merchant, amount));
    locks.set(payer.address, run);
    void run.finally(() => {
      if (locks.get(payer.address) === run) locks.delete(payer.address);
    }).catch(() => undefined);
    return run;
  };
}
