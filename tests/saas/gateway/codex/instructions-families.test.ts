import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CODEX_FAMILY_SPECS,
  extractBaseInstructions,
  fetchGithubTextContent,
  planAssetRelease,
  readStagedAssets,
  renderGeneratedModule,
  syncCodexInstructions,
} from '../../../../scripts/saas/codex-sync-instructions.js';
import {
  CODEX_FALLBACK_INSTRUCTIONS,
  codexInstructionsForModel,
  codexModelFamily,
  resolveCodexInstructions,
} from '../../../../src/saas/gateway/codex/instructions.js';
import {
  CODEX_FAMILY_INSTRUCTIONS,
  CODEX_INSTRUCTIONS_FALLBACK,
  CODEX_INSTRUCTIONS_SOURCE_REF,
} from '../../../../src/saas/gateway/codex/instructions-families.generated.js';
import { applyCodexCompilation, codexProviderRequestTransform } from '../../../../src/saas/gateway/codex/payload.js';

const ASSET_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '../../../../src/saas/gateway/codex/instructions');

const FAMILY_CASES: ReadonlyArray<readonly [model: string, family: string]> = [
  ['gpt-5.3-codex', 'codex'],
  ['gpt-5.1-codex-max', 'codex'],
  ['gpt-5.6-luna', 'gpt-5.6'],
  ['gpt-5.5', 'gpt-5.5'],
  ['gpt-5.4-mini', 'gpt-5.4'],
  ['gpt-5.2', 'gpt-5.2'],
  ['gpt-6-astra', 'gpt-5.5'],
  ['unknown-model', 'gpt-5.5'],
  ['provider/gpt-5.5', 'gpt-5.5'],
  ['  GPT-5.2  ', 'gpt-5.2'],
  ['', 'gpt-5.5'],
];

for (const [model, family] of FAMILY_CASES) {
  test(`model family mapping: ${JSON.stringify(model)} -> ${family}`, () => {
    assert.equal(codexModelFamily(model), family);
    assert.equal(codexInstructionsForModel(model), CODEX_FAMILY_INSTRUCTIONS[family]);
  });
}

test('generated family prompts are substantial, newline-terminated strings', () => {
  for (const family of Object.keys(CODEX_FAMILY_INSTRUCTIONS)) {
    const text = CODEX_FAMILY_INSTRUCTIONS[family];
    assert.equal(typeof text, 'string', `${family} must be a string`);
    assert.ok(text.length > 1000, `${family} prompt should carry the real base instructions`);
    assert.ok(text.endsWith('\n'), `${family} prompt must end with a newline`);
  }
  assert.equal(typeof CODEX_INSTRUCTIONS_FALLBACK, 'string');
  assert.ok(CODEX_INSTRUCTIONS_FALLBACK.length > 100);
  assert.equal(typeof CODEX_INSTRUCTIONS_SOURCE_REF, 'string');
  assert.match(CODEX_INSTRUCTIONS_SOURCE_REF, /^rust-v/, 'source ref must record the openai/codex tag');
});

test('generated constants match the staged asset files (atomic pairing)', async () => {
  const staged = await readStagedAssets(ASSET_DIR);
  for (const spec of CODEX_FAMILY_SPECS) {
    const asset = staged[spec.family];
    assert.ok(asset !== undefined, `family ${spec.family} must have a staged asset`);
    assert.equal(asset.text, CODEX_FAMILY_INSTRUCTIONS[spec.family], `${spec.family} drifted from ${asset.fileName}`);
  }
  const fallback = await readFile(join(ASSET_DIR, 'fallback.txt'), 'utf8');
  assert.equal(fallback, CODEX_INSTRUCTIONS_FALLBACK);
  assert.equal(CODEX_FALLBACK_INSTRUCTIONS, CODEX_INSTRUCTIONS_FALLBACK, 'compat alias stays in sync');
});

test('client-provided instructions win verbatim; otherwise the family prompt is used', () => {
  assert.equal(resolveCodexInstructions('custom system prompt', 'gpt-5.2'), 'custom system prompt');
  assert.equal(resolveCodexInstructions('   ', 'gpt-5.2'), CODEX_FAMILY_INSTRUCTIONS['gpt-5.2']);
  assert.equal(resolveCodexInstructions(undefined, 'gpt-5.2'), CODEX_FAMILY_INSTRUCTIONS['gpt-5.2']);
  assert.equal(resolveCodexInstructions(123, 'gpt-5.2'), CODEX_FAMILY_INSTRUCTIONS['gpt-5.2']);
  // No model at all (legacy call sites): latest-known family.
  assert.equal(resolveCodexInstructions(undefined), CODEX_FAMILY_INSTRUCTIONS['gpt-5.5']);
});

test('the resolver never returns an empty string', () => {
  for (const model of ['', 'unknown-model', 'gpt-6-astra', 'provider/x/codex']) {
    assert.ok(codexInstructionsForModel(model).length > 0, `model ${model} resolved to empty instructions`);
    assert.ok(resolveCodexInstructions(null, model).length > 0);
  }
});

test('applyCodexCompilation threads the payload model into the resolver', () => {
  const byBodyModel = applyCodexCompilation({ model: 'gpt-5.2', input: [] }) as Record<string, unknown>;
  assert.equal(byBodyModel.instructions, CODEX_FAMILY_INSTRUCTIONS['gpt-5.2']);

  const codexFamily = applyCodexCompilation({ model: 'gpt-5.1-codex-max', input: [] }) as Record<string, unknown>;
  assert.equal(codexFamily.instructions, CODEX_FAMILY_INSTRUCTIONS.codex);

  const byOption = applyCodexCompilation({ model: 'gpt-5.2', input: [] }, { model: 'gpt-5.4' }) as Record<
    string,
    unknown
  >;
  assert.equal(byOption.instructions, CODEX_FAMILY_INSTRUCTIONS['gpt-5.4']);
});

test('compiler hook resolves instructions from the bridged body model', () => {
  const out = codexProviderRequestTransform({
    providerId: 'openai-codex',
    productId: 'codex-chatgpt',
    clientProtocol: 'anthropic',
    providerProtocol: 'responses',
    providerOperation: 'responses.create',
    body: { model: 'gpt-5.6-luna', input: [{ role: 'user', content: 'hi' }] },
  }) as Record<string, unknown>;
  assert.equal(out.instructions, CODEX_FAMILY_INSTRUCTIONS['gpt-5.6']);
});

test('models.json slug extraction walks nested structures', () => {
  const modelsJson = JSON.stringify({
    families: [{ models: [{ slug: 'gpt-5.6-sol', base_instructions: 'sol text' }] }],
    models: [{ slug: 'gpt-5.4', base_instructions: '54 text' }, { slug: 'no-instructions' }],
  });
  assert.deepEqual(extractBaseInstructions(modelsJson), {
    'gpt-5.6-sol': 'sol text',
    'gpt-5.4': '54 text',
  });
});

test('planAssetRelease bumps changed families in lockstep and keeps unchanged ones', () => {
  const staged: Record<string, { family: string; version: number; fileName: string; text: string }> = {};
  const fetched: Record<string, string> = {};
  for (const spec of CODEX_FAMILY_SPECS) {
    staged[spec.family] = { family: spec.family, version: 1, fileName: `${spec.fileStem}-v1.txt`, text: 'same text' };
    fetched[spec.family] = 'same text';
  }
  staged.codex = { family: 'codex', version: 3, fileName: 'codex-codex-v3.txt', text: 'codex text' };
  fetched.codex = 'codex text';
  fetched['gpt-5.2'] = 'new 52 text';
  const plan = planAssetRelease(staged, fetched);
  const byFamily = Object.fromEntries(plan.map((asset) => [asset.family, asset]));
  assert.equal(byFamily.codex.changed, false);
  assert.equal(byFamily.codex.fileName, 'codex-codex-v3.txt');
  assert.equal(byFamily['gpt-5.2'].changed, true);
  // One release = one version number: next N is the highest staged N + 1.
  assert.equal(byFamily['gpt-5.2'].fileName, 'codex-gpt5-2-v4.txt');
  for (const spec of CODEX_FAMILY_SPECS) {
    if (spec.family !== 'gpt-5.2') assert.equal(byFamily[spec.family].changed, false);
  }
});

test('fetchGithubTextContent retries transient failures and decodes base64', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls === 1) return new Response('rate limited', { status: 503 });
    return new Response(
      JSON.stringify({ content: Buffer.from('prompt text\n').toString('base64'), encoding: 'base64' }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  }) as unknown as typeof fetch;
  const text = await fetchGithubTextContent('codex-rs/core/gpt_5_codex_prompt.md', 'rust-vTEST', fetchImpl);
  assert.equal(text, 'prompt text\n');
  assert.equal(calls, 2);
});

interface StubResponseSpec {
  readonly status: number;
  readonly body?: string;
}

function stubFetch(routes: Record<string, StubResponseSpec>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [fragment, spec] of Object.entries(routes)) {
      if (!url.includes(fragment)) continue;
      if (spec.status !== 200) return new Response(spec.body ?? 'boom', { status: spec.status });
      return new Response(
        JSON.stringify({ content: Buffer.from(spec.body ?? '', 'utf8').toString('base64'), encoding: 'base64' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

const SEED_FAMILY_TEXT = 'old family prompt\n';

async function seedAssetDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-sync-test-'));
  for (const spec of CODEX_FAMILY_SPECS) {
    await writeFile(join(dir, `${spec.fileStem}-v1.txt`), SEED_FAMILY_TEXT);
  }
  await writeFile(join(dir, 'fallback.txt'), 'minimal fallback instruction\n');
  return dir;
}

function upstreamRoutes(nextTexts: Record<string, string>): Record<string, StubResponseSpec> {
  const slugTexts: Record<string, string> = {};
  for (const spec of CODEX_FAMILY_SPECS) {
    if (spec.slug !== null) slugTexts[spec.slug] = nextTexts[spec.family];
  }
  return {
    'gpt_5_codex_prompt.md': { status: 200, body: nextTexts.codex },
    'models.json': {
      status: 200,
      body: JSON.stringify({
        models: Object.entries(slugTexts).map(([slug, base]) => ({ slug, base_instructions: base })),
      }),
    },
  };
}

test('sync writes the next lockstep version and regenerates the module atomically', async () => {
  const dir = await seedAssetDir();
  const generatedPath = join(dir, 'instructions-families.generated.ts');
  const nextTexts: Record<string, string> = { codex: 'new codex prompt\n' };
  for (const spec of CODEX_FAMILY_SPECS) {
    if (spec.family !== 'codex') nextTexts[spec.family] = `new ${spec.family} prompt\n`;
  }

  const first = await syncCodexInstructions({
    ref: 'rust-vTEST',
    assetDir: dir,
    generatedPath,
    fetchImpl: stubFetch(upstreamRoutes(nextTexts)),
  });
  assert.equal(first.sourceRef, 'rust-vTEST');
  assert.equal(first.writtenAssets.length, CODEX_FAMILY_SPECS.length);
  assert.equal(first.regeneratedModule, true);
  // All families advanced together to v2 in one release.
  const files = await readdir(dir);
  assert.ok(files.includes('codex-codex-v2.txt'));
  assert.ok(files.includes('codex-gpt5-2-v2.txt'));

  const moduleText = await readFile(generatedPath, 'utf8');
  assert.ok(moduleText.includes("CODEX_INSTRUCTIONS_SOURCE_REF = 'rust-vTEST'"));
  assert.ok(moduleText.includes('new codex prompt'));
  assert.equal(moduleText, renderGeneratedModule('rust-vTEST', nextTexts, 'minimal fallback instruction\n'));

  // Second run with identical upstream text is a no-op.
  const second = await syncCodexInstructions({
    ref: 'rust-vTEST',
    assetDir: dir,
    generatedPath,
    fetchImpl: stubFetch(upstreamRoutes(nextTexts)),
  });
  assert.deepEqual(second.writtenAssets, []);
  assert.equal(second.regeneratedModule, false);
});

test('sync --from-staged regenerates the module from staged assets without network', async () => {
  const dir = await seedAssetDir();
  const generatedPath = join(dir, 'instructions-families.generated.ts');
  const failingFetch: typeof fetch = (async () =>
    new Response('no network', { status: 599 })) as unknown as typeof fetch;
  const result = await syncCodexInstructions({
    ref: 'rust-vSTAGED',
    assetDir: dir,
    generatedPath,
    fetchImpl: failingFetch,
    fromStaged: true,
  });
  assert.deepEqual(result.writtenAssets, []);
  assert.equal(result.regeneratedModule, true);
  const moduleText = await readFile(generatedPath, 'utf8');
  assert.ok(moduleText.startsWith('// GENERATED by scripts/saas/codex-sync-instructions.ts'));
  assert.ok(moduleText.includes("CODEX_INSTRUCTIONS_SOURCE_REF = 'rust-vSTAGED'"));
  const staged = await readStagedAssets(dir);
  for (const spec of CODEX_FAMILY_SPECS) {
    assert.ok(moduleText.includes(staged[spec.family].text.slice(0, -1)));
  }
});
