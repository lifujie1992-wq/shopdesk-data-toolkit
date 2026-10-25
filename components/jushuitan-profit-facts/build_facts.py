#!/usr/bin/env python3
"""聚水潭「单款实际利润」事实表构建器（Mac 采集端）。

把已有本地数仓（订单商品明细 / 售后 / 销售业绩 / 库存 / 紫旗）归一化成
4 张事实表 + batch_runs，落成 jst-profit-facts.sqlite。

语义（对齐 SHOP-FEE-CONTRACT v1.1 与逐单对账修正）：
- item_paid_amount = base_amount（明细级成交金额，非订单级 dw_pay_amount）
- channel = labels 含「精选联盟」→ creator，否则 normal，缺失 → unknown
- 商品成本 = sku_cost（成交成本/成本价），唯一来源
- 商品退款 = 减少收入，落 aftersale_events.refund_actual_amount，不进 order_fee_ledger
- 售后 as_item_id = 售后单号 + asiId（稳定组件ID，非行序号）；combine_sku_id 保留组件归属
- 申请/实际退款金额分开，不兜底；refund_status 独立
- 事实表 append/upsert-only（本脚本按输出文件全量生成；增量合并由 --merge-existing 处理）

用法：
  python3 build_facts.py --orders <item sqlite> --aftersales <sqlite> \
      [--inventory <sqlite>] [--purple <sqlite>] [--sales <sqlite>] \
      --output <out sqlite> [--sample N] [--merge-existing <base sqlite>]
"""
import argparse
import hashlib
import json
import sqlite3
import sys
from collections import OrderedDict, defaultdict
from datetime import datetime

TZ = "+08:00"


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--orders", required=True, help="jst-order-item-details.sqlite（order_item_details）")
    ap.add_argument("--aftersales", required=True, help="jst-aftersales.sqlite")
    ap.add_argument("--inventory", help="jst-inventory-full-second.sqlite（sku_inventory，可选）")
    ap.add_argument("--purple", help="jst-purple-orders.sqlite（purple_orders，可选）")
    ap.add_argument("--sales", help="jst-sales-performance.sqlite（sales_performance，可选）")
    ap.add_argument("--output", required=True)
    ap.add_argument("--sample", type=int, default=0, help="每表最多采样行数（0=不采样，测试用）")
    ap.add_argument("--merge-existing", help="先加载既有事实库作为基线（append/upsert，不删除历史）")
    return ap.parse_args()


def dt_iso(v):
    if v is None or v == "":
        return None
    s = str(v).strip()
    if not s:
        return None
    if s.endswith("Z") or "+" in s[10:]:
        return s
    return s.replace(" ", "T") + TZ


def money(v):
    if v is None or v == "":
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f"{f:.2f}"


def cost_money(v):
    """sku_cost=0 未验证为真实零成本，按未知输出 null。"""
    m = money(v)
    if m is None:
        return None
    return m if float(m) > 0 else None


def source_range(values):
    vals = sorted(str(v) for v in values if v not in (None, ""))
    if not vals:
        return None
    return json.dumps({"from": vals[0], "to": vals[-1]}, ensure_ascii=False)


def qty(v):
    if v is None or v == "":
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return str(int(f)) if f == int(f) else f"{f:.6f}".rstrip("0").rstrip(".")


def sha(s):
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def channel_of(labels):
    if not labels:
        return "unknown"
    if "精选联盟" in labels:
        return "creator"
    return "normal"


def batch_id():
    return "pf-" + datetime.now().strftime("%Y%m%d%H%M%S")


def load_orders(db, sample):
    rows = db.execute("SELECT * FROM order_item_details").fetchall()
    cols = [c[0] for c in db.execute("PRAGMA table_info(order_item_details)")]
    return cols, rows[:sample] if sample else rows


def main():
    args = parse_args()
    out = args.output

    orders_db = sqlite3.connect(f"file:{args.orders}?mode=ro", uri=True)
    orders_db.row_factory = sqlite3.Row
    ocols, orows = load_orders(orders_db, args.sample)

    # spu 映射
    spu_map = {}
    if args.inventory:
        inv = sqlite3.connect(f"file:{args.inventory}?mode=ro", uri=True)
        try:
            for r in inv.execute("SELECT sku_id, spu_id FROM sku_inventory WHERE sku_id IS NOT NULL"):
                spu_map[str(r[0])] = str(r[1])
        except sqlite3.Error:
            pass
        inv.close()

    # 紫旗集合
    purple_o = set()
    if args.purple:
        pu = sqlite3.connect(f"file:{args.purple}?mode=ro", uri=True)
        try:
            for r in pu.execute("SELECT DISTINCT o_id FROM purple_orders WHERE seller_flag='5' OR seller_flag=5"):
                purple_o.add(str(r[0]))
        except sqlite3.Error:
            pass
        pu.close()

    batch = batch_id()
    captured = datetime.now().astimezone().isoformat(timespec="seconds")
    order_range = source_range((dict(r).get("order_date") for r in orows))

    def oidx(cols, name):
        return cols.index(name) if name in cols else None

    i_o_id = oidx(ocols, "o_id")
    i_row = oidx(ocols, "row_key")

    # ---------- order_profit_facts ----------
    opf_cols = ["schema_version","dataset","batch_id","captured_at","source","source_range","complete",
        "mainCoid","mainCoid_source","company_id","platform","shop_id","o_id","so_id","outer_so_id",
        "order_item_id","row_key","sku_id","spu_id","platform_sku_id","platform_link_id",
        "original_order_rel","split_merge_rel","order_at","paid_at","shipped_at",
        "qty","item_paid_amount","buyer_freight_amount","order_discount_alloc","actual_shipped_qty","cost_amount","cost_basis",
        "channel","creator_id","leader_id","provider_id","seller_flag","brush_flag",
        "source_record_id","source_updated_at","raw_record_hash","source_page","source_ref"]
    opf_rows = []
    for r in orows:
        d = dict(r)
        row_key = d.get("row_key")
        o_id = str(d.get("o_id") or "")
        labels = d.get("labels")
        sku_id = d.get("sku_id")
        channel = channel_of(labels)
        raw_json = d.get("raw_json") or json.dumps({k: d.get(k) for k in ocols if k != "raw_json"}, ensure_ascii=False)
        original_rel = json.dumps({"raw_so_id": d.get("oi_raw_so_id"), "outer_so_id": d.get("outer_so_id")}, ensure_ascii=False)
        opf_rows.append([
            "1", "order_profit_facts", batch, captured, "jst_order_item_details", order_range, "true",
            str(d.get("mainCoid")) if d.get("mainCoid") is not None else None,
            "order_item_details.mainCoid(语义未验证)" if d.get("mainCoid") is not None else None,
            None,  # company_id 未验证
            d.get("platform"), str(d.get("shop_id") or "") or None, o_id or None,
            str(d.get("so_id")) if d.get("so_id") is not None else None,
            str(d.get("outer_so_id")) if d.get("outer_so_id") is not None else None,
            row_key, row_key, sku_id, spu_map.get(str(sku_id)) if sku_id is not None else None,
            str(d.get("oi_shop_sku_id")) if d.get("oi_shop_sku_id") is not None else None,
            str(d.get("oi_shop_i_id")) if d.get("oi_shop_i_id") is not None else None,
            original_rel, None,
            dt_iso(d.get("order_date")), dt_iso(d.get("pay_date")), dt_iso(d.get("send_date")),
            qty(d.get("order_qty")), money(d.get("base_amount")), money(d.get("freight_revenue")),
            json.dumps({"free_amount": money(d.get("free_amount"))}, ensure_ascii=False),
            qty(d.get("r_sent_qty")), cost_money(d.get("sku_cost")),
            "order_item_details.sku_cost(成交成本/成本价)" if cost_money(d.get("sku_cost")) is not None else None,
            channel,
            str(d.get("oi_referrer_id")) if d.get("oi_referrer_id") not in (None, "") else None,
            None, None,
            str(d.get("seller_flag")) if d.get("seller_flag") is not None else None,
            "true" if o_id in purple_o else "false",
            o_id or None,
            dt_iso(d.get("send_date") or d.get("oi_item_end_time")),
            sha(raw_json), "销售主题分析-订单(商品)明细",
            f"order_item_details[{o_id},{sku_id}]",
        ])

    # ---------- aftersale_events ----------
    aft_db = sqlite3.connect(f"file:{args.aftersales}?mode=ro", uri=True)
    aft_db.row_factory = sqlite3.Row
    ar = aft_db.execute('SELECT MIN("售后申请时间"), MAX("售后申请时间") FROM aftersale_details').fetchone()
    after_range = source_range(ar)
    afe_cols = ["schema_version","dataset","batch_id","captured_at","source","source_range","complete",
        "as_id","as_item_id","as_event_id","event_type",
        "o_id","so_id","order_item_id","sku_id","design_code","combine_sku_id",
        "apply_time","refund_time","return_time","inbound_time","update_time",
        "status","type","refund_applied_amount","refund_actual_amount","refund_status",
        "refund_actual_order_amount","refund_alloc_method",
        "returned_qty","inbound_qty","resalable_qty","damaged_qty","not_inbound_qty",
        "cost_recoverable_basis",
        "source_record_id","source_updated_at","raw_record_hash","source_page","source_ref"]
    afe_rows = []
    item_rows = aft_db.execute('SELECT * FROM aftersale_item_details').fetchall()
    if args.sample:
        item_rows = item_rows[:args.sample]
    masters = {str(r["售后单号"]): dict(r) for r in aft_db.execute("SELECT * FROM aftersale_details")}

    def asi_of(value):
        # asiId 原始值是浮点串（如 "623552778.0"）；只能去掉精确的尾部 ".0"，
        # 不能用 rstrip(".0")——那会把 623063800 截成 6230638。
        raw = str(value or "").strip()
        return raw[:-2] if raw.endswith(".0") else raw

    # 只对逐列完全相同的采集重复去重；不同 asiId 或不同内容均保留。
    # （已验证：2 组重复均为逐列全同，且去重后件数与售后主表完全守恒。）
    seen_items = set()
    deduped = []
    for it in item_rows:
        d = dict(it)
        sig = sha(json.dumps(d, ensure_ascii=False, sort_keys=True, default=str))
        key = (str(d.get("售后单号") or ""), asi_of(d.get("售后商品明细编号")), sig)
        if key in seen_items:
            continue
        seen_items.add(key)
        deduped.append(d)

    def cents(value):
        try:
            return int(round(float(value) * 100))
        except (TypeError, ValueError):
            return 0

    # 「实际退款金额」只存在于售后主表（订单级）。若整单照抄到每条组件明细，
    # 多组件售后单按行求和会高估退款（实测会虚增 341,057.94 元）。
    # 这里按明细申请金额比例分摊到分，并保留订单级原值与方法，
    # 保证同 as_id 的 Σ(refund_actual_amount) == 订单级实际退款。
    by_order = defaultdict(list)
    for d in deduped:
        by_order[str(d.get("售后单号") or "")].append(d)
    allocation = {}
    for as_id, group in by_order.items():
        raw_actual = masters.get(as_id, {}).get("实际退款金额")
        if raw_actual in (None, ""):
            for d in group:
                allocation[id(d)] = (None, None)
            continue
        total_cents = cents(raw_actual)
        if len(group) == 1:
            allocation[id(group[0])] = (total_cents, "order_level_single")
            continue
        weights = [max(cents(d.get("退款金额")), 0) for d in group]
        total_weight = sum(weights)
        if total_weight > 0:
            exact = [total_cents * weight / total_weight for weight in weights]
            method = "item_proportional"
        else:
            exact = [total_cents / len(group)] * len(group)
            method = "item_even"
        shares = [int(value) for value in exact]
        remainder = total_cents - sum(shares)
        ranked = sorted(range(len(group)), key=lambda i: (-(exact[i] - shares[i]), i))
        for i in ranked[:max(remainder, 0)]:
            shares[i] += 1
        for d, share in zip(group, shares):
            allocation[id(d)] = (share, method)

    for d in deduped:
        as_id = str(d.get("售后单号") or "")
        asi = asi_of(d.get("售后商品明细编号"))
        sku_id = d.get("SKU编码")
        combine = d.get("套装或组合商品编码")
        as_item_id = f"{as_id}_{asi}" if asi else None
        md = masters.get(as_id, {})
        applied = d.get("退款金额")
        actual_cents, alloc_method = allocation.get(id(d), (None, None))
        actual = None if actual_cents is None else f"{actual_cents / 100:.2f}"
        order_actual = md.get("实际退款金额")
        # refund_status: 实际退款非0→settled；申请>0 但实际=0/空→pending；都空→unknown
        try:
            a_f = float(actual) if actual not in (None, "") else None
            p_f = float(applied) if applied not in (None, "") else None
        except (TypeError, ValueError):
            a_f = p_f = None
        if a_f is not None and a_f != 0:
            rstatus = "settled"
        elif p_f is not None and p_f != 0:
            rstatus = "pending"
        else:
            rstatus = "unknown"
        afe_rows.append([
            "1", "aftersale_events", batch, captured, "jst_aftersales", after_range, "true",
            as_id, as_item_id, f"{as_id}_{asi}_refund" if asi else as_id, "refund",
            str(md.get("关联订单号") or "") or None,
            str(md.get("关联原始订单号") or "") or None,
            None, sku_id, d.get("商品编码"), combine,
            dt_iso(md.get("售后申请时间")), dt_iso(md.get("退款成功时间")),
            dt_iso(md.get("仓库实际收货时间")), dt_iso(md.get("销退入库时间")),
            dt_iso(md.get("售后更新时间")),
            md.get("ERP售后状态"), md.get("售后类型"),
            money(applied), actual, rstatus,
            money(order_actual), alloc_method,
            qty(md.get("买家实际寄回件数")), qty(md.get("销退实际入库件数")),
            qty(md.get("可再次销售件数")), qty(md.get("次品件数")), qty(md.get("尚未退回件数")),
            ("质检合格/可再次销售件数>0 才可回收" if md.get("可再次销售件数") not in (None, "", "0.0", "0") else None),
            as_id, dt_iso(md.get("售后更新时间")),
            sha(json.dumps({k: (d.get(k) if k in d else md.get(k)) for k in set(d) | set(md)}, ensure_ascii=False, default=str)),
            "售后(退货退款)列表", f"aftersale_item_details[{as_id},{asi}]",
        ])
    aft_db.close()

    # ---------- shipment_package_items（骨架：以 l_id 为临时包裹键，运单号/撤销待补） ----------
    spi_cols = ["schema_version","dataset","batch_id","captured_at","source","source_range","complete",
        "package_id","waybill_no","o_id","so_id","order_item_id","row_key","sku_id",
        "shipped_qty","shipped_at","revoke_time","revoke_status",
        "package_fee_total","package_fee_alloc","fee_status",
        "item_count","order_count","package_count",
        "source_record_id","source_updated_at","raw_record_hash","source_page","source_ref"]
    spi_rows = []
    # 每个 (o_id,l_id) 组：package_fee_total=该包裹运费成本(订单层单值)，package_fee_alloc=明细分摊。
    # l_id 缺失/占位时不得伪造包裹号：落到显式 "(unassigned)" 桶并用
    # fee_status=unassigned 标记，避免把「没有包裹」当成真实包裹参与分析。
    PLACEHOLDER_LID = {"", "0", "0000", "none", "null"}
    pkg = OrderedDict()
    for r in orows:
        d = dict(r)
        raw_l = str(d.get("l_id") or "").strip()
        real = raw_l.lower() not in PLACEHOLDER_LID
        o_id = str(d.get("o_id") or "")
        pkg.setdefault((o_id, raw_l if real else ""), []).append(d)
    for (o_id, l_id), items in pkg.items():
        real = bool(l_id)
        package_id = l_id if real else "(unassigned)"
        item_count = len({x.get("row_key") for x in items})
        fcost = next((x.get("freight_cost") for x in items if x.get("freight_cost") is not None), None)
        for d in items:
            row_key = d.get("row_key")
            sku_id = d.get("sku_id")
            spi_rows.append([
                "1", "shipment_package_items", batch, captured,
                "jst_order_item_details(l_id骨架)" if real else "jst_order_item_details(无l_id,未分配包裹)",
                order_range, "false",
                package_id, None, o_id or None,
                str(d.get("so_id")) if d.get("so_id") is not None else None,
                row_key, row_key, sku_id,
                qty(d.get("r_sent_qty")), dt_iso(d.get("send_date")), None, None,
                money(fcost) if real else None,
                money(d.get("freight_price_share")) if real else None,
                "estimated" if real and fcost is not None else "unassigned",
                str(item_count), "1", "1" if real else "0",
                package_id, dt_iso(d.get("send_date")),
                sha(json.dumps({"o_id": o_id, "l_id": package_id, "sku_id": str(sku_id)}, ensure_ascii=False)),
                "订单商品明细(l_id)", f"order_item_details[{o_id},{sku_id}]",
            ])

    # ---------- order_fee_ledger（店铺×日聚合，标 estimated/allocated；无财务页流水） ----------
    ofl_cols = ["schema_version","dataset","batch_id","captured_at","source","source_range","complete",
        "fee_record_id","source_charge_id","platform","shop_id","o_id","so_id","order_item_id","sku_id","package_id","policy_id",
        "fee_type","amount","currency","direction","occurred_at","settled_at","source_updated_at",
        "status","bill_name","settlement_period","allocation_method","business_ref_id",
        "source_record_id","raw_record_hash","source_page","source_ref"]
    ofl_rows = []
    sales_range = None
    if args.sales:
        sal = sqlite3.connect(f"file:{args.sales}?mode=ro", uri=True)
        sr = sal.execute("SELECT MIN(report_date), MAX(report_date) FROM sales_performance").fetchone()
        sales_range = source_range(sr)
        sal.row_factory = sqlite3.Row
        for r in sal.execute("SELECT * FROM sales_performance"):
            d = dict(r)
            rj = json.loads(d.get("raw_json") or "{}")
            rd = str(d.get("report_date") or "")
            sid = str(d.get("shop_id") or "")
            def fee_row(ftype, amt, bill):
                if amt in (None, ""):
                    return None
                try:
                    if float(amt) == 0:
                        return None
                except (TypeError, ValueError):
                    return None
                rid = f"agg_{sid}_{rd}_{ftype}"
                return [
                    "1", "order_fee_ledger", batch, captured, "jst_sales_performance(店铺×日聚合)", sales_range, "false",
                    rid, None, d.get("platform"), sid, None, None, None, None, None, None,
                    ftype, money(amt), "CNY", "charge", None, None, dt_iso(d.get("synced_at")),
                    "estimated", bill, rd, "shop_date", None,
                    rid, sha(json.dumps({ftype: amt}, ensure_ascii=False)), "销售业绩日报", f"sales_performance[{rd},{sid}]",
                ]
            for ftype, amt, bill in [
                ("platform_service", d.get("platform_fees"), "平台服务费(店铺日)"),
                ("creator_commission", d.get("commission"), "佣金(店铺日)"),
                ("promotion", d.get("advertising_costs"), "推广费(店铺日)"),
            ]:
                rr = fee_row(ftype, amt, bill)
                if rr:
                    ofl_rows.append(rr)
        sal.close()

    # ---------- 写库（append/merge） ----------
    if args.merge_existing:
        import shutil
        shutil.copyfile(args.merge_existing, args.output)
    db = sqlite3.connect(args.output)

    def ensure_table(name, cols, pks):
        coldef = ", ".join(f'"{c}" TEXT' for c in cols)
        pk = ",".join(f'"{p}"' for p in pks)
        db.execute(f'CREATE TABLE IF NOT EXISTS "{name}" ({coldef}, PRIMARY KEY({pk}))')

    ensure_table("batch_runs", ["batch_id","dataset","schema_version","captured_at","source","source_range","complete","records","started_at","completed_at"], ["batch_id","dataset"])
    ensure_table("order_profit_facts", opf_cols, ["order_item_id"])
    ensure_table("shipment_package_items", spi_cols, ["package_id","order_item_id"])
    ensure_table("aftersale_events", afe_cols, ["as_event_id"])
    ensure_table("order_fee_ledger", ofl_cols, ["fee_record_id"])

    def upsert(name, cols, rows):
        ph = ",".join("?" for _ in cols)
        qcols = ",".join('"%s"' % c for c in cols)
        db.executemany(
            f'INSERT OR REPLACE INTO "{name}" ({qcols}) VALUES ({ph})',
            rows,
        )

    upsert("order_profit_facts", opf_cols, opf_rows)
    upsert("shipment_package_items", spi_cols, spi_rows)
    upsert("aftersale_events", afe_cols, afe_rows)
    upsert("order_fee_ledger", ofl_cols, ofl_rows)

    counts = {n: db.execute(f'SELECT COUNT(*) FROM "{n}"').fetchone()[0]
              for n in ["order_profit_facts", "shipment_package_items", "aftersale_events", "order_fee_ledger"]}
    db.executemany(
        'INSERT OR REPLACE INTO "batch_runs" ("batch_id","dataset","schema_version","captured_at","source","source_range","complete","records","started_at","completed_at") VALUES (?,?,?,?,?,?,?,?,?,?)',
        [
            (batch, "order_profit_facts", "1", captured, "jst_order_item_details", order_range, "true", counts["order_profit_facts"], captured, captured),
            (batch, "shipment_package_items", "1", captured, "jst_order_item_details(l_id骨架)", order_range, "false", counts["shipment_package_items"], captured, captured),
            (batch, "aftersale_events", "1", captured, "jst_aftersales", after_range, "true", counts["aftersale_events"], captured, captured),
            (batch, "order_fee_ledger", "1", captured, "jst_sales_performance(店铺×日聚合)", sales_range, "false", counts["order_fee_ledger"], captured, captured),
        ],
    )
    db.commit()
    db.close()

    print(json.dumps({
        "ok": True,
        "batch_id": batch,
        "output": out,
        "counts": counts,
        "spu_mapped": sum(1 for r in opf_rows if r[opf_cols.index("spu_id")] is not None),
        "purple_orders": len(purple_o),
        "notes": [
            "item_paid_amount=base_amount; cost=sku_cost; channel=labels含精选联盟",
            "shipment_package_items 为 l_id 骨架(complete=false), 运单号/撤销/包裹费用待发货页",
            "order_fee_ledger 为店铺×日聚合(complete=false, status=estimated), 非订单级流水",
            "company_id=null(未验证), 商品退款落 aftersale_events 不进费用表",
        ],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
