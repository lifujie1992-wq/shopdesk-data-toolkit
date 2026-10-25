#!/usr/bin/env python3
"""Copy only paid-order ODS tables into a compact, independently checked SQLite file."""

from __future__ import annotations

import argparse
import os
import sqlite3
from pathlib import Path


TABLES = ("export_batches", "export_shards", "export_coverage", "paid_order_items_raw", "_xdr_meta")


def quote(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def compact(source: Path, output: Path) -> dict[str, int]:
    source, output = source.resolve(), output.resolve()
    if not source.is_file():
        raise ValueError(f"source does not exist: {source}")
    if output.exists():
        raise ValueError(f"output already exists: {output}")
    src = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    dst = sqlite3.connect(output)
    try:
        src.row_factory = sqlite3.Row
        definitions = src.execute(
            "SELECT type,name,tbl_name,sql FROM sqlite_master "
            f"WHERE sql IS NOT NULL AND ((type='table' AND name IN ({','.join('?' for _ in TABLES)})) "
            f"OR (type='index' AND tbl_name IN ({','.join('?' for _ in TABLES)}))) "
            "ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END,name",
            (*TABLES, *TABLES),
        ).fetchall()
        table_sql = {row["name"]: row["sql"] for row in definitions if row["type"] == "table"}
        missing = set(TABLES) - set(table_sql)
        if missing:
            raise ValueError(f"source is missing ODS tables: {sorted(missing)}")
        dst.execute("PRAGMA journal_mode=OFF")
        dst.execute("PRAGMA synchronous=OFF")
        for table in TABLES:
            dst.execute(table_sql[table])
        source_sql = str(source).replace("'", "''")
        dst.execute(f"ATTACH DATABASE '{source_sql}' AS source")
        counts = {}
        for table in TABLES:
            dst.execute(f"INSERT INTO {quote(table)} SELECT * FROM source.{quote(table)}")
            counts[table] = dst.execute(f"SELECT count(*) FROM {quote(table)}").fetchone()[0]
            expected = src.execute(f"SELECT count(*) FROM {quote(table)}").fetchone()[0]
            if counts[table] != expected:
                raise ValueError(f"row count mismatch for {table}")
        for row in definitions:
            if row["type"] == "index":
                dst.execute(row["sql"])
        dst.commit()
        if dst.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("compacted ODS integrity check failed")
        dst.close()
        dst = None
        with open(output, "rb") as handle:
            os.fsync(handle.fileno())
        return counts
    except Exception:
        output.unlink(missing_ok=True)
        raise
    finally:
        src.close()
        if dst is not None:
            dst.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    print(compact(args.source, args.output))


if __name__ == "__main__":
    main()
