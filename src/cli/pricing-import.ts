import { closeSync, existsSync, lstatSync, openSync, readFileSync, type Stats, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { importPricingProfiles, type PricingImportResult } from '../admin/pricing-import.js';
import type { ConfigV2 } from '../config/v2-schema.js';
import { ControlStore } from '../control/store.js';
import { DEFAULT_CONFIG_PATH } from '../utils/paths.js';
import { v2Config } from './v2.js';

export class PricingImportCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingImportCliError';
  }
}

export interface PricingImportCliOptions {
  config?: string;
  dryRun?: boolean;
  /** Default provider label applied to imported profiles. */
  provider?: string;
  /** Default upstreamId applied to imported profiles. */
  upstream?: string;
  /** Currency code label override (never converts amounts). */
  currency?: string;
  /** Injectable fetch used for URL sources; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  writeLine?: (line: string) => void;
}

const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

function parseDocument(text: string, origin: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new PricingImportCliError(
      `${origin} is not valid JSON: ${error instanceof Error ? error.message : 'parse error'}`,
    );
  }
}

/** URL source: https only, 30s timeout, 10MB cap, via the global fetch. */
async function fetchDocument(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      redirect: 'follow',
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError')
      throw new PricingImportCliError(`Pricing document fetch timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s`);
    throw new PricingImportCliError(
      `Unable to fetch pricing document: ${error instanceof Error ? error.message : 'network error'}`,
    );
  }
  if (!response.ok) throw new PricingImportCliError(`Pricing document fetch failed: HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES)
    throw new PricingImportCliError(
      `Pricing document exceeds the ${MAX_DOWNLOAD_BYTES / (1024 * 1024)}MB download limit`,
    );
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_DOWNLOAD_BYTES)
    throw new PricingImportCliError(
      `Pricing document exceeds the ${MAX_DOWNLOAD_BYTES / (1024 * 1024)}MB download limit`,
    );
  return parseDocument(text, 'Pricing document');
}

function readDocumentFile(path: string): unknown {
  let info: Stats;
  try {
    info = lstatSync(path);
  } catch {
    throw new PricingImportCliError(`Pricing document file not found: ${path}`);
  }
  if (!info.isFile()) throw new PricingImportCliError(`Pricing document is not a regular file: ${path}`);
  if (info.size > MAX_DOWNLOAD_BYTES)
    throw new PricingImportCliError(
      `Pricing document exceeds the ${MAX_DOWNLOAD_BYTES / (1024 * 1024)}MB file size limit`,
    );
  return parseDocument(readFileSync(path, 'utf8'), `Pricing document file ${path}`);
}

async function loadDocument(source: string, fetchImpl: typeof fetch): Promise<unknown> {
  if (/^https?:\/\//i.test(source)) {
    if (!/^https:\/\//i.test(source))
      throw new PricingImportCliError('Remote pricing documents must be fetched over https');
    return fetchDocument(source, fetchImpl);
  }
  return readDocumentFile(source);
}

function lock(configPath: string): () => void {
  const lockPath = `${configPath}.cli.lock`;
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, 'wx', 0o600);
  } catch {
    throw new PricingImportCliError('Another V2 CLI write is in progress; retry after it finishes');
  }
  return () => {
    closeSync(descriptor);
    unlinkSync(lockPath);
  };
}

const loopback = (address: string): string =>
  address === '0.0.0.0' || address === '::' ? '127.0.0.1' : address.includes(':') ? `[${address}]` : address;

/**
 * Offline-write guard with the same fail-closed semantics as the other V2 CLI
 * commands (src/cli/v2-management.ts): any listener that answers a probe — or
 * a probe that times out, which may be a busy server — refuses the import.
 * Dry runs never write, so they skip this guard and only read the store.
 */
async function refuseRunning(config: ConfigV2): Promise<void> {
  const probes = [
    `http://${loopback(config.server.bindAddress)}:${config.server.port}/healthz`,
    ...(config.admin.enabled
      ? [`http://${loopback(config.admin.bindAddress)}:${config.admin.port}/admin/api/v1/bootstrap`]
      : []),
  ];
  for (const url of probes) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(400), redirect: 'manual' });
      throw new PricingImportCliError(
        'A server is responding on the configured port; use the admin console/API or stop it before importing pricing offline',
      );
    } catch (error) {
      if (error instanceof PricingImportCliError) throw error;
      if (error instanceof Error && error.name === 'TimeoutError')
        throw new PricingImportCliError(
          'A server may be responding on the configured port (probe timed out); use the admin console/API or stop it before importing pricing offline',
        );
    }
  }
}

/**
 * Imports model pricing from a local JSON file or an https URL into the
 * offline V2 control store. Fatal problems (bad source, bad config, a live
 * server) throw; row-level problems are reported in the returned result.
 */
export async function pricingImport(
  source: string,
  options: PricingImportCliOptions = {},
): Promise<PricingImportResult> {
  if (options.currency !== undefined && !CURRENCY_PATTERN.test(options.currency))
    throw new PricingImportCliError('--currency must be a 3-letter ISO 4217 code (for example USD)');
  const configPath = resolve(options.config ?? DEFAULT_CONFIG_PATH);
  if (!existsSync(configPath))
    throw new PricingImportCliError('Configuration file does not exist; pricing:import requires a V2 configuration');
  const config = v2Config({ config: options.config });
  if (!config) throw new PricingImportCliError('pricing:import requires a V2 configuration (schemaVersion 2)');
  const document = await loadDocument(source, options.fetchImpl ?? fetch);
  const release = lock(configPath);
  let store: ControlStore | undefined;
  try {
    if (!options.dryRun) await refuseRunning(config);
    store = new ControlStore(resolve(dirname(configPath), config.storage.dataDir));
    return importPricingProfiles(document, store, {
      currencyOverride: options.currency,
      defaultProvider: options.provider,
      defaultUpstreamId: options.upstream,
      dryRun: options.dryRun,
      actor: 'cli',
    });
  } finally {
    store?.close();
    release();
  }
}

/** Command entry point for `model-router pricing:import <path-or-url>`. */
export async function pricingImportCli(source: string, options: PricingImportCliOptions = {}): Promise<void> {
  const writeLine = options.writeLine ?? ((line: string) => console.log(line));
  const result = await pricingImport(source, options);
  if (result.dryRun) writeLine('Dry run: no pricing changes were written.');
  writeLine(`Pricing import: ${result.imported} imported, ${result.skipped} skipped, ${result.failed.length} failed.`);
  for (const row of result.skippedRows) writeLine(`  skipped ${row.model}: ${row.reason}`);
  for (const row of result.failed) writeLine(`  failed ${row.model}: ${row.reason}`);
}
