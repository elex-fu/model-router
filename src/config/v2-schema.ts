import { isIP } from 'node:net';
import { z } from 'zod';

const id = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const label = z.string().trim().min(1).max(200);
const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().nonnegative();
const secretSource = z.discriminatedUnion('type', [
  z.object({ type: z.literal('env'), name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/) }).strict(),
  z.object({ type: z.literal('inline'), value: z.string().min(1) }).strict(),
  z.object({ type: z.literal('secret'), id }).strict(),
]);

const capabilityState = z.enum(['supported', 'unsupported', 'unknown']);
const modelCapabilities = z
  .object({
    text: capabilityState,
    imageInput: capabilityState,
    tools: capabilityState,
    parallelTools: capabilityState,
    structuredOutput: capabilityState,
    thinking: capabilityState,
    streamUsage: capabilityState,
    maxInputTokens: positiveInt,
    maxOutputTokens: positiveInt,
  })
  .partial()
  .strict();
const protocol = z.enum(['openai', 'anthropic', 'responses', 'gemini']);
const stableProtocol = z.enum(['openai', 'anthropic', 'responses']);

const unsafeAuthHeaders = new Set([
  'accept',
  'accept-encoding',
  'authorization',
  'connection',
  'content-encoding',
  'content-length',
  'content-type',
  'cookie',
  'forwarded',
  'host',
  'keep-alive',
  'origin',
  'proxy-authenticate',
  'proxy-authorization',
  'referer',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'x-real-ip',
  'x-request-id',
]);

const upstreamAuthSchema = z
  .object({
    mode: z.enum(['bearer', 'x-api-key', 'custom-header', 'google', 'none', 'pass-through', 'oauth']),
    headerName: z.string().optional(),
    tokenUrl: z.url().optional(),
    clientId: z.string().optional(),
    clientSecret: secretSource.optional(),
    scope: z.string().optional(),
  })
  .strict()
  .superRefine((auth, ctx) => {
    if (auth.mode !== 'custom-header') return;
    const name = auth.headerName;
    if (!name || !/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(name)) {
      ctx.addIssue({
        code: 'custom',
        path: ['headerName'],
        message: 'Custom auth header must be 1–64 ASCII letters, digits or hyphens and start with a letter',
      });
      return;
    }
    const lower = name.toLowerCase();
    if (
      unsafeAuthHeaders.has(lower) ||
      lower.startsWith('proxy-') ||
      lower.startsWith('sec-') ||
      lower.startsWith('x-forwarded-') ||
      lower.startsWith('x-model-router-') ||
      lower.startsWith('x-proxy-')
    ) {
      ctx.addIssue({ code: 'custom', path: ['headerName'], message: 'Reserved or unsafe auth header name' });
    }
  });

export const proxyKeySchema = z
  .object({
    id,
    name: label,
    description: z.string().max(2000).optional(),
    enabled: z.boolean(),
    createdAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
    keyHash: z.string().regex(/^[a-f0-9]{64}$/),
    keyPrefix: z.string().min(1).max(32),
    allowedUpstreamIds: z.array(id).optional(),
    allowedModels: z.array(z.string().min(1)).optional(),
    rpm: nonNegativeInt.optional(),
    dailyTokens: nonNegativeInt.optional(),
    maxConcurrentRequests: nonNegativeInt.optional(),
  })
  .strict();

export const upstreamSchema = z
  .object({
    id,
    name: label,
    provider: z.enum(['kimi', 'deepseek', 'custom']),
    presetId: z.string().optional(),
    protocol,
    enabled: z.boolean(),
    baseUrl: z.url(),
    endpoints: z
      .object({ generate: z.string().min(1), models: z.string().optional(), compact: z.string().optional() })
      .strict(),
    auth: upstreamAuthSchema,
    credentials: z.array(z.object({ id, label, enabled: z.boolean(), secret: secretSource }).strict()),
    accountGroupId: id.optional(),
    models: z.array(
      z
        .object({
          id: z.string().min(1),
          enabled: z.boolean(),
          capabilities: modelCapabilities,
          capabilitiesSource: z.enum(['preset', 'manual', 'verified']),
          verifiedAt: z.iso.datetime({ offset: true }).optional(),
        })
        .strict(),
    ),
    priority: z.number().int(),
    sortIndex: z.number().int(),
    policy: z
      .object({
        /** Permit HTTP only for loopback or literal private-network addresses. */
        allowInsecureHttp: z.boolean().optional(),
        thinking: z.enum(['preserve', 'strip', 'force']).optional(),
        healthMode: z.enum(['passive', 'active', 'off']).optional(),
        requestStreamUsage: z.boolean().optional(),
        autoCacheControl: z.boolean().optional(),
        anthropicBetas: z.array(z.string()).optional(),
        anthropicVersion: z.string().optional(),
        inputIncludesCache: z.boolean().optional(),
      })
      .passthrough(),
  })
  .strict();

export const routeSchema = z
  .object({
    id,
    name: label,
    enabled: z.boolean(),
    clientProtocols: z.array(stableProtocol).min(1),
    match: z.object({ kind: z.enum(['exact', 'glob']), value: z.string().min(1) }).strict(),
    order: z.number().int(),
    publishedModels: z.array(z.string().min(1)),
    targets: z.array(z.object({ upstreamId: id, model: z.string().min(1) }).strict()).min(1),
  })
  .strict();

export const configV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    revision: positiveInt,
    instanceId: id,
    server: z
      .object({
        port: positiveInt.max(65535),
        bindAddress: z.string().min(1),
        publicProxyBaseUrl: z.url(),
        maxBodyBytes: positiveInt,
        maxAttempts: positiveInt,
        connectTimeoutMs: positiveInt,
        firstByteTimeoutMs: positiveInt,
        streamIdleTimeoutMs: positiveInt,
        totalRequestTimeoutMs: positiveInt,
        trustedProxyCidrs: z.array(
          z.string().refine((cidr) => {
            const slash = cidr.lastIndexOf('/');
            const address = slash < 0 ? cidr : cidr.slice(0, slash);
            const family = isIP(address);
            if (!family) return false;
            if (slash < 0) return true;
            const prefix = Number(cidr.slice(slash + 1));
            return Number.isInteger(prefix) && prefix >= 0 && prefix <= (family === 4 ? 32 : 128);
          }, 'Expected an IP address or CIDR'),
        ),
      })
      .strict(),
    admin: z
      .object({
        enabled: z.boolean(),
        port: positiveInt.max(65535),
        bindAddress: z.string().min(1),
        publicAdminBaseUrl: z.url(),
        sessionTtlSeconds: positiveInt,
      })
      .strict(),
    storage: z
      .object({
        dataDir: z.string().min(1),
        flushIntervalMs: positiveInt,
        batchSize: positiveInt,
        requestRetentionDays: positiveInt,
        minuteRetentionDays: positiveInt,
        hourRetentionDays: positiveInt,
        dailyRetentionDays: positiveInt,
      })
      .strict(),
    quota: z
      .object({
        timezone: z
          .string()
          .min(1)
          .refine((value) => {
            try {
              new Intl.DateTimeFormat('en-US', { timeZone: value });
              return true;
            } catch {
              return false;
            }
          }, 'Expected an IANA timezone'),
        semanticsVersion: z.enum(['normalized_v2', 'legacy_v1']),
        missingUsagePolicy: z.enum(['retain-reservation', 'release-reservation']),
        defaultMaxConcurrentRequests: positiveInt,
      })
      .strict(),
    upstreams: z.array(upstreamSchema),
    routes: z.array(routeSchema),
    proxyKeys: z.array(proxyKeySchema),
  })
  .strict();

export type ConfigV2 = z.infer<typeof configV2Schema>;
export type UpstreamDefinition = z.infer<typeof upstreamSchema>;
export type RouteDefinition = z.infer<typeof routeSchema>;
export type ProxyKeyDefinition = z.infer<typeof proxyKeySchema>;
export type SecretSource = z.infer<typeof secretSource>;
export type ModelCapabilities = z.infer<typeof modelCapabilities>;

export function defaultConfigV2(configPath: string, instanceId: string): ConfigV2 {
  const dataDir = configPath.replace(/[/\\][^/\\]+$/, '') || '.';
  return {
    schemaVersion: 2,
    revision: 1,
    instanceId,
    server: {
      port: 15005,
      bindAddress: '127.0.0.1',
      publicProxyBaseUrl: 'http://127.0.0.1:15005',
      maxBodyBytes: 4_194_304,
      maxAttempts: 3,
      connectTimeoutMs: 10_000,
      firstByteTimeoutMs: 60_000,
      streamIdleTimeoutMs: 60_000,
      totalRequestTimeoutMs: 300_000,
      trustedProxyCidrs: [],
    },
    admin: {
      enabled: true,
      port: 15006,
      bindAddress: '127.0.0.1',
      publicAdminBaseUrl: 'http://127.0.0.1:15006',
      sessionTtlSeconds: 28_800,
    },
    storage: {
      dataDir,
      flushIntervalMs: 250,
      batchSize: 100,
      requestRetentionDays: 30,
      minuteRetentionDays: 7,
      hourRetentionDays: 90,
      dailyRetentionDays: 400,
    },
    quota: {
      timezone: 'UTC',
      semanticsVersion: 'normalized_v2',
      missingUsagePolicy: 'retain-reservation',
      defaultMaxConcurrentRequests: 10,
    },
    upstreams: [],
    routes: [],
    proxyKeys: [],
  };
}
