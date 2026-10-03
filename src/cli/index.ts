#!/usr/bin/env node
import { Command } from 'commander';
import { ConfigStore } from '../config/store.js';
import {
  type DeploymentEnvironment,
  MODEL_ROUTER_DEPLOYMENT_MODE,
  MODEL_ROUTER_SAAS_WORKLOAD_ROLE,
} from '../saas/deployment.js';
import { generateProxyKey } from '../utils/generate-key.js';
import { DEFAULT_CONFIG_PATH } from '../utils/paths.js';
import { applyUpdateOptions, parseCreateOptions } from './key-options.js';
import { saasBootstrapAdmin } from './saas-management.js';
import { saasMigrationAudit } from './saas-migration-audit.js';
import { saasMigrate } from './saas-migrations.js';
import { saasPlatformMfaEnroll } from './saas-platform-mfa-enrollment.js';
import { tryV2, v2Config } from './v2.js';
import {
  adminBootstrap,
  backupCreate,
  backupRestore,
  configApply,
  configMigrate,
  configValidate,
  telemetryRebuildLive,
  upstreamTest,
  upstreamUpdate,
} from './v2-management.js';

const program = new Command();

program.name('model-router').description('Lightweight AI model proxy').version('0.1.0');

function getStore(options: { config?: string }) {
  return new ConfigStore(options.config ?? DEFAULT_CONFIG_PATH);
}

type StartRoleOptions = {
  role?: string;
  workloadRole?: string;
};

/**
 * Select a managed SaaS workload without mutating the supervisor environment.
 * The server remains responsible for validating the complete deployment
 * contract and running every readiness/privilege gate before it binds.
 */
function resolveStartEnvironment(options: StartRoleOptions): DeploymentEnvironment {
  const requestedRoles = [options.role, options.workloadRole].filter((role): role is string => role !== undefined);
  if (requestedRoles.length === 0) return process.env;

  const requestedRole = requestedRoles[0];
  if (requestedRoles.some((role) => role !== requestedRole)) {
    throw new Error('--role and --workload-role must select the same managed SaaS workload role');
  }

  const configuredMode = process.env[MODEL_ROUTER_DEPLOYMENT_MODE];
  if (configuredMode !== undefined && configuredMode !== 'managed-saas') {
    throw new Error(`--role requires ${MODEL_ROUTER_DEPLOYMENT_MODE}=managed-saas`);
  }
  const configuredRole = process.env[MODEL_ROUTER_SAAS_WORKLOAD_ROLE];
  if (configuredRole !== undefined && configuredRole !== requestedRole) {
    throw new Error(`--role conflicts with ${MODEL_ROUTER_SAAS_WORKLOAD_ROLE}`);
  }

  return Object.freeze({
    ...process.env,
    [MODEL_ROUTER_DEPLOYMENT_MODE]: 'managed-saas',
    [MODEL_ROUTER_SAAS_WORKLOAD_ROLE]: requestedRole,
  });
}

async function management(action: () => Promise<void>) {
  try {
    await action();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Command failed');
    process.exitCode = 1;
  }
}

program
  .command('config:validate')
  .description('Validate an offline V2 configuration without changing it')
  .option('-c, --config <path>', 'Path to V2 configuration')
  .action((options) => management(() => configValidate(options)));

program
  .command('config:migrate')
  .description('Preview the V1-to-V2 conversion or perform an offline V2 migration')
  .option('--dry-run', 'Convert and validate without writing configuration, secrets, or backup')
  .option('-c, --config <path>', 'Path to configuration')
  .action((options) => management(() => configMigrate(options)));

program
  .command('admin:bootstrap')
  .description('Create the first administrator via the local admin listener')
  .option('-c, --config <path>', 'Path to V2 configuration')
  .option('--test-stdin', 'Test-only: read token, name, and password from three stdin lines')
  .action((options) => management(() => adminBootstrap(options)));

program
  .command('saas:bootstrap-admin')
  .description('Create the first SaaS platform administrator directly in PostgreSQL')
  .action(() => management(() => saasBootstrapAdmin()));

program
  .command('saas:platform-mfa-enroll')
  .description('Issue a one-time platform MFA enrollment handoff from a secure operator TTY using the explicit management database and TOTP KMS provider')
  .option('--allow-local-plaintext', 'Permit sslmode=disable only for an explicit loopback disposable database or trusted local tunnel; default verifies TLS')
  .addHelpText('after', '\nRequires MODEL_ROUTER_SAAS_DATABASE_URL and the trusted MODEL_ROUTER_SAAS_KMS_PROVIDER module. Only platform-totp is loaded. The provider receives fixed non-secret region/deployment/workload labels and must use workload identity for authentication; no DB, Redis, upstream or API credentials are forwarded, and no embedded AES keys are supported. Remote PostgreSQL requires verified TLS; session/role/search_path/query overrides are rejected.\n')
  .action((options) => management(() => saasPlatformMfaEnroll({}, options)));

program
  .command('saas:migrate')
  .description('Apply SaaS database migrations explicitly. Server startup never runs migrations.')
  .action(() => management(() => saasMigrate()));

program
  .command('saas:migration-audit')
  .description('Read-only ledger/catalog audit using MODEL_ROUTER_SAAS_AUDIT_DATABASE_URL; missing baseline is unverified')
  .option('--deployment-id <id>', 'Explicit non-sensitive target deployment label')
  .option('--environment-id <id>', 'Explicit non-sensitive target environment label')
  .option('--database <name>', 'Expected PostgreSQL database name')
  .option('--schema <name>', 'Explicit SaaS schema name')
  .option('--release-id <id>', 'Expected release label for this executable and reviewed baseline')
  .option('--catalog-baseline <path>', 'Reviewed JSON catalog baseline; never generated or promoted automatically')
  .option('--allow-local-plaintext', 'Permit sslmode=disable only for an explicit loopback disposable database or trusted local tunnel; default verifies TLS')
  .action((options) => management(async () => {
    const result = await saasMigrationAudit(options);
    process.exitCode = result.exitCode;
  }));

program
  .command('config:apply <path>')
  .description('Apply a V2 JSON file to an offline target with revision CAS')
  .option('--expected-revision <revision>', 'Fail unless the current revision matches')
  .option('-c, --config <path>', 'Target configuration path')
  .action((path, options) => management(() => configApply(path, options)));

program
  .command('upstream:update <name>')
  .description('Update an offline V2 upstream')
  .option('--base-url <url>', 'New upstream base URL')
  .option('--model <model>', 'Add an enabled model')
  .option('--enable', 'Enable upstream')
  .option('--disable', 'Disable upstream')
  .option('-c, --config <path>', 'Path to V2 configuration')
  .action((name, options) => management(() => upstreamUpdate(name, options)));

program
  .command('upstream:test <name>')
  .description('Probe a V2 upstream without changing configuration')
  .option('--model <model>', 'Override model')
  .option('-c, --config <path>', 'Path to V2 configuration')
  .action((name, options) => management(() => upstreamTest(name, options)));

program
  .command('backup:create')
  .description('Create an offline V2 config, secrets, control and telemetry backup')
  .option('-c, --config <path>', 'Path to V2 configuration')
  .action((options) => management(() => backupCreate(options)));

program
  .command('backup:restore <backupId>')
  .description('Restore a complete V2 backup to a fully stopped instance')
  .requiredOption('-c, --config <path>', 'Explicit path to the stopped V2 configuration')
  .requiredOption('--expected-revision <revision>', 'Current configuration revision CAS')
  .action((backupId, options) => management(() => backupRestore(backupId, options)));

program
  .command('telemetry:rebuild-live')
  .description('Rebuild live telemetry aggregates on a fully stopped V2 instance')
  .requiredOption('-c, --config <path>', 'Explicit path to the stopped V2 configuration')
  .requiredOption('--expected-revision <revision>', 'Current configuration revision CAS')
  .action((options) => management(() => telemetryRebuildLive(options)));

// start
program
  .command('start')
  .description('Start the proxy server')
  .option('-p, --port <port>', 'Server port', parseInt)
  .option('-b, --bind <address>', 'Address to bind (default: 127.0.0.1)')
  .option('--max-body-size <size>', 'Max request body size (e.g. 4mb, 1024)')
  .option('--trust-proxy', 'Honor X-Forwarded-For (only when behind a trusted reverse proxy)')
  .option('--daemon', 'Run in background; requires --pid-file (and usually --log-file)')
  .option('--log-file <path>', 'Daemon stdout/stderr log file')
  .option('--pid-file <path>', 'Daemon PID file')
  .option('--role <role>', 'Managed SaaS workload role; selects managed-saas startup')
  .option('--workload-role <role>', 'Alias for --role')
  .option('-c, --config <path>', 'Path to config file')
  .action(async (options) => {
    const environment = resolveStartEnvironment(options);
    let maxBodyBytes: number | undefined;
    if (options.maxBodySize) {
      const { parseByteSize } = await import('./size.js');
      try {
        maxBodyBytes = parseByteSize(options.maxBodySize);
      } catch (err: any) {
        console.error(err.message);
        process.exit(1);
      }
    }
    if (options.daemon) {
      if (!options.pidFile) {
        console.error('--daemon requires --pid-file');
        process.exit(1);
      }
      const { spawnDaemon, readPidFile, isProcessRunning } = await import('./daemon.js');
      const existing = readPidFile(options.pidFile);
      if (existing && isProcessRunning(existing)) {
        console.error(`Already running with pid ${existing} (pid-file: ${options.pidFile})`);
        process.exit(1);
      }
      const childArgs = ['start'];
      if (options.port !== undefined) childArgs.push('--port', String(options.port));
      if (options.bind) childArgs.push('--bind', options.bind);
      if (options.maxBodySize) childArgs.push('--max-body-size', options.maxBodySize);
      if (options.trustProxy) childArgs.push('--trust-proxy');
      if (options.role) childArgs.push('--role', options.role);
      if (options.workloadRole) childArgs.push('--workload-role', options.workloadRole);
      if (options.config) childArgs.push('--config', options.config);
      const pid = spawnDaemon({
        args: childArgs,
        logFile: options.logFile,
        pidFile: options.pidFile,
      });
      console.log(`model-router started in background (pid ${pid})`);
      return;
    }
    const { startServer } = await import('../server/index.js');
    await startServer(options.port, options.config, {
      bindAddress: options.bind,
      maxBodyBytes,
      trustProxy: options.trustProxy,
      environment,
    });
  });

// stop
program
  .command('stop')
  .description('Stop a running daemon by sending SIGTERM to the pid file process')
  .requiredOption('--pid-file <path>', 'Daemon PID file')
  .action(async (options) => {
    const { readPidFile, isProcessRunning } = await import('./daemon.js');
    const pid = readPidFile(options.pidFile);
    if (pid === null) {
      console.error(`pid file not found or unreadable: ${options.pidFile}`);
      process.exit(1);
    }
    if (!isProcessRunning(pid)) {
      console.log(`No running process for pid ${pid}; removing stale pid file.`);
      try {
        const fs = await import('node:fs');
        fs.unlinkSync(options.pidFile);
      } catch {
        // best-effort
      }
      return;
    }
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`Sent SIGTERM to pid ${pid}`);
    } catch (err: any) {
      console.error(`Failed to signal pid ${pid}: ${err.message}`);
      process.exit(1);
    }
  });

// status
program
  .command('status')
  .description('Check whether a daemon recorded in the pid file is running')
  .requiredOption('--pid-file <path>', 'Daemon PID file')
  .action(async (options) => {
    const { readPidFile, isProcessRunning } = await import('./daemon.js');
    const pid = readPidFile(options.pidFile);
    if (pid === null) {
      console.log('not running (no pid file)');
      process.exit(1);
    }
    if (isProcessRunning(pid)) {
      console.log(`running (pid ${pid})`);
    } else {
      console.log(`not running (stale pid ${pid})`);
      process.exit(1);
    }
  });

// key create
program
  .command('key:create <name>')
  .description('Create a new proxy key')
  .option('--description <text>', 'Free-form note (e.g., user email or purpose)')
  .option('--upstreams <list>', 'Comma-separated upstream whitelist (empty = all)')
  .option('--models <list>', 'Comma-separated model whitelist, glob OK (empty = all)')
  .option('--rpm <n>', 'Max requests per minute (0 = blocked, omit = unlimited)')
  .option('--daily-tokens <n>', 'Max input+output tokens per local day')
  .option('--expires <iso>', 'ISO 8601 timestamp; omit = never expires')
  .option('-c, --config <path>', 'Path to config file')
  .action(async (name, options) => {
    if (await tryV2('key:create', options, name)) return;
    const store = getStore(options);
    const key = generateProxyKey();
    let patch: Partial<import('../config/types.js').ProxyKey>;
    try {
      patch = parseCreateOptions(options);
    } catch (err: any) {
      console.error(err.message);
      process.exit(1);
    }
    store.addProxyKey({
      name,
      key,
      enabled: true,
      createdAt: new Date().toISOString(),
      ...patch,
    });
    console.log(`Created proxy key: ${name}`);
    console.log(`Key: ${key}`);
  });

// key update
program
  .command('key:update <name>')
  .description('Update an existing proxy key')
  .option('--description <text>', 'Set description')
  .option('--upstreams <list>', 'Replace upstream whitelist (empty = clear)')
  .option('--add-upstream <name>', 'Add one upstream to the whitelist')
  .option('--remove-upstream <name>', 'Remove one upstream from the whitelist')
  .option('--models <list>', 'Replace model whitelist (empty = clear)')
  .option('--add-model <pattern>', 'Add one model pattern to the whitelist')
  .option('--remove-model <pattern>', 'Remove one model pattern from the whitelist')
  .option('--rpm <n>', 'Set RPM limit (0 = blocked)')
  .option('--daily-tokens <n>', 'Set daily token limit (0 = blocked)')
  .option('--expires <iso>', `Set expiry; literal "never" clears it`)
  .option('-c, --config <path>', 'Path to config file')
  .action(async (name, options) => {
    if (await tryV2('key:update', options, name)) return;
    const store = getStore(options);
    const existing = store.getProxyKeyByName(name);
    if (!existing) {
      console.error(`Proxy key "${name}" not found`);
      process.exit(1);
    }
    let patch: Partial<import('../config/types.js').ProxyKey>;
    try {
      patch = applyUpdateOptions(options, existing);
    } catch (err: any) {
      console.error(err.message);
      process.exit(1);
    }
    store.updateProxyKey(name, patch);
    console.log(`Updated proxy key: ${name}`);
  });

// key rotate
program
  .command('key:rotate <name>')
  .description('Generate a new key string for the named proxy key (old key invalidated immediately)')
  .option('-c, --config <path>', 'Path to config file')
  .action(async (name, options) => {
    if (await tryV2('key:rotate', options, name)) return;
    const store = getStore(options);
    if (!store.getProxyKeyByName(name)) {
      console.error(`Proxy key "${name}" not found`);
      process.exit(1);
    }
    const newKey = generateProxyKey();
    store.rotateProxyKey(name, newKey);
    console.log(`Rotated proxy key: ${name}`);
    console.log(`New key: ${newKey}`);
  });

// key enable / disable
program
  .command('key:enable <name>')
  .description('Enable a proxy key')
  .option('-c, --config <path>', 'Path to config file')
  .action(async (name, options) => {
    if (await tryV2('key:enable', options, name)) return;
    const store = getStore(options);
    if (!store.setProxyKeyEnabled(name, true)) {
      console.error(`Proxy key "${name}" not found`);
      process.exit(1);
    }
    console.log(`Enabled proxy key: ${name}`);
  });

program
  .command('key:disable <name>')
  .description('Disable a proxy key')
  .option('-c, --config <path>', 'Path to config file')
  .action(async (name, options) => {
    if (await tryV2('key:disable', options, name)) return;
    const store = getStore(options);
    if (!store.setProxyKeyEnabled(name, false)) {
      console.error(`Proxy key "${name}" not found`);
      process.exit(1);
    }
    console.log(`Disabled proxy key: ${name}`);
  });

// key list
program
  .command('key:list')
  .description('List all proxy keys (secrets masked by default)')
  .option('--show-secrets', 'Show full key strings (unsafe)')
  .option('-c, --config <path>', 'Path to config file')
  .action(async (options) => {
    if (await tryV2('key:list', options)) return;
    const store = getStore(options);
    const keys = store.listProxyKeys();
    if (keys.length === 0) {
      console.log('No proxy keys found.');
      return;
    }
    const { maskSecret } = await import('./mask.js');
    const { logStoreFromConfig } = await import('../logger/store.js');
    const today = new Date().toISOString().slice(0, 10);
    let activity = new Map<string, { usedToday: number; lastUsed: string | null }>();
    try {
      const logStore = await logStoreFromConfig(options.config);
      const rows = await logStore.keyActivitySummary(today);
      activity = new Map(rows.map((r) => [r.keyName, { usedToday: r.usedToday, lastUsed: r.lastUsed }]));
      await logStore.close?.();
    } catch {
      // log db absent or unreadable — show config columns only
    }
    console.table(
      keys.map((k) => {
        const a = activity.get(k.name);
        return {
          name: k.name,
          key: options.showSecrets ? k.key : maskSecret(k.key),
          enabled: k.enabled,
          expires: k.expiresAt ?? '-',
          upstreams: k.allowedUpstreams?.join(',') ?? '*',
          models: k.allowedModels?.join(',') ?? '*',
          rpm: k.rpm ?? '-',
          daily_tokens: k.dailyTokens ?? '-',
          used_today: a?.usedToday ?? 0,
          last_used: a?.lastUsed ?? '-',
          createdAt: k.createdAt,
        };
      }),
    );
  });

// key delete
program
  .command('key:delete <name>')
  .description('Delete a proxy key')
  .option('-c, --config <path>', 'Path to config file')
  .action(async (name, options) => {
    if (await tryV2('key:delete', options, name)) return;
    const store = getStore(options);
    store.deleteProxyKey(name);
    console.log(`Deleted proxy key: ${name}`);
  });

// upstream add
program
  .command('upstream:add <name> <provider> <protocol> <baseUrl> <apiKeys>')
  .description('Add a new upstream')
  .option('-m, --models <models>', 'Comma-separated list of models')
  .option('--map <entries>', 'Comma-separated modelMap entries: pattern=target,...')
  .option('--auth-mode <mode>', 'V2 auth mode: bearer|x-api-key|google|none (use - for apiKeys with none)')
  .option(
    '--allow-insecure-http',
    'V2 only: allow plaintext HTTP to localhost/private IPs; credentials and prompts may be exposed',
  )
  .option('-c, --config <path>', 'Path to config file')
  .action(async (name, provider, protocol, baseUrl, apiKeys, options) => {
    if (await tryV2('upstream:add', options, name, provider, protocol, baseUrl, apiKeys)) return;
    if (options.allowInsecureHttp) throw new Error('--allow-insecure-http is supported only by V2 configuration');
    const store = getStore(options);
    const models = options.models
      ? String(options.models)
          .split(',')
          .map((s: string) => s.trim())
      : [];
    const validProtocols = ['anthropic', 'openai', 'gemini', 'responses'];
    if (!validProtocols.includes(protocol)) {
      console.error('Protocol must be "anthropic", "openai", "gemini", or "responses"');
      process.exit(1);
    }
    let modelMap: Record<string, string> | undefined;
    if (options.map) {
      modelMap = {};
      for (const entry of String(options.map).split(',')) {
        const trimmed = entry.trim();
        if (!trimmed) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) {
          console.error(`Invalid --map entry "${trimmed}", expected pattern=target`);
          process.exit(1);
        }
        const pattern = trimmed.slice(0, eq).trim();
        const target = trimmed.slice(eq + 1).trim();
        if (!pattern || !target) {
          console.error(`Invalid --map entry "${trimmed}", pattern and target required`);
          process.exit(1);
        }
        modelMap[pattern] = target;
      }
    }
    store.addUpstream({
      name,
      provider,
      protocol,
      baseUrl,
      apiKeys: apiKeys
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean),
      models,
      enabled: true,
      ...(modelMap ? { modelMap } : {}),
    });
    console.log(`Created upstream: ${name}`);
  });

// upstream list
program
  .command('upstream:list')
  .description('List all upstreams (apiKeys masked by default)')
  .option('--show-secrets', 'Show full apiKeys strings (unsafe)')
  .option('-c, --config <path>', 'Path to config file')
  .action(async (options) => {
    if (await tryV2('upstream:list', options)) return;
    const store = getStore(options);
    const upstreams = store.listUpstreams();
    if (upstreams.length === 0) {
      console.log('No upstreams found.');
      return;
    }
    const { maskSecret } = await import('./mask.js');
    console.table(
      upstreams.map((u) => ({
        name: u.name,
        provider: u.provider,
        protocol: u.protocol,
        baseUrl: u.baseUrl,
        keys: options.showSecrets ? u.apiKeys.join(', ') : u.apiKeys.map((k: string) => maskSecret(k)).join(', '),
        models: u.models.join(', '),
        modelMap: u.modelMap ? Object.keys(u.modelMap).length : 0,
        enabled: u.enabled,
      })),
    );
  });

// upstream delete
program
  .command('upstream:delete <name>')
  .description('Delete an upstream')
  .option('-c, --config <path>', 'Path to config file')
  .action(async (name, options) => {
    if (await tryV2('upstream:delete', options, name)) return;
    const store = getStore(options);
    store.deleteUpstream(name);
    console.log(`Deleted upstream: ${name}`);
  });

// upstream map set
program
  .command('upstream:map:set <upstream> <pattern> <target>')
  .description('Add or update a modelMap entry on an upstream')
  .option('-c, --config <path>', 'Path to config file')
  .action(async (upstream, pattern, target, options) => {
    if (await tryV2('upstream:map:set', options, upstream, pattern, target)) return;
    const store = getStore(options);
    store.setModelMapEntry(upstream, pattern, target);
    console.log(`Set ${upstream}: ${pattern} → ${target}`);
  });

// upstream map delete
program
  .command('upstream:map:delete <upstream> <pattern>')
  .description('Delete a modelMap entry on an upstream')
  .option('-c, --config <path>', 'Path to config file')
  .action(async (upstream, pattern, options) => {
    if (await tryV2('upstream:map:delete', options, upstream, pattern)) return;
    const store = getStore(options);
    store.deleteModelMapEntry(upstream, pattern);
    console.log(`Deleted ${upstream}: ${pattern}`);
  });

// upstream map list
program
  .command('upstream:map:list <upstream>')
  .description('List modelMap entries for an upstream')
  .option('-c, --config <path>', 'Path to config file')
  .action(async (upstream, options) => {
    if (await tryV2('upstream:map:list', options, upstream)) return;
    const store = getStore(options);
    const u = store.getUpstream(upstream);
    if (!u) {
      console.error(`Upstream "${upstream}" not found`);
      process.exit(1);
    }
    const map = u.modelMap ?? {};
    const entries = Object.entries(map);
    if (entries.length === 0) {
      console.log(`No modelMap entries for ${upstream}.`);
      return;
    }
    console.table(entries.map(([pattern, target]) => ({ pattern, target })));
  });

// test (connectivity)
program
  .command('test <upstream>')
  .description('Send a minimal probe request to verify an upstream is reachable')
  .option('-c, --config <path>', 'Path to config file')
  .option('--model <model>', 'Override the model used in the probe')
  .action(async (upstreamName, options) => {
    if (await tryV2('test', options, upstreamName)) return;
    const store = getStore(options);
    const u = store.getUpstream(upstreamName);
    if (!u) {
      console.error(`Upstream "${upstreamName}" not found`);
      process.exit(1);
    }
    const probeModel: string = options.model ?? u.models[0] ?? (u.modelMap ? Object.values(u.modelMap)[0] : undefined);
    if (!probeModel) {
      console.error(`Upstream "${upstreamName}" has no models or modelMap; pass --model <name> to probe`);
      process.exit(1);
    }

    const url =
      u.protocol === 'anthropic'
        ? `${u.baseUrl.replace(/\/$/, '')}/v1/messages`
        : `${u.baseUrl.replace(/\/$/, '')}/v1/chat/completions`;
    const body =
      u.protocol === 'anthropic'
        ? {
            model: probeModel,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'ping' }],
          }
        : {
            model: probeModel,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'ping' }],
          };

    const start = Date.now();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${u.apiKeys[0]}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
      });
      const ms = Date.now() - start;
      let snippet: any = null;
      try {
        snippet = await res.json();
      } catch {
        snippet = await res.text().catch(() => '');
      }
      console.log(`${upstreamName} ${u.baseUrl} model=${probeModel}: ${res.status} in ${ms}ms`);
      if (res.status >= 400) {
        console.log(JSON.stringify(snippet, null, 2));
        process.exit(1);
      } else {
        console.log('OK');
      }
    } catch (err: any) {
      const ms = Date.now() - start;
      console.error(`${upstreamName} ${u.baseUrl}: network error after ${ms}ms — ${err.message}`);
      process.exit(1);
    }
  });

// chat
program
  .command('chat <model> [message]')
  .description('Send a chat request through the local proxy to verify end-to-end routing')
  .option('--stream', 'Use streaming mode')
  .option('--protocol <protocol>', 'Client protocol (anthropic|openai)', 'anthropic')
  .option('--key <key>', 'Proxy key to use (defaults to first enabled key)')
  .option('-c, --config <path>', 'Path to config file')
  .action(async (model, message, options) => {
    const rawV2 = v2Config(options);
    const store = rawV2 ? undefined : getStore(options);
    const cfg = rawV2 ?? store!.load();
    const bind = cfg.server.bindAddress ?? '127.0.0.1';
    const port = cfg.server.port ?? 15005;
    const baseUrl = `http://${bind}:${port}`;

    const protocol = options.protocol;
    if (protocol !== 'anthropic' && protocol !== 'openai') {
      console.error('--protocol must be "anthropic" or "openai"');
      process.exit(1);
    }

    let proxyKey: string = options.key;
    if (rawV2) {
      if (!proxyKey) {
        console.error('V2 proxy keys cannot be recovered; pass the raw key with --key');
        process.exitCode = 1;
        return;
      }
      if (rawV2.proxyKeys.some((key) => key.id === proxyKey || key.name === proxyKey)) {
        console.error('V2 proxy key names cannot be resolved to plaintext; pass the raw key with --key');
        process.exitCode = 1;
        return;
      }
    } else if (!proxyKey) {
      const keys = store!.listProxyKeys().filter((k) => k.enabled);
      if (keys.length === 0) {
        console.error('No enabled proxy keys found. Create one with key:create or pass --key');
        process.exit(1);
      }
      proxyKey = keys[0].key;
    } else {
      const found = store!.listProxyKeys().find((k) => k.key === proxyKey || k.name === proxyKey);
      if (!found) {
        console.error(`Proxy key "${options.key}" not found`);
        process.exit(1);
      }
      proxyKey = found.key;
    }

    const userMessage = message ?? 'Hello, can you hear me?';
    const url = protocol === 'anthropic' ? `${baseUrl}/v1/messages` : `${baseUrl}/v1/chat/completions`;

    const body =
      protocol === 'anthropic'
        ? {
            model,
            max_tokens: 256,
            messages: [{ role: 'user', content: userMessage }],
            stream: !!options.stream,
          }
        : {
            model,
            messages: [{ role: 'user', content: userMessage }],
            stream: !!options.stream,
          };

    console.log(`→ ${protocol.toUpperCase()} ${url}`);
    console.log(`  model: ${model}`);
    console.log(`  message: "${userMessage}"`);
    console.log(`  stream: ${!!options.stream}`);
    console.log('');

    const start = Date.now();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': proxyKey,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error(`HTTP ${res.status} (${Date.now() - start}ms)`);
        try {
          const err = JSON.parse(text);
          console.error(JSON.stringify(err, null, 2));
        } catch {
          console.error(text);
        }
        process.exit(1);
      }

      if (options.stream) {
        if (!res.body) {
          console.error('No response body');
          process.exit(1);
        }
        const { parseSseStream } = await import('../protocol/sse.js');
        let wroteAny = false;
        for await (const ev of parseSseStream(res.body)) {
          if (!ev.data || ev.data === '[DONE]') continue;
          try {
            const chunk = JSON.parse(ev.data);
            if (chunk.type === 'error') {
              console.error('\nStream error:', JSON.stringify(chunk.error ?? chunk));
              process.exit(1);
            }
            let text: string | undefined;
            if (protocol === 'anthropic') {
              text = chunk.delta?.text ?? chunk.delta?.content;
            } else {
              text = chunk.choices?.[0]?.delta?.content;
            }
            if (text) {
              process.stdout.write(text);
              wroteAny = true;
            }
          } catch {
            // ignore parse errors
          }
        }
        if (!wroteAny) {
          console.log('(no content received in stream)');
        }
        console.log(`\n✓ Streaming complete (${Date.now() - start}ms)`);
      } else {
        const data = (await res.json()) as any;
        const ms = Date.now() - start;
        if (protocol === 'anthropic') {
          const text = data.content?.map((b: { text?: string }) => b.text).join('') ?? '';
          console.log(text);
          console.log(`\n✓ ${ms}ms | usage: ${JSON.stringify(data.usage ?? {})}`);
        } else {
          const text = data.choices?.[0]?.message?.content ?? '';
          console.log(text);
          console.log(`\n✓ ${ms}ms | usage: ${JSON.stringify(data.usage ?? {})}`);
        }
      }
    } catch (err: any) {
      console.error(`Request failed: ${err.message}`);
      process.exit(1);
    }
  });

// logs
program
  .command('logs')
  .description('Query request logs')
  .option('-t, --tail <n>', 'Number of recent logs', '20')
  .option('-k, --key <name>', 'Filter by proxy key name')
  .option('--protocol <protocol>', 'Filter by protocol (anthropic|openai)')
  .option('-c, --config <path>', 'Path to config file')
  .action(async (options) => {
    const { logStoreFromConfig } = await import('../logger/store.js');
    const store = await logStoreFromConfig(options.config);
    const limit = parseInt(options.tail, 10);
    if (options.protocol && options.protocol !== 'anthropic' && options.protocol !== 'openai') {
      console.error('--protocol must be "anthropic" or "openai"');
      process.exit(1);
    }
    const logs = await store.queryLogs(limit, {
      keyName: options.key,
      protocol: options.protocol,
    });
    if (logs.length === 0) {
      console.log('No logs found.');
      return;
    }
    console.table(
      logs.map((l) => ({
        id: l.id,
        key: l.proxy_key_name,
        cp: l.client_protocol ?? '-',
        up: l.upstream_protocol ?? '-',
        model: l.request_model,
        upstream: l.upstream_name,
        status: l.status_code,
        input: l.request_tokens,
        output: l.response_tokens,
        ms: l.duration_ms,
        created: l.created_at,
      })),
    );
  });

// stats
program
  .command('stats')
  .description('Show daily statistics')
  .option('-d, --date <date>', 'Date in YYYY-MM-DD format')
  .option('-c, --config <path>', 'Path to config file')
  .action(async (options) => {
    const { logStoreFromConfig } = await import('../logger/store.js');
    const store = await logStoreFromConfig(options.config);
    const date = options.date ?? new Date().toISOString().slice(0, 10);
    const stats = await store.stats(date);
    console.log(`Statistics for ${date}:`);
    console.table(stats);
  });

// stats:key <name> [--since 7d|YYYY-MM-DD]
program
  .command('stats:key <name>')
  .description("Show one proxy key's stats over a date range (default: today only)")
  .option('--since <since>', 'Range start: "Nd" (e.g. 7d) or YYYY-MM-DD')
  .option('-c, --config <path>', 'Path to config file')
  .action(async (name, options) => {
    const { logStoreFromConfig } = await import('../logger/store.js');
    const { resolveSinceRange } = await import('./since.js');
    const today = new Date().toISOString().slice(0, 10);
    let range: { fromDate: string; toDate: string };
    try {
      range = resolveSinceRange(options.since, today);
    } catch (err: any) {
      console.error(err.message);
      process.exit(1);
    }
    const store = await logStoreFromConfig(options.config);
    const stats = await store.statsByKey(name, range.fromDate, range.toDate);
    console.log(`Stats for "${name}" (${range.fromDate} → ${range.toDate}):`);
    console.table({
      requests: stats.requests,
      errors: stats.errors,
      rate_limited: stats.rateLimited,
      input_tokens: stats.inputTokens,
      output_tokens: stats.outputTokens,
      total_tokens: stats.totalTokens,
      avg_latency_ms: stats.avgLatencyMs,
      last_seen: stats.lastSeen ?? '-',
    });
  });

// stats:keys [--since 7d|YYYY-MM-DD]
program
  .command('stats:keys')
  .description('Show stats for all proxy keys over a date range (default: today only)')
  .option('--since <since>', 'Range start: "Nd" (e.g. 7d) or YYYY-MM-DD')
  .option('-c, --config <path>', 'Path to config file')
  .action(async (options) => {
    const { logStoreFromConfig } = await import('../logger/store.js');
    const { resolveSinceRange } = await import('./since.js');
    const today = new Date().toISOString().slice(0, 10);
    let range: { fromDate: string; toDate: string };
    try {
      range = resolveSinceRange(options.since, today);
    } catch (err: any) {
      console.error(err.message);
      process.exit(1);
    }
    const store = await logStoreFromConfig(options.config);
    const rows = await store.statsAllKeys(range.fromDate, range.toDate);
    if (rows.length === 0) {
      console.log(`No activity between ${range.fromDate} and ${range.toDate}.`);
      return;
    }
    console.log(`Stats by key (${range.fromDate} → ${range.toDate}):`);
    console.table(
      rows.map((r) => ({
        key: r.keyName,
        requests: r.requests,
        errors: r.errors,
        rate_limited: r.rateLimited,
        input: r.inputTokens,
        output: r.outputTokens,
        total: r.totalTokens,
        avg_ms: r.avgLatencyMs,
        last_seen: r.lastSeen ?? '-',
      })),
    );
  });

// usage [--since 7d|YYYY-MM-DD] [--key <name>]
program
  .command('usage')
  .description('Show daily token usage over a date range (default: today only)')
  .option('--since <since>', 'Range start: "Nd" (e.g. 7d) or YYYY-MM-DD')
  .option('-k, --key <name>', 'Filter by proxy key name')
  .option('-c, --config <path>', 'Path to config file')
  .action(async (options) => {
    const { logStoreFromConfig } = await import('../logger/store.js');
    const { resolveSinceRange } = await import('./since.js');
    const today = new Date().toISOString().slice(0, 10);
    let range: { fromDate: string; toDate: string };
    try {
      range = resolveSinceRange(options.since, today);
    } catch (err: any) {
      console.error(err.message);
      process.exit(1);
    }
    const store = await logStoreFromConfig(options.config);
    const rows = await store.dailyUsage(range.fromDate, range.toDate, options.key);
    if (rows.length === 0) {
      console.log(`No usage data between ${range.fromDate} and ${range.toDate}.`);
      return;
    }
    const totalInput = rows.reduce((sum, r) => sum + r.inputTokens, 0);
    const totalOutput = rows.reduce((sum, r) => sum + r.outputTokens, 0);
    const totalCacheRead = rows.reduce((sum, r) => sum + r.cacheReadTokens, 0);
    const totalCacheCreation = rows.reduce((sum, r) => sum + r.cacheCreationTokens, 0);

    const title = options.key
      ? `Daily usage for "${options.key}" (${range.fromDate} → ${range.toDate})`
      : `Daily usage (${range.fromDate} → ${range.toDate})`;
    console.log(title);
    console.table(
      rows.map((r) => ({
        date: r.date,
        requests: r.requests,
        input: r.inputTokens,
        output: r.outputTokens,
        total: r.totalTokens,
        cache_read: r.cacheReadTokens,
        cache_creation: r.cacheCreationTokens,
        avg_ms: r.avgLatencyMs,
      })),
    );
    console.log(
      `Summary: ${totalInput.toLocaleString()} input + ${totalOutput.toLocaleString()} output = ${(totalInput + totalOutput).toLocaleString()} total tokens`,
    );
    if (totalCacheRead > 0 || totalCacheCreation > 0) {
      console.log(`Cache: ${totalCacheRead.toLocaleString()} read + ${totalCacheCreation.toLocaleString()} creation`);
    }
  });

// maintenance:purge --older-than 90d
program
  .command('maintenance:purge')
  .description('Delete request logs older than the given window')
  .option('--older-than <days>', 'Threshold like "90d" or "90"', '90d')
  .option('-c, --config <path>', 'Path to config file')
  .action(async (options) => {
    const m = /^(\d+)d?$/.exec(options.olderThan);
    if (!m) {
      console.error(`invalid --older-than: ${options.olderThan} (expected "Nd" or "N")`);
      process.exit(1);
    }
    const days = Number(m[1]);
    const { logStoreFromConfig } = await import('../logger/store.js');
    const store = await logStoreFromConfig(options.config);
    const deleted = await store.purgeOlderThan(days);
    await store.close?.();
    console.log(`Deleted ${deleted} log row(s) older than ${days} days.`);
  });

// maintenance:vacuum
program
  .command('maintenance:vacuum')
  .description('Reclaim space in the request log database')
  .option('-c, --config <path>', 'Path to config file')
  .action(async (options) => {
    const { logStoreFromConfig } = await import('../logger/store.js');
    const store = await logStoreFromConfig(options.config);
    await store.vacuum();
    await store.close?.();
    console.log('Vacuum complete.');
  });

program.parse(process.argv);
