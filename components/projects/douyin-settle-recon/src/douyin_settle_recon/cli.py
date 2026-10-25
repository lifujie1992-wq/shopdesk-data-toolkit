from __future__ import annotations

import argparse
from datetime import date,timedelta
import json
from pathlib import Path
import sys

from .export import grid_page
from .model import DataError
from .pipeline import build
from .shopdesk import ShopDesk,ShopDeskError


def parser():
    p=argparse.ArgumentParser(prog='recon',description='ShopDesk finance collection and typed table exports')
    sub=p.add_subparsers(dest='command',required=True)
    sub.add_parser('shops',help='list Douyin shops through the running ShopDesk bridge')
    pimport=sub.add_parser('import',help='parse local official exports or an input manifest')
    pimport.add_argument('--source',action='append',type=Path,default=[])
    pimport.add_argument('--manifest',type=Path)
    _common(pimport)
    pimport.add_argument('--account',action='append',default=[],metavar='SHEET=ACCOUNT')
    pimport.add_argument('--balances',type=Path,help='verified monthly balance evidence JSON')
    pimport.add_argument('--mapping',type=Path,help='explicitly approved mapping overrides')
    pc=sub.add_parser('collect',help='collect a shop and build Excel plus structured source tables')
    _common(pc)
    pc.add_argument('--resume',type=Path,help='resume a same-shop same-month collection.json')
    pc.add_argument('--kinds',default='fund,settlement,base_deposit,experience_deposit,steward,tax,qianchuan')
    pg=sub.add_parser('export-grid',help='page canonical typed rows for a future Tencent Docs adapter')
    pg.add_argument('--run',type=Path,required=True);pg.add_argument('--table',required=True)
    pg.add_argument('--offset',type=int,default=0);pg.add_argument('--limit',type=int,default=500)
    pg.add_argument('--output',type=Path)
    pr=sub.add_parser('review',help='serve a local workbook comparison dashboard')
    pr.add_argument('--root',type=Path,default=Path.cwd(),help='project directory')
    pr.add_argument('--runs',type=Path,action='append',help='run directory; repeatable; defaults to runs and data/runs')
    pr.add_argument('--expected-dir',type=Path,help='directory containing same-name expected workbooks; defaults to doc')
    pr.add_argument('--template',type=Path,help='monthly template workbook')
    pr.add_argument('--port',type=int,default=5189)
    pu=sub.add_parser('upload',help='upload existing run reports using the Mac Worker contract')
    pu.add_argument('--run',type=Path,action='append',required=True,help='completed run directory; repeatable, uploaded serially')
    pu.add_argument('--reconciliation-date',help='override original Beijing execution date (YYYY-MM-DD); frozen on first enqueue')
    pu.add_argument('--shop-id',help='stable cloud shop ID; otherwise use manifest cloud/platform ID')
    mode=pu.add_mutually_exclusive_group()
    mode.add_argument('--dry-run',action='store_true',help='validate local files and show metadata without credentials or network')
    mode.add_argument('--prepare-only',action='store_true',help='freeze metadata and queue tasks without sending')
    _upload_options(pu)
    pq=sub.add_parser('upload-queue',help='resume due cloud uploads without rebuilding reports')
    _upload_options(pq)
    ps=sub.add_parser('upload-status',help='show durable upload task states and receipt paths')
    ps.add_argument('--queue-dir',type=Path,default=Path('data/upload-queue'))
    pcl=sub.add_parser('cleanup-uploaded',help='query and verify cloud downloads, then remove owned local generated data')
    pcl.add_argument('--queue-dir',type=Path,default=Path('data/upload-queue'))
    pcl.add_argument('--runs-root',type=Path,default=Path('data/runs'))
    pcl.add_argument('--run-id',action='append')
    pcl.add_argument('--upload-config',type=Path)
    pm=sub.add_parser('monthly',help='collect and upload last month for all current workbench shops, with checkpoints')
    pm.add_argument('--month',help='manual month override; default is previous month in Beijing time')
    pm.add_argument('--scheduled',action='store_true',help='run only installed due cycles or pending retries')
    pm.add_argument('--dry-run',action='store_true',help='list real workbench shops and plan; no collection, upload or state changes')
    pm.add_argument('--state-dir',type=Path,default=Path('data/monthly'))
    pm.add_argument('--output',type=Path,default=Path('data/runs'))
    pm.add_argument('--template',type=Path,default=Path('doc/【抖音】月度账单处理模版.xlsx'))
    pm.add_argument('--upload-config',type=Path)
    pm.add_argument('--queue-dir',type=Path,default=Path('data/upload-queue'))
    pm.add_argument('--retry-failed',action='store_true',help='manually recover failed shops without rebuilding successful reports')
    pm.add_argument('--retry-incomplete',action='store_true',help='supplement archived reports with missing Qianchuan access; resume sources into a new run')
    psc=sub.add_parser('schedule',help='inspect or install the monthly macOS launchd schedule')
    psc.add_argument('--root',type=Path,default=Path.cwd())
    psc.add_argument('--install',action='store_true',help='register monthly 1st 01:00 plus hourly gated retries; does not collect now')
    return p


def _common(p):
    p.add_argument('--month',default=(date.today().replace(day=1)-timedelta(days=1)).strftime('%Y-%m'))
    p.add_argument('--shop-name',help='local import label; live collection/upload uses the latest official platform name')
    p.add_argument('--shop',dest='shopdesk_shop_uuid')
    p.add_argument('--platform-shop-id')
    p.add_argument('--cloud-shop-id',dest='shop_id',help='compatibility identity assertion; must match the current platform shop ID')
    p.add_argument('--output',type=Path,default=Path('data/runs'))
    p.add_argument('--template',type=Path,default=Path('doc/【抖音】月度账单处理模版.xlsx'))
    p.add_argument('--reconciliation-date',help='override Beijing execution date YYYY-MM-DD for later uploads')
    p.add_argument('--upload',action='store_true',help='queue and upload the generated report after local export')
    _upload_options(p)


def _upload_options(p):
    p.add_argument('--upload-config',type=Path,help='optional private JSON override; defaults to ~/.config/invoice-mac-agent/config.json; environment overrides it')
    p.add_argument('--queue-dir',type=Path,default=Path('data/upload-queue'))
    p.add_argument('--retry-failed',action='store_true',help='manually retry failed tasks with the same run ID and frozen metadata')
    p.add_argument('--watch',action='store_true',help='wait for scheduled bounded retries; otherwise leave retry tasks on disk')


def _upload_runs(args,runs):
    from .upload import UploadConfig,enqueue_run,drain_queue,prepare_metadata
    if getattr(args,'dry_run',False):
        return {'dry_run':True,'reports':[prepare_metadata(run,reconciliation_date=args.reconciliation_date,shop_id=getattr(args,'shop_id',None))[0] for run in runs]}
    config=UploadConfig.load(args.upload_config,require_token=not getattr(args,'prepare_only',False))
    tasks=[enqueue_run(run,config,queue_dir=args.queue_dir,reconciliation_date=args.reconciliation_date,
                       shop_id=getattr(args,'shop_id',None)) for run in runs]
    if getattr(args,'prepare_only',False):return {'prepared':True,'tasks':tasks}
    delivery=drain_queue(config,queue_dir=args.queue_dir,run_ids={t['local_run_id'] for t in tasks},
                         retry_failed=args.retry_failed,watch=args.watch)
    _finalize_delivery(delivery,config,args.queue_dir)
    return delivery


def _finalize_delivery(delivery,config,queue_dir):
    from .retention import finalize_queue
    delivery['retention']=[]
    for task in delivery['tasks']:
        if task['state']!='uploaded':continue
        cleanup=finalize_queue(config,queue_dir=queue_dir,runs_root=Path(task['report_path']).parent.parent,run_ids={task['local_run_id']})
        delivery['retention'].extend(cleanup['reports'])
        if not cleanup['ok']:delivery['ok']=False


def main(argv=None):
    args=parser().parse_args(argv)
    exit_code=0
    try:
        if args.command=='review':
            from .review import serve
            serve(args.root,port=args.port,run_roots=args.runs,expected_dir=args.expected_dir,template=args.template)
            return 0
        elif args.command=='shops':result=ShopDesk().shops()
        elif args.command=='upload-status':
            from .upload import queue_status
            result={'tasks':queue_status(args.queue_dir)}
        elif args.command=='cleanup-uploaded':
            from .retention import finalize_queue
            from .upload import UploadConfig
            result=finalize_queue(UploadConfig.load(args.upload_config),queue_dir=args.queue_dir,runs_root=args.runs_root,run_ids=set(args.run_id) if args.run_id else None)
            if not result['ok']:exit_code=3
        elif args.command=='monthly':
            from .monthly import monthly_run
            result=monthly_run(**{k:getattr(args,k) for k in ['month','scheduled','dry_run','state_dir','output','template','queue_dir','upload_config','retry_failed','retry_incomplete']})
            if result.get('ok') is False:exit_code=3
        elif args.command=='schedule':
            from .scheduler import install,status
            result=install(args.root) if args.install else status(args.root)
        elif args.command=='upload':
            result=_upload_runs(args,args.run)
            if result.get('ok') is False:exit_code=3
        elif args.command=='upload-queue':
            from .upload import UploadConfig,drain_queue
            config=UploadConfig.load(args.upload_config)
            result=drain_queue(config,queue_dir=args.queue_dir,retry_failed=args.retry_failed,watch=args.watch)
            _finalize_delivery(result,config,args.queue_dir)
            if not result['ok']:exit_code=3
        elif args.command=='export-grid':
            result=grid_page(args.run/'tables.sqlite',args.table,args.offset,args.limit)
            if args.output:
                args.output.parent.mkdir(parents=True,exist_ok=True)
                args.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
                result={'output':str(args.output),'rows':len(result['rows']),'next_offset':result['next_offset']}
        else:
            options={k:getattr(args,k) for k in ['month','shop_name','output','template','shopdesk_shop_uuid','platform_shop_id','shop_id','reconciliation_date']}
            if args.upload:
                # Fail before expensive collection when required config/date is missing.
                from .upload import UploadConfig,business_date
                UploadConfig.load(args.upload_config)
                if args.reconciliation_date:business_date(args.reconciliation_date)
            if args.command=='import':
                if not args.source and not args.manifest:raise DataError('provide --source or --manifest')
                if not args.shop_name:raise DataError('--shop-name is required for import')
                bindings={}
                for spec in args.account:
                    if '=' not in spec:raise DataError('--account must be SHEET=ACCOUNT')
                    key,value=spec.split('=',1);bindings[key]=value
                balances=json.loads(args.balances.read_text()) if args.balances else None
                result=build(args.source,bindings=bindings,balances=balances,mapping=args.mapping,manifest_path=args.manifest,**options)
            else:
                from .collect import collect_and_build
                result=collect_and_build(kinds=args.kinds.split(','),resume=args.resume,**options)
            if result.get('upload_ready') is False:exit_code=3
            if args.upload:
                try:result['cloud_upload']=_upload_runs(args,[Path(result['run_dir'])])
                except (DataError,OSError,ValueError) as exc:
                    result['cloud_upload']={'ok':False,'error':str(exc)}
                if not result['cloud_upload'].get('ok'):exit_code=3
        print(json.dumps(result,ensure_ascii=False,indent=2))
        return exit_code
    except (DataError,ShopDeskError,ValueError,OSError) as exc:
        print(json.dumps({'error':str(exc),'type':type(exc).__name__},ensure_ascii=False),file=sys.stderr)
        return 2


if __name__=='__main__':raise SystemExit(main())
