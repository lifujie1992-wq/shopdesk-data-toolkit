#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { callApi, PURCHASE_WARNING_CONTEXT } from '../src/api.js'
import { loadSession } from '../src/chrome-session.js'
import { normalizeShopGroups } from '../src/sqlite-export.js'

const databasePath = process.argv[2]
if (!databasePath) throw new Error('usage: sync-shop-groups-into-sqlite.mjs DATABASE')

const capturedAt = new Date().toISOString()
const payload = await callApi(
  loadSession(), 'query_shop_group_config', {}, {}, PURCHASE_WARNING_CONTEXT,
)
const groups = normalizeShopGroups(payload)
const database = new DatabaseSync(resolve(databasePath))
database.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;')
try {
  database.exec(`
    CREATE TABLE IF NOT EXISTS shop_groups (
      group_id TEXT PRIMARY KEY,
      group_name TEXT NOT NULL,
      shop_count INTEGER NOT NULL,
      captured_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS shop_group_members (
      group_id TEXT NOT NULL,
      shop_id TEXT NOT NULL,
      PRIMARY KEY (group_id, shop_id),
      FOREIGN KEY (group_id) REFERENCES shop_groups(group_id)
    );
    CREATE INDEX IF NOT EXISTS shop_group_members_shop_idx
      ON shop_group_members(shop_id, group_id);
    DELETE FROM shop_group_members;
    DELETE FROM shop_groups;
  `)
  const insertGroup = database.prepare(
    'INSERT INTO shop_groups(group_id,group_name,shop_count,captured_at) VALUES(?,?,?,?)',
  )
  const insertMember = database.prepare(
    'INSERT INTO shop_group_members(group_id,shop_id) VALUES(?,?)',
  )
  let members = 0
  for (const group of groups) {
    insertGroup.run(group.group_id, group.group_name, group.shop_ids.length, capturedAt)
    for (const shopId of group.shop_ids) { insertMember.run(group.group_id, shopId); members++ }
  }
  database.exec('COMMIT;')
  console.log(JSON.stringify({ ok: true, groups: groups.length, members, captured_at: capturedAt }))
} catch (error) {
  database.exec('ROLLBACK;')
  throw error
} finally {
  database.close()
}
