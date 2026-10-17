/**
 * Batch-5 §5.1 test helper: an in-memory PluginStore implementation for
 * manager/reconcile and e2e tests that do not need Postgres. Mirrors the
 * CAS semantics of PostgresPluginStore (0-row update → null / false).
 */

import { randomUUID } from 'node:crypto';
import type {
  PluginBindingRecord,
  PluginInstallationRecord,
  PluginInstallationState,
  PluginKvEntry,
  PluginManifest,
  PluginStore,
} from '../../../src/saas/plugins/types.js';

interface StoredInstallation extends PluginInstallationRecord {
  bindings: StoredBinding[];
  lastUpdatedMs: number;
}

interface StoredBinding extends PluginBindingRecord {}

export class InMemoryPluginStore implements PluginStore {
  public installations: StoredInstallation[] = [];
  private kv: Map<string, PluginKvEntry> = new Map();
  public failListInstallations = false;

  private record(installation: StoredInstallation): PluginInstallationRecord {
    const { bindings: _bindings, lastUpdatedMs: _lastUpdatedMs, ...rest } = installation;
    void _bindings;
    void _lastUpdatedMs;
    return Object.freeze({ ...rest });
  }

  /** Test hook: age a row's updated_at without touching real time. */
  async ageInstallation(id: number, ageMs: number): Promise<void> {
    const found = this.installations.find((installation) => installation.id === id);
    if (found === undefined) return;
    found.updatedAt = new Date(Date.parse(found.updatedAt) - ageMs).toISOString();
  }

  getInstallationSync(pluginKey: string): PluginInstallationRecord | null {
    const found = this.installations.find((installation) => installation.pluginKey === pluginKey);
    return found === undefined ? null : this.record(found);
  }

  async listInstallations(): Promise<PluginInstallationRecord[]> {
    if (this.failListInstallations) throw new Error('simulated database failure');
    return this.installations.map((installation) => this.record(installation));
  }

  async getInstallation(pluginKey: string): Promise<PluginInstallationRecord | null> {
    return this.getInstallationSync(pluginKey);
  }

  async upsertInstallation(input: {
    pluginKey: string;
    name: string;
    version: string;
    description: string;
    author: string;
    manifest: PluginManifest;
    manifestSha256: string;
    entrypointPath: string;
    binarySha256: string;
    signatureStatus: 'trusted' | 'unsigned';
    artifactData: Uint8Array;
    artifactSha256: string;
    installedBy: string | null;
  }): Promise<PluginInstallationRecord> {
    const existing = this.installations.find((installation) => installation.pluginKey === input.pluginKey);
    if (existing !== undefined) {
      if (
        existing.state === 'starting' ||
        existing.state === 'enabled' ||
        existing.bindings.some((binding) => binding.enabled)
      ) {
        const error = new Error('plugin is enabled; replace forbidden') as Error & { code: string };
        error.code = 'plugin_replace_forbidden';
        throw error;
      }
      Object.assign(existing, {
        name: input.name,
        version: input.version,
        description: input.description,
        author: input.author,
        manifest: input.manifest,
        manifestSha256: input.manifestSha256,
        entrypointPath: input.entrypointPath,
        binarySha256: input.binarySha256,
        signatureStatus: input.signatureStatus,
        artifactData: input.artifactData,
        artifactSha256: input.artifactSha256,
        installedBy: input.installedBy,
        state: 'disabled',
        lastError: '',
        enabledAt: null,
        updatedAt: new Date().toISOString(),
      });
      existing.bindings = [];
      return this.record(existing);
    }
    const created: StoredInstallation = {
      id: this.installations.length + 1,
      pluginKey: input.pluginKey,
      name: input.name,
      version: input.version,
      description: input.description,
      author: input.author,
      manifest: input.manifest,
      manifestSha256: input.manifestSha256,
      entrypointPath: input.entrypointPath,
      binarySha256: input.binarySha256,
      signatureStatus: input.signatureStatus,
      state: 'disabled',
      configJson: null,
      lastError: '',
      artifactData: input.artifactData,
      artifactSha256: input.artifactSha256,
      installedBy: input.installedBy,
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      enabledAt: null,
      bindings: [],
      lastUpdatedMs: Date.now(),
    };
    this.installations.push(created);
    return this.record(created);
  }

  async updateInstallationState(input: {
    id: number;
    expectedState: PluginInstallationState | null;
    expectedBinarySha256: string;
    state: PluginInstallationState;
    lastError?: string;
  }): Promise<PluginInstallationRecord | null> {
    const found = this.installations.find((installation) => installation.id === input.id);
    if (
      found === undefined ||
      found.binarySha256 !== input.expectedBinarySha256 ||
      (input.expectedState !== null && found.state !== input.expectedState)
    ) {
      return null;
    }
    found.state = input.state;
    if (input.lastError !== undefined) found.lastError = input.lastError;
    if (input.state === 'disabled' || input.state === 'error' || input.state === 'incompatible') {
      found.enabledAt = null;
    }
    if (input.state === 'enabled') found.enabledAt = new Date().toISOString();
    found.updatedAt = new Date().toISOString();
    return this.record(found);
  }

  async markRuntimeHealthy(input: { id: number; expectedBinarySha256: string }): Promise<boolean> {
    const found = this.installations.find((installation) => installation.id === input.id);
    if (
      found === undefined ||
      found.binarySha256 !== input.expectedBinarySha256 ||
      (found.state !== 'starting' && found.state !== 'error' && found.state !== 'disabled') ||
      !found.bindings.some((binding) => binding.enabled)
    ) {
      return false;
    }
    found.state = 'enabled';
    found.enabledAt = new Date().toISOString();
    found.lastError = '';
    found.updatedAt = new Date().toISOString();
    return true;
  }

  async updateConfigJson(input: {
    id: number;
    configJson: Readonly<Record<string, unknown>> | null;
  }): Promise<PluginInstallationRecord | null> {
    const found = this.installations.find((installation) => installation.id === input.id);
    if (found === undefined) return null;
    found.configJson = input.configJson;
    found.updatedAt = new Date().toISOString();
    return this.record(found);
  }

  async replaceBindings(input: {
    installationId: number;
    bindings: readonly {
      capability: PluginBindingRecord['capability'];
      platform: string;
      accountType: string;
      enabled: boolean;
      rolloutPercent: number;
    }[];
  }): Promise<void> {
    const found = this.installations.find((installation) => installation.id === input.installationId);
    if (found === undefined) return;
    found.bindings = input.bindings.map((binding, index) => ({
      id: index + 1,
      installationId: input.installationId,
      pluginKey: found.pluginKey,
      capability: binding.capability,
      platform: binding.platform,
      accountType: binding.accountType,
      enabled: binding.enabled,
      rolloutPercent: binding.rolloutPercent,
    }));
    found.updatedAt = new Date().toISOString();
  }

  async listBindings(): Promise<PluginBindingRecord[]> {
    return this.installations.flatMap((installation) =>
      installation.bindings.map((binding) => Object.freeze({ ...binding })),
    );
  }

  async deleteInstallation(id: number): Promise<boolean> {
    const index = this.installations.findIndex((installation) => installation.id === id);
    if (index < 0) return false;
    this.installations.splice(index, 1);
    return true;
  }

  async kvGet(pluginKey: string, namespace: string, key: string): Promise<PluginKvEntry | null> {
    return this.kv.get(`${pluginKey}\0${namespace}\0${key}`) ?? null;
  }

  async kvSet(
    pluginKey: string,
    namespace: string,
    key: string,
    value: string,
    ttlSeconds: number | null,
  ): Promise<void> {
    this.kv.set(`${pluginKey}\0${namespace}\0${key}`, {
      namespace,
      key,
      value,
      expiresAt: ttlSeconds === null ? null : new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    });
  }

  async kvDelete(pluginKey: string, namespace: string, key: string): Promise<boolean> {
    return this.kv.delete(`${pluginKey}\0${namespace}\0${key}`);
  }

  async kvList(pluginKey: string, namespace: string, keyPrefix: string, limit: number): Promise<string[]> {
    const prefix = `${pluginKey}\0${namespace}\0`;
    return [...this.kv.keys()]
      .filter((composite) => composite.startsWith(prefix))
      .map((composite) => composite.slice(prefix.length))
      .filter((key) => key.startsWith(keyPrefix))
      .sort()
      .slice(0, limit);
  }
}

/** Minimal valid manifest for tests (capabilities from the authorization table). */
export function testPluginManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    schemaVersion: 1,
    id: 'com.example.mr-mock-transport',
    name: 'Mock Transport Plugin',
    version: '1.2.3',
    description: 'test fixture plugin',
    author: 'test',
    requires: { modelRouter: '>=0.1.0', pluginProtocol: 1, transportApi: 1 },
    capabilities: [{ id: 'claude.oauth.outbound_transport.v1' }],
    entrypoint: 'plugin.mjs',
    files: { 'plugin.mjs': '0'.repeat(64) },
    ...overrides,
  };
}

export function uniquePluginKey(): string {
  return `com.example.mr-test-${randomUUID().slice(0, 8)}`;
}
