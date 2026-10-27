'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { performance } = require('node:perf_hooks');
const { waitForExit } = require('./async-receipt-child-exit.cjs');

test('normal child exit cancels long fallback timer and does not retain event loop', async () => {
  const helper = require.resolve('./async-receipt-child-exit.cjs');
  const script = `const {EventEmitter}=require('node:events');const {waitForExit}=require(${JSON.stringify(helper)});const child=Object.assign(new EventEmitter(),{exitCode:null,signalCode:null});waitForExit(child,45000).then(ok=>{if(!ok)process.exitCode=2});setTimeout(()=>{child.exitCode=0;child.emit('exit',0,null)},5);`;
  const started = performance.now();
  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
  try {
    assert.equal(await waitForExit(child, 2000), true);
    assert.equal(child.exitCode, 0);
    assert.ok(performance.now() - started < 2000, 'no surviving 45s timer');
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});

test('referenced timeout fires for a child refusing TERM and forced kill is observable', async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);console.log('ready')"], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await once(child.stdout, 'data');
    child.kill('SIGTERM');
    assert.equal(await waitForExit(child, 25), false, 'timeout is not a successful exit');
    child.kill('SIGKILL');
    assert.equal(await waitForExit(child, 2000), true);
    assert.equal(child.exitCode, null); assert.equal(child.signalCode, 'SIGKILL');
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});
