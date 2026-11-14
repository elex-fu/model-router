import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export function parseGateCounts(stdout) {
  const counts = {};
  for (const name of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo', 'duration_ms']) {
    const matches = [...stdout.matchAll(new RegExp(`^ℹ ${name} (\\d+(?:\\.\\d+)?)\\r?$`, 'gm'))];
    counts[name] = matches.length === 1 ? Number(matches[0][1]) : null;
  }
  return counts;
}

export function completeGateRun(status, counts) {
  return status === 0 && Number.isSafeInteger(counts.tests) && counts.tests > 0 &&
    counts.pass === counts.tests && ['fail', 'cancelled', 'skipped', 'todo'].every((name) => counts[name] === 0);
}

export function sourceIdentity(root) {
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (result.error || result.status !== 0) throw new Error('cannot identify the candidate source');
    return result.stdout;
  };
  const sha = git(['rev-parse', 'HEAD']).trim();
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('candidate requires a full Git SHA');
  // Hash bytes as well as status: modifying an already-dirty file during a
  // run must invalidate that run. Do not record filenames or file contents.
  const digest = createHash('sha256').update(sha);
  const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  digest.update(status);
  for (const path of [...tracked, ...untracked].sort()) {
    digest.update(path).update('\0');
    try { digest.update(createHash('sha256').update(readFileSync(`${root}/${path}`)).digest()); }
    catch (error) { if (error.code !== 'ENOENT') throw error; digest.update('deleted'); }
  }
  return { sha, clean: status.length === 0, fingerprint: digest.digest('hex') };
}

export function promotableGateRun(status, counts, before, after) {
  return completeGateRun(status, counts) && before.clean === true && after.clean === true &&
    before.sha === after.sha && before.fingerprint === after.fingerprint;
}
