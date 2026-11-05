#!/usr/bin/env node
/**
 * 定时任务工作台（本地网页）。
 *
 *   npm run workbench            # 打开 http://127.0.0.1:4173
 *   npm run workbench -- --port 4174
 *
 * 能做什么：
 *   - 看：触发时间、下次运行、最近一次耗时与退出码
 *   - 改：增删改任务、改时间、改命令，保存回 schedules/tasks.json（自动备份）
 *   - 装：把选中的任务 install / uninstall 到 launchd
 *   - 跑：立刻跑一次，并把耗时记进 var/schedule-runs.jsonl
 *
 * 安全：只监听 127.0.0.1；所有写操作要带 token（页面里已注入）。
 * token 每次启动重新生成，存在 var/workbench.token（0600）。
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(ROOT, "schedules", "tasks.json");
const HISTORY = join(ROOT, "var", "schedule-runs.jsonl");
const BACKUPS = join(ROOT, "var", "backups");
const AGENTS = join(homedir(), "Library/LaunchAgents");
const HOME = homedir();
const expand = (v) => String(v ?? "").replace(/^~(?=$|\/)/, HOME);
const NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const PORT = Number(arg("port", process.env.WORKBENCH_PORT ?? 4173));
// token 持久化：常驻服务重启后，已经打开的页面不需要刷新也能继续用
const TOKEN_FILE = join(ROOT, "var", "workbench.token");
mkdirSync(dirname(HISTORY), { recursive: true });
const TOKEN = (() => {
  try {
    const saved = readFileSync(TOKEN_FILE, "utf8").trim();
    if (saved.length >= 16) return saved;
  } catch { /* 第一次启动 */ }
  const fresh = randomBytes(24).toString("base64url");
  writeFileSync(TOKEN_FILE, fresh, { mode: 0o600 });
  return fresh;
})();

/* ---------------- 数据 ---------------- */

const readManifest = () => JSON.parse(readFileSync(MANIFEST, "utf8"));

function writeManifest(manifest) {
  mkdirSync(BACKUPS, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  if (existsSync(MANIFEST)) writeFileSync(join(BACKUPS, `tasks-${stamp}.json`), readFileSync(MANIFEST));
  const tmp = `${MANIFEST}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n");
  renameSync(tmp, MANIFEST);
}

function launchctl() {
  const out = new Map();
  const result = spawnSync("/bin/launchctl", ["list"], { encoding: "utf8" });
  for (const line of String(result.stdout ?? "").split("\n").slice(1)) {
    const [pid, status, label] = line.trim().split(/\s+/);
    if (label) out.set(label, { pid: pid === "-" ? null : Number(pid), lastExit: Number(status) });
  }
  return out;
}

function installedLabels() {
  try {
    return new Set(
      spawnSync("/bin/ls", [AGENTS], { encoding: "utf8" }).stdout.split("\n")
        .filter((n) => n.endsWith(".plist")).map((n) => n.replace(/\.plist$/, "")),
    );
  } catch { return new Set(); }
}

function readHistory(limit = 40_000) {
  if (!existsSync(HISTORY)) return [];
  const lines = readFileSync(HISTORY, "utf8").trim().split("\n").slice(-limit);
  const out = [];
  for (const line of lines) {
    try { out.push(JSON.parse(line)); } catch { /* 半行跳过 */ }
  }
  return out;
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] : null);

function durationsByName(history) {
  const map = new Map();
  for (const run of history) {
    if (!map.has(run.name)) map.set(run.name, []);
    map.get(run.name).push(run);
  }
  const out = {};
  for (const [name, runs] of map) {
    const sorted = runs.map((r) => r.duration_ms).sort((a, b) => a - b);
    const last = runs[runs.length - 1];
    out[name] = {
      runs: runs.length,
      avg: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
      p50: pct(sorted, 0.5),
      p95: pct(sorted, 0.95),
      max: sorted[sorted.length - 1],
      last: { at: last.finished_at, duration_ms: last.duration_ms, exit: last.exit, source: last.source },
      recent: runs.slice(-20).map((r) => ({ at: r.finished_at, ms: r.duration_ms, exit: r.exit })),
    };
  }
  return out;
}

const MO = "日一二三四五六";

/** 人类可读的触发时间，例如「每天 08:30」「每小时 :02、:32」「每周一 10:05」 */
function scheduleText(task) {
  if (task.keepAlive) return "常驻";
  if (task.interval) return `每 ${task.interval} 秒`;
  if (!task.calendar?.length) return "仅手动";
  const list = task.calendar;
  const hh = (c) => `${String(c.hour ?? 0).padStart(2, "0")}:${String(c.minute ?? 0).padStart(2, "0")}`;
  const allMinuteOnly = list.every((c) => c.minute !== undefined && c.hour === undefined
    && c.day === undefined && c.weekday === undefined && c.month === undefined);
  if (allMinuteOnly) return `每小时 ${list.map((c) => `:${String(c.minute).padStart(2, "0")}`).join("、")}`;
  const allDaily = list.every((c) => c.hour !== undefined && c.day === undefined
    && c.weekday === undefined && c.month === undefined);
  if (allDaily) return `每天 ${list.map(hh).join("、")}`;
  return list.map((c) => {
    const parts = [];
    if (c.month !== undefined) parts.push(`每年 ${c.month} 月`);
    else if (c.day !== undefined && c.weekday === undefined) parts.push("每月");
    if (c.day !== undefined) parts.push(`${c.day} 日`);
    if (c.weekday !== undefined) parts.push(`每周${MO[c.weekday]}`);
    if (c.hour === undefined && c.minute !== undefined) parts.push(`每小时 :${String(c.minute).padStart(2, "0")}`);
    else parts.push(hh(c));
    return parts.join(" ");
  }).join("、");
}

/** 平均每天触发几次；不足一天一次时返回更合适的口径 */
function frequency(task) {
  if (task.keepAlive) return { perDay: 0, label: "常驻" };
  if (task.interval) return { perDay: 86_400 / task.interval, label: `${Math.round(86_400 / task.interval)} 次/天` };
  if (!task.calendar?.length) return { perDay: 0, label: "手动" };
  let hits = 0;
  const start = new Date(); start.setHours(0, 0, 0, 0);
  for (let d = 0; d < 366; d += 1) {
    const day = new Date(start.getTime() + d * 86_400_000);
    for (const c of task.calendar) {
      if (c.month !== undefined && day.getMonth() + 1 !== c.month) continue;
      if (c.day !== undefined && day.getDate() !== c.day) continue;
      if (c.weekday !== undefined && day.getDay() !== c.weekday) continue;
      hits += c.hour === undefined ? 24 : 1;
    }
  }
  const perDay = hits / 366;
  const round = (n) => Math.round(n * 10) / 10;
  if (perDay >= 1) return { perDay, label: `${round(perDay)} 次/天` };
  if (perDay * 7 >= 1) return { perDay, label: `${round(perDay * 7)} 次/周` };
  if (perDay * 30 >= 1) return { perDay, label: `${round(perDay * 30)} 次/月` };
  return { perDay, label: `${round(perDay * 365)} 次/年` };
}

function nextRun(task, from = new Date()) {
  if (task.keepAlive || task.interval || !task.calendar?.length) return null;
  for (let d = 0; d < 400; d += 1) {
    const base = new Date(from);
    base.setDate(base.getDate() + d);
    base.setHours(0, 0, 0, 0);
    const candidates = [];
    for (const c of task.calendar) {
      if (c.month !== undefined && base.getMonth() + 1 !== c.month) continue;
      if (c.day !== undefined && base.getDate() !== c.day) continue;
      if (c.weekday !== undefined && base.getDay() !== c.weekday) continue;
      if (c.hour === undefined) {
        for (let h = 0; h < 24; h += 1) {
          const at = new Date(base); at.setHours(h, c.minute ?? 0, 0, 0);
          if (at > from) candidates.push(at);
        }
      } else {
        const at = new Date(base); at.setHours(c.hour, c.minute ?? 0, 0, 0);
        if (at > from) candidates.push(at);
      }
    }
    if (candidates.length) return candidates.sort((a, b) => a - b)[0].toISOString();
  }
  return null;
}

function buildState() {
  const manifest = readManifest();
  const loaded = launchctl();
  const files = installedLabels();
  const history = readHistory();
  const stats = durationsByName(history);

  const tasks = manifest.tasks.map((task) => {
    const label = task.label ?? `com.shopdesk.${task.name}`;
    const state = loaded.get(label);
    // 旧 label 可能才是真正在跑的那一个，必须单独看，否则会误报「未安装」
    const legacyState = task.legacyLabel ? loaded.get(task.legacyLabel) : null;
    return {
      ...task,
      label,
      schedule: { text: scheduleText(task) },
      frequency: frequency(task),
      perDay: frequency(task).perDay,
      nextRun: nextRun(task),
      installed: files.has(label),
      legacyInstalled: Boolean(task.legacyLabel && files.has(task.legacyLabel)),
      legacyPresent: Boolean(task.legacyLabel && (files.has(task.legacyLabel) || loaded.has(task.legacyLabel))),
      pid: state?.pid ?? null,
      lastExit: state?.lastExit ?? null,
      legacyPid: legacyState?.pid ?? null,
      legacyLastExit: legacyState?.lastExit ?? null,
      runningUnder: state?.pid ? "new" : legacyState?.pid ? "legacy" : null,
      duration: stats[task.name] ?? null,
    };
  });

  const byMinute = new Map();
  for (const task of tasks) {
    if (task.schedule.kind !== "calendar") continue;
    for (const c of task.calendar ?? []) {
      const key = c.hour !== undefined
        ? `${String(c.hour).padStart(2, "0")}:${String(c.minute ?? 0).padStart(2, "0")}`
        : `每小时 :${String(c.minute ?? 0).padStart(2, "0")}`;
      if (!byMinute.has(key)) byMinute.set(key, []);
      byMinute.get(key).push(task.name);
    }
  }
  const collisions = [...byMinute.entries()]
    .filter(([, names]) => new Set(names).size > 1)
    .map(([time, names]) => ({ time, names: [...new Set(names)] }));

  return { generatedAt: new Date().toISOString(), root: ROOT, tasks, collisions, historyCount: history.length };
}

/* ---------------- 校验 ---------------- */

function validate(task) {
  const errors = [];
  if (!NAME_RE.test(task.name ?? "")) errors.push("名字要用小写字母和连字符，例如 doudian-daily");
  if (!Array.isArray(task.command) || !task.command.length || task.command.some((a) => typeof a !== "string" || !a)) {
    errors.push("命令至少一个参数，且都要是非空字符串");
  }
  const hasCalendar = Array.isArray(task.calendar) && task.calendar.length;
  if (!task.keepAlive && !task.interval && !hasCalendar) errors.push("至少要选一种触发方式：定时 / 间隔 / 常驻");
  if (task.interval !== undefined && (!Number.isInteger(task.interval) || task.interval < 10)) errors.push("间隔至少 10 秒");
  for (const c of task.calendar ?? []) {
    for (const [key, max] of [["minute", 59], ["hour", 23], ["day", 31], ["weekday", 6], ["month", 12]]) {
      if (c[key] !== undefined && (!Number.isInteger(c[key]) || c[key] < 0 || c[key] > max)) {
        errors.push(`${key} 要在 0-${max} 之间`);
      }
    }
  }
  if (task.env && typeof task.env !== "object") errors.push("env 要是键值对象");
  return errors;
}

const clean = (task) => {
  const out = { ...task };
  for (const key of Object.keys(out)) {
    if (out[key] === undefined || out[key] === null || out[key] === "") delete out[key];
  }
  if (out.calendar) out.calendar = out.calendar.map((c) => Object.fromEntries(
    Object.entries(c).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => [k, Number(v)]),
  ));
  if (out.interval) out.interval = Number(out.interval);
  if (out.command) out.command = out.command.map(String).filter(Boolean);
  return out;
};

/* ---------------- HTTP ---------------- */

const send = (res, status, data) => {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 128 * 1024) throw new Error("body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const authed = (req) => req.headers["x-workbench-token"] === TOKEN;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = readFileSync(join(ROOT, "tools", "workbench.html"), "utf8").replaceAll("__TOKEN__", TOKEN);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
      return;
    }
    if (!url.pathname.startsWith("/api/")) return send(res, 404, { ok: false, error: "not_found" });
    if (!authed(req)) return send(res, 401, { ok: false, error: "需要 token：刷新页面" });

    if (req.method === "GET" && url.pathname === "/api/state") return send(res, 200, { ok: true, data: buildState() });

    if (req.method === "POST" && url.pathname === "/api/task") {
      const task = clean(await readBody(req));
      const errors = validate(task);
      if (errors.length) return send(res, 400, { ok: false, error: errors.join("；") });
      const manifest = readManifest();
      const index = manifest.tasks.findIndex((t) => t.name === task.name);
      if (index === -1) manifest.tasks.push(task); else manifest.tasks[index] = task;
      manifest.tasks.sort((a, b) => a.name.localeCompare(b.name));
      writeManifest(manifest);
      return send(res, 200, { ok: true, data: { saved: task.name } });
    }

    if (req.method === "DELETE" && url.pathname === "/api/task") {
      const name = url.searchParams.get("name");
      const manifest = readManifest();
      const next = manifest.tasks.filter((t) => t.name !== name);
      if (next.length === manifest.tasks.length) return send(res, 404, { ok: false, error: "没有这个任务" });
      manifest.tasks = next;
      writeManifest(manifest);
      return send(res, 200, { ok: true, data: { removed: name } });
    }

    if (req.method === "POST" && url.pathname === "/api/apply") {
      const { action, names } = await readBody(req);
      const args = [join(ROOT, "tools", "schedule.js"), action === "uninstall" ? "uninstall" : "install"];
      if (names === "all" || !Array.isArray(names) || !names.length) args.push("--all");
      else args.push(...names);
      const result = spawnSync(process.execPath, args, { encoding: "utf8", cwd: ROOT });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
      return send(res, result.status === 0 ? 200 : 500, { ok: result.status === 0, output });
    }

    if (req.method === "POST" && url.pathname === "/api/run") {
      const { name } = await readBody(req);
      const manifest = readManifest();
      if (!manifest.tasks.some((t) => t.name === name)) return send(res, 404, { ok: false, error: "没有这个任务" });
      const child = spawn(process.execPath, [join(ROOT, "tools", "run-task.js"), name, "--manual"], {
        cwd: ROOT, detached: true, stdio: "ignore",
      });
      child.unref();
      return send(res, 200, { ok: true, data: { started: name, pid: child.pid } });
    }

    if (req.method === "POST" && url.pathname === "/api/history") {
      const { name } = await readBody(req);
      const runs = readHistory().filter((r) => r.name === name).slice(-200).reverse();
      return send(res, 200, { ok: true, data: runs });
    }

    return send(res, 404, { ok: false, error: "not_found" });
  } catch (error) {
    send(res, 500, { ok: false, error: String(error.message ?? error) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`定时任务工作台： http://127.0.0.1:${PORT}\n`);
  process.stdout.write(`  清单 ${MANIFEST.replace(HOME, "~")}\n`);
  process.stdout.write(`  耗时 ${HISTORY.replace(HOME, "~")}（${readHistory().length} 条）\n`);
  if (!process.argv.includes("--no-open")) spawnSync("/usr/bin/open", [`http://127.0.0.1:${PORT}`], { stdio: "ignore" });
});
