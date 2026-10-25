#!/usr/bin/env python3
"""xdr-sync-agent 数据源适配器：抖店待开票（每日快照）
====================================================
采集「给消费者开票(待开票/待红冲) + 我给平台开票(待开票账单)」，写成 sqlite，
供 xdr-sync-agent 按 dataset 上传到阿里云数仓。

子命令：
    export-sqlite --output <path>   采集 + 导出 sqlite 到指定路径（agent 调这个）
    login-status                    登录态速查（agent doctor 调这个）

输出约定（与 xdr-sync-agent 的 runJson 一致）：最后一行打印 JSON。
"""
import argparse, json, os, shutil, sqlite3, sys
from datetime import datetime
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from cookies import collect as collect_cookies, CookieSourceError
from invoice import fetch_shop_pending

SQLITE = os.path.join(HERE, 'data', 'invoice.sqlite3')


def _emit_ok(data):
    print(json.dumps({"ok": True, "data": data}, ensure_ascii=False))


def _emit_fail(code, message, exit_code=1):
    print(json.dumps({"ok": False, "error": {"code": code, "message": message}}, ensure_ascii=False))
    sys.exit(exit_code)


def _now_shanghai():
    return datetime.now(ZoneInfo('Asia/Shanghai'))


def _today():
    return _now_shanghai().strftime('%Y-%m-%d')


def _shop_platform_id(shop):
    """从 cookie 里取平台店铺 id（SHOP_ID）。"""
    for c in shop.get('cookies', []):
        if c['name'] == 'SHOP_ID' and c.get('value'):
            return str(c['value'])
    return ''


def _money(v):
    """把 '￥ 109.80' / '￥109.80' 转成纯数字字符串 '109.80'；空/非法返回 ''。"""
    if v is None:
        return ''
    s = str(v).replace('￥', '').replace('¥', '').replace(',', '').strip()
    try:
        return ('%.2f' % float(s)) if s else ''
    except ValueError:
        return ''


def _money_sum(items, key):
    total = 0.0
    for x in items:
        try:
            total += float(str(x.get(key) or 0).replace('￥', '').replace('¥', '').replace(',', '').strip() or 0)
        except ValueError:
            pass
    return round(total, 2)


def collect_rows():
    """采集全部店铺待开票，返回三张表的行。"""
    stat_date = _today()
    captured_at = _now_shanghai().isoformat()
    shops = collect_cookies(platform='抖店')
    daily_rows, consumer_rows, platform_rows = [], [], []
    ok_shops = fail_shops = 0
    for shop in shops:
        pid = _shop_platform_id(shop)
        try:
            r = fetch_shop_pending(shop)
        except Exception as e:
            daily_rows.append((
                stat_date, shop['id'], shop['name'], pid, captured_at,
                '', '', '', '', '', '', 'error', str(e)[:200]))
            fail_shops += 1
            continue
        cp = r['consumer_pending']
        cr = r['consumer_red']
        pb = r['platform_bills']
        cp_amt = _money_sum(cp, 'invoice_amount')
        cr_amt = _money_sum(cr, 'invoice_amount')
        pb_amt = round(sum(x['bill_amount_yuan'] or 0 for x in pb), 2)
        daily_rows.append((
            stat_date, shop['id'], shop['name'], pid, captured_at,
            str(len(cp)), cp_amt, str(len(cr)), cr_amt,
            str(len(pb)), pb_amt, 'ok', ''))
        for x in cp:
            consumer_rows.append((
                stat_date, shop['id'], shop['name'],
                x.get('shop_order_id'), x.get('registation_id'),
                x.get('title'), x.get('tax_no'), x.get('invoice_type'),
                _money(x.get('invoice_amount')), x.get('apply_time'),
                x.get('order_status'), x.get('invoice_status'),
                x.get('deadline_time'), x.get('deadline_text'),
                x.get('sub_order_no')))
        for x in cr:
            consumer_rows.append((
                stat_date, shop['id'], shop['name'],
                x.get('shop_order_id'), x.get('registation_id'),
                x.get('title'), x.get('tax_no'), x.get('invoice_type'),
                _money(x.get('invoice_amount')), x.get('apply_time'),
                x.get('order_status'), x.get('invoice_status'),
                x.get('deadline_time'), x.get('deadline_text'),
                x.get('sub_order_no')))
        for x in pb:
            platform_rows.append((
                stat_date, shop['id'], shop['name'],
                x.get('credit_code'), x.get('bill_id'), x.get('scene'),
                x.get('scene_text'), x.get('bill_amount_yuan'), x.get('bill_amount_raw'),
                x.get('order_count'), x.get('bill_period'), x.get('create_time'),
                x.get('corp_title'), x.get('corp_tax_no'),
                '1' if x.get('is_frozen') else '0',
                x.get('pay_status'), x.get('unpay_amount')))
        ok_shops += 1
    if fail_shops >= len(shops) and shops:
        raise RuntimeError('全部店铺采集失败，疑似登录失效')
    return stat_date, daily_rows, consumer_rows, platform_rows, ok_shops, fail_shops


def _write_sqlite(path):
    stat_date, daily_rows, consumer_rows, platform_rows, ok_shops, fail_shops = collect_rows()
    db = sqlite3.connect(path)
    try:
        db.execute('CREATE TABLE IF NOT EXISTS invoice_daily ('
                   'stat_date TEXT, shop_id TEXT, shop_name TEXT, platform_shop_id TEXT, captured_at TEXT,'
                   'consumer_pending_count TEXT, consumer_pending_amount TEXT,'
                   'consumer_red_count TEXT, consumer_red_amount TEXT,'
                   'platform_bill_count TEXT, platform_bill_amount TEXT,'
                   'steps_ok TEXT, notes TEXT, PRIMARY KEY (stat_date, shop_id))')
        db.execute('CREATE TABLE IF NOT EXISTS consumer_invoice ('
                   'stat_date TEXT, shop_id TEXT, shop_name TEXT,'
                   'shop_order_id TEXT, registation_id TEXT, title TEXT, tax_no TEXT,'
                   'invoice_type TEXT, invoice_amount TEXT, apply_time TEXT, order_status TEXT,'
                   'invoice_status TEXT, deadline_time TEXT, deadline_text TEXT, sub_order_no TEXT,'
                   'PRIMARY KEY (stat_date, shop_id, shop_order_id))')
        db.execute('CREATE TABLE IF NOT EXISTS platform_invoice_bill ('
                   'stat_date TEXT, shop_id TEXT, shop_name TEXT,'
                   'credit_code TEXT, bill_id TEXT, scene TEXT, scene_text TEXT,'
                   'bill_amount_yuan TEXT, bill_amount_raw TEXT, order_count TEXT, bill_period TEXT,'
                   'create_time TEXT, corp_title TEXT, corp_tax_no TEXT, is_frozen TEXT,'
                   'pay_status TEXT, unpay_amount TEXT,'
                   'PRIMARY KEY (stat_date, shop_id, bill_id))')
        db.executemany('INSERT OR REPLACE INTO invoice_daily VALUES ('
                       + ','.join('?' * 13) + ')', daily_rows)
        db.executemany('INSERT OR REPLACE INTO consumer_invoice VALUES ('
                       + ','.join('?' * 15) + ')', consumer_rows)
        db.executemany('INSERT OR REPLACE INTO platform_invoice_bill VALUES ('
                       + ','.join('?' * 17) + ')', platform_rows)
        db.commit()
    finally:
        db.close()
    return stat_date, ok_shops, fail_shops, len(daily_rows), len(consumer_rows), len(platform_rows)


def export_sqlite(output):
    os.makedirs(os.path.dirname(os.path.abspath(output)), exist_ok=True)
    os.makedirs(os.path.dirname(SQLITE), exist_ok=True)
    try:
        stat_date, ok, fail, daily_n, consumer_n, platform_n = _write_sqlite(SQLITE)
    except (CookieSourceError, RuntimeError) as e:
        _emit_fail('collect_failed', str(e))
    shutil.copy2(SQLITE, output)
    os.chmod(output, 0o600)
    _emit_ok({"stat_date": stat_date, "shops": ok + fail, "shops_ok": ok, "shops_failed": fail,
              "invoice_daily_rows": daily_n, "consumer_invoice_rows": consumer_n,
              "platform_invoice_bill_rows": platform_n})


def login_status():
    try:
        shops = collect_cookies(platform='抖店')
    except CookieSourceError as e:
        _emit_fail('no_appdata', str(e))
    usable = [s for s in shops if s['cookie_count']]
    authed = [s for s in usable
              if any(c['name'] in ('sessionid', 'sid_guard', 'sid_tt') for c in s['cookies'])]
    _emit_ok({
        "shops": len(shops),
        "usable": len(usable),
        "authenticated": len(authed),
        "names": [s['name'] for s in authed],
    })


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    e = sub.add_parser('export-sqlite'); e.add_argument('--output', required=True)
    ls = sub.add_parser('login-status'); ls.add_argument('--date'); ls.add_argument('--end-date')
    args = ap.parse_args()
    if args.cmd == 'export-sqlite':
        export_sqlite(args.output)
    elif args.cmd == 'login-status':
        login_status()


if __name__ == '__main__':
    main()
