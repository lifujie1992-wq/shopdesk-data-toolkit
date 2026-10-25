from __future__ import annotations

import json
import re
import sqlite3
import time
from pathlib import Path
from urllib.parse import urlencode

from .bridge import ShopDesk, ShopDeskError
from .model import (CaptureError, PAGE, PROMOTED, STRATEGIES, UNPROMOTED,
                    adapter_hash, atomic_json, digest, identifier, normalize, normalize_overrides, now, response_data)


def load_targets(path):
    path=Path(path)
    if path.suffix in ('.sqlite','.db'):
        with sqlite3.connect(path.resolve().as_uri()+'?mode=ro',uri=True) as db:
            rows=db.execute('''SELECT shop_id,platform,platform_link_id,
             CASE WHEN count(DISTINCT nullif(spu_id,''))=1 THEN max(nullif(spu_id,'')) END
             FROM order_profit_facts WHERE platform='抖音'
             AND (CAST(actual_shipped_qty AS REAL)>0 OR nullif(shipped_at,'') IS NOT NULL)
             AND nullif(platform_link_id,'') IS NOT NULL GROUP BY 1,2,3 ORDER BY 1,3''').fetchall()
        targets=[dict(zip(('shop_id','platform','platform_link_id','internal_item_code'),r)) for r in rows]
    else:
        data=json.loads(path.read_text())
        targets=data['targets'] if isinstance(data,dict) else data
    seen=set()
    for t in targets:
        identifier(t.get('shop_id'),'shop_id'); identifier(t.get('platform_link_id'),'platform_link_id')
        if t.get('platform')!='抖音': raise CaptureError('targets must be filtered to 抖音')
        key=(t['shop_id'],t['platform'],t['platform_link_id'])
        if key in seen: raise CaptureError('duplicate target pair')
        seen.add(key)
    return sorted(targets,key=lambda r:(r['shop_id'],r['platform_link_id']))


def canonical_name(name):
    # ERP prefixes/operators may be removed; brand hyphens such as DLIN-DLING are significant.
    stripped=re.sub(r'^[A-Za-z]-','',name)
    if stripped!=name:
        stripped=re.sub(r'-[\u4e00-\u9fff]{1,6}(?:[（(][^）)]*[）)])?$','',stripped)
    return stripped.strip()


def plan_shops(sales, bridge, output):
    with sqlite3.connect(Path(sales).resolve().as_uri()+'?mode=ro',uri=True) as db:
        rows=db.execute("SELECT DISTINCT shop_id,shop_name FROM sales_performance WHERE platform IN ('抖音','抖店')").fetchall()
    by_name={}
    for sid,name in rows:
        by_name.setdefault(canonical_name(name),set()).add(sid)
    shops=[];unmapped=[]
    for shop in bridge.shops():
        ids=by_name.get(shop['name'],set())
        if len(ids)!=1:
            unmapped.append({'bridge_shop_id':shop['id'],'shop_name':shop['name'],'reason':'no_unique_ERP_name_match'})
            continue
        shops.append(dict(shop_id=next(iter(ids)),shop_name=shop['name'],bridge_shop_id=shop['id'],
                          platform_shop_id=None,mapping_basis='ERP店名精确去前后缀匹配，待后台身份验证'))
    atomic_json(output,{'shops':shops,'unmapped':unmapped,'created_at':now()})
    return {'candidate_shops':len(shops),'unmapped':len(unmapped),'output':str(output)}


class Buyin:
    def __init__(self, bridge=None, interval=1.2, retries=3):
        self.bridge=bridge or ShopDesk()
        self.interval=max(1.0,interval)
        self.retries=retries
        self.last_call=0
        self.eid=None
        self.shop=None

    def open(self, shop):
        self.close()
        self.eid=self.bridge.start(shop['bridge_shop_id'],PAGE)
        self.bridge.ready(self.eid)
        deadline=time.monotonic()+30
        while time.monotonic()<deadline:
            identity=self.bridge.evaluate(self.eid,'''({shop_id:String(window.__shop_id||''),
             shop_name:window.__INITIAL_USER_INFO__?.data?.shop_name||'',url:location.href,
             denied:/无权限访问|暂无权限|没有访问权限/.test(document.body?.innerText||'')})''')
            if identity.get('shop_id') and identity.get('shop_name'):
                break
            time.sleep(.5)
        else:
            raise CaptureError('cannot verify backend shop identity')
        if identity['denied'] or '/login' in identity['url']:
            raise CaptureError('needs_login_or_permission')
        if shop.get('platform_shop_id') and identity['shop_id']!=shop['platform_shop_id']:
            raise CaptureError('configured platform_shop_id does not match current session')
        if identity['shop_name']!=shop['shop_name']:
            raise CaptureError('configured shop_name does not match current session')
        identifier(identity['shop_id'],'platform_shop_id')
        self.shop={**shop,'platform_shop_id':identity['shop_id']}
        return self.shop

    def close(self):
        if self.eid:
            eid,self.eid=self.eid,None
            self.bridge.close(eid)

    def request(self,path,params):
        if path not in (PROMOTED,UNPROMOTED,STRATEGIES):
            raise CaptureError('only verified read endpoints allowed')
        url=path+'?'+urlencode(params)
        expression='''(async()=>{let r=await fetch(URL_VALUE,{credentials:'include',signal:AbortSignal.timeout(8000)});
         return {status:r.status,text:await r.text()}})()'''.replace('URL_VALUE',json.dumps(url))
        for attempt in range(self.retries):
            time.sleep(max(0,self.last_call+self.interval-time.monotonic()))
            self.last_call=time.monotonic()
            try:
                r=self.bridge.evaluate(self.eid,expression)
                if r['status'] in (401,403): raise CaptureError('needs_login_or_permission')
                if r['status'] not in (429,500,502,503,504):
                    if r['status']!=200: raise CaptureError('unexpected_http_status')
                    payload=json.loads(r['text']) # Python preserves every integer digit.
                    response_data(payload)
                    return payload
            except (ShopDeskError,ValueError,KeyError,TypeError):
                if attempt+1==self.retries:
                    raise CaptureError('network_or_response_error') from None
            if attempt+1<self.retries: time.sleep(min(15,2**attempt))
        raise CaptureError('http_rate_limit_or_server_error')

    def pages(self,path,params,allowed_ids=None):
        result=[];seen=set();page=1;expected=None
        while True:
            payload=self.request(path,{**params,'page':page,'pageSize':50,'page_size':50})
            rows,total=response_data(payload)
            if expected is None: expected=total
            if total!=expected: raise CaptureError('result set changed during pagination; retry task')
            if payload.get('current')!=page:
                raise CaptureError('API ignored requested page')
            if allowed_ids is not None and total>len(allowed_ids):
                raise CaptureError('API ignored exact ID filter or target count changed')
            for row in rows:
                key=identifier(row.get('product_id') if path!=STRATEGIES else row.get('strategy_id'), 'response_id')
                if key in seen: raise CaptureError('duplicate or repeated API page')
                if allowed_ids is not None and key not in allowed_ids:
                    raise CaptureError('API returned an unrequested ID')
                seen.add(key)
            result.extend(rows)
            if len(result)==total: return result
            if not rows or len(result)>total: raise CaptureError('incomplete API pagination')
            if page>=1000: raise CaptureError('pagination safety limit reached')
            page+=1

    def task(self,store,batch,task):
        ids=json.loads(task['link_ids_json']);wanted=set(ids)
        promoted=self.pages(PROMOTED,{'status':0,'product_info':','.join(ids)},wanted)
        missing=wanted-{r['product_id'] for r in promoted}
        unpromoted=self.pages(UNPROMOTED,{'title':','.join(sorted(missing)),'is_new_platform':'true',
                                        'is_opportunity_product':'false'},missing) if missing else []
        rows=[];overrides=[];issues=[]
        for kind,raw in [(PROMOTED,r) for r in promoted]+[(UNPROMOTED,r) for r in unpromoted]:
            item=raw['product_id']
            try:
                if kind==UNPROMOTED and raw.get('promotion_status')==99 and not raw.get('promotion_id'):
                    active=self.pages(STRATEGIES,{'status':1,'product_id':item})
                    raw={**raw,'_capture_active_strategy_count':len(active)}
                row=normalize(raw,self.shop,kind,now(),store.previous(batch,task['shop_id'],item))
                internal=store.db.execute('''SELECT internal_item_code FROM batch_targets
                 WHERE batch_id=? AND shop_id=? AND platform='抖音' AND platform_link_id=?''',
                 (batch,task['shop_id'],item)).fetchone()
                row['internal_item_code']=internal[0]
                if kind==PROMOTED and raw.get('status')==2 and (raw.get('strategy_info') or {}).get('strategy_kol_num',0):
                    strategies=self.pages(STRATEGIES,{'status':1,'product_id':item})
                    extra=normalize_overrides(strategies,row)
                    if not extra: raise CaptureError('specified creator strategies missing from details')
                    overrides.extend((item,r) for r in extra)
                rows.append(row)
            except CaptureError as exc:
                issues.append((item,str(exc)))
        for item in wanted-{r['product_id'] for r in promoted+unpromoted}:
            # Not found does not prove disabled, delisted or invalid.
            issues.append((item,'not_found_in_promoted_or_unpromoted_inventory'))
        return rows,overrides,issues


def collect(store,batch,source=None,max_tasks=None,only_shop=None,report_dir=None):
    source=source or Buyin()
    b=store.batch(batch)
    if b['complete']: raise CaptureError('accepted batch is immutable')
    if b['adapter_hash']!=adapter_hash():
        raise CaptureError('capture code changed since batch started; create a new batch')
    shops={s['shop_id']:s for s in json.loads(b['config_json'])['shops']}
    tasks=store.db.execute("SELECT * FROM capture_tasks WHERE batch_id=? AND status<>'done' ORDER BY shop_id,task_id",(batch,)).fetchall()
    opened=None;blocked=set();count=0
    try:
        for task in tasks:
            if only_shop and task['shop_id']!=only_shop: continue
            if max_tasks is not None and count>=max_tasks: break
            sid=task['shop_id']
            if sid in blocked: continue
            if sid!=opened:
                try:
                    if sid not in shops: raise CaptureError('no_shopdesk_session_mapping')
                    source.open(shops[sid]);opened=sid
                except (CaptureError,ShopDeskError) as exc:
                    store.failed_task(batch,task,str(exc) if isinstance(exc,CaptureError) else 'shopdesk_session_unavailable')
                    blocked.add(sid);opened=None
                    continue
            try:
                rows,overrides,issues=source.task(store,batch,task)
                store.save_task(batch,task,rows,overrides,issues)
                count+=1
                print(json.dumps({'batch_id':batch,'shop_id':sid,'task':task['task_id'],
                                  'rows':len(rows),'unresolved':len(issues)},ensure_ascii=False),flush=True)
            except (CaptureError,ShopDeskError) as exc:
                store.failed_task(batch,task,str(exc) if isinstance(exc,CaptureError) else 'shopdesk_command_failed')
                blocked.add(sid) # stop this shop; do not hammer a login or risk-control response
    finally:
        source.close()
        store.finish_collection(batch)
        if report_dir: store.write_report(batch,report_dir)
    return store.report(batch)
