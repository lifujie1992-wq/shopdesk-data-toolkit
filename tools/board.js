#!/usr/bin/env node
/**
 * 定时任务看板 → docs/schedules.html
 *
 * 数据全部取真：schedules/tasks.json + launchctl list + 日志文件状态。
 * 输出是自包含 HTML，离线可开，不用起服务。
 *
 *   node tools/board.js            # 生成 docs/schedules.html
 *   node tools/board.js --open     # 生成并打开
 *   node tools/board.js --json     # 只要数据
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS = join(homedir(), "Library/LaunchAgents");
const HOME = homedir();
const OUT = join(ROOT, "docs", "schedules.html");
const expand = (v) => String(v ?? "").replace(/^~(?=$|\/)/, HOME);
const has = (n) => process.argv.includes(`--${n}`);

const manifest = JSON.parse(readFileSync(join(ROOT, "schedules", "tasks.json"), "utf8"));
const tasks = manifest.tasks;

/* ---------- 系统状态 ---------- */
const loaded = new Map();
const list = spawnSync("/bin/launchctl", ["list"], { encoding: "utf8" });
for (const line of String(list.stdout ?? "").split("\n").slice(1)) {
  const [pid, status, label] = line.trim().split(/\s+/);
  if (label) loaded.set(label, { pid: pid === "-" ? null : Number(pid), lastExit: Number(status) });
}
const installedFiles = new Set(
  existsSync(AGENTS) ? readdirSync(AGENTS).filter((n) => n.endsWith(".plist")).map((n) => n.replace(/\.plist$/, "")) : [],
);

/* ---------- 触发时间推算 ---------- */
const MO = "日一二三四五六";
function labelOf(task) {
  if (task.keepAlive) return "常驻";
  if (task.interval) return `每 ${task.interval} 秒`;
  if (!task.calendar?.length) return "手动";
  return task.calendar.map((c) => {
    const p = [];
    if (c.month !== undefined) p.push(`${c.month} 月`);
    if (c.day !== undefined) p.push(`${c.day} 日`);
    if (c.weekday !== undefined) p.push(`周${MO[c.weekday]}`);
    p.push(c.hour !== undefined
      ? `${String(c.hour).padStart(2, "0")}:${String(c.minute ?? 0).padStart(2, "0")}`
      : `每小时 :${String(c.minute ?? 0).padStart(2, "0")}`);
    return p.join(" ");
  }).join(" / ");
}

function matches(entry, date) {
  if (entry.month !== undefined && date.getMonth() + 1 !== entry.month) return false;
  if (entry.day !== undefined && date.getDate() !== entry.day) return false;
  if (entry.weekday !== undefined && date.getDay() !== entry.weekday) return false;
  if (entry.hour !== undefined && date.getHours() !== entry.hour) return false;
  return date.getMinutes() === (entry.minute ?? 0);
}

/** 未来 hours 小时内所有触发时刻 */
function upcoming(task, from, hours = 24) {
  if (task.keepAlive || task.interval || !task.calendar?.length) return [];
  const out = [];
  const start = new Date(from);
  start.setSeconds(0, 0);
  for (let i = 0; i <= hours * 60; i += 1) {
    const at = new Date(start.getTime() + i * 60_000);
    if (task.calendar.some((c) => matches(c, at))) out.push(at);
  }
  return out;
}

const now = new Date();
const rows = tasks.map((task) => {
  const labelName = task.label ?? `com.shopdesk.${task.name}`;
  const state = loaded.get(labelName);
  const legacy = task.legacyLabel ? loaded.get(task.legacyLabel) : null;
  const logPath = expand(task.log);
  let log = null;
  try {
    const st = statSync(logPath);
    log = { path: logPath, bytes: st.size, mtime: st.mtime };
  } catch { log = null; }
  const runs = upcoming(task, now, 24);
  return {
    name: task.name,
    description: task.description ?? "",
    schedule: labelOf(task),
    label: labelName,
    legacyLabel: task.legacyLabel ?? null,
    enabled: task.enabled !== false,
    keepAlive: Boolean(task.keepAlive),
    interval: task.interval ?? null,
    installed: installedFiles.has(labelName),
    legacyPresent: Boolean(task.legacyLabel && (installedFiles.has(task.legacyLabel) || legacy)),
    pid: state?.pid ?? null,
    lastExit: state?.lastExit ?? null,
    loadedHere: Boolean(state),
    runs,
    nextRun: runs[0] ?? null,
    log,
    command: task.command,
  };
});
/* ---------- 诊断 ---------- */
const byMinute = new Map();
for (const row of rows) {
  for (const at of row.runs) {
    const key = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
    if (!byMinute.has(key)) byMinute.set(key, []);
    byMinute.get(key).push(row.name);
  }
}
const collisions = [...byMinute.entries()]
  .filter(([, names]) => new Set(names).size > 1)
  .map(([time, names]) => ({ time, names: [...new Set(names)] }))
  .sort((a, b) => a.time.localeCompare(b.time));

// 逐条的真问题（漂移单独汇总，不然 26 条同一条会淹掉真问题）
const problems = [];
const drift = { notInstalled: [], legacy: [] };
for (const row of rows) {
  if (!row.installed) drift.notInstalled.push(row.name);
  if (row.legacyPresent) drift.legacy.push(row.name);
  if (!row.enabled) { problems.push({ level: "info", name: row.name, text: "清单里已停用" }); continue; }
  if (row.lastExit !== null && row.lastExit !== 0) {
    problems.push({ level: "error", name: row.name, text: `上次退出码 ${row.lastExit}` });
  }
  if (row.log && row.log.bytes > 1_000_000) {
    problems.push({ level: "warn", name: row.name, text: `日志 ${(row.log.bytes / 1e6).toFixed(1)} MB，没有轮转` });
  }
  // 不做「日志多久没更新」判断：多数脚本自己写日志文件，plist 的 stdout 本来就是空的。
}

const summary = {
  total: rows.length,
  enabled: rows.filter((r) => r.enabled).length,
  installed: rows.filter((r) => r.installed).length,
  daemons: rows.filter((r) => r.keepAlive).length,
  firesPerDay: rows.reduce((n, r) => n + (r.keepAlive ? 0 : r.interval ? Math.round(86_400 / r.interval) : r.runs.length), 0),
  failing: rows.filter((r) => r.lastExit !== null && r.lastExit !== 0).length,
  drift: rows.filter((r) => !r.installed || r.legacyPresent).length,
  noRotation: rows.filter((r) => r.log && r.log.bytes > 1_000_000).length,
};

const payload = { generatedAt: now.toISOString(), summary, rows, collisions, problems, drift };

if (has("json")) {
  process.stdout.write(JSON.stringify(payload, (k, v) => (k === "runs" ? undefined : v), 2) + "\n");
  process.exit(0);
}

/* ---------- 渲染 ---------- */
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const rel = (date) => {
  if (!date) return "—";
  const diff = now - date;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`;
  return `${Math.round(diff / 86_400_000)} 天前`;
};
const fmtBytes = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n > 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);
const fmtTime = (date) => (!date ? "—" : `${date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`);

// 24 小时密度：每个小时触发了多少次
const perHour = Array.from({ length: 24 }, () => []);
for (const row of rows) for (const at of row.runs) perHour[(at.getHours() - now.getHours() + 24) % 24].push(row.name);
const maxHour = Math.max(1, ...perHour.map((h) => h.length));

const hourRows = perHour.map((names, index) => {
  const hour = (now.getHours() + index) % 24;
  const unique = [...new Set(names)];
  return { hour, count: names.length, unique, pct: Math.round((names.length / maxHour) * 100) };
});

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>定时任务看板 · ${esc(now.toLocaleString("zh-CN", { hour12: false }))}</title>
<style>
  :root{--bg:#0d1117;--panel:#151b24;--panel2:#1b222d;--line:#253040;--text:#e6edf3;--dim:#8b98a9;--dim2:#6b7788;
        --blue:#5b9dff;--green:#3fb950;--amber:#d29922;--red:#f85149;--purple:#bc8cff}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",Arial,sans-serif}
  code{font-family:ui-monospace,Menlo,monospace;font-size:12px;background:#0b1017;border:1px solid var(--line);border-radius:4px;padding:1px 5px;color:#a8c7fa}
  .wrap{max-width:1180px;margin:0 auto;padding:0 20px}
  header{position:sticky;top:0;z-index:9;background:rgba(13,17,23,.92);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
  .head{display:flex;align-items:center;gap:14px;padding:12px 0;flex-wrap:wrap}
  h1{font-size:16px;margin:0;font-weight:650}
  .sub{color:var(--dim2);font-size:12px}
  .search{flex:1;min-width:170px}
  .search input{width:100%;background:var(--panel);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:7px 11px;font-size:13px;outline:none}
  .search input:focus{border-color:var(--blue)}
  section{padding:26px 0 4px}
  h2{font-size:17px;margin:0 0 4px;font-weight:650;display:flex;align-items:center;gap:8px}
  h2 .n{font-size:11px;color:var(--dim2);border:1px solid var(--line);border-radius:6px;padding:1px 7px;font-weight:500}
  .lede{color:var(--dim);font-size:13px;margin:0 0 14px}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:10px;margin-top:16px}
  .stat{background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:12px 14px}
  .stat .k{font-size:24px;font-weight:700;line-height:1.15}
  .stat .l{color:var(--dim);font-size:11.5px;margin-top:2px}
  .stat.green .k{color:var(--green)}.stat.blue .k{color:var(--blue)}.stat.amber .k{color:var(--amber)}
  .stat.red .k{color:var(--red)}.stat.purple .k{color:var(--purple)}
  .hours{display:grid;gap:4px}
  .hour{display:grid;grid-template-columns:56px 1fr 44px;gap:10px;align-items:center;font-size:12px}
  .hour .h{color:var(--dim);font-family:ui-monospace,Menlo,monospace}
  .hour .bar{height:18px;background:#0b1017;border-radius:4px;display:flex;align-items:center;gap:3px;padding:0 3px;overflow:hidden}
  .hour .fill{height:10px;border-radius:3px;background:linear-gradient(90deg,#2b5c9e,#5b9dff);min-width:3px}
  .hour .cnt{color:var(--dim2);text-align:right;font-variant-numeric:tabular-nums}
  .hour .tip{color:#9fb0c4;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  table{width:100%;border-collapse:collapse;font-size:12.5px}
  .tw{border:1px solid var(--line);border-radius:11px;overflow:hidden;background:var(--panel)}
  th,td{text-align:left;padding:8px 11px;border-bottom:1px solid var(--line);vertical-align:top}
  th{background:var(--panel2);color:var(--dim);font-size:11px;font-weight:600;letter-spacing:.3px;position:sticky;top:56px}
  tr:last-child td{border-bottom:none}
  tbody tr:hover{background:#19202b}
  td.mono{font-family:ui-monospace,Menlo,monospace;color:var(--blue);white-space:nowrap}
  .tag{font-size:10.5px;font-weight:600;padding:1px 7px;border-radius:20px;border:1px solid;white-space:nowrap}
  .t-ok{color:var(--green);border-color:#1f5b31;background:#0f2a18}
  .t-warn{color:var(--amber);border-color:#5c470f;background:#241c07}
  .t-err{color:var(--red);border-color:#5d1f1b;background:#2a0f0d}
  .t-dim{color:var(--dim);border-color:#333c4a;background:#171d26}
  .t-run{color:var(--blue);border-color:#1d3d69;background:#0e1d31}
  .logs{color:var(--dim2);font-size:11.5px}
  .issues{display:grid;gap:8px}
  .issue{background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--amber);border-radius:9px;padding:10px 13px;font-size:12.5px}
  .issue.error{border-left-color:var(--red)}
  .issue.info{border-left-color:var(--dim)}
  .issue b{color:#dbe6f3}
  .note{background:#101a26;border:1px solid #1d3352;border-radius:9px;padding:11px 14px;font-size:12.5px;color:#a9bdd6;margin-top:14px}
  footer{color:var(--dim2);font-size:11.5px;padding:30px 0;text-align:center;border-top:1px solid var(--line);margin-top:26px}
  .hidden{display:none!important}
</style>
</head>
<body>
<header><div class="wrap head">
  <div><h1>定时任务看板</h1><div class="sub">生成于 ${esc(now.toLocaleString("zh-CN", { hour12: false }))} · 数据来自 schedules/tasks.json + launchctl</div></div>
  <div class="search"><input id="q" placeholder="搜索任务、命令、label…（按 / 聚焦）"></div>
</div></header>
<main>
<section><div class="wrap">
  <div class="stats">
    <div class="stat blue"><div class="k">${summary.total}</div><div class="l">任务总数</div></div>
    <div class="stat green"><div class="k">${summary.installed}</div><div class="l">已按新 label 安装</div></div>
    <div class="stat purple"><div class="k">${summary.daemons}</div><div class="l">常驻进程</div></div>
    <div class="stat amber"><div class="k">${summary.firesPerDay}</div><div class="l">24 小时触发次数</div></div>
    <div class="stat ${summary.failing ? "red" : "green"}"><div class="k">${summary.failing}</div><div class="l">上次退出码非零</div></div>
    <div class="stat ${summary.drift ? "amber" : "green"}"><div class="k">${summary.drift}</div><div class="l">清单与系统不一致</div></div>
  </div>
</div></section>

<section><div class="wrap">
  <h2>接下来 24 小时 <span class="n">按小时</span></h2>
  <p class="lede">柱长表示该小时触发次数；常驻进程不计入。用于发现撞在同一分钟的套娃任务。</p>
  <div class="hours">
    ${hourRows.map((h) => `<div class="hour"><div class="h">${String(h.hour).padStart(2, "0")}:00</div>
      <div class="bar" title="${esc(h.unique.join("、"))}"><div class="fill" style="width:${Math.max(h.pct, h.count ? 4 : 0)}%"></div>
      <div class="tip">${esc(h.unique.slice(0, 6).join("、"))}${h.unique.length > 6 ? ` +${h.unique.length - 6}` : ""}</div></div>
      <div class="cnt">${h.count || ""}</div></div>`).join("\n    ")}
  </div>
</div></section>

<section><div class="wrap">
  <h2>任务明细 <span class="n" id="count">${rows.length}</span></h2>
  <p class="lede">「下次」指的是清单里的计划时间；标灰的表示还没按新 label 装到系统里。</p>
  <div class="tw"><table>
    <thead><tr><th style="width:190px">任务</th><th style="width:150px">触发</th><th style="width:96px">下次</th><th style="width:110px">状态</th><th>日志</th></tr></thead>
    <tbody id="rows">
    ${rows.map((r) => {
      const state = !r.enabled ? '<span class="tag t-dim">已停用</span>'
        : r.pid ? '<span class="tag t-run">运行中</span>'
        : r.loadedHere ? '<span class="tag t-ok">已加载</span>'
        : '<span class="tag t-dim">未加载</span>';
      const exit = r.lastExit === null ? "" : r.lastExit === 0 ? "" : `<span class="tag t-err">退出 ${r.lastExit}</span>`;
      return `<tr data-k="${esc(`${r.name} ${r.description} ${r.label} ${r.command.join(" ")}`.toLowerCase())}">
        <td><b>${esc(r.name)}</b>${r.enabled ? "" : " <span class=\"tag t-dim\">停用</span>"}<div class="logs">${esc(r.description)}</div></td>
        <td class="mono">${esc(r.schedule)}</td>
        <td class="mono">${esc(fmtTime(r.nextRun))}</td>
        <td>${state} ${exit}</td>
        <td class="logs">${r.log ? `${fmtBytes(r.log.bytes)} · ${esc(rel(r.log.mtime))}<br><span style="opacity:.65">${esc(r.log.path.replace(HOME, "~"))}</span>` : "—"}</td>
      </tr>`;
    }).join("\n    ")}
    </tbody>
  </table></div>
</div></section>

<section><div class="wrap">
  <h2>需要注意 <span class="n">${problems.length + collisions.length + (drift.notInstalled.length ? 1 : 0)}</span></h2>
  <div class="issues">
    ${drift.notInstalled.length ? `<div class="issue info"><b>${drift.notInstalled.length} 个任务还没按新 label 安装</b><div style="color:var(--dim);margin-top:4px">旧 label 仍在运行，功能正常；切换用 <code>npm run schedule -- install --all</code>。</div></div>` : ""}
    ${collisions.length ? `<div class="issue"><b>同一分钟多个任务</b><div style="color:var(--dim);margin-top:4px">${collisions.map((c) => `${c.time} → ${esc(c.names.join("、"))}`).join("<br>")}</div></div>` : ""}
    ${problems.map((p) => `<div class="issue ${p.level === "error" ? "error" : p.level === "info" ? "info" : ""}"><b>${esc(p.name)}</b> — ${esc(p.text)}</div>`).join("\n    ")}
    ${!problems.length && !collisions.length ? '<div class="issue info">没有发现问题。</div>' : ""}
  </div>
  <div class="note">
    看板是快照，不会自动刷新。重新生成：<code>npm run board</code>。
    改任务请改 <code>schedules/tasks.json</code>，再用 <code>npm run schedule -- install --all</code> 生效。
  </div>
</div></section>
</main>
<footer>shopdesk-data-toolkit · 定时任务看板</footer>
<script>
const input = document.getElementById('q');
const rows = [...document.querySelectorAll('#rows tr')];
const count = document.getElementById('count');
function apply() {
  const q = input.value.trim().toLowerCase();
  let shown = 0;
  for (const row of rows) {
    const hit = !q || row.dataset.k.includes(q);
    row.classList.toggle('hidden', !hit);
    if (hit) shown++;
  }
  count.textContent = shown + ' / ' + rows.length;
}
input.addEventListener('input', apply);
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== input) { e.preventDefault(); input.focus(); }
});
</script>
</body>
</html>
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html);
process.stdout.write(`已生成 ${OUT.replace(HOME, "~")}\n`);
process.stdout.write(`  ${summary.total} 个任务 · 已安装 ${summary.installed} · 常驻 ${summary.daemons} · 24 小时触发 ${summary.firesPerDay} 次\n`);
process.stdout.write(`  真问题 ${problems.length} 条 · 撞点 ${collisions.length} 处 · 未迁 label ${drift.notInstalled.length} 个\n`);

if (has("open")) spawnSync("/usr/bin/open", [OUT], { stdio: "ignore" });
