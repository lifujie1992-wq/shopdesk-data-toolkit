#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Bridge, CliError } from '../src/bridge.js';
import { readPage } from '../src/page.js';
import { saveSnapshot, loadSnapshot, schemaOf, writePrivate } from '../src/storage.js';
import { render } from '../src/render.js';
import { DEFAULT_DAY_PAGE_SIZE, PAGE_SIZES, syncDay } from '../src/day-sync.js';
import { syncUnshipped, UNSHIPPED_PAGE_SIZE } from '../src/unshipped-sync.js';

const HELP = `Usage: jst-order-page <command> [options]

Read 聚水潭「常用 → 订单」and「详 → 销售订单详情」.
Uses the existing logged-in Chrome tab through OpenBridge.

Commands:
  login-status                 Verify a real list request
  list                         Query list; stdout omits private fields
  count                        Read actual total for current filters or --id
  detail --id INTERNAL_ID      Fetch list + full detail + payments/items/logs/aftersales
  capture                      Capture a bounded page including every detail
  sync-day                     Sync today's list to SQLite (max 100000 orders)
  sync-unshipped               Sync all currently unshipped orders to SQLite
                               (waitpay/waitconfirm/delivering/waitoutersent/question)
  schema --input FILE          Inspect all captured field paths and types
  render --input FILE          Generate an offline order page with detail dialog

Options:
  --id ID                      Internal order number, decimal digits
  --limit N                    Default 20; list max 2000; capture max 20
  --page N                     Page index, default 1
  --date YYYY-MM-DD            sync-day date, default today in Asia/Shanghai
  --date-field NAME            sync-day filter: order_date (default) or pay_date
  --page-size N                sync-day page size, default/max 2000
  --settle-minutes N           today cutoff lag, default 0; avoids late payment backfill drift
  --filters FILE               JSON array [{k,v,c,t?}]; otherwise current page filters
  --output FILE                Save .json or .sqlite (permissions 0600)
  --input FILE                 Existing JSON/SQLite snapshot
  --help, -h                   Help on every command

detail/capture default output: ./jst-order-page.json
render default output: ./jst-order-page.html
All fields are preserved in files; this is a bounded snapshot, not a full sync.
sync-day stores at most 100000 list rows, streams pages, and never opens「详」.
No order write operations are implemented.`;

function positive(value, fallback, max) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new CliError('invalid_arguments', `数值必须为 1–${max} 的整数。`);
  return n;
}
function required(v, name) { if (!v) throw new CliError('invalid_arguments', `必须指定 ${name}。`); return v; }
async function main() {
  if (process.argv.slice(2).some(a => a === '--help' || a === '-h') || process.argv.length === 2) { console.log(HELP); return; }
  const { positionals, values: v } = parseArgs({ allowPositionals: true, options: Object.fromEntries(['id','limit','page','filters','output','input','date','date-field','page-size','settle-minutes'].map(k => [k, { type: 'string' }])) });
  const [command] = positionals;
  if (positionals.length !== 1 || !['login-status','list','count','detail','capture','sync-day','sync-unshipped','schema','render'].includes(command)) throw new CliError('invalid_arguments', '未知命令；请运行 --help。');
  if (v.id && !/^\d{1,20}$/.test(v.id)) throw new CliError('invalid_arguments', '--id 必须是内部订单号。');
  if (command === 'sync-unshipped') {
    const pageSize = v['page-size'] === undefined ? UNSHIPPED_PAGE_SIZE : Number(v['page-size']);
    if (!Number.isSafeInteger(pageSize) || !PAGE_SIZES.includes(pageSize)) {
      throw new CliError('invalid_arguments', `--page-size 只支持 ${PAGE_SIZES.join('/')}。`);
    }
    const settleMinutes = v['settle-minutes'] === undefined ? 0 : Number(v['settle-minutes']);
    if (!Number.isSafeInteger(settleMinutes) || settleMinutes < 0 || settleMinutes > 60) {
      throw new CliError('invalid_arguments', `--settle-minutes 只支持 0–60 的整数。`);
    }
    const bridge = new Bridge({ session: 'jst-unshipped-orders' });
    await bridge.connect({ dedicated: true });
    const now = new Date(Date.now() - settleMinutes * 60_000);
    return bridge.withPageRecovery(() => syncUnshipped({
      bridge,
      pageSize,
      output: v.output || 'jst-order-unshipped.sqlite',
      now,
      onProgress: progress => process.stderr.write(`[sync-unshipped] ${progress.page}/${progress.pageCount} pages, ${progress.fetched}/${progress.expected} orders task=${bridge.session} browser=${bridge.browserSessionId} tab=${bridge.tabId}\n`),
    }));
  }
  if (command === 'schema' || command === 'render') {
    const snapshot = loadSnapshot(required(v.input, '--input'));
    if (command === 'render') return { output: render(snapshot, v.output || 'jst-order-page.html'), rows: snapshot.rows.length, details: snapshot.details.length };
    const schema = schemaOf(snapshot);
    return v.output ? { output: writePrivate(v.output, JSON.stringify(schema, null, 2) + '\n'), fields: schema.fields.length } : schema;
  }
  if (command === 'detail') required(v.id, '--id');
  if (command === 'sync-day') {
    const pageSize = v['page-size'] === undefined ? DEFAULT_DAY_PAGE_SIZE : Number(v['page-size']);
    if (!Number.isSafeInteger(pageSize) || !PAGE_SIZES.includes(pageSize)) {
      throw new CliError('invalid_arguments', `--page-size 只支持 ${PAGE_SIZES.join('/')}。`);
    }
    const settleMinutes = v['settle-minutes'] === undefined ? 0 : Number(v['settle-minutes']);
    if (!Number.isSafeInteger(settleMinutes) || settleMinutes < 0 || settleMinutes > 60) {
      throw new CliError('invalid_arguments', '--settle-minutes 只支持 0–60 的整数。');
    }
    const bridge = new Bridge({ session: 'jst-paid-orders' });
    await bridge.connect({ dedicated: true });
    const now = new Date(Date.now() - settleMinutes * 60_000);
    return bridge.withPageRecovery(() => syncDay({
      bridge,
      date: v.date,
      dateField: v['date-field'] || 'order_date',
      pageSize,
      output: v.output || 'jst-order-today.sqlite',
      now,
      onProgress: progress => process.stderr.write(`[sync-day] ${progress.page}/${progress.pageCount} pages, ${progress.fetched}/${progress.expected} orders task=${bridge.session} browser=${bridge.browserSessionId} tab=${bridge.tabId}\n`),
    }));
  }
  const limit = command === 'detail' || command === 'login-status' ? 1 : positive(v.limit, 20, command === 'list' ? 2000 : 20);
  const page = positive(v.page, 1, 1000000);
  let filters;
  if (v.filters) {
    filters = JSON.parse(readFileSync(v.filters, 'utf8'));
    if (!Array.isArray(filters) || filters.some(f => !f || typeof f.k !== 'string' || typeof f.c !== 'string' || !Object.hasOwn(f, 'v'))) throw new CliError('invalid_arguments', '筛选文件必须是 [{k,v,c,t?}] 数组。');
  }
  const bridge = new Bridge();
  await bridge.connect();
  const snapshot = await bridge.run(readPage, { command, id: v.id, limit, page, filters });
  if (command === 'login-status' || command === 'count') return snapshot;
  const output = v.output || (command === 'list' ? null : 'jst-order-page.json');
  const result = { rows: snapshot.rows.length, details: snapshot.details.length, captured_at: snapshot.captured_at, pagination: snapshot.pagination };
  if (output) result.output = saveSnapshot(output, snapshot);
  else result.orders = snapshot.rows.map(r => Object.fromEntries(['o_id','status','shop_name','order_date','pay_date','paid_amount'].map(k => [k, r[k]])));
  return result;
}
try { const data = await main(); if (data !== undefined) console.log(JSON.stringify({ ok: true, data })); }
catch (e) { console.log(JSON.stringify({ ok: false, error: { code: e.code || 'internal_error', message: e.message } })); process.exitCode = 1; }
