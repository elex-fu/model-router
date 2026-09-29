import { z } from 'zod';
import { ControlError } from '../control/service.js';
import { type AdminRequestSchemaKey, adminRequestSchemas } from './contracts-schema.js';

export type ContractOperation = {
  method: string;
  path: string;
  schema?: AdminRequestSchemaKey;
  public?: boolean;
  revision?: boolean;
  success?: number;
  summary: string;
  responseType?: 'json' | 'openapi' | 'export-file' | 'sse' | 'config-export';
  query?: Record<string, unknown>;
};

const queryTime = {
  type: 'string',
  format: 'date-time',
  description: 'ISO8601 timestamp with a timezone offset. If omitted, to defaults to now and from to 24 hours before to. The range is [from,to), positive, and at most 400 days.',
};
const querySource = {
  type: 'string',
  enum: ['production', 'playground', 'health', 'all', 'proxy'],
  description: 'proxy is accepted as an alias for production.',
};
const queryDimension = { type: 'string', maxLength: 200 };
const queryRangeAndDimensions = {
  from: queryTime,
  to: queryTime,
  keyId: queryDimension,
  upstreamId: queryDimension,
  model: queryDimension,
  protocol: queryDimension,
  source: querySource,
};
const queryByPath: Record<string, Record<string, unknown>> = {
  '/usage/summary': { ...queryRangeAndDimensions },
  '/usage/timeseries': {
    ...queryRangeAndDimensions,
    grain: { type: 'string', enum: ['hour', 'day'], description: 'Archived timeseries supports day only.' },
  },
  '/usage/breakdown': {
    ...queryRangeAndDimensions,
    groupBy: { type: 'string', enum: ['keyId', 'upstreamId', 'model', 'protocol', 'source', 'upstream'] },
    upstreamFilterMode: { type: 'string', enum: ['final', 'attempt'], default: 'final' },
  },
  '/requests': {
    ...queryRangeAndDimensions,
    state: {
      type: 'string',
      enum: ['received', 'rejected', 'admitted', 'routing', 'connecting', 'streaming', 'nonstream', 'completed', 'failed', 'cancelled', 'interrupted', 'succeeded'],
    },
    status: {
      type: 'string',
      enum: ['received', 'rejected', 'admitted', 'routing', 'connecting', 'streaming', 'nonstream', 'completed', 'failed', 'cancelled', 'interrupted', 'succeeded'],
      description: 'Alias for state; state takes precedence when both are supplied.',
    },
    limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    cursor: { type: 'string', maxLength: 512 },
  },
};

const rows: Array<[string, string, AdminRequestSchemaKey?, boolean?, boolean?, number?]> = [
  ['get','/openapi.json',undefined,true], ['get','/bootstrap',undefined,true], ['post','/bootstrap','bootstrap',true,false,201],
  ['post','/session','session',true], ['get','/session'], ['delete','/session'], ['get','/config'], ['put','/config','configWrite',false,true],
  ['get','/config/export'], ['post','/config/validate','configValidate'], ['post','/config/import-preview','configImportPreview'],
  ['post','/config/import','configImport',false,true], ['get','/config/history'], ['post','/config/rollback','configRollback',false,true],
  ['get','/provider-presets'], ['get','/capabilities'], ['get','/system'], ['get','/overview'],
  ['get','/upstreams'], ['get','/upstreams/{id}'], ['post','/upstreams','upstreamCreate',false,true,201],
  ['patch','/upstreams/{id}','upstreamPatch',false,true], ['delete','/upstreams/{id}',undefined,false,true],
  ['post','/upstreams/{id}/credentials','credentialCreate',false,true,201], ['patch','/upstreams/{id}/credentials/{credentialId}','credentialPatch',false,true],
  ['delete','/upstreams/{id}/credentials/{credentialId}',undefined,false,true], ['post','/upstreams/{id}/discover-models','emptyAction'],
  ['post','/upstreams/{id}/test','upstreamTest',false,false,202], ['post','/upstreams/{id}/test-jobs/{jobId}/cancel'], ['get','/upstreams/{id}/runtime'], ['get','/upstreams/{id}/health-events'], ['post','/upstreams/{id}/circuit-reset'],
  ['get','/routes'], ['get','/routes/{id}'], ['post','/routes','routeCreate',false,true,201], ['patch','/routes/{id}','routePatch',false,true],
  ['delete','/routes/{id}',undefined,false,true], ['put','/routes/order','routeOrder',false,true], ['post','/routes/preview','routePreview'], ['get','/models'],
  ['get','/keys'], ['get','/keys/{id}'], ['post','/keys','keyCreate',false,true,201], ['patch','/keys/{id}','keyPatch',false,true],
  ['delete','/keys/{id}',undefined,false,true], ['post','/keys/{id}/rotate','emptyAction',false,true], ['get','/keys/{id}/quota'],
  ['post','/keys/{id}/quota-adjustments','quotaAdjustment',false,false,201], ['get','/usage/summary'], ['get','/usage/timeseries'], ['get','/usage/breakdown'],
  ['get','/requests'], ['get','/requests/{id}'], ['get','/requests/{id}/attempts'], ['post','/exports','exportCreate',false,false,202], ['get','/exports/{id}/download'],
  ['post','/playground/runs','playgroundRun',false,false,202], ['get','/playground/runs/{id}'], ['get','/playground/status'], ['post','/playground/runs/{id}/cancel'],
  ['get','/connect/templates'], ['get','/pricing'], ['post','/pricing','pricingCreate',false,false,201], ['patch','/pricing/{id}','pricingPatch'],
  ['get','/accounts'], ['post','/accounts/client-credentials','accountClientCredentials',false,false,201], ['post','/accounts/device-flows','deviceFlowCreate',false,false,202],
  ['get','/accounts/device-flows/{id}'], ['delete','/accounts/device-flows/{id}'], ['patch','/accounts/{id}','accountPatch'], ['delete','/accounts/{id}'], ['post','/accounts/{id}/refresh'],
  ['get','/balances'], ['post','/balances/refresh','emptyAction',false,false,202], ['get','/audit-events'], ['post','/maintenance/jobs','maintenanceJob',false,false,202], ['get','/jobs/{id}'], ['get','/events'],
];

export const adminContractOperations: ContractOperation[] = rows.map(([method,path,schema,isPublic,revision,success]) => ({
  method, path, ...(schema ? { schema } : {}), ...(isPublic ? { public: true } : {}), ...(revision ? { revision: true } : {}),
  ...(success ? { success } : {}), summary: `${method.toUpperCase()} ${path}`,
  ...(path === '/openapi.json' ? { responseType: 'openapi' as const } : {}),
  ...(path === '/config/export' ? { responseType: 'config-export' as const } : {}),
  ...(path === '/exports/{id}/download' ? { responseType: 'export-file' as const } : {}),
  ...(path === '/events' ? { responseType: 'sse' as const } : {}),
  ...(queryByPath[path] ? { query: queryByPath[path] } : {}),
}));

const schemaKeys = new Set(Object.keys(adminRequestSchemas));
for (const operation of adminContractOperations) {
  if (operation.schema && !schemaKeys.has(operation.schema))
    throw new Error(`Missing request schema "${operation.schema}" for ${operation.method.toUpperCase()} ${operation.path}`);
}
export const adminBodylessActions = new Set(['POST /upstreams/{id}/circuit-reset','POST /upstreams/{id}/test-jobs/{jobId}/cancel','POST /playground/runs/{id}/cancel','POST /accounts/{id}/refresh']);
for (const operation of adminContractOperations) {
  if (!['get', 'delete'].includes(operation.method) && !operation.schema && !adminBodylessActions.has(`${operation.method.toUpperCase()} ${operation.path}`))
    throw new Error(`Missing request schema for body-bearing operation ${operation.method.toUpperCase()} ${operation.path}`);
}

const errorSchema = z.toJSONSchema(z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional(), requestId: z.string() }).strict() }).strict());
const successSchema = z.toJSONSchema(z.object({ data: z.unknown(), meta: z.object({ requestId: z.string(), observedAt: z.iso.datetime() }).passthrough() }).strict());
const response = (description: string, schema: unknown, media = 'application/json') => ({ description, content: { [media]: { schema } } });

export const adminOpenApiDocument = {
  openapi: '3.1.0', info: { title: 'Model Router Management API', version: '1.0.0', description: 'Generated from the runtime Zod request contracts and admin route manifest.' },
  servers: [{ url: '/admin/api/v1' }],
  paths: adminContractOperations.reduce<Record<string, Record<string, unknown>>>((paths, operation) => {
    const parameters: Array<{ name: string; in: string; required: boolean; schema: Record<string, unknown> }> = [...operation.path.matchAll(/\{([^}]+)\}/g)].map((match) => ({ name: match[1], in: 'path', required: true, schema: { type: 'string' } }));
    if (operation.revision) parameters.push({ name: 'If-Match', in: 'header', required: true, schema: { type: 'string', pattern: '^"cfg-[0-9]+"$' } });
    const successful = operation.responseType === 'sse' ? response('Server-sent event stream', { type: 'string' }, 'text/event-stream')
      : operation.responseType === 'export-file' ? { description: 'CSV or JSON export file', content: { 'text/csv': { schema: { type: 'string' } }, 'application/json': { schema: { type: 'object' } } } }
      : operation.responseType === 'openapi' ? response('OpenAPI 3.1 document', { type: 'object' }, 'application/vnd.oai.openapi+json;version=3.1')
      : operation.responseType === 'config-export' ? response('Configuration export (contains secret references only)', successSchema)
      : response(operation.success === 202 ? 'Job or asynchronous operation accepted' : 'Successful response', successSchema);
    const responses: Record<string, unknown> = { [String(operation.success ?? 200)]: successful, '400': response('Invalid request', errorSchema), '401': response('Authentication required', errorSchema), '403': response('Authorization, origin, or CSRF check failed', errorSchema), '422': response('Request validation failed', errorSchema) };
    if (operation.success === undefined || operation.success !== 200) { /* success response uses the handler status */ }
    if (operation.revision) { responses['412'] = response('Configuration revision conflict', errorSchema); responses['428'] = response('If-Match is required', errorSchema); }
    if (operation.query) parameters.push(...Object.entries(operation.query).map(([name, schema]) => ({ name, in: 'query', required: false, schema: schema as Record<string, unknown> })));
    if (operation.method !== 'get' && operation.method !== 'delete' && operation.schema) {
      const schema = adminRequestSchemas[operation.schema];
      responses['422'] = response('Request validation failed', errorSchema);
      const item = { operationId: `${operation.method}_${operation.path.replaceAll(/[{}]/g, '').replaceAll('/', '_').replace(/^_/, '')}`, summary: operation.summary,
        ...(operation.public ? {} : { security: [operation.method === 'get' ? { AdminSession: [] } : { AdminSession: [], CsrfToken: [] }] }),
        ...(parameters.length ? { parameters } : {}), requestBody: { required: true, content: { 'application/json': { schema: z.toJSONSchema(schema, { target: 'draft-2020-12' }) } } }, responses };
      paths[operation.path] ??= {}; paths[operation.path][operation.method] = item;
    } else {
      const item = { operationId: `${operation.method}_${operation.path.replaceAll(/[{}]/g, '').replaceAll('/', '_').replace(/^_/, '')}`, summary: operation.summary,
        ...(operation.public ? {} : { security: [operation.method === 'get' ? { AdminSession: [] } : { AdminSession: [], CsrfToken: [] }] }),
        ...(parameters.length ? { parameters } : {}), responses };
      paths[operation.path] ??= {}; paths[operation.path][operation.method] = item;
    }
    return paths;
  }, {}),
  components: { securitySchemes: { AdminSession: { type: 'apiKey', in: 'cookie', name: 'mr_admin_session' }, CsrfToken: { type: 'apiKey', in: 'header', name: 'x-csrf-token' } } },
} as const;

export function schemaForAdminOperation(method: string, path: string): AdminRequestSchemaKey | undefined {
  const normalized = path.replace(/^\/admin\/api\/v1/, '');
  return adminContractOperations.find((operation) =>
    operation.method === method.toLowerCase() &&
    operation.path.split('/').length === normalized.split('/').length &&
    new RegExp(`^${operation.path.split('/').map((part) => part.startsWith('{') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/')}$`).test(normalized),
  )?.schema;
}

export function parseAdminRequest(method: string, path: string, input: unknown): unknown {
  const key = schemaForAdminOperation(method, path);
  if (!key) {
    const normalized = path.replace(/^\/admin\/api\/v1/, '');
    const bodyless = ['POST /upstreams/{id}/circuit-reset','POST /upstreams/{id}/test-jobs/{jobId}/cancel','POST /playground/runs/{id}/cancel','POST /accounts/{id}/refresh'];
    const operation = adminContractOperations.find((candidate) => candidate.method === method.toLowerCase() &&
      candidate.path.split('/').length === normalized.split('/').length &&
      new RegExp(`^${candidate.path.split('/').map((part) => part.startsWith('{') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/')}$`).test(normalized));
    if (!operation || !bodyless.includes(`${method.toUpperCase()} ${operation.path}`) || (input && typeof input === 'object' && Object.keys(input).length === 0)) return input;
    const parsedEmpty = adminRequestSchemas.emptyAction.safeParse(input);
    if (parsedEmpty.success) return parsedEmpty.data;
    throw new ControlError(422, 'INVALID_REQUEST', 'Request body does not match the documented schema', parsedEmpty.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));
  }
  const parsed = adminRequestSchemas[key].safeParse(input);
  if (parsed.success) return parsed.data;
  // Keep the established 400 semantics for these handler-level format errors.
  // The request schemas still document the enums and all other validation
  // failures continue to return 422.
  const issuesOnlyAt = (field: string) =>
    parsed.error.issues.length > 0 && parsed.error.issues.every((issue) => issue.path.length === 1 && issue.path[0] === field);
  if ((key === 'configImport' || key === 'configImportPreview') && issuesOnlyAt('mode'))
    throw new ControlError(400, 'UNSUPPORTED_IMPORT_MODE', 'mode must be replace or merge');
  if (key === 'exportCreate' && issuesOnlyAt('type'))
    throw new ControlError(400, 'INVALID_EXPORT_TYPE', 'Use usage or requests');
  if (key === 'exportCreate' && issuesOnlyAt('format'))
    throw new ControlError(400, 'INVALID_EXPORT_FORMAT', 'Use csv or json');
  throw new ControlError(422, 'INVALID_REQUEST', 'Request body does not match the documented schema', parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));
}
