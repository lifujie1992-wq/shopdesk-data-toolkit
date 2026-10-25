from __future__ import annotations

from datetime import datetime, timezone, timedelta
import json
from pathlib import Path
import shutil
import socket
import uuid

from .export import export
from .model import Dataset, DataError, dump_json, month_bounds, safe_name
from .parse import import_file
from .rules import TemplateRules, process


def build(source_paths, *, month, shop_name, output=Path('data/runs'), template=Path('doc/【抖音】月度账单处理模版.xlsx'),
          shopdesk_shop_uuid=None, platform_shop_id=None, shop_id=None, bindings=None,
          balances=None, mapping=None, manifest_path=None, collection_context=None,reconciliation_date=None):
    month_bounds(month)
    if reconciliation_date is not None:
        from .upload import business_date
        business_date(reconciliation_date)
    run_id=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+uuid.uuid4().hex[:8]
    root=output.resolve()/run_id
    root.mkdir(parents=True,exist_ok=False)
    context={'schema_version':'1.0','run_id':run_id,'month':month,'shop_name':shop_name,
             'shopdesk_shop_uuid':shopdesk_shop_uuid,'platform_shop_id':platform_shop_id,'shop_id':shop_id,
             'platform':'douyin','agent_id':socket.gethostname(),'created_at':datetime.now(timezone.utc).isoformat(),
             **(collection_context or {})}
    context['reconciliation_date']=reconciliation_date or datetime.fromisoformat(context['created_at']).astimezone(timezone(timedelta(hours=8))).date().isoformat()
    dataset=Dataset(context)
    try:
        if manifest_path:
            manifest=json.loads(manifest_path.read_text())
            for k in ['shopdesk_shop_uuid','platform_shop_id','shop_id']:
                incoming=manifest.get('shop',{}).get(k)
                if context.get(k) and incoming and context[k]!=incoming:
                    raise DataError(f'shop identity conflict in {k}')
                if incoming:context[k]=incoming
            shop=manifest.get('shop',{})
            if shop.get('platform','douyin')!='douyin':raise DataError('source manifest belongs to another platform')
            if shop.get('identity'):
                from .identity import validate_identity
                identity=validate_identity(shop['identity'],context.get('platform_shop_id'))
                context.update(platform='douyin',platform_shop_id=identity['shop_id'],shop_id=identity['shop_id'],
                               shop_name=identity['shop_name'],shop_identity=identity)
            balances=manifest.get('balances',balances)
            context['collection']=manifest.get('collection',context.get('collection',[]))
            context['qianchuan_expected_accounts']=[e['id'] for e in manifest.get('entities',[]) if e.get('role')=='qianchuan' and e.get('id')]
            for item in context['collection']:
                if item.get('status')=='error':
                    dataset.issue('collection_failed',item.get('error','collection failed'),role=item.get('role'))
            for item in manifest.get('inputs',[]):
                path=Path(item['path'])
                if not path.is_absolute():path=manifest_path.parent/path
                if item.get('sha256'):
                    from .model import sha256
                    if sha256(path)!=item['sha256']:raise DataError('source file hash differs from collection receipt')
                import_file(dataset,path,root,role=item.get('role'),account=item.get('account'),entity_id=item.get('entity_id'),entity_name=item.get('entity_name'))
            for image in manifest.get('screenshots',[]):
                source=Path(image['path'])
                if not source.is_absolute():source=manifest_path.parent/source
                target=root/'screenshots'/safe_name(source.name);target.parent.mkdir(parents=True,exist_ok=True)
                shutil.copy2(source,target)
                context.setdefault('images',[]).append({**image,'path':str(target)})
        for source in source_paths:
            import_file(dataset,Path(source),root)
        for table in dataset.tables:
            override=(bindings or {}).get(table.name)
            if override:
                for row in table.rows:row.source['account']=override
        if balances:dataset.balances=balances
        for item in context.get('collection',[]):
            role=item.get('role')
            if role in ['fund','settlement'] and item.get('status')=='downloaded' and item.get('month_row'):
                fields=item['month_row']
                expected=int(str(fields[1]).replace(',','')) if role=='fund' else int(str(fields[2]).replace(',',''))+int(str(fields[4]).replace(',',''))
                from .parse import target_rows
                actual=sum(1 for t in dataset.table(role) for r in target_rows(dataset,t,'动账时间' if role=='fund' else '结算时间'))
                if expected!=actual:dataset.issue('row_count_mismatch',f'{role} monthly expected {expected}, downloaded {actual}',expected=expected,actual=actual)
        rules=TemplateRules(template,mapping)
        (root/'rules').mkdir(exist_ok=True)
        shutil.copy2(template,root/'rules/template.xlsx')
        process(dataset,rules)
        report=export(dataset,root)
        return {'run_id':run_id,'run_dir':str(root),'report':str(report),'conclusion':context['conclusion'],
                'upload_ready':context['upload_ready'],'validation':str(root/'report-validation.json'),
                'partial_accounts':context['partial_accounts'],
                'tables':len(dataset.tables),'rows':sum(len(t.rows) for t in dataset.tables),
                'issues':len(dataset.issues),'source_counts':{t.name:len(t.rows) for t in dataset.tables if t.role in ['fund','settlement','deposit','base_deposit','experience_deposit','steward','qianchuan']}}
    except Exception as exc:
        if not (root/'qianchuan-result.json').exists():
            dump_json(root/'qianchuan-result.json',{'shop_id':context.get('platform_shop_id'),'month':month,
                     'status':'failed','row_count':0,'reason':'源数据未能完成解析或计算；详见本地failure.json'})
        dump_json(root/'failure.json',{'run_id':run_id,'error':str(exc),'type':type(exc).__name__})
        raise
