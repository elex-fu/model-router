/**
 * R3 §8.1: the resolved SUPPLY billing identity — the actual provider /
 * product / upstream model / operation this attempt is served on, with the
 * supplier cost version and metering policy version frozen for it.
 *
 * The two commercial identities of a request are frozen SEPARATELY:
 *
 * - the CUSTOMER sale identity (public model, group, frozen customer terms,
 *   customer price version, request idempotency) stays bound to the route as
 *   configured and never drifts on internal switches;
 * - the SUPPLY identity is resolved server-side AFTER the composite routing
 *   decision (and after any model rewrite / admin payload rule that changes
 *   what is actually sent), BEFORE admission. Retries and cross-platform
 *   fallback resolve it again for their own attempt.
 *
 * Every field below is server-resolved. None of it is client-supplied, and
 * the whole identity enters the signed prepared-evidence statement
 * (providerId / productId / resolvedModel / endpoint / providerOperation /
 * supplierCostVersion / providerMeteringPolicyVersion are all statement
 * fields), so precheck, claim, and settlement verify the SAME identity.
 */

/** The frozen per-attempt supply-side commercial identity (§8.1). */
export interface ResolvedSupplyBillingIdentity {
  readonly providerId: string;
  readonly productId: string;
  readonly upstreamModel: string;
  readonly providerOperation: string | null;
  readonly supplierCostVersion: string;
  readonly meteringPolicyVersion: string;
}

/**
 * The customer-side identity the customer price version is registered under.
 * For composite dispatches this is the ROUTE's nominal provider/product/
 * endpoint — the customer price never follows the internal platform switch.
 */
export interface CustomerSaleBillingIdentity {
  readonly providerId: string;
  readonly productId: string;
  readonly endpoint: string;
}

export function resolvedSupplyBillingIdentityFromInput(input: {
  readonly providerId: string;
  readonly productId: string;
  readonly upstreamModel: string;
  readonly providerOperation?: string | null;
  readonly supplierCostVersion: string;
  readonly meteringPolicyVersion: string;
}): ResolvedSupplyBillingIdentity {
  return {
    providerId: input.providerId,
    productId: input.productId,
    upstreamModel: input.upstreamModel,
    providerOperation: input.providerOperation ?? null,
    supplierCostVersion: input.supplierCostVersion,
    meteringPolicyVersion: input.meteringPolicyVersion,
  };
}

/**
 * Identity equality for the drift fence: precheck, claim and settlement all
 * compare the same six fields.
 */
export function sameResolvedSupplyBillingIdentity(
  left: ResolvedSupplyBillingIdentity,
  right: ResolvedSupplyBillingIdentity,
): boolean {
  return (
    left.providerId === right.providerId &&
    left.productId === right.productId &&
    left.upstreamModel === right.upstreamModel &&
    left.providerOperation === right.providerOperation &&
    left.supplierCostVersion === right.supplierCostVersion &&
    left.meteringPolicyVersion === right.meteringPolicyVersion
  );
}

/**
 * Canonical digest material for the identity (fixed field order). Used where
 * a caller needs the identity inside a digest without depending on object
 * key ordering.
 */
export function resolvedSupplyBillingIdentityDigestMaterial(identity: ResolvedSupplyBillingIdentity): string {
  return [
    `provider=${identity.providerId}`,
    `product=${identity.productId}`,
    `model=${identity.upstreamModel}`,
    `operation=${identity.providerOperation ?? 'null'}`,
    `supplierCostVersion=${identity.supplierCostVersion}`,
    `meteringPolicyVersion=${identity.meteringPolicyVersion}`,
  ].join('|');
}
