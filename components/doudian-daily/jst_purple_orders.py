#!/usr/bin/env python3
"""聚水潭「紫色旗帜」(seller_flag=5) 订单明细 → 本地数仓 SQLite。

紫色旗帜 = 刷单标记。口径：按下单日期(order_date)统计，含全部订单状态；
会话复用 jst-orders 的 keychain 凭据（与 jst_brush.py 同一套）。

用法:
    python3 jst_purple_orders.py sync [--days 7] [--output ~/jst-purple-orders.sqlite]
    python3 jst_purple_orders.py sync --date 2026-10-05
    python3 jst_purple_orders.py list [--date 2026-10-05] [--limit 20]
"""
import argparse
import os
import sqlite3
import sys
from datetime import date, datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import jst_brush

DEFAULT_DB = os.path.expanduser('~/jst-purple-orders.sqlite')
FLAG_PURPLE = 5  # 紫色旗帜 = 刷单

# (列名, 类型)
COLUMNS = [
    ('o_id', 'TEXT PRIMARY KEY'),
    ('so_id', 'TEXT'),
    ('shop_name', 'TEXT'),
    ('platform', 'TEXT'),
    ('order_date', 'TEXT'),
    ('pay_date', 'TEXT'),
    ('send_date', 'TEXT'),
    ('order_type', 'TEXT'),
    ('status', 'TEXT'),
    ('order_qty', 'REAL'),
    ('order_amt', 'REAL'),
    ('base_amount', 'REAL'),
    ('dw_pay_amount', 'REAL'),
    ('sku_id', 'TEXT'),
    ('skus', 'TEXT'),
    ('sku_cost', 'REAL'),
    ('gross_margin', 'REAL'),
    ('gross_margin_rate', 'REAL'),
    ('free_amount', 'REAL'),
    ('freight_revenue', 'REAL'),
    ('r_sent_qty', 'REAL'),
    ('r_sent_amt', 'REAL'),
    ('no_price_qty', 'REAL'),
    ('receiver_state', 'TEXT'),
    ('receiver_city', 'TEXT'),
    ('receiver_district', 'TEXT'),
    ('labels', 'TEXT'),
    ('remark', 'TEXT'),
    ('seller_flag', 'INTEGER'),
    ('wms_co_name', 'TEXT'),
    ('logistics_company', 'TEXT'),
    ('creator_name', 'TEXT'),
    ('main_coid', 'TEXT'),
    ('stat_date', 'TEXT'),
    ('fetched_at', 'TEXT'),
]
COL_NAMES = [c for c, _ in COLUMNS]


def ensure_schema(db):
    cols = ', '.join(f'"{n}" {t}' for n, t in COLUMNS)
    db.execute(f'CREATE TABLE IF NOT EXISTS purple_orders ({cols})')
    db.execute('CREATE INDEX IF NOT EXISTS idx_purple_order_date ON purple_orders(order_date)')
    db.execute('CREATE INDEX IF NOT EXISTS idx_purple_stat_date ON purple_orders(stat_date)')
    db.execute('CREATE INDEX IF NOT EXISTS idx_purple_shop ON purple_orders(shop_name)')
    db.execute('''CREATE TABLE IF NOT EXISTS sync_info (
        stat_date TEXT PRIMARY KEY, started_at TEXT, completed_at TEXT,
        duration_ms INTEGER, total_rows INTEGER, window_days INTEGER)''')
    db.execute('''CREATE TABLE IF NOT EXISTS purple_review_daily (
        shop_name TEXT, platform TEXT, stat_date TEXT,
        brush_orders REAL, brush_good_reviews REAL, brush_count_reviews REAL,
        PRIMARY KEY (shop_name, platform, stat_date))''')
    db.commit()


def refresh_review_daily(db, stat_date):
    """把某天已落库的紫旗订单按 (店铺, 平台) 汇总成 purple_review_daily。

    brush_orders（当日紫旗订单数）由本脚本的紫旗订单明细权威计算；
    brush_good_reviews（当日出好评数）/ brush_count_reviews（当日计入评价数）
    来自抖店评价链路，本脚本不回填，re-sync 时只更新 brush_orders、保留已有的评价列。
    """
    db.execute('''
        INSERT INTO purple_review_daily (shop_name, platform, stat_date, brush_orders)
        SELECT shop_name, platform, stat_date, COUNT(*) AS brush_orders
        FROM purple_orders
        WHERE stat_date = ?
        GROUP BY shop_name, platform, stat_date
        ON CONFLICT(shop_name, platform, stat_date) DO UPDATE SET
            brush_orders = excluded.brush_orders
    ''', (stat_date,))


def fetch_day(cookies, d):
    """拉某天下单的紫旗单（全部页）。"""
    rows_all = []
    for rows, total, fetched in jst_brush._paginate(cookies, d, d, FLAG_PURPLE, 60):
        rows_all.extend(rows)
        if not rows:
            break
    return rows_all


def to_record(r, stat_date, fetched_at):
    def g(k):
        return r.get(k)
    return {
        'o_id': str(g('o_id')) if g('o_id') is not None else None,
        'so_id': g('so_id'),
        'shop_name': g('shop_name'),
        'platform': g('platform'),
        'order_date': g('order_date'),
        'pay_date': g('pay_date'),
        'send_date': g('send_date'),
        'order_type': g('order_type'),
        'status': g('status'),
        'order_qty': g('order_qty'),
        'order_amt': g('order_amt'),
        'base_amount': g('base_amount'),
        'dw_pay_amount': g('dw_pay_amount'),
        'sku_id': g('sku_id'),
        'skus': g('skus'),
        'sku_cost': g('sku_cost'),
        'gross_margin': g('gross_margin'),
        'gross_margin_rate': g('gross_margin_rate'),
        'free_amount': g('free_amount'),
        'freight_revenue': g('freight_revenue'),
        'r_sent_qty': g('r_sent_qty'),
        'r_sent_amt': g('r_sent_amt'),
        'no_price_qty': g('no_price_qty'),
        'receiver_state': g('receiver_state'),
        'receiver_city': g('receiver_city'),
        'receiver_district': g('receiver_district'),
        'labels': g('labels'),
        'remark': g('remark'),
        'seller_flag': g('seller_flag'),
        'wms_co_name': g('wms_co_name'),
        'logistics_company': g('logistics_company'),
        'creator_name': g('creator_name'),
        'main_coid': str(g('mainCoid')) if g('mainCoid') is not None else None,
        'stat_date': stat_date,
        'fetched_at': fetched_at,
    }


def sync(days=7, dates=None, output=DEFAULT_DB):
    started = datetime.now()
    cookies = jst_brush.load_session()
    if dates:
        day_list = dates
        window_days = len(dates)
    else:
        today = date.today()
        day_list = [(today - timedelta(days=i)).isoformat() for i in range(days)]
        window_days = days

    db = sqlite3.connect(output)
    ensure_schema(db)
    placeholders = ', '.join('?' * len(COL_NAMES))
    sql = (f'INSERT OR REPLACE INTO purple_orders ({", ".join(chr(34)+c+chr(34) for c in COL_NAMES)}) '
           f'VALUES ({placeholders})')
    total = 0
    per_day = {}
    for d in sorted(day_list):
        rows = fetch_day(cookies, d)
        fetched_at = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        db.execute('BEGIN')
        for r in rows:
            rec = to_record(r, d, fetched_at)
            db.execute(sql, [rec[c] for c in COL_NAMES])
        db.commit()
        refresh_review_daily(db, d)
        db.commit()
        per_day[d] = len(rows)
        total += len(rows)
        print(f'  {d}: {len(rows)} 条', flush=True)
    dur = int((datetime.now() - started).total_seconds() * 1000)
    # sync_info 记录每个 stat_date
    for d, n in per_day.items():
        db.execute('INSERT OR REPLACE INTO sync_info VALUES (?,?,?,?,?,?)',
                   (d, started.isoformat(), datetime.now().isoformat(), dur, n, window_days))
    db.commit()
    db.close()
    print(f'sync 完成: 窗口 {window_days} 天, 本次抓取 {total} 行 -> {output}')
    return total


def list_orders(date_filter=None, limit=20, output=DEFAULT_DB):
    db = sqlite3.connect(output)
    where = f'WHERE stat_date = "{date_filter}"' if date_filter else ''
    cur = db.execute(f'SELECT o_id, shop_name, order_date, order_qty, order_amt, status, skus '
                     f'FROM purple_orders {where} ORDER BY order_date DESC LIMIT ?', (limit,))
    for row in cur:
        print(' | '.join(str(x) for x in row))
    db.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('command', choices=['sync', 'list'])
    ap.add_argument('--days', type=int, default=7)
    ap.add_argument('--date', action='append', help='指定日期(可多次)，覆盖 --days')
    ap.add_argument('--output', default=DEFAULT_DB)
    ap.add_argument('--limit', type=int, default=20)
    args = ap.parse_args()

    if args.command == 'sync':
        sync(days=args.days, dates=args.date, output=args.output)
    elif args.command == 'list':
        d = args.date[0] if args.date else None
        list_orders(d, args.limit, args.output)


if __name__ == '__main__':
    main()
