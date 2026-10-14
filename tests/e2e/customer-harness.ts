import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { createAdminServer } from '../../dist/admin/server.js';
import { SaasCatalogService } from '../../dist/saas/catalog/service.js';
import { createSaasDatabase, verifySaasRuntimeDatabasePrivileges } from '../../dist/saas/db/index.js';
import { SaasProjectInferencePolicyService } from '../../dist/saas/gateway/project-policy-service.js';
import { SaasRouteConfigService } from '../../dist/saas/gateway/route-config-service.js';
import { createSaasIdentityHandler } from '../../dist/saas/identity/http.js';
import { SaasIdentityService } from '../../dist/saas/identity/service.js';
import { PostgresSupplyProfileResolver } from '../../dist/saas/keys/resolver.js';
import { KeyService } from '../../dist/saas/keys/service.js';
import type { SaasDatabase, SqlExecutor, SqlResult } from '../../src/saas/db/types.js';

const execute = promisify(execFile);

function observeDatabase(database: SaasDatabase): SaasDatabase {
  const query =
    (executor: SqlExecutor) =>
    async <Row>(sql: string, values?: readonly unknown[]): Promise<SqlResult<Row>> => {
      try {
        return await executor.query<Row>(sql, values);
      } catch (error) {
        const failure = error as {
          code?: string;
          table?: string;
          column?: string;
          constraint?: string;
          message?: string;
        };
        const denied = /^permission denied for (?:table|schema|function|sequence) ([a-z0-9_]+)$/.exec(
          failure.message ?? '',
        );
        console.warn(
          'customer_e2e_sql_failure',
          JSON.stringify({
            code: failure.code,
            table: failure.table,
            column: failure.column,
            constraint: failure.constraint,
            deniedObject: denied?.[1],
            relations: [...sql.matchAll(/(?:FROM|INTO|UPDATE)\s+(saas_[a-z0-9_]+)/gi)].map((match) => match[1]),
          }),
        );
        throw error;
      }
    };
  return {
    ...database,
    query: query(database),
    transaction: (work) => database.transaction((tx) => work({ query: query(tx) })),
  };
}

async function postgresCommand(command: string, args: string[]) {
  // All PostgreSQL commands target the fresh cluster below. Never consume a
  // developer's configured database URL or change the service on port 5432.
  return execute('rtk', ['proxy', command, ...args], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
}

async function freePort() {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('PostgreSQL fixture port unavailable');
  await new Promise<void>((done, reject) => listener.close((error) => (error ? reject(error) : done())));
  return address.port;
}

/** Real customer identity/key SQL and HTTP, with a disposable PostgreSQL cluster. */
export async function startCustomerConsole() {
  const directory = await mkdtemp(join(tmpdir(), 'model-router-customer-e2e-'));
  const data = join(directory, 'postgres');
  const socket = join(directory, 'socket');
  const port = await freePort();
  const databaseName = 'model_router_test_customer_e2e';
  const url = (user: string) => `postgresql://${user}@127.0.0.1:${port}/${databaseName}`;
  let started = false;
  let admin: ReturnType<typeof createAdminServer> | undefined;
  let migrator: ReturnType<typeof createSaasDatabase> | undefined;
  let control: ReturnType<typeof createSaasDatabase> | undefined;
  const clusterOwner = new Pool({ connectionString: `postgresql://e2e_owner@127.0.0.1:${port}/postgres`, max: 1 });

  async function close() {
    try {
      await admin?.close();
    } finally {
      try {
        await Promise.all([control?.close(), migrator?.close(), clusterOwner.end()]);
      } finally {
        if (started) {
          await postgresCommand('pg_ctl', ['-D', data, '-w', '-t', '15', '-m', 'fast', 'stop']);
          started = false;
        }
        await rm(directory, { recursive: true, force: true });
      }
    }
  }

  try {
    await mkdir(socket);
    await postgresCommand('initdb', [
      '-D',
      data,
      '-U',
      'e2e_owner',
      '--auth-local=trust',
      '--auth-host=trust',
      '--encoding=UTF8',
      '--no-locale',
    ]);
    await postgresCommand('pg_ctl', [
      '-D',
      data,
      '-l',
      join(directory, 'postgres.log'),
      '-o',
      `-h 127.0.0.1 -p ${port} -k ${socket}`,
      '-w',
      '-t',
      '15',
      'start',
    ]);
    started = true;
    await clusterOwner.query(`CREATE DATABASE ${databaseName}`);
    const roleArgs = [
      '-X',
      '-v',
      'ON_ERROR_STOP=1',
      '--dbname',
      url('e2e_owner'),
      '--file',
      resolve('deploy/managed-saas-postgres-roles.sql'),
    ];
    await postgresCommand('psql', roleArgs);
    migrator = createSaasDatabase({ connectionString: url('model_router_saas_migrator'), max: 2 });
    await migrator.migrate();
    await postgresCommand('psql', roleArgs);
    control = createSaasDatabase({ connectionString: url('model_router_saas_control_plane'), max: 3 });
    await verifySaasRuntimeDatabasePrivileges(control, 'control_plane');

    const seedIdentity = new SaasIdentityService(migrator);
    const bootstrap = await seedIdentity.issueBootstrapToken();
    const owner = await seedIdentity.bootstrapPlatformAdmin({
      token: bootstrap.token,
      email: 'owner@customer-e2e.test',
      password: 'customer-e2e-owner-password',
      displayName: 'E2E workspace owner',
    });
    const tenant = await seedIdentity.createTenant(owner.id, { name: 'E2E customer workspace', slug: 'customer-e2e' });
    const projectId = tenant.defaultProjectId;
    if (!projectId) throw new Error('Customer default project was not created');
    const audit = { actorUserId: owner.id, entryPoint: 'customer-registration-e2e', requestId: randomUUID() };
    await new SaasProjectInferencePolicyService(migrator).enable({
      tenantId: tenant.id,
      projectId,
      expectedVersion: 1,
      audit,
    });
    const observedControl = observeDatabase(control);
    const service = new SaasIdentityService(observedControl);
    const keys = new KeyService(observedControl, { resolver: new PostgresSupplyProfileResolver(observedControl) });
    async function provisionSupply(model: string) {
      if (!migrator) throw new Error('Customer fixture migrator unavailable');
      await migrator.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO saas_supply_profiles (tenant_id, id, supply_mode, model_scopes) VALUES ($1, $2, 'byok', $3)`,
          [tenant.id, 'customer-e2e-supply', [model]],
        );
        await tx.query(
          `INSERT INTO saas_project_entitlements (id, tenant_id, project_id, supply_profile_id, supply_mode, model_scopes, source_type) VALUES ($1, $2, $3, $4, 'byok', $5, 'admin_grant')`,
          [randomUUID(), tenant.id, projectId, 'customer-e2e-supply', [model]],
        );
      });
      const catalog = new SaasCatalogService(migrator);
      const providerId = 'customer-e2e-provider';
      const productId = 'customer-e2e-product';
      const publicModelId = 'customer-e2e-public-model';
      const providerModel = 'customer-e2e-provider-model';
      const endpoint = '/v1/chat/completions';
      await catalog.registerProviderProduct({ providerId, productId, displayName: 'Customer E2E provider' });
      await catalog.registerPublicModelAlias({
        publicModelId,
        alias: model,
        displayName: 'Customer E2E model',
        providerId,
        productId,
        model: providerModel,
        endpointScope: [endpoint],
      });
      await catalog.registerProviderRightsVersion({
        rightsId: 'customer-e2e-rights',
        providerId,
        productId,
        credentialType: 'api-key',
        supplyMode: 'byok',
        region: 'e2e-region',
        purpose: 'inference',
        modelScope: [providerModel],
        endpointScope: [endpoint],
        effectiveAt: new Date(Date.now() - 60_000).toISOString(),
        approvalReference: 'customer-e2e-approval',
        status: 'active',
        evidenceReference: 'customer-e2e-rights-evidence',
        evidenceSha256: 'b'.repeat(64),
        audit,
      });
      const routes = new SaasRouteConfigService(migrator);
      const definition = {
        publicModelId,
        publicModelVersion: 1,
        protocol: 'openai' as const,
        supplyMode: 'byok' as const,
        targetMode: 'tenant_account' as const,
        upstreamId: 'customer-e2e-upstream',
        endpoint,
      };
      await routes.create({ tenantId: tenant.id, projectId, routeId: 'customer-e2e-route', definition, audit });
      await routes.publish({
        tenantId: tenant.id,
        projectId,
        routeId: 'customer-e2e-route',
        expectedVersion: 1,
        definition,
        audit,
      });
    }
    let origin = '';
    let handler: ReturnType<typeof createSaasIdentityHandler>;
    admin = createAdminServer({
      configPath: join(directory, 'config.json'),
      webDistPath: resolve('web/dist'),
      publicOrigin: () => origin,
      saasIdentityHandler: (request, response) => handler(request, response),
    });
    admin.server.listen(0, '127.0.0.1');
    await once(admin.server, 'listening');
    const address = admin.server.address();
    if (!address || typeof address === 'string') throw new Error('Customer console did not bind');
    origin = `http://127.0.0.1:${address.port}`;
    handler = createSaasIdentityHandler({ service, keyService: keys, publicOrigin: origin, sessionTtlSeconds: 900 });

    return { origin, directory, tenant, owner, keys, service, migrator, control, provisionSupply, close };
  } catch (error) {
    await close();
    throw error;
  }
}
