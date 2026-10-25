"""店铺经营指标采集：一次抓取抖店后台多个只读接口并汇总成一行指标。"""
import json, os, sys, time, sqlite3
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from zoneinfo import ZoneInfo

import doudian as dd

TZ = ZoneInfo('Asia/Shanghai')


def now_iso():
    return datetime.now(TZ).isoformat()


def progress(done, total):
    try:
        print(json.dumps({'event': 'progress', 'completed': done, 'total': total}),
              file=sys.stderr, flush=True)
    except Exception:
        pass


def collect_shop(shop):
    t0 = time.perf_counter()
    s = dd.make_session(shop['cookies'], shop.get('ua', ''))
    row = {'shop_id': shop['id'], 'name': shop['name'], 'status': 'ok'}
    steps_status = {}
    failed = []
    try:
        steps = [
            ('home', dd.fetch_home),
            ('experience', dd.fetch_experience),
            ('comments', dd.fetch_comments),
            ('orders', dd.fetch_tabcnt),
            ('products', dd.fetch_products),
            ('aftersale', dd.fetch_aftersale),
            ('logistics', dd.fetch_logistics),
            ('stock', dd.fetch_stock),
            ('product_flow', dd.fetch_product_flow),
        ]
        for key, fn in steps:
            st = time.perf_counter()
            try:
                res = fn(s)
                if isinstance(res, tuple):
                    data, extra = res
                    row.update(data)
                    if isinstance(extra, dict):
                        row.update(extra)
                else:
                    row.update(res)
                steps_status[key] = {'ok': True, 'ms': round(time.perf_counter() - st, 2)}
            except ValueError as e:
                msg = str(e)
                if msg.startswith(('LOGIN_REQUIRED', 'VERIFICATION_REQUIRED')):
                    raise
                steps_status[key] = {'ok': False, 'error': msg,
                                     'ms': round(time.perf_counter() - st, 2)}
                failed.append(f'{key}: {msg}')
            except Exception as e:
                steps_status[key] = {'ok': False, 'error': type(e).__name__,
                                     'ms': round(time.perf_counter() - st, 2)}
                failed.append(f'{key}: {type(e).__name__}')
        row['captured_at'] = now_iso()
        row['http_seconds'] = round(time.perf_counter() - t0, 2)
        row['step_status'] = json.dumps(steps_status, ensure_ascii=False)
        done = sum(1 for v in steps_status.values() if v['ok'])
        row['steps_ok'] = f'{done}/{len(steps_status)}'
        if failed:
            row['notes'] = '; '.join(failed)[:400]
        return row
    except Exception as e:
        return {'shop_id': shop['id'], 'name': shop['name'], 'status': 'error',
                'error': str(e) if type(e) is ValueError else '请求或解析失败',
                'http_seconds': round(time.perf_counter() - t0, 2)}
    finally:
        try:
            s.close()
        except Exception:
            pass
        shop['cookies'].clear()


def main(request):
    if request.get('action') != 'metrics':
        raise ValueError('不支持的操作')
    shops = request.get('shops') or []
    if not isinstance(shops, list):
        raise ValueError('无效的采集请求')
    data_dir = request.get('dataDir') or '.'
    total = len(shops)
    results, done = [], 0
    with ThreadPoolExecutor(max_workers=3) as pool:
        futs = {pool.submit(collect_shop, sh): sh for sh in shops}
        for f in as_completed(futs):
            results.append(f.result())
            done += 1
            progress(done, total)
    results.sort(key=lambda r: r.get('name') or '')
    run = now_iso()
    os.makedirs(data_dir, mode=0o700, exist_ok=True)
    db_path = os.path.join(data_dir, 'business.sqlite3')
    with sqlite3.connect(db_path, timeout=15) as db:
        os.chmod(db_path, 0o600)
        db.execute('CREATE TABLE IF NOT EXISTS metrics_snapshots (run TEXT, shop_id TEXT, data TEXT, PRIMARY KEY(run,shop_id))')
        for r in results:
            db.execute('INSERT OR REPLACE INTO metrics_snapshots VALUES (?,?,?)',
                       (run, r['shop_id'], json.dumps(r, ensure_ascii=False)))
    return {'captured_at': run, 'shop_count': total,
            'success': sum(1 for r in results if r.get('status') == 'ok'),
            'results': results}
