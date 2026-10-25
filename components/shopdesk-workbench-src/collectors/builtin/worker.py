"""Bundled worker: one private stdin request, one sanitized JSON response."""
import sys,json,os,sqlite3
from pathlib import Path
from douyin import direct_credentials

def collect(pool,fn,shops):
    from concurrent.futures import as_completed
    futures=[pool.submit(fn,item) for item in shops];rows=[]
    for f in as_completed(futures):
        rows.append(f.result())
        print(json.dumps({'event':'progress','completed':len(rows),'total':len(shops)}),file=sys.stderr,flush=True)
    return rows

def finalize_worklist(results,dataDir,action):
    """把全部候选写成工单文件（含举报/申诉说明），并限制返回体积。"""
    from pathlib import Path
    from datetime import datetime,timezone
    rows=[]
    for r in results:
        for c in (r.get('candidates') or []):
            rows.append({'shop_id':r.get('shop_id'),'shop':r.get('name'),**c})
    folder=Path(dataDir);folder.mkdir(parents=True,mode=0o700,exist_ok=True)
    stamp=datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')
    file=folder/('appeal-worklist-%s-%s.json'%(action,stamp))
    file.write_text(json.dumps(rows,ensure_ascii=False,indent=1),encoding='utf-8')
    os.chmod(file,0o600)
    # 全部品退/中差评按天总量（趋势图用）
    daily={}
    for r in results:
        for d,n in (r.get('all_daily') or {}).items():
            daily[d]=daily.get(d,0)+int(n or 0)
    df=folder/('appeal-daily-%s.json'%action)
    df.write_text(json.dumps({'captured_at':datetime.now(timezone.utc).isoformat(),'daily':daily},ensure_ascii=False,indent=1),encoding='utf-8')
    os.chmod(df,0o600)
    for r in results:
        if isinstance(r.get('candidates'),list) and len(r['candidates'])>60:
            r['candidates']=r['candidates'][:60]
    return str(file),len(rows)

def main(request):
    if request.get('action')=='health':return {'frozen':bool(getattr(sys,'frozen',False)),'python':sys.version.split()[0]}
    if request.get('action')=='fetch':
        if not isinstance(request.get('cookies'),list) or not isinstance(request.get('name'),str):raise ValueError('无效的采集请求')
        return direct_credentials(request['cookies'],request.get('userAgent',''),request['name'])
    if request.get('action')=='experience':
        from experience import fetch
        from concurrent.futures import ThreadPoolExecutor
        from datetime import datetime,timezone
        import time
        started=time.perf_counter()
        with ThreadPoolExecutor(max_workers=3) as pool:results=collect(pool,fetch,request['shops'])
        http=time.perf_counter()-started
        folder=Path(request['dataDir']);folder.mkdir(parents=True,mode=0o700,exist_ok=True)
        file=folder/'business.sqlite3';run=datetime.now(timezone.utc).isoformat()
        with sqlite3.connect(file,timeout=10) as db:
            os.chmod(file,0o600)
            db.execute('CREATE TABLE IF NOT EXISTS experience_snapshots (run TEXT,shop_id TEXT,data TEXT,PRIMARY KEY(run,shop_id))')
            for r in results:db.execute('INSERT INTO experience_snapshots VALUES (?,?,?)',(run,r['shop_id'],json.dumps(r,ensure_ascii=False)))
        return {'captured_at':run,'success':sum(r['status']=='ok' for r in results),'shop_count':len(results),'concurrency':3,'python_http_seconds':round(http,3),'results':results}
    if request.get('action')=='shipped_refunds':
        from refunds import fetch,period
        from concurrent.futures import ThreadPoolExecutor
        from datetime import datetime,timezone
        import time
        started=time.perf_counter();span=period(30)
        with ThreadPoolExecutor(max_workers=3) as pool:results=collect(pool,lambda item:fetch(item,span),request['shops'])
        http=time.perf_counter()-started
        folder=Path(request['dataDir']);folder.mkdir(parents=True,mode=0o700,exist_ok=True)
        file=folder/'business.sqlite3';run=datetime.now(timezone.utc).isoformat()
        with sqlite3.connect(file,timeout=10) as db:
            os.chmod(file,0o600)
            db.execute('CREATE TABLE IF NOT EXISTS shipped_refund_snapshots (run TEXT,shop_id TEXT,data TEXT,PRIMARY KEY(run,shop_id))')
            for r in results:db.execute('INSERT INTO shipped_refund_snapshots VALUES (?,?,?)',(run,r['shop_id'],json.dumps(r,ensure_ascii=False)))
        return {'captured_at':run,'period':span,'total_count':sum(r['count'] for r in results if r['status']=='ok'),'success':sum(r['status']=='ok' for r in results),'shop_count':len(results),'concurrency':3,'python_http_seconds':round(http,3),'results':results}
    if request.get('action')=='quality_returns':
        from quality import fetch_quality_returns,period
        from concurrent.futures import ThreadPoolExecutor
        from datetime import datetime,timezone
        import time,json as _json
        started=time.perf_counter();span=period(30)
        # 已有判定结果的单号（按店），供采集器优先核查尚未判定的
        try:
            _pool=Path(request['dataDir'])/'quality-all-latest.json'
            _chk={}
            for _x in _json.loads(_pool.read_text(encoding='utf-8')):
                if _x.get('appealable') is not None and _x.get('order_id'):
                    _chk.setdefault(str(_x.get('shop_id') or ''),set()).add(str(_x['order_id']))
            for _it in request['shops']:
                _it['checked']=list(_chk.get(str(_it.get('id') or ''),set()))[:6000]
        except Exception:
            pass
        with ThreadPoolExecutor(max_workers=3) as pool:results=collect(pool,lambda item:fetch_quality_returns(item),request['shops'])
        http=time.perf_counter()-started
        worklist,count=finalize_worklist(results,request['dataDir'],'quality_returns')
        # 额外落一份「全量品退池」（含被筛掉的：说明与原因一致 / 含真实品质词 / 详情失败）
        try:
            folder=Path(request['dataDir']);folder.mkdir(parents=True,mode=0o700,exist_ok=True)
            stamp=datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')
            allrows=[]
            for r in results:
                for x in (r.get('all_returns') or []):
                    allrows.append(dict(x, shop=r.get('name') or '', shop_id=r.get('shop_id') or ''))
            f=folder/('quality-all-%s.json'%stamp)
            f.write_text(json.dumps(allrows,ensure_ascii=False,indent=1),encoding='utf-8')
            os.chmod(f,0o600)
            latest=folder/'quality-all-latest.json'
            merged={}
            try:
                for x in json.loads(latest.read_text(encoding='utf-8')): merged[str(x.get('order_id'))]=x
            except Exception:
                pass
            for x in allrows:
                if x.get('order_id'): merged[str(x['order_id'])]=x
            from datetime import date,timedelta
            cutoff=(date.today()-timedelta(days=30)).isoformat()
            merged={k:v for k,v in merged.items() if str(v.get('apply_date') or cutoff)>=cutoff}
            latest.write_text(json.dumps(list(merged.values()),ensure_ascii=False),encoding='utf-8')
            os.chmod(latest,0o600)
            total_pool=sum(len(r.get('all_returns') or []) for r in results)
            total_appealable=sum(r.get('appealable_count') or 0 for r in results)
            # 池已落盘，回传时清掉明细，避免「采集模块返回过大」
            for r in results:
                if 'all_returns' in r: r['all_returns']=[]
        except Exception:
            total_pool=total_appealable=0
        return {'captured_at':datetime.now(timezone.utc).isoformat(),'period':span,'total_candidates':count,'worklist_file':worklist,'total_pool':total_pool,'total_appealable':total_appealable,'success':sum(r['status']=='ok' for r in results),'shop_count':len(results),'concurrency':3,'python_http_seconds':round(http,3),'results':results}
    if request.get('action')=='negative_reviews':
        from quality import fetch_negative_reviews
        from concurrent.futures import ThreadPoolExecutor
        from datetime import datetime,timezone
        import time
        started=time.perf_counter()
        with ThreadPoolExecutor(max_workers=3) as pool:results=collect(pool,fetch_negative_reviews,request['shops'])
        http=time.perf_counter()-started
        worklist,count=finalize_worklist(results,request['dataDir'],'negative_reviews')
        # 额外落一份「全量中差评」（含被筛掉的：有实质内容/有图/情绪化）
        try:
            stamp=datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')
            allrows=[]
            for r in results:
                for x in (r.get('all_reviews') or []):
                    allrows.append(dict(x, shop=r.get('name') or '', shop_id=r.get('shop_id') or ''))
            f=Path(request['dataDir'])/('reviews-all-%s.json'%stamp)
            f.write_text(json.dumps(allrows,ensure_ascii=False,indent=1),encoding='utf-8')
        except Exception:
            pass
        return {'captured_at':datetime.now(timezone.utc).isoformat(),'total_candidates':count,'worklist_file':worklist,'success':sum(r['status']=='ok' for r in results),'shop_count':len(results),'concurrency':3,'python_http_seconds':round(http,3),'results':results}
    if request.get('action')=='review_details':
        from quality import fetch_review_details
        from concurrent.futures import ThreadPoolExecutor
        from datetime import datetime,timezone
        import time
        started=time.perf_counter()
        with ThreadPoolExecutor(max_workers=3) as pool:results=collect(pool,fetch_review_details,request['shops'])
        http=time.perf_counter()-started
        stamp=datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')
        allrows=[]
        for r in results:
            for x in (r.get('details') or []):
                allrows.append(dict(x, shop=r.get('name') or '', shop_id=r.get('shop_id') or ''))
        folder=Path(request['dataDir']);folder.mkdir(parents=True,mode=0o700,exist_ok=True)
        f=folder/('reviews-detail-%s.json'%stamp)
        f.write_text(json.dumps(allrows,ensure_ascii=False,indent=1),encoding='utf-8')
        os.chmod(f,0o600)
        # latest 合并（按 review_id upsert，供 BI/云端直接取）
        latest=folder/('reviews-detail-latest.json')
        merged={}
        try:
            old=json.loads(latest.read_text(encoding='utf-8'))
            for x in old: merged[str(x.get('review_id'))]=x
        except Exception: pass
        for x in allrows: merged[str(x.get('review_id'))]=x
        # 30 天滚动窗口：过老的行清掉，保持增量库恒定范围
        cutoff=int(time.time())-30*86400
        merged={k:v for k,v in merged.items() if int(v.get('comment_time') or 0)>=cutoff}
        latest.write_text(json.dumps(list(merged.values()),ensure_ascii=False),encoding='utf-8')
        os.chmod(latest,0o600)
        return {'captured_at':datetime.now(timezone.utc).isoformat(),'total_details':len(allrows),'merged_total':len(merged),
                'detail_file':str(f),'latest_file':str(latest),
                'success':sum(r['status']=='ok' for r in results),'shop_count':len(results),
                'python_http_seconds':round(http,3),
                'results':[{k:r.get(k) for k in ('status','name','shop_id','fetched','seconds','error')} for r in results]}
    if request.get('action')=='backfill_products':
        from backfill import backfill_products
        from concurrent.futures import ThreadPoolExecutor
        from datetime import datetime,timezone
        import time
        started=time.perf_counter()
        with ThreadPoolExecutor(max_workers=3) as pool:results=collect(pool,lambda item:backfill_products(item,item.get('_targets') or {}),request['shops'])
        http=time.perf_counter()-started
        total=sum(r.get('matched_count') or 0 for r in results)
        missing=sum(len(r.get('missing') or []) for r in results)
        return {'captured_at':datetime.now(timezone.utc).isoformat(),'total_matched':total,'total_missing':missing,'success':sum(r['status']=='ok' for r in results),'shop_count':len(results),'concurrency':3,'python_http_seconds':round(http,3),'results':results}
    if request.get('action')=='record':
        # Only normalized metric data, never the fetch request or raw responses.
        folder=Path(request['dataDir']);folder.mkdir(parents=True,mode=0o700,exist_ok=True)
        file=folder/'business.sqlite3';db=sqlite3.connect(file,timeout=10);os.chmod(file,0o600)
        try:
            db.execute('CREATE TABLE IF NOT EXISTS snapshots(run_id TEXT,shop_id TEXT,shop_name TEXT,platform TEXT,status TEXT,transport TEXT,captured_at TEXT,data_json TEXT,error TEXT,PRIMARY KEY(run_id,shop_id))')
            r=request['record'];data=r.get('data') or {}
            clean={k:data[k] for k in ['metrics','sourceLabels','period','date','capturedAt','sourceURL','durationMs','transport'] if k in data}
            db.execute('INSERT OR REPLACE INTO snapshots VALUES(?,?,?,?,?,?,?,?,?)',(r['runId'],r['id'],r['name'],r['platform'],r['status'],data.get('transport','cdp'),data.get('capturedAt'),json.dumps(clean,ensure_ascii=False),r.get('error')));db.commit();return {'saved':True}
        finally:db.close()
    raise ValueError('不支持的操作')
if __name__=='__main__':
    try:
        raw=sys.stdin.buffer.read(16_000_001)
        if len(raw)>16_000_000:raise ValueError('请求过大')
        result=main(json.loads(raw));print(json.dumps({'ok':True,'result':result},ensure_ascii=False))
    except Exception as e:
        # Never emit requests exceptions, URLs, headers, cookies, or tracebacks.
        message=str(e) if isinstance(e,ValueError) else '内置采集模块执行失败：'+type(e).__name__
        print(json.dumps({'ok':False,'error':message},ensure_ascii=False));sys.exit(1)
