import type { ApiKeyMetadata, ApiKeyPrincipalKind } from '../api/saas-client';
import { Badge, Field } from '../components/ui';

export function isApiKeyPrincipalKind(value: string): value is ApiKeyPrincipalKind {
  return value === 'member' || value === 'project_service';
}

export function keyPrincipalLabel(key: ApiKeyMetadata): string {
  return (key.executionPrincipalType === 'project_service' ? '项目服务' : '成员用户') +
    ' · ' + key.executionPrincipalId;
}

function displayKeyDate(value: string | null): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '—';
}

function keyModeLabel(mode: ApiKeyMetadata['supplyMode']): string {
  return mode === 'byok' ? 'BYOK' : '平台供给';
}

function keyStatusLabel(status: ApiKeyMetadata['status']): string {
  return status === 'active' ? '有效' : '已撤销';
}

export function ApiKeyPrincipalSelector({
  value,
  canIssueServiceKey,
  onChange,
}: {
  value: ApiKeyPrincipalKind;
  canIssueServiceKey: boolean;
  onChange: (value: ApiKeyPrincipalKind) => void;
}) {
  return (
    <Field label="执行主体" hint="默认绑定当前登录成员；项目服务绑定当前项目，仅两级 Owner/Admin 可创建和轮换。">
      <select
        aria-label="选择执行主体"
        value={value}
        onChange={(event) => {
          const value = event.target.value;
          if (isApiKeyPrincipalKind(value)) onChange(value);
        }}
      >
        <option value="member">成员用户 — 当前登录成员</option>
        <option value="project_service" disabled={!canIssueServiceKey}>项目服务 — 当前项目</option>
      </select>
    </Field>
  );
}

export function ApiKeyMetadataDetails({ apiKey }: { apiKey: ApiKeyMetadata }) {
  const key = apiKey;
  return (
    <>
      <div className="saas-tenant-heading">
        <div>
          <h3>{key.name}</h3>
          <small>
            <code>{key.prefix}</code>
          </small>
        </div>
        <Badge tone={key.status === 'active' ? 'good' : 'bad'}>{keyStatusLabel(key.status)}</Badge>
      </div>
      <div className="summary-list">
        <div>
          <span>供给模式</span>
          <Badge>{keyModeLabel(key.supplyMode)}</Badge>
        </div>
        <div>
          <span>执行主体</span>
          <strong>{keyPrincipalLabel(key)}</strong>
        </div>
        <div>
          <span>模型范围</span>
          <span>
            {key.modelScopes.map((scope) => (
              <code key={scope}>{scope} </code>
            ))}
          </span>
        </div>
        <div>
          <span>创建时间</span>
          <strong>{displayKeyDate(key.createdAt)}</strong>
        </div>
        <div>
          <span>过期时间</span>
          <strong>{displayKeyDate(key.expiresAt)}</strong>
        </div>
        <div>
          <span>最近使用</span>
          <strong>{key.lastUsedAt ? displayKeyDate(key.lastUsedAt) : '尚未使用'}</strong>
        </div>
        {key.revokedAt && (
          <div>
            <span>撤销时间</span>
            <strong>{displayKeyDate(key.revokedAt)}</strong>
          </div>
        )}
      </div>
    </>
  );
}
