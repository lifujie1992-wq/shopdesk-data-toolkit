import gzip
import importlib.util
import json
import tempfile
import unittest
import uuid
from pathlib import Path

import duckdb


ROOT = Path(__file__).parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


importer = load("shop_products_duckdb_importer", ROOT / "scripts/import-shop-product-exports-duckdb.py")
delta = load("shop_products_delta", ROOT / "scripts/build-shop-products-delta.py")
server = load("xdr_sync_server_delta", ROOT / "server/xdr_sync_server.py")


class ShopProductsDeltaTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.base = self.root / "base.duckdb"
        self.current = self.root / "current.duckdb"
        self.revision = str(uuid.uuid4())
        for path in (self.base, self.current):
            db = duckdb.connect(str(path))
            importer.create_schema(db)
            db.close()

        db = duckdb.connect(str(self.base))
        db.execute("INSERT INTO snapshot_info VALUES(1,'2026-09-10','old',1,1,4,2,2,0,1)")
        db.execute("INSERT INTO snapshot_files VALUES('old.xlsx','old',1,4)")
        db.execute("INSERT INTO shop_product_items VALUES "
                   "('s','shop','淘宝','i1','c1','one',NULL,'u1',NULL,1,1,1,NULL,NULL,NULL,NULL),"
                   "('s','shop','淘宝','i2','c2','two',NULL,'u2',NULL,1,1,0,NULL,NULL,NULL,NULL)")
        db.execute("INSERT INTO shop_product_skus VALUES "
                   "('s','i1','k1','a','one',NULL,NULL,1,1,1,NULL,NULL,NULL,NULL),"
                   "('s','i2','k2','b','two',NULL,NULL,1,1,0,NULL,NULL,NULL,NULL)")
        db.execute("INSERT INTO _xdr_meta VALUES('revision',?),"
                   "('export_format','shop_product_detail_v1')", [self.revision])
        db.close()

        db = duckdb.connect(str(self.current))
        db.execute("INSERT INTO snapshot_info VALUES(1,'2026-09-11','new',1,1,4,2,2,0,1)")
        db.execute("INSERT INTO snapshot_files VALUES('new.xlsx','new',1,4)")
        db.execute("INSERT INTO shop_product_items VALUES "
                   "('s','shop','淘宝','i1','c1','one changed',NULL,'u1',NULL,1,1,0,NULL,NULL,NULL,NULL),"
                   "('s','shop','淘宝','i3','c3','three',NULL,'u3',NULL,1,1,1,NULL,NULL,NULL,NULL)")
        db.execute("INSERT INTO shop_product_skus VALUES "
                   "('s','i1','k1','a','one changed',NULL,NULL,1,1,0,NULL,NULL,NULL,NULL),"
                   "('s','i3','k3','c','three',NULL,NULL,1,1,1,NULL,NULL,NULL,NULL)")
        db.execute("INSERT INTO listing_status_changes VALUES"
                   "('2026-09-11','item','s','i1','','status_changed',1,0,'new')")
        db.execute("INSERT INTO _xdr_meta VALUES('export_format','shop_product_detail_v1')")
        db.close()

    def tearDown(self):
        self.temp.cleanup()

    def test_delta_round_trip_updates_deletes_and_revision(self):
        job = str(uuid.uuid4())
        result = delta.build(self.current, self.base, self.root, job, self.revision,
                             ROOT / "shared/datasets.json")
        self.assertLess(result["compressed_bytes"], 100_000)
        self.assertGreater(result["changed_rows"], 0)
        unpacked = self.root / "patch.sqlite"
        with gzip.open(result["data"], "rb") as source, unpacked.open("wb") as target:
            target.write(source.read())
        applied = self.root / "applied.duckdb"
        spec = json.loads((ROOT / "shared/datasets.json").read_text())["datasets"]["shop_products"]
        server.apply_shop_products_patch(self.base, applied, unpacked, result["manifest"], spec)
        db = duckdb.connect(str(applied), read_only=True)
        self.assertEqual(db.execute("SELECT platform_item_id,item_name,is_listed FROM shop_product_items ORDER BY 1").fetchall(),
                         [("i1", "one changed", 0), ("i3", "three", 1)])
        self.assertEqual(db.execute("SELECT platform_sku_id FROM shop_product_skus ORDER BY 1").fetchall(),
                         [("k1",), ("k3",)])
        self.assertEqual(db.execute("SELECT count(*) FROM listing_status_changes").fetchone()[0], 1)
        self.assertEqual(server.duckdb_revision(applied), result["manifest"]["target_revision"])
        db.close()

    def test_snapshot_comparison_records_listing_changes(self):
        db = duckdb.connect(str(self.current))
        count = importer.add_changes(db, self.base, "2026-09-11", "new")
        self.assertEqual(count, 6)
        self.assertEqual(
            db.execute("SELECT change_type,count(*) FROM listing_status_changes GROUP BY 1 ORDER BY 1").fetchall(),
            [("created", 2), ("deleted", 2), ("status_changed", 2)],
        )
        db.close()

    def test_delta_rejects_mismatched_export_formats(self):
        db = duckdb.connect(str(self.current))
        db.execute(
            "UPDATE _xdr_meta SET value='shop_product_listing_v1' WHERE key='export_format'"
        )
        db.close()
        with self.assertRaisesRegex(ValueError, "shop_products_export_format_mismatch"):
            delta.build(self.current, self.base, self.root, str(uuid.uuid4()), self.revision,
                        ROOT / "shared/datasets.json")

    def test_delta_rejects_abnormal_primary_table_churn(self):
        with self.assertRaisesRegex(ValueError, "shop_products_change_ratio_exceeded"):
            delta.build(self.current, self.base, self.root, str(uuid.uuid4()), self.revision,
                        ROOT / "shared/datasets.json", change_guard_min_rows=1)


if __name__ == "__main__":
    unittest.main()
