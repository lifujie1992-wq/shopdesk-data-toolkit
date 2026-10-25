#!/usr/bin/env python3
"""验证本地 profit facts 事实库，不上传、不修改生产配置。"""
import argparse
import json
import sqlite3
from collections import Counter, defaultdict
from decimal import Decimal, InvalidOperation
from pathlib import Path


def money(v):
    if v in (None, ""):
        return None
    try:
        return f"{Decimal(str(v)):.2f}"
    except InvalidOperation:
        return None


def qty(v):
    if v in (None, ""):
        return None
    try:
        d = Decimal(str(v))
        return str(int(d)) if d == int(d) else str(d).rstrip("0").rstrip(".")
    except InvalidOperation:
        return None


def cost(v):
    m = money(v)
    if m is None:
        return None
    return m if Decimal(m) > 0 else None


def conn(path):
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    return db


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--facts", required=True)
    ap.add_argument("--orders", required=True)
    ap.add_argument("--aftersales", required=True)
    ap.add_argument("--schema", required=True)
    ap.add_argument("--report", required=True)
    args = ap.parse_args()

    facts = conn(args.facts)
    orders = conn(args.orders)
    aft = conn(args.aftersales)
    contract = json.loads(Path(args.schema).read_text())
    expected = contract["datasets"]["profit_facts"]["tables"]
    checks = []
    warnings = []
    details = {}

    def check(name, ok, detail):
        checks.append((name, bool(ok), detail))

    # 契约字段和 SQLite 主键
    for table, spec in expected.items():
        cols = [r[1] for r in facts.execute(f'PRAGMA table_info("{table}")')]
        pks = [r[1] for r in sorted(facts.execute(f'PRAGMA table_info("{table}")').fetchall(), key=lambda x: x[5]) if r[5]]
        check(f"schema.columns.{table}", cols == spec["columns"], f"expected={len(spec['columns'])}, actual={len(cols)}")
        check(f"schema.pk.{table}", pks == spec["pk"], f"expected={spec['pk']}, actual={pks}")

    tables = list(expected)
    counts = {t: facts.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for t in tables}
    details["counts"] = counts

    # 主键唯一性（事实库已建 SQLite PK，仍显式检查）
    key_map = {
        "batch_runs": ["batch_id", "dataset"],
        "order_profit_facts": ["order_item_id"],
        "shipment_package_items": ["package_id", "order_item_id"],
        "aftersale_events": ["as_event_id"],
        "order_fee_ledger": ["fee_record_id"],
    }
    for table, keys in key_map.items():
        expr = ",".join(f'"{k}"' for k in keys)
        total = facts.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
        distinct = facts.execute(f'SELECT COUNT(*) FROM (SELECT DISTINCT {expr} FROM "{table}")').fetchone()[0]
        check(f"pk.unique.{table}", total == distinct, f"rows={total}, distinct={distinct}")

    # 订单商品明细逐行对账
    source_orders = orders.execute("SELECT * FROM order_item_details").fetchall()
    fact_orders = {r["order_item_id"]: r for r in facts.execute("SELECT * FROM order_profit_facts")}
    source_order_map = {r["row_key"]: r for r in source_orders}
    missing = [k for k in source_order_map if k not in fact_orders]
    extra = [k for k in fact_orders if k not in source_order_map]
    check("orders.row_key.coverage", not missing and not extra, f"source={len(source_order_map)}, facts={len(fact_orders)}, missing={len(missing)}, extra={len(extra)}")

    paid_bad = []
    cost_bad = []
    channel_bad = []
    for key, src in source_order_map.items():
        out = fact_orders.get(key)
        if not out:
            continue
        if out["item_paid_amount"] != money(src["base_amount"]):
            paid_bad.append(key)
        if out["cost_amount"] != cost(src["sku_cost"]):
            cost_bad.append(key)
        labels = src["labels"]
        expected_channel = "unknown" if not labels else ("creator" if "精选联盟" in labels else "normal")
        if out["channel"] != expected_channel:
            channel_bad.append(key)
    check("orders.item_paid_amount=base_amount", not paid_bad, f"mismatch={len(paid_bad)}")
    check("orders.cost_amount=sku_cost", not cost_bad, f"mismatch={len(cost_bad)}")
    check("orders.channel=labels", not channel_bad, f"mismatch={len(channel_bad)}")
    details["channel"] = dict(facts.execute("SELECT channel, COUNT(*) FROM order_profit_facts GROUP BY channel").fetchall())
    details["cost_non_null"] = facts.execute("SELECT COUNT(*) FROM order_profit_facts WHERE cost_amount IS NOT NULL").fetchone()[0]

    # 运费分摊：源数据按订单校验；输出包裹骨架按 package_id 校验
    src_freight = defaultdict(lambda: {"shares": Decimal("0"), "cost": None, "n": 0})
    for r in source_orders:
        if r["freight_price_share"] in (None, "") or r["freight_cost"] in (None, ""):
            continue
        x = src_freight[str(r["o_id"])]
        x["shares"] += Decimal(str(r["freight_price_share"]))
        x["cost"] = Decimal(str(r["freight_cost"]))
        x["n"] += 1
    freight_ok = sum(1 for x in src_freight.values() if x["shares"] == x["cost"])
    check("source.freight_price_share=sum freight_cost", freight_ok == len(src_freight), f"matched={freight_ok}/{len(src_freight)}")

    pkg = defaultdict(lambda: {"alloc": Decimal("0"), "total": None})
    for r in facts.execute("SELECT package_id, package_fee_total, package_fee_alloc FROM shipment_package_items"):
        if r["package_fee_alloc"] in (None, ""):
            continue
        x = pkg[r["package_id"]]
        x["alloc"] += Decimal(str(r["package_fee_alloc"]))
        if r["package_fee_total"] not in (None, ""):
            x["total"] = Decimal(str(r["package_fee_total"]))
    pkg_ok = sum(1 for x in pkg.values() if x["total"] is not None and x["alloc"] == x["total"])
    check("facts.package_fee_alloc=sum package_fee_total", pkg_ok == len(pkg), f"matched={pkg_ok}/{len(pkg)}")

    # 包裹号不得造假：缺失 l_id 必须落显式 unassigned 桶
    fake_pkg = facts.execute(
        "SELECT COUNT(*) FROM shipment_package_items "
        "WHERE package_id IS NULL OR package_id IN ('','0','0000','None','null')"
    ).fetchone()[0]
    check("shipments.no_fake_package_id", fake_pkg == 0, f"fake={fake_pkg}")
    bad_unassigned = facts.execute(
        "SELECT COUNT(*) FROM shipment_package_items WHERE package_id='(unassigned)' "
        "AND (fee_status!='unassigned' OR package_count!='0' OR package_fee_total IS NOT NULL)"
    ).fetchone()[0]
    check("shipments.unassigned_marked", bad_unassigned == 0, f"bad={bad_unassigned}")

    # 售后：只去除整行重复，实际退款来自主表，绝不由申请金额兜底
    item_rows = aft.execute("SELECT * FROM aftersale_item_details").fetchall()
    all_hashes = Counter()
    for r in item_rows:
        all_hashes[(r["售后单号"], r["售后商品明细编号"], tuple(r))] += 1
    duplicate_excess = sum(n - 1 for n in all_hashes.values() if n > 1)
    out_after = list(facts.execute("SELECT * FROM aftersale_events"))
    check("aftersales.only_full-row-duplicates-removed", len(item_rows) - duplicate_excess == len(out_after), f"source={len(item_rows)}, duplicate_excess={duplicate_excess}, facts={len(out_after)}")

    main_by_as = {r["售后单号"]: r for r in aft.execute("SELECT * FROM aftersale_details")}
    status_bad = []
    item_key_seen = set()
    for r in out_after:
        item_key_seen.add(r["as_item_id"])
        applied = Decimal(r["refund_applied_amount"]) if r["refund_applied_amount"] not in (None, "") else None
        actual = Decimal(r["refund_actual_amount"]) if r["refund_actual_amount"] not in (None, "") else None
        expected_status = "settled" if actual is not None and actual != 0 else ("pending" if applied is not None and applied != 0 else "unknown")
        if r["refund_status"] != expected_status:
            status_bad.append(r["as_event_id"])
    # 单组件售后单：分摊额必须等于订单级原值（多组件由 refund_actual_conserved 保证守恒）
    per_order = Counter(r["as_id"] for r in out_after)
    single_bad = [
        r["as_event_id"] for r in out_after
        if per_order[r["as_id"]] == 1
        and r["refund_actual_order_amount"] is not None
        and r["refund_actual_amount"] != r["refund_actual_order_amount"]
    ]
    check("aftersales.single_item_actual_equals_order", not single_bad, f"mismatch={len(single_bad)}")
    check("aftersales.refund_status.independent", not status_bad, f"mismatch={len(status_bad)}")
    check("aftersales.as_item_id.non_null_unique", all(k not in (None, "") for k in item_key_seen) and len(item_key_seen) == len(out_after), f"rows={len(out_after)}, distinct={len(item_key_seen)}")

    # as_item_id 必须忠实还原源 asiId（踩过 rstrip(".0") 把 623063800 截成 6230638 的坑）
    raw_asi = {str(r[0]).strip() for r in aft.execute("SELECT DISTINCT 售后商品明细编号 FROM aftersale_item_details")}
    norm_asi = {v[:-2] if v.endswith(".0") else v for v in raw_asi if v}
    fact_asi = {r["as_item_id"].split("_", 1)[1] for r in out_after if r["as_item_id"] and "_" in r["as_item_id"]}
    check("aftersales.as_item_id.faithful_to_source", fact_asi == norm_asi,
          f"source={len(norm_asi)}, facts={len(fact_asi)}, missing={len(norm_asi - fact_asi)}, extra={len(fact_asi - norm_asi)}")

    # 订单级实际退款必须守恒到分：同 as_id 的 Σ(明细分摊) == 主表实际退款
    alloc_sum: dict[str, Decimal] = defaultdict(lambda: Decimal("0"))
    for r in out_after:
        if r["refund_actual_amount"] not in (None, ""):
            alloc_sum[r["as_id"]] += Decimal(r["refund_actual_amount"])
    conserve_bad = []
    for as_id, m in main_by_as.items():
        raw = m["实际退款金额"]
        if raw in (None, ""):
            if as_id in alloc_sum:
                conserve_bad.append(as_id)
            continue
        if as_id in alloc_sum and alloc_sum[as_id] != Decimal(money(raw) or "0"):
            conserve_bad.append(as_id)
    check("aftersales.refund_actual_conserved", not conserve_bad, f"mismatch={len(conserve_bad)}")
    methods = {r["refund_alloc_method"] for r in out_after}
    check("aftersales.refund_alloc_method.enumerated",
          methods <= {"order_level_single", "item_proportional", "item_even", None},
          f"methods={sorted(m for m in methods if m)}")
    repeated = {r["refund_actual_order_amount"] for r in out_after if r["refund_actual_order_amount"] not in (None, "")}
    check("aftersales.refund_actual_order_amount.preserved", len(repeated) > 0,
          f"distinct_order_level_amounts={len(repeated)}")
    details["refund_status"] = dict(facts.execute("SELECT refund_status, COUNT(*) FROM aftersale_events GROUP BY refund_status").fetchall())
    details["actual_refund_non_null"] = facts.execute("SELECT COUNT(*) FROM aftersale_events WHERE refund_actual_amount IS NOT NULL").fetchone()[0]

    # 商品退款不能进入费用表；当前费用表是销售业绩聚合，不能冒充订单级流水
    fee_sources = [r[0] for r in facts.execute("SELECT DISTINCT source FROM order_fee_ledger")]
    refund_fee_rows = facts.execute("SELECT COUNT(*) FROM order_fee_ledger WHERE lower(fee_type) LIKE '%refund%' OR lower(direction)='refund'").fetchone()[0]
    check("fees.no_product_refund_rows", refund_fee_rows == 0, f"refund_like_rows={refund_fee_rows}")
    check("fees.marked_estimated", facts.execute("SELECT COUNT(*) FROM order_fee_ledger WHERE status!='estimated'").fetchone()[0] == 0, f"sources={fee_sources}")
    check("fees.not_order_level_claim", facts.execute("SELECT COUNT(*) FROM order_fee_ledger WHERE allocation_method!='shop_date'").fetchone()[0] == 0, "all current fee rows are shop_date aggregates")

    # 完整性标记与批次
    check("shipment.complete=false", facts.execute("SELECT COUNT(*) FROM shipment_package_items WHERE complete!='false'").fetchone()[0] == 0, "package source not independently collected")
    check("fees.complete=false", facts.execute("SELECT COUNT(*) FROM order_fee_ledger WHERE complete!='false'").fetchone()[0] == 0, "finance ledger not independently collected")
    batch_count = facts.execute("SELECT COUNT(*) FROM batch_runs").fetchone()[0]
    check("batch_runs.one-per-dataset", batch_count == len(expected) - 1, f"rows={batch_count}, expected={len(expected) - 1}")
    null_ranges = facts.execute("SELECT COUNT(*) FROM batch_runs WHERE source_range IS NULL OR source_range='' ").fetchone()[0]
    if null_ranges:
        warnings.append(f"batch_runs.source_range 仍有 {null_ranges} 行为空，建议下一版填充采集窗口")

    passed = sum(1 for _, ok, _ in checks if ok)
    failed = len(checks) - passed
    lines = ["# profit_facts 本地验收报告", "", f"- facts: `{args.facts}`", f"- 结果：**{'PASS' if failed == 0 else 'FAIL'}**（{passed}/{len(checks)} checks）", "", "## 表行数", ""]
    for k, v in counts.items():
        lines.append(f"- `{k}`: {v}")
    lines += ["", "## 校验结果", "", "| Check | Result | Detail |", "|---|---|---|"]
    for name, ok, detail in checks:
        lines.append(f"| `{name}` | {'PASS' if ok else 'FAIL'} | {detail} |")
    if warnings:
        lines += ["", "## 警告", ""] + [f"- {w}" for w in warnings]
    lines += ["", "## 关键统计", "", "```json", json.dumps(details, ensure_ascii=False, indent=2, default=str), "```", ""]
    Path(args.report).write_text("\n".join(lines) + "\n")
    print(json.dumps({"ok": failed == 0, "passed": passed, "failed": failed, "report": args.report, "counts": counts, "warnings": warnings}, ensure_ascii=False))
    raise SystemExit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
