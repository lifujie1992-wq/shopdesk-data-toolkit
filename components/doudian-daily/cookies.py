#!/usr/bin/env python3
"""
Cookie 来源：从「店铺工作台」的会话分区里读 cookie。

工作台（shopdesk）把每个店铺的登录态存在：
    ~/Library/Application Support/shopdesk/Partitions/shop-<id>/Cookies   (SQLite, 明文)
    ~/Library/Application Support/shopdesk/shops.json                     (店铺列表)

本模块只读这些文件，**不需要工作台进程在运行**。
工作台的唯一职责就是"扫码登录"，登录完把 cookie 留在磁盘上即可。

也支持从外部 cookie 文件读取（便于在别的机器/容器里跑）：
    {"shop_name": [{"name":..., "value":..., "domain":..., "path":..., "secure":...}, ...], ...}
"""
import json, os, shutil, sqlite3, tempfile

UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36')

APPDATA = os.path.expanduser('~/Library/Application Support/shopdesk')
SHOPS_JSON = os.path.join(APPDATA, 'shops.json')


class CookieSourceError(RuntimeError):
    pass


def list_shops(appdata=APPDATA):
    """返回工作台里的店铺列表 [{id, name, platform, partition}]"""
    path = os.path.join(appdata, 'shops.json')
    if not os.path.exists(path):
        raise CookieSourceError(f'找不到 {path}，请先安装/运行一次「店铺工作台」')
    shops = json.load(open(path, encoding='utf-8'))
    out = []
    for s in shops:
        out.append({
            'id': s['id'],
            'name': s['name'],
            'platform': s.get('platform'),
            'partition': os.path.join(appdata, 'Partitions', 'shop-' + s['id']),
        })
    return out


def read_cookies(partition, domains=('jinritemai.com',)):
    """读某个分区里的 cookie（明文存储，直接取 value 列）。"""
    db = os.path.join(partition, 'Cookies')
    if not os.path.exists(db):
        return []
    tmp = tempfile.mktemp(prefix='ck-')
    shutil.copy(db, tmp)          # 复制一份，避免与正在运行的浏览器抢锁
    try:
        con = sqlite3.connect(tmp)
        rows = con.execute(
            'SELECT host_key, name, value, path, is_secure, expires_utc FROM cookies').fetchall()
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass
    out = []
    for host, name, value, path, secure, expires in rows:
        if not value:
            continue
        if domains and not any(host.endswith(d) for d in domains):
            continue
        out.append({'name': name, 'value': value, 'domain': host,
                    'path': path or '/', 'secure': bool(secure),
                    'expires_utc': expires or 0})
    return out


def load_from_file(path, shop_name):
    """从外部 cookie JSON 读取。"""
    data = json.load(open(path, encoding='utf-8'))
    ck = data.get(shop_name)
    if ck is None:
        for k, v in data.items():
            if k == shop_name or k in shop_name or shop_name in k:
                ck = v
                break
    if ck is None:
        raise CookieSourceError(f'{path} 里没有店铺「{shop_name}」的 cookie')
    if isinstance(ck, dict):
        ck = [{'name': k, 'value': v, 'domain': '.jinritemai.com', 'path': '/', 'secure': True}
              for k, v in ck.items()]
    return ck


def collect(appdata=APPDATA, platform='抖店', cookie_file=None, only=None):
    """返回 [{id, name, platform, cookies, ua}]

    cookie_file: 指定则从该文件读 cookie（按店铺名匹配），忽略工作台分区。
    """
    shops = [s for s in list_shops(appdata) if platform is None or s['platform'] == platform]
    if only:
        keep = set(only)
        shops = [s for s in shops if s['name'] in keep]
    out = []
    for s in shops:
        ck = (load_from_file(cookie_file, s['name']) if cookie_file
              else read_cookies(s['partition']))
        out.append({'id': s['id'], 'name': s['name'], 'platform': s['platform'],
                    'cookies': ck, 'ua': UA, 'cookie_count': len(ck)})
    return out


if __name__ == '__main__':
    import sys
    shops = list_shops()
    print(f'工作台店铺 {len(shops)} 个，AppData={APPDATA}')
    for s in shops:
        ck = read_cookies(s['partition'])
        has_login = any(c['name'] in ('sessionid', 'sid_guard', 'sid_tt') for c in ck)
        print(f"  {'✅' if has_login else '  '} {s['name']:22s} {s['platform']:6s} cookie={len(ck):3d}")
