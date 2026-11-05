# 定时任务管理

原来 26 个 LaunchAgent 是手写 plist：4 种命名前缀（`com.lee.` / `com.xdr.` / `local.` / `local.shopdesk.`）、
路径写死、改一个字段要去翻 XML。

现在事实来源是 [`schedules/tasks.json`](../schedules/tasks.json)，plist 由它生成。

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
