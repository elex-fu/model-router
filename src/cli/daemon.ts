import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function readPidFile(filePath: string): number | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) return null;
    return n;
  } catch {
    return null;
  }
}

export function writePidFile(filePath: string, pid: number): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, `${pid}\n`, 'utf-8');
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // best-effort
    }
  }
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    if (err.code === 'EPERM') return true;
    return false;
  }
}

export interface SpawnDaemonOptions {
  args: string[];
  logFile?: string;
  pidFile: string;
  cwd?: string;
  scriptPath?: string;
  execArgv?: string[];
}

export function spawnDaemon(options: SpawnDaemonOptions): number {
  const { args, logFile, pidFile, cwd } = options;
  let stdout: number | 'ignore' = 'ignore';
  let stderr: number | 'ignore' = 'ignore';
  if (logFile) {
    const dir = path.dirname(logFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const fd = fs.openSync(logFile, 'a');
    stdout = fd;
    stderr = fd;
  }
  const scriptPath = options.scriptPath ?? process.argv[1];
  const execArgv = options.execArgv ?? process.execArgv;
  const child = spawn(process.execPath, [...execArgv, scriptPath, ...args], {
    cwd,
    detached: true,
    stdio: ['ignore', stdout, stderr],
    env: { ...process.env, MODEL_ROUTER_DAEMON_CHILD: '1' },
  });
  if (child.pid === undefined) {
    throw new Error('failed to spawn daemon child');
  }
  writePidFile(pidFile, child.pid);
  child.unref();
  return child.pid;
}
