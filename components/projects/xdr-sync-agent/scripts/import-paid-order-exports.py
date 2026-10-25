#!/usr/bin/env python3
"""Parse JST paid-order Excel shards into an ODS SQLite package without aggregation."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sqlite3
import uuid
import zipfile
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from xml.etree import ElementTree as ET

try:
    import fastexcel
except ImportError:  # Keep a dependency-free compatibility path.
    fastexcel = None

REQUIRED_GROUPS = (("付款日期",), ("平台", "平台站点"), ("店铺名称",), ("商品编码",),
                   ("款式编码", "款号"), ("销售件数", "数量"), ("店铺编号",))
SELECTED_COLUMNS = {
    name for group in REQUIRED_GROUPS for name in group
} | {
    "店铺款式编码", "店铺商品编码", "内部订单号", "线上订单号", "订单号",
    "订单标签", "标签", "达人ID", "达人名称", "销售金额", "商品金额",
    "退款件数", "退款金额", "毛利",
}

ODS_SCHEMA = """
  CREATE TABLE export_batches(batch_id TEXT PRIMARY KEY,business_date TEXT NOT NULL,
    start_date TEXT NOT NULL,end_date TEXT NOT NULL,captured_at TEXT NOT NULL,
    quality TEXT NOT NULL,complete INTEGER NOT NULL,manifest_json TEXT NOT NULL);
  CREATE TABLE export_shards(batch_id TEXT NOT NULL,shard_id TEXT NOT NULL,source_name TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,effective_start TEXT NOT NULL,effective_end TEXT NOT NULL,
    row_count INTEGER NOT NULL,complete INTEGER NOT NULL,PRIMARY KEY(batch_id,shard_id));
  CREATE TABLE export_coverage(batch_id TEXT NOT NULL,biz_date TEXT NOT NULL,shard_id TEXT NOT NULL,
    PRIMARY KEY(batch_id,biz_date));
  CREATE TABLE paid_order_items_raw(batch_id TEXT NOT NULL,shard_id TEXT NOT NULL,row_number INTEGER NOT NULL,
    biz_date TEXT NOT NULL,pay_date TEXT,platform TEXT,shop_id TEXT,shop_name TEXT,spu_id TEXT,sku_id TEXT,
    shop_spu_id TEXT,shop_sku_id TEXT,sales_qty REAL NOT NULL,so_id TEXT,outer_so_id TEXT,o_id TEXT,
    order_labels TEXT,influencer_id TEXT,influencer_name TEXT,sales_amount REAL,refund_qty REAL,
    refund_amount REAL,gross_margin REAL,
    raw_json TEXT NOT NULL,PRIMARY KEY(batch_id,shard_id,row_number));
"""


def cell_value(cell, shared):
    kind = cell.attrib.get("t")
    value = next((node.text for node in cell if node.tag.endswith("}v")), None)
    if kind == "s" and value is not None:
        return shared[int(value)]
    if kind == "inlineStr":
        return "".join(node.text or "" for node in cell.iter() if node.tag.endswith("}t"))
    return value


def xml_excel_rows(path):
    with zipfile.ZipFile(path) as archive:
        shared = []
        if "xl/sharedStrings.xml" in archive.namelist():
            for _, node in ET.iterparse(archive.open("xl/sharedStrings.xml"), events=("end",)):
                if node.tag.endswith("}si"):
                    shared.append("".join(part.text or "" for part in node.iter() if part.tag.endswith("}t")))
                    node.clear()
        header = None
        for _, node in ET.iterparse(archive.open("xl/worksheets/sheet1.xml"), events=("end",)):
            if not node.tag.endswith("}row"):
                continue
            values = {}
            for cell in node:
                if cell.tag.endswith("}c"):
                    column = re.match(r"[A-Z]+", cell.attrib.get("r", ""))
                    if column:
                        values[column.group()] = cell_value(cell, shared)
            node.clear()
            if header is None:
                header = {str(value).strip(): column for column, value in values.items() if value}
                missing = ["/".join(group) for group in REQUIRED_GROUPS
                           if not any(name in header for name in group)]
                if missing:
                    raise ValueError(f"{path.name}: missing columns {missing}")
                continue
            yield {name: values.get(column) for name, column in header.items()}


def excel_rows(path):
    if fastexcel is None:
        yield from xml_excel_rows(path)
        return
    reader = fastexcel.read_excel(path)
    sheet = reader.load_sheet(
        0, header_row=0, use_columns=lambda column: column.name in SELECTED_COLUMNS,
        dtypes="string",
    )
    frame = sheet.to_polars()
    header = set(frame.columns)
    missing = ["/".join(group) for group in REQUIRED_GROUPS if not any(name in header for name in group)]
    if missing:
        raise ValueError(f"{path.name}: missing columns {missing}")
    yield from frame.iter_rows(named=True)


def identifier(value):
    text = str(value or "")
    if "e" not in text.lower() and not re.fullmatch(r"-?\d+\.0+", text):
        return text
    try:
        parsed = Decimal(text)
    except InvalidOperation:
        return text
    return str(int(parsed)) if parsed == parsed.to_integral_value() else text


def day_of(value):
    match = re.match(r"(\d{4}-\d{2}-\d{2})", str(value or ""))
    return date.fromisoformat(match.group(1)) if match else None


def file_range(path):
    dates = re.findall(r"\d{4}-\d{2}-\d{2}", path.name)
    if path.name.startswith("gap-") and dates:
        day = date.fromisoformat(dates[0])
        return day, day
    if len(dates) >= 2:
        return date.fromisoformat(dates[0]), date.fromisoformat(dates[1])
    raise ValueError(f"{path.name}: cannot determine export range")


def pick(row, *names):
    return next((row.get(name) for name in names if row.get(name) not in (None, "")), None)


def numeric(row, *names):
    value = pick(row, *names)
    if value in (None, ""):
        return None
    try:
        return float(Decimal(str(value).replace(",", "")))
    except InvalidOperation as exc:
        raise ValueError(f"invalid numeric value for {'/'.join(names)}: {value}") from exc


def file_sha256(path):
    hasher = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def export_generation(path):
    """Group the numbered shards produced by one JST export request."""
    return re.sub(r"_\d+$", "", path.stem)


def selected_files(args):
    files = []
    if args.xlsx_dir:
        files.extend(sorted(args.xlsx_dir.glob("*.xlsx")))
    files.extend(args.xlsx)
    files.extend(args.today_xlsx)
    unique = []
    seen = set()
    for path in files:
        resolved = path.resolve()
        if resolved in seen:
            raise ValueError(f"duplicate xlsx input: {path}")
        if not path.is_file():
            raise ValueError(f"xlsx input does not exist: {path}")
        seen.add(resolved)
        unique.append(path)
    if not unique:
        raise ValueError("no xlsx exports found")
    return unique


def ownership(files, ranges, start, end, *, strict):
    if start > end:
        raise ValueError("invalid export range")
    if strict:
        groups = {
            path: f"{span[0].isoformat()}..{span[1].isoformat()}:{export_generation(path)}"
            for path, span in ranges.items()
        }
    else:
        groups = {path: f"{span[0].isoformat()}..{span[1].isoformat()}"
                  for path, span in ranges.items()}
    gap_days = {span[0] for path, span in ranges.items() if path.name.startswith("gap-")}
    day_owner = {}
    for offset in range((end - start).days + 1):
        day = start + timedelta(days=offset)
        candidates = [path for path, span in ranges.items() if span[0] <= day <= span[1]]
        if day in gap_days:
            candidates = [path for path in candidates if path.name.startswith("gap-")]
        if not candidates:
            continue
        owner_groups = {groups[path] for path in candidates}
        if len(owner_groups) != 1:
            raise ValueError(f"ambiguous export coverage on {day.isoformat()}")
        day_owner[day] = owner_groups.pop()
    return groups, day_owner


def raw_record(batch_id, shard_id, source_row, biz_day, row):
    sku_id = identifier(pick(row, "商品编码"))
    if not sku_id:
        return None
    try:
        qty = float(pick(row, "销售件数", "数量") or 0)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"invalid sales quantity at row {source_row + 1}") from exc
    return (
        batch_id, shard_id, source_row, biz_day.isoformat(), str(row.get("付款日期") or ""),
        str(pick(row, "平台", "平台站点") or ""), identifier(row.get("店铺编号")),
        str(row.get("店铺名称") or ""), identifier(pick(row, "款式编码", "款号")), sku_id,
        identifier(row.get("店铺款式编码")), identifier(row.get("店铺商品编码")), qty,
        identifier(row.get("内部订单号")), identifier(row.get("线上订单号")),
        identifier(row.get("订单号")), str(pick(row, "订单标签", "标签") or ""),
        identifier(row.get("达人ID")), str(row.get("达人名称") or ""),
        numeric(row, "销售金额", "商品金额"), numeric(row, "退款件数"),
        numeric(row, "退款金额"), numeric(row, "毛利"), "{}")


def import_files(db, batch_id, files, ranges, groups, day_owner, start, end, *, upsert_shards=False):
    total = 0
    manifest = []
    recorded_coverage = set()
    digests = set()
    inserted_shards = set()
    insert_sql = "INSERT INTO paid_order_items_raw VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    for path in files:
        range_start, range_end = ranges[path]
        effective_start, effective_end = max(range_start, start), min(range_end, end)
        if effective_start > effective_end:
            continue
        digest = file_sha256(path)
        if digest in digests:
            raise ValueError(f"duplicate xlsx content: {path.name}")
        digests.add(digest)
        shard_id = digest[:24]
        existing_digest = db.execute(
            "SELECT source_sha256 FROM export_shards WHERE batch_id=? AND shard_id=?",
            (batch_id, shard_id)).fetchone()
        if existing_digest and existing_digest[0] != digest:
            raise ValueError(f"truncated shard hash collision: {path.name}")
        count = 0
        pending = []
        for source_row, row in enumerate(excel_rows(path), start=1):
            biz_day = day_of(row.get("付款日期"))
            if (not biz_day or not effective_start <= biz_day <= effective_end
                    or day_owner.get(biz_day) != groups[path]):
                continue
            try:
                record = raw_record(batch_id, shard_id, source_row, biz_day, row)
            except ValueError as exc:
                raise ValueError(f"{path.name}: {exc}") from exc
            if record is None:
                continue
            pending.append(record)
            count += 1
            if len(pending) >= 5000:
                db.executemany(insert_sql, pending)
                pending.clear()
        if pending:
            db.executemany(insert_sql, pending)
        shard_values = (batch_id, shard_id, path.name, digest, effective_start.isoformat(),
                        effective_end.isoformat(), count)
        if upsert_shards:
            db.execute("""INSERT INTO export_shards VALUES(?,?,?,?,?,?,?,1)
                ON CONFLICT(batch_id,shard_id) DO UPDATE SET
                  source_name=excluded.source_name,source_sha256=excluded.source_sha256,
                  effective_start=min(export_shards.effective_start,excluded.effective_start),
                  effective_end=max(export_shards.effective_end,excluded.effective_end),
                  complete=1""", shard_values)
        else:
            db.execute("INSERT INTO export_shards VALUES(?,?,?,?,?,?,?,1)", shard_values)
        inserted_shards.add(shard_id)
        for offset in range((effective_end - effective_start).days + 1):
            coverage_day = effective_start + timedelta(days=offset)
            if day_owner.get(coverage_day) != groups[path] or coverage_day in recorded_coverage:
                continue
            db.execute("INSERT INTO export_coverage VALUES(?,?,?)",
                       (batch_id, coverage_day.isoformat(), groups[path]))
            recorded_coverage.add(coverage_day)
        total += count
        manifest.append({"file": path.name, "sha256": digest, "rows": count,
                         "effective_start": effective_start.isoformat(),
                         "effective_end": effective_end.isoformat()})
    return total, manifest, recorded_coverage, inserted_shards


def validate_ods(db, batch_id, start, end):
    batches = db.execute("SELECT batch_id,complete FROM export_batches").fetchall()
    if batches != [(batch_id, 1)]:
        raise ValueError("paid orders ODS must contain exactly one complete batch")
    foreign_batches = sum(db.execute(
        f"SELECT count(*) FROM {table} WHERE batch_id<>?", (batch_id,)).fetchone()[0]
        for table in ("export_shards", "export_coverage", "paid_order_items_raw"))
    if foreign_batches:
        raise ValueError("paid orders ODS contains rows from another batch")
    expected = {(start + timedelta(days=i)).isoformat()
                for i in range((end - start).days + 1)}
    coverage = db.execute(
        "SELECT biz_date,count(*) FROM export_coverage WHERE batch_id=? GROUP BY biz_date",
        (batch_id,)).fetchall()
    actual = {row[0] for row in coverage if row[1] == 1}
    if actual != expected or any(row[1] != 1 for row in coverage):
        missing = sorted(expected - actual)
        raise ValueError(f"incomplete export coverage: {missing[:5]}")
    outside = db.execute(
        "SELECT count(*) FROM paid_order_items_raw WHERE batch_id<>? OR biz_date<? OR biz_date>?",
        (batch_id, start.isoformat(), end.isoformat())).fetchone()[0]
    if outside:
        raise ValueError("paid order rows fall outside the complete batch window")
    shard_count, declared_rows = db.execute(
        "SELECT count(*),coalesce(sum(row_count),0) FROM export_shards WHERE batch_id=? AND complete=1",
        (batch_id,)).fetchone()
    raw_count = db.execute(
        "SELECT count(*) FROM paid_order_items_raw WHERE batch_id=?", (batch_id,)).fetchone()[0]
    orphan_rows = db.execute("""SELECT count(*) FROM paid_order_items_raw r
        LEFT JOIN export_shards s ON s.batch_id=r.batch_id AND s.shard_id=r.shard_id
        WHERE r.batch_id=? AND s.shard_id IS NULL""", (batch_id,)).fetchone()[0]
    if not shard_count or declared_rows != raw_count or orphan_rows:
        raise ValueError("paid order shard manifest does not match raw rows")
    return raw_count


def configure_database(db):
    db.execute("PRAGMA journal_mode=OFF")
    db.execute("PRAGMA synchronous=OFF")
    db.execute("PRAGMA temp_store=MEMORY")


def finish_database(db):
    check = db.execute("PRAGMA integrity_check").fetchone()[0]
    if check != "ok":
        raise ValueError("paid order ODS integrity check failed")
    db.commit()


def manifest_from_shards(db, batch_id):
    return [
        {"file": row[0], "sha256": row[1], "rows": row[4],
         "effective_start": row[2], "effective_end": row[3]}
        for row in db.execute("""SELECT source_name,source_sha256,effective_start,effective_end,row_count
            FROM export_shards WHERE batch_id=? AND complete=1
            ORDER BY effective_start,effective_end,source_name,shard_id""", (batch_id,))
    ]


def build_full(args, files, today_files):
    batch_id = str(uuid.uuid4())
    captured_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    start = args.start_date or args.business_date - timedelta(days=30)
    # Historical exports normally end yesterday. Today's changing data can be
    # supplied as an additional same-day export without changing warehouse SQL.
    end = args.end_date or (args.business_date if today_files
                            else args.business_date - timedelta(days=1))
    ranges = {path: ((args.business_date, args.business_date)
                     if path in today_files else file_range(path)) for path in files}
    groups, day_owner = ownership(files, ranges, start, end, strict=False)
    building = args.output.with_name(f".{args.output.name}.{uuid.uuid4()}.building")
    db = None
    try:
        db = sqlite3.connect(building)
        configure_database(db)
        db.executescript(ODS_SCHEMA)
        db.execute("CREATE INDEX paid_order_items_raw_batch_day ON paid_order_items_raw(batch_id,biz_date)")
        total, manifest, coverage, _shards = import_files(
            db, batch_id, files, ranges, groups, day_owner, start, end)
        expected = {start + timedelta(days=i) for i in range((end - start).days + 1)}
        if coverage != expected:
            missing = sorted(day.isoformat() for day in expected - coverage)
            raise ValueError(f"incomplete export coverage: {missing[:5]}")
        for path in today_files:
            found = db.execute(
                "SELECT coalesce(sum(row_count),0) FROM export_shards WHERE batch_id=? AND source_name=?",
                (batch_id, path.name)).fetchone()[0]
            if not found:
                raise ValueError(f"{path.name}: no paid rows for {args.business_date}; today export is not usable")
        db.execute("INSERT INTO export_batches VALUES(?,?,?,?,?,?,1,?)", (
            batch_id, args.business_date.isoformat(), start.isoformat(), end.isoformat(), captured_at,
            "raw_paid_order_exports", json.dumps(manifest, ensure_ascii=False, separators=(",", ":"))))
        raw_count = validate_ods(db, batch_id, start, end)
        finish_database(db)
        db.close()
        db = None
        os.replace(building, args.output)
        return {"batch_id": batch_id, "mode": "full", "files": len(manifest),
                "imported_rows": total, "rows": raw_count, "start_date": start.isoformat(),
                "end_date": end.isoformat(), "output": str(args.output)}
    except Exception:
        if db is not None:
            db.close()
        building.unlink(missing_ok=True)
        raise


def build_incremental(args, files, today_files):
    if args.replace_start_date is None or args.replace_end_date is None:
        raise ValueError("incremental mode requires --replace-start-date and --replace-end-date")
    if args.replace_start_date > args.replace_end_date:
        raise ValueError("replace start date must not exceed replace end date")
    if not args.base.is_file():
        raise ValueError(f"base ODS does not exist: {args.base}")
    replace_start, replace_end = args.replace_start_date, args.replace_end_date
    ranges = {path: ((args.business_date, args.business_date)
                     if path in today_files else file_range(path)) for path in files}
    outside = [path.name for path, span in ranges.items()
               if span[0] < replace_start or span[1] > replace_end]
    if outside:
        raise ValueError(f"incremental inputs extend outside replacement range: {outside[:3]}")
    groups, day_owner = ownership(files, ranges, replace_start, replace_end, strict=True)
    expected_replacement = {replace_start + timedelta(days=i)
                            for i in range((replace_end - replace_start).days + 1)}
    if set(day_owner) != expected_replacement:
        missing = sorted(day.isoformat() for day in expected_replacement - set(day_owner))
        raise ValueError(f"incomplete replacement coverage: {missing[:5]}")

    building = args.output.with_name(f".{args.output.name}.{uuid.uuid4()}.building")
    db = None
    try:
        shutil.copy2(args.base, building)
        db = sqlite3.connect(building)
        configure_database(db)
        batch_rows = db.execute("""SELECT batch_id,business_date,start_date,end_date
            FROM export_batches WHERE complete=1""").fetchall()
        all_batches = db.execute("SELECT count(*) FROM export_batches").fetchone()[0]
        if len(batch_rows) != 1 or all_batches != 1:
            raise ValueError("base ODS must contain exactly one complete batch")
        batch_id, old_business_text, old_start_text, old_end_text = batch_rows[0]
        old_business = date.fromisoformat(old_business_text)
        old_start, old_end = date.fromisoformat(old_start_text), date.fromisoformat(old_end_text)
        validate_ods(db, batch_id, old_start, old_end)
        if args.business_date < old_business:
            raise ValueError("business date cannot move backwards in incremental mode")
        start = args.start_date or args.business_date - timedelta(days=30)
        end = args.end_date or max(old_end, replace_end)
        if start > end or end > args.business_date:
            raise ValueError("invalid incremental ODS window")
        if replace_start < start or replace_end > end:
            raise ValueError("replacement range falls outside the target ODS window")

        db.execute("CREATE INDEX IF NOT EXISTS paid_order_items_raw_batch_day "
                   "ON paid_order_items_raw(batch_id,biz_date)")
        db.execute("UPDATE export_batches SET complete=0 WHERE batch_id=?", (batch_id,))
        replaced_rows_before = db.execute(
            "SELECT count(*) FROM paid_order_items_raw WHERE batch_id=? AND biz_date BETWEEN ? AND ?",
            (batch_id, replace_start.isoformat(), replace_end.isoformat())).fetchone()[0]
        db.execute("DELETE FROM paid_order_items_raw WHERE batch_id=? AND biz_date BETWEEN ? AND ?",
                   (batch_id, replace_start.isoformat(), replace_end.isoformat()))
        db.execute("DELETE FROM export_coverage WHERE batch_id=? AND biz_date BETWEEN ? AND ?",
                   (batch_id, replace_start.isoformat(), replace_end.isoformat()))
        imported, _new_manifest, coverage, inserted_shards = import_files(
            db, batch_id, files, ranges, groups, day_owner, replace_start, replace_end,
            upsert_shards=True)
        if coverage != expected_replacement:
            missing = sorted(day.isoformat() for day in expected_replacement - coverage)
            raise ValueError(f"incomplete replacement coverage: {missing[:5]}")
        for path in today_files:
            found = db.execute(
                "SELECT count(*) FROM paid_order_items_raw WHERE batch_id=? AND biz_date=? AND shard_id=?",
                (batch_id, args.business_date.isoformat(), file_sha256(path)[:24])).fetchone()[0]
            if not found:
                raise ValueError(f"{path.name}: no paid rows for {args.business_date}; today export is not usable")

        db.execute("DELETE FROM paid_order_items_raw WHERE batch_id=? AND (biz_date<? OR biz_date>?)",
                   (batch_id, start.isoformat(), end.isoformat()))
        db.execute("DELETE FROM export_coverage WHERE batch_id=? AND (biz_date<? OR biz_date>?)",
                   (batch_id, start.isoformat(), end.isoformat()))
        db.execute("""UPDATE export_shards SET row_count=(
            SELECT count(*) FROM paid_order_items_raw r
             WHERE r.batch_id=export_shards.batch_id AND r.shard_id=export_shards.shard_id)
            WHERE batch_id=?""", (batch_id,))
        if inserted_shards:
            placeholders = ",".join("?" for _ in inserted_shards)
            db.execute(f"""DELETE FROM export_shards WHERE batch_id=? AND row_count=0
                AND shard_id NOT IN ({placeholders})""", (batch_id, *sorted(inserted_shards)))
        else:
            db.execute("DELETE FROM export_shards WHERE batch_id=? AND row_count=0", (batch_id,))
        manifest = manifest_from_shards(db, batch_id)
        captured_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        db.execute("""UPDATE export_batches SET business_date=?,start_date=?,end_date=?,captured_at=?,
            quality='raw_paid_order_exports',complete=1,manifest_json=? WHERE batch_id=?""", (
                args.business_date.isoformat(), start.isoformat(), end.isoformat(), captured_at,
                json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), batch_id))
        raw_count = validate_ods(db, batch_id, start, end)
        finish_database(db)
        db.close()
        db = None
        os.replace(building, args.output)
        return {"batch_id": batch_id, "mode": "incremental", "files": len(files),
                "imported_rows": imported, "rows": raw_count,
                "replaced_rows_before": replaced_rows_before,
                "replaced_rows_after": imported,
                "replace_start_date": replace_start.isoformat(),
                "replace_end_date": replace_end.isoformat(), "start_date": start.isoformat(),
                "end_date": end.isoformat(), "output": str(args.output)}
    except Exception:
        if db is not None:
            db.close()
        building.unlink(missing_ok=True)
        raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--xlsx-dir", type=Path,
                        help="Directory containing only the exports for this import")
    parser.add_argument("--xlsx", action="append", default=[], type=Path,
                        help="Explicit Excel export path; repeat for split files")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--business-date", required=True, type=date.fromisoformat)
    parser.add_argument("--today-xlsx", action="append", default=[], type=Path,
                        help="Excel export forced to the business date; repeat for split files")
    parser.add_argument("--start-date", type=date.fromisoformat)
    parser.add_argument("--end-date", type=date.fromisoformat)
    parser.add_argument("--base", type=Path,
                        help="Existing ODS to copy and update while preserving its batch identity")
    parser.add_argument("--replace-start-date", type=date.fromisoformat)
    parser.add_argument("--replace-end-date", type=date.fromisoformat)
    args = parser.parse_args()
    if (args.replace_start_date or args.replace_end_date) and not args.base:
        raise ValueError("replacement dates require --base")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    files = selected_files(args)
    today_files = set(args.today_xlsx)
    result = (build_incremental(args, files, today_files) if args.base
              else build_full(args, files, today_files))
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
