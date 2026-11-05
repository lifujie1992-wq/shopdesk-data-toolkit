# 定时任务管理

原来 26 个 LaunchAgent 是手写 plist：4 种命名前缀（`com.lee.` / `com.xdr.` / `local.` / `local.shopdesk.`）、
路径写死、改一个字段要去翻 XML。

现在事实来源是 [`schedules/tasks.json`](../schedules/tasks.json)，plist 由它生成。

## 工作台（能看耗时、能自己改）

**http://127.0.0.1:4173** —— 已装成常驻服务（`com.shopdesk.workbench`），Mac 登录后一直在。

### 一级是看板

打开就是全量任务卡片，一屏看清「它是什么 / 几点跑 / 多频繁 / 耗时多少 / 下次什么时候」：

```
┌──────────────────────────────────────┐
│ ● doudian-daily        [已加载]       │
│ 抖店经营指标采集（11 步 / 107 字段）    │
│  时间  每天 08:30      频次  1 次/天   │
│  耗时  中位 42.3 s     下次  明天 08:30 │
│  [编辑] [运行一次]                     │
└──────────────────────────────────────┘
```

顶部 5 个统计：任务总数 / 运行中 / 有异常 / 每天触发次数 / 清单与系统不一致。
筛选：有异常 · 运行中 · 已停用 · 未迁 label；支持搜索。

### 状态标签什么意思

launchd 用 **label** 当任务唯一标识。历史上有 4 种前缀（`com.lee.` / `com.xdr.` / `local.` / `local.shopdesk.`），
重构后统一成 `com.shopdesk.*`，但**系统里装的还是旧的**，所以卡片上会出现两种状态：

| 标签 | 含义 |
|---|---|
| `已加载` | 新 label `com.shopdesk.*` 已经装进 `~/Library/LaunchAgents` |
| `已加载（旧 label）` | 旧 label 还在跑，功能正常，只是名字没统一 → 同时标 `待迁移` |
| `未安装` | 系统里根本没有这个任务（新老 label 都没有） |
| `运行中` / `运行中（旧 label）` | 此刻有进程在跑 |
| `退出 N` | 上一次跑完退出码是 N（正数才算失败） |
| `已停用` | 清单里 `enabled: false`，且系统里也没装 |
| `已停用·但系统里还在跑` | 清单里停用了，但没执行过 install，旧 plist 仍在触发 |

> `-15` 之类的负数退出码是 SIGTERM（常驻进程重启时被杀），不算异常，看板会忽略。

所以「待迁移」不影响功能——**26 个任务现在都是用旧 label 在正常跑**，
只是清单和系统名字对不上。想统一：`npm run schedule -- install --all`。

### 二级才是编辑

点卡片上的 **编辑** 才进入编辑视图（整页），改完点 **保存** 回看板。
`Esc` 返回，`⌘S` 保存，有未保存改动会拦你。

编辑视图四块：它是什么 / 什么时候跑 / 跑什么 / 耗时。
底部动作：保存 · 安装到 launchd · 卸载 · 运行一次 · 删除。

### 耗时是怎么来的

launchd 不记录执行时长，所以给需要计时的任务套了一层
`tools/run-task.js`：读清单里的命令、跑一遍、把
`{开始, 结束, 耗时, 退出码, 来源}` 追加到 `var/schedule-runs.jsonl`，原样返回退出码。

- `"track": true` 的任务，`install` 时 plist 的 ProgramArguments 换成 `node tools/run-task.js <名字>`
- 常驻进程没有「跑完」的概念，不包装、不计时
- 没装到 launchd 也能点「运行一次」，一样记耗时
- 副作用：命令/cwd/env 从清单实时读，**改完清单不用重装**；改**触发时间**仍要 `install`

### 安全

- 只监听 `127.0.0.1`
- 接口要 `x-workbench-token`；token 持久化在 `var/workbench.token`（0600），服务重启不影响已打开的页面
- 保存前校验名字、命令、触发方式、时间范围，不合法直接拒绝并说明原因
- 每次保存备份到 `var/backups/tasks-<时间>.json`

## 看板

```bash
npm run board            # 生成 docs/schedules.html（自包含，离线可开）
npm run board -- --open   # 生成并打开
npm run board -- --json   # 只要数据，给监控用
```

数据全部取真：清单 + `launchctl list` + 日志文件状态。看板内容：

- 6 个统计：任务数 / 已安装 / 常驻 / 24 小时触发次数 / 退出码非零 / 清单漂移
- **接下来 24 小时的按小时密度**——用来看有没有撞在同一分钟
- 任务明细（可搜索）：触发规则、下次运行、运行状态、日志体积与最后写入
- 需要注意：真问题逐条列出，漂移单独汇总

看板是快照，不会自动刷新；重新生成即可。

## 命令

```bash
npm run schedule -- list                    # 清单：触发时间 + 说明
npm run schedule -- plan                    # 清单 vs 系统实际状态，差在哪（有差异时退出码 1）
npm run schedule -- status                  # 同上
npm run schedule -- render <name>           # 打印将要写入的 plist
npm run schedule -- install <name> [--dry-run]
npm run schedule -- install --all
npm run schedule -- uninstall <name>
npm run schedule -- import                  # 把现有 LaunchAgents 反推成清单
```

## 清单长这样

```json
{
  "name": "doudian-daily",
  "label": "com.shopdesk.doudian-daily",
  "legacyLabel": "com.lee.doudian-daily",
  "description": "抖店经营指标采集（11 步 / 107 字段）",
  "command": ["/usr/bin/python3", "~/doudian-daily/daily_collect.py"],
  "cwd": "~/doudian-daily",
  "calendar": [{ "hour": 8, "minute": 30 }],
  "log": "~/doudian-daily/data/cron.log",
  "enabled": true
}
```

支持的字段：

| 字段 | 含义 |
|---|---|
| `command` / `cwd` | 必填。`~` 在渲染时展开 |
| `calendar` | `[{minute,hour,day,weekday,month}]`，数组即多个触发时刻 |
| `interval` | 每 N 秒 |
| `keepAlive` / `runAtLoad` | 常驻 / 加载即跑 |
| `env` | 环境变量。**PATH 要写全绝对路径**，launchd 的默认 PATH 很短 |
| `processType` / `throttleInterval` | 低优先级、崩溃后最快多久重启 |
| `log` / `errorLog` | 合并或分开 |
| `extra` | 上面没建模、但影响行为的键（`Nice`、`Umask`、`LowPriorityIO`、`ExitTimeOut`…），原样透传 |
| `legacyLabel` | 旧 label。`install` 会先把它 bootout 再装新的，避免双份执行 |

## 迁移已完成（2026-11-06 03:15）

26 个任务全部从旧 label 切到 `com.shopdesk.*`，旧 plist 已删除。

```
com.shopdesk.* 已加载        26
残留旧 label                0（只剩手工任务 com.xdr.manual-replay-20261017）
plan                        清单与系统一致
```

切换后实际跑过的任务（走计时包装，全部 exit 0）：

| 任务 | 次数 | 最近耗时 |
|---|---|---|
| failure-watch | 4 | 8.6 s |
| invoice-mac-agent | 2 | 43 ms |
| aftersale-push | 1 | 97 ms |
| sync-agent-cleanup | 1 | 368 ms |

四个常驻进程（sync-agent / profit-facts / openbridge / workbench）全部起来，退出码 0；
OpenBridge 的 Chrome 扩展在守护重启后约 1 分钟自动重连。

### 回滚

切换前把 36 个文件备份到了 `var/backups/launchagents-<时间>/`（含 tasks.json）：

```bash
B=var/backups/launchagents-20261106-031400
for f in "$B"/*.plist; do
  launchctl bootout "gui/$(id -u)/$(basename "$f" .plist)" 2>/dev/null
done
cp "$B"/*.plist ~/Library/LaunchAgents/
for f in "$B"/*.plist; do
  launchctl bootstrap "gui/$(id -u)" "$f"
done
rm -f ~/Library/LaunchAgents/com.shopdesk.*.plist   # 清掉新 label
```

## 安全迁移路径

```bash
# 1. 先看差异，什么都不会改
npm run schedule -- plan

# 2. 挑一条低风险的试
npm run schedule -- install summary --dry-run
npm run schedule -- install summary

# 3. 观察一两天没问题，再全量
npm run schedule -- install --all
```

`install` 会：bootout 旧 label → 写新 plist → bootstrap → 删旧的 `legacyLabel`.plist。
`plan` 会把「旧 label 还在」单独标出来，所以不会出现新旧同时跑却没发现。

## 两个已经踩过的坑

**1. PATH 不能只展开开头一个 `~`。**
`failure-repair` 的 PATH 是 `/Users/xxx/.local/bin:/Users/xxx/.local/bin:/usr/bin:…`
（HOME 出现两次）。导入时把 HOME 替换成 `~`、渲染时只展开开头的 `~`，
第二个就变成了字面量 `~/...`，PATH 直接少一段。所以 `env` 里保留绝对路径，不做 `~` 替换。

**2. 别丢失没建模的 launchd 键。**
导入时如果只挑认识的字段，`Nice`、`Umask`、`LowPriorityIO`、`ExitTimeOut` 就没了——
这些会实际改变调度行为（比如 `invoice-capture-cleanup` 的 `Nice: 10`）。
所以未识别的键统一进 `extra` 原样写回。

验证方式：26 条逐个 `render` 出来和线上原 plist 做语义对比，除 `Label` 与 `RunAtLoad:false` 外全等。

## 还没做的

- 没有自动安装（`install` 必须点名或 `--all`）。
- 没有做「任务跑失败自动禁用」，失败交给告警 + 自修链路。
- `com.xdr.manual-replay-20261017` 是手工临时任务，不在清单里，`plan` 会把它列在「清单外」。

## 体检结论（2026-11-06）

跑完看板后的真实数字：**26 个任务，24 小时共触发 5013 次**，其中 4320 次来自三个
60 秒任务（`failure-watch`、`invoice-mac-agent`、`failure-repair`）。

### 已经改掉的

| 问题 | 处理 |
|---|---|
| `failure-repair` 每 60 秒起一次，但 Codex 未登录，**1440 次/天纯空转** | 清单里 `enabled: false`，`install --all` 会 bootout 并删除旧 plist |
| `douyin-settle-recon.monthly` 名字是月度，实际还挂了 `StartInterval 3600`，**每小时空检查一次**（日志里全是 `no monthly cycle due`） | 去掉 interval，只保留每月 1 日 01:00 |
| `failure-watch` 的描述写成"每 10 分钟"，实际是 60 秒 | 描述改正 |
| 日志从不轮转：`openbridge 43 MB`、`invoice 14 MB`、`aftersale 4.9 MB`、`failure-watch 2.9 MB` | 新增 `ops/newsyslog.shopdesk.conf`，装到 `/etc/newsyslog.d/` 即可 |

### 查过但不是问题的

- **两个 `sync-agent` daemon 不是重复**：`sync-agent-profit-facts` 挂了
  `XDR_AGENT_CONFIG` 指向另一份配置，是有意的双实例。已在清单描述里写清区别。
- **`invoice-mac-agent` 每 60 秒**：是轮询 worker，没活时立刻退避退出（日志 `reason: backoff, processed: 0`），
  属于设计行为。真要省，可以改成 5 分钟，但会拉长发票处理延迟。
- **撞点 0 处**：日历类任务没有落在同一分钟的。

### 还可以做，但没动

- 三个 60 秒任务的频率（4320 次/天）。`failure-watch` 可以降到 5 分钟，
  代价是失败发现变慢；这是业务取舍，不该我替你定。
- 日志轮转没装：`sudo cp ops/newsyslog.shopdesk.conf /etc/newsyslog.d/shopdesk.conf`。
