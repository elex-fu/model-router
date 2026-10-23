import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export interface PaymentCredentialReader {
  read(name: string): Promise<Buffer>;
}

export class PaymentDeploymentError extends Error {
  constructor(readonly code: 'PAYMENT_CONFIG_INVALID' | 'PAYMENT_CREDENTIAL_UNAVAILABLE' | 'PAYMENT_ROLE_FORBIDDEN') {
    super(code);
    this.name = 'PaymentDeploymentError';
  }
}

export function validPaymentCredentialName(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(name) && !name.includes('..');
}

/** A dedicated CP systemd credential directory or operator-provisioned read-only mount. */
export function createPaymentCredentialReader(directory: string): PaymentCredentialReader {
  if (!isAbsolute(directory)) throw new PaymentDeploymentError('PAYMENT_CREDENTIAL_UNAVAILABLE');
  return Object.freeze({
    async read(name: string): Promise<Buffer> {
      if (!validPaymentCredentialName(name)) throw new PaymentDeploymentError('PAYMENT_CREDENTIAL_UNAVAILABLE');
      let handle;
      try {
        const root = await realpath(directory);
        // A symlinked file is rejected even when its target happens to be in the mount.
        handle = await open(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW);
        const info = await handle.stat();
        if (!info.isFile() || info.size < 1 || info.size > 64 * 1024) throw new Error();
        const rootInfo = await stat(root);
        if (!rootInfo.isDirectory()) throw new Error();
        const value = Buffer.alloc(64 * 1024 + 1);
        let length = 0;
        while (length < value.length) {
          const result = await handle.read(value, length, value.length - length, null);
          if (result.bytesRead === 0) break;
          length += result.bytesRead;
        }
        if (length < 1 || length > 64 * 1024) { value.fill(0); throw new Error(); }
        return value.subarray(0, length);
      } catch {
        throw new PaymentDeploymentError('PAYMENT_CREDENTIAL_UNAVAILABLE');
      } finally {
        await handle?.close().catch(() => {});
      }
    },
  });
}
