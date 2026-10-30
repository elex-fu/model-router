import { BlockList, isIP } from 'node:net';

import type { ProxyKey } from '../config/types.js';

/**
 * O3 (docs/standalone-relay-capability-plan-2026-10-30.md): per-proxy-key IP
 * policy. `ipDenylist` wins over `ipAllowlist`; an empty allowlist means any
 * address not denied is allowed. Entries are single IPs or CIDRs (v4/v6);
 * invalid entries are ignored rather than failing the whole key — a typo in
 * one entry must not silently lock a key out of every network.
 *
 * Parsed BlockLists are cached per key object. Config snapshots create fresh
 * key objects on change, so a WeakMap never serves stale policy.
 */

interface KeyIpPolicy {
  deny: BlockList | null;
  allow: BlockList | null;
}

const policyCache = new WeakMap<object, KeyIpPolicy>();

function buildList(entries: readonly string[] | undefined): BlockList | null {
  if (!entries || entries.length === 0) return null;
  const list = new BlockList();
  let added = 0;
  for (const entry of entries) {
    const slash = entry.lastIndexOf('/');
    const address = slash < 0 ? entry : entry.slice(0, slash);
    const family = isIP(address);
    if (!family) continue;
    const prefix = slash < 0 ? (family === 4 ? 32 : 128) : Number(entry.slice(slash + 1));
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)) continue;
    list.addSubnet(address, prefix, family === 4 ? 'ipv4' : 'ipv6');
    added += 1;
  }
  return added > 0 ? list : null;
}

function policyFor(key: ProxyKey): KeyIpPolicy {
  let policy = policyCache.get(key);
  if (!policy) {
    policy = { deny: buildList(key.ipDenylist), allow: buildList(key.ipAllowlist) };
    policyCache.set(key, policy);
  }
  return policy;
}

/** True when the client address is allowed to use this key. */
export function keyIpAllowed(key: ProxyKey, clientIp: string): boolean {
  const policy = policyFor(key);
  if (!policy.deny && !policy.allow) return true;
  const normalized = clientIp.startsWith('::ffff:') ? clientIp.slice(7) : clientIp;
  const family = isIP(normalized);
  if (!family) return false; // unparseable peer address: fail closed
  const familyName = family === 4 ? ('ipv4' as const) : ('ipv6' as const);
  if (policy.deny?.check(normalized, familyName)) return false;
  if (policy.allow && !policy.allow.check(normalized, familyName)) return false;
  return true;
}
