from __future__ import annotations

import csv
import fcntl
import json
import random
import sqlite3
import uuid
from contextlib import contextmanager
from pathlib import Path

from .model import CaptureError, DATASET, adapter_hash, atomic_json, digest, dump, now, validate_row

FIELDS = ('shop_id','shop_name','platform','platform_item_id','platform_link_id','internal_item_code',
          'item_name','commission_rate','commission_enabled','commission_type','extra_rate','link_status',
          'captured_at','source','platform_shop_id','promotion_id','ad_commission_rate','rate_captured_at',
          'carried_from_batch','notes','raw_json')
SCHEMA = '''
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS batch_runs(
 batch_id TEXT PRIMARY KEY, dataset TEXT NOT NULL DEFAULT 'commission_rates',
 schema_version INTEGER NOT NULL DEFAULT 1, started_at TEXT NOT NULL, completed_at TEXT,
 captured_at TEXT NOT NULL, source TEXT NOT NULL, source_range TEXT NOT NULL,
 complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN(0,1)), records INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL, expected_links INTEGER NOT NULL, config_json TEXT NOT NULL,
 targets_hash TEXT NOT NULL, config_hash TEXT NOT NULL, coverage REAL NOT NULL DEFAULT 0,
 acceptance_reference TEXT, adapter_hash TEXT NOT NULL DEFAULT 'legacy');
CREATE TABLE IF NOT EXISTS batch_targets(
 batch_id TEXT NOT NULL REFERENCES batch_runs(batch_id), shop_id TEXT NOT NULL,
 platform TEXT NOT NULL, platform_link_id TEXT NOT NULL, internal_item_code TEXT,
 PRIMARY KEY(batch_id,shop_id,platform,platform_link_id));
CREATE TABLE IF NOT EXISTS commission_rates(
 batch_id TEXT NOT NULL REFERENCES batch_runs(batch_id),
 shop_id TEXT NOT NULL, shop_name TEXT, platform TEXT NOT NULL,
 platform_item_id TEXT NOT NULL, platform_link_id TEXT NOT NULL, internal_item_code TEXT,
 item_name TEXT, commission_rate REAL CHECK(commission_rate BETWEEN 0 AND 1),
 commission_enabled INTEGER NOT NULL CHECK(commission_enabled IN(0,1)),
 commission_type TEXT, extra_rate REAL CHECK(extra_rate BETWEEN 0 AND 1), link_status TEXT,
 captured_at TEXT NOT NULL, source TEXT NOT NULL, platform_shop_id TEXT NOT NULL,
 promotion_id TEXT, ad_commission_rate REAL CHECK(ad_commission_rate BETWEEN 0 AND 1),
 rate_captured_at TEXT NOT NULL, carried_from_batch TEXT, notes TEXT, raw_json TEXT NOT NULL,
 CHECK(commission_enabled<>0 OR commission_rate IS NULL OR commission_rate=0),
 CHECK(commission_enabled<>1 OR commission_rate IS NOT NULL),
 PRIMARY KEY(batch_id,shop_id,platform,platform_link_id));
CREATE INDEX IF NOT EXISTS ix_rates_history ON commission_rates(shop_id,platform,platform_link_id,captured_at);
CREATE TABLE IF NOT EXISTS commission_overrides(
 batch_id TEXT NOT NULL, shop_id TEXT NOT NULL, platform TEXT NOT NULL, platform_link_id TEXT NOT NULL,
 strategy_id TEXT NOT NULL, creator_id TEXT NOT NULL DEFAULT '', commission_type TEXT NOT NULL,
 commission_rate REAL NOT NULL CHECK(commission_rate BETWEEN 0 AND 1),
 extra_rate REAL CHECK(extra_rate BETWEEN 0 AND 1), ad_commission_rate REAL,
 source TEXT NOT NULL, raw_json TEXT NOT NULL,
 PRIMARY KEY(batch_id,shop_id,platform,platform_link_id,strategy_id,creator_id),
 FOREIGN KEY(batch_id,shop_id,platform,platform_link_id)
 REFERENCES commission_rates(batch_id,shop_id,platform,platform_link_id));
CREATE TABLE IF NOT EXISTS capture_tasks(
 batch_id TEXT NOT NULL REFERENCES batch_runs(batch_id), shop_id TEXT NOT NULL, task_id INTEGER NOT NULL,
 link_ids_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
 error TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(batch_id,shop_id,task_id));
CREATE TABLE IF NOT EXISTS capture_issues(
 batch_id TEXT NOT NULL, shop_id TEXT NOT NULL, platform_link_id TEXT NOT NULL,
 reason TEXT NOT NULL, observed_at TEXT NOT NULL,
 PRIMARY KEY(batch_id,shop_id,platform_link_id));
CREATE TABLE IF NOT EXISTS sample_checks(
 batch_id TEXT NOT NULL, shop_id TEXT NOT NULL, platform TEXT NOT NULL, platform_link_id TEXT NOT NULL,
 expected_rate REAL, expected_enabled INTEGER NOT NULL, observed_rate REAL, observed_enabled INTEGER,
 checked_by TEXT, checked_at TEXT, evidence TEXT, matches INTEGER,
 PRIMARY KEY(batch_id,shop_id,platform,platform_link_id),
 FOREIGN KEY(batch_id,shop_id,platform,platform_link_id)
 REFERENCES commission_rates(batch_id,shop_id,platform,platform_link_id));
CREATE VIEW IF NOT EXISTS commission_rates_latest AS
 SELECT r.* FROM commission_rates r JOIN batch_runs b USING(batch_id)
 WHERE b.complete=1 AND NOT EXISTS(
 SELECT 1 FROM commission_rates n JOIN batch_runs bn ON bn.batch_id=n.batch_id
 WHERE bn.complete=1 AND n.shop_id=r.shop_id AND n.platform=r.platform
 AND n.platform_link_id=r.platform_link_id
 AND (bn.started_at>b.started_at OR (bn.started_at=b.started_at AND bn.batch_id>b.batch_id)));
CREATE TABLE IF NOT EXISTS publication_releases(
 batch_id TEXT NOT NULL REFERENCES batch_runs(batch_id),
 release_mode TEXT NOT NULL CHECK(release_mode IN ('accepted','partial')),
 released_at TEXT NOT NULL, reason TEXT NOT NULL,
 PRIMARY KEY(batch_id,release_mode));
CREATE VIEW IF NOT EXISTS commission_rates_available_latest AS
 SELECT r.*,b.complete AS batch_complete,b.status AS batch_status
 FROM commission_rates r JOIN batch_runs b USING(batch_id)
 WHERE (b.complete=1 OR EXISTS(SELECT 1 FROM publication_releases p
  WHERE p.batch_id=b.batch_id AND p.release_mode='partial'))
 AND NOT EXISTS(
  SELECT 1 FROM commission_rates n JOIN batch_runs bn ON bn.batch_id=n.batch_id
  WHERE (bn.complete=1 OR EXISTS(SELECT 1 FROM publication_releases p
   WHERE p.batch_id=bn.batch_id AND p.release_mode='partial'))
  AND n.shop_id=r.shop_id AND n.platform=r.platform AND n.platform_link_id=r.platform_link_id
  AND (bn.started_at>b.started_at OR (bn.started_at=b.started_at AND bn.batch_id>b.batch_id)));
'''


@contextmanager
def lock(path):
    path = Path(str(path) + '.lock')
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise CaptureError('another collector/publication is running') from None
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.path, timeout=30)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        columns={r[1] for r in self.db.execute('PRAGMA table_info(batch_runs)')}
        if 'acceptance_reference' not in columns:
            self.db.execute('ALTER TABLE batch_runs ADD COLUMN acceptance_reference TEXT')
        if 'adapter_hash' not in columns:
            self.db.execute("ALTER TABLE batch_runs ADD COLUMN adapter_hash TEXT NOT NULL DEFAULT 'legacy'")
        self.db.execute('PRAGMA busy_timeout=30000')
        self.path.chmod(0o600)

    def close(self):
        self.db.close()

    def batch(self, batch):
        row = self.db.execute('SELECT * FROM batch_runs WHERE batch_id=?', (batch,)).fetchone()
        if not row:
            raise CaptureError('unknown batch_id')
        return dict(row)

    def new_batch(self, targets, config, source, expected_links):
        if not targets or expected_links <= 0:
            raise CaptureError('nonempty target universe and positive expected_links required')
        batch = str(uuid.uuid4())
        stamp = now()
        target_keys = [(x['shop_id'], x['platform'], x['platform_link_id'], x.get('internal_item_code')) for x in targets]
        with self.db:
            self.db.execute('''INSERT INTO batch_runs(batch_id,started_at,captured_at,source,source_range,
             status,expected_links,config_json,targets_hash,config_hash,adapter_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?)''',
             (batch,stamp,stamp,source,dump({'target_pairs':len(targets),'shops':len({x['shop_id'] for x in targets})}),
              'running',expected_links,dump(config),digest(sorted(target_keys)),digest(config),adapter_hash()))
            self.db.executemany('INSERT INTO batch_targets VALUES(?,?,?,?,?)', [(batch,*x) for x in target_keys])
            for shop_id in sorted({x['shop_id'] for x in targets}):
                ids = sorted(x['platform_link_id'] for x in targets if x['shop_id']==shop_id)
                self.db.executemany('''INSERT INTO capture_tasks(batch_id,shop_id,task_id,link_ids_json,updated_at)
                 VALUES(?,?,?,?,?)''', [(batch,shop_id,i//50,dump(ids[i:i+50]),stamp) for i in range(0,len(ids),50)])
        return batch

    def previous(self, batch, shop, link):
        row = self.db.execute('''SELECT r.* FROM commission_rates r JOIN batch_runs b USING(batch_id)
          WHERE r.batch_id<>? AND r.shop_id=? AND r.platform='抖音' AND r.platform_link_id=?
          AND r.carried_from_batch IS NULL ORDER BY b.started_at DESC,b.batch_id DESC LIMIT 1''',
          (batch,shop,link)).fetchone()
        return dict(row) if row else None

    def save_task(self, batch, task, rows, overrides, issues):
        if self.batch(batch)['complete']:
            raise CaptureError('accepted batch is immutable')
        # Page results, quality failures and checkpoint commit in the same transaction.
        with self.db:
            for row in rows:
                validate_row(row)
                self.db.execute(f'''INSERT INTO commission_rates(batch_id,{','.join(FIELDS)})
                 VALUES({','.join('?' for _ in range(len(FIELDS)+1))})''',
                 (batch,*(row.get(k) for k in FIELDS)))
            for link, override in overrides:
                keys = ('strategy_id','creator_id','commission_type','commission_rate','extra_rate','ad_commission_rate','source','raw_json')
                self.db.execute('INSERT INTO commission_overrides VALUES('+','.join('?' for _ in range(12))+')',
                                (batch,task['shop_id'],'抖音',link,*(override.get(k) for k in keys)))
            for link, reason in issues:
                self.db.execute('INSERT OR REPLACE INTO capture_issues VALUES(?,?,?,?,?)',
                                (batch,task['shop_id'],link,reason,now()))
            self.db.execute('''UPDATE capture_tasks SET status='done',attempts=attempts+1,error=NULL,updated_at=?
             WHERE batch_id=? AND shop_id=? AND task_id=?''', (now(),batch,task['shop_id'],task['task_id']))

    def failed_task(self, batch, task, message):
        with self.db:
            self.db.execute('''UPDATE capture_tasks SET status='failed',attempts=attempts+1,error=?,updated_at=?
             WHERE batch_id=? AND shop_id=? AND task_id=?''', (message,now(),batch,task['shop_id'],task['task_id']))

    def report(self, batch):
        b = self.batch(batch)
        shops = []
        for row in self.db.execute('''SELECT t.shop_id,count(*) targets,count(r.platform_link_id) found,
         sum(CASE WHEN r.carried_from_batch IS NOT NULL THEN 1 ELSE 0 END) carried
         FROM batch_targets t LEFT JOIN commission_rates r
         USING(batch_id,shop_id,platform,platform_link_id) WHERE t.batch_id=? GROUP BY t.shop_id''', (batch,)):
            shops.append({**dict(row),'coverage':row['found']/row['targets']})
        targets = sum(r['targets'] for r in shops)
        found = sum(r['found'] for r in shops)
        links = self.db.execute('SELECT count(DISTINCT platform_link_id) FROM batch_targets WHERE batch_id=?',(batch,)).fetchone()[0]
        pending = self.db.execute("SELECT count(*) FROM capture_tasks WHERE batch_id=? AND status<>'done'",(batch,)).fetchone()[0]
        sampled, passed = self.db.execute('''SELECT count(*),coalesce(sum(matches=1),0)
         FROM sample_checks WHERE batch_id=?''',(batch,)).fetchone()
        coverage = found/targets if targets else 0
        reference_valid=False
        if b['acceptance_reference']:
            ref=self.batch(b['acceptance_reference'])
            ref_samples,ref_passed=self.db.execute('''SELECT count(*),coalesce(sum(matches=1),0)
             FROM sample_checks WHERE batch_id=?''',(ref['batch_id'],)).fetchone()
            reference_valid=(bool(ref['complete']) and ref_samples>=10 and ref_samples==ref_passed
                             and ref['config_hash']==b['config_hash'] and ref['adapter_hash']==b['adapter_hash'])
        sample_gate=(sampled>=10 and sampled==passed) or (sampled==0 and reference_valid)
        ready = targets > 0 and links >= b['expected_links'] and coverage >= .98 and pending == 0 and sample_gate
        return dict(batch_id=batch,status=b['status'],complete=bool(b['complete']),targets=targets,unique_links=links,
                    expected_links=b['expected_links'],found=found,coverage=coverage,pending_tasks=pending,
                    samples=sampled,samples_passed=passed,acceptance_reference=b['acceptance_reference'],
                    reference_valid=reference_valid,ready_to_accept=ready,shops=shops)

    def finish_collection(self, batch):
        r = self.report(batch)
        with self.db:
            self.db.execute('UPDATE batch_runs SET status=?,records=?,coverage=? WHERE batch_id=? AND complete=0',
                            ('needs_review' if r['pending_tasks']==0 else 'partial',r['found'],r['coverage'],batch))
        return self.report(batch)

    def sample(self, batch, path, seed=20261018):
        # Existing sample is stable across retries; never regenerate failed checks to get a pass.
        if not self.db.execute('SELECT 1 FROM sample_checks WHERE batch_id=?',(batch,)).fetchone():
            if self.batch(batch)['complete']:
                raise CaptureError('accepted batch is immutable; cannot create a new sample')
            keys = self.db.execute('''SELECT shop_id,platform,platform_link_id,commission_rate,commission_enabled
             FROM commission_rates WHERE batch_id=? ORDER BY shop_id,platform_link_id''',(batch,)).fetchall()
            if len(keys) < 10:
                raise CaptureError('need at least 10 captured links to sample')
            with self.db:
                self.db.executemany('''INSERT INTO sample_checks(batch_id,shop_id,platform,platform_link_id,
                 expected_rate,expected_enabled) VALUES(?,?,?,?,?,?)''', [(batch,*r) for r in random.Random(seed).sample(keys,10)])
        rows = [dict(r) for r in self.db.execute('SELECT * FROM sample_checks WHERE batch_id=?',(batch,))]
        # CSV text IDs must be imported as text when opening in spreadsheet applications.
        with Path(path).open('w',encoding='utf-8-sig',newline='') as out:
            writer = csv.DictWriter(out,fieldnames=list(rows[0]))
            writer.writeheader(); writer.writerows(rows)
        return rows

    def import_checks(self, batch, path):
        if self.batch(batch)['complete']:
            raise CaptureError('accepted batch is immutable')
        with Path(path).open(encoding='utf-8-sig',newline='') as inp:
            rows = list(csv.DictReader(inp))
        with self.db:
            for r in rows:
                key=(batch,r['shop_id'],r['platform'],r['platform_link_id'])
                old=self.db.execute('''SELECT * FROM sample_checks WHERE batch_id=? AND shop_id=?
                 AND platform=? AND platform_link_id=?''',key).fetchone()
                if r['batch_id']!=batch or old is None:
                    raise CaptureError('sample is not part of this frozen batch')
                if not r['checked_by'].strip() or not r['checked_at'] or not r['evidence'].strip():
                    raise CaptureError('manual reviewer, checked_at and evidence required')
                from datetime import datetime
                if datetime.fromisoformat(r['checked_at']).utcoffset() is None:
                    raise CaptureError('checked_at requires timezone')
                enabled=int(r['observed_enabled'])
                if enabled not in (0,1): raise CaptureError('observed_enabled must be 0/1')
                value=float(r['observed_rate']) if r['observed_rate'] else None
                import math
                if value is not None and (not math.isfinite(value) or not 0<=value<=1):
                    raise CaptureError('observed_rate must be decimal 0..1')
                matches=int(enabled==old['expected_enabled'] and value==old['expected_rate'])
                self.db.execute('''UPDATE sample_checks SET observed_rate=?,observed_enabled=?,checked_by=?,
                 checked_at=?,evidence=?,matches=? WHERE batch_id=? AND shop_id=? AND platform=? AND platform_link_id=?''',
                 (value,enabled,r['checked_by'],r['checked_at'],r['evidence'],matches,*key))

    def accept(self, batch, reference=None):
        if self.batch(batch)['complete']: return self.report(batch)
        with self.db:
            if reference:
                self.db.execute('UPDATE batch_runs SET acceptance_reference=? WHERE batch_id=?',(reference,batch))
            report=self.report(batch)
            if not report['ready_to_accept']:
                raise CaptureError('coverage/universe/tasks/manual sample acceptance gates not met')
            self.db.execute("UPDATE batch_runs SET complete=1,status='accepted',completed_at=? WHERE batch_id=?",
                            (now(),batch))
        return self.report(batch)

    def write_report(self, batch, directory):
        directory=Path(directory);directory.mkdir(parents=True,exist_ok=True)
        atomic_json(directory/'coverage.json',self.report(batch))
        with (directory/'missing-links.csv').open('w',encoding='utf-8-sig',newline='') as out:
            writer=csv.writer(out);writer.writerow(['shop_id','platform_link_id','reason'])
            writer.writerows(self.db.execute('''SELECT t.shop_id,t.platform_link_id,coalesce(i.reason,'not_collected')
             FROM batch_targets t LEFT JOIN commission_rates r USING(batch_id,shop_id,platform,platform_link_id)
             LEFT JOIN capture_issues i ON i.batch_id=t.batch_id AND i.shop_id=t.shop_id AND i.platform_link_id=t.platform_link_id
             WHERE t.batch_id=? AND r.platform_link_id IS NULL ORDER BY t.shop_id,t.platform_link_id''',(batch,)))
