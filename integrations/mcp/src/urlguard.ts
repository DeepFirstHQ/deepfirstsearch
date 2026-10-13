import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// Kept identical in every package with a paid_fetch tool (each is published on its own): change one, change them all.

export type UrlGuardOptions = {
  /** True for an owner-registered merchant origin: always allowed (in development it may be http://localhost). */
  isMerchant: (origin: string) => boolean;
  /** Owner opt-in: also fetch http:// URLs and hosts on loopback, private, link-local or CGNAT addresses. */
  allowPrivateNetwork?: boolean;
};

/**
 * Why a model-chosen URL must not be fetched, or undefined when it may be. Without this, an injected instruction could
 * point the agent at this machine's own services, the LAN or a cloud metadata endpoint (169.254.169.254) and read the
 * answer back. Only https is allowed, and every address the host resolves to must be public. Callers fetch with
 * `redirect: "manual"`, so a public URL can't bounce the request inward. fetch resolves the name again, so a DNS server
 * that answers differently the second time (rebinding) is not covered here; an egress firewall is the complete fix.
 */
export async function urlRefusal(url: string, opts: UrlGuardOptions): Promise<string | undefined> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "not a valid URL";
  }
  if (opts.isMerchant(u.origin) || opts.allowPrivateNetwork) return undefined;
  if (u.protocol !== "https:") return `only https URLs can be fetched, not ${u.protocol}`;
  const host = u.hostname.replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return `${host} is a local host name`;
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
    } catch {
      return `could not resolve ${host}`;
    }
  }
  if (!addresses.length || addresses.some(isPrivateAddress))
    return `${host} is or resolves to a loopback, private, link-local or otherwise internal address`;
  return undefined;
}

function privateV4([a, b]: number[]): boolean {
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b! >= 64 && b! <= 127) || // CGNAT 100.64/10
    a! >= 224 // multicast, reserved, broadcast
  );
}

/** The eight 16-bit words of a valid IPv6 address (zone dropped, embedded dotted IPv4 supported). */
function ipv6Words(ip: string): number[] {
  let s = ip.split("%")[0]!;
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) {
    const [b0, b1, b2, b3] = v4.slice(1).map(Number) as [number, number, number, number];
    s = `${s.slice(0, v4.index)}${((b0 << 8) | b1).toString(16)}:${((b2 << 8) | b3).toString(16)}`;
  }
  const [head = "", tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const zeros = tail === undefined ? [] : Array<string>(8 - h.length - t.length).fill("0");
  return [...h, ...zeros, ...t].map((x) => Number.parseInt(x, 16));
}

/** Loopback, private, link-local, CGNAT, unspecified or otherwise non-public. Anything unparseable counts as private. */
export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return privateV4(ip.split(".").map(Number));
  if (version !== 6) return true;
  const w = ipv6Words(ip);
  const zero = (from: number, to: number) => w.slice(from, to).every((x) => x === 0);
  if (zero(0, 5) && w[5] === 0xffff) return privateV4([w[6]! >> 8, w[6]! & 255]); // IPv4-mapped ::ffff:a.b.c.d
  if (w[0] === 0x64 && w[1] === 0xff9b && zero(2, 6)) return privateV4([w[6]! >> 8, w[6]! & 255]); // NAT64 64:ff9b::/96
  return (
    zero(0, 8) || // ::
    (zero(0, 7) && w[7] === 1) || // ::1
    (w[0]! & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (w[0]! & 0xffc0) === 0xfec0 || // site-local fec0::/10 (deprecated)
    (w[0]! & 0xfe00) === 0xfc00 // unique local fc00::/7
  );
}
