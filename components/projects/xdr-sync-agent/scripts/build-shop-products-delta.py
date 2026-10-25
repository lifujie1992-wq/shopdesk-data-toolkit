#!/usr/bin/env python3
"""Build a small SQLite transfer patch by comparing two DuckDB snapshots."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import shutil
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

import duckdb


UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)


def qi(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def literal(value: object) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def metadata(db: duckdb.DuckDBPyConnection, key: str,
             catalog: str = "main") -> str | None:
    try:
        row = db.execute(
            f"SELECT value FROM {qi(catalog)}._xdr_meta WHERE key=?", [key]
        ).fetchone()
    except duckdb.Error:
        return None
    return row[0] if row else None


def revision(db: duckdb.DuckDBPyConnection, catalog: str = "main") -> str | None:
    return metadata(db, "revision", catalog)


def sqlite_type(duck_type: str) -> str:
    upper = duck_type.upper()
    if any(token in upper for token in ("INT", "BOOL")):
        return "INTEGER"
    if any(token in upper for token in ("DOUBLE", "FLOAT", "DECIMAL", "REAL")):
        return "REAL"
    return "TEXT"


def copy_query(source: duckdb.DuckDBPyConnection, target: sqlite3.Connection,
               table: str, columns: list[str], query: str) -> int:
    cursor = source.execute(query)
    placeholders = ",".join("?" for _ in columns)
    insert = f"INSERT INTO {qi(table)}({','.join(map(qi, columns))}) VALUES({placeholders})"
    total = 0
    while True:
        batch = cursor.fetchmany(20_000)
        if not batch:
            break
        target.executemany(insert, batch)
        total += len(batch)
    return total


def build(current: Path, base: Path, output_dir: Path, job_id: str,
          server_revision: str, schema_file: Path,
          max_primary_change_ratio: float = 0.35,
          change_guard_min_rows: int = 100_000) -> dict:
    if not UUID.fullmatch(job_id):
        raise ValueError("invalid job id")
    if not current.is_file() or not base.is_file():
        raise ValueError("current/base DuckDB snapshot is missing")
    spec = json.loads(schema_file.read_text())["datasets"]["shop_products"]
    output_dir.mkdir(parents=True, exist_ok=True)
    target_revision = str(uuid.uuid4())
    stem = f"{job_id}.shop_products.patch"
    raw = output_dir / f"{stem}.sqlite"
    compressed = output_dir / f"{stem}.sqlite.gz.partial"
    sha_path = output_dir / f"{stem}.sha256.partial"
    for path in (raw, compressed, sha_path):
        path.unlink(missing_ok=True)

    source = duckdb.connect(str(current))
    package = sqlite3.connect(raw)
    try:
        source.execute("SET threads=4")
        source.execute("SET memory_limit='6GB'")
        source.execute("SET preserve_insertion_order=false")
        source.execute(f"ATTACH {literal(base.resolve())} AS base (READ_ONLY)")
        local_revision = revision(source, "base")
        if not local_revision or local_revision != server_revision:
            raise ValueError("shop_products_revision_conflict")
        current_format = metadata(source, "export_format")
        base_format = metadata(source, "export_format", "base")
        if not current_format or not base_format:
            raise ValueError("shop_products_export_format_missing")
        if current_format != base_format:
            raise ValueError(
                f"shop_products_export_format_mismatch:{base_format}->{current_format}"
            )

        primary_table = spec["primary_table"]
        primary_rule = spec["tables"][primary_table]
        primary_columns, primary_pk = primary_rule["columns"], primary_rule["pk"]
        primary_join = " AND ".join(
            f"b.{qi(column)} IS NOT DISTINCT FROM t.{qi(column)}" for column in primary_pk
        )
        primary_changed = " OR ".join(
            f"b.{qi(column)} IS DISTINCT FROM t.{qi(column)}"
            for column in primary_columns if column not in primary_pk
        )
        primary_upsert_where = f"b.{qi(primary_pk[0])} IS NULL"
        if primary_changed:
            primary_upsert_where += f" OR {primary_changed}"
        primary_base_join = " AND ".join(
            f"t.{qi(column)} IS NOT DISTINCT FROM b.{qi(column)}" for column in primary_pk
        )
        target_count = source.execute(
            f"SELECT count(*) FROM {qi(primary_table)}"
        ).fetchone()[0]
        base_count = source.execute(
            f"SELECT count(*) FROM base.{qi(primary_table)}"
        ).fetchone()[0]
        upsert_count = source.execute(
            f"SELECT count(*) FROM {qi(primary_table)} t "
            f"LEFT JOIN base.{qi(primary_table)} b ON {primary_join} "
            f"WHERE {primary_upsert_where}"
        ).fetchone()[0]
        delete_count = source.execute(
            f"SELECT count(*) FROM base.{qi(primary_table)} b "
            f"LEFT JOIN {qi(primary_table)} t ON {primary_base_join} "
            f"WHERE t.{qi(primary_pk[0])} IS NULL"
        ).fetchone()[0]
        denominator = max(base_count, target_count, 1)
        primary_change_ratio = (upsert_count + delete_count) / denominator
        if denominator >= change_guard_min_rows and primary_change_ratio > max_primary_change_ratio:
            raise ValueError(
                "shop_products_change_ratio_exceeded:"
                f"{primary_change_ratio:.6f}>{max_primary_change_ratio:.6f}:"
                f"upserts={upsert_count}:deletes={delete_count}:"
                f"base={base_count}:target={target_count}"
            )

        manifest = {
            "format_version": 1, "job_id": job_id, "dataset": "shop_products",
            "mode": "patch", "base_revision": local_revision,
            "target_revision": target_revision,
            "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "row_count": 0, "tables": {}, "engine": "duckdb_delta_v1",
        }
        for table, rule in spec["tables"].items():
            columns, pk = rule["columns"], rule["pk"]
            type_rows = source.execute(f"PRAGMA table_info({qi(table)})").fetchall()
            types = {row[1]: sqlite_type(str(row[2])) for row in type_rows}
            upsert_table, delete_table = f"upsert__{table}", f"delete__{table}"
            package.execute(f"CREATE TABLE {qi(upsert_table)}({','.join(f'{qi(c)} {types[c]}' for c in columns)})")
            package.execute(f"CREATE TABLE {qi(delete_table)}({','.join(f'{qi(c)} {types[c]}' for c in pk)})")
            join = " AND ".join(f"b.{qi(c)} IS NOT DISTINCT FROM t.{qi(c)}" for c in pk)
            changed = " OR ".join(f"b.{qi(c)} IS DISTINCT FROM t.{qi(c)}" for c in columns if c not in pk)
            upsert_where = f"b.{qi(pk[0])} IS NULL" + (f" OR {changed}" if changed else "")
            selected = ",".join(f"t.{qi(c)}" for c in columns)
            upserts = copy_query(source, package, upsert_table, columns,
                f"SELECT {selected} FROM {qi(table)} t LEFT JOIN base.{qi(table)} b ON {join} WHERE {upsert_where}")
            base_join = " AND ".join(f"t.{qi(c)} IS NOT DISTINCT FROM b.{qi(c)}" for c in pk)
            deletes = copy_query(source, package, delete_table, pk,
                f"SELECT {','.join(f'b.{qi(c)}' for c in pk)} FROM base.{qi(table)} b "
                f"LEFT JOIN {qi(table)} t ON {base_join} WHERE t.{qi(pk[0])} IS NULL")
            target_count = source.execute(f"SELECT count(*) FROM {qi(table)}").fetchone()[0]
            manifest["tables"][table] = {
                "target_count": target_count, "upsert_count": upserts, "delete_count": deletes,
            }
        manifest["row_count"] = manifest["tables"][spec["primary_table"]]["target_count"]
        package.execute("CREATE TABLE _xdr_transfer_manifest(json TEXT NOT NULL)")
        package.execute("INSERT INTO _xdr_transfer_manifest VALUES(?)", [json.dumps(manifest, ensure_ascii=False)])
        package.commit()
        source.execute("CREATE TABLE IF NOT EXISTS _xdr_meta(key VARCHAR PRIMARY KEY,value VARCHAR NOT NULL)")
        source.execute("INSERT OR REPLACE INTO _xdr_meta VALUES('revision',?)", [target_revision])
        source.execute("CHECKPOINT")
    finally:
        package.close()
        source.close()

    with raw.open("rb") as incoming, gzip.open(compressed, "wb", compresslevel=6) as outgoing:
        shutil.copyfileobj(incoming, outgoing, length=4 * 1024 * 1024)
    digest = hashlib.sha256(compressed.read_bytes()).hexdigest()
    sha_path.write_text(f"{digest}  {compressed.name.removesuffix('.partial')}.ready\n")
    raw.unlink()
    return {"data": str(compressed), "sha": str(sha_path), "manifest": manifest,
            "compressed_bytes": compressed.stat().st_size,
            "changed_rows": sum(v["upsert_count"] + v["delete_count"] for v in manifest["tables"].values()),
            "primary_change_ratio": primary_change_ratio,
            "export_format": current_format}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--current", required=True, type=Path)
    parser.add_argument("--base", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--server-revision", required=True)
    parser.add_argument("--max-primary-change-ratio", type=float, default=0.35)
    parser.add_argument("--schema-file", type=Path,
                        default=Path(__file__).parents[1] / "shared/datasets.json")
    args = parser.parse_args()
    if not 0 < args.max_primary_change_ratio <= 1:
        raise ValueError("max primary change ratio must be in (0,1]")
    print(json.dumps(build(args.current, args.base, args.output_dir, args.job_id,
                           args.server_revision, args.schema_file,
                           args.max_primary_change_ratio), ensure_ascii=False))


if __name__ == "__main__":
    main()
