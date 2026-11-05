# jst-sales

Read 聚水潭销售业绩 by shop and save daily snapshots to SQLite without Feishu.

## Authentication

The CLI shares the three-field macOS Keychain session created by:

```bash
jst-inventory auth import
```

## Usage

```bash
jst-sales login-status
jst-sales fetch --date 2026-09-05
jst-sales sync-sqlite --date 2026-09-05
jst-sales summary --date 2026-09-05
jst-sales list --date 2026-09-05 --limit 20
```

The default date is yesterday in Asia/Shanghai. The default database is `~/jst-sales-performance.sqlite`.

The `sales_performance` table uses stable English column names and retains each complete API row in `raw_json`. The `销售业绩报告` view exposes the original Feishu-style Chinese headers. Re-syncing the same date replaces that date atomically.
