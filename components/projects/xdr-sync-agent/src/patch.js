import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";

function qi(value) { return `"${value.replaceAll('"', '""')}"`; }
function validateSchema(db, spec) {
  for (const [table, rule] of Object.entries(spec.tables)) {
    const rows = db.prepare(`PRAGMA table_info(${qi(table)})`).all();
    const actual = new Set(rows.map((row) => row.name));
    for (const column of rule.columns) if (!actual.has(column)) throw new Error(`schema_missing:${table}.${column}`);
  }
}
export function checkDatabase(path, spec) {
  if (!existsSync(path) || statSync(path).size < 512) throw new Error("sqlite_missing_or_empty");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") throw new Error("sqlite_integrity_failed");
    validateSchema(db, spec);
    return Object.fromEntries(Object.keys(spec.tables).map((t) => [t, Number(db.prepare(`SELECT count(*) AS n FROM ${qi(t)}`).get().n)]));
  } finally { db.close(); }
}
function revisionOf(path) {
  if (!existsSync(path)) return null;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const found = db.prepare("SELECT 1 AS yes FROM sqlite_master WHERE type='table' AND name='_xdr_meta'").get();
    return found ? (db.prepare("SELECT value FROM _xdr_meta WHERE key='revision'").get()?.value || null) : null;
  } finally { db.close(); }
}
function schemaMatches(path, spec) {
  if (!existsSync(path)) return false;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    validateSchema(db, spec);
    return true;
  } catch {
    return false;
  } finally {
    db.close();
  }
}
async function gzipWithSha(source, target, shaPath) {
  await pipeline(createReadStream(source), createGzip({ level: 6 }), createWriteStream(target, { mode: 0o600 }));
  const hash = createHash("sha256");
  await pipeline(createReadStream(target), hash);
  const digest = hash.digest("hex");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(shaPath, `${digest}  ${target.split("/").at(-1).replace(/\.partial$/, ".ready")}\n`, { mode: 0o600 }));
  return digest;
}
export async function buildTransfer({ jobId, dataset, staging, baseline, outputDir, spec, serverRevision, forceFull = false }) {
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const counts = checkDatabase(staging, spec);
  const localRevision = revisionOf(baseline);
  const full = forceFull || !localRevision || localRevision !== serverRevision
    || !schemaMatches(baseline, spec);
  const targetRevision = crypto.randomUUID();
  const mode = full ? "full" : "patch";
  const stem = `${jobId}.${dataset}.${mode}`;
  const raw = `${outputDir}/${stem}.sqlite`;
  const data = `${raw}.gz.partial`;
  const sha = `${outputDir}/${stem}.sha256.partial`;
  const manifest = { format_version: 1, job_id: jobId, dataset, mode,
    base_revision: full ? null : serverRevision, target_revision: targetRevision,
    created_at: new Date().toISOString(), row_count: counts[spec.primary_table], tables: {} };
  if (full) {
    const source = new DatabaseSync(staging);
    try {
      source.exec("CREATE TABLE IF NOT EXISTS _xdr_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      source.prepare("INSERT INTO _xdr_meta(key,value) VALUES('revision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(targetRevision);
      source.prepare("INSERT INTO _xdr_meta(key,value) VALUES('manifest',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(manifest));
    } finally { source.close(); }
    await import("node:fs/promises").then(({ copyFile }) => copyFile(staging, raw));
    for (const [table, n] of Object.entries(counts)) manifest.tables[table] = { target_count: n, upsert_count: n, delete_count: 0 };
  } else {
    const db = new DatabaseSync(raw);
    try {
      db.exec("CREATE TABLE _xdr_transfer_manifest (json TEXT NOT NULL)");
      db.prepare("ATTACH DATABASE ? AS target").run(staging);
      db.prepare("ATTACH DATABASE ? AS base").run(baseline);
      for (const [table, rule] of Object.entries(spec.tables)) {
        const cols = rule.columns.map(qi).join(",");
        const pkJoin = rule.pk.map((c) => `b.${qi(c)} IS t.${qi(c)}`).join(" AND ");
        const changed = rule.columns.map((c) => `b.${qi(c)} IS NOT t.${qi(c)}`).join(" OR ");
        db.exec(`CREATE TABLE ${qi(`upsert__${table}`)} AS SELECT ${cols} FROM target.${qi(table)} WHERE 0`);
        db.exec(`INSERT INTO ${qi(`upsert__${table}`)} SELECT ${rule.columns.map((c) => `t.${qi(c)}`).join(",")} FROM target.${qi(table)} t LEFT JOIN base.${qi(table)} b ON ${pkJoin} WHERE b.${qi(rule.pk[0])} IS NULL OR ${changed}`);
        db.exec(`CREATE TABLE ${qi(`delete__${table}`)} AS SELECT ${rule.pk.map(qi).join(",")} FROM base.${qi(table)} WHERE 0`);
        db.exec(`INSERT INTO ${qi(`delete__${table}`)} SELECT ${rule.pk.map((c) => `b.${qi(c)}`).join(",")} FROM base.${qi(table)} b LEFT JOIN target.${qi(table)} t ON ${pkJoin} WHERE t.${qi(rule.pk[0])} IS NULL`);
        db.exec(`CREATE UNIQUE INDEX ${qi(`delete__${table}_pk`)} ON ${qi(`delete__${table}`)}(${rule.pk.map(qi).join(",")})`);
        manifest.tables[table] = { target_count: counts[table],
          upsert_count: Number(db.prepare(`SELECT count(*) n FROM ${qi(`upsert__${table}`)}`).get().n),
          delete_count: Number(db.prepare(`SELECT count(*) n FROM ${qi(`delete__${table}`)}`).get().n) };
      }
      db.prepare("INSERT INTO _xdr_transfer_manifest(json) VALUES(?)").run(JSON.stringify(manifest));
    } finally { db.close(); }
    const target = new DatabaseSync(staging);
    try {
      target.exec("CREATE TABLE IF NOT EXISTS _xdr_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      target.prepare("INSERT INTO _xdr_meta(key,value) VALUES('revision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(targetRevision);
    } finally { target.close(); }
  }
  if (full) {
    const db = new DatabaseSync(raw);
    try { db.prepare("UPDATE _xdr_meta SET value=? WHERE key='manifest'").run(JSON.stringify(manifest)); } finally { db.close(); }
  }
  await gzipWithSha(raw, data, sha);
  try { unlinkSync(raw); } catch {}
  return { data, sha, manifest };
}
