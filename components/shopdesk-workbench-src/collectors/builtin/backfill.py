"""补跑商品名/商品编码（只读）。

用已有订单号去平台接口做「算法匹配」，把缺的 product_name / product_id 补回来：
- 品退：走售后详情接口（after_sale_id 精确命中，返回商品名+编码）
- 中差评：先批量拉评价列表匹配（拿编码）；拿不到商品名的再用举报预检接口按单查（拿商品名+编码）
不提交任何举报、不写订单隐私。
"""
import json, time, requests
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from zoneinfo import ZoneInfo

from douyin import check_platform_login
from quality import _pick_product, _session, _ymd

BASE = 'https://fxg.jinritemai.com'
AFTER_SALE_DETAIL_API = BASE + '/v1/aftersale/pc/detail'
AFTER_SALE_REFERER = BASE + '/ffa/merchant-aftersale-workbench/aftersale/list'
COMMENT_API = BASE + '/product/tcomment/commentList'
COMMENT_REFERER = BASE + '/ffa/maftersale/comment'
ACCUSE_COMMENT_API = BASE + '/shopuser/accuse/comment_list'
ACCUSE_REFERER = BASE + '/ffa/govern-report/report-create'

# 举报预检接口需要 scene/sub，仅用于读商品信息；沿用已实测的"异常评价"场景与一个常用原因
ACCUSE_SCENE = 'report_type_unusual_comment'
ACCUSE_SUB = 'report_reason_fake_negative_comment'


def _accuse_product(s, order_id):
    """按订单号走举报预检接口，读取该评价对应的商品名/编码（不提交）。"""
    try:
        r = s.post(ACCUSE_COMMENT_API, json={
            'size': 3, 'page': 1,
            'scene_type': ACCUSE_SCENE, 'sub_scene_type': ACCUSE_SUB,
            'accuse_id': None, 'sku_order_id': str(order_id),
        }, timeout=(5, 20), allow_redirects=False)
        if r.status_code != 200:
            return None
        payload = r.json()
        if payload.get('code') != 0 or payload.get('st', 0) != 0:
            return None
        comments = ((payload.get('data') or {}).get('comments')) or []
        if not comments:
            return None
        c = comments[0]
        name, pid = _pick_product(c)
        # 兜底：接口顶层若直接给了 product_name / product_id 也读
        if not name:
            name = str(c.get('product_name') or '')
        if not pid:
            pid = str(c.get('product_id') or '') if c.get('product_id') else ''
        return {'product_name': (name or '').strip(), 'product_id': pid}
    except Exception:
        return None


def _review_list_products(s, targets, max_pages=80, page_size=50):
    """批量拉评价列表，按 order_id 匹配商品名/编码。返回 {order_id: {product_name, product_id}}。"""
    matched = {}
    remaining = set(targets)
    for rank in (1, 2):
        if not remaining:
            break
        for page in range(0, max_pages):
            if not remaining:
                break
            try:
                r = s.get(COMMENT_API, params={'rank': rank, 'page': page, 'pageSize': page_size,
                                               'status_filter': 0, 'content_search': 0, 'reply_search': 0,
                                               'appeal_search': 0, 'bad_comment_class_tag_key': '',
                                               'count_ecology_score_filter': 0, 'random': 0.5,
                                               'appid': 1}, timeout=(5, 25), allow_redirects=False)
                if r.status_code != 200:
                    break
                payload = r.json(); check_platform_login(payload)
                if payload.get('code') != 0 or payload.get('st', 0) != 0:
                    break
                rows = payload.get('data') or []
                if not isinstance(rows, list) or not rows:
                    break
                for c in rows:
                    oid = str(c.get('order_id') or c.get('shop_order_id') or '')
                    if oid in remaining:
                        name, pid = _pick_product(c)
                        matched[oid] = {'product_name': name or '', 'product_id': pid or ''}
                        remaining.discard(oid)
                if len(rows) < page_size:
                    break
            except Exception:
                break
    return matched


def backfill_products(item, targets):
    """targets: {'quality': {order_id: after_sale_id}, 'review': [order_id, ...]}"""
    started = time.perf_counter()
    matched = {}; missing = []
    q_targets = targets.get('quality') or {}
    r_targets = list(targets.get('review') or [])

    # ① 品退：售后详情精确匹配
    if q_targets:
        cookies = [dict(c) for c in item['cookies']]; ua = item['ua']
        def q_work(pair):
            oid, asid = pair
            ds = _session({'cookies': [dict(c) for c in cookies], 'ua': ua}, AFTER_SALE_REFERER)
            try:
                r = ds.get(AFTER_SALE_DETAIL_API, params={
                    'appid': '1', '_bid': 'ffa_aftersale', 'aid': '4272',
                    'aftersale_platform_source': 'fxg', 'after_sale_id': asid,
                    'extra': json.dumps({'detail_upgrade_hit': 'new'}, separators=(',', ':'))},
                    timeout=(5, 25), allow_redirects=False)
                if r.status_code != 200:
                    return oid, None
                payload = r.json(); check_platform_login(payload)
                if payload.get('code') != 0 or payload.get('st', 0) != 0:
                    return oid, None
                name, pid = _pick_product(payload)
                return oid, {'product_name': name or '', 'product_id': pid or ''}
            except Exception:
                return oid, None
            finally:
                ds.cookies.clear(); ds.close()
        with ThreadPoolExecutor(max_workers=5) as pool:
            for oid, info in pool.map(q_work, list(q_targets.items())):
                if info:
                    matched[oid] = info
                else:
                    missing.append(oid)

    # ② 中差评：批量匹配评价列表（商品名在 product.name，编码在 product_id）
    if r_targets:
        s = _session(item, COMMENT_REFERER)
        try:
            bulk = _review_list_products(s, set(r_targets))
            for oid, info in bulk.items():
                matched[oid] = info
            for oid in r_targets:
                if oid not in matched:
                    missing.append(oid)
        finally:
            s.cookies.clear(); s.close()

    return {'shop_id': item['id'], 'name': item['name'], 'status': 'ok',
            'matched': matched, 'matched_count': len(matched), 'missing': missing,
            'http_seconds': round(time.perf_counter() - started, 3),
            'captured_at': datetime.now(ZoneInfo('Asia/Shanghai')).isoformat()}
