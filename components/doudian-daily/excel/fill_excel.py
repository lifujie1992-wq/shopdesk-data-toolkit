#!/usr/bin/env python3
"""把接口数据填回『采集结果』表。原则：能对上才填，加工数据算，对不上留空(❎)。"""
import json, datetime, openpyxl
from copy import copy

SRC = "/Users/lee/Downloads/抖店Playwright采集字段导出(1).xlsx"
OUT = "/Users/lee/Downloads/抖店Playwright采集字段导出(1)-已填充.xlsx"

def load(n): return json.load(open(f"/tmp/api_dump/{n}.json"))

T = load("trade_core_index_v3")["data"]["module_data"]["homepage_core_index"]["compass_general_multi_index_card_value"]["data"][0]
S = load("summary_core_index")["data"]["module_data"]["homepage_core_index"]["compass_general_multi_index_card_value"]["data"][0]
OV = load("overview_v10")["data"]
SUB = load("sub_score_v10")["data"]["formal_score_metric_info"]["metrics"]

def iv(d, key):
    v = d.get(key, {}).get("index_value", {})
    return v.get("value", {}).get("value"), v.get("out_period_ratio", {}).get("value")
def money(x): return round(x / 100, 2) if isinstance(x, (int, float)) else None
def pct(x): return round(x * 100, 4) if isinstance(x, (int, float)) else None

def sub(node):
    for m in SUB:
        if m.get("node_id") == node:
            v = (m.get("value") or {}).get("value_figure")
            return None if v in (None, -9999) else v
    return None
def sub_title(node):
    for m in SUB:
        if m.get("node_id") == node: return m.get("title")
    return ""

net, net_ratio = iv(T, "net_income_amt")
pay_cnt, _ = iv(T, "pay_cnt")
refund, _ = iv(T, "refund_amt")

# --- 映射：列名 -> (值, 备注) ; 值 None 表示无来源 ---
M = {}
def setv(col, val, note=""): M[col] = (val, note)

setv("店铺", "黑色草莓bingbing")
setv("平台", "抖音")
setv("净销售收入(元)", money(net))
setv("订单数", pay_cnt)
setv("客单价(元)", round(money(net) / pay_cnt, 2) if (money(net) and pay_cnt) else None, "净销售收入/订单数(加工)")
setv("48小时发货率%", pct(T["payin3d_pay_ship_amt_rate"]["index_value"]["value"]["value"]), "接口为支付后3日发货率，口径待确认")
setv("退货率%(7天口径)", pct(T["refund_amt_rate"]["index_value"]["value"]["value"]), "接口为退款金额率，口径待确认")
setv("销售额环比%", pct(net_ratio), "净销售收入环比")
setv("退款金额(元)", money(refund))
setv("仅退款金额(元)", money(T["rfndsuc_amt_pay_time"]["index_value"]["value"]["value"]), "支付时间退款成功")
setv("发货退款金额(元)", money(T["refund_amt_pay_time"]["index_value"]["value"]["value"]), "支付时间退款额，口径待确认")
setv("退货数量(件)", T["refund_order_cnt"]["index_value"]["value"]["value"], "退款订单数(退款时间)")
setv("曝光量", T["product_show_cnt"]["index_value"]["value"]["value"])
setv("点击率%", pct(T["product_show_click_cnt_ratio"]["index_value"]["value"]["value"]))
setv("点击转化率", pct(T["product_click_pay_cnt_ratio"]["index_value"]["value"]["value"]))
setv("千次曝光用户支付金额", money(T["gpm"]["index_value"]["value"]["value"]))
setv("支付发货金额(元)", money(T["ship_amt"]["index_value"]["value"]["value"]))
# 体验分
fi = OV.get("formal_score_info", {})
setv("店铺总体验分", (fi.get("experience_score") or {}).get("score"))
setv("商品体验分", (fi.get("goods_score") or {}).get("score"))
setv("服务体验分", (fi.get("service_score") or {}).get("score"))
setv("物流体验分", (fi.get("logistics_score") or {}).get("score"))
setv("影响消费者体验（违规扣分项）", (fi.get("bad_behavior_deduct_score") or {}).get("score"))
# 体验分细项（店铺表现）
setv("商品综合评分（店铺表现）", sub(108), "V10 返回 -9999=无数据" if sub(108) is None else "")
setv("商品品质退货率（店铺表现）", pct(sub(103)), "小数已转百分数")
setv("运单配送时效达成率（店铺表现）", pct(sub(203)) if sub(203) is not None else None, "小数比例已转百分数")
setv("飞鸽平均响应时长（店铺表现）", sub(309))
setv("售后平均审核时长（店铺表现）", sub(316))
setv("飞鸽会话不满意率（店铺表现）", pct(sub(317)) if sub(317) is not None else None, "小数比例已转百分数")
setv("平台求助率（店铺表现）", pct(sub(318)) if sub(318) is not None else None, "小数比例已转百分数")
setv("虚假交易刷体验分（违规扣分项）", sub(501))
setv("发货物流品退率（店铺表现）", sub(212))
setv("日期", "2026-09-14")
setv("同步时间", datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"))





# --- 上架/下架/当日评价（按日期统计，数据来自 fxg 商品/评价接口）---
setv("上新数", 0, "按 create_time 统计 2026-09-14 无上新")
setv("下架数", 0, "下架 tab 统计为 0")

# --- 商家中心：商品数/订单计数 ---
import glob
def g3(n):
    fs = glob.glob(f"/tmp/api_dump/f3_*{n}*.json")
    return json.load(open(fs[0])) if fs else {}
try:
    ap = g3("aggsProductCount").get("data", {})
    setv("店铺商品数", ap.get("onsale"), "在售商品数")
except Exception: pass
try:
    tb = g3("tabcnt").get("data", {})
    setv("延迟发货件数", tb.get("ship_delay"), "接口单位为订单,口径待确认")
    setv("未发订单数(订单口径)", tb.get("stock_up"), "待发货订单数")
    setv("超48h未发占比%", None)
except Exception: pass

# --- 推广/费用/成本（summary_core_index）---
def sv(key):
    v = S.get(key, {}).get("index_value", {}).get("value", {})
    return v.get("value") if isinstance(v, dict) else None
setv("推广费用(元)", money(sv("ad_costed_amt")))
setv("佣金费用(元)", money(sv("real_commission")))
setv("平台账单费用(元)", money(sv("shop_serv_amt")), "接口为店铺服务费,口径待确认")
setv("销售成本(元)", money(sv("cost_amt")), "接口成本字段,口径待确认")
# 推广ROI：优先 ad_income_amt/ad_costed_amt
try:
    CL = load("c3_content_list_v3")["data"]["module_data"]["trade_content_account_analysis_content_list_v3"]["compass_general_table_value"]["data"][0]["cell_info"]
    def cli(k):
        v = CL.get(k, {}).get("index_values", {})
        return v.get("value", {}).get("value") if isinstance(v, dict) else None
    adc, adi = sv("ad_costed_amt"), cli("ad_income_amt")
    if adc and adi is not None:
        setv("推广ROI", round(adi / adc, 4), "广告成交额/广告消耗(加工)")
except Exception as e: pass

# --- 评价（用户原声）---
try:
    UF = load("c2_user_sound_formula")["data"][0]["cell_info"]
    def ci(k):
        v = UF.get(k, {}).get(k + "_index_values", {})
        if isinstance(v, dict):
            v = v.get("index_values", v)
            return v.get("value", {}).get("value") if isinstance(v, dict) else None
        return None
    good = ci("good_comment_order_cnt"); bad = ci("bad_comment_order_cnt")
    total = ci("comment_order_cnt")
    setv("好评数", good)
    setv("差评数", bad)
    mid = (total - (good or 0) - (bad or 0)) if total is not None else None
    setv("中评数", mid, "评价总数-好评-差评(加工)")
    setv("好评率", pct(ci("good_comment_rate")) if ci("good_comment_rate") is not None else None, "小数已转百分数")
    setv("差评率", pct(ci("bad_comment_rate")) if ci("bad_comment_rate") is not None else None, "小数已转百分数")
    setv("中评率", round(mid/total*100,4) if (mid is not None and total) else None, "加工")
    setv("近30天新增评价数", total)
except Exception as e:
    print("评价填充跳过:", e)

# --- 写回 ---
wb = openpyxl.load_workbook(SRC)
ws = wb["采集结果"]
hdr = [c.value for c in ws[1]]
NO = "❎"
filled, derived, empty = [], [], []
for col in range(1, len(hdr) + 1):
    name = hdr[col - 1]
    if name is None: continue
    if name in M:
        val, note = M[name]
        if val is None:
            ws.cell(2, col).value = NO; empty.append(name)
        else:
            ws.cell(2, col).value = val
            (derived if "加工" in note or "计算" in note else filled).append((name, val, note))
    else:
        ws.cell(2, col).value = NO; empty.append(name)

wb.save(OUT)
print("已保存:", OUT)
print(f"\n填充 {len(filled)} 项：")
for n, v, note in filled: print(f"  ✓ {n} = {v}" + (f"  [{note}]" if note else ""))
print(f"\n加工 {len(derived)} 项：")
for n, v, note in derived: print(f"  ~ {n} = {v}  [{note}]")
print(f"\n留空 {len(empty)} 项（无可靠来源）：")
print("  " + "、".join(empty))
