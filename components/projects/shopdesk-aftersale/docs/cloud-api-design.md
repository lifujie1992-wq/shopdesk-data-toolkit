# 抖店售后「待商家审核」数据上云 · 技术方案

> 目标读者：负责实现云端服务的 AI / 工程师。  
> 上游数据来源：本机 `~/projects/shopdesk-aftersale/bin/scrape_counts.py`，每 30 分钟采集一次，  
> 产物为 `data/runs/<run_id>.json`（单轮明细）+ `data/latest.json` + `data/history.jsonl`。  
> 本文档给出云端 Node.js 服务的完整设计、接口契约、数据模型、部署与验收标准。

---

## 1. 目标与范围

### 1.1 要做的事

1. 云端提供一个 **接收接口**，本机采集器每 30 分钟把一轮采集结果（40 家店 × 6 个数字）一次性推上来。
2. 数据入库（Postgres 或 SQLite，见 §5），支持幂等重放、断网补传。
3. 提供最小可用的 **查询接口**：各店最新快照、单店历史、整体时间序列、轮次列表。
4. 提供 `/health`、结构化日志、错误码规范，便于长期无人值守运行。

### 1.2 明确不做

- 不做采集（采集在本机，靠「店铺工作台」登录态）。
- 不接收、不存储任何 Cookie / Token / 买家昵称 / 收货信息。**上行载荷只有店铺标识 + 6 个整数 + 状态**。
- 不做退款、审核、回传等任何写平台的动作。
- 第一版不做用户体系/多租户前端；只做「一个采集客户端 → 一个服务」的私有接口。

### 1.3 名词

| 名称          | 含义                                 |
| ----------- | ---------------------------------- |
| run         | 一次采集轮次（约 30 分钟一次，40 家店）            |
| shop        | 抖店店铺（`shop_id` 是店铺工作台的 UUID）       |
| counts      | 待商家审核的 6 个分项数量                     |
| needs_login | 该店会话失效，本轮未取到数据（**必须存 NULL，不能存 0**） |

---

## 2. 总体架构

```
┌─────────────────────── 本机 (macOS) ───────────────────────┐
│  店铺工作台.app  ──(本机接口/CDP)──> scrape_counts.py       │
│                                      │                     │
│                                      ├─ data/runs/*.json   │
│                                      └─ push.py（新增）    │
│                                            │ outbox + 重试  │
└────────────────────────────────────────────┼───────────────┘
                                             │ HTTPS POST /v1/ingest/runs
                                             │ Authorization: Bearer <token>
                                             ▼
┌──────────────────────── 云端 ──────────────────────────────┐
│  Caddy/Nginx (TLS, 443)                                     │
│        │                                                    │
│  Node.js 20 + TypeScript + Fastify                          │
│        ├── POST /v1/ingest/runs   （鉴权、校验、幂等 upsert）│
│        ├── GET  /v1/shops/latest                            │
│        ├── GET  /v1/shops/:shop_id/history                  │
│        ├── GET  /v1/metrics/timeseries                      │
│        ├── GET  /v1/runs                                    │
│        └── GET  /health                                     │
│        │                                                    │
│  Postgres 16（推荐）/ SQLite（MVP）                          │
└─────────────────────────────────────────────────────────────┘
```

**关键原则**

- 采集端「先落盘、再上云」：本地 JSON 是事实来源，云端是副本。上云失败不影响采集。
- 幂等：同一 `run_id` 重复推送结果一致（upsert，不产生重复行）。
- 只增不改语义：同一 `(run_id, shop_id)` 以最后一次推送为准（采集可能补数）。
- 云端不主动回连本机，不需要公网暴露采集机。

---

## 3. 技术选型（建议）

| 层      | 选择                                   | 理由                                                         |
| ------ | ------------------------------------ | ---------------------------------------------------------- |
| 运行时    | Node.js 20 LTS + TypeScript          | 长期支持、AI 生成代码质量高                                            |
| Web 框架 | Fastify 4                            | 内置 JSON Schema 校验与序列化，性能好                                  |
| 校验     | zod（或 Fastify JSON Schema）           | 入参强校验，错误信息清晰                                               |
| ORM    | Drizzle ORM（或 Prisma）                | 类型安全、迁移简单                                                  |
| 数据库    | Postgres 16（生产）/ SQLite（单机 MVP）      | 数据量极小（≈ 40 店 × 48 轮/天 ≈ 2k 行/天），SQLite 完全够；需要多人查询/备份上云则 PG |
| 日志     | pino（JSON 行）                         | 结构化、可直接被云日志采集                                              |
| 部署     | Docker Compose（app + db + caddy）     | 一条命令起服务                                                    |
| 进程守护   | Docker restart=always 或 systemd      | 无人值守                                                       |
| 测试     | vitest + supertest（或 Fastify inject） | 契约测试                                                       |

> 数据量估算：40 店 × 48 轮/天 × 365 ≈ **70 万行/年**，单表 + 两个索引毫无压力。

---

## 4. 接口契约

统一约定：

- Base URL：`https://<your-domain>/v1`
- 请求/响应均为 `application/json; charset=utf-8`
- 时间：ISO 8601 带时区（采集端发送 `+08:00`），服务端统一转 UTC 存储，返回时可选 `Asia/Shanghai`
- 字段命名：`snake_case`（与本地 JSON 保持一致，减少转换）
- 请求体上限 **1 MB**（一轮 40 店约 20 KB）
- 除 `/health` 外全部需要鉴权

### 4.1 鉴权

```
Authorization: Bearer <INGEST_TOKEN>
```

- `INGEST_TOKEN`：32 字节随机串（hex/base64url），只放在服务端环境变量与采集端配置文件，**不入库、不打日志**。
- 建议支持多个 token（`TOKENS=name:token,name2:token2`），便于轮换与区分来源。
- 可选增强（推荐，成本很低）：请求签名
  ```
  X-Timestamp: 1792222397            // unix 秒，与服务端偏差 > 300s 拒绝
  X-Signature: hex(HMAC_SHA256(secret, timestamp + "." + raw_body))
  ```
  防重放、防篡改。第一版可只做 Bearer。

失败返回 `401 {"error":{"code":"unauthorized",...}}`。

### 4.2 写入：`POST /v1/ingest/runs`

一次推送一整轮。**幂等**：以 `(run_id, shop_id)` 为唯一键 upsert。

请求体：

```json
{
  "schema_version": 1,
  "client": { "name": "shopdesk-mac", "version": "1.0.0", "timezone": "Asia/Shanghai" },
  "run": {
    "run_id": "20261017-162345-306bca",
    "started_at": "2026-10-17T16:23:45+08:00",
    "finished_at": "2026-10-17T16:26:11+08:00",
    "source": "https://fxg.jinritemai.com/ffa/merchant-aftersale-workbench/aftersale/list",
    "shops_total": 40,
    "shops_ok": 39,
    "shops_failed": 1,
    "total_count": 178
  },
  "shops": [
    {
      "shop_id": "ba958668-8bfc-4fc3-923f-0ab06dea66f2",
      "shop_name": "香朵儿官方旗舰店",
      "platform": "抖店",
      "captured_at": "2026-10-17T16:23:49+08:00",
      "status": "ok",
      "error": null,
      "counts": {
        "unshipped_refund": 0,
        "shipped_refund": 13,
        "return_refund": 0,
        "exchange": 0,
        "resend": 0,
        "repair": 0
      },
      "total_count": 13
    },
    {
      "shop_id": "9f2c0382-fa7e-4d34-8e04-60fe913291ea",
      "shop_name": "柒亿女装",
      "platform": "抖店",
      "captured_at": "2026-10-17T16:26:05+08:00",
      "status": "needs_login",
      "error": "会话已失效，需在工作台重新登录",
      "counts": null,
      "total_count": null
    }
  ]
}
```

校验规则（必须实现，缺一即 422）：

| 字段                           | 规则                                                                  |
| ---------------------------- | ------------------------------------------------------------------- |
| `schema_version`             | 必须为 `1`（不支持则 400，返回 `unsupported_schema_version`）                   |
| `run.run_id`                 | 1–64 字符，`[A-Za-z0-9._:-]`                                           |
| `run.started_at/finished_at` | 可解析的 ISO 8601；`finished_at >= started_at`                           |
| `shops`                      | 数组，长度 1–500                                                         |
| `shops[].shop_id`            | 必填，1–64 字符                                                          |
| `shops[].status`             | `ok` / `needs_login` / `error`                                      |
| `shops[].status=ok`          | `counts` 6 个键齐全且为 **非负整数**；`total_count` 必须等于 6 项之和（不一致则 422 并指出该店） |
| `shops[].status!=ok`         | `counts` 必须为 `null` 或省略；**禁止把缺失写成 0**                               |
| 重复 `shop_id`                 | 同一请求内重复 → 422                                                       |
| `shops_total`                | 若提供，必须等于 `shops.length`                                             |

成功响应（`200`，可含部分拒收）：

```json
{
  "ok": true,
  "run_id": "20261017-162345-306bca",
  "accepted": 39,
  "rejected": 1,
  "rejected_items": [
    { "shop_id": "9f2c...", "reason": "invalid_total_count" }
  ],
  "server_time": "2026-10-17T08:26:12.345Z"
}
```

- 全部接受：`200 accepted=N rejected=0`
- 部分拒收：仍 `200`，`accepted>0`，采集端应记录 `rejected_items` 但不重试（重试也不会通过）
- 整轮不合法：`422`，`{ "error": { "code": "validation_failed", "details": [...] } }`
- 幂等重放：同样返回 `200`，`accepted` 为本次 upsert 的条数；**不返回 409**

写入语义：

```sql
-- shop_counts 主键 (run_id, shop_id)，冲突则更新（同一轮补数覆盖旧值）
INSERT INTO shop_counts (...) VALUES (...)
ON CONFLICT (run_id, shop_id) DO UPDATE SET
  captured_at=EXCLUDED.captured_at, status=EXCLUDED.status, error=EXCLUDED.error,
  unshipped_refund=EXCLUDED.unshipped_refund, shipped_refund=EXCLUDED.shipped_refund,
  return_refund=EXCLUDED.return_refund, exchange=EXCLUDED.exchange,
  resend=EXCLUDED.resend, repair=EXCLUDED.repair,
  total_count=EXCLUDED.total_count, updated_at=now();
```

整轮写库必须放在**一个事务**里；`runs` 表按 `run_id` upsert 汇总字段。

### 4.3 查询：`GET /v1/shops/latest`

各店「最近一次成功快照」。

Query：`?status=ok|needs_login|all`（默认 `ok`）、`?with_zero=true`（默认包含 0 值店铺）。

```json
{
  "generated_at": "2026-10-17T08:30:00Z",
  "count": 39,
  "totals": { "unshipped_refund": 0, "shipped_refund": 173, "return_refund": 1,
              "exchange": 4, "resend": 0, "repair": 0, "total_count": 178 },
  "shops": [
    { "shop_id": "...", "shop_name": "SHALLDOER官方旗舰店",
      "captured_at": "2026-10-17T16:24:10+08:00", "run_id": "...", "status": "ok",
      "counts": { "unshipped_refund": 0, "shipped_refund": 41, ... },
      "total_count": 41,
      "delta_since_previous": 3,
      "pending_minutes": 0 }
  ]
}
```

- `delta_since_previous`：与该店上一次成功快照的 `total_count` 差值（可为负）。
- `pending_minutes`：当前时间与该店 `captured_at` 的分钟差，用于发现「某店 2 小时没数据了」。

### 4.4 查询：`GET /v1/shops/:shop_id/history`

Query：`from`、`to`（ISO 时间，默认最近 7 天）、`limit`（1–1000，默认 200，倒序）、`status`。

```json
{
  "shop_id": "ba958668-...",
  "shop_name": "香朵儿官方旗舰店",
  "points": [
    { "captured_at": "2026-10-17T16:23:49+08:00", "run_id": "...", "status": "ok",
      "counts": {...}, "total_count": 13 }
  ]
}
```

### 4.5 查询：`GET /v1/metrics/timeseries`

整体/分店铺的时间序列，按自动桶（30m / 1h / 1d）。

Query：`from`、`to`、`interval=30m|1h|1d`（默认 `1h`）、`shop_id`（可选，缺省为全部店铺求和）。

```json
{
  "interval": "1h",
  "series": [
    { "bucket": "2026-10-17T16:00:00+08:00",
      "unshipped_refund": 0, "shipped_refund": 178, "return_refund": 1,
      "exchange": 4, "resend": 0, "repair": 0, "total_count": 183,
      "shops_reported": 39 }
  ]
}
```

聚合规则：**桶内取每店最后一次成功快照再求和**（不是把多轮简单相加，否则数字会翻倍）。这是最容易写错的地方，需有单测。

### 4.6 查询：`GET /v1/runs`

Query：`limit`（默认 50，倒序）。返回轮次概览（`run_id`、开始/结束、店铺数、成功/失败、合计），用于排查采集是否按时跑。

### 4.7 健康检查：`GET /health`

无鉴权，`200` 表示进程可用；建议附 DB 探活：

```json
{ "ok": true, "version": "1.0.0", "db": "ok", "uptime_s": 12345 }
```

DB 不可用时返回 `503`。

### 4.8 错误格式（统一）

```json
{ "error": { "code": "validation_failed", "message": "human readable",
             "details": [{ "path": "shops[3].counts", "issue": "required" }],
             "request_id": "01J..." } }
```

错误码表：

| HTTP | code                                         | 场景                      |
| ---- | -------------------------------------------- | ----------------------- |
| 400  | `bad_request` / `unsupported_schema_version` | JSON 解析失败、版本不支持         |
| 401  | `unauthorized`                               | token 缺失/错误             |
| 403  | `forbidden`                                  | token 无写权限              |
| 404  | `not_found`                                  | shop_id 不存在             |
| 413  | `payload_too_large`                          | > 1 MB                  |
| 422  | `validation_failed`                          | 字段校验失败                  |
| 429  | `rate_limited`                               | 超频（建议 60 req/min/token） |
| 500  | `internal_error`                             | 未预期异常（日志里有 request_id）  |
| 503  | `db_unavailable`                             | 数据库不可用                  |

---

## 5. 数据模型（Postgres 版 DDL）

```sql
CREATE TABLE runs (
  run_id        TEXT PRIMARY KEY,
  started_at    TIMESTAMPTZ NOT NULL,
  finished_at   TIMESTAMPTZ,
  source        TEXT,
  shops_total   INT NOT NULL DEFAULT 0,
  shops_ok      INT NOT NULL DEFAULT 0,
  shops_failed  INT NOT NULL DEFAULT 0,
  total_count   INT NOT NULL DEFAULT 0,
  client        JSONB,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE shops (
  shop_id       TEXT PRIMARY KEY,
  shop_name     TEXT NOT NULL,
  platform      TEXT NOT NULL DEFAULT '抖店',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE shop_counts (
  run_id            TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  shop_id           TEXT NOT NULL REFERENCES shops(shop_id) ON DELETE CASCADE,
  captured_at       TIMESTAMPTZ NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('ok','needs_login','error')),
  error             TEXT,
  unshipped_refund  INT,   -- 未发货退款
  shipped_refund    INT,   -- 已发货退款
  return_refund     INT,   -- 退货退款
  exchange          INT,   -- 换货
  resend            INT,   -- 补寄
  repair            INT,   -- 维修
  total_count       INT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, shop_id),
  CONSTRAINT ok_requires_counts CHECK (
    status <> 'ok' OR (unshipped_refund IS NOT NULL AND shipped_refund IS NOT NULL
      AND return_refund IS NOT NULL AND exchange IS NOT NULL
      AND resend IS NOT NULL AND repair IS NOT NULL AND total_count IS NOT NULL)
  )
);

CREATE INDEX idx_counts_shop_time ON shop_counts (shop_id, captured_at DESC);
CREATE INDEX idx_counts_time      ON shop_counts (captured_at DESC);
CREATE INDEX idx_counts_ok_time   ON shop_counts (captured_at DESC) WHERE status = 'ok';

-- 每店最近一次成功快照（查询用）
CREATE VIEW v_shop_latest AS
SELECT DISTINCT ON (c.shop_id)
       c.shop_id, s.shop_name, c.run_id, c.captured_at, c.status,
       c.unshipped_refund, c.shipped_refund, c.return_refund,
       c.exchange, c.resend, c.repair, c.total_count
FROM shop_counts c JOIN shops s USING (shop_id)
WHERE c.status = 'ok'
ORDER BY c.shop_id, c.captured_at DESC;
```


MVP 用 SQLite 时：`TIMESTAMPTZ → TEXT`（ISO 字符串），`JSONB → TEXT`，`DISTINCT ON` 用窗口函数改写。

---

## 6. 采集端需要配合的改动（`push.py`）

在现有脚本基础上新增推送层（`bin/push.py`），**不要改动采集逻辑**：

1. 每轮 `write_run()` 之后，把 `data/runs/<run_id>.json` 原样 POST 到云端；
2. 成功（HTTP 2xx）→ 在 `data/outbox/sent/<run_id>.json` 落标记（或移动文件）；
3. 失败 → 留在 `data/outbox/`，每 5 分钟重试一次，指数退避（1、2、4、8、16…上限 30 分钟）；
4. 启动时先补传 outbox（最多保留 7 天、200 轮）；
5. 令牌从环境变量 `AFTERSALE_API_URL` / `AFTERSALE_API_TOKEN` 读取（或 `~/.config/aftersale/env`，权限 600），**不写进仓库**；
6. 请求超时 20s，只对 5xx/网络错误重试；4xx（除 429）标记为 `dead`，不再重试并在日志告警；
7. 日志只记 `run_id / http_status / 耗时`，不打印 token。

伪代码：

```python
def push(path):
    body = open(path, "rb").read()
    payload = {"schema_version": 1,
               "client": {"name": "shopdesk-mac", "version": "1.0.0", "timezone": "Asia/Shanghai"},
               "run": json.loads(body),
               "shops": json.loads(body)["shops"]}
    # run 里已包含 shops，按 §4.2 结构组装：run 去掉 shops，shops 单独提出来
    req = urllib.request.Request(API + "/v1/ingest/runs", data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + TOKEN})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.status, json.loads(r.read())
```

> 注意：本地 run 文件里 `shops` 在 `run` 内部；上行时把它提到顶层（§4.2），或在服务端兼容两种结构（二选一，建议按 §4.2 规范，服务端严格校验）。

---

## 7. 项目结构与实现要点

```
aftersale-api/
├── src/
│   ├── server.ts            # Fastify 实例、插件注册
│   ├── config.ts            # env 读取 + zod 校验（启动即失败）
│   ├── auth.ts              # Bearer / HMAC 校验，常数时间比较
│   ├── routes/
│   │   ├── ingest.ts
│   │   ├── shops.ts
│   │   ├── metrics.ts
│   │   ├── runs.ts
│   │   └── health.ts
│   ├── schema.ts            # 入参 zod schema（§4.2 全部规则）
│   ├── repo/                # SQL 访问层（事务 upsert）
│   └── errors.ts            # 统一错误映射
├── migrations/              # Drizzle / node-pg-migrate
├── test/
│   ├── ingest.spec.ts       # 幂等、部分拒收、422 各分支
│   ├── aggregate.spec.ts    # 桶内“每店最后一次再求和”
│   └── fixtures/run.json
├── docker-compose.yml       # app + postgres + caddy
├── Dockerfile
├── .env.example
└── openapi.yaml             # 见同目录文件，可直接给前端/测试用
```

实现要点（易错清单）：

1. **时间统一**：入口用 `new Date(iso)`，落库 `TIMESTAMPTZ`；不要用字符串比较做时间查询。
2. **NULL ≠ 0**：`needs_login` 的 6 个字段和 `total_count` 必须为 `NULL`，`SUM` 时用 `COALESCE`，但展示「无数据」要区分 `NULL` 与 `0`。
3. **幂等**：`ON CONFLICT DO UPDATE`，整轮一个事务；`runs` 与 `shop_counts` 同事务。
4. **`total_count` 一致性校验**：服务端重算并比对，不一致拒收该店（防止采集端算错悄悄污染）。
5. **聚合口径**：`timeseries` 必须「每桶内每店取最后一条成功记录再求和」；`shops_reported` 用于识别该桶数据缺失。
6. **参数化 SQL**：全部使用占位符，禁止拼接。
7. **限流**：`@fastify/rate-limit`，60 req/min/token；超限 429。
8. **请求体大小**：`bodyLimit: 1_048_576`。
9. **日志**：pino，字段 `request_id, method, path, status, ms, token_name`；**禁止打印 Authorization**；`ingest` 额外记录 `run_id, accepted, rejected`。
10. **关闭**：收到 SIGTERM 先停止接收、等待在途请求（Fastify `closeGracefully`），再关连接池。
11. **迁移**：启动时不自动迁移；用 `npm run migrate` 在部署流程中执行。
12. **时钟**：服务端只信任 `captured_at` 用于业务，`received_at` 用服务端时间；若 `captured_at` 与服务端相差 > 2 天，记录告警字段但不拒收。

---

## 8. 部署与运维

### 8.1 环境变量（`.env.example`）

```ini
NODE_ENV=production
PORT=8080
DATABASE_URL=postgres://aftersale:***@db:5432/aftersale
# 采集端令牌，格式 name:token，逗号分隔；支持轮换
TOKENS=mac-mini:6f1c...c9
# 可选：启用 HMAC 签名
HMAC_SECRET=
RATE_LIMIT_PER_MIN=60
LOG_LEVEL=info
TZ=Asia/Shanghai
```

### 8.2 docker-compose（示意）

```yaml
services:
  api:
    build: .
    restart: always
    env_file: .env
    depends_on: [db]
    ports: ["127.0.0.1:8080:8080"]   # 只监听回环，由 caddy 反代
  db:
    image: postgres:16-alpine
    restart: always
    environment:
      POSTGRES_DB: aftersale
      POSTGRES_USER: aftersale
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes: ["pgdata:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U aftersale"]
      interval: 10s
  caddy:
    image: caddy:2-alpine
    restart: always
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
volumes: { pgdata: {}, caddy_data: {} }
```

```
# Caddyfile
api.example.com {
  reverse_proxy api:8080
}
```

### 8.3 安全清单

- 仅 HTTPS；HTTP 301 跳转。
- 令牌长度 ≥ 32 字节，随机生成；每季度轮换；服务端只存哈希也可（可选）。
- 常数时间比较（`crypto.timingSafeEqual`）。
- 可选 IP 白名单（采集机出口 IP 固定时最有效）。
- 关闭 CORS（无浏览器调用方）；不返回 `X-Powered-By`。
- 数据库不对公网暴露，只走 compose 内网。
- 备份：`pg_dump` 每日 + 保留 14 天；SQLite 则每日 `.backup` + 保留 14 天。
- 数据保留：明细保留 2 年，之后按月归档（数据量很小，可先不归档）。

### 8.4 监控

- 外部探活 `GET /health`（1 分钟）。
- 告警条件（任一）：
  - 最近 90 分钟没有新 `run`（采集停了）；
  - 单轮 `shops_failed > 5`；
  - 某店 `needs_login` 连续 2 轮；
  - 5xx 比例 > 1%。
- 建议直接用云厂商日志服务采集 pino JSON，按 `level>=error` 告警。

---

## 9. 验收标准（给实现方）

必须通过：

1. `POST /v1/ingest/runs` 用同一 `run_id` 连续调用 3 次 → `shop_counts` 行数不变（幂等）。
2. `needs_login` 的店铺入库后 6 个字段与 `total_count` 均为 `NULL`；`GET /v1/shops/latest?status=all` 能返回该店并标注状态。
3. `total_count` 与 6 项之和不一致 → 该店被拒收，同请求其他店正常入库（`200, rejected=1`）。
4. `counts` 为负数 / 小数 / 缺键 → 422。
5. `GET /v1/metrics/timeseries?interval=1h`：同一小时内推了 2 轮，结果不翻倍（每店取最后一条）。
6. 未带 token / 错误 token → 401；60 次/分钟以上 → 429。
7. `GET /v1/shops/:id/history?from=..&to=..` 分页与排序正确（倒序）。
8. 请求体 2 MB → 413。
9. SIGTERM 时在途请求正常完成，无 5xx。
10. `openapi.yaml` 与实现一致（用 `npx @redocly/cli lint` 通过）。

---

## 10. 交付顺序建议

1. 起 Fastify + `/health` + 鉴权 + 统一错误；
2. 迁移脚本 + `ingest` 事务 upsert + 校验（含 §9.1–9.4 测试）；
3. `shops/latest`、`runs`；
4. `history`、`timeseries`（含 §9.5 测试）；
5. Docker Compose + Caddy + 备份脚本；
6. 输出采集端 `push.py` 对接说明与联调（用本地 3 轮历史 JSON 做回归）。

---

## 附录 A：`schema_version` 演进

- 新增可选字段：不改版本号。
- 新增必填字段 / 改语义：`schema_version + 1`，服务端同时支持 N 与 N-1，采集中间态安全。
- 客户端版本号放在 `client.version`，便于排查。

## 附录 B：手工联调命令

```bash
TOKEN=...
API=https://api.example.com

curl -sS -X POST "$API/v1/ingest/runs" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @sample-run.json | jq

curl -sS "$API/v1/shops/latest" -H "Authorization: Bearer $TOKEN" | jq '.totals'
curl -sS "$API/v1/metrics/timeseries?interval=1h" -H "Authorization: Bearer $TOKEN" | jq '.series[-3:]'
curl -sS "$API/health" | jq
```
