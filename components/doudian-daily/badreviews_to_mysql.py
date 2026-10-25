#!/usr/bin/env python3
"""每日新增差评 → 聚水潭紫旗同款落库 → 写入 MySQL，供腾讯文档智能表格「同步数据」拉取。

流程：抖店评价接口（评价时间=昨日，差评）→ INSERT IGNORE INTO smartsheet.appeal_details
去重：订单号唯一索引（uk_order），重复自动跳过。
调度：launchd com.lee.badreviews-mysql（每天 09:15）
"""
import datetime
import json
import os
import sys
import time

import pymysql

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import cookies as C  # noqa: E402
import doudian as dd  # noqa: E402

DB = dict(host=os.environ.get('SHOPDESK_MYSQL_HOST', '127.0.0.1'),
          port=int(os.environ.get('SHOPDESK_MYSQL_PORT', '3306')),
          user=os.environ.get('SHOPDESK_MYSQL_USER', 'smartsheet'),
          password=os.environ.get('SHOPDESK_MYSQL_PASSWORD', ''),
          database=os.environ.get('SHOPDESK_MYSQL_DATABASE', 'smartsheet'),
          charset='utf8mb4')


def pull_yesterday_bad_reviews(day):
    """拉取 day 当天新增的差评（全部抖店店铺）。返回 list[dict]。"""
    d0 = day
    start = time.mktime((d0.year, d0.month, d0.day, 0, 0, 0, 0, 0, -1))
    end = start + 86399
    shops = C.collect()
    out = []
    for i, sh in enumerate(shops, 1):
        try:
            s = dd.make_session(sh['cookies'], sh.get('ua') or C.UA)
            REF = dd.BASE + '/ffa/g/comment/goods-comment-list'
            page = 1
            while page <= 40:
                b = dd._get(s, '/product/tcomment/commentList',
                            {'page': page, 'pageSize': 50}, referer=REF)
                rows = b.get('data') or []
                if not rows:
                    break
                stop = False
                for r in rows:
                    ct = r.get('comment_time') or 0
                    if ct < start:
                        stop = True
                        continue
                    if ct > end:
                        continue
                    info = (r.get('tags') or {}).get('rank_info') or {}
                    if info.get('name') in ('差评', '中评'):
                        out.append({
                            'shop': sh['name'],
                            'order_id': str(r.get('order_id') or ''),
                            'content': ((r.get('orig_content') or r.get('content') or '')
                                        .replace('\n', ' ').replace('\t', ' '))[:500],
                            'product': ((r.get('product') or {}).get('name') or '')[:255],
                            'ct': ct,
                            'level': info.get('name'),
                        })
                if stop or len(rows) < 50:
                    break
                page += 1
            s.close()
        except Exception as e:
            print(f'  ⚠️ {sh["name"]}: {type(e).__name__} {str(e)[:60]}', file=sys.stderr, flush=True)
        time.sleep(0.3)
    return out


def insert_rows(rows, d0):
    if not DB['password']:
        raise RuntimeError('请配置 SHOPDESK_MYSQL_PASSWORD')
    conn = pymysql.connect(**DB)
    n = 0
    try:
        cur = conn.cursor()
        base = int(time.time())
        for i, x in enumerate(rows):
            # 每行同步时间错开 1 秒：整批同一时间戳会被同步主键去重只剩 1 行
            sync_ts = datetime.datetime.fromtimestamp(base + i)
            ts = datetime.datetime.fromtimestamp(x['ct'])
            cur.execute(
                'INSERT IGNORE INTO appeal_details '
                '(`提交方式`, `提交时间`, `类型`, `同步时间`, `店铺`, `订单号`, `原因/评价内容`, `标签`, `说明`, `商品名`, `日期`, `状态`) '
                'VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                ('AI提交', None, '中差评', sync_ts.strftime('%Y-%m-%d %H:%M:%S'),
                 x['shop'], x['order_id'], x['content'], x.get('level') or '差评', '', x['product'],
                 ts.strftime('%Y-%m-%d'), '未处理'))
            n += cur.rowcount
        conn.commit()
    finally:
        conn.close()
    return n


def main():
    day = datetime.date.today() - datetime.timedelta(days=1)
    for a in sys.argv[1:]:
        if a.startswith('--date='):
            day = datetime.date.fromisoformat(a.split('=')[1])
    print(f'[{datetime.datetime.now():%F %T}] 抓取 {day} 新增差评…', flush=True)
    rows = pull_yesterday_bad_reviews(day)
    print(f'  抓到 {len(rows)} 条差评', flush=True)
    if rows:
        n = insert_rows(rows, day)
        print(f'  新写入 MySQL {n} 条（重复跳过 {len(rows) - n}）', flush=True)
    else:
        print('  无新增差评', flush=True)
    print(f'[{datetime.datetime.now():%F %T}] 完成', flush=True)


if __name__ == '__main__':
    main()
