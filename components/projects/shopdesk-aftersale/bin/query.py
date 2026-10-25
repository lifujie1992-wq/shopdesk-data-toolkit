#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""查看本地 JSON 采集结果（~ /shopdesk-aftersale/data）。

用法：
  python3 query.py                       # 各店最新快照（data/latest.json）+ 合计
  python3 query.py --runs                # 最近 20 轮采集概况
  python3 query.py --history 香朵儿       # 某店最近 20 次（history.jsonl）
  python3 query.py --at "2026-10-17 16"  # 指定时间点各店快照
  python3 query.py --json                # 输出 latest.json 原始 JSON
"""
import argparse
import glob
import json
import os

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 项目根（脚本在 bin/）
DATA = os.path.join(BASE, "data")
RUNS = os.path.join(DATA, "runs")
LATEST = os.path.join(DATA, "latest.json")
HISTORY = os.path.join(DATA, "history.jsonl")
KEYS = ["unshipped_refund", "shipped_refund", "return_refund", "exchange", "resend", "repair"]
HEAD = ["未发货退款", "已发货退款", "退货退款", "换货", "补寄", "维修"]


def table(rows, headers):
    rows = [[("" if v is None else str(v)) for v in r] for r in rows]
    widths = [max([len(h)] + [len(r[i]) for r in rows]) for i, h in enumerate(headers)]
    out = ["  ".join(h.ljust(widths[i]) for i, h in enumerate(headers)),
           "  ".join("-" * w for w in widths)]
    out += ["  ".join(r[i].ljust(widths[i]) for i in range(len(headers))) for r in rows]
    return "\n".join(out)


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def run_files():
    return sorted(glob.glob(os.path.join(RUNS, "*.json")))


def read_runs():
    out = []
    for p in run_files():
        try:
            out.append(load(p))
        except Exception:
            pass
    out.sort(key=lambda r: r.get("started_at") or "")
    return out


def print_snapshot(run):
    shops = [s for s in run.get("shops", []) if s.get("status") == "ok"]
    shops.sort(key=lambda s: (-(s.get("total_count") or 0), s.get("shop_name") or ""))
    rows = [[s["shop_name"], s["captured_at"]] + [s["counts"].get(k) for k in KEYS] + [s["total_count"]]
            for s in shops]
    print(table(rows, ["店铺", "采集时间"] + HEAD + ["合计"]))
    sums = [sum((s["counts"].get(k) or 0) for s in shops) for k in KEYS]
    print(table([["合计", ""] + sums + [sum(sums)]], ["店铺", "采集时间"] + HEAD + ["合计"]))
    bad = [s for s in run.get("shops", []) if s.get("status") != "ok"]
    if bad:
        print("\n未取到数据的店铺：" + "、".join("%s(%s)" % (s["shop_name"], s["status"]) for s in bad))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--history", metavar="SHOP")
    ap.add_argument("--runs", action="store_true")
    ap.add_argument("--at", metavar="TIME", help='如 "2026-10-17 16" 或 2026-10-17T16:00:00')
    ap.add_argument("--days", type=int, default=0, help="配合 --history，只看最近 N 天")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    if args.json:
        print(json.dumps(load(LATEST), ensure_ascii=False, indent=1))
        return

    if args.runs:
        runs = read_runs()[-20:]
        rows = [[r["run_id"], r["started_at"], r.get("finished_at") or "",
                 r.get("shops_total"), r.get("shops_ok"), r.get("shops_failed"), r.get("total_count")]
                for r in runs]
        print(table(rows, ["run_id", "开始", "结束", "店铺数", "成功", "失败", "待审核合计"]))
        return

    if args.history:
        if not os.path.exists(HISTORY):
            raise SystemExit("还没有 history.jsonl")
        cutoff = None
        if args.days:
            import datetime
            cutoff = (datetime.datetime.now() - datetime.timedelta(days=args.days)).isoformat(timespec="seconds")
        rows = []
        with open(HISTORY, encoding="utf-8") as f:
            for line in f:
                try:
                    r = json.loads(line)
                except Exception:
                    continue
                if args.history not in (r.get("shop_name") or ""):
                    continue
                if cutoff and (r.get("captured_at") or "") < cutoff:
                    continue
                rows.append(r)
        rows.sort(key=lambda r: r.get("captured_at") or "")
        rows = rows[-20:]
        if not rows:
            raise SystemExit("没有匹配的店铺记录")
        print(table([[r["captured_at"]] + [r["counts"].get(k) for k in KEYS] +
                     [r.get("total_count"), r.get("status")] for r in rows],
                    ["采集时间"] + HEAD + ["合计", "状态"]))
        return

    if args.at:
        pivot = args.at.replace("T", " ")
        best = {}
        for run in read_runs():
            for s in run.get("shops", []):
                ts = (s.get("captured_at") or "").replace("T", " ")
                if s.get("status") != "ok" or ts > pivot:
                    continue
                if s["shop_id"] not in best or ts > best[s["shop_id"]]["captured_at"]:
                    best[s["shop_id"]] = s
        shops = sorted(best.values(), key=lambda s: (-(s.get("total_count") or 0), s["shop_name"]))
        if not shops:
            raise SystemExit("该时间点之前没有成功数据")
        rows = [[s["shop_name"], s["captured_at"]] + [s["counts"].get(k) for k in KEYS] + [s["total_count"]]
                for s in shops]
        print(table(rows, ["店铺", "采集时间"] + HEAD + ["合计"]))
        sums = [sum((s["counts"].get(k) or 0) for s in shops) for k in KEYS]
        print(table([["合计", ""] + sums + [sum(sums)]], ["店铺", "采集时间"] + HEAD + ["合计"]))
        return

    if not os.path.exists(LATEST):
        raise SystemExit("还没有数据：%s" % LATEST)
    print_snapshot(load(LATEST))


if __name__ == "__main__":
    main()
