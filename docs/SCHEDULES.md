# 定时任务管理

原来 26 个 LaunchAgent 是手写 plist：4 种命名前缀（`com.lee.` / `com.xdr.` / `local.` / `local.shopdesk.`）、
路径写死、改一个字段要去翻 XML。

现在事实来源是 [`schedules/tasks.json`](../schedules/tasks.json)，plist 由它生成。

## 工作台（能看耗时、能自己改）

```bash
npm run workbench          # 起服务并打开 http://127.0.0.1:4173
npm run workbench -- --port 4174 --no-open
```

左边任务列表（可搜索/筛选异常·运行中·已停用·未迁 label），右边是编辑面板：

| 卡片 | 内容 |
|---|---|
| 基本信息 | 名字、说明、label、上次退出码、下次运行 |
| 什么时候跑 | 按日历（月/日/周/时/分，留空=每）· 按间隔 · 常驻 · 仅手动 |
| 跑什么 | 命令（一行一个参数）、工作目录、日志、环境变量、启用、计时 |
| 耗时 | 中位数 / 平均 / P95 / 最长 / 次数 + 最近 20 次柱状图 |

底部按钮：**保存**（写回 tasks.json，自动备份到 `var/backups/`）、
**安装到 launchd** / **卸载**、**立即运行一次**、**删除任务**。
保存快捷键 `⌘S`。

### 耗时是怎么来的

launchd 不记录执行时长，所以给需要计时的任务套了一层
`tools/run-task.js`：它读清单里的命令、跑一遍、把
`{开始, 结束, 耗时, 退出码, 来源}` 追加到 `var/schedule-runs.jsonl`，然后原样返回退出码。

- 清单里 `"track": true` 的任务，`install` 时会把 plist 的 ProgramArguments 换成
  `node tools/run-task.js <名字>`（常驻进程没有「跑完」的概念，不包装）
- 没装到 launchd 的任务也能点「立即运行一次」，一样会记耗时
- 副作用：命令、cwd、env 改成从清单实时读取，所以**改完清单不用重装**；
  但改**触发时间**仍然要 `install` 才会生效

### 安全

- 只监听 `127.0.0.1`
- 所有接口要 `x-workbench-token`，token 每次启动重新生成，写在 `var/workbench.token`（0600）
- 保存前校验名字、命令、触发方式、时间范围；不合法直接拒绝并说明原因
- 每次保存都把旧清单备份到 `var/backups/tasks-<时间>.json`

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
