# 失败自动修复（agent-autoloop）

定时任务失败后，不再只是发一条飞书告警：先交给本机 Agent 排查，能修的自己修，
修不了的才找人。

## 先说结论：之前为什么一直在报警

老的自修链路从 **2026-10-28 17:07** 起就已经死了：

```
codex_api::endpoint::responses_websocket:
  failed to connect to websocket: HTTP error: 401 Unauthorized
```

`codex login status` → `Not logged in`。也就是说 `var/failure-repair/runs` 里
**387 次运行、554 个 401** 全都没干活，每一次失败都白等 30 分钟，最后原样推到飞书。
你收到的那一堆告警，根因在这里，不是任务本身天天坏。

> 换框架解决不了这个问题。**Agent 没登录，换谁编排都是 401。**
> 所以这次用的是本机已经登录的 `pi`，不是 Codex。

## 现在的链路

```
定时任务失败
   │
   ├─ scripts/*.sh            → bin/xdr-failure-alert.js
   └─ launchd 巡检（10 分钟）  → src/failure-watch.js
                │
                ▼
        queueFailure()            写 outbox（脱敏，0600）
                │
                ▼
        deliverAlert()
                ├─ 派单 POST http://127.0.0.1:3350/v1/events
                │      Bearer <来源密钥>
                │      type = task.failed.<项目>
                │
                └─ 派单成功 → 30 分钟内压住飞书
                   派单失败 → 立刻照常发飞书（自修不能吞掉告警）
                                │
                                ▼
                     agent-autoloop 规则匹配
                                │
                                ▼
              pi --print "<提示词 + 事件资料>"（在出事项目的目录里）
                                │
                    ┌───────────┴───────────┐
                    ▼                       ▼
              自己修完                要人恢复登录
          第一行写结论            第一行写「待你处理：…」+ 卡片
```

## 两类失败，两条路

不是所有失败都该叫 Agent。**店铺掉线（工作台里的抖店会话失效）只能人工扫码**，
派 Agent 过去它也只能回一句"要你处理"，纯烧 Token。所以在派单之前就分流：

| 失败类型 | 判定 | 处理 |
|---|---|---|
| 店铺掉线 | 原因里含「需在工作台重新登录」或 `needs_login` | **不派 Agent**，立刻推飞书，同一原因一小时内只推一次 |
| 其他全部（含聚水潭登录态失效） | 其余 | 派 Agent 自修 |

聚水潭的 `not_logged_in` / `invalid_callback` **不算**店铺掉线——那套登录态有
`refresh-jst-auth.mjs` 能自动恢复，本来就该交给 Agent。

判定集中在 `src/failure-alerts.js` 的 `needsHuman()`：命中就让 `repair_key = null`，
`deliverAlert` 直接走飞书；没命中的才写 `repair_key = 'autoloop'` 去派单。

## 组件

| 组件 | 位置 |
|---|---|
| 中台 | `~/.agent-autoloop`（launchd: `agent-autoloop`，端口 3350） |
| 规则 | `~/.agent-autoloop/rules.json`（示例见 `ops/agent-autoloop/rules.example.json`） |
| Agent | `pi --print {prompt}`（本机已登录） |
| 处理手册 | `~/.agents/skills/shopdesk-ops/SKILL.md`（源文件在 `ops/skills/`） |
| 派单配置 | `~/Library/Application Support/shopdesk/agent-autoloop.json`（0600，含来源密钥） |
| 告警配置 | `~/Library/Application Support/shopdesk/alert-webhook.json`（飞书，未变） |

### 规则怎么分

按项目一条，`type` 为 `task.failed.<项目名>`，项目名与映射沿用
`~/xdr-sync-agent/config/failure-repair.json` 的 `tasks` 规则，**只有一处映射，不会漂移**。

| Agent | 用在 | 原因 |
|---|---|---|
| `fixer`（access: edit） | 有测试、能自证的项目 | 改完必须跑测试 |
| `advisor`（access: read） | `shopdesk-aftersale`、`doudian-daily` | 老配置里 `autoApply: false`，只让它查、不让它改 |

## 成本控制

同一任务 + 同一原因，**一小时内只派一次**。
派单 id = `任务名 + sha256(任务+原因) 前12位 + 小时`，中台按 id 去重。

不加这条的话，「3 家店要扫码」这种修不了的失败每 30 分钟唤醒一轮 Agent，
一天 48 轮纯烧 Token。

## 怎么验证

```bash
agent-autoloop status                  # 在跑/排队/最近几轮
agent-autoloop why 1                   # 某一轮为什么跑、结果是什么
agent-autoloop rules explain           # 规则生效情况

# 走真实告警入口（会写真实 outbox，验证完记得删记录）
node ~/xdr-sync-agent/bin/xdr-failure-alert.js \
  --task sync_selftest --reason "连通性自检，请只回复结论"
```

## 怎么停

```bash
# 只停自修，保留飞书告警
mv ~/Library/Application\ Support/shopdesk/agent-autoloop.json{,.off}

# 整个中台停掉
agent-autoloop service remove
```

`agent-autoloop.json` 不在位时，代码自动退回原来的 Codex 队列，行为与改造前一致。

## 已知限制

1. **需要人扫码/改密码的失败修不了**。聚水潭密码超期、抖店店铺掉线，Agent 只能发卡片。
2. **飞书仍在 30 分钟后兜底**。Agent 修好了也不会撤销已排队的告警——
   这是有意的：宁可多收一条，也不能因为自修误判而丢掉真实故障。
   想彻底消掉，需要让 Agent 在修好后回写 outbox，属于下一步。
3. **Token 不上报**。`pi --print` 不是专用插件，中台统计里 Token/费用是空的。
