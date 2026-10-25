#!/bin/bash
# 定时提交「已确认」：从 erp.xiangduoer.com（申诉工作台·云端核对）拉「云端已确认、本地未执行」的单，
# 按页面上人工修改后的最新内容(desc/理由)写回本地队列，再触发轻量提交(confirmedOnly)。
set -u
APP="$HOME/Library/Application Support/shopdesk"
RD="$APP/appeal-reports"
LOG="$RD/submit-confirmed.log"
CRED="$APP/erp-login.json"
mkdir -p "$RD"
say(){ echo "[$(date '+%F %T')] $*" >> "$LOG"; }

ERP="${XDR_ERP_BASE:-https://erp.xiangduoer.com}"
CJ="/tmp/shopdesk-erp-cookies.txt"
SSHKEY="$HOME/.ssh/xdr_mac"
SRV="root@47.114.33.246:/srv/appeal-workbench/data"

# ⑥ 先把最新 data/stats/queue 推上云（供云端页面查看；20MB 的评价/聊天明细留给每日任务）
curl -s --max-time 10 --noproxy '*' http://127.0.0.1:8899/data  > /tmp/appeal-data.json  2>/dev/null
curl -s --max-time 10 --noproxy '*' http://127.0.0.1:8899/stats > /tmp/appeal-stats.json 2>/dev/null
if [ -s /tmp/appeal-data.json ]; then
  scp -q -i "$SSHKEY" -o ConnectTimeout=12 /tmp/appeal-data.json "$SRV/data.json" 2>/dev/null \
    && say "已推送 data.json（含场景/评价/操作内容）" || say "data 推送失败"
  [ -s /tmp/appeal-stats.json ] && scp -q -i "$SSHKEY" -o ConnectTimeout=12 /tmp/appeal-stats.json "$SRV/stats.json" 2>/dev/null
  [ -s "$RD/review-queue.json" ] && scp -q -i "$SSHKEY" -o ConnectTimeout=12 "$RD/review-queue.json" "$SRV/review-queue.json" 2>/dev/null
fi

# ① 登录 ERP 拿会话（账号密码放本地 600 文件，不进仓库）
if [ ! -f "$CRED" ]; then say "缺少 $CRED（ERP 登录凭据），跳过"; exit 0; fi
curl -s -k --max-time 20 -c "$CJ" -X POST "$ERP/api/auth/login" -H 'Content-Type: application/json' \
  --data-binary @"$CRED" -o /tmp/erp_login.json 2>/dev/null

# ② 拉云端队列（含已确认 execPending + 人工修改后的内容）
curl -s -k --max-time 25 -b "$CJ" "$ERP/appeal/api/queue" -o /tmp/erp_queue.json 2>/dev/null

# ③ 把「云端已确认、本地未执行」的单合并进本地队列
N=$(/usr/bin/python3 - <<'PY'
import json,os,sys
qpath=os.path.expanduser('~/Library/Application Support/shopdesk/appeal-reports/review-queue.json')
try: q=json.load(open(qpath))
except Exception: q={'items':{}}
q.setdefault('items',{})
try: erp=json.load(open('/tmp/erp_queue.json'))
except Exception: erp={}
items=erp.get('items') or []
if not isinstance(items,list): items=list(items.values())
n=0
for it in items:
    if not isinstance(it,dict): continue
    if it.get('status')!='已确认' or not it.get('execPending'): continue
    oid=str(it.get('order_id') or '')
    if not oid: continue
    cur=q['items'].get(oid) or {'order_id':oid}
    cur.update({
        'order_id':oid,
        'shop':it.get('shop') or cur.get('shop',''),
        'rank':it.get('rank') or cur.get('rank',''),
        'content':it.get('content') or cur.get('content',''),
        'desc':it.get('desc') or cur.get('desc',''),
        'scene':it.get('scene') or cur.get('scene') or 'report_type_unusual_comment',
        'sub':it.get('sub') or cur.get('sub'),
        'label':it.get('label') or cur.get('label'),
        'proofUrl':cur.get('proofUrl'),
        'status':'confirmed',
        'images':(it.get('images') or cur.get('images') or []),
        'confirmedAt':it.get('confirmedAt') or cur.get('confirmedAt'),
        'cloudConfirmed':True,
    })
    q['items'][oid]=cur; n+=1
json.dump(q,open(qpath,'w'),ensure_ascii=False,indent=2)
print(n)
PY
)
say "云端已确认待执行: ${N:-0}"
[ "${N:-0}" -gt 0 ] || exit 0

# ④ 触发轻量提交（只处理已确认单，跳过筛查/飞鸽/预审）
BRIDGE="$APP/agent-bridge.json"
[ -f "$BRIDGE" ] || { say "工作台未运行，跳过提交（下次再提）"; exit 0; }
P=$(/usr/bin/plutil -extract port raw -o - "$BRIDGE" 2>/dev/null)
T=$(/usr/bin/plutil -extract token raw -o - "$BRIDGE" 2>/dev/null)
case "$P" in ''|*[!0-9]*) say "端口无效，跳过"; exit 0;; esac
case "$T" in ''|*[!0-9a-f]*) say "token 无效，跳过"; exit 0;; esac
R=$(printf 'header = "Authorization: Bearer %s"\n' "$T" | /usr/bin/curl --config - -s --max-time 15 --noproxy '*' -H 'Content-Type: application/json' --data-binary '{"method":"auto_appeal_status"}' "http://127.0.0.1:$P/call" 2>/dev/null)
case "$R" in *'"running":true'*) say "已有申诉任务在跑，本次跳过（下次再提）"; exit 0;; esac
OUT=$(printf 'header = "Authorization: Bearer %s"\n' "$T" | /usr/bin/curl --config - -s --max-time 30 --noproxy '*' \
  -H 'Content-Type: application/json' -H 'X-ShopDesk-Client: cron' \
  --data-binary '{"method":"auto_appeal_start","args":{"kinds":["quality","reviews"],"submit":true,"reviewQueue":true,"confirmedOnly":true,"skipSync":true}}' \
  "http://127.0.0.1:$P/call" 2>/dev/null)
say "已触发提交: $OUT"
