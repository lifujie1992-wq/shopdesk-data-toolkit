#!/usr/bin/env python3
import argparse, gzip, hashlib, html, json, os, re, shutil, sqlite3, sys, tempfile, uuid
from datetime import datetime, timedelta, timezone
from contextlib import contextmanager
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs
sys.path.insert(0, str(Path(__file__).resolve().parent))
from paid_orders_warehouse import materialize_paid_orders
try:
    from paid_orders_duckdb import build_paid_orders_duckdb
except ImportError:
    build_paid_orders_duckdb = None
try:
    import duckdb
except ImportError:
    duckdb = None

BASE = Path(os.environ.get("XDR_SYNC_ROOT", "/var/lib/xdr-sync"))
CONTROL = BASE / "state/control.sqlite"
SCHEMA_FILE = Path(os.environ.get("XDR_SYNC_SCHEMA", "/usr/local/lib/xdr-sync/datasets.json"))
DATA = BASE / "data"; INCOMING = BASE / "incoming"; FAILED = BASE / "failed"
PAID_ORDERS_ENGINE = os.environ.get(
    "XDR_PAID_ORDERS_ENGINE", "duckdb" if build_paid_orders_duckdb is not None else "sqlite",
)
PAID_ORDERS_BI_FILE = os.environ.get("XDR_PAID_ORDERS_BI_FILE", "jst-paid-orders-bi.duckdb")
TASKS = {"sync_all", "sync_hourly", "sync_inventory", "sync_spu_live", "sync_orders", "sync_sales", "finalize_sales", "sync_order_page", "sync_paid_orders", "sync_unshipped_orders", "sync_profit_analysis", "sync_shop_products", "sync_doudian", "sync_doudian_client", "sync_doudian_invoice", "sync_purple_orders"}
DATASETS = {"inventory", "spu_live", "orders", "sales", "order_page", "paid_orders", "unshipped_orders", "profit_analysis", "shop_products", "doudian", "doudian_client", "doudian_invoice", "jst_purple_orders"}
ACTIVE = {"leased", "running", "uploaded", "applying"}
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
AGENT_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
FILE_RE = re.compile(r"^([0-9a-f-]{36})\.(inventory|spu_live|orders|sales|order_page|paid_orders|unshipped_orders|profit_analysis|shop_products|doudian|doudian_client|doudian_invoice|jst_purple_orders)\.(full|patch)\.(sqlite\.gz|sha256)\.(partial|ready)$", re.I)
PHASES = {"fetching_inventory", "fetching_spu_live", "fetching_orders", "fetching_order_page", "fetching_sales", "fetching_paid_orders", "fetching_unshipped_orders", "fetching_profit_analysis", "fetching_shop_products", "fetching_doudian", "fetching_doudian_client", "fetching_doudian_invoice", "fetching_jst_purple_orders", "diffing", "uploading", "waiting_apply", "idle"}
LEASE_SECONDS = 180
SHOP_PRODUCTS_LEASE_SECONDS = int(os.getenv("XDR_SHOP_PRODUCTS_LEASE_SECONDS", "14400"))
SHANGHAI = timezone(timedelta(hours=8))

def now(): return datetime.now(timezone.utc).isoformat(timespec="seconds")
def shanghai_now(): return datetime.now(SHANGHAI)
def is_quiet(local): return local.hour >= 23 or local.hour < 9 or (local.hour == 9 and local.minute < 30)
def next_allowed(local):
    if local.hour >= 23: local += timedelta(days=1)
    return local.replace(hour=9,minute=30,second=0,microsecond=0)
def allowed_schedule(value, task=None):
    stamp=datetime.fromisoformat(value); stamp=stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)
    local=stamp.astimezone(SHANGHAI)
    if task == "sync_shop_products" or not is_quiet(local): return stamp.isoformat(timespec="seconds"),False
    return next_allowed(local).astimezone(timezone.utc).isoformat(timespec="seconds"),True
def next_hourly(local):
    for hour in (10,14,18,22):
        candidate=local.replace(hour=hour,minute=40,second=0,microsecond=0)
        if candidate > local: return candidate
    return (local+timedelta(days=1)).replace(hour=10,minute=40,second=0,microsecond=0)
def next_finalize(local):
    candidate=local.replace(hour=9,minute=45,second=0,microsecond=0)
    return candidate if candidate > local else candidate+timedelta(days=1)
def next_orders(local):
    candidate=local.replace(hour=9,minute=40,second=0,microsecond=0)
    return candidate if candidate > local else candidate+timedelta(days=1)
def next_unshipped(local):
    for hour in (9,11,13,15,17,19,21):
        candidate=local.replace(hour=hour,minute=30,second=0,microsecond=0)
        if candidate > local: return candidate
    return (local+timedelta(days=1)).replace(hour=9,minute=30,second=0,microsecond=0)
def next_profit_analysis(local):
    candidate=local.replace(hour=10,minute=5,second=0,microsecond=0)
    return candidate if candidate > local else candidate+timedelta(days=1)
def next_shop_products(local):
    candidate=local.replace(hour=1,minute=0,second=0,microsecond=0)
    return candidate if candidate > local else candidate+timedelta(days=1)
def next_spu_live(local):
    slots = [(9,55)]
    slots.extend((hour,minute) for hour in range(10,22) for minute in (25,55))
    slots.append((22,25))
    for hour,minute in slots:
        candidate=local.replace(hour=hour,minute=minute,second=0,microsecond=0)
        if candidate > local: return candidate
    return (local+timedelta(days=1)).replace(hour=9,minute=55,second=0,microsecond=0)
@contextmanager
def conn():
    CONTROL.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(CONTROL, timeout=30); db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA journal_mode=WAL"); db.execute("PRAGMA foreign_keys=ON")
        with db:
            yield db
    finally:
        db.close()
def schemas(): return json.loads(SCHEMA_FILE.read_text())["datasets"]
def init():
    for p in (DATA, INCOMING, FAILED, BASE/"queue", BASE/"logs", BASE/"state"): p.mkdir(parents=True, exist_ok=True)
    with conn() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS jobs(
          id TEXT PRIMARY KEY, task TEXT NOT NULL, source TEXT NOT NULL, state TEXT NOT NULL,
          scheduled_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          leased_by TEXT, lease_until TEXT, phase TEXT, started_at TEXT, completed_at TEXT,
          error TEXT, attempts INTEGER NOT NULL DEFAULT 0, progress_json TEXT);
        CREATE INDEX IF NOT EXISTS jobs_state_idx ON jobs(state, scheduled_at);
        CREATE TABLE IF NOT EXISTS job_datasets(
          job_id TEXT NOT NULL REFERENCES jobs(id), dataset TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
          mode TEXT, base_revision TEXT, target_revision TEXT, rows INTEGER, data_file TEXT, sha_file TEXT,
          PRIMARY KEY(job_id,dataset));
        CREATE TABLE IF NOT EXISTS dataset_state(
          dataset TEXT PRIMARY KEY, revision TEXT, last_success_at TEXT, row_count INTEGER, last_job_id TEXT, error TEXT);
        """)
        for d in DATASETS: db.execute("INSERT OR IGNORE INTO dataset_state(dataset) VALUES(?)", (d,))

def clean_expired(db):
    stamp = now()
    db.execute("UPDATE jobs SET state='queued',leased_by=NULL,lease_until=NULL,phase=NULL,updated_at=?,error='lease_expired' WHERE state IN ('leased','running','uploaded','applying') AND lease_until IS NOT NULL AND lease_until < ?", (stamp, stamp))

def task_datasets(task):
    if task == "sync_all": return ["inventory", "orders", "sales", "profit_analysis"]
    if task == "sync_hourly": return ["inventory", "sales"]
    if task in ("sync_sales", "finalize_sales"): return ["sales"]
    if task == "sync_order_page": return ["order_page"]
    if task == "sync_unshipped_orders": return ["unshipped_orders"]
    if task == "sync_purple_orders": return ["jst_purple_orders"]
    return [task.removeprefix("sync_")]

def enqueue(task, source="manual", scheduled_at=None):
    if task not in TASKS or source not in ("manual", "auto"): raise ValueError("invalid enqueue request")
    stamp = now()
    if source == "auto": scheduled_at,deferred = allowed_schedule(scheduled_at or stamp, task)
    else: scheduled_at,deferred = scheduled_at or stamp,False
    with conn() as db:
        clean_expired(db)
        if source == "auto":
            row = db.execute("SELECT id FROM jobs WHERE source='auto' AND task=? AND state='queued' ORDER BY created_at LIMIT 1", (task,)).fetchone()
            if row:
                # Keep the earliest queued run. Moving it forward on every timer tick can
                # starve a frequent task while another long job owns the single worker.
                db.execute("UPDATE jobs SET updated_at=? WHERE id=?", (stamp, row["id"]))
                return {"job_id": row["id"], "result": "deduplicated"}
        else:
            running = db.execute("SELECT 1 FROM jobs WHERE state IN ('leased','running','uploaded','applying') LIMIT 1").fetchone()
            queued = db.execute("SELECT id,task FROM jobs WHERE source='manual' AND state='queued' ORDER BY created_at LIMIT 1").fetchone()
            if running and queued:
                merged = queued["task"] if queued["task"] == task else "sync_all"
                db.execute("UPDATE jobs SET task=?,updated_at=? WHERE id=?", (merged, stamp, queued["id"]))
                if merged == "sync_all":
                    for d in task_datasets("sync_all"):
                        db.execute("INSERT OR IGNORE INTO job_datasets(job_id,dataset) VALUES(?,?)", (queued["id"], d))
                return {"job_id": queued["id"], "result": "coalesced", "task": merged}
            same = db.execute("SELECT id FROM jobs WHERE source='manual' AND task=? AND state='queued' LIMIT 1", (task,)).fetchone()
            if same: return {"job_id": same["id"], "result": "deduplicated"}
        job = str(uuid.uuid4())
        db.execute("INSERT INTO jobs(id,task,source,state,scheduled_at,created_at,updated_at) VALUES(?,?,?,'queued',?,?,?)", (job,task,source,scheduled_at,stamp,stamp))
        for d in task_datasets(task): db.execute("INSERT INTO job_datasets(job_id,dataset) VALUES(?,?)", (job,d))
        return {"job_id": job, "result": "deferred" if deferred else "queued", "task": task, "scheduled_at": scheduled_at}

def valid_uuid(value):
    if not UUID_RE.fullmatch(value or ""): raise ValueError("invalid job id")
def valid_agent(value):
    if not AGENT_RE.fullmatch(value or ""): raise ValueError("invalid agent")
def csrf_cookie(header):
    jar=cookies.SimpleCookie(header or ""); item=jar.get("xdr_csrf")
    return item.value if item and re.fullmatch(r"[0-9a-f]{32}",item.value) else None
def require_job(db, job, agent=None):
    valid_uuid(job); row=db.execute("SELECT * FROM jobs WHERE id=?",(job,)).fetchone()
    if not row: raise ValueError("unknown job")
    if agent is not None and row["leased_by"] != agent: raise ValueError("lease owner mismatch")
    return row

def job_lease_seconds(task):
    return SHOP_PRODUCTS_LEASE_SECONDS if task == "sync_shop_products" else LEASE_SECONDS

def lease(agent):
    valid_agent(agent)
    stamp=now()
    with conn() as db:
        clean_expired(db)
        night_clause=" AND (source='manual' OR task='sync_shop_products')" if is_quiet(shanghai_now()) else ""
        row=db.execute("SELECT * FROM jobs WHERE state='queued' AND scheduled_at<=?"+night_clause+" ORDER BY scheduled_at,created_at LIMIT 1",(stamp,)).fetchone()
        if not row: return {"job": None}
        until=(datetime.fromisoformat(stamp)+timedelta(seconds=job_lease_seconds(row["task"]))).isoformat(timespec="seconds")
        changed=db.execute("UPDATE jobs SET state='leased',leased_by=?,lease_until=?,started_at=COALESCE(started_at,?),updated_at=?,attempts=attempts+1 WHERE id=? AND state='queued'",(agent,until,stamp,stamp,row["id"])).rowcount
        if not changed: return {"job": None}
        revisions={r["dataset"]:r["revision"] for r in db.execute("SELECT dataset,revision FROM dataset_state")}
        return {"job":{"id":row["id"],"task":row["task"],"source":row["source"],"started_at":stamp,"revisions":revisions}}

def heartbeat(job, agent, phase):
    valid_agent(agent)
    if phase not in PHASES: raise ValueError("invalid phase")
    stamp=now()
    with conn() as db:
        row=require_job(db,job,agent)
        if row["state"] in ("success","failed"): raise ValueError("job is terminal")
        until=(datetime.fromisoformat(stamp)+timedelta(seconds=job_lease_seconds(row["task"]))).isoformat(timespec="seconds")
        db.execute("UPDATE jobs SET state='running',phase=?,lease_until=?,updated_at=? WHERE id=?",(phase,until,stamp,job))
    return {"accepted":True}

def safe_file(name, job, dataset, kind, suffix):
    match=FILE_RE.fullmatch(name or "")
    if not match or match.group(1).lower()!=job.lower() or match.group(2)!=dataset or match.group(4)!=kind or match.group(5)!=suffix: raise ValueError("invalid filename")
    path=(INCOMING/name).resolve()
    if path.parent != INCOMING.resolve(): raise ValueError("invalid path")
    return path

def upload_ready(job, agent, dataset, data_name, sha_name):
    valid_agent(agent); valid_uuid(job)
    if dataset not in DATASETS: raise ValueError("invalid dataset")
    data=safe_file(data_name,job,dataset,"sqlite.gz","partial"); sha=safe_file(sha_name,job,dataset,"sha256","partial")
    if not data.is_file() or not sha.is_file(): raise ValueError("upload incomplete")
    ready_data=data.with_name(data.name.removesuffix(".partial")+".ready"); ready_sha=sha.with_name(sha.name.removesuffix(".partial")+".ready")
    os.replace(data,ready_data); os.replace(sha,ready_sha)
    expected=ready_sha.read_text().split()[0]
    if not re.fullmatch(r"[0-9a-f]{64}",expected): raise ValueError("invalid sha file")
    actual=hashlib.sha256(ready_data.read_bytes()).hexdigest()
    if actual != expected:
        shutil.move(ready_data, FAILED/ready_data.name); shutil.move(ready_sha, FAILED/ready_sha.name); raise ValueError("sha256 mismatch")
    with conn() as db:
        require_job(db,job,agent)
        if not db.execute("SELECT 1 FROM job_datasets WHERE job_id=? AND dataset=?",(job,dataset)).fetchone(): raise ValueError("dataset not requested")
        db.execute("UPDATE job_datasets SET state='uploaded',data_file=?,sha_file=? WHERE job_id=? AND dataset=?",(ready_data.name,ready_sha.name,job,dataset))
        db.execute("UPDATE jobs SET state='uploaded',updated_at=? WHERE id=?",(now(),job))
    return {"ready":True}

def qi(name): return '"'+name.replace('"','""')+'"'
def revision(db):
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_xdr_meta'").fetchone(): return None
    row=db.execute("SELECT value FROM _xdr_meta WHERE key='revision'").fetchone(); return row[0] if row else None
def duckdb_revision(path):
    if duckdb is None or not path.exists(): return None
    db=duckdb.connect(str(path),read_only=True)
    try:
        found=db.execute("SELECT count(*) FROM information_schema.tables WHERE table_name='_xdr_meta'").fetchone()[0]
        if not found: return None
        row=db.execute("SELECT value FROM _xdr_meta WHERE key='revision'").fetchone()
        return row[0] if row else None
    finally: db.close()
def validate_schema(db,spec):
    for table,rule in spec["tables"].items():
        actual={r[1] for r in db.execute(f"PRAGMA table_info({qi(table)})")}
        missing=set(rule["columns"])-actual
        if missing: raise ValueError(f"schema missing {table}")
def integrity(db, quick=False):
    pragma = "quick_check" if quick else "integrity_check"
    if db.execute(f"PRAGMA {pragma}").fetchone()[0] != "ok": raise ValueError("integrity check failed")

def read_package(path,spec,job,dataset):
    fd,temp=tempfile.mkstemp(prefix="package-",suffix=".sqlite",dir=BASE/"state"); os.close(fd)
    try:
        with gzip.open(path,"rb") as src, open(temp,"wb") as dst: shutil.copyfileobj(src,dst)
        db=sqlite3.connect(temp); integrity(db)
        if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_xdr_transfer_manifest'").fetchone(): raw=db.execute("SELECT json FROM _xdr_transfer_manifest").fetchone()[0]
        elif db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_xdr_meta'").fetchone(): raw=db.execute("SELECT value FROM _xdr_meta WHERE key='manifest'").fetchone()[0]
        else: raise ValueError("manifest missing")
        manifest=json.loads(raw); db.close()
        required={"format_version","job_id","dataset","mode","base_revision","target_revision","created_at","row_count","tables"}
        if not required <= manifest.keys() or manifest["format_version"]!=1 or manifest["job_id"]!=job or manifest["dataset"]!=dataset or manifest["mode"] not in ("full","patch") or not UUID_RE.fullmatch(manifest["target_revision"]): raise ValueError("invalid manifest")
        if set(manifest["tables"]) != set(spec["tables"]): raise ValueError("invalid manifest tables")
        for table, counts in manifest["tables"].items():
            if set(counts)!={"target_count","upsert_count","delete_count"} or any(not isinstance(v,int) or v<0 for v in counts.values()): raise ValueError("invalid counts")
        return Path(temp),manifest
    except Exception:
        Path(temp).unlink(missing_ok=True); raise

def apply_shop_products_patch(live,temp,patch,manifest,spec):
    if duckdb is None: raise RuntimeError("DuckDB support is not installed")
    if manifest["mode"] != "patch": raise ValueError("shop-products package must be a patch")
    if not live.exists(): raise ValueError("base DuckDB missing")
    shutil.copy2(live,temp)
    db=duckdb.connect(str(temp))
    try:
        db.execute("SET threads=2")
        db.execute("SET memory_limit='1GB'")
        db.execute("LOAD sqlite")
        escaped=str(patch).replace("'","''")
        db.execute(f"ATTACH '{escaped}' AS patch (TYPE SQLITE, READ_ONLY)")
        db.execute("BEGIN TRANSACTION")
        for table,rule in spec["tables"].items():
            columns,pk=rule["columns"],rule["pk"]
            matches=" AND ".join(f"t.{qi(c)} IS NOT DISTINCT FROM p.{qi(c)}" for c in pk)
            db.execute(f"DELETE FROM {qi(table)} t USING patch.{qi('delete__'+table)} p WHERE {matches}")
            db.execute(f"DELETE FROM {qi(table)} t USING patch.{qi('upsert__'+table)} p WHERE {matches}")
            db.execute(f"INSERT INTO {qi(table)}({','.join(map(qi,columns))}) "
                       f"SELECT {','.join(map(qi,columns))} FROM patch.{qi('upsert__'+table)}")
        db.execute("CREATE TABLE IF NOT EXISTS _xdr_meta(key VARCHAR PRIMARY KEY,value VARCHAR NOT NULL)")
        db.execute("INSERT OR REPLACE INTO _xdr_meta VALUES('revision',?)",[manifest["target_revision"]])
        db.execute("COMMIT")
        for table,counts in manifest["tables"].items():
            actual=db.execute(f"SELECT count(*) FROM {qi(table)}").fetchone()[0]
            if actual != counts["target_count"]: raise ValueError(f"row count mismatch: {table}")
        snapshot=db.execute("SELECT complete FROM snapshot_info WHERE id=1").fetchone()
        if not snapshot or snapshot[0] != 1: raise ValueError("incomplete shop-products snapshot")
        db.execute("CHECKPOINT")
    except Exception:
        try: db.execute("ROLLBACK")
        except Exception: pass
        raise
    finally: db.close()

def apply(job,agent,dataset):
    valid_agent(agent); valid_uuid(job)
    if dataset not in DATASETS: raise ValueError("invalid dataset")
    spec=schemas()[dataset]
    with conn() as control:
        require_job(control,job,agent); item=control.execute("SELECT * FROM job_datasets WHERE job_id=? AND dataset=?",(job,dataset)).fetchone()
        if not item or item["state"] not in ("uploaded","applied"): raise ValueError("dataset not uploaded")
        if item["state"]=="applied": return {"applied":False,"idempotent":True,"revision":item["target_revision"]}
        control.execute("UPDATE jobs SET state='applying',updated_at=? WHERE id=?",(now(),job))
        package=INCOMING/item["data_file"]
    unpacked,manifest=read_package(package,spec,job,dataset)
    live=DATA/spec["filename"]; current=None
    if live.exists():
        if dataset == "shop_products": current=duckdb_revision(live)
        else:
            check=sqlite3.connect(live); current=revision(check); check.close()
    if manifest["mode"]=="patch" and manifest["base_revision"] != current:
        unpacked.unlink(missing_ok=True); return {"applied":False,"conflict":True,"current_revision":current}
    if current == manifest["target_revision"]:
        unpacked.unlink(missing_ok=True)
        with conn() as control: control.execute("UPDATE job_datasets SET state='applied',target_revision=? WHERE job_id=? AND dataset=?",(current,job,dataset))
        return {"applied":False,"idempotent":True,"revision":current}
    temp=DATA/f".{spec['filename']}.{job}.tmp"
    bi_temp=DATA/f".{PAID_ORDERS_BI_FILE}.{job}.tmp"
    try:
        if dataset == "shop_products":
            apply_shop_products_patch(live,temp,unpacked,manifest,spec)
        elif manifest["mode"]=="full": shutil.copy2(unpacked,temp)
        else:
            if not live.exists(): raise ValueError("base database missing")
            shutil.copy2(live,temp); db=sqlite3.connect(temp)
            try:
                db.execute("ATTACH DATABASE ? AS patch",(str(unpacked),)); db.execute("BEGIN IMMEDIATE")
                for table,rule in spec["tables"].items():
                    cols=rule["columns"]; pk=rule["pk"]
                    # Schema evolution: a patch may declare columns the live table does
                    # not have yet (e.g. new metrics). Add them so the INSERT succeeds.
                    existing={r[1] for r in db.execute(f"PRAGMA table_info({qi(table)})")}
                    for column in cols:
                        if column not in existing:
                            db.execute(f"ALTER TABLE {qi(table)} ADD COLUMN {qi(column)}")
                    index=qi(f"delete__{table}_pk")
                    db.execute(f"CREATE UNIQUE INDEX IF NOT EXISTS patch.{index} ON {qi('delete__'+table)}({','.join(map(qi,pk))})")
                    where=" AND ".join(f"{qi(table)}.{qi(c)} IS patch.{qi('delete__'+table)}.{qi(c)}" for c in pk)
                    db.execute(f"DELETE FROM {qi(table)} WHERE EXISTS(SELECT 1 FROM patch.{qi('delete__'+table)} WHERE {where})")
                    conflict=",".join(qi(c) for c in pk); updates=",".join(f"{qi(c)}=excluded.{qi(c)}" for c in cols if c not in pk)
                    action=f"DO UPDATE SET {updates}" if updates else "DO NOTHING"
                    db.execute(f"INSERT INTO {qi(table)}({','.join(map(qi,cols))}) SELECT {','.join(map(qi,cols))} FROM patch.{qi('upsert__'+table)} WHERE 1 ON CONFLICT({conflict}) {action}")
                db.execute("CREATE TABLE IF NOT EXISTS _xdr_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)")
                db.execute("INSERT INTO _xdr_meta VALUES('revision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",(manifest["target_revision"],)); db.commit()
            finally: db.close()
        if dataset == "shop_products":
            if duckdb_revision(temp)!=manifest["target_revision"]: raise ValueError("revision write failed")
        else:
            db=sqlite3.connect(temp); validate_schema(db,spec); integrity(db, dataset == "paid_orders")
            for table,counts in manifest["tables"].items():
                if db.execute(f"SELECT count(*) FROM {qi(table)}").fetchone()[0] != counts["target_count"]: raise ValueError("row count mismatch")
            if revision(db)!=manifest["target_revision"]: raise ValueError("revision write failed")
            db.close()
        warehouse = None
        if dataset == "paid_orders":
            inventory_path = DATA/schemas()["inventory"]["filename"]
            if PAID_ORDERS_ENGINE == "duckdb":
                if build_paid_orders_duckdb is None:
                    raise RuntimeError("DuckDB warehouse engine is not installed")
                warehouse = build_paid_orders_duckdb(temp, bi_temp, inventory_path)
            else:
                warehouse = materialize_paid_orders(temp, inventory_path)
        with open(temp,"rb") as f: os.fsync(f.fileno())
        if bi_temp.exists():
            with open(bi_temp,"rb") as f: os.fsync(f.fileno())
        os.replace(temp,live); dfd=os.open(DATA,os.O_DIRECTORY); os.fsync(dfd); os.close(dfd)
        if bi_temp.exists():
            os.replace(bi_temp,DATA/PAID_ORDERS_BI_FILE)
            dfd=os.open(DATA,os.O_DIRECTORY); os.fsync(dfd); os.close(dfd)
        with conn() as control:
            control.execute("UPDATE job_datasets SET state='applied',mode=?,base_revision=?,target_revision=?,rows=? WHERE job_id=? AND dataset=?",(manifest["mode"],manifest["base_revision"],manifest["target_revision"],manifest["row_count"],job,dataset))
            control.execute("UPDATE dataset_state SET revision=?,last_success_at=?,row_count=?,last_job_id=?,error=NULL WHERE dataset=?",(manifest["target_revision"],now(),manifest["row_count"],job,dataset))
            control.execute("UPDATE jobs SET state='running',phase='waiting_apply',updated_at=? WHERE id=?",(now(),job))
        package.unlink(missing_ok=True); (INCOMING/item["sha_file"]).unlink(missing_ok=True)
        return {"applied":True,"revision":manifest["target_revision"],"rows":manifest["row_count"],"warehouse":warehouse}
    except Exception:
        temp.unlink(missing_ok=True); bi_temp.unlink(missing_ok=True); raise
    finally: unpacked.unlink(missing_ok=True)

def complete(job,agent):
    valid_agent(agent)
    with conn() as db:
        require_job(db,job,agent); pending=db.execute("SELECT count(*) FROM job_datasets WHERE job_id=? AND state!='applied'",(job,)).fetchone()[0]
        if pending: raise ValueError("datasets pending")
        db.execute("UPDATE jobs SET state='success',phase='idle',error=NULL,completed_at=?,updated_at=?,lease_until=NULL WHERE id=?",(now(),now(),job))
    return {"success":True}
def fail(job,agent,error):
    valid_agent(agent); error=re.sub(r"[^A-Za-z0-9_.:-]","_",error or "unknown")[:160]
    with conn() as db: require_job(db,job,agent); db.execute("UPDATE jobs SET state='failed',error=?,completed_at=?,updated_at=?,lease_until=NULL WHERE id=?",(error,now(),now(),job))
    return {"failed":True}

def dataset_watermarks(dataset, spec):
    """Read source and collection watermarks from the published dataset itself."""
    result={"data_cutoff_at":None,"collection_completed_at":None}
    filename=spec.get("filename") if spec else None
    path=DATA/filename if filename else None
    if not path or not path.is_file(): return result
    if dataset=="shop_products" and path.suffix==".duckdb" and duckdb is not None:
        try:
            db=duckdb.connect(str(path),read_only=True)
            row=db.execute("SELECT snapshot_date,captured_at FROM snapshot_info WHERE id=1 AND complete=1").fetchone()
            if row: result.update(data_cutoff_at=row[0],collection_completed_at=row[1])
            db.close()
        except Exception:
            pass
        return result
    db=None
    try:
        db=sqlite3.connect(f"file:{path}?mode=ro",uri=True,timeout=2)
        tables={row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        def scalar(query, params=()):
            row=db.execute(query,params).fetchone()
            return row[0] if row and row[0] is not None else None
        if dataset in ("inventory","spu_live") and "export_info" in tables:
            main=scalar("SELECT max(completed_at) FROM export_info")
            completed=[main]
            if dataset=="inventory" and "shop_shortage_export_info" in tables:
                completed.append(scalar("SELECT max(completed_at) FROM shop_shortage_export_info"))
            result["data_cutoff_at"]=main
            result["collection_completed_at"]=max((v for v in completed if v),default=None)
        elif dataset=="orders":
            end_dates=[]; completed=[]
            for table in ("sync_info","item_sync_info"):
                if table in tables:
                    end_dates.append(scalar(f"SELECT max(end_date) FROM {table}"))
                    completed.append(scalar(f"SELECT max(completed_at) FROM {table}"))
            result["data_cutoff_at"]=max((v for v in end_dates if v),default=None)
            result["collection_completed_at"]=max((v for v in completed if v),default=None)
        elif dataset=="sales" and "sync_runs" in tables:
            result["data_cutoff_at"]=scalar("SELECT max(report_date) FROM sync_runs WHERE status='success'")
            result["collection_completed_at"]=scalar("SELECT max(completed_at) FROM sync_runs WHERE status='success'")
        elif dataset=="order_page" and "snapshot" in tables:
            raw=scalar("SELECT json FROM snapshot WHERE id=1")
            snapshot=json.loads(raw) if raw else {}
            captured=snapshot.get("captured_at")
            result["data_cutoff_at"]=captured
            result["collection_completed_at"]=captured
            if "_xdr_meta" in tables:
                raw_manifest=scalar("SELECT value FROM _xdr_meta WHERE key='manifest'")
                if raw_manifest:
                    result["collection_completed_at"]=json.loads(raw_manifest).get("created_at") or captured
        elif dataset=="unshipped_orders" and "sync_metadata" in tables:
            result["data_cutoff_at"]=scalar("SELECT captured_at FROM sync_metadata WHERE id=1")
            result["collection_completed_at"]=scalar("SELECT finished_at FROM sync_metadata WHERE id=1")
        elif dataset=="paid_orders" and "export_batches" in tables:
            result["data_cutoff_at"]=scalar("SELECT max(captured_at) FROM export_batches WHERE complete=1")
            # The warehouse currently records the source cutoff but not the exact
            # end of local Excel processing. Leave it blank instead of inventing it.
        elif dataset=="profit_analysis" and "profit_analysis_runs" in tables:
            result["data_cutoff_at"]=scalar("SELECT max(end_date) FROM profit_analysis_runs WHERE complete=1")
            result["collection_completed_at"]=scalar("SELECT max(captured_at) FROM profit_analysis_runs WHERE complete=1")
        elif dataset=="shop_products" and "snapshot_info" in tables:
            result["data_cutoff_at"]=scalar("SELECT snapshot_date FROM snapshot_info WHERE id=1 AND complete=1")
            result["collection_completed_at"]=scalar("SELECT captured_at FROM snapshot_info WHERE id=1 AND complete=1")
        elif dataset in ("doudian","doudian_client") and "shop_metrics_daily" in tables:
            result["data_cutoff_at"]=scalar("SELECT max(stat_date) FROM shop_metrics_daily")
            result["collection_completed_at"]=scalar("SELECT max(captured_at) FROM shop_metrics_daily")
        elif dataset=="doudian_invoice" and "invoice_daily" in tables:
            result["data_cutoff_at"]=scalar("SELECT max(stat_date) FROM invoice_daily")
            result["collection_completed_at"]=scalar("SELECT max(captured_at) FROM invoice_daily")
    except (OSError,sqlite3.Error,ValueError,TypeError,json.JSONDecodeError):
        pass
    finally:
        if db is not None: db.close()
    return result

def status():
    with conn() as db:
        clean_expired(db)
        ds=[dict(r) for r in db.execute("SELECT * FROM dataset_state ORDER BY dataset")]
        jobs=[dict(r) for r in db.execute("SELECT id,task,source,state,scheduled_at,started_at,completed_at,phase,error,attempts,leased_by,updated_at FROM jobs ORDER BY created_at DESC LIMIT 30")]
    specs=schemas()
    for item in ds:
        item.update(dataset_watermarks(item["dataset"],specs.get(item["dataset"],{})))
        item["publication_completed_at"]=item["last_success_at"]
    local=shanghai_now(); hourly=next_hourly(local); spu_live=next_spu_live(local); finalize=next_finalize(local); orders=next_orders(local); unshipped=next_unshipped(local); profit=next_profit_analysis(local); shop_products=next_shop_products(local)
    return {"datasets":ds,"jobs":jobs,"next_hourly":hourly.isoformat(),"next_spu_live":spu_live.isoformat(),"next_orders":orders.isoformat(),"next_unshipped_orders":unshipped.isoformat(),"next_profit_analysis":profit.isoformat(),"next_shop_products":shop_products.isoformat(),"next_finalize_sales":finalize.isoformat(),"quiet_hours":is_quiet(local),"next_allowed_at":next_allowed(local).isoformat() if is_quiet(local) else None}

class Handler(BaseHTTPRequestHandler):
    server_version="XDRSync/1"
    def log_message(self,fmt,*args): pass
    def origin_ok(self): return self.headers.get("Origin")=="http://127.0.0.1:8765"
    def csrf(self):
        token=csrf_cookie(self.headers.get("Cookie",""))
        return token is not None and self.headers.get("X-CSRF-Token")==token
    def send_json(self,code,data):
        body=json.dumps(data,ensure_ascii=False).encode(); self.send_response(code); self.send_header("Content-Type","application/json; charset=utf-8"); self.send_header("Content-Length",str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        if self.path=="/api/status": self.send_json(200,status()); return
        if self.path!="/": self.send_error(404); return
        token=csrf_cookie(self.headers.get("Cookie","")) or uuid.uuid4().hex
        body=PAGE.encode()
        self.send_response(200); self.send_header("Content-Type","text/html; charset=utf-8"); self.send_header("Set-Cookie",f"xdr_csrf={token}; SameSite=Strict; Path=/"); self.send_header("Content-Length",str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_POST(self):
        if not self.origin_ok() or not self.csrf(): self.send_json(403,{"error":"csrf"}); return
        actions={"/api/sync/all":"sync_all","/api/sync/inventory":"sync_inventory","/api/sync/orders":"sync_orders","/api/sync/order-page":"sync_order_page","/api/sync/unshipped-orders":"sync_unshipped_orders","/api/sync/sales":"sync_sales","/api/sync/paid-orders":"sync_paid_orders","/api/sync/profit-analysis":"sync_profit_analysis","/api/sync/shop-products":"sync_shop_products","/api/sync/doudian":"sync_doudian","/api/sync/doudian-client":"sync_doudian_client","/api/sync/doudian-invoice":"sync_doudian_invoice"}
        try:
            if self.path in actions: self.send_json(200,enqueue(actions[self.path],"manual")); return
            if self.path=="/api/retry":
                with conn() as db: row=db.execute("SELECT id,task FROM jobs WHERE state='failed' ORDER BY completed_at DESC LIMIT 1").fetchone()
                self.send_json(200, enqueue(row["task"],"manual") if row else {"result":"nothing_to_retry"}); return
            self.send_error(404)
        except Exception as e: self.send_json(400,{"error":str(e)[:160]})

PAGE = r'''<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>XDR 同步管理</title>
<style>
:root{color-scheme:light;--ink:#17212b;--muted:#65727e;--line:#dce2e7;--panel:#fff;--bg:#f3f5f7;--green:#087e68;--green-dark:#066b59;--navy:#1d3448}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;letter-spacing:0}
header{background:var(--navy);color:#fff}.header-inner{max-width:1240px;margin:auto;padding:17px 24px;display:flex;align-items:center;justify-content:space-between;gap:16px}.brand{display:flex;align-items:center;gap:11px}.brand-mark{display:grid;place-items:center;width:32px;height:32px;border-radius:6px;background:#10a184;font-weight:750}.brand strong{display:block;font-size:16px}.brand small{display:block;color:#b9c8d4;margin-top:1px}.service-state{display:flex;align-items:center;gap:7px;color:#d8e5ec;font-size:13px}.service-state i{width:8px;height:8px;border-radius:50%;background:#38d39f;box-shadow:0 0 0 3px rgb(56 211 159/.14)}.service-state.quiet i{background:#f4b84a;box-shadow:0 0 0 3px rgb(244 184 74/.16)}
main{max-width:1240px;margin:auto;padding:24px}.toolbar{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:16px 0 20px;border-bottom:1px solid var(--line)}.actions{display:flex;gap:8px;flex-wrap:wrap}button{min-height:38px;border:1px solid #bac4cc;background:#fff;color:#24313c;padding:8px 13px;border-radius:6px;font:inherit;font-weight:600;cursor:pointer;transition:background .15s,border-color .15s,box-shadow .15s}button:hover{background:#f8fafb;border-color:#8e9ba6}button:focus-visible{outline:3px solid rgb(8 126 104/.2);outline-offset:1px}button.primary{background:var(--green);border-color:var(--green);color:#fff}button.primary:hover{background:var(--green-dark)}button.retry{color:#9a5800;border-color:#d8b878}button:disabled{cursor:wait;opacity:.58}.schedule{color:var(--muted);font-size:13px;text-align:right;white-space:nowrap}
#notice{display:none;margin:16px 0 0;padding:10px 12px;border-left:3px solid #2679bd;background:#eaf4fb;color:#174f78}#notice.show{display:block}#notice.error{border-color:#c73e49;background:#fcedee;color:#8a2630}
section{margin-top:27px}.section-head{display:flex;align-items:end;justify-content:space-between;gap:12px;margin-bottom:10px}.section-head h2{font-size:16px;margin:0}.section-head p{margin:0;color:var(--muted);font-size:13px}.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:7px;background:var(--panel)}table{width:100%;border-collapse:collapse;min-width:760px}th,td{text-align:left;padding:11px 13px;border-bottom:1px solid #e7ebee;vertical-align:middle}th{background:#f7f9fa;color:#53616d;font-size:12px;font-weight:700;white-space:nowrap}tbody tr:last-child td{border-bottom:0}tbody tr:hover{background:#fafcfc}.dataset-name,.task-name{font-weight:650}.dataset-name small,.task-name small{display:block;color:#87929c;font-weight:400;font-size:11px}.number{font-variant-numeric:tabular-nums}.revision{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:#51606d}.muted{color:#87929c}.error-text{display:block;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#b02f3a;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}.badge{display:inline-flex;align-items:center;gap:6px;min-width:66px;justify-content:center;padding:3px 8px;border:1px solid transparent;border-radius:999px;font-size:12px;font-weight:700;white-space:nowrap}.badge:before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}.success{color:#08735f;background:#e9f7f2;border-color:#bce8d8}.failed{color:#ae303b;background:#fff0f1;border-color:#f2c4c8}.running,.leased,.uploaded,.applying{color:#1769a5;background:#edf6fc;border-color:#c6e1f3}.queued{color:#9a5b05;background:#fff7e7;border-color:#efd59f}.cancelled,.unknown{color:#65727e;background:#f1f3f5;border-color:#dce2e7}.phase{color:#52616d;white-space:nowrap}.source{color:#52616d}.empty{padding:26px;text-align:center;color:var(--muted)}
@media(max-width:760px){.header-inner,main{padding-left:16px;padding-right:16px}.brand small,.service-state{display:none}.toolbar{align-items:flex-start;flex-direction:column}.schedule{text-align:left;white-space:normal}.actions{width:100%}.actions button{flex:1 1 calc(50% - 8px)}section{margin-top:22px}.section-head{align-items:flex-start;flex-direction:column;gap:2px}}
</style>
</head>
<body>
<header><div class="header-inner"><div class="brand"><span class="brand-mark">X</span><div><strong>XDR 数据同步</strong><small>聚水潭数据传输与任务管理</small></div></div><span class="service-state" id="serviceState"><i></i><span id="serviceLabel">同步服务运行中</span></span></div></header>
<main>
  <div class="toolbar"><div class="actions"><button class="primary" data-a="all">全部更新</button><button data-a="inventory">更新库存</button><button data-a="orders">更新订单</button><button data-a="order-page">更新订单详情</button><button data-a="unshipped-orders">更新未发货</button><button data-a="sales">更新销售</button><button data-a="profit-analysis">更新商品利润</button><button data-a="shop-products">更新店铺商品</button><button data-a="doudian">更新抖店指标</button><button data-a="doudian-client">更新客户抖店指标</button><button data-a="doudian-invoice">更新抖店待开票</button><button data-a="paid-orders">发布订单数仓</button><button class="retry" data-a="retry">重试失败任务</button></div><div class="schedule" id="next">正在读取调度计划...</div></div>
  <div id="notice" role="status"></div>
  <section><div class="section-head"><div><h2>数据集概览</h2><p>数据截止＝源数据水位；采集完成＝本地抓取/导出处理结束；发布完成＝阿里云原子切换完成</p></div><p id="updated"></p></div><div class="table-wrap"><table><thead><tr><th>数据集</th><th>数据截止</th><th>采集完成</th><th>发布完成</th><th>数据行数</th><th>版本</th><th>异常</th></tr></thead><tbody id="datasets"><tr><td class="empty" colspan="7">正在加载...</td></tr></tbody></table></div></section>
  <section><div class="section-head"><div><h2>最近任务</h2><p>最新 30 条自动和手动同步记录</p></div></div><div class="table-wrap"><table><thead><tr><th>任务</th><th>来源</th><th>状态</th><th>当前阶段</th><th>开始时间</th><th>耗时</th><th>错误</th></tr></thead><tbody id="jobs"><tr><td class="empty" colspan="7">正在加载...</td></tr></tbody></table></div></section>
</main>
<script>
const TASK={sync_all:'全部数据同步',sync_hourly:'整点轻量同步',sync_inventory:'库存同步',sync_spu_live:'SPU 高频同步',sync_orders:'订单同步',sync_order_page:'订单详情同步',sync_unshipped_orders:'未发货订单同步',sync_sales:'销售同步',sync_paid_orders:'订单数仓发布',sync_profit_analysis:'商品利润分析',sync_shop_products:'店铺商品',sync_doudian:'抖店指标同步',sync_doudian_client:'客户抖店指标同步',sync_doudian_invoice:'抖店待开票同步',finalize_sales:'销售终稿同步'};
const DATASET={inventory:'完整库存',spu_live:'SPU/SKU 高频快照',orders:'订单',order_page:'订单详情',unshipped_orders:'未发货订单',sales:'销售',paid_orders:'订单数仓',profit_analysis:'商品利润分析',shop_products:'店铺商品',doudian:'抖店每日指标',doudian_client:'客户抖店每日指标',doudian_invoice:'抖店待开票'};
const STATE={queued:'排队中',leased:'已领取',running:'进行中',uploaded:'已上传',applying:'应用中',success:'成功',failed:'失败',cancelled:'已取消'};
const PHASE={fetching_inventory:'获取完整库存',fetching_spu_live:'获取 SPU/SKU 列表',fetching_orders:'获取订单',fetching_order_page:'获取订单详情',fetching_unshipped_orders:'获取未发货订单',fetching_sales:'获取销售',fetching_paid_orders:'读取订单导出',fetching_profit_analysis:'导出并处理商品利润',fetching_shop_products:'处理店铺商品导出',fetching_doudian:'采集抖店指标',fetching_doudian_client:'采集客户抖店指标',fetching_doudian_invoice:'采集抖店待开票',diffing:'计算变更',uploading:'上传数据',waiting_apply:'阿里云聚合',idle:'已完成'};
const SOURCE={manual:'手动',auto:'自动'};
const csrf=()=>document.cookie.split('; ').find(x=>x.startsWith('xdr_csrf='))?.split('=').slice(1).join('=')||'';
let quiet=false;
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time=x=>x?new Date(x).toLocaleString('zh-CN',{hour12:false}):'-';
const watermark=x=>/^\d{4}-\d{2}-\d{2}$/.test(x||'')?x:time(x);
const duration=(x,now)=>x.started_at?Math.max(0,Math.round(((x.completed_at?Date.parse(x.completed_at):now)-Date.parse(x.started_at))/1000))+' 秒':'-';
const badge=x=>`<span class="badge ${STATE[x]?x:'unknown'}">${esc(STATE[x]||x||'未知')}</span>`;
async function refresh(){
  try{
    const s=await fetch('/api/status').then(r=>{if(!r.ok)throw Error('状态请求失败');return r.json()});
    datasets.innerHTML=s.datasets.map(x=>`<tr><td class="dataset-name">${esc(DATASET[x.dataset]||x.dataset)}<small>${esc(x.dataset)}</small></td><td>${watermark(x.data_cutoff_at)}</td><td>${watermark(x.collection_completed_at)}</td><td>${time(x.publication_completed_at)}</td><td class="number">${x.row_count==null?'-':Number(x.row_count).toLocaleString('zh-CN')}</td><td class="revision">${esc((x.revision||'-').slice(0,8))}</td><td>${x.error?`<span class="error-text" title="${esc(x.error)}">${esc(x.error)}</span>`:'<span class="muted">无</span>'}</td></tr>`).join('')||'<tr><td class="empty" colspan="7">暂无数据集</td></tr>';
    const now=Date.now();
    jobs.innerHTML=s.jobs.map(x=>`<tr><td class="task-name">${esc(TASK[x.task]||x.task)}<small>${esc(x.task)}</small></td><td class="source">${esc(SOURCE[x.source]||x.source||'-')}</td><td>${badge(x.state)}</td><td class="phase">${esc(PHASE[x.phase]||x.phase||'-')}</td><td>${time(x.started_at)}</td><td class="number">${duration(x,now)}</td><td>${x.error?`<span class="error-text" title="${esc(x.error)}">${esc(x.error)}</span>`:'<span class="muted">无</span>'}</td></tr>`).join('')||'<tr><td class="empty" colspan="7">暂无任务</td></tr>';
    next.textContent=`下次商品利润：${time(s.next_profit_analysis)} · 店铺商品：${time(s.next_shop_products)} · 未发货：${time(s.next_unshipped_orders)} · SPU：${time(s.next_spu_live)} · 完整库存：${time(s.next_hourly)}`;
    quiet=Boolean(s.quiet_hours);
    serviceLabel.textContent=quiet?`静默时段，${time(s.next_allowed_at)} 恢复`:'同步服务运行中';
    serviceState.classList.toggle('quiet',quiet);
    updated.textContent=`更新于 ${new Date().toLocaleTimeString('zh-CN',{hour12:false})}`;
  }catch(error){notice.className='show error';notice.textContent=error.message}
}
document.querySelectorAll('button').forEach(button=>button.onclick=async()=>{
  const buttons=[...document.querySelectorAll('button')];buttons.forEach(x=>x.disabled=true);
  notice.className='show';notice.textContent='正在提交任务...';
  try{
    const path=button.dataset.a==='retry'?'retry':'sync/'+button.dataset.a;
    const response=await fetch('/api/'+path,{method:'POST',headers:{'X-CSRF-Token':csrf()}});
    const result=await response.json();if(!response.ok)throw Error(result.error||'提交失败');
    const messages={queued:'任务已加入队列',deferred:'静默时段，任务已延后至 09:30',deduplicated:'已有相同任务在队列中',coalesced:'任务已合并到待执行队列',nothing_to_retry:'目前没有失败任务'};
    notice.className='show';notice.textContent=messages[result.result]||'任务已提交';await refresh();
  }catch(error){notice.className='show error';notice.textContent=error.message}
  finally{buttons.forEach(x=>x.disabled=false)}
});
refresh();setInterval(refresh,5000);
</script>
</body>
</html>'''

def main(argv=None):
    init(); p=argparse.ArgumentParser(); sub=p.add_subparsers(dest="cmd",required=True)
    e=sub.add_parser("enqueue"); e.add_argument("task",choices=sorted(TASKS)); e.add_argument("--source",choices=["manual","auto"],default="manual"); e.add_argument("--scheduled-at")
    for name in ("agent-lease",): q=sub.add_parser(name); q.add_argument("--agent",required=True)
    q=sub.add_parser("agent-heartbeat"); q.add_argument("--job",required=True); q.add_argument("--agent",required=True); q.add_argument("--phase",required=True)
    q=sub.add_parser("agent-upload-ready"); q.add_argument("--job",required=True); q.add_argument("--agent",required=True); q.add_argument("--dataset",required=True); q.add_argument("--data",required=True); q.add_argument("--sha",required=True)
    q=sub.add_parser("agent-apply"); q.add_argument("--job",required=True); q.add_argument("--agent",required=True); q.add_argument("--dataset",required=True)
    q=sub.add_parser("agent-complete"); q.add_argument("--job",required=True); q.add_argument("--agent",required=True)
    q=sub.add_parser("agent-fail"); q.add_argument("--job",required=True); q.add_argument("--agent",required=True); q.add_argument("--error",required=True)
    sub.add_parser("list"); sh=sub.add_parser("show"); sh.add_argument("job"); rt=sub.add_parser("retry"); rt.add_argument("job"); ca=sub.add_parser("cancel"); ca.add_argument("job"); st=sub.add_parser("status"); st.add_argument("--json",action="store_true"); sv=sub.add_parser("serve"); sv.add_argument("--host",default="127.0.0.1"); sv.add_argument("--port",type=int,default=8765)
    a=p.parse_args(argv)
    try:
        if a.cmd=="enqueue": result=enqueue(a.task,a.source,a.scheduled_at)
        elif a.cmd=="agent-lease": result=lease(a.agent)
        elif a.cmd=="agent-heartbeat": result=heartbeat(a.job,a.agent,a.phase)
        elif a.cmd=="agent-upload-ready": result=upload_ready(a.job,a.agent,a.dataset,a.data,a.sha)
        elif a.cmd=="agent-apply": result=apply(a.job,a.agent,a.dataset)
        elif a.cmd=="agent-complete": result=complete(a.job,a.agent)
        elif a.cmd=="agent-fail": result=fail(a.job,a.agent,a.error)
        elif a.cmd=="status": result=status()
        elif a.cmd=="list": result=status()["jobs"]
        elif a.cmd=="show":
            valid_uuid(a.job)
            with conn() as db: result={"job":dict(db.execute("SELECT * FROM jobs WHERE id=?",(a.job,)).fetchone() or {}),"datasets":[dict(r) for r in db.execute("SELECT * FROM job_datasets WHERE job_id=?",(a.job,))]}
        elif a.cmd=="retry":
            valid_uuid(a.job)
            with conn() as db: row=db.execute("SELECT task FROM jobs WHERE id=? AND state='failed'",(a.job,)).fetchone()
            if not row: raise ValueError("job is not failed")
            result=enqueue(row["task"],"manual")
        elif a.cmd=="cancel":
            valid_uuid(a.job)
            with conn() as db:
                if not db.execute("UPDATE jobs SET state='cancelled',error=NULL,completed_at=?,updated_at=? WHERE id=? AND state='queued'",(now(),now(),a.job)).rowcount: raise ValueError("only queued jobs can be cancelled")
            result={"cancelled":True}
        elif a.cmd=="serve": ThreadingHTTPServer((a.host,a.port),Handler).serve_forever(); return
        print(json.dumps({"ok":True,"data":result},ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"ok":False,"error":{"code":type(e).__name__,"message":str(e)[:200]}},ensure_ascii=False)); raise SystemExit(1)
if __name__=="__main__": main()
