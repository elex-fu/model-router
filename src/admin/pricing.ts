import { z } from 'zod';
import { ControlError } from '../control/service.js';

const rate = z
  .union([z.number().finite().nonnegative(), z.string()])
  .refine(
    (value) => /^\d+(?:\.\d{1,6})?$/.test(String(value)) && Number(value) <= 1_000_000_000,
    'Price must be non-negative, at most 1 billion, with up to 6 decimal places',
  );
const pricing = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/),
    model: z.string().trim().min(1).max(200),
    currency: z.string().regex(/^[A-Z]{3}$/),
    inputPerMillion: rate,
    outputPerMillion: rate,
    cacheReadPerMillion: rate.optional(),
    cacheWritePerMillion: rate.optional(),
    cacheWrite5mPerMillion: rate.optional(),
    cacheWrite1hPerMillion: rate.optional(),
    cacheWriteIncludedInInput: z.boolean().optional(),
    effectiveFrom: z.iso.datetime({ offset: true }).optional(),
    upstreamId: z.string().min(1).max(128).optional(),
    provider: z.string().min(1).max(128).optional(),
  })
  .strict();

export function validatePricing(value: unknown) {
  const result = pricing.safeParse(value);
  if (!result.success)
    throw new ControlError(
      422,
      'INVALID_PRICING',
      'Invalid pricing profile',
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  return result.data;
}
