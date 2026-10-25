#!/usr/bin/env python3
"""抖店待开票信息（只读）：给消费者开票(待开票/待红冲) + 我给平台开票(待开票账单)。

接口全部在 fxg.jinritemai.com，纯 cookie 直连，无需 a_bogus / msToken 签名。
cookie 来源复用 cookies.py（读「店铺工作台」分区，或外部 cookie JSON）。

用法：
    python3 invoice.py --list                 # 所有店铺的待开票概览
    python3 invoice.py --shop "香朵儿官方旗舰店"   # 单店详情
    python3 invoice.py --shop "香朵儿官方旗舰店" --json   # 结构化 JSON
    python3 invoice.py --cookie-file ck.json --shop XXX  # 用外部 cookie 跑

接口清单：
    GET /api/ecomfinance/subject/list                开票主体(多主体，含待开票标志)
    GET /order/invoice/list?invoice_status_desc=wait_blue   给消费者开票-待开票
    GET /order/invoice/list?invoice_status_desc=wait_red    给消费者开票-待红冲
    GET /api/ecomfinance/uninvoicebill/getPage              我给平台开票-待开票账单
    GET /api/ecomfinance/invoicerecord/statuscount          平台开票状态计数(参考)
"""
import argparse, json, os, sys, time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cookies import list_shops, read_cookies, UA, collect as collect_cookies

BASE = 'https://fxg.jinritemai.com'
REF = BASE + '/ffa/m-invoice/merchant-invoice'

# 给消费者开票的状态筛选值
CONSUMER_STATUS = {
    'wait_blue': '待开票',
    'wait_red': '待红冲',
    'already': '已开票',
    'canceled': '已取消',
    'all': '全部',
}

# 我给平台开票的场景代码 -> 中文名
PLATFORM_SCENE = {
    'PLATFORM_COUPON_YZJ': '平台补贴',
    'DOUYIN_PAY_COUPON': '抖音支付补贴',
    'DOUYIN_MONTH_PAY_COUPON': '抖音月付营销补贴',
    'DOU_INSTALLMENT_COUPON_ZT': '抖音月付营销补贴',
    'PLATFORM_SERVICE_FEE': '平台服务费',
    'DOUYIN_AD_COUPON': '广告补贴',
}


def make_session(cookies):
    s = requests.Session()
    s.trust_env = False
    for c in cookies:
        s.cookies.set(c['name'], c['value'], domain=c['domain'],
                      path=c.get('path', '/'), secure=c.get('secure', True))
    s.headers.update({
        'User-Agent': UA,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': REF,
    })
    return s


def _get(s, path, params=None):
    r = s.get(BASE + path, params=params or {}, timeout=(5, 25), allow_redirects=False)
    if r.status_code != 200:
        raise ValueError('平台 HTTP %s (%s)' % (r.status_code, path))
    try:
        return r.json()
    except ValueError:
        raise ValueError('平台返回非 JSON (%s)' % path)


def login_ok(j):
    """粗判登录是否有效。"""
    if not isinstance(j, dict):
        return False
    msg = str(j.get('msg') or j.get('message') or j.get('ret_message') or '')
    if any(k in msg for k in ('登录已失效', '请重新登录', '未登录', '安全验证')):
        return False
    return True


# ---------------- 开票主体 ----------------
def fetch_subjects(s):
    """开票主体列表，含每个主体的待开票标志。"""
    j = _get(s, '/api/ecomfinance/subject/list')
    if not login_ok(j):
        raise ValueError('LOGIN_REQUIRED')
    subs = ((j.get('ret_data') or {}).get('subject_list') or [])
    return [{
        'credit_code': x.get('CreditCode'),
        'company_name': x.get('CompanyName'),
        'has_pending_merchant': bool(x.get('HasPendingMerchantInvoiceBill')),
        'has_pending_platform': bool(x.get('HasPendingPlatformInvoiceBill')),
    } for x in subs]


# ---------------- 给消费者开票 ----------------
def _time_window(days_back=730):
    """开票申请时间窗口（宽一点，覆盖 365 天可申请期）。"""
    tz = ZoneInfo('Asia/Shanghai')
    end = datetime.now(tz) + timedelta(days=7)
    start = datetime.now(tz) - timedelta(days=days_back)
    return int(start.timestamp()), int(end.timestamp())


def fetch_consumer_invoices(s, status='wait_blue', page_size=100):
    """给消费者开票列表（店铺级接口，无需 credit_code）。status: wait_blue/wait_red/already/canceled/all。"""
    start, end = _time_window()
    out, page, total = [], 0, None
    while page < 50:
        j = _get(s, '/order/invoice/list', {
            'page': str(page), 'pageSize': str(page_size),
            'create_time_start': str(start), 'create_time_end': str(end),
            'invoice_status_desc': status,
            'appid': '1', '_bid': 'ffa_order', 'aid': '4272',
        })
        if not login_ok(j):
            raise ValueError('LOGIN_REQUIRED')
        if j.get('code') not in (0, None):
            raise ValueError('接口拒绝 %s' % str(j.get('msg') or '')[:60])
        total = j.get('total')
        data = j.get('data') or []
        for it in data:
            out.append(_parse_consumer(it, status))
        if total is None or len(out) >= total or not data:
            break
        page += 1
    return out, total or len(out)


def _parse_consumer(it, status):
    info = it.get('latest_invoice_time_info') or {}
    st = it.get('invoice_status_info') or {}
    return {
        'shop_order_id': it.get('shop_order_id'),
        'registation_id': it.get('registation_id'),
        'title': it.get('title'),
        'tax_no': it.get('tax_no'),
        'invoice_type': it.get('invoice_type_text'),
        'invoice_amount': it.get('invoice_amount'),
        'apply_time': it.get('apply_time'),
        'order_status': it.get('order_status_text'),
        'invoice_status': st.get('invoice_status_text') or CONSUMER_STATUS.get(status, status),
        'deadline_time': info.get('deadline_time'),
        'deadline_text': info.get('description_text'),
        'sub_order_no': it.get('sub_order_no') or None,
    }


# ---------------- 我给平台开票 ----------------
def fetch_platform_bills(s, credit_code, page_size=50):
    """我给平台开票-待开票账单。bill_amount 单位是分。"""
    j = _get(s, '/api/ecomfinance/uninvoicebill/getPage', {
        'InvoiceVersion': 'v1', 'credit_code': credit_code,
        'is_asc': 'true', 'page_number': '1', 'page_size': str(page_size),
    })
    if not login_ok(j):
        raise ValueError('LOGIN_REQUIRED')
    if j.get('ret_code') not in ('0000', None):
        raise ValueError('接口拒绝 %s' % str(j.get('ret_message') or '')[:60])
    bills = j.get('invoice_bills') or []
    out = []
    for b in bills:
        corp = b.get('CorporationInfo') or {}
        amt = b.get('bill_amount') or '0'
        try:
            amount_yuan = round(int(amt) / 100, 2)
        except (TypeError, ValueError):
            amount_yuan = None
        scene = b.get('scene') or ''
        out.append({
            'credit_code': credit_code,
            'bill_id': b.get('id'),
            'scene': scene,
            'scene_text': PLATFORM_SCENE.get(scene, scene),
            'bill_amount_yuan': amount_yuan,
            'bill_amount_raw': amt,
            'order_count': b.get('order_count'),
            'bill_period': '%s ~ %s' % (b.get('bill_date_begin') or '', b.get('bill_date_end') or ''),
            'create_time': b.get('create_time'),
            'corp_title': corp.get('Title'),
            'corp_tax_no': corp.get('TaxCode'),
            'is_frozen': bool(b.get('IsFrozen')),
            'pay_status': b.get('PayStatus'),
            'unpay_amount': b.get('UnpayAmount'),
        })
    return out


# ---------------- 汇总 ----------------
def fetch_shop_pending(shop):
    """单个店铺的全部待开票。"""
    s = make_session(shop['cookies'])
    subjects = fetch_subjects(s)
    consumer_pending, consumer_red, platform_bills = [], [], []
    # 给消费者开票：店铺级接口，整店只拉一次
    consumer_pending, _ = fetch_consumer_invoices(s, 'wait_blue')
    consumer_red, _ = fetch_consumer_invoices(s, 'wait_red')
    # 我给平台开票：按开票主体（credit_code）分别拉
    for sub in subjects:
        cc = sub['credit_code']
        if not cc:
            continue
        if sub['has_pending_platform']:
            try:
                platform_bills.extend(fetch_platform_bills(s, cc))
            except ValueError as e:
                if str(e).startswith('LOGIN_REQUIRED'):
                    raise
    return {
        'shop_id': shop['id'],
        'shop_name': shop['name'],
        'subjects': subjects,
        'consumer_pending': consumer_pending,   # 给消费者开票-待开票
        'consumer_red': consumer_red,           # 给消费者开票-待红冲
        'platform_bills': platform_bills,       # 我给平台开票-待开票账单
    }


def _fmt_money(rows, key='invoice_amount'):
    return sum(float(str(r.get(key) or '0').replace('￥', '').replace('¥', '').replace(',', '').strip() or 0)
               for r in rows)


def main():
    ap = argparse.ArgumentParser(description='抖店待开票信息')
    ap.add_argument('--shop', help='只查某店铺（按名称子串/精确）')
    ap.add_argument('--list', action='store_true', help='列出所有店铺 + 待开票概览')
    ap.add_argument('--json', action='store_true', help='输出 JSON')
    ap.add_argument('--cookie-file', help='外部 cookie JSON 文件（按店铺名匹配）')
    args = ap.parse_args()

    shops = collect_cookies(platform='抖店', cookie_file=args.cookie_file)
    if args.shop:
        shops = [x for x in shops if args.shop in x['name'] or x['name'] in args.shop]
    if not shops:
        print('没有匹配的店铺（未登录或名字不匹配）', file=sys.stderr)
        sys.exit(1)

    results = []
    for sh in shops:
        try:
            r = fetch_shop_pending(sh)
        except ValueError as e:
            r = {'shop_id': sh['id'], 'shop_name': sh['name'], 'error': str(e),
                 'subjects': [], 'consumer_pending': [], 'consumer_red': [], 'platform_bills': []}
        results.append(r)

    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=1))
        return

    # 文本概览
    for r in results:
        print('=' * 70)
        print('店铺：%s' % r['shop_name'])
        if r.get('error'):
            print('  ⚠️ %s' % r['error'])
            continue
        cp, cr, pb = r['consumer_pending'], r['consumer_red'], r['platform_bills']
        print('  给消费者开票：待开票 %d 张 / 待红冲 %d 张' % (len(cp), len(cr)))
        if cp:
            print('    [待开票] 合计 ￥%.2f' % _fmt_money(cp))
            for x in cp:
                print('      %s | %s | %s | %s | 最晚 %s' % (
                    x['shop_order_id'], x['title'], x['tax_no'],
                    x['invoice_amount'], x['deadline_text'] or x['deadline_time'] or '-'))
        if cr:
            for x in cr:
                print('      [待红冲] %s | %s | %s' % (x['shop_order_id'], x['title'], x['invoice_amount']))
        print('  我给平台开票：待开票账单 %d 个' % len(pb))
        if pb:
            total = sum(x['bill_amount_yuan'] or 0 for x in pb)
            print('    [账单] 合计 ￥%.2f' % total)
            for x in pb:
                print('      %s | %s | ￥%.2f | %s单 | %s' % (
                    x['bill_period'], x['scene_text'], x['bill_amount_yuan'],
                    x['order_count'], x['corp_title']))


if __name__ == '__main__':
    main()
