# 抖店消费者开票 —— 复用「店铺工作台」抓取能力方案

> 依据《发票回传自动匹配技术设计》第 12 节，以及本机已运行的「店铺工作台」（shopdesk，Electron，Dock 里 711 图标那套）。  
> 本文先说明店铺工作台现在是怎么抓抖店数据的，再给出「消费者开票」如何复用同一套能力。  
> 本文是开发方案，不是代码实现。

---

## 0. 结论速览

- 店铺工作台已经维护 **49 家抖店** 的登录态（每家一个独立 Chromium 分区 `Partitions/shop-<id>/Cookies`），并有本地 HTTP 接口（`agent-bridge.json` 里的 port + token）。
- 它抓抖店数据有三套已跑通的手段：
  1. **Python 采集器接口直连**（只读）：从分区读 Cookie，用 `requests` 直连抖店接口；
  2. **页面上下文 `fetch`**（写接口，绕过风控）：隐藏窗口加载抖店页面，`executeJavaScript` 注入脚本，在页面里 `fetch` 相对路径；
  3. **UI 驱动 + 网络捕获**：`DOM.setFileInputFiles` 设文件 + 补发事件，配合注入的 `NET_HOOK` 抓请求/响应。
- **消费者开票可以完全复用**：新增一个 `invoice.js` 模块，复用「登录态 + 页面 fetch + 文件上传 + 网络捕获」，通过 agent-bridge 暴露 `invoice_*` 方法，供 Mac 回传代理调用。
- 关键结论：**不要再另起 ego-browser / Playwright 独立浏览器**。登录态、风控绕过、上传、捕获，店铺工作台都已经有了。

---

## 1. 店铺工作台现状（调研结果）

### 1.1 是什么

- 名称：店铺工作台（shopdesk），macOS arm64 Electron 应用，基于官方「店铺工作台」二次开发，图标为 Dock 里的 711 风格图标。
- 位置：
  - 应用：`/Applications/店铺工作台.app`
  - 源码：`/Users/zhaoxiaozhong/shopdesk-workbench-src/`
  - 运行数据：`~/Library/Application Support/shopdesk/`
- 用途：抖店「品退/中差评」自动举报工作台（采集 → 飞鸽核查 → AI 判断 → 提交 → 回访），并顺带采集体验分、退款、评价明细等数据上云。

### 1.2 登录态与多店铺

- 每家店用 `session.fromPartition('persist:shop-<uuid>')` 创建**独立 Chromium 会话**，Cookie 落在 `Partitions/shop-<id>/Cookies`。
- 当前 `shops.json` 共 **49 家店**，全部 `platform: "抖店"`，`loginHealth.status = "authenticated"`。
- 店铺记录字段：`name`（如「香朵儿官方旗舰店」）、`id`（uuid）、`url`、`platform`、`loginHealth`、`lastScan` 等。**注意：没有落盘的抖店数字 shop_id**，需要时在页面上下文读 `window.SlardarConfigContext.shop_id`（`appeal.js` 里 `pageShopId()` 已有现成逻辑）。

### 1.3 抓取抖店数据的三层机制

#### 机制一：Python 采集器接口直连（只读数据）

- 代码：`collectors/builtin/`（`douyin.py` / `quality.py` / `refunds.py` / `experience.py`），由 App 的 `start_collector` 触发，`worker.py` 分发。
- `douyin.py` 的 `direct_credentials(cookies, agent, ...)`：
  - 从 App 用 `Network.getCookies` 拿 Cookie + `navigator.userAgent`；
  - Python `requests` 直连 `https://fxg.jinritemai.com/pc/api/home/homepage`（带 `Referer`、`trust_env=False`、`timeout=(5,20)`）；
  - 校验店铺身份（名称 / platform_id）后解析指标，写 `business-data/*.json` 或 `business.sqlite3`。
- 特点：**只读接口直连可行**，但要处理登录失效（`code==10008`）与安全验证（`VERIFICATION_REQUIRED`）。

#### 机制二：页面上下文 fetch（写接口，绕过风控）

- 代码：`src/appeal.js`（核心，约 1100 行）。
- README 明确：**举报「提交」接口必须从浏览器页面里发起，Node/curl 直接调会被平台风控拦**（"当前环境存在风险"）。
- 做法：
  ```js
  const ses = session.fromPartition('persist:shop-' + shopId);
  const w = new BrowserWindow({show:false, webPreferences:{...secure, session:ses}});
  await w.loadURL('https://fxg.jinritemai.com/ffa/govern-report/report-create');
  // 把自包含函数序列化后注入页面，在渲染进程上下文执行
  wc.executeJavaScript('(' + fn.toString() + ')(' + args.map(a=>JSON.stringify(a)).join(',') + ')', true);
  ```
  注入的函数里直接用相对路径 `fetch('/shopuser/accuse/apply', {method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body:...})`。
- 因为脚本跑在**渲染进程页面上下文**（真实浏览器环境 + 该分区的 Cookie + 页面自身生成的指纹），所以能绕过风控。
- 文件上传的例子（`pageUploadImage`）：
  ```js
  const fd = new FormData();
  fd.append('image_file', new File([arr], name, {type:'image/png'}));
  const r = await fetch('/common/index/uploadImg', {method:'POST', credentials:'include', body: fd});
  ```

#### 机制三：UI 驱动 + 网络捕获（设文件、抓响应）

- 设文件（`setFileInputs`）：CDP `DOM.setFileInputFiles` 设置 `<input type=file>` 的文件，再补发 `input/change/blur` 事件让页面 React 感知。
- 网络捕获（`installNetHook`）：`Page.addScriptToEvaluateOnNewDocument` 注入 `NET_HOOK_SRC`，在 `window.__net` 里记录 fetch/XHR 请求；对指定 URL（如飞鸽 `get_history_msg`）还会抓响应体到 `window.__hist`。
- 另有 `pageHookFetch`/`pageReadCap` 抓 POST 请求路径与 body。

### 1.4 本地接口（agent-bridge）

- `agent-api.js` 启动本地 HTTP 服务：`127.0.0.1:<port>/call`，鉴权 `Authorization: Bearer <token>`，端口/token 写在 `~/Library/Application Support/shopdesk/agent-bridge.json`（0600）。
- 请求体 `{"method":"...","args":{...}}`，串行队列分发。
- 现有 method（与本方案相关）：
  - `list_shops` → 列出店铺 `{id,name,platform,group,opened}`
  - `open_shop` / `open_shop_home` / `read_shop_page` / `get_login_status`
  - `flyge_probe(shop_id, url, expression)` → 隐藏窗口加载抖店页面 + 执行表达式（通用探针）
  - `auto_appeal_start` / `auto_appeal_status` / `appeal_sync_results`
  - `start_collector` / `get_collector_job` 等

### 1.5 定时任务

- launchd：`local.shopdesk.appeal`（每天 07:00 主流程）、`local.shopdesk.appeal-submit`（每 30 分钟拉云端确认并提交）、`local.shopdesk.autodeploy`（每 5 分钟拉代码）、`local.shopdesk.health`（9/13/17 查登录态）。
- 脚本在 `~/Library/Application Support/shopdesk/`（`daily-appeal.sh` / `submit-confirmed.sh` / `health-check.sh`）。

---

## 2. 与第 12 节「消费者开票」接口的映射

第 12 节观察到的接口基地址 `https://fxg.jinritemai.com`，相对路径如下：

| 开票能力   | 抖店接口                                        | 类型      | 复用手段（推荐）                                            |
| ------ | ------------------------------------------- | ------- | --------------------------------------------------- |
| 拉发票列表  | `GET /order/invoice/list`                   | 只读      | 页面 fetch 相对路径（机制二），失败退 UI 驱动/网络捕获（机制三）              |
| 拉状态数量  | `GET /order/invoice/get_counts`             | 只读      | 同上                                                  |
| 打开上传详情 | `GET /order/invoice/detail`                 | 只读      | 同上                                                  |
| 上传发票文件 | `POST /order/invoice/upload_pdf`（multipart） | 写       | **UI 驱动 + 网络捕获**（机制三）为主；页面 fetch + FormData（机制二）为备选 |
| 提交发票   | `POST /order/invoice/save`（JSON）            | 写（业务变更） | **最终态自动提交**，页面 fetch（机制二）或 UI 点击；开发阶段 dry-run 不真提交  |

关键差异点：`upload_pdf` / `list` 前端请求带动态公共参数（`verifyFp` / `fp` / `msToken` / `a_bogus`）和 `x-secsdk-csrf-token`。**这些参数不由我们生成**，而是让店铺工作台页面自己生成：

- **UI 驱动**：在发票上传弹窗里设文件 → 页面 React 自己调 `upload_pdf`（参数由页面生成）→ 捕获响应拿 `data.key`。这是第 12.5 节「通过浏览器会话生成动态参数」的落地。
- **页面 fetch 直连**：`appeal.js` 的经验是很多写接口其实只校验 Cookie + csrf，不强制 `a_bogus`。可作为实测备选：页面上下文读 `x-secsdk-csrf-token`，`FormData` 直连 `upload_pdf`。**需实测确认**，被风控拦就退回 UI 驱动。

---

## 3. 复用方案设计

### 3.1 总体架构

```text
┌── 云端工作台（replenishment-workbench，既有/待建，第 10/11 节） ─────────────┐
│  POST /api/invoice/worker/jobs/claim     领取任务（Token + 租约）             │
│  GET  fileDownloadUrl                    下载 PDF 原件                        │
│  POST /api/invoice/worker/jobs/:id/result  回传 uploaded/failed/retryable    │
└───────────────────────────────────────────────────────────────────────────────┘
                  ▲ HTTPS（出站）
                  │
┌── Mac 回传代理（独立 Node 进程，本方案新增，纯 fetch 对接云端） ───────────────┐
│  invoice-agent.mjs   5s 轮询 claim → 下载 PDF → 调店铺工作台 关联→上传→提交 → 回传 │
└───────────────────────────────────────────────────────────────────────────────┘
                  │ 本地 HTTP（agent-bridge，127.0.0.1 + Bearer token）
                  ▼
┌── 店铺工作台（Electron，已运行，复用登录态与抓取能力） ────────────────────────┐
│  新增 src/invoice.js         消费者开票模块（对齐 appeal.js 的写法）           │
│  新增 agent-api method       invoice_list / invoice_detail / invoice_upload_pdf │
│                              invoice_counts / invoice_submit                  │
│  复用：session.fromPartition 登录态 + 隐藏窗口 + executeJavaScript + NET_HOOK  │
└───────────────────────────────────────────────────────────────────────────────┘
```

要点：

- **登录态、风控绕过、文件上传、网络捕获全部复用店铺工作台**，不新开浏览器、不复制 Cookie、不落地动态参数。
- **Mac 回传代理只做云端编排**（claim / 下载 / 回传），浏览器侧全交给店铺工作台。也可以把编排逻辑并进店铺工作台内部，但拆成独立进程更简单、可独立重启、不打断跑批。

### 3.2 新增 `src/invoice.js` 模块（店铺工作台内）

对齐 `appeal.js` 的结构：顶部定义「在店铺页面里执行的脚本」（自包含，`executeJavaScript` 注入），下面是 `createInvoice({store, app})` 返回可调用的方法。

#### 3.2.1 注入脚本清单

| 函数                          | 作用                                                                                                   | 实现要点                                                                                                                                                                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pageInvoiceList(cfg)`      | **关联查询**：按 claim 的 `payload.orderId` 在「待开票」列表查对应记录，记录的 `shop_order_id` 须与 `payload.orderId` **精确相等** | `fetch('/order/invoice/list?'+query, {credentials:'include'})`，query 带 `invoice_status_desc=wait_blue` / `shop_order_id=payload.orderId`；命中 1 条且 `shop_order_id` 精确相等=关联成功、不等/0 条=关联失败、多条=转人工                                             |
| `pageInvoiceCounts()`       | 状态数量                                                                                                 | `fetch('/order/invoice/get_counts', {credentials:'include'})`，返回 `wait_blue/wait_red/done_blue/cancel/all`                                                                                                                                |
| `pageInvoiceDetail(cfg)`    | 详情                                                                                                   | `fetch('/order/invoice/detail?shop_order_id=...', {credentials:'include'})`，返回 `upload_info` / `status_info` / `submit_msg`                                                                                                               |
| `pageInvoiceUploadPdf(cfg)` | 上传（页面 fetch 直连，**已实测无需 csrf/动态参数**）                                                                 | `FormData` 拼 `file / shop_order_id / invoice_status_type=1 / file_name`，`fetch('/order/invoice/upload_pdf', {method:'POST', credentials:'include', body:fd})`，返回 `data.key`/`data.url`（url 脱敏） |
| `pageInvoiceSubmit(cfg)`    | 提交（最终态自动，dry-run 控制）                                                                                 | `fetch('/order/invoice/save', {method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body:JSON.stringify({shop_order_id, blue_invoice_key, invoice_status_type, invoice_file_list:[{tos_key,file_name}]})})`，body 字段见 `invoice-return-doudian-api.md` §5 |

#### 3.2.2 上传 PDF 的实现路径（实测后收敛为页面 fetch 直连）

**主路径：页面 fetch + FormData 直连（已实测成功，无需 csrf/动态参数）**

```text
1. session.fromPartition('persist:shop-<id>') 建隐藏窗口，加载 https://fxg.jinritemai.com/ffa/morder/receipt/list
2. 主进程读 pdf_path → base64 → executeJavaScript 注入 pageInvoiceUploadPdf
   页面内 atob 还原字节 → new File([bytes], name, {type:'application/pdf'}) → FormData
3. fetch('/order/invoice/upload_pdf', {method:'POST', credentials:'include', body: fd})
   → 响应 { code:0, data:{ key, url } }，key 即 tos_key
```

- 实测（2026-10-14）`upload_pdf` 直接 fetch 相对路径返回 `code:0`，**不需要** `x-secsdk-csrf-token` / `a_bogus` / `verifyFp`。
- `list`/`detail`/`save` 同样可 fetch 直连，接口契约见 `invoice-return-doudian-api.md`。

**兜底：UI 驱动 + 网络捕获**

- 若未来抖店加风控导致 fetch 直连被拦，退回到「`DOM.setFileInputFiles` + 补发事件 + 扩展 `NET_HOOK` 抓 `upload_pdf` 响应」的 UI 路径（`setFileInputs` 已有现成实现）。

#### 3.2.3 网络捕获（仅作兜底，正常路径不需要）

正常路径直接 fetch 拿到 `data.key`，无需网络捕获。仅当未来切换到 UI 兜底路径时，才需要扩展 `NET_HOOK_SRC` 抓 `upload_pdf` 响应体（把 `data.key` 存入 `window.__invoiceUpload`，读端新增 `pageReadInvoiceUpload()`）。`data.url` 只截取 host + key，**不落盘签名 query**。

### 3.3 agent-bridge 新增 method

在 `agent-api.js` 的 `createDispatcher` 里新增（对齐现有 `auto_appeal_*` / `flyge_probe` 的写法）：

| method               | args                                                                     | 返回                                 | 说明                              |
| -------------------- | ------------------------------------------------------------------------ | ---------------------------------- | ------------------------------- |
| `invoice_list`       | `{shop_id, status_desc, shop_order_id?, page?, pageSize?, start?, end?}` | 列表 rows（快照）                        | 只读                              |
| `invoice_counts`     | `{shop_id}`                                                              | 各状态数量                              | 只读                              |
| `invoice_detail`     | `{shop_id, shop_order_id}`                                               | 详情                                 | 只读                              |
| `invoice_upload_pdf` | `{shop_id, shop_order_id, pdf_path, mode?}`                              | `{ok, key, snapshot, error, shot}` | 上传；`mode` 选 A/B                 |
| `invoice_submit`     | `{shop_id, shop_order_id, tos_key, file_name, blue_invoice_key?}`        | 提交结果                               | **最终态自动提交**，受 `submitMode` 开关控制 |
| `invoice_health`     | `{shop_id}`                                                              | 登录态 + 开票页可达性                       | 自检                              |

`shop_id` 即云端 claim 下发的 `payload.shopId` = 店铺工作台 `shops.json` 的 `id`（uuid），直接 `session.fromPartition('persist:shop-'+shopId)` 选登录态，无需二次映射。

### 3.4 店铺主体映射

- 云端 claim 的 `payload.shopId` 就是店铺工作台 `shops.json` 的 `id`（uuid），Mac 代理直接用。
- 发票列表按 `payload.orderId`（=抖店 `shop_order_id`）定位，不依赖抖店数字 shop_id；如需抖店 shop_id，复用 `pageShopId()`（读 `window.SlardarConfigContext.shop_id`）。


## 5. 安全边界（延续第 12/13 节）

1. **最终态 = 全自动提交（`/order/invoice/save`）**；开发/验证阶段用 `submitMode` 三档开关：`dry-run`（只查/核对，不传不提交）→ `upload-only`（真传拿 key，不提交）→ `auto`（全自动，最终态）。
2. 动态参数（csrf/a_bogus/verifyFp/签名 URL）只在店铺工作台页面内存里，Agent 不读取、不保存、不回传完整签名串。
3. 自动提交 `save` 的触发条件（全部满足，否则转人工）：① 关联成功（待开票列表查到唯一记录）；② 金额/店铺/状态核对通过（抬头/税号由云端匹配保证）；③ 已拿 `data.key`；④ 云端匹配唯一；⑤ 记录仍「待开票」且未被他人领取。
4. 云端无 `submitted`：`uploaded` 是最终成功态，表示关联 + 上传 + `save` 提交 + 列表刷新验证全部成功。
5. 复用店铺工作台的登录失效处理（`code==10008` → `LOGIN_REQUIRED`；安全验证 → `VERIFICATION_REQUIRED`），不要绕过。

---

## 6. 实施顺序

| 阶段      | 内容                                                                                                                 | 复用点           |
| ------- | ------------------------------------------------------------------------------------------------------------------ | ------------- |
| M1 基线走查 | 用 `flyge_probe` 加载发票列表页，固化「待开票」筛选/订单号搜索/上传按钮/文件输入的选择器                                                              | `flyge_probe` |
| M2 只读打通 | `invoice.js` 注入 `pageInvoiceList/Counts/Detail`，agent-bridge 加 `invoice_list/counts/detail`，实测 list 相对路径 fetch 是否通 | 机制二           |
| M3 上传打通 | 路径 B（页面 fetch + FormData）先试；被拦则路径 A（UI 驱动 + 网络捕获）                                                                  | 机制二/三         |
| M4 编排   | Mac 回传代理 `invoice-agent.mjs`（claim→下载→核对→上传→回传）                                                                    | agent-bridge  |
| M5 干跑   | 1 条真实「待开票」订单端到端（dry-run：只查/核对，不传不提交），日志无动态值                                                                        | 全链路           |
| M6 部署   | launchd 常驻 + 断网重连 + 租约过期回归                                                                                         | —             |
| M7 自动提交 | `invoice_submit`（save）+ 列表刷新验证；`dry-run→upload-only→auto` 逐级放开                                                     | 机制二/UI 点击     |

---

## 7. 风险与验证

| 风险                           | 缓解 / 验证                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `upload_pdf` 直连被风控拦（动态参数缺失）  | 路径 B 实测失败即切路径 A（UI 驱动，参数由页面生成）                                                                    |
| 发票页 DOM 与申诉页不同               | M1 用 `flyge_probe` 走查固化选择器，失败截图 + 人工更新基线                                                          |
| 店铺登录态失效                      | 复用 `login-health` / `get_login_status`，失效回 `retryable` 或人工扫码                                      |
| 与跑批互相抢占窗口                    | 上传用独立隐藏 `BrowserWindow`（`show:false`），不碰飞鸽/举报窗口                                                   |
| 数据键不匹配（云 `shopId` ↔ 店铺 `id`） | M4 前用 `list_shops` 建立名称↔uuid 映射，claim 直接下发 uuid 或名称                                               |
| 误调 `save`                    | `submitMode` 三档开关：`dry-run`/`upload-only` 阶段不真提交；`auto` 阶段受触发条件约束，干跑网络捕获断言无 `/order/invoice/save` |

---

## 附：关键代码位置索引（复用参考）

| 能力             | 位置                                                                                |
| -------------- | --------------------------------------------------------------------------------- |
| 多店铺分区登录态       | `src/main.js` → `session.fromPartition('persist:shop-'+id)`                       |
| 隐藏窗口 + 注入执行    | `src/appeal.js` `processShop` / `runPage`（`executeJavaScript` 序列化函数）              |
| 页面 fetch 绕过风控  | `src/appeal.js` `pageReviewApply` / `pageApplyNow` / `pageUploadImage`            |
| 文件上传（CDP 设文件）  | `src/appeal.js` `setFileInputs`                                                   |
| 网络捕获           | `src/appeal.js` `NET_HOOK_SRC` / `installNetHook` / `pageReadNet` / `pageReadCap` |
| 只读接口直连（Python） | `collectors/builtin/douyin.py` `direct_credentials`                               |
| 本地接口分发         | `src/agent-api.js` `createDispatcher` / `startAgentAPI`                           |
| 登录失效判定         | `collectors/builtin/douyin.py` `check_platform_login`、`src/login.js`              |
| 抖店 shop_id 读取  | `src/appeal.js` `pageShopId`                                                      |
