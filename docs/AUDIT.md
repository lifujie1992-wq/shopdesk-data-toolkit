# 现状盘点（2026-11-06）

对象：家目录下全部「取数/抓取/同步」脚本，不含前端补货台、Electron 工作台 UI。
方法：遍历目录、统计行数、比对文件哈希、读取 launchd 配置。**本阶段未修改任何文件。**

## 1. 清单

### 1.1 聚水潭（Node，已 CLI 化）

| 目录 | 行数 | 入口命令 | 认证来源 | 默认输出 |
|---|---|---|---|---|
| `jushuitan-order-details` | 986 | `jst-orders` | Keychain | `~/jst-order-details.sqlite`、`~/jst-order-item-details.sqlite` |
| `jushuitan-sales-performance` | 701 | `jst-sales` | Keychain | `~/jst-sales-performance.sqlite` |
| `jushuitan-inventory-warning` | 7488 | `jst-inventory` | Chrome Cookie + Keychain | `~/jst-inventory-full.sqlite` |
| `jushuitan-order-page` | 1475 | `jst-order-page` | OpenBridge（浏览器标签页） | `~/jst-order-page.sqlite` |
| `jushuitan-aftersales` | 1373 | `jst-aftersales`、`export-refund-daily.mjs` | OpenBridge | `~/jst-aftersales.sqlite`、`~/jst-refund-export.sqlite` |
| `jushuitan-profit-facts` | 720 | `build_facts.py` | 复用订单库 | `jst-profit-facts.sqlite` |
| `jushuitan-purple-orders` | 0 | （空壳，逻辑在 `doudian-daily/`） | — | `~/jst-purple-orders.sqlite` |

四种认证方式并存，是复用困难的第一大原因。

### 1.2 抖店（Python，单目录大杂烩）

`doudian-daily/` 3938 行、24 个脚本，实际承担 6 件互不相关的事：

| 文件 | 职责 |
|---|---|
| `daily_collect.py` | 抖店 11 步经营指标采集（编排） |
| `doudian.py` | 抖店接口客户端（107 字段合约） |
| `doudian_sync.py` / `doudian_client_sync.py` | 同一件事的另两个版本（已分叉） |
| `jst_brush.py` / `jst_purple_orders.py` | 聚水潭紫旗订单（与聚水潭项目重复） |
| `invoice.py` / `invoice_sync.py` | 发票（与 `projects/invoice-mac-agent` 重复） |
| `badreviews_to_mysql.py` | 中差评 → MySQL |
| `excel/fill_*.py` | Excel 回填 |
| `workbook-module/` | 工作台 GUI 采集模块（内嵌又一份 `doudian.py`） |

### 1.3 `projects/` 下的其余项目

| 项目 | 说明 | 与谁重复 |
|---|---|---|
| `xdr-sync-agent` | 云端任务队列 + 上传 + 失败修复，**所有同步的总入口** | — |
| `shopdesk-aftersale` | 售后待审核计数 + 上传 | `jushuitan-aftersales` |
| `feige-customer-daily` | 飞鸽客服表现 | — |
| `invoice-mac-agent` | 发票采集 + PDF 回传 | `doudian-daily/invoice*.py` |
| `douyin-commission-rates` | 精选联盟佣金率 | — |
| `douyin-settle-recon` | 月度账单核对 | — |
| `shopdesk-data-toolkit` | **全部源码的拷贝快照**（14 组件） | 全量重复 |
| `task-runs` | 运维事件记录（非代码） | — |
| `about`、`shopdesk-workbench-src` | 展示页 / Electron 工作台宿主 | — |

### 1.4 散落根目录

`appeal.js`(90KB)、`appeal-web.js`(72KB)、`dev/shop-daily-sync(1).mjs`、
`shopdesk-appeal/`、`shopdesk-appeal-test/`、`replenishment-workbench/`、
`worktrees/replenishment-{user,codex}/`、`店铺工作台.app`、`111.zip`、多个 `.zip` 副本。

## 2. 重复度证据

| 内容 | 份数 | 证据 |
|---|---|---|
| `errors.js`（`CliError`） | 4 | order-details 与 sales-performance **md5 完全相同**；inventory 另一份；order-page 内联一份 |
| `session.js`（Keychain 读 cookie） | 3 | 逻辑 95% 相同，只有 `PREFIXES` 不同 |
| `transportData` 请求骨架 | 3 | `api.js`：相同 headers / cookie 注入 / `code:-1 未登录` 判定 / 限流 / 访问上限等待 |
| SQLite 导出（建表+批量 upsert+原子替换） | 2 | `sqlite-export.js` 结构相同，列定义不同 |
| `doudian.py` | 2 | 根目录与 `workbook-module/` 已分叉 |
| 发票逻辑 | 3 | `invoice.py`、`invoice_sync.py`、`invoice-mac-agent` |
| 全套源码 | 2 | `shopdesk-data-toolkit/components/` 是家目录的拷贝 |

## 3. 运维面

- **26 个 launchd 任务**，全部用绝对路径写死，且文件名有 4 种前缀
  （`com.lee.` / `com.xdr.` / `local.` / `local.shopdesk.`）。
- 存在 `.bak-20261015`、`.plist.before-complete-*` 之类的备份文件躺在生效目录旁。
- 已加载任务中 `com.xdr.jst-auth-refresh`、`local.shopdesk.aftersale-counts`、
  `com.xdr.douyin-commission-rates` 当前退出码非 0。

## 4. 数据落位

12 个 SQLite 直接躺在 `~`，最大 1.2GB（`jst-aftersales.sqlite`）；
`jst-cookie-export.json` / `.txt` **明文 cookie 在根目录**。

## 5. 结论：乱在哪

1. **一个业务一个仓库**，但共享了 4 份相同的基础设施代码。
2. **一个仓库多种职责**（`doudian-daily` 是典型）。
3. **认证方式四套**，没有统一抽象，所以谁都不能复用谁。
4. **入口命令碎片化**：7 个 `jst-*` 二进制，参数风格一致但不共享实现。
5. **路径写死**：没有统一的输出/数据目录约定。
6. **存在「假重构」**：`shopdesk-data-toolkit` 只是拷贝，没有消除重复。
