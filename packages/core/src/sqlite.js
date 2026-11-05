/**
 * SQLite 工具。抽自 jushuitan-order-details / inventory 的两份 sqlite-export.js。
 *
 * 统一三件套：
 *   1. 原子写：先写 <target>.tmp-<pid>，成功再 rename，失败必删。
 *   2. 权限：导出文件默认 0600（订单数据敏感）。
 *   3. 批量 UPSERT：一次性 prepare，循环 run，全程一个事务。
 */
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { CliError } from "./errors.js";

/**
 * @param {string} path
 * @param {{readOnly?: boolean, create?: boolean}} [options]
 */
export function openDatabase(path, { readOnly = false, create = true } = {}) {
  const file = resolve(path);
  if (!readOnly && create) mkdirSync(dirname(file), { recursive: true });
  if (readOnly && !existsSync(file)) {
    throw new CliError("database_missing", `Database not found: ${file}`);
  }
  return new DatabaseSync(file, { readOnly });
}

export function createTable(db, table, columnDefs, { ifNotExists = true } = {}) {
  const body = Object.entries(columnDefs)
    .map(([name, type]) => `"${name}" ${type}`)
    .join(",\n      ");
  db.exec(`CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}"${table}" (\n      ${body}\n    );`);
}

/**
 * 自动建表 + 补列（旧库升级时不丢数据）。
 */
export function ensureSchema(db, table, columnDefs) {
  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(table);
  if (!exists) {
    createTable(db, table, columnDefs);
    return { created: true, addedColumns: [] };
  }
  const current = new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((r) => r.name));
  const addedColumns = [];
  for (const [name, type] of Object.entries(columnDefs)) {
    if (!current.has(name)) {
      db.exec(`ALTER TABLE "${table}" ADD COLUMN "${name}" ${type};`);
      addedColumns.push(name);
    }
  }
  return { created: false, addedColumns };
}

export function prepareReplace(db, table, columns) {
  return db.prepare(
    `INSERT OR REPLACE INTO "${table}" (${columns.map((c) => `"${c}"`).join(",")})\n`
    + `VALUES (${columns.map(() => "?").join(",")})`,
  );
}

/** 空 key 的行直接丢弃（与旧实现一致：o_id 为空视为脏行）。 */
export function insertMany(statement, columns, rows, { key = null, transform = (v) => v } = {}) {
  let inserted = 0;
  for (const row of rows) {
    if (key && (row[key] === null || row[key] === undefined || row[key] === "")) continue;
    statement.run(...columns.map((name) => transform(row[name], name)));
    inserted += 1;
  }
  return inserted;
}

/**
 * 原子构建数据库文件。build(db, tmpPath) 里抛错则目标文件保持原样。
 * @template T
 * @param {string} targetPath
 * @param {(db: DatabaseSync, tmpPath: string) => T | Promise<T>} build
 * @returns {Promise<T & {output: string, size_bytes: number}>}
 */
export async function atomicBuild(targetPath, build) {
  const output = resolve(targetPath);
  const temporary = `${output}.tmp-${process.pid}`;
  mkdirSync(dirname(output), { recursive: true });
  rmSync(temporary, { force: true });
  const db = new DatabaseSync(temporary);
  chmodSync(temporary, 0o600);
  db.exec("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY;");
  try {
    const result = await build(db, temporary);
    db.close();
    chmodSync(temporary, 0o600);
    renameSync(temporary, output);
    return { ...result, output, size_bytes: statSync(output).size };
  } catch (error) {
    try { db.close(); } catch {}
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function readAll(path, sql, params = []) {
  const db = openDatabase(path, { readOnly: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

export function readOne(path, sql, params = []) {
  const db = openDatabase(path, { readOnly: true });
  try {
    return db.prepare(sql).get(...params);
  } finally {
    db.close();
  }
}
