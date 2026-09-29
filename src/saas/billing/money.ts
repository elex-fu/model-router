import { SaasBillingError } from './errors.js';

/** PostgreSQL bigint's largest positive value. Amounts are never represented as JS numbers. */
export const MAX_MINOR_UNITS = 9_223_372_036_854_775_807n;

const ISO_CURRENCY_CODES = new Set([
  'AED',
  'AFN',
  'ALL',
  'AMD',
  'ANG',
  'AOA',
  'ARS',
  'AUD',
  'AWG',
  'AZN',
  'BAM',
  'BBD',
  'BDT',
  'BGN',
  'BHD',
  'BIF',
  'BMD',
  'BND',
  'BOB',
  'BOV',
  'BRL',
  'BSD',
  'BTN',
  'BWP',
  'BYN',
  'BZD',
  'CAD',
  'CDF',
  'CHE',
  'CHF',
  'CHW',
  'CLF',
  'CLP',
  'CNY',
  'COP',
  'COU',
  'CRC',
  'CUC',
  'CUP',
  'CVE',
  'CZK',
  'DJF',
  'DKK',
  'DOP',
  'DZD',
  'EGP',
  'ERN',
  'ETB',
  'EUR',
  'FJD',
  'FKP',
  'GBP',
  'GEL',
  'GHS',
  'GIP',
  'GMD',
  'GNF',
  'GTQ',
  'GYD',
  'HKD',
  'HNL',
  'HTG',
  'HUF',
  'IDR',
  'ILS',
  'INR',
  'IQD',
  'IRR',
  'ISK',
  'JMD',
  'JOD',
  'JPY',
  'KES',
  'KGS',
  'KHR',
  'KMF',
  'KPW',
  'KRW',
  'KWD',
  'KYD',
  'KZT',
  'LAK',
  'LBP',
  'LKR',
  'LRD',
  'LSL',
  'LYD',
  'MAD',
  'MDL',
  'MGA',
  'MKD',
  'MMK',
  'MNT',
  'MOP',
  'MRU',
  'MUR',
  'MVR',
  'MWK',
  'MXN',
  'MXV',
  'MYR',
  'MZN',
  'NAD',
  'NGN',
  'NIO',
  'NOK',
  'NPR',
  'NZD',
  'OMR',
  'PAB',
  'PEN',
  'PGK',
  'PHP',
  'PKR',
  'PLN',
  'PYG',
  'QAR',
  'RON',
  'RSD',
  'RUB',
  'RWF',
  'SAR',
  'SBD',
  'SCR',
  'SDG',
  'SEK',
  'SGD',
  'SHP',
  'SLE',
  'SLL',
  'SOS',
  'SRD',
  'SSP',
  'STN',
  'SVC',
  'SYP',
  'SZL',
  'THB',
  'TJS',
  'TMT',
  'TND',
  'TOP',
  'TRY',
  'TTD',
  'TWD',
  'TZS',
  'UAH',
  'UGX',
  'USD',
  'USN',
  'UYI',
  'UYU',
  'UYW',
  'UZS',
  'VED',
  'VES',
  'VND',
  'VUV',
  'WST',
  'XAF',
  'XAG',
  'XAU',
  'XBA',
  'XBB',
  'XBC',
  'XBD',
  'XCD',
  'XDR',
  'XOF',
  'XPD',
  'XPF',
  'XPT',
  'XSU',
  'XTS',
  'XUA',
  'XXX',
  'YER',
  'ZAR',
  'ZMW',
  'ZWG',
]);

export type MinorUnitInput = bigint | string;

export function normalizeCurrency(value: unknown): string {
  if (typeof value !== 'string' || !ISO_CURRENCY_CODES.has(value)) {
    throw new SaasBillingError('INVALID_CURRENCY');
  }
  return value;
}

export function parseMinorUnits(value: unknown, options: { readonly allowZero?: boolean } = {}): bigint {
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    throw new SaasBillingError('INVALID_AMOUNT');
  }

  let parsed: bigint;
  if (typeof value === 'bigint') {
    parsed = value;
  } else if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) {
    try {
      parsed = BigInt(value);
    } catch {
      throw new SaasBillingError('INVALID_AMOUNT');
    }
  } else {
    throw new SaasBillingError('INVALID_AMOUNT');
  }

  if (parsed < 0n || parsed > MAX_MINOR_UNITS || (!options.allowZero && parsed === 0n)) {
    throw new SaasBillingError('INVALID_AMOUNT');
  }
  return parsed;
}

export function parseStoredMinorUnits(value: unknown): bigint {
  if (typeof value === 'bigint') return parseMinorUnits(value, { allowZero: true });
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) {
    return parseMinorUnits(value, { allowZero: true });
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return parseMinorUnits(String(value), { allowZero: true });
  }
  throw new SaasBillingError('BILLING_STORAGE_ERROR');
}

export function addMinorUnits(left: bigint, right: bigint): bigint {
  const result = left + right;
  if (result < 0n || result > MAX_MINOR_UNITS) throw new SaasBillingError('BILLING_STORAGE_ERROR');
  return result;
}

export function subtractMinorUnits(left: bigint, right: bigint): bigint {
  const result = left - right;
  if (result < 0n) throw new SaasBillingError('INSUFFICIENT_FUNDS');
  return result;
}
