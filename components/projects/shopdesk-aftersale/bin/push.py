#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""上云推送层：把 data/runs/<run_id>.json 推送到 aftersale 云端服务。

契约见 docs/cloud-api-design.md §3 / §5。本文件不修改采集逻辑，只负责：

  本地落盘(事实来源) → outbox 队列 → HTTPS POST /v1/ingest/runs → 成功/死信标记

特性
- 幂等：同一 run_id 重试复用同一 run_id，服务端 upsert
- 退避：网络错误 / 超时 / 429 / 5xx → 1、2、4 … 上限 30 分钟
- 死信：4xx（除 408/425/429）→ outbox/dead，不再重试
- 补传：--once 扫描最近 7 天、最多 200 轮未送达的 run
- 安全：token 只从环境变量或 ~/.config/aftersale/env(600) 读取，绝不打印
- 无第三方依赖（Python 3.9+）

CLI
  python3 push.py --check              # 探活 GET /health
  python3 push.py --once [--verbose]   # 扫描并推送一轮（cron/launchd 用）
  python3 push.py --watch              # 常驻，每 5 分钟补传
  python3 push.py --run-file data/runs/<run_id>.json [--force]
  python3 push.py --status             # outbox 概况
"""

import argparse
import hashlib
import hmac
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone

HOME = os.path.expanduser("~")
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 项目根（脚本在 bin/）
CST = timezone(timedelta(hours=8))

CLIENT = {"name": "shopdesk-mac", "version": "1.0.0", "timezone": "Asia/Shanghai"}
SCHEMA_VERSION = 1
TIMEOUT = 20
BACKOFF_BASE = 60
BACKOFF_MAX = 1800
BACKFILL_DAYS = 7
BACKFILL_MAX = 200
RETRY_HTTP = {408, 425, 429}
COUNT_KEYS = ["unshipped_refund", "shipped_refund", "return_refund", "exchange", "resend", "repair"]
RUN_KEYS = ["run_id", "started_at", "finished_at", "source",
            "shops_total", "shops_ok", "shops_failed", "total_count"]
SHOP_KEYS = ["shop_id", "shop_name", "platform", "captured_at",
             "status", "error", "counts", "total_count"]
ENV_FILE = os.path.join(HOME, ".config", "aftersale", "env")


# ---------------------------------------------------------------- 日志（绝不打印 token）
class Log:
    def __init__(self, path=None, verbose=False):
        self.path = path
        self.verbose = verbose

    def _write(self, msg):
        line = "[%s] %s" % (datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S"), msg)
        print(line, flush=True)
        if self.path:
            try:
                with open(self.path, "a", encoding="utf-8") as f:
                    f.write(line + "\n")
            except OSError:
                pass

    def info(self, msg):
        self._write(msg)

    def debug(self, msg):
        if self.verbose:
            self._write(msg)

    def warn(self, msg):
        self._write("WARN " + msg)

    def error(self, msg):
        self._write("ERROR " + msg)

    def exception(self, msg):
        self._write("ERROR " + msg)


# ---------------------------------------------------------------- 配置
def _read_env_file(path):
    out = {}
    if not os.path.exists(path):
        return out
    try:
        mode = os.stat(path).st_mode & 0o777
        if mode & 0o077:
            # 权限过宽：不读取，提示用户修正，避免 token 泄露
            raise SystemExit("%s 权限应为 600，当前为 %o；请执行 chmod 600 %s" % (path, mode, path))
    except SystemExit:
        raise
    except OSError:
        pass
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def load_config(require_token=True, require_url=True):
    """环境变量优先，其次 ~/.config/aftersale/env。"""
    cfg = _read_env_file(ENV_FILE)
    for k in ("AFTERSALE_API_URL", "AFTERSALE_API_TOKEN", "AFTERSALE_DATA_DIR",
              "AFTERSALE_HMAC_SECRET"):
        if os.environ.get(k):
            cfg[k] = os.environ[k]
    url = (cfg.get("AFTERSALE_API_URL") or "").strip().rstrip("/")
    token = (cfg.get("AFTERSALE_API_TOKEN") or "").strip()
    data_dir = (cfg.get("AFTERSALE_DATA_DIR") or os.path.join(BASE, "data")).strip()
    if require_url and not url:
        raise SystemExit("AFTERSALE_API_URL 未配置；请写入 %s 或环境变量（deploy/go-live.sh 可一键完成）" % ENV_FILE)
    if url and not url.startswith("https://") and not url.startswith("http://127.0.0.1") \
            and not url.startswith("http://localhost"):
        raise SystemExit("AFTERSALE_API_URL 必须是 https://（本机联调可用 http://127.0.0.1）")
    if require_token and (len(token) < 16):
        raise SystemExit("AFTERSALE_API_TOKEN 缺失或过短（≥16 字符）；"
                         "请配置环境变量或 %s（chmod 600）" % ENV_FILE)
    return {"url": url, "token": token, "data_dir": data_dir,
            "hmac_secret": (cfg.get("AFTERSALE_HMAC_SECRET") or "").strip()}


# ---------------------------------------------------------------- outbox
class Outbox:
    def __init__(self, data_dir):
        self.data_dir = data_dir
        self.runs_dir = os.path.join(data_dir, "runs")
        self.root = os.path.join(data_dir, "outbox")
        self.sent_dir = os.path.join(self.root, "sent")
        self.dead_dir = os.path.join(self.root, "dead")
        self.state_path = os.path.join(self.root, "state.json")
        for d in (self.runs_dir, self.sent_dir, self.dead_dir):
            os.makedirs(d, exist_ok=True)
        self.state = self._load_state()

    def _load_state(self):
        try:
            with open(self.state_path, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}

    def save_state(self):
        tmp = self.state_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.state, f, ensure_ascii=False, indent=1)
        os.replace(tmp, self.state_path)
        try:
            os.chmod(self.state_path, 0o600)
        except OSError:
            pass

    def marker(self, run_id, kind):
        return os.path.join(self.sent_dir if kind == "sent" else self.dead_dir, run_id + ".json")

    def is_sent(self, run_id):
        return os.path.exists(self.marker(run_id, "sent"))

    def is_dead(self, run_id):
        return os.path.exists(self.marker(run_id, "dead"))

    def mark(self, run_id, kind, receipt):
        path = self.marker(run_id, kind)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(receipt, f, ensure_ascii=False, indent=1)
        os.replace(tmp, path)
        self.state.pop(run_id, None)
        self.save_state()

    def next_attempt(self, run_id):
        return (self.state.get(run_id) or {}).get("next_attempt_at", 0)

    def record_attempt(self, run_id, http_status, error=None, retry_after=None):
        s = self.state.get(run_id) or {"attempts": 0}
        s["attempts"] = int(s.get("attempts") or 0) + 1
        s["last_attempt_at"] = int(time.time())
        s["last_http_status"] = http_status
        if error:
            s["last_error"] = str(error)[:500]
        delay = min(BACKOFF_BASE * (2 ** (s["attempts"] - 1)), BACKOFF_MAX)
        if retry_after:
            try:
                delay = max(60, min(int(float(retry_after)), BACKOFF_MAX))
            except ValueError:
                pass
        s["next_retry_in"] = delay
        s["next_attempt_at"] = int(time.time()) + delay
        self.state[run_id] = s
        self.save_state()
        return delay

    def pending_runs(self):
        """最近 7 天、最多 200 轮，未 sent / 未 dead 的 run 文件。"""
        cutoff = time.time() - BACKFILL_DAYS * 86400
        items = []
        for name in os.listdir(self.runs_dir):
            if not name.endswith(".json"):
                continue
            path = os.path.join(self.runs_dir, name)
            run_id = name[:-5]
            try:
                if os.path.getmtime(path) < cutoff:
                    continue
            except OSError:
                continue
            if self.is_sent(run_id) or self.is_dead(run_id):
                continue
            items.append((os.path.getmtime(path), path, run_id))
        items.sort()
        return [p for _, p, _ in items][:BACKFILL_MAX]


# ---------------------------------------------------------------- payload
def build_payload(run_path, log=None):
    with open(run_path, encoding="utf-8") as f:
        raw = json.load(f)
    shops_in = raw.get("shops") or []
    run = {k: raw.get(k) for k in RUN_KEYS if k in raw}
    shops = []
    fixed = 0
    for s in shops_in:
        item = {k: s.get(k) for k in SHOP_KEYS if k in s}
        item.setdefault("platform", "抖店")
        item.setdefault("error", None)
        status = item.get("status")
        if status == "ok":
            counts = item.get("counts")
            if not isinstance(counts, dict):
                counts = None
            if counts is not None:
                clean = {}
                for k in COUNT_KEYS:
                    v = counts.get(k)
                    clean[k] = int(v) if isinstance(v, (int, float)) and v >= 0 else None
                counts = clean
            item["counts"] = counts
            if all(counts.get(k) is not None for k in COUNT_KEYS):
                total = sum(counts[k] for k in COUNT_KEYS)
                if item.get("total_count") != total:
                    fixed += 1
                    item["total_count"] = total
            else:
                item["counts"] = None
                item["total_count"] = None
        else:
            # 没有数据必须 null，绝不写 0
            item["counts"] = None
            item["total_count"] = None
        shops.append(item)
    if fixed and log:
        log.warn("修正 %d 家店的 total_count（与 6 项之和不一致）" % fixed)
    return {
        "schema_version": SCHEMA_VERSION,
        "client": dict(CLIENT),
        "run": run,
        "shops": shops,
    }


# ---------------------------------------------------------------- http
def _post(url, token, body, hmac_secret=None):
    headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Accept": "application/json",
        "Authorization": "Bearer " + token,
        "User-Agent": "shopdesk-mac/1.0.0",
    }
    if hmac_secret:
        ts = str(int(time.time()))
        sig = hmac.new(hmac_secret.encode("utf-8"),
                       (ts + ".").encode("utf-8") + body, hashlib.sha256).hexdigest()
        headers["X-Timestamp"] = ts
        headers["X-Signature"] = sig
    req = urllib.request.Request(url, data=body, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return r.status, dict(r.headers), r.read().decode("utf-8", "replace"), None
    except urllib.error.HTTPError as e:
        payload = e.read().decode("utf-8", "replace")
        return e.code, dict(e.headers or {}), payload, None
    except Exception as e:  # 网络/DNS/超时/TLS
        return None, {}, "", "%s: %s" % (type(e).__name__, str(e)[:200])


def _request_id(resp_text):
    try:
        return (json.loads(resp_text).get("error") or {}).get("request_id")
    except Exception:
        return None


# ---------------------------------------------------------------- push
def push_run(run_path, force=False, verbose=False, cfg=None, log=None):
    """返回 True=已送达（含此前已送达）；False=进入重试队列或死信。"""
    cfg = cfg or load_config()
    log = log or Log(os.path.join(cfg["data_dir"], "push.log"), verbose)
    run_id = os.path.basename(run_path)[:-5]
    ob = Outbox(cfg["data_dir"])

    if not force:
        if ob.is_sent(run_id):
            log.debug("%s 已送达，跳过" % run_id)
            return True
        if ob.is_dead(run_id):
            log.debug("%s 已在 dead，跳过（--force 可重推）" % run_id)
            return False
        if ob.next_attempt(run_id) > time.time():
            log.debug("%s 退避中（%ds 后重试）" % (run_id, int(ob.next_attempt(run_id) - time.time())))
            return False

    payload = build_payload(run_path, log)
    if not payload["shops"]:
        log.warn("%s 没有 shops，标记 dead" % run_id)
        ob.mark(run_id, "dead", {"run_id": run_id, "reason": "empty_shops",
                                 "at": datetime.now(CST).isoformat(timespec="seconds")})
        return False

    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    url = cfg["url"] + "/v1/ingest/runs"
    t0 = time.time()
    status, headers, text, net_err = _post(url, cfg["token"], body, cfg.get("hmac_secret"))
    ms = int((time.time() - t0) * 1000)
    receipt = {"run_id": run_id, "http_status": status, "ms": ms,
               "at": datetime.now(CST).isoformat(timespec="seconds")}

    # 成功（含 200 + 部分拒收）
    if status and 200 <= status < 300:
        try:
            resp = json.loads(text)
        except Exception:
            resp = {}
        receipt.update({k: resp.get(k) for k in ("accepted", "rejected", "rejected_items", "server_time")})
        ob.mark(run_id, "sent", receipt)
        if resp.get("rejected"):
            log.warn("%s 已送达但 %s 家被拒收: %s" % (run_id, resp.get("rejected"),
                     json.dumps(resp.get("rejected_items"), ensure_ascii=False)[:300]))
        else:
            log.info("%s 推送成功 accepted=%s %dms" % (run_id, resp.get("accepted"), ms))
        return True

    # 不可重试的客户端错误
    if status and 400 <= status < 500 and status not in RETRY_HTTP:
        rid = _request_id(text)
        receipt.update({"reason": "permanent", "request_id": rid,
                        "error_body": (text or "")[:1000]})
        ob.mark(run_id, "dead", receipt)
        log.error("%s 永久失败 HTTP %s%s，已移入 dead；修复后用 --force 重推"
                  % (run_id, status, (" request_id=" + rid) if rid else ""))
        return False

    # 可重试
    retry_after = (headers or {}).get("Retry-After")
    delay = ob.record_attempt(run_id, status, net_err or (text or "")[:300], retry_after)
    rid = _request_id(text)
    log.error("%s 暂未送达（HTTP %s%s%s），%ds 后重试"
              % (run_id, status, (" " + net_err) if net_err else "",
                 (" request_id=" + rid) if rid else "", delay))
    return False


def push_once(verbose=False, cfg=None, force=False):
    cfg = cfg or load_config()
    log = Log(os.path.join(cfg["data_dir"], "push.log"), verbose)
    ob = Outbox(cfg["data_dir"])
    pending = ob.pending_runs()
    if not pending:
        log.debug("没有待推送的 run")
        return {"pending": 0, "sent": 0, "failed": 0}
    sent = failed = 0
    for path in pending:
        ok = push_run(path, force=force, verbose=verbose, cfg=cfg, log=log)
        sent += 1 if ok else 0
        failed += 0 if ok else 1
    log.info("本轮推送：待传=%d 成功=%d 未送达=%d" % (len(pending), sent, failed))
    return {"pending": len(pending), "sent": sent, "failed": failed}


# ---------------------------------------------------------------- cli
def cmd_check(cfg, log):
    url = cfg["url"] + "/health"
    req = urllib.request.Request(url, headers={"User-Agent": "shopdesk-mac/1.0.0"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            body = r.read().decode("utf-8", "replace")
            log.info("health HTTP %s %s" % (r.status, body[:300]))
            return 0
    except Exception as e:
        log.error("health 失败：%s: %s" % (type(e).__name__, str(e)[:200]))
        return 1


def cmd_status(cfg, log):
    ob = Outbox(cfg["data_dir"])
    sent = len([n for n in os.listdir(ob.sent_dir) if n.endswith(".json")])
    dead = len([n for n in os.listdir(ob.dead_dir) if n.endswith(".json")])
    pending = len(ob.pending_runs())
    retrying = sum(1 for v in ob.state.values() if v.get("next_attempt_at", 0) > time.time())
    log.info("outbox: pending=%d retrying=%d sent=%d dead=%d" % (pending, retrying, sent, dead))
    if dead:
        names = sorted(n for n in os.listdir(ob.dead_dir) if n.endswith(".json"))[:10]
        log.info("dead 列表（前 10）：" + ", ".join(names))
    return 0 if dead == 0 else 3


def main():
    ap = argparse.ArgumentParser(description="售后数据上云推送")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--check", action="store_true", help="探活 /health")
    g.add_argument("--once", action="store_true", help="扫描并推送一轮")
    g.add_argument("--watch", action="store_true", help="常驻，每 5 分钟补传")
    g.add_argument("--run-file", metavar="FILE", help="只推指定 run 文件")
    g.add_argument("--status", action="store_true", help="outbox 概况")
    ap.add_argument("--force", action="store_true", help="忽略 sent/dead/退避，强制重推")
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--interval", type=int, default=300, help="--watch 间隔秒，默认 300")
    args = ap.parse_args()

    try:
        cfg = load_config(require_token=not (args.check or args.status),
                      require_url=not args.status)
    except SystemExit as e:
        print("配置错误：%s" % e, file=sys.stderr)
        return 2
    log = Log(os.path.join(cfg["data_dir"], "push.log"), args.verbose)

    if args.check:
        return cmd_check(cfg, log)
    if args.status:
        return cmd_status(cfg, log)
    if args.run_file:
        ok = push_run(os.path.abspath(args.run_file), force=args.force,
                      verbose=args.verbose, cfg=cfg, log=log)
        return 0 if ok else 1
    if args.watch:
        log.info("watch 启动，每 %ds 补传" % args.interval)
        while True:
            try:
                push_once(verbose=args.verbose, cfg=cfg, force=args.force)
            except Exception as e:
                log.error("watch 循环异常：%s: %s" % (type(e).__name__, str(e)[:200]))
            time.sleep(args.interval)
    # 默认 --once
    r = push_once(verbose=args.verbose, cfg=cfg, force=args.force)
    return 0 if r["failed"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
