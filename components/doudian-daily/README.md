# 抖店每日指标采集（独立脚本）

## 架构：脚本与工作台解耦

```
┌─────────────────────────────┐
│  店铺工作台（只管登录）        │
│  扫码一次 → cookie 落盘       │
│  ~/Library/Application        │
│   Support/shopdesk/           │
│   Partitions/shop-<id>/       │
│   Cookies  (SQLite, 明文)     │
└──────────────┬──────────────┘
               │ 只读文件，不需要工作台进程
               ▼
┌─────────────────────────────┐
│  daily_collect.py（独立脚本） │
│  cookies.py → 读 cookie       │
│  doudian.py → 直调接口        │
│  requests，无需签名           │
└──────────────┬──────────────┘
               ▼
   ① data/<日期>.json      ② data/shop_metrics.sqlite3
   ③ --webhook 你的接口    ④ --dsn MySQL/Postgres
```

**关键点**：工作台的唯一职责是**扫码登录**，登录完 cookie 就留在磁盘上。
脚本**只读磁盘**，工作台关着也能跑，可以随便放进 cron / launchd / 容器。

## 快速开始

```bash
cd ~/doudian-daily

python3 cookies.py                     # 看各店铺 cookie 情况
python3 daily_collect.py --list        # 看店铺 + 登录态
python3 daily_collect.py               # 采集一次
python3 daily_collect.py --report      # 只看质量报告，不写库
python3 daily_collect.py --only "黑色草莓bingbing"
python3 daily_collect.py --webhook https://your.api/x --webhook-token xxx
python3 daily_collect.py --dsn "mysql://u:p@host:3306/db"
python3 daily_collect.py --from-file data/2026-09-16.json   # 离线重跑
python3 daily_collect.py --dump-cookies ck.json             # 导出 cookie 给别的工具
python3 daily_collect.py --cookie-file ck.json              # 用外部 cookie 跑（可在别的机器）
```

## 目录（全部在 `~/doudian-daily/`）

```
~/doudian-daily/
├── README.md                      本文档
├── daily_collect.py           ★  主脚本（编排：取cookie→采集→契约→脱敏→落盘）
├── cookies.py                 ★  Cookie 来源（读工作台分区 / 外部JSON）
├── doudian.py                 ★  API 客户端（11个步骤，纯 requests 无需签名）
├── metrics_contract.json      ★  字段契约（107字段的状态/周期/来源/路径/说明）
├── check_login.py                 登录状态速查
├── com.lee.doudian-daily.plist    launchd 定时任务（每天 09:00）
├── data/
│   ├── shop_metrics.sqlite3       宽表 shop_metrics_daily + 元数据表 shop_metrics_meta
│   └── <日期>.json                当日结果 + 字段元数据（已脱敏）
├── workbook-module/               工作台采集模块（GUI 版，可选，与脚本互不依赖）
│   ├── install.sh              ★  一键装进工作台（不用点 GUI）
│   ├── collector.json             模块清单（能力/列定义）
│   ├── metrics.py                 模块入口（main）
│   ├── doudian.py                 同源 API 客户端
│   └── probe.py                   接口探测（诊断用）
├── excel/                         Excel 回填
│   ├── fill_excel.py              从罗盘/商家中心数据填（早期）
│   └── fill_shop_excel.py         从采集结果填（含「得分」列）
└── docs/
    ├── 抖店接口清单.md               353 个接口清单
    ├── 抖店工作台-自建采集模块说明.md   工作台模块说明
    └── doudian-playwright-单店.zip    参考项目（别家的实现，用于对标）
```

★ = 核心文件，别删

### 重装工作台模块

```bash
bash ~/doudian-daily/workbook-module/install.sh
# 然后打开工作台 → Agent/采集 → 看到「经营指标汇总 · 抖店」（无需重启）
```

## 采集的 11 个步骤（全部只读）

| 步骤 | 接口 | 内容 |
|---|---|---|
| `home` | `/pc/api/home/homepage` | 当日实时：成交金额/订单/客单价/曝光/点击/转化率/投放消耗/费比/结算金额/7日退款/待办 |
| `compass_trade` | 罗盘 `core_index_v3`+`pie_chart_v3` | **总访客数 + 商品卡/图文/短视频/直播/达人带货 销量（成交订单量）** |
| `qianchuan` | 千川 `POST /ad/api/data/v1/common/statQuery` | **推广成本(消耗) / 推广ROI / 推广净成交量 / 推广订单成本 / 推广订单占比** |
| `experience` | `getOverviewByVersion`+`getAnalysisScore` | 体验分总分与三项分 + 13 个分项原始值 + **分档阈值表** |
| `comments` | `/product/tcomment/statistics` | 好评/中评/差评数、各类率、未回复数、有图/视频 |
| `orders` | `/api/order/tabcnt` | 待发货/延迟发货/超时未发/售后中/配送中/已收货/已关闭/全部 |
| `products` | `/product/tproduct/aggsProductCount` | 在售/草稿/审核中/禁售 |
| `aftersale` | `POST /after_sale/pc/list` | 近30天售后单数 |
| `logistics` | `/shopuser/power/getPackageList` | 近30天包裹数 |
| `stock` | `POST /stock/manage/list` | 缺货件数/预警/建议补货/SKU总数 |
| `product_flow` | `/product/tproduct/list`×2 | **商品总数/已下架总数/今日上架·下架/近7天每日流水** |

**fxg 站点全程无需 a_bogus 签名**——纯 cookie 直连。

> ⚠️ **罗盘接口在独立域名 `compass.jinritemai.com`**，cookie 同域共享，
> 直连即可，但 **Referer 不能带 `compass.jinritemai.com`**（会触发风控「当前环境存在风险」），
> 沿用 fxg 会话默认 Referer。罗盘单日口径 `date_type=1` 实为「当日实时」，与首页实时口径一致。
>
> ⚠️ **千川接口在 `qianchuan.jinritemai.com`**（`/ad/api/...`），同一份抖店 cookie 可直接调；
> `statQuery` **无需 a_bogus 签名**，直接 POST 即可。推广消耗/ROI/订单数均取平台返回值。

## 表结构

### 宽表 `shop_metrics_daily`（一店一天一行）

```sql
PRIMARY KEY (stat_date, shop_id)
stat_date, shop_id, shop_name, captured_at, steps_ok, notes + 100 个业务指标
```

### 元数据表 `shop_metrics_meta`（一字段一行）

```sql
PRIMARY KEY (stat_date, shop_id, metric_key)
metric_key, metric_label, status, has_value, period, source, response_path, note, raw_value
```

```sql
-- 口径待确认的字段
SELECT metric_label, note FROM shop_metrics_meta
WHERE stat_date='2026-09-16' AND status='candidate_not_exact';

-- 某字段的来源与周期
SELECT period, source, response_path FROM shop_metrics_meta WHERE metric_key='s_feige_response';

-- 每个采集步骤的状态
SELECT metric_key, status, note FROM shop_metrics_meta WHERE metric_key LIKE '__step__%';
```

## 字段状态分级

| status | 含义 | 建议展示 |
|---|---|---|
| `exact` | 接口直接返回，口径一致 | 正常 |
| `as_of` | 实时/快照口径 | 标注"截至此刻" |
| `derived` | 由接口值计算/推算 | 标注"推算" |
| `candidate_not_exact` | 有值但口径不完全一致 | **灰显** |
| `source_no_data` | 平台无数据（`-9999`/`"-"`），已置 NULL | 显示"—" |
| `constant` | 固定值 | 正常 |

> ⚠️ **8 个「得分」字段都是 `derived`**：平台接口不下发分项得分，
> 是本脚本按平台自己的分档阈值表（`standard_conf_info_map`）分段线性插值算的，
> 与页面显示可能有小幅差异。

## 统计周期

每个字段带自己的真实周期，**不会把 30 天口径混进当天**：

| 字段组 | period |
|---|---|
| 成交/订单/曝光/点击/转化率/投放 | `当日实时（截至采集时刻）` |
| 待发货/售后/订单计数/缺货/商品数 | `当前快照（截至采集时刻）` |
| 评价各类率/售后单数/包裹数 | `近30天` |
| 总访客数/渠道销量（罗盘） | `当日实时（截至采集时刻）` |
| 推广成本/ROI/净成交量/订单成本（千川） | `当日实时（截至采集时刻）` |
| 体验分各项 | `体验分统计窗口（近30天，见 exp_window）` |
| 上架/下架 | `当日` / `近7天` |

## 主要指标列

| 分组 | 列 |
|---|---|
| 经营实时 | `sales` `orders` `aov` `pay_amt` `settle_amt` `refund_pay` `refund7` `refund_orders` `compass_pay_cnt` `compass_pay_amt` |
| 流量 | `exposure_uv` `click_uv` `buyer_uv` `ctr` `cvr` `visit_uv`(总访客数) |
| 渠道销量（成交订单量） | `sales_product_card` `sales_artc_video` `sales_video` `sales_live` `sales_talent`(达人带货) |
| 推广/千川 | `promo_cost`(推广成本) `promo_cost_total`(账户整体消耗) `promo_cost_uni`(全域消耗) `promo_roi` `promo_net_orders` `promo_order_cost` `promo_pay_amt` `promo_order_ratio` + `promo_uni_*`(全域) |
| 投放 | `ad_cost` `ad_ratio` `spend` |
| 待办 | `todo_stockup` `todo_aftersale` `todo_exception` `todo_ticket` `todo_unpaid` `todo_risk` `todo_violation` |
| 体验分 | `exp_total` `exp_goods` `exp_logistics` `exp_service` `exp_category` `exp_window` |
| 体验分项(值) | `m_quality_return` `m_collect_ontime` `m_delivery_ontime` `m_logistics_return` `m_feige_response` `m_aftersale_audit` `m_feige_dissatisfy` `m_platform_help` `m_goods_rating` `m_collect_duration` |
| 体验分项(**得分**) | `s_*` 同上一一对应 |
| 评价 | `comment_good_count` `comment_neutral_count` `comment_bad_count` `comment_good_rate` `comment_bad_rate` `comment_neutral_rate` `comment_new_30d` `comment_order_rate` `comment_detailed_rate` `comment_with_photo/video/content` `comment_unreply` `comment_bad_to_reply` |
| 订单计数 | `order_stock_up` `order_ship_delay` `order_exp_ship` `order_in_aftersale` `order_on_delivery` `order_received` `order_closed` `order_all` |
| 商品/流转 | `product_onsale` `product_draft` `product_audit` `product_total` `product_offline_total` `listed_today` `offline_today` `listed_7d` `offline_7d` `listed_daily_7d` `offline_daily_7d` |
| 库存 | `stock_sold_out` `stock_alarm` `stock_advised_increase` `stock_sku_total` |
| 售后/物流 | `aftersale_total` `package_total` `package_exception_sampled` |
| 刷单(聚水潭) | `brush_orders`（聚水潭紫旗=刷单；按下单日期统计、含全部状态；次日自动回填前一日完整值） |

完整定义见 `metrics_contract.json`。

## 刷单字段（brush_orders，来自聚水潭）

- 口径：聚水潭**紫色旗帜**（seller_flag=5）= 刷单；按**下单日期**=统计日期统计，含全部订单状态
- 来源：聚水潭 salesTheme 订单接口（`apiParams.sellerFlags=[5]`），会话复用 jst-orders 的 keychain 凭据
- 店铺匹配：聚水潭店名 ↔ 抖店店名模糊匹配（多操作号/多主体合并计数）；
  匹配不上的可在 `jst_shop_map.json` 配人工映射：`{"抖店店铺名": ["聚水潭店铺名子串"]}`
- 时序：聚水潭数据每天上午 ~9:00 刷新，早晨采集时当天值只是凌晨部分；
  采集程序会自动**次日回填**前 2 日的完整数值（`--brush-backfill-days`，0 关闭）
- 跳过：`--no-brush`；客户电脑没有聚水潭凭据时该字段自动置空，不影响其它采集

## 安全

- **脱敏**：导出前递归扫描，命中 `cookie/authorization/token/csrf/msToken/a_bogus/verifyFp/sessionid/sid_guard/...` → `[REDACTED]`
- **只读**：脚本不写任何 cookie、不调用任何写接口
- `--dump-cookies` 导出的文件权限 0600，内含登录凭证，**勿外传**
- 工作台的 Cookies 库是**明文存储**的（Electron 未启用 safeStorage），所以本机任何进程都能读——
  介意的话给 `~/Library/Application Support/shopdesk` 收紧权限

## 定时任务（每天 09:00）

```bash
cp ~/doudian-daily/com.lee.doudian-daily.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.lee.doudian-daily.plist
tail -f ~/doudian-daily/data/cron.log        # 看日志
launchctl unload ~/Library/LaunchAgents/com.lee.doudian-daily.plist   # 卸载
```

## 推送阿里云（复用 xdr-sync-agent）

采集结果会自动同步到阿里云服务器（47.114.33.246），与 xdr-sync-agent 同一套机制：
本地采集 → 差分 → scp 上传 → 服务器原子应用 + 版本追踪。

> ✅ **新增指标已纳入同步**：`visit_uv`、`sales_live/video/product_card/artc_video/talent`、
> `compass_pay_cnt/amt`、`promo_*`（千川推广）等 20 个新列已加入 `shared/datasets.json`
> 与服务器 `app.py`，云端 `/v1/bi/doudian*/daily` 会直接返回。
> 新增列属于「演进式 schema」：服务器应用补丁时会自动 `ALTER TABLE ... ADD COLUMN`，
> 无需重建全量库。

- **适配器**：`doudian_sync.py`（`export-sqlite --output <path>` / `login-status`）
- **dataset**：`doudian`（文件名 `doudian-daily.sqlite`，表 `shop_metrics_daily` + `shop_metrics_meta`）
- **调度**：服务器 systemd `xdr-sync-doudian.timer` 每天 09:20（上海）入队，Mac 上的 xdr-sync-agent daemon 领取执行
- **手动触发**：`~/xdr-sync-agent/bin/xdr-sync-agent.js sync-now doudian`，或在管理界面点「更新抖店指标」

只读 API（需 `X-API-Key` 头）：

```text
GET /v1/bi/doudian/status                       最新采集日期 / 店铺数 / 行数
GET /v1/bi/doudian/daily?stat_date=&shop_id=...  每日宽表（一店一天一行）
GET /v1/bi/doudian/metrics?status=&metric_key=... 字段元数据（口径/来源/状态）
```

### 待开票（独立数据集 doudian_invoice）

给消费者开票（待开票/待红冲）+ 我给平台开票（待开票账单）的**每日快照**，
与 `invoice.py` 同一套接口（纯 cookie 直连，无需 a_bogus）。

- **适配器**：`invoice_sync.py`（`export-sqlite --output <path>` / `login-status`）
- **dataset**：`doudian_invoice`（文件名 `doudian-invoice.sqlite`，三张表）
  - `invoice_daily`：一店一天一行汇总（待开票张数/金额 + 平台账单数/金额）
  - `consumer_invoice`：给消费者开票明细（抬头/税号/金额/申请时间/最晚开票时间）
  - `platform_invoice_bill`：我给平台开票账单（场景/收票方/金额/月份）
- **调度已停用（2026-10-17）**：服务器 `xdr-sync-doudian-invoice.timer` 已停止并禁用，旧发票队列无未完成任务。现由 `~/projects/invoice-mac-agent` 的 `local.invoice-capture-sync` 每日09:40（上海）执行 `--once --complete`，直接采集并入库ERP V2。旧脚本和历史数据保留，旧数仓快照停止自动刷新。
- **手动触发**：`~/xdr-sync-agent/bin/xdr-sync-agent.js sync-now doudian_invoice`

```text
GET /v1/bi/doudian-invoice/status                  最新快照（店铺数/明细行数）
GET /v1/bi/doudian-invoice/daily?stat_date=&shop_id=  每日汇总（一店一天一行）
GET /v1/bi/doudian-invoice/consumer?invoice_status=&shop_id=  给消费者开票明细
GET /v1/bi/doudian-invoice/platform?scene=&shop_id=       我给平台开票账单
```

### 客户店铺（独立数据集 doudian_client）

客户店铺与自营店铺**彻底隔离**：单独的 sqlite（`data/shop_metrics_client.sqlite3`）、
单独的阿里云数据集（`doudian-client-daily.sqlite`）、单独的定时任务（每天 09:25）和 API。

```text
GET /v1/bi/doudian-client/status
GET /v1/bi/doudian-client/daily?stat_date=&shop_id=
GET /v1/bi/doudian-client/metrics?status=&metric_key=
```

- 适配器：`doudian_client_sync.py`
- **采集范围＝扫描「店铺工作台」里当前登录的全部店铺**（无手动名单）：客户登录哪些店就抓哪些店
- 手动触发：`~/xdr-sync-agent/bin/xdr-sync-agent.js sync-now doudian_client`
- ⚠️ 自营抖店同步（每天 09:00 本地 + 09:20 云端）已在客户电脑上停用，避免把客户店铺采进自营数据集

## ⚠️ 前提与坑

1. **每个店铺要在工作台里扫码登录过**，未登录的会返回 `LOGIN_REQUIRED`，脚本跳过并告警
2. **同一抖店账号只能一处登录**——工作台登了就别在别处登同一账号（会互相踢下线）
3. **cookie 过期**：平台会作废服务端会话（磁盘上的过期时间不一定准），
   表现就是全部/部分店铺 `LOGIN_REQUIRED` → 打开工作台重扫
4. 脚本**不需要工作台运行**，但工作台必须先安装过一次（才有 `shops.json` 和分区目录）

## 与「店铺工作台采集模块」的关系

工作台里那个 `shopmetrics` 采集模块是**同一套逻辑的 GUI 版**（`doudian.py` 同源），
方便你在工作台界面里手动点一下看结果。**日常自动化走本目录的脚本即可，两者互不依赖。**
