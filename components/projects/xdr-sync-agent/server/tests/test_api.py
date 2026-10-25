import importlib.machinery
import importlib.util
import sqlite3
import json
import tempfile
import unittest
from datetime import date, datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
if importlib.util.find_spec("fastapi"):
    LOADER = importlib.machinery.SourceFileLoader(
        "xdr_readonly_api", str(ROOT / "server/app.py.deploy"),
    )
    SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
    api = importlib.util.module_from_spec(SPEC)
    LOADER.exec_module(api)
else:
    api = None


@unittest.skipIf(api is None, "FastAPI is not installed in the local system Python")
class ApiTests(unittest.TestCase):
    def store_channel_snapshot(self, snapshot, *, batch=False):
        table = "sale_channel_batch_snapshots" if batch else "sale_channel_snapshots"
        with sqlite3.connect(api.DB_PATHS["inventory"]) as connection:
            connection.execute(f"""CREATE TABLE IF NOT EXISTS {table} (
                query_type TEXT, product_id TEXT, count_type TEXT,
                captured_at TEXT, total INTEGER, raw_json TEXT,
                PRIMARY KEY(query_type, product_id, count_type)
            )""")
            connection.execute(f"INSERT OR REPLACE INTO {table} VALUES(?,?,?,?,?,?)", (
                snapshot["query_type"], snapshot["product_id"], snapshot["count_type"],
                snapshot["captured_at"], snapshot["total"], json.dumps(snapshot),
            ))

    def channel_snapshot(self, **overrides):
        return {
            "query_type": "sku", "product_id": "001", "sku_id": "001", "spu_id": None,
            "count_type": "channel", "captured_at": "2026-01-01T00:00:00Z",
            "total": 1, "rows": [{"platform": "拼多多", "shop_id": "shop-1",
                                   "pay_qty_today": 7, "pay_qty_3d": None}],
            **overrides,
        }

    def test_sale_channel_snapshot_grains_and_direct_values(self):
        connection = sqlite3.connect(api.DB_PATHS['inventory'])
        connection.execute('CREATE TABLE sale_channel_snapshots(query_type TEXT,product_id TEXT,count_type TEXT,raw_json TEXT)')
        for grain, quantity in [('spu', 17), ('sku', None)]:
            snapshot = {'query_type': grain, 'product_id': '001', 'count_type': 'channel',
                        'captured_at': '2026-01-01T00:00:00Z', 'total': 1,
                        'rows': [{'platform': '拼多多', 'shop_id': -1, 'distributor_id': 'd',
                                  'pay_qty_today': quantity, 'pay_qty_3d': 0, 'pay_qty_30d': 30}]}
            connection.execute('INSERT INTO sale_channel_snapshots VALUES(?,?,?,?)',
                               (grain, '001', 'channel', json.dumps(snapshot)))
        connection.commit()
        connection.close()
        sku = api.get_sale_channel_snapshot(None, '001', 'sku', 'channel')
        self.assertIsNone(sku['rows'][0]['pay_qty_today'])
        self.assertEqual(sku['rows'][0]['pay_qty_3d'], 0)
        self.assertEqual(sku['rows'][0]['distributor_id'], 'd')
        self.assertTrue(sku['stale'])
        self.assertEqual(api.get_sale_channel_snapshot(None, '001', 'spu', 'channel')['rows'][0]['pay_qty_today'], 17)
        with self.assertRaises(api.HTTPException):
            api.get_sale_channel_snapshot(None, '001', 'invalid', 'channel')

    def test_sale_channel_batch_fallback_preserves_raw_rows_and_coverage(self):
        captured = datetime.now(timezone.utc).isoformat()
        platforms = ["拼多多", "淘宝", "天猫", "抖音", "快手", "其他"]
        business_rows = [{
            "platform": platform, "shop_id": -1 if platform == "其他" else str(index),
            "shop_name": f"{platform}店铺", "pay_qty_today": None,
            "pay_qty_3d": 0, "pay_qty_7d": None, "pay_qty_15d": 15,
            "pay_qty_30d": 30, "raw_json": {"pay_qty_3d": 0},
        } for index, platform in enumerate(platforms)]
        # All-missing matrix rows are real stored records, not zeroes to invent
        # or records for the API to drop.
        business_rows.append({"platform": "拼多多", "shop_id": "all-missing",
                              **{f"pay_qty_{window}": None
                                 for window in ("today", "3d", "7d", "15d", "30d")}})
        snapshot = self.channel_snapshot(
            captured_at=captured, completed_at=captured, total=len(business_rows),
            rows=business_rows, scope_captured_at="2026-09-09T00:00:00Z",
            complete=True, is_complete_popup=True, quality="complete_popup",
        )
        self.store_channel_snapshot(snapshot, batch=True)
        result = api.get_sale_channel_snapshot(None, "001", "sku", "channel")
        self.assertEqual(result["rows"], business_rows)
        self.assertEqual(result["total"], 7)
        self.assertEqual(result["source_api"], "purchase_alarm_sku_detail_unfold")
        self.assertEqual(result["quality"], "batch_list")
        self.assertEqual(result["coverage"], "listed_shops_only")
        self.assertEqual(result["scope"], "listed_shops_only")
        self.assertEqual(result["scope_captured_at"], snapshot["scope_captured_at"])
        self.assertEqual(result["distributor_granularity"], "unavailable")
        self.assertFalse(result["complete"])
        self.assertFalse(result["is_complete_popup"])
        self.assertFalse(result["stale"])
        self.assertEqual(result["captured_at"], captured)
        self.assertEqual(result["snapshot_version"], captured)
        self.assertEqual(result["data_version"], captured)

    def test_sale_channel_complete_popup_wins_even_when_batch_is_newer(self):
        complete = self.channel_snapshot()
        newer = self.channel_snapshot(
            captured_at=datetime.now(timezone.utc).isoformat(),
            total=2, rows=[{"platform": "拼多多", "shop_id": "shop-1", "pay_qty_today": None},
                           {"platform": "抖音", "shop_id": "batch-only", "pay_qty_today": 100}],
        )
        self.store_channel_snapshot(complete)
        self.store_channel_snapshot(newer, batch=True)
        result = api.get_sale_channel_snapshot(None, "001", "sku", "channel")
        self.assertEqual(result["rows"], complete["rows"])
        self.assertEqual(result["total"], complete["total"])
        self.assertEqual(result["captured_at"], complete["captured_at"])
        self.assertEqual(result["source_api"], "purchase_alarm_sale_channel_detail")
        self.assertEqual(result["quality"], "complete_popup")
        self.assertEqual(result["coverage"], "all_returned_records")
        self.assertTrue(result["complete"])
        self.assertTrue(result["is_complete_popup"])
        self.assertTrue(result["stale"])

    def test_sale_channel_complete_survives_missing_or_failed_batch(self):
        snapshot = self.channel_snapshot()
        self.store_channel_snapshot(snapshot)
        # Optional table has not yet been migrated.
        self.assertEqual(api.get_sale_channel_snapshot(None, "001")["rows"], snapshot["rows"])
        with sqlite3.connect(api.DB_PATHS["inventory"]) as connection:
            # Deliberately unreadable batch schema: a complete popup never
            # consults it, so an incomplete/failed batch cannot break old data.
            connection.execute("CREATE TABLE sale_channel_batch_snapshots(broken TEXT)")
        self.assertEqual(api.get_sale_channel_snapshot(None, "001")["rows"], snapshot["rows"])

    def test_sale_channel_fallback_keeps_product_and_dimension_grains_separate(self):
        self.store_channel_snapshot(self.channel_snapshot(), batch=True)
        spu = self.channel_snapshot(query_type="spu", sku_id=None, spu_id="001",
                                    rows=[{"platform": "淘宝", "pay_qty_today": 20}])
        sku_platform = self.channel_snapshot(count_type="platform",
                                             rows=[{"platform": "天猫", "pay_qty_today": 30}])
        self.store_channel_snapshot(spu)
        self.store_channel_snapshot(sku_platform)
        self.assertEqual(api.get_sale_channel_snapshot(None, "001", "spu", "channel")["rows"], spu["rows"])
        self.assertEqual(api.get_sale_channel_snapshot(None, "001", "sku", "platform")["rows"], sku_platform["rows"])
        self.assertEqual(api.get_sale_channel_snapshot(None, "001", "sku", "channel")["quality"], "batch_list")
        for product_id, query_type, count_type in [("001", "spu", "platform"),
                                                  ("different", "sku", "channel")]:
            with self.assertRaises(api.HTTPException) as caught:
                api.get_sale_channel_snapshot(None, product_id, query_type, count_type)
            self.assertEqual(caught.exception.status_code, 404)
        with self.assertRaises(api.HTTPException) as caught:
            api.get_sale_channel_snapshot(None, "001", "sku", "invalid")
        self.assertEqual(caught.exception.status_code, 422)

    def test_sale_channel_empty_batch_fallback_is_not_a_complete_zero(self):
        self.store_channel_snapshot(self.channel_snapshot(total=0, rows=[]), batch=True)
        with self.assertRaises(api.HTTPException) as caught:
            api.get_sale_channel_snapshot(None, "001")
        self.assertEqual(caught.exception.status_code, 404)
        self.store_channel_snapshot(self.channel_snapshot(total=0, rows=[]))
        result = api.get_sale_channel_snapshot(None, "001")
        self.assertEqual(result["rows"], [])
        self.assertEqual(result["total"], 0)
        self.assertTrue(result["is_complete_popup"])

    def test_sale_channel_missing_snapshots_have_compatible_status_codes(self):
        with self.assertRaises(api.HTTPException) as caught:
            api.get_sale_channel_snapshot(None, "001")
        self.assertEqual(caught.exception.status_code, 503)
        self.store_channel_snapshot(self.channel_snapshot())
        with self.assertRaises(api.HTTPException) as caught:
            api.get_sale_channel_snapshot(None, "not-collected")
        self.assertEqual(caught.exception.status_code, 404)

    def test_sale_channel_invalid_complete_does_not_silently_fall_back(self):
        self.store_channel_snapshot(self.channel_snapshot(captured_at="invalid"))
        self.store_channel_snapshot(self.channel_snapshot(), batch=True)
        with self.assertRaises(api.HTTPException) as caught:
            api.get_sale_channel_snapshot(None, "001")
        self.assertEqual(caught.exception.status_code, 503)
        self.assertEqual(caught.exception.detail, "Sales channel snapshot is invalid")

    def test_sale_channel_invalid_total_is_rejected_for_each_source(self):
        for batch in (False, True):
            for index, total in enumerate((True, False, -1, 1.0, "1", None, 0, 2)):
                with self.subTest(batch=batch, total=total):
                    product_id = f"total-{batch}-{index}"
                    self.store_channel_snapshot(
                        self.channel_snapshot(product_id=product_id, sku_id=product_id, total=total),
                        batch=batch,
                    )
                    with self.assertRaises(api.HTTPException) as caught:
                        api.get_sale_channel_snapshot(None, product_id)
                    self.assertEqual(caught.exception.status_code, 503)
                    self.assertEqual(caught.exception.detail, "Sales channel snapshot is invalid")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        database = Path(self.temp.name) / "inventory.sqlite"
        connection = sqlite3.connect(database)
        connection.executescript("""
            CREATE TABLE shop_daily_sales_analysis (
              spu_id TEXT NOT NULL, shop_id TEXT NOT NULL, biz_date TEXT NOT NULL,
              sales_qty REAL NOT NULL, sales_amount REAL NOT NULL,
              order_count REAL NOT NULL, return_item_qty REAL
            );
            CREATE TABLE inventory_daily_metrics (
              snapshot_date TEXT PRIMARY KEY, captured_at TEXT NOT NULL,
              warning_style_count INTEGER NOT NULL, stockout_qty REAL NOT NULL,
              urgent_stockout_qty REAL NOT NULL, overdue_qty REAL NOT NULL,
              due_within_1d_qty REAL NOT NULL, presale_stockout_qty REAL NOT NULL,
              unshipped_qty REAL NOT NULL, available_qty REAL NOT NULL,
              onway_qty REAL NOT NULL, active_style_count_7d INTEGER NOT NULL,
              product_stockout_style_count INTEGER NOT NULL,
              purchase_warning_style_count INTEGER NOT NULL
            );
            INSERT INTO shop_daily_sales_analysis VALUES
              ('spu-1', 'shop-1', '2026-09-06', 12, 345.67, 8, 3),
              ('spu-1', 'shop-1', '2026-09-05', 5, 100, 4, 1),
              ('spu-2', 'shop-2', '2026-09-06', 2, 30, 2, 0);
            INSERT INTO inventory_daily_metrics VALUES
              ('2026-09-06', '2026-09-06T12:45:00Z', 20, 100, 12, 9, 3, 40, 80, 500, 120, 15, 8, 10),
              ('2026-09-05', '2026-09-05T12:45:00Z', 18, 90, 10, 8, 2, 35, 70, 520, 100, 14, 7, 9);
        """)
        connection.execute(
            f"CREATE TABLE sku_inventory ({','.join(api.SKU_COLUMNS)})",
        )
        connection.execute(
            f"CREATE TABLE spu_inventory ({','.join(api.SPU_COLUMNS)})",
        )
        connection.executemany(
            "INSERT INTO sku_inventory(spu_id,sku_id,sku_name,stockout_qty,advice_purchase_qty) "
            "VALUES(?,?,?,?,?)",
            [("spu-1", "sku-1", "SKU 一", 3, 10),
             ("spu-2", "sku-2", "SKU 二", 0, 5),
             ("spu-3", "sku-3", "无订单 SKU", 8, 20)],
        )
        connection.executemany(
            "INSERT INTO spu_inventory(spu_id,spu_name,stockout_qty,advice_purchase_qty) "
            "VALUES(?,?,?,?)",
            [("spu-1", "款一", 3, 10), ("spu-2", "款二", 0, 5),
             ("spu-3", "无订单款", 8, 20)],
        )
        connection.execute(
            "CREATE TABLE export_info(id INTEGER,completed_at TEXT)",
        )
        connection.execute(
            "INSERT INTO export_info VALUES(1,'2026-09-09T13:53:28Z')",
        )
        connection.executescript("""
            CREATE TABLE shop_groups(
              group_id TEXT PRIMARY KEY,group_name TEXT,shop_count INTEGER,captured_at TEXT
            );
            CREATE TABLE shop_group_members(
              group_id TEXT,shop_id TEXT,PRIMARY KEY(group_id,shop_id)
            );
            INSERT INTO shop_groups VALUES
              ('group-1','第一事业部（家宜）',1,'2026-09-09T12:00:00Z');
            INSERT INTO shop_group_members VALUES ('group-1','shop-2');
        """)
        for table, columns in (
            ("platform_product_sales_analysis", api.PLATFORM_PRODUCT_SALES_COLUMNS),
            ("shop_product_sales_analysis", api.SHOP_PRODUCT_SALES_COLUMNS),
            ("link_product_sales_analysis", api.LINK_PRODUCT_SALES_COLUMNS),
        ):
            connection.execute(
                f"CREATE TABLE {table} ({','.join(columns)})",
            )
        connection.executemany(
            "INSERT INTO platform_product_sales_analysis "
            "(spu_id,platform,start_date,end_date,pay_qty_today,pay_qty_30d,sales_qty) "
            "VALUES (?,?,?,?,?,?,?)",
            [
                ("spu-1", "Platform A", "2026-08-08", "2026-09-06", 2, 30, 20),
                ("spu-1", "Platform B", "2026-08-08", "2026-09-06", 1, 10, 5),
            ],
        )
        connection.executemany(
            "INSERT INTO link_product_sales_analysis "
            "(spu_id,shop_id,platform,shop_spu_id,start_date,end_date,"
            "pay_qty_today,pay_qty_30d,sales_qty) VALUES (?,?,?,?,?,?,?,?,?)",
            [
                ("spu-1", "shop-1", "Platform A", "link-1", "2026-08-08", "2026-09-06", 2, 30, 20),
                ("spu-1", "shop-1", "Platform A", "link-2", "2026-08-08", "2026-09-06", 1, 10, 5),
            ],
        )
        connection.commit()
        connection.close()
        paid_orders = Path(self.temp.name) / "paid-orders.sqlite"
        today = api.shanghai_today().isoformat()
        with sqlite3.connect(paid_orders) as connection:
            connection.executescript(f"""
                CREATE TABLE warehouse_runs(
                  batch_id TEXT, business_date TEXT, start_date TEXT, end_date TEXT,
                  captured_at TEXT, published_at TEXT, raw_rows INTEGER,
                  sku_snapshots INTEGER, platform_rows INTEGER, shop_rows INTEGER,
                  link_rows INTEGER, source_rows INTEGER, quality TEXT
                );
                INSERT INTO warehouse_runs VALUES(
                  'batch-1','{today}','2026-08-10','{today}',
                  '2026-09-09T11:29:48Z','2026-09-09T11:43:37Z',10,2,1,1,1,2,
                  'order_derived'
                );
                CREATE TABLE ads_sku_source_sales(
                  sku_id TEXT,spu_id TEXT,source_category TEXT,pay_qty_today REAL,
                  pay_qty_1d REAL,pay_qty_3d REAL,pay_qty_7d REAL,pay_qty_15d REAL,
                  pay_qty_30d REAL,captured_at TEXT,quality TEXT,source_labels TEXT,
                  influencer_ids TEXT
                );
                CREATE TABLE ads_sku_shop_source_sales(
                  sku_id TEXT,spu_id TEXT,shop_id TEXT,shop_name TEXT,platform TEXT,
                  source_category TEXT,pay_qty_today REAL,pay_qty_1d REAL,
                  pay_qty_3d REAL,pay_qty_7d REAL,pay_qty_15d REAL,pay_qty_30d REAL,
                  captured_at TEXT,quality TEXT,source_labels TEXT,influencer_ids TEXT
                );
                CREATE TABLE bi_sku_platform_sales_daily(
                  biz_date TEXT,spu_id TEXT,sku_id TEXT,platform TEXT,sales_qty REAL,
                  order_count INTEGER,sales_amount REAL,refund_qty REAL,
                  refund_amount REAL,gross_margin REAL
                );
                CREATE TABLE dwd_paid_order_items(
                  sku_id TEXT,platform TEXT,shop_id TEXT
                );
                CREATE TABLE paid_order_items_raw(
                  sku_id TEXT,platform TEXT,shop_id TEXT
                );
                CREATE INDEX dwd_paid_order_items_sku ON dwd_paid_order_items(sku_id);
                INSERT INTO dwd_paid_order_items VALUES
                  ('sku-1','抖音','shop-1'),
                  ('sku-1','抖音','shop-3'),
                  ('sku-2','拼多多','shop-2');
                INSERT INTO paid_order_items_raw SELECT * FROM dwd_paid_order_items;
                INSERT INTO bi_sku_platform_sales_daily VALUES
                  ('2026-09-09','spu-1','sku-1','抖音',5,4,500,NULL,NULL,NULL),
                  ('2026-09-08','spu-1','sku-1','抖音',31,28,3000,2,100,900);
                INSERT INTO ads_sku_source_sales VALUES
                  ('sku-1','spu-1','精选联盟',4,3,9,20,40,80,
                   '2026-09-09T11:29:48Z','order_derived','精选联盟','达人-1'),
                  ('sku-1','spu-1','商品卡',9,2,6,12,24,48,
                   '2026-09-09T11:29:48Z','order_derived',NULL,NULL);
            """)
        self.old_inventory = api.DB_PATHS["inventory"]
        self.old_spu_live = api.DB_PATHS["spu_live"]
        self.old_paid_orders = api.DB_PATHS["paid_orders"]
        api.DB_PATHS["inventory"] = database
        api.DB_PATHS["spu_live"] = Path(self.temp.name) / "spu-live.sqlite"
        api.DB_PATHS["paid_orders"] = paid_orders

    def tearDown(self):
        api.DB_PATHS["inventory"] = self.old_inventory
        api.DB_PATHS["spu_live"] = self.old_spu_live
        api.DB_PATHS["paid_orders"] = self.old_paid_orders
        self.temp.cleanup()

    def test_live_inventory_keeps_spu_and_sku_on_one_revision(self):
        with sqlite3.connect(api.DB_PATHS["inventory"]) as connection:
            connection.executescript("""
                DROP TABLE export_info;
                CREATE TABLE export_info(
                  id INTEGER,started_at TEXT,completed_at TEXT,
                  fetched_spu INTEGER,fetched_sku INTEGER
                );
                INSERT INTO export_info VALUES(
                  1,'2026-09-09T13:43:14Z','2026-09-09T13:45:46Z',3,3
                );
                CREATE TABLE _xdr_meta(key TEXT PRIMARY KEY,value TEXT);
                INSERT INTO _xdr_meta VALUES('revision','inventory-rev');
                CREATE TABLE shop_shortage_export_info(id INTEGER,completed_at TEXT);
                INSERT INTO shop_shortage_export_info VALUES(1,'2026-09-09T13:52:13Z');
            """)
        with sqlite3.connect(api.DB_PATHS["spu_live"]) as connection:
            connection.execute(f"CREATE TABLE spu_inventory ({','.join(api.SPU_COLUMNS)})")
            connection.execute(f"CREATE TABLE sku_inventory ({','.join(api.SKU_COLUMNS)})")
            connection.execute(
                "INSERT INTO spu_inventory(spu_id,spu_name,stockout_qty,advice_purchase_qty) "
                "VALUES('spu-live','十五分钟新数据',7,99)"
            )
            connection.execute(
                "INSERT INTO sku_inventory(spu_id,sku_id,sku_name,pay_qty_today) "
                "VALUES('spu-live','sku-live','十五分钟 SKU',20)"
            )
            connection.executescript("""
                CREATE TABLE export_info(
                  id INTEGER,started_at TEXT,completed_at TEXT,
                  api_total_spu INTEGER,fetched_spu INTEGER,fetched_sku INTEGER
                );
                INSERT INTO export_info VALUES(
                  1,'2026-09-09T14:00:00Z','2026-09-09T14:02:30Z',1,1,1
                );
                CREATE TABLE _xdr_meta(key TEXT PRIMARY KEY,value TEXT);
                INSERT INTO _xdr_meta VALUES('revision','spu-rev');
            """)

        self.assertEqual(api.get_spu("spu-live", None)["spu_name"], "十五分钟新数据")
        listed = api.list_spus(
            None, limit=100, offset=0, category=None, brand_name=None,
            stockout_only=False,
        )
        self.assertEqual([row["spu_id"] for row in listed["items"]], ["spu-live"])
        sku = api.get_sku("spu-live", "sku-live", None)
        self.assertEqual(sku["sku_name"], "十五分钟 SKU")
        self.assertEqual(sku["pay_qty_today"], 20)
        self.assertEqual(sku["snapshot_date"], "2026-09-09")
        self.assertTrue(sku["spu_sku_coherent"])

        listed_skus = api.list_skus(
            None, limit=100, offset=0, spu_id="spu-live", sku_id=None,
            category=None, brand_name=None, stockout_only=False,
        )
        self.assertEqual([row["sku_id"] for row in listed_skus["items"]], ["sku-live"])
        self.assertEqual(listed_skus["captured_at"], "2026-09-09T14:02:30Z")
        self.assertTrue(listed_skus["spu_sku_coherent"])

        result = api.inventory_status(None)
        self.assertEqual(result["data_version"], "spu-rev:spu-rev")
        self.assertEqual(result["spu_revision"], "spu-rev")
        self.assertEqual(result["sku_revision"], "spu-rev")
        self.assertEqual(result["spu_source_completed_at"], "2026-09-09T14:02:30Z")
        self.assertEqual(result["sku_source_completed_at"], "2026-09-09T14:02:30Z")
        self.assertEqual(result["source_completed_at"], "2026-09-09T14:02:30Z")
        self.assertEqual(result["shop_shortage_source_completed_at"], "2026-09-09T13:52:13Z")
        self.assertEqual(result["spu_total"], 1)
        self.assertEqual(result["sku_total"], 1)
        self.assertEqual(result["spu_source"], "spu_live")
        self.assertEqual(result["sku_source"], "spu_live")
        self.assertTrue(result["spu_sku_coherent"])

    def test_incomplete_spu_live_falls_back_to_full_inventory(self):
        with sqlite3.connect(api.DB_PATHS["spu_live"]) as connection:
            connection.execute(f"CREATE TABLE spu_inventory ({','.join(api.SPU_COLUMNS)})")
            connection.execute(
                "INSERT INTO spu_inventory(spu_id,spu_name) VALUES('partial','不能发布')"
            )
            connection.executescript("""
                CREATE TABLE export_info(
                  id INTEGER,api_total_spu INTEGER,fetched_spu INTEGER
                );
                INSERT INTO export_info VALUES(1,2,1);
            """)
        self.assertFalse(api.spu_live_available())
        self.assertEqual(api.get_spu("spu-1", None)["spu_name"], "款一")
        self.assertEqual(api.inventory_status(None)["spu_source"], "inventory")

    def test_bi_sku_source_sales_uses_bi_contract_and_zero_fills(self):
        result = api.bi_sku_source_sales(None, "sku-1")
        self.assertEqual(result["query_type"], "sku")
        self.assertEqual(result["data_version"], "batch-1:2026-09-09T11:29:48Z")
        self.assertEqual([row["source_type"] for row in result["rows"]],
                         ["精选联盟", "直播间", "商品卡"])
        self.assertNotIn("source_category", result["rows"][0])
        self.assertEqual(result["rows"][0]["pay_qty_today"], 4)
        self.assertEqual(result["rows"][1]["pay_qty_today"], 0)
        self.assertEqual(result["rows"][2]["pay_qty_30d"], 48)

    def test_bi_sku_source_sales_exposes_unattributed_gap_to_live_total(self):
        original = api.live_inventory_today_qty
        api.live_inventory_today_qty = lambda query_type, product_id: (
            83.0, {"captured_at": "live-capture", "snapshot_date": api.shanghai_today().isoformat()},
        )
        try:
            result = api.bi_sku_source_sales(None, "sku-1")
        finally:
            api.live_inventory_today_qty = original
        self.assertEqual(result["live_pay_qty_today"], 83)
        self.assertEqual(result["attributed_pay_qty_today"], 13)
        self.assertFalse(result["attribution_complete"])
        self.assertEqual(result["rows"][-1]["source_type"], "待归因")
        self.assertEqual(result["rows"][-1]["pay_qty_today"], 70)
        self.assertEqual(sum(row["pay_qty_today"] for row in result["rows"]), 83)

    def test_warehouse_sku_source_sales_remains_compatible(self):
        result = api.warehouse_sku_source_sales(None, "sku-1")
        self.assertIn("source_category", result["rows"][0])
        self.assertNotIn("source_type", result["rows"][0])

    def test_bi_sku_platform_daily_filters_and_preserves_nulls(self):
        result = api.bi_sku_platform_sales_daily(
            None, limit=100, offset=0, sku_id="sku-1", spu_id=None,
            platform="抖音", date_from=date(2026, 9, 9), date_to=date(2026, 9, 9),
        )
        self.assertEqual(len(result["items"]), 1)
        self.assertEqual(result["items"][0]["sales_qty"], 5)
        self.assertEqual(result["items"][0]["order_count"], 4)
        self.assertIsNone(result["items"][0]["refund_qty"])
        with self.assertRaises(api.HTTPException):
            api.bi_sku_platform_sales_daily(
                None, limit=100, offset=0, sku_id=None, spu_id=None, platform=None,
                date_from=None, date_to=None,
            )

    def test_inventory_shop_directory_and_product_scope(self):
        with sqlite3.connect(api.DB_PATHS["inventory"]) as connection:
            connection.executescript("""
                CREATE TABLE shop_directory(
                  shop_id TEXT PRIMARY KEY,shop_name TEXT,platform TEXT,captured_at TEXT
                );
                CREATE TABLE IF NOT EXISTS shop_groups(
                  group_id TEXT PRIMARY KEY,group_name TEXT,shop_count INTEGER,captured_at TEXT
                );
                CREATE TABLE IF NOT EXISTS shop_group_members(
                  group_id TEXT,shop_id TEXT,PRIMARY KEY(group_id,shop_id)
                );
                INSERT INTO shop_directory VALUES
                  ('shop-1','抖音一店','抖音','2026-09-09T12:00:00Z'),
                  ('shop-2','多多一店','拼多多','2026-09-09T12:00:00Z');
                INSERT OR REPLACE INTO shop_groups VALUES
                  ('group-1','第一事业部（家宜）',1,'2026-09-09T12:00:00Z');
                INSERT OR REPLACE INTO shop_group_members VALUES ('group-1','shop-2');
                INSERT INTO shop_product_sales_analysis
                  (spu_id,shop_id,shop_name,platform,start_date,end_date,sales_qty)
                  VALUES ('spu-2','shop-2','多多一店','拼多多','2026-08-10','2026-09-09',2);
            """)
        directory = api.list_inventory_shop_directory(None, limit=100, offset=0)
        self.assertEqual(directory["source"], "platform_shop_list")
        self.assertEqual(
            {(row["platform"], row["shop_id"]) for row in directory["items"]},
            {("抖音", "shop-1"), ("拼多多", "shop-2")},
        )
        groups = api.list_inventory_shop_groups(None, limit=100, offset=0)
        self.assertEqual(groups["source"], "query_shop_group_config")
        self.assertEqual(groups["items"], [{
            "group_id": "group-1", "group_name": "第一事业部（家宜）",
            "shop_count": 1, "captured_at": "2026-09-09T12:00:00Z",
            "shop_ids": ["shop-2"],
        }])
        platform = api.list_inventory_product_scope(
            None, limit=100, offset=0, platform=["Platform A"], shop_id=None,
        )
        self.assertEqual([row["spu_id"] for row in platform["items"]], ["spu-1"])
        shop = api.list_inventory_product_scope(
            None, limit=100, offset=0, platform=None, shop_id=["shop-2"],
        )
        self.assertEqual([row["spu_id"] for row in shop["items"]], ["spu-2"])
        union = api.list_inventory_product_scope(
            None, limit=100, offset=0, platform=["Platform A"], shop_id=["shop-2"],
        )
        self.assertEqual([row["spu_id"] for row in union["items"]], ["spu-1", "spu-2"])
        with self.assertRaises(api.HTTPException) as caught:
            api.list_inventory_product_scope(
                None, limit=100, offset=0, platform=None, shop_id=None,
            )
        self.assertEqual(caught.exception.status_code, 422)

    def test_bi_inventory_products_filters_skus_by_platform_and_shop(self):
        douyin = api.bi_inventory_products(
            None, limit=100, offset=0, view_type="sku", platform=["抖音"],
            shop_id=None, stockout_only=False,
        )
        self.assertEqual([row["sku_id"] for row in douyin["items"]], ["sku-1"])
        self.assertEqual(douyin["total"], 1)
        self.assertEqual(douyin["relationship_start_date"], "2026-08-10")
        self.assertEqual(douyin["inventory_captured_at"], "2026-09-09T13:53:28Z")
        self.assertEqual(douyin["quality"], "order_derived_scope")

        shop = api.bi_inventory_products(
            None, limit=100, offset=0, view_type="sku", platform=None,
            shop_id=["shop-2"], stockout_only=False,
        )
        self.assertEqual([row["sku_id"] for row in shop["items"]], ["sku-2"])

        group = api.bi_inventory_products(
            None, limit=100, offset=0, view_type="sku", platform=None,
            shop_id=None, shop_group_id=["group-1"], stockout_only=False,
        )
        self.assertEqual([row["sku_id"] for row in group["items"]], ["sku-2"])

        combined = api.bi_inventory_products(
            None, limit=100, offset=0, view_type="sku", platform=["抖音"],
            shop_id=["shop-2"], stockout_only=False,
        )
        self.assertEqual(combined["items"], [])
        self.assertEqual(combined["total"], 0)

    def test_bi_inventory_products_supports_spu_and_stockout_filter(self):
        result = api.bi_inventory_products(
            None, limit=100, offset=0, view_type="spu",
            platform=["抖音", "拼多多"], shop_id=None, stockout_only=True,
        )
        self.assertEqual([row["spu_id"] for row in result["items"]], ["spu-1"])
        with self.assertRaises(api.HTTPException) as missing:
            api.bi_inventory_products(
                None, limit=100, offset=0, view_type="sku", platform=None,
                shop_id=None, stockout_only=False,
            )
        self.assertEqual(missing.exception.status_code, 422)

    def test_bi_inventory_product_scope_returns_complete_identity_set(self):
        platform = api.bi_inventory_product_scope(
            None, platform=["抖音"], shop_id=None,
        )
        self.assertEqual(platform["items"], [{"spu_id": "spu-1", "sku_id": "sku-1"}])
        self.assertEqual(platform["total"], 1)
        self.assertEqual(platform["spu_total"], 1)
        self.assertEqual(platform["data_version"], "batch-1:2026-09-09T11:29:48Z")
        self.assertEqual(platform["quality"], "order_derived_scope")

        combined = api.bi_inventory_product_scope(
            None, platform=["抖音"], shop_id=["shop-2"],
        )
        self.assertEqual(combined["items"], [])
        group = api.bi_inventory_product_scope(
            None, platform=None, shop_id=None, shop_group_id=["group-1"],
        )
        self.assertEqual(group["items"], [{"spu_id": "spu-2", "sku_id": "sku-2"}])
        self.assertEqual(group["filters"]["shop_group_id"], ["group-1"])
        self.assertEqual(combined["total"], 0)
        with self.assertRaises(api.HTTPException) as missing:
            api.bi_inventory_product_scope(None, platform=None, shop_id=None)
        self.assertEqual(missing.exception.status_code, 422)

    @unittest.skipUnless(api is not None and api.duckdb is not None, "duckdb is not installed")
    def test_sales_channels_reads_normalized_duckdb_warehouse(self):
        path = Path(self.temp.name) / "paid-orders.duckdb"
        connection = api.duckdb.connect(str(path))
        today = api.shanghai_today().isoformat()
        connection.execute(f"""
          CREATE TABLE warehouse_runs(batch_id VARCHAR,business_date VARCHAR,start_date VARCHAR,
            end_date VARCHAR,captured_at VARCHAR,published_at VARCHAR,raw_rows BIGINT,
            sku_snapshots BIGINT,platform_rows BIGINT,shop_rows BIGINT,link_rows BIGINT,
            source_rows BIGINT,quality VARCHAR,data_version VARCHAR);
          INSERT INTO warehouse_runs VALUES('b','{today}','2026-08-10','{today}',
            'capture','publish',2,2,1,1,1,1,'order_derived','b:capture');
          CREATE TABLE bi_product_catalog(query_type VARCHAR,product_id VARCHAR,spu_id VARCHAR);
          INSERT INTO bi_product_catalog VALUES('sku','sku-1','spu-1');
          CREATE TABLE bi_sales_channel_rows(query_type VARCHAR,product_id VARCHAR,spu_id VARCHAR,
            count_type VARCHAR,platform VARCHAR,shop_id VARCHAR,shop_name VARCHAR,
            pay_qty_today DOUBLE,pay_qty_1d DOUBLE,pay_qty_3d DOUBLE,pay_qty_7d DOUBLE,
            pay_qty_15d DOUBLE,pay_qty_30d DOUBLE);
          INSERT INTO bi_sales_channel_rows VALUES
            ('sku','sku-1','spu-1','platform','抖音',NULL,NULL,5,3,8,8,8,8);
        """)
        connection.close()
        old = api.DB_PATHS["paid_orders"]
        api.DB_PATHS["paid_orders"] = path
        try:
            result = api.bi_sales_channels(None, "sku-1", "sku", "platform")
        finally:
            api.DB_PATHS["paid_orders"] = old
        self.assertEqual(result["data_version"], "b:capture")
        self.assertEqual(result["rows"], [{"platform": "抖音", "pay_qty_today": 5,
            "pay_qty_1d": 3, "pay_qty_3d": 8, "pay_qty_7d": 8,
            "pay_qty_15d": 8, "pay_qty_30d": 8}])

    @unittest.skipUnless(api is not None and api.duckdb is not None, "duckdb is not installed")
    def test_sales_channels_never_reports_previous_day_as_today(self):
        path = Path(self.temp.name) / "stale-paid-orders.duckdb"
        connection = api.duckdb.connect(str(path))
        connection.execute("""
          CREATE TABLE warehouse_runs(batch_id VARCHAR,business_date VARCHAR,start_date VARCHAR,
            end_date VARCHAR,captured_at VARCHAR,published_at VARCHAR,raw_rows BIGINT,
            sku_snapshots BIGINT,platform_rows BIGINT,shop_rows BIGINT,link_rows BIGINT,
            source_rows BIGINT,quality VARCHAR,data_version VARCHAR);
          INSERT INTO warehouse_runs VALUES('b','2000-01-01','1999-12-01','2000-01-01',
            'capture','publish',2,2,1,1,1,1,'order_derived','b:capture');
          CREATE TABLE bi_product_catalog(query_type VARCHAR,product_id VARCHAR,spu_id VARCHAR);
          INSERT INTO bi_product_catalog VALUES('spu','66353','66353');
          CREATE TABLE bi_sales_channel_rows(query_type VARCHAR,product_id VARCHAR,spu_id VARCHAR,
            count_type VARCHAR,platform VARCHAR,shop_id VARCHAR,shop_name VARCHAR,
            pay_qty_today DOUBLE,pay_qty_1d DOUBLE,pay_qty_3d DOUBLE,pay_qty_7d DOUBLE,
            pay_qty_15d DOUBLE,pay_qty_30d DOUBLE);
          INSERT INTO bi_sales_channel_rows VALUES
            ('spu','66353','66353','platform','抖音',NULL,NULL,119,5,8,8,8,8);
        """)
        connection.close()
        old = api.DB_PATHS["paid_orders"]
        api.DB_PATHS["paid_orders"] = path
        try:
            result = api.bi_sales_channels(None, "66353", "spu", "platform")
        finally:
            api.DB_PATHS["paid_orders"] = old
        self.assertIsNone(result["rows"][0]["pay_qty_today"])
        self.assertFalse(result["today_complete"])
        self.assertTrue(result["stale"])
    def test_shop_directory_can_filter_platform_and_name(self):
        with sqlite3.connect(api.DB_PATHS["inventory"]) as connection:
            connection.executescript("""
                CREATE TABLE shop_directory(
                  shop_id TEXT PRIMARY KEY,shop_name TEXT,platform TEXT,captured_at TEXT
                );
                INSERT INTO shop_directory VALUES
                  ('shop-1','抖音一店','抖音','2026-09-09T12:00:00Z'),
                  ('shop-2','多多一店','拼多多','2026-09-09T12:00:00Z');
            """)
        result = api.list_inventory_shop_directory(
            None, limit=100, offset=0, platform=["抖音"], shop_name="一店",
        )
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["items"][0]["shop_id"], "shop-1")

    def test_get_shop_daily_sales(self):
        result = api.get_shop_daily_sales(
            "spu-1", "shop-1", date(2026, 9, 6), None,
        )
        self.assertEqual(result["sales_qty"], 12)
        self.assertEqual(result["return_item_qty"], 3)

    def test_list_shop_daily_sales_requires_shop_or_spu(self):
        with self.assertRaisesRegex(api.HTTPException, "Provide spu_id or shop_id"):
            api.list_shop_daily_sales(
                None, limit=100, offset=0, spu_id=None, shop_id=None,
                date_from=None, date_to=None,
            )

    def test_list_shop_daily_sales_filters_real_grain(self):
        result = api.list_shop_daily_sales(
            None,
            limit=100,
            offset=0,
            spu_id="spu-1",
            shop_id=None,
            date_from=date(2026, 9, 6),
            date_to=date(2026, 9, 6),
        )
        self.assertEqual(len(result["items"]), 1)
        self.assertEqual(result["items"][0]["shop_id"], "shop-1")
        self.assertEqual(result["items"][0]["return_item_qty"], 3)

    def test_get_inventory_daily_metrics(self):
        result = api.get_inventory_daily_metrics(date(2026, 9, 6), None)
        self.assertEqual(result["warning_style_count"], 20)
        self.assertEqual(result["overdue_qty"], 9)

    def test_list_inventory_daily_metrics_by_date(self):
        result = api.list_inventory_daily_metrics(
            None,
            limit=100,
            offset=0,
            date_from=date(2026, 9, 6),
            date_to=date(2026, 9, 6),
        )
        self.assertEqual(len(result["items"]), 1)
        self.assertEqual(result["items"][0]["snapshot_date"], "2026-09-06")

    def test_list_platform_sales_orders_by_sales_quantity(self):
        result = api.list_platform_product_sales(
            None, limit=100, offset=0, spu_id="spu-1", platform=None,
        )
        self.assertEqual(
            [item["platform"] for item in result["items"]],
            ["Platform A", "Platform B"],
        )
        self.assertEqual(result["items"][0]["pay_qty_30d"], 30)

    def test_list_link_sales_orders_by_sales_quantity(self):
        result = api.list_link_product_sales(
            None, limit=100, offset=0, spu_id="spu-1", shop_id=None,
            shop_spu_id=None, platform=None,
        )
        self.assertEqual(
            [item["shop_spu_id"] for item in result["items"]],
            ["link-1", "link-2"],
        )
        self.assertEqual(result["items"][0]["pay_qty_today"], 2)


@unittest.skipIf(api is None, "FastAPI is not installed in the local system Python")
class ProfitAnalysisApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.database = Path(self.temp.name) / "profit.sqlite"
        self.old_database = api.DB_PATHS["profit_analysis"]
        api.DB_PATHS["profit_analysis"] = self.database
        with sqlite3.connect(self.database) as connection:
            connection.execute("""CREATE TABLE profit_analysis_runs(
                start_date TEXT,end_date TEXT,previous_start_date TEXT,previous_end_date TEXT,
                data_update_date TEXT,captured_at TEXT,source_name TEXT,source_sha256 TEXT,
                row_count INTEGER,complete INTEGER)""")
            definitions = ",".join(f'"{column}"' for column in api.PROFIT_ANALYSIS_COLUMNS)
            connection.execute(f"CREATE TABLE sku_profit_analysis({definitions})")
            connection.execute(
                "INSERT INTO profit_analysis_runs VALUES(?,?,?,?,?,?,?,?,?,?)",
                ("2026-09-03", "2026-09-09", "2026-08-27", "2026-09-02",
                 "2026-09-09", "2026-09-10T16:03:38+08:00", "利润.xlsx", "sha", 2, 1),
            )
            connection.executemany(
                "INSERT INTO sku_profit_analysis(start_date,end_date,sku_id,spu_id,profit,profit_rate,gross_profit_rate,sales_amount,high_profit_order_count,high_gross_profit_order_count,negative_profit_order_count,negative_gross_profit_order_count,product_loss_order_count,freight_loss_order_count,profit_status_label,profit_change_label,gross_profit_status_label,gross_profit_change_label) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                [
                    ("2026-09-03", "2026-09-09", "sku-profit", "spu-1", 80, .2, .25, 400,
                     7, 8, 1, 2, 0, 3,
                     "持续盈利", "盈利增长", "持续盈利", "盈利增长"),
                    ("2026-09-03", "2026-09-09", "sku-loss", "spu-1", -10, -.1, .05, 100,
                     5, 6, 3, 4, 2, 4,
                     "持续亏损", "亏损扩大", "持续盈利", "盈利缩小"),
                ],
            )

    def tearDown(self):
        api.DB_PATHS["profit_analysis"] = self.old_database
        self.temp.cleanup()

    def test_profit_analysis_filters_latest_window_and_preserves_decimal_rates(self):
        result = api.sku_profit_analysis(
            None, limit=100, offset=0, start_date=None, end_date=None,
            sku_id=None, spu_id="spu-1", min_profit_rate=None, max_profit_rate=None,
            loss_only=True, sort_by="profit", descending=True,
        )
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["items"][0]["sku_id"], "sku-loss")
        self.assertEqual(result["items"][0]["profit_rate"], -.1)
        self.assertEqual(result["items"][0]["product_loss_order_count"], 2)
        self.assertEqual(result["items"][0]["freight_loss_order_count"], 4)
        self.assertEqual(result["items"][0]["high_profit_order_count"], 5)
        self.assertEqual(result["items"][0]["negative_gross_profit_order_count"], 4)
        self.assertEqual(result["items"][0]["profit_status_label"], "持续亏损")
        self.assertEqual(result["items"][0]["profit_change_label"], "亏损扩大")
        self.assertEqual(result["rate_unit"], "decimal_ratio")
        self.assertEqual(api.sku_profit_analysis_status(None)["row_count"], 2)


@unittest.skipIf(api is None, "FastAPI is not installed in the local system Python")
class ShopProductsApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.database = Path(self.temp.name) / "shop-products.sqlite"
        self.old_database = api.DB_PATHS["shop_products"]
        api.DB_PATHS["shop_products"] = self.database
        with sqlite3.connect(self.database) as connection:
            connection.executescript("""
              CREATE TABLE snapshot_info(id INTEGER PRIMARY KEY,snapshot_date TEXT,captured_at TEXT,
                source_count INTEGER,workbook_count INTEGER,raw_row_count INTEGER,item_count INTEGER,
                sku_count INTEGER,unmapped_shop_count INTEGER,complete INTEGER);
              INSERT INTO snapshot_info VALUES(1,'2026-09-10','2026-09-10T23:16:56+08:00',17,32,3,1,2,0,1);
              CREATE TABLE shop_product_items(shop_id TEXT,shop_name TEXT,platform TEXT,
                platform_item_id TEXT,internal_item_code TEXT,item_name TEXT,item_image TEXT,item_url TEXT,
                virtual_category TEXT,shop_stock INTEGER,system_available_stock INTEGER,is_listed INTEGER,
                listing_result TEXT,sync_setting TEXT,off_shelf_time TEXT,remark TEXT);
              INSERT INTO shop_product_items VALUES('shop-1','一店','淘宝','item-1','spu-1','商品',
                'image','https://item.example/1','分类',3,2,1,NULL,'开启同步',NULL,NULL);
              INSERT INTO shop_product_items VALUES('shop-1','一店','淘宝','item-2','34284-','商品2',
                NULL,NULL,NULL,0,0,1,NULL,NULL,NULL,NULL);
              INSERT INTO shop_product_items VALUES('shop-2','二店','抖音','item-3','原F-34284-A','商品3',
                NULL,NULL,NULL,0,0,0,NULL,NULL,NULL,NULL);
              INSERT INTO shop_product_items VALUES('shop-2','二店','抖音','item-4','342840-A','其他商品',
                NULL,NULL,NULL,0,0,1,NULL,NULL,NULL,NULL);
              CREATE TABLE shop_product_skus(shop_id TEXT,platform_item_id TEXT,platform_sku_id TEXT,
                internal_sku_code TEXT,sku_name TEXT,sku_image TEXT,virtual_category TEXT,shop_stock INTEGER,
                system_available_stock INTEGER,is_listed INTEGER,listing_result TEXT,sync_setting TEXT,
                off_shelf_time TEXT,remark TEXT);
              INSERT INTO shop_product_skus VALUES('shop-1','item-1','variant-1','sku-1','红;L',NULL,
                '分类',2,1,1,NULL,'开启同步',NULL,NULL);
              INSERT INTO shop_product_skus VALUES('shop-1','item-1','variant-2','sku-2','蓝;L',NULL,
                '分类',1,1,0,NULL,'开启同步','2026/9/10 12:00:00',NULL);
              CREATE TABLE listing_status_changes(change_date TEXT,entity_type TEXT,shop_id TEXT,
                platform_item_id TEXT,platform_sku_id TEXT,change_type TEXT,old_is_listed INTEGER,
                new_is_listed INTEGER,detected_at TEXT);
              INSERT INTO listing_status_changes VALUES('2026-09-10','sku','shop-1','item-1',
                'variant-2','status_changed',1,0,'2026-09-10T23:16:56+08:00');
            """)

    def tearDown(self):
        api.DB_PATHS["shop_products"] = self.old_database
        self.temp.cleanup()

    def test_shop_product_skus_include_item_link_and_cursor(self):
        result = api.shop_product_skus(
            None, limit=1, after_rowid=0, shop_id=None, platform="淘宝",
            platform_item_id=None, platform_sku_id=None, sku_id=None, listed=True,
        )
        self.assertEqual(result["items"][0]["internal_sku_code"], "sku-1")
        self.assertEqual(result["items"][0]["item_url"], "https://item.example/1")
        self.assertTrue(result["has_more"])
        self.assertEqual(result["snapshot"]["sku_count"], 2)

    def test_shop_product_changes_filter_date(self):
        result = api.shop_product_status_changes(
            None, limit=100, offset=0, change_date=date(2026, 9, 10),
            entity_type="sku", change_type="status_changed", shop_id=None,
        )
        self.assertEqual(result["items"][0]["old_is_listed"], 1)
        self.assertEqual(result["items"][0]["new_is_listed"], 0)

    def test_shop_product_code_summary_merges_all_matching_numeric_parts(self):
        result = api.shop_product_code_summary(None, "34284")
        self.assertEqual(result["link_count"], 2)
        self.assertEqual(result["listed_link_count"], 1)
        self.assertEqual(result["unlisted_link_count"], 1)
        self.assertEqual(result["shop_count"], 2)
        self.assertEqual(
            [item["internal_item_code"] for item in result["matched_raw_codes"]],
            ["34284-", "原F-34284-A"],
        )
        self.assertEqual({item["platform"] for item in result["platforms"]}, {"淘宝", "抖音"})

    def test_shop_product_code_summary_rejects_non_numeric_query(self):
        with self.assertRaises(api.HTTPException) as raised:
            api.shop_product_code_summary(None, "34284-A")
        self.assertEqual(raised.exception.status_code, 422)


if __name__ == "__main__":
    unittest.main()
