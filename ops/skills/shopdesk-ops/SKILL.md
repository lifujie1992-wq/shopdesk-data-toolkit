---
name: shopdesk-ops
description: 店铺取数与同步任务失败时的自动排查与修复手册。用于处理聚水潭 / 抖店 / 发票 / 佣金率 / 月度账单等定时任务报错，判断哪些能自己修、哪些必须让本人恢复登录。
---

# 店铺取数任务自修手册

这台 Mac 上跑着一整套「取数 → 落库 → 上云」的定时任务。事件里给你的是一次任务失败的告警，
你的活是：**查清真实原因 → 能修就修掉 → 修不了就交给本人**。

## 先搞清楚状况

1. **你所在的目录就是出事的那段代码**。改代码只改这里，不要跨项目改。
2. 事件资料里有一段脱敏后的告警正文，含任务名、失败时间、原因、日志路径。
   先按日志路径读原文，再判断；告警正文只是线索，不是结论。
3. 常用位置：

| 看什么 | 在哪 |
|---|---|
| 任务最近状态 | `~/Library/Application Support/xdr-sync-agent/status.json` |
| 同步任务日志 | `~/Library/Logs/xdr-sync-agent/` |
| 聚水潭登录态自检 | `node ~/projects/shopdesk-data-toolkit/sources/jst/bin/jst.js doctor` |
| 聚水潭会话是否有效 | `node ~/projects/shopdesk-data-toolkit/sources/jst/bin/jst.js auth status` |
| 历史同类故障 | `~/projects/shopdesk-data-toolkit/docs/INCIDENTS.md` |
| 迁移与口径 | `~/projects/shopdesk-data-toolkit/docs/MIGRATION.md` |

> 注意：生产仍在跑老的 `~/jushuitan-*`、`~/doudian-daily` 目录，
> `~/projects/shopdesk-data-toolkit` 是重构后的新仓库。两个都在，别搞混。

## 常见失败与处置

| 现象 | 真实原因 | 你该做什么 |
|---|---|---|
| `invalid_callback` / `not_logged_in` / `session_expired` | 聚水潭浏览器会话失效 | 跑 `node ~/xdr-sync-agent/scripts/refresh-jst-auth.mjs`；成功就完事 |
| 上面这条命令返回 `login_verification_required` / `saved_login_failed` / `saved_login_autofill_missing` | Chrome 里密码没自动填充，或需要短信/图形验证 | **只能本人**：请他在 Chrome 打开 erp321.com 手动登录一次。用 ask 卡片 |
| `order_page_required` / 订单页读不到 | 订单页标签页失效 | 同上 refresh 脚本会重建；仍失败则 ask |
| `需要重新登录` / `needs_login`（抖店多店） | 某几家店在工作台里掉线 | 这类事件**正常不会派到你这里**（派单前已分流成直接告警）。真收到了说明判定漏了：核实后按“待你处理”收尾，别改代码 |
| `cloud_transport_failed` | Mac 刚唤醒、网络没就绪，SSH 失败 | 已加重试；偶发不必动。稳定复现才查网络与 `~/.ssh/xdr_mac` |
| 退款导出 `生成文件失败` | 聚水潭那边导出任务失败 | 先看是不是搜索区间没数据（换一天验证）；是上游问题就 ask，别改代码 |
| 发票 / 月度账单失败 | 页面结构变化或文件缺失 | 只读排查，给出结论和建议；这两个项目**不要自动改文件** |
| 抖店指标缺字段 | 接口改版 | 先确认是不是 `metrics_contract.json` 里的口径问题，再动代码 |

## 两条红线

1. **不改凭据**。不读、不打印、不写 cookie / token / webhook 地址 / 私钥。
   看到告警正文里有类似字串，当它不存在。
2. **不动数据**。不删、不覆盖 `*.sqlite`、`~/shopdesk-data`、`var/` 下的历史记录。
   要验证只读行为，用 `--output /tmp/xxx` 之类的一次性路径。

再加三条：

- 不 `git push`、不 `git reset --hard`、不切分支。改动留在工作区，让人自己看。
- 聚水潭是真实后台。**一次只做一次读请求级别的验证**，不要跑全量导出。
  当前时间在 23:00–07:00 之间时，不要触发任何聚水潭自动化请求。
- 一次只修一个失败，不顺手重构、不格式化整个文件。

## 怎么算修好

按这个顺序，做到哪一步算哪一步：

1. 能跑测试的项目，跑它的测试（例：`node --test`、`node --test test/*.test.js`、
   `.venv/bin/python -m pytest -q tests`）。**测试不过就把自己的改动撤回**，
   然后当“没修好”处理。
2. 幂等的读命令可以重跑一次确认（例：
   `node ~/projects/shopdesk-data-toolkit/sources/jst/bin/jst.js orders count --days 1`）。
3. 有副作用的命令（导出、上传、发布）**不要重跑**。看日志确认上一次到底走到哪一步即可。

没验证过的不要写成已修复。

## 收尾

- 修好了：第一行一句话说清“哪里坏了、改了什么、怎么验证的”。
- 修不了、要本人动手：第一行写 `待你处理：<具体原因>`，
  然后用 ask 写清楚：出了什么事、要他做什么、做完之后会怎么继续。
  同一件事已经有一张 open 卡片就不要再发一张。
- 什么都没做（比如偶发抖动、已自愈）：第一行写 `没事可做：<原因>`。
- 不写“没跑成”来糊弄——那是留给真正可以自动重试的临时失败的。
