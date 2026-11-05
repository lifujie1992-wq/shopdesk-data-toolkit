# shopdesk-agents

抖店 / 聚水潭取数与同步脚本的统一仓库。

替代原先散落在 `~` 下的 20 多个目录（`jushuitan-*` 7 个、`doudian-daily` 1 个大杂烩、
`projects/` 下 12 个），目标只有三条：

1. **基础设施写一次** —— 登录态、HTTP、限流、SQLite、CLI 骨架、错误码。
2. **一个数据源一个命令** —— `jst <sub>`、`doudian <sub>`，不再是 7 个二进制。
3. **数据落位有约定** —— `~/shopdesk-data/<source>/<dataset>/`，不再往家目录扔 1.2GB 的 sqlite。

> **仓库沿革**
> 2026-10-25 的第一版是「全量源码快照」——`components/` 下把 14 个组件的源码原样拷了一遍，
> 没做去重，所以看起来整齐但复用不了。
> 2026-11-06 起本仓库改为**真实重构**的结果：基础设施收敛到 `packages/core`，
> 聚水潭的 7 个命令行收敛成 `jst` 一个命令，每个迁移都有新旧对拍。
>
> 旧的快照仍在 git 历史里，随时可取：
> `git show 1d1c7b0:components/doudian-daily/daily_collect.py`。
> 抖店（Python）侧尚未迁移，参考实现就在那个提交里。
> `schedules/`（26 个 launchd 定义）、`config/`（环境变量示例）、
> `runtime-wrappers/`（工作台运行脚本快照）从第一版原样保留，供阶段 6 使用。

**先看这个：** [`docs/dashboard.html`](docs/dashboard.html) —— 一页看清所有脚本、用途、定时任务、重复度与迁移进度（离线可开，支持搜索）。

背景与决策见：

- [`docs/AUDIT.md`](docs/AUDIT.md) —— 原来到底有多乱（带行数/哈希/重复度证据）
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) —— 目标结构与约定
- [`docs/MIGRATION.md`](docs/MIGRATION.md) —— 分阶段迁移、对拍标准、回滚方案
- [`docs/INCIDENTS.md`](docs/INCIDENTS.md) —— 2026-11-06 三个定时任务故障的根因与修复
- [`docs/AUTO-REPAIR.md`](docs/AUTO-REPAIR.md) —— 失败自动修复链路（agent-autoloop），以及「一直报警」的真因

## 状态

| 能力 | 旧位置 | 新位置 | 状态 |
|---|---|---|---|
| 环境自检 | 无 | `jst doctor` | ✅ |
| 登录态 | 4 套实现 | `jst auth status` / `import` | ✅ |
| 订单明细 | `jst-orders` | `jst orders` | ✅ 对拍通过 |
| 销售业绩 | `jst-sales` | `jst sales` | ✅ 对拍通过 |
| 库存预警 | `jst-inventory` | `jst inventory` | ✅ 91 个测试通过 |
| 订单页 | `jst-order-page` | `jst order-page` | ✅ 17 个测试 + CLI 对拍 |
| 售后明细 | `jst-aftersales` | `jst aftersales` | ✅ 18 个测试通过 |
| 退款单导出 | `export-refund-daily.mjs` | `jst refund` | ✅ 入口 + 失败路径对拍 |
| 紫色旗 | `jst-purple-orders` | `jst purple` | ⏳ 阶段 5（与抖店同批，共用 `jst_brush.py`） |
| 利润事实库 | `build_facts.py` | `jst profit` | ⏳ 阶段 5（Python） |
| 抖店指标 / 中差评 / 发票 | `doudian-daily/*` | `doudian <sub>` | ⏳ 阶段 5 |

聚水潭（Node）侧已全部搬入，**126 个单元测试全部通过**。

**整个迁移期旧命令始终可用**，26 个 launchd 任务不需要动。

## 快速开始

```bash
cd ~/projects/shopdesk-agents
npm install --workspaces            # 只链接本地 workspace，不联网

node sources/jst/bin/jst.js --help
node sources/jst/bin/jst.js doctor          # 运行时 / 数据目录 / Keychain / 登录态
node sources/jst/bin/jst.js auth status     # 只报 cookie 名与存在性，不打印值

node sources/jst/bin/jst.js orders count --days 1
node sources/jst/bin/jst.js orders sync-sqlite --days 30
node sources/jst/bin/jst.js sales summary --date 2026-10-14
node sources/jst/bin/jst.js inventory summary
node sources/jst/bin/jst.js order-page login-status
node sources/jst/bin/jst.js aftersales sync --output /tmp/aftersales.sqlite

node --test sources/jst/*/test/*.test.js    # 126 个测试
```

## 对拍

迁移不允许靠肉眼验收。两条命令，一处不一致就非零退出：

```bash
# CLI 输出深比较
node tools/parity.js cli \
  --old "jst-orders count --days 1" \
  --new "node sources/jst/bin/jst.js orders count --days 1"

# SQLite 内容比较（表/列/索引/行数/逐行）
node tools/parity.js db \
  --old /tmp/parity-old.sqlite \
  --new /tmp/parity-new.sqlite \
  --table order_details --sort-list skus
```

`--sort-list` 抹平上游接口的字段内顺序抖动（聚水潭 `skus` 逗号分隔项顺序每次请求都不同，
旧实现自己跑两次也会有 100 多行差异，与重构无关）。

## 目录

```
packages/core/          @shopdesk/core —— 共享基础库
  src/session.js          认证抽象（keychain / json）
  src/chrome-session.js   Chrome cookie 解密 + Keychain 读写
  src/jst-transport.js    transportData 请求 + 限流 + 访问上限 + 静默时段
  src/sqlite.js           原子写 / 建表补列 / 批量 replace / 只读查询
  src/cli.js              子命令分发 + 声明式参数 + 输出契约
  src/errors.js           CliError + 脱敏 diagnostic + errorResult
  src/date.js             Asia/Shanghai 日期
  src/paths.js            数据目录唯一出口
  src/doctor.js           环境自检
sources/jst/            jst 统一 CLI
  bin/jst.js              子命令分发
  src/orders.js           订单明细
  src/sales.js            销售业绩
  inventory/              库存预警（12 源文件 + 18 测试，原样搬迁）
  order-page/             订单页（6 源文件 + 3 测试 + web 模板）
  aftersales/             售后明细 + 退款单导出 + Python 入库脚本
tools/parity.js         新旧对拍
docs/                   盘点 / 架构 / 迁移
```

## 约定

- 输出契约固定：成功 `{"ok":true,"data":…}`，失败 `{"ok":false,"error":{"code","message"}}`。
- 错误一律抛 `CliError(code, message)`，不裸抛 `Error`。
- 日期一律 Asia/Shanghai，不用本机时区。
- 导出 SQLite 一律 0600 权限 + 原子 rename。
- 敏感数据（cookie、收件人、快递单号）不打印、不入库到仓库。
