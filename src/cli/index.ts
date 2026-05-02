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
  .option('--map <entries>', 'Comma-separated modelMap entries: pattern=target,...')
  .option('-c, --config <path>', 'Path to config file')
  .action((name, provider, protocol, baseUrl, apiKey, options) => {
    const store = getStore(options);
    const models = options.models ? String(options.models).split(',').map((s: string) => s.trim()) : [];
    if (protocol !== 'anthropic' && protocol !== 'openai') {
      console.error('Protocol must be "anthropic" or "openai"');
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
      apiKey,
      models,
      enabled: true,
      ...(modelMap ? { modelMap } : {}),
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
        modelMap: u.modelMap ? Object.keys(u.modelMap).length : 0,
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

// upstream map set
program
  .command('upstream:map:set <upstream> <pattern> <target>')
  .description('Add or update a modelMap entry on an upstream')
  .option('-c, --config <path>', 'Path to config file')
  .action((upstream, pattern, target, options) => {
    const store = getStore(options);
    store.setModelMapEntry(upstream, pattern, target);
    console.log(`Set ${upstream}: ${pattern} → ${target}`);
  });

// upstream map delete
program
  .command('upstream:map:delete <upstream> <pattern>')
  .description('Delete a modelMap entry on an upstream')
  .option('-c, --config <path>', 'Path to config file')
  .action((upstream, pattern, options) => {
    const store = getStore(options);
    store.deleteModelMapEntry(upstream, pattern);
    console.log(`Deleted ${upstream}: ${pattern}`);
  });

// upstream map list
program
  .command('upstream:map:list <upstream>')
  .description('List modelMap entries for an upstream')
  .option('-c, --config <path>', 'Path to config file')
  .action((upstream, options) => {
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
    const store = getStore(options);
    const u = store.getUpstream(upstreamName);
    if (!u) {
      console.error(`Upstream "${upstreamName}" not found`);
      process.exit(1);
    }
    const probeModel: string =
      options.model ??
      u.models[0] ??
      (u.modelMap ? Object.values(u.modelMap)[0] : undefined);
    if (!probeModel) {
      console.error(
        `Upstream "${upstreamName}" has no models or modelMap; pass --model <name> to probe`
      );
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
          authorization: `Bearer ${u.apiKey}`,
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
      console.log(
        `${upstreamName} ${u.baseUrl} model=${probeModel}: ${res.status} in ${ms}ms`
      );
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
