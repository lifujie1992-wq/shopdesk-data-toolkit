#!/usr/bin/env python3
"""Build balanced shop-product export batches from the latest published snapshot."""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path

import duckdb


def inventory_shops(path: Path) -> list[str]:
    with sqlite3.connect(path) as db:
        rows = db.execute(
            "SELECT shop_id FROM shop_directory WHERE shop_id <> '0' ORDER BY shop_id"
        ).fetchall()
    shops = [str(row[0]) for row in rows if str(row[0]).isdigit()]
    if not shops:
        raise ValueError("inventory shop directory is empty")
    return shops


def previous_counts(
    path: Path | None,
) -> tuple[
    dict[str, int],
    dict[tuple[str, int], int],
    dict[tuple[str, int], list[tuple[int, int]]],
]:
    if not path or not path.is_file():
        return {}, {}, {}
    db = duckdb.connect(str(path), read_only=True)
    try:
        totals = {
            str(shop_id): int(count)
            for shop_id, count in db.execute(
                "SELECT shop_id,count(*) FROM shop_product_skus GROUP BY shop_id"
            ).fetchall()
        }
        by_listing = {
            (str(shop_id), int(is_listed)): int(count)
            for shop_id, is_listed, count in db.execute(
                """SELECT shop_id,is_listed,count(*) FROM shop_product_skus
                   WHERE is_listed IN (0,1) GROUP BY shop_id,is_listed"""
            ).fetchall()
        }
        stock_counts: dict[tuple[str, int], list[tuple[int, int]]] = {}
        for shop_id, is_listed, stock, count in db.execute(
            """SELECT shop_id,is_listed,shop_stock,count(*) FROM shop_product_skus
               WHERE is_listed IN (0,1) AND shop_stock IS NOT NULL
               GROUP BY shop_id,is_listed,shop_stock ORDER BY shop_id,is_listed,shop_stock"""
        ).fetchall():
            stock_counts.setdefault((str(shop_id), int(is_listed)), []).append(
                (int(stock), int(count))
            )
        return totals, by_listing, stock_counts
    finally:
        db.close()


def filtered_batches(
    shop_id: str,
    listed: int,
    rows: int,
    stocks: list[tuple[int, int]],
    max_filtered_rows: int,
) -> list[dict]:
    base = [{"k": "enabled", "v": str(listed), "c": "="}]
    if rows <= max_filtered_rows:
        return [{"shops": [shop_id], "estimated_rows": rows, "filters": base}]
    if sum(count for _, count in stocks) != rows:
        raise ValueError(
            f"shop {shop_id} listing partition {listed} has null or incomplete stock data"
        )

    target = max_filtered_rows * 4 // 5
    groups: list[tuple[int, int]] = []
    current_rows = 0
    current_max = 0
    for stock, count in stocks:
        if count > max_filtered_rows:
            raise ValueError(
                f"shop {shop_id} has {count} rows at stock value {stock}; cannot split safely"
            )
        if current_rows and current_rows + count > target:
            groups.append((current_max, current_rows))
            current_rows = 0
        current_rows += count
        current_max = stock
    if current_rows:
        groups.append((current_max, current_rows))
    if any(count > max_filtered_rows for _, count in groups):
        raise ValueError(f"shop {shop_id} stock partition exceeds the filtered-export limit")

    batches = []
    for index, (upper, count) in enumerate(groups):
        filters = list(base)
        if index > 0:
            filters.append({
                "k": "shop_qty", "v": str(groups[index - 1][0] + 1), "c": ">="
            })
        if index < len(groups) - 1:
            filters.append({"k": "shop_qty", "v": str(upper), "c": "<="})
        batches.append({"shops": [shop_id], "estimated_rows": count, "filters": filters})
    return batches


def plan(inventory: Path, baseline: Path | None, target_rows: int,
         max_single_rows: int, max_filtered_rows: int) -> dict:
    shops = inventory_shops(inventory)
    counts, listing_counts, stock_counts = previous_counts(baseline)
    weighted = sorted(((shop, counts.get(shop, 0)) for shop in shops), key=lambda row: (-row[1], row[0]))
    batches: list[dict] = []
    for shop_id, rows in weighted:
        if rows > max_single_rows:
            parts = [(listed, listing_counts.get((shop_id, listed), 0)) for listed in (0, 1)]
            if not all(count > 0 for _, count in parts) or sum(count for _, count in parts) != rows:
                raise ValueError(
                    f"shop {shop_id} exceeds the single-export limit but cannot be split completely"
                )
            for listed, count in parts:
                batches.extend(filtered_batches(
                    shop_id,
                    listed,
                    count,
                    stock_counts.get((shop_id, listed), []),
                    max_filtered_rows,
                ))
            continue
        if rows >= target_rows:
            batches.append({"shops": [shop_id], "estimated_rows": rows})
            continue
        eligible = [
            batch for batch in batches
            if batch["estimated_rows"] < target_rows and not batch.get("filters")
        ]
        batch = min(eligible, key=lambda item: item["estimated_rows"], default=None)
        if batch is None or batch["estimated_rows"] + rows > target_rows:
            batches.append({"shops": [shop_id], "estimated_rows": rows})
        else:
            batch["shops"].append(shop_id)
            batch["estimated_rows"] += rows
    for batch in batches:
        batch["shops"].sort()
    return {
        "version": 2,
        "target_rows": target_rows,
        "max_single_rows": max_single_rows,
        "max_filtered_rows": max_filtered_rows,
        "shop_count": len(shops),
        "known_shop_count": sum(shop in counts for shop in shops),
        "estimated_rows": sum(counts.get(shop, 0) for shop in shops),
        "batches": batches,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--inventory", required=True, type=Path)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--target-rows", type=int, default=900_000)
    parser.add_argument("--max-single-rows", type=int, default=950_000)
    parser.add_argument("--max-filtered-rows", type=int, default=550_000)
    args = parser.parse_args()
    if args.target_rows < 100_000:
        raise ValueError("target rows is too small")
    if args.max_single_rows < args.target_rows:
        raise ValueError("max single rows cannot be smaller than target rows")
    if args.max_filtered_rows < 100_000 or args.max_filtered_rows >= 600_000:
        raise ValueError("max filtered rows must be between 100000 and 599999")
    result = plan(
        args.inventory,
        args.baseline,
        args.target_rows,
        args.max_single_rows,
        args.max_filtered_rows,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
