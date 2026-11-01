# OAuth 刷新引擎统一化：引擎核心 + 双 Store 适配器

日期：2026-11-01。状态：**R1–R4 已实施完成**（2026-11-02）。

## 实施结果

- **R1 完成**：`src/oauth-refresh/{core,adapters}.ts` 中性层——`performOAuthRefresh`（无状态单次网络往返+解析+分类）、`refreshBackoffMs`/`shouldRefresh`、统一注册表（五家 SaaS 绑定 + classic 键归一：`codex_oauth` 与 `openai-codex/codex-chatgpt/oauth` 解析到同一 adapter 实例）+ passthrough 逃生口。两侧实现的 11 处语义分歧全部按"更严格者胜"合并（详见 core.ts 的 DIVERGENCE 注释——含响应字节上限 4KiB、content-type 必须校验、终态五元组分类等）。
- **R2 完成**：classic `OAuthRefreshEngine` 换芯（内部全部委托 core+adapters+store；`OAuthRefreshStoreAdapter` 包装 JSON 原子写路径）。**公开 API 零变化**——`tests/server/oauth-refresh.test.ts` 21 项字节未动全过（零语义变化证明）。
- **R3 完成**：SaaS `requestOauthTokenRefresh` 委托 core（~370 行内联实现删除）；Worker/store/rotator/密封/审计全部不动；44 个导出前后集合一致（脚本验证）。两个 codex 绑定保持本地（SaaS 测试钉住 adapterId v1 与 UA 差异，故意不做注册表别名）。
- **R4 完成**：`app_EMoamEEZ…` 常量从 4 份收编为 1 份（仅剩 `src/saas/platform/codex-oauth/oauth.ts` 源头）。
- **验证**：tsc 干净；刷新域 162/162（core 26 + adapters 10 + classic 21 + store 18 + SaaS worker 58 + CLI/池/集成）；全量单相 8,017 通过（backup-restore 6 项 lsof 环境噪音失败，git stash 基线复测确认与本变更无关）。
- **CS5 效益已锁定**：新厂商 = adapters.ts 注册表加一行 + 两侧装配，引擎/网络/分类/退避全部唯一实现。

日期：2026-11-01。原始设计：
依据：重复开发分析（对话记录 2026-11-01）——类别 B（持久化适配层）是唯一"语义一致、可抽象"的重复项；本方案消除它，并为 CS5（Claude/Gemini/Grok 同构复制，届时重复将 ×3）预铺单一实现路径。

## 一、现状量化（重复的精确边界）

| 项 | classic（`src/server/oauth-refresh.ts`，582 行） | SaaS（`src/saas/supply/oauth-token-refresh-worker.ts`，1,724 行） | 语义关系 |
|---|---|---|---|
| 刷新请求核心（HTTP + 表单 + 响应解析 + 失败分类） | `refreshOAuthAccount` | `requestOauthTokenRefresh` | **等价**（同一 grant_type=refresh_token 表单、同一终态错误码五元组、同一响应解析规则） |
| Provider 注册表 | `resolveOAuthRefreshProviderSpec`（codex 固定 + 通用透传） | `FIXED_OAUTH_TOKEN_ADAPTERS` 四家表（codex/claude/grok/gemini） | **SaaS 更全**（四家 vs 一家+透传） |
| 退避计算 | `oauthRefreshBackoffMs`（60s→24h ±10%） | `oauthRefreshFailureBackoffMs`（60s→24h） | 等价（抖动细节略异） |
| 持久化 | `OAuthRefreshAccountStore`（JSON 原子写 + 进程内单飞锁） | `PostgresOauthTokenRefreshWorkerStore.refreshNext`（SKIP LOCKED 行租约 + KMS 密封轮换） | **不同设计，接口可统一** |
| 调度 | 引擎内置 60s 扫描循环 | 独立 Worker 类（批处理 + 轮询 + owner-kind 范围） | 各自保留（节奏语义不同：单进程 vs 多实例） |

**关键验证（决定可行性）**：SaaS worker 的 PG 耦合已经通过 `OauthCredentialRotator` 回调接口隔离——`refreshNext(rotator)` 把"网络刷新"作为参数注入，store 只管行租约与密封写回。这是现成的接缝。

## 二、设计

### 2.1 引擎核心（新：`src/oauth-refresh/core.ts`——中性层，无 classic/SaaS 前缀）

**归一化账号模型**（两个平面各自的账号形状映射进来）：

```typescript
export interface RefreshableCredential {
  readonly key: string;              // 租约/单飞键（classic: provider:id；SaaS: ownerKind:accountId:credentialId）
  readonly providerId: string;       // 归一化 provider 名（见 2.3 注册表键）
  readonly refreshToken: string;
  readonly expiresAtMs: number | null;
}

export interface RefreshWriteback {
  readonly key: string;
  readonly accessToken: string;
  readonly refreshToken: string | null;  // 仅返回才覆写
  readonly expiresAtMs: number | null;
  readonly passthrough?: Readonly<Record<string, string>>;  // SaaS 信封透传字段（id_token 等）
}

export interface RefreshOutcome {
  readonly kind: 'success' | 'terminal' | 'retryable' | 'unsupported' | 'backing-off';
  readonly errorCode?: string;     // 终态五元组 / HTTP 状态
  readonly retryAfterMs?: number;
}
```

**核心纯函数（唯一实现）**：

```typescript
// 一次刷新的网络往返 + 解析 + 分类（无任何存储/调度依赖）
export async function performOAuthRefresh(
  credential: RefreshableCredential,
  adapter: OAuthRefreshAdapter,
  fetchImpl?: OAuthRefreshFetch,
): Promise<{ outcome: RefreshOutcome; writeback: RefreshWriteback | null }>;

// 退避计算（唯一实现，两侧现有公式取并集）
export function refreshBackoffMs(failureCount: number, opts?: { min?: number; max?: number }): number;

// 到期判断（含 force 旁路——classic 上轮补的语义）
export function shouldRefresh(expiresAtMs: number | null, marginMs: number, nowMs: number, force: boolean): boolean;
```

### 2.2 Provider 注册表（归一，消四份常量拷贝）

`src/oauth-refresh/adapters.ts`：

```typescript
export interface OAuthRefreshAdapter {
  readonly id: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly refreshScope: string | null;
  readonly userAgent: string;
  readonly passthroughFields?: readonly string[];
}

// 单一注册表，两个平面各自的 key 都映射进来：
// 'codex_oauth'（classic 键）与 openai-codex/codex-chatgpt/oauth（SaaS 三元组键）
// → 同一 adapter 实例（常量收归此处，漂移锚点注释删除）
export function resolveAdapter(normalizedProviderId: string): OAuthRefreshAdapter | null;
```

四份 `app_EMoamEEZ...` 拷贝收进此表；SaaS 的 `FIXED_OAUTH_TOKEN_ADAPTERS` 与 classic 的 `CODEX_OAUTH_REFRESH_PROVIDER` 都改为 re-export。**CS5 新厂商 = 此表加一行，两个平面同时获得刷新能力。**

### 2.3 Store 适配器（两种，各自保留设计差异）

```typescript
export interface OAuthRefreshStore {
  /** 归一化凭据快照（engine 只见此形状） */
  listDue(nowMs: number, marginMs: number, limit: number): readonly RefreshableCredential[];
  /** 提交结果（成功写回 / 终态标记 / 退避盖戳）——原子性由实现保证 */
  commit(credential: RefreshableCredential, result: { outcome: RefreshOutcome; writeback: RefreshWriteback | null }): Promise<void>;
}
```

| | classic 适配器（`src/server/oauth-refresh-store.ts`） | SaaS 适配器（`src/saas/supply/…-store-postgres.ts` 改造） |
|---|---|---|
| `listDue` | 读 JSON 账号文件过滤 | SKIP LOCKED 行租约认领（现有 SQL 原样） |
| `commit` | 原子 temp-file 重写 | CAS + KMS 密封 + 审计（现有路径原样） |
| 单飞 | 进程内 `inFlight` Map（引擎调度层职责） | 行租约天然跨进程 |
| **不变** | 零依赖、master.key 加密 | 资金级 CAS/审计语义零稀释 |

**SaaS 侧资产不动的部分**：`OauthCredentialRotator` 密封回调、owner-kind 范围、批处理节奏——worker 外壳照旧，只把 `requestOauthTokenRefresh` 的内联实现替换为对 core 的调用（适配 SaaS 的 Uint8Array 密封材料出入）。

### 2.4 两个平面各自保留的外壳（**不统一**）

- **classic `OAuthRefreshEngine`**：保留公开 API（`resolveAccessToken(provider, accountId?, {force})`、`start/close`）——内部全部改调 core + classic store 适配器。**调用方（proxy/index.ts）零改动**。
- **SaaS `OauthTokenRefreshWorker`**：保留 `startOauthTokenRefreshWorker` 与全部 44 个导出签名（测试依赖它们）——`refreshNext` 内部改调 core。**调用方（managed-saas.ts）零改动**。

## 三、不做什么（边界声明）

- **不抽象调度循环**：classic 的 60s 全量扫描与 SaaS 的分批轮询+租约是两种正确设计，强行统一会把 SKIP LOCKED 语义稀释成"可选能力"。
- **不动配额账本/dispatch**（类别 C）：结构性差异，不在本方案范围。
- **不改任何调用方接口**：proxy.ts、index.ts、managed-saas.ts、44 个 SaaS 导出签名全部不动——这是"内部重构零外部影响"的硬约束。

## 四、任务表

| # | 任务 | 锚点 | 量级 |
|---|---|---|---|
| R1 | 中性层 `src/oauth-refresh/{core,adapters}.ts`：`performOAuthRefresh` + 注册表（语义以两侧现有实现的最严者为准——SaaS 的响应上限/超时常量与 classic 的 force 旁路都进 core） | 从两侧现有代码提炼 | 1 天 |
| R2 | classic store 适配器 + `OAuthRefreshEngine` 内部换芯 | `src/server/oauth-refresh.ts` | 0.5 天 |
| R3 | SaaS worker 内部换芯（`refreshNext` → core，保留 rotator/信封） | `oauth-token-refresh-worker.ts` | 1 天 |
| R4 | 常量四拷贝收编 + 两侧旧实现删净（tsc 证明无残留引用） | 全局 | 0.5 天 |
| R5 | 测试迁移：两侧现有测试套件（classic 21 项 + SaaS 全部刷新测试）不降级；core 新增参数化套件（同一用例矩阵跑两种 store 适配器） | tests/ | 1 天 |

**验收**：①两侧所有既有测试零改动通过（语义不变证明）；②注入同一 mock fetch，两种 store 的引擎产生逐字节一致的 writeback 序列（等价证明）；③grep 全库 `app_EMoamEEZ` 只剩注册表一处；④CS5 演练——注册表加一家 mock adapter，classic+SaaS 测试同时获得刷新能力，各仅需装配侧 3 行。

**风险与回滚**：纯内部重构，两个外壳的公开签名是回滚边界——任何调用方破坏即停止。R2/R3 各自独立可合入。
