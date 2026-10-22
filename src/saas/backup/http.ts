import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PlatformAdminAccessRequest, PlatformAdminActor } from '../platform/access/types.js';
import { getSaasBackupStatus } from './service.js';
import type { SaasBackupStatus } from './types.js';

export const SAAS_BACKUP_STATUS_PATH = '/admin/api/v1/ops/backups';

export function createSaasBackupHttpHandler(options: {
  readonly access: { authenticate(request: PlatformAdminAccessRequest): Promise<PlatformAdminActor | undefined> };
  readonly status?: () => Promise<SaasBackupStatus>;
}): (request: IncomingMessage, response: ServerResponse) => Promise<boolean> {
  const status = options.status ?? (() => getSaasBackupStatus());
  return async (request, response) => {
    let path: string;
    try {
      path = new URL(request.url ?? '/', 'http://saas-backup.invalid').pathname;
    } catch {
      return false;
    }
    if (path !== SAAS_BACKUP_STATUS_PATH) return false;
    request.resume();
    const json = (code: number, body: unknown): void => {
      const payload = Buffer.from(JSON.stringify(body));
      response.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': payload.length,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      response.end(payload);
    };
    try {
      const actor = await options.access.authenticate(request);
      if (!actor) {
        json(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication is required' } });
        return true;
      }
      if (request.method !== 'GET') {
        json(405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET is supported' } });
        return true;
      }
      json(200, { data: await status() });
    } catch {
      json(503, { error: { code: 'BACKUP_STATUS_UNAVAILABLE', message: 'Backup policy or evidence is unavailable' } });
    }
    return true;
  };
}
