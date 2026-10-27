'use strict';
// Explicit diagnostic only: exact allowlisted compiled modules, no application source edits.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { createHash } = require('node:crypto');
const COMPILED_PINS = Object.freeze(require('./bounded-business-capacity-pins.json'));
const ALLOWED_COMPILED_SHA256 = Object.freeze(Object.values(COMPILED_PINS));
// Compatibility alias for historical callers; never used as observed runtime metadata.
const COMPILED_SHA256 = COMPILED_PINS.legacy;
const SAMPLE_LIMIT = 128;
let installedProbe;

function makeProbe(limit, compiledSha256 = null) {
  if (compiledSha256 !== null && !ALLOWED_COMPILED_SHA256.includes(compiledSha256))
    throw new Error('CAPACITY_DIAGNOSTIC_SOURCE_PIN');
  if (limit !== 128) throw new Error('CAPACITY_DIAGNOSTIC_REQUIRES_LOCAL_128');
  const pending = new Map();
  const samples = [];
  let current = 0, peak = 0, accepted = 0, settled = 0, rejected = 0, dropped = 0, violations = 0;
  let publicServer;
  const publicSockets = () => Number.isSafeInteger(publicServer?._connections) && publicServer._connections >= 0
    ? publicServer._connections : null;
  function occupancy() {
    let writableEnded = 0, writableFinished = 0;
    const sockets = new Set();
    for (const [response, socket] of pending) {
      if (response.writableEnded) writableEnded++;
      if (response.writableFinished) writableFinished++;
      if (socket) sockets.add(socket);
    }
    return { pendingResponses: pending.size, writableEnded, writableFinished,
      uniqueSockets: sockets.size, publicSocketsCurrent: publicSockets() };
  }
  return {
    accept(response, socket, count) {
      accepted++; current = count; peak = Math.max(peak, count);
      if (pending.has(response) || pending.size >= limit) { violations++; return; }
      pending.set(response, socket);
      if (pending.size !== current) violations++;
    },
    settle(response, count) {
      settled++; current = count;
      if (!pending.delete(response) || pending.size !== current) violations++;
    },
    reject(httpInFlight, closing, requestId) {
      rejected++;
      if (samples.length >= SAMPLE_LIMIT) { dropped++; return; }
      samples.push({ pid: process.pid, monotonicNs: process.hrtime.bigint().toString(),
        requestId, httpInFlight, limit, closing, ...occupancy() });
    },
    attachPublicServer(server) { publicServer = server; },
    snapshot() {
      return { enabled: true, diagnosticOnly: true, performanceAcceptance: false,
        compiledSha256, pid: process.pid, limit, current, peak,
        accepted, settled, rejected, dropped, violations, ...occupancy(), samples: samples.slice(),
        limitations: ['writableEnded/Finished are server states, not client EOF timestamps',
          'publicSocketsCurrent is native local Server._connections or null, not active requests',
          'other-worker occupancy is not synchronized with rejection snapshots'] };
    },
  };
}
function createProbe(limit, compiledSha256) {
  if (!ALLOWED_COMPILED_SHA256.includes(compiledSha256)) throw new Error('CAPACITY_DIAGNOSTIC_SOURCE_PIN');
  if (installedProbe) throw new Error('CAPACITY_DIAGNOSTIC_MULTIPLE_COMPOSITIONS');
  installedProbe = makeProbe(limit, compiledSha256);
  return installedProbe;
}
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('CAPACITY_DIAGNOSTIC_SOURCE_ANCHOR');
  return source.replace(before, after);
}
function transform(source) {
  const compiledSha256 = createHash('sha256').update(source).digest('hex');
  if (!ALLOWED_COMPILED_SHA256.includes(compiledSha256))
    throw new Error('CAPACITY_DIAGNOSTIC_SOURCE_PIN');
  source = replaceOnce(source, '    const maxHttpInFlight = dependencies.maxHttpInFlight;\n',
    '    const maxHttpInFlight = dependencies.maxHttpInFlight;\n' +
    `    const capacityProbe = require(${JSON.stringify(__filename)}).createProbe(maxHttpInFlight, ${JSON.stringify(compiledSha256)});\n`);
  source = replaceOnce(source, '        if (closing && (0, http_handler_js_1.isSaasGatewayInferenceRequest)(req)) {\n',
    '        if (closing && (0, http_handler_js_1.isSaasGatewayInferenceRequest)(req)) {\n' +
    '            capacityProbe.reject(httpInFlight, closing, currentRequestId);\n');
  source = replaceOnce(source, '            if (httpInFlight >= maxHttpInFlight) {\n',
    '            if (httpInFlight >= maxHttpInFlight) {\n' +
    '                capacityProbe.reject(httpInFlight, closing, currentRequestId);\n');
  source = replaceOnce(source, '            httpInFlight += 1;\n            limited = true;\n',
    '            httpInFlight += 1;\n            limited = true;\n' +
    '            capacityProbe.accept(res, req.socket, httpInFlight);\n');
  source = replaceOnce(source, '                httpInFlight -= 1;\n            throw error;',
    '                httpInFlight -= 1;\n            if (limited) capacityProbe.settle(res, httpInFlight);\n            throw error;');
  source = replaceOnce(source, '                httpInFlight -= 1;\n        };\n',
    '                httpInFlight -= 1;\n            if (limited) capacityProbe.settle(res, httpInFlight);\n        };\n');
  return source;
}
function install(dist, env = process.env) {
  if (env.BOUNDED_CLUSTER_CAPACITY_DIAGNOSTIC !== '1') return null;
  if (env.BOUNDED_CLUSTER_DIAGNOSTIC !== '1' || env.BOUNDED_CLUSTER_PROFILE !== 'c200' ||
      env.BOUNDED_CLUSTER_WORKERS !== '2' || env.MODEL_ROUTER_SAAS_GATEWAY_MAX_HTTP_IN_FLIGHT !== '128')
    throw new Error('CAPACITY_DIAGNOSTIC_EXPLICIT_FIXED_PROFILE_REQUIRED');
  // Existing bounded harnesses deliberately reuse an unchanged compiled dist.
  // Node resolves its module filenames through symlinks; match that exact file.
  const filename = fs.realpathSync(path.join(dist, 'server/managed-saas-gateway.js'));
  if (require.cache[filename]) throw new Error('CAPACITY_DIAGNOSTIC_MODULE_ALREADY_LOADED');
  const original = Module._extensions['.js'];
  let loaded = false;
  let loadedSha256;
  const hooked = function (module, name) {
    if (name !== filename) return original(module, name);
    try {
      const source = fs.readFileSync(name, 'utf8');
      const transformed = transform(source);
      loadedSha256 = createHash('sha256').update(source).digest('hex');
      module._compile(transformed, name); loaded = true;
    }
    finally { Module._extensions['.js'] = original; }
  };
  Module._extensions['.js'] = hooked;
  return {
    proof() {
      if (!loaded || !installedProbe || Module._extensions['.js'] !== original)
        throw new Error('CAPACITY_DIAGNOSTIC_INSTALL_UNPROVEN');
      if (installedProbe.snapshot().compiledSha256 !== loadedSha256)
        throw new Error('CAPACITY_DIAGNOSTIC_SOURCE_PROOF_MISMATCH');
      return { enabled: true, compiledSha256: loadedSha256 };
    },
    snapshot() { this.proof(); return installedProbe.snapshot(); },
    attachPublicServer(server) { this.proof(); installedProbe.attachPublicServer(server); },
  };
}
module.exports = { COMPILED_PINS, ALLOWED_COMPILED_SHA256, COMPILED_SHA256, SAMPLE_LIMIT, makeProbe, createProbe, transform, install };
