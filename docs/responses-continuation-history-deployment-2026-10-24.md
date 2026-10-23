# Responses 持久 continuation 的标准运行时配置

日期：2026-10-24。实现路径是 PostgreSQL migration 141 + `loadResponsesContinuationDeployment` + HTTP/WS 共用的 `PersistentResponsesContinuationResolver`。默认关闭；本文件描述代码/部署合同，不声称已取得真实 AWS KMS、跨实例 HTTP/WS 或恢复验收结果。

## 运行时合同

`loadResponsesContinuationDeployment({ database, env?, importer?, cwd? })` 返回 `undefined`（关闭）或 `{ resolver, readiness, checkReady, purgeExpired, close }`。标准 managed runtime 持有这个对象并把同一个 `resolver` 交给 gateway 的 `continuationHistoryResolver`；HTTP 和 WS 使用相同数据库和加密域，不能用 connection Map 代替持久存储。startup/readiness 调用 `checkReady()`，shutdown 调用幂等的 `close()`。`purgeExpired(limit=100)` 为维护入口，范围 1–1000；应由已有周期维护装配调用，不能在请求失败后重发上游。

`diagnostics()` 只返回 purpose、current/retained key ARN、已读取短期凭据 expiration 和本进程 roundtrip 验证时间，不返回凭据或签名；`productionEvidence` 始终为 `external_evidence_required`。尚未成功 roundtrip 时 `verification=not_verified`，pilot 永远 `pilot_only`。这些 runtime 诊断不能替代部署外部证据。

`readiness` 是安全边界标签：`production-kms` 或 `pilot-file-keyring`，不是生产上线验收凭据。生产模式启动验证精确 schema、SELECT/INSERT/DELETE 三项数据库权限和真实 GenerateDataKey→本地 AEAD→Decrypt roundtrip；失败关闭适配器并拒绝启用。没有加载云配置时不会执行云调用。

reference 必须由认证后的 tenant/project/proxy key、服务端归一化 conversation ID 和 response ID 构成。`resolve(reference, delta)` 返回的 `body` 带服务端 WeakSet provenance，必须把该原对象直接交给 prepare；不能 spread/JSON clone。prepare 后对完整 tenant/project/proxy key/conversation/provider/product/account/credential/version/authz version/public model/resolved model 执行 `assertPreparedIdentity`。不符时先补偿该次准备的 hold，再返回 409 `full_context_required`。

只有 durable dispatch/settlement 后才可调用 `remember({identity,responseId,request,output,operation})`。普通 response 保存完整 canonical input 和完整 output；compact 以完整 returned output 替换旧 input。返回 false 表示本次 continuation 未持久成功，不能因此自动退款、重发推理或宣称该 response 可续接。客户端应保留 full context；数据库/KMS/expiry/identity 不匹配统一要求重新发送 full context。

## 环境配置

| 变量 | 值及约束 |
|---|---|
| `MODEL_ROUTER_SAAS_RESPONSES_HISTORY_MODE` | `disabled`（默认）、`production-kms`、`pilot-file-keyring` |
| `SAAS_RESPONSES_HISTORY_KMS_MODULE` | production 专用可信部署模块，必须导出 `createResponsesHistoryKms`；不可由公共 HTTP/租户配置控制 |
| `MODEL_ROUTER_SAAS_RESPONSES_HISTORY_KMS_KEY_ID` | 当前 history 专用完整 KMS key ARN |
| `MODEL_ROUTER_SAAS_RESPONSES_HISTORY_KMS_PREVIOUS_KEY_IDS` | 内置 AWS adapter 可选 JSON ARN 数组，最多 16 个；相同 region/account，保留旧历史 decrypt 权限；仅当前 key 可生成 DEK |
| `MODEL_ROUTER_SAAS_RESPONSES_HISTORY_TTL_MS` | 默认 3600000，整数 1–86400000 |
| `MODEL_ROUTER_SAAS_RESPONSES_HISTORY_MAX_BYTES` | 默认 4194304，整数 1–16777216 |
| `MODEL_ROUTER_SAAS_RESPONSES_HISTORY_KEYRING_FILE` | 仅 pilot：绝对路径，普通文件，属运行 uid，0600 或更严格，禁 symlink |
| `MODEL_ROUTER_SAAS_RESPONSES_HISTORY_AWS_REGION` | 内置 AWS adapter 支持下列显式 region |
| `MODEL_ROUTER_SAAS_RESPONSES_HISTORY_AWS_CREDENTIALS_FILE` | 内置 AWS adapter 的短期凭据文件，绝对路径，属运行 uid，0600 或更严格，禁 symlink |

生产模式禁止同时配置 pilot keyring；pilot 模式禁止同时配置 KMS module/key ID。模块仅收到 `MODEL_ROUTER_SAAS_RESPONSES_HISTORY_*` 和自身 module 环境变量的冻结快照，未收到 provider credential KMS/master key 或通用 AWS 凭据。

## 内置真实 AWS KMS 路径

编译后的内置模块为 `/opt/model-router/dist/saas/runtime/aws-responses-history-kms.js`（按实际安装根替换）。示例非秘密配置：

```dotenv
MODEL_ROUTER_SAAS_RESPONSES_HISTORY_MODE=production-kms
SAAS_RESPONSES_HISTORY_KMS_MODULE=/opt/model-router/dist/saas/runtime/aws-responses-history-kms.js
MODEL_ROUTER_SAAS_RESPONSES_HISTORY_KMS_KEY_ID=arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012
MODEL_ROUTER_SAAS_RESPONSES_HISTORY_AWS_REGION=us-east-1
MODEL_ROUTER_SAAS_RESPONSES_HISTORY_AWS_CREDENTIALS_FILE=/run/credentials/model-router/history-aws.json
```

内置 adapter 仅访问固定 `https://kms.<region>.amazonaws.com/`，使用 Node 内建 HTTPS fetch 和 SigV4（service `kms`）。显式支持 `us-east-1`、`us-west-2`、`ap-southeast-1`、`ap-northeast-1`、`eu-west-1`、`eu-central-1`。不支持自定义 endpoint、FIPS、VPCE、其他 partition 或 region；没有 disable TLS/redirect 开关。需要其他目标时应增加经过审核的独立可信模块。

凭据文件格式为 `{ "accessKeyId": "...", "secretAccessKey": "...", "sessionToken": "...", "expiration": "2026-10-24T01:00:00Z" }`。示例占位符不是可用凭据。session token 必须存在；每次 KMS 请求重新读取一次文件，形成单次不可变 snapshot，剩余有效期不足 60 秒即拒绝。外部 workload credential agent 必须在过期前通过原子 replace 写入完整文件并保持权限/owner；adapter 不调用 STS，也不自行刷新身份。不要通过 CLI 参数、普通日志或公共配置传递凭据。

完整 key ARN 的 region 必须与配置一致。GenerateDataKey 返回的 KeyId 必须等于请求 ARN，DEK 必须严格 32 bytes；Decrypt 带相同 key ARN/EncryptionContext 并严格验证返回 KeyId。返回/请求的云错误体、签名、headers、上下文原文和 DEK 均不记录，错误仅稳定安全 code。进程关闭会 abort 正在进行的 KMS HTTP 请求。

## 专用 IAM / key policy

history gateway 工作负载需要在**独立 history key ARN**上的 `kms:GenerateDataKey` 和 `kms:Decrypt`。这不会扩大 provider credential seal/decrypt 权限，也不需要 `CreateGrant`、`ReEncrypt` 或通配 key 权限。IAM policy 和 key policy 均应限定专用工作负载 role。最小策略片段（按实际 ARN/role 配置）：

```json
{
  "Effect": "Allow",
  "Action": ["kms:GenerateDataKey", "kms:Decrypt"],
  "Resource": "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012",
  "Condition": {
    "StringEquals": { "kms:EncryptionContext:purpose": "responses-canonical-history/v1", "kms:EncryptionContext:version": "2" },
    "ForAllValues:StringEquals": { "kms:EncryptionContextKeys": ["purpose", "version", "keyId", "aadSha256"] }
  }
}
```

EncryptionContext 在 CloudTrail 可见，因此只包含固定 purpose/version、非秘密 key ARN 和完整 local AAD 的 SHA256，不包含用户原文、credential secret 或原始业务身份。AES-256-GCM local AAD 完整绑定 purpose/version/key ID、tenant/project/proxy key/conversation/response/provider/product/account/credential及版本、models、canonical digest、created/expiry。每条记录使用新 DEK；数据库只保存 versioned ciphertext envelope、wrapped DEK 和认证的元数据，明文 DEK 在本地 AEAD 操作后清零。

轮换时先给所有实例部署新 current ARN + previous ARN 白名单，保留旧 key 的 decrypt 权限直到所有旧记录 TTL/删除完成，再移除旧 ARN。KMS 自动轮换同一 ARN 无需改应用 key ID。跨 ARN 恢复需保留原 ARN、region/account 和 key material；不得用同名 alias 假定兼容。

## Pilot 独立文件 keyring

仅开发/受控 pilot 可用：`{ "version": 1, "currentKeyId": "history-pilot-v1", "keys": { "history-pilot-v1": "<64 hex chars>" } }`。最多 32 把 32-byte AES keys；禁止复用 upstream credential key。文件权限/owner/symlink 检查在加载前完成；复制到 cipher 后临时 key buffer 清零，close 清零常驻 key。此模式始终返回 `pilot-file-keyring`，不能当作生产 KMS ready 或生产上线 GO。

## 验收证据边界

本地 deterministic fixtures 可证明加密/AAD、加载边界、错误脱敏、签名请求结构与生命周期；不能证明云 IAM、真实服务连通性、跨实例 replay、部署恢复或计费安全。生产验收还需要带版本的真实 history 专用 KMS canary、实例 A 写入/实例 B HTTP 与 WS 续接、跨 tenant/project/key 拒绝、过期/旧 key 恢复、compact 全窗口回放、持久失败不重发/不退款，以及终态账务快照。

AWS primary references：[GenerateDataKey](https://docs.aws.amazon.com/kms/latest/APIReference/API_GenerateDataKey.html)、[Decrypt](https://docs.aws.amazon.com/kms/latest/APIReference/API_Decrypt.html)、[SigV4](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html)、[EncryptionContext](https://docs.aws.amazon.com/kms/latest/developerguide/encrypt_context.html)、[KMS endpoints](https://docs.aws.amazon.com/general/latest/gr/kms.html)。
