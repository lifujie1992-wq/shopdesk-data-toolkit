#!/usr/bin/env python3
"""速查各店铺登录状态（读工作台的 loginHealth + 实际采一次探针）。"""
import json, os, sys, datetime

P = os.path.expanduser('~/Library/Application Support/shopdesk')
shops = json.load(open(os.path.join(P, 'shops.json')))
now = datetime.datetime.now()

print(f"{'店铺':<22}{'平台':<8}{'登录健康':<16}{'判定时间':<18}")
print('-' * 66)
for s in shops:
    lh = s.get('loginHealth') or {}
    st = lh.get('status') or '(未检测)'
    when = (lh.get('checkedAt') or '')[:19].replace('T', ' ')
    mark = {'authenticated': '✅', 'needs_login': '❌'}.get(st, '⚪')
    print(f"{mark} {s['name']:<20}{s['platform']:<8}{st:<16}{when:<18}")

print()
ok = [s['name'] for s in shops if (s.get('loginHealth') or {}).get('status') == 'authenticated']
bad = [s['name'] for s in shops if (s.get('loginHealth') or {}).get('status') != 'authenticated']
print(f"可采集({len(ok)}): " + ('、'.join(ok) or '无'))
print(f"待登录({len(bad)}): " + ('、'.join(bad) or '无'))
print()
print("※ loginHealth 是工作台上次检测的结果，可能有延迟。")
print("  最准的确认：python3 ~/doudian-daily/daily_collect.py")
