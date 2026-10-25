#!/usr/bin/env python3
"""Import JST shop-product Excel shards directly into a DuckDB BI warehouse."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from datetime import datetime
from pathlib import Path

import duckdb
import fastexcel
import polars as pl


HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location(
    "shop_product_sqlite_importer", HERE / "import-shop-product-exports.py"
)
_helpers = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(_helpers)

HEADERS = _helpers.HEADERS
MODERN_REQUIRED_HEADERS = {
    "图片", "款式主图", "店铺编号", "店铺名称", "站点名称",
    "平台店铺款式编码", "平台店铺商品编码", "线上款式编码", "线上商品编码",
    "线上商品名称", "线上颜色规格", "店铺库存", "是否上架", "链接同步设置",
    "虚拟分类", "线上链接", "下架时间",
}
LEGACY_EXPORT_FORMAT = "shop_product_listing_v1"
MODERN_EXPORT_FORMAT = "shop_product_detail_v1"
SHANGHAI = _helpers.SHANGHAI
file_stamp = _helpers.file_stamp
shop_directory = _helpers.shop_directory
workbooks = _helpers.workbooks


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(4 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def text(source: str, alias: str, identifier: bool = False) -> pl.Expr:
    value = (
        pl.col(source).cast(pl.String).str.strip_chars()
        .str.replace_all("_x003D_", "=")
        .str.replace_all("_x002B_", "+")
        .str.replace_all("_x0026_", "&")
        .str.replace_all("_x007E_", "~")
        .str.replace_all("_x000A_", "\n")
        .str.replace_all("_x0009_", "\t")
        .str.replace_all("_x200B_", "\u200b")
        .str.replace_all("_x007C_", "|")
        .str.replace_all("_x0060_", "`")
        .str.replace_all("_x200C_", "\u200c")
    )
    if identifier:
        value = value.str.replace(r"^(-?\d+)\.0+$", "$1")
    return pl.when(value == "").then(None).otherwise(value).alias(alias)


def integer(source: str, alias: str) -> pl.Expr:
    return (
        pl.col(source).cast(pl.String).str.replace_all(",", "")
        .cast(pl.Float64, strict=False).cast(pl.Int64, strict=False).alias(alias)
    )


def normalize(frame: pl.DataFrame, shops: dict[str, tuple[str, str | None]],
              previous_parent: str | None) -> tuple[pl.DataFrame, str | None, set[str]]:
    frame = frame.select(
        text("数据类型", "row_type"),
        text("店铺名称", "shop_name"),
        text("平台店铺款式编码/平台店铺商品编码", "external_id", True),
        text("线上款式编码/线上商品编码", "internal_code", True),
        text("线上商品名称/线上颜色规格", "display_name"),
        text("图片", "image"), text("查看线上", "item_url"),
        text("虚拟分类", "virtual_category"),
        integer("店铺库存", "shop_stock"),
        integer("系统可用同步库存", "system_available_stock"),
        text("是否上架", "listed_text"), text("上架结果", "listing_result"),
        text("链接同步设置", "sync_setting"), text("下架时间", "off_shelf_time"),
        text("备注", "remark"),
    ).with_columns(
        pl.when(pl.col("listed_text") == "是").then(1)
        .when(pl.col("listed_text") == "否").then(0)
        .otherwise(None).cast(pl.Int8).alias("is_listed")
    )
    parent = (
        pl.when(pl.col("row_type") == "主表").then(pl.col("external_id"))
        .otherwise(None).fill_null(strategy="forward")
    )
    if previous_parent is not None:
        parent = parent.fill_null(previous_parent)
    frame = frame.with_columns(parent.alias("platform_item_id"))

    names = frame.get_column("shop_name").unique().drop_nulls().to_list()
    unmapped = {name for name in names if name not in shops}
    directory = pl.DataFrame(
        [(name, *(shops.get(name) or (f"name:{name}", None))) for name in names],
        schema=["shop_name", "shop_id", "platform"], orient="row",
    )
    frame = frame.join(directory, on="shop_name", how="left")
    invalid = frame.filter(
        pl.col("row_type").is_in(["主表", "明细"]).not_()
        | pl.col("shop_name").is_null() | pl.col("external_id").is_null()
        | ((pl.col("row_type") == "明细") & pl.col("platform_item_id").is_null())
    )
    if invalid.height:
        raise ValueError(f"invalid shop-product rows: {invalid.head(3).to_dicts()}")
    mains = frame.filter(pl.col("row_type") == "主表").get_column("external_id")
    return frame, (mains[-1] if len(mains) else previous_parent), unmapped


def inventory_available(path: Path | None) -> pl.DataFrame:
    if not path or not path.is_file():
        return pl.DataFrame(
            schema={"internal_sku_code": pl.String, "system_available_stock": pl.Int64}
        )
    import sqlite3
    with sqlite3.connect(path) as db:
        rows = db.execute(
            "SELECT sku_id,CAST(max(available_qty) AS INTEGER) FROM sku_inventory GROUP BY sku_id"
        ).fetchall()
    return pl.DataFrame(
        [(str(sku_id), value) for sku_id, value in rows if sku_id is not None],
        schema=["internal_sku_code", "system_available_stock"], orient="row",
    )


def normalize_modern(frame: pl.DataFrame, shops: dict[str, tuple[str, str | None]],
                     availability: pl.DataFrame) -> tuple[pl.DataFrame, pl.DataFrame, set[str]]:
    optional = lambda name: pl.col(name) if name in frame.columns else pl.lit(None)
    normalized = frame.select(
        text("店铺编号", "shop_id", True),
        text("店铺名称", "shop_name"),
        text("平台店铺款式编码", "platform_item_id", True),
        text("平台店铺商品编码", "platform_sku_id", True),
        text("线上款式编码", "internal_item_code", True),
        text("线上商品编码", "internal_sku_code", True),
        text("线上商品名称", "item_name"),
        text("线上颜色规格", "sku_name"),
        text("图片", "sku_image"), text("款式主图", "item_image"),
        text("虚拟分类", "virtual_category"), text("线上链接", "item_url"),
        integer("店铺库存", "shop_stock"),
        text("是否上架", "listed_text"), text("链接同步设置", "sync_setting"),
        text("下架时间", "off_shelf_time"),
        optional("系统商品备注").cast(pl.String).str.strip_chars().alias("remark"),
    ).with_columns(
        pl.when(pl.col("listed_text") == "是").then(1)
        .when(pl.col("listed_text") == "否").then(0)
        .otherwise(None).cast(pl.Int8).alias("is_listed")
    )
    names = normalized.get_column("shop_name").unique().drop_nulls().to_list()
    unmapped = {name for name in names if name not in shops}
    platforms = {shop_id: platform for shop_id, platform in shops.values()}
    directory = pl.DataFrame(
        list(platforms.items()), schema=["shop_id", "platform"], orient="row",
    )
    normalized = normalized.join(directory, on="shop_id", how="left")
    normalized = normalized.join(availability, on="internal_sku_code", how="left").with_columns(
        pl.col("system_available_stock").fill_null(0)
    )
    invalid = normalized.filter(
        pl.col("shop_id").is_null() | pl.col("shop_name").is_null()
        | pl.col("platform_item_id").is_null() | pl.col("platform_sku_id").is_null()
    )
    if invalid.height:
        raise ValueError(f"invalid modern shop-product rows: {invalid.head(3).to_dicts()}")

    first = lambda name: pl.col(name).drop_nulls().first()
    items = normalized.group_by(
        ["shop_id", "shop_name", "platform", "platform_item_id"], maintain_order=True
    ).agg(
        first("internal_item_code"), first("item_name"),
        pl.coalesce(first("item_image"), first("sku_image")).alias("item_image"),
        first("item_url"), first("virtual_category"),
        pl.col("shop_stock").sum().alias("shop_stock"),
        pl.when(pl.col("system_available_stock").count() > 0)
        .then(pl.col("system_available_stock").sum()).otherwise(None)
        .alias("system_available_stock"),
        pl.col("is_listed").max().alias("is_listed"),
        pl.lit(None, dtype=pl.String).alias("listing_result"),
        first("sync_setting"), first("off_shelf_time"), first("remark"),
    ).rename({
        "platform_item_id": "external_id", "internal_item_code": "internal_code",
        "item_name": "display_name", "item_image": "image",
    }).select(ITEM_COLUMNS)
    skus = normalized.select(
        "shop_id", "platform_item_id", "platform_sku_id", "internal_sku_code", "sku_name",
        "sku_image", "virtual_category", "shop_stock", "system_available_stock",
        "is_listed", pl.lit(None, dtype=pl.String).alias("listing_result"),
        "sync_setting", "off_shelf_time", "remark",
    ).rename({
        "platform_sku_id": "external_id", "internal_sku_code": "internal_code",
        "sku_name": "display_name", "sku_image": "image",
    }).select(SKU_COLUMNS)
    return items, skus, unmapped


def create_schema(db: duckdb.DuckDBPyConnection) -> None:
    db.execute("""
      CREATE TABLE snapshot_info(id INTEGER,snapshot_date VARCHAR,captured_at VARCHAR,
        source_count BIGINT,workbook_count BIGINT,raw_row_count BIGINT,item_count BIGINT,
        sku_count BIGINT,unmapped_shop_count BIGINT,complete INTEGER);
      CREATE TABLE snapshot_files(source_name VARCHAR,source_sha256 VARCHAR,
        workbook_count BIGINT,raw_row_count BIGINT);
      CREATE TABLE shop_product_items(shop_id VARCHAR,shop_name VARCHAR,platform VARCHAR,
        platform_item_id VARCHAR,internal_item_code VARCHAR,item_name VARCHAR,item_image VARCHAR,
        item_url VARCHAR,virtual_category VARCHAR,shop_stock BIGINT,system_available_stock BIGINT,
        is_listed TINYINT,listing_result VARCHAR,sync_setting VARCHAR,off_shelf_time VARCHAR,remark VARCHAR);
      CREATE TABLE shop_product_skus(shop_id VARCHAR,platform_item_id VARCHAR,platform_sku_id VARCHAR,
        internal_sku_code VARCHAR,sku_name VARCHAR,sku_image VARCHAR,virtual_category VARCHAR,
        shop_stock BIGINT,system_available_stock BIGINT,is_listed TINYINT,listing_result VARCHAR,
        sync_setting VARCHAR,off_shelf_time VARCHAR,remark VARCHAR);
      CREATE TABLE listing_status_changes(change_date VARCHAR,entity_type VARCHAR,shop_id VARCHAR,
        platform_item_id VARCHAR,platform_sku_id VARCHAR,change_type VARCHAR,old_is_listed TINYINT,
        new_is_listed TINYINT,detected_at VARCHAR);
      CREATE TABLE _xdr_meta(key VARCHAR PRIMARY KEY,value VARCHAR NOT NULL);
    """)


def export_format(columns: list[str]) -> str:
    if columns == list(HEADERS):
        return LEGACY_EXPORT_FORMAT
    if MODERN_REQUIRED_HEADERS.issubset(columns):
        return MODERN_EXPORT_FORMAT
    raise ValueError(f"unexpected shop-product headers: {columns}")


def add_changes(db: duckdb.DuckDBPyConnection, base: Path | None,
                day: str, captured_at: str) -> int:
    if not base or not base.is_file():
        return 0
    escaped = str(base.resolve()).replace("'", "''")
    db.execute(f"ATTACH '{escaped}' AS old (READ_ONLY)")
    try:
        db.execute("INSERT INTO listing_status_changes SELECT * FROM old.listing_status_changes")
        statements = (
            """SELECT ?, 'item',n.shop_id,n.platform_item_id,'','status_changed',
                      o.is_listed,n.is_listed,?
                 FROM shop_product_items n JOIN old.shop_product_items o
                   USING(shop_id,platform_item_id)
                WHERE o.is_listed IS DISTINCT FROM n.is_listed""",
            """SELECT ?, 'sku',n.shop_id,n.platform_item_id,n.platform_sku_id,'status_changed',
                      o.is_listed,n.is_listed,?
                 FROM shop_product_skus n JOIN old.shop_product_skus o
                   USING(shop_id,platform_item_id,platform_sku_id)
                WHERE o.is_listed IS DISTINCT FROM n.is_listed""",
            """SELECT ?, 'item',n.shop_id,n.platform_item_id,'','created',NULL,n.is_listed,?
                 FROM shop_product_items n ANTI JOIN old.shop_product_items o
                   USING(shop_id,platform_item_id)""",
            """SELECT ?, 'sku',n.shop_id,n.platform_item_id,n.platform_sku_id,'created',
                      NULL,n.is_listed,?
                 FROM shop_product_skus n ANTI JOIN old.shop_product_skus o
                   USING(shop_id,platform_item_id,platform_sku_id)""",
            """SELECT ?, 'item',o.shop_id,o.platform_item_id,'','deleted',o.is_listed,NULL,?
                 FROM old.shop_product_items o ANTI JOIN shop_product_items n
                   USING(shop_id,platform_item_id)""",
            """SELECT ?, 'sku',o.shop_id,o.platform_item_id,o.platform_sku_id,'deleted',
                      o.is_listed,NULL,?
                 FROM old.shop_product_skus o ANTI JOIN shop_product_skus n
                   USING(shop_id,platform_item_id,platform_sku_id)""",
        )
        for query in statements:
            db.execute("INSERT INTO listing_status_changes " + query, [day, captured_at])
        db.execute("""
          CREATE OR REPLACE TABLE listing_status_changes AS
          SELECT * FROM listing_status_changes
          QUALIFY row_number() OVER (
            PARTITION BY change_date,entity_type,shop_id,platform_item_id,
                         platform_sku_id,change_type ORDER BY detected_at DESC
          )=1
        """)
        return db.execute(
            "SELECT count(*) FROM listing_status_changes WHERE change_date=?", [day]
        ).fetchone()[0]
    finally:
        db.execute("DETACH old")


ITEM_COLUMNS = [
    "shop_id", "shop_name", "platform", "external_id", "internal_code", "display_name",
    "image", "item_url", "virtual_category", "shop_stock", "system_available_stock",
    "is_listed", "listing_result", "sync_setting", "off_shelf_time", "remark",
]
SKU_COLUMNS = [
    "shop_id", "platform_item_id", "external_id", "internal_code", "display_name", "image",
    "virtual_category", "shop_stock", "system_available_stock", "is_listed", "listing_result",
    "sync_setting", "off_shelf_time", "remark",
]


def import_exports(source_dir: Path, output: Path, inventory: Path | None,
                   snapshot_date: str | None, base: Path | None = None,
                   resume_building: bool = False) -> dict:
    sources = sorted(
        (p for p in source_dir.iterdir() if p.suffix.lower() in (".xlsx", ".zip")),
        key=lambda p: (file_stamp(p) or datetime.min.replace(tzinfo=SHANGHAI), p.name),
    )
    if not sources:
        raise ValueError("no xlsx or zip exports found")
    manifest_path = source_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.is_file() else None
    if manifest:
        expected = [item["name"] for item in manifest.get("files", [])]
        actual = [source.name for source in sources]
        if manifest.get("batch_count") != len(expected) or sorted(expected) != sorted(actual):
            raise ValueError("shop-product export manifest does not match downloaded files")
    captured = max((file_stamp(p) for p in sources if file_stamp(p)),
                   default=datetime.now(SHANGHAI))
    day = snapshot_date or captured.date().isoformat()
    output.parent.mkdir(parents=True, exist_ok=True)
    building = output.with_name(f".{output.name}.building")
    if not resume_building:
        building.unlink(missing_ok=True)
    shops = shop_directory(inventory)
    availability = inventory_available(inventory)
    unmapped: set[str] = set()
    export_formats: set[str] = set()
    raw_rows = workbook_count = item_rows = sku_rows = 0

    db = duckdb.connect(str(building))
    try:
        db.execute("SET threads=2")
        db.execute("SET preserve_insertion_order=false")
        db.execute("SET memory_limit='12GB'")
        db.execute("SET temp_directory=?", [str(building.parent / ".duckdb-tmp")])
        resume_files: list[str] = []
        if resume_building:
            try:
                resume_files = [row[0] for row in db.execute(
                    "SELECT source_name FROM snapshot_files ORDER BY source_name"
                ).fetchall()]
            except duckdb.Error as error:
                raise ValueError("resumable shop-product database is incomplete") from error
            if resume_files != sorted(source.name for source in sources):
                raise ValueError("resumable shop-product database does not match source files")
            format_row = db.execute(
                "SELECT value FROM _xdr_meta WHERE key='export_format'"
            ).fetchone()
            if not format_row:
                raise ValueError("resumable shop-product database has no export format")
            export_formats.add(format_row[0])
            raw_rows = db.execute(
                "SELECT coalesce(sum(raw_row_count),0) FROM snapshot_files"
            ).fetchone()[0]
            workbook_count = db.execute(
                "SELECT coalesce(sum(workbook_count),0) FROM snapshot_files"
            ).fetchone()[0]
            item_rows = db.execute("SELECT count(*) FROM shop_product_items").fetchone()[0]
            sku_rows = db.execute("SELECT count(*) FROM shop_product_skus").fetchone()[0]
            print(json.dumps({"resumed": True, "source_count": len(resume_files),
                              "raw_rows": raw_rows, "items": item_rows,
                              "skus": sku_rows}, ensure_ascii=False), flush=True)
        else:
            create_schema(db)
        for source in ([] if resume_building else sources):
            source_rows = source_workbooks = 0
            parent = None
            with workbooks(source) as entries:
                for _, workbook in entries:
                    reader = fastexcel.read_excel(workbook)
                    sheet = reader.load_sheet(0, header_row=0, dtypes="string")
                    frame = sheet.to_polars()
                    count = frame.height
                    format_name = export_format(frame.columns)
                    export_formats.add(format_name)
                    if len(export_formats) != 1:
                        raise ValueError(f"mixed shop-product export formats: {sorted(export_formats)}")
                    db.execute(
                        "INSERT OR REPLACE INTO _xdr_meta VALUES('export_format',?)",
                        [format_name],
                    )
                    if format_name == LEGACY_EXPORT_FORMAT:
                        frame, parent, missing = normalize(frame, shops, parent)
                        items = frame.filter(pl.col("row_type") == "主表").select(ITEM_COLUMNS)
                        skus = frame.filter(pl.col("row_type") == "明细").select(SKU_COLUMNS)
                    else:
                        items, skus, missing = normalize_modern(frame, shops, availability)
                    unmapped.update(missing)
                    db.register("item_batch", items)
                    db.execute("INSERT INTO shop_product_items SELECT * FROM item_batch")
                    db.unregister("item_batch")
                    db.register("sku_batch", skus)
                    db.execute("INSERT INTO shop_product_skus SELECT * FROM sku_batch")
                    db.unregister("sku_batch")
                    raw_rows += count
                    source_rows += count
                    item_rows += items.height
                    sku_rows += skus.height
                    workbook_count += 1
                    source_workbooks += 1
                    del frame, items, skus, sheet, reader
            db.execute("INSERT INTO snapshot_files VALUES(?,?,?,?)",
                       [source.name, sha256(source), source_workbooks, source_rows])
            print(json.dumps({"source": source.name, "raw_rows": raw_rows,
                              "items": item_rows, "skus": sku_rows}, ensure_ascii=False), flush=True)
        db.execute("""
          CREATE OR REPLACE TABLE shop_product_items AS
          SELECT * FROM shop_product_items
          QUALIFY row_number() OVER (
            PARTITION BY shop_id,platform_item_id ORDER BY item_name NULLS LAST
          )=1
        """)
        db.execute("CHECKPOINT")
        db.execute("""
          CREATE OR REPLACE TABLE shop_product_skus AS
          SELECT * FROM shop_product_skus
          QUALIFY row_number() OVER (
            PARTITION BY shop_id,platform_item_id,platform_sku_id
            ORDER BY internal_sku_code NULLS LAST
          )=1
        """)
        item_count = db.execute("SELECT count(*) FROM shop_product_items").fetchone()[0]
        sku_count = db.execute("SELECT count(*) FROM shop_product_skus").fetchone()[0]
        if not item_count or not sku_count:
            raise ValueError("shop-product snapshot is empty")
        if len(export_formats) != 1:
            raise ValueError(f"invalid shop-product export formats: {sorted(export_formats)}")
        format_name = next(iter(export_formats))
        if base and base.is_file():
            escaped = str(base.resolve()).replace("'", "''")
            db.execute(f"ATTACH '{escaped}' AS quality_base (READ_ONLY)")
            try:
                previous_items = db.execute("SELECT count(*) FROM quality_base.shop_product_items").fetchone()[0]
                previous_skus = db.execute("SELECT count(*) FROM quality_base.shop_product_skus").fetchone()[0]
            finally:
                db.execute("DETACH quality_base")
            if item_count < previous_items * 0.8 or sku_count < previous_skus * 0.8:
                raise ValueError(
                    f"shop-product snapshot shrank unexpectedly: items {previous_items}->{item_count}, "
                    f"skus {previous_skus}->{sku_count}"
                )
        change_count = add_changes(db, base, day, captured.isoformat(timespec="seconds"))
        db.execute("INSERT INTO snapshot_info VALUES(1,?,?,?,?,?,?,?,?,1)", [
            day, captured.isoformat(timespec="seconds"), len(sources), workbook_count, raw_rows,
            item_count, sku_count, len(unmapped),
        ])
        db.execute("CHECKPOINT")
    finally:
        db.close()
    building.replace(output)
    return {"snapshot_date": day, "captured_at": captured.isoformat(timespec="seconds"),
            "source_count": len(sources), "workbook_count": workbook_count,
            "raw_row_count": raw_rows, "item_count": item_count, "sku_count": sku_count,
            "change_count": change_count, "unmapped_shops": sorted(unmapped), "output": str(output),
            "parser": "fastexcel", "warehouse": "duckdb", "export_format": format_name}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--inventory", type=Path)
    parser.add_argument("--base", type=Path)
    parser.add_argument("--snapshot-date")
    parser.add_argument("--resume-building", action="store_true")
    args = parser.parse_args()
    print(json.dumps(import_exports(
        args.source_dir, args.output, args.inventory, args.snapshot_date,
        args.base, args.resume_building,
    ), ensure_ascii=False))


if __name__ == "__main__":
    main()
