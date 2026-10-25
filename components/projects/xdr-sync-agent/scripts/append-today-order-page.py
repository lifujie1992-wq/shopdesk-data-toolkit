#!/usr/bin/env python3
"""Atomically append a complete pay-date order-page snapshot to paid-order ODS."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sqlite3
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo


SHANGHAI = ZoneInfo("Asia/Shanghai")


def file_hash(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def influencer(item: dict) -> tuple[str, str]:
    identifier = item.get("referrer_id") or item.get("influencer_id") or item.get("talent_id")
    name = item.get("referrer_name") or item.get("influencer_name") or item.get("talent_name")
    extension = item.get("item_ext_data")
    if isinstance(extension, str):
        try:
            extension = json.loads(extension)
        except (TypeError, ValueError):
            extension = None
    if isinstance(extension, dict) and extension.get("role_type") == "达人":
        identifier = identifier or extension.get("carrierId") or extension.get("carrier_id")
        name = name or extension.get("carrier_name")
    return str(identifier or ""), str(name or "")


def local_timestamp(value: str | None) -> str | None:
    """Convert an ISO capture timestamp to the order page's Shanghai wall time."""
    if not value:
        return None
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=SHANGHAI)
    return parsed.astimezone(SHANGHAI).strftime("%Y-%m-%d %H:%M:%S")


def inventory_catalog(
    path: Path | None,
) -> tuple[dict[str, list[tuple[str, str]]], str | None, str | None]:
    if not path:
        return {}, None, None
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as database:
        catalog: dict[str, list[tuple[str, str]]] = {}
        for spu_id, sku_id, properties in database.execute(
                "SELECT spu_id,sku_id,properties_value FROM sku_inventory"):
            catalog.setdefault(str(spu_id), []).append((str(sku_id), str(properties or "")))
        completed_at = database.execute("SELECT completed_at FROM export_info WHERE id=1").fetchone()
    captured_at = str(completed_at[0]) if completed_at and completed_at[0] else None
    return catalog, local_timestamp(captured_at), captured_at


def normalized(value: object) -> str:
    return str(value or "").replace("_x002B_", "+").strip()


def comparable(value: object) -> str:
    return re.sub(r"[\s()（）;:：+_\-/]", "", normalized(value).lower()).replace("色", "")


def component_spus(item: dict, source_spu: object) -> list[str]:
    style = normalized(source_spu)
    if item.get("sku_type") != "combine" and not style.endswith("组"):
        return []
    style = re.sub(r"组$", "", style)
    result = [part.strip() for part in style.split("+") if part.strip()]
    return result if len(result) > 1 else []


def component_sku(spu_id: str, source_sku: object, properties: object,
                  catalog: dict[str, list[tuple[str, str]]]) -> str | None:
    candidates = catalog.get(spu_id, [])
    if not candidates:
        return None
    if len(candidates) == 1:
        return candidates[0][0]
    haystack = normalized(source_sku) + ";" + normalized(properties)
    comparable_haystack = comparable(haystack)
    size = ""
    match = re.search(r"尺码(?:大小)?\s*:\s*([^;(]+)", haystack)
    if match:
        size = match.group(1).strip()
    if not size:
        size = normalized(source_sku).rsplit("-", 1)[-1].strip()
    scored = []
    for sku_id, candidate_properties in candidates:
        tokens = [token.strip() for token in normalized(candidate_properties).split(";") if token.strip()]
        score = (100 if size and (sku_id.endswith("-" + size) or size in tokens) else 0)
        score += sum(10 for token in tokens if len(token) > 1 and token in haystack)
        score += sum(30 for token in tokens if len(comparable(token)) > 1
                     and comparable(token) in comparable_haystack)
        scored.append((score, sku_id))
    scored.sort(reverse=True)
    if not scored or scored[0][0] == 0 or (len(scored) > 1 and scored[0][0] == scored[1][0]):
        return None
    return scored[0][1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ods", required=True, type=Path)
    parser.add_argument("--today", required=True, type=Path)
    parser.add_argument("--business-date", required=True, type=date.fromisoformat)
    parser.add_argument("--inventory", type=Path,
                        help="coherent SPU/SKU snapshot used for combo expansion and cutoff")
    args = parser.parse_args()
    source = sqlite3.connect(f"file:{args.today}?mode=ro", uri=True)
    source.row_factory = sqlite3.Row
    metadata = source.execute("SELECT * FROM sync_metadata WHERE id=1").fetchone()
    if (not metadata or not metadata["finished_at"] or metadata["day"] != args.business_date.isoformat()
            or metadata["date_field"] != "pay_date"
            or metadata["expected_count"] != metadata["unique_count"]
            or metadata["fetched_count"] != metadata["unique_count"]):
        raise ValueError("today_paid_snapshot_is_not_complete")
    # Inventory defines the coherent cutoff, so it must cover this business day.
    # Check before copying/mutating ODS: yesterday's cutoff would discard every
    # current-day order while disguising the dependency failure as an empty day.
    catalog, inventory_cutoff, inventory_captured_at = inventory_catalog(args.inventory)
    day = args.business_date.isoformat()
    if args.inventory and (not inventory_cutoff or inventory_cutoff[:10] < day):
        source.close()
        raise ValueError("inventory_snapshot_before_business_date: "
                         f"business_date={day}, inventory_cutoff={inventory_cutoff}, "
                         "refresh_inventory_first")
    metadata_columns = set(metadata.keys())
    page_cutoff = metadata["upper_bound"] if "upper_bound" in metadata_columns else None
    effective_cutoff = min(filter(None, (page_cutoff, inventory_cutoff)), default=None)
    # A newer inventory snapshot must not advance the timestamp of older orders.
    captured_at = (inventory_captured_at if inventory_cutoff and effective_cutoff == inventory_cutoff
                   else metadata["finished_at"])
    building = args.ods.with_name(f".{args.ods.name}.{uuid.uuid4()}.building")
    shutil.copy2(args.ods, building)
    target = sqlite3.connect(building)
    target.execute("PRAGMA journal_mode=OFF")
    target.execute("PRAGMA synchronous=OFF")
    batch = target.execute(
        "SELECT batch_id,business_date,start_date,end_date,manifest_json "
        "FROM export_batches WHERE complete=1"
    ).fetchone()
    if not batch:
        raise ValueError("ods_complete_batch_missing")
    old_business = date.fromisoformat(batch[1])
    if args.business_date < old_business:
        raise ValueError("ods_business_date_cannot_move_backwards")
    batch_id = batch[0]
    digest = file_hash(args.today)
    shard_id = digest[:24]
    start = (args.business_date - timedelta(days=30)).isoformat()
    target.execute("UPDATE export_batches SET complete=0 WHERE batch_id=?", (batch_id,))
    target.execute("DELETE FROM paid_order_items_raw WHERE batch_id=? AND biz_date=?", (batch_id, day))
    target.execute("DELETE FROM export_coverage WHERE batch_id=? AND biz_date=?", (batch_id, day))
    target.execute("DELETE FROM export_shards WHERE batch_id=? AND effective_start=? AND effective_end=?",
                   (batch_id, day, day))
    shop_platform = {}
    for shop_id, platform, _count in target.execute("""SELECT shop_id,platform,count(*) AS n
          FROM paid_order_items_raw WHERE batch_id=? AND biz_date<? AND shop_id<>'' AND platform<>''
         GROUP BY shop_id,platform ORDER BY shop_id,n DESC""", (batch_id, day)):
        shop_platform.setdefault(str(shop_id), str(platform))
    count = skipped_cancelled = skipped_after_cutoff = expanded_combos = unresolved_combos = 0
    query = """SELECT o.o_id,o.pay_date,o.status,o.shop_id,o.shop_name,o.shop_site,o.so_id,o.labels,
                      i.position,i.sku_id,i.i_id,i.shop_sku_id,i.shop_i_id,i.qty,i.json
                 FROM order_items i JOIN orders o USING(o_id)
                WHERE o.pay_date IS NOT NULL"""
    for row in source.execute(query):
        if str(row["status"] or "") in {"取消", "已取消"}:
            skipped_cancelled += 1
            continue
        if effective_cutoff and str(row["pay_date"]) > effective_cutoff:
            skipped_after_cutoff += 1
            continue
        item = json.loads(row["json"] or "{}")
        influencer_id, influencer_name = influencer(item)
        labels = ",".join(filter(None, (str(row["labels"] or ""), str(item.get("item_labels") or ""))))
        link_id = str(row["shop_i_id"] or row["shop_sku_id"] or "-1")
        shop_id = str(row["shop_id"] or "")
        source_platform = str(row["shop_site"] or "")
        platform = shop_platform.get(shop_id, source_platform)
        sales_amount = item.get("item_pay_amount")
        if sales_amount is None:
            sales_amount = item.get("amount")
        components = component_spus(item, row["i_id"])
        expanded = []
        if components:
            for component in components:
                sku_id = component_sku(component, row["sku_id"], item.get("properties_value"), catalog)
                if sku_id:
                    expanded.append((component, sku_id))
            if len(expanded) == len(components):
                expanded_combos += 1
            else:
                expanded = [(str(row["i_id"] or ""), str(row["sku_id"] or ""))]
                unresolved_combos += 1
        else:
            expanded = [(str(row["i_id"] or ""), str(row["sku_id"] or ""))]
        for spu_id, sku_id in expanded:
            target.execute("INSERT INTO paid_order_items_raw VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
                batch_id, shard_id, count + 1, day, str(row["pay_date"]), platform,
                shop_id, str(row["shop_name"] or ""), spu_id, sku_id, link_id,
                str(row["shop_sku_id"] or ""), float(row["qty"] or 0), str(row["o_id"]),
                str(row["so_id"] or ""), str(item.get("oi_id") or ""), labels,
                influencer_id, influencer_name, sales_amount, item.get("refund_qty"),
                item.get("refund_amount"), item.get("gross_margin"),
                json.dumps({"source_platform": source_platform,
                            **({"combine_spu_id": normalized(row["i_id"]),
                                "combine_sku_id": normalized(row["sku_id"])} if components else {})},
                           ensure_ascii=False, separators=(",", ":"))))
            count += 1
    source.close()
    if count == 0:
        target.close()
        building.unlink(missing_ok=True)
        raise ValueError("today_paid_snapshot_has_no_items: "
                         f"orders={metadata['unique_count']}, skipped_cancelled={skipped_cancelled}, "
                         f"skipped_after_cutoff={skipped_after_cutoff}, effective_cutoff={effective_cutoff}")
    target.execute("DELETE FROM paid_order_items_raw WHERE batch_id=? AND biz_date<?", (batch_id, start))
    target.execute("DELETE FROM export_coverage WHERE batch_id=? AND biz_date<?", (batch_id, start))
    target.execute("INSERT INTO export_shards VALUES(?,?,?,?,?,?,?,1)", (
        batch_id, shard_id, args.today.name, digest, day, day, count))
    target.execute("INSERT INTO export_coverage VALUES(?,?,?)", (batch_id, day, shard_id))
    target.execute("""UPDATE export_shards SET row_count=(
        SELECT count(*) FROM paid_order_items_raw r
         WHERE r.batch_id=export_shards.batch_id AND r.shard_id=export_shards.shard_id)
        WHERE batch_id=?""", (batch_id,))
    target.execute("DELETE FROM export_shards WHERE batch_id=? AND row_count=0", (batch_id,))
    manifest = [{"file": row[0], "sha256": row[1], "rows": row[4],
                 "effective_start": row[2], "effective_end": row[3],
                 **({"source": "common_order_page_pay_date"} if row[0] == args.today.name else {})}
                for row in target.execute(
                    "SELECT source_name,source_sha256,effective_start,effective_end,row_count "
                    "FROM export_shards WHERE batch_id=? ORDER BY effective_start,source_name", (batch_id,))]
    target.execute("""UPDATE export_batches
        SET business_date=?,start_date=?,end_date=?,captured_at=?,complete=1,manifest_json=?
        WHERE batch_id=?""", (
        day, start, day, captured_at,
        json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), batch_id))
    target.commit()
    target.close()
    os.replace(building, args.ods)
    print(json.dumps({"batch_id": batch_id, "orders": metadata["unique_count"], "item_rows": count,
                      "captured_at": captured_at, "page_cutoff": page_cutoff,
                      "effective_cutoff": effective_cutoff,
                      "inventory_cutoff": inventory_cutoff, "expanded_combos": expanded_combos,
                      "unresolved_combos": unresolved_combos, "skipped_cancelled": skipped_cancelled,
                      "skipped_after_cutoff": skipped_after_cutoff, "output": str(args.ods)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
