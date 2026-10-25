# invoice-mac-agent

Mac 侧抖店消费者发票回传代理。代理轮询云端 Worker API，复用「店铺工作台」每个店铺的 Electron 登录会话，完成订单核对、PDF 上传、提交和结果回传。

## 目录与配置

- 代码：`/Users/zhaoxiaozhong/projects/invoice-mac-agent/`
- 配置：`~/.config/invoice-mac-agent/config.json`（必须为 `0600`）
- 临时 PDF 和恢复状态：`~/.local/share/invoice-mac-agent/`
- 店铺工作台 bridge：`~/Library/Application Support/shopdesk/agent-bridge.json`（动态读取）

配置示例见 `config.example.json`。真实 Worker Token 只能放在本机配置或环境变量中，不要写入代码、Git 或日志。

## 运行模式

- `dry-run`：真实 claim、下载、订单查询和核对；不上传、不提交；回传 `retryable`。
- `upload-only`：上传 PDF，但不调用 `/order/invoice/save`；回传 `retryable`。
- `auto`：上传、提交、列表验证成功后回传 `uploaded`。

`dry-run` 和 `upload-only` 在处理一个真实任务后会主动退出，防止立即重复领取同一任务。开发模式不要启用 launchd `KeepAlive`。

## 命令

```bash
npm test
node agent.mjs --once   # 执行有数量/时间上限的一轮，可连续领取多个小批
node agent.mjs --once --upload-only  # 强制只上传PDF，禁用最终提交（覆盖配置中的auto）
npm start               # 手动常驻轮询；默认间隔1分钟（launchd不使用此方式）
```

## 上线步骤

1. 确认店铺工作台已运行，`invoice_health` 返回登录正常。
2. 用 `dry-run` 对生产任务验证店铺、订单号、金额和待开票状态。
3. 用 `upload-only` 验证真实 PDF 上传，确认订单仍在 `wait_blue`。
4. 经明确批准后，把配置中的 `submitMode` 改为 `auto`。
5. 安装并加载 `launchd/local.invoice-mac-agent.plist`。

### 当前生产调度（2026-10-17优化）

- 本机配置 `submitMode=auto`、`pollIntervalMs=60000`、`maxJobs=3`、`maxJobsPerRun=20`。`maxJobs` 直接对应 `/api/invoice/worker/jobs/claim` 请求体的同名字段，表示每次最多领取3条；逐条执行，处理完再领取下一批，每轮最多处理20条，最后一批按本轮剩余额度缩小请求数量（例如只剩2条额度就发送 `{"maxJobs":2}`）。
- 原 `claimBatchSize` 字段及环境变量已移除。每批数量统一使用 `maxJobs` / `INVOICE_AGENT_MAX_JOBS`；每轮总量使用 `maxJobsPerRun` / `INVOICE_AGENT_MAX_JOBS_PER_RUN`。本机已迁移为每批3条、每轮20条，旧配置恢复后须迁移该字段，否则会提示配置错误，避免误按旧 `maxJobs=20` 放大批次。
- 每轮8分钟（`maxRunMs=480000`）后不再领取新批，已经领取的这一批继续处理。`--once` 表示一轮，不再仅表示一次claim；非auto模式每轮只处理1条。
- `~/Library/LaunchAgents/local.invoice-mac-agent.plist` 使用 `StartInterval=60`，每分钟启动 `node agent.mjs --once`，一轮完成后退出，无KeepAlive。加载/登录时首次执行一次；Mac休眠时不会保证准时执行。
- launchd不会并发启动同一服务的多个实例；一次任务未结束时不会叠加新的实例。不要另行手动常驻运行代理。
- 日志：`~/.local/share/invoice-mac-agent/logs/agent.log`、`launchd.out.log`、`launchd.err.log`。
- 停用：`launchctl bootout gui/$(id -u)/local.invoice-mac-agent`（先确认没有正在提交的任务）。
- 此调度仅针对发票回传；独立采集任务已另行启用，见下方「定时采集」。

### 生产配置与领取接口的对应关系

真实配置文件是 `~/.config/invoice-mac-agent/config.json`，权限0600。环境变量优先于文件，文件优先于代码默认值。下表为本机生产值，`config.example.json` 仍使用开发用的 `submitMode=dry-run`。

| 配置字段 | 生产值 | 用途 / 对应环境变量 |
| --- | --- | --- |
| `maxJobs` | `3` | 每次领取数量，对应claim请求体的 `maxJobs`；`INVOICE_AGENT_MAX_JOBS` |
| `maxJobsPerRun` | `20` | 每轮处理总量上限；`INVOICE_AGENT_MAX_JOBS_PER_RUN` |
| `maxRunMs` | `480000` | 本轮8分钟后不再领取新批；`INVOICE_AGENT_MAX_RUN_MS` |
| `pollIntervalMs` | `60000` | 手动常驻模式的轮间等待；`INVOICE_AGENT_POLL_INTERVAL_MS` |
| `retryBackoffMs` | `300000` | 首次失败冷却5分钟；`INVOICE_AGENT_RETRY_BACKOFF_MS` |
| `maxRetryBackoffMs` | `1800000` | 冷却最长30分钟；`INVOICE_AGENT_MAX_RETRY_BACKOFF_MS` |

生产使用launchd，每分钟启动的间隔实际由 `local.invoice-mac-agent.plist` 的 `StartInterval=60` 控制；仅修改JSON中的 `pollIntervalMs` 不会改变launchd触发频率。`maxJobs`、`maxJobsPerRun` 均须为1～20的整数。`claimBatchSize` 和 `INVOICE_AGENT_CLAIM_BATCH_SIZE` 已移除，读取到旧字段会报迁移错误。

### 每批、每轮和接口调用次数

实现入口：[`worker-round.mjs`](worker-round.mjs)。一轮是一次 `agent.mjs --once` 进程的处理周期，一批是一次claim返回的任务；每批中的任务逐个执行。

```text
本次claim请求体 = {"maxJobs": min(配置maxJobs, maxJobsPerRun - 本轮已处理数)}

待办25个，maxJobs=3，maxJobsPerRun=20：
第1～6次请求：每次领取3个，逐个执行，累计处理18个
第7次请求：仅剩2个额度，发送 {"maxJobs":2}，累计处理20个
本轮结束，余下5个由后续定时执行领取
```

批与批之间不等待一分钟，处理完直接续领。一轮可以运行数分钟，期间launchd不会重叠启动同一个服务。20是处理次数上限，终态 `failed` 也占处理次数，不代表必定成功20个。队列为空、达到数量/时间上限、出现可重试失败或收到停止信号都可能提前结束。非auto模式每轮只领取和处理1条。

下表假设任务均正常处理、没有接口重试、没有达到时间预算，且处理中没有新增待办：

| 开始时待办数量 | 每次返回数量 | 本轮claim请求次数 |
| --- | --- | --- |
| 0 | 0 | 1 |
| 3 | 3、0 | 2 |
| 5 | 3、2、0 | 3 |
| 19 | 3、3、3、3、3、3、1、0 | 8 |
| 20及以上 | 3、3、3、3、3、3、2 | 7 |

任务不足上限时，会再请求一次确认队列为空；达到20个上限后直接结束，不再查空。网络错误触发的请求重试会额外增加HTTP调用数。

空队列正常时，一轮只请求一次claim后退出，不下载PDF、不调用店铺工作台。每小时约60次、每天约1440次请求；服务端进行Token鉴权、带索引的待办查询和在线时间更新。生产空队列样本耗时131/135毫秒，包含网络时间，不能当作服务器CPU耗时。

### 使用 shopdesk 最新登录店铺（2026-10-20）

用户已明确：店铺信息按 shopdesk 当前登录的最新店铺处理。实现在 [`latest-shops.mjs`](latest-shops.mjs) 和 [`job-runner.mjs`](job-runner.mjs)，每个任务重新读取 `list_shops`；上传前、提交前再次读取，不再整轮复用店铺列表。`resetShopCache()` 仅保留为兼容空操作。

匹配规则：当前ID存在时使用当前店铺名称；旧ID不在当前清单中时，按任务店名精确匹配当前唯一的抖店登录，并以其最新ID执行订单查询、PDF上传及提交。仅去除名称首尾空格，不模糊匹配、不按历史已删除会话执行。当前ID和店名分别指向不同店铺、同名多条或最新清单暂缺店铺时保留明确错误，不能猜选。

解析最新店铺不会修改云端原任务或历史采集归属；`shop_identity_resolved`日志记录旧ID、当前ID、店名和匹配依据。仍严格核对订单号、子订单、待开票状态、金额及租约。核对后登录记录变化会暂停上传/提交，回报`retryable`，下一轮重新核对；最新清单暂缺或同名歧义也按可重试处理。此前已成为`failed`的任务不会仅因代码更新自动重放，需通过原业务重试流程恢复。

### 请求重试、任务重试与冷却文件

请求层实现在 [`cloud-client.mjs`](cloud-client.mjs)，通过异步循环和 `setTimeout` 等待重试。对网络异常、HTTP 408/425/429/5xx重试；401/403鉴权错误和409租约冲突不会在同一个请求中连续重试。

| 云端操作 | 最多尝试次数（含首次） | 失败后的等待间隔 |
| --- | --- | --- |
| 领取claim | 5 | 1、2、4、8秒 |
| 下载PDF | 3 | 1、2秒 |
| 回报结果 | 3 | 1、2秒 |

这些短重试只包围云端操作。抖店最终提交不套这层通用重试；提交异常或失败后，先查 `done_blue` 确认是否已经开票，已成功则回报 `uploaded`，否则回报 `retryable` 留待重新领取。

任务层由 `job-runner.mjs` 判断并回报：`uploaded` 表示完成；`failed`（例如金额不匹配、PDF损坏）不会自动重新排队；`retryable` 表示服务器重新设为待领取。可重试失败或结果回报租约冲突后，正常情况下继续处理本批其他已领取任务，然后停止续领；未处理完就抛出的异常会保留恢复状态并结束本轮。

冷却实现在 [`worker-round.mjs`](worker-round.mjs) 的 `createWorkerBackoff()`：连续触发时按5、10、20、30分钟暂停领取，30分钟封顶。它作用于整台回传代理，其他新任务也可能延后；当前接口不支持按任务排除领取。空队列或无可重试失败的正常轮次会清零计数。当前没有按单个任务失败次数自动终止或自动转人工的机制。

例如A、B、C同批领取：A网络异常回报retryable，B/C完成；假设10:00本批结束，则冷却到10:05。期间每分钟只检查本地文件；到期后的定时执行恢复领取。如果又发生可重试失败，则从该批结束起再冷却10分钟，后续20分钟、30分钟。

冷却状态文件为 `~/.local/share/invoice-mac-agent/worker-backoff.json`，通过“写临时文件→重命名”保存，权限0600，包含失败次数 `failures` 和允许恢复的毫秒时间戳 `until`。冷却期间新进程读取该文件后立即退出，不访问服务器。

- 只有进入冷却才创建文件，未出现失败时通常看不到，不需要手动创建。
- 冷却到期不会立即自动删除；后续正常完成一轮或确认空队列时删除。
- 再次失败会更新文件和冷却时间；退出、重启进程不会清空已有冷却。

### 租约与进程中断恢复

开始执行、上传前和最终提交前都检查租约，剩余时间不足 `leaseSoftDeadlineMs=60000` 时放弃该步骤并回报retryable。每批在处理前将已领取租约写入 `~/.local/share/invoice-mac-agent/state.json`（0600，临时文件重命名），结果确认后逐条移除，全部完成后删除文件；该文件正常空闲时也可能不存在。

中断后，后续允许执行的一轮逐个回报遗留任务为retryable；遇到409则丢弃旧租约，不使用旧令牌提交。恢复完成后进入一次冷却，不在同一轮立即重做任务。回报恢复结果仍失败时保留尚未确认的租约，供下一轮恢复。该逻辑兼容旧的单任务状态文件。

## V2 采集同步（Node 24，零第三方依赖）

`capture-source.mjs` → `capture-pack.mjs` → `capture-upload.mjs`，由 `capture-runner.mjs` 编排。只采集消费者 `wait_blue` 和平台账单，不采集待红冲。旧 Python/xdr 发票自动采集已于2026-10-17停用，现由本链路负责每日采集入库。失败按店铺×业务隔离，部分明细全部丢弃；明确完整的空列表才上报成功0行。

2026-10-22 起，消费者待开票仅采集页面 `order_status_text=已完成` 的订单，其他状态及缺失/未知状态不进入快照或推送；`shopResults.rowCount` 和云端行数均按筛选后的数量计算。分页完整性仍按来源原始条数与 `total` 校验，全部被筛掉时报告完整成功0行。日志 `capture_consumer_order_filter` 记录每店读取、保留及排除数量。平台账单沿用原采集规则。

当日22:00验证：93项测试全部通过；56店、112个业务单元全部采集成功，消费者来源32条保留29条已完成、排除3条其他状态，平台账单410条。批次 `mac-20261022-220011-ce6243bf-ebb2649c` 已推送并入库为 `processed`，云端ACK为消费者29条、平台410条，与本地一致。

2026-10-19 已实现行内主体字段：原有 `consumer_order`、`platform_bill` 每条记录直接携带 `companyName`、`creditCode`，行数和 ACK 保持两类业务结构。消费者按用户确认的规则使用本店唯一 `IsNewSubject=true` 且未注销、资料完整的最新主体；无法选择时两个字段同时为 null 并记日志。平台账单使用各自查询主体，保留历史主体。无需额外开关，已移除旧独立主体记录试验路径。云端字段、兼容和入库规则见 [主体同步接口补充](doc/2026-10-19_主体同步接口补充.md)。

```bash
node capture-cli.mjs --once --dry-run              # 真实只读采集 + 本地打包，不上传
node capture-cli.mjs --dry-run --shop-id <店铺ID>   # 单店；首次采集前使用
INVOICE_AGENT_CAPTURE_ENABLED=true node capture-cli.mjs --resume  # 上传已有清单，停在 uploaded
# 以下会校验并写入 ERP 主表，须确认后执行；不是抖店最终开票提交：
INVOICE_AGENT_CAPTURE_ENABLED=true node capture-cli.mjs --resume --complete
# 历史日期恢复：
INVOICE_AGENT_CAPTURE_ENABLED=true node capture-cli.mjs --resume --manifest /绝对路径/日期-manifest.json
```

- 总开关 `captureEnabled` 默认 `false`，`--dry-run` 不受开关限制；环境变量支持严格 `true/false`。真实鉴权复用现有配置。
- 默认 **只上传，不调用采集 `/complete`**。`--complete` 是显式的 ERP 入库授权；`agent.mjs --upload-only` 独立控制 PDF 回传且禁止抖店最终开票。
- 默认目录 `~/.local/share/invoice-mac-agent/capture`（0700），gzip / manifest 为0600；含业务敏感信息，不要提交到代码仓库。`captureStateDir`、`captureShopdeskDir` 必须为绝对路径。
- 当天存在未完成 manifest 时拒绝覆盖，必须 `--resume`。恢复会验证gzip哈希、大小及逐店/总行数，原样携带 `capturedAt` 和 `shopResults`；若需重新采集，先归档旧的日期清单（每批ID清单也有独立备份）。
- 采集、恢复和文件清理共用 `capture.lock` 排他锁；正常退出、异常、CLI收到SIGINT/SIGTERM时释放。SIGKILL/断电留下锁时，先检查锁内pid并确认没有采集或清理进程，再人工归档/删除锁；绝不自动抢锁。
- 平台沿用第一页50条，但发现 `total_counts` 表明还有后续页（或无total且满50条）时上报失败，避免错误推进缺失计数。具名主体缺信用代码或相关字段缺失时上报失败，不静默忽略。
- 抖店可能返回 `CompanyName=''`、`CreditCode=''`、待开票标志为true的空条目。对该空范围执行只读账单查询，仅在接口明确成功、`total=0`且列表为空时确认无账单，保留其他正常主体明细；有账单、总数不明或响应不明确时仍失败，不猜测或补造税号。
- 批次ID在方案的内容哈希后增加元数据哈希，防止同秒空快照但采集结果不同而撞ID。
- `captureSourceMachine` 记录在本地；创建API使用契约字段，云端沿用默认来源。全部失败仍上传合法空gzip及失败结果。
- V2 平台账单仅支持采集；现有PDF回传仅支持消费者任务，平台任务会明确拒绝，不会误调用消费者接口。

### 定时采集

2026-10-16 已启用生产采集入库：本机 `captureEnabled=true`；`launchd/local.invoice-capture-sync.plist` 已安装到 `~/Library/LaunchAgents/` 并加载，执行 `capture-cli.mjs --once --complete`。Mac 本地时区 Asia/Shanghai，每日 **10:15** 采集、上传并请求 ERP 校验入库；无 `KeepAlive` / `RunAtLoad`，加载时不会立即采集。

- 已通过同一个 launchd 任务完成真实验证：`processed`，消费者80条、平台账单276条，ACK行数一致，退出码0，锁已释放；44项回归测试通过。
- 日志：`~/.local/share/invoice-mac-agent/logs/capture-launchd.out.log`、`capture-launchd.err.log`；日期清单中的 `cloudView` 保存服务器入库ACK。
- 本机现有 `local.xdr.nosleep` 已启用并运行（`caffeinate -i -s`）。准时执行依赖Mac开机、保持用户登录及联网、店铺登录有效；关机、注销、主动休眠或断网仍会影响执行。
- 云端短暂故障有最多5次退避重试，上传或提交超时先查云端状态；当天仍有未完成清单时，用 `node capture-cli.mjs --resume --complete` 原样恢复，不覆盖未完成快照。跨日恢复加 `--manifest /绝对路径/日期-manifest.json`。
- 首次上线有77/80个店铺业务单元成功；柒亿女装登录失效，QUEEN GLOW南觅女装专卖店的平台待开票主体缺少信用代码。失败单元单独记录，不作为成功空列表、不推进缺失计数，其他店铺正常入库。
- 2026-10-17核对QUEEN GLOW真实接口后，发现两个正常主体和一个名称/税号均为空的条目；空条目账单接口明确成功且0条。已修复对此类空条目的兼容校验，避免因它丢弃正常主体的12条平台账单；此问题无需用户提供或修改企业税号。
- 2026-10-17 23:01经实际launchd补跑验证：QUEEN GLOW消费者1条、平台账单12条均成功；全批消费者39条、平台288条，ERP返回processed且ACK数量一致，78/80单元成功。剩余两项为柒亿女装抖店登录失效。70项本机回归测试通过。

### 采集文件保留与每日清理（2026-10-17启用）

本机配置 `captureRetentionDays=7`，环境变量为 `INVOICE_AGENT_CAPTURE_RETENTION_DAYS`（整数1～3650，默认7）。清理仅作用于 `captureStateDir`，当前为 `~/.local/share/invoice-mac-agent/capture/`，不会清理ERP入库数据、PDF暂存、回传状态、日志或备份目录。

按 **Asia/Shanghai最近7个自然日，包含今天及前6天** 保留。例如2026-10-17保留10月11～17日，删除10月10日及以前的数据。依据文件名中的采集日期判断，不使用mtime，重新上传、修改或恢复旧文件不会延长其保留期。

清理范围为本项目命名规则中的 `.jsonl.gz`（含手动解压得到的同名 `.jsonl`）、日期清单、按批次清单、日期清单归档和相关 `.part` 文件。超过保留期的批次无论processed/prepared/uploaded/failed均清理，过期后不能再通过本地清单resume；要另行留存须在到期前复制到该采集目录以外。未知文件、目录、无效日期文件和符号链接跳过，不递归，不读取清单中记录的外部路径。

- 调度：`launchd/local.invoice-capture-cleanup.plist` 已安装并加载为 `local.invoice-capture-cleanup`，本地时间每日 **04:10** 执行 `capture-cleanup-cli.mjs --once`，与10:15采集及每分钟PDF回传独立，无RunAtLoad/KeepAlive。
- 低峰运行：`ProcessType=Background`、`Nice=10`、`LowPriorityIO=true`，降低CPU和磁盘IO优先级；仅扫描目录和删除过期文件，不解压数据或访问网络。
- 避让采集：复用 [`capture-lock.mjs`](capture-lock.mjs) 的 `capture.lock`，已有采集/恢复/清理任务持锁时整次跳过，后续每日任务再试；不抢占或删除已有锁。
- 日志：`~/.local/share/invoice-mac-agent/logs/capture-cleanup.out.log`、`capture-cleanup.err.log`，以及 `agent.log` 内的 `capture_cleanup_finished` / `capture_cleanup_deleted`。记录保留起始日、候选文件数、删除数、回收字节及错误数。
- 目录不存在则直接跳过；单文件删除失败时记录错误、继续处理其他文件，最终以非零退出码报告，已释放的锁不会阻挡下一次采集。Mac需开机并保持用户登录；休眠、注销或关机会影响准点执行，休眠错过的日历任务可能在唤醒后运行。

手动预览及执行（均读取同一生产配置；无需修改captureEnabled）：

```bash
node capture-cleanup-cli.mjs --once --dry-run   # 只列出过期候选和预计回收字节，不删除
node capture-cleanup-cli.mjs --once             # 执行过期文件清理
# 等价：npm run capture:cleanup -- --dry-run
```

实现见 [`capture-cleanup.mjs`](capture-cleanup.mjs)；首次生产预览保留起始日2026-10-11，扫描12个文件、0个过期，现有采集数据均在保留期内。

旧链路切换（2026-10-17 00:15）：服务器 `xdr-sync-doudian-invoice.timer` 已停止并禁用（原每日09:30）；旧发票队列无未完成任务。Python脚本和历史数据库保留，旧数仓发票数据停止自动刷新；其他xdr业务调度继续运行。服务器原unit备份：`/root/xdr-invoice-retirement-20261017-001509/`。

联调实录见 [2026-10-16 V2 Mac 开发验证记录](doc/2026-10-16_V2-Mac开发验证记录.md)。
