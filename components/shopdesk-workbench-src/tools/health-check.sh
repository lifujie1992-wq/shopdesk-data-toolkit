#!/bin/bash
# 店铺健康体检：① 登录状态 ② 飞鸽会话权限/会话失效
# 发现异常先自动刷新会话(重开店铺首页)再复查；仍有异常 → 弹窗 + 飞书告警
# 防误报：
#   ① 抖店指标采集(daily_collect)运行中 → 跳过本次（共用会话，探针会被限流误判）
#   ② 飞鸽告警分两类，不要混成「店铺掉线」：
#      - 真掉线：飞鸽被重定向到登录页 / 页面出现登录失效文案 → 计入告警去抖
#      - 无会话权限（子账号没开通「基础接待」）→ 只是权限配置问题，店铺后台登录正常，
#        只写进报告和日志，不告警（2026-10-20 就是它让 13 家新店被误报成掉线）
#   ③ 登录状态不能只看 shops.json 里的缓存结论：那份缓存由采集链路写入，接口限流/风控
#      会被写成「登录已失效」（曾出现一次 40 家里 39 家同时报掉线）。缓存只当线索，
#      本次一律真开一次店铺首页复核：判据与工作台 login-health.js 的 pageIssue 完全一致
#      （地址是登录/验证页，或页面出现登录/验证文案）。页面正常 → 顺手清掉陈旧红字；
#      本次取不到有效页面 → 记「未确认」，不算掉线、不告警。
#   ④ 同一时刻只允许一次体检（避免定时任务与手动运行叠加，把探针拖到超时）
set -u
APP="$HOME/Library/Application Support/shopdesk"
LOG="$APP/health-check.log"
say(){ echo "[$(date '+%F %T')] $*" >> "$LOG"; }

LOCK="$APP/health-check.lock"
if [ -d "$LOCK" ]; then
  # 锁超过 30 分钟视为残留（体检正常应在 10 分钟内结束）
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then rmdir "$LOCK" 2>/dev/null || true
  else say "上一次体检仍在进行，跳过本次"; exit 0; fi
fi
mkdir "$LOCK" 2>/dev/null || { say "无法建立体检锁，跳过本次"; exit 0; }
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

# 采集中跳过（探针与采集共用抖店会话，并发会被限流误判成掉线）
if pgrep -f "daily_collect.py" >/dev/null 2>&1; then
  say "抖店指标采集中，跳过本次体检"
  exit 0
fi

BRIDGE="$APP/agent-bridge.json"
[ -f "$BRIDGE" ] || { say "工作台未运行，跳过"; exit 0; }
P=$(/usr/bin/plutil -extract port raw -o - "$BRIDGE" 2>/dev/null)
T=$(/usr/bin/plutil -extract token raw -o - "$BRIDGE" 2>/dev/null)
case "$P" in ''|*[!0-9]*) say "端口无效，跳过"; exit 0;; esac
case "$T" in ''|*[!0-9a-f]*) say "token 无效，跳过"; exit 0;; esac

PORT="$P" TOKEN="$T" APP="$APP" /usr/bin/python3 - <<'PY'
import json, os, re, subprocess, time, datetime, urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

app=os.environ['APP']; port=os.environ['PORT']; token=os.environ['TOKEN']
FEIGE = 'https://im.jinritemai.com/pc_seller_v2/main/workspace'
HOME  = 'https://fxg.jinritemai.com/ffa/mshop/homepage/index'
EXPR_FEIGE = '(()=>{try{const t=(document.body?document.body.innerText:"").slice(0,3000);return JSON.stringify({url:location.href,ready:(!!document.querySelector(".messageList")||document.querySelectorAll(".msgItemWrap").length>0),textLen:t.length,noperm:/暂无会话权限/.test(t),login:/扫码登录|验证码登录|登录已失效|请先登录/.test(t)});}catch(e){return "{}"}})()'

# 判定口径与 src/login-health.js 的 pageIssue 保持一致（地址优先，其次页面文案）
LOGIN_PATH=re.compile(r'(?:^|[/#?=&_-])(?:login|signin|passport)(?:[/#?=&_.]|$)',re.I)
VERIFY_PATH=re.compile(r'(?:^|[/#?=&_-])(?:verify|verification|captcha)(?:[/#?=&_.]|$)',re.I)
LOGIN_HOST=re.compile(r'(?:^|\.)(?:passport|sso|signin|login)\.',re.I)
VERIFY_HOST=re.compile(r'(?:^|\.)(?:verify|captcha)\.',re.I)
LOGIN_TEXT=re.compile(r'扫码登录|扫描二维码|请扫码|请使用.{0,15}扫码|等待.{0,8}确认|扫码成功'
                      r'|验证码登录|密码登录|请先?登录|账号登录|手机号登录|手机登录|短信登录|邮箱登录|发送验证码'
                      r'|选择.{0,4}店铺|选择.{0,4}主体|登录(?:信息)?已失效|登录过期|请重新登录')
VERIFY_TEXT=re.compile(r'安全验证|身份验证|请完成.{0,8}验证')

def page_issue(url,text):
    host='';route=''
    m=re.match(r'https?://([^/?#]+)([^#]*)',url or '')
    if m: host=m.group(1);route=m.group(2)
    t=(text or '').replace('\n',' ')
    if VERIFY_HOST.search(host) or VERIFY_PATH.search(route) or VERIFY_TEXT.search(t): return 'needs_verification'
    if LOGIN_HOST.search(host) or LOGIN_PATH.search(route) or LOGIN_TEXT.search(t): return 'needs_login'
    return None

def expr_home(shop_name):
    """返回地址 + 正文 + 店名是否出现（店名核对与工作台 watch 的口径一致）。"""
    n=json.dumps(shop_name,ensure_ascii=False)
    return ('(()=>{try{const t=(document.body?document.body.innerText:"").slice(0,6000);'
            'return JSON.stringify({url:location.href,textLen:t.length,text:t,'
            'identity:t.split("\\n").some(s=>s.trim()===%s)});}catch(e){return "{}"}})()' % n)

def api(method, args=None, timeout=90):
    body=json.dumps({"method":method,"args":args or {}})
    p=subprocess.run(['/usr/bin/curl','--config','-','-s','--max-time',str(timeout),'--noproxy','*',
                      '-H','Content-Type: application/json','--data-binary',body,
                      'http://127.0.0.1:%s/call'%port],
                     input='header = "Authorization: Bearer %s"\n'%token, capture_output=True, text=True)
    try: return json.loads(p.stdout)
    except Exception: return {}

def jget(r):
    j=r.get('result',{})
    if isinstance(j,str):
        try: j=json.loads(j)
        except Exception: j={}
    return j

def probe(shop_id,url,expr):
    return jget(api('flyge_probe',{'shop_id':shop_id,'url':url,'expression':expr}))

def probe_feige(s):
    """返回 (真掉线, 无会话权限, 未确认)。

    「暂无会话权限」是子账号权限没开通，不是登录失效：店铺后台登录仍正常，
    不能算掉线，否则新加的店会一直被误报。
    """
    j=probe(s['id'],FEIGE,EXPR_FEIGE)
    if not j or not j.get('textLen') or j.get('textLen',0)<50:
        return None,None,{'shop':s['name'],'id':s['id'],'reason':'页面未取到内容（多为加载超时）'}
    login_issue = bool(j.get('login')) or bool(page_issue(j.get('url') or '', ''))
    if login_issue:
        return {'shop':s['name'],'id':s['id'],'reason':'飞鸽登录失效'},None,None
    if j.get('noperm'):
        return None,{'shop':s['name'],'id':s['id'],'reason':'暂无会话权限（子账号未开通「基础接待」）'},None
    return None,None,None

def cached_login_bad():
    """shops.json 里的掉线结论只当线索，不作为结论。"""
    bad=[]
    for x in json.load(open(os.path.join(app,'shops.json'))):
        h=(x.get('loginHealth') or {}); st=h.get('status')
        if st in ('needs_login','needs_verification'):
            bad.append({'shop':x['name'],'id':x['id'],'platform':x.get('platform'),
                        'status':st,'checkedAt':h.get('checkedAt')})
    return bad

def verify_login_candidates(cand):
    """真开一次店铺首页复核缓存的掉线结论。判据同 pageIssue + 店名核对。"""
    confirmed=[];recovered=[];unverified=[]
    def one(x):
        j={}
        for attempt in range(2):
            j=probe(x['id'],HOME,expr_home(x['shop'])) or {}
            if page_issue(j.get('url'),j.get('text')): return x,j
            if int(j.get('textLen') or 0)>=200 and j.get('identity'): return x,j
            if attempt==0: time.sleep(3)
        return x,j
    if cand:
        with ThreadPoolExecutor(max_workers=4) as pool:
            for x,j in pool.map(one,cand):
                issue=page_issue(j.get('url'),j.get('text'))
                if issue:
                    confirmed.append({'shop':x['shop'],'id':x['id'],'platform':x['platform'],
                                      'status':issue,'cached_status':x['status'],'confirmed_by':'页面复核',
                                      'reason':('页面要求完成平台验证' if issue=='needs_verification' else '页面停留在登录页'),
                                      'url':j.get('url','')})
                elif int(j.get('textLen') or 0)>=200 and j.get('identity'):
                    recovered.append({'shop':x['shop'],'id':x['id'],'was':x['status'],
                                      'note':'页面正常且店名匹配，缓存的掉线结论已过期'})
                else:
                    unverified.append({'shop':x['shop'],'id':x['id'],'why':x['status'],
                                       'reason':'本次未能取到有效页面（多为加载超时），不代表掉线'})
    return confirmed,recovered,unverified

shops=[x for x in json.load(open(os.path.join(app,'shops.json'))) if x.get('platform')=='抖店']

# ① 并行探飞鸽（与工作台「一键检测」同款并发思路）
feige_bad=[];feige_noperm=[];feige_unknown=[]
with ThreadPoolExecutor(max_workers=8) as pool:
    futs={pool.submit(probe_feige,s):s for s in shops}
    for f in as_completed(futs):
        bad,noperm,unk=f.result()
        if bad: feige_bad.append(bad)
        elif noperm: feige_noperm.append(noperm)
        elif unk: feige_unknown.append(unk)

# ② 异常店铺自动刷新会话(重开首页) → 复查两轮，仍异常才算数
refreshed=[]
if feige_bad:
    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(lambda x: probe(x['id'],HOME,expr_home(x['shop'])), feige_bad))
    time.sleep(5)
    for attempt in range(2):
        still=[];unknown=[]
        with ThreadPoolExecutor(max_workers=8) as pool:
            futs={pool.submit(probe_feige,{'name':x['shop'],'id':x['id']}):x for x in feige_bad}
            for f in as_completed(futs):
                x=futs[f]; bad,noperm,unk=f.result()
                if bad: still.append(bad)                       # 仍是掉线
                elif unk: unknown.append(unk)                   # 复查也没加载出来：不算异常
                elif noperm: feige_noperm.append(noperm)         # 刷新后变成权限问题：不算掉线
                else: refreshed.append({'shop':x['shop'],'id':x['id'],'was':x['reason']})
        feige_bad=still
        feige_unknown.extend(u for u in unknown if not any(b['id']==u['id'] for b in feige_bad))
        if not feige_bad: break
        time.sleep(4)

# ③ 登录状态：缓存只当线索，逐个真页面复核
cached=cached_login_bad()
verifiable=[x for x in cached if x.get('platform')=='抖店']
skipped=[{'shop':x['shop'],'id':x['id'],'why':x['status'],'reason':'非抖店平台，本次不做页面复核'} for x in cached if x.get('platform')!='抖店']
login_bad,login_recovered,login_unverified=verify_login_candidates(verifiable)
login_unverified+=skipped

# 复核为正常的，请工作台清掉陈旧红字（写回 loginHealth=authenticated）
for x in login_recovered:
    api('login_health_confirm',{'shop_id':x['id']},timeout=20)

json.dump({'checked_at':datetime.datetime.now().isoformat(timespec='seconds'),
           'shop_total':len(shops),
           'login_bad':login_bad,
           'login_recovered':login_recovered,
           'login_unverified':login_unverified,
           'feige_bad':feige_bad,
           'feige_noperm':feige_noperm,
           'feige_unverified':feige_unknown,
           'auto_recovered':refreshed},
          open(os.path.join(app,'health-report.json'),'w'), ensure_ascii=False, indent=1)

print('自动刷新恢复 %d 家 %s' % (len(refreshed), ('· '+'、'.join(x['shop'] for x in refreshed[:6])) if refreshed else ''))
print('登录掉线(页面已复核) %d 家；登录缓存过期已纠正 %d 家；未能确认 %d 家；飞鸽掉线 %d 家；飞鸽无权限 %d 家'
      % (len(login_bad), len(login_recovered), len(login_unverified), len(feige_bad), len(feige_noperm)))
for x in login_bad: print('  [登录] %s (%s，%s) %s' % (x['shop'], x['status'], x['confirmed_by'], x['url'][:80]))
for x in login_recovered: print('  [纠正] %s（缓存 %s 已过期，页面正常）' % (x['shop'], x['was']))
for x in login_unverified: print('  [未确认] %s（缓存 %s，%s）' % (x['shop'], x['why'], x['reason']))
for x in feige_unknown: print('  [飞鸽未确认] %s（%s）' % (x['shop'], x['reason']))
for x in feige_noperm: print('  [飞鸽无权限] %s（%s，店铺后台登录正常，不告警）' % (x['shop'], x['reason']))
for x in feige_bad: print('  [飞鸽] %s (%s)' % (x['shop'], x['reason']))

# ④ 去抖：连续 2 次体检都异常才告警（未确认不算异常）
STATE=os.path.join(app,'health-state.json')
try: state=json.load(open(STATE))
except Exception: state={'streak':0}
if login_bad or feige_bad:
    state['streak']=state.get('streak',0)+1
else:
    state['streak']=0
json.dump(state, open(STATE,'w'), ensure_ascii=False)

n=len(login_bad)+len(feige_bad)
if n==0:
    print('连续正常'); raise SystemExit
if state['streak']<2:
    print('连续第 %d 次异常，暂不告警（连续 2 次才报）' % state['streak'])
    raise SystemExit

lines=[]
if login_bad: lines.append('登录掉线 %d 家(已页面复核)：%s' % (len(login_bad), '、'.join(x['shop'] for x in login_bad[:5])))
if feige_bad: lines.append('飞鸽需重新登录 %d 家(连续%d次)：%s' % (len(feige_bad), state['streak'], '、'.join(x['shop'] for x in feige_bad[:5])))
msg=' | '.join(lines)
try:
    subprocess.run(['/usr/bin/osascript','-e','display notification %s with title "店铺掉线提醒"' % json.dumps(msg, ensure_ascii=False)], timeout=10)
except Exception: pass
wf=os.path.join(app,'alert-webhook.json')
if os.path.isfile(wf):
    try:
        import hashlib, hmac, base64
        cfg=json.load(open(wf)); url=str(cfg.get('url') or '').strip(); secret=str(cfg.get('secret') or '').strip()
        if url:
            payload={'msg_type':'text','content':{'text':'【店铺掉线】'+msg}}
            if secret:
                ts=str(int(time.time()))
                dig=hmac.new((ts+'\n'+secret).encode('utf-8'), digestmod=hashlib.sha256).digest()
                payload['timestamp']=ts; payload['sign']=base64.b64encode(dig).decode('utf-8')
            req=urllib.request.Request(url, data=json.dumps(payload, ensure_ascii=False).encode(), headers={'Content-Type':'application/json'})
            r=urllib.request.urlopen(req, timeout=10)
            print('webhook:', r.status, r.read().decode()[:80])
    except Exception as e: print('webhook 失败:', e)
PY
say "体检完成"
