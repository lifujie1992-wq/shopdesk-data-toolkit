#!/usr/bin/env python3
"""
xdr-sync-agent 数据源适配器：抖店每日指标（客户店铺，独立数据集 doudian_client）
===============================================================================
与 doudian_sync.py 同逻辑，但把客户店铺数据写入独立的 sqlite
（data/shop_metrics_client.sqlite3），与自营店铺数据彻底隔离。

子命令：
    export-sqlite --output <path>   采集客户店铺 + 导出 sqlite 到指定路径
    login-status                    登录态速查

店铺范围：
    若存在 client_shops.json（内容形如 ["店铺A","店铺B"]），只采集其中列出的店铺；
    否则采集工作台里当前所有已登录店铺（客户电脑上应只登录客户店铺）。
"""
import argparse, json, os, shutil, sqlite3, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
CLIENT_SQLITE = os.path.join(HERE, 'data', 'shop_metrics_client.sqlite3')
CLIENT_SHOPS_JSON = os.path.join(HERE, 'client_shops.json')


def _emit_ok(data):
    print(json.dumps({"ok": True, "data": data}, ensure_ascii=False))


def _emit_fail(code, message, exit_code=1):
    print(json.dumps({"ok": False, "error": {"code": code, "message": message}}, ensure_ascii=False))
    sys.exit(exit_code)


def _client_shop_names():
    """返回客户店铺名列表；None 表示没有配置（采工作台全部店铺）。"""
    if not os.path.exists(CLIENT_SHOPS_JSON):
        return None
    data = json.load(open(CLIENT_SHOPS_JSON, encoding='utf-8'))
    names = data if isinstance(data, list) else data.get('shops') or []
    return [str(n).strip() for n in names if str(n).strip()]


def _build_collect_args():
    names = _client_shop_names()
    if names is not None and not names:
        _emit_fail('no_client_shops',
                   f'{CLIENT_SHOPS_JSON} 为空：请先填入客户店铺名（[] 改为 ["店铺名"]），'
                   '或删除该文件以采集工作台全部店铺')
    args = [sys.executable, os.path.join(HERE, 'daily_collect.py'),
            '--sqlite', CLIENT_SQLITE,
            '--json', os.path.join(HERE, 'data', 'client-latest.json')]
    if names:
        for n in names:
            args += ['--only', n]
    return args


def export_sqlite(output):
    args = _build_collect_args()
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0:
        tail = (r.stderr or r.stdout).strip().splitlines()
        _emit_fail('collect_failed', '\n'.join(tail[-12:])[-600:], r.returncode)
    if not os.path.exists(CLIENT_SQLITE):
        _emit_fail('no_sqlite', f'{CLIENT_SQLITE} 不存在（采集未产出）')
    os.makedirs(os.path.dirname(os.path.abspath(output)), exist_ok=True)
    shutil.copy2(CLIENT_SQLITE, output)
    os.chmod(output, 0o600)
    db = sqlite3.connect(f'file:{output}?mode=ro', uri=True)
    try:
        daily = db.execute('SELECT count(*) FROM shop_metrics_daily').fetchone()[0]
        meta = db.execute('SELECT count(*) FROM shop_metrics_meta').fetchone()[0]
        stat_dates = db.execute('SELECT count(DISTINCT stat_date) FROM shop_metrics_daily').fetchone()[0]
        shops = db.execute('SELECT DISTINCT shop_name FROM shop_metrics_daily').fetchall()
    finally:
        db.close()
    _emit_ok({"daily_rows": daily, "meta_rows": meta, "stat_dates": stat_dates,
              "shops": [s[0] for s in shops]})


def login_status():
    import cookies as C
    try:
        shops = C.collect()
    except C.CookieSourceError as e:
        _emit_fail('no_appdata', str(e))
    names = _client_shop_names()
    if names is not None:
        shops = [s for s in shops if s['name'] in set(names)]
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
