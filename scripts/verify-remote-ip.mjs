#!/usr/bin/env node
import fs from 'node:fs';
import https from 'node:https';
import { isIP } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.some((arg) => !['--smoke', '--help'].includes(arg))) {
  console.error('Usage: node scripts/verify-remote-ip.mjs [--smoke]');
  process.exit(1);
}
if (args.includes('--help')) {
  console.log('Read deploy/remote-client.local.env; verify HTTPS health and authentication. --smoke adds one real kimi-k2.6 request (max_tokens=32).');
  process.exit(0);
}

async function main() {
  const config = new Map();
  for (const line of fs.readFileSync(resolve(root, 'deploy/remote-client.local.env'), 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error('Invalid local client configuration');
    config.set(line.slice(0, separator), line.slice(separator + 1));
  }
  const base = new URL(config.get('MODEL_ROUTER_BASE_URL'));
  const hostname = base.hostname.replace(/^\[|\]$/g, '');
  if (base.protocol !== 'https:' || !isIP(hostname) || base.username || base.password || base.search || base.hash) {
    throw new Error('Client configuration must name an HTTPS IP endpoint');
  }
  const key = config.get('MODEL_ROUTER_API_KEY');
  const certificate = config.get('MODEL_ROUTER_CA_CERT');
  if (!key || !certificate) throw new Error('Client API key and trusted IP certificate are required');
  const agent = new https.Agent({ ca: fs.readFileSync(resolve(root, certificate)), keepAlive: true });

  async function check(path, { authenticated = false, expected = 200, body } = {}) {
    const started = performance.now();
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const result = await new Promise((accept, reject) => {
      const request = https.request({
        hostname,
        port: base.port || 443,
        path,
        method: payload ? 'POST' : 'GET',
        agent,
        headers: {
          ...(authenticated ? { Authorization: `Bearer ${key}` } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      }, (response) => {
        let text = '';
        response.on('data', (chunk) => {
          text += chunk;
          if (text.length > 65_536) response.destroy(new Error('Response exceeds verification limit'));
        });
        response.on('error', reject);
        response.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(text); } catch { /* Never print response bodies. */ }
          accept({
            path,
            authenticated,
            status: response.statusCode,
            totalMs: Math.round((performance.now() - started) * 100) / 100,
            ...(payload ? { hasText: typeof parsed?.choices?.[0]?.message?.content === 'string' && parsed.choices[0].message.content.length > 0 } : {}),
          });
        });
      });
      request.on('error', reject);
      request.setTimeout(90_000, () => request.destroy(new Error('Verification timed out')));
      request.end(payload);
    });
    console.log(JSON.stringify(result));
    if (result.status !== expected || (payload && !result.hasText)) throw new Error('IP verification failed');
  }

  try {
    const apiPath = base.pathname.replace(/\/$/, '');
    await check('/healthz');
    await check(`${apiPath}/models`, { expected: 401 });
    await check(`${apiPath}/models`, { authenticated: true });
    if (args.includes('--smoke')) {
      await check(`${apiPath}/chat/completions`, {
        authenticated: true,
        body: { model: 'kimi-k2.6', messages: [{ role: 'user', content: 'Reply with exactly OK.' }], max_tokens: 32, stream: false, thinking: { type: 'disabled' } },
      });
    }
  } finally {
    agent.destroy();
  }
}

main().catch((error) => {
  // Avoid printing configuration, request headers, or response bodies on errors.
  console.error(`IP verification failed: ${error.code ?? error.name ?? 'unknown_error'}`);
  process.exitCode = 1;
});
