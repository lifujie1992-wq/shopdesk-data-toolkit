# 发票回传 Worker API

本文档面向外部 Mac Agent 或其他发票回传服务，描述 `server/invoice-worker-api.mjs` 在 HTTP 层暴露的任务领取、原件下载和结果回传接口。字段和行为以当前代码为准。

## 1. 基本信息

### ERP 发票管理 V2

订单主表、解析台账和 Mac 回传数据统一存储在 `.local-data/invoice-management-v2.sqlite`。  
回传相关表为 `invoice_files`、`invoice_records`、`invoice_match_candidates`、  
`invoice_business_events`、`invoice_upload_jobs`、`invoice_worker`、`invoice_events`。  
启动时一次性迁移旧库，保留任务 ID、租约、代理 Token 哈希及事件；  
`invoice_database_migrations` 记录完成标记，后续启动和接口读写不再访问旧库。  
旧数据库保留供核对，不再作为运行时回传数据源。  
原件继续保存在共享 archive 文件目录，数据库保留其路径。

V2 上传入口为 `POST /api/invoice/v2/ingest`，按  
`invoice-management-v2.sqlite` 的 `invoice_order_consumer` 主表匹配。  
购买方名称、购买方税号、价税合计金额三项必须同时一致（金额按分比较）。  
唯一命中自动入队，多条命中须经 `POST /api/invoice/v2/ledger/resolve`  
人工确认；零条命中为“未找到订单”，不按订单号或仅金额降级匹配，也不由 AI 自动选择。

Mac 继续使用本文的领取、下载、结果回传接口。V2 任务的  
`invoice_id` 为 `v2:<发票identity>`；以 `payload.identity` 作为原发票标识，  
新增 `payload.businessVersion = "v2"`、`subOrderNo`、`subOrderNoKey`。  
订单定位使用 `shopId + orderId + subOrderNoKey`，无子订单时 `subOrderNoKey` 为空字符串。  
V2 任务分配给默认 Mac Worker，`created_by` 单独记录创建任务的 ERP 操作账号，上传人无需注册 Token。  
单 Mac 阶段默认采用最早注册的启用代理，`invoice_worker.is_default=1` 标记默认代理；后续注册其他账号不会抢占。  
未注册代理时任务仍保存为 `pending`，`account_id=''` 表示等待分配；首次注册后自动分配。  
服务启动时也会修正历史待领取 V2 任务的归属，执行中、已完成、失败及已删除任务保持原样；失败任务重试时再按默认代理分配。  
Mac 继续携带注册时的账号 ID 和 Token 领取，无需更换 Token 或调整接口。

| 任务阶段         | 主表 erp_status      |
| ------------ | ------------------ |
| 已匹配并入队       | pending_mac_upload |
| Mac 已领取      | uploading          |
| 回调 uploaded  | invoiced           |
| 回调 failed    | upload_failed      |
| 回调 retryable | pending_mac_upload |

重复上传同一发票不会新建任务；已成功回传的记录不会再次入队。  
待领取任务可删除并释放订单关联；正在回传和已成功回传的发票不可删除。

删除采用逻辑删除。`invoice_files`、`invoice_records`、`invoice_match_candidates`、  
`invoice_upload_jobs` 均包含 `is_deleted`（0 正常，1 已删除）、`deleted_at`、`deleted_by`。  
删除保留原件文件、解析记录、候选和事件，只从页面、导出、文件预览及 Mac 任务领取中排除。  
原件索引被多张正常发票共用时保留为正常状态，直到最后一条关联发票被删除。  
重新上传同一发票可恢复记录与任务；旧租约不能用于恢复后的任务回调。

- 协议：HTTP/HTTPS
- 默认本机 API 地址：`http://127.0.0.1:3001`
- 生产环境地址：由部署环境的公网域名决定，例如 `https://erp.xiangduoer.com`
- 响应编码：JSON 接口使用 UTF-8；文件下载接口返回原始二进制内容
- 账号隔离：所有任务按 `X-Invoice-Account-Id` 隔离，Worker 只能看到所属账号的任务

生产环境应使用公网反向代理地址。默认 API 服务只监听 `127.0.0.1`，外部服务不能直接访问服务器的 `127.0.0.1:3001`。

## 2. 通用鉴权

Worker 接口不使用浏览器登录 Cookie，而是使用两个请求头：

| 请求头                              | 必填      | 说明                                                                                        |
| -------------------------------- | ------- | ----------------------------------------------------------------------------------------- |
| `X-Invoice-Account-Id`           | 是       | 发票账号 ID；必须使用管理员注册代理时对应的账号 ID                                                              |
| `X-Invoice-Worker-Token`         | 是       | Mac Agent Token。鉴权使用 SHA-256 哈希；原文保存在 V2 库 `invoice_worker.token_value` 列，供后台核对，不通过状态接口返回 |
| `Content-Type: application/json` | POST 时是 | 请求体为 JSON 的接口需要设置                                                                         |

Token 由管理员接口注册，长度至少 24 个字符。重新注册会替换旧 Token，旧 Token 立即失效。  
历史记录仅有哈希的，新增 `token_value` 为 NULL，原 Token 仍然有效；重新保存后才会记录原文，不会自动轮换 Token。

服务间调用建议不要发送 `Origin` 请求头。若发送了 `Origin`，服务端会执行来源校验，来源必须是当前 API Host 或本地工作台来源。

## 3. 领取任务

### `POST /api/invoice/worker/jobs/claim`

Worker 主动轮询此接口领取任务。

### 请求

请求头：

```http
X-Invoice-Account-Id: account-001
X-Invoice-Worker-Token: your-worker-token
Content-Type: application/json
```

请求体：

```json
{
  "maxJobs": 5
}
```

`maxJobs` 是可选字段，行为如下：

- 未传、无法转换为数字或值为 `0` 时按 `5` 处理；
- 小于 `1` 时按 `1` 处理；
- 大于 `20` 时按 `20` 处理。

当前Mac生产代理（2026-10-17）配置为 `maxJobs=3`、`maxJobsPerRun=20`。本地 `maxJobs` 直接对应本接口同名入参；每次实际申请 `min(maxJobs, maxJobsPerRun - 本轮已处理数)` 条，最后一批额度不足3条时会缩小请求数量。`maxJobsPerRun` 是Mac本地整轮处理上限，不发送给接口；原本地字段 `claimBatchSize` 已移除。服务端未传时默认5条的契约保持不变。

Mac每分钟启动一轮，逐批领取、逐条执行。队列为空时一轮只调用一次本接口；失败冷却期不调用。批次示例、店铺缓存、请求重试和整轮退避的现行规则见 [README](../README.md)。

### 任务选择和租约

服务端按创建时间升序选择当前账号满足以下条件的任务：

- `state = "pending"`；或
- `state = "processing"` 且 `lease_expires_at` 已过期。

领取成功后，任务会原子地更新为 `processing`，`attempts` 加一，并设置 10 分钟租约。Worker 进程崩溃或未回传结果时，租约过期后任务可以再次领取。  
每次领取还会生成一次性 `leaseToken`。回传结果必须带上本次领取返回的租约令牌，旧 Worker 的迟到回调会被拒绝，避免覆盖新 Worker 的结果。

### 成功响应

HTTP 状态码为 `200`，响应结构为：

```json
{
  "jobs": [
    {
      "job_id": "job-abc123",
      "invoice_id": "invoice-001",
      "account_id": "account-001",
      "idempotency_key": "account-001:invoice-001",
      "state": "processing",
      "lease_expires_at": "2026-10-13T10:00:00.000Z",
      "leaseToken": "9f3c...",
      "attempts": 1,
      "last_error": null,
      "payload_json": "{\\"identity\\":\\"invoice-001\\",\\"filePath\\":\\"/server/.local-data/.../invoice.pdf\\"}",
      "created_at": "2026-10-13T09:50:00.000Z",
      "started_at": "2026-10-13T09:50:00.000Z",
      "finished_at": null,
      "updated_at": "2026-10-13T09:50:00.000Z",
      "payload": {
        "identity": "invoice-001",
        "invoiceNumber": "12345678",
        "orderId": "order-001",
        "shopId": "shop-001",
        "shopName": "示例店铺",
        "amount": "169.00",
        "fileName": "invoice.pdf"
      },
      "fileDownloadUrl": "/api/invoice/worker/jobs/job-abc123/file"
    }
  ]
}
```

没有可领取任务时返回：

```json
{
  "jobs": []
}
```

字段说明：

| 字段                 | 类型          | 说明                                                           |
| ------------------ | ----------- | ------------------------------------------------------------ |
| `job_id`           | string      | 任务 ID，用于下载文件和回传结果                                            |
| `invoice_id`       | string      | 发票业务标识                                                       |
| `account_id`       | string      | 执行代理的账号 ID；V2 未分配时为空字符串                                      |
| `created_by`       | string      | 创建任务的 ERP 操作账号 ID，与执行代理分开记录                                  |
| `idempotency_key`  | string      | 入队幂等键，同一幂等键不会创建重复任务                                          |
| `state`            | string      | 领取后固定为 `processing`                                          |
| `lease_expires_at` | string/null | ISO 8601 时间；当前租约默认 10 分钟                                     |
| `leaseToken`       | string      | 一次性 `leaseToken`。回传结果必须带上本次领取返回的租约令牌                         |
| `attempts`         | number      | 当前第几次领取                                                      |
| `last_error`       | string/null | 最近一次错误信息                                                     |
| `payload_json`     | string      | 数据库中的原始 JSON 字符串。当前实现会保留此字段，其中可能包含服务器内部 `filePath`；外部服务不应依赖它 |
| `payload`          | object      | 解析后的任务数据。为避免暴露路径，当前实现会删除其中的 `filePath`                       |
| `fileDownloadUrl`  | string      | 原件下载相对路径，需要拼接服务根地址                                           |
| `created_at`       | string      | 创建时间，ISO 8601                                                |
| `started_at`       | string/null | 首次领取时间，ISO 8601                                              |
| `finished_at`      | string/null | 完成时间；领取时通常为 `null`                                           |
| `updated_at`       | string      | 最近更新时间，ISO 8601                                              |

当前正常入队任务的 `payload` 通常包含 `identity`、`invoiceNumber`、`orderId`、`shopId`、`shopName`、`amount` 和 `fileName`。客户端应允许业务方增加其他字段，不要假设字段集合永远固定。

### 调用示例

```bash
curl -X POST 'https://erp.xiangduoer.com/api/invoice/worker/jobs/claim' \\
  -H 'X-Invoice-Account-Id: account-001' \\
  -H 'X-Invoice-Worker-Token: your-worker-token' \\
  -H 'Content-Type: application/json' \\
  -d '{"maxJobs":5}'
```

## 4. 下载发票原件

### `GET /api/invoice/worker/jobs/:jobId/file`

使用领取响应里的 `job_id` 或 `fileDownloadUrl` 下载原件。

### 请求

```http
GET /api/invoice/worker/jobs/job-abc123/file
X-Invoice-Account-Id: account-001
X-Invoice-Worker-Token: your-worker-token
```

`fileDownloadUrl` 是相对路径。例如：

```text
fileDownloadUrl = /api/invoice/worker/jobs/job-abc123/file
完整地址 = https://erp.xiangduoer.com/api/invoice/worker/jobs/job-abc123/file
```

### 成功响应

HTTP 状态码为 `200`，响应体是文件原始二进制内容，不是 JSON，也不是 Base64：

```http
HTTP/1.1 200 OK
Content-Type: application/pdf
Cache-Control: private, max-age=60

<binary file bytes>
```

接口当前固定返回 `Content-Type: application/pdf`。即使存档层允许 OFD、XML、CSV 等扩展名，外部服务也应以实际文件内容和领取任务中的 `payload.fileName` 为准。接口不返回 `Content-Disposition`，客户端需要自行决定保存文件名。

### 调用示例

```bash
curl 'https://erp.xiangduoer.com/api/invoice/worker/jobs/job-abc123/file' \\
  -H 'X-Invoice-Account-Id: account-001' \\
  -H 'X-Invoice-Worker-Token: your-worker-token' \\
  --output invoice.pdf
```

下载接口只校验账号、Token 和任务归属，不会因为任务租约已过期而拒绝下载；但任务和原件仍必须存在。

## 5. 回传任务结果

### `POST /api/invoice/worker/jobs/:jobId/result`

文件上传到目标平台后，Worker 使用此接口回传处理结果。

### 请求

```http
X-Invoice-Account-Id: account-001
X-Invoice-Worker-Token: your-worker-token
Content-Type: application/json
```

请求体：

```json
{
  "state": "uploaded",
  "message": "抖店上传成功",
  "leaseToken": "9f3c..."
}
```

字段说明：

| 字段           | 必填       | 类型     | 说明                                  |
| ------------ | -------- | ------ | ----------------------------------- |
| `state`      | 是        | string | 只能是 `uploaded`、`failed`、`retryable` |
| `message`    | 否        | string | 成功说明或失败原因，服务端最多保存 500 个字符           |
| `leaseToken` | 是（已领取任务） | string | 本次 `claim` 返回的租约令牌；租约过期或被重新领取后旧令牌失效 |

当前实现不会读取 `finishedAt` 字段；客户端可以不发送该字段。

状态转换：

| 请求 `state`  | 数据库最终状态    | 说明               |
| ----------- | ---------- | ---------------- |
| `uploaded`  | `uploaded` | 上传成功，清除租约并写入完成时间 |
| `failed`    | `failed`   | 终止本次任务，保存错误信息    |
| `retryable` | `pending`  | 清除租约，允许后续再次领取    |

### 成功响应

首次回传时返回任务最新记录，并包含 `idempotent: false`：

```json
{
  "job_id": "job-abc123",
  "invoice_id": "invoice-001",
  "account_id": "account-001",
  "idempotency_key": "account-001:invoice-001",
  "state": "uploaded",
  "lease_expires_at": null,
  "attempts": 1,
  "last_error": null,
  "payload_json": "{...}",
  "created_at": "2026-10-13T09:50:00.000Z",
  "started_at": "2026-10-13T09:50:00.000Z",
  "finished_at": "2026-10-13T09:55:00.000Z",
  "updated_at": "2026-10-13T09:55:00.000Z",
  "idempotent": false
}
```

对已经是 `uploaded` 的任务重复回传时，服务端不重复执行状态更新，返回 `idempotent: true`：

```json
{
  "job_id": "job-abc123",
  "state": "uploaded",
  "idempotent": true
}
```

实际响应会包含该任务数据库记录的其他字段，客户端应重点读取 `state` 和 `idempotent`。

### 调用示例

成功：

```bash
curl -X POST 'https://erp.xiangduoer.com/api/invoice/worker/jobs/job-abc123/result' \\
  -H 'X-Invoice-Account-Id: account-001' \\
  -H 'X-Invoice-Worker-Token: your-worker-token' \\
  -H 'Content-Type: application/json' \\
  -d '{"state":"uploaded","message":"抖店上传成功","leaseToken":"9f3c..."}'
```

可重试失败：

```bash
curl -X POST 'https://erp.xiangduoer.com/api/invoice/worker/jobs/job-abc123/result' \\
  -H 'X-Invoice-Account-Id: account-001' \\
  -H 'X-Invoice-Worker-Token: your-worker-token' \\
  -H 'Content-Type: application/json' \\
  -d '{"state":"retryable","message":"抖店页面暂时不可用","leaseToken":"9f3c..."}'
```

## 6. 错误响应

JSON 接口和文件下载接口出错时，响应通常为：

```json
{
  "error": "错误说明"
}
```

常见错误：

| HTTP 状态码 | `error` 示例          | 触发条件                          |
| -------- | ------------------- | ----------------------------- |
| `400`    | `回传结果状态无效`          | `state` 不在允许枚举中，或请求 JSON/参数无效 |
| `401`    | `代理 Token 无效或已停用`   | 账号、Token 不匹配或代理已被替换/停用        |
| `404`    | `回传任务不存在`           | `jobId` 不存在或不属于当前账号           |
| `409`    | `回传任务租约已失效，请重新领取任务` | 未携带当前租约令牌，任务租约已过期或已被重新领取      |
| `404`    | `原件读取失败`            | 任务对应的原件不存在或无法读取               |
| `400`    | `原件路径无效`            | 数据库里的原件路径不在服务端 archive 目录内    |

## 7. 管理员注册和查看状态

以下接口用于工作台管理员配置 Mac Agent，不由外部 Worker 轮询调用。它们使用工作台登录会话，而不是 Worker Token。

### `POST /api/invoice/worker/register`

请求体：

```json
{
  "token": "your-worker-token-at-least-24-chars",
  "displayName": "Mac 发票回传代理"
}
```

成功响应：

```json
{
  "accountId": "account-001",
  "displayName": "Mac 发票回传代理",
  "updatedAt": "2026-10-13T09:00:00.000Z"
}
```

`token` 少于 24 个字符时返回 `400`。`displayName` 最多保存 100 个字符。

### `GET /api/invoice/worker/status`

成功响应示例：

```json
{
  "registered": true,
  "displayName": "Mac 发票回传代理",
  "enabled": true,
  "lastSeenAt": "2026-10-13T09:55:00.000Z",
  "createdAt": "2026-10-13T09:00:00.000Z",
  "updatedAt": "2026-10-13T09:55:00.000Z"
}
```

未注册时返回：

```json
{
  "registered": false
}
```

## 8. 推荐调用流程

1. 管理员在工作台注册 Worker Token，并把账号 ID 和 Token 安全地配置到外部 Worker。
2. Worker 定期调用 `POST /api/invoice/worker/jobs/claim`。
3. 对每个任务，使用 `fileDownloadUrl` 加上服务根地址下载原件。
4. 调用目标平台完成上传。
5. 上传成功回传 `uploaded`；可恢复错误回传 `retryable`；不可恢复错误回传 `failed`。
6. 收到 `idempotent: true` 时，将其视为已完成，不需要重复上传。

## 9. TypeScript 类型参考

```ts
export type WorkerJobState = 'pending' | 'processing' | 'uploaded' | 'failed'
export type WorkerResultState = 'uploaded' | 'failed' | 'retryable'

export interface ClaimRequest {
  maxJobs?: number
}

export interface InvoiceJobPayload {
  identity?: string
  invoiceNumber?: string
  orderId?: string
  shopId?: string
  shopName?: string
  amount?: string | number
  fileName?: string
  [key: string]: unknown
}

export interface InvoiceWorkerJob {
  job_id: string
  invoice_id: string
  account_id: string
  idempotency_key: string
  state: WorkerJobState
  lease_expires_at: string | null
  attempts: number
  last_error: string | null
  payload_json: string
  created_at: string
  started_at: string | null
  finished_at: string | null
  updated_at: string
  payload: InvoiceJobPayload
  fileDownloadUrl: string
}

export interface ClaimResponse {
  jobs: InvoiceWorkerJob[]
}

export interface ResultRequest {
  state: WorkerResultState
  message?: string
}

export interface ResultResponse extends Partial<InvoiceWorkerJob> {
  idempotent: boolean
}

export interface ErrorResponse {
  error: string
}
```


<span style="color:rgb(41, 114, 244)">"created_at"</span>: <span style="color:rgb(222, 60, 54)">"2026-10-13T09:50:00.000Z"</span>,

<span style="color:rgb(41, 114, 244)">"started_at"</span>: <span style="color:rgb(222, 60, 54)">"2026-10-13T09:50:00.000Z"</span>,

<span style="color:rgb(41, 114, 244)">"finished_at"</span>: <span style="color:rgb(222, 60, 54)">"2026-10-13T09:55:00.000Z"</span>,

<span style="color:rgb(41, 114, 244)">"updated_at"</span>: <span style="color:rgb(222, 60, 54)">"2026-10-13T09:55:00.000Z"</span>,

<span style="color:rgb(41, 114, 244)">"idempotent"</span>: false

}

\`\`\`

对已经是 \`uploaded\` 的任务重复回传时，服务端不重复执行状态更新，返回 \`idempotent: true\`：

\`\`\`json

{

<span style="color:rgb(41, 114, 244)">"job_id"</span>: <span style="color:rgb(222, 60, 54)">"job-abc123"</span>,

<span style="color:rgb(41, 114, 244)">"state"</span>: <span style="color:rgb(222, 60, 54)">"uploaded"</span>,

<span style="color:rgb(41, 114, 244)">"idempotent"</span>: true

}

\`\`\`

实际响应会包含该任务数据库记录的其他字段，客户端应重点读取 \`state\` 和 \`idempotent\`。

**### 调用示例**

成功：

\`\`\`bash

curl <span style="color:rgb(222, 60, 54)">-X</span> <span style="color:rgb(222, 60, 54)">POST</span> <span style="color:rgb(222, 60, 54)">'<https://erp.xiangduoer.com/api/invoice/worker/jobs/job-abc123/result>'</span> \\\

-H 'X-Invoice-Account-Id: account-001' \\\

<span style="color:rgb(222, 60, 54)">-H</span> <span style="color:rgb(222, 60, 54)">'X-Invoice-Worker-Token: your-worker-token'</span> \\\

-H 'Content-Type: application/json' \\\

<span style="color:rgb(222, 60, 54)">-d</span> <span style="color:rgb(222, 60, 54)">'{"state":"uploaded","message":"抖店上传成功","leaseToken":"9f3c..."}'</span>

\`\`\`

可重试失败：

\`\`\`bash

curl <span style="color:rgb(222, 60, 54)">-X</span> <span style="color:rgb(222, 60, 54)">POST</span> <span style="color:rgb(222, 60, 54)">'<https://erp.xiangduoer.com/api/invoice/worker/jobs/job-abc123/result>'</span> \\\

-H 'X-Invoice-Account-Id: account-001' \\\

<span style="color:rgb(222, 60, 54)">-H</span> <span style="color:rgb(222, 60, 54)">'X-Invoice-Worker-Token: your-worker-token'</span> \\\

-H 'Content-Type: application/json' \\\

<span style="color:rgb(222, 60, 54)">-d</span> <span style="color:rgb(222, 60, 54)">'{"state":"retryable","message":"抖店页面暂时不可用","leaseToken":"9f3c..."}'</span>

\`\`\`

**## 6. 错误响应**

JSON 接口和文件下载接口出错时，响应通常为：

\`\`\`json

{

<span style="color:rgb(41, 114, 244)">"error"</span>: <span style="color:rgb(222, 60, 54)">"错误说明"</span>

}

\`\`\`

常见错误：

| HTTP 状态码 | \`error\` 示例 | 触发条件 |

| --- | --- | --- |

| \`400\` | \`回传结果状态无效\` | \`state\` 不在允许枚举中，或请求 JSON/参数无效 |

| \`401\` | \`代理 Token 无效或已停用\` | 账号、Token 不匹配或代理已被替换/停用 |

| \`404\` | \`回传任务不存在\` | \`jobId\` 不存在或不属于当前账号 |

| \`409\` | \`回传任务租约已失效，请重新领取任务\` | 未携带当前租约令牌，任务租约已过期或已被重新领取 |

| \`404\` | \`原件读取失败\` | 任务对应的原件不存在或无法读取 |

| \`400\` | \`原件路径无效\` | 数据库里的原件路径不在服务端 archive 目录内 |

**## 7. 管理员注册和查看状态**

以下接口用于工作台管理员配置 Mac Agent，不由外部 Worker 轮询调用。它们使用工作台登录会话，而不是 Worker Token。

**### \`POST /api/invoice/worker/register\`**

请求体：

\`\`\`json

{

<span style="color:rgb(41, 114, 244)">"token"</span>: <span style="color:rgb(222, 60, 54)">"your-worker-token-at-least-24-chars"</span>,

<span style="color:rgb(41, 114, 244)">"displayName"</span>: <span style="color:rgb(222, 60, 54)">"Mac 发票回传代理"</span>

}

\`\`\`

成功响应：

\`\`\`json

{

<span style="color:rgb(41, 114, 244)">"accountId"</span>: <span style="color:rgb(222, 60, 54)">"account-001"</span>,

<span style="color:rgb(41, 114, 244)">"displayName"</span>: <span style="color:rgb(222, 60, 54)">"Mac 发票回传代理"</span>,

<span style="color:rgb(41, 114, 244)">"updatedAt"</span>: <span style="color:rgb(222, 60, 54)">"2026-10-13T09:00:00.000Z"</span>

}

\`\`\`

\`token\` 少于 24 个字符时返回 \`400\`。\`displayName\` 最多保存 100 个字符。

**### \`GET /api/invoice/worker/status\`**

成功响应示例：

\`\`\`json

{

<span style="color:rgb(41, 114, 244)">"registered"</span>: true,

<span style="color:rgb(41, 114, 244)">"displayName"</span>: <span style="color:rgb(222, 60, 54)">"Mac 发票回传代理"</span>,

<span style="color:rgb(41, 114, 244)">"enabled"</span>: true,

<span style="color:rgb(41, 114, 244)">"lastSeenAt"</span>: <span style="color:rgb(222, 60, 54)">"2026-10-13T09:55:00.000Z"</span>,

<span style="color:rgb(41, 114, 244)">"createdAt"</span>: <span style="color:rgb(222, 60, 54)">"2026-10-13T09:00:00.000Z"</span>,

<span style="color:rgb(41, 114, 244)">"updatedAt"</span>: <span style="color:rgb(222, 60, 54)">"2026-10-13T09:55:00.000Z"</span>

}

\`\`\`

未注册时返回：

\`\`\`json

{

<span style="color:rgb(41, 114, 244)">"registered"</span>: false

}

\`\`\`

**## 8. 推荐调用流程**

<span style="color:rgb(41, 114, 244)">1.</span> 管理员在工作台注册 Worker Token，并把账号 ID 和 Token 安全地配置到外部 Worker。

<span style="color:rgb(41, 114, 244)">2.</span> Worker 定期调用 \`POST /api/invoice/worker/jobs/claim\`。

<span style="color:rgb(41, 114, 244)">3.</span> 对每个任务，使用 \`fileDownloadUrl\` 加上服务根地址下载原件。

<span style="color:rgb(41, 114, 244)">4.</span> 调用目标平台完成上传。

<span style="color:rgb(41, 114, 244)">5.</span> 上传成功回传 \`uploaded\`；可恢复错误回传 \`retryable\`；不可恢复错误回传 \`failed\`。

<span style="color:rgb(41, 114, 244)">6.</span> 收到 \`idempotent: true\` 时，将其视为已完成，不需要重复上传。

**## 9. TypeScript 类型参考**

\`\`\`ts

export type WorkerJobState = <span style="color:rgb(222, 60, 54)">'pending'</span> | <span style="color:rgb(222, 60, 54)">'processing'</span> | <span style="color:rgb(222, 60, 54)">'uploaded'</span> | <span style="color:rgb(222, 60, 54)">'failed'</span>

export type WorkerResultState = <span style="color:rgb(222, 60, 54)">'uploaded'</span> | <span style="color:rgb(222, 60, 54)">'failed'</span> | <span style="color:rgb(222, 60, 54)">'retryable'</span>

export interface ClaimRequest {

maxJobs?: number

}

export interface InvoiceJobPayload {

identity?: string

invoiceNumber?: string

orderId?: string

shopId?: string

shopName?: string

amount?: string | number

fileName?: string

}

export interface InvoiceWorkerJob {

job_id: string

invoice_id: string

account_id: string

idempotency_key: string

state: WorkerJobState

lease_expires_at: string | null

attempts: number

last_error: string | null

payload_json: string

created_at: string

started_at: string | null

finished_at: string | null

updated_at: string

payload: InvoiceJobPayload

fileDownloadUrl: string

}

export interface ClaimResponse {

jobs: InvoiceWorkerJob[]

}

export interface ResultRequest {

state: WorkerResultState

message?: string

}

export interface ResultResponse extends Partial<InvoiceWorkerJob> {

idempotent: boolean

}

export interface ErrorResponse {

error: string

}

\`\`\`

<span style="color:rgb(41, 114, 244)">"idempotent"</span>: false

}

\`\`\`

对已经是 \`uploaded\` 的任务重复回传时，服务端不重复执行状态更新，返回 \`idempotent: true\`：

\`\`\`json

{

<span style="color:rgb(41, 114, 244)">"job_id"</span>: <span style="color:rgb(222, 60, 54)">"job-abc123"</span>,

<span style="color:rgb(41, 114, 244)">"state"</span>: <span style="color:rgb(222, 60, 54)">"uploaded"</span>,

<span style="color:rgb(41, 114, 244)">"idempotent"</span>: true

}

\`\`\`

实际响应会包含该任务数据库记录的其他字段，客户端应重点读取 \`state\` 和 \`idempotent\`。

**### 调用示例**

成功：

\`\`\`bash

curl <span style="color:rgb(222, 60, 54)">-X</span> <span style="color:rgb(222, 60, 54)">POST</span> <span style="color:rgb(222, 60, 54)">'<https://erp.xiangduoer.com/api/invoice/worker/jobs/job-abc123/result>'</span> \

-H 'X-Invoice-Account-Id: account-001' \

<span style="color:rgb(222, 60, 54)">-H</span> <span style="color:rgb(222, 60, 54)">'X-Invoice-Worker-Token: your-worker-token'</span> \

-H 'Content-Type: application/json' \

<span style="color:rgb(222, 60, 54)">-d</span> <span style="color:rgb(222, 60, 54)">'{"state":"uploaded","message":"抖店上传成功"}'</span>

\`\`\`

可重试失败：

\`\`\`bash

curl <span style="color:rgb(222, 60, 54)">-X</span> <span style="color:rgb(222, 60, 54)">POST</span> <span style="color:rgb(222, 60, 54)">'<https://erp.xiangduoer.com/api/invoice/worker/jobs/job-abc123/result>'</span> \

-H 'X-Invoice-Account-Id: account-001' \

<span style="color:rgb(222, 60, 54)">-H</span> <span style="color:rgb(222, 60, 54)">'X-Invoice-Worker-Token: your-worker-token'</span> \

-H 'Content-Type: application/json' \

<span style="color:rgb(222, 60, 54)">-d</span> <span style="color:rgb(222, 60, 54)">'{"state":"retryable","message":"抖店页面暂时不可用"}'</span>

\`\`\`

**## 6. 错误响应**

JSON 接口和文件下载接口出错时，响应通常为：

\`\`\`json

{

<span style="color:rgb(41, 114, 244)">"error"</span>: <span style="color:rgb(222, 60, 54)">"错误说明"</span>

}

\`\`\`

常见错误：

| HTTP 状态码 | \`error\` 示例 | 触发条件 |

| --- | --- | --- |

| \`400\` | \`回传结果状态无效\` | \`state\` 不在允许枚举中，或请求 JSON/参数无效 |

| \`401\` | \`代理 Token 无效或已停用\` | 账号、Token 不匹配或代理已被替换/停用 |

| \`403\` | \`请求来源不被允许，请从工作台页面访问接口\` | 请求携带了不被允许的 \`Origin\` |

| \`404\` | \`回传任务不存在\` | \`jobId\` 不存在或不属于当前账号 |

| \`404\` | \`原件读取失败\` | 任务对应的原件不存在或无法读取 |

| \`400\` | \`原件路径无效\` | 数据库里的原件路径不在服务端 archive 目录内 |

**## 7. 管理员注册和查看状态**

以下接口用于工作台管理员配置 Mac Agent，不由外部 Worker 轮询调用。它们使用工作台登录会话，而不是 Worker Token。

**### \`POST /api/invoice/worker/register\`**

请求体：

\`\`\`json

{

<span style="color:rgb(41, 114, 244)">"token"</span>: <span style="color:rgb(222, 60, 54)">"your-worker-token-at-least-24-chars"</span>,

<span style="color:rgb(41, 114, 244)">"displayName"</span>: <span style="color:rgb(222, 60, 54)">"Mac 发票回传代理"</span>

}

\`\`\`

成功响应：

\`\`\`json

{

<span style="color:rgb(41, 114, 244)">"accountId"</span>: <span style="color:rgb(222, 60, 54)">"account-001"</span>,

<span style="color:rgb(41, 114, 244)">"displayName"</span>: <span style="color:rgb(222, 60, 54)">"Mac 发票回传代理"</span>,

<span style="color:rgb(41, 114, 244)">"updatedAt"</span>: <span style="color:rgb(222, 60, 54)">"2026-10-13T09:00:00.000Z"</span>

}

\`\`\`

\`token\` 少于 24 个字符时返回 \`400\`。\`displayName\` 最多保存 100 个字符。

**### \`GET /api/invoice/worker/status\`**

成功响应示例：

\`\`\`json

{

<span style="color:rgb(41, 114, 244)">"registered"</span>: true,

<span style="color:rgb(41, 114, 244)">"displayName"</span>: <span style="color:rgb(222, 60, 54)">"Mac 发票回传代理"</span>,

<span style="color:rgb(41, 114, 244)">"enabled"</span>: true,

<span style="color:rgb(41, 114, 244)">"lastSeenAt"</span>: <span style="color:rgb(222, 60, 54)">"2026-10-13T09:55:00.000Z"</span>,

<span style="color:rgb(41, 114, 244)">"createdAt"</span>: <span style="color:rgb(222, 60, 54)">"2026-10-13T09:00:00.000Z"</span>,

<span style="color:rgb(41, 114, 244)">"updatedAt"</span>: <span style="color:rgb(222, 60, 54)">"2026-10-13T09:55:00.000Z"</span>

}

\`\`\`

未注册时返回：

\`\`\`json

{

<span style="color:rgb(41, 114, 244)">"registered"</span>: false

}

\`\`\`

**## 8. 推荐调用流程**

<span style="color:rgb(41, 114, 244)">1.</span> 管理员在工作台注册 Worker Token，并把账号 ID 和 Token 安全地配置到外部 Worker。

<span style="color:rgb(41, 114, 244)">2.</span> Worker 定期调用 \`POST /api/invoice/worker/jobs/claim\`。

<span style="color:rgb(41, 114, 244)">3.</span> 对每个任务，使用 \`fileDownloadUrl\` 加上服务根地址下载原件。

<span style="color:rgb(41, 114, 244)">4.</span> 调用目标平台完成上传。

<span style="color:rgb(41, 114, 244)">5.</span> 上传成功回传 \`uploaded\`；可恢复错误回传 \`retryable\`；不可恢复错误回传 \`failed\`。

<span style="color:rgb(41, 114, 244)">6.</span> 收到 \`idempotent: true\` 时，将其视为已完成，不需要重复上传。

**## 9. TypeScript 类型参考**

\`\`\`ts

export type WorkerJobState = <span style="color:rgb(222, 60, 54)">'pending'</span> | <span style="color:rgb(222, 60, 54)">'processing'</span> | <span style="color:rgb(222, 60, 54)">'uploaded'</span> | <span style="color:rgb(222, 60, 54)">'failed'</span>

export type WorkerResultState = <span style="color:rgb(222, 60, 54)">'uploaded'</span> | <span style="color:rgb(222, 60, 54)">'failed'</span> | <span style="color:rgb(222, 60, 54)">'retryable'</span>

export interface ClaimRequest {

maxJobs?: number

}

export interface InvoiceJobPayload {

identity?: string

invoiceNumber?: string

orderId?: string

shopId?: string

shopName?: string

amount?: string | number

fileName?: string

}

export interface InvoiceWorkerJob {

job_id: string

invoice_id: string

account_id: string

idempotency_key: string

state: WorkerJobState

lease_expires_at: string | null

attempts: number

last_error: string | null

payload_json: string

created_at: string

started_at: string | null

finished_at: string | null

updated_at: string

payload: InvoiceJobPayload

fileDownloadUrl: string

}

export interface ClaimResponse {

jobs: InvoiceWorkerJob[]

}

export interface ResultRequest {

state: WorkerResultState

message?: string

}

export interface ResultResponse extends Partial<InvoiceWorkerJob> {

idempotent: boolean

}

export interface ErrorResponse {

error: string

}

\`\`\`
