from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .bridge import ShopDesk, ShopDeskError
from .model import CaptureError, atomic_json
from .source import Buyin, collect, load_targets, plan_shops
from .store import Store, lock

ROOT=Path(__file__).resolve().parents[2]
DEFAULT_DB=ROOT/'data/jst-commission-rates.sqlite'


def parser():
    p=argparse.ArgumentParser(description='Mac 精选联盟商品链接佣金率采集（只读后台设置）')
    p.add_argument('--db',type=Path,default=DEFAULT_DB)
    sub=p.add_subparsers(dest='command',required=True)
    s=sub.add_parser('plan-shops',help='按 ERP 店铺名生成工作台映射候选')
    s.add_argument('--sales',type=Path,required=True);s.add_argument('--output',type=Path,required=True)
    s=sub.add_parser('targets',help='导出已发货抖音链接目标快照')
    s.add_argument('--facts',type=Path,required=True);s.add_argument('--output',type=Path,required=True)
    s=sub.add_parser('collect',help='新建历史批次或从事务检查点续抓')
    s.add_argument('--targets',type=Path);s.add_argument('--shops',type=Path)
    s.add_argument('--expected-links',type=int,default=70460,help='验收目标的最小独立链接数，默认沿用需求 70460')
    s.add_argument('--resume');s.add_argument('--shop',help='只执行一个 ERP shop_id，保留完整批次分母')
    s.add_argument('--max-tasks',type=int);s.add_argument('--interval',type=float,default=1.2)
    s=sub.add_parser('report');s.add_argument('--batch',required=True)
    s=sub.add_parser('sample');s.add_argument('--batch',required=True);s.add_argument('--output',type=Path,required=True)
    s=sub.add_parser('check-samples');s.add_argument('--batch',required=True);s.add_argument('--input',type=Path,required=True)
    s=sub.add_parser('accept');s.add_argument('--batch',required=True);s.add_argument('--reuse-review',help='复用同一采集器及店铺配置的首次人工验收 batch')
    s=sub.add_parser('publish',help='生成通过验收的完整历史快照和 manifest')
    s.add_argument('--batch',required=True);s.add_argument('--output-dir',type=Path,required=True)
    s.add_argument('--allow-partial',action='store_true',help='明确发布现有部分结果，保留 complete=0 和真实覆盖率')
    s.add_argument('--reason',help='部分结果发布原因')
    s=sub.add_parser('upload',help='校验并原子发布到数仓固定路径')
    s.add_argument('--snapshot',type=Path,required=True);s.add_argument('--config',type=Path,required=True)
    s=sub.add_parser('daily',help='每日续抓/创建批次，生成报告；验收完成后发布')
    s.add_argument('--config',type=Path,required=True)
    return p


def main(argv=None):
    args=parser().parse_args(argv)
    store=None
    try:
        if args.command=='plan-shops':
            result=plan_shops(args.sales,ShopDesk(),args.output)
        elif args.command=='targets':
            targets=load_targets(args.facts);atomic_json(args.output,{'source':str(args.facts),'targets':targets})
            result={'target_pairs':len(targets),'unique_links':len({r['platform_link_id'] for r in targets}),
                    'shops':len({r['shop_id'] for r in targets}),'output':str(args.output)}
        elif args.command=='upload':
            from .publish import upload
            result=upload(args.snapshot,json.loads(args.config.read_text()))
        elif args.command=='daily':
            from .daily import daily
            return daily(args.db,args.config)
        else:
            with lock(args.db):
                store=Store(args.db)
                if args.command=='collect':
                    if args.max_tasks is not None and args.max_tasks<=0:
                        raise CaptureError('max-tasks must be positive')
                    if args.resume:
                        if args.targets or args.shops: raise CaptureError('resume uses frozen targets and shops; omit both inputs')
                        batch=args.resume
                    else:
                        if not args.targets or not args.shops: raise CaptureError('new batch needs --targets and --shops')
                        config=json.loads(args.shops.read_text())
                        ids=[s['shop_id'] for s in config['shops']]
                        if len(ids)!=len(set(ids)): raise CaptureError('ambiguous duplicate ERP shop mapping')
                        batch=store.new_batch(load_targets(args.targets),config,str(args.targets),args.expected_links)
                    print(json.dumps({'batch_id':batch}),flush=True)
                    result=collect(store,batch,Buyin(interval=args.interval),args.max_tasks,args.shop,ROOT/'data/runs'/batch)
                elif args.command=='report':
                    store.write_report(args.batch,ROOT/'data/runs'/args.batch);result=store.report(args.batch)
                elif args.command=='sample':
                    rows=store.sample(args.batch,args.output);result={'sample_count':len(rows),'output':str(args.output)}
                elif args.command=='check-samples':
                    store.import_checks(args.batch,args.input);result=store.report(args.batch)
                elif args.command=='accept': result=store.accept(args.batch,args.reuse_review)
                elif args.command=='publish':
                    from .publish import snapshot
                    result=snapshot(store,args.batch,args.output_dir,allow_partial=args.allow_partial,reason=args.reason)
        print(json.dumps(result,ensure_ascii=False,indent=2))
        if args.command=='collect' and (result['pending_tasks'] or result['coverage']<.98): return 2
        return 0
    except (CaptureError,ShopDeskError,ValueError,OSError) as exc:
        print(json.dumps({'ok':False,'error':str(exc)},ensure_ascii=False),file=sys.stderr)
        return 1
    finally:
        if store: store.close()


if __name__=='__main__':
    sys.exit(main())
