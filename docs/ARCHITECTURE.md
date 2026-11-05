# 目标架构

原则：**按「能力」分层，不按「项目」分层。**
一个数据源一个入口命令，基础设施只写一次，业务逻辑只写一次。

```
shopdesk-agents/
├── packages/
│   ├── core/                  @shopdesk/core   Node 共享基础库
│   │   ├── errors.js            CliError + 统一错误码/退出码
│   │   ├── date.js              Asia/Shanghai 日期与区间
│   │   ├── paths.js             数据目录约定（唯一出口）
│   │   ├── session.js           认证抽象：keychain / chrome / shopdesk / json
│   │   ├── jst-transport.js     聚水潭 transportData：header/限流/未登录/访问上限
│   │   ├── sqlite.js            打开/建表/upsert/原子替换/WAL
│   │   └── cli.js               子命令分发 + --json + 统一错误输出
│   └── pycore/                shopdesk_core     Python 共享基础库（对称实现）
│       ├── session.py           shopdesk 分区 cookie / 外部 JSON
│       ├── http.py              requests 会话 + Referer 规则
│       ├── sqlite.py
│       └── cli.py
├── sources/
│   ├── jst/                   bin: jst       一个命令，七个子命令
│   │   ├── orders.js            ← jushuitan-order-details
│   │   ├── sales.js             ← jushuitan-sales-performance
│   │   ├── inventory.js         ← jushuitan-inventory-warning
│   │   ├── order-page.js        ← jushuitan-order-page
│   │   ├── aftersales.js        ← jushuitan-aftersales
│   │   ├── purple.js            ← doudian-daily/jst_purple_*
│   │   └── profit.js            ← jushuitan-profit-facts
│   └── doudian/               bin: doudian   一个命令，多个子命令
│       ├── metrics.py           ← daily_collect.py
│       ├── reviews.py           ← badreviews_to_mysql.py
│       ├── invoice.py           ← invoice*.py
│       └── appeal.py            ← appeal*.js（后续）
├── pipelines/                 跨源业务流水线
│   ├── profit-facts/           订单 + 成本 → 利润事实库
│   └── cloud-sync/             → xdr-sync-agent
├── schedules/                 launchd 模板 + install/uninstall（路径用变量）
├── tools/
│   ├── parity.js              新旧实现对照测试（同一日期，diff 输出）
│   └── doctor.py              环境自检（登录态/目录/依赖）
└── docs/
```

## 关键变化

| 现在 | 之后 |
|---|---|
| `jst-orders`、`jst-sales`、`jst-inventory`… 7 个二进制 | `jst orders`、`jst sales`、`jst inventory`… 1 个二进制 |
| 每个项目自带 `session.js`/`errors.js`/`api.js` | 全部从 `@shopdesk/core` 引入 |
| 4 套认证实现散落各处 | `session.js` 一个入口，`{ source: 'keychain' \| 'chrome' \| 'shopdesk' \| 'json' }` |
| 输出路径写死 `~/xxx.sqlite` | `paths.js` 统一：`$SHOPDESK_DATA`（默认 `~/shopdesk-data/`） |
| launchd 写死绝对路径 | `schedules/*.plist.tpl` + `install.sh` 生成 |

## 数据目录约定

```
~/shopdesk-data/
├── jst/
│   ├── orders/          order-details.sqlite, order-item-details.sqlite
│   ├── sales/           sales-performance.sqlite
│   ├── inventory/       inventory-full.sqlite
│   ├── order-page/      order-page.sqlite
│   ├── aftersales/      aftersales.sqlite, refund-export.sqlite
│   └── purple/          purple-orders.sqlite
├── doudian/
│   ├── metrics/         shop_metrics.sqlite3 + <date>.json
│   ├── reviews/
│   └── invoice/
└── archive/
```

所有路径由 `resolveDataPath(dataset, file)` 生成，环境变量 `SHOPDESK_DATA` 可整体搬走。
过渡期用软链把旧路径指向新位置，无需改任何调用方。

## 明确不做的事

- 不合并语言：Node 侧本来就是 Node（`node:sqlite`、原生 `fetch`），Python 侧是抖店/Excel/MySQL。
  强行统一会引入无谓重写。两侧各自有 core，接口形状保持一致。
- 不保留「一业务一仓库」。7 个 `jst-*` 目录会消失，代码收进 `sources/jst/`。
- 不在重构中改业务口径。任何字段、过滤条件、分页策略**原样搬运**，
  由 `tools/parity.js` 逐条比对输出后才会切流量。
