#!/usr/bin/env python3
"""按最新成功日期追赶售后漏跑，单轮最多七天；正常情况下仍刷新昨天。"""
import datetime
from pathlib import Path
import sqlite3


def pending_dates(database, today=None, limit=7):
    if today is None:
        today = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).date()
    yesterday = today - datetime.timedelta(days=1)
    latest = None
    database = Path(database).expanduser().resolve()
    if database.exists():
        with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=10) as conn:
            latest = conn.execute(
                "SELECT MAX(date) FROM sync_info WHERE completed_at IS NOT NULL "
                "AND completed_at != '' AND date <= ?", (yesterday.isoformat(),)
            ).fetchone()[0]
    first = datetime.date.fromisoformat(latest) + datetime.timedelta(days=1) if latest else yesterday
    first = min(first, yesterday)
    count = min((yesterday - first).days + 1, limit)
    return [(first + datetime.timedelta(days=i)).isoformat() for i in range(count)]


if __name__ == '__main__':
    print('\n'.join(pending_dates(Path.home() / 'jst-aftersales.sqlite')))
