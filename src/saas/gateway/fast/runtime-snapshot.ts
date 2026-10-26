import { createHash, randomUUID } from 'node:crypto';
import type { ProviderSupplyHttpAuthenticationHeaderResolver } from '../../runtime/provider-supply-http-credential-resolver.js';
import { createModelResolutionProvenance } from '../contracts.js';
import type {
  ProviderModelCompatibilityChecker,
  ProviderModelCompatibilityInput,
} from '../provider-payload-compiler.js';
import type { FastGatewayCandidate, FastGatewaySnapshotProvider } from './snapshots.js';

/** Capture deployment callbacks only on cold load, before either cache tier.
 * The core source's RR authority age is retained. These auxiliary runtime facts
 * are a separately observed, bounded view, NOT a claim of the same RR snapshot.
 */
export function createRuntimeFastGatewaySnapshotSource(
  source: FastGatewaySnapshotProvider,
  options: {
    readonly modelCompatibility: ProviderModelCompatibilityChecker;
    readonly authenticationHeader: ProviderSupplyHttpAuthenticationHeaderResolver;
  },
): FastGatewaySnapshotProvider {
  return {
    async resolve(input) {
      const snapshot = await source.resolve(input);
      if (!snapshot) return null;
      const candidates: FastGatewayCandidate[] = [];
      for (const candidate of snapshot.candidates) {
        const a = candidate.authority;
        const compatibility = {
          providerId: a.providerId,
          productId: a.productId,
          providerModel: a.resolvedModel,
          providerProtocol: 'openai' as const,
        };
        const modelResolution =
          snapshot.authority.modelResolution ??
          createModelResolutionProvenance(input.publicModel, a.resolvedModel, snapshot.authority.modelMappingRules);
        if (
          !(await options.modelCompatibility({
            ...compatibility,
            providerOperation: 'chat.completions',
            modelResolution,
          }))
        )
          continue;
        const coldId = randomUUID();
        const header = await options.authenticationHeader({
          tenantId: snapshot.caller.tenantId,
          projectId: snapshot.caller.projectId,
          requestId: coldId,
          attemptId: coldId,
          evidenceId: coldId,
          accountId: a.accountId,
          upstreamId: a.upstreamId,
          credentialId: a.credentialId,
          credentialVersion: String(a.credentialVersion),
          providerId: a.providerId,
          productId: a.productId,
          endpoint: snapshot.authority.route.endpoint,
          providerProtocol: 'openai',
          providerOperation: 'chat.completions',
          signal: AbortSignal.timeout(2000),
        });
        const descriptor =
          typeof header === 'string'
            ? {
                headerName: header,
                valueFormat: header.toLowerCase() === 'authorization' ? ('bearer' as const) : ('raw' as const),
              }
            : header;
        if (
          !descriptor ||
          !['authorization', 'api-key', 'x-api-key', 'x-goog-api-key'].includes(descriptor.headerName.toLowerCase()) ||
          (descriptor.valueFormat !== undefined &&
            descriptor.valueFormat !== 'raw' &&
            descriptor.valueFormat !== 'bearer')
        ) {
          throw new Error('Fast runtime authentication policy unavailable');
        }
        candidates.push({
          ...candidate,
          dispatch: {
            authenticationHeader: {
              headerName: descriptor.headerName,
              ...(descriptor.valueFormat === undefined ? {} : { valueFormat: descriptor.valueFormat }),
            },
            modelCompatibility: compatibility,
          },
        });
      }
      if (!candidates.length) return null;
      const revision = createHash('sha256')
        .update(snapshot.revision)
        .update(JSON.stringify(candidates.map((c) => c.dispatch)))
        .digest('hex');
      return { ...snapshot, candidates, revision };
    },
  };
}

/** The compiler still validates exact routing identity; it never queries PG. */
export function fastGatewayModelCompatibility(
  candidate: FastGatewayCandidate,
  input: ProviderModelCompatibilityInput,
): boolean {
  const bound = candidate.dispatch?.modelCompatibility;
  return (
    !!bound &&
    input.providerOperation === 'chat.completions' &&
    bound.providerId === candidate.authority.providerId &&
    bound.productId === candidate.authority.productId &&
    bound.providerModel === candidate.authority.resolvedModel &&
    bound.providerProtocol === 'openai' &&
    input.providerId === bound.providerId &&
    input.productId === bound.productId &&
    input.providerModel === bound.providerModel &&
    input.providerProtocol === bound.providerProtocol
  );
}
