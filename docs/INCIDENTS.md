# 故障修复记录

2026-11-06 夜。三件事：两个定时任务长期失败 + 一批明文凭据。

## 1. `com.xdr.jst-auth-refresh` 连续失败（退出码 1）

### 现象

```
[2026-11-05 21:02:08] refresh done: session check failed after 3 attempts
{"ok":false,"code":"invalid_callback"}
```

每天 09:10 / 15:00 / 21:00 各三次，全部失败，从 11-04 起连续三天。

### 根因（两层，缺一不可）

**第一层：错误码没被识别**

`refresh-jst-auth.mjs` 只有这三种错误会触发「自动登录」：

```js
['not_logged_in', 'session_expired', 'order_check_failed']
```

但订单页实际抛的是第四种：`invalid_callback`
（HTTP 200 但 `LoadDataToJSON` 没有 JSONP 回调，本质就是会话过期）。
于是脚本**从来没有尝试过自动登录**，直接失败退出。

**第二层：自动登录的按钮点不中**

补上错误码后仍然失败于 `saved_login_failed`。实测发现：
`#login_id` 的坐标点击能触发 Chrome 密码自动填充，但「立即登录」按钮
位于后台标签页的**实际视口之外**，CDP 坐标点击会打空 ——
页面无任何反应，也不发请求（抓包确认 0 请求）。

改为 `scrollIntoView()` + 元素自身 `click()` 后，登录请求正常发出：

```
//api.erp321.com/erp/webapi/UserApi/WebLogin/Passport  → 200, code 0
```

### 第三个坑：密码过期弹窗

登录成功后聚水潭弹出「您的密码已经超过3个月未修改(304)」，
必须点「确定」才会跳转到 `/epaas`。该按钮同样是坐标点击，同样点不中。
一并改成 `clickInView`。

### 第四个坑：订单页标签页是登录前打开的

会话恢复后，Keychain 已更新，但**旧的订单页标签页**仍持有已失效的页面上下文，
继续返回 `invalid_callback`。
补上：读到 `invalid_callback` 时先 `bridge.refresh()` 重载订单页再读一次。

### 改动

`~/xdr-sync-agent/scripts/`
- `refresh-jst-auth.mjs`
  - 新增 `AUTH_FAILURE_CODES`（含 `invalid_callback`）
  - 新增 `STALE_PAGE_CODES` + 订单页重载后重读
- `login-jst-saved.mjs`
  - 新增 `clickInView(bridge, selector)`：滚动到可视区后用 `el.click()` 触发
  - 协议勾选 / 立即登录 / 密码提醒确认 三处改用它
  - `#login_id` 保留坐标点击（只有真实手势才会触发 Chrome 自动填充）
- `scripts/tests/`
  - `refresh-jst-auth.test.mjs` +2 用例（invalid_callback 触发自动登录、订单页重载）
  - `login-jst-saved.test.mjs` 适配新的点击方式，7 个用例保留原意

### 验证

```
$ node scripts/refresh-jst-auth.mjs
{"inventory":true,"order_page":true,"source":"OpenBridge","auto_login":false,
 "expires_at":"2026-11-15T18:58:46.578Z"}

$ launchctl kickstart -k gui/$(id -u)/com.xdr.jst-auth-refresh
launchctl list  →  -  0  com.xdr.jst-auth-refresh
日志： refresh done: all sessions healthy
```

17 个前端测试全部通过。会话已回灌 Keychain，有效期至 2026-11-15。

---

## 2. `com.xdr.douyin-commission-rates` 上传失败（退出码 1）

### 现象

```
CaptureError: cloud_transport_failed; local snapshot preserved
```

11-04、11-05 两天 05:10 的上传都是这个错。最后一次成功发布是 11-03 05:16。

### 排查

- 服务器 `47.114.33.246` 当时在线（`journalctl --list-boots`：11-02 00:51 起持续运行到 11-05 18:50）
- 现在手工复现 `remote('prepare')` → `{"ok": true, ...}`，SSH 正常
- 结论：**瞬时网络失败**，不是配置或权限问题。05:10 这个时点 Mac 可能刚从睡眠唤醒，
  网络栈未就绪，`ssh` 直接非零退出，整次采集白跑。

### 改动

`~/projects/douyin-commission-rates/src/commission_rates/publish.py`

- 新增 `_with_transport_retry()`：3 次尝试，退避 5s / 10s
- 包住 SSH 的 `remote('prepare')` / `remote('apply')` 与 `scp` 上传
- 远端 helper 的 prepare/apply 本身幂等，重放安全
- 新增 `tests/test_transport_retry.py`（重试成功 / 放弃两条用例）

### 验证

```
$ .venv/bin/python -m pytest tests -q
33 passed
```

---

## 3. 明文 cookie 落在家目录

### 现象

```
~/jst-cookie-export.json   11 KB   0600
~/jst-cookie-export.txt    2.8 KB  0600
```

10-07 导出的聚水潭会话，`u_sso_token` 明文。

### 处理

- 确认无任何活代码引用（只有历史归档/追踪快照里出现过文件名）
- 会话已在 macOS Keychain（`com.xx-cli.jst-inventory.cookie.*`），随时可用 `jst auth import` 重建
- **直接删除**，未保留备份（保留备份等于没修）

### 验证

```
$ node sources/jst/bin/jst.js auth status
{"ok":true,"data":{"source":"keychain:com.xx-cli.jst-inventory", ..., "present":{"u_sso_token":true,...}}}
```

根目录复查：无任何文件含 `u_sso_token`。

---

## 4. `local.shopdesk.aftersale-counts` 退出码 2 —— 未修复，需要人工

### 现象

```
成功=38 失败=3 待商家审核合计=6540
```

退出码 2 = `run.shops_failed != 0`，这是脚本的**预期行为**，不是 bug。

### 3 家失败的店铺

| 店铺 | 状态 |
|---|---|
| QUEEN GLOW有服饰专卖店 | needs_login 会话已失效 |
| QUEEN GLOW官方旗舰店 | needs_login 会话已失效 |
| QUEEN GLOW女装旗舰店 | needs_login 会话已失效 |

### 需要做的

打开「店铺工作台」→ 这 3 家店重新扫码登录。抖店登录态无法用脚本恢复。

若这些店铺已不再经营，应从
`~/Library/Application Support/shopdesk/shops.json` 移除，否则任务会一直返回 2。

---

## 附：一次误操作

对拍 `jst refund` 参数校验时用了 `--date 2026-13-99`，
该脚本只校验 `YYYY-MM-DD` 格式、不校验日期合法性，
于是真的在聚水潭创建了 2 个退款单导出任务（均失败：生成文件失败）。

- 任务号 `206799972`、`206799975`
- 无数据落库、无云端发布
- 如需清理：聚水潭 → 订单 → 退款单 → 导出记录 里删除这两条失败任务

---

## 5. 「一直在报警」的真因：自动修复从 10-28 起全部 401

### 现象

用户反馈"经常有报警发到 webhook"。任务本身并没有天天坏。

### 排查

`~/xdr-sync-agent/var/failure-repair/runs` 里：

- 387 次修复运行，**554 个 `401 Unauthorized`**
- 最早 2026-10-28 17:07，最晚 2026-11-06 02:37
- `codex login status` → `Not logged in`
- `~/.codex/auth.json` 不存在

也就是说：失败 → 进修复队列 → Codex 起不来 → 等 30 分钟 → 原样推到飞书。
每一条告警都是这个流程走完的结果。

### 处理

不是"再修一遍 Codex 就好"——换任何编排框架都绕不开 Agent 未登录。
改为：

1. 装 [agent-autoloop](https://github.com/KKKKhazix/agent-autoloop) 作为调度内核；
2. 用本机**已登录**的 `pi --print` 作为执行 Agent；
3. 失败事件按项目派单（`task.failed.<项目>`），各项目在自己目录里排查；
4. 派单成功才压住飞书 30 分钟，派单失败立刻照常报警；
5. 同任务同原因**一小时只派一次**，避免修不了的失败反复烧 Token。

细节见 [失败自动修复](AUTO-REPAIR.md)。

### 未做

`codex login` 仍然没登录。如果以后想换回 Codex，先登录，再把
`~/.agent-autoloop/rules.json` 里固定 `use: "command"` 改回 `use: "codex"`。

---

## 6. 一次性补跑脚本卡死循环 20 天（151,974 次）

### 现象

看板 `plan` 一直列着「清单外任务 `com.xdr.manual-replay-20261017`」，
我一开始当成手工遗留忽略了。实际查下去：

```
launchctl print gui/501/com.xdr.manual-replay-20261017
  type = Submitted
  runs = 151974          ← 15 万次
  immediate reason = inefficient
  pid = 92959
```

- 日志 `run.log` 已 29.8 MB / 304,141 行
- 每轮都起一个 `ssh` 子进程连控制服务器
- 从 2026-10-17 21:10 起，20 天没停

### 它是什么

`~/projects/task-runs/20261017-replay/run.mjs`，当天手工 `launchctl submit` 提交的**一次性补跑控制器**：
给 10-16 那天漏掉的队列任务（finalize_sales / sync_purple_orders / refund_export）补跑。

### 为什么停不下来

脚本里有个自我保护：提交订单前检查业务日期，变了就抛
`business_date_changed_before_orders_submission` 退出——
防止拿旧日期覆盖新数据。这个逻辑是对的。

问题是它是个 **Submitted 类型的 launchd 任务**：进程一退出，launchd 立刻重启，
没有 ThrottleInterval 节流。于是「启动 → 发现日期变了 → 退出 → 立刻再启动」，
每 ~10 秒一轮，无限循环。而且它**永远不可能成功**（10-17 早就过去了），所以永远不会自己停。

### 处理

```bash
launchctl bootout gui/$(id -u)/com.xdr.manual-replay-20261017
```

- 进程和孩子进程都清掉了
- 29.8 MB 日志压成最后 300 行留档：`~/projects/task-runs/run.log.tail.gz`
- 它的 plist 文件本来就不在了（Submitted 类型），重启也不会复活

### 改进

看板加了「清单外任务」告警条：launchd 里跑着、但 `schedules/tasks.json` 里没有的 label，
会以黄条列出来（带 pid 和退出码）。用临时 Submitted 任务验证过，能抓到现在也能清掉。

教训：**`launchctl submit` 起来的东西不受 plist 管，坏了自己停不下来**。
一次性任务要么用 cron 表达式，要么跑完就 `bootout`。

---

## 7. 品退自动举报停摆一个月（proof_infos 结构错）

### 现象

用户问「品退的自动举报没做了？」。查证：**最后一次成功提交是 2026-10-02**，
之后 0 成功、至少 250 次失败。

| 日期 | 成功 | 失败 |
|---|---:|---:|
| 09-29 | 68 | 122 |
| 10-01 | 6 | 3 |
| **10-02** | **11** | **5** |
| 10-26 | 0 | 23 |
| 10-30 | 0 | 54 |
| 11-05 | 0 | 6 |

失败原因分布：`系统开小差了，请稍后重试`(10003) 234 次、`提交未生效` 188 次、
`登录信息已失效`(10008) 24 次。

### 为什么一个月没人发现

1. `com.shopdesk.appeal` **退出码恒为 0** —— 提交失败不影响进程退出码
2. 失败只写进 `appeal-reports/appeal-*.json` 的 log 数组
3. 日汇总只统计「提交数」，不统计「失败数」
4. 失败**没有重试**，也不会重新排队

### 根因

对比两条提交路径的请求体：

```js
// 中差评：正确
pageReviewApply → proof_infos: [{tpl_id, title, imageUrls: [...]}]

// 品退：错
pageApplyNow    → proof_infos: ["https://…jpg"]        // 字符串数组
```

平台对错误结构返回 **10003「系统开小差了，请稍后重试」**——错误码是障眼法，
看着像平台抖动，实际是参数反序列化失败。

另外 `pageProofTemplate` 把 `scene_type` 写死成 `report_type_unusual_comment`，
品退取不到模板 → 即使想包装也没有 `tpl_id`。

### 修复

`~/shopdesk-workbench-src`（提交 `3f0f569`，未推送）：

- `pageApplyNow` 改读 `cfg.proofInfos`
- `pageProofTemplate` 支持传 `scene`
- 两处调用点（人工确认路径、核对队列路径）都按模板包装凭证

### 验证（单条真实提交）

拿「立刻有时尚服饰」一条已确认的品退试提交：

```
修复前  proof_infos: ["http://lf3-…jpg"]
        resp: {code:10003, msg:"系统开小差了，请稍后重试"}

修复后  proof_infos: [{tpl_id:"shensu_6776540ce580410a", title:"…", imageUrls:["http://lf3-…jpg"]}]
        resp: {code:10003, msg:"订单6918224819782561599，不能举报；"}
```

错误从**通用异常**变成**具体业务判断** —— 说明请求体已被正确解析，
这条订单是平台自己判定不能举报（该单已过期或已处理），不是参数问题。

### 顺带修掉的问题

`build.sh` 会把 `tools/*.plist` 原样写成 `local.shopdesk.*`，
和已迁移的 `com.shopdesk.*` **双份触发**（appeal / appeal-submit / autodeploy /
health / summary 五个）。已改成输出时改名并替换 Label。

### 还没做的

1. **13 条已确认的品退永远不会提交**：它们都早于 30 天的 `queueMaxAgeDays`，
   会被资格校验直接过滤掉。要么放宽窗口，要么标记为过期，别让它们永远挂在「已确认」。
2. **失败不重试**：10003 / 10008 应该退避重试 2 次。
3. **失败不告警**：品退失败数 > 0 应该接进现有的告警链路。
4. 提交里混进了这两个文件**原本就有的未提交改动**（队列策略等），
   推送前需要单独 review。

