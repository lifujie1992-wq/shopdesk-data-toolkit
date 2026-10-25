#!/usr/bin/env python3
"""xdr-sync-agent 数据源适配器：聚水潭紫旗(刷单)订单明细。

子命令:
    export-sqlite --output <path> [--days 7]   拉近 N 天紫旗单写入 sqlite（agent 调这个）
    login-status                                登录态速查（agent doctor 调这个）

输出约定（与 xdr-sync-agent 的 runJson 一致）：stdout 最后一行打印 JSON：
    {"ok": true, "data": {...}}  /  {"ok": false, "error": {"code": "...", "message": "..."}}
进度信息一律走 stderr，避免污染 stdout。
"""
import argparse
import json
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import jst_purple_orders as JPO


def _emit_ok(data):
    print(json.dumps({"ok": True, "data": data}, ensure_ascii=False))


def _emit_fail(code, message, exit_code=1):
    print(json.dumps({"ok": False, "error": {"code": code, "message": message}}, ensure_ascii=False))
    sys.exit(exit_code)


def export_sqlite(output, days=7):
    real_out = sys.stdout
    sys.stdout = sys.stderr  # jst_purple_orders.sync 的进度打去 stderr
    try:
        JPO.sync(days=days, output=output)
    except Exception as exc:  # noqa: BLE001
        sys.stdout = real_out
        _emit_fail("collect_failed", str(exc)[:500])
    finally:
        sys.stdout = real_out
    os.makedirs(os.path.dirname(os.path.abspath(output)), exist_ok=True)
    os.chmod(output, 0o600)
    db = sqlite3.connect(f"file:{output}?mode=ro", uri=True)
    try:
        rows = db.execute("SELECT count(*) FROM purple_orders").fetchone()[0]
        dates = db.execute("SELECT count(DISTINCT stat_date) FROM purple_orders").fetchone()[0]
        review_rows = db.execute("SELECT count(*) FROM purple_review_daily").fetchone()[0]
    finally:
        db.close()
    _emit_ok({"rows": rows, "stat_dates": dates,
              "review_daily_rows": review_rows, "window_days": days})


def login_status():
    try:
        import jst_brush
        jst_brush.load_session()
        _emit_ok({"logged_in": True})
    except Exception as exc:  # noqa: BLE001
        _emit_fail("auth_required", str(exc)[:200])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["export-sqlite", "login-status"])
    ap.add_argument("--output")
    ap.add_argument("--days", type=int, default=7)
    args = ap.parse_args()
    if args.command == "export-sqlite":
        if not args.output:
            _emit_fail("invalid_arguments", "--output required")
        export_sqlite(args.output, args.days)
    else:
        login_status()


if __name__ == "__main__":
    main()
