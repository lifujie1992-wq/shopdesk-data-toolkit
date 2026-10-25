# 飞鸽客服表现每日采集

采集飞鸽 **数据 → 客服数据 → 客服表现**，范围为店铺工作台当前配置的全部抖店。
每天 **10:30** 由 `com.xdr.feige-customer-daily` 执行，默认取上海时区昨天，店铺新增或删除后下次运行自动跟随。
采集完成后自动发布到阿里云数仓 `/var/lib/xdr-sync/data/feige-customer.sqlite`，保留本地完整历史；云端确认后记录同步成功。
Node.js 24，使用内置SQLite，无需安装第三方依赖。

## 使用

```bash
cd /Users/zhaoxiaozhong/projects/feige-customer-daily
node collect.mjs                       # 全部抖店，昨天
node collect.mjs --date 2026-10-16     # 手动补采指定日期
node collect.mjs --shop-id <店铺ID>    # 调试单店
node collect.mjs --list-shops
node collect.mjs --help
node upload.mjs                       # 只补传已有历史数据，不重新采集
node collect.mjs --local-only          # 仅本地采集与导出
bash install.sh                       # 安装/加载每天10:30任务，加载时不立即采集
```

## 输出

- `data/feige-customer.sqlite`：跨日历史库。`staff_daily`按日期、店铺、客服ID唯一；`shop_daily`保存汇总/平均；`shop_snapshots`保存顶部指标；`runs`及`shop_runs`保存逐次结果。
- `data/YYYY-MM-DD/customer-performance.csv`：每个客服的咨询接待、服务响应、销售转化及在线时长等字段。
- `data/YYYY-MM-DD/shop-summary.csv`：每家店的店铺汇总值及平均值。
- `data/YYYY-MM-DD/top-indicators.csv`：登录/在线/接待/达标客服数、平均在线与小休时长，保留原始秒数和格式化时长。
- `data/YYYY-MM-DD/run-status.json`：本次成功/失败店铺、原因及输出位置。
- `catalog/fields.json`：从平台真实指标元数据整理的39项字段定义。平台新增返回字段也会保留到JSON及CSV。
- `logs/run.jsonl`：逐店进度；`logs/launchd.out.log`、`launchd.err.log`为定时任务日志。
- `data/cloud-status.json`：最近一次云端同步的路径、校验和、逐表行数、日期及确认结果。

CSV使用UTF-8 BOM，可直接用Excel打开；客服ID带前导单引号按文本保存，避免19位ID被Excel舍入。
金额、百分比、时长和`-`保留平台原值；预警值拆出对应“预警”列，SQLite同时保留原始JSON。
账号在线状态码为采集时平台返回的原始值，不替代历史日期的在线人数/时长统计。

## 数据来源与完整性

店铺列表和登录来自 `~/Library/Application Support/shopdesk/`，读取Cookie数据库的临时只读副本，按域名/路径/有效期过滤，结束删除副本；不会在脚本、日志或输出中保存Cookie。
日常运行直接GET `https://pigeon.jinritemai.com/backstage/queryStaffData`，参数为`page/size=20/queryType=1/startTime/endTime=YYYYMMDD/_pms=1`，不打开浏览器、不改变客服在线状态、不发送消息或执行客服操作。

每店翻完全部页，检查总数稳定、客服ID唯一，并保存店铺汇总/平均/顶部指标。只写入完整成功的店铺；失败保留该日该店之前的成功结果。
重跑会替换同日同店数据而不会重复追加。CSV按当前配置店铺导出该日已保存的成功数据，采集时间列标明新旧；本轮失败须看run-status.json，旧数据不代表本轮成功。

部分失败时其他店继续，进程退出码1。任务复用 `~/xdr-sync-agent/src/failure-alerts.js` 发送一条飞书失败汇总，并与每分钟监控按同一次launchd执行去重。发送失败由现有待发队列重试；机器人配置不复制到本项目。

网络异常、HTTP 429/5xx及HTTP 200内的普通业务失败，每页最多尝试3次，间隔1、2秒；429的Retry-After最多等10秒。登录失效、权限不足和额外安全验证直接失败。日志保留HTTP状态、业务码、页号和尝试次数，不保存平台原始错误正文或凭据；重试成功后仍须通过全部分页完整性检查。
锁文件为`data/capture.lock`；正常退出和通常的退出信号释放，SIGKILL/断电后先核对锁中PID，确认无进程再清理，不抢占现有锁。

## 阿里云数仓

已发布到 `47.114.33.246:/var/lib/xdr-sync/data/feige-customer.sqlite`。
使用现有XDR服务器连接配置中的主机、端口与SSH密钥，以已有root权限发布本数据集；不复制凭据或Cookie。
本地`lib/warehouse.mjs`生成一致性快照，`catalog/warehouse-schema.json`定义表结构契约；`cloud/apply-snapshot.py`通过SSH标准输入在云端执行校验及原子应用。

云端保存五张源表，并提供三张只读查询视图：

| 视图 | 内容 |
| --- | --- |
| `v_staff_daily` | 日期、店铺、客服及39项直接可查询指标，保留源值口径 |
| `v_shop_daily` | 每店每日汇总与平均值 |
| `v_shop_core_daily` | 登录/在线/接待/达标人数及平均在线、小休秒数 |

发布会校验SQLite完整性、逐店客服数、表结构、逐表行数和SHA-256；拒绝丢失云端已有日期/店铺或倒退采集时间的快照。
上传先进入独立暂存目录，校验后原子替换正式文件，保留一份`.previous`；发布元数据同时保存在库内`_warehouse_publication`及旁边的`.manifest.json`。
云端文件权限0640、属主/组xdrsync。采集器最多尝试三次上传/应用，失败保留本地数据、退出非零并通知飞书；下次每日执行或手动`node upload.mjs`可补传。

```sql
-- 在云端打开 /var/lib/xdr-sync/data/feige-customer.sqlite 后查询
SELECT stat_date, shop_name, staff_name, servConvCnt, servUserCnt, inquiryPayAmount
FROM v_staff_daily
WHERE stat_date = '2026-10-16';
```

2026-10-18首次上云：10月16日826条、10月17日824条，共1650条客服记录，每天覆盖39家店；云端查询、SHA-256及逐表数量均已核对一致。

平台在凌晨可能尚未更新昨天的历史指标，脚本保留接口原值，不编造数据；每天10:30重新采集昨天。Mac需开机、登录用户账户、联网且店铺账号有客服数据权限。

## 验证

```bash
npm test
plutil -lint launchd/com.xdr.feige-customer-daily.plist
launchctl print gui/$(id -u)/com.xdr.feige-customer-daily
```

2026-10-18真实核对香朵儿官方旗舰店2026-10-16：20+8=28个客服，店铺接待会话量1118，登录/在线/接待/达标客服13/7/8/5，平均在线08时03分06秒、小休06时20分08秒，与用户截图一致。
