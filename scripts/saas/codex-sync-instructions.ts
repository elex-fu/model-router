/**
 * Codex instruction asset regenerator (P0-2, design:
 * docs/sub2api-parity-upgrade-plan-2026-10-15.md Phase 1.5 "codex-version-sync").
 *
 * Regenerates the ChatGPT-codex `instructions` assets from an openai/codex
 * release and — in the SAME atomic run — the compiled-in family constants
 * (`src/saas/gateway/codex/instructions-families.generated.ts`), so the staged
 * asset files and the runtime constants can never drift apart.
 *
 * Usage:
 *   node --import tsx scripts/saas/codex-sync-instructions.ts [rust-v<version>]
 *   node --import tsx scripts/saas/codex-sync-instructions.ts rust-v0.146.0
 *   node --import tsx scripts/saas/codex-sync-instructions.ts --from-staged [rust-v<version>]
 *     offline recovery mode: keep the currently staged asset files, regenerate
 *     only the generated module from them (no network access).
 *
 * Network: uses the GitHub contents API
 * (`https://api.github.com/repos/openai/codex/contents/<path>?ref=<ref>`) with
 * 5 attempts and exponential backoff — raw.githubusercontent is flaky from this
 * network, the contents API works. Tests never touch the network: the sync
 * engine is importable with an injected `fetch` implementation.
 *
 * Versioning: one release = one version number. When any family's text
 * differs from its staged file, every family that changed is written as
 * `codex-<family>-v<N>.txt` with N = (highest N staged across ALL families) + 1
 * (families advance in lockstep; unchanged families keep their existing file,
 * which keeps reruns idempotent). Fetched text is normalized to end with `\n`.
 *
 * Source material is Apache-2.0 licensed; the generated module records the
 * ref and attribution in its header.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Ref the currently staged assets were generated from. */
export const DEFAULT_SOURCE_REF = 'rust-v0.146.0';

const MAX_FETCH_ATTEMPTS = 5;
const INITIAL_BACKOFF_MS = 500;

export interface CodexFamilySpec {
  /** Family key in CODEX_FAMILY_INSTRUCTIONS (also the resolver's family id). */
  readonly family: string;
  /** Asset file stem: `<stem>-v<N>.txt`. */
  readonly fileStem: string;
  /** models.json slug providing base_instructions; null → the core prompt file. */
  readonly slug: string | null;
}

/** The five families, in generated-module declaration order. */
export const CODEX_FAMILY_SPECS: readonly CodexFamilySpec[] = [
  { family: 'codex', fileStem: 'codex-codex', slug: null },
  { family: 'gpt-5.6', fileStem: 'codex-gpt5-6', slug: 'gpt-5.6-sol' },
  { family: 'gpt-5.5', fileStem: 'codex-gpt5-5', slug: 'gpt-5.5' },
  { family: 'gpt-5.4', fileStem: 'codex-gpt5-4', slug: 'gpt-5.4' },
  { family: 'gpt-5.2', fileStem: 'codex-gpt5-2', slug: 'gpt-5.2' },
];

const CORE_PROMPT_API_PATH = 'codex-rs/core/gpt_5_codex_prompt.md';
const MODELS_JSON_API_PATH = 'codex-rs/models-manager/models.json';
export const FALLBACK_ASSET_NAME = 'fallback.txt';

/** A 404 from the contents API is fatal (wrong ref/path) and is not retried. */
class FatalSyncError extends Error {}

function delay(ms: number): Promise<void> {
  return new Promise((settle) => {
    setTimeout(settle, ms);
  });
}

/**
 * Fetches one file from openai/codex at `ref` via the GitHub contents API and
 * returns its base64-decoded text. Retries transient failures (network errors,
 * non-OK statuses) up to 5 times with exponential backoff.
 */
export async function fetchGithubTextContent(
  apiPath: string,
  ref: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const url = `https://api.github.com/repos/openai/codex/contents/${apiPath}?ref=${encodeURIComponent(ref)}`;
  let lastFailure = 'unknown error';
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    if (attempt > 1) await delay(INITIAL_BACKOFF_MS * 2 ** (attempt - 2));
    try {
      const response = await fetchImpl(url, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'model-router-codex-sync' },
      });
      if (response.status === 404) {
        throw new FatalSyncError(`${apiPath} not found at ${ref} (wrong ref or upstream layout change?)`);
      }
      if (!response.ok) {
        lastFailure = `HTTP ${response.status}`;
        continue;
      }
      const payload = (await response.json()) as { content?: unknown; encoding?: unknown };
      if (payload.encoding !== 'base64' || typeof payload.content !== 'string') {
        lastFailure = 'unexpected contents payload (not a base64 file)';
        continue;
      }
      return Buffer.from(payload.content.replace(/\s+/g, ''), 'base64').toString('utf8');
    } catch (error) {
      if (error instanceof FatalSyncError) throw error;
      lastFailure = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`failed to fetch ${apiPath} @ ${ref} after ${MAX_FETCH_ATTEMPTS} attempts: ${lastFailure}`);
}

/**
 * Extracts every `slug` → `base_instructions` pair from the models-manager
 * models.json. Structure-agnostic deep walk so upstream layout changes
 * (families vs flat models list) do not break the sync.
 */
export function extractBaseInstructions(modelsJson: string): Record<string, string> {
  const parsed: unknown = JSON.parse(modelsJson);
  const found: Record<string, string> = {};
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (typeof record.slug === 'string' && typeof record.base_instructions === 'string' && record.base_instructions.length > 0) {
      found[record.slug] = record.base_instructions;
    }
    for (const value of Object.values(record)) walk(value);
  };
  walk(parsed);
  return found;
}

/** Fetches all five family prompt texts for one release. */
export async function fetchFamilyInstructions(
  ref: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, string>> {
  const corePrompt = normalizeTrailingNewline(await fetchGithubTextContent(CORE_PROMPT_API_PATH, ref, fetchImpl));
  const slugInstructions = extractBaseInstructions(await fetchGithubTextContent(MODELS_JSON_API_PATH, ref, fetchImpl));
  const texts: Record<string, string> = {};
  for (const spec of CODEX_FAMILY_SPECS) {
    const text = spec.slug === null ? corePrompt : slugInstructions[spec.slug];
    if (typeof text !== 'string' || text.length === 0) {
      throw new FatalSyncError(`no instructions found for family ${spec.family} (slug ${spec.slug ?? 'core prompt'})`);
    }
    texts[spec.family] = normalizeTrailingNewline(text);
  }
  return texts;
}

/** Upstream text is normalized to a trailing newline so assets are uniform. */
function normalizeTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

export interface StagedAsset {
  readonly family: string;
  readonly version: number;
  readonly fileName: string;
  readonly text: string;
}

const ASSET_FILE_PATTERN = /^codex-(codex|gpt5-(?:[0-9]+))-v(\d+)\.txt$/;

/** Reads the staged versioned assets (`codex-<stem>-v<N>.txt`) from `assetDir`. */
export async function readStagedAssets(assetDir: string): Promise<Record<string, StagedAsset>> {
  const stemToFamily = new Map(CODEX_FAMILY_SPECS.map((spec) => [spec.fileStem, spec.family] as const));
  const staged: Record<string, StagedAsset> = {};
  for (const entry of await readdir(assetDir)) {
    const match = ASSET_FILE_PATTERN.exec(entry);
    if (match === null) continue;
    const family = stemToFamily.get(`codex-${match[1]}`);
    if (family === undefined) continue;
    const version = Number.parseInt(match[2], 10);
    const previous = staged[family];
    if (previous !== undefined && previous.version >= version) continue;
    staged[family] = {
      family,
      version,
      fileName: entry,
      text: await readFile(join(assetDir, entry), 'utf8'),
    };
  }
  return staged;
}

export interface PlannedAsset {
  readonly family: string;
  readonly fileName: string;
  readonly text: string;
  /** True when this release writes a new versioned file for the family. */
  readonly changed: boolean;
}

/**
 * Plans the release write set: families whose text changed get the next
 * lockstep version number (highest staged N across ALL families + 1); unchanged
 * families keep their current file, which makes reruns idempotent.
 */
export function planAssetRelease(
  staged: Record<string, StagedAsset>,
  fetched: Record<string, string>,
): PlannedAsset[] {
  const highestVersion = CODEX_FAMILY_SPECS.reduce(
    (max, spec) => Math.max(max, staged[spec.family]?.version ?? 0),
    0,
  );
  // One release = one version number: every family written in this run gets
  // the same next N (highest staged N across all families + 1).
  const nextVersion = highestVersion + 1;
  return CODEX_FAMILY_SPECS.map((spec) => {
    const current = staged[spec.family];
    const text = fetched[spec.family];
    if (typeof text !== 'string' || text.length === 0) {
      throw new FatalSyncError(`fetched text missing for family ${spec.family}`);
    }
    if (current !== undefined && current.text === text) {
      return { family: spec.family, fileName: current.fileName, text, changed: false };
    }
    return { family: spec.family, fileName: `${spec.fileStem}-v${nextVersion}.txt`, text, changed: true };
  });
}

const LINE_WIDTH = 120;

function countChar(text: string, char: string): number {
  let count = 0;
  for (const candidate of text) if (candidate === char) count += 1;
  return count;
}

/** Escapes text for a single-quoted TS string literal (newline must not appear raw). */
function escapeSingleQuoted(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Renders a string literal the way biome formats this repo: single quotes by
 * default, switching to double quotes (JSON.stringify escaping) when that
 * results in fewer escapes. Backticks and `$` stay raw — only template
 * literals are unsafe, never quoted strings.
 */
function renderStringLiteral(text: string): string {
  if (countChar(text, '"') < countChar(text, "'")) return JSON.stringify(text);
  return `'${escapeSingleQuoted(text)}'`;
}

const IDENTIFIER_PATTERN = /^[A-Za-z$_][A-Za-z0-9$_]*$/;

function renderRecordKey(key: string): string {
  return IDENTIFIER_PATTERN.test(key) ? key : `'${escapeSingleQuoted(key)}'`;
}

/** Renders the generated family-constants module (exact bytes on disk). */
export function renderGeneratedModule(
  sourceRef: string,
  familyTexts: Record<string, string>,
  fallback: string,
): string {
  const entries = CODEX_FAMILY_SPECS.map((spec) => {
    const key = renderRecordKey(spec.family);
    const value = renderStringLiteral(familyTexts[spec.family]);
    const oneLine = `  ${key}: ${value},`;
    if (oneLine.length <= LINE_WIDTH) return oneLine;
    return `  ${key}:\n    ${value},`;
  });
  const fallbackLiteral = renderStringLiteral(fallback);
  const fallbackOneLine = `export const CODEX_INSTRUCTIONS_FALLBACK = ${fallbackLiteral};`;
  const fallbackStatement =
    fallbackOneLine.length <= LINE_WIDTH
      ? fallbackOneLine
      : `export const CODEX_INSTRUCTIONS_FALLBACK =\n  ${fallbackLiteral};`;
  return [
    '// GENERATED by scripts/saas/codex-sync-instructions.ts — do not edit by hand.',
    `// Source: openai/codex ${sourceRef} (Apache-2.0)`,
    '',
    `export const CODEX_INSTRUCTIONS_SOURCE_REF = ${renderStringLiteral(sourceRef)};`,
    '',
    'export const CODEX_FAMILY_INSTRUCTIONS: Readonly<Record<string, string>> = {',
    ...entries,
    '};',
    '',
    fallbackStatement,
    '',
  ].join('\n');
}

export interface SyncOptions {
  /** openai/codex ref to fetch from; defaults to DEFAULT_SOURCE_REF. */
  readonly ref?: string;
  /** Directory holding the versioned assets + fallback.txt. */
  readonly assetDir: string;
  /** Path of instructions-families.generated.ts. */
  readonly generatedPath: string;
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Offline mode: regenerate the module from the staged assets, no network. */
  readonly fromStaged?: boolean;
}

export interface SyncResult {
  readonly sourceRef: string;
  /** Versioned asset files written by this run (empty when idempotent). */
  readonly writtenAssets: readonly string[];
  /** Whether the generated module bytes changed on disk. */
  readonly regeneratedModule: boolean;
}

/**
 * The full sync: fetch (or reuse staged) family texts, write new versioned
 * assets when text changed, then regenerate the constants module so assets and
 * constants are updated atomically in one run.
 */
export async function syncCodexInstructions(options: SyncOptions): Promise<SyncResult> {
  const sourceRef = options.ref ?? DEFAULT_SOURCE_REF;
  const staged = await readStagedAssets(options.assetDir);

  let planned: PlannedAsset[];
  if (options.fromStaged === true) {
    planned = CODEX_FAMILY_SPECS.map((spec) => {
      const current = staged[spec.family];
      if (current === undefined) {
        throw new FatalSyncError(`--from-staged requires a staged asset for family ${spec.family}`);
      }
      return { family: spec.family, fileName: current.fileName, text: current.text, changed: false };
    });
  } else {
    const fetched = await fetchFamilyInstructions(sourceRef, options.fetchImpl ?? fetch);
    planned = planAssetRelease(staged, fetched);
  }

  const writtenAssets: string[] = [];
  for (const asset of planned) {
    if (!asset.changed) continue;
    await writeFile(join(options.assetDir, asset.fileName), asset.text);
    writtenAssets.push(asset.fileName);
  }

  const fallback = await readFile(join(options.assetDir, FALLBACK_ASSET_NAME), 'utf8');
  const moduleText = renderGeneratedModule(
    sourceRef,
    Object.fromEntries(planned.map((asset) => [asset.family, asset.text])),
    fallback,
  );
  const currentModule = await readFile(options.generatedPath, 'utf8').catch(() => null);
  const regeneratedModule = currentModule !== moduleText;
  if (regeneratedModule) {
    await writeFile(options.generatedPath, moduleText);
  }

  return { sourceRef, writtenAssets, regeneratedModule };
}

async function main(argv: readonly string[]): Promise<void> {
  const fromStaged = argv.includes('--from-staged');
  const ref = argv.find((arg) => !arg.startsWith('--')) ?? DEFAULT_SOURCE_REF;
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, '../..');
  const result = await syncCodexInstructions({
    ref,
    assetDir: join(repoRoot, 'src/saas/gateway/codex/instructions'),
    generatedPath: join(repoRoot, 'src/saas/gateway/codex/instructions-families.generated.ts'),
    fromStaged,
  });
  for (const asset of result.writtenAssets) console.log(`asset written: ${asset}`);
  if (result.writtenAssets.length === 0) console.log('assets up to date (no versioned writes)');
  console.log(
    result.regeneratedModule
      ? `generated module updated: ${result.sourceRef}`
      : 'generated module up to date',
  );
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
