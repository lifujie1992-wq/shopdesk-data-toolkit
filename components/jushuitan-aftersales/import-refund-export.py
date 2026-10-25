#!/usr/bin/env python3
"""把聚水潭「退款单」（退货退款）导出结果增量并入本地事实源库。

用途：xdr-sync-agent 的 profit_facts 任务读取 ~/jst-refund-export.sqlite，
      本脚本负责把每天导出的 Excel 增/改并入该库。

用法：
  python3 import-refund-export.py <退款单导出.xlsx> [输出sqlite]

语义：
  - 主键 = 内部退款号（唯一）；同一售后单多笔退款会保留多行。
  - 只有「状态=完成」才写入实际退款金额；其余只记申请金额并标 pending。
  - 重复导入同一文件是幂等的（INSERT OR REPLACE）。
  - 不修改任何聚水潭数据，只读取导出文件。
"""
import datetime
import re
import sqlite3
import sys
from pathlib import Path

from fastexcel import read_excel

COLS = ['店铺', '内部退款号', '退款时间', '审核时间', '修改时间', '内部订单号', '线上订单号',
        '货物状态', '退款单号', '原订单已付金额', '金额', '状态', '退款方式', '售后单号',
        '售后分类', '售后问题类型', '售后备注', '原订单备注', '分销商', '余额']

SCHEMA = '''
CREATE TABLE IF NOT EXISTS aftersale_details (
 "售后单号" TEXT PRIMARY KEY, "关联订单号" TEXT, "关联原始订单号" TEXT,
 "平台售后单号" TEXT, "店铺名称" TEXT, "所属平台" TEXT, "售后类型" TEXT,
 "ERP售后状态" TEXT, "平台售后状态" TEXT, "售后申请时间" TEXT,
 "ERP售后创建时间" TEXT, "售后更新时间" TEXT, "退款成功时间" TEXT,
 "退款金额" TEXT, "实际退款金额" TEXT, "原订单是否付款" TEXT,
 "原订单是否发货" TEXT, "售后申请原因" TEXT, "问题原因" TEXT, "备注" TEXT,
 "原订单备注" TEXT, "原订单标签" TEXT, "售后标签" TEXT, "原订单类型" TEXT,
 "线上类型" TEXT, "业务类型" TEXT, "退款阶段" TEXT,
 "买家实际寄回件数" TEXT, "销退实际入库件数" TEXT, "可再次销售件数" TEXT,
 "次品件数" TEXT, "尚未退回件数" TEXT, "退回仓库名称" TEXT, "退回仓库类型" TEXT,
 "原订单当前状态" TEXT, "原订单下单时间" TEXT, "原订单付款时间" TEXT,
 "原订单实际发货时间" TEXT, "订单来源渠道" TEXT, "订单物流签收时间" TEXT,
 "退货物流公司" TEXT, "退货物流状态" TEXT, "原订单仓库" TEXT,
 "退款单号" TEXT, "退款方式" TEXT
);
CREATE TABLE IF NOT EXISTS aftersale_item_details (
 "售后单号" TEXT PRIMARY KEY, "售后商品明细编号" TEXT, "商品编码" TEXT, "SKU编码" TEXT,
 "套装或组合商品编码" TEXT, "退款金额" TEXT, "售后申请件数" TEXT,
 "买家实际寄回件数" TEXT, "销退实际入库件数" TEXT, "可再次销售件数" TEXT,
 "次品件数" TEXT, "尚未退回件数" TEXT, "商品名称" TEXT, "售后商品类型" TEXT
);
CREATE INDEX IF NOT EXISTS idx_refund_order ON aftersale_details("关联订单号");
CREATE INDEX IF NOT EXISTS idx_refund_time ON aftersale_details("售后申请时间");
'''


def s(v):
    return None if v is None else (str(v).strip() or None)


def num_id(v):
    x = s(v)
    if not x:
        return None
    return x.split('.')[0] if re.fullmatch(r'-?\d+\.0+', x) else x


def dt(v):
    x = s(v)
    if not x:
        return None
    for fmt in ('%Y/%m/%d %H:%M:%S', '%Y-%m-%d %H:%M:%S', '%Y/%m/%d %H:%M', '%Y-%m-%d %H:%M'):
        try:
            return datetime.datetime.strptime(x, fmt).strftime('%Y-%m-%d %H:%M:%S')
        except ValueError:
            continue
    return x.replace('/', '-')


def money(v):
    x = s(v)
    if not x:
        return None
    try:
        return f'{float(x):.2f}'
    except ValueError:
        return x


def main():
    if len(sys.argv) < 2:
        print('usage: import-refund-export.py <xlsx> [output sqlite]', file=sys.stderr)
        return 2
    src = Path(sys.argv[1]).expanduser()
    out = Path(sys.argv[2]).expanduser() if len(sys.argv) > 2 else Path.home() / 'jst-refund-export.sqlite'
    if not src.is_file():
        print(f'input not found: {src}', file=sys.stderr)
        return 2

    sheet = read_excel(str(src)).load_sheet('Sheet1', header_row=0, use_columns=COLS, eager=True)
    data = sheet.to_pydict()

    db = sqlite3.connect(out)
    db.executescript(SCHEMA)
    before = db.execute('SELECT COUNT(*) FROM aftersale_details').fetchone()[0]

    main_sql = 'INSERT OR REPLACE INTO aftersale_details VALUES (' + ','.join('?' * 45) + ')'
    item_sql = 'INSERT OR REPLACE INTO aftersale_item_details VALUES (' + ','.join('?' * 14) + ')'

    rows = 0
    seen = set()
    for values in zip(*(data[c] for c in COLS)):
        m = dict(zip(COLS, values))
        refund_id = num_id(m['内部退款号'])
        order_id = num_id(m['内部订单号'])
        # 跳过空行与 Excel 末尾的合计行（退款号/订单号为 0、无退款时间）
        if not refund_id or refund_id == '0' or refund_id in seen:
            continue
        if not order_id or order_id == '0' or not dt(m['退款时间']):
            continue
        seen.add(refund_id)
        state = s(m['状态'])
        amount = money(m['金额'])
        when = dt(m['退款时间'])
        paid = money(m['原订单已付金额'])
        completed = state == '完成'
        main = (refund_id, num_id(m['内部订单号']), s(m['线上订单号']), num_id(m['售后单号']),
                s(m['店铺']), None, s(m['售后分类']) or '普通退货', state, s(m['货物状态']),
                when, when, dt(m['修改时间']), when if completed else None,
                amount, amount if completed else None,
                '1' if paid and float(paid) > 0 else None,
                '1' if s(m['货物状态']) else None,
                s(m['售后问题类型']), s(m['售后问题类型']), s(m['售后备注']), s(m['原订单备注']),
                None, None, '普通订单', s(m['售后分类']), None, None,
                None, None, None, None, None, None, None, None, None, None, None,
                None, None, None, None, None, s(m['退款单号']), s(m['退款方式']))
        item = (refund_id, refund_id, None, None, None, amount, '1', None, None, None,
                None, None, None, s(m['售后分类']) or '普通退货')
        db.execute(main_sql, main)
        db.execute(item_sql, item)
        rows += 1

    db.commit()
    after = db.execute('SELECT COUNT(*) FROM aftersale_details').fetchone()[0]
    lo, hi = db.execute('SELECT MIN("售后申请时间"), MAX("售后申请时间") FROM aftersale_details').fetchone()
    db.close()
    print(f'parsed={rows} before={before} after={after} (net {after - before:+d})')
    print(f'window: {lo} ~ {hi}')
    print(f'output: {out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
