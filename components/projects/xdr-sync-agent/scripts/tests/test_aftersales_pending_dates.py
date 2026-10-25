import datetime
import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    'aftersales_pending_dates', Path(__file__).resolve().parents[1] / 'aftersales-pending-dates.py'
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PendingDatesTests(unittest.TestCase):
    today = datetime.date(2026, 10, 17)

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.database = Path(self.directory.name) / 'test.sqlite'

    def records(self, records):
        with sqlite3.connect(self.database) as conn:
            conn.execute('CREATE TABLE sync_info(date TEXT, completed_at TEXT)')
            conn.executemany('INSERT INTO sync_info VALUES (?, ?)', records)

    def test_first_run_only_fetches_yesterday(self):
        self.assertEqual(module.pending_dates(self.database, self.today), ['2026-10-16'])

    def test_normal_run_refreshes_yesterday(self):
        self.records([('2026-10-16', '2026-10-17T01:00:00Z')])
        self.assertEqual(module.pending_dates(self.database, self.today), ['2026-10-16'])

    def test_missed_days_caught_up_oldest_first(self):
        self.records([('2026-10-13', '2026-10-14T01:00:00Z')])
        self.assertEqual(module.pending_dates(self.database, self.today),
                         ['2026-10-14', '2026-10-15', '2026-10-16'])

    def test_large_gap_keeps_work_bounded_without_skipping_oldest(self):
        self.records([('2026-10-01', '2026-10-02T01:00:00Z')])
        dates = module.pending_dates(self.database, self.today)
        self.assertEqual(len(dates), 7)
        self.assertEqual((dates[0], dates[-1]), ('2026-10-02', '2026-10-08'))

    def test_failed_record_does_not_skip_a_date(self):
        self.records([('2026-10-14', '2026-10-15T01:00:00Z'), ('2026-10-16', None)])
        self.assertEqual(module.pending_dates(self.database, self.today), ['2026-10-15', '2026-10-16'])


if __name__ == '__main__':
    unittest.main()
