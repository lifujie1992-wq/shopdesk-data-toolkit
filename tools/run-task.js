#!/usr/bin/env node
/**
 * 任务计时包装器。
 *
 *   node tools/run-task.js <名字> [--manual]
 *
 * 读 schedules/tasks.json 里同名任务的 command / cwd / env，跑一遍，
 * 把「开始、结束、耗时、退出码」追加到 var/schedule-runs.jsonl。
 *
 * 为什么需要它：launchd 只记录最后一次退出码，不记录跑了多久。
 * 想要「每个任务耗时」就得自己掐表。
 *
 * 注意：stdout/stderr 直接继承，不在这里再写一遍日志——plist 里已经重定向了。
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(ROOT, "schedules", "tasks.json");
const HISTORY = join(ROOT, "var", "schedule-runs.jsonl");
const expand = (v) => String(v ?? "").replace(/^~(?=$|\/)/, homedir());

const argv = process.argv.slice(2);
const name = argv.find((a) => !a.startsWith("--"));
const manual = argv.includes("--manual");

function die(message) {
  process.stderr.write(`[run-task] ${message}\n`);
  process.exit(127);
}

if (!name) die("用法：run-task.js <名字> [--manual]");
if (!existsSync(MANIFEST)) die(`找不到清单 ${MANIFEST}`);

let task;
try {
  task = JSON.parse(readFileSync(MANIFEST, "utf8")).tasks.find((t) => t.name === name);
} catch (error) {
  die(`清单读不出来：${error.message}`);
}
if (!task) die(`清单里没有任务 ${name}`);

const [program, ...args] = task.command;
const startedAt = new Date();
const started = process.hrtime.bigint();

const result = spawnSync(expand(program), args.map(expand), {
  cwd: task.cwd ? expand(task.cwd) : undefined,
  env: { ...process.env, ...Object.fromEntries(Object.entries(task.env ?? {}).map(([k, v]) => [k, expand(v)])) },
  stdio: "inherit",
});

const durationMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
const exit = result.error ? 127 : (result.status ?? 1);

try {
  mkdirSync(dirname(HISTORY), { recursive: true });
  appendFileSync(HISTORY, JSON.stringify({
    name,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: durationMs,
    exit,
    source: manual ? "manual" : "scheduled",
    ...(result.error ? { error: String(result.error.message).slice(0, 200) } : {}),
  }) + "\n");
} catch (error) {
  process.stderr.write(`[run-task] 写历史失败（不影响任务）：${error.message}\n`);
}

process.exit(exit);
