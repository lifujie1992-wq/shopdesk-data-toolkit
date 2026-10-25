#!/bin/bash
# 每日 22:00：① 只刷新平台审核结果（不采集、不提交）
# ② 生成当日汇总（按 品退/中差评 × AI/人工 区分）③ 推飞书 + 存档 + 推云端
set -u
APP="$HOME/Library/Application Support/shopdesk"
RD="$APP/appeal-reports"
BRIDGE="$APP/agent-bridge.json"
LOG="$RD/daily-summary.log"
OUT="$RD/summary-$(date +%F).txt"
if [ -n "${SUMMARY_DATE:-}" ]; then OUT="$RD/summary-$SUMMARY_DATE.txt"; fi
mkdir -p "$RD"
say(){ echo "[$(date '+%F %T')] $*" >> "$LOG"; }
say "==== 每日汇总开始 ===="

# ---------- ① 刷新审核结果 ----------
P=$(/usr/bin/plutil -extract port raw -o - "$BRIDGE" 2>/dev/null)
T=$(/usr/bin/plutil -extract token raw -o - "$BRIDGE" 2>/dev/null)
if [ -z "${P:-}" ] || [ -z "${T:-}" ]; then
  say "工作台未运行，尝试启动"
  pgrep -f "店铺工作台.app/Contents/MacOS/店铺工作台" >/dev/null 2>&1 || open "$HOME/店铺工作台.app"
  for i in $(seq 1 20); do [ -f "$BRIDGE" ] && break; sleep 3; done
  P=$(/usr/bin/plutil -extract port raw -o - "$BRIDGE" 2>/dev/null)
  T=$(/usr/bin/plutil -extract token raw -o - "$BRIDGE" 2>/dev/null)
fi
# ---------- ⓪ 补齐当天采集（不采集的话日报里的"今日"只到早上7点）----------
call_bridge(){
  printf 'header = "Authorization: Bearer %s"\n' "$T" | /usr/bin/curl --config - -s --max-time 60 --noproxy '*' \
    -H 'Content-Type: application/json' -H 'X-ShopDesk-Client: cron' --data-binary "$1" "http://127.0.0.1:$P/call" 2>/dev/null
}
if [ "${SKIP_COLLECT:-0}" = "1" ]; then
  say "SKIP_COLLECT=1，跳过当天采集"
elif [ -n "${P:-}" ] && [ -n "${T:-}" ]; then
  for _key in builtin:quality_returns builtin:negative_reviews; do
    _job=$(call_bridge "{\"method\":\"start_collector\",\"args\":{\"key\":\"$_key\"}}")
    _id=$(printf '%s' "$_job" | /usr/bin/python3 -c 'import sys,json
try: print((json.load(sys.stdin).get("result") or {}).get("id",""))
except Exception: print("")' 2>/dev/null)
    if [ -z "$_id" ]; then say "采集 $_key 启动失败: $(printf '%s' "$_job" | head -c 200)"; continue; fi
    say "采集 $_key 启动（id=$_id）"
    for _i in $(seq 1 90); do
      sleep 5
      _st=$(call_bridge "{\"method\":\"get_collector_job\",\"args\":{\"id\":\"$_id\"}}" | /usr/bin/python3 -c 'import sys,json
try: print((json.load(sys.stdin).get("result") or {}).get("status",""))
except Exception: print("")' 2>/dev/null)
      case "$_st" in done|error|cancelled|failed) say "采集 $_key 结束: $_st"; break;; esac
    done
  done
fi

SYNCED=0
if [ "${SKIP_SYNC:-0}" = "1" ]; then
  say "SKIP_SYNC=1，跳过结果刷新（仅预览日报格式）"
elif [ -n "${P:-}" ] && [ -n "${T:-}" ]; then
  R=$(printf 'header = "Authorization: Bearer %s"\n' "$T" | /usr/bin/curl --config - -s --max-time 20 --noproxy '*' -H 'Content-Type: application/json' --data-binary '{"method":"auto_appeal_status"}' "http://127.0.0.1:$P/call" 2>/dev/null)
  case "$R" in
    *'"running":true'*) say "跑批中，跳过结果刷新（日报用现有数据）";;
    "") say "接口无响应，跳过结果刷新";;
    *)
      say "刷新平台审核结果…"
      printf 'header = "Authorization: Bearer %s"\n' "$T" | /usr/bin/curl --config - -s --max-time 1500 --noproxy '*' \
        -H 'Content-Type: application/json' -H 'X-ShopDesk-Client: cron' \
        --data-binary '{"method":"appeal_sync_results","args":{"days":30,"pages":12}}' \
        "http://127.0.0.1:$P/call" >> "$LOG" 2>&1
      SYNCED=1
      say "结果刷新完成"
      ;;
  esac
fi

# ---------- ②③④ 汇总 ----------
SYNCED="$SYNCED" OUT="$OUT" /usr/bin/python3 - <<'PY'
import json, os, time, base64, hmac, hashlib, datetime, collections, urllib.request, subprocess, glob

app = os.path.expanduser('~/Library/Application Support/shopdesk')
rd = os.path.join(app, 'appeal-reports')
out = os.environ['OUT']
today = os.environ.get('SUMMARY_DATE') or datetime.date.today().isoformat()
KINDS = ['品退', '中差评']
WHOS = ['AI', '人工']

def norm(d):
    return str(d or '').replace('/', '-')[:10]

# 平台举报记录（含订单号）
try:
    res = json.load(open(os.path.join(rd, 'results.json')))
    recs = [dict(v, order_id=str(k)) for k, v in (res.get('map') or {}).items()]
except Exception:
    recs = []

# 提交人归属：我们系统提交的=AI；平台上其它来源=人工（取自本地 /stats）
who_of = {}
try:
    st = json.loads(urllib.request.urlopen('http://127.0.0.1:8899/stats', timeout=40).read().decode('utf-8'))
    for row in ((st.get('review') or {}).get('rows') or []):
        oid = str(row.get('order_id') or '')
        if oid:
            who_of[oid] = 'AI' if str(row.get('submitter') or '').startswith('AI') else '人工'
except Exception:
    pass

def who(r):
    return who_of.get(str(r.get('order_id') or ''), 'AI')

def kind_of(r):
    return '品退' if '售后' in str(r.get('scene') or '') else '中差评'

def newrec():
    return {'sub': 0, 'pass': 0, 'rej': 0, 'wait': 0, 'audN': 0, 'audPass': 0, 'audRej': 0,
            'total': 0, 'ok': 0, 'bad': 0, 'subAI': 0, 'subMan': 0,
            'totAI': 0, 'totMan': 0, 'audAI': 0, 'audMan': 0}

# 统计口径：排除测试窗口 2026-10-01~10-04（AI 批量测试，637条通过率仅8%）；其余全保留
EX_LO, EX_HI = '2026-10-01', '2026-10-05'
_raw_n = len(recs)
recs = [r for r in recs if not (EX_LO <= (norm(r.get('created')) or '0000-00-00') < EX_HI)]
CUT_NOTE = '已排除 %s~%s 测试数据' % (EX_LO, '2026-10-04')
EXCLUDED = _raw_n - len(recs)

sub_today = [r for r in recs if norm(r.get('created')) == today]
aud_today = [r for r in recs if norm(r.get('auditTime')) == today]

G = {k: newrec() for k in KINDS}     # 今日提交
A = {k: newrec() for k in KINDS}     # 今日出结果
T = {k: newrec() for k in KINDS}     # 累计
W = {w: newrec() for w in WHOS}      # 按提交人累计

for r in recs:
    k, w = kind_of(r), who(r)
    t = T[k]; t['total'] += 1; t['totAI' if w == 'AI' else 'totMan'] += 1
    x = W[w]; x['total'] += 1
    a = r.get('auditStatus')
    if a == 6:
        t['ok'] += 1; x['ok'] += 1
    elif a == 3:
        t['bad'] += 1; x['bad'] += 1
for r in sub_today:
    k, w = kind_of(r), who(r)
    g = G[k]
    g['sub'] += 1; g['subAI' if w == 'AI' else 'subMan'] += 1
    a = r.get('auditStatus')
    if a == 6:
        g['pass'] += 1
    elif a == 3:
        g['rej'] += 1
    else:
        g['wait'] += 1
for r in aud_today:
    k, w = kind_of(r), who(r)
    a = A[k]
    a['audN'] += 1; a['audAI' if w == 'AI' else 'audMan'] += 1
    s = r.get('auditStatus')
    if s == 6:
        a['audPass'] += 1
    elif s == 3:
        a['audRej'] += 1

def rate(p, r):
    return round(p * 100 / (p + r)) if (p + r) else 0

# ---------- 今日新增（平台今天产生的差评/品退） ----------
PURE_EMOTION = {'差评','中评','差','中','烂','不好','不推荐','不推荐购买','垃圾','辣鸡','无语','服了','服气',
                '呵呵','唉','哎','后悔','失望','一般','还行','凑合','醉了','离谱','难看','丑','不值','不值得',
                '浪费钱','上当','踩雷','翻车','绝了','恶心','什么玩意','很一般','太差了','差劲','无语子'}

def emo(t):
    s = str(t or '').strip().strip('。.！!~～,，、；;？?　 \t\n')
    return (not s) or (s in PURE_EMOTION)

NEW = {k: {'n': 0, 'ok': 0} for k in KINDS}      # 平台今日产生
CUM = {k: {'n': 0, 'ok': 0} for k in KINDS}      # 平台累计产生（自统计口径起）
NEW_SHOP = {}          # {店铺: {'品退':[总,可申诉], '中差评':[总,可申诉]}}
COLLECTED_AT = ''


def add(k, shop, d, ok):
    """d=该单在平台的日期；今日计入 NEW；全量计入 CUM（平台近30天）"""
    if d == today:
        NEW[k]['n'] += 1
        NEW[k]['ok'] += 1 if ok else 0
        e = NEW_SHOP.setdefault(shop or '(未知店铺)', {}).setdefault(k, [0, 0])
        e[0] += 1
        e[1] += 1 if ok else 0
    CUM[k]['n'] += 1
    CUM[k]['ok'] += 1 if ok else 0

try:
    _p = os.path.join(app, 'business-data', 'quality-all-latest.json')
    COLLECTED_AT = datetime.datetime.fromtimestamp(os.path.getmtime(_p)).strftime('%m-%d %H:%M')
    for r in json.load(open(_p)):
        add('品退', r.get('shop'), str(r.get('apply_date') or '')[:10], r.get('appealable') is True)
except Exception:
    pass
try:
    _fs = sorted(glob.glob(os.path.join(app, 'business-data', 'reviews-all-*.json')))
    if _fs:
        _mt = datetime.datetime.fromtimestamp(os.path.getmtime(_fs[-1])).strftime('%m-%d %H:%M')
        if _mt > COLLECTED_AT:
            COLLECTED_AT = _mt
    seen_r = set()
    for _f in _fs:                      # 批次文件是增量的，要全部合并去重
        try:
            _d = json.load(open(_f))
        except Exception:
            continue
        for r in (_d if isinstance(_d, list) else (_d.get('all_reviews') or [])):
            try:
                if int(r.get('rank') or 5) > 3:      # 只要中差评
                    continue
            except Exception:
                continue
            oid = str(r.get('order_id') or '')
            if not oid or oid in seen_r:
                continue
            seen_r.add(oid)
            add('中差评', r.get('shop'), str(r.get('comment_date') or '')[:10],
                emo(r.get('content')) and not r.get('has_media'))
except Exception:
    pass

L = []
L.append('【抖店申诉日报】%s%s' % (today, ('　数据截至 ' + COLLECTED_AT) if COLLECTED_AT else ''))
L.append('')


def _dw(s):
    n = 0
    for c in str(s):
        o = ord(c)
        n += 2 if (0x1100 <= o <= 0x115F or 0x2E80 <= o <= 0xA4CF or 0xAC00 <= o <= 0xD7A3
                    or 0xF900 <= o <= 0xFAFF or 0xFE30 <= o <= 0xFE6F or 0xFF00 <= o <= 0xFF60
                    or 0xFFE0 <= o <= 0xFFE6 or 0x20000 <= o <= 0x3FFFD) else 1
    return n


def _pd(s, w):
    return str(s) + ' ' * max(0, w - _dw(s))


T = T
tot_sub = sum(G[k]['sub'] for k in KINDS)
tot_aud = sum(A[k]['audN'] for k in KINDS)
_all = sum(T[k]['total'] for k in KINDS)
_ok = sum(T[k]['ok'] for k in KINDS)
_bad = sum(T[k]['bad'] for k in KINDS)
_p = sum(A[k]['audPass'] for k in KINDS)
_r = sum(A[k]['audRej'] for k in KINDS)
_NQ, _NR = '品退', '中差评'
_LW, _CW = 16, 10
_BAR = '  ' + '─' * (_LW + _CW * 3)


def _row(lab, a, b, c):
    return '  %s%s%s%s' % (_pd(lab, _LW), _pd(a, _CW), _pd(b, _CW), _pd(c, _CW))


L.append('  【平台产生】')
L.append(_row('项目', _NQ, _NR, '合计'))
L.append(_BAR)
for _lab, _a, _b in (
        ('今日新增', NEW['品退']['n'], NEW['中差评']['n']),
        ('  其中可申诉', NEW['品退']['ok'], NEW['中差评']['ok']),
        ('近30天新增', CUM['品退']['n'], CUM['中差评']['n']),
        ('  其中可申诉', CUM['品退']['ok'], CUM['中差评']['ok'])):
    L.append(_row(_lab, _a, _b, _a + _b))
L.append(_BAR)
L.append('  【我们的举报】')
for _lab, _va, _vb, _vt in (
        ('今日提交', G['品退']['sub'], G['中差评']['sub'], tot_sub),
        ('累计提交', T['品退']['total'], T['中差评']['total'], _all),
        ('  成功', T['品退']['ok'], T['中差评']['ok'], _ok),
        ('  失败', T['品退']['bad'], T['中差评']['bad'], _bad)):
    L.append(_row(_lab, _va, _vb, _vt))
L.append(_row('  通过率', '%d%%' % rate(T['品退']['ok'], T['品退']['bad']),
              '%d%%' % rate(T['中差评']['ok'], T['中差评']['bad']), '%d%%' % rate(_ok, _bad)))
L.append(_BAR)
_ai = sum(T[k]['totAI'] for k in KINDS)
_mn = sum(T[k]['totMan'] for k in KINDS)
L.append('  提交人　%s' % ' ｜ '.join(
    '%s %d 单（%d%%）' % (w, W[w]['total'], rate(W[w]['ok'], W[w]['bad'])) for w in WHOS if W[w]['total']))
L.append('')

# 驳回原因（分类型）
for k in KINDS:
    msgs = collections.Counter()
    for r in aud_today:
        if kind_of(r) != k:
            continue
        m = str(r.get('resultMsg') or '').replace('失败原因:', '').split(';平台建议')[0].strip()
        if not m:
            continue
        msgs[(m[:32] + '…') if len(m) > 32 else m] += 1
    if msgs:
        L.append('')
        L.append('❌ 今日驳回（%s）' % k)
        for m, n in msgs.most_common(2):
            L.append('   • %s ×%d' % (m, n))

# ---------- 店铺维度（类型 × 提交人）----------
SH = {}
def srow(s, k):
    return SH.setdefault(s, {kk: newrec() for kk in KINDS})[k]
for r in recs:
    d = srow(str(r.get('shop') or '?'), kind_of(r))
    w = who(r)
    d['total'] += 1; d['totAI' if w == 'AI' else 'totMan'] += 1
    if r.get('auditStatus') == 6:
        d['ok'] += 1
    elif r.get('auditStatus') == 3:
        d['bad'] += 1
for r in sub_today:
    d = srow(str(r.get('shop') or '?'), kind_of(r)); w = who(r)
    d['sub'] += 1; d['subAI' if w == 'AI' else 'subMan'] += 1
    a = r.get('auditStatus')
    if a == 6:
        d['pass'] += 1
    elif a == 3:
        d['rej'] += 1
    else:
        d['wait'] += 1
for r in aud_today:
    d = srow(str(r.get('shop') or '?'), kind_of(r)); w = who(r)
    d['audN'] += 1; d['audAI' if w == 'AI' else 'audMan'] += 1
    if r.get('auditStatus') == 6:
        d['audPass'] += 1
    elif r.get('auditStatus') == 3:
        d['audRej'] += 1

def act(d):
    return sum(d[k]['sub'] + d[k]['audN'] for k in KINDS)

# ---------- 店铺明细（今日新增 + 累计，一张表）----------
_shops = set(NEW_SHOP) | set(SH)
_rows = []
for _s in _shops:
    _nq = NEW_SHOP.get(_s, {}).get('品退', [0, 0])
    _nr = NEW_SHOP.get(_s, {}).get('中差评', [0, 0])
    _d = SH.get(_s) or {}
    _cq = _d.get('品退', {}).get('total', 0) if _d else 0        # 累计品退
    _cr = _d.get('中差评', {}).get('total', 0) if _d else 0      # 累计中差评
    _t = _cq + _cr
    _o = sum(_d[k]['ok'] for k in KINDS) if _d else 0
    _b = sum(_d[k]['bad'] for k in KINDS) if _d else 0
    if not (_nq[0] or _nr[0] or _t):
        continue
    _rows.append((_s, _nq, _nr, _nq[1] + _nr[1], _cq, _cr, _t, _o, _b))
_rows.sort(key=lambda r: (-(r[1][0] + r[2][0]), -r[6]))

if _rows:
    def _dw(s):
        n = 0
        for c in str(s):
            o = ord(c)
            n += 2 if (0x1100 <= o <= 0x115F or 0x2E80 <= o <= 0xA4CF or 0xAC00 <= o <= 0xD7A3
                        or 0xF900 <= o <= 0xFAFF or 0xFE30 <= o <= 0xFE6F or 0xFF00 <= o <= 0xFF60
                        or 0xFFE0 <= o <= 0xFFE6 or 0x20000 <= o <= 0x3FFFD) else 1
        return n

    def _pad(s, w):
        return str(s) + ' ' * max(1, w - _dw(s))

    _w = max(_dw(r[0]) for r in _rows) + 2
    _c1, _c2, _c3 = 13, 13, 13

    def _rt(d):
        """通过率（带样本量）：无记录 '-'，有记录 '58% (50)'"""
        if not d or not d.get('total'):
            return '-'
        if not (d.get('ok') or d.get('bad')):
            return '审核中 (%d)' % d['total']
        return '%d%% (%d)' % (rate(d.get('ok', 0), d.get('bad', 0)), d['total'])

    L.append('')
    L.append('🏪 店铺明细（今日平台产生 ｜ 累计举报通过率，括号内为累计提交单数）')
    L.append('  %s%s%s%s' % (
        _pd('店铺', _w), _pd('品退/中差评', _c1), _pd('品退通过率', _c2), '中差评通过率'))
    L.append('  ' + '─' * (_w + _c1 + _c2 + _c3))
    for _s, _nq, _nr, _aok, _cq, _cr, _t, _o, _b in _rows:
        _sd = SH.get(_s) or {}
        L.append('  %s%s%s%s' % (
            _pad(_s, _w), _pd('%d / %d' % (_nq[0], _nr[0]), _c1),
            _pd(_rt(_sd.get('品退')), _c2), _rt(_sd.get('中差评'))))
    L.append('  ' + '─' * (_w + _c1 + _c2 + _c3))
    L.append('  %s%s%s%s' % (
        _pad('合计', _w), _pd('%d / %d' % (NEW['品退']['n'], NEW['中差评']['n']), _c1),
        _pd(_rt(T['品退']), _c2), _rt(T['中差评'])))

L.append('')
L.append('（数据源：抖店举报记录 + 本地提交日志；%s%s）' % (
    ('统计口径：' + CUT_NOTE + '，共 %d 条；' % EXCLUDED) if CUT_NOTE else '',
    '本次已刷新' if os.environ.get('SYNCED') == '1' else '本次未刷新，沿用上次'))
text = '\n'.join(L)
open(out, 'w', encoding='utf-8').write(text + '\n')
print(text)

# 存档 json + 历史（每天一行，按日期去重；原子写入，绝不动其它日期）
jpath = os.path.join(rd, 'daily-summary.json')
hpath = os.path.join(rd, 'daily-summary-history.jsonl')
try:
    day = {'date': today,
           'kinds': {k: {'today': G[k], 'auditToday': A[k], 'total': T[k]} for k in KINDS},
           'bySubmitter': W,
           'byShop': [{'shop': s, **{k: d[k] for k in KINDS}} for s, d in
                      sorted(SH.items(), key=lambda kv: -sum(kv[1][k]['total'] for k in KINDS))],
           'generatedAt': datetime.datetime.now().isoformat()}
    # 最新一份
    with open(jpath + '.tmp', 'w', encoding='utf-8') as fh:
        json.dump(dict(day, text=text), fh, ensure_ascii=False, indent=1)
    os.replace(jpath + '.tmp', jpath)
    # 历史：读回全部 → 只替换当天 → 原子写回（其它日期原样保留；重复日期只留一行）
    lines, replaced, bad = [], False, []
    if os.path.exists(hpath):
        with open(hpath, encoding='utf-8') as fh:
            for line in fh:
                s = line.strip()
                if not s:
                    continue
                try:
                    e = json.loads(s)
                except Exception:
                    bad.append(s)          # 已损坏的行原样保留，不删
                    continue
                if str(e.get('date') or '') == today:
                    if replaced:
                        continue           # 同一天的重复行 → 跳过
                    lines.append(json.dumps(day, ensure_ascii=False))
                    replaced = True
                else:
                    lines.append(s)        # 其它日期原样保留
    if not replaced:
        lines.append(json.dumps(day, ensure_ascii=False))
    lines.extend(bad)
    with open(hpath + '.tmp', 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(lines) + ('\n' if lines else ''))
    os.replace(hpath + '.tmp', hpath)
    # 每天一份纯文本（其它日期不碰；同一天原子替换）
    tp = os.path.join(rd, 'summary-%s.txt' % today)
    with open(tp + '.tmp', 'w', encoding='utf-8') as fh:
        fh.write(text + '\n')
    os.replace(tp + '.tmp', tp)
except Exception:
    pass

# 推云端（最新 + 当天存档 + 历史）
try:
    pushes = [(out, 'daily-summary.txt'),
              (jpath, 'daily-summary.json'),
              (hpath, 'daily-summary-history.jsonl'),
              (os.path.join(rd, 'summary-%s.txt' % today), 'daily-summary-%s.txt' % today)]
    for src, dst in pushes:
        if os.path.exists(src):
            subprocess.run(['/usr/bin/scp', '-q', '-i', os.path.expanduser('~/.ssh/xdr_mac'),
                            '-o', 'ConnectTimeout=12', src,
                            'root@47.114.33.246:/srv/appeal-workbench/data/' + dst], timeout=30)
    print('已推云端（含历史）')
except Exception as e:
    print('推云端失败:', e)

# 飞书：用交互卡片（普通文本的表格在飞书里会错位）
try:
    cfg = json.load(open(os.path.join(app, 'alert-webhook.json')))
    url, secret = str(cfg.get('url') or '').strip(), str(cfg.get('secret') or '').strip()
    if url:
        def _fx(label, val):
            return {'is_short': True, 'text': {'tag': 'lark_md', 'content': '**%s**\n%s' % (label, val)}}

        _rq = rate(T['品退']['ok'], T['品退']['bad'])
        _rr = rate(T['中差评']['ok'], T['中差评']['bad'])
        _els = [
            {'tag': 'div', 'text': {'tag': 'lark_md', 'content': '**【平台产生】**'}},
            {'tag': 'div', 'fields': [
                _fx('今日新增', '品退 **%d** ｜ 中差评 **%d**' % (NEW['品退']['n'], NEW['中差评']['n'])),
                _fx('今日可申诉', '品退 **%d** ｜ 中差评 **%d**' % (NEW['品退']['ok'], NEW['中差评']['ok'])),
                _fx('近30天新增', '品退 **%d** ｜ 中差评 **%d**' % (CUM['品退']['n'], CUM['中差评']['n'])),
                _fx('近30天可申诉', '品退 **%d** ｜ 中差评 **%d**' % (CUM['品退']['ok'], CUM['中差评']['ok'])),
            ]},
            {'tag': 'hr'},
            {'tag': 'div', 'text': {'tag': 'lark_md', 'content': '**【我们的举报】**'}},
            {'tag': 'div', 'fields': [
                _fx('今日提交', '**%d** 单' % tot_sub),
                _fx('累计提交', '**%d** 单（品退 %d ｜ 中差评 %d）' % (_all, T['品退']['total'], T['中差评']['total'])),
                _fx('累计通过率', '**%d%%**（品退 %d%% ｜ 中差评 %d%%）' % (rate(_ok, _bad), _rq, _rr)),
                _fx('提交人', 'AI %d（%d%%）· 人工 %d（%d%%）' % (
                    W['AI']['total'], rate(W['AI']['ok'], W['AI']['bad']),
                    W['人工']['total'], rate(W['人工']['ok'], W['人工']['bad']))),
            ]},
        ]
        # 店铺：用 column_set 做真正的列（普通行会在飞书里挤成一团）
        _act = [x for x in _rows if (x[1][0] or x[2][0])][:12]
        if _act:
            def _col(txt, wt):
                return {'tag': 'column', 'width': 'weighted', 'weight': wt,
                        'elements': [{'tag': 'div', 'text': {'tag': 'lark_md', 'content': txt}}]}

            _els.append({'tag': 'hr'})
            _els.append({'tag': 'div', 'text': {'tag': 'lark_md', 'content': '**【店铺明细】**'}})
            _els.append({'tag': 'column_set', 'flex_mode': 'none', 'columns': [
                _col('**店铺**', 4), _col('**品退/中差评**', 3),
                _col('**品退通过率**', 3), _col('**中差评通过率**', 3)]})
            for _s, _nq, _nr, _aok, _cq, _cr, _t2, _o2, _b2 in _act:
                _sd = SH.get(_s) or {}

                def _rt2(d):
                    if not d or not d.get('total'):
                        return '-'
                    if not (d.get('ok') or d.get('bad')):
                        return '审核中(%d)' % d['total']
                    return '**%d%%** (%d)' % (rate(d.get('ok', 0), d.get('bad', 0)), d['total'])

                _els.append({'tag': 'column_set', 'flex_mode': 'none', 'columns': [
                    _col('**%s**' % _s, 4),
                    _col('%d / %d' % (_nq[0], _nr[0]), 3),
                    _col(_rt2(_sd.get('品退')), 3),
                    _col(_rt2(_sd.get('中差评')), 3)]})
            if len(_rows) > len(_act):
                _els.append({'tag': 'note', 'elements': [{'tag': 'plain_text', 'content': '另有 %d 家店今日无动作' % (len(_rows) - len(_act))}]})
        # 驳回原因
        for _k in KINDS:
            _c = collections.Counter()
            for _rec in aud_today:
                if kind_of(_rec) != _k:
                    continue
                _m = str(_rec.get('resultMsg') or '').replace('失败原因:', '').split(';平台建议')[0].strip()
                if _m:
                    _c[(_m[:40] + '…') if len(_m) > 40 else _m] += 1
            if _c:
                _els.append({'tag': 'hr'})
                _els.append({'tag': 'div', 'text': {'tag': 'lark_md', 'content': '**❌ 今日驳回（%s）**\n%s' % (
                    _k, '\n'.join('· %s ×%d' % (m, n) for m, n in _c.most_common(3)))}})
        _els.append({'tag': 'note', 'elements': [{'tag': 'plain_text', 'content':
            '数据源：抖店举报记录+本地提交日志'
            + ('；' + CUT_NOTE + '（%d 条）' % EXCLUDED if CUT_NOTE else '')
            + ('；数据截至 ' + COLLECTED_AT + ' 采集' if COLLECTED_AT else '')}]})
        payload = {'msg_type': 'interactive', 'card': {
            'config': {'wide_screen_mode': True},
            'header': {'template': 'blue', 'title': {'tag': 'plain_text', 'content': '抖店申诉日报 %s' % today}},
            'elements': _els}}
        if secret:
            ts = str(int(time.time()))
            dig = hmac.new((ts + '\n' + secret).encode('utf-8'), digestmod=hashlib.sha256).digest()
            payload['timestamp'] = ts
            payload['sign'] = base64.b64encode(dig).decode('utf-8')
        req = urllib.request.Request(url, data=json.dumps(payload, ensure_ascii=False).encode(),
                                     headers={'Content-Type': 'application/json'})
        if os.environ.get('FEISHU_DRY') == '1':
            print('=== 飞书卡片预览 ===')
            print(json.dumps(payload, ensure_ascii=False, indent=1))
            _resp = '"code":0'
        else:
            _resp = urllib.request.urlopen(req, timeout=12).read().decode()
        print('飞书卡片:', _resp[:80])
        if '"code":0' not in _resp.replace(' ', ''):
            raise RuntimeError('卡片发送失败，回退纯文本')
except Exception as e:
    print('飞书卡片失败，回退纯文本:', e)
    try:
        cfg = json.load(open(os.path.join(app, 'alert-webhook.json')))
        url, secret = str(cfg.get('url') or '').strip(), str(cfg.get('secret') or '').strip()
        if url:
            payload = {'msg_type': 'text', 'content': {'text': text}}
            if secret:
                ts = str(int(time.time()))
                dig = hmac.new((ts + '\n' + secret).encode('utf-8'), digestmod=hashlib.sha256).digest()
                payload['timestamp'] = ts
                payload['sign'] = base64.b64encode(dig).decode('utf-8')
            req = urllib.request.Request(url, data=json.dumps(payload, ensure_ascii=False).encode(),
                                         headers={'Content-Type': 'application/json'})
            r = urllib.request.urlopen(req, timeout=10)
            print('飞书文本:', r.status, r.read().decode()[:60])
    except Exception as e2:
        print('飞书推送失败:', e2)
PY

say "日报已生成: $OUT"
say "==== 每日汇总结束 ===="
