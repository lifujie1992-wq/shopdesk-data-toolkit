#!/bin/bash
# 实时看申诉进度：bash ~/shopdesk-workbench-src/status.sh
BRIDGE="$HOME/Library/Application Support/shopdesk/agent-bridge.json"
P=$(/usr/libexec/PlistBuddy -c "Print :port" "$BRIDGE" 2>/dev/null)
T=$(/usr/libexec/PlistBuddy -c "Print :token" "$BRIDGE" 2>/dev/null)
R=""
for i in 1 2 3 4; do
  R=$(curl -s --max-time 20 --noproxy '*' -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
    -d '{"method":"auto_appeal_status"}' "http://127.0.0.1:$P/call" 2>/dev/null)
  [ -n "$R" ] && break
  sleep 3
done
echo "$R" | python3 -c "
import json,sys,datetime
from collections import Counter
try: r=json.load(sys.stdin)['result']
except Exception: print('(接口暂时没响应，App 可能在忙批量预查，30 秒后再试)'); sys.exit(0)
print('状态 :', '运行中' if r.get('running') else '已结束')
print('开始 :', (r.get('startedAt') or '')[11:19], ' 结束:', (r.get('finishedAt') or '—')[11:19])
d=[e for e in r.get('log',[]) if e.get('order')]
c=Counter()
for e in d:
    if e.get('result')=='已提交': c['✅ 已提交']+=1
    elif e.get('result')=='跳过': c['⏭ 跳过']+=1
    else: c['❌ 失败']+=1
print('进度 :', len(d),'条')
for k,v in c.most_common(): print('   ',k,v)
print()
steps=[e for e in r['log'] if 'step' in e]
for e in steps[-5:]: print(' ',e['at'][11:19], str(e.get('step'))[:40], str(e.get('进度') or ''))
print()
print('最近处理：')
for e in d[-6:]:
    print('  ',e['at'][11:19], e.get('result'), '·', str(e.get('reason'))[:30], '·', e['order'])
"
