#!/usr/bin/env python3
"""Inventory, offline verification and non-overwriting migration of ShopDesk sources."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import sys

ROOT = Path(__file__).resolve().parents[1]
SOURCE_HOME = '/Users/zhaoxiaozhong'
COMPONENTS = [
    'shopdesk-workbench-src', 'doudian-daily', 'jushuitan-aftersales',
    'jushuitan-order-page', 'jushuitan-order-details', 'jushuitan-inventory-warning',
    'jushuitan-sales-performance', 'jushuitan-profit-facts',
    'projects/xdr-sync-agent', 'projects/shopdesk-aftersale',
    'projects/feige-customer-daily', 'projects/douyin-commission-rates',
    'projects/douyin-settle-recon', 'projects/invoice-mac-agent',
]
CLI = {
    'jst-inventory': 'jushuitan-inventory-warning/bin/jst-inventory.js',
    'jst-orders': 'jushuitan-order-details/bin/jst-orders.js',
    'jst-order-page': 'jushuitan-order-page/bin/jst-order-page.js',
    'jst-sales': 'jushuitan-sales-performance/bin/jst-sales.js',
    'jst-aftersales': 'jushuitan-aftersales/bin/jst-aftersales.js',
    'jst-purple-orders': 'doudian-daily/jst_purple_orders.py',
    'xdr-sync-agent': 'projects/xdr-sync-agent/bin/xdr-sync-agent.js',
}


def verify():
    errors = []
    manifest = json.loads((ROOT/'docs/source-manifest.json').read_text())
    for row in manifest['files']:
        p = ROOT/row['path']
        if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest() != row['sha256']:
            errors.append(row['path'])
    for f in (ROOT/'schedules').glob('*.plist'):
        plistlib.loads(f.read_bytes())
    print(json.dumps({'source_files': len(manifest['files']), 'errors': errors}, ensure_ascii=False))
    return bool(errors)


def prepare(home, apply):
    # Resolve paths before planning so symlinks and custom home locations are explicit.
    home = Path(home).expanduser().resolve()
    destinations = [home/n for n in COMPONENTS]
    destinations += [home/'xdr-sync-agent'] + [home/'.local/bin'/n for n in CLI]
    collisions = [str(p) for p in destinations if p.exists() or p.is_symlink()]
    print(json.dumps({'target_home': str(home), 'components': COMPONENTS,
                      'collisions': collisions, 'apply': apply}, ensure_ascii=False, indent=2))
    if collisions:
        print('存在目标目录或命令；未写入任何文件。请使用新电脑或独立的 --home 目录。', file=sys.stderr)
        return 1
    if not apply:
        print('预览完成；加 --apply 才复制源码。不会加载定时任务、启动应用或上传数据。')
        return 0
    for name in COMPONENTS:
        target = home/name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(ROOT/'components'/name, target)
        for f in target.rglob('*'):
            if not f.is_file():
                continue
            try:
                text = f.read_text()
            except (UnicodeError, OSError):
                continue
            if SOURCE_HOME in text:
                f.write_text(text.replace(SOURCE_HOME, str(home)))
    (home/'xdr-sync-agent').symlink_to(home/'projects/xdr-sync-agent', target_is_directory=True)
    bindir = home/'.local/bin'
    bindir.mkdir(parents=True, exist_ok=True)
    for name, source in CLI.items():
        target = home/source
        target.chmod(target.stat().st_mode | 0o111)
        (bindir/name).symlink_to(target)
    # Stage wrappers separately for review; keep the real ShopDesk profile untouched.
    staged = home/'shopdesk-runtime-wrappers'
    if not staged.exists():
        shutil.copytree(ROOT/'runtime-wrappers', staged)
        for f in staged.glob('*.sh'):
            f.write_text(f.read_text().replace(SOURCE_HOME, str(home)))
    print('源码和CLI已就位。接下来按 docs/MIGRATION.md 配置依赖、登录与云端连接。')
    return 0


def render_schedules(home, output):
    output = Path(output).expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    files = list((ROOT/'schedules').glob('*.plist'))
    if any((output/f.name).exists() for f in files):
        raise SystemExit('输出目录已有同名文件；未覆盖。')
    node = shutil.which('node') or '__NODE__'
    for f in files:
        # Re-serialize so special characters in paths stay valid XML.
        def expand(v):
            if isinstance(v, str):
                return v.replace('__HOME__', str(Path(home).expanduser().resolve())).replace('__NODE__', node)
            if isinstance(v, list): return [expand(x) for x in v]
            if isinstance(v, dict): return {k: expand(x) for k, x in v.items()}
            return v
        (output/f.name).write_bytes(plistlib.dumps(expand(data)))
    print(f'已生成 {len(files)} 个待审核任务定义：{output}。尚未安装或加载。')


def doctor(home):
    home = Path(home).expanduser()
    checks = {'node': shutil.which('node'), 'python3': shutil.which('python3'),
              'uv': shutil.which('uv'), 'ssh': shutil.which('ssh'),
              'shopdesk_app': (home/'店铺工作台.app').is_dir(),
              'shopdesk_profile': (home/'Library/Application Support/shopdesk/shops.json').is_file(),
              'shopdesk_bridge': (home/'Library/Application Support/shopdesk/agent-bridge.json').is_file(),
              'xdr_config': (home/'.config/xdr-sync-agent/config.json').is_file(),
              'ssh_key': (home/'.ssh/xdr_mac').is_file(),
              'finance_template': (home/'projects/douyin-settle-recon/doc/【抖音】月度账单处理模版.xlsx').is_file()}
    print(json.dumps(checks, ensure_ascii=False, indent=2))
    print('仅检查文件存在和命令路径；没有读取凭据、联网或执行采集。')
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('inventory')
    sub.add_parser('verify')
    p = sub.add_parser('prepare'); p.add_argument('--home', default=str(Path.home())); p.add_argument('--apply', action='store_true')
    p = sub.add_parser('doctor'); p.add_argument('--home', default=str(Path.home()))
    p = sub.add_parser('render-schedules'); p.add_argument('--home', default=str(Path.home())); p.add_argument('--output', required=True)
    args = parser.parse_args()
    if args.command == 'verify': return verify()
    if args.command == 'inventory':
        print('\n'.join(COMPONENTS)); return 0
    if args.command == 'prepare': return prepare(args.home, args.apply)
    if args.command == 'doctor': return doctor(args.home)
    if args.command == 'render-schedules': return render_schedules(args.home, args.output)


if __name__ == '__main__':
    sys.exit(main() or 0)
