#!/usr/bin/env python3
"""列出聚水潭「紫色旗帜」(seller_flag=5) 订单明细。

用法:
    python3 find_purple_orders.py 2026-10-05 [更多日期...]
    python3 find_purple_orders.py 2026-10-01:2026-10-05   # 支持区间

产出: data/purple-orders-<date>.csv （含内部订单号/平台单号/店铺/下单时间/金额/状态/商品/收货地/标签/备注）
"""
import sys
import os
import csv
from datetime import date, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import jst_brush

MAX_PAGES = 60


def fetch_date(cookies, d, max_pages=MAX_PAGES):
    rows_all = []
    for rows, total, fetched in jst_brush._paginate(cookies, d, jst_brush.FLAG_BRUSH, max_pages):
        rows_all.extend(rows)
        if not rows:
            break
    return rows_all


def expand(args):
    out = []
    for a in args:
        if ':' in a:
            s, e = a.split(':')
            d0 = date.fromisoformat(s)
            d1 = date.fromisoformat(e)
            cur = d0
            while cur <= d1:
                out.append(cur.isoformat())
                cur += timedelta(days=1)
        else:
            out.append(a)
    return out


def main():
    args = sys.argv[1:]
    dates = expand(args) if args else [(date.today() - timedelta(days=1)).isoformat()]
    cookies = jst_brush.load_session()
    outdir = os.path.join(HERE, 'data')
    os.makedirs(outdir, exist_ok=True)
    grand = 0
    for d in dates:
        rows = fetch_date(cookies, d)
        grand += len(rows)
        by_shop = {}
        for r in rows:
            n = r.get('shop_name') or '(未知店铺)'
            by_shop[n] = by_shop.get(n, 0) + 1
        path = os.path.join(outdir, f'purple-orders-{d}.csv')
        with open(path, 'w', newline='', encoding='utf-8-sig') as f:
            w = csv.writer(f)
            w.writerow(['内部订单号', '平台单号', '店铺', '下单时间', '付款时间', '件数',
                        '订单金额', '状态', '商品', '省', '市', '区', '标签', '备注'])
            for r in sorted(rows, key=lambda x: x.get('order_date') or ''):
                w.writerow([
                    r.get('o_id'), r.get('so_id'), r.get('shop_name'),
                    r.get('order_date'), r.get('pay_date'), r.get('order_qty'),
                    r.get('order_amt'), r.get('status'), r.get('skus'),
                    r.get('receiver_state'), r.get('receiver_city'), r.get('receiver_district'),
                    r.get('labels'), r.get('remark'),
                ])
        print(f'{d}: 紫旗单 {len(rows)} 条 -> {path}')
        for n, c in sorted(by_shop.items(), key=lambda kv: -kv[1])[:12]:
            print(f'    {c:5d}  {n}')
    if len(dates) > 1:
        print(f'合计 {grand} 条')


if __name__ == '__main__':
    main()
