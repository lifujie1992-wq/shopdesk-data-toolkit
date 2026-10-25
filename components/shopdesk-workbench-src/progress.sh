#!/bin/bash
# 用磁盘日志看申诉进度（不占用接口，任何时刻都能看）
# bash ~/shopdesk-workbench-src/progress.sh
python3 - <<'PY'
import json,glob,os,datetime
S=os.path.expanduser('~/Library/Application Support/shopdesk/appeal-reports')
f=max(glob.glob(S+'/appeal-*.json'), key=os.path.getmtime)
rep=json.load(open(f))
d=[e for e in rep.get('log',[]) if e.get('order')]
tot=0
for e in rep.get('log',[]):
    if '筛查完成' in str(e.get('step')): tot=e.get('候选') or '?'
from collections import Counter
print('开始:',(rep.get('startedAt') or '')[11:19],'| 候选:',tot)
for e in rep.get('log',[]):
    if 'step' in e: print('  ',e['at'][11:19],str(e.get('step'))[:44],str(e.get('进度') or ''))
c=Counter()
for e in d:
    if e.get('result')=='已提交': c['✅ 已提交']+=1
    elif e.get('result')=='跳过': c['⏭ 跳过']+=1
    else: c['❌ 失败']+=1
print()
print('已处理:',len(d),'/',tot)
for k,v in c.most_common(): print('   ',k,v)
print()
print('最近 8 条:')
for e in d[-8:]:
    print('  ',e['at'][11:19],e.get('result'),'·',str(e.get('reason'))[:26],'·',e['order'])
PY
