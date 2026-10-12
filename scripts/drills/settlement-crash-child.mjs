#!/usr/bin/env node
// FIN-01 crash-drill child (A3 / Track I shared base). Reads settlement inputs
// from a JSON file, completes each through the real conditional settlement
// port against the restricted gateway role, and appends one fsync'd JSONL
// marker per finished request. The parent drill SIGKILLs this process
// mid-flight; a later run re-attempts every input so terminal replay proves
// exactly-once financial effect. No output contains URLs or key material.
import { appendFileSync, readFileSync } from 'node:fs';

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || index + 1 >= process.argv.length) return undefined;
  return process.argv[index + 1];
}
const inputsPath = arg('inputs');
const progressPath = arg('progress');
const runId = arg('run-id');
// The restricted role URL arrives via env (never argv/process list), matching
// the CI runner's fixed-env contract. It carries no password (trust auth).
const gatewayUrl = process.env.MODEL_ROUTER_SAAS_DRILL_GATEWAY_URL;
if (!inputsPath || !progressPath || !gatewayUrl || !runId || !/^[a-z0-9-]+$/.test(runId)) {
  console.error('usage: settlement-crash-child --inputs f --progress f --run-id id (env: MODEL_ROUTER_SAAS_DRILL_GATEWAY_URL)');
  process.exit(2);
}
const payload = JSON.parse(readFileSync(inputsPath, 'utf8'));
if (
  payload === null || typeof payload !== 'object' || !Array.isArray(payload.inputs) ||
  typeof payload.idempotencyHmacHex !== 'string' || !/^[0-9a-f]{16}$/.test(payload.idempotencyHmacHex)
) {
  console.error('inputs file is not a settlement drill payload');
  process.exit(2);
}

const { createSaasDatabase } = await import('../../src/saas/db/index.js');
const { PlatformWalletLedgerService } = await import('../../src/saas/billing/service.js');
const { SaasMeteringService } = await import('../../src/saas/metering/service.js');
const { DurableNormalSuccessSettlementPort } = await import('../../src/saas/metering/conditional-settlement-port.js');

const database = createSaasDatabase({ connectionString: gatewayUrl, max: 1, connectionTimeoutMillis: 5_000 });
const metering = new SaasMeteringService(database, {
  idempotencyHmacSecret: Uint8Array.from(Buffer.from(payload.idempotencyHmacHex, 'hex')),
});
const port = new DurableNormalSuccessSettlementPort(database, { metering, billing: new PlatformWalletLedgerService() });

let sequence = 0;
try {
  for (const input of payload.inputs) {
    const result = await port.complete(input);
    sequence += 1;
    // Synchronous append: a SIGKILL after this line cannot lose the marker.
    appendFileSync(progressPath, `${JSON.stringify({ runId, sequence, requestId: input.requestId, kind: result.kind })}\n`);
  }
} catch {
  // Redacted by contract: the parent observes database facts, not child text.
  console.error('settlement drill child failed mid-run');
  process.exitCode = 1;
} finally {
  await database.close();
}
