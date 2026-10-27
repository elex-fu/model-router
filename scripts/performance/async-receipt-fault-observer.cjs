'use strict';

// Functional fault injection only. Never preload this in a performance scene.
// The real SQL executes unchanged. A hold delays its invocation; ACK loss hides
// a real successful driver result. Journal/queue/runOnce are never wrapped.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');

function sqlKind(text) {
  if (text.includes('fast-journal:append-receipt')) return 'receipt';
  if (text.includes('fast-journal:reserve-intent')) return 'intent';
  if (text.includes('fast-journal:worker-claim')) return 'worker_claim';
  if (text.includes('fast-journal:worker-credit')) return 'worker_credit';
  if (/^\s*SELECT receipt_digest FROM saas_fast_gateway_receipts/.test(text)) return 'receipt_lookup';
  return null;
}
function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}
function inspectQuery(args) {
  const config = args[0];
  const text = typeof config === 'string' ? config : config?.text ?? '';
  const kind = sqlKind(text);
  const values = Array.isArray(args[1]) ? args[1] : config?.values;
  return {
    kind,
    identityHash: ['receipt', 'intent', 'receipt_lookup'].includes(kind) && typeof values?.[0] === 'string'
      ? digest(values[0]) : null,
    // Hash the full immutable SQL input, but never record its content.
    inputHash: kind === 'receipt' && Array.isArray(values) ? digest(JSON.stringify(values)) : null,
  };
}
function createObserver(options = {}) {
  const io = options.io ?? fs;
  const markerDirectory = options.markerDirectory;
  const output = options.output;
  const maxEvents = options.maxEvents ?? 10000;
  const timeoutMs = options.timeoutMs ?? 30000;
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  if (!path.isAbsolute(markerDirectory ?? '') || !path.isAbsolute(output ?? '')) {
    throw new Error('ASYNC_RECEIPT_FAULT_ABSOLUTE_PATHS_REQUIRED');
  }
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 100000) {
    throw new Error('ASYNC_RECEIPT_FAULT_EVENT_BOUND_INVALID');
  }
  const events = [];
  let dropped = 0;
  let nextQuery = 0;
  let nextHttp = 0;
  function record(phase, fields = {}) {
    try {
      if (events.length >= maxEvents) { dropped++; return; }
      events.push({ phase, monotonicMs: now(), wallMs: Date.now(), ...fields });
    } catch { /* Observation must not alter successful application behavior. */ }
  }
  function snapshot() {
    return {
      schemaVersion: 1,
      functionalFaultOnly: true,
      eventLimit: maxEvents,
      dropped,
      events: events.slice(),
      definitions: {
        query_driver_ack: 'Real driver result; may subsequently be hidden from application by this injector.',
        http_finish: 'Node response finish, not an external client EOF observation.',
        before_sql_hold: 'Actual query has not been invoked, not a delayed SQL acknowledgement.',
        receipt_input_hash: 'SHA256 of complete SQL parameter array; raw parameters never emitted.',
        absent_queue_accepted: 'No queue hook is installed; queue acceptance is not inferred from SQL timestamps.',
      },
    };
  }
  function dump() {
    const temporary = `${output}.tmp`;
    io.writeFileSync(temporary, `${JSON.stringify(snapshot())}\n`, { mode: 0o600 });
    io.renameSync(temporary, output);
  }
  function held(kind) {
    const control = kind === 'receipt' ? 'receipt-before-sql' : kind === 'worker_claim' ? 'worker-before-claim' : null;
    return control && io.existsSync(path.join(markerDirectory, `${control}.hold`)) ? control : null;
  }
  function claimAckLoss(kind) {
    if (kind !== 'receipt' && kind !== 'intent') return false;
    const marker = path.join(markerDirectory, `${kind}-ack-loss.once`);
    if (!io.existsSync(marker)) return false;
    try { io.renameSync(marker, `${marker}.used`); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  async function waitForRelease(control, event) {
    record('before_sql_hold', { ...event, control });
    io.writeFileSync(path.join(markerDirectory, `${control}.waiting`), 'waiting\n', { mode: 0o600 });
    dump();
    const deadline = now() + timeoutMs;
    while (io.existsSync(path.join(markerDirectory, `${control}.hold`))) {
      if (now() >= deadline) throw new Error('ASYNC_RECEIPT_FAULT_HOLD_TIMEOUT');
      await sleep(5);
    }
    record('before_sql_released', { ...event, control });
  }
  function wrapQuery(original) {
    return function (...args) {
      const info = inspectQuery(args);
      if (!info.kind) return original.apply(this, args);
      const event = { query: ++nextQuery, ...info };
      const control = held(info.kind);
      const loseAck = claimAckLoss(info.kind);
      const receiver = this;
      function settled(error) {
        record(error ? 'query_driver_error' : 'query_driver_ack', event);
        if (!error && loseAck) {
          record('ack_loss_injected', event);
          const failure = new Error('ASYNC_RECEIPT_TEST_ACK_LOSS');
          failure.code = 'ECONNRESET';
          return failure;
        }
        return error;
      }
      const callbackIndex = args.length - 1;
      if (typeof args[callbackIndex] === 'function') {
        const callback = args[callbackIndex];
        args[callbackIndex] = function (error, result) {
          const fault = settled(error);
          return callback.call(this, fault, fault ? undefined : result);
        };
        const invoke = () => { record('query_driver_start', event); return original.apply(receiver, args); };
        if (!control) return invoke();
        // pg-pool callback query path ignores Client.query's return value.
        // Deliberate pre-SQL fault cannot return a not-yet-created Query object.
        void waitForRelease(control, event).then(invoke, (error) => callback.call(receiver, error));
        return undefined;
      }
      const invoke = () => {
        record('query_driver_start', event);
        const result = original.apply(receiver, args);
        if (!result || typeof result.then !== 'function') return result;
        if (loseAck) return result.then((value) => { throw settled(null); }, (error) => { throw settled(error); });
        // Passive normal path returns the EXACT original promise.
        void result.then(() => settled(null), (error) => settled(error)).catch(() => {});
        return result;
      };
      return control ? waitForRelease(control, event).then(invoke) : invoke();
    };
  }
  function wrapHttpEmit(original) {
    return function (event, ...args) {
      if (event !== 'request' || args[0]?.url !== '/v1/chat/completions') return original.call(this, event, ...args);
      const [, response] = args;
      const http = ++nextHttp;
      record('http_request', { http });
      response.once('finish', () => record('http_finish', { http, status: response.statusCode }));
      response.once('close', () => record('http_close', { http, status: response.statusCode, finished: response.writableFinished }));
      return original.call(this, event, ...args);
    };
  }
  return { wrapQuery, wrapHttpEmit, snapshot, dump };
}
function install() {
  if (process.env.ASYNC_RECEIPT_FAULT_ENABLE !== '1') throw new Error('ASYNC_RECEIPT_FAULT_EXPLICIT_OPT_IN_REQUIRED');
  const observer = createObserver({ markerDirectory: process.env.ASYNC_RECEIPT_FAULT_DIRECTORY, output: process.env.ASYNC_RECEIPT_FAULT_OUTPUT });
  const { Client } = require('pg');
  const http = require('node:http');
  Client.prototype.query = observer.wrapQuery(Client.prototype.query);
  http.Server.prototype.emit = observer.wrapHttpEmit(http.Server.prototype.emit);
  process.on('SIGUSR2', observer.dump);
  process.on('exit', observer.dump);
  return observer;
}
if (process.env.ASYNC_RECEIPT_FAULT_ENABLE === '1') install();
module.exports = { createObserver, inspectQuery, sqlKind };
