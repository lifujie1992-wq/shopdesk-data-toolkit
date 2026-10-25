"""接口探测：确认哪些抖店后台接口可由 Python 直连（仅带 cookie）获取。"""
import json, sys, time
from concurrent.futures import ThreadPoolExecutor

BASE = 'https://fxg.jinritemai.com'
REF = BASE + '/ffa/mshop/homepage/index'

# (标签, method, path, params, json_body)
TESTS = [
    ('经营首页',        'GET', '/pc/api/home/homepage', {'meet_redirect_grey': 'true', 'source': '1', 'homepage_version': '202606240', 'appid': '1', '_bid': 'ffa_shop'}, None),
    ('体验分总览',      'GET', '/governance/shop/experiencescore/getOverviewByVersion', {'exp_version': 'release', 'new_shop_version': 'release', 'source': '1'}, None),
    ('体验分明细',      'GET', '/governance/shop/experiencescore/getAnalysisScore', {'exp_version': 'release', 'new_shop_version': 'release', 'number_type': '30 '}, None),
    ('体验分趋势',      'GET', '/governance/shop/experiencescore/getTrendByVersion', {'exp_version': 'release', 'new_shop_version': 'release', 'number_type': '30 ', 'source': '1'}, None),
    ('评价统计',        'GET', '/product/tcomment/statistics', {}, None),
    ('评价列表',        'GET', '/product/tcomment/commentList', {'page': '1', 'page_size': '20'}, None),
    ('评价标签聚合',    'GET', '/product/tcomment/allCommentTagAggStat', {}, None),
    ('商品数',          'GET', '/product/tproduct/aggsProductCount', {'tab': 'onSale'}, None),
    ('商品列表',        'GET', '/product/tproduct/list', {'page': '1', 'page_size': '20', 'tab': 'onSale', 'check_status': '3'}, None),
    ('订单计数',        'GET', '/api/order/tabcnt', {'appid': '1', '_bid': 'ffa_order'}, None),
    ('订单列表',        'POST', '/api/order/searchlist', {'appid': '1', '_bid': 'ffa_order'}, {'page': 0, 'page_size': 10, 'order_by': 'create_time', 'order_asc': False}),
    ('库存列表',        'GET', '/stock/manage/list', {'page': '1', 'page_size': '20'}, None),
    ('仓库列表',        'GET', '/stock/index/warehouse_list', {}, None),
    ('售后列表',        'POST', '/after_sale/pc/list', {'appid': '1', '_bid': 'ffa_aftersale', 'aid': '4272', 'aftersale_platform_source': 'fxg'}, {'pageSize': 10, 'page': 1, 'conf_version': 'v13', 'after_sale_status': '', 'after_sale_type': 'refund', 'reason': '', 'negotiate_status': '', 'order_flag': [], 'order_logistics_state': []}),
    ('物流列表',        'GET', '/shopuser/power/logisticslist', {'page': '1', 'page_size': '20'}, None),
    ('包裹列表',        'GET', '/shopuser/power/getPackageList', {'page': '1', 'page_size': '20'}, None),
    ('焦点异常包裹',    'GET', '/shopuser/power/getFocusExceptionInfo', {}, None),
    ('异常包裹聚合',    'GET', '/shopuser/power/getExceptionPackageAggr', {}, None),
    ('罗盘核心指标',    'GET', '/compass_api/shop/common/homepage/core_index_v3', {}, None),
    ('罗盘概览',        'GET', '/compass_api/shop/common/flow/overview', {}, None),
]


def build_session(cookies, ua):
    import requests
    s = requests.Session()
    s.trust_env = False
    for c in cookies:
        s.cookies.set(c['name'], c['value'], domain=c['domain'],
                      path=c.get('path', '/'), secure=c.get('secure', True))
    s.headers.update({'User-Agent': ua or '', 'Accept': 'application/json, text/plain, */*',
                      'Referer': REF, 'Accept-Language': 'zh-CN,zh;q=0.9'})
    return s


def probe_one(session, item):
    label, method, path, params, body = item
    t0 = time.perf_counter()
    try:
        if method == 'GET':
            r = session.get(BASE + path, params=params, timeout=(5, 12), allow_redirects=False)
        else:
            r = session.post(BASE + path, params=params, json=body, timeout=(5, 12), allow_redirects=False)
        http = r.status_code
        note = ''
        ok = False
        if http == 200:
            try:
                j = r.json()
                st = j.get('st'); code = j.get('code'); msg = str(j.get('msg') or '')[:40]
                ok = (st in (0, None)) and (code in (0, None))
                note = f'st={st} code={code} {msg} len={len(r.text)}'
            except ValueError:
                note = f'非JSON len={len(r.text)}'
        else:
            note = r.text[:60].replace('\n', ' ')
        return {'api': label, 'http': http, 'ok': '✅' if ok else '❌', 'note': note,
                '_path': path, '_sec': round(time.perf_counter() - t0, 2)}
    except Exception as e:
        return {'api': label, 'http': '-', 'ok': '❌',
                'note': type(e).__name__ + ': ' + str(e)[:50], '_path': path, '_sec': None}


def main(request):
    shops = request['shops']
    out = []
    for shop in shops:
        s = build_session(shop['cookies'], shop.get('ua', ''))
        with ThreadPoolExecutor(max_workers=6) as pool:
            rows = list(pool.map(lambda it: probe_one(s, it), TESTS))
        s.close()
        for r in rows:
            out.append({'shop_id': shop['id'], 'name': shop['name'], 'status': 'ok',
                        'api': f"{r['api']} [{r['_path']}]", 'http': r['http'],
                        'ok': r['ok'], 'note': f"{r['note']} {r['_sec']}s"})
    return {'captured_at': None, 'shop_count': len(shops), 'success': len(shops), 'results': out}
