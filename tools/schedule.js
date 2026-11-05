#!/usr/bin/env node
/**
 * 定时任务管理器。
 *
 * 事实来源是 schedules/tasks.json（声明式），不再手改 plist。
 *
 *   node tools/schedule.js list                  # 看清单
 *   node tools/schedule.js plan                  # 清单 vs 系统里实际加载的，差在哪
 *   node tools/schedule.js render <name>         # 打印将要写入的 plist
 *   node tools/schedule.js install <name>...     # 写 plist + launchctl bootstrap（会先停掉同名旧 label）
 *   node tools/schedule.js uninstall <name>...   # bootout + 删 plist
 *   node tools/schedule.js import                # 把现有的 LaunchAgents 反推成清单
 *   node tools/schedule.js status                # 清单里的任务现在是什么状态
 *
 * 设计上的两个约束：
 * 1. install 会同时 bootout 旧的 legacyLabel，避免新旧两份同时跑。
 * 2. 默认什么都不做，install / uninstall 必须点名或 --all。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(ROOT, "schedules", "tasks.json");
const AGENTS = join(homedir(), "Library/LaunchAgents");
const HOME = homedir();
const LEGACY_PREFIXES = ["com.lee.", "com.xdr.", "local."];

const expand = (value) => String(value).replace(/^~(?=$|\/)/, HOME);
const command = (argv) => process.argv.slice(2).filter((a) => !a.startsWith("--"));
const has = (name) => process.argv.includes(`--${name}`);

function readManifest() {
  if (!existsSync(MANIFEST)) return { version: 1, prefix: "com.shopdesk", tasks: [] };
  return JSON.parse(readFileSync(MANIFEST, "utf8"));
}
const tasks = () => readManifest().tasks;

function readPlist(file) {
  const out = execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" });
  return JSON.parse(out);
}

function installed() {
  const loaded = new Map();
  const list = spawnSync("/bin/launchctl", ["list"], { encoding: "utf8" });
  for (const line of String(list.stdout ?? "").split("\n").slice(1)) {
    const [pid, status, label] = line.trim().split(/\s+/);
    if (!label) continue;
    loaded.set(label, { pid: pid === "-" ? null : Number(pid), lastExit: Number(status) });
  }
  const files = new Map();
  if (existsSync(AGENTS)) {
    for (const name of readdirSync(AGENTS)) {
      if (name.endsWith(".plist")) files.set(name.replace(/\.plist$/, ""), join(AGENTS, name));
    }
  }
  return { loaded, files };
}

/* ---------------- 渲染 ---------------- */

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function plistValue(value, indent) {
  if (typeof value === "boolean") return [`${indent}<${value ? "true" : "false"}/>`];
  if (typeof value === "number") return [`${indent}<integer>${value}</integer>`];
  if (Array.isArray(value)) return [`${indent}<array>`, ...value.flatMap((v) => plistValue(v, indent + "\t")), `${indent}</array>`];
  if (value && typeof value === "object") {
    return [`${indent}<dict>`,
      ...Object.entries(value).flatMap(([k, v]) => [`${indent}\t<key>${esc(k)}</key>`, ...plistValue(v, indent + "\t")]),
      `${indent}</dict>`];
  }
  return [`${indent}<string>${esc(value)}</string>`];
}

function renderPlist(task) {
  const label = task.label ?? `com.shopdesk.${task.name}`;
  const args = task.command.map((a) => `\t\t<string>${esc(expand(a))}</string>`).join("\n");
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "\t<key>Label</key>",
    `\t<string>${esc(label)}</string>`,
    "\t<key>ProgramArguments</key>",
    "\t<array>",
    args,
    "\t</array>",
  ];
  // extra：不想建模、但会影响行为的 launchd 键（Nice / Umask / LowPriorityIO / ExitTimeOut…）
  for (const [key, value] of Object.entries(task.extra ?? {})) {
    lines.push(`\t<key>${esc(key)}</key>`, ...plistValue(value, "\t"));
  }
  if (task.cwd) lines.push("\t<key>WorkingDirectory</key>", `\t<string>${esc(expand(task.cwd))}</string>`);
  if (task.env && Object.keys(task.env).length) {
    lines.push("\t<key>EnvironmentVariables</key>", "\t<dict>");
    for (const [key, value] of Object.entries(task.env)) {
      lines.push(`\t\t<key>${esc(key)}</key>`, `\t\t<string>${esc(expand(value))}</string>`);
    }
    lines.push("\t</dict>");
  }
  if (task.processType) lines.push("\t<key>ProcessType</key>", `\t<string>${esc(task.processType)}</string>`);
  if (task.throttleInterval) lines.push("\t<key>ThrottleInterval</key>", `\t<integer>${Number(task.throttleInterval)}</integer>`);
  if (task.keepAlive) lines.push("\t<key>KeepAlive</key>", "\t<true/>");
  if (task.runAtLoad) lines.push("\t<key>RunAtLoad</key>", "\t<true/>");
  if (task.interval) lines.push("\t<key>StartInterval</key>", `\t<integer>${Number(task.interval)}</integer>`);
  if (Array.isArray(task.calendar) && task.calendar.length) {
    lines.push("\t<key>StartCalendarInterval</key>");
    if (task.calendar.length === 1) {
      lines.push("\t<dict>", ...calendarDict(task.calendar[0]), "\t</dict>");
    } else {
      lines.push("\t<array>");
      for (const entry of task.calendar) lines.push("\t\t<dict>", ...calendarDict(entry, "\t\t"), "\t\t</dict>");
      lines.push("\t</array>");
    }
  }
  if (task.log) lines.push("\t<key>StandardOutPath</key>", `\t<string>${esc(expand(task.log))}</string>`);
  // 没有单独的 errorLog 时，stderr 才和 stdout 共用一个文件
  const errLog = task.errorLog ?? task.log;
  if (errLog) lines.push("\t<key>StandardErrorPath</key>", `\t<string>${esc(expand(errLog))}</string>`);
  lines.push("</dict>", "</plist>", "");
  return lines.join("\n");
}

function calendarDict(entry, indent = "\t") {
  const map = { Minute: "minute", Hour: "hour", Day: "day", Weekday: "weekday", Month: "month" };
  return Object.entries(map)
    .filter(([, key]) => entry[key] !== undefined)
    .flatMap(([name, key]) => [`${indent}\t<key>${name}</key>`, `${indent}\t<integer>${Number(entry[key])}</integer>`]);
}

const describe = (task) => {
  if (task.keepAlive) return "常驻";
  if (task.interval) return `每 ${task.interval}s`;
  if (!task.calendar?.length) return "手动";
  return task.calendar.map((c) => {
    const pad = (n) => String(n).padStart(2, "0");
    const day = c.weekday !== undefined ? `周${"日一二三四五六"[c.weekday]}` : c.day !== undefined ? `${c.day}日` : undefined;
    const month = c.month !== undefined ? `${c.month}月` : "";
    const time = c.hour !== undefined ? `${pad(c.hour)}:${pad(c.minute ?? 0)}` : `每${c.minute ?? 0}分`;
    return [month, day, time].filter(Boolean).join(" ");
  }).join(" / ");
};

/* ---------------- 命令 ---------------- */

function cmdList() {
  const all = tasks();
  const width = Math.max(10, ...all.map((t) => t.name.length));
  process.stdout.write(`${"任务".padEnd(width)}  ${"触发".padEnd(22)} 说明\n`);
  for (const task of all) {
    const off = task.enabled === false ? "（已停）" : "";
    process.stdout.write(`${task.name.padEnd(width)}  ${describe(task).padEnd(22)} ${task.description ?? ""}${off}\n`);
  }
  process.stdout.write(`\n共 ${all.length} 条，清单：${MANIFEST.replace(HOME, "~")}\n`);
}

function cmdPlan() {
  const { loaded, files } = installed();
  const all = tasks();
  const expected = new Set(all.map((t) => t.label ?? `com.shopdesk.${t.name}`));
  const legacyOf = new Set(all.map((t) => t.legacyLabel).filter(Boolean));

  const rows = [];
  for (const task of all) {
    const label = task.label ?? `com.shopdesk.${task.name}`;
    const file = files.get(label);
    const state = loaded.get(label);
    const problems = [];
    if (!file) problems.push("未安装");
    if (task.enabled === false && (file || state)) problems.push("清单里已停用但仍存在");
    if (state && state.lastExit !== 0) problems.push(`上次退出码 ${state.lastExit}`);
    if (task.legacyLabel && (files.has(task.legacyLabel) || loaded.has(task.legacyLabel))) {
      problems.push(`旧 label 还在：${task.legacyLabel}`);
    }
    rows.push({ name: task.name, label, state, problems });
  }

  const extras = [...loaded.keys()].filter((label) =>
    !expected.has(label) && !legacyOf.has(label) &&
    LEGACY_PREFIXES.some((p) => label.startsWith(p)));

  const pad = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
  process.stdout.write(`${pad("任务", 26)} ${pad("label", 36)} 状态\n`);
  for (const row of rows) {
    const status = row.state
      ? (row.state.pid ? `运行中 pid=${row.state.pid}` : "已加载")
      : "未加载";
    process.stdout.write(`${pad(row.name, 26)} ${pad(row.label, 36)} ${status}${row.problems.length ? "  ← " + row.problems.join("；") : ""}\n`);
  }
  if (extras.length) {
    process.stdout.write(`\n清单外、仍在加载的任务（${extras.length} 个）：\n`);
    for (const label of extras) process.stdout.write(`  ${label}\n`);
  }
  const drift = rows.filter((r) => r.problems.length).length;
  process.stdout.write(`\n${drift ? `有 ${drift} 条需要处理` : "清单与系统一致"}；清单外 ${extras.length} 个\n`);
  process.exitCode = drift ? 1 : 0;
}

function cmdRender(name) {
  const task = tasks().find((t) => t.name === name);
  if (!task) throw new Error(`清单里没有 ${name}`);
  process.stdout.write(renderPlist(task));
}

function cmdInstall(names) {
  const all = tasks();
  const picked = has("all") ? all.filter((t) => t.enabled !== false) : all.filter((t) => names.includes(t.name));
  if (!picked.length) throw new Error("要说清装哪几个，或用 --all");
  const disabled = has("all") ? all.filter((t) => t.enabled === false) : [];
  if (has("dry-run")) {
    for (const task of picked) {
      const label = task.label ?? `com.shopdesk.${task.name}`;
      process.stdout.write(`将写入 ${join(AGENTS, `${label}.plist`)}；先 bootout ${task.legacyLabel ?? label}；再 bootstrap ${label}\n`);
    }
    for (const task of disabled) {
      process.stdout.write(`将停用 ${task.name}：bootout 并删除 ${task.legacyLabel ?? task.label ?? `com.shopdesk.${task.name}`}.plist\n`);
    }
    return;
  }
  mkdirSync(AGENTS, { recursive: true });
  for (const task of picked) {
    const label = task.label ?? `com.shopdesk.${task.name}`;
    const path = join(AGENTS, `${label}.plist`);
    // 先停旧的：新 label 与 legacyLabel 同时跑会双份执行
    for (const old of [task.legacyLabel, label]) {
      if (!old) continue;
      spawnSync("/bin/launchctl", ["bootout", `gui/${process.getuid()}/${old}`], { stdio: "ignore" });
    }
    writeFileSync(path, renderPlist(task));
    if (task.log) mkdirSync(dirname(expand(task.log)), { recursive: true });
    const result = spawnSync("/bin/launchctl", ["bootstrap", `gui/${process.getuid()}`, path], { encoding: "utf8" });
    process.stdout.write(`${result.status === 0 ? "✓" : "✗"} ${label}${result.status ? `  ${result.stderr.trim()}` : ""}\n`);
    if (task.legacyLabel) {
      const legacyFile = join(AGENTS, `${task.legacyLabel}.plist`);
      if (existsSync(legacyFile)) {
        rmSync(legacyFile);
        process.stdout.write(`  已移除旧 label 文件 ${task.legacyLabel}.plist\n`);
      }
    }
  }
  // enabled:false 的任务：停掉并从 LaunchAgents 移除，避免"清单说停用、系统还在跑"
  for (const task of disabled) {
    const old = task.legacyLabel ?? task.label ?? `com.shopdesk.${task.name}`;
    spawnSync("/bin/launchctl", ["bootout", `gui/${process.getuid()}/${old}`], { stdio: "ignore" });
    const file = join(AGENTS, `${old}.plist`);
    if (existsSync(file)) rmSync(file);
    process.stdout.write(`✓ ${old} 已停用并移除\n`);
  }
}

function cmdUninstall(names) {
  const all = tasks();
  const picked = has("all") ? all : all.filter((t) => names.includes(t.name));
  if (!picked.length) throw new Error("要说清卸哪几个，或用 --all");
  if (has("dry-run")) {
    for (const task of picked) process.stdout.write(`将 bootout 并删除 ${task.label ?? `com.shopdesk.${task.name}`}\n`);
    return;
  }
  for (const task of picked) {
    const label = task.label ?? `com.shopdesk.${task.name}`;
    spawnSync("/bin/launchctl", ["bootout", `gui/${process.getuid()}/${label}`], { stdio: "ignore" });
    const path = join(AGENTS, `${label}.plist`);
    if (existsSync(path)) rmSync(path);
    process.stdout.write(`✓ 已卸载 ${label}\n`);
  }
}

function cmdImport() {
  if (!existsSync(AGENTS)) throw new Error("没有 LaunchAgents 目录");
  const out = [];
  for (const file of readdirSync(AGENTS).filter((n) => n.endsWith(".plist"))) {
    const label = file.replace(/\.plist$/, "");
    if (!LEGACY_PREFIXES.some((p) => label.startsWith(p))) continue;
    let plist;
    try { plist = readPlist(join(AGENTS, file)); } catch { continue; }
    const args = plist.ProgramArguments ?? (plist.Program ? [plist.Program] : []);
    if (!args.length) continue;
    const name = label.replace(/^(com\.lee\.|com\.xdr\.|local\.)/, "");
    const task = {
      name,
      label: `com.shopdesk.${name}`,
      legacyLabel: label,
      description: plist._comment ?? "",
      command: args.map((a) => a.replaceAll(HOME, "~")),
      ...(plist.WorkingDirectory ? { cwd: plist.WorkingDirectory.replaceAll(HOME, "~") } : {}),
      ...(plist.KeepAlive ? { keepAlive: true } : {}),
      ...(plist.RunAtLoad ? { runAtLoad: true } : {}),
      ...(plist.StartInterval ? { interval: plist.StartInterval } : {}),
      ...(plist.StartCalendarInterval
        ? { calendar: (Array.isArray(plist.StartCalendarInterval) ? plist.StartCalendarInterval : [plist.StartCalendarInterval])
            .map((c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k.toLowerCase(), v]))) }
        : {}),
      ...(plist.StandardOutPath ? { log: plist.StandardOutPath.replaceAll(HOME, "~") } : {}),
      ...(plist.StandardErrorPath && plist.StandardErrorPath !== plist.StandardOutPath
        ? { errorLog: plist.StandardErrorPath.replaceAll(HOME, "~") } : {}),
      // env 里的 PATH 常含重复的 $HOME 段，保留绝对路径，避免 ~ 只展开开头一个
      ...(plist.EnvironmentVariables
        ? { env: Object.fromEntries(Object.entries(plist.EnvironmentVariables).map(([k, v]) => [k, String(v)])) }
        : {}),
      ...(plist.ProcessType ? { processType: plist.ProcessType } : {}),
      ...(plist.ThrottleInterval ? { throttleInterval: plist.ThrottleInterval } : {}),
      enabled: true,
    };
    const MANAGED = new Set(["Label", "ProgramArguments", "WorkingDirectory", "KeepAlive", "RunAtLoad",
      "StartInterval", "StartCalendarInterval", "StandardOutPath", "StandardErrorPath",
      "EnvironmentVariables", "ProcessType", "ThrottleInterval"]);
    const extra = Object.fromEntries(Object.entries(plist).filter(([k]) => !MANAGED.has(k)));
    if (Object.keys(extra).length) task.extra = extra;
    out.push(task);
  }
  process.stdout.write(JSON.stringify({ version: 1, prefix: "com.shopdesk", tasks: out }, null, 2) + "\n");
}

const [sub, ...rest] = process.argv.slice(2);
try {
  switch (sub) {
    case "list": cmdList(); break;
    case "plan": cmdPlan(); break;
    case "render": cmdRender(rest[0]); break;
    case "install": cmdInstall(command()); break;
    case "uninstall": cmdUninstall(command()); break;
    case "import": cmdImport(); break;
    default:
      process.stdout.write(`用法：
  node tools/schedule.js list
  node tools/schedule.js plan
  node tools/schedule.js render <name>
  node tools/schedule.js install <name>... | --all
  node tools/schedule.js uninstall <name>... | --all
  node tools/schedule.js import > schedules/tasks.json
`);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
