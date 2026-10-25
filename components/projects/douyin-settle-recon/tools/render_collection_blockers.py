"""Build a portable Excel audit with embedded, linked screenshot evidence."""
from __future__ import annotations

import argparse
from datetime import datetime
import hashlib
import json
import math
from pathlib import Path
import sys

import xlsxwriter
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from audit_collection_blockers import PAGES, STATUS, action_for


def load_reports(root):
    listing = json.loads((root / 'shops.json').read_text())
    reports = []
    for shop in listing['shops']:
        path = root / 'shops' / shop['id'] / 'audit.json'
        if not path.is_file():
            raise ValueError('Audit is incomplete: missing shop ' + shop['name'])
        report = json.loads(path.read_text())
        roles = [x['role'] for x in report['roles']]
        if not report.get('complete') or len(roles) != len(PAGES) or set(roles) != set(PAGES):
            raise ValueError('Audit is incomplete: missing/duplicate sources for ' + shop['name'])
        reports.append(report)
    if not reports:
        raise ValueError('Audit is incomplete: no shops')
    return listing, reports


def render(root, output):
    listing, reports = load_reports(root)
    output.parent.mkdir(parents=True, exist_ok=True)
    wb = xlsxwriter.Workbook(output, {'strings_to_formulas': False, 'strings_to_urls': False})
    head = wb.add_format({'bold': True, 'bg_color': '#193653', 'font_color': 'white', 'text_wrap': True, 'valign': 'vcenter', 'border': 1})
    base = wb.add_format({'text_wrap': True, 'valign': 'top', 'border': 1, 'border_color': '#D9E2F3'})
    error = wb.add_format({'text_wrap': True, 'valign': 'top', 'bg_color': '#FCE4D6', 'border': 1, 'border_color': '#D9E2F3'})
    warn = wb.add_format({'text_wrap': True, 'valign': 'top', 'bg_color': '#FFF2CC', 'border': 1, 'border_color': '#D9E2F3'})
    good = wb.add_format({'text_wrap': True, 'valign': 'top', 'bg_color': '#E2F0D9', 'border': 1, 'border_color': '#D9E2F3'})
    title = wb.add_format({'bold': True, 'font_size': 14, 'font_color': '#193653', 'text_wrap': True})
    notes = wb.add_worksheet('排查说明与统计')
    overview = wb.add_worksheet('全部店铺')
    blockers = wb.add_worksheet('抓取阻塞清单')
    unopened = wb.add_worksheet('未开通账户')
    detail = wb.add_worksheet('逐来源检查结果')
    entities = wb.add_worksheet('主体及千川账户明细')
    retries = wb.add_worksheet('超时及下载重试记录')
    evidence = wb.add_worksheet('截图证据')
    evidence.set_column(0, 0, 32)
    evidence.set_column(1, 13, 12)
    evidence.set_default_row(20)
    evidence_cursor = 0
    evidence_rows = {}
    issues = [(r, issue) for r in reports for issue in r['issues']]
    category = {code: sorted({r['shop']['name'] for r, issue in issues if issue['status'] == code})
                for code in ['permission', 'real_name', 'login', 'verification', 'download', 'validation', 'period_missing', 'qianchuan_not_opened', 'empty_table', 'unconfirmed']}

    def add_evidence(path, shop, label, reason):
        nonlocal evidence_cursor
        path = Path(path) if path else None
        if not path or not path.is_file():
            return None
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        # Permission screens can be pixel-identical across shops. Keep a
        # separate caption/anchor so every row links to its own shop's proof.
        key = (shop, label, digest)
        if key in evidence_rows:
            return evidence_rows[key]
        start = evidence_cursor
        with Image.open(path) as im:
            width, height = im.size
        scale = min(1.0, 1100 / width)
        evidence.merge_range(start, 0, start, 13, shop + '｜' + label, title)
        evidence.set_row(start, 32)
        evidence.merge_range(start + 1, 0, start + 2, 13, reason, base)
        evidence.insert_image(start + 4, 0, str(path), {'x_scale': scale, 'y_scale': scale,
                              'object_position': 3, 'description': shop + ' ' + label + ' 官方页面截图'})
        evidence_cursor = start + 6 + math.ceil(height * scale / (20 * 4 / 3))
        evidence_rows[key] = start
        return start

    def link(sheet, row, col, anchor, missing='截图未取得，见原因'):
        if anchor is None:
            sheet.write(row, col, missing, warn)
        else:
            sheet.write_url(row, col, "internal:'截图证据'!A" + str(anchor + 1), string='查看截图')

    notes.set_column(0, 0, 28)
    notes.set_column(1, 1, 125)
    summary = [
        ('检查范围', f"当前 ShopDesk 工作台全部 {len(reports)} 个抖店登录记录；按 UUID 逐店检查，非全平台店铺名单"),
        ('检查月份', listing['month']),
        ('检查开始', min(r['started_at'] for r in reports)),
        ('检查结束', max(r['finished_at'] for r in reports)),
        ('实际检查项', '资金账单、结算账单、基础保证金、体验保证金、管家账户（各可见主体）、涉税信息报送数据（各可见主体）、千川账户（全部可见绑定账户）'),
        ('检查方式', '调用项目正式抓取函数，执行官方查询、生成或复用对应月份报表、实际下载；下载成功才标记“已实际下载”。千川同时执行正式文件格式与月份校验。受阻来源保留提示及现场截图，继续检查其他来源。'),
        ('完成的含义', '“全部来源完成”表示本次抓取检查未受阻，包含官方确认无流水或账户未开通的结果；不代表财务核对已通过。千川空报表不能证明历史月末余额为零。'),
        ('统计口径', '权限不足、账号未实名认证、登录失效、下载失败与页面／程序异常分别统计；同店可同时存在多类问题，分类家数不可相加。'),
        ('如何处理', '先筛选“抓取阻塞清单”；按店铺、来源、主体查看页面路径、官方提示和处理建议，点击“查看截图”在本 Excel 内查看现场证据。'),
        ('权限配置入口', '主账号／管理员→抖店→店铺→子账号管理→岗位管理，或账号管理→修改权限。实际需要访问的业务页面路径和具名权限点详见每行；千川资金权限可能还需在对应广告账户配置。'),
        ('未开通与无流水', '“当月无流水”有正式查询依据，不属于抓取故障；“账户未开通”单列，需按业务需要决定是否开通，未代为开通。'),
        ('证据边界', '权限／认证提示只说明当前账号、页面或主体的阻塞；解除第一层拦截后仍需复测深层页面。页面／程序异常不直接认定需要客户开权限。无法建立登录会话时如无截图会明确标注。'),
        ('本次云端操作', '本次为本地全面排查，不推送 56 家新报表到云端。'),
        ('全部来源完成店数', sum(not r['issues'] for r in reports)),
        ('存在阻塞店数', sum(bool(r['issues']) for r in reports)),
        ('阻塞明细项数', len(issues)),
    ]
    summary += [(STATUS[code] + '店数', len(names)) for code, names in category.items()]
    for row, (label, value) in enumerate(summary):
        notes.write(row, 0, label, head)
        notes.write(row, 1, value, base)
        notes.set_row(row, 60 if row in (4, 5, 8, 10) else 42)

    def setup(sheet, headers, widths):
        sheet.write_row(0, 0, headers, head)
        sheet.set_row(0, 38)
        sheet.freeze_panes(1, 1)
        sheet.set_default_row(80)
        for i, width in enumerate(widths):
            sheet.set_column(i, i, width)

    setup(overview, ['店铺名称', '整体结果', *[x[0] for x in PAGES.values()], '阻塞分类', '阻塞项数', '店铺UUID', '完成时间'],
          [30, 20] + [25] * 7 + [35, 12, 40, 28])
    issue_headers = ['店铺名称', '受阻数据来源', '主体／广告账户', '阻塞分类', '需要开通／复查的页面路径', '目前阻塞原因（页面原话优先）', '处理建议', '对应截图', '实际访问地址', '程序错误原文', '明确权限点', '检查时间', '店铺UUID']
    setup(blockers, issue_headers, [30, 22, 35, 24, 65, 80, 85, 18, 65, 70, 35, 28, 40])
    setup(unopened, ['店铺名称', '数据来源', '未开通主体', '实际状态', '页面路径', '说明', '对应截图', '店铺UUID'], [30, 22, 35, 20, 65, 85, 18, 40])
    setup(detail, ['店铺名称', '数据来源', '结果', '实际下载文件数', '各主体结果', '检查开始', '检查结束', '页面路径', '访问地址', '店铺UUID'], [30, 22, 30, 18, 80, 28, 28, 65, 65, 40])
    setup(entities, ['店铺名称', '数据来源', '主体／广告账户', '主体ID／广告账户ID', '结果', '错误／查询说明', '核验月份', '店铺UUID'], [30, 22, 40, 30, 25, 85, 18, 40])
    setup(retries, ['店铺名称', '数据来源', '主体／广告账户', '重试前原因', '目前结果', '原始现场截图', '原检查时间', '店铺UUID'], [30, 22, 40, 85, 45, 20, 28, 40])
    issue_row = unopened_row = detail_row = entity_row = 1
    retry_row = 1
    for index, report in enumerate(reports, 1):
        shop = report['shop']
        role_map = {x['role']: x for x in report['roles']}
        values = []
        for role in PAGES:
            checks = role_map[role]['receipts']
            states = list(dict.fromkeys(STATUS.get(x['status'], x['status']) for x in checks))
            if not role_map[role]['complete']:
                states = list(dict.fromkeys(STATUS[x['status']] for x in report['issues'] if x['role'] == role)) or ['来源未完成']
            values.append('；'.join(states))
        overview.write_row(index, 0, [shop['name'], STATUS['blocked'] if report['issues'] else STATUS['passed'], *values,
                           '；'.join(dict.fromkeys(STATUS[i['status']] for i in report['issues'])), len(report['issues']), shop['id'], report['finished_at']],
                           error if report['issues'] else good)
        for issue in report['issues']:
            role = issue['role']
            entity = issue.get('entity') or {}
            name = entity.get('name') or issue.get('advertiser_id') or '入口／当前账号（尚未进入主体）'
            anchor = add_evidence(issue.get('screenshot'), shop['name'], PAGES[role][0] + '｜' + name, issue['reason'])
            blockers.write_row(issue_row, 0, [shop['name'], PAGES[role][0], name, STATUS[issue['status']], issue.get('required_page_path') or PAGES[role][1],
                               issue['reason'], issue.get('action') or action_for(issue['status'], role), '',
                               issue.get('actual_url') or PAGES[role][2], issue.get('collector_error', ''),
                               '、'.join(issue.get('permission_points', [])), issue.get('checked_at', ''), shop['id']],
                               warn if issue['status'] == 'unconfirmed' else error)
            blockers.set_row(issue_row, 130)
            link(blockers, issue_row, 7, anchor, issue.get('screenshot_error', '截图未取得'))
            issue_row += 1
            if issue['status'] == 'qianchuan_not_opened':
                unopened.write_row(unopened_row, 0, [shop['name'], '千川账户', '入口未显示可用绑定账户', STATUS[issue['status']],
                                   issue['required_page_path'], issue['action'], '', shop['id']], warn)
                link(unopened, unopened_row, 6, anchor)
                unopened_row += 1
        collection = json.loads((root / 'shops' / shop['id'] / 'collection.json').read_text())
        for role, checked in role_map.items():
            receipts = checked['receipts']
            text = '；'.join((x.get('entity') or {}).get('name', '') + '：' + STATUS.get(x['status'], x['status']) for x in receipts)
            detail.write_row(detail_row, 0, [shop['name'], PAGES[role][0], '抓取完成' if checked['complete'] else '抓取受阻',
                             len(checked.get('downloaded_files', [])), text, checked.get('started_at', ''), checked.get('finished_at', ''),
                             PAGES[role][1], PAGES[role][2], shop['id']], good if checked['complete'] else error)
            detail_row += 1
            for receipt in receipts:
                entity = receipt.get('entity') or {}
                name = entity.get('name') or receipt.get('advertiser_id') or '当前账号／账户'
                identifier = str(entity.get('id') or receipt.get('advertiser_id') or '')
                query = receipt.get('query') or {}
                explanation = receipt.get('error') or (f"官方查询记录数：{query.get('total')}" if 'total' in query else '')
                if receipt['status'] == 'not_opened':
                    explanation = '官方页面明确显示“开通抖店钱包／去开通”，未代为开通'
                if role == 'qianchuan' and receipt['status'] == 'no_activity':
                    explanation = '官方同月日结查询返回0条；无可下载明细，未据此认定月末赠款／非赠款余额为0'
                entities.write_row(entity_row, 0, [shop['name'], PAGES[role][0], name, identifier,
                                   STATUS.get(receipt['status'], receipt['status']), explanation, listing['month'], shop['id']],
                                   warn if receipt['status'] == 'not_opened' else error if receipt['status'] == 'error' else good)
                entity_row += 1
                if receipt['status'] == 'not_opened':
                    shots = [s for s in collection.get('screenshots', []) if s.get('entity_name') == name and (s.get('wallet_balance') or {}).get('status') == 'not_opened']
                    anchor = add_evidence(shots[-1]['path'] if shots else '', shop['name'], '管家账户未开通｜' + name, explanation)
                    unopened.write_row(unopened_row, 0, [shop['name'], PAGES[role][0], name, '未开通（非权限拦截）', PAGES[role][1],
                                       action_for('not_opened', role), '', shop['id']], warn)
                    link(unopened, unopened_row, 6, anchor)
                    unopened_row += 1
        seen_retries = set()
        for history_path in report.get('retry_history', []):
            old = json.loads(Path(history_path).read_text())
            for issue in old['issues']:
                if issue['status'] not in {'unconfirmed', 'download'}:
                    continue
                if issue.get('actual_url', '').startswith('about:'):
                    # An early retry script initialization failure was local
                    # audit infrastructure, not evidence about this shop.
                    continue
                key = (issue['role'], (issue.get('entity') or {}).get('name'), issue.get('checked_at'))
                if key in seen_retries:
                    continue
                seen_retries.add(key)
                role = issue['role']
                name = (issue.get('entity') or {}).get('name') or issue.get('advertiser_id') or '入口／当前账号'
                anchor = add_evidence(issue.get('screenshot'), shop['name'], '重试前现场｜' + PAGES[role][0] + '｜' + name, issue['reason'])
                current = '已恢复：该来源重新实测完成' if role_map[role]['complete'] else '仍有阻塞：见“抓取阻塞清单”'
                retries.write_row(retry_row, 0, [shop['name'], PAGES[role][0], name, issue['reason'], current, '', issue.get('checked_at', ''), shop['id']],
                                  good if role_map[role]['complete'] else warn)
                link(retries, retry_row, 5, anchor, issue.get('screenshot_error', '截图未取得'))
                retry_row += 1
    for sheet, row, columns in [(overview, len(reports) + 1, 13), (blockers, issue_row, len(issue_headers)),
                                (unopened, unopened_row, 8), (detail, detail_row, 10), (entities, entity_row, 8), (retries, retry_row, 8)]:
        sheet.autofilter(0, 0, max(1, row - 1), columns - 1)
    wb.close()
    result = {'checked_at': datetime.now().astimezone().isoformat(), 'month': listing['month'],
              'shops': len(reports), 'source_checks': detail_row - 1, 'entity_checks': entity_row - 1,
              'blocked_shops': sum(bool(r['issues']) for r in reports), 'issue_count': len(issues),
              'passed_shops': [r['shop']['name'] for r in reports if not r['issues']], 'categories': category,
              'unopened_accounts': unopened_row - 1, 'embedded_screenshots': len(evidence_rows),
              'transient_retry_items': retry_row - 1,
              'missing_blocker_screenshots': sum(not Path(i.get('screenshot', '')).is_file() for _, i in issues),
              'workbook': str(output.resolve()), 'workbook_sha256': hashlib.sha256(output.read_bytes()).hexdigest()}
    output.with_suffix('.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    render(args.source.resolve(), args.output.resolve())
