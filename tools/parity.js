#!/usr/bin/env node
/**
 * 新旧实现对拍。
 *
 * 迁移的铁律：任何一条命令在切换前必须过对拍，且不允许「差不多」。
 *
 *   node tools/parity.js cli \
 *     --old "jst-orders count --days 3" \
 *     --new "node sources/jst/bin/jst.js orders count --days 3"
 *
 *   node tools/parity.js db \
 *     --old /tmp/a.sqlite --new /tmp/b.sqlite \
 *     --table order_details --sort-list skus
 *
 * --sort-list 用于抹平上游接口的字段内顺序抖动（例如 skus 逗号分隔项）。
 */
import { execSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function deepDiff(a, b, path = "$") {
  const diffs = [];
  if (a === b) return diffs;
  const ta = a === null ? "null" : Array.isArray(a) ? "array" : typeof a;
  const tb = b === null ? "null" : Array.isArray(b) ? "array" : typeof b;
  if (ta !== tb) {
    diffs.push({ path, old: a, new: b });
    return diffs;
  }
  if (ta === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) diffs.push(...deepDiff(a[key], b[key], `${path}.${key}`));
    return diffs;
  }
  if (ta === "array") {
    if (a.length !== b.length) {
      diffs.push({ path: `${path}.length`, old: a.length, new: b.length });
    }
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
      diffs.push(...deepDiff(a[i], b[i], `${path}[${i}]`));
    }
    return diffs;
  }
  diffs.push({ path, old: a, new: b });
  return diffs;
}

function runCli() {
  const oldCmd = arg("old");
  const newCmd = arg("new");
  if (!oldCmd || !newCmd) throw new Error("cli mode needs --old and --new");
  const ignoreKeys = new Set((arg("ignore-keys", "") || "").split(",").filter(Boolean));

  const runOne = (cmd) => {
    const stdout = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return JSON.parse(stdout);
  };
  const oldOut = runOne(oldCmd);
  const newOut = runOne(newCmd);
  const all = deepDiff(oldOut, newOut);
  const diffs = ignoreKeys.size
    ? all.filter((d) => !ignoreKeys.has(d.path.split(/[.[\]]/).filter(Boolean).pop()))
    : all;
  return {
    mode: "cli",
    old: oldCmd,
    new: newCmd,
    ignored_keys: [...ignoreKeys],
    identical: diffs.length === 0,
    diffs: diffs.slice(0, 50),
    diff_count: diffs.length,
    raw_diff_count: all.length,
  };
}

function runDb() {
  const oldPath = arg("old");
  const newPath = arg("new");
  if (!oldPath || !newPath) throw new Error("db mode needs --old and --new");
  const table = arg("table", "order_details");
  const key = arg("key");
  const sortLists = (arg("sort-list", "") || "").split(",").filter(Boolean);
  const ignoreColumns = new Set((arg("ignore-columns", "") || "").split(",").filter(Boolean));

  const open = (p) => new DatabaseSync(p, { readOnly: true });
  const a = open(oldPath);
  const b = open(newPath);

  const names = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
  const schema = (db, t) => db.prepare(`PRAGMA table_info("${t}")`).all().map((r) => `${r.name}:${r.type}`).join(",");
  const indexes = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);

  const tables = { old: names(a), new: names(b) };
  const columns = schema(a, table).split(",");
  const keyColumns = (key ?? columns[0]?.split(":")[0] ?? "rowid")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const orderBy = keyColumns.map((c) => `"${c}"`).join(", ");
  const views = (db) => db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'view' ORDER BY name").all();

  const normalize = (row) => {
    if (!row) return row;
    const out = { ...row };
    for (const column of ignoreColumns) delete out[column];
    for (const field of sortLists) {
      if (typeof out[field] === "string") {
        out[field] = out[field].split(",").map((s) => s.trim()).sort().join(",");
      }
    }
    return out;
  };

  const rowsA = a.prepare(`SELECT * FROM "${table}" ORDER BY ${orderBy}`).all().map(normalize);
  const rowsB = b.prepare(`SELECT * FROM "${table}" ORDER BY ${orderBy}`).all().map(normalize);

  const diffs = [];
  for (let i = 0; i < Math.max(rowsA.length, rowsB.length); i += 1) {
    const d = deepDiff(rowsA[i], rowsB[i], `$[${i}]`);
    if (d.length) {
      diffs.push(...d);
      if (diffs.length > 100) break;
    }
  }

  const identical = JSON.stringify(tables.old) === JSON.stringify(tables.new)
    && schema(a, table) === schema(b, table)
    && JSON.stringify(indexes(a)) === JSON.stringify(indexes(b))
    && JSON.stringify(views(a)) === JSON.stringify(views(b))
    && rowsA.length === rowsB.length
    && diffs.length === 0;

  return {
    mode: "db",
    table,
    key: keyColumns.join(","),
    sorted_lists: sortLists,
    ignored_columns: [...ignoreColumns],
    identical,
    tables,
    views_identical: JSON.stringify(views(a)) === JSON.stringify(views(b)),
    schema_identical: schema(a, table) === schema(b, table),
    indexes_identical: JSON.stringify(indexes(a)) === JSON.stringify(indexes(b)),
    row_counts: { old: rowsA.length, new: rowsB.length },
    diff_count: diffs.length,
    diffs: diffs.slice(0, 20),
  };
}

const mode = process.argv[2];
const result = mode === "cli" ? runCli() : mode === "db" ? runDb() : (() => {
  throw new Error("usage: parity.js <cli|db> --old ... --new ...");
})();

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exitCode = result.identical ? 0 : 1;
