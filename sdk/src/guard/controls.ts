/**
 * Runtime controls that sit around the policy engine: kill switch, rate limiting, human approval and the
 * "Agents Rule of Two" session check.
 */

export class KillSwitch {
  private killedReason: string | undefined;

  kill(reason = "killed by operator"): void {
    this.killedReason = reason;
  }

  get killed(): boolean {
    return this.killedReason !== undefined;
  }

  assertAlive(): void {
    if (this.killedReason !== undefined) throw new PaymentBlockedError(`kill switch: ${this.killedReason}`);
  }
}

/** Sliding-window limiter: at most `max` payments per `windowMs`, per origin and overall. */
export class RateLimiter {
  private readonly events = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly globalMax = max * 4,
  ) {}

  check(origin: string, now: number): void {
    if (this.count(origin, now) >= this.max) throw new PaymentBlockedError(`rate limit for ${origin}`);
    if (this.count("*", now) >= this.globalMax) throw new PaymentBlockedError("global payment rate limit");
  }

  record(origin: string, now: number): void {
    for (const key of [origin, "*"]) {
      const list = this.events.get(key) ?? [];
      list.push(now);
      this.events.set(key, list);
    }
  }

  private count(key: string, now: number): number {
    const list = (this.events.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.events.set(key, list);
    return list.length;
  }
}

export type ApprovalRequest = {
  origin: string;
  payTo: string;
  amount: bigint;
  network: string;
  reasons: string[];
};

/** Must be answered by a human through a channel the model cannot write to (passkey prompt, phone, CLI). */
export type ApprovalHook = (req: ApprovalRequest) => Promise<boolean>;

export const denyAll: ApprovalHook = async () => false;

/**
 * Meta's "Agents Rule of Two": a session should hold at most two of (a) untrusted input, (b) access to sensitive
 * data or systems, (c) the ability to change state or communicate externally. Paying is (c). If a session has all
 * three, every payment requires human approval.
 */
export type SessionCapabilities = {
  readsUntrustedInput: boolean;
  accessesSensitiveData: boolean;
  canPay: boolean;
};

export function requiresHumanForEveryPayment(s: SessionCapabilities): boolean {
  return s.readsUntrustedInput && s.accessesSensitiveData && s.canPay;
}

export class PaymentBlockedError extends Error {
  override name = "PaymentBlockedError";
}

export class PaymentDeniedError extends Error {
  override name = "PaymentDeniedError";
  constructor(readonly reasons: string[]) {
    super(`payment denied: ${reasons.join("; ")}`);
  }
}
