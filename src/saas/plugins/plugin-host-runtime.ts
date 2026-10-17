/**
 * Batch-5 §5.1 plugin-host workload runtime — the `--role plugin-host`
 * startup branch (the startCredentialValidationWorkerRuntime pattern).
 *
 * The plugin-host is an isolated workload: it owns the reconcile loop, the
 * plugin child processes, and the internal-token-guarded HTTP surface the
 * gateway calls for forwarding. It opens no public listener, loads no
 * control-plane/gateway providers, and receives exactly one provider
 * capability: the dedicated decrypt-only KMS module for the restricted
 * unseal (types.ts decision #2).
 */

import {
  MODEL_ROUTER_SAAS_PLUGIN_HOST_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE,
  type DeploymentEnvironment,
  type ManagedSaasDeploymentConfig,
} from '../deployment.js';
import { closeSaasDatabase, createSaasDatabase, pingSaasDatabase, type SaasDatabase } from '../db/index.js';
import { verifyPluginHostRuntimePrivileges } from '../db/plugin-host-privileges.js';
import {
  loadPluginHostProviderCredentialKms,
  type LoadedPluginHostProviderCredentialKms,
} from '../runtime/plugin-host-provider-credential-kms.js';
import { PluginManager } from './manager.js';
import {
  createPluginHostHttpServer,
  listenPluginHostHttpServer,
  type PluginHostHttpServerHandle,
} from './plugin-host-server.js';
import { PostgresPluginStore } from './store.js';

export interface PluginHostRuntimeHandle {
  readonly manager: PluginManager;
  readonly database: SaasDatabase;
  close(): Promise<void>;
}

export interface StartPluginHostRuntimeOptions {
  readonly createDatabase?: (options: { connectionString: string }) => SaasDatabase;
  readonly pingDatabase?: (database: SaasDatabase) => Promise<void>;
  readonly closeDatabase?: (database: SaasDatabase) => Promise<void>;
  readonly loadKms?: (env: DeploymentEnvironment) => Promise<LoadedPluginHostProviderCredentialKms | undefined>;
  readonly startManager?: (manager: PluginManager) => Promise<void>;
  readonly pluginsDataDir?: string;
}

export async function startPluginHostRuntime(
  deployment: ManagedSaasDeploymentConfig,
  options: StartPluginHostRuntimeOptions,
  environment: DeploymentEnvironment,
): Promise<PluginHostRuntimeHandle> {
  const kmsModule = deployment.pluginHostProviderCredentialDecryptKmsModule;
  const internalToken = deployment.pluginHostInternalToken;
  const bindAddress = deployment.pluginHostBindAddress;
  const port = deployment.pluginHostPort;
  if (
    typeof kmsModule !== 'string' ||
    kmsModule.trim() === '' ||
    environment[MODEL_ROUTER_SAAS_PLUGIN_HOST_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE] !== kmsModule ||
    typeof internalToken !== 'string' ||
    typeof bindAddress !== 'string' ||
    typeof port !== 'number'
  ) {
    throw new Error('Plugin-host configuration is unavailable');
  }
  const createDatabase =
    options.createDatabase ?? ((input: { connectionString: string }) => createSaasDatabase(input));
  const pingDatabase = options.pingDatabase ?? ((database: SaasDatabase) => pingSaasDatabase(database));
  const closeDatabase = options.closeDatabase ?? ((database: SaasDatabase) => closeSaasDatabase(database));
  const loadKms = options.loadKms ?? ((env: DeploymentEnvironment) => loadPluginHostProviderCredentialKms({ env }));

  let database: SaasDatabase | undefined;
  let kms: LoadedPluginHostProviderCredentialKms | undefined;
  let manager: PluginManager | undefined;
  let server: PluginHostHttpServerHandle | undefined;
  let closePromise: Promise<void> | undefined;
  const close = async (): Promise<void> => {
    closePromise ??= (async () => {
      if (server) await Promise.allSettled([server.close()]);
      if (manager) await Promise.allSettled([manager.stop()]);
      if (kms) await Promise.allSettled([Promise.resolve().then(() => kms?.close())]);
      if (database) await Promise.allSettled([closeDatabase(database)]);
    })();
    await closePromise;
  };

  try {
    database = createDatabase({ connectionString: deployment.postgresUrl });
    try {
      await pingDatabase(database);
    } catch {
      throw new Error('Plugin-host PostgreSQL ping failed');
    }
    try {
      // Fail closed on privilege drift: the plugin-host holds envelope-read
      // grants, so its role must match the manifest exactly before serving.
      await verifyPluginHostRuntimePrivileges(database);
    } catch {
      throw new Error('Plugin-host database privileges are unsafe');
    }
    const loaded = await loadKms(environment);
    if (loaded === undefined) {
      throw new Error('Plugin-host KMS module could not be loaded');
    }
    kms = loaded;
    manager = new PluginManager({
      store: new PostgresPluginStore({ database }),
      executor: database,
      kms,
      dataDir: options.pluginsDataDir ?? process.env.MODEL_ROUTER_SAAS_PLUGINS_DATA_DIR ?? './data/plugins',
      trustedPublishers: deployment.pluginsTrustedPublishers ?? {},
      allowUnsigned: deployment.pluginsAllowUnsigned === true,
      deploymentId: deployment.deploymentId,
      environmentId: deployment.environmentId,
    });
    const startManager = options.startManager ?? ((candidate: PluginManager) => candidate.start());
    await startManager(manager);
    server = createPluginHostHttpServer({ manager, internalToken });
    await listenPluginHostHttpServer(server, { bindAddress, port });
    return {
      manager,
      database,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
