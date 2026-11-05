#!/usr/bin/env node
/**
 * 新脚本脚手架。
 *
 *   node tools/new.js jst crypto-report --desc "加密行情日报"
 *   node tools/new.js jst crypto-report --desc "..." --dry-run
 *
 * 产物：
 *   sources/jst/src/<name>/index.js     业务入口（导出 name/description/run）
 *   sources/jst/src/<name>/README.md    用途、数据落位、认证、定时
 *   sources/jst/src/<name>/test/…       node --test 单测
 *
 * 因为是约定式自动发现（sources/jst/src/registry.js），
 * 建完目录 `jst <name>` 立刻可用，不需要改任何分发器。
 */
import { existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}
const has = (name) => process.argv.includes(`--${name}`);

function fail(message) {
  process.stderr.write(`${JSON.stringify({ ok: false, error: { code: "invalid_arguments", message } })}\n`);
  process.exitCode = 1;
  process.exit();
}

const [source, name] = process.argv.slice(2).filter((a) => !a.startsWith("--") && a !== arg("desc"));
const desc = arg("desc");
const dryRun = has("dry-run");

if (!source || !name) fail("用法：node tools/new.js <source> <name> --desc \"一句话用途\" [--dry-run]");
if (!NAME_RE.test(name)) fail(`${name} 不是合法的命令名：小写字母开头，用 - 连接，例如 crypto-report`);
if (!desc) fail("必须写 --desc：一句话说清这个脚本取什么数、干什么用");
if (!["jst", "doudian", "ops"].includes(source)) fail(`source 只能是 jst / doudian / ops`);

/* ---------------- 模板 ---------------- */

const nodeIndex = `/**
 * ${desc}
 *
 * 约定：放进 sources/${source}/src/${name}/ 即自动成为 \`${source === "jst" ? "jst" : source} ${name}\`。
 * 业务代码只写在这里；认证、HTTP、SQLite、限流、错误一律用 @shopdesk/core。
 */
import { CliError, resolveDataPath } from "@shopdesk/core";

export const name = "${name}";
export const description = "${desc}";
export const usage = "[options]";

export async function run(args) {
  // 1) 解析参数：用 core 的 parseFlags，别自己写
  //    import { parseFlags } from "@shopdesk/core";
  //    const flags = parseFlags(args, { days: { type: "number", default: 30, min: 1, max: 366 } });
  //
  // 2) 取数
  //    import { loadSession, createJstTransport } from "@shopdesk/core";
  //    const session = loadSession();
  //
  // 3) 落库
  //    const outputPath = flags.output ?? resolveDataPath("jst/${name}", "${name}.sqlite");
  //
  // 4) 返回数据即可：外层会输出 {"ok":true,"data":…}
  throw new CliError("not_implemented", "业务还没实现，先删掉这行再写。");
}
`;

const nodeTest = `import test from "node:test";
import assert from "node:assert/strict";
import { name, description, run } from "../index.js";

test("模块元信息可用于自动注册", () => {
  assert.equal(name, "${name}");
  assert.equal(typeof description, "string");
  assert.equal(typeof run, "function");
});

// 真实用例写在这里：纯函数优先，网络/数据库用注入的 fake。
`;

const readme = `# ${name}

${desc}

## 入口

\`\`\`bash
${source === "jst" ? `jst ${name}` : `node sources/${source}/bin/${source}.js ${name}`}
\`\`\`

## 数据落位

${source === "jst" ? `\`resolveDataPath("jst/${name}", "${name}.sqlite")\` → \`~/shopdesk-data/jst/${name}/${name}.sqlite\`` : "待定"}

## 认证

<!-- keychain / 工作台分区 cookie / OpenBridge / 无 -->

## 定时

<!-- 有就写 launchd 任务名与时间；没有写「手工」 -->

## 字段口径

<!-- 字段来自哪个接口、周期、是否派生；口径不确定的标 candidate_not_exact -->
`;

const files = source === "jst"
  ? [
      [`sources/jst/src/${name}/index.js`, nodeIndex],
      [`sources/jst/src/${name}/test/${name}.test.js`, nodeTest],
      [`sources/jst/src/${name}/README.md`, readme],
    ]
  : [
      [`sources/${source}/src/${name}/README.md`, readme],
      [`sources/${source}/src/${name}/index.js`, nodeIndex],
    ];

/* ---------------- 落盘 ---------------- */

const created = [];
for (const [relativePath, content] of files) {
  const target = join(ROOT, relativePath);
  if (existsSync(target)) fail(`${relative(target, process.cwd())} 已存在，不覆盖`);
  created.push({ path: target, content });
}

if (dryRun) {
  process.stdout.write(JSON.stringify({
    ok: true,
    dry_run: true,
    would_create: created.map((f) => relative(ROOT, f.path)),
  }, null, 2) + "\n");
  process.exit();
}

for (const { path, content } of created) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

// 同源已有命令里有没有同名，直接提醒（自动发现不会注册，但会静默覆盖显式命令）
const explicit = new Set(["orders", "sales", "inventory", "order-page", "aftersales", "refund", "purple", "profit", "doctor", "auth"]);
const clash = source === "jst" && explicit.has(name);

process.stdout.write(JSON.stringify({
  ok: true,
  created: created.map((f) => relative(ROOT, f.path)),
  next: [
    clash ? `⚠️ ${name} 与已有的显式命令同名，自动发现会跳过它，换个名字。` : null,
    `写业务：sources/jst/src/${name}/index.js`,
    `跑一下：node sources/jst/bin/jst.js ${name} --help`,
    `跑测试：node --test sources/jst/src/${name}/test/*.test.js`,
  ].filter(Boolean),
}, null, 2) + "\n");
