# 迁移计划

原则：**并行建新、旧的不动、逐条对拍、软链切换、观察回滚。**
全程不出现「改一半不能用」的状态。

## 阶段 0：冻结（✅ 2026-11-06）

- 产出 `docs/AUDIT.md`、`docs/ARCHITECTURE.md`、仓库骨架。
- 不改动任何现有文件，26 个 launchd 任务照常跑。

## 阶段 1：core 落地（✅ 2026-11-06）

- `packages/core` 落地：`errors` / `date` / `paths` / `session` / `jst-transport` /
  `sqlite` / `cli` / `doctor`，全部从旧代码提取，行为对齐。
- `jst doctor` 实测：Node 24.20.0、`node:sqlite` 可用、`~/shopdesk-data` 可写、
  Keychain `com.xx-cli.jst-inventory` 3/3 cookie 可读、session 解析成功。
- `orders` 已迁移，对拍结果见下。

### 对拍记录：`jst orders`（2026-11-05 数据）

| 用例 | 结果 |
|---|---|
| `count --days 1` | 输出字节级相同 |
| `login-status` | 输出字节级相同 |
| `summary` | 输出字节级相同 |
| `list --limit 3` | 输出字节级相同 |
| `sync-sqlite --days 1` | 表/列(53)/索引/行数(2834) 全同 |
| 逐行内容比对 | `--sort-list skus` 后 **0 差异** |

> `skus` 字段是聚水潭返回的逗号分隔项，**顺序每次请求都不同**。
> 旧实现自己连跑两次，2834 行里有 105 行 `skus` 顺序不一致 —— 上游抖动，非回归。

## 阶段 2 结果：聚水潭 Node 侧全部迁完（✅ 2026-11-06）

| 命令 | 迁移方式 | 验收 |
|---|---|---|
| `jst orders` | 重写为 `src/orders.js`（用 core 传输/落库） | 字节级对拍 + 2834 行×53 列 |
| `jst sales` | 重写为 `src/sales.js` | 77 行、schema/索引/视图全同 |
| `jst inventory` | 12 源文件原样搬迁，`errors`/`chrome-session` 上收 core | **91 个单测全过** + CLI 对拍 |
| `jst order-page` | 6 源文件原样搬迁，`CliError` 上收 core | **17 个单测全过** + CLI 对拍 |
| `jst aftersales` | 2 源文件原样搬迁 | **18 个单测全过** + help 对拍 |
| `jst refund` | `export-refund-daily.mjs` 参数化入口 | 入口打通（未真实导出） |

合计 **126 个单元测试 0 失败**。

搬迁过程中发现并修正的隐式耦合（审计时没看出来，靠测试才暴露）：

1. `aftersales/src/session.js` 动态 import 了兄弟项目
   `../../jushuitan-order-page/src/bridge.js` → 改为同仓库内相对路径。
2. 同一文件还 import 了 `../../xdr-sync-agent/scripts/{login-jst-saved,refresh-jst-auth}.mjs`，
   `export-refund-daily.mjs` 静态 import 了 `../xdr-sync-agent/src/failure-alerts.js`
   → 统一改为按家目录锚定（`~/xdr-sync-agent/...`），xdr-sync-agent 继续作为独立项目。
3. `export-refund-daily.mjs` 的 `IMPORTER` 指死了 `~/jushuitan-aftersales/import-refund-export.py`
   → 改为 `import.meta.dirname`，脚本随仓库走。
4. `order-page` 的 bin 用 `parseArgs()` 默认读 `process.argv`，被 `jst` 调用时会拿错参数
   → 显式传 `args: argv`；独立运行检测用 `realpathSync` 比较（旧命令是软链）。

**真实抓取对拍（2026-11-06 补完）**：

`jst aftersales sync` 已用 2026-11-05 全量数据做完对拍（写 `/tmp`，未碰生产库）：

| 项 | 旧 | 新 |
|---|---|---|
| 主表行数 | 41102 | 41102 |
| 商品明细行数 | 46238 | 46238 |
| 主表列数 | 82 | 82（schema 全同） |
| 明细逐行差异 | — | **0** |
| 主表逐行差异 | — | 仅 `商家剩余处理时长`/`售后更新时间`（实时倒计时） |

> 首次跑出 41103 / 41102 的 1 行差，是 4 分钟内上游一条淘宝售后单
> （621168709，“待确认”）发生了状态变更；旧实现重跑第二次也是 41102。
> 旧 vs 旧 的对照组差异（1537 行）比新 vs 旧（768 行）还大 —— 纯上游抖动。

`jst refund` 只验证了入口与失败路径（两边输出、退出码完全一致）。
**真实导出未跑**：它会创建导出任务、下载 xlsx 并向云端发布，不便拿来试。
下次 07:00 定时任务跑完后，可用同一份 xlsx 手工核对一次。

## 阶段 2：聚水潭逐命令迁移（风险从低到高）

顺序按「依赖少、调用方少」排：

1. `orders`（无 OpenBridge、无 Chrome、参数最规整）
2. `sales`
3. `purple`
4. `profit`
5. `inventory`（Chrome cookie 解密要一起搬）
6. `aftersales`（OpenBridge + Chrome target，最复杂）
7. `order-page`（OpenBridge）

每个命令的验收标准（缺一不可）：

```bash
# a. 帮助与参数
jst <cmd> --help

# b. 登录态
jst <cmd> login-status

# c. 对拍：同一天、同一参数，新旧输出 JSON 深比较
node tools/parity.js --old jst-orders --new "jst orders" --args "count --days 3"

# d. 落库对拍：行数、列名、主键、抽样 20 行的字段值
node tools/parity.js --db old.sqlite --db new.sqlite --table order_details
```

`parity.js` 只要有一处不一致就非零退出，**不允许「差不多就行」**。

## 阶段 3：原路径变 shim

旧命令不删，改成转发器，保证 launchd、xdr-sync-agent、手工脚本零改动：

```js
#!/usr/bin/env node
// 兼容层：jushuitan-order-details/bin/jst-orders.js
import { spawnSync } from "node:child_process";
const r = spawnSync("jst", ["orders", ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
```

`~/.local/bin/jst-orders` 这个软链也可以直接指向新 `jst` 的 `orders` 入口。

## 阶段 4：数据目录迁移

1. 建 `~/shopdesk-data/{jst,doudian}/…`。
2. `rsync` 旧 SQLite 过去（停机 0 秒，只读副本）。
3. 旧路径改成指向新位置的软链 —— 此时**新旧代码都能正常读写同一份数据**。
4. 观察 7 天，确认没有进程还在写旧路径：
   ```bash
   lsof ~/jst-order-details.sqlite   # 应为空（只剩软链解析后的新 inode）
   ```
5. 删软链、删旧文件。

## 阶段 5：抖店 Python 侧

- 先拆 `doudian-daily/doudian_sync.py`、`doudian_client_sync.py`：
  确认哪个在跑（查 launchd + `.zsh_history`），只迁活的，其余进 `_legacy/`。
- `doudian.py` 的两份分叉合并成 `sources/doudian/client.py`，
  用 `metrics_contract.json` 做回归基准（107 字段逐个比对）。
- `invoice*.py` 与 `projects/invoice-mac-agent` 二选一，保留能跑的那个。

## 阶段 6：定时任务收敛

- `schedules/*.plist.tpl`：路径用 `{{HOME}}`、`{{NODE}}`、`{{CLI}}` 占位。
- `schedules/install.sh` 渲染 + `launchctl bootstrap`；`uninstall.sh` 反向。
- 一次性把 4 种前缀统一成 `com.shopdesk.`。
- 清理 `.bak-*` 到 `_legacy/`。
- 修掉当前退出码非 0 的 3 个任务。

## 阶段 7：归档

```
~/_legacy/2026-11/
├── jushuitan-*/
├── doudian-daily/
├── projects/shopdesk-data-toolkit/
├── *.zip / *.bak-* / appeal*.js
└── MANIFEST.md      ← 每个目录对应新位置的映射
```

保留 30 天，确认无遗漏后删除。

## 回滚

任一阶段出问题：

```bash
schedules/uninstall.sh          # 停新任务
git -C ~/projects/shopdesk-agents checkout .   # 代码回滚
mv ~/_legacy/2026-11/jushuitan-order-details ~/   # 目录还原
ln -sfn <old> ~/jst-order-details.sqlite          # 数据还原
```

因为阶段 3 之前旧的**从未改动**，回滚成本为 0。

## 时间与风险

| 阶段 | 预计 | 风险 | 可控性 |
|---|---|---|---|
| 1 core | 半天 | 无 | 纯新增 |
| 2 orders/sales | 1 天 | 低 | 有对拍 |
| 2 inventory/aftersales/order-page | 2–3 天 | 中（Chrome 解密、OpenBridge） | shim 兜底 |
| 5 doudian | 1–2 天 | 中（分叉版本判断） | 合约比对 |
| 6 定时任务 | 半天 | 中（漏任务） | 逐个 `launchctl` 核对 |

**唯一真正的风险**是「漏掉一个没人记得的调用方」。缓解手段：

```bash
# 迁移前先摸清谁在调旧命令
grep -rl "jst-orders\|jst-sales\|daily_collect" \
  ~/Library/LaunchAgents ~/xdr-sync-agent ~/.zsh_history ~/projects 2>/dev/null
```
