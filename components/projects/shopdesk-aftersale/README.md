# 抖店售后「待商家审核」定时采集

每小时 :02、:32（北京时间）从 **店铺工作台** 已登录的抖店店铺拉取售后工作台「快捷筛选 → 待商家审核」
6 个分项数量，写入本地 JSON，并（可选）推送到云端 API。

| 分项 | 页面字段 | JSON 键 | 接口 after_sale_tab |
|---|---|---|---|
| 未发货退款 | 待商家审核 · 未发货退款 | `unshipped_refund` | `presale_all_audit` |
| 已发货退款 | 待商家审核 · 已发货退款 | `shipped_refund` | `refund_audit` |
| 退货退款 | 待商家审核 · 退货退款 | `return_refund` | `return_audit` |
| 换货 | 待商家审核 · 换货 | `exchange` | `exchange_audit` |
| 补寄 | 待商家审核 · 补寄 | `resend` | `resend_audit` |
| 维修 | 待商家审核 · 维修 | `repair` | `repair_audit` |

数字 = 官方 `POST /after_sale/pc/list` 返回的 `total`（与页面角标同口径），
请求固定 `pageSize=1`，只读 `total`，不拉明细、不做任何写操作。

## 目录结构

```
~/projects/shopdesk-aftersale/
├── bin/
│   ├── scrape_counts.py     采集（6 个数字）
│   ├── push.py              上云推送（outbox / 退避 / 死信）
│   └── query.py             查询本地 JSON
├── config/
│   └── config.env.example   上云配置模板（复制到 ~/.config/aftersale/env）
├── deploy/
│   ├── install.sh           安装 launchd 任务（采集 30min + 补传 5min）
│   ├── uninstall.sh         卸载定时任务（保留数据）
│   └── launchd/*.plist.tmpl 定时任务模板（安装时替换 __ROOT__）
├── docs/
│   ├── cloud-api-design.md  云端接口技术方案
│   ├── openapi.yaml         OpenAPI 3.1 契约
│   └── sample-run.json      一轮 40 店上行样例
├── data/                    本地数据（事实来源）
│   ├── runs/<run_id>.json   每轮完整明细
│   ├── latest.json          最近一轮快照
│   ├── history.jsonl        追加式历史（每店每轮一行）
│   ├── outbox/{sent,dead,state.json}
│   └── push.log
└── logs/                    scrape.log / launchd*.log
```

> `data/`、`logs/`、`config/env` 已在 `.gitignore` 中，不会提交。

## 安装 / 卸载

```sh
cd ~/projects/shopdesk-aftersale
./deploy/install.sh      # 采集任务每小时 :02/:32，加载后等待计划时间
./deploy/uninstall.sh    # 卸载定时任务，保留数据
```

依赖：**店铺工作台必须处于运行状态**（脚本通过它的本机接口
`~/Library/Application Support/shopdesk/agent-bridge.json` 调用）。
工作台未启动时，当轮直接跳过并记日志。

## 页面并发与失败处理

工作台探索接口共用 2 个页面名额，每次采集用返回的页面 ID 执行命令和关闭页面。
售后与财务采集可以各占一个；其它工作台功能自行创建的窗口不计入这 2 个名额。
无 ID 的关闭请求会被拒绝，不会关闭其它任务的页面。页面空闲 5 分钟自动回收。

名额满时在客户端每秒重试，单次最多等 60 秒，一整轮累计最多等待 120 秒，
避免 39 家店逐家长时间排队。首轮未成功的店铺在轮末再补采一次，以补采结果为准；
最后才保存和推送本轮数据。仍失败的店铺保留错误状态和空值，不算作 0。

等待和补采期间不发飞书失败通知。补采全部成功则正常结束；仍有失败则退出码 2，
由原有监控每轮通知一次，并列出成功/失败店数及原因。工作台不可用、脚本异常退出等
任务级错误仍会通知。最终状态保存在 `data/status.json`，通过 launchd 执行次数关联本轮。

升级脚本：`python3 deploy/install-exploration-pool.py --install`，先检查业务任务空闲，
只替换工作台内 4 个相关文件并保留备份。验证：`python3 deploy/verify-exploration-pool.py`。
财务采集的页面等待上限为每次 60 秒，不新增任务调度器。

## 查询

```sh
cd ~/projects/shopdesk-aftersale
python3 bin/query.py                  # 各店最新一次快照 + 合计
python3 bin/query.py --runs           # 最近 20 轮采集概况
python3 bin/query.py --history 香朵儿  # 某店最近 20 次
python3 bin/query.py --at "2026-10-17 15"   # 指定时间点各店快照
python3 bin/query.py --json           # latest.json 原文
```

也可以直接 `jq`：

```sh
jq -r '.shops[]|select(.status=="ok")|[.shop_name,.counts.shipped_refund,.total_count]|@tsv' \
  ~/projects/shopdesk-aftersale/data/latest.json | sort -k3 -nr | head
```

## 数据格式

`data/runs/<run_id>.json` 与 `data/latest.json`：

```json
{
 "run_id": "20261017-162345-306bca",
 "started_at": "2026-10-17T16:23:45+08:00",
 "finished_at": "2026-10-17T16:26:11+08:00",
 "source": "https://fxg.jinritemai.com/ffa/merchant-aftersale-workbench/aftersale/list",
 "columns": {"unshipped_refund": "未发货退款", "shipped_refund": "已发货退款",
             "return_refund": "退货退款", "exchange": "换货",
             "resend": "补寄", "repair": "维修"},
 "shops_total": 40, "shops_ok": 39, "shops_failed": 1, "total_count": 177,
 "shops": [
   {"shop_id": "…", "shop_name": "香朵儿官方旗舰店", "platform": "抖店",
    "captured_at": "2026-10-17T16:23:49+08:00",
    "status": "ok", "error": null, "seconds": 4.0,
    "counts": {"unshipped_refund": 0, "shipped_refund": 13, "return_refund": 0,
               "exchange": 0, "resend": 0, "repair": 0},
    "total_count": 13}
 ]
}
```

`data/history.jsonl` 每行 = 上述单店对象 + `run_id`。

## 上云推送（可选）

契约见 `docs/cloud-api-design.md`，OpenAPI 见 `docs/openapi.yaml`。

### 配置（token 不入库、不进日志）

```sh
mkdir -p ~/.config/aftersale
cp ~/projects/shopdesk-aftersale/config/config.env.example ~/.config/aftersale/env
# 编辑填入 AFTERSALE_API_URL / AFTERSALE_API_TOKEN
chmod 600 ~/.config/aftersale/env
```

也支持同名环境变量，**环境变量优先**。token 至少 16 字符（推荐 32 字节随机）。

### 行为

| 情况 | 行为 |
|---|---|
| HTTP 2xx | 写 `data/outbox/sent/<run_id>.json`（含 accepted/rejected），不再推送 |
| 200 但 `rejected>0` | 视为已送达，仅告警 |
| 网络错误 / 超时 / 429 / 5xx | 留在待传队列，1、2、4 … 上限 30 分钟退避 |
| 4xx（除 408/425/429） | 写 `data/outbox/dead/<run_id>.json`，不再重试 |
| 同一 run 重推 | 复用同一 `run_id`，云端 upsert 幂等 |

- 每轮采集结束后自动推送（失败只记录、不影响采集）。
- `--once` 扫描最近 7 天、最多 200 轮未送达的 run；launchd 每 5 分钟兜底。
- 修复 token 后重推死信：`python3 bin/push.py --run-file data/runs/<run_id>.json --force`

### 命令

```sh
python3 bin/push.py --check                 # GET /health
python3 bin/push.py --once --verbose        # 手动补传一轮
python3 bin/push.py --watch                 # 常驻，每 5 分钟补传
python3 bin/push.py --run-file data/runs/<run_id>.json [--force]
python3 bin/push.py --status                # outbox 概况（有 dead 时退出码 3）
```

退出码：`0` 全部送达 / 无待传；`1` 有未送达（已排队重试）；`2` 配置缺失或非法。

## 行为说明

- **登录态**：不使用、不导出 Cookie。脚本让工作台用一个该店独立的隐藏页面
  （`persist:shop-<uuid>` 分区）访问售后工作台，在页面内 `fetch` 官方接口，
  读完 `total` 立即关闭页面。凭据只存在于工作台进程与该页面内存。
- **只采已登录店铺**：所有抖店店铺都会尝试；会话失效的店记为 `needs_login`
  （数值为 `null`，不写 0），重新扫码后下一轮自动恢复。
- **防重入**：`data/.scrape.lock` 文件锁，上一轮未跑完时本轮跳过。
- **单店超时**：45s；单店异常只影响该店。
- **残留探索页**：上次异常退出留下后台探索页时，自动清理并重试一次。
- **保留期**：`RETAIN_DAYS = 180`（`bin/scrape_counts.py` 顶部），每轮清理更早的轮次文件与历史行。
- **调试过滤不落盘**：`--shop` / `--limit` 默认不覆盖 `latest.json`、不追加 `history.jsonl`；需要写时加 `--force-write`。
