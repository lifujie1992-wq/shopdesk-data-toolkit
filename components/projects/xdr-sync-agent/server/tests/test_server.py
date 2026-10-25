import gzip, hashlib, importlib.util, json, os, sqlite3, tempfile, unittest, uuid
from datetime import datetime
from pathlib import Path

MODULE=Path(__file__).parents[1]/"xdr_sync_server.py"
spec=importlib.util.spec_from_file_location("xdr_sync_server",MODULE); x=importlib.util.module_from_spec(spec); spec.loader.exec_module(x)

class ServerTests(unittest.TestCase):
 def setUp(self):
  self.original_now=x.now; self.original_shanghai_now=x.shanghai_now
  x.now=lambda:"2026-09-07T01:00:00+00:00"
  x.shanghai_now=lambda:datetime.fromisoformat("2026-09-07T09:00:00+08:00")
  self.t=tempfile.TemporaryDirectory(); root=Path(self.t.name); x.BASE=root; x.CONTROL=root/"state/control.sqlite"; x.DATA=root/"data"; x.INCOMING=root/"incoming"; x.FAILED=root/"failed"; x.SCHEMA_FILE=root/"schema.json"
  x.SCHEMA_FILE.write_text(json.dumps({"datasets":{"inventory":{"filename":"inventory.sqlite","primary_table":"items","tables":{"items":{"pk":["id"],"columns":["id","value"]}}},"orders":{"filename":"orders.sqlite","primary_table":"items","tables":{"items":{"pk":["id"],"columns":["id","value"]}}},"sales":{"filename":"sales.sqlite","primary_table":"items","tables":{"items":{"pk":["id"],"columns":["id","value"]}}}}}))
  x.init()
 def tearDown(self): self.t.cleanup(); x.now=self.original_now; x.shanghai_now=self.original_shanghai_now
 def test_connection_closes_and_preserves_transactions(self):
  with x.conn() as db:
   db.execute("CREATE TABLE connection_test (value TEXT)")
   db.execute("INSERT INTO connection_test VALUES ('committed')")
  with self.assertRaises(sqlite3.ProgrammingError): db.execute("SELECT 1")
  with self.assertRaisesRegex(ValueError,"rollback"):
   with x.conn() as failed:
    failed.execute("INSERT INTO connection_test VALUES ('rolled back')")
    raise ValueError("rollback")
  with self.assertRaises(sqlite3.ProgrammingError): failed.execute("SELECT 1")
  with x.conn() as check:
   self.assertEqual([r[0] for r in check.execute("SELECT value FROM connection_test")],["committed"])
 def test_auto_dedupe_keeps_earliest_queued_run(self):
  a=x.enqueue("sync_all","auto","2026-09-07T01:00:00+00:00"); b=x.enqueue("sync_all","auto","2026-09-07T02:00:00+00:00"); self.assertEqual(a["job_id"],b["job_id"]); self.assertEqual(b["result"],"deduplicated")
  with x.conn() as db: scheduled=db.execute("SELECT scheduled_at FROM jobs WHERE id=?",(a["job_id"],)).fetchone()[0]
  self.assertEqual(scheduled,"2026-09-07T01:30:00+00:00")
 def test_spu_live_task_has_its_own_dataset(self):
  result=x.enqueue("sync_spu_live","manual")
  with x.conn() as db: datasets=[row[0] for row in db.execute("SELECT dataset FROM job_datasets WHERE job_id=?",(result["job_id"],))]
  self.assertEqual(datasets,["spu_live"])
 def test_profit_analysis_task_and_watermark(self):
  result=x.enqueue("sync_profit_analysis","manual")
  with x.conn() as db: datasets=[row[0] for row in db.execute("SELECT dataset FROM job_datasets WHERE job_id=?",(result["job_id"],))]
  self.assertEqual(datasets,["profit_analysis"])
  live=x.DATA/"profit.sqlite"
  db=sqlite3.connect(live); db.executescript("CREATE TABLE profit_analysis_runs(end_date TEXT,captured_at TEXT,complete INTEGER); INSERT INTO profit_analysis_runs VALUES('2026-09-09','2026-09-10T16:03:38+08:00',1)"); db.close()
  watermark=x.dataset_watermarks("profit_analysis",{"filename":live.name})
  self.assertEqual(watermark["data_cutoff_at"],"2026-09-09")
  self.assertEqual(watermark["collection_completed_at"],"2026-09-10T16:03:38+08:00")
 def test_shop_products_task_and_watermark(self):
  result=x.enqueue("sync_shop_products","manual")
  with x.conn() as db: datasets=[row[0] for row in db.execute("SELECT dataset FROM job_datasets WHERE job_id=?",(result["job_id"],))]
  self.assertEqual(datasets,["shop_products"])
  live=x.DATA/"shop-products.sqlite"
  db=sqlite3.connect(live); db.executescript("CREATE TABLE snapshot_info(id INTEGER,snapshot_date TEXT,captured_at TEXT,complete INTEGER); INSERT INTO snapshot_info VALUES(1,'2026-09-10','2026-09-10T23:16:56+08:00',1)"); db.close()
  watermark=x.dataset_watermarks("shop_products",{"filename":live.name})
  self.assertEqual(watermark["data_cutoff_at"],"2026-09-10")
  self.assertEqual(watermark["collection_completed_at"],"2026-09-10T23:16:56+08:00")
 def test_csrf_cookie_is_reused_and_validated(self):
  token="0123456789abcdef0123456789abcdef"
  self.assertEqual(x.csrf_cookie(f"other=a; xdr_csrf={token}"),token)
  self.assertIsNone(x.csrf_cookie("xdr_csrf=invalid"))
  self.assertIn("'X-CSRF-Token':csrf()",x.PAGE)
  self.assertIn("sync_inventory:'库存同步'",x.PAGE)
  self.assertIn("success:'成功'",x.PAGE)
  self.assertIn('class="badge',x.PAGE)
  self.assertIn('<th>数据截止</th><th>采集完成</th><th>发布完成</th>',x.PAGE)
 def test_dataset_watermarks_are_read_from_published_data(self):
  live=x.DATA/"inventory-watermark.sqlite"; live.parent.mkdir(parents=True,exist_ok=True)
  db=sqlite3.connect(live)
  db.executescript("CREATE TABLE export_info(completed_at TEXT);CREATE TABLE shop_shortage_export_info(completed_at TEXT)")
  db.execute("INSERT INTO export_info VALUES('2026-09-09T13:45:46.523Z')")
  db.execute("INSERT INTO shop_shortage_export_info VALUES('2026-09-09T13:52:13.140Z')")
  db.commit();db.close()
  result=x.dataset_watermarks("inventory",{"filename":live.name})
  self.assertEqual(result["data_cutoff_at"],"2026-09-09T13:45:46.523Z")
  self.assertEqual(result["collection_completed_at"],"2026-09-09T13:52:13.140Z")
 def test_status_keeps_publication_separate_from_data_cutoff(self):
  with x.conn() as db:
   db.execute("UPDATE dataset_state SET last_success_at='2026-09-10T03:30:44+00:00' WHERE dataset='paid_orders'")
  result=x.status(); paid=next(row for row in result["datasets"] if row["dataset"]=="paid_orders")
  self.assertIsNone(paid["data_cutoff_at"])
  self.assertEqual(paid["publication_completed_at"],"2026-09-10T03:30:44+00:00")
 def test_quiet_hours_and_next_schedules(self):
  local=datetime.fromisoformat("2026-09-07T02:10:00+08:00")
  self.assertTrue(x.is_quiet(local))
  self.assertEqual(x.next_hourly(local).isoformat(),"2026-09-07T10:40:00+08:00")
  self.assertEqual(x.next_hourly(datetime(2026,9,7,20,30,tzinfo=x.SHANGHAI)).isoformat(),"2026-09-07T22:40:00+08:00")
  self.assertEqual(x.next_finalize(local).isoformat(),"2026-09-07T09:45:00+08:00")
  self.assertEqual(x.next_orders(local).isoformat(),"2026-09-07T09:40:00+08:00")
  self.assertEqual(x.next_profit_analysis(local).isoformat(),"2026-09-07T10:05:00+08:00")
  self.assertEqual(x.next_shop_products(local).isoformat(),"2026-09-08T01:00:00+08:00")
  self.assertEqual(x.next_spu_live(local).isoformat(),"2026-09-07T09:55:00+08:00")
  self.assertEqual(x.next_spu_live(datetime.fromisoformat("2026-09-07T10:05:00+08:00")).isoformat(),"2026-09-07T10:25:00+08:00")
  self.assertEqual(x.next_spu_live(datetime.fromisoformat("2026-09-07T22:25:00+08:00")).isoformat(),"2026-09-08T09:55:00+08:00")
  scheduled,deferred=x.allowed_schedule("2026-09-06T18:10:00+00:00")
  self.assertTrue(deferred)
  self.assertEqual(scheduled,"2026-09-07T01:30:00+00:00")
  self.assertFalse(x.is_quiet(datetime.fromisoformat("2026-09-07T09:30:00+08:00")))
 def test_manual_enqueue_bypasses_quiet_hours(self):
  x.now=lambda:"2026-09-06T18:10:00+00:00"
  x.shanghai_now=lambda:datetime.fromisoformat("2026-09-07T02:10:00+08:00")
  manual=x.enqueue("sync_all","manual")
  auto=x.enqueue("sync_all","auto")
  self.assertEqual(manual["result"],"queued")
  self.assertEqual(manual["scheduled_at"],"2026-09-06T18:10:00+00:00")
  self.assertEqual(auto["result"],"deferred")
  self.assertEqual(auto["scheduled_at"],"2026-09-07T01:30:00+00:00")
  leased=x.lease("manual-agent")["job"]
  self.assertEqual(leased["id"],manual["job_id"])
  self.assertEqual(leased["source"],"manual")
 def test_manual_coalesces_one_rerun(self):
  first=x.enqueue("sync_inventory"); lease=x.lease("agent")["job"]; x.heartbeat(lease["id"],"agent","fetching_inventory")
  second=x.enqueue("sync_orders"); third=x.enqueue("sync_sales"); self.assertEqual(second["job_id"],third["job_id"]); self.assertEqual(third["task"],"sync_all")
 def test_inventory_analysis_task_is_retired(self):
  with self.assertRaisesRegex(ValueError,"invalid enqueue request"):
   x.enqueue("sync_inventory_analysis")
 def test_expired_lease_is_reclaimed(self):
  jid=x.enqueue("sync_inventory")["job_id"]; x.lease("old")
  with x.conn() as db: db.execute("UPDATE jobs SET lease_until='2000-01-01T00:00:00+00:00' WHERE id=?",(jid,))
  self.assertEqual(x.lease("new")["job"]["id"],jid)
 def make_full(self,job,revision,broken=False):
  raw=Path(self.t.name)/"raw.sqlite"; db=sqlite3.connect(raw); db.execute("CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT)"); db.executemany("INSERT INTO items VALUES(?,?)",[(1,"one"),(2,"two")]); db.execute("CREATE TABLE _xdr_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)")
  man={"format_version":1,"job_id":job,"dataset":"inventory","mode":"full","base_revision":None,"target_revision":revision,"created_at":x.now(),"row_count":2,"tables":{"items":{"target_count":2,"upsert_count":2,"delete_count":0}}}; db.executemany("INSERT INTO _xdr_meta VALUES(?,?)",[("revision",revision),("manifest",json.dumps(man))]); db.commit();db.close()
  name=f"{job}.inventory.full.sqlite.gz.partial"; data=x.INCOMING/name
  with open(raw,"rb") as src,gzip.open(data,"wb") as dst: dst.write(src.read())
  sha=x.INCOMING/f"{job}.inventory.full.sha256.partial"; digest=("0"*64 if broken else hashlib.sha256(data.read_bytes()).hexdigest());sha.write_text(digest+"  file\n");return name,sha.name
 def prepared(self):
  job=x.enqueue("sync_inventory")["job_id"];x.lease("agent");x.heartbeat(job,"agent","fetching_inventory");return job
 def test_full_apply_duplicate_and_atomic_result(self):
  job=self.prepared(); rev=str(uuid.uuid4()); data,sha=self.make_full(job,rev);x.upload_ready(job,"agent","inventory",data,sha); result=x.apply(job,"agent","inventory");self.assertTrue(result["applied"]);live=x.DATA/"inventory.sqlite";self.assertEqual(sqlite3.connect(live).execute("SELECT count(*) FROM items").fetchone()[0],2);self.assertTrue(x.apply(job,"agent","inventory")["idempotent"]);self.assertFalse(any(x.DATA.glob("*.tmp")))
 def test_corrupt_upload_rejected(self):
  job=self.prepared();data,sha=self.make_full(job,str(uuid.uuid4()),True)
  with self.assertRaisesRegex(ValueError,"sha256"):x.upload_ready(job,"agent","inventory",data,sha)
 def test_revision_conflict_requests_full(self):
  job=self.prepared(); current=str(uuid.uuid4());live=x.DATA/"inventory.sqlite";db=sqlite3.connect(live);db.executescript("CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT);CREATE TABLE _xdr_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)");db.execute("INSERT INTO _xdr_meta VALUES('revision',?)",(current,));db.commit();db.close()
  # Reuse a valid patch-shaped package with an intentionally different base.
  raw=Path(self.t.name)/"patch.sqlite";db=sqlite3.connect(raw);db.executescript('CREATE TABLE _xdr_transfer_manifest(json TEXT NOT NULL);CREATE TABLE "upsert__items"(id,value);CREATE TABLE "delete__items"(id)');target=str(uuid.uuid4());man={"format_version":1,"job_id":job,"dataset":"inventory","mode":"patch","base_revision":str(uuid.uuid4()),"target_revision":target,"created_at":x.now(),"row_count":0,"tables":{"items":{"target_count":0,"upsert_count":0,"delete_count":0}}};db.execute("INSERT INTO _xdr_transfer_manifest VALUES(?)",(json.dumps(man),));db.commit();db.close();name=f"{job}.inventory.patch.sqlite.gz.partial";data=x.INCOMING/name
  with open(raw,"rb") as src,gzip.open(data,"wb") as dst:dst.write(src.read())
  shan=f"{job}.inventory.patch.sha256.partial";(x.INCOMING/shan).write_text(hashlib.sha256(data.read_bytes()).hexdigest()+"  f\n");x.upload_ready(job,"agent","inventory",name,shan);self.assertTrue(x.apply(job,"agent","inventory")["conflict"])
 def test_patch_upsert_and_delete(self):
  current=str(uuid.uuid4());live=x.DATA/"inventory.sqlite";db=sqlite3.connect(live);db.executescript("CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT);CREATE TABLE _xdr_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)");db.executemany("INSERT INTO items VALUES(?,?)",[(1,"old"),(2,"delete")]);db.execute("INSERT INTO _xdr_meta VALUES('revision',?)",(current,));db.commit();db.close()
  job=self.prepared();target=str(uuid.uuid4());raw=Path(self.t.name)/"patch2.sqlite";db=sqlite3.connect(raw);db.executescript('CREATE TABLE _xdr_transfer_manifest(json TEXT NOT NULL);CREATE TABLE "upsert__items"(id,value);CREATE TABLE "delete__items"(id)');db.executemany('INSERT INTO "upsert__items" VALUES(?,?)',[(1,"new"),(3,"insert")]);db.execute('INSERT INTO "delete__items" VALUES(2)');man={"format_version":1,"job_id":job,"dataset":"inventory","mode":"patch","base_revision":current,"target_revision":target,"created_at":x.now(),"row_count":2,"tables":{"items":{"target_count":2,"upsert_count":2,"delete_count":1}}};db.execute("INSERT INTO _xdr_transfer_manifest VALUES(?)",(json.dumps(man),));db.commit();db.close();name=f"{job}.inventory.patch.sqlite.gz.partial";data=x.INCOMING/name
  with open(raw,"rb") as src,gzip.open(data,"wb") as dst:dst.write(src.read())
  shan=f"{job}.inventory.patch.sha256.partial";(x.INCOMING/shan).write_text(hashlib.sha256(data.read_bytes()).hexdigest()+"  f\n");x.upload_ready(job,"agent","inventory",name,shan);self.assertTrue(x.apply(job,"agent","inventory")["applied"]);db=sqlite3.connect(live);self.assertEqual(db.execute("SELECT * FROM items ORDER BY id").fetchall(),[(1,"new"),(3,"insert")]);db.close()

if __name__=="__main__": unittest.main()
