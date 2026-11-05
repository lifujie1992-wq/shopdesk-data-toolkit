---
name: shopdesk-new-script
description: 新增或搬运取数/抓取/同步脚本时使用。用于把新脚本落到 shopdesk-data-toolkit 仓库的正确位置、复用 @shopdesk/core、补 README 与测试，避免又散落在家目录。
---

# 新增脚本必须落在仓库里

仓库：`~/projects/shopdesk-data-toolkit`

**不要在家目录、`~/dev`、桌面新建脚本文件。** 一律走脚手架，落到 `sources/` 下。

## 标准动作

```bash
cd ~/projects/shopdesk-data-toolkit
npm run new -- jst <kebab-case-name> --desc "一句话说明取什么数、干什么用"
```

生成的三个文件都要填：

| 文件 | 要求 |
|---|---|
| `sources/jst/src/<name>/index.js` | 业务唯一入口；导出 `name` / `description` / `run(args)` |
| `sources/jst/src/<name>/README.md` | 用途、入口、数据落位、认证方式、定时、字段口径 |
| `sources/jst/src/<name>/test/*.test.js` | 至少一个用例 |

建完目录**自动注册**成 `jst <name>`（`sources/jst/src/registry.js` 扫描），
不需要改 `bin/jst.js`。验证：

```bash
node sources/jst/bin/jst.js <name> --help
npm test
```

## 写业务只能这样

```js
import { CliError, parseFlags, loadSession, createJstTransport,
         resolveDataPath, atomicBuild } from "@shopdesk/core";
```

- 参数：`parseFlags`，不要手写 `args.indexOf('--x')`
- 认证：`loadSession()`，不要自己读 Keychain / cookie / Chrome 分区
- HTTP：`createJstTransport()`，自带限流、访问上限、静默时段
- 落库：`resolveDataPath('jst/<name>', 'x.sqlite')`，不要写死 `~/x.sqlite`
- 原子写：`atomicBuild()`，不要对目标路径直接 `new DatabaseSync()`
- 错误：`throw new CliError(code, message)`，不要裸 `throw new Error`
- 输出：直接 `return 数据`，外层会包成 `{"ok":true,"data":…}`

## 判断放哪里

| 数据来源 | 位置 |
|---|---|
| 聚水潭（erp321） | `sources/jst/src/<name>/` |
| 抖店（jinritemai / fxg / 罗盘 / 千川） | `sources/doudian/src/<name>/`（阶段 5 前不注册为命令） |
| 跨源流水线（订单+成本→利润等） | `pipelines/<name>/` |
| 运维脚本（不取数） | `ops/` |

拿不准就选 `ops/`，并在 README 里写清为什么。

## 禁止

1. 不在仓库外新建脚本文件。
2. 不把 `session.js` / `errors.js` / fetch 包装复制进新模块——用 core。
3. 不提交 cookie、token、`.sqlite`、导出的 `*.jsonl`。
4. 不改已有的 `orders` / `sales` / `inventory` / `order-page` / `aftersales` 来塞新功能；
   新功能是新模块，需要共享的部分上提到 `packages/core`。
5. 没有测试不提交。

## 发现仓库外有脚本

```bash
npm run audit                  # 只报告
npm run audit -- --apply --yes # 复制进仓库并把原文件换成软链（默认不执行）
```

报告里「判断不出归属」的，不要自己猜，把清单交给用户定。
