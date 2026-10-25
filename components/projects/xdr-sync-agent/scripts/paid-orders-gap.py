#!/usr/bin/env python3
"""Detect and repair coverage gaps in the paid-order ODS (订单数仓 baseline).

Why this exists
---------------
The paid-order publish path is strictly incremental: each run rewrites the
rolling window [business_date-30, business_date] and the server refuses to
materialize unless *every* day in that window has exactly one coverage row
(`paid_orders_incomplete_or_overlapping_coverage`).  So one missed day
deadlocks the whole pipeline until the gap is filled by hand.

Usage
-----
  paid-orders-gap.py                      # same as --detect
  paid-orders-gap.py --detect             # report window / coverage / gaps (read-only)
  paid-orders-gap.py --backfill           # fill gaps up to yesterday, then swap in
  paid-orders-gap.py --backfill --until 2026-10-14
  paid-orders-gap.py --republish          # queue a server publish job for the worker

--backfill writes to a scratch copy and only replaces the baseline once every
day succeeded, keeping a `<ods>.pre-gap-backfill-<yyyymmdd>` rollback copy.
"""
from __future__ import annotations

import argparse
import shutil
import sqlite3
import subprocess
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

HOME = Path.home()
STATE = HOME / "Library/Application Support/xdr-sync-agent"
ODS = STATE / "baseline/jst-paid-orders-warehouse.sqlite"
SPU = STATE / "baseline/jst-inventory-spu-live.sqlite"
WORK = STATE / "paid-orders-gap"
APPEND = HOME / "xdr-sync-agent/scripts/append-today-order-page.py"
JST = HOME / ".local/bin/jst-order-page"

SSH_KEY = HOME / ".ssh/xdr_mac"
SERVER = "xdrsync@47.114.33.246"
CTL = "/usr/local/bin/xdr-syncctl"
PY = "/usr/bin/python3"


def days(start: date, end: date):
    day = start
    while day <= end:
        yield day
        day += timedelta(days=1)


def read_state(path: Path) -> dict:
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        batches = db.execute(
            "SELECT batch_id,business_date,start_date,end_date,complete FROM export_batches"
        ).fetchall()
        coverage = dict(db.execute(
            "SELECT biz_date,count(*) FROM export_coverage GROUP BY biz_date"))
        items = db.execute("SELECT count(*) FROM paid_order_items_raw").fetchone()[0]
    finally:
        db.close()
    return {"batches": batches, "coverage": coverage, "items": items}


def complete_batch(state: dict):
    complete = [b for b in state["batches"] if b[4] == 1]
    return complete[0] if len(complete) == 1 else None


def describe(state: dict) -> dict:
    batch = complete_batch(state)
    print(f"ods       : {ODS}")
    if not batch:
        print(f"!! expected exactly one complete batch, found {len(state['batches'])}")
        return {"ok": False}
    start, end = date.fromisoformat(batch[2]), date.fromisoformat(batch[3])
    expected = list(days(start, end))
    missing = [d for d in expected if state["coverage"].get(d.isoformat()) != 1]
    print(f"batch     : {batch[0]}")
    print(f"window    : {start} .. {end}")
    print(f"business  : {batch[1]}")
    print(f"rows      : {state['items']:,}")
    print(f"covered   : {len(expected) - len(missing)}/{len(expected)} days")
    if missing:
        print("!! GAPS   : " + ", ".join(d.isoformat() for d in missing))
    else:
        print("gaps      : none")
    dupes = {k: v for k, v in state["coverage"].items() if v != 1}
    if dupes:
        print(f"!! BAD    : non-singleton coverage {dupes}")
    return {"ok": True, "end": end, "missing": missing}


def backfill(until: date) -> int:
    state = read_state(ODS)
    batch = complete_batch(state)
    if not batch:
        print("refusing to backfill: no single complete batch")
        return 2
    last = date.fromisoformat(batch[3])
    if until <= last:
        print(f"nothing to do: window already ends at {last}")
        return 0

    todo = list(days(last + timedelta(days=1), until))
    print(f"backfilling {len(todo)} day(s): {todo[0]} .. {todo[-1]}")

    WORK.mkdir(parents=True, exist_ok=True)
    scratch = WORK / "ods-scratch.sqlite"
    backup = ODS.with_name(f"{ODS.name}.pre-gap-backfill-{date.today():%Y%m%d}")
    if not backup.exists():
        print(f"backup    : {backup.name}")
        shutil.copy2(ODS, backup)
    print("scratch   : copying baseline")
    shutil.copy2(ODS, scratch)

    for day in todo:
        snap = WORK / f"today-{day.isoformat()}.sqlite"
        snap.unlink(missing_ok=True)
        print(f"[{day}] sync-day", flush=True)
        r = subprocess.run([str(JST), "sync-day", "--date", day.isoformat(),
                            "--date-field", "pay_date", "--output", str(snap)],
                           capture_output=True, text=True)
        if r.returncode != 0:
            print(f"[{day}] sync-day FAILED\n{(r.stderr or r.stdout)[-1000:]}")
            return 3
        print(f"[{day}] append", flush=True)
        r = subprocess.run([PY, str(APPEND), "--ods", str(scratch), "--today", str(snap),
                            "--business-date", day.isoformat(), "--inventory", str(SPU)],
                           capture_output=True, text=True)
        if r.returncode != 0:
            print(f"[{day}] append FAILED\n{r.stdout[-600:]}\n{r.stderr[-1000:]}")
            return 4
        print(f"[{day}] {r.stdout.strip().splitlines()[-1]}")

    shutil.move(str(scratch), str(ODS))
    print("baseline  : replaced with repaired ODS")
    describe(read_state(ODS))
    print("\nNow publish it:  paid-orders-gap.py --republish")
    return 0


def republish(priority: bool) -> int:
    remote = [CTL, "enqueue", "sync_paid_orders", "--source", "manual"]
    if priority:
        early = (datetime.now(timezone.utc) - timedelta(hours=6)).replace(microsecond=0)
        remote += ["--scheduled-at", early.isoformat()]
    r = subprocess.run(["ssh", "-i", str(SSH_KEY), "-p", "22", "-o", "BatchMode=yes",
                        "-o", "ConnectTimeout=10", SERVER, " ".join(remote)],
                       capture_output=True, text=True)
    out = (r.stdout or r.stderr).strip()
    print(out)
    return r.returncode


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--detect", action="store_true", help="report gaps (read-only)")
    parser.add_argument("--backfill", action="store_true", help="fill gaps locally")
    parser.add_argument("--until", type=date.fromisoformat,
                        help="last day to fill (default: yesterday)")
    parser.add_argument("--republish", action="store_true",
                        help="queue a server publish job for the worker")
    parser.add_argument("--priority", action="store_true",
                        help="with --republish: jump the queue so the worker picks it first")
    args = parser.parse_args()

    if not (args.detect or args.backfill or args.republish):
        args.detect = True

    if args.detect or args.backfill:
        describe(read_state(ODS))
    if args.backfill:
        return backfill(args.until or (date.today() - timedelta(days=1)))
    if args.republish:
        return republish(args.priority)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
