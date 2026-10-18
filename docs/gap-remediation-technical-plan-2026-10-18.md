# 核心差距补充技术方案 — 参考代码详细对比版

> 基线：model-router main `5df3191`（T00/T03/T04/T05 已合入，迁移链至 131）。
> 本文档是 `core-capability-alignment-technical-plan-2026-10-18.md` 的**补充方案**，针对 2026-10-18 差距分析确认的 A/B/C 级缺口，逐项给出：model-router 现状锚点 → 三个参考项目的实现对比 → 落地设计 → 验收标准 → 任务归属。
> 参考仓库均为本地克隆且与主方案 §16 钉住的 commit 一致：
> - **sub2api** `a3eb7ef3`（/Users/lex/play/sub2api）
> - **new-api** `6549a17e`（/Users/lex/play/new-api）
> - **CLIProxyAPI** `911f49c`（/Users/lex/play/CLIProxyAPI）

## 0. 差距总表与本文结构

| 编号 | 差距 | 参考主源 | 优先级 | 任务归属 |
|---|---|---|---|---|
| G-A1 | 媒体任务恢复循环（无人轮询结算/死亡接管） | new-api task_polling、sub2api batch worker | P0 | T08 |
| G-A2 | 新 main 性能基线（R9 重跑） | 三项目无对应（自建） | P0 | T06 |
| G-A3 | legacy-112 真库升级证据 | 三项目无对应（自建） | P0 | T00 尾项 |
| G-B1 | 窗口三态预留带 + 多实例状态共享 | sub2api gateway_scheduling | P1 | T05 尾段 |
| G-B2 | multipart 受控上传 | new-api common/gin | P1 | T07 |
| G-B3 | rerank + audio/speech 别名 | new-api relay-router | P1 | T03 续 |
| G-B4 | Responses WebSocket | new-api responses_websocket、CLIProxyAPI | P1 | T09 |
| G-B5 | Realtime WebSocket 音频计量 | 无完整参考（CLIProxyAPI 明确缺计量） | P2 | T09 |
| G-B6 | 4×4 协议矩阵闭合 + thinking 三段式 | new-api relayconvert、CLIProxyAPI thinking | P1 | T03 续 |
| G-C1 | capability readiness 投影 + 探针分离 | CLIProxyAPI model_updater（清单面） | P1 | T10/T11 |
| G-C2 | 控制台新能力闭环 + 巨型文件拆分 | — | P1/P2 | T10 |

不改变主方案 §15 的里程碑划分；本文细化 G 项的工程方案与参考边界。

---

## 1. G-A1：媒体任务恢复循环（B07，P0）

### 1.1 model-router 现状

- **视频**：结算状态机已完备——`src/saas/gateway/videos/video-billing-state-machine.ts` 实现 sub2api 式 pending→claim→settle→release 幂等链（原子 `UPDATE ... WHERE billing_state='pending'`，`video-task-store.ts:201`），fail-closed skip（快照丢失绝不默认价计费）、结算失败释放 claim 等待重试。**唯一驱动源是客户 poll**（`videos-query-port.ts` 经 `video-settlement-port.ts:206 reconcile`）；无客户 poll 时任务与 hold 悬空。
- **图片**：异步任务是 `http-handler.ts:2096` 的后台 promise——进程死亡即任务丢失（`image-task-store.ts` 有 TTL/ownership，但无恢复者）。
- 迁移 123/124（image/video tasks）已有任务表；无租约字段（owner/epoch/next_poll_at）。

### 1.2 参考实现对比

**new-api `service/task_polling.go`（核心参考，完整状态机）**：

- **驱动**：system-task 框架 15s 间隔（`system_task_handlers.go:145`），`RunTaskPollingOnce`（:134）每轮执行；多 master 用 **DB lease + 心跳续约**（`system_task.go:308`，TTL/3 续约，丢租约 cancel ctx）——天然多实例安全。
- **CAS 三件套**：推进前 `task.Snapshot()`（Status/Progress/ResultURL/Data/PollFailures 等），终态且状态变化才 `UpdateWithStatus(fromStatus)`（`UPDATE ... WHERE status=?`，RowsAffected>0 为赢家）；**只有 CAS 赢家调结算**（:633-639）。注释记录两个坑：GORM `Save()` 在 WHERE 0 行时退化为 INSERT ON CONFLICT 绕过 CAS；MySQL 返回 changed 而非 matched rows。
- **失败分类**（`classifyPollHTTP` :720）：`ok`→推进；`not_found`(404/410)→**立即终态**；`auth`(401/403)→等管理员修复不终态；`transient`(429/5xx)→重试；`other_client`(4xx)→仅解析出终态才接受；`unrecognized`→WARN（512 字节脱敏 body）计失败。`PollFailures` 持久化，成功轮询清零，累计 ≥20 放弃→终态+退款；24h sweep 兜底。
- **退款幂等**：`RefundTaskQuota` 先退资金→退 token→回减用量→记账→**最后清 `task.Quota=0` 作已退款持久标记**；清零回写失败显式 ERROR 防二次退款。
- **缺陷**：固定 15s 无退避；sweep 的 legacy 判定按 SubmitTime 硬编码；`TaskBulkUpdateByID`（无 CAS）与 CAS 路径并存易误用。

**sub2api `batch_image_worker.go`（心跳/恢复上界参考）**：

- Redis 队列（ready/delayed/active zset + job lock TTL 5min），处理期间**心跳刷 active 时间戳并续锁**（:204）；`RunStaleActiveRecovery` 每 5min 把 active 超 10min（心跳断绝=实例死亡）的 job 重入队（:263）；`RunDelayedMover` 挪到期 delayed；`BatchImageBillingRecoveryService.ReleaseStaleUnsubmittedOnce` 释放卡在"未提交计费"超 10min 的冻结额度。Job 状态机在 PG（CAS 式迁移），队列只承载调度。

### 1.3 落地设计

> **实施记录（2026-10-18，已交付）**：迁移 132 只为 `saas_video_tasks` 增列——图片任务**不加列**（偏离下方第 1 点的初稿）：图片生成是单次同步上游 HTTP 派发，无上游任务 ID 可回查，进程死亡即交付物不可恢复，恢复动作只能是"卡死行终结"（`created_at` 超过执行时限 → failed，status 守卫即 CAS），无需租约/游标列；计费侧由现有 unknown-outcome worker 持有。图片终结清扫为 `ImageTaskService.sweepStuckTasks()` + 默认开启的 unref 定时器。视频侧完整实现：`claimRecoveryBatch`（`FOR UPDATE SKIP LOCKED` 批量认领 + epoch 围栏）、`renewRecoveryLease`、`recordRecoveryOutcome`、`VideoTaskRecoveryWorker`（六类失败分类、指数退避 15s→15min、cap 20 → fail-closed skip、404/410 立即 skip、复用 `billing.observe` 一次性幂等结算、绑定账号精确重拨）。生产装配默认随 videoMedia/imageMedia 接线开启（`recovery.disabled`/`stuckSweep.disabled` 可退避），stop 句柄挂 `lifecycle.close`。权限走 privileges-manifest 生成（G-A1 五列 UPDATE 授权，镜像再生成）。

以 model-router **现有 PG 任务表 + 现有结算通道**为基础，新增受租约保护的后台恢复循环，不引入 Redis 队列（方案 §11.3 已定调"复用现有任务机器，补租约、恢复"）：

1. **迁移 132 `media_task_recovery`**：image/video 任务表增加 `lease_owner text`、`lease_epoch bigint`、`lease_until timestamptz`、`next_poll_at timestamptz`、`poll_failures int`、`recovered_at timestamptz`。默认 `next_poll_at = now()` 使存量任务立即可被恢复循环认领。
2. **恢复 worker**（gateway workload 内，与 refresh worker 同模式）：
   - 循环间隔 15s（沿用 new-api）；claim 用 `UPDATE ... SET lease_owner=$me, lease_epoch=epoch+1, lease_until=now()+interval '90s' WHERE task_id IN (待恢复集) AND (lease_until < now() OR lease_owner = $me) RETURNING *`——等价 SKIP LOCKED 语义，租约 90s / 心跳 30s（TTL/3）续约，对齐 sub2api 心跳与 new-api lease 双模式。
   - 待恢复集 = `终态未结算 OR (非终态 AND next_poll_at <= now())`；按 provider account 分组串行、组间并发（new-api channel 分组模式），组内每任务间 sleep 1s 可配置关闭。
   - **失败分类照搬 new-api 六类**；`poll_failures` 持久化累计，上限默认 20，超限走终态失败 + 现有 compensation/unknown-outcome 通道（model-router 已有比 new-api 更完备的 unknown 流程，这是优势项）。
3. **结算复用**：视频走现有 `video-billing-state-machine`（已幂等）；图片补一个同构的 image billing 收尾（复用 `image-result-offloader` + `dispatch-usage-settlement`）。**CAS 赢家才结算**的不变式写进 worker 断言。
4. **图片后台 promise 迁移**：`http-handler.ts` 的 in-process promise 保留为 fast path（活着就它跑），但任务行在 admit 时即落库 `next_poll_at=now()+30s`；worker 只认领 `next_poll_at` 已到且仍非终态的行——进程死亡后 30s 内由其他实例接管。已发送任务只回查不重 POST（现有 reconciliation 身份保证）。
5. **图片对象存储失败**：只重试已取得结果的持久化，不重新生成（方案 §11.3 红线，与 sub2api `isBatchImageSettlementRetryExhausted` 同界）。

### 1.4 验收

kill 注入矩阵（发送前/发送后/上游成功后/落盘后/结算后）各一实例：另一实例 ≤95s 接管，无重复生成、无重复扣费（结算幂等键断言）；无人轮询的已接受视频在终态后 15s 内完成结算；`poll_failures` 耗尽路径走 compensation 且账务可解释；三实例同跑租约不超发（SQL 断言同一时刻一 task 只有一活跃 lease）。

---

## 2. G-B1：窗口三态预留带 + 多实例状态共享（9.2 前半 + 9.1 尾段）

### 2.1 model-router 现状

- 聚合管线就绪：`postgres-provider-account-window-stats.ts:50 getAccountWindowStatsBatch` / `:81 groupAccountIdsByWindowStart`（按窗口起点分组、每窗口一次批量查询——与 sub2api `withWindowCostPrefetch` 同构）。
- 迁移 130 `provider_account_window_cost_policy` 已建（费用上限 schema）；调度器已有 sticky wait（T05）与阈值平台族（7 平台）。
- 缺口：三态判定未接（migration 130 只有 schema 无消费）；模型冷却 `ProviderAccountModelRateLimit` 仍进程-local。

### 2.2 参考实现对比

**sub2api 三态判定（照搬级参考）**——`account.go:3173 CheckWindowCostSchedulability(currentWindowCost) WindowCostSchedulability`：

```text
cost < limit                      → Schedulable
limit ≤ cost < limit + reserve    → StickyOnly（仅粘性会话）
cost ≥ limit + reserve            → NotSchedulable（停调）
```

**纯函数、无 IO、无锁**——判定与数据获取（ctx 预取 map → Redis → DB，三级降级、DB 失败**放行**）在调用方分离。RPM 同构复用同一枚举。粘性路径与普通路径分别传 `isSticky` 进 gate。窗口费用仅对 OAuth 类账号生效（`IsAnthropicOAuthOrSetupToken`）。

**wait plan 完整形态**（`gateway_scheduling.go`）：粘性等待 45s/队列 3 vs 兜底等待 30s/队列 100 双参数；等待前先查等待队列计数，满则降级 Layer 2；**wait plan 也占 session 名额**；`ReleaseAccountSession`（:1497）转发失败立即归还槽位防卡满。model-router T05 已实现核心（busy 域扩展 + tick 重试 + 队列上限 + 429/Retry-After），差"失败归还 session 槽"与双参数。

**多实例一致性（outbox+版本化快照）**：账号/分组变更写 `scheduler_outbox`（PG，advisory lock 清理）→ 每实例 1s 轮询按 Redis watermark 消费 → 更新 Redis 版本化 snapshot bucket（Lua：epoch/active/retired、写令牌）+ 全量重建 worker 兜底 + outbox 滞后告警。**一致性策略是"选号循环内重查 + 抢槽后 DB 复检"双层检查**，而非强失效保证。EWMA 运行时健康是单进程内存（缺陷，multi-instance 不共享）。

**多窗口取最晚重置**（`account_scheduling_threshold_eval.go:396`）：超阈值候选中选重置时间**最晚**者停调——避免 5h 窗重置后又立即被 7d 窗打停抖动。model-router 阈值机制已有，缺此合并策略。

### 2.3 落地设计

1. **三态纯函数**：`src/saas/gateway/provider-account-window-policy.ts` 新增 `evaluateWindowCostSchedulability({usage, limit, reserve, isSticky})` → `'admit' | 'sticky_only' | 'paused'`。镜像 sub2api 签名（纯函数），限值/预留带来自 migration 130 冻结策略（`window_cost_limit`、`window_cost_sticky_reserve`，默认 reserve=$10 对齐 sub2api `GetWindowCostStickyReserve`）。
2. **调度器接线**：`provider-account-scheduler.ts` eligibility 阶段读 `getAccountWindowStatsBatch`（管线已就绪），非粘性候选遇 `sticky_only/paused` 跳过、粘性候选遇 `sticky_only` 放行；DB 查询失败放行（对齐 sub2api fail-open 与 P17 语义）。**窗口费用只对 OAuth/订阅类账号生效**（supplyMode 判定，PAYG 不套用）。
3. **wait 补丁**：`stickyWait` 增加 `fallbackWaitMs/fallbackMaxQueueLength`（默认 OFF 不变）；sticky binding 命中后转发失败时释放 session 名额（补 `ReleaseAccountSession` 等价物）。
4. **模型冷却持久化（迁移 133）**：表 `provider_account_model_cooldown(account_id, model, until, reason, updated_at)`，PK (account_id, model)。`ProviderAccountModelRateLimit` 改为 PG-backed + 进程内 30s 有界缓存（读路径）；写入走现有 dispatch 反馈事务。**不引入 Redis**（model-router 部署形态单 PG 权威，与 sub2api 的 Redis 前提不同；失效上界=缓存 TTL 30s，满足方案 9.1"明确失效上界"）。
5. **阈值多窗口合并**：`provider-account-scheduling-threshold.ts` 增加"超阈值候选取最晚重置"合并（5h+7d 并存平台），默认行为不变（单窗口平台无感）。

### 2.4 验收

黄色窗口（`limit ≤ usage < limit+reserve`）新会话被拒、既有粘性会话放行；红色窗口全拒且窗口滚动后恢复；模型冷却在三实例间 ≤35s 收敛（写→他实例读到）；冷却 rule 与 P17 联合清空时并集 fail-open；PAYG 账号不受窗口费用门影响；golden-fixture 零漂移（默认无 `window_cost_limit` 的账号路径不变）。

---

## 3. G-B2：multipart 受控上传（R6 §11.2）

### 3.1 model-router 现状与参考对比

现状：`http-handler.ts:86-106` multipart 明确拒绝（audio transcriptions/translations、xAI STT、images/edits 的标准形态全部 404+提示语）。

**new-api 实现**（核心参考）：

- 仅标准库 `mime/multipart`；`ParseMultipartFormReusable`（`common/gin.go:357`）：请求体先整体读入 **BodyStorage**（内存/磁盘双实现，超 `DiskCacheThresholdBytes` 落盘，reader 流式版失败不回退直接报错）→ `ReadForm(memoryLimit=32MB)`（文件部分自动落盘临时文件）→ `Seek(0)` 复位供重放；原始 Content-Type 存 context 防 boundary 失配。
- 限制链：`MAX_REQUEST_BODY_MB`(32MB) 经 `http.MaxBytesReader` 在**解压后**施加，超限 413。
- 音频计量：逐 file `GetAudioDuration` → `ceil(时长/60)*1000` token，**负时长钳 0**（防伪造元数据压低预扣）。
- 上游重编码：`bytes.Buffer+multipart.NewWriter` 重写 value 字段、**只取第一个 file**；pass-through 模式流转发但出站 JSON 重新解析 `n` 修正计费。
- 缺陷：音频只取第一个 file（多文件静默丢弃）；音频时长解析失败令整个请求失败而非降级。

sub2api 无独立 multipart 机制（音频按 body-size 启发式计费）；CLIProxyAPI 无音频转写。

### 3.2 落地设计（按方案 §11.2 既定 envelope 合同）

1. 依赖例外：`busboy@<锁定精确版本>`（方案 §4 已定调；不用 new-api 的全量缓冲 BodyStorage——model-router 验收门禁更严）。
2. **流式解析**：鉴权与轻量上传资源门在 body 读取前执行（方案红线）；busboy 增量计算每文件 SHA-256，落私有临时目录（`storage.dataDir/tmp-uploads/`，权限 0700）。界限：单文件 25MB、文件数 4、字段数 32、总字节 32MB、并发上传 per-key 4、临时磁盘总量 2GB、读入时长 60s。
3. `GatewayBodyEnvelope`（json | multipart{fields, files, manifestDigest}）按方案 §11.2 落地；manifest 摘要 = 规范化字段 + 重复字段顺序 + 文件摘要/大小 + operation 的 SHA-256，进入受签名派发证据。
4. 端点接线：`/v1/audio/transcriptions|translations`、`/v1/images/edits`（multipart 形态）、`/v1/audio/speech`（别名到现有 tts）。音频计量用 `GetAudioDuration` 等价物（ffprobe 可选依赖，缺失时按字节数降级估算并显式标记 estimate）；**多文件全部接受进 envelope，超过供给声明的文件数上限才 4xx**（修正 new-api 的静默丢弃）。
5. 清理：临时文件生命周期绑定任务/请求生命周期（异步任务转持久引用后清理），crash 残留由启动清扫（`tmp-uploads` 下 mtime > 24h 即删）。

### 3.3 验收

超限 413/422（区分单文件/总数/总字节）；伪造 MIME/时长钳 0；multipart 与 JSON 双形态同 operation 同计价（幂等域一致，不因路径双扣）；busboy 恶意 boundary/超长文件名 fuzz 无崩溃；临时目录清理断言。

---

## 4. G-B3：rerank + audio 别名（小收入面）

- **rerank**：参考 new-api `/v1/rerank`（`relay-router.go:143`，RelayFormatRerank → JSON 形状 + 专用 usage extractor：`usage.tokens` 或按 input 数量计）。落地：endpoint-registry 注册 `rerank.query`（第 6 条），operation=`rerank`，usage metric 复用 per_unit（documents 数）或 token；先接一个有真实 rerank 上游的供给（如智谱/Jina 形态），无供给前 registry 注册但 catalog 不声明可售（能力不可售原则）。
- **`/v1/audio/speech`**：新 route 指向现有 tts operation（同幂等域同计价，纯别名）。
- 验收：endpoint-registry 与 http-handler 零漂移（既有断言模式）；别名与原路径计费幂等。

---

## 5. G-B4：Responses WebSocket（R7 §12.1，双参考融合）

### 5.1 参考实现对比

| 维度 | new-api `relay/responses_websocket.go` | CLIProxyAPI `openai_responses_websocket.go` |
|---|---|---|
| 鉴权粒度 | **每事件重放完整中间件**（TokenAuth+ModelRequestRateLimit 在专用 gin 子引擎，:38-54）——事件级限流 | 连接级一次（upgrade 前 AuthMiddleware），每轮重走**凭据选择+usage 计量**但不重放 HTTP 中间件 |
| 并发模型 | 同连接串行：`tryReserveCurrent` 抢当前槽，并发 create 409 | 读循环唯一 + input chan(16) 写满阻塞（TCP 背压） |
| 固定路由 | 首个 create 锁定 Channel/Model/Group/Key(17 个上下文键)，后续同模型 `restoreConnectionContext` 复用上游连接但重验证 channel/key/baseURL/proxy/route 未变 | `pinnedAuthByProvider` 固化，每轮校验 pinned auth 仍可用/匹配模型 |
| 取消 | `response.cancel` 投递活跃请求 controls chan(buffered 1)，**取消不退款**——等上游 cancelled 终态按累计 usage 结算 | interrupt 绕过队列立即转发；无上游 WS 时本地合成 `response.incomplete{interrupted}` |
| 结算 | 终态事件或终态 error → `ConsumeResponsesQuota(accumulator.Finish())`；失败路径才退款 | 每轮 executor 层 usage 计量 |
| 错误语义 | `responsesWSErrorEndsRequest` 三级关联（event_id/response_id/stream_id）判断 error 是否终止请求；401/403 ClosePolicyViolation | 分类决定"通知 vs 沉默"：凭据/配额错静默关（隐式重连指令），413→1009，上游要 replay→1013 |
| 背压/慢写 | 空闲超时 300s；shutdown closeOnce 不持写锁 | 写侧 `writeMu+TryLock` 失败直接 `conn.Close()` 解救阻塞写者 |

### 5.2 落地设计（方案 §12.1 为主干，吸收双方）

1. **每轮独立准入/结算**（方案既定 + new-api 模式）：每个 `response.create` 进现有 prepare/admission/attempt/settlement 全链；连接建立只做 Key 鉴权 + Origin/消息上限/连接数校验。CLIProxyAPI 的"连接级一次鉴权"不采纳——model-router 的 Key 权限/配额是每请求语义。
2. **固定账号/模型**：首轮 `pinnedAuth` 等价物绑定 (tenant, key, provider, account, upstreamModel, upstreamSession)；后续轮次轮前校验（channel/key/路由未变，变了要求重连——new-api 重验证清单照搬）。改锁定身份必须重连。
3. **event_id 幂等**：同 event_id + 同指纹 → 同逻辑请求；同 ID 不同内容拒绝（new-api `lastResponseID` 守卫 + 方案 12.1 第 4 条融合）。
4. **取消**：控制事件投递活跃请求 controls chan（buffered 1，重复 pending 拒绝）；取消不触发退款，终态按累计 usage 结算（双方一致，采纳）。
5. **背压**：读循环唯一 + 有界队列（16）；写侧 TryLock-close 解救模式（CLIProxyAPI）；慢消费者达上限停上游不无限缓存。
6. **关闭码**：Key 撤销/账号禁用 → ClosePolicyViolation 等价（4403）；凭据/配额类错误静默关闭（CLIProxyAPI 语义，reason 截断 123 字节 UTF-8 安全）；reason 123 逐字照搬。
7. 依赖例外 `ws@<锁定版本>`，初期禁压缩；WS 帧/缓冲/连接数进指标（R8 §13.2）。

### 5.3 验收

方案 §12.1 清单全项 + 双方特有的：并发 create 409；迟到终态守卫（上一响应迟到 error 不误结当前）；controls chan 重复取消拒绝；慢写者解救（写阻塞时关闭不死锁）。

---

## 6. G-B5：Realtime WS（P2，独立能力门）

**参考现状警示**：CLIProxyAPI realtime（`internal/client/codex/live/`）**无 token 级计量**——relay 不解析 usage，资金控制仅靠凭据配额 + client secret 过期 + sideband 会话表归属；relay 无速率/字节预算。new-api `/v1/realtime` 走 Distribute+Relay，计量依赖上游事件 usage。

**结论**：三项目都没有"音频输入/输出维度增量计量 + 增量资金围栏"的完整实现。方案 §12.2 的判断成立——Realtime 必须自建（PriceMetric/UsageValues 扩展 + 单调序号 checkpoint + 高水位去重），且**在音频维度计量完整实现前不开放**。工程顺序：G-B4 完成并稳定 → 音频计量维度设计独立评审 → Realtime。本项本文不展开，维持主方案 §12.2 原文。

---

## 7. G-B6：4×4 协议矩阵闭合 + thinking 三段式（R2 收尾）

### 7.1 参考实现对比

**new-api `relaykit/relayconvert`（converter 质量合同，核心参考）**：

- **四阶段合同**：Request `Convert(ctx, meta, req)`；非流 Response `Convert(ctx, meta, resp) (any, *Usage, error)`；流式有状态 `NewStreamState(opts) → ConvertStreamChunk(..., state) → FinalizeStream(..., state)`——**流式转换有显式状态对象与收尾钩子**，模型与方案 §7.1"独立流状态、finalize 模型"一致。
- **注册期 fail-fast**：ID/From/To/Quality 必填、(from,to) 全局唯一、step 链逐级衔接且只能引用 direct converter——panic 级校验，杜绝"可被选中却只透传"的占位。
- **转换损失显式化**：`ConversionDiagnostic{Code,Path,Message,Severity}`——`tool_namespace_flattened`/`namespaced_tool_dropped`/`gemini_schema_keyword_dropped` 等诊断码每 chunk 前检查（`InspectStreamResponse`），ToolLossPolicy strict/safe/allow 三档可配。**这是 new-api 转换口碑的核心**：损失不静默。
- 不支持方向纯 error 无静默直通。
- 缺陷：request 侧无 stream/finalize 概念（天然单帧）；`param *any` 类型不安全。

**CLIProxyAPI**：

- **registry**（`sdk/translator/registry.go`）：requests/responses 双 map，静态注册全覆盖双向矩阵；规范化四步：源体提取 thinking 意图 → 原生转换 → 回填目标协议 summary 字段 → **plugin NormalizeRequest 最后执行拥有最终 payload**；无注册转换 fallback 仅改写 model 防前缀泄漏。
- **thinking 三段式**（`internal/thinking/apply.go:206`）：①意图提取（模型名后缀 `(8192)` 优先、Responses 源先 `extractCodexUsageConfig`）→ ②目标模型校验（`LookupModelInfo`；未知模型按 user-defined 直通；**模型不支持且请求带 thinking → 主动剥除**而非透传报错；codex/xai 不支持 configuration_update → 剥 update items）→ ③供应商参数转换（`ValidateConfig` clamp → `Apply` → 回填 summary 可见性防"禁用复活"；跨协议 `mapConfiguredHighIntent` xhigh→目标级别降级）。五家映射表：claude=`thinking.type+budget_tokens`（budget clamp 到 max_tokens）+ `output_config.effort`；openai chat=`reasoning_effort`；codex/xai=`reasoning.effort`；gemini=`thinkingLevel`(Gemini3)/`thinkingBudget`(2.5)；kimi=`thinking.effort`。

### 7.2 落地设计

1. **Endpoint/Bridge Registry 扩展**（T03 已建 5 条，继续注册）：为每个 (from,to) 方向声明四态 `passthrough | converted | limited | unsupported`（镜像 new-api Quality 三档 + 方案语义）；`limited` 必须携带损失诊断码清单。优先补：Responses→Messages、OpenAI↔Gemini、Responses↔Gemini、SaaS Gemini→Messages。
2. **流式状态合同**：现有 `src/protocol/sse.ts` 扩展 `StreamState + finalize()` 钩子（new-api 模式）；bridge 实现迁移按此重构，tool delta 交错、稳定 item ID 在 state 内保证。
3. **转换诊断**：新增 `ConversionDiagnostic` 等价物进 evidence（不进客户端响应，运营可见）；ToolLossPolicy 先固定 safe（诊断记录+不阻断），strict 模式后置。
4. **thinking 三段式**：`src/server/preprocess.ts` 现有 thinking 注入重构为三段：提取（含模型名后缀解析）→ 目标模型能力校验（catalog capability；不支持→剥除+诊断码）→ 供应商参数转换（clamp/降级映射表按 CLIProxyAPI 五家照搬，kimi/longcat 国产线已有基础）。
5. **三 CLI 验收**（方案 §7.3）：固定版本 Claude Code/Codex/Gemini CLI 跑多轮工具/并行工具/思考/长上下文压缩/取消限流，记录真实执行路径。

### 7.3 验收

矩阵 16 方向每方向至少 1 个 golden（含 SSE）；`limited` 方向的诊断码在 evidence 可查；thinking 剥除/降级有诊断码；三 CLI 验收报告归档。

---

## 8. G-C1：capability readiness 投影 + 探针分离

### 8.1 参考对比与现状

CLIProxyAPI `model_updater` 提供清单面参考：embed 内置清单 + 双镜像容错 + **校验通过后整表原子替换指针**（读写锁，读侧零拷贝）+ 失败保留旧清单 + generation 计数器丢弃过期刷新。缺陷：单回调、非增量。

现状：`/healthz`（proxy.ts:470）只查 db+telemetry；`/v1/models`（http-handler.ts:1394）有 plaza 门但无"已装配"维度；模型发现已有 OpenRouter/OpenCodeGo 同步设施。

### 8.2 落地设计

1. **探针分离**：`/healthz`（liveness：进程存活）保留；新增 `/readyz`（readiness：db + migration 版本 + 必要依赖 + **per-capability assembled**）。可选上游单账号故障不拖垮 readiness（方案 §13.2）；响应不暴露密钥/内部地址。
2. **能力四态投影**：`enabled / assembled / verified / operational` 单源来自 endpoint-registry + provider bundle registry + 验证记录；`/v1/models` 返回 Key 权限 ∩ assembled ∩ 可售；管理 API 暴露四态 + 脱敏原因。显式启用但缺装配 → 启动报配置错误（方案 §6.3）。
3. **模型清单原子发布**：沿用 CLIProxyAPI 模式——同步结果先校验（ID 去重、section 非空）再 generation CAS 切换；失败保留最近有效清单；价格同步只追加版本。已有 `ConfigStore.load()` mtime 缓存 + generation 机制的扩展即可，无需新部件。

### 8.3 验收

坏清单（缺 section/重复 ID）被拒且旧清单继续服务；readyz 在停一个可选上游时仍 200；未装配能力在 /v1/models 不可见；能力说明与 registry 同源（零漂移断言）。

---

## 9. G-C2：控制台闭环 + 巨型文件拆分（要点）

- 流程页按方案 §13.1 表（供给接入/销售配置/故障处置/任务运营/账务核对/品牌/告警）逐项补；新增页面独立文件，**禁止再扩展 `web/src/features/saas-platform.tsx`（3416 行）与 `saas-platform-client.ts`（3848 行）**——按流程域拆 `features/platform/{supply,pricing,incidents,tasks,ledger}.tsx`，旧文件只保留路由分发并逐页迁移。
- 展示价与执行价同一版本解析；"已实现未装配/未实测"管理员可见、客户可售列表不可见。
- 任务运营页直接消费 G-A1 的恢复循环数据（lease owner/poll_failures/recovered_at）——G-A1 先行，此页后做。
- 故障处置页消费 G-B1 的窗口三态/冷却状态（sticky_only/paused/冷却原因）。

## 10. G-A2 / G-A3（自建项，无参考代码，仅列口径）

- **G-A2 性能基线**：按方案 §10.1/10.3 原文执行——新 main 重跑 R9（单/多租户种子、固定 digest、p99 overhead <30ms/<10ms、三实例 ≥2.7×、c=200 无泄漏）。唯一参考吸收：sub2api 把"上游等待"与"代理 CPU"分开计时的口径。
- **G-A3 legacy-112 证据**：按方案 §5.2 原文执行——真库（旧 main 112 / ≤111 / 当前 129+）三向升级 + 故障注入回滚 + 双次幂等重跑 + 未知历史拒绝。命令已交付（`saas:migrate-legacy-112`），只差真库执行与报告归档。

## 11. 实施顺序与依赖（增量修订主方案 §15.2）

~~~text
第一批（P0，M0/M1 前）：
  G-A3 真库证据 ──┐
  G-A2 性能基线 ──┼─ 不互相依赖，可并行
  G-A1 任务恢复 ──┘ （G-A1 是收费可靠性，先行）

第二批（P1，M1 内）：
  G-B1 三态+多实例（依赖 migration 130 已在）
  G-B6 协议矩阵 + thinking（T03 续）
  G-C1 readiness 探针（依赖 endpoint-registry 持续注册）

第三批（P1，M2 内）：
  G-B2 multipart（busboy）→ G-B3 rerank/别名（同批，收入面）
  G-C2 控制台（任务运营页依赖 G-A1；故障处置页依赖 G-B1）

第四批（P1/P2，M3）：
  G-B4 Responses WS → 音频计量评审 → G-B5 Realtime WS
~~~

工作量（增量估计，人日）：G-A1 8–12、G-A2 3–5、G-A3 2–3、G-B1 4–6、G-B2 4–6、G-B3 1–2、G-B4 10–14、G-B5 8–12（含计量评审）、G-B6 6–10、G-C1 3–4、G-C2 6–10。合计 **55–84 人日**，叠加主方案 61–95 人日的未完成部分（M1–M3 剩余），均在既有里程碑框架内。

## 12. 数据与验收纪律（对齐主方案 §14）

- 新迁移编号从 **132** 起集中分配（本方案占用：132 media_task_recovery、133 model_cooldown）；registry/manifest 尾部断言同步。
- 每项 G 交付物含：真库/真实上游证据链接、失败注入记录、golden 零漂移证明（默认路径不变）。
- 参考代码**只对齐行为不移植字节**（主方案 §16 结论维持）：CAS 三件套、三态纯函数、关闭码语义、诊断码模式均为机制借鉴，非代码拷贝；若未来直接复用第三方源码须单独登记来源与许可。
