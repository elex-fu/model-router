# 个人 Token 售卖部署配置（M0 开放注册）

日期：2026-11-03。配套方案：`personal-token-resale-technical-plan-2026-11-01.md` §6.1 / §10.2 M0（"注册 open 模式"部署项）。

本文只记录个人售卖形态上线所需的**部署侧配置通道**；能力本身全部已存在，零新代码。

## 1. 开放注册

注册准入双通道：平台 settings store 优先，store 为空回落 env（`src/saas/identity/registration-settings.ts`）。

| 配置 | settings key（store） | env 回落 | 个人售卖建议值 |
|---|---|---|---|
| 注册模式 | `saas.identity.registration.mode` | `MODEL_ROUTER_SAAS_REGISTRATION_MODE` | `open` |
| 邮箱验证 | `saas.identity.registration.email_verification_required` | `MODEL_ROUTER_SAAS_REGISTRATION_EMAIL_VERIFICATION` | `true` |
| Turnstile | `saas.identity.registration.turnstile.enabled` (+ site_key) | `MODEL_ROUTER_SAAS_REGISTRATION_TURNSTILE_ENABLED` 等 | 公网部署建议开启 |
| SMTP | `saas.identity.registration.smtp.*` | `MODEL_ROUTER_SAAS_REGISTRATION_SMTP_*` | 按邮箱验证需要配置 |
| 域名允许/拒绝清单 | `saas.identity.registration.email_domain_{allow,deny}list` | 同名 env | 视运营策略 |

要点：

- 默认 fail-closed：不配置即为 `closed`。上线个人售卖必须显式 `open`。
- Turnstile 关闭时直通（不验证）；SMTP 密码只走 env / KMS sealed envelope，store 不收明文（F1 纪律）。
- 注册成功后默认引导（tenant + 默认项目 + 默认平台供给 entitlement）由服务端注册事务自动完成（M1-E2，`register-service.ts`），部署无需额外配置。
- 注册奖励金额（`reward.*` keys）默认全零；个人售卖不使用邀请返佣，保持默认即可。

## 2. 客户端接入地址

个人首屏/教程页展示的客户端配置 base URL 来自品牌设置：

- settings key：`saas.brand.api_base_url`（`src/saas/platform/brand/snapshot.ts`，经 `GET /settings/public` 公开只读）。
- 填网关公网入口，如 `https://api.example.com`。未配置时页面提示"平台尚未配置可用的公网接入地址"，不生成配置。

## 3. 周边部署项（既有文档，不重复）

| 项 | 文档 |
|---|---|
| PSP 商户与收款部署（四家任选其一） | `docs/payments-deployment-2026-10-24.md` |
| managed-saas systemd 单元 | `deploy/systemd/managed-saas/` |
| 备份与恢复 runbook | `deploy/managed-saas-backup-runbook.md` |
| 角色与权限 SQL | `deploy/managed-saas-postgres-roles.sql` |

## 4. 上线前验收对应

- 注册 open 模式 E2E：见 `tests/e2e/`（M1 收费闭环 E2E 内含注册段；邀请流见 `customer-registration.spec.ts`）。
- 四家真实 OAuth smoke、100 账号导入验收：需真实凭证，运营方执行（方案 §10.1）。
