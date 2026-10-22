#!/usr/bin/env node
// Recovery-principal canary verification. No plaintext, credentials, child
// output, or ciphertext content is printed, including on failure.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
try {
  const request = JSON.parse(process.env.MODEL_ROUTER_SAAS_BACKUP_REQUEST ?? '');
  const configurationFile = process.env.MODEL_ROUTER_SAAS_BACKUP_KMS_CANARIES_FILE;
  const executable = process.env.MODEL_ROUTER_SAAS_BACKUP_AWS_EXECUTABLE ?? '/usr/local/bin/aws';
  const recoveryProfile = process.env.MODEL_ROUTER_SAAS_BACKUP_RECOVERY_AWS_PROFILE;
  if (request.format !== 'saas-backup-kms-request-v1' || !/^[a-f0-9-]{36}$/.test(request.challenge) ||
    !Array.isArray(request.requiredKeyIds) || !request.requiredKeyIds.length ||
    !configurationFile || !isAbsolute(configurationFile) || !isAbsolute(executable) ||
    !recoveryProfile || recoveryProfile === process.env.AWS_PROFILE) throw new Error('invalid');
  const configInfo = await lstat(configurationFile);
  if (!configInfo.isFile() || configInfo.size > 256 * 1024) throw new Error('invalid');
  const configuration = JSON.parse(await readFile(configurationFile, 'utf8'));
  if (configuration.format !== 'saas-aws-kms-canaries-v1' || !Array.isArray(configuration.canaries)) throw new Error('invalid');
  const recoveredKeyIds = [];
  const evidence = [];
  for (const keyId of request.requiredKeyIds) {
    const canary = configuration.canaries.find((entry) => entry.keyId === keyId);
    if (!canary || typeof canary.ciphertextFile !== 'string' || !isAbsolute(canary.ciphertextFile) ||
      !/^[a-f0-9]{64}$/.test(canary.plaintextSha256) || typeof canary.region !== 'string') throw new Error('invalid');
    const info = await lstat(canary.ciphertextFile);
    if (!info.isFile() || info.size === 0 || info.size > 1024 * 1024) throw new Error('invalid');
    const args = ['--no-cli-pager', '--region', canary.region, 'kms', 'decrypt', '--key-id', keyId,
      '--ciphertext-blob', `fileb://${canary.ciphertextFile}`, '--output', 'json'];
    if (canary.encryptionContext !== undefined) {
      if (canary.encryptionContext === null || typeof canary.encryptionContext !== 'object' ||
        Array.isArray(canary.encryptionContext) || Object.values(canary.encryptionContext).some((value) => typeof value !== 'string')) {
        throw new Error('invalid');
      }
      args.push('--encryption-context', JSON.stringify(canary.encryptionContext));
    }
    const result = await exec(executable, args, { timeout: 30_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, AWS_PROFILE: recoveryProfile, AWS_CLI_AUTO_PROMPT: 'off' }, encoding: 'utf8' });
    const output = JSON.parse(result.stdout);
    if (output.KeyId !== keyId || typeof output.Plaintext !== 'string') throw new Error('invalid');
    const plaintext = Buffer.from(output.Plaintext, 'base64');
    try {
      if (!plaintext.length || createHash('sha256').update(plaintext).digest('hex') !== canary.plaintextSha256) throw new Error('invalid');
    } finally { plaintext.fill(0); }
    recoveredKeyIds.push(keyId);
    evidence.push({ keyId, ciphertextSha256: createHash('sha256').update(await readFile(canary.ciphertextFile)).digest('hex'),
      plaintextSha256: canary.plaintextSha256 });
  }
  process.stdout.write(`${JSON.stringify({ format: 'saas-backup-kms-recovery-v1', challenge: request.challenge,
    verifiedAt: new Date().toISOString(), recoveredKeyIds,
    evidenceSha256: createHash('sha256').update(JSON.stringify(evidence)).digest('hex') })}\n`);
} catch {
  process.stderr.write('KMS recovery canary verification failed; sensitive output withheld\n');
  process.exitCode = 1;
}
