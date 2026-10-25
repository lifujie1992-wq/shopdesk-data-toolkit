#!/usr/bin/env python3
"""Build SKU sales-channel snapshots from paid-order Excel exports and today's order page."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sqlite3
import zipfile
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from xml.etree import ElementTree as ET


WINDOWS = {"pay_qty_today": 1, "pay_qty_3d": 3, "pay_qty_7d": 7,
           "pay_qty_15d": 15, "pay_qty_30d": 30}
REQUIRED = {"付款日期", "平台", "店铺名称", "商品编码", "款式编码", "销售件数", "店铺编号"}


def cell_value(cell, shared):
    kind = cell.attrib.get("t")
    value = next((node.text for node in cell if node.tag.endswith("}v")), None)
    if kind == "s" and value is not None:
        return shared[int(value)]
    if kind == "inlineStr":
        return "".join(node.text or "" for node in cell.iter() if node.tag.endswith("}t"))
    return value


def excel_rows(path):
    with zipfile.ZipFile(path) as archive:
        shared = []
        if "xl/sharedStrings.xml" in archive.namelist():
            for _, node in ET.iterparse(archive.open("xl/sharedStrings.xml"), events=("end",)):
                if node.tag.endswith("}si"):
                    shared.append("".join(part.text or "" for part in node.iter()
                                          if part.tag.endswith("}t")))
                    node.clear()
        header = None
        for _, node in ET.iterparse(archive.open("xl/worksheets/sheet1.xml"), events=("end",)):
            if not node.tag.endswith("}row"):
                continue
            values = {}
            for cell in node:
                if cell.tag.endswith("}c"):
                    column = re.match(r"[A-Z]+", cell.attrib.get("r", ""))
                    if column:
                        values[column.group()] = cell_value(cell, shared)
            node.clear()
            if header is None:
                header = {value: column for column, value in values.items() if value}
                missing = REQUIRED - set(header)
                if missing:
                    raise ValueError(f"{path.name}: missing columns {sorted(missing)}")
                continue
            yield {name: values.get(column) for name, column in header.items()}


def number(value):
    if value in (None, ""):
        return 0.0
    return float(value)


def identifier(value):
    """Undo Excel's scientific notation without changing textual identifiers."""
    text = str(value or "")
    if "e" not in text.lower() and not re.fullmatch(r"-?\d+\.0+", text):
        return text
    try:
        parsed = Decimal(text)
    except InvalidOperation:
        return text
    return str(int(parsed)) if parsed == parsed.to_integral_value() else text


def day_of(value):
    if not value:
        return None
    match = re.match(r"(\d{4}-\d{2}-\d{2})", str(value))
    return date.fromisoformat(match.group(1)) if match else None


def file_range(path):
    dates = re.findall(r"\d{4}-\d{2}-\d{2}", path.name)
    if path.name.startswith("gap-") and dates:
        day = date.fromisoformat(dates[0])
        return day, day + timedelta(days=1)
    if len(dates) >= 2:
        return date.fromisoformat(dates[0]), date.fromisoformat(dates[1])
    raise ValueError(f"{path.name}: cannot determine export date range")


def add(aggregate, key, biz_day, qty, identity):
    if not key[0] or not biz_day or qty == 0:
        return
    entry = aggregate.setdefault(key, {"identity": identity, "daily": defaultdict(float)})
    entry["daily"][biz_day] += qty


def quantities(daily, business_date):
    result = {"pay_qty_1d": daily.get(business_date - timedelta(days=1), 0.0)}
    for field, days in WINDOWS.items():
        start = business_date - timedelta(days=days - 1)
        result[field] = sum(qty for day, qty in daily.items() if start <= day <= business_date)
    return result


def clean_numbers(row):
    for key, value in list(row.items()):
        if key.startswith("pay_qty_") and isinstance(value, float) and value.is_integer():
            row[key] = int(value)
    return row


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--xlsx-dir", required=True, type=Path)
    parser.add_argument("--today", required=True, type=Path)
    parser.add_argument("--inventory", required=True, type=Path)
    parser.add_argument("--shops", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--business-date", required=True, type=date.fromisoformat)
    args = parser.parse_args()

    shop_map = {str(row["shop_id"]): row for row in json.loads(args.shops.read_text())}
    platforms, channels, links = {}, {}, {}
    source_rows = 0
    out_of_range_rows = 0
    source_files = sorted(args.xlsx_dir.glob("*.xlsx"))
    if not source_files:
        raise ValueError("no historical xlsx files")

    for path in source_files:
        range_start, range_end = file_range(path)
        for row in excel_rows(path):
            source_rows += 1
            biz_day, sku_id = day_of(row.get("付款日期")), identifier(row.get("商品编码"))
            if not biz_day or not sku_id:
                continue
            if not range_start <= biz_day < range_end:
                out_of_range_rows += 1
                continue
            qty = number(row.get("销售件数"))
            platform, shop_id = str(row.get("平台") or ""), identifier(row.get("店铺编号"))
            shop_name, spu_id = str(row.get("店铺名称") or ""), str(row.get("款式编码") or "")
            shop_i_id = identifier(row.get("店铺款式编码"))
            shop_sku_id = identifier(row.get("店铺商品编码"))
            add(platforms, (sku_id, platform), biz_day, qty,
                {"platform": platform, "spu_id": spu_id})
            add(channels, (sku_id, shop_id), biz_day, qty,
                {"platform": platform, "shop_id": shop_id, "shop_name": shop_name, "spu_id": spu_id})
            link_key = shop_i_id or shop_sku_id or "-1"
            add(links, (sku_id, shop_id, link_key), biz_day, qty,
                {"platform": platform, "shop_id": shop_id, "shop_name": shop_name,
                 "shop_i_id": shop_i_id or None, "shop_sku_id": shop_sku_id or None,
                 "spu_id": spu_id})

    today_db = sqlite3.connect(f"file:{args.today}?mode=ro", uri=True)
    meta = today_db.execute("SELECT finished_at,upper_bound,expected_count FROM sync_metadata").fetchone()
    if not meta or not meta[0]:
        raise ValueError("today snapshot is incomplete")
    today_rows = 0
    for row in today_db.execute("""
        SELECT i.sku_id,i.i_id,i.shop_sku_id,i.shop_i_id,i.qty,
               o.shop_id,o.shop_name,o.shop_site,o.pay_date
          FROM order_items i JOIN orders o USING(o_id)
         WHERE o.pay_date IS NOT NULL
    """):
        sku_id, spu_id, shop_sku_id, shop_i_id, qty, shop_id, shop_name, shop_site, pay_date = row
        today_rows += 1
        shop_id, sku_id = str(shop_id or ""), str(sku_id or "")
        directory = shop_map.get(shop_id, {})
        platform = str(directory.get("platform") or shop_site or "")
        name = str(directory.get("shop_name") or shop_name or "")
        biz_day = day_of(pay_date)
        add(platforms, (sku_id, platform), biz_day, number(qty),
            {"platform": platform, "spu_id": str(spu_id or "")})
        add(channels, (sku_id, shop_id), biz_day, number(qty),
            {"platform": platform, "shop_id": shop_id, "shop_name": name, "spu_id": str(spu_id or "")})
        link_key = str(shop_i_id or shop_sku_id or "-1")
        add(links, (sku_id, shop_id, link_key), biz_day, number(qty),
            {"platform": platform, "shop_id": shop_id, "shop_name": name,
             "shop_i_id": shop_i_id, "shop_sku_id": shop_sku_id, "spu_id": str(spu_id or "")})
    today_db.close()

    args.output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(args.inventory, args.output)
    db = sqlite3.connect(args.output)
    captured_at = meta[0]
    inventory_skus = {row[0]: row[1] for row in db.execute("SELECT sku_id,spu_id FROM sku_inventory")}
    db.executescript("""
      CREATE TABLE IF NOT EXISTS sale_channel_snapshots(
        query_type TEXT NOT NULL,product_id TEXT NOT NULL,count_type TEXT NOT NULL,
        captured_at TEXT NOT NULL,total INTEGER NOT NULL,raw_json TEXT NOT NULL,
        PRIMARY KEY(query_type,product_id,count_type));
      CREATE TABLE IF NOT EXISTS sku_link_sales_windows(
        sku_id TEXT NOT NULL,shop_id TEXT NOT NULL,link_id TEXT NOT NULL,platform TEXT,
        shop_name TEXT,shop_i_id TEXT,shop_sku_id TEXT,pay_qty_today REAL,pay_qty_1d REAL,
        pay_qty_3d REAL,pay_qty_7d REAL,pay_qty_15d REAL,pay_qty_30d REAL,
        PRIMARY KEY(sku_id,shop_id,link_id));
    """)
    db.execute("DELETE FROM sale_channel_snapshots WHERE query_type='sku'")
    db.execute("DELETE FROM sku_link_sales_windows")
    by_sku_platform, by_sku_channel = defaultdict(list), defaultdict(list)
    for (sku_id, _), value in platforms.items():
        identity = value["identity"]
        identity["spu_id"] = identity.get("spu_id") or inventory_skus.get(sku_id)
        by_sku_platform[sku_id].append(clean_numbers({**identity, **quantities(value["daily"], args.business_date)}))
    for (sku_id, _), value in channels.items():
        identity = value["identity"]
        identity["spu_id"] = identity.get("spu_id") or inventory_skus.get(sku_id)
        by_sku_channel[sku_id].append(clean_numbers({**identity, **quantities(value["daily"], args.business_date)}))

    insert = db.cursor()
    for sku_id in inventory_skus:
        for count_type, rows in (("platform", by_sku_platform.get(sku_id, [])),
                                 ("channel", by_sku_channel.get(sku_id, []))):
            rows.sort(key=lambda row: (-row["pay_qty_today"], -row["pay_qty_30d"],
                                       str(row.get("platform", "")), str(row.get("shop_id", ""))))
            snapshot = {"query_type": "sku", "product_id": sku_id, "sku_id": sku_id,
                        "spu_id": inventory_skus[sku_id], "count_type": count_type,
                        "captured_at": captured_at, "business_date": args.business_date.isoformat(),
                        "start_date": (args.business_date - timedelta(days=29)).isoformat(),
                        "end_date": args.business_date.isoformat(), "total": len(rows), "rows": rows,
                        "source_api": "paid_order_exports+order_page", "quality": "order_derived",
                        "coverage": "complete_paid_order_exports", "complete": True,
                        "is_complete_popup": False, "today_cutoff": meta[1]}
            insert.execute("INSERT INTO sale_channel_snapshots VALUES(?,?,?,?,?,?)",
                           ("sku", sku_id, count_type, captured_at, len(rows),
                            json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"))))
    for (sku_id, shop_id, link_id), value in links.items():
        if sku_id not in inventory_skus:
            continue
        identity, qty = value["identity"], clean_numbers(quantities(value["daily"], args.business_date))
        insert.execute("INSERT INTO sku_link_sales_windows VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                       (sku_id, shop_id, link_id, identity.get("platform"), identity.get("shop_name"),
                        identity.get("shop_i_id"), identity.get("shop_sku_id"), qty["pay_qty_today"],
                        qty["pay_qty_1d"], qty["pay_qty_3d"], qty["pay_qty_7d"],
                        qty["pay_qty_15d"], qty["pay_qty_30d"]))
    db.commit()
    counts = {"inventory_skus": len(inventory_skus), "historical_files": len(source_files),
              "historical_rows": source_rows, "out_of_range_rows": out_of_range_rows,
              "today_orders": meta[2], "today_item_rows": today_rows,
              "platform_rows": len(platforms), "shop_rows": len(channels), "link_rows": len(links),
              "snapshots": db.execute("SELECT count(*) FROM sale_channel_snapshots WHERE query_type='sku'").fetchone()[0],
              "captured_at": captured_at, "today_cutoff": meta[1], "output": str(args.output)}
    db.close()
    print(json.dumps(counts, ensure_ascii=False))


if __name__ == "__main__":
    main()
