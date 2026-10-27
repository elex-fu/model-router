import { createHash } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  type BoundedGatewayBudgets,
  type BoundedGatewaySlot,
  boundedGatewayBudgets,
} from './bounded-gateway-budgets.js';
import { isBoundedGatewayTicket } from './bounded-gateway-protocol.js';

export interface BoundedGatewayProcessIdentity {
  readonly pid: number;
  readonly startTicks: string;
}
export interface BoundedGatewaySlotState {
  readonly slot: BoundedGatewaySlot;
  readonly epoch: string;
  recoveryEpochs: string[];
  process: BoundedGatewayProcessIdentity | null;
  phase: 'starting' | 'ready' | 'unready' | 'draining' | 'exited';
  exitCode: number | null;
  signal: string | null;
  forced: boolean;
}
export interface BoundedGatewayState {
  readonly version: 1;
  readonly deploymentId: string;
  readonly machineId: string;
  readonly bootId: string;
  readonly generation: string;
  readonly primary: BoundedGatewayProcessIdentity;
  readonly totals: BoundedGatewayBudgets;
  readonly creditCapMinorUnits: string;
  readonly policyDigest: string;
  phase: 'starting' | 'ready' | 'replacing' | 'stopping' | 'closed' | 'failed';
  slots: Array<BoundedGatewaySlotState | null>;
  lastError?: string;
}

export function validateBoundedGatewayState(value: unknown): asserts value is BoundedGatewayState {
  const invalid = () => {
    throw new Error('BOUNDED_GATEWAY_INVALID_STATE_FILE');
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const state = value as BoundedGatewayState;
  const identity = (item: BoundedGatewayProcessIdentity | null | undefined) =>
    Boolean(
      item &&
        Number.isSafeInteger(item.pid) &&
        item.pid > 0 &&
        typeof item.startTicks === 'string' &&
        /^[1-9][0-9]*$/.test(item.startTicks),
    );
  if (
    state.version !== 1 ||
    typeof state.deploymentId !== 'string' ||
    !/^[a-zA-Z0-9_:-]{1,128}$/.test(state.deploymentId) ||
    !isBoundedGatewayTicket(state.generation) ||
    !isBoundedGatewayTicket(state.bootId) ||
    !identity(state.primary) ||
    typeof state.machineId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(state.machineId) ||
    typeof state.policyDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(state.policyDigest) ||
    typeof state.creditCapMinorUnits !== 'string' ||
    !/^[1-9][0-9]*$/.test(state.creditCapMinorUnits) ||
    BigInt(state.creditCapMinorUnits) < 2n ||
    BigInt(state.creditCapMinorUnits) > 9223372036854775807n ||
    !['starting', 'ready', 'replacing', 'stopping', 'closed', 'failed'].includes(state.phase) ||
    !Array.isArray(state.slots) ||
    state.slots.length !== 2 ||
    !state.totals ||
    Object.keys(state.totals).length !== 7 ||
    (state.lastError !== undefined && !/^BOUNDED_[A-Z0-9_]+$/.test(state.lastError))
  )
    invalid();
  try {
    boundedGatewayBudgets(state.totals);
  } catch {
    invalid();
  }
  for (const [index, slot] of state.slots.entries()) {
    if (slot === null) {
      if (state.phase === 'ready') invalid();
      continue;
    }
    if (
      !slot ||
      slot.slot !== index ||
      !isBoundedGatewayTicket(slot.epoch) ||
      !['starting', 'ready', 'unready', 'draining', 'exited'].includes(slot.phase) ||
      (slot.process === null ? slot.phase !== 'starting' : !identity(slot.process)) ||
      !Array.isArray(slot.recoveryEpochs) ||
      slot.recoveryEpochs.length > 64 ||
      slot.recoveryEpochs.some((epoch) => !isBoundedGatewayTicket(epoch) || epoch === slot.epoch) ||
      new Set(slot.recoveryEpochs).size !== slot.recoveryEpochs.length ||
      typeof slot.forced !== 'boolean' ||
      (slot.exitCode !== null && (!Number.isInteger(slot.exitCode) || slot.exitCode < 0 || slot.exitCode > 255)) ||
      (slot.signal !== null && (typeof slot.signal !== 'string' || !/^SIG[A-Z0-9]+$/.test(slot.signal))) ||
      (state.phase === 'ready' && !['ready', 'unready'].includes(slot.phase))
    )
      invalid();
  }
}

export function boundedGatewayMachineId(): string {
  let value: string | undefined;
  try {
    value = readFileSync('/etc/machine-id', 'utf8').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (value && /^[a-f0-9]{32}$/.test(value)) return createHash('sha256').update(`machine:${value}`).digest('hex');
  // Minimal Linux containers may have no provisioned machine-id. A boot-scoped
  // identity is sufficient for this process domain; after reboot old state
  // conflicts and recovery fails closed instead of guessing a new host.
  const boot = boundedGatewayBootId();
  return createHash('sha256').update(`boot:${boot}`).digest('hex');
}
export function boundedGatewayBootId(): string {
  const value = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  if (!isBoundedGatewayTicket(value)) throw new Error('BOUNDED_GATEWAY_BOOT_ID_UNAVAILABLE');
  return value;
}
function processFacts(pid: number): { identity: BoundedGatewayProcessIdentity; state: string } {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('BOUNDED_GATEWAY_INVALID_PID');
  const value = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = value
    .slice(value.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/);
  const ticks = fields[19];
  if (!ticks || !/^[1-9][0-9]*$/.test(ticks) || !fields[0] || !/^[A-Za-z]$/.test(fields[0]))
    throw new Error('BOUNDED_GATEWAY_PROCESS_IDENTITY_UNAVAILABLE');
  return { identity: { pid, startTicks: ticks }, state: fields[0] };
}
export function boundedGatewayProcessIdentity(pid: number): BoundedGatewayProcessIdentity {
  return processFacts(pid).identity;
}
export function boundedGatewayProcessIsAlive(identity: BoundedGatewayProcessIdentity): boolean {
  try {
    const facts = processFacts(identity.pid);
    // Zombies have exited and own no sockets/pools; a non-reaping container PID1
    // must not be mistaken for a still-running business process.
    return facts.identity.startTicks === identity.startTicks && !['Z', 'X', 'x'].includes(facts.state);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH')
      return false;
    throw error; // Permissions/unknown observation are not proof of death.
  }
}

function secureDirectory(directory: string): void {
  if (!isAbsolute(directory) || resolve(directory) !== directory)
    throw new Error('BOUNDED_GATEWAY_ABSOLUTE_STATE_DIRECTORY_REQUIRED');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
    throw new Error('BOUNDED_GATEWAY_PRIVATE_STATE_DIRECTORY_REQUIRED');
  }
}

export function readBoundedGatewayState(directory: string): BoundedGatewayState | undefined {
  try {
    const filename = join(directory, 'state.json');
    const stat = lstatSync(filename);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 65536 ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.()
    ) {
      throw new Error('BOUNDED_GATEWAY_INVALID_STATE_FILE');
    }
    const state: unknown = JSON.parse(readFileSync(filename, 'utf8'));
    validateBoundedGatewayState(state);
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function writeBoundedGatewayState(directory: string, state: BoundedGatewayState): void {
  validateBoundedGatewayState(state);
  const target = join(directory, 'state.json');
  const temporary = `${target}.${process.pid}.tmp`;
  const fd = openSync(temporary, 'w', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(state)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, target);
  const directoryFd = openSync(dirname(target), 'r');
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}

/** No automatic stale-lock stealing. Recovery checks the exact generation and every recorded PID. */
export async function acquireBoundedGatewayState(
  directory: string,
  deploymentId: string,
  recoverGeneration?: string,
): Promise<{
  readonly previous: BoundedGatewayState | undefined;
  release(): Promise<void>;
}> {
  if (process.platform !== 'linux') throw new Error('BOUNDED_GATEWAY_LINUX_REQUIRED');
  // Kernel-owned abstract socket closes on death. Unlike deleting a stale PID file,
  // this serializes concurrent recovery attempts without a check/unlink race.
  const singleton = createServer((socket) => socket.destroy());
  singleton.maxConnections = 1;
  await new Promise<void>((resolveLock, reject) => {
    singleton.once('error', reject);
    singleton.listen(
      { path: `\0model-router-bounded-${createHash('sha256').update(deploymentId).digest('hex')}`, backlog: 1 },
      () => {
        singleton.off('error', reject);
        resolveLock();
      },
    );
  });
  const closeSingleton = () => new Promise<void>((resolveClose) => singleton.close(() => resolveClose()));
  try {
    secureDirectory(directory);
    const previous = readBoundedGatewayState(directory);
    const lock = join(directory, 'supervisor.lock');
    if (previous) {
      if (previous.deploymentId !== deploymentId || previous.machineId !== boundedGatewayMachineId())
        throw new Error('BOUNDED_GATEWAY_STATE_SCOPE_CONFLICT');
      if (recoverGeneration !== previous.generation) throw new Error('BOUNDED_GATEWAY_EXPLICIT_RECOVERY_REQUIRED');
      if (
        previous.bootId === boundedGatewayBootId() &&
        (boundedGatewayProcessIsAlive(previous.primary) ||
          previous.slots.some((slot) => slot?.process && boundedGatewayProcessIsAlive(slot.process)))
      ) {
        throw new Error('BOUNDED_GATEWAY_PREVIOUS_PROCESS_STILL_ALIVE');
      }
      try {
        unlinkSync(lock);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    } else if (recoverGeneration !== undefined) throw new Error('BOUNDED_GATEWAY_RECOVERY_GENERATION_MISMATCH');
    const descriptor = openSync(lock, 'wx', 0o600);
    try {
      writeFileSync(descriptor, `${process.pid}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    let released = false;
    return {
      previous,
      async release() {
        if (!released) {
          released = true;
          try {
            unlinkSync(lock);
          } finally {
            await closeSingleton();
          }
        }
      },
    };
  } catch (error) {
    await closeSingleton();
    throw error;
  }
}
