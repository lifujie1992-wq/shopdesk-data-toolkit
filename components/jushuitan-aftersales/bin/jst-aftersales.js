#!/usr/bin/env node
// 聚水潭售后明细同步：jst-aftersales sync [--date YYYY-MM-DD] [--output PATH]
// 默认同步昨天（上海时区）的售后数据到 ~/jst-aftersales.sqlite。
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { yesterdayShanghai, ensureSchema, loadRows } from '../src/sync.js';
import { fetchAfterSales } from '../src/session.js';

function parseArgs(argv) {
  const out = { command: null, date: null, output: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') out.date = argv[++i];
    else if (a === '--output') out.output = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else rest.push(a);
  }
  out.command = rest[0];
  return out;
}

function assertDate(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error('日期格式必须为 YYYY-MM-DD');
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.toISOString().slice(0, 10) !== v) throw new Error('日期不合法');
  return v;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command || args.command !== 'sync') {
    console.log(`Usage: jst-aftersales sync [--date YYYY-MM-DD] [--output PATH]

同步聚水潭「售后(退货退款)」明细到本地 SQLite 数仓。
默认同步昨天（上海时区）。通过 OpenBridge 复用浏览器登录态。
`);
    return;
  }
  const date = args.date ? assertDate(args.date) : yesterdayShanghai();
  const output = args.output || join(homedir(), 'jst-aftersales.sqlite');

  const startedAt = new Date().toISOString();
  console.log(`[sync] 目标日期: ${date}  输出: ${output}`);

  const { total, rows } = await fetchAfterSales(date);
  console.log(`[sync] 抓取完成: ${date} 共 ${total} 条`);

  // 6. 落库
  const db = new DatabaseSync(output);
  ensureSchema(db);
  const itemRows = loadRows(db, rows);
  db.prepare(`INSERT OR REPLACE INTO sync_info (date, started_at, completed_at, duration_ms, total_rows, item_rows) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(date, startedAt, new Date().toISOString(), Date.now() - new Date(startedAt).getTime(), total, itemRows);
  db.close();

  console.log(`[sync] 落库完成: 主表 ${total} 行, 商品明细 ${itemRows} 行 → ${output}`);
  console.log(`[sync] done`);
}

main().catch(e => {
  console.error('[sync] 失败:', e.message);
  process.exit(1);
});
