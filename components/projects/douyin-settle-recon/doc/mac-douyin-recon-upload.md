# Mac 账单报表上传接口对接文档

文档版本：1.4.0；日期：2026-10-23；新增平台与实时店铺信息契约，云端接收端需同步支持后再部署新上传端。

本文可直接交给 Mac 端开发人员。配套 [OpenAPI 文件](mac-douyin-recon-upload.openapi.json) 可导入 Apifox、Postman 等工具；服务端运行配置见[接收与存储说明](douyin-recon-receive-storage.md)。

## 1. 对接范围与联调准备

Mac 负责账单抓取、核对、生成 Excel 和 gzip；服务端负责接收文件、验证、数据库归档和 Excel 下载。**每次请求上传一个报表，多个报表由 Mac 排队串行上传。没有批量上传接口，也不接入企微同步。**

Mac 端需要取得以下配置，真实 Token 通过既有凭据配置交接，不放入本文或业务日志：

| 配置                     | 约定                                                              |
| ---------------------- | --------------------------------------------------------------- |
| `RECON_API_BASE`       | 正式入口为 `https://erp.xiangduoer.com`，不包含 `/api`，无尾斜杠；部署完成并验证后用于联调 |
| `INVOICE_ACCOUNT_ID`   | 已注册 Mac Worker 对应的工作台账号 ID，账号应处于启用状态                            |
| `INVOICE_WORKER_TOKEN` | 该账号当前有效的 Mac Worker Token；沿用现有发票 Worker 凭据                      |

正式上传地址：`https://erp.xiangduoer.com/api/douyin-recon/v1/reports`。

当前代码已完成本地测试，本次由运维自行部署，**尚未确认正式接口已发布或通过线上上传下载验证**。部署并按[部署说明](douyin-recon-deploy.md)完成验证后，Mac 使用上面的正式入口及已有有效凭据联调。

店铺信息由 Mac 在请求中提供。无需调用店铺刷新、查询配置或上传授权接口，也不校验账号到店铺的白名单。服务端保留 Mac 身份校验、运行记录的账号隔离、文件完整性及幂等校验。

## 2. 上传请求

```http
POST {RECON_API_BASE}/api/douyin-recon/v1/reports
X-Invoice-Account-Id: <账号 ID>
X-Invoice-Worker-Token: <当前 Token>
Content-Type: multipart/form-data; boundary=<客户端库自动生成>
```

必须同时提供两个身份请求头；不使用浏览器 Cookie 或 Bearer Token。multipart **恰好包含以下两部分**，顺序不限：

| part 名称    | 内容                                | 建议 Content-Type    |
| ---------- | --------------------------------- | ------------------ |
| `metadata` | 一个 JSON 对象，可作为普通文本字段或 JSON 文件部分发送 | `application/json` |
| `file`     | 一个 `.xlsx.gz` 附件，解压后得到原 Excel     | `application/gzip` |

附件的 multipart `filename` 必须与 `metadata.upload.filename` 完全一致，包括中文和大小写；如果本地缓存文件采用别名，上传时须显式指定正确的 filename。不要多传原 `.xlsx`、manifest 或第二个报表；不要设置整个请求的 `Content-Encoding: gzip`。请求边界交给客户端库生成，不手工拼接 Content-Type。

### 2.1 metadata 字段

| 字段                      | 类型     | 必填     | 规则                                                                |
| ----------------------- | ------ | ------ | ----------------------------------------------------------------- |
| `platform`              | string | 新客户端必传 | `douyin`（抖音）、`taobao`（淘宝）、`xiaohongshu`（小红书）；旧客户端省略时按 `douyin` 兼容 |
| `shop_id`               | string | 是      | 来源平台最新返回的稳定店铺 ID，1–128 字符；使用 `(platform, shop_id)` 唯一校验           |
| `shop_name`             | string | 否      | 首次入队前从来源平台取得的最新店名快照，1–255 字符；不使用工作台旧标签，不添加 `Y-` 等来源前缀             |
| `local_run_id`          | string | 是      | 本次产出的稳定运行 ID，1–128 字符；使用 manifest 中的 run_id，在账单业务域全局唯一；重试不变       |
| `reconciliation_date`   | string | 是      | 实际核对业务日期，北京时间 `YYYY-MM-DD`，必须为真实日历日期                              |
| `reconciliation_month`  | string | 是      | 所核对的账单月份，`YYYY-MM`，月份 01–12                                       |
| `reconciliation_status` | string | 否      | `matched`、`different` 或 `pending`；省略时为 `pending`，不要传 null         |
| `report`                | object | 是      | 原 Excel 的文件名、字节数和 SHA-256                                         |
| `upload`                | object | 是      | 本次 gzip 附件的文件名、字节数、SHA-256 和压缩类型                                  |

`reconciliation_date` 与 `reconciliation_month` 分别记录。例如 `2026-10-19` 核对 `2026-08` 合法；重传时沿用原日期，不改为重试当天。不要未经确认就把运行开始时间当成核对业务日期。

| 子字段                  | 类型      | 规则                                       |
| -------------------- | ------- | ---------------------------------------- |
| `report.filename`    | string  | 原文件名，必须为 `YYYYMM【抖音】Y-店铺名.xlsx`，年月与账单月份一致，兼容旧版 `YYYYMM【抖音】店铺名.xlsx` |
| `report.size_bytes`  | integer | 原 Excel 的实际字节数，大于 0                      |
| `report.sha256`      | string  | 原 Excel 的 SHA-256，64 位小写十六进制             |
| `upload.filename`    | string  | 必须等于 `report.filename + ".gz"`           |
| `upload.size_bytes`  | integer | 实际发送的 gzip 字节数，大于 0                      |
| `upload.sha256`      | string  | 实际发送的 gzip 字节的 SHA-256，64 位小写十六进制        |
| `upload.compression` | string  | 固定为 `gzip`                               |

上述子字段均必填。两个文件名分别限制为最多 255 字符，不能包含 `/`、`\` 或控制字符；业务字符串也不能包含控制字符。顶层及 `report`、`upload` 不接受额外字段，账号归属由已验证的请求头确定，不放入 metadata。文件名仅作展示和下载命名，服务端不据其推断店铺身份。

### 2.2 格式示例

下面仅展示结构；大小与哈希是占位值，**不能直接上传**。实际值从本次产物计算，可使用第 3 节示例。

```json
{
  "platform": "douyin",
  "shop_id": "87755028",
  "shop_name": "测试店铺",
  "local_run_id": "20261019T100000Z-example-run",
  "reconciliation_date": "2026-10-19",
  "reconciliation_month": "2026-08",
  "reconciliation_status": "pending",
  "report": {
    "filename": "202608【抖音】测试店铺.xlsx",
    "size_bytes": 123456,
    "sha256": "<原 Excel 的 64 位小写 SHA-256>"
  },
  "upload": {
    "filename": "202608【抖音】测试店铺.xlsx.gz",
    "compression": "gzip",
    "size_bytes": 100000,
    "sha256": "<实际 gzip 的 64 位小写 SHA-256>"
  }
}
```

## 3. 可执行的调用示例

### 3.1 为一个运行准备配置

下列配置中的路径、店铺、日期、运行 ID 及凭据需要替换为实际值。示例假定 Mac 已经生成原 Excel 及对应 gzip，不重新生成账单。

```sh
export RECON_API_BASE='https://erp.xiangduoer.com'
export INVOICE_ACCOUNT_ID='<已注册账号 ID>'
export INVOICE_WORKER_TOKEN='<通过既有凭据配置取得的当前 Token>'

export RECON_XLSX_PATH='/本次运行目录/202608【抖音】测试店铺.xlsx'
export RECON_GZIP_PATH="${RECON_XLSX_PATH}.gz"
export RECON_METADATA_PATH='/本次运行目录/upload-metadata.json'
export RECON_SHOP_ID='douyin_shop_001'
export RECON_SHOP_NAME='测试店铺'
export RECON_RUN_ID='<manifest 中本次运行的 run_id>'
export RECON_DATE='2026-10-19'
export RECON_MONTH='2026-08'
export RECON_STATUS='pending'
```

### 3.2 生成 metadata（已有正确 metadata 时可跳过）

以下 Python 3 标准库示例流式计算两个现有文件的哈希。它只在首次对接时辅助生成 JSON，不替代服务端解压校验。输出文件必须尚不存在；同一运行重试应复用已经保存的 metadata，不重复生成或修改快照。

```python
import hashlib
import json
import os
from pathlib import Path

def file_info(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return {"size_bytes": path.stat().st_size, "sha256": digest.hexdigest()}

xlsx = Path(os.environ["RECON_XLSX_PATH"])
gzip_file = Path(os.environ["RECON_GZIP_PATH"])
metadata = {
    "platform": os.environ.get("RECON_PLATFORM", "douyin"),
    "shop_id": os.environ["RECON_SHOP_ID"],
    "local_run_id": os.environ["RECON_RUN_ID"],
    "reconciliation_date": os.environ["RECON_DATE"],
    "reconciliation_month": os.environ["RECON_MONTH"],
    "reconciliation_status": os.environ.get("RECON_STATUS", "pending"),
    "report": {"filename": xlsx.name, **file_info(xlsx)},
    "upload": {
        "filename": xlsx.name + ".gz",
        "compression": "gzip",
        **file_info(gzip_file),
    },
}
if os.environ.get("RECON_SHOP_NAME"):
    metadata["shop_name"] = os.environ["RECON_SHOP_NAME"]
with Path(os.environ["RECON_METADATA_PATH"]).open("x", encoding="utf-8") as stream:
    json.dump(metadata, stream, ensure_ascii=False, indent=2)
```

### 3.3 发送单个文件

建议连接超时 10 秒，整次请求超时 360 秒；服务端默认总处理时间上限为 300 秒。以下 curl 自动读取 metadata 中的上传文件名，显式覆盖附件名，支持本地 gzip 缓存采用别名的情况。

```sh
RECON_UPLOAD_FILENAME=$(python3 -c 'import json,os; print(json.load(open(os.environ["RECON_METADATA_PATH"], encoding="utf-8"))["upload"]["filename"])')

curl --fail-with-body --connect-timeout 10 --max-time 360 \
  -X POST "${RECON_API_BASE}/api/douyin-recon/v1/reports" \
  -H "X-Invoice-Account-Id: ${INVOICE_ACCOUNT_ID}" \
  -H "X-Invoice-Worker-Token: ${INVOICE_WORKER_TOKEN}" \
  -F "metadata=@${RECON_METADATA_PATH};type=application/json" \
  -F "file=@${RECON_GZIP_PATH};filename=\"${RECON_UPLOAD_FILENAME}\";type=application/gzip"
```

请求头凭据不能写入普通请求日志。集成 HTTP 客户端时用文件流发送附件，并让 multipart 库编码 UTF-8 文件名；不要求一次把整个文件读进内存。

## 4. 回执与成功判定

首次归档返回 HTTP **201**、`duplicate=false`；同账号同内容重传返回 HTTP **200**、`duplicate=true`。两种都表示成功，不要只接受其中一种状态码。

```json
{
  "code": "OK",
  "message": "同步成功",
  "data": {
    "report_id": "rpt_<服务端生成的 UUID>",
    "local_run_id": "20261019T100000Z-example-run",
    "stored": true,
    "duplicate": false,
    "excel_sha256": "<与请求 report.sha256 一致>",
    "download_url": "/recon/files/<服务端生成的随机文件标识>"
  }
}
```

Mac 只在下列条件全部满足时，将该运行标记为同步完成并保存回执：

1. HTTP 状态为 200 或 201，响应能解析为 JSON，`code == "OK"`。
2. `data.stored` 严格等于布尔值 `true`，`data.report_id` 非空。
3. `data.local_run_id` 等于本次原运行 ID。
4. `data.excel_sha256` 等于本地原 Excel 的 SHA-256。

不要只判断 HTTP 成功或中文 `message`。建议保存本次使用的账号 ID、原运行 ID、report_id、哈希、下载地址、duplicate 和接收回执的本地时间；回执中不保存 Token。确认成功前保留本地文件、metadata 和上传任务。

`download_url` 可以是绝对 HTTP(S) 地址，也可以是 `/recon/files/...` 站点绝对路径。客户端应以 `RECON_API_BASE` 的站点根地址解析，例如 Python `urllib.parse.urljoin(RECON_API_BASE.rstrip("/") + "/", download_url)`；不要相对于 `/api/douyin-recon/v1/` 拼接。

`stored=true` 只表示 Excel 和数据库记录持久保存成功，不表示账单核对结果一致；`pending`、`different` 报表同样可归档。2026-10-25 起可通过GET回执查询的 `data.sync` 分页验证企微同步；归档成功不等于费用页同步成功。

2026-10-25 后续用户确认：明确千川无权限时允许部分报告使用 `pending` 归档，千川金额保留未知，其他有效账户正常交付；不新增metadata字段或采集状态工作表。Mac端仍校验其他账户及相关数据校验缓存，千川超时/下载失败或其他数据异常不会按无权限放行。云端需按有效指标汇总，千川缺失及其依赖总额不得补0；费用页同步成功也不能表示千川数据已补齐。权限恢复后Mac端使用新运行ID补采更新，同一次上传的网络重试仍复用冻结任务。

## 5. 幂等、串行队列与失败重试

`local_run_id` 是一次真实核对产出的唯一标识。一个新的计算运行使用新的运行 ID；网络重传继续使用原运行 ID。

- 同账号、同运行 ID、同业务字段及同原 Excel 文件名/大小/哈希，返回已有回执及同一下载地址。
- `platform` 在旧请求中省略时按 `douyin` 归一化；新客户端每次显式提供。服务端按 `(platform, shop_id)` 关联店铺，不能按店名关联。不同平台的同值 ID 属于不同店铺；同平台同 ID 改名仍属于原店铺，店铺档案名称更新为本次最新快照，历史报表名称快照保持原值。
- `shop_name` 省略按 null 比较，状态省略按 `pending` 比较；首次入队前刷新平台身份，入队后冻结 `platform`、`shop_id`、`shop_name`。同一运行重试不因改名更换名称，否则返回 409；需要反映新的店名时建立新的运行。旧队列保持原请求，不强行增加字段。
- 云端必须校验平台枚举，持久保存并在 GET 报表查询的 `metadata.platform` 中原样返回。新请求的平台未被云端保存或回传时，Mac 端校验失败，保留本地数据。
- `(platform, shop_id)` 的唯一约束用于店铺档案，不是报表记录；同一家店可以保存多个账期和多个运行版本。报表幂等仍使用现有的 `local_run_id` 规则，不能因为店铺 ID 相同而覆盖或拒绝其他月份报表。
- 重新 gzip 可能改变压缩字节。只要本次 upload 元数据与实际 gzip 一致，且解压后 Excel 及业务字段未变，仍可命中原记录；推荐直接保留原 gzip 重试。
- 已有运行属于另一个账号时返回 404，不能通过更换账号重复认领。Token 更新后，用同一账号的新有效 Token 可以继续重试。

默认同一账号仅允许 **1 个上传处理中**，全服务同时最多 2 个。Mac 端多个店铺或月份的报表采用串行队列，每份各自保存状态和回执；一份失败不清除其他已成功任务。不要额外上传一个包含多份 Excel 的 ZIP。

| 情况                                   | Mac 处理方式                                    |
| ------------------------------------ | ------------------------------------------- |
| 超时、断线、响应丢失、成功状态下回执无法解析或不能确认内容        | 保留原任务，按同账号、同运行 ID、同报表重试；服务端可能已归档，重试后会返回已有回执 |
| HTTP 429                             | 优先遵守 `Retry-After`（当前为 30 秒），避免同账号并发        |
| HTTP 500、502、503、504                 | 有限次数退避重试；持续失败时保留任务并提示排查。网关错误不一定返回 JSON      |
| HTTP 400、401、404、405、409、413、415、422 | 修正请求、凭据或配置后处理，不自动无限重试                       |

无 `Retry-After` 时，建议采用 30 秒、2 分钟、10 分钟的有限退避并加入少量抖动。失败不自动换运行 ID，不把新 ID 当成规避 409 的办法。服务器端不需要额外幂等请求头。

特别注意：**上传响应丢失时，客户端可能还没有 report_id。此时重新 POST 原上传请求即可，不需要先查询，也没有按 local_run_id 查询的独立接口。**

## 6. 可选查询和文件下载

### 6.1 查询本人报表

```http
GET {RECON_API_BASE}/api/douyin-recon/v1/reports/{report_id}
X-Invoice-Account-Id: <原创建账号>
X-Invoice-Worker-Token: <该账号当前有效 Token>
```


仅在已拿到 report_id 后需要核对时使用。正常上传成功后不必再查询一次。HTTP 200 返回 `code=OK`，`data` 包含上传回执数据、`metadata`、`shop_name` 及 `received_at`。其中 `metadata.shop_name` 可为 null；状态已补默认值。查询响应中的 `duplicate=false` 不代表历史上从未重传，幂等判断以 POST 回执为准。

不存在或归属其他账号时均返回 404；未登录浏览器不影响此接口，双请求头仍必须有效。

### 6.2 下载归档 Excel

```http
GET  {download_url}
HEAD {download_url}
```

先按第 4 节解析 download_url。任何持有完整链接的人都能下载，无需附带 Cookie 或 Mac Token。GET 返回原始 `.xlsx` 字节，HEAD 仅返回响应头；Content-Type 为 XLSX 类型，Content-Length 为原文件字节数，Content-Disposition 提供原中文文件名。

文件标识由服务端生成，不可自行拼接或从 report_id 推算。成功归档的链接不设置自动到期；幂等重传复用原链接。文件下载失败不应把已经确认的归档记录当成新运行重新上传，应保留回执排查。

## 7. 限制与错误码

以下为当前默认配置，正式联调以服务端及代理的实际限制为准：

| 项目              | 默认上限                   |
| --------------- | ---------------------- |
| 单次文件数           | 一个 `.xlsx.gz`          |
| metadata        | 64 KiB（UTF-8 字节）       |
| gzip 附件         | 100 MiB，即 104857600 字节 |
| 原 Excel         | 200 MiB，即 209715200 字节 |
| 整个 multipart 请求 | 101 MiB，即 105906176 字节 |
| 接收到归档的处理时间      | 300 秒                  |

Excel 还会经过内部 ZIP 展开大小、条目数量、CRC 及基本工作簿结构检查，不接收损坏工作簿、宏包或异常展开文件。metadata 声明的大小正确不代表可以绕过实际流式计量。

错误 JSON 格式：

```json
{
  "code": "FILE_HASH_MISMATCH",
  "message": "gzip 大小或 SHA-256 不匹配",
  "details": { "field": "upload" }
}
```

| HTTP | code                    | 含义                                  |
| ---- | ----------------------- | ----------------------------------- |
| 400  | `INVALID_REQUEST`       | multipart、JSON、必填部分或请求结构错误，或上传连接中断  |
| 401  | `UNAUTHORIZED`          | 身份头缺失，账号或 Worker 停用，Token 无效或不属于该账号 |
| 404  | `RUN_NOT_FOUND`         | 已有运行不属于当前账号，或查询的 report_id 不存在/不可访问 |
| 404  | `FILE_NOT_FOUND`        | 下载链接的文件标识不存在或格式无效                   |
| 405  | `INVALID_REQUEST`       | 请求方法或路径不支持                          |
| 409  | `RUN_CONTENT_CONFLICT`  | 同一运行 ID 对应不同业务快照或原 Excel            |
| 413  | `FILE_TOO_LARGE`        | metadata、请求、gzip 或原 Excel 超过限制      |
| 415  | `UNSUPPORTED_FILE_TYPE` | 未传 `.xlsx.gz`，或将整个 HTTP 请求设为 gzip   |
| 422  | `INVALID_METADATA`      | 字段值、日期、月份、文件名、压缩类型等不合法              |
| 422  | `FILE_HASH_MISMATCH`    | 声明大小或哈希与实际 gzip/Excel 不一致           |
| 422  | `INVALID_GZIP`          | gzip 损坏或不完整                         |

| 422 | `INVALID_EXCEL` | Excel 包结构无效或超过结构校验限制 |  
| 503 | `STORAGE_UNAVAILABLE` | 存储暂不可用、已有归档文件缺失，或上传处理超时 |  
| 429 | `RATE_LIMITED` | 上传并发达到限制，响应带 `Retry-After` |

当前没有店铺授权的 `SHOP_FORBIDDEN` 校验。HTTP 网关的错误响应可能不使用本表 JSON 结构，客户端应保留 HTTP 状态和脱敏错误摘要，不能将其标记为上传成功。

## 8. Mac 端联调验收

1. 上传真实 `.xlsx.gz`：取得 201 回执并按第 4 节确认 stored、运行 ID 和哈希。
2. 原请求再上传一次：取得 200、duplicate=true，report_id 及下载链接与首次相同。
3. 用下载链接取得 Excel，计算原文件哈希一致；HEAD 字节数正确。
4. 模拟断线或回执丢失后，以原运行 ID 重试，最终复用同一报表。
5. 用错误 Token 上传收到 401；用其他有效账号重传已有运行收到 404。
6. 同一运行修改核对日期或名称快照收到 409，不覆盖原记录。
7. 修改或截断 gzip、故意传错哈希，收到对应错误，不标记同步完成。
8. 串行上传多份报表，分别保存回执；失败项保留原信息等待单独重试。

2026-10-25费用验收还需按[千川空数据与公式缓存修改说明](2026-10-25_Mac端千川空数据与公式缓存修改说明.md)检查 `data.sync.is_current` 及费用汇总、数据校验两页各自的 `synced` 状态；余额页问题单独记录。

上传、重复提交、查询及下载规则已通过自动化回归测试。正式环境是否可用，以运维部署后的线上验证为准。
