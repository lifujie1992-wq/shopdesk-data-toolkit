# 新增一个脚本

目标：**新脚本一生成就落在对的位置**，不需要事后搬家。

## 三步

```bash
cd ~/projects/shopdesk-data-toolkit

# 1. 建骨架（自动出现在 `jst <名字>` 里，不用改分发器）
npm run new -- jst crypto-report --desc "加密行情日报"

# 2. 写业务：只改这一个文件
$EDITOR sources/jst/src/crypto-report/index.js

# 3. 验证
node sources/jst/bin/jst.js crypto-report --help
npm test
```

## 为什么不用注册

约定：`sources/jst/src/<命令名>/index.js` 导出

```js
export const name = "crypto-report";      // 命令名
export const description = "加密行情日报";  // 出现在 jst --help
export async function run(args) { … }     // 返回的数据会被输出成 {"ok":true,"data":…}
```

`sources/jst/src/registry.js` 启动时扫这个目录，**放进来自动注册**。
所以不存在「加了脚本忘了接线」，也不会两条命令抢一个名字
（显式注册的 `orders`/`sales`/… 优先，重名会在 `new` 里提醒你换名）。

## 写业务时的硬性约定

| 事项 | 怎么做 |
|---|---|
| 参数 | `parseFlags()`，别自己写 `indexOf('--x')` |
| 认证 | `loadSession()`，别自己读 Keychain / cookie |
| HTTP | `createJstTransport()`（自带限流、访问上限、静默时段） |
| 落库 | `resolveDataPath('jst/<名字>', 'x.sqlite')`，别写死 `~/x.sqlite` |
| 原子写 | `atomicBuild()`，别直接 `new DatabaseSync(目标路径)` |
| 错误 | `throw new CliError(code, msg)`，外层会转成标准 JSON |
| 失败告警 | 不用管。任务失败会自动进告警 + 自修链路 |

## 必须有的

- `README.md`：用途、入口、**数据落位**、认证方式、定时、字段口径。
  `new` 会生成模板，空着的地方要填。
- `test/`：至少一个用例。纯函数优先，网络/数据库用注入的 fake。
  没有测试的脚本不允许 `git commit`（见下）。

## Python 脚本

抖店侧（`doudian`）还没迁完，暂时：

```bash
npm run new -- doudian invoice-check --desc "发票状态核对"
```

会生成 `sources/doudian/src/invoice-check/`，但**不会**自动注册成命令。
等阶段 5 把 `sources/doudian/bin/doudian.py` 建起来再接。

## 禁止

- 不要在 `~`、`~/dev`、`~/Desktop` 里新建脚本文件。
- 不要复制一份 `session.js` / `errors.js` / `fetch` 包装进新模块——用 `@shopdesk/core`。
- 不要把凭据、cookie、SQLite、导出的 jsonl 提交进仓库（`.gitignore` 已挡，别绕过）。

## 检查仓库外有没有长出来的脚本

```bash
npm run audit                 # 只报告，不动
npm run audit -- --json       # 给 CI / 定时任务用
npm run audit -- --apply --yes  # 复制进仓库，并在原位置留软链
```

`--apply` 的行为是「复制 + 把原文件换成指向仓库的软链」，
所以 `node ~/xxx.js`、launchd 里写死的绝对路径都还能跑。
默认不执行，是因为挪动正在跑的文件风险高。

## 想让它更自动

把巡检挂成每周任务，发现漂移就发告警（会走已有的自修链路）：

```xml
<!-- ~/Library/LaunchAgents/com.shopdesk.repo-audit.plist -->
<key>ProgramArguments</key>
<array>
  <string>/bin/bash</string>
  <string>-lc</string>
  <string>cd ~/projects/shopdesk-data-toolkit && npm run audit || node ~/xdr-sync-agent/bin/xdr-failure-alert.js --task repo-drift --reason "仓库外出现新脚本，运行 npm run audit 查看"</string>
</array>
<key>StartCalendarInterval</key>
<dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>10</integer></dict>
```

`repo-drift` 会按 `^sync_` 之外没有映射的规则落到 `xdr` 项目，Agent 会去读 `npm run audit` 的结果。
如果你不想让它自动动手，就把这条任务换成纯通知。
