#!/usr/bin/env node
'use strict';
// Minimal diagnostic control, NOT a gateway or authorization/financial service.
// Node and Go controls intentionally share a fixed small response and delay.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const BODY = '{"choices":[{"message":{"role":"assistant","content":"ok"}}]}';
const REQUEST_LIMIT = 2048, CONNECTION_LIMIT = 1024;
function mono() { return process.hrtime.bigint().toString(); }
function clockAnchor() {
  const monotonicBeforeNs = mono(), wallUnixNs = (BigInt(Date.now()) * 1000000n).toString();
  return { monotonicBeforeNs, wallUnixNs, monotonicAfterNs: mono(), wallResolutionNs: '1000000' };
}
function appendBounded(rows, row, limit, drops, key) {
  if (rows.length < limit) rows.push(row); else drops[key]++;
}
function requestId(serial) { return `00000000-0000-4000-8000-${String(serial).padStart(12, '0')}`; }
function parseArgs(args) {
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--port', '--delay-ms', '--state', '--out'].includes(args[i]) || args[i + 1] === undefined || values[args[i]] !== undefined)
      throw new Error('C200_ECHO_INVALID_SETUP');
    values[args[i]] = args[i + 1];
  }
  const port = Number(values['--port'] ?? '0'), delayMs = Number(values['--delay-ms'] ?? '5');
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 100 ||
      !values['--state'] || !path.isAbsolute(values['--state']) || !values['--out'] || !path.isAbsolute(values['--out']) ||
      path.resolve(values['--state']) === path.resolve(values['--out']))
    throw new Error('C200_ECHO_INVALID_SETUP');
  return { port, delayMs, stateFile: values['--state'], outputFile: values['--out'] };
}
function writeJson(file, value) {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
}
function createEcho(options) {
  const sockets = new WeakMap(), incoming = new WeakMap();
  const connections = [], requests = [], drops = { connections: 0, requests: 0 };
  const anchors = [clockAnchor()];
  let connectionSerial = 0, requestSerial = 0, stopping = false, failed = false, deadline;
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000, keepAliveTimeout: 5000 }, (req, res) => {
    const row = incoming.get(req), id = requestId(row.id);
    row.handlerStartMonotonicNs = mono();
    row.requestHash = createHash('sha256').update(id).digest('hex');
    let bodyBytes = 0, responseTimer;
    const finish = terminal => {
      if (row.terminal) return;
      row.terminal = terminal; row.finishMonotonicNs = mono();
      row.status = res.headersSent ? res.statusCode : null;
      clearTimeout(responseTimer);
    };
    res.once('finish', () => finish('finish'));
    res.once('close', () => finish('close'));
    req.on('error', () => { row.requestReadError = true; res.destroy(); });
    // The echo application consumes/discards its body; no payload is inspected
    // or persisted. This is not an instrumentation change to the real gateway.
    req.on('data', chunk => { bodyBytes += chunk.length; });
    req.once('end', () => {
      row.bodyDrainedMonotonicNs = mono();
      if (bodyBytes > 4096) {
        res.writeHead(413, { 'content-length': '0' }); res.end(); return;
      }
      responseTimer = setTimeout(() => {
        if (res.destroyed) return;
        row.writeStartedMonotonicNs = mono();
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(BODY), 'x-request-id': id });
        res.end(BODY);
        row.handlerEndMonotonicNs = mono();
      }, options.delayMs);
    });
  });
  const originalEmit = server.emit;
  server.emit = function(event, ...args) {
    if (event === 'connection') {
      const socket = args[0];
      const row = { id: ++connectionSerial, connectionEventMonotonicNs: mono(), requestCount: 0 };
      sockets.set(socket, row); appendBounded(connections, row, CONNECTION_LIMIT, drops, 'connections');
      socket.once('close', () => { row.closedMonotonicNs = mono(); });
    } else if (event === 'request') {
      const req = args[0], connection = sockets.get(req.socket);
      if (connection) connection.requestCount++;
      const row = { id: ++requestSerial, connection: connection?.id ?? null,
        connectionRequestSequence: connection?.requestCount ?? null, requestEventMonotonicNs: mono() };
      incoming.set(req, row); appendBounded(requests, row, REQUEST_LIMIT, drops, 'requests');
    }
    return originalEmit.call(this, event, ...args);
  };
  function stop() {
    if (stopping) return;
    stopping = true;
    deadline = setTimeout(() => { failed = true; server.closeAllConnections(); }, 5000);
    server.close(() => {
      clearTimeout(deadline); anchors.push(clockAnchor());
      try {
        writeJson(options.outputFile, { diagnosticOnly: true, role: 'node-http-echo', pid: process.pid,
          delayMs: options.delayMs, responseBytes: Buffer.byteLength(BODY), drops, connections, requests,
          clockAnchors: anchors, resourceUsage: process.resourceUsage(), shutdownClean: !failed,
          boundarySemantics: 'connectionEvent is before original Node Server.emit(connection) listeners, not kernel accept. requestEvent is before original request listeners. finish is Node response finish, not client receipt. No Socket data hook or payload metadata.',
          limit: { connections: CONNECTION_LIMIT, requests: REQUEST_LIMIT }, financialScope: 'none; synthetic echo, not gateway execution' });
      } catch { failed = true; process.stderr.write('C200_ECHO_OUTPUT_FAILED\n'); }
      process.exitCode = failed ? 1 : 0;
    });
  }
  return { server, stop, anchors, connections, requests, drops };
}
function main() {
  const options = parseArgs(process.argv.slice(2)), echo = createEcho(options);
  echo.server.once('error', () => { process.stderr.write('C200_ECHO_LISTEN_FAILED\n'); process.exitCode = 1; });
  echo.server.listen(options.port, '127.0.0.1', () => {
    const clock = clockAnchor(); echo.anchors.push(clock);
    try { writeJson(options.stateFile, { diagnosticOnly: true, pid: process.pid, role: 'node-http-echo',
      boundPort: echo.server.address().port, delayMs: options.delayMs, responseBytes: Buffer.byteLength(BODY), clockAnchor: clock }); }
    catch { process.stderr.write('C200_ECHO_STATE_FAILED\n'); echo.server.close(); process.exitCode = 1; }
  });
  process.once('SIGTERM', echo.stop); process.once('SIGINT', echo.stop);
}
module.exports = { BODY, appendBounded, requestId, parseArgs, clockAnchor };
if (require.main === module) {
  try { main(); } catch { process.stderr.write('C200_ECHO_INVALID_SETUP\n'); process.exitCode = 1; }
}
