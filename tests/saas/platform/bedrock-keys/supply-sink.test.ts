import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBedrockCredentialMaterial } from '../../../../src/saas/gateway/bedrock/transport.js';
import {
  BedrockCredentialSinkError,
  buildBedrockSealedEnvelope,
  createPostgresBedrockCatalogBindingResolver,
  createProviderSupplyBedrockCredentialSink,
  parseBedrockCredentialImport,
} from '../../../../src/saas/platform/bedrock-keys/supply-sink.js';

const AUDIT_USER = 'user-1';

function sinkHarness(options: { bindingOk?: boolean } = {}) {
  const writes: Array<{ account: Record<string, unknown>; credential: Record<string, unknown> }> = [];
  const sink = createProviderSupplyBedrockCredentialSink({
    supply: {
      async createPlatformProviderAccount(input) {
        writes.push({ account: input as unknown as Record<string, unknown>, credential: {} });
        return {
          id: 'account-uuid-1',
          displayName: input.displayName,
          providerId: input.providerId,
          productId: input.productId,
          status: 'active',
          validationState: 'pending',
          createdAt: '2026-10-17T00:00:00Z',
          updatedAt: '2026-10-17T00:00:00Z',
        } as never;
      },
      async createPlatformProviderCredential(input) {
        writes[writes.length - 1].credential = input as unknown as Record<string, unknown>;
        return { credentialId: 'cred-1', version: 1 } as never;
      },
    },
    resolveCatalogBinding:
      options.bindingOk === false
        ? async () => {
            throw new BedrockCredentialSinkError('CATALOG_BINDING_MISSING');
          }
        : async () => ({
            rightsId: 'bedrock-claude-platform-aws-sigv4-v1',
            rightsVersion: 1,
            capabilities: [{ model: 'us.anthropic.claude-sonnet-4-5-v1:0', endpoint: 'bedrock-invoke', version: 1 }],
          }),
  });
  return { sink, writes };
}

test('operator imports parse into the SigV4 or bearer envelope shapes', () => {
  assert.deepEqual(
    parseBedrockCredentialImport(
      JSON.stringify({
        aws_access_key_id: 'AKIAIOSFODNN7EXAMPLE',
        aws_secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        aws_region: 'us-west-2',
      }),
    ),
    {
      kind: 'aws-sigv4',
      awsAccessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      awsSecretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      awsSessionToken: null,
      awsRegion: 'us-west-2',
      forceGlobal: false,
      label: null,
    },
  );
  assert.deepEqual(
    parseBedrockCredentialImport(
      JSON.stringify({
        awsAccessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        awsSecretAccessKey: 'x'.repeat(40),
        awsSessionToken: 'tok',
        awsRegion: 'eu-central-1',
        awsForceGlobal: true,
        label: 'eu pool',
      }),
    ),
    {
      kind: 'aws-sigv4',
      awsAccessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      awsSecretAccessKey: 'x'.repeat(40),
      awsSessionToken: 'tok',
      awsRegion: 'eu-central-1',
      forceGlobal: true,
      label: 'eu pool',
    },
  );
  assert.deepEqual(
    parseBedrockCredentialImport(JSON.stringify({ api_key: 'bedrock-bearer-key-000000', aws_region: 'us-east-1' })),
    { kind: 'api-key', apiKey: 'bedrock-bearer-key-000000', awsRegion: 'us-east-1', label: null },
  );
});

test('invalid imports fail closed (region shape, key lengths, unknown shapes)', () => {
  assert.equal(parseBedrockCredentialImport('not json'), null);
  assert.equal(parseBedrockCredentialImport('{}'), null);
  assert.equal(
    parseBedrockCredentialImport(
      JSON.stringify({
        aws_access_key_id: 'AKIAIOSFODNN7EXAMPLE',
        aws_secret_access_key: 'short',
        aws_region: 'us-west-2',
      }),
    ),
    null,
  );
  assert.equal(
    parseBedrockCredentialImport(
      JSON.stringify({
        aws_access_key_id: 'AKIAIOSFODNN7EXAMPLE',
        aws_secret_access_key: 'x'.repeat(40),
        aws_region: 'not-a-region',
      }),
    ),
    null,
  );
  // Missing region falls back to the default, not null.
  const defaulted = parseBedrockCredentialImport(
    JSON.stringify({ aws_access_key_id: 'AKIAIOSFODNN7EXAMPLE', aws_secret_access_key: 'x'.repeat(40) }),
  );
  assert.equal(defaulted?.kind, 'aws-sigv4');
  if (defaulted?.kind === 'aws-sigv4') assert.equal(defaulted.awsRegion, 'us-east-1');
});

test('the sealed envelope plaintext is the gateway transport contract shape', () => {
  const sigv4 = buildBedrockSealedEnvelope({
    kind: 'aws-sigv4',
    awsAccessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    awsSecretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    awsSessionToken: 'tok',
    awsRegion: 'us-west-2',
    forceGlobal: true,
    label: null,
  });
  const material = JSON.parse(Buffer.from(sigv4.secret).toString('utf8'));
  assert.deepEqual(material, {
    aws_access_key_id: 'AKIAIOSFODNN7EXAMPLE',
    aws_secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    aws_region: 'us-west-2',
    aws_session_token: 'tok',
    aws_force_global: 'true',
  });
  assert.equal(sigv4.expiresAt, null);
  // The transport's parser round-trips it.
  assert.deepEqual(parseBedrockCredentialMaterial(material), {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    sessionToken: 'tok',
    region: 'us-west-2',
    forceGlobal: true,
  });

  const bearer = buildBedrockSealedEnvelope({
    kind: 'api-key',
    apiKey: 'bedrock-bearer-key',
    awsRegion: 'us-east-1',
    label: null,
  });
  assert.deepEqual(JSON.parse(Buffer.from(bearer.secret).toString('utf8')), {
    api_key: 'bedrock-bearer-key',
    aws_region: 'us-east-1',
  });
  assert.deepEqual(parseBedrockCredentialMaterial(JSON.parse(Buffer.from(bearer.secret).toString('utf8'))), {
    apiKey: 'bedrock-bearer-key',
    region: 'us-east-1',
    forceGlobal: false,
  });
});

test('the sink creates the platform account and sealed credential through the supply service', async () => {
  const { sink, writes } = sinkHarness();
  const outcome = await sink.accept({
    envelope: {
      kind: 'aws-sigv4',
      awsAccessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      awsSecretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      awsSessionToken: null,
      awsRegion: 'us-west-2',
      forceGlobal: false,
      label: 'west pool',
    },
    actorUserId: AUDIT_USER,
    source: 'operator-import',
    sourceIp: null,
    userAgent: null,
  });
  assert.equal(outcome.accountRef, 'account-uuid-1');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].account.displayName, 'Bedrock west pool');
  assert.equal(writes[0].account.providerId, 'aws-bedrock');
  assert.equal(writes[0].account.credentialType, 'aws-sigv4');
  assert.equal(writes[0].account.rightsId, 'bedrock-claude-platform-aws-sigv4-v1');
  // The credential secret never carries the raw key inside the audit
  // surface: it is the sealed envelope bytes (the KMS wrap happens in the
  // supply service).
  const secretText = Buffer.from(writes[0].credential.secret as Uint8Array).toString('utf8');
  assert.ok(secretText.includes('aws_secret_access_key'));
  assert.equal(writes[0].credential.expiresAt, undefined);
});

test('the sink fails closed when the catalog binding is missing', async () => {
  const { sink } = sinkHarness({ bindingOk: false });
  await assert.rejects(
    () =>
      sink.accept({
        envelope: {
          kind: 'aws-sigv4',
          awsAccessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          awsSecretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          awsSessionToken: null,
          awsRegion: 'us-west-2',
          forceGlobal: false,
          label: null,
        },
        actorUserId: AUDIT_USER,
        source: 'operator-import',
        sourceIp: null,
        userAgent: null,
      }),
    (error: unknown) => {
      assert.ok(error instanceof BedrockCredentialSinkError);
      assert.equal(error.code, 'CATALOG_BINDING_MISSING');
      return true;
    },
  );
});

test('the Postgres binding resolver requires exactly one active rights row plus capabilities', async () => {
  const queries: string[] = [];
  const resolver = createPostgresBedrockCatalogBindingResolver({
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes('saas_provider_rights')) {
        return { rows: [{ rights_id: 'r1', version: 3 }], rowCount: 1 } as never;
      }
      return { rows: [{ model: 'm', endpoint: 'bedrock-invoke', version: 2 }], rowCount: 1 } as never;
    },
  });
  const binding = await resolver();
  assert.equal(binding.rightsId, 'r1');
  assert.equal(binding.rightsVersion, 3);
  assert.deepEqual(binding.capabilities, [{ model: 'm', endpoint: 'bedrock-invoke', version: 2 }]);
  assert.equal(queries.length, 2);

  const missing = createPostgresBedrockCatalogBindingResolver({
    query: async (sql: string) => {
      if (sql.includes('saas_provider_rights')) return { rows: [], rowCount: 0 } as never;
      return { rows: [], rowCount: 0 } as never;
    },
  });
  await assert.rejects(
    () => missing(),
    (error: unknown) => {
      assert.ok(error instanceof BedrockCredentialSinkError);
      assert.equal(error.code, 'CATALOG_BINDING_MISSING');
      return true;
    },
  );
});
