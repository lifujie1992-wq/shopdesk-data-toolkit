# 按能力复用

## 选择最小入口

只抓经营指标：复用 `doudian-daily/cookies.py` 和 `doudian.py`，用 `daily_collect.py` 编排。它们读工作台登录分区，不需要把 Electron UI 复制进新项目。

需要真实页面、下载或截图：走工作台 Bridge，参考 `douyin-settle-recon/src/douyin_settle_recon/shopdesk.py` 与 `commission_rates/bridge.py`；它们管理探索页的租用与释放。不要只复制调用接口而漏掉页面回收、身份核验和完整性检查。

只抓逐客服表现：选飞鸽项目。`lib/` 分离 Cookie、API、SQLite、快照和发布；`collect.mjs --local-only` 适合先验证本地结果，`upload.mjs` 可补传已有历史。店铺级经营指标里的客服字段不能替代逐客服表现。

聚水潭有两种订单能力：`jst-orders` 对应“数据→订单明细查询”报表；`jst-order-page` 对应“常用→订单”及“详”。两者范围和字段不同，不要互相替代。

## 选择上传通道

| 通道 | 实现参考 | 完成判定 |
| --- | --- | --- |
| XDR 固定作业队列 + SSH | `xdr-sync-agent/src/agent.js`、`transport.js`、`validation.js`；`server/` | 固定任务映射、本地验证、传输、云端应用状态 |
| 独立 SQLite 原子发布 | `feige-customer-daily/lib/warehouse.mjs`、`cloud/apply-snapshot.py` | SHA-256、行数、历史防覆盖与 ACK |
| JSON API + outbox | `shopdesk-aftersale/bin/push.py` | 服务端应答、退避重试及死信处理 |
| Excel + gzip 归档 | `douyin-settle-recon/upload.py`、`cloud_sync.py` | 本地校验、上传身份、下载核验、各表同步状态 |
| MySQL 幂等插入 | `doudian-daily/badreviews_to_mysql.py` | 唯一键去重、事务提交；密码从环境取得 |

阿里云现有 HTTP 接收服务、BI/ERP 网页及其部署配置不完整存在于本机，所以这个仓库不等同于完整云端系统备份。XDR 自带的服务端源码已保留；其他模块的云端契约和样例见各自 docs/doc 目录。接新服务器时按这些契约实现接收端，或连接现有服务器。

## 新增一个采集任务

1. 先独立实现只读采集，配置与代码分开；沿用工作台/Keychain 中的登录态，不在源码填 Cookie。
2. 固定店铺身份、日期范围、字段口径；全量翻页后检查唯一键、行数和失败状态，再提交本地事务或替换快照。
3. 选一个已有上传通道，保留原始身份与幂等键。上传成功应有远端确认；失败保留旧数据和待重试产物。
4. 单店、本地输出与云端结果核对完成后，再加 launchd 调度及失败通知。不要在远端任务参数里开放任意 shell 命令；XDR 使用固定任务到本机CLI的映射。

## 快照维护

`docs/source-manifest.json` 指向原 Mac 的相对来源，保留整理版本的文件哈希。原生产目录继续独立运行；修改它们不会自动更新本仓库。后续同步时从明确的源码目录更新，核对差异、排除敏感文件，再更新清单和提交。不要对整个用户主目录做 `git add`。

唯一业务源码改动是仓库副本的 MySQL 配置读取方式；另有 Markdown/JSON 中旧账单下载地址的脱敏。其他逻辑保留来源快照。新增加的迁移工具和文档不改变生产业务口径。
