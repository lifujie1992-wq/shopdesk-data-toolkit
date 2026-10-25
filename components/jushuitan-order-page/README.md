# jst-order-page

独立读取聚水潭 **常用 → 订单 → 内部订单号旁「详」→ 销售订单详情**。  
不是「数据 → 订单明细查询」，不套用 `jst-orders` 的已发货、排除标签等报表口径。

需要 Node.js 22+、已连接且启用 browser_evaluate 的 OpenBridge，以及 Chrome 中已登录并打开的订单管理页面。复用浏览器会话，不读取/导出 Cookie。

多浏览器连接时会逐个核对真实订单页，并明确固定浏览器连接与标签页；登录页
URL 中的订单跳转参数不算有效订单页。`com.xdr.jst-auth-refresh` 定时刷新订单
工具的专用页，保留用户 ERP 页及售后任务页；Keychain 更新由该独立刷新任务负责。

```sh
jst-order-page login-status
jst-order-page list --limit 20
jst-order-page count
jst-order-page detail --id 94894206 --output order.sqlite
jst-order-page capture --limit 20 --output orders.sqlite
jst-order-page capture --filters examples/sent.json --limit 3 --output sent.sqlite
jst-order-page sync-day --output jst-order-today.sqlite
jst-order-page sync-day --date 2026-09-08 --output jst-order-2026-09-08.sqlite
jst-order-page render --input orders.sqlite --output orders.html
jst-order-page schema --input orders.sqlite --output fields.json
```

尚未安装命令时，使用 `node bin/jst-order-page.js` 替代 `jst-order-page`。

## 当天订单同步

`sync-day` 支持最多 10 万单的单日列表同步。默认按 `Asia/Shanghai` 的今天筛选，  
底层每页请求页面支持的最大值 2000，最多约 50 页；先计数、再顺序翻页，最后复查  
计数。同步开始时会固定截止时间，新进入的订单留给下一次运行，避免翻页过程中  
列表漂移：

```sh
jst-order-page sync-day --output jst-order-today.sqlite
```

订单平台可能延迟补写付款时间；日内高频同步可增加  
`--settle-minutes 5 --date-field pay_date`，只固定到五分钟前，尾部订单留给下一轮，  
避免完整性复查因少量回填而持续漂移。

也可以用 `--date YYYY-MM-DD` 同步指定日期；过去日期的截止时间为当天  
`23:59:59`。`--page-size` 仅接受页面原生支持的  
20/50/100/200/500/1000/1500/2000，默认 2000。  
当天计数超过 100000 时会在读取分页前失败并保留旧数据库，不会静默截断。

这个命令只读取订单列表，不逐单打开「详」，因此不会为 4 万单额外发起详情、  
支付、日志和售后请求。每页到达后立即写入临时 SQLite，全部页数和唯一订单数都  
与计数一致时才原子替换输出文件；中途失败会保留旧文件。

数据库包含：

- `sync_metadata`：日期、固定时间窗口、页大小、页数和完整性计数；
- `orders`：常用查询字段以及一份完整列表行 `json`，不再重复保存整份快照；
- `order_items`：基于 `orders.json` 的商品明细视图，不额外复制商品 JSON。

```sh
sqlite3 jst-order-today.sqlite \
  'select day,unique_count,pages_completed from sync_metadata;'
sqlite3 jst-order-today.sqlite \
  'select status,count(*) from orders group by status order by count(*) desc;'
```

输出仍含订单业务数据并保持 0600 权限。`schema`/`render` 面向原来的详情快照，  
不用于 `sync-day` 数据库。

`list`/`capture` 默认沿用订单页当前筛选；`--id` 使用精确内部订单号查询，覆盖页面筛选。`--filters` 接受页面协议的 `{k,v,c,t?}` 数组。`--page` 是服务端页号；`--limit` 是最多保留条数，底层页大小向上取页面支持的 20/50/100/200/500/1000/1500/2000。若 limit 小于页大小，后续 `--page` 会跳过本页未保存行；完整的当天列表请使用 `sync-day`。详情采集每次最多 20 条，顺序读取，不自动遍历全部订单。

`DataCount=-1`、`PageCount=0`、`IsLast=true` 可能只是列表懒计数占位，不能据此判断总数/末页；使用 `count` 查询真实总数。分页查询是实时视图，没有事务快照保障，新订单进入时跨页可能漂移。这一版是接口验证和有界快照工具，不是生产全量/增量同步器。

保存内容包含：原始列表行、100 个页面列定义（名称、显示、类型、宽度、排序、说明）、订单主数据、完整商品请求、支付、操作日志、售后、收入及优惠、扩展字段和详情中文标签。新增或未识别字段不会丢弃。不同状态/平台可能返回不同字段，样本字段清单不是完整服务端契约。

SQLite 表为 `snapshot`、`orders`、`details`、`order_items`、`order_pays`、`order_actions`、`order_aftersales`，用 JSON 保留所有字段，可直接用 SQLite JSON 函数查询。文件先写临时文件，成功后原子替换；读取失败不会覆盖原快照。JSON、SQLite 和生成的 HTML 权限均为 0600。

离线网页支持搜索、自定义列和“详细”弹窗，包含全部已采集数据与原始字段查看。它是数据还原原型，不是原站像素级复刻，不提供修改、审核或发货操作。图片 URL 保留为字段，离线页面不向外站发送请求。界面保留接口当前遮罩/密文，不调用查看真实手机号等解密/报备操作。

详细请求协议、验证证据与尚未覆盖项见 [ARCHAEOLOGY.md](ARCHAEOLOGY.md)。[FIELD-SCHEMA.json](FIELD-SCHEMA.json) 只包含样本字段路径和类型；[INTERFACE-CANDIDATES.json](INTERFACE-CANDIDATES.json) 是静态引用清单，包含写操作，不能直接用于自动调用。

```sh
npm test
node scripts/catalog.js  # 仅扫描当前打开的订单列表/详情函数引用
```
