# 精选联盟商品链接佣金率（Mac 采集端）

对应 2026-10-18 BI 利润核算需求。只读抖店内嵌精选联盟推广页，通过现有 ShopDesk 登录会话采集，不修改推广设置、不导出 Cookie。Python 3.11+，运行时使用标准库。

## 最新发布与调度（2026-10-19）

**已完成全部 39 家可访问抖店采集，云端现有 41,192 个独立链接。** 文件：`47.114.33.246:/var/lib/xdr-sync/data/jst-commission-rates.sqlite`，同目录有 `.manifest.json`；publication_id：`daa3f460-cb46-45de-a4e1-adf7d8dc0e6b`。

- 可访问店铺目标 41,598 个链接，取得 41,192 个，覆盖率 **99.02%**。
- 完整订单范围为 49 家店、42,645 个链接，覆盖率 **96.59%**。另外 10 家店、1,047 个链接缺登录会话；已采店铺还有 406 个链接无法在两类库存中找到或无法确认公开佣金状态，未补为 0。
- 本批次另有 2,123 条指定达人记录、6,675 条投放期费率、4,590 个明确未推广/策略关闭链接。
- 39 家会话逐一排查；素小星和 QUEEN GLOW 的名称变化使用平台 ID 及 4 个订单商品 ID 实测核实，修正映射并完成补采。
- 全量门槛和人工抽样仍未通过，发布为 `partial`、批次 `complete=0`，不伪造正式验收。

**下游使用 `commission_rates_available_latest`**，按店铺、平台、链接去重，并包含 `batch_complete`、`batch_status`；`commission_rates_latest` 仍仅返回正式验收批次，当前为空。历史主表不能直接按行数当作独立链接数。

逐店覆盖：[shop-coverage-20261019.csv](data/shop-coverage-20261019.csv)；缺会话店铺：[missing-shop-sessions.csv](data/missing-shop-sessions.csv)；完整缺失链接：[missing-links.csv](data/runs/234dd2d3-444f-4a22-9b4d-81285a0260bc/missing-links.csv)。

已加载 `com.xdr.douyin-commission-rates`，每天北京时间 **05:10 一次**。佣金采集最多占用一个探索页面，另一个共享名额留给售后或财务任务；旧配置即使写 `workers: 2` 也按 1 执行。单轮采集耗时会增加，完成店铺后仍分批同步，最后再发布完整已采状态；相同源数据跳过重复中间上传。正式配置 `config/daily.json`，已核实的 39 店映射为 `data/shop-mappings.json`；其中含人工证据核实的改名映射，不要用未审核的店名匹配结果直接覆盖它。状态见 `data/daily-status.json`。

## 首次开发与真实验证

已实现定向批量采集、事务断点、完整批次历史、公开/定向/双佣金分存、抽样验收、覆盖率门禁、SQLite + manifest 发布、远端历史防覆盖及每日 launchd 脚本。

2026-10-18 真实采集兹伊翰官方旗舰店：**2,626 个订单链接，获得 2,623 条（99.89%）**，另有 78 条指定达人佣金记录、145 条投放期佣金。3 个未确认链接保留在缺失清单。该结果只证明这一家店的覆盖率；完整 49 店目标批次仍为 `partial`。尚未人工逐条核对 10 个随机样本；现已按用户要求发布为部分结果并加载每日任务，见上文。

本机及云端当前利润事实库的已发货抖音范围为 **42,645 个独立链接、49 家 ERP 店铺**。需求中的约 7 万链接、85 店范围包含其他平台。本项目只采抖音，并默认保留 `expected_links=70460` 作为发布门禁，等待 BI 明确本期范围后配置；不会拿单店或可登录店铺数量缩小完整分母。现已核实 39 家工作台店铺；另 10 家目标店、1,047 个链接缺登录会话。即使可访问店铺全部成功，完整目标范围的理论上限也为 97.54%，尚达不到全量 98% 门槛。完整目标数仓仍需补齐这些映射/登录。

产物：`data/jst-commission-rates.sqlite`；真实批次 `1d89c7ea-c246-4258-a6a4-c07e9569b56c`；覆盖率和缺失清单位于 `data/runs/<batch_id>/`，随机人工样本为 `manual-sample.csv`。`data/` 默认不入 Git。

## 安装与使用

```sh
uv sync --extra dev
uv run commission --help
uv run pytest -q
```

要求 ShopDesk 已运行，已有 exploration pool v2 和财务扩展（项目复用它的只读页面桥接和 `finance_close`）。这些扩展已在当前机器存在；本项目不重打包、不重启工作台。最多串行使用一个探索页，名额占用时短暂等待，结束或异常时释放。登录失效、权限不足、验证码或风控都保留为失败，不自动绕过。

先冻结订单范围，并按 ERP 销售业绩数据生成店铺映射候选：

```sh
uv run commission targets \
  --facts "$HOME/Library/Application Support/xdr-sync-agent-profit-facts/baseline/jst-profit-facts.sqlite" \
  --output data/targets.json
uv run commission plan-shops \
  --sales "$HOME/Library/Application Support/xdr-sync-agent/baseline/jst-sales-performance.sqlite" \
  --output data/shop-mappings.json
uv run commission collect --targets data/targets.json --shops data/shop-mappings.json
```

输入也可为 JSON：`{"targets":[{"shop_id":"14132514","platform":"抖音","platform_link_id":"3834480513620508784","internal_item_code":"款号"}]}`。长 ID 必须为字符串。SQLite 订单源只读取 `platform='抖音'` 且 `actual_shipped_qty>0` 或存在 `shipped_at` 的行；同店同链接去重，多个 `spu_id` 时款号留空，避免错误归款。

`config/shops.example.json` 演示已实测店铺的三种 ID。候选映射只对去掉 ERP 运营前后缀后的**精确、唯一店名**匹配；不做模糊匹配。每店实际采集前再次核实后台店名、平台 ID；配置了 `platform_shop_id` 时必须与页面一致。建议审核候选清单、补全已核实的平台 ID。

```sh
# 只运行一个店或少量任务，完整批次分母仍保留所有目标店
uv run commission collect --targets data/targets.json --shops data/shop-mappings.json \
  --shop 14132514 --max-tasks 3
# 接着执行剩余任务（不再传入目标和店铺，使用批次冻结配置）
uv run commission collect --resume '<batch_id>'
uv run commission report --batch '<batch_id>'
```

每个任务最多 50 个商品 ID。公开推广接口按 `product_info` 定向查；未命中部分再到未推广接口按 `title` 查 ID 列表。校验响应业务码、总数、当前页、去重和 ID 集合，忽略过滤器、重复页、缺失页会报错，绝不把抓取失败当未挂佣金。默认请求间隔 1.2 秒，最低 1 秒；网络/429/5xx 最多 3 次退避重试。单店遇到接口或身份异常即暂停该店，其他店继续。恢复时仅重试未完成任务；如果采集器代码发生变化，必须新建批次，避免混入不同字段口径。已成功但无法确认的链接保留缺失原因；若要重新调查这些链接，开始新批次。

## 字段与佣金语义

`commission_rates` 主键：`(batch_id, shop_id, platform, platform_link_id)`。包含需求全部字段，另有 `platform_shop_id`、`promotion_id`、`ad_commission_rate`、`rate_captured_at`、`carried_from_batch`、`notes`、`raw_json`。

| 字段 | 口径 |
| --- | --- |
| `shop_id` | **沿用现有 ERP/BI shop_id**。已验证 ERP `14132514` 对应抖店 `87755028`，不混用 |
| `platform_shop_id` | 抖店真实后台 ID，采集时核实 |
| `platform_item_id` / `platform_link_id` | 此后台 `product_id`，与订单链接字段实测一致；不是 `promotion_id` |
| `commission_rate` | `cos_info.cos_ratio / 100`，公开、普通期间的达人佣金，不取范围最大值 |
| `commission_enabled` | 有已核实公开配置为 1（率可为 0）；未推广/策略关闭有明确证据时为 0、率为空 |
| `commission_type` | 页面语义“公开”“未推广”“策略关闭”；定向策略在附表保存，原始枚举另保留于 `raw_json` |
| `extra_rate` | 仅在指定达人加佣差值唯一且非负时填写；多个不同值时留空、查附表，不强行合并 |
| `ad_commission_rate` | 双佣金的投放期间费率，独立保存；不是团长加佣 |
| `link_status` | 下架明确为“下架”，封禁/清退为“失效”；推广中不等于商品在架，未知架状态留空 |
| `captured_at` | 本次观察时间，ISO8601 `+08:00` |
| `rate_captured_at` | 上次核实费率的时间；失效沿用历史时不会伪装成新测费率 |
| `source` | 本次数据来源接口路径，详见下表 |

只在接口明确返回最后配置、或已有历史时保留下架/失效商品的最后已知费率。API 未返回的链接保持未知，不能凭“未命中”写成失效或未挂佣金。策略关闭当前率为空，历史仍可查。历史佣金不因新批次更新而覆盖。

`commission_overrides` 保存指定达人策略，包含 `strategy_id`、`creator_id`、定向**绝对费率**、相对公开的 `extra_rate`、投放期费率和原始策略。多个达人/多个加佣均单独一行，不挤进主表单值。下架/清退策略的原始信息仍保留。当前已验证接口没有提供团长/服务商加佣，主表不会猜测填值；这些额外费率后续可按明确来源接入。

| 页面/接口 | 用途 |
| --- | --- |
| `/ffa/buyin/shop_smallshop/product/promote-manage` | 已验证的抖店内嵌精选联盟入口 |
| `/doudian_pc/pc/api/promotion/getDeliveredProductList` | 按 `product_info`（最多 50 ID）采集公开佣金 |
| `/doudian_pc/api/promotion/batchGetProducts` | 按 `title` 查未推广的确切 ID，验证未挂佣金 |
| `/doudian_pc/pc/api/strategy/getStrategyList` | 指定达人策略和详情，逐页校验 |

接口与官方前端 bundle 及页面在 2026-10-18 实测，属于后台内部接口。前端变更导致结构不符时采集失败并保留旧版本，不按缺省值继续写。

## 验收与发布

```sh
uv run commission sample --batch '<batch_id>' --output data/manual-sample.csv
# 人工查看后台，填 observed_rate（小数）、observed_enabled、checked_by、checked_at（带时区）、evidence
uv run commission check-samples --batch '<batch_id>' --input data/manual-sample.csv
uv run commission accept --batch '<batch_id>'
uv run commission publish --batch '<batch_id>' --output-dir data/publications
uv run commission upload --snapshot 'data/publications/<publication_id>/jst-commission-rates.sqlite' \
  --config config/daily.json
```

样本在第一次抽取时冻结；不能换随机种子抹掉不一致。所有目标任务完成、目标规模达到配置门槛、完整目标集合覆盖率 ≥98%、10 个手工样本全匹配，才能 `complete=1`。部分成功数据可通过明确授权的部分发布同步云端。`commission_rates_latest` 只暴露已验收批次；`commission_rates_available_latest` 暴露已明确发布的部分结果和正式验收结果，附批次质量标记。`collect` 不完整退出 2，业务错误退出 1。

发布文件为 **`/var/lib/xdr-sync/data/jst-commission-rates.sqlite`**，同目录 **`jst-commission-rates.sqlite.manifest.json`**。manifest 含 `dataset=commission_rates`、`publication_id`、`published_at`、各表 `row_counts`、SHA-256、验收报告。SQLite 内也保存相同 publication 元数据，可识别数据库/旁车文件短暂切换不一致的窗口。先上传暂存文件，云端重新校验校验和、完整性、外键、覆盖率和验收记录，再在独占发布锁内替换正式库及 manifest、保留 `.previous`，最后核对 ACK。网络失败保留本地产物与旧版本；ACK 丢失可用同一快照重试。

远端使用逐字段历史比较，拒绝删改已发布费率、定向策略、目标和人工核对记录。不会注册/改动其他数据集、重启云端服务。上传使用现有 SSH 身份文件，不在配置内保存凭据。所有历史在 SQLite 内保留；BI 连接和历史查询示例见 [bi_queries.sql](docs/bi_queries.sql)。

当前可显式发布部分结果（不改批次 complete 标记）：

```sh
uv run commission publish --batch '<batch_id>' --output-dir data/publications \
  --allow-partial --reason '用户要求立即同步已有结果，完整验收待完成'
```

`publication_releases` 保留发布范围与原因。部分发布同样检查字段合法性、数据库完整性、外键、历史不可覆盖及云端 ACK，manifest 同时保留完整目标集合覆盖率、待执行任务与抽样状态。

## 每日刷新

```sh
cp config/daily.example.json config/daily.json
# 设置正确目标门槛、正式店铺映射、首次人工验收 batch；要发布时设 publish=true
uv run commission daily --config config/daily.json
# 先生成可审阅 plist，默认每天 05:10
uv run python tools/install_daily.py --config config/daily.json
# 完成真实验收后安装
uv run python tools/install_daily.py --config config/daily.json --install
```

同日重跑续抓当日最近批次，次日新建批次。每日目标从事实 SQLite 重新读取；单批次中途不变。正式验收须人工完成 10 条；后续可在 `acceptance_reference` 中显式指定该批次，自动复用同一店铺映射配置与采集器代码哈希的人工验收。采集器或映射变化强制重新人工核对；新批次自己的失败抽样也不会被参考批次绕过。覆盖率及来源校验每天重新执行。失败/待核对记录到 `data/daily-status.json` 和 launchd 日志，并返回非零状态。

05:10 是启动时间，完成时间取决于目标规模、定向策略数量和会话可用性；配置文件与目标范围未验收前，本项目不会将未达标批次冒充每日完成。生产每日任务现已加载，部分发布策略为 `publish_partial=true`，不会伪造人工验收。

## BI 使用限制

每天快照可回溯“观察到的配置”，无法证明首次采集之前某个订单发生时的历史费率。公开率无法单独解释指定达人、投放期间佣金及账务时差，需结合 creator/ad 归因；不能把 `extra_rate` 无差别加给所有订单。`channel=unknown`、达人出单但链接未挂佣金、缺失链接应保留核算异常。全店佣金差异 <5% 是 BI 后续对账验收，本项目未用日报佣金反推或调整采集结果。
