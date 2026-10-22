import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  assertKimiHttpStatus,
  bindVerifiedKimiSupply,
  captureKimiNumericUsage,
  INITIAL_WALLET,
  type JsonObject,
  KIMI_COMMERCIAL_REQUIRED,
  KIMI_COMMERCIAL_URLS,
  type KimiCommercialFixture,
  kimiFinancialSnapshot,
  postKimi,
  provisionKimiCommercialFixture,
  readCliStartupDiagnostics,
  readCredentialOnboardingDiagnostics,
  readDurableKimiFailureState,
  readDurableKimiRequest,
  readKimiHttpFailureDiagnostics,
  readKimiJsonResponse,
  readKimiSettlementDiagnostics,
  startBuiltCli,
  waitCredentialVerified,
  waitGatewayReady,
  waitKimiSettled,
  waitUntil,
} from '../../scripts/ops/verify-commercial-kimi.js';
import {
  executeOpaqueLookup,
  OPAQUE_LOOKUP_PROMPT,
  OPAQUE_LOOKUP_TOOL,
  OPAQUE_LOOKUP_VALUE,
} from './kimi-code-opaque-tool-fixture.js';

// Explicit live opt-in. The disposable PostgreSQL runner creates/destroys the
// database and restricted identities; this suite never discovers a local key,
// changes an existing gateway, or calls the real provider from a fake handler.
// Build the current server first, then have the parent supervisor run:
// RUN_KIMI_COMMERCIAL_LIVE=1 KIMI_CODE_API_KEY=<ephemeral environment value>
//   node scripts/run-commercial-postgres-gate.mjs --suite kimi
// It uses a pilot software KMS and local test pricing/rights, so a passing test
// proves commercial accounting behavior, not production KMS or resale approval.
const enabled = process.env[KIMI_COMMERCIAL_REQUIRED] === '1';
const credential = process.env.KIMI_CODE_API_KEY;
const firstDispatchOnly = process.env.KIMI_COMMERCIAL_FIRST_DISPATCH_ONLY === '1';

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requestId(response: Response): string {
  const value = response.headers.get('x-request-id');
  assert.ok(value, 'Every accepted commercial request must expose its durable request ID');
  return value;
}

function assistantMessage(body: JsonObject): JsonObject {
  assert.ok(Array.isArray(body.choices), 'Expected OpenAI choices after the native-provider bridge');
  const first = body.choices[0];
  assert.ok(isRecord(first) && isRecord(first.message), 'Expected an OpenAI assistant message');
  return first.message;
}

test('built CLI Kimi commercial acceptance: automatic onboarding, native JSON/SSE, OpenAI tools and durable accounting', {
  skip: !enabled ? `Set ${KIMI_COMMERCIAL_REQUIRED}=1 with the disposable PostgreSQL runner to opt in` : false,
  timeout: 600_000,
}, async (t) => {
  assert.ok(credential, 'KIMI_CODE_API_KEY must be supplied ephemerally by the live-test supervisor');
  for (const name of Object.values(KIMI_COMMERCIAL_URLS)) {
    assert.ok(process.env[name], `${name} must identify the disposable runner-owned database`);
  }
  let fixture: KimiCommercialFixture | undefined;
  const evidence: {
    schema: number;
    startedAt: string;
    finishedAt?: string;
    mode: string;
    kms: string;
    runtime: string;
    postgresPreparedStatements?: KimiCommercialFixture['postgresPreparedStatements'];
    scope: string;
    inventorySeedRole: string;
    supplyLifecycleRole: string;
    customerKeyRole: string;
    providerInferenceCallsExpected: number;
    scenes: Array<Record<string, unknown>>;
    processesStopped?: boolean;
    cliStartup?: ReturnType<typeof readCliStartupDiagnostics>;
    credentialOnboarding?: ReturnType<typeof readCredentialOnboardingDiagnostics>;
    httpFailures?: ReturnType<typeof readKimiHttpFailureDiagnostics>;
    settlements?: ReturnType<typeof readKimiSettlementDiagnostics>;
    passed?: boolean;
    failedStage?: string;
  } = {
    schema: 1,
    startedAt: new Date().toISOString(),
    mode: 'real-provider-disposable-pg18',
    kms: 'local-test-pilot-software-kms',
    runtime: 'current-dist-cli-builtin',
    scope: firstDispatchOnly ? 'first-dispatch-and-duplicate-only' : 'full-commercial-matrix',
    inventorySeedRole: 'disposable-test-migrator',
    supplyLifecycleRole: 'model_router_saas_control_plane',
    customerKeyRole: 'model_router_saas_control_plane',
    providerInferenceCallsExpected: firstDispatchOnly ? 2 : 8,
    scenes: [],
  };
  let stage = 'provision-disposable-test-inventory';
  let totalCharged = 0n;
  const runScene = async (name: string, run: () => Promise<void>) => {
    let failed = false;
    await t.test(name, async () => {
      try {
        await run();
      } catch (error) {
        failed = true;
        throw error;
      }
    });
    assert.equal(failed, false, `Stop live dispatch after the first failed scene: ${stage}`);
  };
  const settle = async (response: Response, protocol: 'openai' | 'anthropic', scene: string) => {
    assert.ok(fixture);
    const durable = await waitKimiSettled(fixture, requestId(response), protocol);
    totalCharged += BigInt(durable.settlement_amount ?? '0');
    evidence.scenes.push({
      scene,
      requestId: durable.request_id,
      state: durable.execution_state,
      inputTokens: durable.input_total,
      outputTokens: durable.output_total,
      amountMinorUnits: durable.settlement_amount,
      priceVersion: durable.snapshot_price_version,
      supplierCostVersion: durable.supplier_cost_version,
    });
    const wallet = await kimiFinancialSnapshot(fixture);
    assert.equal(
      wallet.wallet,
      (INITIAL_WALLET - totalCharged).toString(),
      'Every completed real request must match the exact wallet delta',
    );
    return durable;
  };
  try {
    fixture = await provisionKimiCommercialFixture(credential);
    evidence.postgresPreparedStatements = fixture.postgresPreparedStatements;
    const live = fixture;
    // Validate the observation query before spending the first provider call.
    assert.equal(await readDurableKimiRequest(live, randomUUID()), undefined);
    const failureQuery = await readDurableKimiFailureState(live, randomUUID());
    assert.equal(failureQuery.available, true, 'The safe failure observer must be queryable before provider calls');
    assert.equal(
      failureQuery.querySqlstate,
      null,
      'The safe failure observer must be schema-compatible before provider calls',
    );
    assert.equal(failureQuery.found, false);
    await runScene(
      'platform import automatically reaches active/verified through the built credential worker',
      async () => {
        stage = 'automatic-credential-onboarding';
        const worker = startBuiltCli(live, 'credential-validation-worker');
        const verified = await waitCredentialVerified(live, worker, (snapshot) => {
          t.diagnostic(`credential_onboarding_state ${JSON.stringify(snapshot)}`);
        });
        evidence.scenes.push({
          scene: stage,
          accountState: verified.account_status,
          credentialState: verified.credential_status,
          validationState: verified.credential_validation,
          validationAttempts: verified.attempt_count,
        });
        await bindVerifiedKimiSupply(live);
        const gateway = startBuiltCli(live, 'gateway');
        await waitGatewayReady(live, gateway);
        assert.equal((await kimiFinancialSnapshot(live)).wallet, INITIAL_WALLET.toString());
      },
    );

    await runScene(
      'native nonstreaming commercial request settles upstream usage exactly and duplicate delivery adds no effects',
      async () => {
        stage = 'native-nonstreaming-and-duplicate';
        const body = {
          model: live.publicModel,
          max_tokens: 32,
          thinking: { type: 'disabled' },
          messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
        };
        const idempotency = `kimi-live-json-${randomUUID()}`;
        const response = await postKimi(live, 'anthropic', body, idempotency);
        const json = await readKimiJsonResponse(live, response);
        assert.ok(
          Array.isArray(json.content) && json.content.length > 0,
          'Native Messages response must have content blocks',
        );
        assert.ok(
          isRecord(json.usage) &&
            typeof json.usage.input_tokens === 'number' &&
            typeof json.usage.output_tokens === 'number',
          'Native Messages response must expose actual usage',
        );
        const settled = await settle(response, 'anthropic', 'native-nonstreaming');
        const beforeReplay = await kimiFinancialSnapshot(live);
        const replay = await postKimi(live, 'anthropic', body, idempotency);
        const replayJson = await readKimiJsonResponse(live, replay);
        assert.equal(replay.headers.get('x-canonical-request-id'), settled.request_id);
        assert.equal(replayJson.object, 'request_status');
        assert.equal(replayJson.id, settled.request_id);
        assert.equal(replayJson.status, 'completed');
        assert.equal(replayJson.response_replayed, false);
        assert.deepEqual(
          await kimiFinancialSnapshot(live),
          beforeReplay,
          'A duplicate must not add dispatches, usage, holds, prices or wallet postings',
        );
        assert.deepEqual(await readDurableKimiRequest(live, settled.request_id), settled);
        const conflict = await postKimi(live, 'anthropic', { ...body, max_tokens: 31 }, idempotency);
        await conflict.body?.cancel();
        assert.equal(conflict.status, 409);
        assert.deepEqual(
          await kimiFinancialSnapshot(live),
          beforeReplay,
          'Conflicting duplicate content must have no financial or dispatch effects',
        );
        evidence.scenes.push({
          scene: 'duplicate-and-conflict',
          completedReplayStatus: replay.status,
          conflictStatus: conflict.status,
          unchangedFinancialSnapshot: true,
        });
      },
    );

    if (firstDispatchOnly) {
      // This explicit diagnostic scope is partial acceptance. It spends one
      // onboarding probe and one business inference; duplicate checks are local.
      evidence.passed = true;
      return;
    }

    await runScene('native SSE reaches message_stop and settles the complete streamed upstream usage', async () => {
      stage = 'native-sse';
      const response = await postKimi(
        live,
        'anthropic',
        {
          model: live.publicModel,
          max_tokens: 32,
          stream: true,
          thinking: { type: 'disabled' },
          messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
        },
        `kimi-live-sse-${randomUUID()}`,
      );
      await assertKimiHttpStatus(live, response);
      assert.ok(
        /text\/event-stream/i.test(response.headers.get('content-type') ?? ''),
        'Expected native SSE content type',
      );
      const text = await response.text();
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:') || line.length > 65_536) continue;
        try {
          captureKimiNumericUsage(live, response, JSON.parse(line.slice(5).trim()));
        } catch {
          /* No arbitrary SSE data enters evidence. */
        }
      }
      const events = [...text.matchAll(/^event:\s*(\S+)$/gm)].map((match) => match[1]);
      assert.ok(events.includes('message_start'), 'Native SSE must begin with message_start');
      assert.ok(events.includes('content_block_delta'), 'Native SSE must contain a content delta');
      assert.ok(events.includes('message_stop'), 'Native SSE must finish with message_stop');
      await settle(response, 'anthropic', stage);
    });

    for (const forced of [false, true]) {
      await runScene(
        `OpenAI ${forced ? 'forced' : 'automatic'} tool choice preserves arguments and completes both charged turns`,
        async () => {
          stage = `openai-${forced ? 'forced' : 'automatic'}-tool-two-turn`;
          const messages: JsonObject[] = [
            {
              role: 'user',
              content: OPAQUE_LOOKUP_PROMPT,
            },
          ];
          const firstBody = {
            model: live.publicModel,
            max_completion_tokens: 128,
            reasoning_effort: 'none',
            thinking: { type: 'disabled' },
            tools: [OPAQUE_LOOKUP_TOOL],
            tool_choice: forced ? { type: 'function', function: { name: OPAQUE_LOOKUP_TOOL.function.name } } : 'auto',
            messages,
          };
          const first = await postKimi(live, 'openai', firstBody, `kimi-live-tool-first-${randomUUID()}`);
          const firstJson = await readKimiJsonResponse(live, first);
          const assistant = assistantMessage(firstJson);
          assert.ok(
            Array.isArray(assistant.tool_calls) && assistant.tool_calls.length === 1,
            'Expected exactly one tool call',
          );
          const call = assistant.tool_calls[0];
          assert.ok(isRecord(call) && typeof call.id === 'string' && isRecord(call.function));
          assert.ok(typeof call.function.name === 'string');
          assert.ok(typeof call.function.arguments === 'string');
          const toolResult = executeOpaqueLookup({
            id: call.id,
            function: { name: call.function.name, arguments: call.function.arguments },
          });
          await settle(first, 'openai', `${stage}-first`);
          messages.push(assistant, { role: 'tool', tool_call_id: call.id, content: toolResult });
          const second = await postKimi(
            live,
            'openai',
            { ...firstBody, messages, tool_choice: 'none', max_completion_tokens: 32 },
            `kimi-live-tool-second-${randomUUID()}`,
          );
          const secondJson = await readKimiJsonResponse(live, second);
          const final = assistantMessage(secondJson);
          assert.ok(
            typeof final.content === 'string' && final.content.trim() === OPAQUE_LOOKUP_VALUE,
            'Tool result must reach the final assistant answer',
          );
          assert.ok(
            !Array.isArray(final.tool_calls) || final.tool_calls.length === 0,
            'Second turn must finish without another tool dispatch',
          );
          await settle(second, 'openai', `${stage}-second`);
        },
      );
    }

    await runScene(
      'cancellation after the first native SSE frame retains uncertainty and cannot charge or redispatch on replay',
      async () => {
        stage = 'native-sse-abort';
        const controller = new AbortController();
        const body = {
          model: live.publicModel,
          max_tokens: 512,
          stream: true,
          thinking: { type: 'disabled' },
          messages: [
            {
              role: 'user',
              content: 'Print the integers from 1 through 1000 in order, separated by spaces, without any explanation.',
            },
          ],
        };
        const idempotency = `kimi-live-abort-${randomUUID()}`;
        const before = await kimiFinancialSnapshot(live);
        const response = await postKimi(
          live,
          'anthropic',
          body,
          idempotency,
          AbortSignal.any([controller.signal, AbortSignal.timeout(65_000)]),
        );
        await assertKimiHttpStatus(live, response);
        const id = requestId(response);
        const reader = response.body?.getReader();
        assert.ok(reader);
        try {
          const first = await reader.read();
          assert.equal(first.done, false, 'Cancellation must observe a real upstream stream frame');
          assert.ok(first.value && first.value.byteLength > 0);
          const firstText = new TextDecoder().decode(first.value);
          assert.ok(
            !/^event:\s*message_stop$/m.test(firstText),
            'Upstream completed before cancellation; cannot claim abort acceptance',
          );
          controller.abort();
          await reader.cancel().catch(() => {});
        } finally {
          controller.abort();
          reader.releaseLock();
        }
        const unknown = await waitUntil('Cancelled Kimi request uncertainty', async () => {
          const row = await readDurableKimiRequest(live, id);
          if (!row || row.result_state === 'pending' || row.reservation_state === 'reserved' || row.held_leases !== '0')
            return undefined;
          assert.equal(row.execution_state, 'unknown');
          assert.equal(row.result_state, 'unknown');
          assert.equal(row.financial_status, 'reconciliation_pending');
          assert.equal(row.reservation_state, 'reconciliation_pending');
          assert.equal(row.usage_count, '0', 'Unobserved terminal usage cannot be guessed');
          assert.equal(row.settlement_count, '0');
          assert.equal(row.settlement_amount, null);
          assert.equal(row.ledger_amount, null);
          assert.equal(row.attempt_count, '1');
          return row;
        });
        const after = await kimiFinancialSnapshot(live);
        assert.equal(
          after.wallet,
          before.wallet,
          'An aborted request without terminal usage must never charge the wallet',
        );
        assert.equal(after.ledger_transactions, before.ledger_transactions);
        assert.equal(after.ledger_entries, before.ledger_entries);
        assert.ok(BigInt(after.hold) > 0n, 'Unknown outcome must keep its original financial hold');
        const replay = await postKimi(live, 'anthropic', body, idempotency);
        assert.equal(replay.status, 202);
        const status: unknown = await replay.json();
        assert.ok(
          isRecord(status) &&
            status.object === 'request_status' &&
            status.id === id &&
            status.status === 'unknown' &&
            status.response_replayed === false,
        );
        assert.deepEqual(
          await kimiFinancialSnapshot(live),
          after,
          'Unknown replay must not create another dispatch or financial effect',
        );
        assert.deepEqual(await readDurableKimiRequest(live, id), unknown);
        evidence.scenes.push({
          scene: stage,
          requestId: id,
          state: unknown.execution_state,
          usageEvents: unknown.usage_count,
          settlementEvents: unknown.settlement_count,
          replayStatus: replay.status,
          retainedHoldMinorUnits: after.hold,
        });
      },
    );
    evidence.passed = true;
  } catch (error) {
    evidence.passed = false;
    evidence.failedStage = stage;
    throw error;
  } finally {
    if (fixture) {
      await fixture.close();
      evidence.processesStopped = fixture.started.every(
        (child) => child.exitCode !== null || child.signalCode !== null,
      );
      evidence.cliStartup = readCliStartupDiagnostics(fixture);
      evidence.credentialOnboarding = readCredentialOnboardingDiagnostics(fixture);
      evidence.httpFailures = readKimiHttpFailureDiagnostics(fixture);
      evidence.settlements = readKimiSettlementDiagnostics(fixture);
    }
    evidence.finishedAt = new Date().toISOString();
    const directory = process.env.KIMI_COMMERCIAL_EVIDENCE_DIR;
    if (directory) {
      await mkdir(resolve(directory), { recursive: true, mode: 0o700 });
      await writeFile(
        join(resolve(directory), 'kimi-commercial-summary.json'),
        `${JSON.stringify(evidence, null, 2)}\n`,
        { mode: 0o600 },
      );
    }
    t.diagnostic(
      JSON.stringify({
        runtime: evidence.runtime,
        postgresPreparedStatements: evidence.postgresPreparedStatements,
        scope: evidence.scope,
        kms: evidence.kms,
        passed: evidence.passed,
        completedScenes: evidence.scenes.length,
        failedStage: evidence.failedStage,
        processesStopped: evidence.processesStopped,
      }),
    );
  }
});
