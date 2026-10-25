"""抖店后台只读接口封装：抓取 + 解析。仅使用调用方提供的会话 cookie。"""
import json, re, time
import requests

BASE = 'https://fxg.jinritemai.com'
REF = BASE + '/ffa/mshop/homepage/index'
EXP_ROOT = BASE + '/governance/shop/experiencescore/'
AFTER_SALE = BASE + '/after_sale/pc/list'

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
