import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { completeGateRun } from './gate-evidence.mjs';

const baseGates = ['A0', 'A1', 'moderation-auto-ban'];
const paidGates = ['B0', 'B1', 'C0', 'C1', 'C2'];
const liveGates = new Set(['A0', 'A1', 'A2', 'B0', 'B1']);

export function strictC0Artifacts(documents, sha) {
  return documents.some(({ data: run }) => {
    if (run?.ok !== true || run.serialProfile !== true || run.requestDiagnostics?.enabled !== false ||
      run.postgresPreparedStatements !== 'off' || run.postgresDurability?.fsync !== 'on' ||
      run.postgresDurability?.synchronousCommit !== 'on' || run.sourceChanged !== false ||
      run.distChanged !== false || run.harnessChanged !== false ||
      run.candidateBefore?.clean !== true || run.candidateAfter?.clean !== true ||
      run.candidateBefore.sha !== sha || run.candidateAfter.sha !== sha ||
      !/^[a-f0-9]{64}$/.test(run.candidateBefore.fingerprint ?? '') ||
      run.candidateBefore.fingerprint !== run.candidateAfter.fingerprint ||
      !['processesStopped', 'postgresStopped', 'runtimeRemoved'].every((key) => run.cleanup?.[key] === true) ||
      !Array.isArray(run.scenes) || run.scenes.length !== 1) return false;
    const scene = run.scenes[0];
    if (!scene || typeof scene.report !== 'string') return false;
    const report = documents.find((document) => document.path === scene.report)?.data;
    if (scene.ok !== true || report?.tool !== 'bench-gateway' || !Array.isArray(report.violations) || report.violations.length !== 0 ||
      report.config?.requests !== 100 || report.config.streamSamples !== 100 || report.config.warmupInflight !== 1 ||
      report.config.instanceCount !== 3 || report.config.noFail !== false ||
      report.config.p99OverheadMs !== 30 || report.config.ttfbOverheadMs !== 10 ||
      Object.keys(report.scenarios ?? {}).sort().join(',') !== 'latency,ttfb') return false;
    const { latency, ttfb } = report.scenarios;
    if (!latency || !ttfb) return false;
    return [latency.direct, latency.gateway, ttfb.direct, ttfb.gateway].every((leg) => leg?.n === 100) &&
      ttfb.gatewayErrors === 0 && Number.isFinite(latency.p99OverheadMs) && latency.p99OverheadMs <= 30 &&
      Number.isFinite(ttfb.ttfbOverheadMs) && ttfb.ttfbOverheadMs <= 10;
  });
}
const checks = {
  A0: ['realUpstream', 'firstRequest', 'nativeJson', 'nativeSse', 'durableUsage'],
  A1: ['realUpstream', 'realCli', 'twoToolRounds', 'thinking', 'cancellation', 'durableUsage', 'reconnectConsistency'],
  A2: ['realUpstream', 'approvedTrustedBound', 'usageEnvelopeEnforced', 'durableUsage'],
  B0: ['realPsp', 'create', 'credit', 'query', 'postReplay', 'callbackOutOfOrder', 'fullRefund', 'partialRefund', 'unknownOutcome'],
  B1: ['realPsp', 'noDoubleCredit', 'noOverRefund', 'refundReplay', 'unknownRetained', 'restartRecovery'],
  C1: ['workerCrash', 'noDoubleSettlement', 'unknownRetained', 'replayRecovery'],
  C2: ['productionKms', 'iamLeastPrivilege', 'crossRegionPitr', 'haFailover', 'alertDelivery', 'onCallAcknowledged', 'operationsSignoff'],
  'moderation-auto-ban': ['realGatewayRole', 'keyRevocation', 'authorizationFence', 'operatorProtection', 'atomicRollback'],
  FAST: ['openaiNative', 'anthropicNative', 'zeroRejections', 'stableAcceptance', 'T11', 'T12', 'T13', 'T14'],
  'G-B5': ['websocket', 'audioMeteringReviewed', 'audioMeteringEnforced', 'cancellation', 'unknownRetained'],
};

export function releaseReadiness(manifest, candidate, readArtifact = (path) => readFileSync(path)) {
  const errors = [];
  if (!candidate?.clean || !/^[a-f0-9]{40}$/.test(candidate?.sha ?? '')) errors.push('candidate must be a clean, exact Git SHA');
  if (manifest?.schema !== 1 || manifest?.candidateSha !== candidate?.sha) errors.push('manifest candidate SHA differs from the current candidate');
  if (!['M1', 'M2', 'M3'].includes(manifest?.milestone)) errors.push('milestone must be M1, M2 or M3');
  if (!Array.isArray(manifest?.evidence)) return { ok: false, errors: [...errors, 'evidence must be an array'] };
  const required = [...baseGates, ...(['M2', 'M3'].includes(manifest.milestone) ? paidGates : []),
    ...(manifest.milestone === 'M3' ? ['A2', 'protocol-matrix'] : [])];
  for (const [feature, gate] of [['fast', 'FAST'], ['codex', 'A2'], ['realtime', 'G-B5']]) {
    if (typeof manifest.features?.[feature] !== 'boolean') errors.push(`${feature} must be explicitly enabled or disabled`);
    if (manifest.features?.[feature] === true) required.push(gate);
  }
  for (const gate of new Set(required)) {
    const entries = manifest.evidence.filter((entry) => entry?.gate === gate);
    if (entries.length !== 1) { errors.push(`${gate}: exactly one evidence record required`); continue; }
    const entry = entries[0];
    const reject = (message) => errors.push(`${gate}: ${message}`);
    if (entry.sourceSha !== candidate?.sha || entry.sourceClean !== true || entry.sourceStable !== true) reject('evidence must bind the same clean, unchanged SHA');
    if (entry.result !== 'pass' || !Number.isFinite(Date.parse(entry.finishedAt))) reject('a completed passing run is required');
    if (liveGates.has(gate) && entry.kind !== 'live') reject('real external evidence required; synthetic fixtures cannot substitute');
    if (gate === 'C2' && entry.kind !== 'production') reject('production evidence required; local drills cannot substitute');
    for (const name of checks[gate] ?? []) if (entry.checks?.[name] !== true) reject(`missing ${name}`);
    if (gate === 'moderation-auto-ban' && ![15, 18].every((version) => entry.postgresMajors?.includes(version))) reject('PG15 and PG18 both required');
    if (gate === 'B0' || gate === 'B1') {
      if (!['sandbox', 'production'].includes(entry.pspEnvironment)) reject('PSP environment must be sandbox or production');
    }
    if (gate === 'A2') {
      const scope = entry.scope;
      for (const axis of ['endpoint', 'productId', 'model', 'operation', 'transport', 'continuationMode']) {
        if (typeof scope?.[axis] !== 'string' || !scope[axis].trim()) reject(`missing exact scope axis ${axis}`);
      }
      if (typeof entry.backendRevision !== 'string' || !entry.backendRevision.trim() || entry.backendRevision === 'unknown') reject('known backend revision required');
    }
    if (gate === 'C0' || gate === 'FAST') {
      const p = entry.performance;
      if (entry.kind !== 'performance' || p?.strict !== true || p?.serial !== true ||
        p?.fsync !== 'on' || p?.synchronousCommit !== 'on' || p?.preparedStatements !== 'off' ||
        !Number.isFinite(p?.p99OverheadMs) || p.p99OverheadMs > 30 ||
        !Number.isFinite(p?.ttfbOverheadMs) || p.ttfbOverheadMs > 10 ||
        !Array.isArray(p?.legs) || p.legs.length !== 4 ||
        !['direct-latency', 'gateway-latency', 'direct-ttfb', 'gateway-ttfb'].every((name) =>
          p.legs.filter((leg) => leg?.name === name && Number.isSafeInteger(leg.samples) && leg.samples >= 100 &&
            leg.errors === 0 && leg.bodyComplete === true).length === 1)) reject('strict four-leg 30ms/10ms performance contract not met');
    }
    if (gate === 'protocol-matrix' && entry.checks?.completeAllowlist !== true) reject('complete protocol allowlist required');
    const summaries = [];
    const documents = [];
    if (!Array.isArray(entry.artifacts) || entry.artifacts.length === 0) reject('hashed artifacts required');
    else for (const artifact of entry.artifacts) {
      try {
        if (typeof artifact?.path !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error();
        const bytes = readArtifact(artifact.path);
        if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error();
        try {
          const data = JSON.parse(bytes.toString('utf8'));
          summaries.push(data); documents.push({ path: artifact.path, data });
        } catch { /* External artifacts may be signed documents. */ }
      } catch { reject('artifact missing or digest mismatch'); }
    }
    if (gate === 'C0' && !strictC0Artifacts(documents, candidate?.sha)) reject('native R9 summary and its hashed benchmark report must independently pass the unchanged C0 contract');
    if (baseGates.includes(gate)) {
      // Count evidence comes from the runner artifact itself, never a hand
      // written number in the release manifest. Fixtures with every test
      // skipped and dirty development runs cannot certify a release.
      const runs = summaries.filter((summary) => summary?.ok === true && summary.commit === candidate?.sha &&
        summary.candidateBefore?.clean === true && summary.candidateAfter?.clean === true &&
        summary.candidateBefore.sha === candidate?.sha && summary.candidateAfter.sha === candidate?.sha &&
        /^[a-f0-9]{64}$/.test(summary.candidateBefore.fingerprint ?? '') &&
        summary.candidateBefore.fingerprint === summary.candidateAfter.fingerprint &&
        Array.isArray(summary.suites) && summary.suites.length > 0 &&
        summary.suites.every((suite) => suite?.ok === true && completeGateRun(suite.code, suite.counts ?? {})));
      const rootMatches = (suite) => gate === 'A0' ? /(?:kimi-commercial|platform-access-first-request)-live\.test\.ts$/.test(suite.test)
        : gate === 'A1' ? /platform-access-cli-.*-live\.test\.ts$/.test(suite.test)
          : suite.test === 'tests/saas/risk/content-moderation.postgres.integration.test.ts';
      const matching = runs.filter((run) => run.suites.some(rootMatches));
      if (matching.length === 0) reject('native passing runner counts from the exact candidate required');
      if (gate === 'moderation-auto-ban' && ![15, 18].every((version) =>
        matching.some((run) => new RegExp(`PostgreSQL\\) ${version}(?:\\.|\\s|$)`).test(run.postgresVersion ?? '')))) reject('native PG15 and PG18 auto-ban artifacts required');
    }
  }
  return { ok: errors.length === 0, candidateSha: candidate?.sha, milestone: manifest?.milestone, errors };
}

export function readReleaseManifest(path) {
  const absolute = resolve(path);
  return JSON.parse(readFileSync(absolute, 'utf8'));
}
