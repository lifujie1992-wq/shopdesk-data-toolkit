#!/usr/bin/env python3
"""
xdr-sync-agent 数据源适配器：抖店每日指标
==========================================
把 daily_collect.py 的采集结果导出为 sqlite，供 xdr-sync-agent 按 dataset 上传到阿里云。

子命令：
    export-sqlite --output <path>   采集 + 导出 sqlite 到指定路径（agent 调这个）
    login-status                    登录态速查（agent doctor 调这个）

输出约定（与 xdr-sync-agent 的 runJson 一致）：最后一行打印 JSON，形如
    {"ok": true, "data": {...}}
    {"ok": false, "error": {"code": "...", "message": "..."}}
"""
import argparse, json, os, shutil, sqlite3, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SQLITE = os.path.join(HERE, 'data', 'shop_metrics.sqlite3')


def _emit_ok(data):
    print(json.dumps({"ok": True, "data": data}, ensure_ascii=False))


def _emit_fail(code, message, exit_code=1):
    print(json.dumps({"ok": False, "error": {"code": code, "message": message}}, ensure_ascii=False))
    sys.exit(exit_code)


def _run_collect(extra_args=None):
    """跑一次 daily_collect.py，返回 (returncode, stdout, stderr)。"""
    cmd = [sys.executable, os.path.join(HERE, 'daily_collect.py')] + (extra_args or [])
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r.returncode, r.stdout, r.stderr


def export_sqlite(output):
    rc, out, err = _run_collect()
    if rc != 0:
        tail = (err or out).strip().splitlines()
        _emit_fail('collect_failed', '\n'.join(tail[-12:])[-600:], rc)
    if not os.path.exists(SQLITE):
        _emit_fail('no_sqlite', f'{SQLITE} 不存在')
    os.makedirs(os.path.dirname(os.path.abspath(output)), exist_ok=True)
    shutil.copy2(SQLITE, output)
    os.chmod(output, 0o600)
    db = sqlite3.connect(f'file:{output}?mode=ro', uri=True)
    try:
        daily = db.execute('SELECT count(*) FROM shop_metrics_daily').fetchone()[0]
        meta = db.execute('SELECT count(*) FROM shop_metrics_meta').fetchone()[0]
        stat_dates = db.execute('SELECT count(DISTINCT stat_date) FROM shop_metrics_daily').fetchone()[0]
    finally:
        db.close()
    _emit_ok({"daily_rows": daily, "meta_rows": meta, "stat_dates": stat_dates})


def login_status():
    import cookies as C
    try:
        shops = C.collect()
    except C.CookieSourceError as e:
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
