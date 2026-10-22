import { readFile } from 'node:fs/promises';
import {
  getSaasBackupStatus,
  runSaasBackup,
  type SaasBackupDependencies,
  SaasBackupFailure,
  verifySaasBackupRestore,
} from '../saas/backup/service.js';
import { parseSaasDeployEnvFile } from './saas-deploy-shared.js';

export interface SaasBackupCommandOptions {
  readonly policy?: string;
  readonly envFile?: string;
  readonly allowLocalPlaintext?: boolean;
  readonly ifDue?: boolean;
  readonly backupId?: string;
}

export async function saasBackup(
  action: 'run' | 'status' | 'verify-restore',
  options: SaasBackupCommandOptions = {},
  dependencies: SaasBackupDependencies & { readonly writeLine?: (line: string) => void } = {},
): Promise<{ readonly exitCode: 0 | 1 }> {
  const write = dependencies.writeLine ?? ((line: string) => process.stdout.write(`${line}\n`));
  try {
    let env = dependencies.env ?? process.env;
    if (options.envFile) {
      let text: string;
      try {
        text = await readFile(options.envFile, 'utf8');
      } catch {
        throw new SaasBackupFailure('ENV_FILE_UNREADABLE', 'Unable to read the backup environment file');
      }
      env = { ...env, ...parseSaasDeployEnvFile(text, 'backup environment file') };
    }
    const operation = {
      policyFile: options.policy,
      allowLocalPlaintext: options.allowLocalPlaintext,
      ifDue: options.ifDue,
    };
    const deps = { ...dependencies, env };
    if (action === 'status') {
      const status = await getSaasBackupStatus(operation, deps);
      write(JSON.stringify(status));
      return { exitCode: status.readiness.ok ? 0 : 1 };
    }
    if (action === 'verify-restore') {
      if (!options.backupId) throw new SaasBackupFailure('BACKUP_ID_REQUIRED', '--backup-id is required');
      const receipt = await verifySaasBackupRestore({ ...operation, backupId: options.backupId }, deps);
      write(JSON.stringify({ status: 'restore-verified', receipt }));
    } else {
      write(JSON.stringify(await runSaasBackup(operation, deps)));
    }
    return { exitCode: 0 };
  } catch (error) {
    const known = error instanceof SaasBackupFailure;
    write(
      JSON.stringify({
        status: 'failed',
        error: {
          code: known ? error.code : 'BACKUP_OPERATION_FAILED',
          message: known
            ? error.message
            : 'Backup operation failed; sensitive database and adapter output was withheld',
        },
      }),
    );
    return { exitCode: 1 };
  }
}
