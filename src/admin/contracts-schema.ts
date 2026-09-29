import { z } from 'zod';
import { configV2Schema, routeSchema, upstreamSchema } from '../config/v2-schema.js';

const id = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const revision = z.number().int().positive();
// Config responses mask inline values as an empty string. Accept that safe
// placeholder at the HTTP boundary; ControlService restores the existing value
// by stable upstream/credential ID before full runtime schema validation.
const adminSecretSource = z.discriminatedUnion('type', [
  z.object({ type: z.literal('env'), name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/) }).strict(),
  z.object({ type: z.literal('inline'), value: z.string() }).strict(),
  z.object({ type: z.literal('secret'), id }).strict(),
]);
const adminAuthSchema = upstreamSchema.shape.auth.safeExtend({ clientSecret: adminSecretSource.optional() });
const adminCredentialSchema = upstreamSchema.shape.credentials.element.safeExtend({ secret: adminSecretSource });
const adminUpstreamSchema = upstreamSchema.safeExtend({
  auth: adminAuthSchema,
  credentials: z.array(adminCredentialSchema),
});
const adminConfigSchema = configV2Schema.safeExtend({ upstreams: z.array(adminUpstreamSchema) });
const configPayload = z.union([adminConfigSchema, z.object({ config: adminConfigSchema }).strict()]);
const secretSource = z.discriminatedUnion('type', [
  z.object({ type: z.literal('env'), name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/) }).strict(),
  z.object({ type: z.literal('secret'), id }).strict(),
]);
const rate = z.union([z.number().finite().nonnegative(), z.string()]).refine(
  (value) => /^\d+(?:\.\d{1,6})?$/.test(String(value)) && Number(value) <= 1_000_000_000,
);
const pricing = z.object({
  id: id,
  model: z.string().trim().min(1).max(200),
  currency: z.string().regex(/^[A-Z]{3}$/),
  inputPerMillion: rate,
  outputPerMillion: rate,
  cacheReadPerMillion: rate.optional(),
  cacheWritePerMillion: rate.optional(),
  cacheWrite5mPerMillion: rate.optional(),
  cacheWrite1hPerMillion: rate.optional(),
  cacheWriteIncludedInInput: z.boolean().optional(),
  effectiveFrom: z.iso.datetime({ offset: true }).optional(),
  upstreamId: id.optional(),
  provider: z.string().trim().min(1).max(128).optional(),
}).strict();

export const adminRequestSchemas = {
  bootstrap: z.object({ token: z.string().min(1), name: z.string().trim().min(1), password: z.string().min(12) }).strict(),
  session: z.object({ name: z.string().trim().min(1), password: z.string().min(1) }).strict(),
  configWrite: configPayload,
  configValidate: configPayload,
  configImportPreview: z.object({ config: adminConfigSchema, mode: z.enum(['replace', 'merge']).optional() }).strict(),
  configImport: z.object({ config: adminConfigSchema, mode: z.enum(['replace', 'merge']).optional() }).strict(),
  configRollback: z.object({ revision }),
  upstreamCreate: upstreamSchema,
  upstreamPatch: z.object({ name: upstreamSchema.shape.name.optional(), provider: upstreamSchema.shape.provider.optional(), presetId: upstreamSchema.shape.presetId.optional(), protocol: upstreamSchema.shape.protocol.optional(), enabled: z.boolean().optional(), baseUrl: upstreamSchema.shape.baseUrl.optional(), endpoints: upstreamSchema.shape.endpoints.optional(), auth: upstreamSchema.shape.auth.optional(), credentials: upstreamSchema.shape.credentials.optional(), accountGroupId: upstreamSchema.shape.accountGroupId.optional(), models: upstreamSchema.shape.models.optional(), priority: z.number().int().optional(), sortIndex: z.number().int().optional(), policy: upstreamSchema.shape.policy.optional() }).strict().refine((value) => Object.keys(value).length > 0),
  credentialCreate: z.object({
    id: id.optional(), label: z.string().trim().min(1).max(200).optional(), enabled: z.boolean().optional(),
    secret: secretSource.optional(), value: z.string().min(1).optional(),
  }).strict().refine((value) => value.secret !== undefined || value.value !== undefined),
  credentialPatch: z.object({ label: z.string().trim().min(1).max(200).optional(), enabled: z.boolean().optional(), secret: secretSource.optional(), value: z.string().min(1).optional() }).strict().refine((value) => Object.keys(value).length > 0),
  upstreamTest: z.object({ model: z.string().min(1).optional() }).strict(),
  emptyAction: z.object({}).strict(),
  routeCreate: routeSchema,
  routePatch: routeSchema.partial().strict().refine((value) => Object.keys(value).length > 0),
  routeOrder: z.object({ ids: z.array(id) }).strict(),
  routePreview: z.object({ model: z.string().trim().min(1), protocol: z.enum(['openai','anthropic','responses']), proxyKeyId: z.string().optional() }).strict(),
  keyCreate: z.object({
    id: id.optional(), name: z.string().trim().min(1).max(200), description: z.string().max(2000).optional(),
    enabled: z.boolean().optional(), allowedUpstreamIds: z.array(id).optional(), allowedModels: z.array(z.string().min(1)).optional(),
    rpm: z.number().int().nonnegative().optional(), dailyTokens: z.number().int().nonnegative().optional(),
    maxConcurrentRequests: z.number().int().nonnegative().optional(), expiresAt: z.iso.datetime({ offset: true }).optional(),
  }).strict(),
  keyPatch: z.object({ name: z.string().trim().min(1).max(200).optional(), description: z.string().max(2000).optional(), enabled: z.boolean().optional(),
    allowedUpstreamIds: z.array(id).optional(), allowedModels: z.array(z.string().min(1)).optional(), rpm: z.number().int().nonnegative().optional(),
    dailyTokens: z.number().int().nonnegative().optional(), maxConcurrentRequests: z.number().int().nonnegative().optional(), expiresAt: z.iso.datetime({ offset: true }).optional(),
  }).strict().refine((value) => Object.keys(value).length > 0),
  quotaAdjustment: z.object({ periodId: z.string().min(1).optional(), deltaTokens: z.number().int().optional(), amount: z.number().int().optional(), period: z.string().optional(), reason: z.string().max(1000).optional(), idempotencyKey: z.string().min(1).max(200).optional() }).strict().refine((value) => value.deltaTokens !== undefined || value.amount !== undefined),
  exportCreate: z.object({ type: z.enum(['usage', 'requests']), format: z.enum(['csv', 'json']).optional(), filters: z.object({ from: z.string().optional(), to: z.string().optional(), source: z.enum(['proxy','production','playground','health','all']).optional(), keyId: z.string().optional(), upstreamId: z.string().optional(), model: z.string().optional(), protocol: z.string().optional() }).optional() }).strict(),
  playgroundRun: z.object({ model: z.string().trim().min(1), protocol: z.enum(['openai','anthropic','responses']), messages: z.array(z.unknown()).optional(), input: z.unknown().optional(), stream: z.boolean().optional(), proxyKeyId: z.string().optional(), maxTokens: z.number().int().positive().optional() }).passthrough(),
  accountClientCredentials: z.object({ provider: z.string().min(1), name: z.string().min(1).optional(), clientId: z.string().optional(), clientSecret: z.string().optional(), tokenUrl: z.url().optional(), scopes: z.array(z.string()).optional() }).passthrough(),
  deviceFlowCreate: z.object({ provider: z.string().min(1), clientId: z.string().optional(), scopes: z.array(z.string()).optional() }).passthrough(),
  accountPatch: z.object({ name: z.string().min(1).optional(), enabled: z.boolean().optional(), priority: z.number().int().optional(), metadata: z.record(z.string(), z.unknown()).optional() }).passthrough().refine((value) => Object.keys(value).length > 0),
  pricingCreate: pricing,
  pricingPatch: pricing.omit({ id: true }).partial().strict().refine((value) => Object.keys(value).length > 0),
  maintenanceJob: z.discriminatedUnion('type', [
    z.object({ type: z.enum(['integrity-check', 'vacuum-control', 'backup', 'purge', 'purge-logs', 'aggregate']) }).strict(),
    z.object({ type: z.literal('restore'), backupId: z.string().regex(/^bak_[0-9a-f-]{36}$/), expectedRevision: revision }).strict(),
  ]),
} as const;

export type AdminRequestSchemaKey = keyof typeof adminRequestSchemas;
