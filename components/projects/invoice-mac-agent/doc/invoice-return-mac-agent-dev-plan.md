# 抖店消费者开票 Mac 回传代理 —— 本机开发方案

> 本文保留早期设计，常驻进程、maxJobs=1、重试与恢复设想均不是当前部署状态。2026-10-17已上线每分钟启动、maxJobs=3小批连续领取、maxJobsPerRun=20整轮上限、同轮店铺缓存和跨进程5～30分钟退避；当前实现、配置及已知边界统一见 [README](../README.md)，验证历史见 [开发验证记录](2026-10-16_V2-Mac开发验证记录.md)。

> 依据《发票回传自动匹配技术设计》（`invoice-return-technical-design.md`）第 12 节「抖店消费者开票接口调查与 Mac 自动化方案」编写。  
> 本文只做开发方案设计，不包含代码实现。范围限定在本台 Mac 上的「单台回传代理」。  
> 与云端工作台相关的能力（第 10 节 SQLite、第 11 节 API）在本文只作为既有依赖列出，不在本方案内重复设计。
>
> ⚠️ **浏览器层已改为复用本机已运行的「店铺工作台」（Electron，49 家抖店登录态）**。抓取机制调研与复用映射见同目录 `invoice-return-shopdesk-reuse.md`；本文第 3.1 节已同步更新，第 5.5 节的 ego-browser 伪代码仅作业务时序参考。

---

## 0. 目标与边界

### 0.1 本方案要实现什么

在本台 Mac 上运行一个常驻的 Node.js 回传代理，完整走通第 12.5 节定义的链路：

```text
云端工作台
  ↑ HTTPS：领取任务 / 下载 PDF / 回传结果
Mac Agent（常驻 Node.js 进程）
  └─ 已登录抖店后台的浏览器会话：筛选订单、核对字段、上传 PDF、读取 upload_pdf 响应
```

单条任务的执行闭环（最终交付态 = 全自动提交）：

```text
claim 领取任务（返回店铺信息 + 订单信息 shop_order_id + 发票下载地址）
→ 下载 PDF 并校验 SHA256
→ 在抖店「待开票」列表按 shop_order_id 查询 → 记录 shop_order_id 与 payload.orderId 精确相等 = 关联成功，不等/查不到 = 关联失败
→ 核对金额/店铺/状态（抬头/税号由云端匹配保证）
→ 打开上传详情 → 设置文件触发 upload_pdf → 捕获响应拿 data.key
→ 自动调 /order/invoice/save 提交 → 刷新列表验证 → 回传 uploaded
```

### 0.2 边界（按最新需求校准）

1. **最终交付态 = 全自动提交（调用 `/order/invoice/save`）**；开发/验证阶段用 `submitMode` 三档开关控制，不真实提交：`dry-run`（只查/核对，不传不提交）→ `upload-only`（真传拿 key，不提交）→ `auto`（全自动，最终态）。
2. **关联以抖店实时查询为准**：claim 返回店铺信息 + 订单信息（`shop_order_id`），用它在抖店「待开票」列表查记录，查到才关联，查不到回传关联失败、不上传。
3. **不保存、不复用、不跨机复制**抖店动态值（`Cookie`、`Authorization`、`session_id`、`verifyFp`、`fp`、`msToken`、`a_bogus`、`x-secsdk-csrf-token`、签名 URL）。这些值只存在于浏览器会话内存中，由页面 JS 在真实请求时现场生成。
4. **不把动态值写进配置、日志、数据库**。日志只允许出现脱敏后的 `code`/`msg`、`shop_order_id`、`jobId`、请求序号。
5. **不做云端 SQLite 与 API 的开发**（第 10、11 节），只依赖其接口契约。

### 0.3 结果语义（避免混淆）

| 状态                     | 含义                                               | 由谁推进      |
| ---------------------- | ------------------------------------------------ | --------- |
| `matched + pending`    | 云端已解析、已唯一匹配、等待回传                                 | 云端        |
| `processing`           | 已被 Mac 领取，租约有效                                   | Mac claim |
| `uploaded`             | 关联成功 + 上传拿到 `data.key` + `save` 提交成功（云端最终成功态）    | Mac 回传    |
| `failed` / `retryable` | 回传失败 / 可重试（云端无 `submitted` 状态，提交成功即回 `uploaded`） | Mac 回传    |

---

## 1. 本机环境核对

| 项         | 现状                                                               | 说明                                                                                                                                      |
| --------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 操作系统      | macOS（arm64）                                                     | 本机为 Apple Silicon                                                                                                                       |
| Node.js   | v24.20.0                                                         | 满足文档要求 `>=22.13.0`，自带 `fetch`、`node:sqlite` 等内置能力                                                                                       |
| 工作台仓库     | `/Users/zhaoxiaozhong/replenishment-workbench`                   | Node ESM，`"type": "module"`                                                                                                             |
| 浏览器自动化（主） | 「店铺工作台」Electron App（`/Applications/店铺工作台.app`）                   | 已运行，维护 49 家抖店登录态（`Partitions/shop-*/Cookies`），提供本地 HTTP 接口（`agent-bridge.json`）与页面 fetch/上传/网络捕获能力，见 `invoice-return-shopdesk-reuse.md` |
| 浏览器自动化（备） | `ego-browser` 已安装于 `/Users/zhaoxiaozhong/.local/bin/ego-browser` | ego-lite（Chromium），作为店铺工作台不可用时的兜底                                                                                                       |
| 抖店后台登录态   | 通过 ego-lite 浏览器人工登录并保持                                           | 浏览器自身维护，Agent 不读取、不导出                                                                                                                   |

---

## 2. 总体架构

```text
┌──────────────────────────── 云端工作台（既有，第 10/11 节） ────────────────────────────┐
│  /api/invoice/worker/jobs/claim      领取任务（Token 鉴权 + 租约）                      │
│  /api/invoice/worker/jobs/:id/result 回传结果（uploaded / failed / retryable）          │
│  fileDownloadUrl（短期签名 URL）      下载 PDF 原件                                     │
└──────────────────────────────────────────────────────────────────────────────────────────┘
                                   ▲  HTTPS（出站，无公网入站）
                                   │
┌────────────────────────────── Mac Agent（本方案） ──────────────────────────────────────┐
│                                                                                          │
│  cloud-client.mjs     云端轮询循环、鉴权、租约、结果回传（纯 Node fetch）                 │
│  job-runner.mjs       任务编排：下载 → 校验 → 浏览器上传 → 回传（串行队列）              │
│  pdf-stage.mjs        PDF 下载、落盘、SHA256/大小校验                                    │
│  browser-driver.mjs   浏览器自动化抽象（接口 + 适配器）                                  │
│  redact.mjs           日志脱敏与审计字段拼接                                             │
│  config.mjs           配置与密钥加载（0600 权限，env 可覆盖）                            │
│  agent.mjs            入口：launchd 守护、信号处理、5s 轮询                              │
│                                                                                          │
│  ┌── browser-driver 实现 ──────────────────────────────────────────────┐                 │
│  │  ShopdeskInvoiceDriver（推荐） 经 agent-bridge 复用店铺工作台登录态/上传/捕获 │  │
│  │  ego-browser / Playwright（兜底）                                           │  │
│  └──────────────────────────────────────────────────────────────────────┘                 │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

要点：

- **单进程、串行执行**。一台 Mac 只有一个浏览器会话，避免两个任务同时操作同一个页面互相干扰。`claim` 使用 `maxJobs=1`。
- **浏览器与云端循环解耦**。浏览器驱动做成可替换适配器，云端轮询逻辑不关心浏览器实现。
- **出站连接**。Mac 只主动 HTTPS 访问云端，不开放任何入站端口。

---

## 3. 关键选型

### 3.1 浏览器驱动引擎

| 方案                                                     | 优点                                                                                                        | 缺点                                   | 结论     |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------ |
| **复用「店铺工作台」Electron（`src/invoice.js` + agent-bridge）** | 已维护 49 家抖店登录态；页面上下文 `fetch` 已验证可绕过风控；已有文件上传（`DOM.setFileInputFiles`）与网络捕获（`NET_HOOK`）；无需另开浏览器、无需复制 Cookie | 需在店铺工作台 App 内新增模块并重启 App             | **推荐** |
| ego-browser CLI（子进程）                                   | 已安装，可驱动已登录站点                                                                                              | 登录态与店铺工作台割裂（需另登录）；每次调用是独立进程；非进程内 API | 兜底     |
| Playwright + persistent profile                        | 进程内确定性控制                                                                                                  | 需下载浏览器 + 另建/另登录 profile，登录态割裂        | 不采用    |

推荐理由：文档第 12.5 节要求「同一台 Mac 上的已登录浏览器会话」，而本机**已经有一套为此而生的系统**——店铺工作台用 `session.fromPartition('persist:shop-<id>')` 维护 49 家抖店登录态，并用「隐藏窗口 + `executeJavaScript` 注入页面 `fetch`」跑通了举报提交（README 明确：写接口直连会被风控拦，必须从页面发起）。开票的 `upload_pdf` / `save` 是同类写接口，直接复用同一套登录态与风控绕过即可，不要另起浏览器。详见 `invoice-return-shopdesk-reuse.md`。

> 设计上仍保留 `BrowserDriver` 接口层，店铺工作台不可用时再退回 ego-browser/Playwright，不改上层编排。

### 3.2 读取 `upload_pdf` 的 `data.key`（实测：无需网络捕获）

实测（2026-10-14）结论：在店铺工作台页面上下文直接 `fetch('/order/invoice/upload_pdf', {method:'POST', credentials:'include', body: FormData})` 即返回 `{ code:0, data:{ key, url } }`，**不需要** `x-secsdk-csrf-token`、`a_bogus`、`verifyFp` 等动态参数，也**不需要** CDP 网络捕获或页面插桩——响应体直接就是 `data.key`。

- 主路径：页面 fetch 直连拿 `data.key`（= `tos_key`），接口契约见 `invoice-return-doudian-api.md` §4。
- 兜底：若未来抖店加风控导致 fetch 被拦，退回「`DOM.setFileInputFiles` + 扩展 `NET_HOOK` 抓响应」的 UI 路径（见 `invoice-return-shopdesk-reuse.md` §3.2.2）。

### 3.3 进程模型

- **一个常驻 Node.js 进程**（`agent.mjs`），`setInterval` 5 秒轮询云端。
- 领取到的任务进入**本地串行队列**，一次只处理一个；处理期间暂停 claim（或 claim 到 1 个即停）。
- 浏览器步骤通过**本地 HTTP 调店铺工作台**（agent-bridge `127.0.0.1:<port>/call` + Bearer token）完成：定位/核对/上传/读 `data.key` 都由店铺工作台 `invoice.js` 在页面上下文执行，Agent 只收发结构化结果。

### 3.4 密钥与配置

| 项                       | 存放位置           | 权限    | 说明                                                             |
| ----------------------- | -------------- | ----- | -------------------------------------------------------------- |
| 云端工作台地址 `WORKBENCH_URL` | 配置文件           | 0600  | 例：`https://workbench.example.com`                              |
| Mac Agent Token（明文）     | 配置文件           | 0600  | 与云端 `POST /api/invoice/worker/register` 注册时的 `token` 一致；≥24 字符 |
| 账号 ID `account_id`      | 配置文件           | 0600  | 管理员页面显示的账号 ID                                                  |
| 抖店登录态                   | 浏览器 profile 内部 | 浏览器自管 | Agent 永不读取、不导出                                                 |
| 抖店动态值                   | 内存             | 不落盘   | 只存在于浏览器会话                                                      |

- 配置文件放在 `~/.config/invoice-mac-agent/config.json`（权限 `0600`），支持 `INVOICE_AGENT_*` 环境变量覆盖（优先级高于文件）。
- 密钥不进 Git、不进数据库、不进日志。日志与运行时状态放 `~/.local/share/invoice-mac-agent/`。

---

## 4. 目录与模块结构

```text
invoice-mac-agent/                     # 本方案新增，位于 /Users/zhaoxiaozhong/projects/invoice-mac-agent/
├── package.json                        # "type": "module"，仅 Node 内置依赖
├── agent.mjs                           # 入口：轮询循环、信号处理、队列调度
├── config.mjs                          # 配置/密钥加载与校验
├── cloud-client.mjs                    # claim / 下载 / 回传结果
├── job-runner.mjs                      # 单任务编排（下载→校验→浏览器→回传）
├── pdf-stage.mjs                       # PDF 落盘、SHA256、大小/格式校验
├── browser-driver.mjs                  # BrowserDriver 接口 + 工厂
├── shopdesk-invoice-driver.mjs         # 复用店铺工作台 agent-bridge 实现（推荐）
├── ego-browser-driver.mjs              # ego-browser 子进程实现（兜底，占位）
├── redact.mjs                          # 脱敏、日志、审计字段拼接
├── state.mjs                           # 本地队列/运行状态（内存 + 可选落盘）
├── fixtures/                           # 测试样例（JSON 响应、假 PDF）
│   ├── claim-response.json
│   ├── upload-pdf-response.json
│   └── sample.pdf
└── test/                               # node:test 用例
    ├── cloud-client.test.mjs
    ├── job-runner.test.mjs
    ├── redact.test.mjs
    └── browser-driver.test.mjs
```


运行时目录（git 忽略）：

```text
~/.config/invoice-mac-agent/config.json      # 密钥/配置，0600
~/.local/share/invoice-mac-agent/staging/    # 领取后下载的 PDF（按 jobId 分目录）
~/.local/share/invoice-mac-agent/logs/       # 运行日志（已脱敏）
~/.local/share/invoice-mac-agent/state.json  # 可选：本地任务状态恢复
~/Library/LaunchAgents/com.example.invoice-mac-agent.plist  # launchd 配置
```

---

## 5. 模块详细设计

### 5.1 `cloud-client.mjs` —— 云端轮询与回传

依赖 `invoice-worker-api.md` 接口契约（以当前代码为准）：

| 动作     | 方法/路径                                         | 请求                                                                       | 响应要点                                                                                                                                                                                            |
| ------ | --------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 领取任务   | `POST /api/invoice/worker/jobs/claim`         | `{ "maxJobs": 1 }`，鉴权头 `X-Invoice-Account-Id` + `X-Invoice-Worker-Token` | `{ jobs: [ { job_id, invoice_id, idempotency_key, state, lease_expires_at, attempts, payload{identity,invoiceNumber,orderId,shopId,shopName,amount,fileName}, fileDownloadUrl(相对路径), ... } ] }` |
| 下载 PDF | `GET {baseUrl}{fileDownloadUrl}`              | 同上鉴权头                                                                    | PDF 二进制（`Content-Type: application/pdf`，无 `Content-Disposition`）                                                                                                                                |
| 回传结果   | `POST /api/invoice/worker/jobs/:jobId/result` | `{ state, message }`，`state ∈ {uploaded, failed, retryable}`             | 任务记录 + `idempotent: true/false`                                                                                                                                                                 |

关键约束（对齐 `invoice-worker-api.md`）：

- 鉴权用两个请求头 `X-Invoice-Account-Id`（账号 ID）+ `X-Invoice-Worker-Token`（Token），**不是** `Authorization`；建议不发送 `Origin` 头（发送了会做来源校验）。
- `payload.orderId` = 抖店「代开票列表」的「订单信息」列订单号，即 `/order/invoice/list` 的 `shop_order_id` 字段；抖店列表查到的记录 `shop_order_id` 必须与 `payload.orderId` **精确相等**才算匹配上，不等/查不到即关联失败。`payload.shopId` = 店铺工作台 `shops.json` 的 `id`（uuid），直接 `session.fromPartition('persist:shop-'+shopId)` 选登录态；`payload.amount` 用于金额核对；`invoiceNumber`/`fileName` 用于审计。注意 `payload` 不含抬头/税号。
- `fileDownloadUrl` 是**相对路径**，需拼服务根地址（如 `https://erp.xiangduoer.com` + 相对路径）；以 `payload.fileName` 为准保存文件名。
- `lease_expires_at` 固定 **10 分钟**：Agent 计算 `softDeadline = lease_expires_at - 60s`，超过即回传 `retryable`，避免「本地完成但云端租约已过期」。
- 幂等：重复回传 `uploaded` 返回 `idempotent: true`，Agent 视为已完成，不重试、不重放。
- 回传 `state` 只有 `uploaded`/`failed`/`retryable`；**云端无 `submitted`**——关联 + 上传 + `save` 全成功才回 `uploaded`。
- 401/403 停轮询转人工；网络/5xx 按指数退避重试。

### 5.2 `job-runner.mjs` —— 单任务编排

```text
runJob(job)
  1. 校验 job 字段完整、租约未过期
  2. pdfStage.download(job)         // 下载并校验 SHA256、大小、PDF 魔数
  3. browserDriver.execute({        // 一次浏览器脚本内完成以下全部步骤
       shopOrderId, pdfPath,
       expect: { shopName, amount }   // claim payload 只带店铺名+金额；抬头/税号已在云端匹配阶段使用
     })
     → 返回 { ok, uploadKey, shopSnapshot, errorCode, errorMsg, screenshot? }
  4. 脱敏后写入日志与审计字段
  5. cloudClient.report({ jobId, state, message })   // 云端不读 finishedAt，可不发
```

- 每一步失败都有独立错误分类（见第 7 节），决定 `retryable` / `failed`。
- 执行期间把 `shopSnapshot`（从抖店「待开票」列表读到的行快照：`shop_order_id`、`title`、`tax_no`、`invoice_amount`、`invoice_status`）随结果回传，供云端写入 `invoice_match_candidates` 留证；`title`/`tax_no` 是抖店侧读到的值、非 claim 下发，不用于 Mac 侧强制核对。
- 全程只处理一个任务；任务结束后再进入下一轮 claim。

### 5.3 `pdf-stage.mjs` —— 下载与校验

- 按 `jobId` 建目录：`~/.local/share/invoice-mac-agent/staging/<jobId>/original.pdf`。
- 下载后校验：
  1. 字节大小与预期（如有）一致；
  2. `%PDF-` 魔数开头；
  3. `SHA256(file)` 与任务信息比对（云端 claim 响应建议带 `fileSha256`，如未带则至少记录哈希用于审计）。
- 校验失败回传 `retryable`（可重新领取下载）或 `failed`（文件本身异常），不进入浏览器步骤。
- 任务完成后清理 staging 目录（保留日志中的哈希与路径记录即可）。

### 5.4 `browser-driver.mjs` —— 浏览器自动化抽象

```ts
interface UploadOutcome {
  ok: boolean
  uploadKey: string | null          // upload_pdf 响应的 data.key
  shopSnapshot: {                   // 列表行快照
    shopOrderId: string
    title: string
    taxNo: string
    amount: string
    statusText: string
  } | null
  matchCheck: {                     // 核对结果
    titleOk: boolean
    taxNoOk: boolean
    amountOk: boolean
    statusOk: boolean
  }
  errorCode: string | null          // 脱敏后的业务 code
  errorMsg: string | null           // 脱敏后的 msg
}

interface BrowserDriver {
  openInvoiceList(): Promise<void>
  locateOrder(shopOrderId: string): Promise<shopSnapshot>
  verifyRecord(expect, snapshot): Promise<matchCheck>
  openUploadDetail(shopOrderId: string): Promise<void>
  uploadPdf(pdfPath: string, shopOrderId: string): Promise<{ key: string }>
  captureNetwork(): Promise<void>   // 开启 Network.enable + 插桩
  readUploadResponse(): Promise<{ key: string }>
  screenshot(label: string): Promise<string>
}
```

适配器工厂 `createBrowserDriver(config)` 根据配置返回 `ShopdeskInvoiceDriver`（复用店铺工作台）或 `EgoBrowserDriver`（兜底）。

### 5.5 `shopdesk-invoice-driver.mjs` —— 复用店铺工作台实现

浏览器操作全部下沉到店铺工作台（Electron）的 `invoice.js` 模块，Mac 代理经 agent-bridge 调用，不再自己驱动浏览器。实测四个接口（list/detail/upload_pdf/save）均可页面 fetch 直连，具体注入脚本与接口契约见 `invoice-return-shopdesk-reuse.md` 与 `invoice-return-doudian-api.md`。

#### 5.5.3 单任务浏览器时序（业务概念示意，浏览器操作由店铺工作台承接）

```js
// 概念性伪代码，非实现
const task = await taskSpace(SPACE_ID);
const page = task.page("p1");

await page.goto(INVOICE_LIST_URL);

// 1) 开启网络捕获（CDP Network + 页面插桩双保险）
await page.cdp("Network.enable", { maxTotalBufferSize: 100 * 1024 * 1024 });
await page.evaluate(() => {
  window.__captured = [];
  const hook = (kind) => (res) => {
    if (String(res.url ?? res.responseURL ?? "").includes("/order/invoice/upload_pdf")) {
      window.__captured.push({ kind, url: res.url, status: res.status });
    }
  };
  // 包装 fetch / XHR，只记录，不改变行为
});

// 2) 筛选：状态=待开票 + shop_order_id 搜索，定位唯一行
await page.selectOption(STATUS_FILTER, "wait_blue");
await page.fill(ORDER_ID_INPUT, shopOrderId);
await page.waitForSelector(LIST_ROW);

// 3) 读列表行快照并核对（title / tax_no / amount / status）
const snapshot = await readRow(page, shopOrderId);
const check = verifyRecord(expected, snapshot);
if (!check.allOk) return { ok: false, reason: "mismatch", snapshot, check };

// 4) 打开上传详情并设置文件（真实触发 upload_pdf）
const chooserPromise = page.waitForFileChooser({ timeout: 15_000 });
await page.click(UPLOAD_BUTTON);
const chooser = await chooserPromise;
const result = await chooser.setFiles(pdfPath);

// 5) 等待 upload_pdf 完成，读取响应体拿到 data.key
await page.waitForFunction(() => window.__captured.length > 0, undefined, { timeout: 30_000 });
// 备选/首选：从 page.events() 找 Network.responseReceived(…/upload_pdf) → getResponseBody
const key = await readUploadKey(page);

return { ok: true, uploadKey: key, snapshot, check };
```

实测后 `data.key` 直接从 `fetch` 响应体拿（`data.key`），无需网络捕获；网络捕获仅作为未来风控升级时的兑底方案。

#### 5.5.4 核对规则（关联 + 字段核对）

- **关联前提（硬门槛）**：`payload.orderId` 与抖店 `shop_order_id` 是同一个值，查到的记录 `shop_order_id` 必须与 `payload.orderId` **精确相等**，相等才算匹配上；不等/查不到 → 关联失败，回传 `failed`。定位键只用 `shop_order_id`，不用金额/抬头做模糊匹配。
- `amount`：价税合计，容差 0.01 元（与 `payload.amount` 比较）。
- `shop`：店铺归属与 `payload.shopId`/`shopName` 一致。
- `status`：必须为「待开票」。
- 任一不满足 → `ok:false`，回传 `failed`（业务不匹配，重试无意义），并回传 `shopSnapshot` 供云端人工处理。

### 5.6 `redact.mjs` —— 脱敏与审计

- 日志/回传消息中，只允许出现：`jobId`、`idempotencyKey`、`shop_order_id`、`invoiceNumber`、脱敏 `code`/`msg`、请求序号。
- 明确禁止写入：`Cookie`、`Authorization`、`x-secsdk-csrf-token`、`verifyFp`、`fp`、`msToken`、`a_bogus`、签名 URL 完整串、`data.url` 的完整签名查询串。
- `data.url` 只允许截取 `https://{{host}}/{{key}}`（去掉 query）用于预览校验，禁止落盘完整签名串。
- 提供一个 `redactUrl()` 统一入口，所有写日志/回传的字段都经它过滤，做「默认拒绝、显式白名单」。

---

## 6. 任务状态机（Mac 侧）

```text
                 claim(1) / 5s 轮询
                         │
                         ▼
              ┌─── pending(本地队列) ───┐
              │         │               │
              │  下载+校验失败           │ 租约将过期
              │         ▼               ▼
              │   retryable ──────► 回传 retryable
              │         │
              │         │ 下载+校验成功
              │         ▼
              │   browser: 定位/核对失败(业务不匹配)
              │         └──────────► 回传 failed
              │
              │   browser: 上传 + save 提交成功，列表验证通过
              │         └──────────► 回传 uploaded（最终态）
              │
              │   browser: 上传失败(可重试)
              │         └──────────► 回传 retryable
              │
              │   browser: 上传失败(不可重试/风控/登录失效)
              │         └──────────► 回传 failed + handOff 人工
              └──────────────────────────────► 处理完进入下一轮 claim
```

- `uploaded` 是本期终点；后续 `save` 提交由独立流程（第 12 节）触发，不在本状态机内。
- 本地可选把「已领取未完成」任务写入 `state.json`，进程重启后先回传 `retryable`（放弃未完成任务，交给云端重新调度），避免留下「本地以为在处理、云端已过期」的僵尸任务。

---

## 7. 错误分类与重试

| 场景                             | 分类          | 处理                                      |
| ------------------------------ | ----------- | --------------------------------------- |
| claim 网络超时 / 5xx               | 临时          | 指数退避后继续轮询                               |
| claim 401/403（Token 失效）        | 致命          | 停止轮询，记录告警，人工介入                          |
| 下载 URL 过期 / 下载失败               | 可重试         | 回传 `retryable`，等云端重新发放                  |
| PDF 非 `%PDF-` 或大小异常            | 失败          | 回传 `failed`，人工处理原件                      |
| 列表定位到 0 条或多条                   | 失败          | 回传 `failed`，附截图与搜索条件                    |
| 列表行核对不匹配（金额/店铺/状态）             | 失败          | 回传 `failed` + `shopSnapshot`，进入云端人工     |
| `upload_pdf` 业务失败（`code != 0`） | 视 `code` 而定 | 可重试的码回 `retryable`；风控/权限类回 `failed` 并人工 |
| 拿到 `data.key` 但回传结果失败          | 可重试         | 本地保留 `key` 与证据，回传重试（云端幂等）               |
| 登录失效 / 风控页 / 验证码               | 致命          | `handOff()` 交人工，回传 `failed`，不自动绕过       |

重试上限：单一任务在 Mac 侧不本地无限重试，回传 `retryable` 后由云端 `upload_attempts` 计数封顶；Mac 只负责单次执行与如实上报。

---

## 8. launchd 部署

以用户级 `LaunchAgent` 运行，进程崩溃、断网后自动拉起：

```xml

<plist version="1.0">
  <dict>
    <key>Label</key><string>com.example.invoice-mac-agent</string>
    <key>ProgramArguments</key>
    <array>
      <string>/Users/zhaoxiaozhong/.local/node-v24.20.0-darwin-arm64/bin/node</string>
      <string>/Users/zhaoxiaozhong/projects/invoice-mac-agent/agent.mjs</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/zhaoxiaozhong/projects/invoice-mac-agent</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key>
    <dict><key>SuccessfulExit</key><false/></dict>
    <key>StandardOutPath</key>
    <string>/Users/zhaoxiaozhong/.local/share/invoice-mac-agent/logs/agent.out.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/zhaoxiaozhong/.local/share/invoice-mac-agent/logs/agent.err.log</string>
    <key>ProcessType</key><string>Interactive</string>
  </dict>
</plist>
```


加载与启停：

```bash
launchctl load   ~/Library/LaunchAgents/com.example.invoice-mac-agent.plist
launchctl unload ~/Library/LaunchAgents/com.example.invoice-mac-agent.plist
launchctl kickstart -k gui/$(id -u)/com.example.invoice-mac-agent   # 手动重启
```

注意：`ProcessType=Interactive` 保证 Agent 有权唤起 ego-lite 浏览器并操作其登录会话；抖店会话需保持登录，故该 Mac 需处于可解锁/已登录状态。

## 10. 实施顺序与里程碑

| 阶段       | 内容                                                               | 交付物                     | 是否可独立验收 |
| -------- | ---------------------------------------------------------------- | ----------------------- | ------- |
| M1 基线走查  | 人工走查抖店页面，固化 URL 与选择器基线                                           | `browser-baseline.json` | 是       |
| M2 云端骨架  | `config` + `cloud-client` + `agent` 轮询循环（可空跑）                    | 能 claim/下载/回传假结果        | 是       |
| M3 浏览器驱动 | 店铺工作台 `invoice.js` + agent-bridge `invoice_*` 方法（定位/核对/上传/读 key） | 沙箱页集成测试通过               | 是       |
| M4 编排    | `job-runner` 串联下载→校验→浏览器→回传，错误分类                                 | 单测 + 假 driver 通过        | 是       |
| M5 干跑    | 真实抖店 1 单端到端（`dry-run→upload-only→auto` 三档逐级）                     | 干跑记录 + 截图 + 无动态值日志      | 是       |
| M6 部署    | launchd 常驻、断网重连、租约过期回归                                           | 7×24 观察报告               | 是       |
| M7 自动提交  | 全自动 `save` 提交 + 列表刷新验证（最终态，回传 `uploaded`）                        | 见第 12 节                 | 是       |

## 12. 全自动提交（save）阶段（最终态）

最终交付态在 `auto` 模式下自动调用 `/order/invoice/save`，须同时满足以下条件（否则转人工）：

1. 关联成功：抖店「待开票」列表按 `shop_order_id` 查到唯一记录；
2. 字段核对通过：金额/店铺/状态=待开票（抬头/税号由云端匹配保证）；
3. `upload_pdf` 已返回 `data.key`（`tos_key`）；
4. 云端匹配唯一（非 ambiguous）；
5. 记录仍为「待开票」且未被其他任务领取。

提交请求体形状（第 12.4 节）：

```json
{
  "shop_order_id": "{{ORDER_ID}}",
  "blue_invoice_key": "{{BLUE_INVOICE_KEY}}",
  "invoice_status_type": 1,
  "invoice_file_list": [
    { "tos_key": "{{FILE_KEY}}", "file_name": "{{FILE_NAME}}" }
  ]
}
```

提交成功后刷新 `/order/invoice/list` 验证状态，全通过则回传 `uploaded`（云端最终成功态，无 `submitted`）。`save` 失败时：先查列表幂等判断——已提交则回 `uploaded`，否则回 `retryable`，并把错误原因写入 `message` 同步云端。开发/验证阶段用 `submitMode` 三档开关：`dry-run`（不传不提交）→ `upload-only`（传不提交）→ `auto`（全自动）。

---

## 附：本文依赖的云端接口契约清单（以 `invoice-worker-api.md` 为准，供实现时对齐）

鉴权：所有 Worker 接口带 `X-Invoice-Account-Id` + `X-Invoice-Worker-Token` 两个请求头，建议不发送 `Origin`。

| 接口                                            | 用途                                | 关键字段                                                                                                                                                                                        |
| --------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/invoice/worker/register`           | 注册/替换 Mac Token（管理员用，非 Worker 鉴权） | `token`(≥24)、`displayName`(≤100)                                                                                                                                                            |
| `GET /api/invoice/worker/status`              | 查看 Agent 注册/最近轮询（管理员用）            | `registered/enabled/lastSeenAt/...`                                                                                                                                                         |
| `POST /api/invoice/worker/jobs/claim`         | 领取任务                              | `maxJobs`(1–20，默认 5)；返回 `jobs[]`，元素含 `job_id`、`idempotency_key`、`lease_expires_at`(10min)、`payload{identity,invoiceNumber,orderId,shopId,shopName,amount,fileName}`、`fileDownloadUrl`(相对路径) |
| `GET /api/invoice/worker/jobs/:jobId/file`    | 下载 PDF 原件                         | 返回 PDF 二进制，以 `payload.fileName` 存文件名                                                                                                                                                        |
| `POST /api/invoice/worker/jobs/:jobId/result` | 回传结果                              | `state ∈ {uploaded, failed, retryable}`、`message`(≤500)；响应含 `idempotent`                                                                                                                    |

> 云端无 `submitted` 状态：Mac 侧「关联 + 上传 + `save` 提交」全成功才回 `uploaded`。  
> 本 Mac 代理可先用 mock 服务（`cloud-client` 已做可测性抽象）并行开发与联调。
