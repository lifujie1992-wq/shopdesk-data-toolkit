#!/usr/bin/env node
/**
 * 漂移巡检：家目录里又长出脚本了吗。
 *
 *   node tools/audit.js                # 只看，不动
 *   node tools/audit.js --json         # 给机器读
 *   node tools/audit.js --apply --yes  # 复制进仓库，并把原文件换成指向仓库的软链
 *
 * 目的不是「定期大扫除」，而是让"新脚本跑到仓库外"这件事一直可见。
 * --apply 默认不做，是因为挪动正在跑的文件风险高；加 --yes 才执行，
 * 而且只处理能明确判断归属（聚水潭 / 抖店）的文件，其余只报告。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, copyFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = process.env.HOME ?? "";
const EXT = /\.(m?js|cjs|py|sh)$/;
const SKIP_DIRS = new Set([
  "node_modules", ".git", "Library", ".Trash", "Applications", "Music", "Movies", "Pictures",
  "Public", ".npm", ".cache", ".local", ".codex", ".claude", ".workbuddy", ".agent-autoloop",
  ".ssh", ".config", ".venv-html-to-docx", "__pycache__", "dist", "build", ".next", "vendor",
]);
const SIGNALS = [
  [/erp321|jushuitan|聚水潭|openbridge/i, "jst"],
  [/jinritemai|fxg\.|doudian|抖店/i, "doudian"],
];

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const has = (name) => process.argv.includes(`--${name}`);
const dryRun = !has("apply");
// 只扫「人顺手丢脚本」的地方：家目录本身、以及少数几个工作目录。
// 已经迁移完 / 待迁移的旧项目树不在这里重复报告，免得把历史包袱当漂移。
const DEFAULT_ROOTS = ["", "dev", "Desktop", "Documents", "Downloads", "scripts", "bin"]
  .map((name) => (name ? join(HOME, name) : HOME))
  .filter((dir) => existsSync(dir));
const roots = arg("root") ? [resolve(arg("root"))] : DEFAULT_ROOTS;
// 默认只看这几处「直接放着」的文件，不往子目录里钻：
// 子目录里的是各项目自己的结构，归不归整由人决定，不该由脚本猜。
const maxDepth = Number(arg("depth", "0"));

function walk(dir, depth, out) {
  if (depth > maxDepth) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (full === ROOT) continue;
      walk(full, depth + 1, out);
      continue;
    }
    if (!entry.isFile() || !EXT.test(entry.name)) continue;
    try { if (statSync(full).size > 1_000_000) continue; } catch { continue; }
    out.push(full);
  }
}

function classify(file) {
  let head = "";
  try { head = readFileSync(file, "utf8").slice(0, 4096); } catch { return { source: "unknown", why: "读不到" }; }
  for (const [pattern, source] of SIGNALS) if (pattern.test(head)) return { source, why: `内容命中 ${pattern}` };
  for (const [pattern, source] of SIGNALS) if (pattern.test(file)) return { source, why: "路径命中" };
  return { source: "unknown", why: "判断不出归属" };
}

const slugOf = (file) => file.split("/").pop().replace(EXT, "").replace(/\(\d+\)$/, "")
  .replace(/([a-z])([A-Z])/g, "$1-$2").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase()
  || "script";

function destination(file, source) {
  const slug = slugOf(file);
  if (source === "jst") return join(ROOT, "sources/jst/src", slug, "index.js");
  if (source === "doudian") return join(ROOT, "sources/doudian/src", slug, "index.js");
  return null;
}

const found = [];
for (const dir of roots) walk(dir, 0, found);

const rows = found.map((file) => {
  const { source, why } = classify(file);
  const dest = destination(file, source);
  return {
    file, relative: relative(HOME, file) || file, source, why,
    bytes: statSync(file).size,
    destination: dest ? relative(ROOT, dest) : null,
    insideRepo: file.startsWith(ROOT + "/"),
  };
}).filter((row) => !row.insideRepo);

const actionable = rows.filter((r) => r.destination && !existsSync(join(ROOT, r.destination)));
const unknown = rows.filter((r) => !r.destination);

if (has("json")) {
  process.stdout.write(JSON.stringify({ ok: true, roots, dry_run: dryRun, actionable, unknown }, null, 2) + "\n");
  process.exit(0);
}

const pad = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
process.stdout.write(`扫描 ${roots.map((d) => relative(HOME, d) || "~").join("、")}：仓库外有 ${rows.length} 个脚本\n\n`);

if (actionable.length) {
  process.stdout.write(`能自动归整（${actionable.length} 个）：\n`);
  process.stdout.write(`  ${pad("源文件", 46)} ${pad("归属", 9)} → 目标\n`);
  for (const row of actionable) {
    process.stdout.write(`  ${pad(row.relative, 46)} ${pad(row.source, 9)} → ${row.destination}\n`);
  }
  process.stdout.write("\n");
}

if (unknown.length) {
  process.stdout.write(`判断不出归属，需要你定（${unknown.length} 个）：\n`);
  for (const row of unknown.slice(0, 30)) {
    process.stdout.write(`  ${pad(row.relative, 46)} ${row.why}\n`);
  }
  if (unknown.length > 30) process.stdout.write(`  … 还有 ${unknown.length - 30} 个\n`);
  process.stdout.write("\n");
}

if (dryRun) {
  process.stdout.write("以上只是报告。要执行复制 + 建软链：node tools/audit.js --apply --yes\n");
  process.exit(actionable.length || unknown.length ? 1 : 0);
}

if (!has("yes")) {
  process.stderr.write(JSON.stringify({ ok: false, error: { code: "confirmation_required", message: "加 --yes 才会真正执行" } }) + "\n");
  process.exit(2);
}

const applied = [];
for (const row of actionable) {
  const dest = join(ROOT, row.destination);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(row.file, dest);
  // 原位置留软链：`node ~/xxx.js`、launchd 里写死的绝对路径都还能用
  const backup = `${row.file}.bak-${Date.now()}`;
  renameSync(row.file, backup);
  symlinkSync(dest, row.file);
  applied.push({ ...row, backup: relative(root, backup) });
}

process.stdout.write(JSON.stringify({ ok: true, applied: applied.map((a) => a.relative), count: applied.length }, null, 2) + "\n");
