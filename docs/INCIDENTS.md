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
