import importlib.util
import sqlite3
import tempfile
import unittest
from pathlib import Path

try:
    import duckdb
except ImportError:  # The server requirements install it; base developer Python may not.
    duckdb = None


ROOT = Path(__file__).parents[1]


@unittest.skipUnless(duckdb, "duckdb is not installed")
class PaidOrdersDuckDBTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "source.sqlite"
        self.inventory = self.root / "inventory.sqlite"
        db = sqlite3.connect(self.source)
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
            refund_qty REAL,refund_amount REAL,gross_margin REAL,raw_json TEXT,
            PRIMARY KEY(batch_id,shard_id,row_number));
          INSERT INTO export_batches VALUES
            ('b','2026-09-09','2026-09-08','2026-09-09','2026-09-09T12:00:00Z','raw',1,'[]');
          INSERT INTO export_shards VALUES('b','s','source.xlsx','x','2026-09-08','2026-09-09',2,1);
          INSERT INTO export_coverage VALUES('b','2026-09-08','s'),('b','2026-09-09','s');
          INSERT INTO paid_order_items_raw VALUES
            ('b','s',1,'2026-09-08','2026-09-08','抖音','shop','店','spu','sku','link','ls',3,
             'so-1',NULL,NULL,'直播',NULL,NULL,30,NULL,NULL,6,'{}'),
            ('b','s',2,'2026-09-09','2026-09-09','抖音','shop','店','spu','sku','link','ls',5,
             'so-2',NULL,NULL,'精选联盟','talent','达人',50,1,2,10,'{}');
        """)
        db.commit()
        db.close()
        db = sqlite3.connect(self.inventory)
        db.executescript("""
          CREATE TABLE sku_inventory(spu_id TEXT,sku_id TEXT);
          CREATE TABLE spu_inventory(spu_id TEXT);
          INSERT INTO sku_inventory VALUES('spu','sku'),('empty-spu','empty-sku');
          INSERT INTO spu_inventory VALUES('spu'),('empty-spu');
        """)
        db.commit()
        db.close()

    def tearDown(self):
        self.temp.cleanup()

    def test_builds_compatible_normalized_bi_tables(self):
        spec = importlib.util.spec_from_file_location(
            "paid_orders_duckdb", ROOT / "paid_orders_duckdb.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        output = self.root / "paid.duckdb"
        result = module.build_paid_orders_duckdb(self.source, output, self.inventory)
        self.assertEqual(result["raw_rows"], 2)
        self.assertEqual(result["sku_snapshots"], 8)
        db = duckdb.connect(str(output), read_only=True)
        row = db.execute("""SELECT pay_qty_today,pay_qty_1d,pay_qty_3d
          FROM bi_sales_channel_rows WHERE query_type='sku' AND count_type='platform'""").fetchone()
        self.assertEqual(row, (5, 3, 3))
        source = dict(db.execute(
            "SELECT source_category,pay_qty_today FROM ads_sku_source_sales").fetchall())
        self.assertEqual(source, {"直播间": 0, "精选联盟": 5})
        empty = db.execute(
            "SELECT spu_id FROM bi_product_catalog WHERE product_id='empty-sku'").fetchone()
        self.assertEqual(empty, ("empty-spu",))
        db.close()


if __name__ == "__main__":
    unittest.main()
