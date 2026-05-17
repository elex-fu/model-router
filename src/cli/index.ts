#!/usr/bin/env node
import { Command } from 'commander';
import { ConfigStore } from '../config/store.js';
import { DEFAULT_CONFIG_PATH } from '../utils/paths.js';
import { generateProxyKey } from '../utils/generate-key.js';
import { parseCreateOptions, applyUpdateOptions } from './key-options.js';

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
  .option('-b, --bind <address>', 'Address to bind (default: 127.0.0.1)')
  .option('--max-body-size <size>', 'Max request body size (e.g. 4mb, 1024)')
  .option('--trust-proxy', 'Honor X-Forwarded-For (only when behind a trusted reverse proxy)')
  .option('--daemon', 'Run in background; requires --pid-file (and usually --log-file)')
  .option('--log-file <path>', 'Daemon stdout/stderr log file')
  .option('--pid-file <path>', 'Daemon PID file')
  .option('-c, --config <path>', 'Path to config file')
  .action(async (options) => {
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
  .action((name, options) => {
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
  .action((name, options) => {
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
  .action((name, options) => {
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
  .action((name, options) => {
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
  .action((name, options) => {
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
      })
    );
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
  .command('upstream:add <name> <provider> <protocol> <baseUrl> <apiKeys>')
  .description('Add a new upstream')
  .option('-m, --models <models>', 'Comma-separated list of models')
  .option('--map <entries>', 'Comma-separated modelMap entries: pattern=target,...')
  .option('-c, --config <path>', 'Path to config file')
  .action((name, provider, protocol, baseUrl, apiKeys, options) => {
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
      apiKeys: apiKeys.split(',').map((s: string) => s.trim()).filter(Boolean),
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

// chat
program
  .command('chat <model> [message]')
  .description('Send a chat request through the local proxy to verify end-to-end routing')
  .option('--stream', 'Use streaming mode')
  .option('--protocol <protocol>', 'Client protocol (anthropic|openai)', 'anthropic')
  .option('--key <key>', 'Proxy key to use (defaults to first enabled key)')
  .option('-c, --config <path>', 'Path to config file')
  .action(async (model, message, options) => {
    const store = getStore(options);
    const cfg = store.load();
    const bind = cfg.server.bindAddress ?? '127.0.0.1';
    const port = cfg.server.port ?? 15005;
    const baseUrl = `http://${bind}:${port}`;

    const protocol = options.protocol;
    if (protocol !== 'anthropic' && protocol !== 'openai') {
      console.error('--protocol must be "anthropic" or "openai"');
      process.exit(1);
    }

    let proxyKey: string = options.key;
    if (!proxyKey) {
      const keys = store.listProxyKeys().filter((k) => k.enabled);
      if (keys.length === 0) {
        console.error('No enabled proxy keys found. Create one with key:create or pass --key');
        process.exit(1);
      }
      proxyKey = keys[0].key;
    } else {
      const found = store.listProxyKeys().find((k) => k.key === proxyKey || k.name === proxyKey);
      if (!found) {
        console.error(`Proxy key "${options.key}" not found`);
        process.exit(1);
      }
      proxyKey = found.key;
    }

    const userMessage = message ?? 'Hello, can you hear me?';
    const url = protocol === 'anthropic'
      ? `${baseUrl}/v1/messages`
      : `${baseUrl}/v1/chat/completions`;

    const body = protocol === 'anthropic'
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
        const reader = res.body?.getReader();
        if (!reader) {
          console.error('No response body');
          process.exit(1);
        }
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;
            const data = trimmed.slice(6);
            if (data === '[DONE]') continue;
            try {
              const chunk = JSON.parse(data);
              if (protocol === 'anthropic') {
                if (chunk.type === 'content_block_delta' && chunk.delta?.text) {
                  process.stdout.write(chunk.delta.text);
                }
              } else {
                const delta = chunk.choices?.[0]?.delta?.content;
                if (delta) process.stdout.write(delta);
              }
            } catch {
              // ignore non-JSON lines
            }
          }
        }
        console.log('');
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
    let range;
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
    let range;
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
      }))
    );
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
