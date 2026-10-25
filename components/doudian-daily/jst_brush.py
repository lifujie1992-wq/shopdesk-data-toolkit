#!/usr/bin/env python3
"""聚水潭「刷单」订单计数（紫色旗帜 seller_flag=5）
==================================================
数据源：聚水潭 salesTheme 订单明细接口（api.erp321.com/jst-data-report/getData/transportData），
会话与 ~/.local/bin/jst-orders（jushuitan-order-details）同一份 keychain 凭据：
    security find-generic-password -a erp321.com -s com.xx-cli.jst-orders.cookie.<name> -w

口径：
    · 紫色旗帜 = 刷单（ERP 旗帜筛选：1红 2黄 3绿 4蓝 5紫 6橙 7天蓝 8粉）
    · 按下单日期（order_date）= 统计日期
    · 含全部订单状态（未付款/已关闭的刷单单也计入）
    · 组合商品拆分=是（与 ERP 默认一致）
    · 接口实时，无 T-1 延迟

对外：
    fetch_brush_data(stat_date)
        -> {'purple': {聚水潭店铺名: 紫旗单数}, 'total_purple': int,
            'universe': [当天有订单的聚水潭店铺名], 'universe_complete': bool}
    match_count(抖店店铺名, data) -> (数量|None, [匹配到的聚水潭店铺名])
"""
import datetime
import json
import os
import subprocess
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SHOP_MAP_JSON = os.path.join(HERE, 'jst_shop_map.json')

API_ROOT = 'https://api.erp321.com/jst-data-report/getData/transportData'
TABLE_CODE = 'sales_theme_analysis_order_by_order_table'
KEYCHAIN_ACCOUNT = 'erp321.com'
KEYCHAIN_PREFIXES = ['com.xx-cli.jst-orders', 'com.xx-cli.jst-inventory']
COOKIE_NAMES = ['u_sso_token', 'u_id', 'u_co_id']
FLAG_BRUSH = 5            # 紫色旗帜
PAGE_SIZE = 5000
MAX_PAGES_PURPLE = 40     # 紫旗单一般数百条，1-2 页
MAX_PAGES_UNIVERSE = 14   # 当日全量明细翻页上限（4-5万单 ≈ 9 页）


class JstSessionError(Exception):
    pass


def _keychain(service):
    r = subprocess.run(['/usr/bin/security', 'find-generic-password',
                        '-a', KEYCHAIN_ACCOUNT, '-s', service, '-w'],
                       capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else None


def load_session():
    """读 keychain 里的聚水潭会话 cookie（与 jst-orders CLI 共用）。"""
    for prefix in KEYCHAIN_PREFIXES:
        cookies = {n: _keychain(f'{prefix}.cookie.{n}') for n in COOKIE_NAMES}
        if all(cookies.values()):
            return cookies
    raise JstSessionError(
        '本机没有聚水潭会话凭据（先在 jst CLI 里执行过 auth import）；刷单字段将置空')


def _call(cookies, page_num, start_date, end_date, flag=None, timeout=60):
    api_params = {
        'dateType': 'order_date',       # 按下单日期统计
        'skuType': 0, 'iIdType': 0, 'skuLabelsFilterType': 1,
        'isSplit': 1,                   # 组合商品拆分=是（与 ERP 默认一致）
        'isEntity': 0, 'costType': 0,
        'isExcludeUnfinishedOrders': 0,  # 未完结也计（刷单单常未发货/已关闭）
        'orderStatus': [],              # 全部状态
        'orderLabelsType': 1, 'orderLabels': [],
        'sellerFlagType': 0,
        'sellerFlags': ([flag] if flag is not None else []),  # ★ 旗帜过滤：5=紫色
        'orderType': 1, 'orderTypes': [],
        'nodeType': None, 'buyerMessageType': None, 'remarkType': None,
        'startDate': f'{start_date} 00:00:00',
        'endDate': f'{end_date} 23:59:59',
        'oIds': [], 'states': [], 'cities': [], 'districts': [], 'addressFlag': 0,
        'sortMap': {'o_id': 'DESC'},
        'pageSize': PAGE_SIZE, 'pageNum': page_num,
    }
    body = {'coid': '', 'uid': '', 'data': {
        'apiCode': 'sales_theme_order_list', 'apiParams': api_params,
        'customColumnTableCode': TABLE_CODE, 'bizDomain': 'salesTheme',
        'pageCode': 'SALES_THEME_ORDER', 'sysEnv': 'ERP'}}
    req = urllib.request.Request(
        f'{API_ROOT}?apiCode=sales_theme_order_list',
        data=json.dumps(body).encode(),
        headers={
            'accept': 'application/json, text/plain, */*',
            'content-type': 'application/json',
            'cookie': '; '.join(f'{k}={v}' for k, v in cookies.items()),
            'origin': 'https://src.erp321.com',
            'referer': 'https://src.erp321.com/erp-data/salesThemeAnalysis/order/home',
            'pageparam': json.dumps(
                {'bizDomain': 'salesTheme', 'pageCode': 'SALES_THEME_ORDER', 'dataRole': 1},
                separators=(',', ':')),
            'u_co_id': cookies['u_co_id'], 'u_id': cookies['u_id'],
        }, method='POST')
    with urllib.request.urlopen(req, timeout=timeout) as r:
        payload = json.loads(r.read().decode('utf-8'))
    msg = payload.get('msg')
    if payload.get('code') == -1 and msg == '未登录':
        raise JstSessionError('聚水潭会话已过期，请重新执行 jst-inventory auth import')
    if payload.get('code') != 0 or payload.get('success') is not True:
        raise JstSessionError('聚水潭接口异常: ' + str(msg)[:120])
    return payload


def _paginate(cookies, start_date, end_date, flag=None, max_pages=40):
    """翻页拉某天的订单行（flag=None 为全量），返回 (行迭代器, 总数, 是否拉全)。"""
    fetched, total, page = 0, None, 1
    while page <= max_pages:
        payload = _call(cookies, page, start_date, end_date, flag)
        rows = payload.get('data') or []
        total = payload.get('total')
        fetched += len(rows)
        yield rows, total, fetched
        if not rows or not isinstance(total, int) or fetched >= total:
            return
        page += 1


def fetch_brush_data(stat_date, flag=FLAG_BRUSH, with_universe=True):
    """统计 stat_date 当天（下单日期）紫色旗帜订单数，按聚水潭店铺名分组。

    返回 dict：
        purple          {聚水潭店铺原始名: 紫旗单数}
        total_purple    当日紫旗订单总数
        universe        [当天有订单的聚水潭店铺名]（用于区分 0 和未匹配）
        universe_complete  universe 是否扫描完整
    """
    cookies = load_session()

    purple, total_purple = {}, 0
    for rows, _total, _fetched in _paginate(cookies, stat_date, stat_date, flag, MAX_PAGES_PURPLE):
        for r in rows:
            name = r.get('shop_name') or '(未知店铺)'
            purple[name] = purple.get(name, 0) + 1
        total_purple = _total or total_purple
        if not rows:
            break

    universe, universe_complete = [], True
    if with_universe:
        seen = set(purple)
        complete = False
        for rows, _total, fetched in _paginate(cookies, stat_date, stat_date, None, MAX_PAGES_UNIVERSE):
            for r in rows:
                name = r.get('shop_name')
                if name and name not in seen:
                    seen.add(name)
                    universe.append(name)
            if not rows or (isinstance(_total, int) and fetched >= _total):
                complete = True
                break
        if complete:
            universe_complete = True
        else:
            universe_complete = False
    return {'purple': purple, 'total_purple': total_purple,
            'universe': universe, 'universe_complete': universe_complete}


def compact(s):
    return ''.join(ch for ch in str(s or '') if ch.isalnum())


_SHOP_SUFFIX_WORDS = ['旗舰店', '专卖店', '专营店', '服饰店', '服装店', '女装店', '男装店',
                      '童装店', '鞋店', '百货店', '工厂店', '折扣店', '企业店', '优选店',
                      '服饰', '服装', '女装', '男装', '童装', '鞋类', '百货', '铺子',
                      '官方', '直营', '自营', '国际', '海外', '企业']


def _stem(name):
    """去掉店铺类型后缀，留品牌主干：兹伊翰官方旗舰店 → 兹伊翰。"""
    s = compact(name)
    changed = True
    while changed and s:
        changed = False
        for w in _SHOP_SUFFIX_WORDS:
            if s.endswith(w) and len(s) > len(w):
                s = s[:-len(w)]
                changed = True
    return s


def _manual_map():
    """jst_shop_map.json: {"抖店店铺名": ["聚水潭店铺名子串", ...]}（可选，人工兜底）。"""
    try:
        d = json.load(open(SHOP_MAP_JSON, encoding='utf-8'))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def fetch_brush_orders_window(end_date, days=14, flag=FLAG_BRUSH):
    """近 days 天（按下单日期，含 end_date 当天）的紫旗订单号，按聚水潭店铺分组。

    返回 (dict{聚水潭店铺原始名: set(线上订单号)}, 紫旗订单总数)。
    用于和抖店评价列表的 order_id 做关联。
    """
    cookies = load_session()
    d0 = datetime.date.fromisoformat(end_date)
    start = (d0 - datetime.timedelta(days=days - 1)).isoformat()
    orders, total = {}, 0
    for rows, _total, _fetched in _paginate(cookies, start, end_date, flag, MAX_PAGES_PURPLE * 4):
        for r in rows:
            name = r.get('shop_name') or '(未知店铺)'
            so = str(r.get('so_id') or '')
            if so:
                orders.setdefault(name, set()).add(so)
        total = _total if isinstance(_total, int) else total
        if not rows or (isinstance(_total, int) and sum(len(v) for v in orders.values()) >= _total):
            break
    return orders, total


def match_names(douyin_name, universe_names):
    """返回抖店店铺名匹配到的聚水潭店铺名列表（匹配策略同 match_count）。"""
    universe = list(universe_names or [])
    dn = str(douyin_name or '')
    dc = compact(dn)
    if not dc:
        return []
    for pat in _manual_map().get(dn, []):
        pc = compact(pat)
        hits = [n for n in universe if pc and pc in compact(n)]
        if hits:
            return hits
    hits = [n for n in universe
            if len(compact(n)) > 3 and (compact(n).find(dc) >= 0 or dc.find(compact(n)) >= 0)]
    if hits:
        return hits
    ds = _stem(dn)
    if len(ds) >= 2:
        hits = [n for n in universe if _stem(n) == ds]
        if not hits:
            hits = [n for n in universe if len(_stem(n)) > len(ds) and _stem(n).find(ds) >= 0]
        if hits:
            return hits
    return []


def match_count(douyin_name, data):
    """把聚水潭紫旗计数匹配到抖店店铺名。返回 (数量|None, [用到的聚水潭店铺名])。"""
    purple = data.get('purple') or {}
    universe = list(data.get('universe') or []) + list(purple.keys())
    names = match_names(douyin_name, universe)
    if not names:
        return None, []
    return sum(purple.get(n, 0) for n in names), names


if __name__ == '__main__':
    import sys
    d = sys.argv[1] if len(sys.argv) > 1 else __import__('datetime').date.today().isoformat()
    data = fetch_brush_data(d)
    print(f"{d} 紫旗订单总数: {data['total_purple']}，"
          f"聚水潭有单店铺 {len(data['universe']) + len(set(data['purple']) - set(data['universe']))} 家"
          f"（universe完整={data['universe_complete']}）:")
    for n, c in sorted(data['purple'].items(), key=lambda kv: -kv[1]):
        print(f'  {c:5d}  {n}')
