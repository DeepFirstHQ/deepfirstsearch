import {
  encodeAbiParameters,
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
import type { Merchant } from "@deepfirstsearch/agent-pay";

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
const Operator = { Pass: 0, Or: 2, Matches: 5, EqualTo: 16, WithinAllowance: 28 } as const;
const ExecutionOptions = { None: 0 } as const;
/** Roles v2 `Status` values reported by ConditionViolation(status, info). */
export const ROLES_STATUS = [
  "Ok", "DelegateCallNotAllowed", "TargetAddressNotAllowed", "FunctionNotAllowed", "SendNotAllowed", "OrViolation",
  "NorViolation", "ParameterNotAllowed", "ParameterLessThanAllowed", "ParameterGreaterThanAllowed", "ParameterNotAMatch",
  "NotEveryArrayElementPasses", "NoArrayElementPasses", "ParameterNotSubsetOfAllowed", "BitmaskOverflow", "BitmaskNotAllowed",
  "CustomConditionViolation", "AllowanceExceeded", "CallAllowanceExceeded", "EtherAllowanceExceeded",
] as const;

export const roleKey = (name: string): Hex => stringToHex(name, { size: 32 });

export type AgentPayRole = {
  roles: Address;
  usdc: Address;
  agent: Address;
  /** The per-merchant payer addresses the agent may top up (the only `to` the transfer accepts). */
  payers: Address[];
  /** Total the agent may move out of the Safe per period, in USDC atomic units. Enforced by a Roles allowance. */
  dailyCap: bigint;
  period?: number;
  role?: string;
};

export type SafeCall = { to: Address; data: Hex };

/**
 * The calls the Safe (the Roles owner) executes to give the agent an x402 budget:
 * the agent may call USDC.transfer(to, amount) only with `to` in `payers` and `amount` within a refilling allowance.
 * Nothing else: no other function, no other contract, no ETH, no delegatecall.
 */
export function agentPayRoleCalls(r: AgentPayRole): SafeCall[] {
  if (!r.payers.length) throw new Error("at least one payer");
  if (r.payers.length > 50) throw new Error("too many payers for one condition");
  if (r.dailyCap <= 0n || r.dailyCap >= 2n ** 128n) throw new Error("dailyCap out of range");
  const key = roleKey(r.role ?? "agent-pay");
  const allowanceKey = roleKey(`${r.role ?? "agent-pay"}:daily`);
  const toNode = r.payers.length === 1
    ? [] // a single payer: the `to` node itself is EqualTo
    : r.payers.map((p) => ({ parent: 1, paramType: ParameterType.Static, operator: Operator.EqualTo, compValue: encodeAbiParameters([{ type: "address" }], [p]) }));
  // Breadth-first: [0] calldata matches (to, amount); [1] to; [2] amount; [3..] the payers when `to` is an Or.
  const conditions = [
    { parent: 0, paramType: ParameterType.Calldata, operator: Operator.Matches, compValue: "0x" as Hex },
    r.payers.length === 1
      ? { parent: 0, paramType: ParameterType.Static, operator: Operator.EqualTo, compValue: encodeAbiParameters([{ type: "address" }], [r.payers[0]!]) }
      : { parent: 0, paramType: ParameterType.None, operator: Operator.Or, compValue: "0x" as Hex },
    { parent: 0, paramType: ParameterType.Static, operator: Operator.WithinAllowance, compValue: allowanceKey },
    ...toNode,
  ];
  const period = BigInt(r.period ?? 86_400);
  const call = (functionName: string, args: readonly unknown[]): SafeCall => ({
    to: r.roles,
    data: encodeFunctionData({ abi: ROLES_ABI, functionName: functionName as never, args: args as never }),
  });
  return [
    call("scopeTarget", [key, r.usdc]),
    call("scopeFunction", [key, r.usdc, toFunctionSelector("transfer(address,uint256)"), conditions, ExecutionOptions.None]),
    call("setAllowance", [allowanceKey, r.dailyCap, r.dailyCap, r.dailyCap, period, 0n]),
    call("assignRoles", [r.agent, [key], [true]]),
  ];
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

/**
 * `ensureFunded` hook for `createAgentPay`: before a payment, if the merchant's payer holds less than the amount, the
 * agent tops it up from the Safe through Roles. The funds stay in the Safe until then; the role decides on-chain
 * who may receive them and how much per period, so a compromised agent key can't exceed it.
 */
export function rolesFunder(opts: RolesFunderOptions) {
  if (opts.tranche <= 0n) throw new Error("tranche must be positive");
  const key = roleKey(opts.role ?? "agent-pay");
  const allowed = opts.payers?.map((a) => a.toLowerCase());
  // One funding decision per payer at a time: parallel payments must not each read the same balance and top up twice.
  const locks = new Map<Address, Promise<unknown>>();

  const fund = async (payer: Address, topUp: bigint) => {
    const hash = await opts.agent.writeContract({
      address: opts.roles,
      abi: ROLES_ABI,
      functionName: "execTransactionWithRole",
      args: [opts.usdc, 0n, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [payer, topUp] }), 0, key, true],
      account: opts.agent.account!,
      chain: opts.agent.chain,
    });
    const receipt = await opts.publicClient.waitForTransactionReceipt({ hash, confirmations: opts.confirmations ?? 2 });
    if (receipt.status !== "success") throw new Error(`Roles top-up reverted (${hash})`);
  };

  const ensure = async (payer: LocalAccount, _merchant: Merchant, amount: bigint): Promise<void> => {
    if (amount <= 0n) throw new Error("amount must be positive");
    if (allowed && !allowed.includes(payer.address.toLowerCase())) throw new Error(`payer ${payer.address} is not in this role`);
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
