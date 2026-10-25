#!/usr/bin/env python3
"""Materialize SPU sales-analysis tables from complete SKU paid-order snapshots."""

from __future__ import annotations

import argparse
import json
import sqlite3
from collections import defaultdict
from datetime import date, timedelta


FIELDS = ("pay_qty_today", "pay_qty_1d", "pay_qty_3d", "pay_qty_7d",
          "pay_qty_15d", "pay_qty_30d")


def add(target, key, identity, row):
    current = target.setdefault(key, {**identity, **{field: 0 for field in FIELDS}})
    for field in FIELDS:
        value = row.get(field)
        if value is not None:
            current[field] += value


def clean(value):
    return int(value) if isinstance(value, float) and value.is_integer() else value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("database")
    parser.add_argument("--business-date", required=True, type=date.fromisoformat)
    args = parser.parse_args()
    db = sqlite3.connect(args.database)
    sku_to_spu = dict(db.execute("SELECT sku_id,spu_id FROM sku_inventory"))
    platform_rows, shop_rows, link_rows = {}, {}, {}
    sku_channels = {}

    for raw_json, in db.execute(
            "SELECT raw_json FROM sale_channel_snapshots "
            "WHERE query_type='sku' AND count_type='platform'"):
        snapshot = json.loads(raw_json)
        spu_id = sku_to_spu.get(snapshot["sku_id"])
        if not spu_id:
            continue
        for row in snapshot["rows"]:
            platform = str(row.get("platform") or "")
            if platform:
                add(platform_rows, (spu_id, platform),
                    {"spu_id": spu_id, "platform": platform}, row)

    for raw_json, in db.execute(
            "SELECT raw_json FROM sale_channel_snapshots "
            "WHERE query_type='sku' AND count_type='channel'"):
        snapshot = json.loads(raw_json)
        spu_id = sku_to_spu.get(snapshot["sku_id"])
        if not spu_id:
            continue
        for row in snapshot["rows"]:
            shop_id = str(row.get("shop_id") or "")
            if shop_id:
                sku_channels[(snapshot["sku_id"], shop_id)] = row
                add(shop_rows, (spu_id, shop_id), {
                    "spu_id": spu_id, "shop_id": shop_id,
                    "shop_name": row.get("shop_name"), "platform": row.get("platform")}, row)

    db.execute("DELETE FROM sku_link_sales_windows WHERE sku_id NOT IN (SELECT sku_id FROM sku_inventory)")
    existing_links = defaultdict(lambda: {field: 0 for field in FIELDS})
    for row in db.execute("SELECT sku_id,shop_id,pay_qty_today,pay_qty_1d,pay_qty_3d,pay_qty_7d,pay_qty_15d,pay_qty_30d FROM sku_link_sales_windows"):
        current = existing_links[(row[0], str(row[1]))]
        for field, value in zip(FIELDS, row[2:]):
            current[field] += value or 0
    for (sku_id, shop_id), channel in sku_channels.items():
        current = existing_links[(sku_id, shop_id)]
        missing = {field: (channel.get(field) or 0) - current[field] for field in FIELDS}
        if any(missing.values()):
            db.execute("""INSERT INTO sku_link_sales_windows
                (sku_id,shop_id,link_id,platform,shop_name,pay_qty_today,pay_qty_1d,
                 pay_qty_3d,pay_qty_7d,pay_qty_15d,pay_qty_30d)
                VALUES(?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(sku_id,shop_id,link_id) DO UPDATE SET
                  pay_qty_today=excluded.pay_qty_today,pay_qty_1d=excluded.pay_qty_1d,
                  pay_qty_3d=excluded.pay_qty_3d,pay_qty_7d=excluded.pay_qty_7d,
                  pay_qty_15d=excluded.pay_qty_15d,pay_qty_30d=excluded.pay_qty_30d""",
                (sku_id, shop_id, "-1", channel.get("platform"), channel.get("shop_name"),
                 *(missing[field] for field in FIELDS)))

    query = """SELECT l.sku_id,l.shop_id,l.link_id,l.platform,l.shop_name,
                      l.shop_i_id,l.shop_sku_id,l.pay_qty_today,l.pay_qty_1d,
                      l.pay_qty_3d,l.pay_qty_7d,l.pay_qty_15d,l.pay_qty_30d
                 FROM sku_link_sales_windows l"""
    for values in db.execute(query):
        (sku_id, shop_id, link_id, platform, shop_name, shop_i_id, shop_sku_id,
         today, one, three, seven, fifteen, thirty) = values
        spu_id = sku_to_spu.get(sku_id)
        if not spu_id:
            continue
        add(link_rows, (spu_id, str(shop_id), str(link_id)), {
            "spu_id": spu_id, "shop_id": str(shop_id), "shop_name": shop_name,
            "platform": platform, "shop_spu_id": str(link_id), "shop_i_id": shop_i_id,
            "shop_sku_id": shop_sku_id}, dict(zip(FIELDS, (today, one, three, seven, fifteen, thirty))))

    end = args.business_date
    start = end - timedelta(days=29)
    previous_end = start - timedelta(days=1)
    previous_start = previous_end - timedelta(days=29)
    dates = {"start_date": start.isoformat(), "end_date": end.isoformat(),
             "previous_start_date": previous_start.isoformat(),
             "previous_end_date": previous_end.isoformat()}

    def replace(table, rows):
        columns = [row[1] for row in db.execute(f"PRAGMA table_info({table})")]
        db.execute(f"DELETE FROM {table}")
        sql = f"INSERT INTO {table} ({','.join(columns)}) VALUES ({','.join('?' for _ in columns)})"
        for row in rows.values():
            row = {key: clean(value) for key, value in {**row, **dates}.items()}
            row["sales_qty"] = row["pay_qty_30d"]
            row["raw_json"] = json.dumps({**row, "source_api": "paid_order_exports+order_page",
                "quality": "order_derived", "complete": True}, ensure_ascii=False,
                separators=(",", ":"))
            db.execute(sql, [row.get(column) for column in columns])

    with db:
        replace("platform_product_sales_analysis", platform_rows)
        replace("shop_product_sales_analysis", shop_rows)
        replace("link_product_sales_analysis", link_rows)
        sku_yesterday = defaultdict(float)
        for (sku_id, _shop_id), row in sku_channels.items():
            value = row.get("pay_qty_1d")
            if value is not None:
                sku_yesterday[sku_id] += value
        db.executemany("UPDATE sku_inventory SET pay_qty_1d=? WHERE sku_id=?",
                       ((clean(value), sku_id) for sku_id, value in sku_yesterday.items()))
        db.execute("""UPDATE spu_inventory SET pay_qty_1d=(
            SELECT sum(s.pay_qty_1d) FROM sku_inventory s
            WHERE s.spu_id=spu_inventory.spu_id)""")
    result = {"platform_product_sales_analysis": len(platform_rows),
              "shop_product_sales_analysis": len(shop_rows),
              "link_product_sales_analysis": len(link_rows),
              "sku_yesterday_rows": len(sku_yesterday),
              "start_date": start.isoformat(), "end_date": end.isoformat()}
    db.close()
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
