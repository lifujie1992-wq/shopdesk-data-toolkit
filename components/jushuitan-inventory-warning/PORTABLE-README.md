# 聚水潭库存查询工具

仅支持 macOS。安装后无需保持 Chrome 或 OpenBridge 运行。

## 安装

解压后在终端进入本目录，运行：

```bash
bash install.sh
```

## 导入 Cookie

在已登录聚水潭的浏览器开发者工具中，复制任意 `api.erp321.com` 请求的完整 `Cookie` 请求头，然后运行：

```bash
pbpaste | ~/.local/bin/jst-inventory auth import
```

也可以运行 `~/.local/bin/jst-inventory auth import`，在隐藏输入提示中直接粘贴。

工具验证 Cookie 后，只把 `u_sso_token`、`u_id` 和 `u_co_id` 保存到 macOS 钥匙串。不要把 Cookie 发到聊天窗口或放入命令参数。

## Agent 调用

安装器会安装 Codex 和通用 agent skill。重新启动 agent 会话后，可直接询问库存预警，也可调用：

```bash
~/.local/bin/jst-inventory summary
~/.local/bin/jst-inventory list --page 1 --limit 10
~/.local/bin/jst-inventory shop-shortage list --page 1 --limit 10
~/.local/bin/jst-inventory shop-shortage summary
~/.local/bin/jst-inventory shop-shortage export-sqlite --output ./jst-shop-shortage.sqlite
```

店铺缺货导出包含店铺链接明细和按店铺汇总。`shop_urgent_stockout_qty` 的口径为  
已超时件数加剩余 1 天内超时件数。自动任务在北京时间 23:00 至次日 07:00  
不得调用抓取或同步命令。
