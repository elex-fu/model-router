import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildKeywordMatcher, type KeywordMatcher, matchKeyword } from '../../../src/saas/risk/keyword-matcher.js';

/** Reference semantics: naive lowercase substring scan, first configured keyword wins. */
function legacyMatch(text: string, keywords: readonly string[]): { keyword: string; hit: boolean } {
  const lower = text.toLowerCase();
  for (const keyword of keywords) {
    if (!keyword) continue;
    if (lower.includes(keyword.toLowerCase())) {
      return { keyword, hit: true };
    }
  }
  return { keyword: '', hit: false };
}

function match(matcher: KeywordMatcher | null, text: string): { keyword: string; hit: boolean } {
  const result = matchKeyword(matcher, text);
  return { keyword: result.keyword, hit: result.hit };
}

describe('keyword matcher (Aho-Corasick direct translation)', () => {
  it('returns null for empty or trivially-empty keyword sets', () => {
    assert.equal(buildKeywordMatcher([]), null);
    assert.equal(buildKeywordMatcher(['', '']), null);
  });

  it('matches the legacy naive-scan behavior on fixed cases', () => {
    const cases: ReadonlyArray<{ name: string; text: string; keywords: readonly string[] }> = [
      { name: 'miss', text: 'clean prompt', keywords: ['blocked', 'secret'] },
      { name: 'case insensitive', text: 'contains SECRET value', keywords: ['secret'] },
      { name: 'configured order wins', text: 'early appears before later', keywords: ['later', 'early'] },
      { name: 'overlap uses configured order', text: 'abc', keywords: ['bc', 'abc'] },
      { name: 'unicode', text: '这里包含敏感词和世界', keywords: ['世界', '敏感词'] },
      { name: 'duplicates', text: 'duplicate', keywords: ['duplicate', 'DUPLICATE'] },
      { name: 'empty entries', text: 'blocked', keywords: ['', 'blocked'] },
      { name: 'keyword at start', text: 'hit immediately', keywords: ['hit'] },
      { name: 'keyword at end', text: 'ends with hit', keywords: ['hit'] },
      { name: 'no keywords', text: 'anything', keywords: [] },
    ];
    for (const testCase of cases) {
      const matcher = buildKeywordMatcher(testCase.keywords);
      const want = legacyMatch(testCase.text, testCase.keywords);
      const got = match(matcher, testCase.text);
      assert.deepEqual(got, want, `case ${testCase.name}`);
    }
  });

  it('matches failure-link behavior where a naive scan differs only in reporting order', () => {
    // "she" and "he" overlap: reaching the end of "she" via failure links must
    // still surface "he" when it is configured first.
    const matcher = buildKeywordMatcher(['he', 'she']);
    assert.deepEqual(match(matcher, 'she said'), { keyword: 'he', hit: true });
    const reversed = buildKeywordMatcher(['she', 'he']);
    assert.deepEqual(match(reversed, 'she said'), { keyword: 'she', hit: true });
  });

  it('matches keywords spanning the whole text and mid-word', () => {
    const matcher = buildKeywordMatcher(['敏感', 'mid']);
    assert.deepEqual(match(matcher, '敏感'), { keyword: '敏感', hit: true });
    assert.deepEqual(match(matcher, 'a mid b'), { keyword: 'mid', hit: true });
    assert.deepEqual(match(matcher, 'midimidl'), { keyword: 'mid', hit: true });
    assert.equal(match(matcher, 'clean').hit, false);
  });

  it('matches randomized corpora against the naive reference', () => {
    // Deterministic LCG (no seedable node:crypto randomness needed).
    let seed = 20260714;
    const random = (max: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % max;
    };
    const alphabet = 'abcXYZ';
    for (let iteration = 0; iteration < 1000; iteration++) {
      const keywords: string[] = [];
      const keywordCount = 1 + random(30);
      for (let index = 0; index < keywordCount; index++) {
        const length = 1 + random(8);
        let value = '';
        for (let i = 0; i < length; i++) value += alphabet[random(alphabet.length)];
        keywords.push(value);
      }
      let text = '';
      const textLength = 20 + random(100);
      for (let i = 0; i < textLength; i++) text += alphabet[random(alphabet.length)];

      const matcher = buildKeywordMatcher(keywords);
      const want = legacyMatch(text, keywords);
      const got = match(matcher, text);
      assert.deepEqual(got, want, `iteration ${iteration} keywords=${keywords.join('|')} text=${text}`);
    }
  });

  it('matches with a fresh matcher per call (immutability of frozen automaton)', () => {
    const keywords = ['alpha', 'beta', 'gamma'];
    const matcher = buildKeywordMatcher(keywords);
    for (let i = 0; i < 100; i++) {
      assert.deepEqual(match(matcher, `gamma run ${i}`), { keyword: 'gamma', hit: true });
      assert.equal(match(matcher, `clean run ${i}`).hit, false);
    }
  });

  it('builds and matches 10,000 keywords within latency budgets', () => {
    const keywords: string[] = [];
    for (let i = 0; i < 10000; i++) {
      // Mix of latin and CJK keywords with varying lengths up to ~200 runes.
      const length = 8 + (i % 40);
      let keyword = `kw${i}`;
      while ([...keyword].length < length) keyword += i % 2 === 0 ? '敏感词组' : 'xymtok';
      keywords.push([...keyword].slice(0, 200).join(''));
    }
    keywords.push('canary-hit-token');

    const buildStart = process.hrtime.bigint();
    const matcher = buildKeywordMatcher(keywords);
    const buildMs = Number(process.hrtime.bigint() - buildStart) / 1e6;
    assert.ok(matcher !== null);

    const probeLength = 12000;
    let probe = '';
    for (let i = 0; i < probeLength; i += 40) probe += 'clean text without any banned tokens. ';
    const probeRunes = [...probe].length;
    assert.ok(probeRunes <= 12000);

    // Warm up JIT then measure.
    for (let i = 0; i < 50; i++) matchKeyword(matcher, probe);
    const iterations = 200;
    const matchStart = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) matchKeyword(matcher, probe);
    const matchMs = Number(process.hrtime.bigint() - matchStart) / 1e6;
    const perCallMs = matchMs / iterations;

    assert.deepEqual(match(matcher, 'totally fine text canary-hit-token suffix'), {
      keyword: 'canary-hit-token',
      hit: true,
    });
    assert.equal(match(matcher, probe).hit, false);

    // Generous CI budgets: build is one-shot per config change; the
    // per-request scan must stay far below typical upstream latency. The
    // build bound keeps 4x headroom over an uncontended run so parallel
    // test-suite CPU contention does not mask real algorithmic regressions
    // (which would overshoot by orders of magnitude, not by contention).
    assert.ok(buildMs < 8000, `build of 10k keywords took ${buildMs.toFixed(1)}ms (budget 8000ms)`);
    assert.ok(perCallMs < 5, `match over ${probeRunes} runes took ${perCallMs.toFixed(3)}ms (budget 5ms)`);
  });
});
