from __future__ import annotations

import hashlib
import json
import math
import re
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path

TZ = timezone(timedelta(hours=8))
DATASET = 'commission_rates'
PROMOTED = '/doudian_pc/pc/api/promotion/getDeliveredProductList'
UNPROMOTED = '/doudian_pc/api/promotion/batchGetProducts'
STRATEGIES = '/doudian_pc/pc/api/strategy/getStrategyList'
PAGE = 'https://fxg.jinritemai.com/ffa/buyin/shop_smallshop/product/promote-manage'


class CaptureError(RuntimeError):
    pass


def now():
    return datetime.now(TZ).isoformat(timespec='seconds')


def dump(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def digest(value):
    return hashlib.sha256(dump(value).encode()).hexdigest()


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    with temporary.open('w', encoding='utf-8') as out:
        json.dump(value, out, ensure_ascii=False, indent=2, allow_nan=False)
        out.write('\n')
        out.flush()
        import os
        os.fsync(out.fileno())
    temporary.replace(path)


def adapter_hash():
    return hashlib.sha256(b''.join(Path(__file__).with_name(name).read_bytes()
                          for name in ('model.py','source.py','bridge.py'))).hexdigest()


def identifier(value, field):
    # Never repair a rounded JS number, scientific notation or missing ID.
    if not isinstance(value, str) or not re.fullmatch(r'[0-9]+', value):
        raise CaptureError(f'{field}: expected original decimal text identifier')
    return value


def rate(value):
    if value is None or isinstance(value, bool):
        raise CaptureError('missing commission rate')
    try:
        number = Decimal(str(value)) / 100
    except InvalidOperation:
        raise CaptureError('invalid percentage') from None
    if not number.is_finite() or not 0 <= number <= 1:
        raise CaptureError('percentage outside 0..100')
    return float(number)


def response_data(payload):
    if not isinstance(payload, dict) or payload.get('code') != 0 or payload.get('st', 0) != 0:
        raise CaptureError('API business error or login/permission required')
    if not isinstance(payload.get('data'), list):
        raise CaptureError('API data schema changed')
    if type(payload.get('total')) is not int or payload['total'] < 0:
        raise CaptureError('API total missing or invalid')
    return payload['data'], payload['total']


def normalize(record, shop, kind, stamp, previous=None):
    item = identifier(record.get('product_id'), 'product_id')
    if record.get('shop_id') is not None and str(record['shop_id']) != shop['platform_shop_id']:
        raise CaptureError('API shop identity mismatch')
    result = dict(shop_id=shop['shop_id'], shop_name=shop['shop_name'], platform='抖音',
                  platform_shop_id=shop['platform_shop_id'], platform_item_id=item,
                  platform_link_id=item, promotion_id=record.get('promotion_id') or None,
                  internal_item_code=None, item_name=record.get('title'), commission_type=None,
                  extra_rate=None, ad_commission_rate=None, link_status=None, captured_at=stamp,
                  rate_captured_at=stamp, source=kind, carried_from_batch=None, notes=None,
                  raw_json=dump(record))
    if kind == UNPROMOTED:
        # A successful exact result in the unpromoted inventory is positive evidence.
        inactive_verified=(record.get('promotion_status')==99
                           and type(record.get('_capture_active_strategy_count')) is int
                           and record['_capture_active_strategy_count']==0)
        if (record.get('promotion_status') != 0 and not inactive_verified) or record.get('promotion_id'):
            raise CaptureError('unpromoted state changed; cannot infer disabled')
        result.update(commission_enabled=0, commission_rate=None, commission_type='未推广')
        if inactive_verified:
            result['notes']='无法推广；已另查生效中策略为空。接口遗留 cos_ratio 只保留原始证据，不视为当前有效佣金。'
    elif kind == PROMOTED:
        info = record.get('cos_info') or {}
        # Status mapping was checked against the official frontend bundle + page.
        status=record.get('status')
        has_public=bool((record.get('strategy_info') or {}).get('all_strategy_id'))
        inactive=status in (1,4,5,6)
        if inactive and previous:
            for key in ('commission_rate', 'commission_enabled', 'commission_type', 'extra_rate',
                        'ad_commission_rate', 'rate_captured_at'):
                result[key] = previous[key]
            result.update(link_status='下架' if status==4 else '失效', carried_from_batch=previous['batch_id'],
                          notes='下架/封禁/清退；保留最后已知佣金，不视为本次新测佣金')
        elif status in (1,2,4,5,6) and has_public and record.get('open_status') == 2:
            result.update(commission_enabled=1, commission_rate=rate(info.get('cos_ratio')),
                          commission_type='公开')
            if info.get('cos_ratio_ad') is not None:
                result['ad_commission_rate'] = rate(info['cos_ratio_ad'])
            if inactive:
                result.update(link_status='下架' if status==4 else '失效',
                              notes='后台仍返回最后配置的公开佣金；当前链接非推广中，不能视为历史生效时间证明')
            elif (record.get('strategy_info') or {}).get('strategy_kol_num', 0):
                result['notes'] = '含指定达人策略，详见 commission_overrides；不覆盖公开佣金'
        elif status==3:
            result.update(commission_enabled=0,commission_rate=None,commission_type='策略关闭',
                          notes='后台标记无生效中佣金策略；旧佣金保留在历史 batch')
        else:
            raise CaptureError('unknown promotion status or missing public strategy; not treated as disabled')
    else:
        raise CaptureError('unsupported source')
    validate_row(result)
    return result


def validate_row(row):
    for key in ('shop_id', 'platform_item_id', 'platform_link_id', 'platform_shop_id'):
        identifier(row.get(key), key)
    if row.get('platform') != '抖音':
        raise CaptureError('unsupported platform')
    if type(row.get('commission_enabled')) is not int or row['commission_enabled'] not in (0, 1):
        raise CaptureError('commission_enabled must be explicit 0/1')
    for key in ('commission_rate', 'extra_rate', 'ad_commission_rate'):
        value = row.get(key)
        if value is not None and (isinstance(value, bool) or not math.isfinite(value) or not 0 <= value <= 1):
            raise CaptureError(f'invalid {key}')
    if row['commission_enabled'] == 0 and row['commission_rate'] not in (None, 0):
        raise CaptureError('disabled commission cannot have a positive rate')
    if row['commission_enabled'] == 1 and row['commission_rate'] is None:
        raise CaptureError('enabled commission needs a verified rate')
    for key in ('captured_at', 'rate_captured_at'):
        if datetime.fromisoformat(row[key]).utcoffset() != timedelta(hours=8):
            raise CaptureError(f'{key} must include +08:00')
    if not row.get('source'):
        raise CaptureError('missing source')


def normalize_overrides(records, base):
    result = []
    for row in records:
        # Only currently effective specified-creator strategies. Other scopes remain in raw evidence.
        if row.get('status') != 1 or row.get('valid_kol_range') not in (2, 4):
            continue
        strategy = identifier(row.get('strategy_id'), 'strategy_id')
        info = row.get('cos_ratio') or {}
        absolute = rate(info.get('cos_ratio'))
        difference = round(absolute - base['commission_rate'], 10)
        for kol in row.get('kol_infos') or [{}]:
            result.append(dict(strategy_id=strategy, creator_id=str(kol.get('uid') or ''),
                               commission_type='定向', commission_rate=absolute,
                               extra_rate=difference if difference >= 0 else None,
                               ad_commission_rate=rate(info['cos_ratio_ad']) if info.get('cos_ratio_ad') is not None else None,
                               source=STRATEGIES, raw_json=dump(row)))
    additions = {r['extra_rate'] for r in result}
    if len(additions) == 1:
        base['extra_rate'] = next(iter(additions))
    return result
