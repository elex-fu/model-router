import { appendFileSync, openSync, closeSync } from 'node:fs';
import os from 'node:os';

const output = process.argv[2];
closeSync(openSync(output, 'wx', 0o600));
let previous;
function sample() {
  const cpus = os.cpus();
  const now = cpus.reduce((a, cpu) => {
    a.idle += cpu.times.idle;
    a.total += Object.values(cpu.times).reduce((sum, n) => sum + n, 0);
    return a;
  }, { idle: 0, total: 0 });
  const delta = previous ? now.total - previous.total : 0;
  appendFileSync(output, JSON.stringify({
    at: new Date().toISOString(), logicalCpus: cpus.length,
    loadavg: os.loadavg(), freeMemoryBytes: os.freemem(),
    cpuBusyPercent: delta > 0 ? 100 * (1 - (now.idle - previous.idle) / delta) : null,
  }) + '\n');
  previous = now;
}
sample();
const timer = setInterval(sample, 5000);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  clearInterval(timer);
  sample();
  process.exit(0);
});
