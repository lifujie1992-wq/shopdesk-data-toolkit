#!/usr/bin/env python3
"""Import a 聚水潭 商品利润分析（按 SKU）Excel export into retained SQLite."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sqlite3
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path

import fastexcel


COLUMNS = [
    ("SKU名称", "sku_name", "text"), ("颜色规格", "properties_value", "text"),
    ("SKU编码", "sku_id", "id"), ("款式编码", "spu_id", "id"),
    ("毛利", "gross_profit", "number"), ("毛利率", "gross_profit_rate", "percent"),
    ("商品毛利", "item_gross_profit", "number"),
    ("商品毛利率", "item_gross_profit_rate", "percent"),
    ("净销售成本", "net_sales_cost", "number"),
    ("净销售成本占净收入", "net_sales_cost_rate", "percent"),
    ("利润", "profit", "number"), ("利润环比", "profit_chain_rate", "percent"),
    ("利润变化说明", "profit_change_description", "text"),
    ("利润率", "profit_rate", "percent"),
    ("利润率变化", "profit_rate_change", "percent"),
    ("单位商品利润", "per_item_profit", "number"),
    ("净销售金额", "net_sales_amount", "number"),
    ("净销售件数", "net_sales_qty", "number"),
    ("销售金额", "sales_amount", "number"), ("商品收入", "item_revenue", "number"),
    ("运费收入", "freight_revenue", "number"), ("商品净成本", "net_item_cost", "number"),
    ("商品净成本占净销售成本", "net_item_cost_rate", "percent"),
    ("商品成本", "item_cost", "number"), ("退回成本", "returned_cost", "number"),
    ("发货前退回", "returned_before_shipment_cost", "number"),
    ("发货后退回", "returned_after_shipment_cost", "number"),
    ("已取消成本", "cancelled_cost", "number"), ("运费支出", "freight_cost", "number"),
    ("运费支出占净销售成本", "freight_cost_rate", "percent"),
    ("平台服务费", "platform_service_fee", "number"),
    ("平台服务费占净销售成本", "platform_service_fee_rate", "percent"),
    ("平台服务费结算金额", "platform_service_fee_settled", "number"),
    ("平台服务费预估金额", "platform_service_fee_estimated", "number"),
    ("营销支出", "marketing_cost", "number"),
    ("营销支出占净销售成本", "marketing_cost_rate", "percent"),
    ("达人佣金", "influencer_commission", "number"),
    ("团长佣金", "leader_commission", "number"),
    ("服务商佣金", "service_provider_commission", "number"),
    ("其他营销支出", "other_marketing_cost", "number"),
    ("营销支出返还", "marketing_cost_return", "number"),
    ("其他支出", "other_cost", "number"),
    ("其他支出占净销售成本", "other_cost_rate", "percent"),
    ("包装费", "packing_fee", "number"), ("包装费占净销售成本", "packing_fee_rate", "percent"),
    ("运费险", "freight_insurance", "number"),
    ("运费险占净销售成本", "freight_insurance_rate", "percent"),
    ("税金", "tax", "number"), ("税金占净销售成本", "tax_rate", "percent"),
    ("运费毛利", "freight_gross_profit", "number"),
    ("单位商品毛利", "per_item_gross_profit", "number"),
    ("特殊订单总费用", "special_order_total_fee", "number"),
    ("自定义费用", "custom_fee", "number"),
    ("商品创建时间", "product_created_at", "text"),
]

VALUE_COLUMNS = [name for _, name, _ in COLUMNS]
TEXT_COLUMNS = {name for _, name, kind in COLUMNS if kind in {"text", "id"}}
FOCUS_COLUMNS = [
    "high_profit_order_count", "high_gross_profit_order_count",
    "negative_profit_order_count", "negative_gross_profit_order_count",
    "product_loss_order_count", "freight_loss_order_count",
]
LABEL_COLUMNS = [
    "profit_status_label", "profit_change_label",
    "gross_profit_status_label", "gross_profit_change_label",
]
CRAWL_METRIC_COLUMNS = [
    ("gross_profit_chain_rate", "order_sku_gross_profit_chain"),
    ("gross_profit_change_amount", "order_sku_gross_profit_change"),
    ("gross_profit_rate_change", "order_sku_gross_profit_rate_change"),
    ("previous_gross_profit", "order_sku_gross_profit_lastperiod"),
    ("profit_change_amount", "order_sku_profit_change"),
    ("previous_profit", "order_sku_profit_lastperiod"),
]
API_FIELDS = [
    "sku_name", "properties_value", "sku_id", "i_id",
    "order_sku_gross_profit", "order_sku_gross_profit_rate",
    "order_item_gross_profit", "order_item_gross_profit_rate",
    "net_order_sku_cost", "net_order_sku_cost_pct", "order_sku_profit",
    "order_sku_profit_chain", "order_sku_profit_desc", "order_sku_profit_rate",
    "order_sku_profit_rate_change", "per_order_sku_profit", "net_order_item_amt",
    "net_order_item_qty", "total_income_amt", "order_item_amt", "order_item_freight",
    "net_sku_cost", "net_sku_cost_pct", "order_sku_cost",
    "afs_refund_order_item_cost", "afs_before_send_sku_cost",
    "afs_after_send_refund_sku_cost", "cancel_exp_afs_order_sku_cost",
    "order_sku_f_freight", "order_sku_f_freight_pct", "order_sku_commission",
    "order_sku_commission_pct", "order_sku_commission_settled",
    "order_sku_commission_esi", "common_commission", "common_commission_pct",
    "order_sku_anchor_common_commission", "order_sku_head_common_commission",
    "order_sku_partner_common_commission", "order_sku_other_common_commission",
    "marketing_fee_return", "other_fee", "other_fee_pct", "order_sku_packing_fee",
    "order_sku_packing_fee_pct", "order_sku_freight_insurance",
    "order_sku_freight_insurance_pct", "order_sku_taxes", "order_sku_taxes_pct",
    "order_item_freight_gross_profit", "per_order_sku_gross_profit",
    "special_order_total_fee", "self_define_fee", "goods_create_date",
]
if len(API_FIELDS) != len(COLUMNS):
    raise RuntimeError("profit analysis API/SQLite field mapping is incomplete")


def schema_sql() -> str:
    definitions = []
    for name in VALUE_COLUMNS:
        sql_type = "TEXT" if name in TEXT_COLUMNS else "REAL"
        nullable = " NOT NULL" if name == "sku_id" else ""
        definitions.append(f'"{name}" {sql_type}{nullable}')
    return f"""
      CREATE TABLE IF NOT EXISTS profit_analysis_runs(
        start_date TEXT NOT NULL,end_date TEXT NOT NULL,previous_start_date TEXT NOT NULL,
        previous_end_date TEXT NOT NULL,data_update_date TEXT NOT NULL,captured_at TEXT NOT NULL,
        source_name TEXT NOT NULL,source_sha256 TEXT NOT NULL,row_count INTEGER NOT NULL,
        complete INTEGER NOT NULL,PRIMARY KEY(start_date,end_date));
      CREATE TABLE IF NOT EXISTS sku_profit_analysis(
        start_date TEXT NOT NULL,end_date TEXT NOT NULL,{','.join(definitions)},
        high_profit_order_count INTEGER,high_gross_profit_order_count INTEGER,
        negative_profit_order_count INTEGER,negative_gross_profit_order_count INTEGER,
        product_loss_order_count INTEGER,freight_loss_order_count INTEGER,raw_json TEXT NOT NULL,
        PRIMARY KEY(start_date,end_date,sku_id));
      CREATE INDEX IF NOT EXISTS idx_sku_profit_analysis_sku ON sku_profit_analysis(sku_id,end_date);
      CREATE INDEX IF NOT EXISTS idx_sku_profit_analysis_spu ON sku_profit_analysis(spu_id,end_date);
    """


def blank(value) -> bool:
    return value is None or str(value).strip().lower() in {"", "-", "--", "—", "null", "none", "nan"}


def identifier(value):
    if blank(value):
        return None
    text = str(value).strip()
    if "e" not in text.lower() and not re.fullmatch(r"-?\d+\.0+", text):
        return text
    try:
        parsed = Decimal(text)
    except InvalidOperation:
        return text
    return str(int(parsed)) if parsed == parsed.to_integral_value() else text


def number(value, column):
    if blank(value):
        return None
    text = str(value).strip().replace(",", "")
    try:
        return float(Decimal(text))
    except InvalidOperation as exc:
        raise ValueError(f"invalid number in {column}: {value}") from exc


def percentage(value, column):
    if blank(value):
        return None
    text = str(value).strip().replace(",", "")
    has_percent = text.endswith("%")
    if has_percent:
        text = text[:-1].strip()
    try:
        parsed = Decimal(text)
    except InvalidOperation as exc:
        raise ValueError(f"invalid percentage in {column}: {value}") from exc
    return float(parsed / 100 if has_percent else parsed)


def infer_range(path: Path):
    days = re.findall(r"\d{4}-\d{2}-\d{2}", path.name)
    if len(days) < 2:
        return None, None
    return days[0], days[1]


def captured_at(path: Path) -> str:
    match = re.search(r"_(\d{14})(?:_|\.)", path.name)
    if not match:
        return datetime.now(timezone.utc).isoformat(timespec="seconds")
    local = datetime.strptime(match.group(1), "%Y%m%d%H%M%S").replace(
        tzinfo=timezone(timedelta(hours=8)))
    return local.isoformat(timespec="seconds")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def excel_rows(path: Path):
    reader = fastexcel.read_excel(path)
    sheet = reader.load_sheet(0, header_row=0, dtypes="string")
    frame = sheet.to_polars()
    expected = [source for source, _, _ in COLUMNS]
    missing = [column for column in expected if column not in frame.columns]
    if missing:
        raise ValueError(f"{path.name}: missing columns: {', '.join(missing)}")
    if len(frame.columns) != len(expected) or set(frame.columns) != set(expected):
        extras = [column for column in frame.columns if column not in expected]
        raise ValueError(f"{path.name}: expected exactly 54 columns; extra columns: {', '.join(extras)}")
    yield from frame.select(expected).iter_rows(named=True)


def transform(row):
    result = {}
    for source, target, kind in COLUMNS:
        value = row.get(source)
        if kind == "id":
            result[target] = identifier(value)
        elif kind == "number":
            result[target] = number(value, source)
        elif kind == "percent":
            result[target] = percentage(value, source)
        else:
            result[target] = None if blank(value) else str(value).strip()
    if not result["sku_id"]:
        raise ValueError("SKU编码 cannot be empty")
    return result


def load_focus_orders(path: Path, start_date: str, end_date: str):
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("format_version") not in {1, 2}:
        raise ValueError("focus-order export has an unsupported format_version")
    if payload.get("start_date") != start_date or payload.get("end_date") != end_date:
        raise ValueError("focus-order date range does not match the Excel export")
    rows = payload.get("rows")
    if not isinstance(rows, list) or payload.get("row_count") != len(rows):
        raise ValueError("focus-order row_count is invalid")
    result = {}
    for item in rows:
        sku_id = identifier(item.get("sku_id")) if isinstance(item, dict) else None
        if not sku_id or sku_id in result:
            raise ValueError(f"focus-order export has an empty or duplicate SKU: {sku_id}")
        counts = []
        for column in FOCUS_COLUMNS:
            value = item.get(column, 0)
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ValueError(f"focus-order {column} must be a nonnegative integer for SKU {sku_id}")
            counts.append(value)
        labels = tuple(item.get(column) for column in LABEL_COLUMNS)
        if any(value is not None and not isinstance(value, str) for value in labels):
            raise ValueError(f"focus-order labels must be strings for SKU {sku_id}")
        result[sku_id] = {"counts": tuple(counts), "labels": labels,
                          "raw": item.get("raw") if payload.get("format_version") == 2 else None}
    return payload, result


def ensure_focus_columns(connection):
    existing = {row[1] for row in connection.execute("PRAGMA table_info(sku_profit_analysis)")}
    for column in FOCUS_COLUMNS:
        if column not in existing:
            connection.execute(f'ALTER TABLE sku_profit_analysis ADD COLUMN "{column}" INTEGER')
    for column in LABEL_COLUMNS:
        if column not in existing:
            connection.execute(f'ALTER TABLE sku_profit_analysis ADD COLUMN "{column}" TEXT')
    for column, _ in CRAWL_METRIC_COLUMNS:
        if column not in existing:
            connection.execute(f'ALTER TABLE sku_profit_analysis ADD COLUMN "{column}" REAL')


def transform_api(row):
    if not isinstance(row, dict):
        raise ValueError("crawler row raw payload must be an object")
    result = {}
    for (source_name, target, kind), api_name in zip(COLUMNS, API_FIELDS):
        value = row.get(api_name)
        if kind == "id":
            result[target] = identifier(value)
        elif kind in {"number", "percent"}:
            result[target] = number(value, api_name)
        else:
            result[target] = None if blank(value) else str(value).strip()
    if not result["sku_id"]:
        raise ValueError("crawler SKU编码 cannot be empty")
    return result


def import_export(xlsx: Path | None, output: Path, base: Path | None, start_date: str, end_date: str,
                  focus_orders_path: Path | None = None, crawl_path: Path | None = None):
    start = date.fromisoformat(start_date)
    end = date.fromisoformat(end_date)
    if start > end:
        raise ValueError("start date must not be after end date")
    period = (end - start).days + 1
    previous_start = start - timedelta(days=period)
    previous_end = start - timedelta(days=1)
    building = Path(f"{output}.building")
    if building.exists():
        building.unlink()
    output.parent.mkdir(parents=True, exist_ok=True)
    if base and base.is_file():
        shutil.copy2(base, building)
    connection = sqlite3.connect(building)
    try:
        connection.executescript(schema_sql())
        ensure_focus_columns(connection)
        focus_payload, focus_orders = (load_focus_orders(focus_orders_path, start_date, end_date)
                                       if focus_orders_path else (None, None))
        if crawl_path:
            crawl_payload, crawl_orders = load_focus_orders(crawl_path, start_date, end_date)
            if crawl_payload.get("format_version") != 2:
                raise ValueError("crawler input must use format_version 2")
            focus_payload, focus_orders = crawl_payload, crawl_orders
        connection.execute("BEGIN")
        connection.execute("DELETE FROM sku_profit_analysis WHERE start_date=? AND end_date=?",
                           (start_date, end_date))
        columns = ["start_date", "end_date", *VALUE_COLUMNS, *FOCUS_COLUMNS,
                   *LABEL_COLUMNS, *(name for name, _ in CRAWL_METRIC_COLUMNS), "raw_json"]
        placeholders = ",".join("?" for _ in columns)
        sql = f'INSERT INTO sku_profit_analysis({",".join(columns)}) VALUES({placeholders})'
        count = 0
        excel_skus = set()
        source_rows = ([item["raw"] for item in focus_orders.values()] if crawl_path
                       else excel_rows(xlsx))
        for source_row in source_rows:
            row = transform_api(source_row) if crawl_path else transform(source_row)
            if row["sku_id"] in excel_skus:
                raise ValueError(f"Excel export has duplicate SKU: {row['sku_id']}")
            excel_skus.add(row["sku_id"])
            extra = focus_orders.get(row["sku_id"]) if focus_orders is not None else None
            focus = extra["counts"] if extra else (None,) * len(FOCUS_COLUMNS)
            labels = extra["labels"] if extra else (None, None, None, None)
            crawl_metrics = tuple(number(source_row.get(api_name), api_name)
                                  for _, api_name in CRAWL_METRIC_COLUMNS) if crawl_path else (None,) * len(CRAWL_METRIC_COLUMNS)
            connection.execute(sql, [start_date, end_date, *(row[name] for name in VALUE_COLUMNS),
                                     *focus, *labels, *crawl_metrics,
                                     json.dumps(source_row, ensure_ascii=False, separators=(",", ":"))])
            count += 1
        if count == 0:
            raise ValueError("Excel export contains no data rows")
        if focus_orders is not None and set(focus_orders) != excel_skus:
            missing = len(excel_skus - set(focus_orders))
            extra = len(set(focus_orders) - excel_skus)
            raise ValueError(f"focus-order SKU coverage mismatch: missing={missing}, extra={extra}")
        source_path = crawl_path or xlsx
        captured = (focus_payload.get("captured_at") if crawl_path else captured_at(source_path))
        connection.execute("""
          INSERT INTO profit_analysis_runs(
            start_date,end_date,previous_start_date,previous_end_date,data_update_date,captured_at,
            source_name,source_sha256,row_count,complete) VALUES(?,?,?,?,?,?,?,?,?,1)
          ON CONFLICT(start_date,end_date) DO UPDATE SET
            previous_start_date=excluded.previous_start_date,previous_end_date=excluded.previous_end_date,
            data_update_date=excluded.data_update_date,captured_at=excluded.captured_at,
            source_name=excluded.source_name,source_sha256=excluded.source_sha256,
            row_count=excluded.row_count,complete=1
        """, (start_date, end_date, previous_start.isoformat(), previous_end.isoformat(), end_date,
              captured, source_path.name, sha256(source_path), count))
        connection.commit()
        if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("SQLite integrity check failed")
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()
    building.replace(output)
    return {"start_date": start_date, "end_date": end_date, "row_count": count,
            "output": str(output.resolve()), "source": source_path.name,
            "parser": "crawler-json" if crawl_path else "fastexcel",
            "focus_orders": focus_orders is not None}


def main():
    parser = argparse.ArgumentParser()
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--xlsx", type=Path)
    source.add_argument("--crawl-json", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--base", type=Path)
    parser.add_argument("--focus-orders", type=Path)
    parser.add_argument("--start-date")
    parser.add_argument("--end-date")
    args = parser.parse_args()
    if args.xlsx and not args.xlsx.is_file():
        raise ValueError(f"xlsx input does not exist: {args.xlsx}")
    if args.crawl_json and not args.crawl_json.is_file():
        raise ValueError(f"crawler input does not exist: {args.crawl_json}")
    if args.focus_orders and not args.focus_orders.is_file():
        raise ValueError(f"focus-order input does not exist: {args.focus_orders}")
    inferred_start, inferred_end = infer_range(args.xlsx or args.crawl_json)
    start_date = args.start_date or inferred_start
    end_date = args.end_date or inferred_end
    if not start_date or not end_date:
        raise ValueError("--start-date and --end-date are required when the filename has no date range")
    print(json.dumps(import_export(args.xlsx, args.output, args.base, start_date, end_date,
                                   args.focus_orders, args.crawl_json),
                     ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
