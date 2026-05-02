import crypto from 'node:crypto';

export function generateProxyKey(): string {
  const random = crypto.randomBytes(16).toString('base64url').slice(0, 22);
  return `mrk_${random}`;
}
