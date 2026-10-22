import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Dispatcher } from 'undici';
import {
  bindVerifiedKimiSupply,
  captureKimiNumericUsage,
  INITIAL_WALLET,
  KIMI_COMMERCIAL_URLS,
  kimiFinancialSnapshot,
  provisionKimiCommercialFixture,
  readDurableKimiRequest,
  waitKimiSettled,
} from '../../scripts/ops/verify-commercial-kimi.js';
import { createSaasDatabase } from '../../src/saas/db/index.js';
import { parseDeploymentConfig } from '../../src/saas/deployment.js';
import type { PlatformRequestAdmissionHoldEvidence } from '../../src/saas/gateway/admission.js';
import {
  PostgresRequestAdmissionGuard,
  PostgresRequestAdmissionGuardError,
} from '../../src/saas/gateway/postgres-request-admission-guard.js';
import { SaasPreparedEvidenceDispatchService } from '../../src/saas/gateway/prepared-evidence-dispatch-service.js';
import { ProviderHttpTransport } from '../../src/saas/gateway/provider-http-transport.js';
import type { RequestPreparationInput } from '../../src/saas/gateway/request-preparation-service.js';
import { KeyService } from '../../src/saas/keys/service.js';
import { SaasPricingService } from '../../src/saas/pricing/service.js';
import { createBuiltinProviderTargetResolver } from '../../src/saas/runtime/builtin-gateway-runtime.js';
import { createCredentialValidationWorkerUnsealingKms } from '../../src/saas/runtime/software-provider-credential-kms.js';
import { CredentialValidationWorker } from '../../src/saas/supply/credential-validation-worker.js';
import { type ManagedSaasRuntime, startManagedSaasServer } from '../../src/server/managed-saas.js';
import { normalizeUsage } from '../../src/telemetry/usage.js';
import {
  executeOpaqueLookup,
  OPAQUE_LOOKUP_PROMPT,
  OPAQUE_LOOKUP_RECORD_ID,
  OPAQUE_LOOKUP_TOOL,
} from './kimi-code-opaque-tool-fixture.js';

// Diagnostic only: synthetic credential, mocked validation HTTP and a synthetic
// inference transport. This is not real-provider or built-CLI acceptance.
const configured = Object.values(KIMI_COMMERCIAL_URLS).every((name) => Boolean(process.env[name]));
const required = process.env.MODEL_ROUTER_SAAS_GATEWAY_E2E_REQUIRED === '1';
const expectBlocked = process.env.KIMI_PREPARATION_DIAGNOSTIC_EXPECT_BLOCKED === '1';

test('synthetic Kimi builtin preparation preserves independent cache bounds through commercial admission', {
  skip: !configured && !required ? 'Disposable PostgreSQL role URLs are required' : false,
  timeout: 60_000,
}, async (t) => {
  assert.ok(configured, 'Every disposable role URL must be supplied by the owned runner');
  const syntheticCredential = `local-test-synthetic-${randomUUID()}`;
  const fixture = await provisionKimiCommercialFixture(syntheticCredential, {
    mode: 'source-diagnostic',
  });
  let runtime: ManagedSaasRuntime | undefined;
  const workerUrl = process.env[KIMI_COMMERCIAL_URLS.worker];
  assert.ok(workerUrl, 'The owned worker PostgreSQL role URL is required');
  const workerDatabase = createSaasDatabase({ connectionString: workerUrl });
  const kms = await createCredentialValidationWorkerUnsealingKms({ env: fixture.workerEnvironment });
  let mockValidationCalls = 0;
  const worker = new CredentialValidationWorker(
    workerDatabase,
    {
      decryptDataKey: async (request) => kms.decryptDataKey(request),
    },
    {
      deployment: 'kimi-commercial-local-test',
      environment: 'test',
      owners: ['platform'],
      fetch: async (url) => {
        mockValidationCalls += 1;
        assert.equal(url.hostname, 'api.kimi.com');
        return new Response(
          JSON.stringify({
            id: 'synthetic-validation-message',
            type: 'message',
            role: 'assistant',
            model: 'kimi-for-coding',
            content: [{ type: 'text', text: 'OK' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 5, output_tokens: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    },
  );
  const failures: Array<{ constructor: string; code: string; boundary: string }> = [];
  const holdBounds: Array<Record<string, string>> = [];
  let mutateHold: ((hold: PlatformRequestAdmissionHoldEvidence) => PlatformRequestAdmissionHoldEvidence) | undefined;
  const assertNoHeldLeases = async () => {
    const held = await fixture.database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM saas_provider_account_leases WHERE tenant_id=$1 AND status='held'",
      [fixture.tenantId],
    );
    assert.equal(held.rows[0]?.count, '0', 'No synthetic diagnostic boundary may leave a held provider lease');
  };
  const originalGuard = PostgresRequestAdmissionGuard.prototype.revalidate;
  PostgresRequestAdmissionGuard.prototype.revalidate = async function (input) {
    const hold = input.holdEvidence && mutateHold ? mutateHold(input.holdEvidence) : input.holdEvidence;
    if (hold)
      holdBounds.push({
        inputTotal: String(hold.inputTotal),
        inputUncached: String(hold.inputUncached),
        cacheRead: String(hold.cacheRead),
        cacheWrite: String(hold.cacheWrite),
        cacheWrite5m: String(hold.cacheWrite5m),
        cacheWrite1h: String(hold.cacheWrite1h),
        outputTotal: String(hold.outputTotal),
      });
    try {
      return await originalGuard.call(this, { ...input, holdEvidence: hold });
    } catch (error) {
      if (error instanceof PostgresRequestAdmissionGuardError)
        failures.push({
          constructor: 'PostgresRequestAdmissionGuardError',
          code: error.code,
          boundary: error.stack?.includes('validateHoldEvidence') ? 'validateHoldEvidence' : 'other-guard-boundary',
        });
      else failures.push({ constructor: 'unrecognized', code: 'unrecognized', boundary: 'other-guard-boundary' });
      throw error;
    }
  };
  try {
    assert.equal(await worker.runOnce(), 'processed');
    assert.equal(mockValidationCalls, 1, 'Only a mock validation response was consumed');
    await bindVerifiedKimiSupply(fixture);
    const deployment = parseDeploymentConfig(fixture.gatewayEnvironment);
    assert.equal(deployment.mode, 'managed-saas');
    if (deployment.mode !== 'managed-saas') throw new Error('Managed SaaS diagnostic deployment required');
    runtime = await startManagedSaasServer(deployment, {
      environment: fixture.gatewayEnvironment,
      installSignalHandlers: false,
    });
    assert.ok(runtime.gateway, 'The source builtin production composition must be assembled');
    const caller = await new KeyService(runtime.database).authenticate(fixture.customerKey);
    assert.ok(caller, 'The normal control-plane-issued customer key must authenticate');
    const preparationInput: RequestPreparationInput = {
      authenticatedCaller: caller,
      publicModel: fixture.publicModel,
      protocol: 'anthropic',
      clientRequest: {
        model: fixture.publicModel,
        max_tokens: 32,
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
      },
      idempotencyKey: randomUUID(),
      audit: { entryPoint: 'synthetic-commercial-preparation-diagnostic' },
    };
    const result = await runtime.gateway.preparation.prepare(preparationInput);
    t.diagnostic(
      JSON.stringify({
        mode: 'synthetic-source-builtin-preparation-only',
        realProviderCalls: 0,
        mockValidationCalls,
        outcome: result.outcome,
        ...(result.outcome === 'prepared' ? {} : { stage: result.stage, code: result.code }),
        failures,
        holdBounds,
      }),
    );
    const snapshot = await kimiFinancialSnapshot(fixture);
    await assertNoHeldLeases();
    assert.equal(snapshot.wallet, INITIAL_WALLET.toString());
    assert.equal(snapshot.usage, '0');
    assert.equal(snapshot.settlements, '0');
    if (expectBlocked) {
      assert.equal(result.outcome, 'blocked');
      assert.equal(result.stage, 'admission');
      assert.equal(result.code, 'storage_failure');
      assert.deepEqual(failures, [
        {
          constructor: 'PostgresRequestAdmissionGuardError',
          code: 'AUTHORITY_MISMATCH',
          boundary: 'validateHoldEvidence',
        },
      ]);
      assert.equal(snapshot.requests, '0');
      assert.equal(snapshot.attempts, '0');
      assert.equal(snapshot.hold, '0');
    } else {
      assert.equal(result.outcome, 'prepared');
      assert.deepEqual(failures, []);
      assert.equal(snapshot.requests, '1');
      assert.equal(snapshot.attempts, '1');
      assert.equal(snapshot.hold, '262240', 'Hold prices the maximum feasible input allocation once');
    }
    assert.deepEqual(holdBounds, [
      {
        inputTotal: '131072',
        inputUncached: '131072',
        cacheRead: '131072',
        cacheWrite: '131072',
        cacheWrite5m: '131072',
        cacheWrite1h: '131072',
        outputTotal: '32',
      },
    ]);
    if (expectBlocked) return;
    assert.equal(result.outcome, 'prepared');
    const gateway = runtime.gateway;
    const gatewayDatabase = runtime.database;
    type DispatchPorts = ConstructorParameters<typeof SaasPreparedEvidenceDispatchService>;
    // Reuse the actual production evidence, lease, metering and settlement
    // ports, substituting only the transport. No credential is sent anywhere.
    const ports = gateway.dispatch as unknown as {
      evidence: DispatchPorts[0];
      metering: DispatchPorts[1];
      leaseProvider: DispatchPorts[2];
      normalSuccessSettlement: DispatchPorts[4];
    };
    assert.ok(ports.normalSuccessSettlement);
    const nativeUsage = {
      input_tokens: 0,
      output_tokens: 11,
      cache_read_input_tokens: 25,
      cache_creation_input_tokens: 0,
      service_tier: 'standard',
      inference_geo: 'not_available',
    };
    captureKimiNumericUsage(fixture, new Response(null, { headers: { 'x-request-id': result.requestId } }), {
      usage: nativeUsage,
    });
    const usage = {
      ...normalizeUsage('anthropic', nativeUsage),
      source: 'upstream' as const,
    };
    let mockInferenceCalls = 0;
    const syntheticDispatch = new SaasPreparedEvidenceDispatchService(
      ports.evidence,
      ports.metering,
      ports.leaseProvider,
      {
        async send() {
          mockInferenceCalls += 1;
          return { responseStarted: true, resultHttpStatus: 200, providerUsage: usage };
        },
      },
      ports.normalSuccessSettlement,
    );
    await t.test(
      'real PostgreSQL settlement charges synthetic actual usage once and releases the conservative hold',
      async () => {
        const dispatched = await syntheticDispatch.dispatch({
          evidenceId: result.evidence.evidenceId,
          payloadBytes: result.payloadBytes,
          normalSuccessSnapshot: result.normalSuccessSnapshot,
          audit: {
            actorUserId: caller.authorization.principalId,
            entryPoint: 'synthetic-commercial-settlement-diagnostic',
            requestId: result.requestId,
          },
        });
        assert.equal(dispatched.kind, 'sent');
        assert.equal(mockInferenceCalls, 1);
        const settled = await waitKimiSettled(fixture, result.requestId, 'anthropic');
        assert.equal(settled.input_total, '25');
        assert.equal(settled.output_total, '11');
        assert.equal(settled.settlement_amount, '83');
        const after = await kimiFinancialSnapshot(fixture);
        assert.equal(after.wallet, (INITIAL_WALLET - 83n).toString());
        assert.equal(after.hold, '0');
        assert.equal(after.usage, '1');
        assert.equal(after.settlements, '1');
        await assertNoHeldLeases();
        const duplicate = await ports.normalSuccessSettlement?.complete({
          tenantId: fixture.tenantId,
          requestId: result.requestId,
          attemptId: result.attemptId,
          snapshot: result.normalSuccessSnapshot,
          usage,
        });
        assert.equal(duplicate?.kind, 'replayed');
        assert.deepEqual(
          await kimiFinancialSnapshot(fixture),
          after,
          'Duplicate settlement cannot charge or write usage again',
        );
        t.diagnostic(
          JSON.stringify({
            mode: 'synthetic-transport-real-postgres-settlement',
            realProviderCalls: 0,
            mockInferenceCalls,
            heldAmount: '262240',
            chargedAmount: '83',
            duplicate: duplicate?.kind,
          }),
        );
      },
    );
    const malformed = (hold: PlatformRequestAdmissionHoldEvidence, changes: Record<string, unknown>) =>
      ({ ...hold, ...changes }) as unknown as PlatformRequestAdmissionHoldEvidence;
    const negatives: Array<{
      name: string;
      change: (hold: PlatformRequestAdmissionHoldEvidence) => PlatformRequestAdmissionHoldEvidence;
    }> = [
      { name: 'cache bound above input total', change: (hold) => malformed(hold, { cacheRead: 131073 }) },
      { name: 'reasoning bound above output total', change: (hold) => malformed(hold, { reasoningOutput: 33 }) },
      { name: 'negative input bucket bound', change: (hold) => malformed(hold, { cacheWrite1h: -1 }) },
      { name: 'unknown evidence tag', change: (hold) => malformed(hold, { evidenceKind: 'unrecognized-bound-kind' }) },
      { name: 'present undefined evidence tag', change: (hold) => malformed(hold, { evidenceKind: undefined }) },
      {
        name: 'legacy untagged overlapping allocation',
        change: (hold) => {
          const copy = { ...hold } as Record<string, unknown>;
          delete copy.evidenceKind;
          return copy as unknown as PlatformRequestAdmissionHoldEvidence;
        },
      },
      {
        name: 'inherited evidence tag',
        change: (hold) => {
          const copy = { ...hold } as Record<string, unknown>;
          const kind = copy.evidenceKind;
          delete copy.evidenceKind;
          return Object.assign(Object.create({ evidenceKind: kind }), copy) as PlatformRequestAdmissionHoldEvidence;
        },
      },
    ];
    for (const negative of negatives) {
      await t.test(`invalid trusted evidence rejects without financial effects: ${negative.name}`, async () => {
        const before = await kimiFinancialSnapshot(fixture);
        mutateHold = negative.change;
        try {
          const rejected = await gateway.preparation.prepare({ ...preparationInput, idempotencyKey: randomUUID() });
          assert.equal(rejected.outcome, 'blocked');
          assert.equal(rejected.stage, 'admission');
          assert.equal(rejected.code, 'storage_failure');
          assert.deepEqual(await kimiFinancialSnapshot(fixture), before);
          assert.equal(mockInferenceCalls, 1, 'Invalid bounds must never dispatch');
          await assertNoHeldLeases();
        } finally {
          mutateHold = undefined;
        }
      });
    }
    await t.test(
      'OpenAI tool response uses the native observer and real PostgreSQL settlement',
      async (crossProtocolTest) => {
        const before = await kimiFinancialSnapshot(fixture);
        const prepared = await gateway.preparation.prepare({
          ...preparationInput,
          protocol: 'openai',
          clientRequest: {
            model: fixture.publicModel,
            max_completion_tokens: 128,
            reasoning_effort: 'none',
            messages: [{ role: 'user', content: OPAQUE_LOOKUP_PROMPT }],
            tools: [OPAQUE_LOOKUP_TOOL],
            tool_choice: 'auto',
          },
          idempotencyKey: randomUUID(),
        });
        assert.equal(prepared.outcome, 'prepared');
        assert.equal(prepared.normalSuccessSnapshot.providerProtocol, 'anthropic');
        assert.equal(prepared.normalSuccessSnapshot.customerProtocol, 'openai');
        assert.ok(prepared.normalSuccessSnapshot.customerPriceVersion);
        const customerPrice = await new SaasPricingService(gatewayDatabase).getCustomerPriceVersion(
          prepared.normalSuccessSnapshot.customerPriceVersion,
        );
        assert.equal(customerPrice.protocol, 'openai');
        const rawNativeUsage = {
          input_tokens: 0,
          output_tokens: 62,
          cache_read_input_tokens: 186,
          cache_creation_input_tokens: 0,
          service_tier: 'standard',
          inference_geo: 'not_available',
        };
        const nativeResponse = {
          id: 'synthetic-native-tool-message',
          type: 'message',
          role: 'assistant',
          model: 'kimi-for-coding',
          content: [
            {
              type: 'tool_use',
              id: 'synthetic-native-tool-call',
              name: OPAQUE_LOOKUP_TOOL.function.name,
              input: { record_id: OPAQUE_LOOKUP_RECORD_ID },
            },
          ],
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: rawNativeUsage,
        };
        const fixedTargets = createBuiltinProviderTargetResolver([{ bundle: 'kimi', enabled: true }]);
        let httpMockCalls = 0;
        let socketCalls = 0;
        let credentialCallbacks = 0;
        const noNetworkDispatcher = {
          dispatch() {
            socketCalls += 1;
            throw new Error('Synthetic diagnostic must never open a network socket');
          },
        } as unknown as Dispatcher;
        const transport = new ProviderHttpTransport({
          endpointPolicy: fixedTargets.endpointPolicy,
          timeoutMs: 10_000,
          resolveAddresses: async () => [{ address: '8.8.8.8', family: 4 }],
          createConnector: () => ({
            dispatcher: noNetworkDispatcher,
            close: async () => {},
            destroy: async () => {},
          }),
          resolveDispatchProfile: async (input) => {
            assert.equal(input.protocol, 'openai');
            assert.equal(input.providerProtocol, 'anthropic');
            assert.equal(input.providerOperation, 'messages');
            assert.equal(input.endpoint, 'messages');
            const target = fixedTargets.resolver.resolve({
              upstreamId: input.upstreamId,
              productId: 'kimi-code',
              protocol: input.providerProtocol,
              operation: input.providerOperation,
            });
            return { url: target.url ?? target.targetUrl };
          },
          resolveCredential: async (input, useCredential) => {
            credentialCallbacks += 1;
            assert.equal(input.accountId, fixture.accountId);
            assert.equal(input.credentialId, fixture.credentialId);
            assert.equal(input.providerId, 'kimi');
            assert.equal(input.productId, 'kimi-code');
            return useCredential({ headerName: 'x-api-key', value: syntheticCredential });
          },
          fetch: async (url, init) => {
            httpMockCalls += 1;
            assert.equal(url, 'https://api.kimi.com/coding/v1/messages');
            assert.equal(init.dispatcher, noNetworkDispatcher);
            return new Response(JSON.stringify(nativeResponse), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          },
        });
        const settlement = ports.normalSuccessSettlement;
        assert.ok(settlement);
        const settlementFailures: Array<{ constructor: string; signature: string }> = [];
        const observedUsage: Array<Record<string, number | string | null>> = [];
        let observedCompletion: Parameters<NonNullable<DispatchPorts[4]>['complete']>[0] | undefined;
        const projectSettlementFailure = (error: unknown) => ({
          constructor: error instanceof Error && error.constructor === Error ? 'Error' : 'unrecognized',
          signature:
            error instanceof Error && error.message === 'selected customer price does not match the prepared quote'
              ? 'customer-price-prepared-quote-mismatch'
              : 'unrecognized',
        });
        const observedSettlement: NonNullable<DispatchPorts[4]> = {
          async complete(input) {
            observedCompletion = input;
            observedUsage.push({
              inputTotal: input.usage.inputTotal,
              inputUncached: input.usage.inputUncached,
              cacheRead: input.usage.cacheRead,
              cacheWrite: input.usage.cacheWrite,
              outputTotal: input.usage.outputTotal,
              source: input.usage.source,
            });
            try {
              return await settlement.complete(input);
            } catch (error) {
              // Project only the one fixed source signature under investigation.
              // Never persist arbitrary exception messages, stacks or provider data.
              settlementFailures.push(projectSettlementFailure(error));
              throw error;
            }
          },
          retainUnknown: (input) => settlement.retainUnknown(input),
        };
        const dispatch = new SaasPreparedEvidenceDispatchService(
          ports.evidence,
          ports.metering,
          ports.leaseProvider,
          transport,
          observedSettlement,
        );
        const clientChunks: Uint8Array[] = [];
        const dispatched = await dispatch.dispatch({
          evidenceId: prepared.evidence.evidenceId,
          payloadBytes: prepared.payloadBytes,
          normalSuccessSnapshot: prepared.normalSuccessSnapshot,
          audit: {
            actorUserId: caller.authorization.principalId,
            entryPoint: 'synthetic-openai-native-observer-settlement',
            requestId: prepared.requestId,
          },
          client: {
            signal: new AbortController().signal,
            start(status) {
              assert.equal(status, 200);
            },
            write(chunk) {
              clientChunks.push(Uint8Array.from(chunk));
            },
            end() {},
            abort() {},
          },
        });
        const durable = await readDurableKimiRequest(fixture, prepared.requestId);
        t.diagnostic(
          JSON.stringify({
            mode: 'synthetic-http-native-observer-real-postgres-cross-protocol',
            realProviderCalls: 0,
            externalSocketCalls: socketCalls,
            httpMockCalls,
            credentialCallbacks,
            customerProtocol: customerPrice.protocol,
            providerProtocol: prepared.normalSuccessSnapshot.providerProtocol,
            settlementFailures,
            observedUsage,
            outcome: dispatched.kind,
            unknownReason: durable?.unknown_reason,
            usageCount: durable?.usage_count,
            settlementCount: durable?.settlement_count,
          }),
        );
        assert.equal(httpMockCalls, 1);
        assert.equal(credentialCallbacks, 1);
        assert.equal(socketCalls, 0);
        assert.deepEqual(observedUsage, [
          {
            inputTotal: 186,
            inputUncached: 0,
            cacheRead: 186,
            cacheWrite: 0,
            outputTotal: 62,
            source: 'upstream',
          },
        ]);
        const bridged = JSON.parse(Buffer.concat(clientChunks).toString('utf8'));
        const toolCall = bridged.choices?.[0]?.message?.tool_calls?.[0];
        assert.ok(toolCall, 'The actual native response bridge must return a canonical OpenAI tool call');
        executeOpaqueLookup(toolCall);
        await assertNoHeldLeases();
        assert.equal(dispatched.kind, 'sent');
        assert.deepEqual(settlementFailures, []);
        const settled = await waitKimiSettled(fixture, prepared.requestId, 'openai');
        assert.equal(settled.input_total, '186');
        assert.equal(settled.output_total, '62');
        assert.equal(settled.settlement_amount, '558');
        const after = await kimiFinancialSnapshot(fixture);
        assert.equal(after.wallet, (BigInt(before.wallet) - 558n).toString());
        assert.equal(after.hold, '0');
        await crossProtocolTest.test(
          'an explicit wrong customer protocol rejects before financial writes',
          async () => {
            assert.ok(observedCompletion, 'Use only the actual native observer completion input');
            const completion = observedCompletion;
            const beforeWrongProtocol = await kimiFinancialSnapshot(fixture);
            let wrongProtocolFailure: ReturnType<typeof projectSettlementFailure> | undefined;
            try {
              await settlement.complete({
                ...completion,
                snapshot: { ...completion.snapshot, customerProtocol: 'anthropic' },
              });
            } catch (error) {
              wrongProtocolFailure = projectSettlementFailure(error);
            }
            assert.deepEqual(wrongProtocolFailure, {
              constructor: 'Error',
              signature: 'customer-price-prepared-quote-mismatch',
            });
            assert.deepEqual(await kimiFinancialSnapshot(fixture), beforeWrongProtocol);
            await assertNoHeldLeases();
          },
        );
      },
    );
  } finally {
    PostgresRequestAdmissionGuard.prototype.revalidate = originalGuard;
    await runtime?.close();
    await worker.close();
    await kms.close();
    await workerDatabase.close();
    await fixture.close();
  }
});
