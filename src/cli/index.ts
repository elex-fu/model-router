#!/usr/bin/env node
import { Command } from 'commander';
import { ConfigStore } from '../config/store.js';
import { DEFAULT_CONFIG_PATH } from '../utils/paths.js';
import { generateProxyKey } from '../utils/generate-key.js';

const program = new Command();

program.name('model-router').description('Lightweight AI model proxy').version('0.1.0');

function getStore(options: { config?: string }) {
  return new ConfigStore(options.config ?? DEFAULT_CONFIG_PATH);
}

// start
program
  .command('start')
  .description('Start the proxy server')
  .option('-p, --port <port>', 'Server port', parseInt)
  .option('-c, --config <path>', 'Path to config file')
  .action(async (options) => {
    const { startServer } = await import('../server/index.js');
    await startServer(options.port, options.config);
  });

// key create
program
  .command('key:create <name>')
  .description('Create a new proxy key')
  .option('-c, --config <path>', 'Path to config file')
  .action((name, options) => {
    const store = getStore(options);
    const key = generateProxyKey();
    store.addProxyKey({
      name,
      key,
      enabled: true,
      createdAt: new Date().toISOString(),
    });
    console.log(`Created proxy key: ${name}`);
    console.log(`Key: ${key}`);
  });

// key list
program
  .command('key:list')
  .description('List all proxy keys')
  .option('-c, --config <path>', 'Path to config file')
  .action((options) => {
    const store = getStore(options);
    const keys = store.listProxyKeys();
    if (keys.length === 0) {
      console.log('No proxy keys found.');
      return;
    }
    console.table(keys.map((k) => ({ name: k.name, key: k.key, enabled: k.enabled, createdAt: k.createdAt })));
  });

// key delete
program
  .command('key:delete <name>')
  .description('Delete a proxy key')
  .option('-c, --config <path>', 'Path to config file')
  .action((name, options) => {
    const store = getStore(options);
    store.deleteProxyKey(name);
    console.log(`Deleted proxy key: ${name}`);
  });

// upstream add
program
  .command('upstream:add <name> <provider> <protocol> <baseUrl> <apiKey>')
  .description('Add a new upstream')
  .option('-m, --models <models>', 'Comma-separated list of models')
  .option('-c, --config <path>', 'Path to config file')
  .action((name, provider, protocol, baseUrl, apiKey, options) => {
    const store = getStore(options);
    const models = options.models ? String(options.models).split(',').map((s: string) => s.trim()) : [];
    if (protocol !== 'anthropic' && protocol !== 'openai') {
      console.error('Protocol must be "anthropic" or "openai"');
      process.exit(1);
    }
    store.addUpstream({
      name,
      provider,
      protocol,
      baseUrl,
      apiKey,
      models,
      enabled: true,
    });
    console.log(`Created upstream: ${name}`);
  });

// upstream list
program
  .command('upstream:list')
  .description('List all upstreams')
  .option('-c, --config <path>', 'Path to config file')
  .action((options) => {
    const store = getStore(options);
    const upstreams = store.listUpstreams();
    if (upstreams.length === 0) {
      console.log('No upstreams found.');
      return;
    }
    console.table(
      upstreams.map((u) => ({
        name: u.name,
        provider: u.provider,
        protocol: u.protocol,
        baseUrl: u.baseUrl,
        models: u.models.join(', '),
        enabled: u.enabled,
      }))
    );
  });

// upstream delete
program
  .command('upstream:delete <name>')
  .description('Delete an upstream')
  .option('-c, --config <path>', 'Path to config file')
  .action((name, options) => {
    const store = getStore(options);
    store.deleteUpstream(name);
    console.log(`Deleted upstream: ${name}`);
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
      }))
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

program.parse(process.argv);
