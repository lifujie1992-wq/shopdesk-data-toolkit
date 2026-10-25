"""抖店后台只读接口封装：抓取 + 解析。仅使用调用方提供的会话 cookie。"""
import json, re, threading, time
import requests

BASE = 'https://fxg.jinritemai.com'
REF = BASE + '/ffa/mshop/homepage/index'
EXP_ROOT = BASE + '/governance/shop/experiencescore/'
AFTER_SALE = BASE + '/after_sale/pc/list'

# 罗盘（compass）与营销数据在独立域名，cookie 同域共享（.jinritemai.com）
COMPASS_BASE = 'https://compass.jinritemai.com'
# 注意：compass 的 Referer 会触发风控（“当前环境存在风险”），实际请求不要带，见 _compass_get
COMPASS_REF = COMPASS_BASE + '/shop/business-part'

NUM_RE = re.compile(r'^[¥￥]?(-?\d+(?:\.\d+)?)(万|亿)?$')


def _clean(v):
    """平台用 -9999 表示无数据。"""
    if isinstance(v, (int, float)) and v == -9999:
        return None
    return v


def num(v):
    """把 '¥149.00' / '7.07%' / '1.2万' 转 float。"""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace(',', '')
    pct = s.endswith('%')
    s = s.rstrip('%')
    m = NUM_RE.match(s)
    if not m:
        return None
    val = float(m.group(1)) * {'万': 10000, '亿': 100000000}.get(m.group(2), 1)
    return val


def login_check(payload):
    """识别登录失效 / 需要验证，供工作台标记登录状态。"""
    if not isinstance(payload, dict):
        return
    if payload.get('code') == 0 and payload.get('st', 0) == 0:
        return
    msg = str(payload.get('msg') or payload.get('message') or '')
    if re.search(r'安全验证|身份验证|请完成.{0,8}验证', msg):
        raise ValueError('VERIFICATION_REQUIRED: 需要完成平台验证，请打开店铺处理')
    if (str(payload.get('code')) == '10008' and str(payload.get('st')) == '10000') or \
       re.search(r'登录(?:信息)?已失效|登录过期|请重新登录|未登录', msg):
        raise ValueError('LOGIN_REQUIRED: 登录已失效，请重新扫码登录')


def make_session(cookies, ua):
    s = requests.Session()
    s.trust_env = False
    for c in cookies:
        s.cookies.set(c['name'], c['value'], domain=c['domain'],
                      path=c.get('path', '/'), secure=c.get('secure', True))
    s.headers.update({
        'User-Agent': ua or '',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': REF,
    })
    return s


def _get(session, path, params=None, referer=None):
    h = {'Referer': referer} if referer else {}
    r = session.get(BASE + path, params=params or {}, headers=h, timeout=(5, 25), allow_redirects=False)
    if r.status_code != 200:
        raise ValueError('平台 HTTP %s' % r.status_code)
    try:
        body = r.json()
    except ValueError:
        raise ValueError('平台返回非 JSON')
    login_check(body)
    if body.get('code') not in (0, None):
        raise ValueError('平台拒绝请求 %s' % str(body.get('msg') or '')[:40])
    return body


def _post(session, path, params, body, referer=None):
    h = {'Referer': referer} if referer else {}
    r = session.post(BASE + path, params=params, json=body, headers=h, timeout=(5, 25), allow_redirects=False)
    if r.status_code != 200:
        raise ValueError('平台 HTTP %s' % r.status_code)
    try:
        j = r.json()
    except ValueError:
        raise ValueError('平台返回非 JSON')
    login_check(j)
    if j.get('code') not in (0, None):
        raise ValueError('平台拒绝请求 %s' % str(j.get('msg') or '')[:40])
    return j


# 罗盘限流：多店并发时很容易触发「请求过于频繁」。全局串行化 + 最小间隔，从源头避免。
COMPASS_MIN_INTERVAL = 3.5
COMPASS_RETRY_DELAYS = (20, 45, 90)
_compass_lock = threading.Lock()
_compass_next = [0.0]


def _compass_get(session, path, params=None, referer=None):
    """罗盘/营销接口：独立域名，状态码在 st（部分接口用 code）。

    注意：Referer 不要带 compass.jinritemai.com（会触发风控），沿用会话默认 referer。
    全局串行 + 最小间隔避免限流；偶发限流再退避重试。
    """
    h = {'Referer': referer} if referer else {}
    msg = ''
    for attempt in range(len(COMPASS_RETRY_DELAYS) + 1):
        with _compass_lock:
            wait = _compass_next[0] - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            r = session.get(COMPASS_BASE + path, params=params or {}, headers=h,
                            timeout=(5, 25), allow_redirects=False)
            _compass_next[0] = time.monotonic() + COMPASS_MIN_INTERVAL
        if r.status_code != 200:
            raise ValueError('罗盘 HTTP %s' % r.status_code)
        try:
            body = r.json()
        except ValueError:
            raise ValueError('罗盘返回非 JSON')
        login_check(body)
        if body.get('st') in (0, None) and body.get('code') in (0, None):
            return body
        msg = str(body.get('msg') or body.get('message') or '')
        if attempt < len(COMPASS_RETRY_DELAYS) and (
                '频繁' in msg or '稍后重试' in msg or '风控' in msg or '存在风险' in msg):
            time.sleep(COMPASS_RETRY_DELAYS[attempt])
            continue
        raise ValueError('罗盘拒绝请求 %s' % msg[:40])
    raise ValueError('罗盘拒绝请求（重试后仍限流）%s' % msg[:40])
    return body


def _card_map(body, module):
    """取罗盘 compass_general_multi_index_card_value 卡片。"""
    mod = ((body.get('data') or {}).get('module_data') or {}).get(module) or {}
    return mod.get('compass_general_multi_index_card_value') or {}


def _index_value(card, key):
    """罗盘卡片指标值。unit: 3=分 4=小数比例 5=次数/人数 6=无数据。"""
    row = (card.get('data') or [{}])[0]
    node = row.get(key) or {}
    iv = (node.get('index_value') or {}).get('value') or {}
    val, unit = iv.get('value'), iv.get('unit')
    if val is None:
        val = iv.get('value_str')
    if val is None or val == -9999:
        return None
    if isinstance(val, (int, float)):
        if unit == 3:
            val = round(val / 100, 2)          # 分 -> 元
        elif unit == 4:
            val = round(val * 100, 4)          # 小数比例 -> 百分数
    return val


# ---------------- 经营首页（实时） ----------------
HOME_LABELS = {
    '成交金额': 'sales', '成交订单数': 'orders', '退款金额(支付时间)': 'refund_pay',
    '商品曝光人数': 'exposure_uv', '商品点击人数': 'click_uv', '成交人数': 'buyer_uv',
    '客单价': 'aov', '支出金额': 'spend', '用户支付金额': 'pay_amt',
    '投放消耗（店铺被投）': 'ad_cost', '投放费比': 'ad_ratio',
    '退款订单数(退款时间)': 'refund_orders', '商品曝光-点击转化率(人数)': 'ctr',
    '商品点击-成交转化率(人数)': 'cvr', '结算金额': 'settle_amt',
}
TODO_LABELS = {
    '待支付': 'todo_unpaid', '待发货': 'todo_stockup', '异常包裹': 'todo_exception',
    '待处理售后': 'todo_aftersale', '服务工单': 'todo_ticket',
    '待整改风险点': 'todo_risk', '待处理违规': 'todo_violation',
}


def fetch_home(s):
    b = _get(s, '/pc/api/home/homepage', {
        'meet_redirect_grey': 'true', 'source': '1',
        'homepage_version': '202606240', 'appid': '1', '_bid': 'ffa_shop'})
    layouts = (b.get('data') or {}).get('lay_out_data')
    if not isinstance(layouts, list):
        raise ValueError('首页结构变化')
    out, shop = {}, {}
    for card in [c for l in layouts for c in l.get('cards', [])]:
        data = card.get('data') or {}
        info = (data.get('shop_info_card_data') or {}).get('base_info')
        if info:
            shop = {'shop_name': info.get('name'),
                    'platform_shop_id': str((info.get('douyin_shop_info') or {}).get('shop_id', ''))}
        for grp, mapping in (('todo_list_card_data', TODO_LABELS),
                             ('operating_data_card_v4_data', HOME_LABELS)):
            g = data.get(grp) or {}
            for item in (g.get('todo_list') or g.get('compass_list') or []):
                k = mapping.get(item.get('title'))
                if k:
                    out[k] = num(item.get('val'))
        raw = (card.get('custom_data') or {}).get('pc_refund_diagnose_data')
        if raw:
            try:
                gen = json.loads(raw).get('general_index', {})
                for m in gen.get('basic_meta', []):
                    if m.get('index_name') == 'refund_amt':
                        v = gen['data'][0]['refund_amt']['index_value']['value']
                        if v.get('unit') == 3 and isinstance(v.get('value'), (int, float)):
                            out['refund7'] = round(v['value'] / 100, 2)
            except (ValueError, KeyError, IndexError, TypeError):
                pass
    return out, shop


# ---------------- 体验分 ----------------
def score_from_thresholds(value, conf, node_score=None):
    """按平台分档阈值(100/90/80/70/60)做分段线性插值。"""
    if node_score:
        try:
            n = float(node_score)
            if n > 0:
                return n
        except (TypeError, ValueError):
            pass
    if value is None or not isinstance(conf, dict):
        return None
    pts = []
    for sc, key in ((100, 'threshold_one_hundred'), (90, 'threshold_ninety'),
                    (80, 'threshold_eighty'), (70, 'threshold_seventy'),
                    (60, 'threshold_sixty')):
        try:
            pts.append((float(conf[key]), sc))
        except (KeyError, TypeError, ValueError):
            continue
    if len(pts) < 2:
        return None
    pts.sort()
    if value <= pts[0][0]:
        seg = (pts[0], pts[1])
    elif value >= pts[-1][0]:
        seg = (pts[-2], pts[-1])
    else:
        seg = next((pts[i], pts[i + 1]) for i in range(len(pts) - 1)
                   if pts[i][0] <= value <= pts[i + 1][0])
    (v1, s1), (v2, s2) = seg
    if v2 == v1:
        return float(s1)
    score = s1 + (s2 - s1) * (value - v1) / (v2 - v1)
    return round(max(0.0, min(100.0, score)), 2)


def fetch_experience(s):
    o = _get(s, '/governance/shop/experiencescore/getOverviewByVersion',
             {'exp_version': 'release', 'new_shop_version': 'release', 'source': '1'},
             referer=BASE + '/ffa/eco/experience-score')
    a = _get(s, '/governance/shop/experiencescore/getAnalysisScore',
             {'exp_version': 'release', 'new_shop_version': 'release', 'number_type': '30 '},
             referer=BASE + '/ffa/eco/experience-score')
    d, ad = o.get('data') or {}, a.get('data') or {}
    if not isinstance(ad.get('shop_analysis'), list) or not ad['shop_analysis']:
        raise ValueError('体验分明细接口结构变化')
    if not isinstance(d.get('experience_score'), dict) and not d.get('new_shop_info'):
        raise ValueError('体验分总览接口结构变化')
    if ad.get('shop_name') and ad['shop_name'] != d.get('shop_name') and d.get('shop_name'):
        raise ValueError('店铺身份不匹配')
    out = {
        'exp_total': _clean(d.get('experience_score', {}).get('value')),
        'exp_goods': _clean(d.get('goods_score', {}).get('value')),
        'exp_logistics': _clean(d.get('logistics_score', {}).get('value')),
        'exp_service': _clean(d.get('service_score', {}).get('value')),
        'exp_has_data': bool(d.get('has_data')),
        'exp_update_time': d.get('update_time'),
        'exp_category': ad.get('shop_category'),
        'exp_window': '%s~%s' % (ad.get('begin_date') or '', ad.get('current_date') or ''),
        'platform_shop_id': str(ad.get('shop_id') or ''),
    }
    cat = ad.get('shop_category')
    for node in ad.get('shop_analysis') or []:
        title = node.get('title') or ''
        val = (node.get('value') or {}).get('value_figure')
        conf = (node.get('standard_conf_info_map') or {}).get(cat) or {}
        nsi = node.get('node_score_info') or {}
        if title in SUB_METRICS and val is not None and val != -9999:
            key = SUB_METRICS[title]
            out['m_' + key] = val
            sc = score_from_thresholds(val, conf, nsi.get('node_score'))
            if sc is not None:
                out['s_' + key] = sc
    return out, d.get('shop_name')


SUB_METRICS = {
    '商品综合评分': 'goods_rating',
    '商品品质退货率': 'quality_return',
    '揽收时效达成率': 'collect_ontime',
    '揽收时长平均得分': 'collect_duration',
    '运单配送时效达成率': 'delivery_ontime',
    '发货物流品退率': 'logistics_return',
    '飞鸽平均响应时长': 'feige_response',
    '售后处理时长达成率': 'aftersale_ontime',
    '售后平均审核时长': 'aftersale_audit',
    '飞鸽会话不满意率': 'feige_dissatisfy',
    '平台求助率': 'platform_help',
    '虚假交易刷体验分': 'fake_trade',
    '影响消费者体验': 'affect_experience',
}


# ---------------- 计数类 ----------------
def _pct_text(v):
    """'0.00%' -> 0.0"""
    if v is None or v == '-':
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    if s.endswith('%'):
        s = s[:-1]
    try:
        return float(s)
    except ValueError:
        return None


def _inner(v):
    return v.get('last_30days_value') if isinstance(v, dict) else v


def fetch_comments(s):
    """评价管理汇总。注意 good_rate/bad_rate 是废弃字段，真实值在 *_comment_*。"""
    b = _get(s, '/product/tcomment/statistics', {}, referer=BASE + '/ffa/g/comment/goods-comment-list')
    d = b.get('data') or {}
    if not isinstance(d, dict) or 'positive_comment_rate' not in d:
        raise ValueError('评价接口结构变化')
    return {
        # 总计数（不分周期）
        'comment_good_count': d.get('positive_commnet_count'),
        'comment_neutral_count': d.get('neutral_comment_count'),
        'comment_bad_count': d.get('negative_comment_count'),
        # 近30天比例
        'comment_good_rate': _pct_text(_inner(d.get('positive_comment_rate'))),
        'comment_neutral_rate': _pct_text(_inner(d.get('neutral_comment_rate'))),
        'comment_bad_rate': _pct_text(_inner(d.get('negative_comment_rate'))),
        'comment_order_rate': _pct_text(_inner(d.get('order_comment_rate'))),
        'comment_detailed_rate': _pct_text(_inner(d.get('detailed_comment_rate'))),
        # 近30天计数
        'comment_new_30d': _inner(d.get('new_order_comment_30d')),
        'comment_detailed_30d': _inner(d.get('detailed_comment_30d')),
        'comment_good_30d': d.get('positive_commnet_count_30d'),
        'comment_neutral_30d': d.get('neutral_comment_count_30d'),
        'comment_bad_30d': d.get('negative_comment_count_30d'),
        'comment_in_score_30d': d.get('positive_commnet_in_ecology_score_count_30d'),
        # 其它
        'comment_with_photo': d.get('has_photo_count'),
        'comment_with_video': d.get('has_video_count'),
        'comment_with_content': d.get('has_content_count'),
        'comment_unreply': d.get('unreply_count'),
        'comment_bad_to_reply': d.get('bad_to_reply_count'),
        'comment_worst': d.get('worst_count'),
        'comment_latest_date': str(d.get('latestDate') or ''),
    }


def fetch_brush_reviews(s, shop):
    """刷单(聚水潭紫旗)订单的当日新增评价统计 —— 需要 shop['_brush_ids']/_brush_stat_date。

    口径：评价时间=统计日期 的新增评价中，订单号 ∈ 紫旗集合 的：
        brush_good_reviews    出好评数（rank>=4 或 平台标记"好评"）
        brush_count_reviews   计入评价数（excluded_by_exp_score=False，即计入体验分）
    未匹配聚水潭店铺（_brush_ids is None）→ 置 None。
    """
    ids = shop.get('_brush_ids')
    stat = shop.get('_brush_stat_date')
    if ids is None or not stat:
        return {'brush_good_reviews': None, 'brush_count_reviews': None}
    if not ids:
        return {'brush_good_reviews': 0, 'brush_count_reviews': 0}
    y, m, d = map(int, stat.split('-'))
    day_start = time.mktime((y, m, d, 0, 0, 0, 0, 0, -1))
    day_end = day_start + 86399
    REF = BASE + '/ffa/g/comment/goods-comment-list'
    good = counted = 0
    page = 1
    while page <= 60:
        b = _get(s, '/product/tcomment/commentList',
                 {'page': page, 'pageSize': 50}, referer=REF)
        rows = b.get('data') or []
        if not rows:
            break
        stop = False
        for r in rows:
            ct = r.get('comment_time') or 0
            if ct < day_start:
                stop = True          # 按时间倒序，往后只会更早
                continue
            if ct > day_end:
                continue
            if str(r.get('order_id') or '') in ids:
                info = (r.get('tags') or {}).get('rank_info') or {}
                if info.get('name') == '好评' or (r.get('rank') or 0) >= 4:
                    good += 1
                if not r.get('excluded_by_exp_score'):
                    counted += 1
        if stop or len(rows) < 50:
            break
        page += 1
    return {'brush_good_reviews': good, 'brush_count_reviews': counted}


def fetch_tabcnt(s):
    b = _get(s, '/api/order/tabcnt', {'appid': '1', '_bid': 'ffa_order'},
             referer=BASE + '/ffa/morder/order/list')
    d = b.get('data') or {}
    if not isinstance(d, dict) or 'stock_up' not in d:
        raise ValueError('订单计数接口结构变化')
    return {
        'order_stock_up': d.get('stock_up'),
        'order_ship_delay': d.get('ship_delay'),
        'order_exp_ship': d.get('exp_ship'),
        'order_in_aftersale': d.get('in_aftersale'),
        'order_on_delivery': d.get('on_delivery'),
        'order_received': d.get('received'),
        'order_closed': d.get('closed'),
        'order_all': d.get('all'),
        'order_unpaid': d.get('unpaid'),
    }


def fetch_products(s):
    b = _get(s, '/product/tproduct/aggsProductCount', {'tab': 'onSale'},
             referer=BASE + '/ffa/g/list')
    d = b.get('data') or {}
    if not isinstance(d, dict) or 'onsale' not in d:
        raise ValueError('商品汇总接口结构变化')
    return {
        'product_onsale': d.get('onsale'),
        'product_draft': d.get('draft'),
        'product_audit': d.get('audit'),
        'product_forbidden': d.get('forbidden'),
        'product_unpass': d.get('unpass'),
    }


def fetch_aftersale(s, days=30):
    from datetime import datetime, timedelta
    from zoneinfo import ZoneInfo
    now = datetime.now(ZoneInfo('Asia/Shanghai'))
    start = (now - timedelta(days=days - 1)).replace(hour=0, minute=0, second=0, microsecond=0)
    body = {'pageSize': 10, 'page': 1, 'order_by': ['status_deadline asc'], 'conf_version': 'v13',
            'search_receiver': '', 'after_sale_status': '', 'after_sale_type': '',
            'reason': '', 'negotiate_status': '', 'order_flag': [], 'order_logistics_state': [],
            'apply_time_start': int(start.timestamp()), 'apply_time_end': int(now.timestamp()),
            'shop_hit_gray_info': {'list_v1': {'hit': True}}}
    j = _post(s, '/after_sale/pc/list',
              {'appid': '1', '_bid': 'ffa_aftersale', 'aid': '4272', 'aftersale_platform_source': 'fxg'},
              body, referer=BASE + '/ffa/merchant-aftersale-workbench/aftersale/list')
    total = j.get('total')
    if type(total) is not int or total < 0:
        raise ValueError('售后接口结构变化')
    return {'aftersale_total': total, 'aftersale_window_days': days}


def fetch_logistics(s, days=30):
    """包裹中心：近 N 天包裹总数（含异常包裹）。"""
    from datetime import datetime, timedelta
    from zoneinfo import ZoneInfo
    now = datetime.now(ZoneInfo('Asia/Shanghai'))
    start = (now - timedelta(days=days - 1)).replace(hour=0, minute=0, second=0, microsecond=0)
    out = {}
    try:
        b = _get(s, '/shopuser/power/getPackageList', {
            'deliveryTimeStart': int(start.timestamp()), 'deliveryTimeEnd': int(now.timestamp()),
            'page': '1', 'pageSize': '10', 'orderColumn': 'delivery_time', 'queryType': '0',
            'orderType': '2', 'onlyComment': '0', 'immunityTrue': '0', 'specialTag': '0',
            'hasCompensationAmount': '0', 'appid': '1',
        }, referer=BASE + '/ffa/logistics/parcelCenter')
        d = b.get('data')
        if isinstance(d, dict) and isinstance(d.get('total'), int):
            out['package_total'] = d['total']
            items = d.get('list') or []
            if isinstance(items, list):
                exc = 0
                for it in items:
                    if it.get('exceptionList'):
                        exc += 1
                out['package_exception_sampled'] = exc
    except ValueError as e:
        if str(e).startswith(('LOGIN_REQUIRED', 'VERIFICATION_REQUIRED')):
            raise
    return out


def fetch_stock(s):
    """库存/缺货管理（POST，返回店铺级缺货统计）。"""
    j = _post(s, '/stock/manage/list', {'appid': '1', '_bid': 'ffa_goods',
                                        'page': '1', 'pageSize': '10'}, {},
              referer=BASE + '/ffa/g/stock-manage/list')
    if not isinstance(j, dict) or 'sold_out_cnt' not in j:
        raise ValueError('库存接口结构变化')
    return {
        'stock_sold_out': j.get('sold_out_cnt'),
        'stock_alarm': j.get('stock_alarm_cnt'),
        'stock_advised_increase': j.get('advised_increase_spot_cnt'),
        'stock_sku_total': j.get('total'),
    }


# ---------------- 商品上架/下架流 ----------------
def _product_list(s, tab, order_field, page, page_size=100, extra=None):
    params = {'page': str(page), 'pageSize': str(page_size), 'tab': tab, 'business_type': '4',
              'from_mng': '1', 'not_for_sale_search_type': '1',
              'need_auto_rectify_info': 'true', 'need_pay_no_stock_skus': 'false',
              'order_field': order_field, 'sort': 'desc', 'appid': '1', '_bid': 'ffa_goods'}
    if tab == 'onSale':
        params.update({'draft_status': '0', 'is_online': '1', 'check_status': '3', 'status': '0'})
    elif tab == 'offline':
        params.update({'is_online': '', 'is_offline': '1', 'offline_type': '', 'supply_status': ''})
    else:  # all
        params.update({'is_online': '1'})
    if extra:
        params.update(extra)
    return _get(s, '/product/tproduct/list', params, referer=BASE + '/ffa/g/list')


def _count_by_day(s, tab, order_field, days=8):
    """按 publish_time / offline_time 统计每日数量，翻页直到超出窗口。"""
    from collections import Counter
    from datetime import datetime as _dt, timedelta as _td
    cutoff = (_dt.now() - _td(days=days)).timestamp()
    byday, seen, page = Counter(), 0, 0
    while page < 25:
        j = _product_list(s, tab, order_field, page)
        data = j.get('data') or []
        if not isinstance(data, list) or not data:
            break
        oldest = None
        for it in data:
            ts = it.get(order_field) or 0
            if ts:
                byday[_dt.fromtimestamp(ts).strftime('%Y-%m-%d')] += 1
                if oldest is None or ts < oldest:
                    oldest = ts
            seen += 1
        total = j.get('total') or 0
        if (oldest is not None and oldest < cutoff) or seen >= total:
            break
        page += 1
    return byday


def fetch_product_flow(s, days=8):
    from datetime import date, timedelta
    today = date.today()
    out = {}
    # 各口径总数
    for tab, key in (('all', 'product_total'), ('onSale', 'product_onsale_cnt'),
                     ('offline', 'product_offline_total')):
        j = _product_list(s, tab, 'offline_time' if tab == 'offline' else 'publish_time', 0, page_size=1)
        if isinstance(j.get('total'), int):
            out[key] = j['total']
    # 每日上架 / 下架
    if 'product_total' not in out:
        raise ValueError('商品列表接口结构变化')
    listed = _count_by_day(s, 'all', 'publish_time', days)
    off = _count_by_day(s, 'offline', 'offline_time', days)
    out['listed_today'] = listed.get(today.isoformat(), 0)
    out['offline_today'] = off.get(today.isoformat(), 0)
    out['listed_7d'] = sum(listed.get((today - timedelta(days=i)).isoformat(), 0) for i in range(7))
    out['offline_7d'] = sum(off.get((today - timedelta(days=i)).isoformat(), 0) for i in range(7))
    out['listed_daily_7d'] = ','.join(
        f'{(today - timedelta(days=i)).isoformat()}:{listed.get((today - timedelta(days=i)).isoformat(), 0)}'
        for i in range(6, -1, -1))
    out['offline_daily_7d'] = ','.join(
        f'{(today - timedelta(days=i)).isoformat()}:{off.get((today - timedelta(days=i)).isoformat(), 0)}'
        for i in range(6, -1, -1))
    return out


# ---------------- 罗盘：总访客数 + 渠道销量 ----------------
# 渠道卡片维度：operate_type(自营 self_employed / 合作 bring_goods)
#              × content_type(live/video/product_card/artc_video/other_content)
CHANNEL_SALES = {
    'sales_live': ('self_employed#live', 'bring_goods#live'),
    'sales_video': ('self_employed#video', 'bring_goods#video'),
    'sales_product_card': ('self_employed#product_card', 'bring_goods#product_card'),
    'sales_artc_video': ('self_employed#artc_video', 'bring_goods#artc_video'),
}


def fetch_compass_trade(s, day=None):
    """罗盘交易：总访客数 + 各渠道销量（成交订单量，自营+合作）。

    罗盘单日口径 date_type=1 实为"当日实时"（截至采集时刻），与首页实时口径一致。
    """
    from datetime import date
    d = (day or date.today()).strftime('%Y/%m/%d')
    rng = f'{d} 00:00:00'
    base = {'date_type': '1', 'begin_date': rng, 'end_date': rng,
            'activity_id': '', 'is_activity': 'false'}

    # 总访客数（罗盘"商品曝光人数"，即店铺访客数口径）
    b = _compass_get(s, '/compass_api/shop/common/trade/core_index_v3',
                     dict(base, index_selected='product_show_ucnt,pay_cnt,pay_amt'))
    card = _card_map(b, 'homepage_core_index')
    out = {
        'visit_uv': _index_value(card, 'product_show_ucnt'),
        'compass_pay_cnt': _index_value(card, 'pay_cnt'),
        'compass_pay_amt': _index_value(card, 'pay_amt'),
    }

    # 渠道销量（成交订单量 pay_cnt，自营 + 合作 合并）
    p = _compass_get(s, '/compass_api/shop/common/trade/pie_chart_v3',
                     dict(base, index_name='pay_cnt',
                          first_dim='operate_type', second_dim='content_type'))
    pcard = _card_map(p, 'trade_core_index_pie_and_bar')
    for field, keys in CHANNEL_SALES.items():
        vals = [_index_value(pcard, k + '#pay_cnt') for k in keys]
        vals = [v for v in vals if v is not None]
        out[field] = sum(vals) if vals else None
    out['sales_talent'] = _index_value(pcard, 'bring_goods#total')   # 达人带货（合作口径）
    return out


# ---------------- 千川（巨量千川）：推广消耗 / ROI / 成交 -------------
# 千川走独立域名，但抖店 cookie 可直接调；statQuery 无需 a_bogus。
QC_BASE = 'https://qianchuan.jinritemai.com'
QC_METRICS = ['stat_cost', 'prepay_and_pay_order_roi', 'pay_order_count',
              'pay_order_amount', 'ecp_cpa_platform']


def _qc_json(session, path, params=None, body=None, method='GET'):
    url = QC_BASE + path
    if method == 'GET':
        r = session.get(url, params=params or {}, timeout=(5, 25), allow_redirects=False)
    else:
        r = session.post(url, params=params or {}, json=body, timeout=(5, 25), allow_redirects=False)
    if r.status_code != 200:
        raise ValueError('千川 HTTP %s' % r.status_code)
    try:
        j = r.json()
    except ValueError:
        raise ValueError('千川返回非 JSON')
    login_check(j)
    if j.get('status_code') not in (0, None):
        raise ValueError('千川拒绝请求 %s' % str(j.get('message') or '')[:40])
    return j


def _qc_num(node):
    """千川指标值：用展示值 ValueStr（元/个/比例），'-' 视为无数据。"""
    if not isinstance(node, dict):
        return None
    s = node.get('ValueStr')
    if s is not None:
        t = str(s).strip()
        if t in ('', '-', '--', 'None'):
            return None
        t = t.replace(',', '').rstrip('%')
        m = NUM_RE.match(t)
        if m:
            return float(m.group(1)) * {'万': 10000, '亿': 100000000}.get(m.group(2), 1)
    v = node.get('Value')
    return None if v in (None, -9999) else v


def _qc_stat(session, dataset, req_from, aavid, start, end, metrics):
    body = {'StartTime': start, 'EndTime': end, 'DataSetKey': dataset,
            'Metrics': metrics, 'Dimensions': []}
    if aavid:
        body['Filters'] = {'ConditionRelationshipType': 1, 'Conditions': [
            {'Field': 'advertiser_id', 'Operator': 7, 'Values': [aavid]}]}
    params = {'reqFrom': req_from}
    if aavid:
        params['aavid'] = aavid
    j = _qc_json(session, '/ad/api/data/v1/common/statQuery', params, body, 'POST')
    return ((j.get('data') or {}).get('StatsData') or {}).get('Totals') or {}


def fetch_qianchuan(s, day=None):
    """千川推广数据（非推算）：推广成本/ROI/净成交量/订单成本。

    - 标准投放 `home_cost_common_prom`：消耗/直接支付ROI/直接成交订单数/转化成本/成交金额
    - 全域投放 `home_stat_cost_overall_prom`：同上
    - 账户整体消耗 `overall_home_cost_total_prom`
    口径：当日实时（00:00 至采集时刻）。
    """
    from datetime import datetime
    from zoneinfo import ZoneInfo
    now = datetime.now(ZoneInfo('Asia/Shanghai'))
    d = day or now.date()
    start = '%s 00:00:00' % d.strftime('%Y-%m-%d')
    end = (now.strftime('%Y-%m-%d %H:%M:%S') if d == now.date()
           else '%s 23:59:59' % d.strftime('%Y-%m-%d'))

    acc = _qc_json(s, '/ad/api/v1/account/shop/get-account-list', {})
    lst = ((acc.get('data') or {}).get('accountInfoList') or [])
    aavid = str(lst[0]['id']) if lst and lst[0].get('id') else None

    if not aavid:
        # 未绑定千川账户：推广指标全部为空
        return {k: None for k in (
            'promo_cost', 'promo_cost_total', 'promo_cost_uni', 'promo_roi',
            'promo_net_orders', 'promo_order_cost', 'promo_pay_amt', 'promo_order_ratio',
            'promo_uni_roi', 'promo_uni_orders', 'promo_uni_order_cost', 'promo_uni_pay_amt')}

    std = _qc_stat(s, 'home_cost_common_prom', 'content_common_data', aavid, start, end, QC_METRICS)
    uni = _qc_stat(s, 'home_stat_cost_overall_prom', 'content_overall_data', aavid, start, end, QC_METRICS)
    total = _qc_stat(s, 'overall_home_cost_total_prom', 'data-summary-overall',
                     aavid, start, end, ['stat_cost'])

    orders = _qc_num(std.get('pay_order_count'))
    # 推广订单占比 = 标准投放成交订单数 ÷ 全店成交订单数（罗盘 pay_cnt）
    try:
        rng = '%s 00:00:00' % d.strftime('%Y/%m/%d')
        cb = _compass_get(s, '/compass_api/shop/common/trade/core_index_v3',
                          {'date_type': '1', 'begin_date': rng, 'end_date': rng,
                           'activity_id': '', 'is_activity': 'false', 'index_selected': 'pay_cnt'})
        shop_orders = _index_value(_card_map(cb, 'homepage_core_index'), 'pay_cnt')
    except ValueError:
        shop_orders = None
    ratio = round(orders / shop_orders * 100, 2) if (orders is not None and shop_orders) else None

    return {
        'promo_cost': _qc_num(std.get('stat_cost')),
        'promo_cost_total': _qc_num(total.get('stat_cost')),
        'promo_cost_uni': _qc_num(uni.get('stat_cost')),
        'promo_roi': _qc_num(std.get('prepay_and_pay_order_roi')),
        'promo_net_orders': orders,
        'promo_order_cost': _qc_num(std.get('ecp_cpa_platform')),
        'promo_pay_amt': _qc_num(std.get('pay_order_amount')),
        'promo_order_ratio': ratio,
        'promo_uni_roi': _qc_num(uni.get('prepay_and_pay_order_roi')),
        'promo_uni_orders': _qc_num(uni.get('pay_order_count')),
        'promo_uni_order_cost': _qc_num(uni.get('ecp_cpa_platform')),
        'promo_uni_pay_amt': _qc_num(uni.get('pay_order_amount')),
    }
