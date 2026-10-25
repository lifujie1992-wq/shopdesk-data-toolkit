import importlib.util
from importlib.machinery import SourceFileLoader
import os
import sqlite3
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location('night_server', os.environ.get('NIGHT_SERVER', str(HERE / 'xdr_sync_server.py')), loader=SourceFileLoader('night_server', os.environ.get('NIGHT_SERVER', str(HERE / 'xdr_sync_server.py'))))
x = importlib.util.module_from_spec(spec)
spec.loader.exec_module(x)

class NightTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        x.BASE = root
        x.CONTROL = root / 'state/control.sqlite'
        x.DATA = root / 'data'
        x.INCOMING = root / 'incoming'
        x.FAILED = root / 'failed'
        x.now = lambda: '2026-10-20T17:00:00+00:00'
        x.shanghai_now = lambda: datetime.fromisoformat('2026-10-21T01:00:00+08:00')
        x.init()

    def test_next_run_is_one_am_shanghai(self):
        self.assertEqual(x.next_shop_products(datetime.fromisoformat('2026-10-21T00:30:00+08:00')).isoformat(), '2026-10-21T01:00:00+08:00')
        self.assertEqual(x.next_shop_products(x.shanghai_now()).isoformat(), '2026-10-22T01:00:00+08:00')

    def test_automatic_shop_export_can_be_queued_and_leased_at_night(self):
        job = x.enqueue('sync_shop_products', 'auto')
        self.assertEqual(job['result'], 'queued')
        self.assertEqual(job['scheduled_at'], x.now())
        self.assertEqual(x.lease('night-test')['job']['id'], job['job_id'])

    def test_other_automatic_tasks_stay_deferred(self):
        job = x.enqueue('sync_inventory', 'auto')
        self.assertEqual(job['result'], 'deferred')
        self.assertEqual(job['scheduled_at'], '2026-10-21T01:30:00+00:00')
        self.assertIsNone(x.lease('night-test')['job'])

    def test_waiting_daytime_job_does_not_block_night_export(self):
        earlier = x.enqueue('sync_inventory', 'auto')
        with x.conn() as db:
            db.execute('UPDATE jobs SET scheduled_at=? WHERE id=?', ('2026-10-20T14:00:00+00:00', earlier['job_id']))
        job = x.enqueue('sync_shop_products', 'auto')
        with x.conn() as db:
            db.execute('UPDATE jobs SET scheduled_at=? WHERE id=?', (x.now(), job['job_id']))
        self.assertEqual(x.lease('night-test')['job']['id'], job['job_id'])
        with x.conn() as db:
            self.assertEqual(db.execute('SELECT state FROM jobs WHERE id=?', (earlier['job_id'],)).fetchone()[0], 'queued')

if __name__ == '__main__':
    unittest.main()
