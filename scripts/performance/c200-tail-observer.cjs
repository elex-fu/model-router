'use strict';
// Diagnostic-only passive taps. No request bodies, SQL parameters, raw errors,
// authority helpers, journal methods or currentRequestDiagnosticTrace are used.
function safe(fn, ...args) { try { return fn(...args); } catch { return undefined; } }
function observeReturn(value, onDone) {
  if (value && typeof value.then === 'function') {
    // Both handlers return normally. The caller receives the ORIGINAL promise.
    value.then(v => { safe(onDone, null, v); }, e => { safe(onDone, e); });
  } else safe(onDone, null, value);
  return value;
}
function tap(fn, before, after) {
  return function(...args) {
    const state = safe(before, this, args);
    let value;
    try { value = fn.apply(this, args); }
    catch (error) { safe(after, state, error); throw error; }
    return observeReturn(value, (error, result) => safe(after, state, error, result));
  };
}
function callbackTap(fn, observe) {
  return function(...args) { safe(observe, ...args); return fn.apply(this, args); };
}
function passiveEmitTap(proto, observe) {
  const original = proto.emit;
  proto.emit = function(event, ...args) {
    safe(observe, this, event, args);
    return original.call(this, event, ...args);
  };
}
function driverTap(proto, name, describe, finish, bindCallback) {
  const original = proto[name];
  proto[name] = function(...args) {
    const receiver = this, row = safe(describe, receiver, args);
    const done = (error, value) => safe(finish, row, receiver, error, value);
    const last = args.length - 1;
    if (typeof args[last] === 'function') {
      const callback = callbackTap(args[last], done);
      args[last] = bindCallback ? (safe(bindCallback, callback) ?? callback) : callback;
      try { return original.apply(receiver, args); } catch (error) { done(error); throw error; }
    }
    // Unknown config.callback completion is not worth changing object identity.
    if (args[0] && typeof args[0] === 'object' && typeof args[0].callback === 'function') {
      if (row) row.completionUnknownCallbackOverload = true;
      return original.apply(receiver, args);
    }
    let value; try { value = original.apply(receiver, args); } catch (error) { done(error); throw error; }
    return observeReturn(value, done);
  };
}
module.exports = { observeReturn, tap, callbackTap, driverTap, passiveEmitTap };

if (process.env.R9_TEST_DIST && process.env.PAIR_REQUEST_OBSERVER) install();
function install() {
  const { AsyncLocalStorage } = require('node:async_hooks');
  const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
  const { createHash } = require('node:crypto');
  const { createRequire } = require('node:module');
  const dc = require('node:diagnostics_channel');
  const fs = require('node:fs');
  const path = require('node:path');
  const http = require('node:http');
  const net = require('node:net');
  const requireSource = createRequire(path.join(process.env.R9_TEST_DIST, '../package.json'));
  const { Client, Pool } = requireSource('pg');
  const httpContext = new AsyncLocalStorage(), spanContext = new AsyncLocalStorage();
  const epoch = performance.now(), epochWall = Date.now();
  const events = [], requests = [], markers = [], caches = new Set();
  const inboundSockets = new WeakMap(), inboundConnections = [];
  const inboundConnectionLimit = 4096;
  let inboundConnectionSerial = 0, inboundConnectionDrops = 0;
  const limit = 250000, requestLimit = 12000;
  let drops = 0, requestDrops = 0, serial = 0, phase = 'warm', signalCount = 0;
  const clientIds = new WeakMap(), poolIds = new WeakMap(), workIds = new WeakMap();
  const sockets = new WeakMap(), liveSockets = new Set(), connectors = new WeakMap(), undiciRequests = new WeakMap();
  let clientSerial = 0, poolSerial = 0, workSerial = 0, socketSerial = 0;
  const output = path.join(path.dirname(process.env.PAIR_REQUEST_OBSERVER), 'passive-tail-observer.json');
  const ready = path.join(path.dirname(output), 'passive-tail-phase.json');
  const now = () => performance.now() - epoch;
  function clockCalibration() {
    const monotonicBeforeMs = now(), wallMs = Date.now(), monotonicAfterMs = now();
    return { wallMs, monotonicBeforeMs, monotonicAfterMs, wallQuantizationMs: 1 };
  }
  function clockAnchor() {
    const monotonicBeforeNs = process.hrtime.bigint().toString();
    const wallUnixNs = (BigInt(Date.now()) * 1000000n).toString();
    const monotonicAfterNs = process.hrtime.bigint().toString();
    return { monotonicBeforeNs, wallUnixNs, monotonicAfterNs, wallResolutionNs: '1000000', monotonicSource: 'process.hrtime.bigint' };
  }
  const number = x => typeof x === 'number' && Number.isFinite(x) ? x : null;
  function id(map, object, next) { if (!map.has(object)) map.set(object, next()); return map.get(object); }
  function begin(kind, extra = {}) {
    const row = { id: ++serial, kind, phase, startMs: now(), http: httpContext.getStore()?.id ?? null, parent: spanContext.getStore()?.id ?? null, httpAlreadyFinishedAtStart: httpContext.getStore()?.endMs !== undefined, ...extra };
    if (events.length < limit) events.push(row); else drops++;
    return row;
  }
  function end(row, error) { row.endMs = now(); row.durationMs = row.endMs - row.startMs; row.ok = !error; }
  function poolState(pool) { return { total: number(pool.totalCount), idle: number(pool.idleCount), waiting: number(pool.waitingCount), max: number(pool.options?.max) }; }
  function hashRequest(value) { return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? createHash('sha256').update(value).digest('hex') : null; }
  function headroom(entry) {
    // Approximation only. Never call remaining/live/rejection/wall/mono helpers.
    return entry ? { monotonicRemainingApproxMs: number(entry.until - performance.now()), wallRemainingApproxMs: number(entry.wallUntil - Date.now()) } : null;
  }
  function cacheState(cache) { return { entries: cache.entries?.size ?? null, pending: cache.pending?.size ?? null, minimumValidity: number(cache.minimumValidity), refreshAhead: number(cache.refreshAhead), ttl: number(cache.ttl), headrooms: cache.entries ? Array.from(cache.entries.values(), headroom) : [] }; }
  function mark(name) {
    markers.push({ name, atMs: now(), epochMs: Date.now(), clockCalibration: clockCalibration(), clockAnchor: clockAnchor(), openInferenceSockets: Array.from(liveSockets).filter(x => x.inference).length, openObservedSockets: liveSockets.size, inboundConnections: inboundConnectionSerial, caches: Array.from(caches, cacheState) });
    fs.writeFileSync(ready, JSON.stringify({ phase: name, atMs: now() }) + '\n', { mode: 0o600 });
  }
  // Observe only events the application already emits. In particular, NEVER
  // add a data/readable listener or call read/resume/pause: that changes flow.
  // Node's native HTTP parser may bypass Socket.emit('data'); absence is UNKNOWN.
  passiveEmitTap(net.Socket.prototype, (socket, event) => {
    const row = inboundSockets.get(socket);
    if (!row) return;
    if (event === 'data') {
      const atMs = now();
      row.firstObservableDataMs ??= atMs;
      row.firstObservableDataMonotonicNs ??= process.hrtime.bigint().toString();
      row.lastObservableDataMs = atMs;
      row.observableDataEvents++;
      row.dataObservation = 'observed_socket_emit_data';
    } else if (event === 'close') { row.closedAtMs = now(); row.closedMonotonicNs = process.hrtime.bigint().toString(); }
  });
  passiveEmitTap(http.Server.prototype, (_server, event, args) => {
    if (event !== 'connection' || !args[0] || typeof args[0] !== 'object') return;
    const socket = args[0];
    if (inboundSockets.has(socket)) return;
    const row = { id: ++inboundConnectionSerial, phase, connectionEventMs: now(), connectionEventMonotonicNs: process.hrtime.bigint().toString(), dataObservation: 'unknown_no_socket_emit_data_observed', observableDataEvents: 0, httpRequests: 0 };
    inboundSockets.set(socket, row);
    if (inboundConnections.length < inboundConnectionLimit) inboundConnections.push(row);
    else inboundConnectionDrops++;
  });
  const emit = http.Server.prototype.emit;
  http.Server.prototype.emit = function(event, ...args) {
    if (event !== 'request' || args[0]?.url !== '/v1/chat/completions') return emit.call(this, event, ...args);
    const [req, res] = args, inbound = inboundSockets.get(req.socket);
    if (inbound) { inbound.httpRequests++; inbound.firstHttpRequestMs ??= now(); }
    const row = { id: requests.length + requestDrops + 1, phase, startMs: now(), startMonotonicNs: process.hrtime.bigint().toString(), inboundSocket: inbound?.id ?? null, inboundSocketRequestSequence: inbound?.httpRequests ?? null, inboundConnectionEventMs: inbound?.connectionEventMs ?? null, inboundFirstObservableDataMs: inbound?.firstObservableDataMs ?? null, inboundDataObservation: inbound?.dataObservation ?? 'unknown_socket_not_observed' };
    if (requests.length < requestLimit) requests.push(row); else requestDrops++;
    let finished = false;
    const finish = terminal => safe(() => { if (finished) return; finished = true; row.endMs = now(); row.endMonotonicNs = process.hrtime.bigint().toString(); row.durationMs = row.endMs - row.startMs; row.status = res.statusCode; row.terminal = terminal; row.requestHash = hashRequest(res.getHeader('x-request-id')); });
    res.once('finish', () => finish('finish')); res.once('close', () => finish('close'));
    return httpContext.run(row, () => emit.call(this, event, ...args));
  };
  function queryKind(sql) {
    if (/fast-journal:reserve-intent|WITH current_owner AS MATERIALIZED/.test(sql)) return 'intent';
    if (/fast-journal:append-receipt|WITH receipt AS/.test(sql)) return 'receipt';
    if (sql.startsWith('SELECT set_config')) return 'tenant_context';
    if (/REPEATABLE READ READ ONLY/.test(sql)) return 'snapshot_rr_setup';
    if (/SELECT transaction_timestamp/.test(sql)) return 'snapshot_anchor';
    if (/SELECT support_level, validation_state, protocol/.test(sql)) return 'runtime_compatibility';
    if (/SELECT account.provider_id,account.product_id,account.credential_type/.test(sql)) return 'runtime_credential_header';
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) return sql.trim().split(/\s+/)[0].toLowerCase();
    if (/fast-journal:worker-claim|SELECT intent_id FROM saas_fast_billing_jobs/.test(sql)) return 'worker_claim';
    if (/SET CONSTRAINTS/.test(sql)) return 'worker_balance';
    if (/saas_fast_billing_jobs|saas_ledger_|saas_wallets|saas_fast_credit_allocations/.test(sql)) return 'financial_background';
    return 'other';
  }
  function driverWrap(proto, name, describe, restoreObserverContext = false) {
    driverTap(proto, name, describe, (row, receiver, error, value) => {
      end(row, error);
      if (name === 'connect' && receiver instanceof Pool) {
        row.poolAfter = poolState(receiver);
        if (value && typeof value === 'object') row.client = id(clientIds, value, () => ++clientSerial);
      }
    }, restoreObserverContext ? callback => {
      const capturedHttp = httpContext.getStore(), capturedSpan = spanContext.getStore();
      return function(...args) {
        const receiver = this;
        return httpContext.run(capturedHttp, () => spanContext.run(capturedSpan, () => callback.apply(receiver, args)));
      };
    } : undefined);
  }
  driverWrap(Pool.prototype, 'connect', pool => begin('pool_checkout_including_connect', { pool: id(poolIds, pool, () => ++poolSerial), poolBefore: poolState(pool) }), true);
  driverWrap(Client.prototype, 'connect', client => begin('pg_connection', { client: id(clientIds, client, () => ++clientSerial) }));
  driverWrap(Client.prototype, 'query', (client, args) => begin('driver_query_roundtrip', { client: id(clientIds, client, () => ++clientSerial), sqlClass: queryKind(typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '') }));
  function spanMethod(object, name, kind, before) {
    const original = object[name];
    if (typeof original !== 'function') throw new Error('Diagnostic method missing');
    object[name] = function(...args) {
      const row = begin(kind, safe(before ?? (() => ({})), this, args) ?? {});
      return spanContext.run(row, () => {
        let value; try { value = original.apply(this, args); } catch (error) { end(row, error); throw error; }
        if (value && typeof value.then === 'function') row.work = id(workIds, value, () => ++workSerial);
        return observeReturn(value, error => end(row, error));
      });
    };
  }
  const snap = require(path.join(process.env.R9_TEST_DIST, 'saas/gateway/fast/snapshots.js'));
  spanMethod(snap.CachedFastGatewaySnapshots.prototype, 'resolve', 'snapshot_resolve', cache => { caches.add(cache); return { pendingAtStart: cache.pending.size, entriesAtStart: cache.entries.size }; });
  spanMethod(snap.CachedFastGatewaySnapshots.prototype, 'startLoad', 'snapshot_load_or_join', (cache, args) => ({ joinedExisting: cache.pending.has(args[0]), bypassL2: args[2] === true, entryHeadroom: headroom(cache.entries.get(args[0])) }));
  spanMethod(snap.CachedFastGatewaySnapshots.prototype, 'use', 'snapshot_use', (_cache, args) => ({ entryHeadroom: headroom(args[0]) }));
  for (const [file, factoryName, kind] of [
    ['postgres-snapshot-loader.js', 'createPostgresFastGatewaySnapshotLoader', 'snapshot_pg_loader'],
    ['runtime-snapshot.js', 'createRuntimeFastGatewaySnapshotSource', 'snapshot_runtime_source'],
  ]) {
    const mod = require(path.join(process.env.R9_TEST_DIST, 'saas/gateway/fast', file));
    const factory = mod[factoryName];
    mod[factoryName] = function(...args) { const source = factory.apply(this, args); spanMethod(source, 'resolve', kind); return source; };
  }
  const fetch = globalThis.fetch;
  globalThis.fetch = function(...args) {
    const input = args[0], url = typeof input === 'string' ? input : input?.url ?? '';
    if (!/^https:\/\/127\.0\.0\.1:\d+\/v1\/chat\/completions$/.test(url)) return fetch.apply(this, args);
    const row = begin('upstream_fetch_until_headers');
    return spanContext.run(row, () => { let value; try { value = fetch.apply(this, args); } catch (error) { end(row, error); throw error; } return observeReturn(value, error => end(row, error)); });
  };
  function subscribe(name, callback) { dc.channel(name).subscribe(value => safe(callback, value)); }
  subscribe('undici:request:create', ({ request }) => { undiciRequests.set(request, { http: httpContext.getStore()?.id ?? null, parent: spanContext.getStore()?.id ?? null }); });
  subscribe('undici:client:beforeConnect', ({ connector }) => { if (connector && typeof connector === 'function') { const queue = connectors.get(connector) ?? []; const row = begin('upstream_connection_including_TLS', { ambiguousConnectorOverlap: queue.length > 0 }); for (const pending of queue) pending.ambiguousConnectorOverlap = true; queue.push(row); connectors.set(connector, queue); } });
  subscribe('undici:client:connected', ({ connector, socket }) => {
    const queue = connectors.get(connector); const row = queue?.shift(); if (row) { end(row, null); if (!queue.length) connectors.delete(connector); }
    let state = sockets.get(socket);
    if (!state) { state = { id: ++socketSerial, inference: false, connectionEvent: row?.id ?? null }; sockets.set(socket, state); liveSockets.add(state); socket.once('close', () => safe(() => { liveSockets.delete(state); begin('upstream_socket_closed', { socket: state.id }); })); }
    if (row) row.socket = state.id;
  });
  subscribe('undici:client:connectError', ({ connector }) => { const queue = connectors.get(connector); const row = queue?.shift(); if (row) { end(row, true); if (!queue.length) connectors.delete(connector); } });
  subscribe('undici:client:sendHeaders', ({ request, socket }) => {
    if (request.path !== '/v1/chat/completions') return;
    const association = undiciRequests.get(request), state = sockets.get(socket); if (state) state.inference = true;
    begin('upstream_send_headers', { http: association?.http ?? null, parent: association?.parent ?? null, socket: state?.id ?? null, connectionEvent: state?.connectionEvent ?? null });
  });
  const histogram = monitorEventLoopDelay({ resolution: 10 }); histogram.enable();
  let previous = performance.now(), cpu = process.cpuUsage();
  const timer = setInterval(() => safe(() => { const time = performance.now(), next = process.cpuUsage(); begin('event_loop_cpu', { gapMs: time - previous, delayMaxMs: histogram.max / 1e6, cpuMs: (next.user - cpu.user + next.system - cpu.system) / 1000, heapUsed: process.memoryUsage().heapUsed }); histogram.reset(); previous = time; cpu = next; }), 50); timer.unref();
  process.on('SIGWINCH', () => safe(() => {
    signalCount++;
    if (signalCount === 1) { mark('warm_complete'); phase = 'gap'; }
    else if (signalCount === 2) { phase = 'diagnostic'; mark('diagnostic_start'); }
    else {
      phase = 'complete'; mark('diagnostic_complete');
      const temporary = output + '.tmp'; fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 2, diagnosticOnly: true, originalPromisesReturned: true, policyHelpersNotCalled: true, epochWall, drops, requestDrops, limit, inboundConnectionLimit, inboundConnectionDrops, inboundConnections, events, requests, markers, limits: ['checkout includes connection acquisition; driver span is not pure PostgreSQL execution', 'headroom uses independent clocks; approximate, never authority', 'connection span includes connector/TLS acquisition, not pure TLS handshake', 'inbound connection means Node connection event, not kernel accept timestamp', 'Socket.emit data is passive and may be bypassed by native parsing; absence is unknown, not absent bytes', 'wall anchors are bracketed by independent monotonic readings with 1ms wall quantization', 'all observations add overhead; no performance acceptance claim', 'no journal/runOnce wrappers or diagnostic trace activation'] }) + '\n', { mode: 0o600 }); fs.renameSync(temporary, output);
    }
  }));
  mark('installed');
}
