import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { initializeEmptySalesAnalysis, copySalesAnalysisFromSqlite } from '../src/sales-analysis-sqlite.js';

test('inventory-only initialization needs no upstream calls; hourly reuse preserves both sources', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jst-batch-schema-'));
  const sourcePath = join(dir, 'source.sqlite');
  initializeEmptySalesAnalysis({ outputPath: sourcePath });
  const source = new DatabaseSync(sourcePath);
  for (const table of ['sale_channel_snapshots', 'sale_channel_batch_snapshots']) {
    source.prepare(`INSERT INTO ${table} VALUES('sku','A','channel','2026-09-09T06:00:00Z',1,?)`)
      .run(JSON.stringify({ sku_id: 'A', rows: [{ platform: '拼多多', pay_qty_today: null, pay_qty_3d: 0 }] }));
  }
  source.close();
  const targetPath = join(dir, 'target.sqlite');
  copySalesAnalysisFromSqlite({ sourcePath, outputPath: targetPath });
  const target = new DatabaseSync(targetPath, { readOnly: true });
  for (const table of ['sale_channel_snapshots', 'sale_channel_batch_snapshots']) {
    const snapshot = JSON.parse(target.prepare(`SELECT raw_json FROM ${table}`).get().raw_json);
    assert.equal(snapshot.rows[0].pay_qty_today, null);
    assert.equal(snapshot.rows[0].pay_qty_3d, 0);
  }
  target.close();
  const legacy = new DatabaseSync(sourcePath);
  legacy.exec('DROP TABLE sale_channel_batch_snapshots'); legacy.close();
  const legacyTarget = join(dir, 'legacy-target.sqlite');
  copySalesAnalysisFromSqlite({ sourcePath, outputPath: legacyTarget });
  const migrated = new DatabaseSync(legacyTarget, { readOnly: true });
  assert.equal(migrated.prepare('SELECT COUNT(*) n FROM sale_channel_batch_snapshots').get().n, 0);
  assert.equal(migrated.prepare('SELECT COUNT(*) n FROM sale_channel_snapshots').get().n, 1);
  migrated.close();
});
