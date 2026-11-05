import { writeFileSync, readFileSync, renameSync, unlinkSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export function writePrivate(path, contents) {
  const output = resolve(path), tmp = `${output}.${randomUUID()}.tmp`;
  try { writeFileSync(tmp, contents, { mode: 0o600, flag: 'wx' }); renameSync(tmp, output); }
  finally { try { unlinkSync(tmp); } catch {} }
  return output;
}

export function saveSnapshot(path, snapshot) {
  if (!path.endsWith('.sqlite')) return writePrivate(path, JSON.stringify(snapshot, null, 2) + '\n');
  const output = resolve(path), tmp = `${output}.${randomUUID()}.tmp`;
  writeFileSync(tmp, '', { mode: 0o600, flag: 'wx' });
  const db = new DatabaseSync(tmp);
  try {
    db.exec('BEGIN; CREATE TABLE snapshot (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL); CREATE TABLE orders (o_id TEXT PRIMARY KEY, json TEXT NOT NULL); CREATE TABLE details (o_id TEXT PRIMARY KEY, json TEXT NOT NULL); CREATE TABLE order_items (o_id TEXT, position INTEGER, json TEXT NOT NULL, PRIMARY KEY(o_id,position)); CREATE TABLE order_pays (o_id TEXT, position INTEGER, json TEXT NOT NULL, PRIMARY KEY(o_id,position)); CREATE TABLE order_actions (o_id TEXT, position INTEGER, json TEXT NOT NULL, PRIMARY KEY(o_id,position)); CREATE TABLE order_aftersales (o_id TEXT, position INTEGER, json TEXT NOT NULL, PRIMARY KEY(o_id,position));');
    db.prepare('INSERT INTO snapshot VALUES (1,?)').run(JSON.stringify(snapshot));
    for (const row of snapshot.rows) db.prepare('INSERT INTO orders VALUES (?,?)').run(String(row.o_id), JSON.stringify(row));
    for (const d of snapshot.details) {
      db.prepare('INSERT INTO details VALUES (?,?)').run(d.o_id, JSON.stringify(d));
      for (const [table, values] of [['order_items', d.order.items], ['order_pays', d.order.pays], ['order_actions', d.order.actions], ['order_aftersales', d.aftersales]]) {
        if (!Array.isArray(values)) continue;
        const insert = db.prepare(`INSERT INTO ${table} VALUES (?,?,?)`);
        values.forEach((v, i) => insert.run(d.o_id, i, JSON.stringify(v)));
      }
    }
    db.exec('COMMIT');
    db.close();
    chmodSync(tmp, 0o600);
    renameSync(tmp, output);
  } catch (e) { try { db.close(); } catch {} throw e; }
  finally { try { unlinkSync(tmp); } catch {} }
  return output;
}

export function loadSnapshot(path) {
  if (!path.endsWith('.sqlite')) return JSON.parse(readFileSync(path, 'utf8'));
  const db = new DatabaseSync(path, { readOnly: true });
  try { return JSON.parse(db.prepare('SELECT json FROM snapshot WHERE id=1').get().json); } finally { db.close(); }
}

export function schemaOf(snapshot) {
  const fields = new Map();
  function walk(value, path) {
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (!fields.has(path)) fields.set(path, new Set());
    fields.get(path).add(type);
    if (Array.isArray(value)) value.forEach(v => walk(v, path + '[]'));
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, path ? path + '.' + k : k);
  }
  snapshot.rows.forEach(r => walk(r, 'list'));
  snapshot.details.forEach(d => walk(d, 'detail'));
  return { captured_at: snapshot.captured_at, rows: snapshot.rows.length, details: snapshot.details.length, columns: snapshot.columns.map(c => ({ id: c.id, name: c.name, help: c.help, type: c.dt, visible: c.show && c.u_show })), fields: [...fields].sort(([a], [b]) => a.localeCompare(b)).map(([path, types]) => ({ path, types: [...types] })) };
}
