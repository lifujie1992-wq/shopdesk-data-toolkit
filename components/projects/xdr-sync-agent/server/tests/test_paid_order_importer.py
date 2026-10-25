import hashlib
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape


ROOT = Path(__file__).parents[2]
IMPORTER = ROOT / "scripts" / "import-paid-order-exports.py"
HEADERS = ("付款日期", "平台", "店铺名称", "商品编码", "款式编码", "销售件数", "店铺编号")


def _column(index):
    result = ""
    while index:
        index, remainder = divmod(index - 1, 26)
        result = chr(65 + remainder) + result
    return result


def write_xlsx(path, rows):
    values = [HEADERS, *rows]
    xml_rows = []
    for row_number, row in enumerate(values, start=1):
        cells = []
        for column_number, value in enumerate(row, start=1):
            reference = f"{_column(column_number)}{row_number}"
            cells.append(
                f'<c r="{reference}" t="inlineStr"><is><t>{escape(str(value))}</t></is></c>')
        xml_rows.append(f'<row r="{row_number}">{"".join(cells)}</row>')
    sheet = ("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
             '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
             f'<sheetData>{"".join(xml_rows)}</sheetData></worksheet>')
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", """<?xml version="1.0" encoding="UTF-8"?>
          <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
            <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
            <Default Extension="xml" ContentType="application/xml"/>
            <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
            <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
          </Types>""")
        archive.writestr("_rels/.rels", """<?xml version="1.0" encoding="UTF-8"?>
          <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
            <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
          </Relationships>""")
        archive.writestr("xl/workbook.xml", """<?xml version="1.0" encoding="UTF-8"?>
          <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
                    xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
            <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
          </workbook>""")
        archive.writestr("xl/_rels/workbook.xml.rels", """<?xml version="1.0" encoding="UTF-8"?>
          <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
            <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
          </Relationships>""")
        archive.writestr("xl/worksheets/sheet1.xml", sheet)


def run_importer(*arguments, succeeds=True):
    completed = subprocess.run(
        [sys.executable, str(IMPORTER), *map(str, arguments)],
        cwd=ROOT, text=True, capture_output=True,
    )
    if succeeds and completed.returncode:
        raise AssertionError(completed.stderr)
    if not succeeds and not completed.returncode:
        raise AssertionError("import unexpectedly succeeded")
    return completed


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class PaidOrderImporterTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        self.initial = self.directory / "initial"
        self.initial.mkdir()
        self.base_export = self.initial / "orders_2026-09-07~2026-09-08_batch-a_1.xlsx"
        write_xlsx(self.base_export, (
            ("2026-09-07 10:00:00", "抖音", "一店", "sku-7", "spu", "7", "shop"),
            ("2026-09-08 10:00:00", "抖音", "一店", "sku-8", "spu", "8", "shop"),
        ))
        self.database = self.directory / "paid.sqlite"
        run_importer(
            "--xlsx-dir", self.initial, "--business-date", "2026-09-09",
            "--start-date", "2026-09-07", "--end-date", "2026-09-08",
            "--output", self.database,
        )

    def tearDown(self):
        self.temporary.cleanup()

    def _batch_id(self):
        with sqlite3.connect(self.database) as connection:
            return connection.execute("SELECT batch_id FROM export_batches").fetchone()[0]

    def test_full_cli_still_builds_a_complete_ods(self):
        with sqlite3.connect(self.database) as connection:
            batch = connection.execute(
                "SELECT start_date,end_date,complete FROM export_batches").fetchone()
            coverage = connection.execute(
                "SELECT biz_date FROM export_coverage ORDER BY biz_date").fetchall()
            count = connection.execute("SELECT count(*) FROM paid_order_items_raw").fetchone()[0]
            index = connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type='index' "
                "AND name='paid_order_items_raw_batch_day'").fetchone()
        self.assertEqual(batch, ("2026-09-07", "2026-09-08", 1))
        self.assertEqual(coverage, [("2026-09-07",), ("2026-09-08",)])
        self.assertEqual(count, 2)
        self.assertIsNotNone(index)

    def test_incremental_replace_preserves_batch_and_untouched_row_identity(self):
        batch_id = self._batch_id()
        with sqlite3.connect(self.database) as connection:
            untouched_before = connection.execute(
                "SELECT batch_id,shard_id,row_number FROM paid_order_items_raw WHERE biz_date='2026-09-07'"
            ).fetchone()
        replacement = self.directory / "orders_2026-09-08~2026-09-08_batch-b_1.xlsx"
        write_xlsx(replacement, (
            ("2026-09-08 12:00:00", "抖音", "一店", "sku-8-new", "spu", "18", "shop"),
        ))
        run_importer(
            "--base", self.database, "--xlsx", replacement,
            "--replace-start-date", "2026-09-08", "--replace-end-date", "2026-09-08",
            "--business-date", "2026-09-09", "--start-date", "2026-09-07",
            "--end-date", "2026-09-08", "--output", self.database,
        )
        with sqlite3.connect(self.database) as connection:
            batch_after = connection.execute("SELECT batch_id FROM export_batches").fetchone()[0]
            untouched_after = connection.execute(
                "SELECT batch_id,shard_id,row_number FROM paid_order_items_raw WHERE biz_date='2026-09-07'"
            ).fetchone()
            replaced = connection.execute(
                "SELECT sku_id,sales_qty FROM paid_order_items_raw WHERE biz_date='2026-09-08'"
            ).fetchall()
            counts = connection.execute(
                "SELECT (SELECT sum(row_count) FROM export_shards),"
                "(SELECT count(*) FROM paid_order_items_raw)").fetchone()
        self.assertEqual(batch_after, batch_id)
        self.assertEqual(untouched_after, untouched_before)
        self.assertEqual(replaced, [("sku-8-new", 18.0)])
        self.assertEqual(counts, (2, 2))

    def test_incremental_rejects_two_export_generations_for_one_day(self):
        first = self.directory / "orders_2026-09-08~2026-09-08_batch-b_1.xlsx"
        second = self.directory / "orders_2026-09-08~2026-09-08_batch-c_1.xlsx"
        write_xlsx(first, (("2026-09-08", "抖音", "一店", "one", "spu", "1", "shop"),))
        write_xlsx(second, (("2026-09-08", "抖音", "一店", "two", "spu", "2", "shop"),))
        completed = run_importer(
            "--base", self.database, "--xlsx", first, "--xlsx", second,
            "--replace-start-date", "2026-09-08", "--replace-end-date", "2026-09-08",
            "--business-date", "2026-09-09", "--start-date", "2026-09-07",
            "--end-date", "2026-09-08", "--output", self.database, succeeds=False,
        )
        self.assertIn("ambiguous export coverage", completed.stderr)

    def test_parse_failure_after_copy_does_not_replace_base(self):
        before = digest(self.database)
        invalid = self.directory / "orders_2026-09-08~2026-09-08_batch-invalid_1.xlsx"
        write_xlsx(invalid, (
            ("2026-09-08", "抖音", "一店", "bad", "spu", "not-a-number", "shop"),
        ))
        completed = run_importer(
            "--base", self.database, "--xlsx", invalid,
            "--replace-start-date", "2026-09-08", "--replace-end-date", "2026-09-08",
            "--business-date", "2026-09-09", "--start-date", "2026-09-07",
            "--end-date", "2026-09-08", "--output", self.database, succeeds=False,
        )
        self.assertIn("invalid sales quantity", completed.stderr)
        self.assertEqual(digest(self.database), before)

    def test_incremental_window_drops_only_expired_dates(self):
        batch_id = self._batch_id()
        replacement = self.directory / "orders_2026-09-09~2026-09-09_batch-d_1.xlsx"
        write_xlsx(replacement, (
            ("2026-09-09 09:00:00", "拼多多", "二店", "sku-9", "spu", "9", "shop-2"),
        ))
        run_importer(
            "--base", self.database, "--xlsx", replacement,
            "--replace-start-date", "2026-09-09", "--replace-end-date", "2026-09-09",
            "--business-date", "2026-09-10", "--start-date", "2026-09-08",
            "--end-date", "2026-09-09", "--output", self.database,
        )
        with sqlite3.connect(self.database) as connection:
            batch = connection.execute(
                "SELECT batch_id,business_date,start_date,end_date FROM export_batches").fetchone()
            days = connection.execute(
                "SELECT biz_date FROM export_coverage ORDER BY biz_date").fetchall()
            skus = connection.execute(
                "SELECT sku_id FROM paid_order_items_raw ORDER BY biz_date").fetchall()
        self.assertEqual(batch, (batch_id, "2026-09-10", "2026-09-08", "2026-09-09"))
        self.assertEqual(days, [("2026-09-08",), ("2026-09-09",)])
        self.assertEqual(skus, [("sku-8",), ("sku-9",)])


if __name__ == "__main__":
    unittest.main()
