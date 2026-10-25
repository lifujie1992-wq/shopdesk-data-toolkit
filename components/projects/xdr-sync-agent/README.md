# XDR Sync Agent

The Mac agent fetches fixed jobs from the Linux control queue. The server cannot
send commands or arguments: task names are mapped to local, fixed CLI argument
arrays. JST authentication remains in macOS Keychain and is never transported.

```bash
./bin/xdr-sync-agent.js doctor
./bin/xdr-sync-agent.js run-once
./bin/xdr-sync-agent.js daemon
./bin/xdr-sync-agent.js status
./bin/xdr-sync-agent.js sync-now all
./bin/xdr-sync-agent.js sync-now profit_analysis
```

Install or remove the login agent:

```bash
./scripts/install-mac.sh
./scripts/uninstall-mac.sh
```

Open the management interface through SSH:

```bash
ssh -N -L 8765:127.0.0.1:8765 -i ~/.ssh/xdr_mac root@47.114.33.246
```

Then browse to <http://127.0.0.1:8765>.

The inventory dataset contains the hourly SPU/SKU inventory, shop-shortage tables,
existing sales-analysis snapshots, and the complete `platform_shop_list`
directory as `shop_directory`. Hourly inventory refreshes reuse the existing
analysis tables (or initialize them empty) and never request sales popups,
drawers, trends, or shop/SKU sales batches. Sales windows are built from paid-order
Excel exports and published through the BI dataset.

The separate `spu_live` dataset contains one coherent half-hour SPU + SKU snapshot.
The same 100-row JST report pages already include each SPU's SKU children, so no
additional JST requests are needed. Publication requires a stable SPU total,
complete pages, unique SPU/SKU identities, matching SPU and summed-SKU today
quantities, and exact stored row counts. A rejected run leaves the previous cloud
snapshot untouched. `/v1/inventory/spus` and `/v1/inventory/skus` both prefer this
snapshot and fall back together to the hourly inventory database; shop-shortage
routes remain hourly.

The SPU/SKU list and detail responses expose `snapshot_date`, `captured_at`,
`data_version`, and `spu_sku_coherent`. Consumers must compare quantities only
within the same `data_version`. Excel-derived BI responses remain historical
facts and use their explicit `business_date`; that date must not be relabeled as
the current Shanghai calendar day.

`inventory_daily_metrics` keeps one Shanghai-calendar-day snapshot of warning
styles, shortage quantities, overdue and near-overdue quantities, presale shortage,
unshipped quantity, available inventory, inventory in transit, and 7-day active
styles. Hourly refreshes replace the current day's row and retain prior dates.

The separate `jst-order-page` capture is available through the manual
`sync_order_page` task and is stored as the independent `order_page` dataset. It
does not alter the incremental `orders` report dataset.

The `profit_analysis` dataset comes from 聚水潭「商品利润分析 → 按 SKU」. The
agent submits the site's asynchronous Excel export, waits for the complete file,
and validates all 54 columns before publishing. The Rust-backed `fastexcel`
reader converts money and quantity fields to numbers, percentage strings to
decimal ratios, and preserves blank metrics as SQL `NULL`. Each seven-day window
is keyed by `start_date + end_date + sku_id`; a new window is retained while a
rerun of the same window is replaced atomically. Read it through
`/v1/bi/sku-profit-analysis` and inspect the latest run through
`/v1/bi/sku-profit-analysis/status`.
The default job crawls the latest seven days directly from the page API. The SKU response
contains focus-order counts plus the page's profit/gross-profit state and change labels.

The `orders` dataset contains both report tabs. `order_details` is the order-grain
history; `order_item_details` is the item-grain history and uses `row_key` as its
stable transfer key. Daily order synchronization refreshes yesterday in both
tables and retains older rows. The read-only API exposes item rows at
`/v1/orders/{o_id}/items` and `/v1/order-items`.

The legacy popup/drawer and shop/SKU batch collectors are not exposed as XDR jobs.
Historical analysis tables may remain in an inventory snapshot for compatibility,
but routine synchronization only copies them and cannot refresh them from JST.

`platform_product_sales_analysis` contains one aggregate row per SPU and platform.
`shop_product_sales_analysis` contains one aggregate row per SPU and shop. Its
`return_item_qty_180d` and refund forecasts are direct shop-row values, never
product-level backfills.
`link_product_sales_analysis` contains one row per SPU, shop, and platform listing,
including the listing identity, image, creation time, SKU identifier, and URL.
All three tables retain the direct `pay_qty_today`, `pay_qty_3d`, `pay_qty_7d`,
`pay_qty_15d`, and `pay_qty_30d` values at their own grain.
`product_daily_sales_analysis` currently contains product-level daily rows keyed by
`spu_id + biz_date`. `shop_daily_sales_analysis` contains the previous complete
day at `spu_id + shop_id + biz_date` grain and retains earlier synchronized dates.
Its `return_item_qty` is read from the same shop-grain response as its sales values.

Automatic inventory and sales synchronization runs at 10:40, 14:40, 18:40,
and 22:40 Asia/Shanghai. A 09:35 SPU warm-up is queued before the 09:40 order
history and 09:50 paid-order jobs. The regular lightweight SPU snapshot starts at 09:55, then runs
at :25/:55 from 10:00 through 21:59, and once more at 22:25. All supported Mac
crawlers use concurrency 1. Orders
synchronize yesterday's date once daily at 09:40 and merge it into the retained
history; yesterday's sales are finalized at 09:45. Current-day paid orders refresh
at 09:50 and hourly at :10 from 10:00 through 22:59, so BI `pay_qty_today` always
uses the current Asia/Shanghai date. XDR never requests full order
history, even on the first run. No automatic popup/drawer sales-analysis task is
scheduled. Automated JST reads stay inside the allowed daytime window.

Paid-order ingestion uses the earlier of the order-page bound and the inventory
snapshot time to keep quantities coherent. Inventory must cover the paid-order
business date; a previous-day or undated inventory snapshot is rejected before
copying or changing ODS, with `inventory_snapshot_before_business_date` in the
diagnostic log. A newer inventory snapshot cannot advance an older order snapshot's
capture time. The final summary records both cutoffs and skipped-row counts.
Automatic jobs scheduled before 09:30 are deferred to 09:30; one Mac worker executes
them in queue order, so timer success means queued rather than collection complete.
商品利润分析在源页面每日更新后，于 10:05 自动导出并发布。店铺商品于
每日凌晨 01:00（Asia/Shanghai）按上次快照规模自动分批导出，仅此任务允许夜间采集，所有批次下载并校验完成后才生成和发布
新的 DuckDB 快照；明确触发聚水潭单次导出 100 万条上限时，自动按店铺拆小该批次并串行重试。单店仍超限、其他批次失败或总行数异常下降时保留上一版。
每个已下载批次保存 SHA-256 检查点；同一作业或后续重试作业在店铺、账号和筛选范围一致且采集开始未超过12小时的情况下可断点继续；正在运行的其他采集进程不会被复用。网络中断、429或5xx最多尝试三次，间隔5秒、15秒；下载重试复用已取得的文件地址。失败保留已完成批次，范围变化、文件损坏或登录过期不会被当成成功。

## 任务失败飞书通知

`com.xdr.failure-watch` 已安装为每60秒执行一次的独立 LaunchAgent，登录时也会运行。
它只读检查云端实际作业失败、云端服务退出状态及本机任务退出码；同时读取发票
采集结果和PDF回传业务日志，因此进程退出0但部分店铺失败也能通知。
同时读取本机采集 worker 的失败状态，在结果无法上报云端时仍可告警。
监控覆盖当前正在运行的作业，无需重启采集 worker。

退款、紫旗、售后和登录态刷新脚本直接调用统一通知入口。通知包含任务名称及标识、
北京时间、失败阶段、执行编号、原因和日志位置。原生通知与监控使用同一执行身份
去重；云端按作业ID、发票按采集批次/PDF任务ID去重。首次建立基线不群发历史失败。

机器人配置复用 `~/Library/Application Support/shopdesk/alert-webhook.json`，权限0600。
签名按飞书自定义机器人要求生成，不把地址、密钥或鉴权头写进通知、日志和待发队列。
每次发送最多尝试三次；失败消息保存在
`~/Library/Application Support/xdr-sync-agent/failure-alerts/outbox/`，后续监控继续补发。
监控及发送状态见 `~/projects/xdr-sync-agent/var/logs/failure-watch.out.log`。

```bash
bash scripts/install-failure-watch.sh
node --test test/failure-alerts.test.js
```

监控任务清单来自本机about看板的 `data/inventory.json`，由 `scan.py` 扫描已安装任务
生成；新增任务后刷新看板。云端状态通过现有SSH密钥以只读查询获取，独立于任务
派发进程。业务数据结构与云端发布契约不变。

## Codex 故障自动处理

正式代码目录：`~/projects/xdr-sync-agent`。原 `~/xdr-sync-agent` 保留兼容软链接，
已有脚本、CLI和运行中的代理可继续使用。跨项目聚水潭工具从用户主目录解析，
不依赖本项目与其他工具的相对层级。

`com.xdr.failure-watch` 每60秒收集失败；统一通知入口将新失败持久化到
`var/failure-repair/incidents/`。`com.xdr.failure-repair` 是独立LaunchAgent，
每60秒领取一个事件并串行处理，使用本机已登录的 Codex CLI，模型为配置中的
`gpt-6.1-sol`。每个事件最多两轮、20分钟；相同原因六小时内复用已有定位。
首次接入不群发历史失败，监控和处理器自身的故障直接走原始告警，避免递归调用。

处理顺序：脱敏日志及任务配置 → 独立源码副本 → Codex定位和修复 → 受限检查 →
对原代码运行相同测试复现故障 → 原文件哈希检查 → 空闲时应用 → 等待原任务执行。
检查进程被操作系统限制为只能写副本和临时目录、不能访问网络。Codex也使用
workspace-write沙箱并关闭命令网络访问，不加载用户的MCP/插件配置。
任务执行中会暂存通过检查的补丁；原排期空闲后应用。不会自动重放采集、上传、
申诉等具有副作用的业务操作，不会重启正在工作的代理。

自动应用只针对 `config/failure-repair.json` 登记的本地项目、路径和检查命令；
目前登记12个项目，10个允许在门槛通过后自动应用。无验证登记的项目及云端服务
故障仍自动分析和报告，保留候选方案。已有测试、依赖配置、敏感配置、财务规则、
身份/费用映射和数据清理规则禁止自动修改。低置信度结论不自动应用。
需要验证码、实名认证、岗位授权或人工输入时明确报告，不将这类问题当作已修复。

2026-10-20用户已明确店铺信息以shopdesk最新登录清单为准。发票任务排查会自动附上
当前店铺ID、名称和平台，不包含凭据；回传端每任务及上传/提交前读取最新清单，
旧工作台ID缺失时使用当前唯一精确同名的抖店登录。该用户规则会传入Codex排查指令，
保留订单、子订单、金额及状态验证；旧任务对应订单不在当前店铺时仍不得上传。

应用前保存逐文件快照，记录部署事务；进程中断后先恢复未完成事务。下一轮任务
仍非零退出会回滚本次改动；发现文件已被人工修改则保留冲突，不覆盖人工内容。
进程退出0只报告“后续进程正常，业务待核验”。月度账单通过原失败店铺的
云端归档、下载哈希验证及清理检查点确认后，才报告业务已恢复。

月度账单 `local.douyin-settle-recon.monthly` 已纳入看板扫描和监控，还额外读取
`~/projects/douyin-settle-recon/data/monthly/YYYY-MM/batch.json` 中逐店的采集、上传、
云端验证失败，因此进程退出0也能发现部分店铺失败。等待实名认证的店铺保持原有
等待状态，不触发反复修复。监控内置该任务兜底，不依赖看板刚好刷新成功。

正常只向原飞书机器人发送处理结论：失败原因、定位证据、简要修复、验证和状态；
状态变化再补发一次。报告使用原有签名和待发队列，发送失败会继续补发。
原始失败通知延迟30分钟，若处理器不可用或排队过久，原告警会兜底发送；
故障处理完成并生成报告后原告警标记为已被处理报告替代，不重复发。
机器人配置及旧告警去重记录继续保存在原Library位置，不复制密钥到代码目录。

主要目录：

| 路径 | 用途 |
| --- | --- |
| `src/failure-incidents.js` | 故障事件持久化和脱敏 |
| `src/failure-repair.js` | Codex调用、处理状态、汇报及恢复观察 |
| `src/repair-workspace.js` | 源码快照、沙箱检查、应用和回滚 |
| `config/failure-repair.json` | 开关、模型、项目范围和验证命令 |
| `var/failure-repair/incidents/` | 每个故障的当前状态及简要结论 |
| `var/failure-repair/runs/<故障ID>/<轮次>/` | 上下文、Codex结果、检查结果、补丁清单和原文件备份 |
| `var/logs/failure-watch.*.log` | 失败监控日志 |
| `var/logs/failure-repair.*.log` | Codex处理器运行日志 |
| `var/acceptance/` | 隔离模拟故障及真实Codex验收记录 |

```bash
cd ~/projects/xdr-sync-agent
node bin/xdr-failure-repair.js --status
npm test

# 安装/重新加载两个后台任务；不会触发业务重跑
bash scripts/install-failure-watch.sh
bash scripts/install-failure-repair.sh

# 显式运行隔离模拟故障：调用真实Codex，不发送飞书、不触碰业务数据
node scripts/smoke-failure-repair.mjs
```

关闭自动处理：把配置的 `enabled` 改为 `false`。后续新失败恢复原告警通道；
已在队列中的事件保留，原告警到30分钟时兜底。正在处理的轮次会完成当前已开始的
步骤；如需立即停止，使用 `launchctl bootout gui/$(id -u)/com.xdr.failure-repair`，
下次启用会恢复未完成事务。Mac休眠/离线期间无法执行本机处理和发送通知。

## 聚水潭登录态自动刷新

`com.xdr.jst-auth-refresh` 每天 09:10、15:00、21:00 运行
`scripts/refresh-jst-auth.sh`。它选择已连接且可加载订单页的浏览器，刷新订单工具
专用页，执行真实订单列表读取，再读取同一会话的 API 域 Cookie。库存 API 验证
通过后保存到 macOS Keychain，并读回再次验证。来源不再固定为 Chrome `Default`，
Cookie 到期时间取浏览器实际值；凭据不写日志或临时文件。

失败间隔一分钟重试三次；连续失败发送系统通知，并复用
`~/Library/Application Support/shopdesk/alert-webhook.json` 的飞书告警配置。
用户已授权登录失效时自动恢复：打开 `https://www.erp321.com/login.aspx`，必要时
点击账号框触发Chrome自动填入已保存账号密码，勾选“我已阅读并同意”后点击
“立即登录”。实现见 `scripts/login-jst-saved.mjs`。只在明确登录失效时尝试一次恢复，
随后重新验证订单页、库存API并保存及读回Keychain；网络故障不会触发登录。
已识别的“密码超过三个月未修改”提醒会点击“确定”继续登录，不自动修改密码。
只在内存中检查账号密码是否已填入，不读取到日志、不复制密码、不保存密码文件。
未自动填入或遇到验证码/短信等额外验证时保留失败结果并沿用告警，不自动绕过。
运行结果见 `~/Library/Logs/xdr-sync-agent/auth-refresh.log`。
验收须同时检查 launchd 退出码和 `jst-inventory login-status`、
`jst-order-page login-status`，不能只看页面导航命令成功。

```bash
node --test scripts/tests/refresh-jst-auth.test.mjs scripts/tests/login-jst-saved.test.mjs
```

## 聚水潭售后明细自动同步

独立任务 `com.xdr.jst-aftersales-sync` 安装于
`~/Library/LaunchAgents/com.xdr.jst-aftersales-sync.plist`，每天 08:00、12:00、16:00
运行 `scripts/sync-jst-aftersales.sh`。正常刷新昨天；漏跑后根据本地
`~/jst-aftersales.sqlite` 的 `sync_info`，从最新成功日期的次日依次追赶，每轮
最多七天。每个日期失败重试三次，间隔一分钟；连续失败沿用飞书及系统通知，
后续排期继续追赶。显式传入日期时仅同步该日期。

采集器使用 OpenBridge，每轮新建专用 ERP 页重新初始化跨域售后鉴权，调用真实
售后接口验证；不复用可能持有过期 Authorization 的长期驻留页面。失败时尝试
其他浏览器；明确返回1006或跳转登录页时，在同一浏览器复用已授权的保存密码
登录恢复一次，验证订单和库存并保存/读回 Keychain 后，再新建售后页完整重抓。
网络或页面超时不触发登录，验证码/未自动填入/恢复后仍失效继续失败告警。
本轮专用页在成功或失败后关闭，完整抓取成功才写数据库，不输出鉴权头。
恢复逻辑在 `~/jushuitan-aftersales/src/session.js`。手动补跑仍使用
`launchctl kickstart gui/$(id -u)/com.xdr.jst-aftersales-sync`。
plist 文件存在不代表任务已加载，验收须核对 `launchctl print`、业务日志
`~/Library/Logs/xdr-sync-agent/aftersales-sync.log` 和数据库目标日期成功记录。

```bash
node --test ~/jushuitan-aftersales/test/sync.test.js
node --test ~/jushuitan-aftersales/test/session.test.js
/usr/bin/python3 -m unittest discover -s scripts/tests -p test_aftersales_pending_dates.py
```

## Paid-order Excel warehouse

Excel files are only parsed and coverage-checked on the Mac. The validated ODS
remains `jst-paid-orders-warehouse.sqlite`; Alibaba Cloud builds the read-only BI
serving layer separately as `jst-paid-orders-bi.duckdb`. DuckDB scans the ODS and
materializes platform, shop, link, SKU traffic-source and daily facts in one
atomic candidate. A failed or incomplete build does not replace the last BI file.

Large exports use the Rust-backed `fastexcel` reader when installed. It reads only
the required columns and writes SQLite in batches; the standard-library XML parser
remains as a recovery fallback.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-excel.txt
```

```bash
.venv/bin/python scripts/import-paid-order-exports.py \
  --xlsx-dir "/path/to/order-item-exports" \
  --today-xlsx "/path/to/today-order-export.xlsx" \
  --business-date 2026-09-09 \
  --output "$HOME/Library/Application Support/xdr-sync-agent/imports/paid-orders.sqlite"

node bin/xdr-sync-agent.js sync-now paid_orders
```

After the initial complete window, replace only the newly exported date while
preserving the existing batch identity. The import is built and checked in a
temporary database, then atomically replaces the local seed:

```bash
.venv/bin/python scripts/import-paid-order-exports.py \
  --base "$HOME/Library/Application Support/xdr-sync-agent/imports/paid-orders.sqlite" \
  --today-xlsx "/path/to/latest-today-order-export.xlsx" \
  --replace-start-date 2026-09-10 \
  --replace-end-date 2026-09-10 \
  --business-date 2026-09-10 \
  --output "$HOME/Library/Application Support/xdr-sync-agent/imports/paid-orders.sqlite"

node bin/xdr-sync-agent.js sync-now paid_orders
```

Hourly Excel publication is the initial operating target: a measured one-day
57,048-row replacement took about 16 seconds locally and XDR diffing about 4 seconds.
On the production host, DuckDB rebuilt all BI tables for 1,509,286 ODS rows in
about 7 seconds with a 512 MB engine memory limit; the serving file was about
198 MB. The legacy SQLite materializer remains available as an automatic fallback
when DuckDB is not installed.
BI `data_version` combines the retained batch ID with `captured_at`, so consumers
still detect every incremental Excel generation.

Current-day attribution is sourced from 聚水潭「常用 → 订单」with `pay_date` semantics.
Before publication it is cut to the coherent SPU/SKU inventory snapshot time,
cancelled orders are removed, and combination styles are expanded to their component
SKUs using the same inventory catalog.  This keeps SPU, SKU, platform, shop and
traffic-source totals comparable at one capture time; unresolved combinations remain
visible as their original style instead of being guessed.

`/v1/warehouse/status` exposes publication metadata. All sales-analysis contracts
are BI endpoints: `/v1/bi/sales-channels`, `/v1/bi/platform-sales`,
`/v1/bi/shop-sales`, `/v1/bi/link-sales`, `/v1/bi/sku-source-sales`, and
`/v1/bi/sku-platform-sales-daily`.
The old `/v1/warehouse/*-sales` and `/v1/warehouse/sales-channels` paths remain as
hidden compatibility aliases only.

The BI `sku-source-sales` endpoint always returns the three `source_type` buckets `精选联盟`, `直播间`,
and `商品卡`, including today, yesterday, and 3/7/15/30-day quantities. A
`精选联盟` label or non-empty `达人ID` takes precedence; otherwise a label
containing `直播` is `直播间`; everything else is `商品卡`. The 3/7/15/30-day
windows end yesterday, and today's changing value is separate. These exports
are marked `quality=order_derived`, not presented as direct popup snapshots.

`/v1/bi/shop-directory` is the current platform/shop selector captured from JST's
`platform_shop_list`. It accepts repeatable `platform` parameters and an optional
`shop_name` substring. `/v1/bi/inventory-products` accepts `view_type=sku|spu`,
repeatable `platform` and `shop_id` parameters, plus `stockout_only`. Values within
one dimension are ORed; platform and shop dimensions are ANDed. Product/shop
relationships come from the currently published paid-order Excel window, while
the returned product columns come from the latest inventory snapshot. The response
therefore declares `relationship_start_date`, `relationship_end_date`,
`inventory_captured_at`, and `quality=order_derived_scope`.

```text
GET /v1/bi/shop-directory?platform=抖音&limit=100
GET /v1/bi/inventory-products?view_type=sku&platform=抖音&limit=100
GET /v1/bi/inventory-products?view_type=sku&shop_id=14483357&stockout_only=true
```

`bi_sku_platform_sales_daily` is the date + SKU + platform BI fact table. It
stores direct source quantities, order counts, sales amounts, refunds, and gross
margin. A metric absent from an export remains null instead of becoming zero.

## Dataset schema evolution

`shared/datasets.json` declares the exact columns transferred for every dataset,
and both sides enforce it: the Mac validates each staging database against the
declared columns, and the server validates every applied package. When a dataset
gains columns (for example the doudian `visit_uv` / `sales_*` / `promo_*` metrics):

1. Add the columns to `shared/datasets.json` (this file is read by the Mac agent
   **at startup**, so restart the daemon afterwards to reload it) and to the
   matching BI column list in `/root/xdr/app.py`, then deploy both.
2. The running server adds any declared-but-missing columns to the live table
   with `ALTER TABLE ... ADD COLUMN` while applying a patch, so a routine
   incremental sync publishes the new columns without a full rebuild.
3. The BI API tolerates a schema that is ahead of the published file: columns not
   yet uploaded are simply omitted until the next sync delivers them.

A stale schema that is declared but not present in every published database makes
the server reject the package, so update the schema and the collectors together.

### Adding a brand-new dataset

A new dataset needs four coordinated changes, or the first upload fails:

1. `shared/datasets.json` (Mac) **and** `/usr/local/lib/xdr-sync/datasets.json` (server).
2. The `TASKS` / `DATASETS` / `FILE_RE` / `PHASES` allowlists in
   `/usr/local/lib/xdr-sync/xdr_sync_server.py`.
3. The upload filename whitelist in the SSH forced command
   `/usr/local/bin/xdr-sync-ssh`. The agent uploads to the full file path, so a
   dataset missing from that regex is rejected with a bare `scp_failed:1` while a
   manual `scp` to the directory still succeeds — a misleading combination.
4. `TASK_DATASETS` in `src/agent.js`, `src/validation.js`, and the
   `bin/xdr-sync-agent.js` `sync-now` map.

## Parallel workers

One agent process owns one lease loop. A single worker can only run one job at a
 time, so a short task can sit behind a multi-hour inventory export.

`agent-lease` accepts `--tasks` (allowlist) and `--exclude-tasks` (denylist). A
second worker can therefore coexist with the main daemon:

- give it a distinct `agent_id` and its own `state_dir` / `log_dir`,
- set `lease_tasks` to the tasks it owns,
- set `lease_exclude_tasks` on the main daemon so it does not steal them.

The `profit_facts` dataset runs this way: `config-profit-facts.json` claims only
`sync_profit_facts`, and the main config excludes it. Workers must never share a
`state_dir` or an `agent_id`, because the lease owner check would then let one
worker complete the other's job.

故障诊断按执行阶段选择源码：采集错误进入原采集项目，diffing、uploading、waiting_apply及SCP错误进入同步代理项目。同步作业按精确作业ID和任务名补齐本机diagnostics.jsonl中的调用参数、退出码和stderr，逐字段脱敏，避免要求用户提供本机已有的诊断日志。
