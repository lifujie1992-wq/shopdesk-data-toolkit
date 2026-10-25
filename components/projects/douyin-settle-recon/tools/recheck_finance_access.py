"""Run a fresh workbench access audit and compare it with the previous audit."""
from collections import Counter
import csv
from datetime import datetime
import json
from pathlib import Path
import subprocess
import sys
import uuid

from audit_finance_access import PAGES, run
from render_access_audit import STATUS, render
from douyin_settle_recon.model import dump_json
from douyin_settle_recon.shopdesk import ShopDeskError


def main():
    project = Path(__file__).resolve().parents[1]
    stamp = datetime.now().strftime('%Y%m%dT%H%M%S') + '-' + uuid.uuid4().hex[:6]
    root = project / 'data' / ('access-recheck-' + stamp)
    output = root / 'results'
    print('重新检查当前工作台全部店铺，使用新的目录保存本次结果。', flush=True)
    print('检查页面访问、月度查询、主体切换及导出入口；本次不生成或下载账单。', flush=True)
    try:
        run(root)
    except (ShopDeskError, OSError, ValueError) as exc:
        print(f'未完成复查：{exc}', file=sys.stderr)
        return 1

    listing = json.loads((root / 'shops.json').read_text())['shops']
    output.mkdir(parents=True, exist_ok=True)
    historical = [json.loads(p.read_text()) for p in (project/'data/access-audit-20261018/shops').glob('*.json')]
    historical_by_name = {r['shop']['name']: r for r in historical}
    complete = []
    rows = []
    page_counts = Counter()
    unfinished = []
    for shop in listing:
        path = root / 'shops' / (shop['id'] + '.json')
        report = json.loads(path.read_text()) if path.exists() else {}
        pages = {p['role']: p for p in report.get('pages', [])}
        previous = project / 'data/access-audit-20261018/shops' / (shop['id'] + '.json')
        old = json.loads(previous.read_text()) if previous.exists() else historical_by_name.get(shop['name'], {})
        old_pages = {p['role']: p for p in old.get('pages', [])}
        if not report.get('complete') or len(pages) != len(PAGES):
            unfinished.append(shop['name'])
        if all(pages.get(role, {}).get('status') == 'accessible' for role, _, _ in PAGES):
            complete.append(shop)
        for role, label, _ in PAGES:
            page = pages.get(role, {})
            status = page.get('status', 'not_checked')
            page_counts[status] += 1
            old_status = old_pages.get(role, {}).get('status')
            rows.append([shop['name'], label, STATUS.get(old_status, '无历史记录'),
                         STATUS.get(status, '尚未检查'), page.get('reason', ''),
                         page.get('checked_at', '')])
    with (output / '本次与上次权限对照.csv').open('w', encoding='utf-8-sig', newline='') as stream:
        writer = csv.writer(stream)
        writer.writerow(['店铺', '页面', '10月18日状态', '本次状态', '本次提示', '本次检查时间'])
        writer.writerows(rows)
    summary = {'checked_at': datetime.now().astimezone().isoformat(),
               'shop_count': len(listing), 'page_status_counts': dict(page_counts),
               'all_pages_accessible_shops': complete, 'unfinished_shops': unfinished,
               'source': str(root),
               'scope': '页面访问、查询与导出入口；未验证账单生成和下载执行权限'}
    dump_json(output / '本次复查汇总.json', summary)
    if listing and not unfinished:
        render(root, output)
        target = output / f'{len(listing)}店财务采集权限与实名认证排查表.xlsx'
    else:
        target = output
    dump_json(project / 'data/access-recheck-latest.json', summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    subprocess.run(['/usr/bin/open', str(target)], check=False)
    return 1 if unfinished else 0


if __name__ == '__main__':
    raise SystemExit(main())
