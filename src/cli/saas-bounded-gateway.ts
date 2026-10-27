import type { BoundedGatewayBudgets } from '../server/bounded-gateway-budgets.js';
import { requestBoundedGatewayControl } from '../server/bounded-gateway-control.js';
import {
  boundedGatewayBootId,
  boundedGatewayMachineId,
  boundedGatewayProcessIsAlive,
  readBoundedGatewayState,
} from '../server/bounded-gateway-state.js';
import { startBoundedGatewaySupervisor } from '../server/bounded-gateway-supervisor.js';

export interface SaasBoundedGatewayOptions {
  readonly stateDirectory: string;
  readonly creditCapMinorUnits?: string;
  readonly expectedGeneration?: string;
  readonly httpInFlight?: string;
  readonly databasePoolMax?: string;
  readonly maximumBodyBytes?: string;
  readonly maximumConnections?: string;
  readonly requestTimeoutMs?: string;
}
function number(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error('BOUNDED_GATEWAY_INVALID_NUMBER');
  return Number(value);
}

/** Explicit foreground command. Never changes a deployment unit, role, firewall, or runtime configuration. */
export async function saasBoundedGateway(action: string, options: SaasBoundedGatewayOptions): Promise<void> {
  if (action === 'start' || action === 'recover') {
    if (!options.creditCapMinorUnits) throw new Error('BOUNDED_GATEWAY_CREDIT_CAP_REQUIRED');
    if (action === 'recover' && !options.expectedGeneration)
      throw new Error('BOUNDED_GATEWAY_EXPECTED_GENERATION_REQUIRED');
    if (action === 'start' && options.expectedGeneration) throw new Error('BOUNDED_GATEWAY_USE_EXPLICIT_RECOVER');
    const budgets: Partial<BoundedGatewayBudgets> = {
      ...(options.httpInFlight === undefined ? {} : { httpInFlight: number(options.httpInFlight) }),
      ...(options.databasePoolMax === undefined ? {} : { databasePoolMax: number(options.databasePoolMax) }),
    };
    const supervisor = await startBoundedGatewaySupervisor({
      stateDirectory: options.stateDirectory,
      creditCapMinorUnits: options.creditCapMinorUnits,
      budgets,
      ...(options.expectedGeneration ? { recoverGeneration: options.expectedGeneration } : {}),
      ...(options.maximumBodyBytes ? { maximumBodyBytes: number(options.maximumBodyBytes) } : {}),
      ...(options.maximumConnections ? { maximumConnections: number(options.maximumConnections) } : {}),
      ...(options.requestTimeoutMs ? { requestTimeoutMs: number(options.requestTimeoutMs) } : {}),
    });
    console.log(
      `Bounded gateway ready: generation=${supervisor.state.generation}, businessWorkers=2, autoRestart=false`,
    );
    await supervisor.closed;
    return;
  }
  if (!['status', 'stop', 'roll'].includes(action))
    throw new Error('BOUNDED_GATEWAY_ACTION_MUST_BE_START_RECOVER_STATUS_STOP_OR_ROLL');
  const state = readBoundedGatewayState(options.stateDirectory);
  if (!state || state.machineId !== boundedGatewayMachineId()) throw new Error('BOUNDED_GATEWAY_STATE_UNAVAILABLE');
  if (action === 'status') {
    console.log(
      JSON.stringify(
        {
          ...state,
          primaryAlive: state.bootId === boundedGatewayBootId() && boundedGatewayProcessIsAlive(state.primary),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (options.expectedGeneration !== state.generation) throw new Error('BOUNDED_GATEWAY_EXPECTED_GENERATION_MISMATCH');
  if (state.bootId !== boundedGatewayBootId()) throw new Error('BOUNDED_GATEWAY_PREVIOUS_BOOT_PROCESS');
  if (!boundedGatewayProcessIsAlive(state.primary)) throw new Error('BOUNDED_GATEWAY_SUPERVISOR_NOT_RUNNING');
  if (action === 'roll' && state.phase !== 'ready') throw new Error('BOUNDED_GATEWAY_NOT_READY_FOR_ROLL');
  await requestBoundedGatewayControl(options.stateDirectory, state.generation, action === 'stop' ? 'stop' : 'roll');
  console.log(
    `${action === 'stop' ? 'Shutdown' : 'Sequential replacement'} requested for generation=${state.generation}; inspect status for completion.`,
  );
}
