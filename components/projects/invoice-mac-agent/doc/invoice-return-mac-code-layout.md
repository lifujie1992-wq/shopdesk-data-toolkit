# Mac 侧代码目录 / 文件清单 + 接口签名（Node.js 版）

> 本文保留实施前的目录和接口设计，包含旧的常驻/5秒轮询、maxJobs=1及单任务状态示意，不能作为当前运行配置依据。2026-10-17现行行为以 [README](../README.md) 为准：每分钟启动有上限的一轮，maxJobs=3对应每次claim数量、maxJobsPerRun=20对应整轮上限；新增worker-round.mjs实现续领和持久化退避，state.mjs恢复整批租约，job-runner.mjs缓存同轮店铺列表。部署验证见 [开发验证记录](2026-10-16_V2-Mac开发验证记录.md)。

> 实现前的接口契约层设计，不包含具体实现。  
> 范围：只开发 Mac 侧。云端（VPS）已就绪，接口契约见 `invoice-worker-api.md`。

---

## 0. 技术栈与范围

全部使用 **Node.js（ESM）**：

| 位置                                           | 语言               | 说明                                                             |
| -------------------------------------------- | ---------------- | -------------------------------------------------------------- |
| **Mac 回传代理**（`/Users/zhaoxiaozhong/projects/invoice-mac-agent/`，新目录） | Node ESM（`.mjs`） | 纯 Node 内置能力（`fetch`/`node:fs`/`node:crypto`），无第三方依赖，launchd 常驻 |
| **店铺工作台开票模块**（`~/shopdesk-workbench-src/`，改） | JS（Electron 主进程） | 复用登录态 + 页面上下文 fetch 绕过风控                                       |

```text
Mac 回传代理 (Node ESM)                        店铺工作台 (Electron)
   cloud-client.mjs ──HTTPS──► 云端 VPS
   shopdesk-invoice-driver.mjs ──HTTP──► agent-bridge(/call) ──► invoice.js ──► 抖店页面
```

本机 Node `v24.20.0`（≥22.13 要求），自带全局 `fetch`，无需第三方依赖。

---

## 1. 共享类型定义（TS 风格，两侧对齐）

```ts
// ---- 云端任务（claim 返回）----
interface JobPayload {
  identity?: string
  invoiceNumber?: string
  orderId: string          // = 抖店「订单信息」列订单号 = /order/invoice/list 的 shop_order_id
  shopId: string           // = 店铺工作台 shops.json 的 id（uuid）
  shopName?: string
  amount: string | number  // 价税合计，核对用
  fileName?: string
  [k: string]: unknown
}
interface Job {
  job_id: string
  idempotency_key: string
  lease_expires_at: string | null
  leaseToken: string       // 一次性租约令牌，回传必带
  payload: JobPayload
  fileDownloadUrl: string  // 相对路径，需拼 baseUrl
  [k: string]: unknown
}

// ---- 回传结果 ----
type ResultState = 'uploaded' | 'failed' | 'retryable'
interface ReportInput {
  job_id: string
  leaseToken: string
  state: ResultState
  message: string          // ≤500 字符；失败时把错误原因同步云端
}
interface ReportOutput { state: string; idempotent: boolean }

// ---- 抖店列表行快照（关联/核对）----
interface ShopSnapshot {
  shop_order_id: string    // 必须与 payload.orderId 精确相等才算关联
  title: string            // 留证，不参与 Mac 侧强制核对
  tax_no: string           // 留证
  invoice_amount: string   // 与 payload.amount 核对（容差 0.01）
  invoice_status: number
  invoice_status_text: string  // 须为「待开票」
  [k: string]: unknown
}

// ---- 上传结果 / 提交结果 ----
interface UploadResult {
  ok: boolean
  key: string | null       // upload_pdf 的 data.key（= tos_key）
  snapshot: ShopSnapshot | null
  errorCode: string | null // 脱敏后的业务 code
  errorMsg: string | null  // 脱敏后的 msg
  screenshot: string | null
}
interface SubmitResult {
  ok: boolean
  submitted: boolean
  alreadySubmitted: boolean // 幂等判断：列表已显示已开票
  errorCode: string | null
  errorMsg: string | null
}
```

---

## 2. Mac 回传代理（Node ESM，`/Users/zhaoxiaozhong/projects/invoice-mac-agent/`）

### 2.1 目录清单

```text
invoice-mac-agent/                       # 完整路径 /Users/zhaoxiaozhong/projects/invoice-mac-agent/
├── package.json            # { "type": "module" }，无第三方依赖（仅 node: 内置）
├── agent.mjs               # 入口：轮询循环、串行队列、信号处理
├── config.mjs              # 配置/密钥加载与校验（0600 文件 + env 覆盖）
├── cloud-client.mjs        # 云端 claim / 下载 / 回传（leaseToken、409）
├── pdf-stage.mjs           # PDF 下载落盘、SHA256/大小/%PDF- 校验、清理
├── shopdesk-invoice-driver.mjs  # 店铺工作台 agent-bridge 客户端（关联/上传/提交）
├── job-runner.mjs          # 单任务编排 + submitMode 三档 + 错误分类
├── redact.mjs              # 脱敏、白名单、消息截断
├── state.mjs               # 本地运行状态（可选）
├── log.mjs                 # 结构化日志（stdout + 文件）
├── fixtures/
│   ├── claim-response.json
│   └── sample.pdf
└── test/
    ├── cloud-client.test.mjs
    ├── job-runner.test.mjs
    ├── redact.test.mjs
    └── shopdesk-driver.test.mjs
```

### 2.2 接口签名

#### `config.mjs`

```js
// 配置来源：~/.config/invoice-mac-agent/config.json（0600）> 环境变量
export interface Config {
  workbenchBaseUrl: string      // 如 https://erp.xiangduoer.com
  accountId: string             // X-Invoice-Account-Id
  workerToken: string           // X-Invoice-Worker-Token
  shopdeskPort: number          // agent-bridge 端口
  shopdeskToken: string         // agent-bridge token
  submitMode: 'dry-run' | 'upload-only' | 'auto'
  pollIntervalMs: number        // 默认 5000
  maxJobs: number               // 默认 1
  leaseSoftDeadlineMs: number   // 默认 60_000（lease 10min - 60s）
  stagingDir: string            // 默认 ~/.local/share/invoice-mac-agent/staging
  logDir: string
}

export function loadConfig(env = process.env): Config
export function assertConfig(cfg: Config): void   // 必填项缺失/非法则 throw
export function loadShopdeskBridge(): { port: number; token: string }
  // 读 ~/Library/Application Support/shopdesk/agent-bridge.json（0600）
```

#### `cloud-client.mjs`

```js
export class FatalAuthError extends Error {}      // 401/403，停轮询转人工
export class LeaseConflictError extends Error {}  // 409，租约失效，放弃本地结果

export function createCloudClient(cfg: Config): CloudClient

interface CloudClient {
  claim(): Promise<{ jobs: Job[] }>
    // POST /api/invoice/worker/jobs/claim { maxJobs }
    // 头：X-Invoice-Account-Id + X-Invoice-Worker-Token；不发 Origin
    // 网络/5xx：指数退避重试；401/403：抛 FatalAuthError

  download(job: Job, destPath: string): Promise<{ path: string; sha256: string; size: number }>
    // GET baseUrl + fileDownloadUrl，二进制落盘；以 payload.fileName 命名

  report(input: ReportInput): Promise<ReportOutput>
    // POST /api/invoice/worker/jobs/:jobId/result { state, message, leaseToken }
    // 409：抛 LeaseConflictError；idempotent:true 视为完成
}
```

#### `pdf-stage.mjs`

```js
export class PdfIntegrityError extends Error {}

export function stagePdf(cloud: CloudClient, job: Job, stagingDir: string)
  : Promise<{ path: string; sha256: string; size: number }>
  // 下载到 stagingDir/<job_id>/original.pdf；校验 %PDF- 魔数、记录 sha256/size

export function cleanupStage(jobId: string, stagingDir: string): Promise<void>
```

#### `shopdesk-invoice-driver.mjs`

```js
export function createShopdeskInvoiceDriver(bridge: { port: number; token: string }): ShopdeskDriver

interface ShopdeskDriver {
  listShops(): Promise<Shop[]>                       // method: list_shops

  invoiceList(args: {
    shop_id: string                                  // = payload.shopId（shops.json id）
    shop_order_id: string                            // = payload.orderId
    status_desc?: string                             // 默认 'wait_blue'
  }): Promise<{ rows: ShopSnapshot[]; total: number }>
    // method: invoice_list；关联判定由调用方做：row.shop_order_id === payload.orderId

  invoiceUploadPdf(args: {
    shop_id: string
    shop_order_id: string
    pdf_path: string                                 // Mac 侧绝对路径
  }): Promise<UploadResult>
    // method: invoice_upload_pdf

  invoiceSubmit(args: {
    shop_id: string
    shop_order_id: string
    tos_key: string                                  // upload_pdf 的 data.key
    file_name: string
    blue_invoice_key?: string
  }): Promise<SubmitResult>
    // method: invoice_submit

  invoiceHealth(args: { shop_id: string }): Promise<{ login: boolean; pageOk: boolean }>
    // method: invoice_health

  // 统一走 agent-bridge：POST http://127.0.0.1:{port}/call
  // 头 Authorization: Bearer {token}，body { method, args }，超时按任务类型
}
```

#### `job-runner.mjs`

```js
export function createJobRunner(deps: {
  cloud: CloudClient
  stage: typeof stagePdf
  driver: ShopdeskDriver
  cfg: Config
  log: Logger
}): { run(job: Job): Promise<void> }

// run(job) 四步流程：
//   1. 校验 job.leaseToken 存在、租约未过期（softDeadline）
//   2. stagePdf 下载 + 校验
//   3. driver.invoiceList 关联查询：shop_order_id 精确相等才继续，否则回 failed
//      核对 invoice_amount ≈ payload.amount（0.01 容差）+ 店铺 + status=待开票
//   4. submitMode 分支：
//        dry-run     → 只查/核对，不传不提交
//        upload-only → upload_pdf 拿 key，不 save
//        auto        → upload_pdf → save → 刷新列表验证 → 回 uploaded
//   5. save 失败：先 invoiceList 幂等判断（已提交 → 回 uploaded）
//      否则回 retryable，错误原因写 message
//   6. cloud.report({ job_id, leaseToken, state, message })；409 时放弃并清理
```

#### `agent.mjs`

```js
async function main(cfg: Config): Promise<void>
//   loadConfig → assertConfig → 构造 cloud/stage/driver/runner
//   setInterval(pollIntervalMs)：claim() → 串行队列（maxJobs=1）→ runner.run(job)
//   SIGINT/SIGTERM：停止领取，等在跑任务结束或回 retryable，退出
```

#### `redact.mjs`

```js
export function redactUrl(u: string): string                 // 去 query/凭据，截 host+path
export function redactMessage(s: string, max = 500): string  // 白名单字段 + 截断
export function sanitizeLog(rec: Record<string, unknown>): Record<string, unknown>
  // 默认拒绝：Cookie/Authorization/签名 URL/动态参数 一律不落
```

#### `log.mjs` / `state.mjs`

```js
export function createLogger(logDir: string): Logger  // stdout + 文件，经 sanitizeLog 过滤

export function createState(file: string): { load(): void; save(job: Job): void }
  // 进程重启后：已领取未完成的任务统一回 retryable（旧 leaseToken 尝试，409 则忽略）
```

#### `package.json`

```json
{ "name": "invoice-mac-agent", "type": "module", "private": true }
```

---

## 3. 店铺工作台开票模块（JS，`~/shopdesk-workbench-src/`）

### 3.1 改动清单

| 文件                 | 改动                                     |
| ------------------ | -------------------------------------- |
| `src/invoice.js`   | **新增**：消费者开票模块（对齐 `appeal.js`）         |
| `src/agent-api.js` | 改：`createDispatcher` 增加 `invoice_*` 分发 |
| `src/main.js`      | 改：注册 `createInvoice({store, app})`     |

### 3.2 `src/invoice.js` 接口签名

```js
export function createInvoice({ store, app }): InvoiceModule

interface InvoiceModule {
  list({ shop_id, shop_order_id, status_desc })
    : Promise<{ rows: ShopSnapshot[]; total: number; error?: string }>
    // 隐藏 BrowserWindow(session.fromPartition('persist:shop-'+shop_id))
    // executeJavaScript 注入 pageInvoiceList 拉 /order/invoice/list

  detail({ shop_id, shop_order_id }): Promise<{...}>

  uploadPdf({ shop_id, shop_order_id, pdf_path })
    : Promise<UploadResult>
    // 页面 fetch 直连（已实测无需 csrf/动态参数）：主进程读 pdf → base64 → 页面内 FormData 传 file
    // 接口契约见 invoice-return-doudian-api.md §4

  submit({ shop_id, shop_order_id, tos_key, file_name, blue_invoice_key })
    : Promise<SubmitResult>
    // 页面上下文 fetch /order/invoice/save；成功后刷新 list 验证状态

  health({ shop_id }): Promise<{ login, pageOk }>
}

// 注入脚本（自包含，executeJavaScript 序列化）：
//   pageInvoiceList / pageInvoiceCounts / pageInvoiceDetail
//   pageInvoiceUploadPdf / pageInvoiceSubmit / pageInvoiceCsrf / pageReadInvoiceUpload
```

### 3.3 `agent-api.js` 新增 method

```js
if (method === 'invoice_list')        return invoice.list(args)
if (method === 'invoice_detail')      return invoice.detail(args)
if (method === 'invoice_upload_pdf')  return invoice.uploadPdf(args)
if (method === 'invoice_submit')      return invoice.submit(args)
if (method === 'invoice_health')      return invoice.health(args)
```

---

## 4. agent-bridge 调用约定（Mac 代理 ↔ 店铺工作台）

```http
POST http://127.0.0.1:{port}/call
Authorization: Bearer {shopdeskToken}
Content-Type: application/json

{ "method": "invoice_upload_pdf",
  "args": { "shop_id": "...", "shop_order_id": "...", "pdf_path": "/abs/path/original.pdf" } }
```


```

- 端口/token 从 `~/Library/Application Support/shopdesk/agent-bridge.json` 读取（0600）。
- 响应 `{ "result": {...} }` 或 `{ "error": "..." }`。
- `pdf_path` 传 Mac 侧绝对路径，由店铺工作台主进程读取后经 CDP 上传。

---

## 5. 错误码与回传映射

| 场景 | 回传 state | message |
|---|---|---|
| 关联失败（shop_order_id 不精确相等/查不到/查多条） | `failed` | 「待开票列表未找到/不匹配订单 xxx」 |
| 字段核对失败（金额/店铺/状态不符） | `failed` | 具体不符字段 |
| `upload_pdf` 业务失败（不可重试码） | `failed` | 脱敏 code/msg |
| 上传/网络/登录超时（可重试） | `retryable` | 原因 |
| `save` 失败且列表未提交 | `retryable` | 脱敏 code/msg（同步云端） |
| `save` 失败但列表已显示已开票（幂等） | `uploaded` | 「已提交」 |
| 关联+上传+save 全成功 + 列表验证通过 | `uploaded` | 「抖店开票成功」 |
| 回传收到 `409` | —（放弃，重新 claim） | 本地日志 |

---

## 6. 建议实施顺序

1. `config.mjs` + `log.mjs` + `redact.mjs`（基础件，可单测）
2. `cloud-client.mjs`（mock 云端联调 claim/下载/回传 + leaseToken/409）
3. `pdf-stage.mjs`
4. 店铺工作台 `src/invoice.js` + `agent-api.js`/`main.js`（先用 `flyge_probe` 走查固化选择器）
5. `shopdesk-invoice-driver.mjs`（对接 agent-bridge）
6. `job-runner.mjs` + `agent.mjs`（串行编排 + submitMode）
7. `state.mjs`（可选）+ launchd 部署

---

## 附：与既有文档对应

| 本文 | 对应 |
|---|---|
| `cloud-client.mjs` | `invoice-return-mac-agent-dev-plan.md` §5.1 |
| `shopdesk-invoice-driver.mjs` | `invoice-return-mac-agent-dev-plan.md` §5.5 |
| 店铺工作台 `invoice.js` | `invoice-return-shopdesk-reuse.md` §3.2 |
| 四步流程 + submitMode | `invoice-return-feature-checklist.md` §2 |
| 云端字段口径 | `invoice-worker-api.md` |
```
