'use strict';
// Test-owned transport process only: no PostgreSQL, Redis, money or upstream calls.
const http = require('node:http');
let server;
let stopping = false;
const tickets = new Map();
let config;
process.once('message', (message) => {
  if (message.type !== 'bootstrap') process.exit(2);
  config = message.configuration;
  if (process.env.BOUNDED_TEST_FAIL_SLOT === String(config.slot)) process.exit(2);
  server = http.createServer((req, res) => {
    const ticket = req.headers['x-model-router-bounded-ticket'];
    if (!tickets.delete(ticket)) { res.writeHead(403); res.end(); return; }
    req.resume();
    res.end(String(config.slot));
    process.send({ type: 'completed', epoch: config.epoch, ticket });
  });
  const localPool = config.totals.databasePoolMax / 2;
  const quota = localPool === 1 ? 0 : localPool < 4 ? 1 : 2;
  server.listen(config.socketPath, () => process.send({ type: 'ready', epoch: config.epoch, pid: process.pid,
    budgets: Object.fromEntries(Object.entries(config.totals).map(([key, value]) => [key, value / 2])),
    nativePools: [localPool - quota, ...(quota ? [quota] : [])].sort((a, b) => a - b) }));
  process.on('message', (next) => {
    if (next.epoch !== config.epoch) process.exit(3);
    if (next.type === 'reserve') {
      tickets.set(next.ticket, next.peerAddress);
      process.send({ type: 'reserved', epoch: config.epoch, ticket: next.ticket });
    } else if (next.type === 'cancel' && tickets.delete(next.ticket)) {
      process.send({ type: 'completed', epoch: config.epoch, ticket: next.ticket });
    } else if (next.type === 'stop') {
      stopping = true;
      server.close(() => { process.exitCode = 0; process.disconnect(); });
    }
  });
});
process.on('disconnect', () => { if (!stopping) process.exit(1); });
