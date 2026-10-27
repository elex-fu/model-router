import { createHash } from 'node:crypto';
import { SimpleError } from '@redis/client';
import type { RedisEvalClient } from './redis-admission.js';

type EvalInput = Parameters<RedisEvalClient['eval']>[1];
interface ScriptCommands extends RedisEvalClient {
  evalSha(sha: string, input: EvalInput): Promise<unknown>;
}

// These fixed admission scripts never emit NOSCRIPT themselves. Only this
// decoded server reply proves EVALSHA did not execute. A timeout,
// lost ACK, ACL/runtime error or lookalike application Error is never retried.
const isNoScript = (error: unknown): boolean =>
  error instanceof SimpleError && error.message === 'NOSCRIPT No matching script. Please use EVAL.';

/** Transport only: static bodies, keys, arguments and replies remain unchanged. */
export function createRedisScriptTransport(command: () => ScriptCommands, scripts: readonly string[]): RedisEvalClient {
  // Bounded by the caller's static script set; never retain request arguments.
  const digests = new Map(scripts.map((script) => [script, createHash('sha1').update(script).digest('hex')]));
  return {
    async eval(script, input) {
      const sha = digests.get(script);
      if (!sha) throw new Error('Unknown fast admission Redis script');
      // Keep one command facade/deadline for the entire operation, including a
      // cold-cache fallback. Never refresh an expired command's timeout.
      const client = command();
      try {
        return await client.evalSha(sha, input);
      } catch (error) {
        if (!isNoScript(error)) throw error;
      }
      // One body fallback at most, and only after our own genuine NOSCRIPT.
      // EVAL errors/unknown ACKs propagate unchanged, without any replay.
      // Concurrent cold callers each execute only their own operation; no
      // shared promises/results or assumption that the cache stays populated.
      return client.eval(script, input);
    },
  };
}
