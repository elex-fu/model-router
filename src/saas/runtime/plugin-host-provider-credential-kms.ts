import {
  type DecryptProviderCredentialDataKeyRequest,
  type ProviderCredentialUnsealingKms,
} from '../credentials/provider-crypto.js';
import { MODEL_ROUTER_SAAS_PLUGIN_HOST_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE } from '../deployment.js';
import { loadValidationWorkerProviderCredentialKms } from './validation-worker-provider-credential-kms.js';

/**
 * Batch-5 §5.1: dedicated decrypt-only KMS loader for the plugin-host
 * workload (the validation-worker loader pattern, its own env var). The
 * factory contract (`createCredentialValidationWorkerUnsealingKms`) is
 * deliberately shared with the software-KMS pilot module so one operator
 * module can serve any decrypt workload; only the ENV VAR selecting it is
 * plugin-host-specific.
 */
export const SAAS_PLUGIN_HOST_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE =
  MODEL_ROUTER_SAAS_PLUGIN_HOST_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE;

export interface LoadedPluginHostProviderCredentialKms extends ProviderCredentialUnsealingKms {
  decryptDataKey(request: DecryptProviderCredentialDataKeyRequest): Promise<Uint8Array>;
  checkReady(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Loads the plugin-host decrypt KMS module from
 * MODEL_ROUTER_SAAS_PLUGIN_HOST_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE.
 * Delegates to the shared validation-worker loader implementation with the
 * plugin-host specifier presented under the shared variable name (the
 * factory contract is identical). Returns undefined when the variable is
 * absent; plugin-host startup treats that as a configuration error.
 */
export async function loadPluginHostProviderCredentialKms(
  options: Parameters<typeof loadValidationWorkerProviderCredentialKms>[0] = {},
): Promise<LoadedPluginHostProviderCredentialKms | undefined> {
  const environment = options.env ?? process.env;
  const specifier = environment[SAAS_PLUGIN_HOST_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE];
  if (specifier === undefined) return undefined;
  const remapped = {
    ...environment,
    SAAS_VALIDATION_WORKER_PROVIDER_CREDENTIAL_DECRYPT_KMS_MODULE: specifier,
  };
  return loadValidationWorkerProviderCredentialKms({ ...options, env: remapped }) as Promise<
    LoadedPluginHostProviderCredentialKms | undefined
  >;
}
