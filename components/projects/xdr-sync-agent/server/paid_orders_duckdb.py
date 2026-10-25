#!/usr/bin/env python3
"""Build the paid-order BI serving warehouse with DuckDB.

The uploaded SQLite file remains the validated ODS/source of truth.  This module
builds a separate, read-only DuckDB file so publishing BI data no longer rewrites
the 2 GB SQLite ODS/DWD/ADS bundle on every daily replacement.
"""

from __future__ import annotations

import os
import sqlite3
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import duckdb

from paid_orders_warehouse import WINDOWS, _validate_batch


def _literal(value: object) -> str:
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"


def _qty_columns(business: date, today_complete: bool, alias: str = "r") -> str:
    expressions = []
    for days in WINDOWS:
        start = business - timedelta(days=days)
        end = business - timedelta(days=1)
        expressions.append(
            f"sum(CASE WHEN CAST({alias}.biz_date AS DATE) BETWEEN DATE '{start}' "
            f"AND DATE '{end}' THEN {alias}.sales_qty ELSE 0 END) AS pay_qty_{days}d"
        )
    today = (
        f"sum(CASE WHEN {alias}.biz_date='{business}' THEN {alias}.sales_qty ELSE 0 END)"
        if today_complete else "CAST(NULL AS DOUBLE)"
    )
    return ",".join((f"{today} AS pay_qty_today", *expressions))


def _load_sqlite_extension(db: duckdb.DuckDBPyConnection) -> None:
    try:
        db.execute("LOAD sqlite")
    except duckdb.Error:
        # Installation is a deployment-time operation.  This fallback makes a
        # first manual rollout self-bootstrapping while subsequent builds stay
        # independent of network availability.
        db.execute("INSTALL sqlite")
        db.execute("LOAD sqlite")


def build_paid_orders_duckdb(
    source: Path, output: Path, inventory: Path | None = None,
) -> dict:
    """Build a complete BI warehouse at *output* from a validated SQLite ODS."""
    source, output = Path(source).resolve(), Path(output).resolve()
    if not source.is_file():
        raise ValueError(f"paid order ODS does not exist: {source}")
    if output.exists():
        raise ValueError(f"DuckDB output already exists: {output}")

    with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as source_db:
        source_db.row_factory = sqlite3.Row
        batch = dict(_validate_batch(source_db))

    business = date.fromisoformat(batch["business_date"])
    today_complete = date.fromisoformat(batch["end_date"]) >= business
    qty = _qty_columns(business, today_complete)
    start = (business - timedelta(days=30)).isoformat()
    end = business.isoformat()
    batch_id = batch["batch_id"]
    captured_at = batch["captured_at"]
    quality = "order_derived"
    data_version = f"{batch_id}:{captured_at}"

    output.parent.mkdir(parents=True, exist_ok=True)
    db = duckdb.connect(str(output))
    try:
        _load_sqlite_extension(db)
        memory_limit = os.getenv("XDR_DUCKDB_MEMORY_LIMIT", "512MB")
        threads = max(1, min(int(os.getenv("XDR_DUCKDB_THREADS", "2")), 8))
        db.execute(f"SET memory_limit={_literal(memory_limit)}")
        db.execute(f"SET threads={threads}")
        db.execute(f"SET temp_directory={_literal(output.parent / (output.name + '.tmp'))}")
        db.execute(f"ATTACH {_literal(source)} AS ods (TYPE sqlite, READ_ONLY)")
        db.execute("SET preserve_insertion_order=false")
        db.execute("""
          CREATE TEMP TABLE dwd_paid_order_items AS
          SELECT batch_id,shard_id,row_number,biz_date,pay_date,platform,shop_id,shop_name,
                 spu_id,sku_id,shop_spu_id,shop_sku_id,sales_qty,so_id,outer_so_id,o_id,
                 order_labels,influencer_id,influencer_name,sales_amount,refund_qty,
                 refund_amount,gross_margin,
                 CASE WHEN contains(coalesce(order_labels,''),'直播') THEN '直播间'
                      WHEN contains(coalesce(order_labels,''),'精选联盟')
                                OR trim(coalesce(influencer_id,''))<>'' THEN '精选联盟'
                      ELSE '商品卡' END AS source_category
            FROM ods.paid_order_items_raw
        """)

        db.execute(f"""CREATE TABLE ads_platform_product_sales AS
          SELECT spu_id,platform,{_literal(start)} AS start_date,{_literal(end)} AS end_date,
                 {qty},{_literal(captured_at)} AS captured_at,{_literal(quality)} AS quality
            FROM dwd_paid_order_items r
           WHERE batch_id={_literal(batch_id)} AND spu_id<>'' AND platform<>''
           GROUP BY spu_id,platform ORDER BY spu_id,platform""")
        db.execute(f"""CREATE TABLE ads_shop_product_sales AS
          SELECT spu_id,shop_id,max(shop_name) AS shop_name,max(platform) AS platform,
                 {_literal(start)} AS start_date,{_literal(end)} AS end_date,
                 {qty},{_literal(captured_at)} AS captured_at,{_literal(quality)} AS quality
            FROM dwd_paid_order_items r
           WHERE batch_id={_literal(batch_id)} AND spu_id<>'' AND shop_id<>''
           GROUP BY spu_id,shop_id ORDER BY spu_id,shop_id""")
        db.execute(f"""CREATE TABLE ads_link_product_sales AS
          SELECT spu_id,shop_id,max(shop_name) AS shop_name,max(platform) AS platform,
                 shop_spu_id,max(shop_sku_id) AS shop_sku_id,
                 {_literal(start)} AS start_date,{_literal(end)} AS end_date,{qty},
                 {_literal(captured_at)} AS captured_at,{_literal(quality)} AS quality
            FROM dwd_paid_order_items r
           WHERE batch_id={_literal(batch_id)} AND spu_id<>'' AND shop_id<>'' AND shop_spu_id<>''
           GROUP BY spu_id,shop_id,shop_spu_id ORDER BY spu_id,shop_id,shop_spu_id""")
        db.execute(f"""CREATE TABLE ads_sku_source_sales AS
          SELECT sku_id,max(spu_id) AS spu_id,source_category,{qty},
                 {_literal(captured_at)} AS captured_at,{_literal(quality)} AS quality,
                 string_agg(DISTINCT nullif(order_labels,''),',') AS source_labels,
                 string_agg(DISTINCT nullif(influencer_id,''),',') AS influencer_ids
            FROM dwd_paid_order_items r
           WHERE batch_id={_literal(batch_id)} AND sku_id<>''
           GROUP BY sku_id,source_category ORDER BY sku_id,source_category""")
        db.execute(f"""CREATE TABLE ads_sku_shop_source_sales AS
          SELECT sku_id,max(spu_id) AS spu_id,shop_id,max(shop_name) AS shop_name,
                 max(platform) AS platform,source_category,{qty},
                 {_literal(captured_at)} AS captured_at,{_literal(quality)} AS quality,
                 string_agg(DISTINCT nullif(order_labels,''),',') AS source_labels,
                 string_agg(DISTINCT nullif(influencer_id,''),',') AS influencer_ids
            FROM dwd_paid_order_items r
           WHERE batch_id={_literal(batch_id)} AND sku_id<>'' AND shop_id<>''
           GROUP BY sku_id,shop_id,source_category ORDER BY sku_id,shop_id,source_category""")
        db.execute(f"""CREATE TABLE bi_sku_platform_sales_daily AS
          SELECT biz_date,max(nullif(spu_id,'')) AS spu_id,sku_id,platform,sum(sales_qty) AS sales_qty,
                 count(DISTINCT coalesce(nullif(so_id,''),nullif(outer_so_id,''),nullif(o_id,''),
                   'row:'||shard_id||':'||row_number)) AS order_count,
                 sum(sales_amount) AS sales_amount,sum(refund_qty) AS refund_qty,
                 sum(refund_amount) AS refund_amount,sum(gross_margin) AS gross_margin
            FROM dwd_paid_order_items
           WHERE batch_id={_literal(batch_id)} AND sku_id<>'' AND platform<>''
           GROUP BY biz_date,sku_id,platform ORDER BY sku_id,biz_date,platform""")

        db.execute(f"""CREATE TABLE bi_sales_channel_rows AS
          SELECT 'sku' AS query_type,sku_id AS product_id,max(spu_id) AS spu_id,
                 'platform' AS count_type,platform,NULL::VARCHAR AS shop_id,
                 NULL::VARCHAR AS shop_name,{qty}
            FROM dwd_paid_order_items r WHERE batch_id={_literal(batch_id)} AND sku_id<>''
           GROUP BY sku_id,platform
          UNION ALL
          SELECT 'sku',sku_id,max(spu_id),'channel',platform,shop_id,shop_name,{qty}
            FROM dwd_paid_order_items r WHERE batch_id={_literal(batch_id)} AND sku_id<>''
           GROUP BY sku_id,platform,shop_id,shop_name
          UNION ALL
          SELECT 'spu',spu_id,spu_id,'platform',platform,NULL::VARCHAR,NULL::VARCHAR,{qty}
            FROM dwd_paid_order_items r WHERE batch_id={_literal(batch_id)} AND spu_id<>''
           GROUP BY spu_id,platform
          UNION ALL
          SELECT 'spu',spu_id,spu_id,'channel',platform,shop_id,shop_name,{qty}
            FROM dwd_paid_order_items r WHERE batch_id={_literal(batch_id)} AND spu_id<>''
           GROUP BY spu_id,platform,shop_id,shop_name
          ORDER BY query_type,product_id,count_type,platform,shop_id""")

        if inventory and Path(inventory).is_file():
            db.execute(f"ATTACH {_literal(Path(inventory).resolve())} AS inventory (TYPE sqlite, READ_ONLY)")
            db.execute("""CREATE TABLE bi_product_catalog AS
              SELECT 'sku' AS query_type,CAST(sku_id AS VARCHAR) AS product_id,
                     CAST(spu_id AS VARCHAR) AS spu_id FROM inventory.sku_inventory
              UNION ALL
              SELECT 'spu',CAST(spu_id AS VARCHAR),CAST(spu_id AS VARCHAR)
                FROM inventory.spu_inventory
              ORDER BY query_type,product_id""")
        else:
            db.execute("""CREATE TABLE bi_product_catalog AS
              SELECT 'sku' AS query_type,sku_id AS product_id,max(spu_id) AS spu_id
                FROM dwd_paid_order_items WHERE sku_id<>'' GROUP BY sku_id
              UNION ALL SELECT 'spu',spu_id,spu_id FROM dwd_paid_order_items
                WHERE spu_id<>'' GROUP BY spu_id ORDER BY query_type,product_id""")

        counts = {
            "raw_rows": db.execute("SELECT count(*) FROM dwd_paid_order_items").fetchone()[0],
            "sku_snapshots": db.execute("SELECT count(*)*2 FROM bi_product_catalog").fetchone()[0],
            "platform_rows": db.execute("SELECT count(*) FROM ads_platform_product_sales").fetchone()[0],
            "shop_rows": db.execute("SELECT count(*) FROM ads_shop_product_sales").fetchone()[0],
            "link_rows": db.execute("SELECT count(*) FROM ads_link_product_sales").fetchone()[0],
            "source_rows": db.execute("SELECT count(*) FROM ads_sku_shop_source_sales").fetchone()[0],
            "daily_rows": db.execute("SELECT count(*) FROM bi_sku_platform_sales_daily").fetchone()[0],
        }
        db.execute("""CREATE TABLE warehouse_runs(
          batch_id VARCHAR PRIMARY KEY,business_date VARCHAR,start_date VARCHAR,end_date VARCHAR,
          captured_at VARCHAR,published_at VARCHAR,raw_rows BIGINT,sku_snapshots BIGINT,
          platform_rows BIGINT,shop_rows BIGINT,link_rows BIGINT,source_rows BIGINT,quality VARCHAR,
          data_version VARCHAR)""")
        published_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        db.execute("INSERT INTO warehouse_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [
            batch_id, end, batch["start_date"], batch["end_date"], captured_at,
            published_at, counts["raw_rows"], counts["sku_snapshots"],
            counts["platform_rows"], counts["shop_rows"], counts["link_rows"],
            counts["source_rows"], quality, data_version,
        ])
        db.execute("CHECKPOINT")
        return {"batch_id": batch_id, "data_version": data_version, **counts}
    except Exception:
        db.close()
        output.unlink(missing_ok=True)
        raise
    finally:
        try:
            db.close()
        except Exception:
            pass
