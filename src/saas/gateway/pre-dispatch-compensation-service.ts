import type {
  RequestPreparationCompensationInput,
  RequestPreparationCompensationPort,
  RequestPreparationCompensationResult,
  RequestPreparationPreparedResult,
  RequestPreparationTransactionPort,
} from './request-preparation-service.js';

export interface GatewayPreDispatchCompensationPort {
  compensate(input: {
    readonly prepared: RequestPreparationPreparedResult;
    readonly cause: 'client_cancelled' | 'dispatch_failed';
    readonly responseMayHaveStarted: boolean;
  }): Promise<RequestPreparationCompensationResult>;
}

/** Owns a fresh short transaction after preparation commits; never performs upstream I/O. */
export class GatewayPreDispatchCompensationService implements GatewayPreDispatchCompensationPort {
  constructor(
    private readonly transaction: RequestPreparationTransactionPort,
    private readonly compensation: RequestPreparationCompensationPort,
  ) {}

  async compensate(input: Parameters<GatewayPreDispatchCompensationPort['compensate']>[0]) {
    const { prepared } = input;
    const retained: RequestPreparationCompensationResult = {
      requestId: prepared.requestId,
      attemptId: prepared.attemptId,
      disposition: 'retained_for_reconciliation',
      quotaReservation: 'retained_for_reconciliation',
      rateReservation: 'retained_for_reconciliation',
      holdReservation: prepared.caller.supplyMode === 'byok' ? 'not_applicable' : 'retained_for_reconciliation',
      manualReconciliationRequired: true,
    };
    // References are from the server's preparation result, never request body/header authority.
    if (
      prepared.evidence.tenantId !== prepared.caller.tenantId ||
      prepared.evidence.projectId !== prepared.caller.projectId ||
      prepared.evidence.requestId !== prepared.requestId ||
      prepared.evidence.attemptId !== prepared.attemptId ||
      prepared.evidence.supplyMode !== prepared.caller.supplyMode
    ) return retained;
    const command: RequestPreparationCompensationInput = {
      tenantId: prepared.caller.tenantId,
      requestId: prepared.requestId,
      attemptId: prepared.attemptId,
      admission: prepared.admission,
      evidenceId: prepared.evidence.evidenceId,
      responseMayHaveStarted: input.responseMayHaveStarted,
      expectedAttempt: { dispatchState: 'not_sent', resultState: 'pending', responseStarted: false },
      failedStage: 'dispatch',
      failureCode: input.cause,
    };
    try {
      return await this.transaction.transaction(async (executor) => {
        const decision = await this.compensation.releasePreDispatch(command, { executor });
        if (decision.decision !== 'allow') throw new Error('Pre-dispatch compensation was not confirmed');
        const result = decision.value;
        if (
          result.requestId !== prepared.requestId || result.attemptId !== prepared.attemptId ||
          (result.disposition === 'released' && (
            result.quotaReservation !== 'released' || result.rateReservation !== 'released' ||
            result.holdReservation !== (prepared.caller.supplyMode === 'byok' ? 'not_applicable' : 'released') ||
            result.manualReconciliationRequired !== false
          )) ||
          (result.disposition === 'retained_for_reconciliation' && (
            result.manualReconciliationRequired !== true ||
            result.quotaReservation !== 'retained_for_reconciliation' ||
            result.rateReservation !== 'retained_for_reconciliation' ||
            result.holdReservation !== (prepared.caller.supplyMode === 'byok' ? 'not_applicable' : 'retained_for_reconciliation')
          )) ||
          (result.disposition !== 'released' && result.disposition !== 'retained_for_reconciliation')
        ) throw new Error('Invalid pre-dispatch compensation outcome');
        return result;
      });
    } catch {
      // Includes uncertain COMMIT. No retry, secondary release, or failure replay is authorized.
      // Persisted pending/unknown facts remain the recovery authority until re-read by an operator.
      return retained;
    }
  }
}
