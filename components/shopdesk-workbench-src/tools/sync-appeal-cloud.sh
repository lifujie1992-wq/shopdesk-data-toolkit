#!/bin/bash
# 申诉数据云端同步：① 拉回云端确认并合并进本地队列 ② 推送最新数据上云
set -u
SERVER="root@47.114.33.246"
KEY="$HOME/.ssh/xdr_mac"
SSH="ssh -i $KEY -o ConnectTimeout=12 -o StrictHostKeyChecking=no $SERVER"
SCP="scp -i $KEY -o ConnectTimeout=12 -o StrictHostKeyChecking=no"
APP="$HOME/Library/Application Support/shopdesk"
RD="$APP/appeal-reports"
mkdir -p "$RD"
log(){ echo "[$(date '+%F %T')] $*"; }

# ① 拉云端确认（jsonl）→ 合并进本地 review-queue.json
$SSH 'cat /srv/appeal-workbench/data/confirmations.jsonl 2>/dev/null' > /tmp/appeal-conf.jsonl 2>/dev/null || true
python3 - <<'PY'
import json,os
rd=os.path.expanduser('~/Library/Application Support/shopdesk/appeal-reports')
qp=rd+'/review-queue.json'; ap=rd+'/confirmations-applied.json'
try: conf=[json.loads(l) for l in open('/tmp/appeal-conf.jsonl') if l.strip()]
except Exception: conf=[]
if not conf: print('[sync] 云端无新确认'); raise SystemExit
try: q=json.load(open(qp))
except Exception: q={'items':{}}
if 'items' not in q: q['items']={}
try: applied=json.load(open(ap))
except Exception: applied={'seen':[]}
seen=set(applied.get('seen',[])); changed=0
for e in conf:
    k=e.get('order_id','')+'|'+e.get('at','')
    if not e.get('order_id') or k in seen: continue
    seen.add(k)
    it=q['items'].get(e['order_id'])
    if not it: continue
    if it.get('status')=='pending':
        if e.get('action')=='confirm':
            it['status']='confirmed'
            if e.get('desc'): it['desc']=e['desc']
            if e.get('sub'): it['sub']=e['sub']
            if e.get('label'): it['label']=e['label']
            it['confirmedAt']=e.get('at'); changed+=1
        elif e.get('action')=='reject':
            it['status']='rejected'; it['rejectedAt']=e.get('at'); changed+=1
json.dump(q,open(qp,'w'),ensure_ascii=False,indent=2)
applied['seen']=sorted(seen)
json.dump(applied,open(ap,'w'),ensure_ascii=False)
print(f'[sync] 云端确认合并 {changed} 条')
PY

# ② 推送数据上云（本地工作台必须在跑）
curl -s --max-time 10 http://127.0.0.1:8899/data  > /tmp/appeal-data.json  2>/dev/null
curl -s --max-time 10 http://127.0.0.1:8899/stats > /tmp/appeal-stats.json 2>/dev/null
[ -s /tmp/appeal-data.json ] || { log "本地工作台未响应，跳过推送"; exit 0; }
$SCP /tmp/appeal-data.json   $SERVER:/srv/appeal-workbench/data/data.json   >/dev/null
$SCP /tmp/appeal-stats.json  $SERVER:/srv/appeal-workbench/data/stats.json  >/dev/null
$SCP "$RD/review-queue.json" $SERVER:/srv/appeal-workbench/data/review-queue.json >/dev/null
# 评价明细库（BI 用：按商品/店铺/供应商/发货时效切差评率）
DETAIL="$APP/business-data/reviews-detail-latest.json"
if [ -s "$DETAIL" ]; then $SCP "$DETAIL" $SERVER:/srv/appeal-workbench/data/reviews-detail-latest.json >/dev/null && log "评价明细已推送"; fi
# 飞鸽聊天明细（买家+客服，含客服名）
CHAT="$APP/appeal-reports/chat-detail-latest.json"
if [ -s "$CHAT" ]; then $SCP "$CHAT" $SERVER:/srv/appeal-workbench/data/chat-detail-latest.json >/dev/null && log "聊天明细已推送"; fi
log "推送完成：data/stats/queue/评价明细 → 云端"
