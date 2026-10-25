#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""每 30 分钟采集「店铺工作台」中已登录抖店店铺的售后工作台
「快捷筛选 → 待商家审核」6 个分项数量，写入本地 JSON。

数据来源：售后工作台官方接口
  POST https://fxg.jinritemai.com/after_sale/pc/list
6 个分项（对应页面角标，取接口返回的 total）：
  未发货退款 presale_all_audit
  已发货退款 refund_audit
  退货退款   return_audit
  换货       exchange_audit
  补寄       resend_audit
  维修       repair_audit

登录态说明：不发 Cookie、不落盘 Cookie。脚本通过「店铺工作台」本机接口
(start_exploration) 打开该店独立会话的隐藏页面，在页面内 fetch 官方接口，
读取 total 后立即关闭页面。凭据只存在于工作台进程与该隐藏页面内存中。
"""

import argparse
import fcntl
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone

HOME = os.path.expanduser("~")
APP_SUPPORT = os.path.join(HOME, "Library", "Application Support", "shopdesk")
BRIDGE = os.path.join(APP_SUPPORT, "agent-bridge.json")
SHOPS = os.path.join(APP_SUPPORT, "shops.json")
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 项目根（脚本在 bin/）
DATA_DIR = os.path.join(BASE, "data")
RUNS_DIR = os.path.join(DATA_DIR, "runs")
LATEST = os.path.join(DATA_DIR, "latest.json")
HISTORY = os.path.join(DATA_DIR, "history.jsonl")
LOCK_PATH = os.path.join(BASE, "data", ".scrape.lock")
LOG_PATH = os.path.join(BASE, "logs", "scrape.log")
STATUS_PATH = os.path.join(DATA_DIR, "status.json")
PAGE_WAIT_TIMEOUT = 60
ROUND_WAIT_BUDGET = 120

LIST_URL = "https://fxg.jinritemai.com/ffa/merchant-aftersale-workbench/aftersale/list"
CST = timezone(timedelta(hours=8))
RETAIN_DAYS = 180           # 原始采集保留天数
SHOP_TIMEOUT = 45           # 单店最长耗时（秒）
PAGE_READY_TIMEOUT = 25     # 隐藏页加载等待上限（秒）

TABS = [
    ("presale_all_audit", "未发货退款", "unshipped_refund"),
    ("refund_audit", "已发货退款", "shipped_refund"),
    ("return_audit", "退货退款", "return_refund"),
    ("exchange_audit", "换货", "exchange"),
    ("resend_audit", "补寄", "resend"),
    ("repair_audit", "维修", "repair"),
]
DB_COLS = [t[2] for t in TABS]


# ---------------------------------------------------------------- logging
def log(msg):
    line = "[%s] %s" % (datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S"), msg)
    print(line, flush=True)
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


# ---------------------------------------------------------------- bridge
def load_bridge():
    if not os.path.exists(BRIDGE):
        raise SystemExit("未找到 %s：请先启动「店铺工作台」。" % BRIDGE)
    with open(BRIDGE, encoding="utf-8") as f:
        st = json.load(f)
    port, token = int(st["port"]), st["token"]
    if not (1 <= port <= 65535) or len(token) != 64:
        raise SystemExit("店铺工作台本机接口信息无效，请重启工作台。")
    return port, token


def make_caller(port, token, reload_bridge=False):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def call(payload, timeout=SHOP_TIMEOUT + 15):
        # 本机接口只接受回环地址 + Bearer；凭据仅放在请求头，不写日志、不入库。
        try:
            current_port, current_token = load_bridge() if reload_bridge else (port, token)
        except (Exception, SystemExit):
            return {"error": "工作台连接信息不可用，请检查工作台运行状态", "code": "BRIDGE_UNAVAILABLE"}
        req = urllib.request.Request(
            "http://127.0.0.1:%d/call" % current_port,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "Authorization": "Bearer " + current_token,
                "Content-Type": "application/json",
                "X-ShopDesk-Client": "codex-skill",
            },
        )
        try:
            with opener.open(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            try:
                problem = json.loads(body)
                msg = problem.get("error") or "工作台拒绝请求"
            except Exception:
                problem, msg = {}, "工作台接口错误"
            return {"error": str(msg)[:300], "code": problem.get("code")}
        except Exception as e:  # 网络/超时/JSON
            return {"error": "%s: %s" % (type(e).__name__, str(e)[:200])}

    return call


# ---------------------------------------------------------------- in-page JS
# 只读：页码固定 1、pageSize 1，仅读取 total，不拉取订单明细、不做任何写操作。
JS_COUNTS = r"""
(async () => {
  const API = 'https://fxg.jinritemai.com/after_sale/pc/list?appid=1&_bid=ffa_aftersale&aid=4272&aftersale_platform_source=fxg';
  const TABS = %(tabs)s;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const out = {};
  for (const [tab, label] of TABS) {
    let res = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const body = {
          pageSize: 1, page: 1, after_sale_tab: tab,
          order_by: ['status_deadline asc'], conf_version: 'v13',
          shop_hit_gray_info: { list_v1: { hit: true } }
        };
        const r = await fetch(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'accept': 'application/json' },
          body: JSON.stringify(body),
          credentials: 'include'
        });
        const j = await r.json();
        if (r.status === 200 && j.code === 0 && j.st === 0 && typeof j.total === 'number') {
          res = { ok: true, total: j.total };
          break;
        }
        res = { ok: false, http: r.status, code: j.code, st: j.st, msg: j.msg || j.message || '' };
        if (j.code === 10003) break;           // 参数/权限错误，重试无意义
      } catch (e) {
        res = { ok: false, msg: String(e).slice(0, 120) };
      }
      await sleep(800);
    }
    out[tab] = Object.assign({ label }, res || { ok: false, msg: 'no response' });
  }
  return JSON.stringify({ counts: out, url: location.href, at: Date.now() });
})()
"""


def js_counts():
    tabs = [[t[0], t[1]] for t in TABS]
    return JS_COUNTS % {"tabs": json.dumps(tabs, ensure_ascii=False)}


# ---------------------------------------------------------------- collect one shop
def acquire_page(call, shop, wait_budget, *, sleep=time.sleep, clock=time.monotonic):
    """Wait in the client; never occupy the workbench API queue while waiting."""
    started = clock()
    allowance = min(PAGE_WAIT_TIMEOUT, max(0, wait_budget["remaining"]))
    waited = False
    try:
        while True:
            result = call({"method": "start_exploration", "args": {
                "shop_id": shop["id"], "url": LIST_URL, "owner": "aftersale-counts"}})
            if not isinstance(result, dict) or "error" not in result:
                return result
            busy = result.get("code") == "EXPLORATION_BUSY" or "已有后台探索页面" in str(result.get("error"))
            if not busy:
                return result
            waited = True
            remaining = allowance - (clock() - started)
            if remaining <= 0:
                return {"error": "等待后台页面名额超时（单次最多60秒，整轮最多等待120秒）",
                        "code": "EXPLORATION_WAIT_TIMEOUT"}
            sleep(min(1, remaining))
    finally:
        if waited:
            wait_budget["remaining"] = max(0, wait_budget["remaining"] - (clock() - started))


def fetch_shop(call, shop, wait_budget=None):
    """Read one shop and close only the page returned to this call."""
    started = time.time()
    if wait_budget is None:
        wait_budget = {"remaining": ROUND_WAIT_BUDGET}
    r = acquire_page(call, shop, wait_budget)
    if not isinstance(r, dict) or "result" not in r:
        err = (r or {}).get("error") if isinstance(r, dict) else "invalid response"
        return {"status": "error", "error": "打开后台页失败: %s" % (err or "unknown")}
    eid = r["result"]["id"]

    try:
        # 等隐藏页进入售后工作台（或被重定向到登录页）
        ready = False
        deadline = time.time() + PAGE_READY_TIMEOUT
        while time.time() < deadline:
            time.sleep(1.2)
            q = call({
                "method": "exploration_command",
                "args": {"id": eid, "method": "Runtime.evaluate",
                         "params": {"expression": "JSON.stringify({s:document.readyState,u:location.href})"}},
            }, timeout=30)
            try:
                val = json.loads(q["result"]["result"]["result"]["value"])
            except Exception:
                continue
            url = val.get("u") or ""
            if "/login" in url or "/passport" in url:
                return {"status": "needs_login", "error": "会话已失效，需在工作台重新登录"}
            if val.get("s") in ("interactive", "complete") and "merchant-aftersale-workbench" in url:
                ready = True
                break
        if not ready:
            return {"status": "error", "error": "后台页加载超时"}

        q = call({
            "method": "exploration_command",
            "args": {"id": eid, "method": "Runtime.evaluate",
                     "params": {"expression": js_counts()}},
        }, timeout=SHOP_TIMEOUT)
        try:
            payload = json.loads(q["result"]["result"]["result"]["value"])
        except Exception:
            return {"status": "error", "error": "读取结果失败: %s" % str(q)[:160]}

        counts, failed = {}, []
        for tab, label, key in TABS:
            row = (payload.get("counts") or {}).get(tab) or {}
            if row.get("ok"):
                counts[key] = int(row["total"])
            else:
                counts[key] = None
                failed.append("%s(%s)" % (label, row.get("code") or row.get("http") or row.get("msg") or "?"))
        if failed:
            return {"status": "error", "counts": counts,
                    "error": "部分分项失败: " + ", ".join(failed)}
        return {"status": "ok", "counts": counts,
                "seconds": round(time.time() - started, 1)}
    finally:
        call({"method": "close_exploration", "args": {"id": eid}}, timeout=30)


def collect_shops(call, shops, quiet=False, fetch=None):
    fetch = fetch or fetch_shop
    records = [None] * len(shops)
    budget = {"remaining": ROUND_WAIT_BUDGET}
    retry = []
    def collect(index, attempt):
        shop = shops[index]
        try:
            result = fetch(call, shop, budget)
        except Exception as error:
            result = {"status": "error", "error": "%s: %s" % (type(error).__name__, str(error)[:160])}
        record = shop_record(shop, result, datetime.now(CST).isoformat(timespec="seconds"))
        records[index] = record
        if not quiet:
            log("[%d/%d] %s 第%d次 %s %s" % (index + 1, len(shops), record["shop_name"], attempt,
                record["status"], "合计=%s" % record["total_count"] if record["status"] == "ok" else record["error"]))
        return record
    for index in range(len(shops)):
        if collect(index, 1)["status"] != "ok":
            retry.append(index)
    if retry:
        log("首轮有%d家未成功，开始轮末补采一次；补采结束后才判断本轮是否失败" % len(retry))
        for index in retry:
            collect(index, 2)
    return records


def native_run_number():
    if os.environ.get("XPC_SERVICE_NAME") != "local.shopdesk.aftersale-counts":
        return None
    try:
        text = subprocess.check_output(["/bin/launchctl", "print", "gui/%d/local.shopdesk.aftersale-counts" % os.getuid()],
                                       text=True, timeout=3, stderr=subprocess.DEVNULL)
        match = re.search(r"^\s*runs = (\d+)", text, re.M)
        return int(match.group(1)) if match else None
    except Exception:
        return None


def final_status(run):
    failed = [s for s in run["shops"] if s["status"] != "ok"]
    return {"run_id": run["run_id"], "launchd_runs": native_run_number(), "completed_at": run["finished_at"],
            "shops_total": run["shops_total"], "shops_ok": run["shops_ok"], "shops_failed": len(failed),
            "exit_code": 2 if failed else 0, "retry_complete": True,
            "errors": [{"shop": s["shop_name"], "reason": s["error"]} for s in failed]}


# ---------------------------------------------------------------- storage (JSON)
def jdump(path, obj):
    """原子写：先写临时文件再 rename，避免中途被杀留下半个 JSON。"""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def shop_record(shop, res, captured_at):
    counts = res.get("counts") or {}
    vals = [counts.get(k) for k in DB_COLS]
    known = [v for v in vals if v is not None]
    return {
        "shop_id": shop["id"],
        "shop_name": shop.get("name") or "",
        "platform": shop.get("platform") or "抖店",
        "captured_at": captured_at,
        "status": res.get("status") or "error",
        "error": res.get("error"),
        "seconds": res.get("seconds"),
        "counts": {k: counts.get(k) for k in DB_COLS},
        "total_count": sum(known) if known else None,
    }


def write_run(run):
    """写单轮明细 + 覆盖 latest.json + 追加 history.jsonl。"""
    os.makedirs(RUNS_DIR, exist_ok=True)
    jdump(os.path.join(RUNS_DIR, "%s.json" % run["run_id"]), run)
    jdump(LATEST, run)
    with open(HISTORY, "a", encoding="utf-8") as f:
        for s in run["shops"]:
            f.write(json.dumps({"run_id": run["run_id"], "captured_at": s["captured_at"],
                                "shop_id": s["shop_id"], "shop_name": s["shop_name"],
                                "status": s["status"], "error": s["error"],
                                "counts": s["counts"], "total_count": s["total_count"]},
                               ensure_ascii=False) + "\n")


def prune():
    if not RETAIN_DAYS:
        return
    cutoff = time.time() - RETAIN_DAYS * 86400
    # 旧轮次文件
    if os.path.isdir(RUNS_DIR):
        for fn in os.listdir(RUNS_DIR):
            fp = os.path.join(RUNS_DIR, fn)
            try:
                if fn.endswith(".json") and os.path.getmtime(fp) < cutoff:
                    os.remove(fp)
            except OSError:
                pass
    # history.jsonl 按 captured_at 裁剪
    if os.path.exists(HISTORY):
        keep = []
        with open(HISTORY, encoding="utf-8") as f:
            for line in f:
                try:
                    row = json.loads(line)
                    ts = row.get("captured_at") or ""
                except Exception:
                    continue
                if ts >= datetime.fromtimestamp(cutoff, CST).isoformat(timespec="seconds"):
                    keep.append(line if line.endswith("\n") else line + "\n")
        if len(keep) != sum(1 for _ in open(HISTORY, encoding="utf-8")):
            tmp = HISTORY + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                f.writelines(keep)
            os.replace(tmp, HISTORY)


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description="采集抖店售后工作台待商家审核 6 项数量")
    ap.add_argument("--shop", help="只跑名称包含该关键字的店铺（调试用）")
    ap.add_argument("--limit", type=int, help="最多跑多少家店（调试用）")
    ap.add_argument("--quiet", action="store_true", help="不输出逐店日志")
    ap.add_argument("--no-write", action="store_true", help="只采集不落盘（调试用）")
    ap.add_argument("--force-write", action="store_true", help="调试过滤时也写入 latest/history")
    args = ap.parse_args()

    # 防重入：上一轮未结束时本轮直接退出（launchd 每 30 分钟触发）
    os.makedirs(DATA_DIR, exist_ok=True)
    lockf = open(LOCK_PATH, "w")
    try:
        fcntl.flock(lockf, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        log("上一轮采集仍在运行，本轮跳过")
        return 0

    port, token = load_bridge()
    call = make_caller(port, token, reload_bridge=True)
    capability = call({"method": "exploration_status", "args": {}}, timeout=10)
    if not isinstance(capability, dict) or capability.get("result", {}).get("version", 0) < 2:
        log("后台页面接口尚未升级或不可用，请检查工作台；未打开或关闭任何探索页面")
        return 1

    try:
        with open(SHOPS, encoding="utf-8") as f:
            shops = json.load(f)
    except Exception as e:
        log("读取店铺清单失败：%s" % e)
        return 1

    shops = [s for s in shops if (s.get("platform") or "抖店") == "抖店"]
    if args.shop:
        shops = [s for s in shops if args.shop in (s.get("name") or "") or s.get("id") == args.shop]
    if args.limit:
        shops = shops[: args.limit]
    if not shops:
        log("没有可采集的抖店店铺")
        return 0

    run_id = datetime.now(CST).strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    run = {
        "run_id": run_id,
        "started_at": datetime.now(CST).isoformat(timespec="seconds"),
        "finished_at": None,
        "source": LIST_URL + "  (after_sale_tab total)",
        "columns": {t[2]: t[1] for t in TABS},
        "shops_total": len(shops),
        "shops_ok": 0,
        "shops_failed": 0,
        "total_count": 0,
        "shops": [],
    }

    t0 = time.time()
    log("开始采集 run=%s 店铺=%d" % (run_id, len(shops)))

    run["shops"] = collect_shops(call, shops, quiet=args.quiet)
    run["shops_ok"] = sum(s["status"] == "ok" for s in run["shops"])
    run["shops_failed"] = len(shops) - run["shops_ok"]
    run["total_count"] = sum(s["total_count"] or 0 for s in run["shops"] if s["status"] == "ok")

    run["finished_at"] = datetime.now(CST).isoformat(timespec="seconds")
    run["seconds"] = round(time.time() - t0, 1)

    # --shop / --limit 属于调试过滤：默认不覆盖 latest.json、不追加 history.jsonl
    write = not args.no_write and not ((args.shop or args.limit) and not args.force_write)
    if write:
        write_run(run)
        jdump(STATUS_PATH, final_status(run))
        prune()
        # 上云推送：失败只记录，绝不中断采集（本地 JSON 是事实来源）
        try:
            import push
            push.push_run(os.path.join(RUNS_DIR, "%s.json" % run_id))
        except (Exception, SystemExit) as e:
            log("推送层未完成（不影响采集）：%s" % str(e)[:200])

    log("完成 run=%s 成功=%d 失败=%d 待商家审核合计=%d 耗时=%.1fs"
        % (run_id, run["shops_ok"], run["shops_failed"], run["total_count"], run["seconds"]))
    return 0 if run["shops_failed"] == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
