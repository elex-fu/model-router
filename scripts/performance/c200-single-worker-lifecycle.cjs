'use strict';
// Diagnostic cluster worker only. Keep startup/listen IPC referenced. Once the
// original shutdown signal arrives, let the original server, request, timer and
// DB resources determine natural exit, just as in the direct process. Cluster
// itself otherwise keeps idle IPC referenced even after server.close().
// This neither disconnects IPC nor closes/drains/exits any application resource.
const cluster = require('node:cluster');
if (process.env.C200_CLUSTER_DIAGNOSTIC !== '1' || !cluster.isWorker ||
    typeof process.channel?.unref !== 'function') {
  throw new Error('C200_ACCEPTOR_WORKER_LIFECYCLE_INVALID');
}
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    // once() removes this listener before invocation. During early startup,
    // with no application shutdown listener yet, preserve default termination
    // rather than swallowing a signal and reporting an imaginary clean drain.
    if (process.listenerCount(signal) === 0) {
      process.kill(process.pid, signal);
      return;
    }
    process.channel?.unref();
  });
}
