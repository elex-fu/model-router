# 支付部署与运营配置合同（2026-10-24）

本文对齐当前标准 managed-saas CLI/组合根。配置与离线检查通过，不代表真实支付宝收款、到账或退款验收通过。

## 1. 角色与文件

仅 `control-plane` 或 `combined` 可配置 `MODEL_ROUTER_SAAS_PAYMENTS_CONFIG_FILE`。gateway、credential-validation-worker、plugin-host 不得挂载 PSP 凭据或声明支付配置。生产分角色部署时只向 CP 提供支付文件和密钥。

```dotenv
MODEL_ROUTER_SAAS_PAYMENTS_CONFIG_FILE=/etc/model-router/payments.json
MODEL_ROUTER_SAAS_PAYMENTS_CREDENTIALS_DIRECTORY=/run/secrets/model-router-payments
```

凭据目录必须是绝对路径。未指定专用目录时读取 systemd 的 `CREDENTIALS_DIRECTORY`，文件名仍由下述 descriptor 引用。systemd 使用 CP 专用 `LoadCredential`；容器使用只读 secret mount。建议私钥文件 `0400`、密钥目录仅运行身份可访问，descriptor 由部署管理员持有且运行身份只读。禁止将 PEM、session cookie、CSRF token 写入环境示例、Git、日志或工单。

这些权限和只读挂载是部署要求：当前 reader 检查 basename、普通文件、尺寸和 `O_NOFOLLOW`，不证明挂载只读，也不校验文件 owner/mode。应在部署层校验访问权限。凭据不得使用 symlink；绝对路径、子目录、`..` 均不能作为引用。

## 2. Descriptor schema v1

以下数字身份仅为格式示例，必须替换为已核验的商户身份；没有任何真实密钥内容。

```json
{
  "schemaVersion": 1,
  "bindings": [
    {
      "id": "alipay-merchant-v1",
      "provider": "alipay",
      "appId": "2026000000000001",
      "sellerId": "2088000000000001",
      "currency": "CNY",
      "createMethod": "precreate",
      "merchantPrivateKeyCredential": "alipay-private-v1",
      "alipayPublicKeyCredential": "alipay-public-v1",
      "environment": "production"
    }
  ],
  "walletTopUp": {
    "currency": "CNY",
    "minimumMinorUnits": "100",
    "maximumMinorUnits": "100000"
  }
}
```

- 文件最大 128 KiB，bindings 为 1–64 项，ID 唯一；未知字段拒绝。
- `id` 为 1–128 字符，首字符为 ASCII 字母或数字，后续只允许字母、数字、`_`、`.`、`-`。
- `appId` 为 10–20 位数字；`sellerId` 为 1–32 位数字。
- provider 只允许 `alipay`，币种只允许 `CNY`，创建方式只允许 `precreate`。首发 QR 文本由支付宝 precreate 返回。
- `environment` 可省略，默认 `production`；另一合法值为 `sandbox`。工厂固定映射支付宝端点，不接受任意 URL、JS importer、fetch 或 clock 配置。
- 两个 credential 引用均为 1–128 字符 basename，允许字符同 ID，额外禁止包含 `..`。每个凭据为 1–65536 字节普通文件。凭据分别提供 RSA 商户私钥 PEM 和支付宝公钥 PEM，实际密码学校验由 Alipay provider 完成。
- 充值上下限为分单位的正整数字符串，1–18 位，无前导零，minimum ≤ maximum。

公开 descriptor digest 包括 binding ID、商户身份、币种、创建方式、环境及两个凭据版本引用名，不包括秘密值。不得原地复用 binding ID 改身份或引用。改商户、环境或凭据引用版本时部署新 binding，保留旧 binding 和旧版本凭据，直至历史义务结束。不要在相同引用名下静默替换秘密值。

文件不能提供 `mode`、`activeBindingId`、`active` 或 revision。加载器只创建只读 resolver，不写 PG、不激活、不启动 worker。标准组合根随后执行 insert-only binding 注册、PG control/历史引用 readiness 检查，再创建按 binding 路由的单支付队列 worker及单退款 worker；显式坏配置不会回退为 disabled。

回调地址由 customer origin 派生：`/payments/webhooks/alipay/{bindingId}`；return URL 为 `/wallet`。必须将公开 customer origin 正确代理至 CP，并在 PSP/网络层保持回调可达。

## 3. PG 控制与商户切换

`saas_payment_control` 的 `mode`、`active_binding_id`、`revision` 是新单 admission 的唯一权威。状态为 `disabled`、`draining`、`enabled`；只有 enabled 接受新单。文件部署和进程重启不自动激活。

历史订单、inbox、套餐订单和退款绑定原 binding。draining/disabled 不会把历史单改为新商户；保留旧 descriptor、凭据和回调可达性，继续处理历史查询、回调、履约和退款。

运营顺序：

1. 以新 ID、凭据版本引用创建新 binding；在每个 CP 副本部署同时包含新旧 bindings 的文件与只读凭据。
2. 确认每个副本成功启动，其 binding 注册和历史引用检查通过；逐副本执行 doctor 检查本地文件和凭据，再检查正式 HTTP 可达性。
3. 在正式平台会话下 GET control 获取当前 revision。GET 只返回权威 control 快照，**没有单独的全副本 binding readiness GET API，也不证明其它副本已部署**。必须先完成逐副本部署确认。
4. 用读到的 revision 执行 PATCH CAS enable 新 binding。409 时重新 GET，检查他人变更后再决定操作，禁止盲目覆盖。
5. 需要排空时 PATCH `draining`，保留历史绑定及凭据。旧单依照原 binding 处理。副本不能解析 PG 当前或历史 binding 时拒绝相应操作/启动检查，不使用另一个商户替代。

无 binding 归属的 legacy 金融事实在启用时显式阻塞。必须依据原 PSP/商户/订单证据人工核对和受审计归属，歧义保持对账状态；不得按“当前配置只有一个商户”猜测或批量回填。当前 HTTP control API 不提供 legacy 归属入口。

## 4. 正式管理 API

`GET /admin/api/v1/payments/control`、`PATCH /admin/api/v1/payments/control`，位于 platform origin。需要有效平台管理员会话及 operations/superadmin 权限；PATCH 事务内再次核验有效 TOTP 会话、用户状态、角色及 revision，并追加审计。

Host 必须匹配配置的 platform origin。显式 Origin 必须精确匹配；GET 缺 Origin 时只允许 `Sec-Fetch-Site: same-origin`，或无该 header 且 Referer 为同 origin。PATCH 必须提供正确 Origin、`Content-Type: application/json`、平台 session/CSRF cookies，以及与 CSRF cookie 相同并通过会话校验的 `x-csrf-token`。cookies 名为 `mr_platform_admin_session`、`mr_platform_admin_csrf`；禁止把 cookie 值写入命令历史或证据。

PATCH body 恰好包含三项：

```json
{
  "expectedRevision": "1",
  "mode": "enabled",
  "activeBindingId": "alipay-merchant-v1"
}
```

revision 为字符串；以 GET 实际值替换示例。enabled 的 activeBindingId 不能为 null；draining/disabled 仍应保留可追踪的绑定。请求不接受 actor/session/roles，由服务端会话派生。

## 5. Doctor 的证据范围

`saas:doctor` 的 `payments-readiness` 执行只读 descriptor/凭据加载和 provider 配置校验，不创建 PSP 单，不发真实 PSP 请求，不写 binding 或 control，也不执行 legacy 归属。

其通过仅证明该进程可读取合法本地声明与凭据；不能证明全副本部署完成、PG active CAS 已执行、回调公网可达、真实扫码到账、重复回调仅一次入账或原路退款成功。标准启动时的 PG 注册/历史检查与这些真实金融验收须分别保留证据。

## 6. 独立商业 attestation trust 与 CP pool

P01 平台推理访问开通使用独立公有配置：

```dotenv
MODEL_ROUTER_SAAS_COMMERCIAL_ATTESTATION_TRUST_FILE=/etc/model-router/commercial-attestation-trust.json
MODEL_ROUTER_SAAS_DB_POOL_MAX=16
```

```json
{
  "version": 1,
  "keys": [
    {
      "keyId": "commercial-verifier-v1",
      "publicKeyPem": "<REPLACE_WITH_ED25519_SPKI_PUBLIC_KEY_PEM>"
    }
  ],
  "testVectorDigests": [
    {
      "suiteVersion": "commercial-suite-v1",
      "sha256": "<REPLACE_WITH_REVIEWED_64_LOWERCASE_HEX_DIGEST>"
    }
  ]
}
```

占位符不能直接运行。文件上限 64 KiB，只接受精确字段；keys 1–64 项、testVectorDigests 1–256 项，重复 keyId/suiteVersion 拒绝。公钥必须为 Ed25519 SPKI `PUBLIC KEY` PEM，禁止私钥；SHA-256 必须为 64 位小写 hex。keyId/suiteVersion 为 1–128 字符，首字符字母/数字，后续允许字母、数字、`_`、`.`、`:`、`-`。

这套公钥用于商业合同 attestation 验签，suite digest 用于核对测试向量。它独立于 PSP RSA 密钥、gateway prepared evidence、Responses history KMS 和 Codex 上界证据；不得交叉复用信任用途。配置文件只向 CP/combined 提供，缺配置时 P01 unavailable，显式坏配置使启动失败。

开通 operation guard 占用一个 CP 连接，内部阶段还需连接；标准组合根与 doctor 使用解析后的 pool max，至少为 2。`1`、`01`、` 1 ` 均解析为 1 并阻止 P01 服务接线。

商业 trust 检查通过不证明 Codex 可开通。标准 P01 使用 server-owned admission readiness，在创建前及激活前按真实 product/model、Responses HTTP/full scope 检查 reviewed trusted bound profile；缺精确证据返回 `TRUSTED_USAGE_BOUNDS_UNAVAILABLE`。当前 profile 数展示不能替代逐 operation 检查，也不能通过 operator JSON 自证计费上界。

## 源码入口

- `src/saas/runtime/payment-deployment.ts`、`payment-credentials.ts`
- `src/saas/payments/merchant-binding.ts`
- `src/saas/platform/payments-control-http.ts`
- `src/saas/runtime/commercial-attestation-trust.ts`
- `src/saas/supply/platform-inference-access-admission-readiness.ts`
- `src/server/managed-saas.ts`、`src/cli/saas-doctor.ts`
