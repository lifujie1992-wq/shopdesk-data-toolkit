#!/usr/bin/env node
/**
 * 聚水潭「退款单」每日自动导出 → 下载 → 入库 → 发布。
 *
 * 流程（全部在页面内完成，不依赖手工点击）：
 *   1. 复用/打开 ERP「退款单」页
 *   2. 按「退款时间」= 目标日 + 售后分类=普通退货 搜索，并校验条数上限
 *   3. 点「导出所有符合条件的单据」创建异步导出任务
 *   4. 到「导出记录」列表（页面内隐藏 iframe 内嵌 export_log.aspx）取本次任务的
 *      auto_id，轮询该任务状态直到文件生成，再取 OSS 下载地址
 *      —— 注意：新版退款页 Export() 只调 _ACP("ExportBySync")，响应里既无任务号、
 *      也不会回调全局 NewExportLogs()，任务号只能从导出记录列表反查。
 *   5. Node 侧下载 xlsx
 *   6. 调用 import-refund-export.py 幂等入库到 ~/jst-refund-export.sqlite
 *   7. 触发 xdr-sync-agent 的 sync_profit_facts 任务，发布到阿里云
 *
 * 用法：
 *   node export-refund-daily.mjs [--date YYYY-MM-DD] [--days N] [--skip-publish]
 *   默认 --date = 上海时区昨天；默认 --days 3，即每次重导最近 3 天（幂等，可捕获审核/状态回改）。
 */
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Bridge } from "./src/sync.js";
import { notifyTaskFailure, nativeRunId } from "../xdr-sync-agent/src/failure-alerts.js";

const execFileAsync = promisify(execFile);
const REFUND_URL = "https://www.erp321.com/app/order/refund/refund.aspx";
const IMPORTER = join(homedir(), "jushuitan-aftersales", "import-refund-export.py");
const PYTHON = join(homedir(), "xdr-sync-agent", ".venv", "bin", "python");
const DOWNLOAD_DIR = join(homedir(), "Library", "Application Support", "xdr-sync-agent", "downloads");
const AGENT = join(homedir(), "xdr-sync-agent", "bin", "xdr-sync-agent.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 失败告警（统一签名、去重及发送失败重试） ----------
async function notifyFailure(message) {
  try {
    await execFileAsync("osascript", [
      "-e", `display notification ${JSON.stringify(message)} with title "退款单导出失败" sound name "Glass"`,
    ], { timeout: 10_000 });
  } catch { /* 通知失败不影响主流程 */ }
  try {
    const result = await notifyTaskFailure({ id: nativeRunId('com.xdr.refund-daily') || `refund:${process.pid}:${Date.now()}`,
      task: 'com.xdr.refund-daily', reason: message, phase: '退款导出或入库', failed_at: new Date().toISOString(),
      log: join(homedir(), 'Library/Logs/xdr-refund-daily.err.log') });
    console.log('[refund] 飞书告警:', JSON.stringify(result));
  } catch {
    console.error('[refund] 飞书告警暂不可用');
  }
}

function parseArgs(argv) {
  const out = { date: null, days: 3, publish: true, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--date") out.date = argv[++i];
    else if (a === "--days") out.days = Number(argv[++i]);
    else if (a === "--skip-publish") out.publish = false;
    else if (a === "--keep-file") out.keep = true;
  }
  return out;
}

function shiftDate(iso, deltaDays) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + deltaDays * 86_400_000).toISOString().slice(0, 10);
}

function yesterdayShanghai(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now).map((x) => [x.type, x.value]));
  const d = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) - 86_400_000);
  return d.toISOString().slice(0, 10);
}

async function findRefundTab(bridge) {
  const tabs = (await bridge.command("browser_list_tabs", {}, bridge.sessionId)).tabs || [];
  return tabs.find((t) => (!t.ownerSessionId || t.ownerSessionId === bridge.task) && (t.url || "").includes("/app/order/refund/refund.aspx")) || null;
}

// ---------- 导出记录（用于反查任务号 auto_id） ----------
// 退款页自身的 Export() 不会把任务号回传，任务号只能从「导出记录」列表里反查。
// 这里在退款页内嵌一个隐藏 iframe 指向 export_log.aspx（同源），
// 直接复用它自己的 jTable / _ACP，避免切换标签页（OpenBridge 选标签偶发挂死）。
const LOG_PATH = "/app/common/export/export_log.aspx";
const LOG_FRAME_ID = "__xdr_export_log_frame";
const EXPORT_TYPE = "退款单";
// 供异常路径清理隐藏 iframe
let activeBridge = null;

const JS_ENSURE_FRAME = `(function(){
  var f = document.getElementById(${JSON.stringify(LOG_FRAME_ID)});
  if (!f) {
    f = document.createElement('iframe');
    f.id = ${JSON.stringify(LOG_FRAME_ID)};
    f.setAttribute('aria-hidden', 'true');
    f.style.cssText = 'width:1000px;height:700px;position:fixed;left:-10000px;top:0;border:0;';
    f.src = ${JSON.stringify(LOG_PATH)};
    document.body.appendChild(f);
    return 'created';
  }
  try { return (f.contentWindow && f.contentWindow.jTable && f.contentWindow.jTable.Rows) ? 'ready' : 'loading'; }
  catch (e) { return 'created'; }
})()`;

const JS_FRAME_READY = `(function(){
  var f = document.getElementById(${JSON.stringify(LOG_FRAME_ID)});
  if (!f || !f.contentWindow) return false;
  try { return !!(f.contentWindow.jTable && f.contentWindow.jTable.Rows); } catch (e) { return false; }
})()`;

const JS_TRIGGER_SEARCH = `(function(){
  var f = document.getElementById(${JSON.stringify(LOG_FRAME_ID)});
  if (!f || !f.contentWindow || !f.contentWindow.jTable) return 0;
  try { f.contentWindow.jTable.Search(); return 1; } catch (e) { return -1; }
})()`;

const JS_READ_ROWS = `(function(){
  var f = document.getElementById(${JSON.stringify(LOG_FRAME_ID)});
  if (!f || !f.contentWindow || !f.contentWindow.jTable) return JSON.stringify({ err: 'not-ready' });
  try {
    var rows = (f.contentWindow.jTable.Rows || []).map(function (r) {
      var d = r.Data || {};
      return {
        auto_id: String(d.auto_id || ''),
        file_name: String(d.file_name || ''),
        export_type: String(d.export_type || ''),
        created: String(d.created || ''),
        status: String(d.status || ''),
        progress: String(d.progress || ''),
        total_count: String(d.total_count || ''),
      };
    });
    return JSON.stringify({ rows: rows });
  } catch (e) { return JSON.stringify({ err: e.message }); }
})()`;

const JS_REMOVE_FRAME = `(function(){
  var f = document.getElementById(${JSON.stringify(LOG_FRAME_ID)});
  if (f) f.remove();
  return 1;
})()`;

function jsGetDownloadUrl(autoId) {
  return `(function(){
    var f = document.getElementById(${JSON.stringify(LOG_FRAME_ID)});
    var w = f && f.contentWindow;
    if (!w) return Promise.resolve(JSON.stringify({ err: 'no-frame' }));
    if (typeof w._ACP !== 'function' && typeof w._ACUHW !== 'function') {
      return Promise.resolve(JSON.stringify({ err: 'no-call-api' }));
    }
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () { if (!done) { done = true; resolve(JSON.stringify({ timeout: true })); } }, 25000);
      function finish(rv) {
        if (done) return;
        done = true; clearTimeout(timer);
        resolve(JSON.stringify({ url: rv ? String(rv) : null }));
      }
      try {
        if (typeof w._ACP === 'function') w._ACP('CheckAndGetExportData', finish, ${Number(autoId)});
        else w._ACUHW(${JSON.stringify(LOG_PATH)}, 'GetExportData', finish, ${Number(autoId)});
      } catch (e) {
        if (!done) { done = true; clearTimeout(timer); resolve(JSON.stringify({ err: e.message })); }
      }
    });
  })()`;
}

async function ensureLogFrame(bridge) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const st = await bridge.evaljs(JS_ENSURE_FRAME);
    if (st === "ready") return;
    for (let i = 0; i < 30; i += 1) {
      await sleep(1000);
      if (await bridge.evaljs(JS_FRAME_READY)) return;
    }
  }
  throw new Error("「导出记录」内嵌页加载失败");
}

async function removeLogFrame(bridge) {
  try { await bridge.evaljs(JS_REMOVE_FRAME); } catch { /* 忽略清理失败 */ }
}

async function readLogRows(bridge) {
  await bridge.evaljs(JS_TRIGGER_SEARCH);
  await sleep(4000);
  const raw = await bridge.evaljs(JS_READ_ROWS);
  try { return JSON.parse(raw); } catch { return { err: "bad-payload" }; }
}

// 导出记录列表里，取「本次新产生」的退款单任务（排除导出前已存在的 auto_id）
async function waitForNewTask(bridge, beforeIds, deadlineMs) {
  let lastErr = "";
  while (Date.now() < deadlineMs) {
    const r = await readLogRows(bridge);
    if (!r.err) {
      const hit = (r.rows || []).find((x) => x.export_type === EXPORT_TYPE && x.auto_id && !beforeIds.has(x.auto_id));
      if (hit) return hit;
    } else {
      lastErr = r.err;
    }
    await sleep(2000);
  }
  throw new Error(`未在「导出记录」中找到本次导出任务${lastErr ? "（" + lastErr + "）" : ""}`);
}

const FAILED_STATUS = ["生成文件失败", "已取消", "已删除", "已过期"];

async function waitForFileReady(bridge, autoId, deadlineMs) {
  let last = "";
  while (Date.now() < deadlineMs) {
    const r = await readLogRows(bridge);
    if (!r.err) {
      const row = (r.rows || []).find((x) => x.auto_id === String(autoId));
      if (row) {
        last = row.status || "";
        if (last && last !== "正在生成文件") {
          if (FAILED_STATUS.some((s) => last.includes(s))) throw new Error(`导出任务失败：${last}`);
          if (/等待下载|文件已生成|正在下载|下载完成/.test(last)) return row;
        }
      }
    }
    await sleep(3000);
  }
  throw new Error(`等待导出文件超时（最后状态：${last || "未知"}）`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const end = args.date || yesterdayShanghai();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) throw new Error("日期格式必须为 YYYY-MM-DD");
  const start = shiftDate(end, -(Math.max(1, args.days) - 1));
  console.log(`[refund] 导出区间 ${start} ~ ${end}（售后分类=普通退货）`);

  const bridge = new Bridge({ task: "jst-refund-daily" });
  activeBridge = bridge;
  await bridge.findSession();

  let tab = await findRefundTab(bridge);
  if (!tab) {
    const created = await bridge.command("browser_new_tab", { url: REFUND_URL }, bridge.sessionId);
    console.log(`[refund] 已打开退款单页 tab=${created.tabId}`);
    await sleep(9000);
    tab = { tabId: created.tabId };
  }
  await bridge.command("browser_select_tab", { tabId: tab.tabId }, bridge.sessionId);

  // 等待页面就绪
  for (let i = 0; i < 30; i += 1) {
    const ok = await bridge.evaljs(
      "!!(window.jTable && jTable.Data && jTable.Data.dp && document.getElementById('Tool_Export'))", undefined,
    ).catch(() => false);
    if (ok) break;
    await sleep(2000);
  }

  // 1) 设置筛选并搜索
  await bridge.evaljs(`(function(){
    document.getElementById('date1').value=${JSON.stringify(start)};
    document.getElementById('date2').value=${JSON.stringify(end)};
    document.getElementById('astype_check_v').value='普通退货';
    document.querySelector('a.btn_search').click();
    return 1;
  })()`);
  await sleep(7000);

  const count = Number(await bridge.evaljs("jTable.Data.dp.DataCount"));
  const maxRows = Number(await bridge.evaljs("parseInt(__ExportMaxCount)*10000"));
  console.log(`[refund] 命中 ${count} 条（导出上限 ${maxRows}）`);
  if (!Number.isFinite(count) || count < 0) throw new Error("计数失败");
  if (count === 0) {
    console.log("[refund] 区间内无数据，跳过");
    return;
  }
  if (count > maxRows) throw new Error(`超过单次导出上限：${count} > ${maxRows}`);

  // 2) 先取「导出记录」里已存在的退款单任务号，便于稍后识别本次新建的任务。
  //    退款页 Export() 只调 _ACP("ExportBySync")，响应不含任务号、也不回调 NewExportLogs()，
  //    所以必须在点击导出前先拿到基线。
  await ensureLogFrame(bridge);
  let beforeIds = new Set();
  {
    const r = await readLogRows(bridge);
    if (!r.err) {
      beforeIds = new Set((r.rows || []).filter((x) => x.export_type === EXPORT_TYPE).map((x) => x.auto_id));
    }
  }
  console.log(`[refund] 导出记录基线：已存在 ${beforeIds.size} 个退款单任务`);

  // 3) 点击导出，创建异步导出任务
  await bridge.evaljs("document.getElementById('Tool_Export').click()");
  console.log("[refund] 已点击导出，等待任务进入导出记录…");

  // 4) 从导出记录里反查本次新建的任务号
  const task = await waitForNewTask(bridge, beforeIds, Date.now() + 120_000);
  const autoId = task.auto_id;
  console.log(`[refund] 导出任务 ${autoId} 已创建（${task.file_name}，${task.total_count} 条）`);

  // 5) 等待服务端生成文件
  const ready = await waitForFileReady(bridge, autoId, Date.now() + 900_000);
  console.log(`[refund] 文件已就绪：${ready.status}`);

  // 6) 取 OSS 下载地址（在导出记录页上下文里调它自带的 CheckAndGetExportData）
  let url = "";
  for (let i = 0; i < 4 && !url; i += 1) {
    let o = {};
    try { o = JSON.parse(await bridge.evaljs(jsGetDownloadUrl(autoId))); } catch { /* 忽略解析失败 */ }
    if (o.url && /^https?:\/\//.test(o.url)) url = o.url;
    else await sleep(3000);
  }
  if (!url) throw new Error("未取得导出文件下载地址");
  console.log("[refund] 下载地址已就绪");
  // 导出记录内嵌页已无用，及时移除（它自带 10s 轮询，留着会空转）
  await removeLogFrame(bridge);

  // 7) 下载
  mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const resp = await fetch(url, { signal: AbortSignal.timeout(600_000) });
  if (!resp.ok) throw new Error(`下载失败 HTTP ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  // xlsx 是 zip，必须以 PK 开头；否则多半下到了错误页/空文件，直接判失败以免污染库
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new Error(`下载内容不是 xlsx（${buffer.length} 字节，开头：${buffer.subarray(0, 80).toString("utf8").replace(/\s+/g, " ")}）`);
  }
  const disposition = resp.headers.get("content-disposition") || "";
  const nameMatch = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  const fallbackName = `${ready.file_name || `退款单_${start}_${end}`}.xlsx`;
  const remoteName = nameMatch ? decodeURIComponent(nameMatch[1]) : fallbackName;
  const target = join(DOWNLOAD_DIR, remoteName);
  writeFileSync(target, buffer, { mode: 0o600 });
  console.log(`[refund] 已下载 ${remoteName} (${(buffer.length / 1e6).toFixed(1)}MB)`);

  // 8) 入库
  const imported = await execFileAsync(PYTHON, [IMPORTER, target], { timeout: 1_800_000 });
  process.stdout.write(imported.stdout);
  if (imported.stderr) {
    const noise = imported.stderr.split("\n").filter((l) => l.trim() && !/Could not determine dtype/.test(l));
    if (noise.length) process.stderr.write(noise.join("\n") + "\n");
  }

  // 9) 发布
  if (args.publish) {
    const res = await execFileAsync(process.execPath, [AGENT, "sync-now", "profit_facts"], { timeout: 120_000 });
    console.log("[refund] 已入队发布任务:", res.stdout.trim().replace(/\s+/g, " ").slice(0, 200));
  } else {
    console.log("[refund] 跳过发布");
  }
  if (!args.keep) console.log(`[refund] 导出文件保留于 ${target}`);
  console.log("[refund] done");
}

main().catch(async (error) => {
  console.error("[refund] 失败:", error.message);
  // 异常时也清理隐藏 iframe，避免退款页残留（自带 10s 轮询会空转）
  if (activeBridge) await removeLogFrame(activeBridge);
  await notifyFailure(error.message);
  process.exitCode = 1;
});
