import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeCompletedChannels } from '../src/publish-channels.js';

test('publishes only complete SKU snapshots and leaves source and unfinished data intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'publish-channels-'));
  const sourcePath = join(dir, 'source.sqlite'), targetPath = join(dir, 'target.sqlite');
  const source = new DatabaseSync(sourcePath), target = new DatabaseSync(targetPath);
  source.exec('CREATE TABLE sale_channel_complete(query_type TEXT,product_id TEXT,captured_at TEXT,json TEXT); CREATE TABLE sale_channel_pages(product_id TEXT,json TEXT);');
  const snapshot = { query_type: 'sku', count_type: 'channel', product_id: '001', sku_id: '001',
    captured_at: '2026-09-09T00:00:00Z', total: 1, rows: [{ shop_id: -1, platform: '拼多多', pay_qty_today: null, pay_qty_3d: 0 }] };
  source.prepare('INSERT INTO sale_channel_complete VALUES(?,?,?,?)').run('sku','001',snapshot.captured_at,JSON.stringify(snapshot));
  source.exec("INSERT INTO sale_channel_pages VALUES('002','{}')");
  target.exec("CREATE TABLE sku_inventory(sku_id TEXT PRIMARY KEY); INSERT INTO sku_inventory VALUES('001'),('002');");
  assert.deepEqual(mergeCompletedChannels(sourcePath,targetPath), { published_skus: 1, published_shop_rows: 1, scope: 'completed_skus_only' });
  assert.deepEqual(JSON.parse(target.prepare('SELECT raw_json FROM sale_channel_snapshots').get().raw_json),snapshot);
  assert.equal(source.prepare('SELECT count(*) n FROM sale_channel_complete').get().n,1);
  assert.equal(source.prepare('SELECT count(*) n FROM sale_channel_pages').get().n,1);
  source.close(); target.close();
});
