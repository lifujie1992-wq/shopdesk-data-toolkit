#!/usr/bin/env python3
"""
抖店每日指标采集器 v3 —— 完全独立，不依赖工作台进程
=====================================================
Cookie 来源：直接读「店铺工作台」会话分区里的 cookie（明文 SQLite）。
工作台的唯一职责是"扫码登录"；本脚本只读磁盘文件，不需要工作台在运行。

用法:
    python3 daily_collect.py                          # 采集 + 写 SQLite + 导出 JSON
    python3 daily_collect.py --list                   # 只列店铺 + 登录态 + cookie 数
    python3 daily_collect.py --report                 # 采集并只打印质量报告
    python3 daily_collect.py --webhook URL            # 额外 POST 到你的接口
    python3 daily_collect.py --dsn "mysql://..."      # 额外写 MySQL/Postgres
    python3 daily_collect.py --only "黑色草莓bingbing"
    python3 daily_collect.py --cookie-file ck.json    # 从外部 cookie 文件（可在别的机器跑）
    python3 daily_collect.py --from-file a.json       # 离线重跑（不联网）
    python3 daily_collect.py --dump-cookies out.json  # 导出 cookie 供其它工具使用

输出:
    data/shop_metrics.sqlite3   宽表 shop_metrics_daily + 元数据表 shop_metrics_meta
    data/<日期>.json            当日结果 + 字段元数据（已脱敏）
"""
import argparse, inspect, json, os, re, sqlite3, sys, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, date
from zoneinfo import ZoneInfo

import cookies as C
import doudian as dd
import jst_brush

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, 'data')
CONTRACT = os.path.join(HERE, 'metrics_contract.json')
TZ = ZoneInfo('Asia/Shanghai')

SKIP_FIELDS = {'shop_id', 'name', 'status', 'error', 'notes', 'http_seconds',
               'platform_shop_id', 'shop_name', 'exp_update_time', 'step_status'}
META_FIELDS = {'captured_at', 'steps_ok', 'step_status', 'notes'}

SECRET_KEY = re.compile(r'^(cookie|authorization|password|.*token.*|.*csrf.*|msToken|a_bogus|'
                        r'verifyFp|fp|_lid|sessionid|sid_guard|sid_tt|uid_tt|s_web_id|'
                        r's_v_web_id|member_id|user_id|account_id|credit_code)$', re.I)

# 采集步骤（顺序即执行顺序）
STEPS = [
    ('home', dd.fetch_home),
    ('compass_trade', dd.fetch_compass_trade),
    ('qianchuan', dd.fetch_qianchuan),
    ('experience', dd.fetch_experience),
    ('comments', dd.fetch_comments),
    ('brush_reviews', dd.fetch_brush_reviews),
    ('orders', dd.fetch_tabcnt),
    ('products', dd.fetch_products),
    ('aftersale', dd.fetch_aftersale),
    ('logistics', dd.fetch_logistics),
    ('stock', dd.fetch_stock),
    ('product_flow', dd.fetch_product_flow),
]


def now_iso():
    return datetime.now(TZ).isoformat()


def die(msg, code=1):
    print(f'❌ {msg}', file=sys.stderr)
    sys.exit(code)


# ---------------- 采集 ----------------
def collect_shop(shop):
    t0 = time.perf_counter()
    s = dd.make_session(shop['cookies'], shop.get('ua') or C.UA)
    row = {'shop_id': shop['id'], 'name': shop['name'], 'status': 'ok'}
    steps, failed = {}, []
    try:
        for key, fn in STEPS:
            st = time.perf_counter()
            try:
                # 仅当函数第二个形参名为 shop 时才传店铺上下文；
                # 其余 (s, days=N)/(s, day=None) 形式的可选参数必须用默认值，
                # 否则 shop 字典会被当成 days/day 标量（10-07 重构引入的回归）。
                sig_params = list(inspect.signature(fn).parameters.values())
                if len(sig_params) >= 2 and sig_params[1].name == 'shop':
                    res = fn(s, shop)
                else:
                    res = fn(s)
                if isinstance(res, tuple):
                    data, extra = res
                    row.update(data)
                    if isinstance(extra, dict):
                        row.update(extra)
                else:
                    row.update(res)
                steps[key] = {'ok': True, 'ms': round(time.perf_counter() - st, 2)}
            except ValueError as e:
                msg = str(e)
                if msg.startswith(('LOGIN_REQUIRED', 'VERIFICATION_REQUIRED')):
                    raise
                steps[key] = {'ok': False, 'error': msg, 'ms': round(time.perf_counter() - st, 2)}
                failed.append(f'{key}: {msg}')
            except Exception as e:
                steps[key] = {'ok': False, 'error': type(e).__name__,
                              'ms': round(time.perf_counter() - st, 2)}
                failed.append(f'{key}: {type(e).__name__}')
        row['captured_at'] = now_iso()
        row['http_seconds'] = round(time.perf_counter() - t0, 2)
        row['step_status'] = json.dumps(steps, ensure_ascii=False)
        row['steps_ok'] = f"{sum(1 for v in steps.values() if v['ok'])}/{len(steps)}"
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


def collect_all(shops, concurrency=3):
    rows, done = [], 0
    total = len(shops)
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futs = {pool.submit(collect_shop, sh): sh for sh in shops}
        for f in as_completed(futs):
            rows.append(f.result())
            done += 1
            print(f'  · {done}/{total}')
    rows.sort(key=lambda r: r.get('name') or '')
    return rows


# ---------------- 聚水潭刷单字段 ----------------
def enrich_brush_orders(rows, stat_date):
    """给每行加 brush_orders：聚水潭紫色旗帜(seller_flag=5)=刷单，
    按下单日期=统计日期统计，含全部订单状态。失败时置 NULL 并在 notes 里说明。"""
    try:
        data = jst_brush.fetch_brush_data(stat_date)
    except jst_brush.JstSessionError as e:
        for r in rows:
            r['brush_orders'] = None
        print(f'   ⚠️ 刷单字段跳过: {e}')
        return rows
    except Exception as e:
        for r in rows:
            r['brush_orders'] = None
        print(f'   ⚠️ 刷单字段跳过: {type(e).__name__}: {str(e)[:80]}')
        return rows
    shops_n = len(set(data['universe']) | set(data['purple']))
    print(f"   刷单标记: {stat_date} 聚水潭紫旗订单 {data['total_purple']} 个（有单店铺 {shops_n} 家）")
    # 聚水潭当天一张单都没有：全部店铺刷单数记 0（而不是“未匹配”）
    zero_day = (data['total_purple'] == 0 and not data['purple']
                and data.get('universe_complete') and not data.get('universe'))
    used_all, matched = set(), 0
    for r in rows:
        if zero_day:
            cnt, used = 0, []
        else:
            cnt, used = jst_brush.match_count(r.get('name') or r.get('shop_name'), data)
        used_all.update(used or [])
        r['brush_orders'] = cnt
        if cnt is None:
            r['notes'] = ((r.get('notes') or '') + '; ' if r.get('notes') else '') + \
                         'jst_brush: 未匹配聚水潭店铺'
        else:
            matched += 1
    print(f'   刷单字段: 匹配 {matched}/{len(rows)} 家店铺')
    rest = {n: c for n, c in data['purple'].items() if n not in used_all and c > 0}
    if rest:
        print('   ⚠️ 聚水潭有紫旗单但未匹配到抖店店铺（可在 jst_shop_map.json 配映射）:')
        for n, c in sorted(rest.items(), key=lambda kv: -kv[1]):
            print(f'      {c:4d}  {n}')
    return rows


# ---------------- 契约 / 脱敏 ----------------
def redact(value):
    if isinstance(value, list):
        return [redact(v) for v in value]
    if isinstance(value, dict):
        return {k: ('[REDACTED]' if SECRET_KEY.match(str(k)) else redact(v))
                for k, v in value.items()}
    return value


def load_contract():
    if not os.path.exists(CONTRACT):
        return {}
    return json.load(open(CONTRACT, encoding='utf-8')).get('fields') or {}


def field_status(key, value, contract):
    meta = contract.get(key)
    if not meta:
        return 'unmapped', None, None, None, None
    status = meta['status']
    if value is None or value == '-' or value == '':
        status, value = 'source_no_data', None
    return status, meta.get('period'), meta.get('source'), meta.get('path'), meta.get('note') or ''


def normalize(rows, stat_date, contract):
    wide, meta_rows = [], []
    for r in rows:
        if r.get('status') != 'ok':
            continue
        rec = {'stat_date': stat_date, 'shop_id': r['shop_id'], 'shop_name': r.get('name'),
               'captured_at': r.get('captured_at'), 'steps_ok': r.get('steps_ok'),
               'notes': r.get('notes')}
        for k, v in r.items():
            if k in SKIP_FIELDS or k in META_FIELDS:
                continue
            status, period, source, path, note = field_status(k, v, contract)
            if status == 'source_no_data':
                v = None
            rec[k] = v
            meta_rows.append({
                'stat_date': stat_date, 'shop_id': r['shop_id'], 'shop_name': r.get('name'),
                'metric_key': k, 'metric_label': (contract.get(k) or {}).get('label', k),
                'status': status, 'has_value': 0 if v is None else 1,
                'period': period, 'source': source, 'response_path': path, 'note': note,
                'raw_value': None if v is None else str(v)[:200]})
        try:
            steps = json.loads(r.get('step_status') or '{}')
        except ValueError:
            steps = {}
        for step, info in steps.items():
            meta_rows.append({
                'stat_date': stat_date, 'shop_id': r['shop_id'], 'shop_name': r.get('name'),
                'metric_key': f'__step__{step}', 'metric_label': f'采集步骤 {step}',
                'status': 'exact' if info.get('ok') else 'failed', 'has_value': 1,
                'period': '本次', 'source': '-', 'response_path': '-',
                'note': info.get('error') or f"{info.get('ms')}s", 'raw_value': None})
        wide.append(rec)
    return wide, meta_rows


# ---------------- 落盘 ----------------
def ensure_table(db, name, cols, pk, types=None):
    types = types or {}
    defs = ', '.join(f'"{c}" {types.get(c, "REAL")}' for c in cols)
    db.execute(f'CREATE TABLE IF NOT EXISTS {name} ({defs}, PRIMARY KEY({pk}))')
    existing = {r[1] for r in db.execute(f'PRAGMA table_info({name})')}
    for c in cols:
        if c not in existing:
            db.execute(f'ALTER TABLE {name} ADD COLUMN "{c}" {types.get(c, "REAL")}')


def upsert_sqlite(wide, meta_rows, path=None, extra_cols=None):
    os.makedirs(DATA, mode=0o700, exist_ok=True)
    path = path or os.path.join(DATA, 'shop_metrics.sqlite3')
    os.makedirs(os.path.dirname(os.path.abspath(path)), mode=0o700, exist_ok=True)
    db = sqlite3.connect(path, timeout=20)
    try:
        os.chmod(path, 0o600)
        cols = ['stat_date', 'shop_id', 'shop_name', 'captured_at', 'steps_ok', 'notes']
        # 先把契约里的全部字段建好列，避免某步失败导致列缺失、同步报 schema missing
        for c in (extra_cols or []):
            if c not in cols and c != 'step_status':
                cols.append(c)
        for r in wide:
            for k in r:
                if k not in cols:
                    cols.append(k)
        t = {c: 'TEXT' for c in cols}
        ensure_table(db, 'shop_metrics_daily', cols, 'stat_date, shop_id', t)
        ph = ','.join('?' * len(cols))
        # 同一天重跑时：某步采集失败（字段为 NULL）不覆盖已有的好值；元信息用新值
        TAKE_NEW = ('shop_name', 'captured_at', 'steps_ok', 'notes')
        updates = ','.join(
            f'"{c}"=excluded."{c}"' if c in TAKE_NEW else f'"{c}"=COALESCE(excluded."{c}", "{c}")'
            for c in cols if c not in ('stat_date', 'shop_id'))
        sql = (f'INSERT INTO shop_metrics_daily ({",".join(chr(34)+c+chr(34) for c in cols)}) '
               f'VALUES ({ph}) ON CONFLICT(stat_date, shop_id) DO UPDATE SET ' + updates)
        for r in wide:
            db.execute(sql, [r.get(c) for c in cols])

        mcols = ['stat_date', 'shop_id', 'shop_name', 'metric_key', 'metric_label', 'status',
                 'has_value', 'period', 'source', 'response_path', 'note', 'raw_value']
        mt = {c: 'TEXT' for c in mcols}
        mt['has_value'] = 'INTEGER'
        ensure_table(db, 'shop_metrics_meta', mcols, 'stat_date, shop_id, metric_key', mt)
        mph = ','.join('?' * len(mcols))
        msql = (f'INSERT INTO shop_metrics_meta ({",".join(chr(34)+c+chr(34) for c in mcols)}) '
                f'VALUES ({mph}) ON CONFLICT(stat_date, shop_id, metric_key) DO UPDATE SET '
                + ','.join(f'"{c}"=excluded."{c}"' for c in mcols
                           if c not in ('stat_date', 'shop_id', 'metric_key')))
        for m in meta_rows:
            db.execute(msql, [m.get(c) for c in mcols])
        db.commit()
    finally:
        db.close()
    return path


def post_webhook(url, payload, token=None, timeout=30):
    data = json.dumps(payload, ensure_ascii=False).encode()
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    req = urllib.request.Request(url, data=data, headers=headers, method='POST')
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read(200).decode('utf-8', 'replace')


def write_dsn(dsn, records):
    if not records:
        return 0
    if dsn.startswith(('mysql', 'mariadb')):
        import pymysql
        from urllib.parse import urlparse, unquote
        u = urlparse(dsn)
        conn = pymysql.connect(host=u.hostname, port=u.port or 3306, user=unquote(u.username or ''),
                               password=unquote(u.password or ''), database=(u.path or '/')[1:],
                               charset='utf8mb4')
    elif dsn.startswith(('postgres', 'postgresql')):
        import psycopg2
        conn = psycopg2.connect(dsn)
    else:
        die('不支持的 DSN（仅 mysql:// 或 postgresql://）')
    cols = list(records[0].keys())
    cur = conn.cursor()
    cur.execute('CREATE TABLE IF NOT EXISTS shop_metrics_daily ('
                + ', '.join(f'"{c}" TEXT' for c in cols) + ', PRIMARY KEY (stat_date, shop_id))')
    ph = ','.join(['%s'] * len(cols))
    q = ','.join(f'"{c}"' for c in cols)
    upd = ','.join(f'"{c}"=VALUES("{c}")' for c in cols if c not in ('stat_date', 'shop_id'))
    for r in records:
        cur.execute(f'INSERT INTO shop_metrics_daily ({q}) VALUES ({ph}) '
                    f'ON DUPLICATE KEY UPDATE {upd}', [r.get(c) for c in cols])
    conn.commit()
    n = cur.rowcount
    cur.close()
    conn.close()
    return n


# ---------------- 质量报告 ----------------
def quality_report(wide, meta_rows, total_shops=None):
    from collections import Counter
    print('\n④ 数据质量报告')
    status = Counter(m['status'] for m in meta_rows if not m['metric_key'].startswith('__step__'))
    total = sum(status.values()) or 1
    print('   字段状态：' + '  '.join(f'{k}={v}({v*100//total}%)' for k, v in status.most_common()))
    for r in wide:
        print(f"   采集完整性 {r.get('shop_name')}: {r.get('steps_ok')}"
              f"  步骤失败: {r.get('notes') or '无'}")
    seen = set()
    cand = [m for m in meta_rows if m['status'] == 'candidate_not_exact'
            and not (m['metric_key'] in seen or seen.add(m['metric_key']))]
    if cand:
        print('   ⚠️ 口径待确认字段：')
        for m in cand:
            print(f"      {m['metric_label']}: {m['note']}")
    nod = sorted({m['metric_label'] for m in meta_rows
                  if m['status'] == 'source_no_data' and not m['metric_key'].startswith('__step__')})
    if nod:
        print(f'   ⚪ 平台无数据（已置 NULL）：{"、".join(nod[:12])}{"…" if len(nod) > 12 else ""}')
    der = sorted({m['metric_label'] for m in meta_rows if m['status'] == 'derived'})
    if der:
        print(f'   🧮 推算字段：{"、".join(der)}')


def backfill_brush_orders(sqlite_path, stat_date, days=2):
    """回填前几日的完整刷单数。

    聚水潭 salesTheme 数据每天上午 ~9:00 刷新、只含到前一日，
    所以当天查 stat_date 恒为 0；这里在每次采集后把前 N 天（数据已就绪）的
    紫旗计数写回：已有行 UPDATE，历史断档缺行的补插一条仅含刷单数的补充行。
    """
    from datetime import timedelta
    d0 = date.fromisoformat(stat_date)
    db = sqlite3.connect(sqlite_path, timeout=20)
    try:
        for i in range(1, days + 1):
            d = (d0 - timedelta(days=i)).isoformat()
            try:
                data = jst_brush.fetch_brush_data(d)
            except Exception as e:
                print(f'   ⚠️ 刷单回填 {d}: {str(e)[:80]}')
                continue
            rows = dict(db.execute('SELECT shop_id, shop_name FROM shop_metrics_daily '
                                   'WHERE stat_date=?', (d,)).fetchall())
            # 目标店铺清单：优先用最新一天的全量清单（历史断档的日子也能补齐）
            latest = db.execute('SELECT shop_id, shop_name FROM shop_metrics_daily '
                                'WHERE stat_date=(SELECT MAX(stat_date) FROM shop_metrics_daily)').fetchall()
            shops = latest or list(rows.items())
            if not shops:
                print(f'   刷单回填 {d}: 本地表无店铺清单，跳过')
                continue
            # 数据未刷新（全天无单但连店铺基线都没有）时不盲写 0
            if data['total_purple'] == 0 and not data['purple'] and not data['universe']:
                print(f'   ⚠️ 刷单回填 {d}: 聚水潭数据可能未刷新，跳过')
                continue
            n = 0
            for shop_id, shop_name in shops:
                cnt, _used = jst_brush.match_count(shop_name, data)
                if cnt is None:
                    continue
                if shop_id in rows:
                    db.execute('UPDATE shop_metrics_daily SET brush_orders=? '
                               'WHERE stat_date=? AND shop_id=?',
                               (str(cnt), d, shop_id))
                else:
                    # 该日缺行的店铺：补插一条仅含刷单数的补充行
                    db.execute('INSERT INTO shop_metrics_daily (stat_date, shop_id, shop_name, brush_orders) '
                               'VALUES (?,?,?,?) ON CONFLICT(stat_date, shop_id) '
                               'DO UPDATE SET brush_orders=excluded.brush_orders',
                               (d, shop_id, shop_name, str(cnt)))
                db.execute('INSERT INTO shop_metrics_meta (stat_date, shop_id, shop_name, metric_key, '
                           'metric_label, status, has_value, period, source, response_path, note, raw_value) '
                           'VALUES (?,?,?,?,?,?,?,?,?,?,?,?) '
                           'ON CONFLICT(stat_date, shop_id, metric_key) DO UPDATE SET '
                           'status="exact", has_value=1, raw_value=excluded.raw_value, '
                           'note=COALESCE(note,"") || "（次日回填）"',
                           (d, shop_id, shop_name, 'brush_orders', '刷单订单数', 'exact', 1,
                            '当日（下单日期，截至采集时刻）',
                            '聚水潭 salesTheme 订单接口 apiParams.sellerFlags=[5]', '-',
                            '次日回填', str(cnt)))
                n += 1
            db.commit()
            print(f'   刷单回填 {d}: 紫旗 {data["total_purple"]}，更新 {n} 行')
    finally:
        db.close()


def finish(args, wide, meta_rows, captured_at, stat_date):
    if args.report:
        return
    if not wide:
        die('没有成功采集的数据，未写库')
    print('\n③ 落盘')
    os.makedirs(DATA, mode=0o700, exist_ok=True)
    payload = redact({'stat_date': stat_date, 'captured_at': captured_at,
                      'records': wide, 'field_meta': meta_rows})
    jf = getattr(args, 'json', None) or os.path.join(DATA, f'{stat_date}.json')
    with open(jf, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    os.chmod(jf, 0o600)
    print(f'   已导出 {jf}（已脱敏）')
    if not args.no_sqlite:
        p = upsert_sqlite(wide, meta_rows, getattr(args, 'sqlite', None),
                          list(load_contract().keys()))
        print(f'   已写入 SQLite: {p}')
        print(f'     · shop_metrics_daily  {len(wide)} 行')
        print(f'     · shop_metrics_meta   {len(meta_rows)} 行')
        if not args.no_brush:
            backfill_days = int(getattr(args, 'brush_backfill_days', 2) or 0)
            if backfill_days > 0:
                backfill_brush_orders(p, stat_date, backfill_days)
    if args.webhook:
        try:
            code, body = post_webhook(args.webhook,
                                      redact({'stat_date': stat_date, 'records': wide}),
                                      args.webhook_token)
            print(f'   已上传 webhook: HTTP {code} {body[:80]}')
        except Exception as e:
            print(f'   ⚠️ webhook 上传失败: {e}', file=sys.stderr)
    if args.dsn:
        try:
            print(f'   已写入数据库: 影响 {write_dsn(args.dsn, wide)} 行')
        except ImportError as e:
            print(f'   ⚠️ 缺少数据库驱动: {e}', file=sys.stderr)
        except Exception as e:
            print(f'   ⚠️ 写库失败: {e}', file=sys.stderr)
    print('✅ 完成')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--webhook'), ap.add_argument('--webhook-token')
    ap.add_argument('--dsn')
    ap.add_argument('--only', action='append')
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--report', action='store_true')
    ap.add_argument('--date')
    ap.add_argument('--sqlite', default=None, help='SQLite 输出路径（默认 data/shop_metrics.sqlite3）')
    ap.add_argument('--json', default=None, help='JSON 输出路径（默认 data/<date>.json）')
    ap.add_argument('--no-sqlite', action='store_true')
    ap.add_argument('--no-brush', action='store_true',
                    help='跳过聚水潭刷单字段（brush_orders）')
    ap.add_argument('--brush-backfill-days', type=int, default=2,
                    help='回填前几日的完整刷单数（默认 2，0 关闭）')
    ap.add_argument('--brush-window-days', type=int, default=14,
                    help='刷单评价关联的紫旗订单回看天数（默认 14）')
    ap.add_argument('--from-file', help='离线重跑：从已保存结果读取')
    ap.add_argument('--cookie-file', help='从外部 cookie JSON 读取（不读工作台分区）')
    ap.add_argument('--appdata', default=C.APPDATA, help='工作台数据目录')
    ap.add_argument('--concurrency', type=int, default=3)
    ap.add_argument('--dump-cookies', help='把读到的 cookie 导出为 JSON')
    args = ap.parse_args()

    stat_date = args.date or date.today().isoformat()
    contract = load_contract()
    if contract:
        print(f'   字段契约：{len(contract)} 个字段（metrics_contract.json）')

    # ① 取 cookie
    print('① 读取登录态…')
    try:
        shops = C.collect(appdata=args.appdata, cookie_file=args.cookie_file, only=args.only)
    except C.CookieSourceError as e:
        die(str(e))
    if args.dump_cookies:
        with open(args.dump_cookies, 'w', encoding='utf-8') as f:
            json.dump({s['name']: s['cookies'] for s in shops}, f, ensure_ascii=False, indent=1)
        os.chmod(args.dump_cookies, 0o600)
        print(f'   已导出 cookie → {args.dump_cookies}（敏感，注意保管）')

    if args.list:
        for s in shops:
            has = any(c['name'] in ('sessionid', 'sid_guard', 'sid_tt') for c in s['cookies'])
            print(f"   {'✅' if has else '❌'} {s['name']:22s} {s['platform']:6s} cookie={s['cookie_count']}")
        return

    # ② 离线模式
    if args.from_file:
        print('② 离线模式：从文件读取结果…')
        raw = json.load(open(os.path.expanduser(args.from_file), encoding='utf-8'))
        if 'records' in raw:
            rows = raw['records']
            for r in rows:
                r.setdefault('status', 'ok')
                r.setdefault('shop_id', r.get('shop_id') or r.get('shop_name'))
                r.setdefault('name', r.get('shop_name'))
            captured_at = raw.get('captured_at')
        else:
            job = raw.get('shopmetrics:metrics') or {}
            rows = (job.get('result') or {}).get('results') or []
            captured_at = (job.get('result') or {}).get('captured_at')
        ok = [r for r in rows if r.get('status') == 'ok']
        print(f'   读到 {len(rows)} 条，成功 {len(ok)}')
        wide, meta_rows = normalize(rows, stat_date, contract)
        if wide:
            quality_report(wide, meta_rows)
        return finish(args, wide, meta_rows, captured_at, stat_date)

    # ③ 采集
    usable = [s for s in shops if s['cookie_count']]
    print(f'   共 {len(shops)} 个店铺，有 cookie 的 {len(usable)} 个')
    if not usable:
        die('没有任何店铺的登录态；请在「店铺工作台」里扫码登录后重试')
    if not args.no_brush:
        # 预取近 N 天聚水潭紫旗订单号，挂到各抖店店铺，供 brush_reviews 步骤关联评价
        try:
            wdays = int(args.brush_window_days or 14)
            bdata, _tot = jst_brush.fetch_brush_orders_window(stat_date, days=wdays)
            jst_universe = list(bdata)
            for sh in usable:
                ids = set()
                for n in jst_brush.match_names(sh['name'], jst_universe):
                    ids |= bdata.get(n) or set()
                sh['_brush_ids'] = ids
                sh['_brush_stat_date'] = stat_date
            print(f'   刷单评价关联: 近{wdays}天紫旗订单 {_tot} 个')
        except jst_brush.JstSessionError as e:
            for sh in usable:
                sh['_brush_ids'] = None
            print(f'   ⚠️ 刷单评价字段将置空: {e}')
        except Exception as e:
            for sh in usable:
                sh['_brush_ids'] = None
            print(f'   ⚠️ 刷单评价关联失败: {str(e)[:80]}')

    print(f'② 采集（并发 {args.concurrency}）…')
    rows = collect_all(usable, args.concurrency)
    ok = [r for r in rows if r.get('status') == 'ok']
    bad = [r for r in rows if r.get('status') != 'ok']
    print(f'   成功 {len(ok)} / {len(rows)}')
    for r in bad:
        print(f"   ⚠️ {r.get('name')}: {r.get('error')}")

    if not args.no_brush:
        print('②b 聚水潭刷单标记…')
        rows = enrich_brush_orders(rows, stat_date)

    wide, meta_rows = normalize(rows, stat_date, contract)
    if wide:
        quality_report(wide, meta_rows)
    finish(args, wide, meta_rows, now_iso(), stat_date)


if __name__ == '__main__':
    main()
