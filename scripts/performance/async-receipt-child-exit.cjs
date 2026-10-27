'use strict';
function hasExited(child) { return child.exitCode !== null || child.signalCode !== null; }
function waitForExit(child, timeoutMs) {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer;
    const finish = (exited) => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    child.once('exit', onExit);
    // This is intentionally referenced: failure bounds must still fire.
    timer = setTimeout(() => finish(false), timeoutMs);
    if (hasExited(child)) finish(true);
  });
}
module.exports = { waitForExit, hasExited };
