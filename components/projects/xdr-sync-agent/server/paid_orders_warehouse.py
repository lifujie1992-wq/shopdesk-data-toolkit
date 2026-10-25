#!/usr/bin/env python3
"""Materialize paid-order ODS rows into read-only sales-channel warehouse tables."""

from __future__ import annotations

import json
import sqlite3
from datetime import date, datetime, timedelta, timezone
from pathlib import Path


WINDOWS = (1, 3, 7, 15, 30)


def _clean(value):
    return int(value) if isinstance(value, float) and value.is_integer() else value


def _validate_batch(db: sqlite3.Connection) -> sqlite3.Row:
    db.row_factory = sqlite3.Row
    batches = db.execute(
        "SELECT * FROM export_batches WHERE complete=1 ORDER BY captured_at DESC"
    ).fetchall()
    if len(batches) != 1:
        raise ValueError("paid_orders_requires_one_complete_batch")
    batch = batches[0]
    start, end = date.fromisoformat(batch["start_date"]), date.fromisoformat(batch["end_date"])
    business = date.fromisoformat(batch["business_date"])
    if start > end or end > business:
        raise ValueError("paid_orders_invalid_date_range")
    expected = {(start + timedelta(days=offset)).isoformat()
                for offset in range((end - start).days + 1)}
    coverage = db.execute(
        "SELECT biz_date,count(*) AS n FROM export_coverage WHERE batch_id=? GROUP BY biz_date",
        (batch["batch_id"],),
    ).fetchall()
    actual = {row["biz_date"] for row in coverage if row["n"] == 1}
    if actual != expected or any(row["n"] != 1 for row in coverage):
        raise ValueError("paid_orders_incomplete_or_overlapping_coverage")
    shards = db.execute(
        "SELECT count(*),coalesce(sum(row_count),0),min(complete) FROM export_shards WHERE batch_id=?",
        (batch["batch_id"],),
    ).fetchone()
    raw_count = db.execute(
        "SELECT count(*) FROM paid_order_items_raw WHERE batch_id=?", (batch["batch_id"],)
    ).fetchone()[0]
    if not shards[0] or shards[2] != 1 or shards[1] != raw_count:
        raise ValueError("paid_orders_incomplete_shards")
    return batch


def _qty_columns(alias: str, business: date, today_complete: bool) -> str:
    expressions = []
    for days in WINDOWS:
        target = business - timedelta(days=1) if days == 1 else business - timedelta(days=days)
        start = target if days == 1 else business - timedelta(days=days)
        expressions.append(
            f"sum(CASE WHEN {alias}.biz_date BETWEEN '{start.isoformat()}' "
            f"AND '{(business - timedelta(days=1)).isoformat()}' THEN {alias}.sales_qty ELSE 0 END) "
            f"AS pay_qty_{days}d"
        )
    expressions.insert(0, (
        f"sum(CASE WHEN {alias}.biz_date='{business.isoformat()}' THEN {alias}.sales_qty ELSE 0 END) AS pay_qty_today"
        if today_complete else "NULL AS pay_qty_today"))
    return ",".join(expressions)


def materialize_paid_orders(database: Path, inventory: Path | None = None) -> dict:
    """Build DWD/ADS tables inside candidate DB; caller atomically publishes the file."""
    db = sqlite3.connect(database)
    db.row_factory = sqlite3.Row
    try:
        batch = _validate_batch(db)
        business = date.fromisoformat(batch["business_date"])
        captured_at = batch["captured_at"]
        with db:
            db.executescript("""
              DROP TABLE IF EXISTS dwd_paid_order_items;
              DROP TABLE IF EXISTS ads_sales_channel_snapshots;
              DROP TABLE IF EXISTS ads_platform_product_sales;
              DROP TABLE IF EXISTS ads_shop_product_sales;
              DROP TABLE IF EXISTS ads_link_product_sales;
              DROP TABLE IF EXISTS ads_sku_source_sales;
              DROP TABLE IF EXISTS ads_sku_shop_source_sales;
              DROP TABLE IF EXISTS bi_sku_platform_sales_daily;
              DROP TABLE IF EXISTS warehouse_runs;
              CREATE TABLE dwd_paid_order_items AS
                SELECT batch_id,shard_id,row_number,biz_date,pay_date,platform,shop_id,shop_name,
                       spu_id,sku_id,shop_spu_id,shop_sku_id,sales_qty,so_id,outer_so_id,o_id,
                       order_labels,influencer_id,influencer_name,sales_amount,refund_qty,
                       refund_amount,gross_margin,
                       CASE WHEN instr(coalesce(order_labels,''),'直播')>0 THEN '直播间'
                            WHEN instr(coalesce(order_labels,''),'精选联盟')>0
                                      OR trim(coalesce(influencer_id,''))<>'' THEN '精选联盟'
                            ELSE '商品卡' END AS source_category,raw_json
                  FROM paid_order_items_raw;
              CREATE UNIQUE INDEX dwd_paid_order_items_pk
                ON dwd_paid_order_items(batch_id,shard_id,row_number);
              CREATE INDEX dwd_paid_order_items_sku_day
                ON dwd_paid_order_items(sku_id,biz_date);
              CREATE INDEX dwd_paid_order_items_spu_day
                ON dwd_paid_order_items(spu_id,biz_date);
              CREATE INDEX dwd_paid_order_items_platform_sku
                ON dwd_paid_order_items(platform,sku_id);
              CREATE INDEX dwd_paid_order_items_shop_sku
                ON dwd_paid_order_items(shop_id,sku_id);
              CREATE TABLE ads_sales_channel_snapshots(
                query_type TEXT NOT NULL,product_id TEXT NOT NULL,count_type TEXT NOT NULL,
                captured_at TEXT NOT NULL,total INTEGER NOT NULL,raw_json TEXT NOT NULL,
                PRIMARY KEY(query_type,product_id,count_type));
              CREATE TABLE ads_platform_product_sales(
                spu_id TEXT NOT NULL,platform TEXT NOT NULL,start_date TEXT NOT NULL,end_date TEXT NOT NULL,
                pay_qty_today REAL,pay_qty_1d REAL,pay_qty_3d REAL,pay_qty_7d REAL,
                pay_qty_15d REAL,pay_qty_30d REAL,captured_at TEXT NOT NULL,quality TEXT NOT NULL,
                PRIMARY KEY(spu_id,platform));
              CREATE TABLE ads_shop_product_sales(
                spu_id TEXT NOT NULL,shop_id TEXT NOT NULL,shop_name TEXT,platform TEXT,
                start_date TEXT NOT NULL,end_date TEXT NOT NULL,pay_qty_today REAL,pay_qty_1d REAL,
                pay_qty_3d REAL,pay_qty_7d REAL,pay_qty_15d REAL,pay_qty_30d REAL,
                captured_at TEXT NOT NULL,quality TEXT NOT NULL,PRIMARY KEY(spu_id,shop_id));
              CREATE TABLE ads_link_product_sales(
                spu_id TEXT NOT NULL,shop_id TEXT NOT NULL,shop_name TEXT,platform TEXT,
                shop_spu_id TEXT NOT NULL,shop_sku_id TEXT,start_date TEXT NOT NULL,end_date TEXT NOT NULL,
                pay_qty_today REAL,pay_qty_1d REAL,pay_qty_3d REAL,pay_qty_7d REAL,
                pay_qty_15d REAL,pay_qty_30d REAL,captured_at TEXT NOT NULL,quality TEXT NOT NULL,
                PRIMARY KEY(spu_id,shop_id,shop_spu_id));
              CREATE TABLE ads_sku_source_sales(
                sku_id TEXT NOT NULL,spu_id TEXT,source_category TEXT NOT NULL,
                pay_qty_today REAL,pay_qty_1d REAL,pay_qty_3d REAL,pay_qty_7d REAL,
                pay_qty_15d REAL,pay_qty_30d REAL,captured_at TEXT NOT NULL,quality TEXT NOT NULL,
                source_labels TEXT,influencer_ids TEXT,PRIMARY KEY(sku_id,source_category));
              CREATE TABLE ads_sku_shop_source_sales(
                sku_id TEXT NOT NULL,spu_id TEXT,shop_id TEXT NOT NULL,shop_name TEXT,platform TEXT,
                source_category TEXT NOT NULL,pay_qty_today REAL,pay_qty_1d REAL,pay_qty_3d REAL,
                pay_qty_7d REAL,pay_qty_15d REAL,pay_qty_30d REAL,captured_at TEXT NOT NULL,
                quality TEXT NOT NULL,source_labels TEXT,influencer_ids TEXT,
                PRIMARY KEY(sku_id,shop_id,source_category));
              CREATE TABLE bi_sku_platform_sales_daily(
                biz_date TEXT NOT NULL,spu_id TEXT,sku_id TEXT NOT NULL,platform TEXT NOT NULL,
                sales_qty REAL NOT NULL,order_count INTEGER NOT NULL,sales_amount REAL,
                refund_qty REAL,refund_amount REAL,gross_margin REAL,
                PRIMARY KEY(biz_date,sku_id,platform));
              CREATE TABLE warehouse_runs(
                batch_id TEXT PRIMARY KEY,business_date TEXT NOT NULL,start_date TEXT NOT NULL,
                end_date TEXT NOT NULL,captured_at TEXT NOT NULL,published_at TEXT NOT NULL,
                raw_rows INTEGER NOT NULL,sku_snapshots INTEGER NOT NULL,platform_rows INTEGER NOT NULL,
                shop_rows INTEGER NOT NULL,link_rows INTEGER NOT NULL,source_rows INTEGER NOT NULL,
                quality TEXT NOT NULL);
            """)
            today_complete = date.fromisoformat(batch["end_date"]) >= business
            qty = _qty_columns("r", business, today_complete)
            start = (business - timedelta(days=30)).isoformat()
            end = business.isoformat()
            common = (start, end, captured_at, "order_derived")
            db.execute(f"""INSERT INTO ads_platform_product_sales
                SELECT spu_id,platform,?,?,{qty},?,?
                  FROM dwd_paid_order_items r
                 WHERE batch_id=? AND spu_id<>'' AND platform<>'' GROUP BY spu_id,platform""",
                       (*common, batch["batch_id"]))
            db.execute(f"""INSERT INTO ads_shop_product_sales
                SELECT spu_id,shop_id,max(shop_name),max(platform),?,?,{qty},?,?
                  FROM dwd_paid_order_items r
                 WHERE batch_id=? AND spu_id<>'' AND shop_id<>'' GROUP BY spu_id,shop_id""",
                       (*common, batch["batch_id"]))
            db.execute(f"""INSERT INTO ads_link_product_sales
                SELECT spu_id,shop_id,max(shop_name),max(platform),shop_spu_id,max(shop_sku_id),
                       ?,?,{qty},?,?
                  FROM dwd_paid_order_items r
                 WHERE batch_id=? AND spu_id<>'' AND shop_id<>'' AND shop_spu_id<>''
                 GROUP BY spu_id,shop_id,shop_spu_id""", (*common, batch["batch_id"]))
            db.execute(f"""INSERT INTO ads_sku_source_sales
                SELECT sku_id,max(spu_id),source_category,{qty},?,?,
                       group_concat(DISTINCT nullif(order_labels,'')),
                       group_concat(DISTINCT nullif(influencer_id,''))
                  FROM dwd_paid_order_items r
                 WHERE batch_id=? AND sku_id<>'' GROUP BY sku_id,source_category""",
                       (captured_at, "order_derived", batch["batch_id"]))
            db.execute(f"""INSERT INTO ads_sku_shop_source_sales
                SELECT sku_id,max(spu_id),shop_id,max(shop_name),max(platform),source_category,{qty},?,?,
                       group_concat(DISTINCT nullif(order_labels,'')),
                       group_concat(DISTINCT nullif(influencer_id,''))
                  FROM dwd_paid_order_items r
                 WHERE batch_id=? AND sku_id<>'' AND shop_id<>''
                 GROUP BY sku_id,shop_id,source_category""",
                       (captured_at, "order_derived", batch["batch_id"]))
            db.execute("""INSERT INTO bi_sku_platform_sales_daily
                SELECT biz_date,max(nullif(spu_id,'')),sku_id,platform,sum(sales_qty),
                       count(DISTINCT coalesce(nullif(so_id,''),nullif(outer_so_id,''),
                         nullif(o_id,''),'row:'||shard_id||':'||row_number)),
                       sum(sales_amount),sum(refund_qty),sum(refund_amount),sum(gross_margin)
                  FROM dwd_paid_order_items
                 WHERE batch_id=? AND sku_id<>'' AND platform<>''
                 GROUP BY biz_date,sku_id,platform""", (batch["batch_id"],))

            inventory_skus = []
            if inventory and inventory.is_file():
                db.execute("ATTACH DATABASE ? AS inventory", (str(inventory),))
                inventory_skus = db.execute("SELECT sku_id,spu_id FROM inventory.sku_inventory").fetchall()
            else:
                inventory_skus = db.execute(
                    "SELECT sku_id,max(spu_id) AS spu_id FROM dwd_paid_order_items GROUP BY sku_id"
                ).fetchall()
            inventory_spus = []
            if inventory and inventory.is_file():
                inventory_spus = db.execute("SELECT spu_id,spu_id FROM inventory.spu_inventory").fetchall()
            else:
                inventory_spus = db.execute(
                    "SELECT spu_id,spu_id FROM dwd_paid_order_items GROUP BY spu_id"
                ).fetchall()
            for query_type, product_column, catalog in (
                    ("sku", "sku_id", inventory_skus), ("spu", "spu_id", inventory_spus)):
                for item in catalog:
                    product_id, spu_id = str(item[0]), str(item[1] or "")
                    for count_type, group_cols in (("platform", ("platform",)),
                                                   ("channel", ("platform", "shop_id", "shop_name"))):
                        select = ",".join(group_cols)
                        grouped = db.execute(
                            f"SELECT {select},{qty} FROM dwd_paid_order_items r "
                            f"WHERE batch_id=? AND {product_column}=? GROUP BY " + select,
                            (batch["batch_id"], product_id),
                        ).fetchall()
                        rows = []
                        for grouped_row in grouped:
                            row = {key: grouped_row[key] for key in group_cols}
                            for field in ("pay_qty_today", "pay_qty_1d", "pay_qty_3d", "pay_qty_7d", "pay_qty_15d", "pay_qty_30d"):
                                row[field] = _clean(grouped_row[field])
                            rows.append(row)
                        rows.sort(key=lambda row: (-float(row["pay_qty_today"] or 0),
                                                   -float(row["pay_qty_30d"] or 0),
                                                   str(row.get("platform") or ""),
                                                   str(row.get("shop_id") or "")))
                        snapshot = {
                            "query_type": query_type, "product_id": product_id,
                            "sku_id": product_id if query_type == "sku" else None,
                            "spu_id": spu_id, "count_type": count_type,
                            "captured_at": captured_at, "business_date": end,
                            "start_date": start, "end_date": end, "total": len(rows), "rows": rows,
                            "source_api": "paid_order_excel_exports", "quality": "order_derived",
                            "coverage": "complete_manifest", "complete": True,
                            "is_complete_popup": False, "today_complete": today_complete,
                            "batch_id": batch["batch_id"],
                            "data_version": f"{batch['batch_id']}:{captured_at}",
                        }
                        db.execute("INSERT INTO ads_sales_channel_snapshots VALUES(?,?,?,?,?,?)",
                                   (query_type, product_id, count_type, captured_at, len(rows),
                                    json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"))))
            counts = {
                "raw_rows": db.execute("SELECT count(*) FROM dwd_paid_order_items").fetchone()[0],
                "sku_snapshots": db.execute("SELECT count(*) FROM ads_sales_channel_snapshots").fetchone()[0],
                "platform_rows": db.execute("SELECT count(*) FROM ads_platform_product_sales").fetchone()[0],
                "shop_rows": db.execute("SELECT count(*) FROM ads_shop_product_sales").fetchone()[0],
                "link_rows": db.execute("SELECT count(*) FROM ads_link_product_sales").fetchone()[0],
                "source_rows": db.execute("SELECT count(*) FROM ads_sku_shop_source_sales").fetchone()[0],
                "daily_rows": db.execute("SELECT count(*) FROM bi_sku_platform_sales_daily").fetchone()[0],
            }
            db.execute("INSERT INTO warehouse_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", (
                batch["batch_id"], end, batch["start_date"], batch["end_date"], captured_at,
                datetime.now(timezone.utc).isoformat(timespec="seconds"), counts["raw_rows"],
                counts["sku_snapshots"], counts["platform_rows"], counts["shop_rows"],
                counts["link_rows"], counts["source_rows"], "order_derived"))
        return {"batch_id": batch["batch_id"], **counts}
    finally:
        db.close()
