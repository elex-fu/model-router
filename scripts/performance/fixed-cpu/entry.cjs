'use strict';
// Same-image startup wrapper in BOTH arms. The real compiled CLI owns runtime,
// private native identities, HTTP, requests, shutdown and process exit.
const path = require('node:path');
const observer = require('./startup-observer.cjs');
const input = observer.readInput();
const handle = input.arm === 'single' ? observer.installBusinessObserver() : observer.installPrimaryObserver();
const cli = path.resolve(__dirname, '../../../dist/cli/index.js');
process.argv[1] = cli;
try {
  require(cli);
} catch (error) {
  if (handle.fail) handle.fail(error);
  else handle.restore();
  throw error;
}
