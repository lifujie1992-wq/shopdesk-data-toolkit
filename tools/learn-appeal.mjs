#!/usr/bin/env node
/**
 * 从平台真实审核结果反推「品退说明」的判定边界。
 *
 *   node tools/learn-appeal.mjs            # 生成/刷新样例库
 *   node tools/learn-appeal.mjs --dry-run  # 只看统计，不写文件
 *
 * 数据来源：
 *   ~/Library/Application Support/shopdesk/appeal-reports/results.json   平台举报记录（含审核结果）
 *   ~/Library/Application Support/shopdesk/business-data/quality-all-latest.json  售后说明
 *
 * 产出：
 *   ~/Library/Application Support/shopdesk/appeal-llm-quality-learned.json
 *
 * 只收录「方向一致」的：全成功 → very_subjective；全失败 → specific_defect。
 * 既有成功又有失败的说明有争议，跳过，交给人工。
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = join(homedir(), "Library/Application Support/shopdesk");
const RESULTS = join(BASE, "appeal-reports", "results.json");
const POOL = join(BASE, "business-data", "quality-all-latest.json");
const OUT = join(BASE, "appeal-llm-quality-learned.json");
const QUALITY_SUB = "消费者选择品质退货与事实不符";
const SUCCESS = "6";
const FAILURE = "3";
const dryRun = process.argv.includes("--dry-run");

for (const f of [RESULTS, POOL]) {
  if (!existsSync(f)) {
    process.stderr.write(`缺少数据：${f}\n`);
    process.exit(1);
  }
}

const results = JSON.parse(readFileSync(RESULTS, "utf8")).map ?? {};
const pool = new Map(JSON.parse(readFileSync(POOL, "utf8")).map((r) => [r.order_id, r]));

/** 说明 → {ok, bad} */
const tally = new Map();
for (const [oid, record] of Object.entries(results)) {
  if (!record || record.sub !== QUALITY_SUB) continue;
  const status = String(record.auditStatus);
  if (status !== SUCCESS && status !== FAILURE) continue;
  const desc = String(pool.get(oid)?.description ?? "").replace(/\s+/g, " ").trim();
  if (!desc) continue;
  const entry = tally.get(desc) ?? { ok: 0, bad: 0 };
  entry[status === SUCCESS ? "ok" : "bad"] += 1;
  tally.set(desc, entry);
}

const learned = [];
for (const [desc, { ok, bad }] of [...tally.entries()].sort((a, b) => (b[1].ok + b[1].bad) - (a[1].ok + a[1].bad))) {
  if (ok && !bad) learned.push({ desc, label: "very_subjective", source: "history", ok });
  else if (bad && !ok) learned.push({ desc, label: "specific_defect", source: "history", bad });
}

const subjective = learned.filter((x) => x.label === "very_subjective");
const defect = learned.filter((x) => x.label === "specific_defect");
process.stdout.write(`配对说明 ${tally.size} 条 → 可用于学习 ${learned.length} 条`);
process.stdout.write(`（纯主观 ${subjective.length} / 品质缺陷 ${defect.length}）\n`);
process.stdout.write(`有争议跳过 ${tally.size - learned.length} 条\n\n`);
process.stdout.write(`判定为「纯主观」（举报成功）：\n${subjective.slice(0, 8).map((x) => `  ×${x.ok}  「${x.desc.slice(0, 30)}」`).join("\n")}\n\n`);
process.stdout.write(`判定为「品质缺陷」（举报失败，不要报）：\n${defect.slice(0, 8).map((x) => `  ×${x.bad}  「${x.desc.slice(0, 30)}」`).join("\n")}\n`);

if (dryRun) process.exit(0);
writeFileSync(OUT, `${JSON.stringify(learned, null, 1)}\n`);
chmodSync(OUT, 0o600);
process.stdout.write(`\n已写入 ${OUT}\n`);
