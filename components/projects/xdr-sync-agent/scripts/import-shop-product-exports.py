#!/usr/bin/env python3
"""Import JST shop-product listing exports into a compact SQLite snapshot."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sqlite3
import tempfile
import zipfile
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

import fastexcel


HEADERS = (
    "数据类型", "图片", "店铺名称", "平台店铺款式编码/平台店铺商品编码",
    "查看线上", "线上款式编码/线上商品编码", "线上商品名称/线上颜色规格",
    "虚拟分类", "店铺库存", "系统可用同步库存", "是否上架", "上架结果",
    "链接同步设置", "下架时间", "备注",
)
SHANGHAI = timezone(timedelta(hours=8))
INSERT_BATCH = 20_000


def clean(value) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return re.sub(r"_x([0-9A-Fa-f]{4})_", lambda m: chr(int(m.group(1), 16)), text)


def identifier(value) -> str | None:
    text = clean(value)
    if text and re.fullmatch(r"-?\d+\.0+", text):
        return text.split(".", 1)[0]
    return text


def integer(value) -> int | None:
    text = clean(value)
    if text is None:
        return None
    try:
        return int(float(text.replace(",", "")))
    except ValueError:
        return None


def listed(value) -> int | None:
    text = clean(value)
    if text == "是":
        return 1
    if text == "否":
        return 0
    return None


def file_stamp(path: Path) -> datetime | None:
    match = re.search(r"_(\d{14})_\d+(?:_\d+)?\.(?:xlsx|zip)$", path.name, re.I)
    if not match:
        return None
    return datetime.strptime(match.group(1), "%Y%m%d%H%M%S").replace(tzinfo=SHANGHAI)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


@contextmanager
def workbooks(source: Path):
    if source.suffix.lower() == ".xlsx":
        yield [(source.name, source)]
        return
    with tempfile.TemporaryDirectory(prefix="jst-shop-products-") as temp:
        root = Path(temp)
        with zipfile.ZipFile(source) as archive:
            names = sorted(
                (name for name in archive.namelist() if name.lower().endswith(".xlsx")),
                key=lambda name: (int(re.search(r"_(\d+)\.xlsx$", name, re.I).group(1))
                                  if re.search(r"_(\d+)\.xlsx$", name, re.I) else 0, name),
            )
            if not names:
                raise ValueError(f"{source.name}: no xlsx workbook")
            paths = []
            for index, name in enumerate(names, 1):
                target = root / f"part-{index:03d}.xlsx"
                with archive.open(name) as incoming, target.open("wb") as outgoing:
                    shutil.copyfileobj(incoming, outgoing)
                paths.append((name, target))
        yield paths


def create_schema(db: sqlite3.Connection) -> None:
    db.executescript("""
      CREATE TABLE snapshot_info(
        id INTEGER PRIMARY KEY CHECK(id=1),snapshot_date TEXT NOT NULL,captured_at TEXT NOT NULL,
        source_count INTEGER NOT NULL,workbook_count INTEGER NOT NULL,raw_row_count INTEGER NOT NULL,
        item_count INTEGER NOT NULL,sku_count INTEGER NOT NULL,unmapped_shop_count INTEGER NOT NULL,
        complete INTEGER NOT NULL CHECK(complete IN (0,1)));
      CREATE TABLE snapshot_files(
        source_name TEXT PRIMARY KEY,source_sha256 TEXT NOT NULL,workbook_count INTEGER NOT NULL,
        raw_row_count INTEGER NOT NULL);
      CREATE TABLE shop_product_items(
        shop_id TEXT NOT NULL,shop_name TEXT NOT NULL,platform TEXT,platform_item_id TEXT NOT NULL,
        internal_item_code TEXT,item_name TEXT,item_image TEXT,item_url TEXT,virtual_category TEXT,
        shop_stock INTEGER,system_available_stock INTEGER,is_listed INTEGER,listing_result TEXT,
        sync_setting TEXT,off_shelf_time TEXT,remark TEXT,
        PRIMARY KEY(shop_id,platform_item_id));
      CREATE TABLE shop_product_skus(
        shop_id TEXT NOT NULL,platform_item_id TEXT NOT NULL,platform_sku_id TEXT NOT NULL,
        internal_sku_code TEXT,sku_name TEXT,sku_image TEXT,virtual_category TEXT,
        shop_stock INTEGER,system_available_stock INTEGER,is_listed INTEGER,listing_result TEXT,
        sync_setting TEXT,off_shelf_time TEXT,remark TEXT,
        PRIMARY KEY(shop_id,platform_item_id,platform_sku_id));
      CREATE TABLE listing_status_changes(
        change_date TEXT NOT NULL,entity_type TEXT NOT NULL,shop_id TEXT NOT NULL,
        platform_item_id TEXT NOT NULL,platform_sku_id TEXT NOT NULL DEFAULT '',change_type TEXT NOT NULL,
        old_is_listed INTEGER,new_is_listed INTEGER,detected_at TEXT NOT NULL,
        PRIMARY KEY(change_date,entity_type,shop_id,platform_item_id,platform_sku_id,change_type));
      CREATE INDEX idx_shop_product_items_code ON shop_product_items(internal_item_code);
      CREATE INDEX idx_shop_product_items_listed ON shop_product_items(is_listed,shop_id);
      CREATE INDEX idx_shop_product_skus_code ON shop_product_skus(internal_sku_code);
      CREATE INDEX idx_shop_product_skus_item ON shop_product_skus(shop_id,platform_item_id);
      CREATE INDEX idx_shop_product_skus_listed ON shop_product_skus(is_listed,shop_id);
      CREATE INDEX idx_listing_changes_date ON listing_status_changes(change_date,entity_type);
    """)


def shop_directory(inventory: Path | None) -> dict[str, tuple[str, str | None]]:
    if not inventory or not inventory.is_file():
        return {}
    with sqlite3.connect(inventory) as db:
        exists = db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='shop_directory'"
        ).fetchone()
        if not exists:
            return {}
        return {
            str(name): (str(shop_id), clean(platform))
            for shop_id, name, platform in db.execute(
                "SELECT shop_id,shop_name,platform FROM shop_directory"
            ) if name
        }


def copy_history(db: sqlite3.Connection, base: Path | None) -> None:
    if not base or not base.is_file():
        return
    db.execute("ATTACH DATABASE ? AS old", (str(base),))
    try:
        exists = db.execute(
            "SELECT 1 FROM old.sqlite_master WHERE type='table' AND name='listing_status_changes'"
        ).fetchone()
        if exists:
            db.execute("INSERT OR IGNORE INTO listing_status_changes SELECT * FROM old.listing_status_changes")
    finally:
        db.execute("DETACH DATABASE old")


def add_changes(db: sqlite3.Connection, base: Path | None, day: str, captured_at: str) -> int:
    if not base or not base.is_file():
        return 0
    db.execute("ATTACH DATABASE ? AS old", (str(base),))
    try:
        statements = (
            """INSERT OR REPLACE INTO listing_status_changes
               SELECT ?, 'item',n.shop_id,n.platform_item_id,'','status_changed',o.is_listed,n.is_listed,?
               FROM shop_product_items n JOIN old.shop_product_items o USING(shop_id,platform_item_id)
               WHERE o.is_listed IS NOT n.is_listed""",
            """INSERT OR REPLACE INTO listing_status_changes
               SELECT ?, 'sku',n.shop_id,n.platform_item_id,n.platform_sku_id,'status_changed',o.is_listed,n.is_listed,?
               FROM shop_product_skus n JOIN old.shop_product_skus o
               USING(shop_id,platform_item_id,platform_sku_id) WHERE o.is_listed IS NOT n.is_listed""",
            """INSERT OR REPLACE INTO listing_status_changes
               SELECT ?, 'item',n.shop_id,n.platform_item_id,'','created',NULL,n.is_listed,?
               FROM shop_product_items n LEFT JOIN old.shop_product_items o USING(shop_id,platform_item_id)
               WHERE o.shop_id IS NULL""",
            """INSERT OR REPLACE INTO listing_status_changes
               SELECT ?, 'sku',n.shop_id,n.platform_item_id,n.platform_sku_id,'created',NULL,n.is_listed,?
               FROM shop_product_skus n LEFT JOIN old.shop_product_skus o
               USING(shop_id,platform_item_id,platform_sku_id) WHERE o.shop_id IS NULL""",
            """INSERT OR REPLACE INTO listing_status_changes
               SELECT ?, 'item',o.shop_id,o.platform_item_id,'','deleted',o.is_listed,NULL,?
               FROM old.shop_product_items o LEFT JOIN shop_product_items n USING(shop_id,platform_item_id)
               WHERE n.shop_id IS NULL""",
            """INSERT OR REPLACE INTO listing_status_changes
               SELECT ?, 'sku',o.shop_id,o.platform_item_id,o.platform_sku_id,'deleted',o.is_listed,NULL,?
               FROM old.shop_product_skus o LEFT JOIN shop_product_skus n
               USING(shop_id,platform_item_id,platform_sku_id) WHERE n.shop_id IS NULL""",
        )
        before = db.total_changes
        for sql in statements:
            db.execute(sql, (day, captured_at))
        return db.total_changes - before
    finally:
        db.execute("DETACH DATABASE old")


def import_exports(source_dir: Path, output: Path, base: Path | None,
                   inventory: Path | None, snapshot_date: str | None) -> dict:
    sources = sorted(
        (path for path in source_dir.iterdir() if path.suffix.lower() in (".xlsx", ".zip")),
        key=lambda path: (file_stamp(path) or datetime.min.replace(tzinfo=SHANGHAI), path.name),
    )
    if not sources:
        raise ValueError("no xlsx or zip exports found")
    captured = max((file_stamp(path) for path in sources if file_stamp(path)), default=datetime.now(SHANGHAI))
    day = snapshot_date or captured.date().isoformat()
    output.parent.mkdir(parents=True, exist_ok=True)
    building = output.with_name(f".{output.name}.building")
    building.unlink(missing_ok=True)
    shops = shop_directory(inventory)
    raw_rows = workbook_count = item_rows = sku_rows = 0
    unmapped: set[str] = set()
    with sqlite3.connect(building) as db:
        db.execute("PRAGMA journal_mode=OFF")
        db.execute("PRAGMA synchronous=OFF")
        db.execute("PRAGMA temp_store=MEMORY")
        db.execute("PRAGMA cache_size=-262144")
        create_schema(db)
        copy_history(db, base)
        item_sql = "INSERT OR REPLACE INTO shop_product_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
        sku_sql = "INSERT OR REPLACE INTO shop_product_skus VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
        for source in sources:
            source_rows = source_workbooks = 0
            current = None
            with workbooks(source) as entries:
                for original_name, workbook in entries:
                    reader = fastexcel.read_excel(workbook)
                    sheet = reader.load_sheet(0, header_row=0, dtypes="string")
                    frame = sheet.to_polars()
                    if frame.columns != list(HEADERS):
                        raise ValueError(f"{source.name}/{original_name}: unexpected headers {frame.columns}")
                    source_workbooks += 1
                    workbook_count += 1
                    item_batch, sku_batch = [], []
                    for values in frame.iter_rows():
                        raw_rows += 1
                        source_rows += 1
                        row = dict(zip(HEADERS, values))
                        row_type = clean(row["数据类型"])
                        shop_name = clean(row["店铺名称"])
                        external_id = identifier(row["平台店铺款式编码/平台店铺商品编码"])
                        if not shop_name or not external_id:
                            raise ValueError(f"{source.name}: row {source_rows} missing shop or external id")
                        mapped = shops.get(shop_name)
                        if mapped:
                            shop_id, platform = mapped
                        else:
                            shop_id, platform = f"name:{shop_name}", None
                            unmapped.add(shop_name)
                        common = (
                            identifier(row["线上款式编码/线上商品编码"]),
                            clean(row["线上商品名称/线上颜色规格"]), clean(row["图片"]),
                            clean(row["虚拟分类"]), integer(row["店铺库存"]),
                            integer(row["系统可用同步库存"]), listed(row["是否上架"]),
                            clean(row["上架结果"]), clean(row["链接同步设置"]),
                            clean(row["下架时间"]), clean(row["备注"]),
                        )
                        if row_type == "主表":
                            current = (shop_id, external_id)
                            item_batch.append((
                                shop_id, shop_name, platform, external_id, common[0], common[1],
                                common[2], clean(row["查看线上"]), common[3], common[4], common[5],
                                common[6], common[7], common[8], common[9], common[10],
                            ))
                            item_rows += 1
                        elif row_type == "明细":
                            if not current or current[0] != shop_id:
                                raise ValueError(f"{source.name}: detail row {source_rows} has no parent item")
                            sku_batch.append((
                                shop_id, current[1], external_id, common[0], common[1], common[2],
                                common[3], common[4], common[5], common[6], common[7], common[8],
                                common[9], common[10],
                            ))
                            sku_rows += 1
                        else:
                            raise ValueError(f"{source.name}: unknown row type {row_type!r}")
                        if len(item_batch) >= INSERT_BATCH:
                            db.executemany(item_sql, item_batch)
                            item_batch.clear()
                        if len(sku_batch) >= INSERT_BATCH:
                            db.executemany(sku_sql, sku_batch)
                            sku_batch.clear()
                    if item_batch:
                        db.executemany(item_sql, item_batch)
                    if sku_batch:
                        db.executemany(sku_sql, sku_batch)
                    del frame, sheet, reader
            db.execute(
                "INSERT INTO snapshot_files VALUES(?,?,?,?)",
                (source.name, sha256(source), source_workbooks, source_rows),
            )
            db.commit()
        item_count = db.execute("SELECT count(*) FROM shop_product_items").fetchone()[0]
        sku_count = db.execute("SELECT count(*) FROM shop_product_skus").fetchone()[0]
        change_count = add_changes(db, base, day, captured.isoformat(timespec="seconds"))
        db.execute(
            "INSERT INTO snapshot_info VALUES(1,?,?,?,?,?,?,?,?,1)",
            (day, captured.isoformat(timespec="seconds"), len(sources), workbook_count, raw_rows,
             item_count, sku_count, len(unmapped)),
        )
        db.execute("PRAGMA optimize")
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("sqlite integrity check failed")
        db.commit()
    building.replace(output)
    return {
        "snapshot_date": day, "captured_at": captured.isoformat(timespec="seconds"),
        "source_count": len(sources), "workbook_count": workbook_count,
        "raw_row_count": raw_rows, "item_rows_seen": item_rows, "sku_rows_seen": sku_rows,
        "item_count": item_count, "sku_count": sku_count, "change_count": change_count,
        "unmapped_shops": sorted(unmapped), "output": str(output), "parser": "fastexcel",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--base", type=Path)
    parser.add_argument("--inventory", type=Path)
    parser.add_argument("--snapshot-date")
    args = parser.parse_args()
    print(json.dumps(import_exports(args.source_dir, args.output, args.base, args.inventory,
                                    args.snapshot_date), ensure_ascii=False))


if __name__ == "__main__":
    main()
