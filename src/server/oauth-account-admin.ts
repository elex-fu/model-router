import { ControlError } from '../control/service.js';
import type { ControlStore } from '../control/store.js';
import type { OAuthAccountStore } from './oauth-accounts.js';

type Provider = 'github_copilot' | 'codex_oauth';

const providers: readonly Provider[] = ['github_copilot', 'codex_oauth'];

export interface OAuthAccountDto {
  id: string;
  provider: Provider;
  type: 'oauth';
  status: 'active' | 'expired' | 'unknown';
  expiresAt: string | null;
  isDefault: boolean;
  refreshAvailable: false;
}

function dto(account: ReturnType<OAuthAccountStore['list']>[number]): OAuthAccountDto {
  return {
    id: account.id,
    provider: account.provider,
    type: 'oauth',
    status: account.expiresAt === undefined ? 'unknown' : account.expiresAt <= Date.now() ? 'expired' : 'active',
    expiresAt: account.expiresAt === undefined ? null : new Date(account.expiresAt).toISOString(),
    isDefault: account.isDefault,
    refreshAvailable: false,
  };
}

function locate(
  store: OAuthAccountStore,
  id: unknown,
): { provider: Provider; account: ReturnType<OAuthAccountStore['list']>[number] } {
  if (typeof id !== 'string' || !id) throw new ControlError(400, 'INVALID_ACCOUNT_ID', 'Account id is required');
  const matches = providers.flatMap((provider) =>
    store
      .list(provider)
      .filter((account) => account.id === id)
      .map((account) => ({ provider, account })),
  );
  if (matches.length > 1) throw new ControlError(409, 'ACCOUNT_ID_CONFLICT', 'Account id matches multiple providers');
  if (matches.length === 0) throw new ControlError(404, 'NOT_FOUND', 'OAuth account not found');
  return matches[0];
}

export function createOAuthAccountAdminAdapters(accounts: OAuthAccountStore, control: ControlStore) {
  return {
    accounts: async () => providers.flatMap((provider) => accounts.list(provider).map(dto)),
    accountPatch: async (input: Record<string, unknown>) => {
      if (
        input.isDefault !== true ||
        Object.keys(input).some((key) => !['accountId', 'actor', 'isDefault'].includes(key))
      )
        throw new ControlError(422, 'UNSUPPORTED_ACCOUNT_MUTATION', 'Only setting isDefault to true is supported');
      const { provider, account } = locate(accounts, input.accountId);
      accounts.setDefault(provider, account.id);
      control.audit(String(input.actor ?? 'admin'), 'oauth.account.set_default', { id: account.id, provider });
      return { ...dto({ ...account, isDefault: true }) };
    },
    accountDelete: async (input: Record<string, unknown>) => {
      const { provider, account } = locate(accounts, input.accountId);
      accounts.remove(provider, account.id);
      control.audit(String(input.actor ?? 'admin'), 'oauth.account.delete', { id: account.id, provider });
      return { id: account.id, provider, deleted: true };
    },
  };
}
