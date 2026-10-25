import json
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "append-today-order-page.py"


class AppendTodayOrderPageTests(unittest.TestCase):
    def test_previous_day_or_undated_inventory_cannot_erase_current_day_orders(self):
        for stamp in ['2026-09-09T14:30:00Z', None]:
            with self.subTest(stamp=stamp), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                ods, today, inventory = root / 'ods.sqlite', root / 'today.sqlite', root / 'inventory.sqlite'
                with sqlite3.connect(ods) as db:
                    db.execute('CREATE TABLE preserved(value TEXT)')
                    db.execute("INSERT INTO preserved VALUES('last complete baseline')")
                before = ods.read_bytes()
                with sqlite3.connect(today) as db:
                    db.executescript("""
                      CREATE TABLE sync_metadata(id INTEGER PRIMARY KEY,day TEXT,date_field TEXT,
                        finished_at TEXT,expected_count INTEGER,fetched_count INTEGER,unique_count INTEGER);
                      INSERT INTO sync_metadata VALUES(1,'2026-09-10','pay_date','2026-09-10T02:00:00Z',1,1,1);
                    """)
                with sqlite3.connect(inventory) as db:
                    db.executescript('CREATE TABLE sku_inventory(spu_id TEXT,sku_id TEXT,properties_value TEXT);'
                                     'CREATE TABLE export_info(id INTEGER PRIMARY KEY,completed_at TEXT);')
                    db.execute('INSERT INTO export_info VALUES(1,?)', (stamp,))
                result = subprocess.run(['python3', str(SCRIPT), '--ods', str(ods), '--today', str(today),
                                         '--business-date', '2026-09-10', '--inventory', str(inventory)],
                                        capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('inventory_snapshot_before_business_date', result.stderr)
                self.assertIn('refresh_inventory_first', result.stderr)
                self.assertEqual(ods.read_bytes(), before)
                self.assertFalse(list(root.glob('*.building')))

    def test_advances_business_date_and_expires_oldest_day(self):
        with tempfile.TemporaryDirectory() as directory:
            ods = Path(directory) / "ods.sqlite"
            today = Path(directory) / "today.sqlite"
            with sqlite3.connect(ods) as db:
                db.executescript("""
                  CREATE TABLE export_batches(batch_id TEXT PRIMARY KEY,business_date TEXT,
                    start_date TEXT,end_date TEXT,captured_at TEXT,quality TEXT,complete INTEGER,
                    manifest_json TEXT);
                  CREATE TABLE export_shards(batch_id TEXT,shard_id TEXT,source_name TEXT,
                    source_sha256 TEXT,effective_start TEXT,effective_end TEXT,row_count INTEGER,
                    complete INTEGER,PRIMARY KEY(batch_id,shard_id));
                  CREATE TABLE export_coverage(batch_id TEXT,biz_date TEXT,shard_id TEXT,
                    PRIMARY KEY(batch_id,biz_date));
                  CREATE TABLE paid_order_items_raw(batch_id TEXT,shard_id TEXT,row_number INTEGER,
                    biz_date TEXT,pay_date TEXT,platform TEXT,shop_id TEXT,shop_name TEXT,spu_id TEXT,
                    sku_id TEXT,shop_spu_id TEXT,shop_sku_id TEXT,sales_qty REAL,so_id TEXT,
                    outer_so_id TEXT,o_id TEXT,order_labels TEXT,influencer_id TEXT,
                    influencer_name TEXT,sales_amount REAL,refund_qty REAL,refund_amount REAL,
                    gross_margin REAL,raw_json TEXT,PRIMARY KEY(batch_id,shard_id,row_number));
                  INSERT INTO export_batches VALUES
                    ('b','2026-09-09','2026-08-10','2026-09-09','old','raw',1,'[]');
                  INSERT INTO export_shards VALUES
                    ('b','old','old.xlsx','abc','2026-08-10','2026-08-10',1,1);
                  INSERT INTO export_coverage VALUES('b','2026-08-10','old');
                  INSERT INTO paid_order_items_raw VALUES
                    ('b','old',1,'2026-08-10','2026-08-10','抖音','1','店','x','old','l','s',1,
                     'o','so','oi','','','',1,NULL,NULL,NULL,'{}');
                """)
            with sqlite3.connect(today) as db:
                db.executescript("""
                  CREATE TABLE sync_metadata(id INTEGER PRIMARY KEY,schema_version INTEGER,day TEXT,
                    date_field TEXT,finished_at TEXT,expected_count INTEGER,fetched_count INTEGER,
                    unique_count INTEGER,upper_bound TEXT);
                  INSERT INTO sync_metadata VALUES
                    (1,2,'2026-09-10','pay_date','2026-09-10T02:00:00Z',1,1,1,'2026-09-10 10:00:00');
                  CREATE TABLE orders(o_id TEXT PRIMARY KEY,pay_date TEXT,status TEXT,shop_id TEXT,shop_name TEXT,
                    shop_site TEXT,so_id TEXT,labels TEXT);
                  CREATE TABLE order_items(o_id TEXT,position INTEGER,sku_id TEXT,i_id TEXT,
                    shop_sku_id TEXT,shop_i_id TEXT,qty REAL,json TEXT);
                  INSERT INTO orders VALUES('o1','2026-09-10 09:00:00','已付款待审核','1','店','抖音','so1','精选联盟');
                  INSERT INTO order_items VALUES
                    ('o1',1,'sku1','spu1','ss1','si1',2,'{"referrer_id":"talent"}');
                """)
            result = subprocess.run([
                "python3", str(SCRIPT), "--ods", str(ods), "--today", str(today),
                "--business-date", "2026-09-10",
            ], check=False, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["item_rows"], 1)
            with sqlite3.connect(ods) as db:
                batch = db.execute(
                    "SELECT business_date,start_date,end_date,complete FROM export_batches"
                ).fetchone()
                self.assertEqual(batch, ("2026-09-10", "2026-08-11", "2026-09-10", 1))
                self.assertEqual(db.execute(
                    "SELECT biz_date,sku_id,sales_qty FROM paid_order_items_raw"
                ).fetchone(), ("2026-09-10", "sku1", 2.0))

    def test_expands_combo_skus_and_aligns_to_inventory_cutoff(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ods, today, inventory = root / "ods.sqlite", root / "today.sqlite", root / "inventory.sqlite"
            with sqlite3.connect(ods) as db:
                db.executescript("""
                  CREATE TABLE export_batches(batch_id TEXT PRIMARY KEY,business_date TEXT,
                    start_date TEXT,end_date TEXT,captured_at TEXT,quality TEXT,complete INTEGER,
                    manifest_json TEXT);
                  CREATE TABLE export_shards(batch_id TEXT,shard_id TEXT,source_name TEXT,
                    source_sha256 TEXT,effective_start TEXT,effective_end TEXT,row_count INTEGER,
                    complete INTEGER,PRIMARY KEY(batch_id,shard_id));
                  CREATE TABLE export_coverage(batch_id TEXT,biz_date TEXT,shard_id TEXT,
                    PRIMARY KEY(batch_id,biz_date));
                  CREATE TABLE paid_order_items_raw(batch_id TEXT,shard_id TEXT,row_number INTEGER,
                    biz_date TEXT,pay_date TEXT,platform TEXT,shop_id TEXT,shop_name TEXT,spu_id TEXT,
                    sku_id TEXT,shop_spu_id TEXT,shop_sku_id TEXT,sales_qty REAL,so_id TEXT,
                    outer_so_id TEXT,o_id TEXT,order_labels TEXT,influencer_id TEXT,
                    influencer_name TEXT,sales_amount REAL,refund_qty REAL,refund_amount REAL,
                    gross_margin REAL,raw_json TEXT,PRIMARY KEY(batch_id,shard_id,row_number));
                  INSERT INTO export_batches VALUES
                    ('b','2026-09-09','2026-09-10','2026-09-09','old','raw',1,'[]');
                  INSERT INTO export_shards VALUES
                    ('b','old','old.xlsx','abc','2026-09-09','2026-09-09',0,1);
                  INSERT INTO export_coverage VALUES('b','2026-09-09','old');
                """)
            with sqlite3.connect(inventory) as db:
                db.executescript("""
                  CREATE TABLE export_info(id INTEGER PRIMARY KEY,completed_at TEXT);
                  INSERT INTO export_info VALUES(1,'2026-09-09T18:45:04.178Z');
                  CREATE TABLE sku_inventory(spu_id TEXT,sku_id TEXT,properties_value TEXT);
                  INSERT INTO sku_inventory VALUES
                    ('66391','66391-黑色上衣-L','黑色上衣;L'),
                    ('66391','66391-黑色上衣-M','黑色上衣;M'),
                    ('66353','66353-吊带皮裙-L','吊带皮裙;L'),
                    ('66353','66353-吊带皮裙-M','吊带皮裙;M');
                """)
            with sqlite3.connect(today) as db:
                db.executescript("""
                  CREATE TABLE sync_metadata(id INTEGER PRIMARY KEY,schema_version INTEGER,day TEXT,
                    date_field TEXT,finished_at TEXT,expected_count INTEGER,fetched_count INTEGER,
                    unique_count INTEGER,upper_bound TEXT);
                  INSERT INTO sync_metadata VALUES
                    (1,2,'2026-09-10','pay_date','2026-09-09T19:00:00Z',3,3,3,
                     '2026-09-10 03:00:00');
                  CREATE TABLE orders(o_id TEXT PRIMARY KEY,pay_date TEXT,status TEXT,shop_id TEXT,
                    shop_name TEXT,shop_site TEXT,so_id TEXT,labels TEXT);
                  CREATE TABLE order_items(o_id TEXT,position INTEGER,sku_id TEXT,i_id TEXT,
                    shop_sku_id TEXT,shop_i_id TEXT,qty REAL,json TEXT);
                  INSERT INTO orders VALUES
                    ('valid','2026-09-10 02:40:00','异常','1','店','抖音','so1','精选联盟'),
                    ('cancel','2026-09-10 02:41:00','取消','1','店','抖音','so2','精选联盟'),
                    ('late','2026-09-10 02:50:00','已付款待审核','1','店','抖音','so3','精选联盟');
                  INSERT INTO order_items VALUES
                    ('valid',1,'66391+66353组-黑衣吊带皮裙两件套-L','66391+66353组','ss1','si1',1,
                     '{"sku_type":"combine","properties_value":"颜色分类:黑衣+吊带皮裙;尺码大小:L"}'),
                    ('cancel',1,'66353-吊带皮裙-L','66353','ss2','si2',1,'{}'),
                    ('late',1,'66353-吊带皮裙-M','66353','ss3','si3',1,'{}');
                """)
            result = subprocess.run([
                "python3", str(SCRIPT), "--ods", str(ods), "--today", str(today),
                "--business-date", "2026-09-10", "--inventory", str(inventory),
            ], check=False, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            summary = json.loads(result.stdout)
            self.assertEqual(summary["expanded_combos"], 1)
            self.assertEqual(summary["skipped_cancelled"], 1)
            self.assertEqual(summary["skipped_after_cutoff"], 1)
            self.assertEqual(summary["inventory_cutoff"], "2026-09-10 02:45:04")
            with sqlite3.connect(ods) as db:
                self.assertEqual(db.execute(
                    "SELECT spu_id,sku_id,sales_qty FROM paid_order_items_raw ORDER BY spu_id"
                ).fetchall(), [
                    ("66353", "66353-吊带皮裙-L", 1.0),
                    ("66391", "66391-黑色上衣-L", 1.0),
                ])
                self.assertEqual(db.execute(
                    "SELECT captured_at FROM export_batches"
                ).fetchone()[0], "2026-09-09T18:45:04.178Z")
            # Replaying an older order snapshot against newer inventory must not
            # label orders with the newer inventory time or exceed page coverage.
            with sqlite3.connect(inventory) as db:
                db.execute("UPDATE export_info SET completed_at='2026-09-10T04:00:00Z'")
            result = subprocess.run([
                'python3', str(SCRIPT), '--ods', str(ods), '--today', str(today),
                '--business-date', '2026-09-10', '--inventory', str(inventory),
            ], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            summary = json.loads(result.stdout)
            self.assertEqual(summary['effective_cutoff'], '2026-09-10 03:00:00')
            self.assertEqual(summary['captured_at'], '2026-09-09T19:00:00Z')
            self.assertEqual(summary['item_rows'], 3)


if __name__ == "__main__":
    unittest.main()
