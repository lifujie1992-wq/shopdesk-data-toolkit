# jst-orders

Read 聚水潭「订单明细查询」 and store a rolling order snapshot in SQLite.

```bash
jst-orders login-status
jst-orders count --days 30
jst-orders sync-sqlite --days 30
jst-orders summary
jst-orders list --limit 20
```

The report has two tabs. Use `--dimension order` (default) for `订单`, or  
`--dimension item` for `订单（商品）`. Item exports default to  
`~/jst-order-item-details.sqlite`, with rows in `order_item_details`.

The default range is the latest 30 complete Shanghai days. Order exports default  
to `~/jst-order-details.sqlite`; item exports default to  
`~/jst-order-item-details.sqlite`. Authentication is shared with  
`jst-inventory auth import`.

The verified report filters by shipment time and sent orders, splits bundle products, and excludes unfinished orders, exchange orders, `特殊单`, and `统计排除标`. The database is written through a temporary file and atomically replaced only after a complete successful export.

The database contains logistics and order message information. Its file mode is restricted to the current macOS user (`0600`). Do not publish or attach it to agent prompts.

# Incremental XDR export

XDR can retain the existing historical database while replacing only the requested  
date range:

```bash
jst-orders sync-sqlite --days 1 --end-date 2026-09-07 \
  --merge-existing ./previous.sqlite --output ./next.sqlite
```

Rows outside the requested send-date range are preserved. Rows inside the range  
are replaced by the latest API result so removed or newly excluded orders do not  
linger.
