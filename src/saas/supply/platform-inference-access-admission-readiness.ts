import { CODEX_RESPONSES_ENDPOINT } from '../gateway/codex/transport.js';
import type { GatewayProtocol } from '../gateway/contracts.js';
import { resolveCodexTrustedBoundProfile } from '../runtime/codex-trusted-bound-profiles.js';

/** Derived from the reviewed route/policy; never accepted from an HTTP request body. */
export interface PlatformInferenceAccessAdmissionScope {
  readonly providerId: string;
  readonly productId: string;
  readonly publicModelId: string;
  readonly publicModelVersion: string;
  readonly resolvedModel: string;
  readonly providerProtocol: GatewayProtocol;
  readonly endpoint: string;
  readonly workflow: 'responses-http-full';
}
export type PlatformInferenceAccessAdmissionReadinessResult =
  | { readonly status: 'ready'; readonly evidenceDigest?: string }
  | { readonly status: 'blocked'; readonly code: 'TRUSTED_USAGE_BOUNDS_UNAVAILABLE' | 'WORKFLOW_UNSUPPORTED' };
export interface PlatformInferenceAccessAdmissionReadiness {
  check(scope: PlatformInferenceAccessAdmissionScope): PlatformInferenceAccessAdmissionReadinessResult;
}
/** Static billing admission only: no dynamic health or arbitrary-payload/WS/compact promise. */
export function createBuiltinPlatformInferenceAccessAdmissionReadiness(): PlatformInferenceAccessAdmissionReadiness {
  return {
    check(scope) {
      if (scope.providerId !== 'openai-codex') return {status:'ready'};
      if (scope.workflow !== 'responses-http-full' || scope.providerProtocol !== 'responses' || scope.endpoint !== '/v1/responses') {
        return {status:'blocked',code:'WORKFLOW_UNSUPPORTED'};
      }
      const trusted=resolveCodexTrustedBoundProfile({endpoint:CODEX_RESPONSES_ENDPOINT,productId:scope.productId,model:scope.resolvedModel,operation:'responses',transport:'http',continuationMode:'full'});
      return trusted ? {status:'ready',evidenceDigest:trusted.digest} : {status:'blocked',code:'TRUSTED_USAGE_BOUNDS_UNAVAILABLE'};
    },
  };
}
