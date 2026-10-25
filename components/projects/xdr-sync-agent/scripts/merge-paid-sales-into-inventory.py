#!/usr/bin/env python3
"""Merge derived paid-sales snapshots into a fresh inventory baseline."""

from __future__ import annotations

import argparse
import shutil
import sqlite3
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--inventory", required=True, type=Path)
    parser.add_argument("--sales", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(args.inventory, args.output)
    db = sqlite3.connect(args.output)
    db.execute("ATTACH DATABASE ? AS paid", (str(args.sales),))
    with db:
        db.execute("DELETE FROM sale_channel_snapshots WHERE query_type='sku'")
        db.execute("""INSERT INTO sale_channel_snapshots
            SELECT s.* FROM paid.sale_channel_snapshots s
            JOIN main.sku_inventory i ON i.sku_id=s.product_id
            WHERE s.query_type='sku'""")
        db.execute("""CREATE TABLE IF NOT EXISTS sku_link_sales_windows(
            sku_id TEXT NOT NULL,shop_id TEXT NOT NULL,link_id TEXT NOT NULL,platform TEXT,
            shop_name TEXT,shop_i_id TEXT,shop_sku_id TEXT,pay_qty_today REAL,pay_qty_1d REAL,
            pay_qty_3d REAL,pay_qty_7d REAL,pay_qty_15d REAL,pay_qty_30d REAL,
            PRIMARY KEY(sku_id,shop_id,link_id))""")
        db.execute("DELETE FROM sku_link_sales_windows")
        db.execute("""INSERT INTO sku_link_sales_windows
            SELECT l.* FROM paid.sku_link_sales_windows l
            JOIN main.sku_inventory i USING(sku_id)""")
    result = {
        "inventory_skus": db.execute("SELECT count(*) FROM sku_inventory").fetchone()[0],
        "sku_snapshots": db.execute(
            "SELECT count(*) FROM sale_channel_snapshots WHERE query_type='sku'").fetchone()[0],
        "link_rows": db.execute("SELECT count(*) FROM sku_link_sales_windows").fetchone()[0],
    }
    db.close()
    print(result)


if __name__ == "__main__":
    main()
