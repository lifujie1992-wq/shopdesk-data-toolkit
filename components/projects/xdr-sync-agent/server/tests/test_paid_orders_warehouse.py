import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

MODULE = Path(__file__).parents[1] / "paid_orders_warehouse.py"
SPEC = importlib.util.spec_from_file_location("paid_orders_warehouse", MODULE)
warehouse = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(warehouse)


class PaidOrdersWarehouseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.database = Path(self.temp.name) / "paid.sqlite"
        db = sqlite3.connect(self.database)
        db.executescript("""
          CREATE TABLE export_batches(batch_id TEXT PRIMARY KEY,business_date TEXT,start_date TEXT,end_date TEXT,
            captured_at TEXT,quality TEXT,complete INTEGER,manifest_json TEXT);
          CREATE TABLE export_shards(batch_id TEXT,shard_id TEXT,source_name TEXT,source_sha256 TEXT,
            effective_start TEXT,effective_end TEXT,row_count INTEGER,complete INTEGER,
            PRIMARY KEY(batch_id,shard_id));
          CREATE TABLE export_coverage(batch_id TEXT,biz_date TEXT,shard_id TEXT,
            PRIMARY KEY(batch_id,biz_date));
          CREATE TABLE paid_order_items_raw(batch_id TEXT,shard_id TEXT,row_number INTEGER,biz_date TEXT,
            pay_date TEXT,platform TEXT,shop_id TEXT,shop_name TEXT,spu_id TEXT,sku_id TEXT,
            shop_spu_id TEXT,shop_sku_id TEXT,sales_qty REAL,so_id TEXT,outer_so_id TEXT,o_id TEXT,
            order_labels TEXT,influencer_id TEXT,influencer_name TEXT,sales_amount REAL,
            refund_qty REAL,refund_amount REAL,gross_margin REAL,
            raw_json TEXT,PRIMARY KEY(batch_id,shard_id,row_number));
        """)
        db.execute("INSERT INTO export_batches VALUES(?,?,?,?,?,?,?,?)",
                   ("b", "2026-09-09", "2026-09-06", "2026-09-09",
                    "2026-09-09T04:00:00+00:00", "raw_paid_order_exports", 1, "[]"))
        for day in ("2026-09-06", "2026-09-07", "2026-09-08", "2026-09-09"):
            db.execute("INSERT INTO export_coverage VALUES(?,?,?)", ("b", day, "s"))
        items = [
            (1, "2026-09-06", "抖音", "shop-1", 3, "直播间", ""),
            (2, "2026-09-07", "抖音", "shop-1", 5, "直播间,精选联盟", ""),
            (3, "2026-09-08", "拼多多", "-1", 7, "", "达人-1"),
            (4, "2026-09-09", "抖音", "shop-1", 11, "", ""),
        ]
        for row_no, day, platform, shop_id, qty, labels, influencer in items:
            db.execute("INSERT INTO paid_order_items_raw VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                       ("b", "s", row_no, day, day, platform, shop_id, "店", "spu", "sku",
                        "link", "shop-sku", qty, f"so-{row_no}", None, None,
                        labels, influencer, "达人", qty * 10, 1 if row_no == 3 else None,
                        5 if row_no == 3 else None, qty * 2, "{}"))
        db.execute("INSERT INTO export_shards VALUES(?,?,?,?,?,?,?,1)",
                   ("b", "s", "source.xlsx", "0" * 64, "2026-09-06", "2026-09-09", 4))
        db.commit()
        db.close()

    def tearDown(self):
        self.temp.cleanup()

    def test_materializes_windows_ending_yesterday_and_keeps_today_separate(self):
        result = warehouse.materialize_paid_orders(self.database)
        self.assertEqual(result["raw_rows"], 4)
        db = sqlite3.connect(self.database)
        snapshot = json.loads(db.execute(
            "SELECT raw_json FROM ads_sales_channel_snapshots WHERE query_type='sku' AND count_type='platform'"
        ).fetchone()[0])
        by_platform = {row["platform"]: row for row in snapshot["rows"]}
        self.assertEqual(by_platform["抖音"]["pay_qty_today"], 11)
        self.assertEqual(by_platform["抖音"]["pay_qty_1d"], 0)
        self.assertEqual(by_platform["抖音"]["pay_qty_3d"], 8)
        self.assertEqual(by_platform["拼多多"]["pay_qty_1d"], 7)
        self.assertFalse(snapshot["is_complete_popup"])
        self.assertEqual(snapshot["quality"], "order_derived")
        source = {row[0]: row[1] for row in db.execute(
            "SELECT source_category,pay_qty_today FROM ads_sku_source_sales")}
        self.assertEqual(source, {"直播间": 0, "精选联盟": 0, "商品卡": 11})
        daily = db.execute("""SELECT sales_qty,order_count,sales_amount,refund_qty,
                                   refund_amount,gross_margin
                                FROM bi_sku_platform_sales_daily
                               WHERE biz_date='2026-09-08' AND sku_id='sku' AND platform='拼多多'""").fetchone()
        self.assertEqual(daily, (7, 1, 70, 1, 5, 14))
        db.close()

    def test_rejects_incomplete_coverage_without_replacing_ads(self):
        db = sqlite3.connect(self.database)
        db.execute("DELETE FROM export_coverage WHERE biz_date='2026-09-08'")
        db.commit()
        db.close()
        with self.assertRaisesRegex(ValueError, "coverage"):
            warehouse.materialize_paid_orders(self.database)
        db = sqlite3.connect(self.database)
        self.assertIsNone(db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='ads_sales_channel_snapshots'"
        ).fetchone())
        db.close()


if __name__ == "__main__":
    unittest.main()
