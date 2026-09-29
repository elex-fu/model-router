import { monitorEventLoopDelay } from 'node:perf_hooks';

const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();
let peakRss = process.memoryUsage().rss;
const sampler = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 50);
sampler.unref();

process.on('message', (message) => {
  if (!message || message.kind !== 'benchmark-monitor') return;
  if (message.action === 'reset') {
    delay.reset();
    peakRss = process.memoryUsage().rss;
    process.send?.({ kind: 'benchmark-monitor', id: message.id, reset: true });
  }
  if (message.action === 'snapshot') {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    process.send?.({
      kind: 'benchmark-monitor',
      id: message.id,
      rssPeakBytes: peakRss,
      eventLoopDelayP95Ms: delay.percentile(95) / 1e6,
      eventLoopDelayMaxMs: delay.max / 1e6,
      eventLoopDelaySamples: delay.count,
    });
  }
});
