from douyin import check_platform_login
"""无凭证品退 / 中差评订单筛查（只读）。品退走售后列表+详情，中差评走评价列表。
仅返回疑似符合举报条件的订单号与摘要，不提交任何举报、不写入订单隐私。
"""
import json, re, requests, time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

BASE = 'https://fxg.jinritemai.com'
AFTER_SALE_API = BASE + '/after_sale/pc/list'
AFTER_SALE_DETAIL_API = BASE + '/v1/aftersale/pc/detail'
AFTER_SALE_REFERER = BASE + '/ffa/merchant-aftersale-workbench/aftersale/list'
COMMENT_API = BASE + '/product/tcomment/commentList'
COMMENT_REFERER = BASE + '/ffa/maftersale/comment'

# 抖店品质类售后原因关键词（覆盖"商品做工粗糙/有瑕疵""质量不好""效果与描述不符"等常见品退口径）
QUALITY_KEYWORDS = [
    '做工粗糙', '做工', '瑕疵', '质量不好', '质量差', '质量', '效果与商品描述不符', '效果与描述不符',
    '描述不符', '与图片不符', '图文不符', '货不对板', '实物与', '破损', '破洞', '污渍', '染色',
    '起球', '掉色', '褪色', '缩水', '变形', '开线', '脱线', '掉毛', '掉钻', '异味', '臭味',
    '材质与描述不符', '材质', '面料', '成分', '功能故障', '功能', '故障', '不能使用', '无法使用',
    '假冒品牌', '假货', '仿冒', '山寨', '不是正品', '以次充好', '质量问题', '品质',
]

# 平台审核标准认可的“主观 / 非品质原因”关键词（原因选品质、但说明写这些）
SUBJECTIVE_KEYWORDS = [
    '不想要', '多拍', '拍多', '买多', '多买', '错拍', '拍错', '买错', '下错', '选错', '点错',
    '不喜欢', '不好看', '觉得不好看', '难看', '不好搭配', '不合适', '不适合', '不需要', '用不上', '没用',
    '无理由', '七天无理由', '7天无理由', '湊单', '后悔', '买重', '拍重', '下错单', '选错码', '尺码拍错',
    '尺寸拍错', '颜色拍错', '拍错了', '买错了', '不想要了', '不想要啦',
]

def is_subjective_reason(text):
    t = str(text or '')
    return any(k in t for k in SUBJECTIVE_KEYWORDS)

# 说明里出现这些强品质词时，说明原因与描述一致，不属于“与事实不符”，不纳入
STRONG_QUALITY_WORDS = [
    '质量差', '质量不好', '质量太差', '质量有问', '质量一般差', '做工', '瑕疵', '破损', '破洞', '污渍', '染色',
    '起球', '掉色', '褪色', '缩水', '变形', '开线', '脱线', '掉毛', '掉钻', '异味', '臭味', '假货', '山寨',
    '仿冒', '以次充好', '面料差', '布料差', '材质差', '料子差', '太差', '很差', '特别皱', '起皱', '皱巴巴', '线头',
]

def has_strong_quality(text):
    t = str(text or '')
    return any(k in t for k in STRONG_QUALITY_WORDS)

# 中差评里出现以下具体品质词时，视为有实质质量问题描述，不纳入
QUALITY_REVIEW_KEYWORDS = QUALITY_KEYWORDS + ['尺码不符', '厚度', '透', '薄', '硬', '扎', '痒', '漏', '破', '脏', '旧', '假']

# 中差评里"情绪化/无实质"表述（仅在未出现具体品质词时使用）
VAGUE_REVIEW_WORDS = ['差评', '不推荐', '不好', '一般', '失望', '垃圾', '后悔', '不值得', '不想要', '不喜欢',
                      '无语', '服了', '呵呵', '唉', '退货', '难说', '凑合', '还行']

def period(days=30):
    now = datetime.now(ZoneInfo('Asia/Shanghai'))
    start = (now - timedelta(days=days - 1)).replace(hour=0, minute=0, second=0, microsecond=0)
    end = now.replace(hour=23, minute=59, second=59, microsecond=0)
    return {'start': start.isoformat(), 'end': end.isoformat(),
            'start_epoch': int(start.timestamp()), 'end_epoch': int(end.timestamp())}

def span_since(since_ms, days=30):
    """增量：从上次扫描时间（毫秒）到现在；无记录则回退到近 days 天。上限仍为 days 天。"""
    now = datetime.now(ZoneInfo('Asia/Shanghai'))
    start = (now - timedelta(days=days - 1)).replace(hour=0, minute=0, second=0, microsecond=0)
    try:
        if since_ms:
            s = datetime.fromtimestamp(int(since_ms) / 1000, ZoneInfo('Asia/Shanghai'))
            if s > start:
                start = s
    except Exception:
        pass
    end = now.replace(hour=23, minute=59, second=59, microsecond=0)
    return {'start': start.isoformat(), 'end': end.isoformat(),
            'start_epoch': int(start.timestamp()), 'end_epoch': int(end.timestamp())}

def is_quality_reason(reason):
    r = str(reason or '')
    return any(k in r for k in QUALITY_KEYWORDS)

def has_quality_content(text):
    """评价是否包含具体品质描述；只有空评价或纯情绪词才算‘无实质’。"""
    t = str(text or '').strip()
    if not t:
        return False
    return any(k in t for k in QUALITY_REVIEW_KEYWORDS)

# 纯情绪 / 无实质内容（去除标点后需与词表完全一致才判为可申诉）
PURE_EMOTION = {'差评', '中评', '差', '中', '烂', '不好', '不推荐', '不推荐购买', '垃圾', '辣鸡', '无语',
                '服了', '服气', '呵呵', '唉', '哎', '后悔', '失望', '一般', '还行', '凑合', '醉了',
                '离谱', '难看', '丑', '不值', '不值得', '浪费钱', '上当', '踩雷', '翻车', '绝了',
                '恶心', '什么玩意', '很一般', '太差了', '差劲', '无语子'}

def is_empty_or_emotion(text):
    t = str(text or '').strip().strip('。.！!~～,，、；;？?　 \t\n')
    return (not t) or (t in PURE_EMOTION)


# ===== 商品名/商品编码提取（接口字段不固定，做通用扫描）=====
_NAME_KEYS = ('product_name', 'goods_name', 'item_name', 'sku_name', 'goods_title', 'product_title', 'product_title_name', 'name')
_ID_KEYS = ('product_id', 'goods_id', 'item_id', 'product_code', 'goods_code', 'outer_product_id', 'product_outer_id')

_BAD_NAME = ('申请', '等待', '处理', '物流', '签收', '发货', '退款', '售后', '已', '待')

def _ok_name(v):
    t = str(v or '').strip()
    if not t or len(t) < 5 or len(t) > 60:
        return False
    if t.isdigit():
        return False
    return not any(w in t for w in _BAD_NAME)

def _pick_product(obj, depth=0):
    """在任意返回结构里找商品名与商品编码。"""
    name = ''; pid = ''
    if depth > 4 or obj is None:
        return name, pid
    if isinstance(obj, dict):
        for k in _NAME_KEYS:
            v = obj.get(k)
            if isinstance(v, str) and _ok_name(v):
                name = v.strip(); break
        for k in _ID_KEYS:
            v = obj.get(k)
            if v not in (None, '', 0, '0'):
                pid = str(v); break
        if not name or not pid:
            for v in obj.values():
                if isinstance(v, (dict, list)):
                    n2, i2 = _pick_product(v, depth + 1)
                    name = name or n2; pid = pid or i2
                    if name and pid:
                        break
    elif isinstance(obj, list):
        for v in obj[:6]:
            n2, i2 = _pick_product(v, depth + 1)
            name = name or n2; pid = pid or i2
            if name and pid:
                break
    return name, pid

def _session(item, referer):
    s = requests.Session(); s.trust_env = False
    for c in item['cookies']:
        s.cookies.set(c['name'], c['value'], domain=c['domain'], path=c.get('path', '/'), secure=c.get('secure', True))
    s.headers.update({'User-Agent': item['ua'], 'Referer': referer, 'Accept': 'application/json'})
    return s

def _list_quality_orders(s, span, max_pages, page_size):
    """拉取近 N 天售后单，返回原因命中品质关键词的订单（含售后单号）。"""
    orders = []
    body = {'pageSize': page_size, 'page': 1, 'order_by': ['status_deadline asc'], 'conf_version': 'v13',
            'search_receiver': '', 'after_sale_status': '', 'after_sale_type': '', 'reason': 'product_quality',
            'negotiate_status': '', 'order_flag': [], 'order_logistics_state': [],
            'apply_time_start': span['start_epoch'], 'apply_time_end': span['end_epoch'],
            'shop_hit_gray_info': {'list_v1': {'hit': True}}}
    total = 0
    for page in range(1, max_pages + 1):
        body['page'] = page
        r = s.post(AFTER_SALE_API, params={'appid': '1', '_bid': 'ffa_aftersale', 'aid': '4272', 'aftersale_platform_source': 'fxg'},
                   json=body, timeout=(5, 25), allow_redirects=False)
        if r.status_code != 200:
            raise ValueError('售后 HTTP 请求失败')
        payload = r.json(); check_platform_login(payload)
        if payload.get('code') != 0 or payload.get('st', 0) != 0:
            raise ValueError('平台拒绝售后请求，请稍后重试')
        data = payload.get('data', {}) or {}
        items = data.get('items') or []
        total = payload.get('total') or data.get('total') or total
        for it in items:
            info = it.get('after_sale_info') or {}
            text = it.get('text_part') or {}
            reason = text.get('reason_text') or ''
            if not is_quality_reason(reason):
                continue
            order = it.get('order_info') or {}
            pname, pid = _pick_product(it)
            orders.append({
                'after_sale_id': str(info.get('after_sale_id') or ''),
                'order_id': order.get('shop_order_id') or info.get('related_id') or '',
                'reason': reason,
                'apply_time': info.get('apply_time') or 0,
                'product_name': pname,
                'product_id': pid,
            })
        if len(items) < page_size:
            break
    return orders, total

def _parse_detail(detail):
    """从售后详情中解析售后原因、售后说明、买家凭证、联系买家飞鸽链接。"""
    d = detail.get('data') or {}
    asi = d.get('after_sale_info') or {}
    det = asi.get('after_sale_detail') or {}
    rows = det.get('detail_info_v3') or det.get('detail_info') or []
    reason = ''; desc = ''
    for row in rows:
        if not isinstance(row, dict):
            continue
        label = row.get('label') or ''
        val = row.get('value')
        text = ' '.join(str(v) for v in val) if isinstance(val, list) else str(val or '')
        if label == '售后原因' and not reason:
            reason = text
        elif label == '售后说明' and not desc:
            desc = _clean_desc(text)
    pname, pid = _pick_product(d)
    return reason, desc, _has_evidence(d), _contact_url(d), pname, pid

def _contact_url(d):
    for a in d.get('actions') or []:
        if isinstance(a, dict) and a.get('id') == 'im_contact_user' and a.get('server_url'):
            return str(a['server_url'])
    return ''

_EMPTY_TOKENS = {'', '-', '—', '－', '--', '无', '暂无', '无说明', 'null', 'None'}

def _clean_desc(text):
    t = str(text or '').strip()
    return '' if t in _EMPTY_TOKENS else t

def _ymd(epoch):
    try:
        return datetime.fromtimestamp(int(epoch), ZoneInfo('Asia/Shanghai')).strftime('%Y-%m-%d')
    except Exception:
        return ''

def quality_appeal(order_id, reason, desc, apply_time):
    r = reason.replace('（商品品质原因）', '').replace('(商品品质原因)', '')
    return ('订单号：%s\n'
            '买家于%s发起售后申请，售后原因选择为“%s”，但售后说明填写的是“%s”。该说明属于个人主观原因，并非商品品质问题，与买家所选的品质退货原因不符。\n'
            '根据平台规则，消费者选择的售后原因为品质问题、但售后说明为个人主观原因或其他非品质原因的，属于“品质退货与事实不符”，支持举报成功。\n'
            '恳请平台核实并剔除该订单对本店商品品质退货率指标的考核，维护商家合法权益。\n'
            '附件：①售后单详情截图  ②飞鸽完整聊天记录截图  ③订单详情截图') % (order_id, _ymd(apply_time) or '—', r, desc)

def review_appeal(order_id, level, comment_time):
    return ('订单号：%s\n'
            '评价星级：%s\n'
            '买家于%s对订单商品给出中差评，经本店核查，该评价存在以下与事实不符的情况：\n'
            '一、评价无任何具体描述。买家评价内容为空，或仅含情绪化表述，未说明商品存在何种具体质量问题。\n'
            '二、评价无任何有效凭证。买家未上传任何商品问题照片、视频，无法佐证其评价主张。\n'
            '三、未事前联系客服。经核查飞鸽聊天记录，买家自下单至评价期间，从未通过客服渠道反馈过任何商品质量问题，也未与本店进行过任何售后协商，直接给出中差评。\n'
            '综上，该评价缺乏事实依据，与商品实际品质情况不符，属于异常评价。恳请平台核实并屏蔽/删除该评价，维护商家合法权益。\n'
            '附件：①评价详情截图  ②飞鸽完整聊天记录截图  ③订单详情截图') % (order_id, level or '—', _ymd(comment_time) or '—')

def _has_evidence(obj):
    """递归判断是否存在非空的买家图片/视频凭证。"""
    keys = ('evidence_list', 'images', 'image_video', 'user_apply_evidence', 'evidence_judge_info')
    found = [False]
    def walk(o, depth=0):
        if found[0] or depth > 12:
            return
        if isinstance(o, dict):
            for k, v in o.items():
                if k in keys and v:
                    if isinstance(v, list) and len(v) > 0:
                        found[0] = True; return
                    if isinstance(v, dict) and len(v) > 0:
                        found[0] = True; return
                walk(v, depth + 1)
        elif isinstance(o, list):
            for x in o:
                walk(x, depth + 1)
    walk(obj)
    return found[0]

def _fetch_detail(s, after_sale_id):
    r = s.get(AFTER_SALE_DETAIL_API, params={'appid': '1', '_bid': 'ffa_aftersale', 'aid': '4272',
                                             'aftersale_platform_source': 'fxg', 'after_sale_id': after_sale_id,
                                             'extra': json.dumps({'detail_upgrade_hit': 'new'}, separators=(',', ':'))},
              timeout=(5, 25), allow_redirects=False)
    if r.status_code != 200:
        raise ValueError('售后详情请求失败')
    payload = r.json(); check_platform_login(payload)
    if payload.get('code') != 0 or payload.get('st', 0) != 0:
        raise ValueError('售后详情被平台拒绝')
    return payload

def fetch_quality_returns(item, span=None, max_pages=60, page_size=50, max_details=2200, detail_workers=6):
    """扫描品退：售后原因为品质类，且售后说明为空、无任何买家图片/视频凭证。"""
    if span is None:
        span = span_since(item.get('since'))
    started = time.perf_counter(); s = _session(item, AFTER_SALE_REFERER)
    candidates = []
    try:
        orders, total = _list_quality_orders(s, span, max_pages, page_size)
        quality_total = len(orders)
        all_daily = {}
        for _o in orders:
            _d = _ymd(_o['apply_time'])
            if _d: all_daily[_d] = all_daily.get(_d, 0) + 1
        # 优先核查「尚未判定」的单（已判定的排后面），多跑几轮可把全量补全
        _chk=set(str(x) for x in (item.get('checked') or []))
        if _chk:
            orders.sort(key=lambda _o: 1 if str(_o['order_id']) in _chk else 0)
        picked = orders[:max_details]
        cookies = [dict(c) for c in item['cookies']]; ua = item['ua']
        def work(o):
            ds = _session({'cookies': [dict(c) for c in cookies], 'ua': ua}, AFTER_SALE_REFERER)
            try:
                reason, desc, has_ev, contact, pname, pid = _parse_detail(_fetch_detail(ds, o['after_sale_id']))
                return o, reason, desc, has_ev, contact, pname, pid
            except Exception:
                return o, None, None, None, '', '', ''
            finally:
                ds.cookies.clear(); ds.close()
        # 超出单次逐单核查上限的，也进池（标未核查），保证「品退全量」不漏
        pool_rows = []
        for _o in orders[max_details:]:
            pool_rows.append({
                'order_id': _o['order_id'], 'after_sale_id': _o['after_sale_id'],
                'reason': _o.get('reason') or '', 'description': '', 'has_media': False,
                'apply_date': _ymd(_o['apply_time']),
                'apply_time': datetime.fromtimestamp(_o['apply_time'], ZoneInfo('Asia/Shanghai')).isoformat() if _o['apply_time'] else '',
                'product_name': _o.get('product_name') or '', 'product_id': _o.get('product_id') or '',
                'flyge_url': '', 'appealable': None, 'block_reason': '未逐单核查（超出单次上限，下次跑批会覆盖）',
            })
        with ThreadPoolExecutor(max_workers=detail_workers) as pool:
            for o, reason, desc, has_ev, contact, pname, pid in pool.map(work, picked):
                if reason is None:
                    pool_rows.append({
                        'order_id': o['order_id'], 'after_sale_id': o['after_sale_id'],
                        'reason': o.get('reason') or '', 'description': '', 'has_media': False,
                        'apply_date': _ymd(o['apply_time']),
                        'apply_time': datetime.fromtimestamp(o['apply_time'], ZoneInfo('Asia/Shanghai')).isoformat() if o['apply_time'] else '',
                        'product_name': pname or o.get('product_name') or '', 'product_id': pid or o.get('product_id') or '',
                        'flyge_url': '', 'appealable': False, 'block_reason': '售后详情获取失败，待重试',
                    })
                    continue  # 详情获取失败，不贸然判定
                if not is_quality_reason(reason):
                    continue
                block = ''
                if not is_subjective_reason(desc):
                    block = '售后说明与所选品质原因一致，不属主观' if str(desc or '').strip() else '买家未填写售后说明'
                elif has_strong_quality(desc):
                    block = '说明里含具体品质问题（%s）' % str(desc)[:14]  # 原因与描述一致，举报不过
                pool_rows.append({
                    'order_id': o['order_id'], 'after_sale_id': o['after_sale_id'],
                    'reason': reason, 'description': desc, 'has_media': bool(has_ev),
                    'apply_date': _ymd(o['apply_time']),
                    'apply_time': datetime.fromtimestamp(o['apply_time'], ZoneInfo('Asia/Shanghai')).isoformat() if o['apply_time'] else '',
                    'product_name': pname or o.get('product_name') or '', 'product_id': pid or o.get('product_id') or '',
                    'flyge_url': contact, 'appealable': not block, 'block_reason': block,
                })
                if block:
                    continue
                r_short = reason.replace('（商品品质原因）', '').replace('(商品品质原因)', '')
                report_desc = ('售后原因选“%s”，但售后说明写的是“%s”，属个人主观/非品质原因，与所选品质退货原因不符，恳请核实剔除品退率考核。' % (r_short, desc))[:100]
                candidates.append({
                    'order_id': o['order_id'],
                    'after_sale_id': o['after_sale_id'],
                    'reason': reason,
                    'description': desc,
                    'has_media': bool(has_ev),
                    'apply_time': datetime.fromtimestamp(o['apply_time'], ZoneInfo('Asia/Shanghai')).isoformat() if o['apply_time'] else '',
                    'apply_date': _ymd(o['apply_time']),
                    'flyge_url': contact,
                    'evidence': '①售后单详情截图  ②飞鸽完整聊天记录截图  ③订单详情截图',
                    'report_desc': report_desc,
                    'product_name': pname or o.get('product_name') or '',
                    'product_id': pid or o.get('product_id') or '',
                    'appeal_text': quality_appeal(o['order_id'], reason, desc, o['apply_time']),
                })
        return {'shop_id': item['id'], 'name': item['name'], 'status': 'ok',
                'quality_count': quality_total, 'checked_count': len(picked), 'candidate_count': len(candidates),
                'appealable_count': sum(1 for x in pool_rows if x.get('appealable')),
                'all_daily': all_daily,
                'all_returns': pool_rows,
                'candidates': candidates,
                'candidate_orders': '、'.join(c['order_id'] for c in candidates[:30]) or '',
                'captured_at': datetime.now(ZoneInfo('Asia/Shanghai')).isoformat(),
                'source': AFTER_SALE_API, 'http_seconds': round(time.perf_counter() - started, 3)}
    except Exception as e:
        return {'shop_id': item['id'], 'name': item['name'], 'status': 'error',
                'error': str(e) if type(e) is ValueError else '请求或解析失败',
                'http_seconds': round(time.perf_counter() - started, 3)}
    finally:
        s.cookies.clear(); s.close(); item['cookies'].clear()

def fetch_negative_reviews(item, max_pages=20, page_size=50):
    """扫描中差评（1~3 星）：近30天内、评价无实质描述、且无图片 / 无视频。"""
    started = time.perf_counter(); s = _session(item, COMMENT_REFERER)
    _all_rows = []
    candidates = []; negative_total = 0; all_daily = {}
    cutoff = int(time.time()) - 30 * 86400
    try:
        if item.get('since'):
            cutoff = max(cutoff, int(int(item['since']) / 1000))   # 增量
    except Exception:
        pass
    try:
        for rank in (1, 2):  # 1=差评(1~2星) 2=中评(3星)
            for page in range(0, max_pages):
                r = s.get(COMMENT_API, params={'rank': rank, 'page': page, 'pageSize': page_size,
                                               'status_filter': 0, 'content_search': 0, 'reply_search': 0,
                                               'appeal_search': 0, 'bad_comment_class_tag_key': '',
                                               'count_ecology_score_filter': 0, 'random': 0.5,
                                               'appid': 1}, timeout=(5, 25), allow_redirects=False)
                if r.status_code != 200:
                    raise ValueError('评价 HTTP 请求失败')
                payload = r.json(); check_platform_login(payload)
                if payload.get('code') != 0 or payload.get('st', 0) != 0:
                    raise ValueError('平台拒绝评价请求，请稍后重试')
                rows = payload.get('data') or []
                if not isinstance(rows, list):
                    rows = []
                negative_total += len(rows)
                for c in rows:
                    ct = c.get('comment_time') or 0
                    if ct >= cutoff:
                        _d = _ymd(ct)
                        if _d: all_daily[_d] = all_daily.get(_d, 0) + 1
                    if ct < cutoff:               # 平台：仅可举报30天内异常评价
                        continue
                    content = (c.get('content') or '').strip()
                    photos = c.get('photos') or []
                    videos = c.get('videos') or []
                    pname, pid = _pick_product(c)
                    # 全量留存（供人工/AI 复盘，不影响候选筛选）
                    _all_rows.append({
                        'order_id': c.get('order_id') or c.get('shop_order_id') or '',
                        'comment_id': str(c.get('comment_id') or ''),
                        'rank': c.get('rank'),
                        'level': ((c.get('tags') or {}).get('rank_info') or {}).get('name') or '',
                        'content': content,
                        'has_media': bool(photos or videos),
                        'comment_date': _ymd(c.get('comment_time') or 0),
                        'product_name': pname,
                        'product_id': pid,
                    })
                    if not is_empty_or_emotion(content) or photos or videos:
                        continue
                    candidates.append({
                        'order_id': c.get('order_id') or c.get('shop_order_id') or '',
                        'product_name': pname,
                        'product_id': pid,
                        'comment_id': str(c.get('id') or ''),
                        'rank': c.get('rank'),
                        'level': ((c.get('tags') or {}).get('rank_info') or {}).get('name') or '',
                        'content': content,
                        'has_media': bool(photos or videos),
                        'comment_time': datetime.fromtimestamp(c.get('comment_time') or 0, ZoneInfo('Asia/Shanghai')).isoformat() if c.get('comment_time') else '',
                        'comment_date': _ymd(c.get('comment_time')),
                        'flyge_url': (((c.get('action_map') or {}).get('contactBuyer') or {}).get('action_url') or ''),
                        'evidence': '①评价详情截图  ②飞鸽完整聊天记录截图  ③订单详情截图',
                        'appeal_text': review_appeal(c.get('order_id') or c.get('shop_order_id') or '',
                                                     ((c.get('tags') or {}).get('rank_info') or {}).get('name') or '',
                                                     c.get('comment_time')),
                    })
                if len(rows) < page_size:
                    break
                if rows and min((c.get('comment_time') or 0) for c in rows) < cutoff:
                    break   # 列表按时间倒序，已到30天前就不再看
        return {'shop_id': item['id'], 'name': item['name'], 'status': 'ok',
                'all_reviews': _all_rows,
                'negative_count': negative_total, 'candidate_count': len(candidates),
                'all_daily': all_daily,
                'candidates': candidates,
                'candidate_orders': '、'.join(c['order_id'] for c in candidates[:30]) or '',
                'captured_at': datetime.now(ZoneInfo('Asia/Shanghai')).isoformat(),
                'source': COMMENT_API, 'http_seconds': round(time.perf_counter() - started, 3)}
    except Exception as e:
        return {'shop_id': item['id'], 'name': item['name'], 'status': 'error',
                'error': str(e) if type(e) is ValueError else '请求或解析失败',
                'http_seconds': round(time.perf_counter() - started, 3)}
    finally:
        s.cookies.clear(); s.close(); item['cookies'].clear()


def fetch_review_details(item, max_pages=40, page_size=50):
    """评价明细全量采集（近30天，含好评/中评/差评）：评价ID、星级、订单号、商品/SKU、
    正文、追评、图片/视频、商家回复、平台标签。供 BI 关联订单/物流/供应商分析差评率。"""
    started = time.perf_counter(); s = _session(item, COMMENT_REFERER)
    cutoff = int(time.time()) - 30 * 86400
    try:
        if item.get('since'):
            cutoff = max(cutoff, int(int(item['since']) / 1000))
    except Exception:
        pass
    rows = []; fetched = 0; reached_old = False
    try:
        for page in range(0, max_pages):
            r = s.get(COMMENT_API, params={'rank': 0, 'page': page, 'pageSize': page_size,
                                           'status_filter': 0, 'content_search': 0, 'reply_search': 0,
                                           'appeal_search': 0, 'bad_comment_class_tag_key': '',
                                           'count_ecology_score_filter': 0, 'random': 0.5,
                                           'appid': 1}, timeout=(5, 25), allow_redirects=False)
            if r.status_code != 200:
                raise ValueError('评价 HTTP 请求失败')
            payload = r.json(); check_platform_login(payload)
            if payload.get('code') != 0 or payload.get('st', 0) != 0:
                raise ValueError('平台拒绝评价请求，请稍后重试')
            batch = payload.get('data') or []
            if not isinstance(batch, list) or not batch:
                break
            fetched += len(batch)
            for c in batch:
                ct = int(c.get('comment_time') or 0)
                if ct < cutoff:
                    reached_old = True
                    continue
                tags = c.get('tags') or {}
                appends = c.get('appends') or []
                photos = c.get('photos') or []
                videos = c.get('videos') or []
                rows.append({
                    'review_id': str(c.get('id') or ''),
                    'comment_time': ct, 'date': _ymd(ct),
                    'rank': c.get('rank'), 'rank_shop': c.get('rank_shop'),
                    'rank_logistic': c.get('rank_logistic'), 'rank_product': c.get('rank_product'),
                    'rank_name': ((tags.get('rank_info') or {}).get('name') or ''),
                    'order_id': str(c.get('order_id') or ''), 'shop_order_id': str(c.get('shop_order_id') or ''),
                    'product_id': str(c.get('product_id') or ''), 'sku_id': str(c.get('sku_id') or ''),
                    'sku': c.get('sku') or '',
                    'content': c.get('content') or '', 'orig_content': c.get('orig_content') or '',
                    'is_append': c.get('is_append') or 0, 'parent_id': str(c.get('parent_id') or '0'),
                    'append_count': len(appends),
                    'appends': [{'content': (a.get('content') or ''), 'comment_time': a.get('comment_time')} for a in appends],
                    'photo_count': len(photos), 'video_count': len(videos),
                    'shop_reply': c.get('shop_reply') or '', 'is_shop_reply': c.get('is_shop_reply') or 0,
                    'reply_time': c.get('reply_time'),
                    'negative_tags': tags.get('negative_tags') or [],
                    'bad_info': tags.get('bad_info'),
                    'user_name': c.get('user_name') or '', 'likes': c.get('likes') or 0,
                    'status': c.get('status'), 'status_info': c.get('status_info'),
                    'store_id': str(c.get('store_id') or ''), 'store_name': c.get('store_name') or '',
                    'is_abnormal_order': c.get('is_abnormal_order'),
                })
            oldest = min(int(c.get('comment_time') or 0) for c in batch)
            if oldest < cutoff or len(batch) < page_size:
                break
        return {'status': 'ok', 'name': item.get('name') or '', 'shop_id': item.get('shop_id') or '',
                'details': rows, 'fetched': fetched, 'reached_30d': reached_old or True,
                'seconds': round(time.perf_counter() - started, 2)}
    except Exception as e:
        return {'status': 'error', 'name': item.get('name') or '', 'shop_id': item.get('shop_id') or '',
                'error': str(e), 'details': rows, 'seconds': round(time.perf_counter() - started, 2)}
