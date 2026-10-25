import { DatabaseSync } from 'node:sqlite';

// Publish complete product snapshots only; unfinished pages stay in the source.
export function mergeCompletedChannels(sourcePath, targetPath) {
  if (sourcePath === targetPath) throw new Error('publish_requires_separate_target');
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  const target = new DatabaseSync(targetPath);
  try {
    target.exec(`CREATE TABLE IF NOT EXISTS sale_channel_snapshots (
      query_type TEXT NOT NULL,product_id TEXT NOT NULL,count_type TEXT NOT NULL,
      captured_at TEXT NOT NULL,total INTEGER NOT NULL,raw_json TEXT NOT NULL,
      PRIMARY KEY(query_type,product_id,count_type));`);
    target.exec(`CREATE TABLE IF NOT EXISTS sale_channel_batch_snapshots (
      query_type TEXT NOT NULL,product_id TEXT NOT NULL,count_type TEXT NOT NULL,
      captured_at TEXT NOT NULL,total INTEGER NOT NULL,raw_json TEXT NOT NULL,
      PRIMARY KEY(query_type,product_id,count_type));`);
    const exists = target.prepare('SELECT 1 FROM sku_inventory WHERE sku_id=? LIMIT 1');
    const upsert = target.prepare(`INSERT INTO sale_channel_snapshots VALUES(?,?,?,?,?,?)
      ON CONFLICT(query_type,product_id,count_type) DO UPDATE SET
      captured_at=excluded.captured_at,total=excluded.total,raw_json=excluded.raw_json
      WHERE excluded.captured_at >= sale_channel_snapshots.captured_at`);
    let products = 0, rows = 0;
    target.exec('BEGIN IMMEDIATE');
    try {
      for (const item of source.prepare("SELECT * FROM sale_channel_complete WHERE query_type='sku'").iterate()) {
        const snapshot = JSON.parse(item.json);
        if (snapshot.query_type !== 'sku' || snapshot.count_type !== 'channel'
          || snapshot.sku_id !== item.product_id || snapshot.product_id !== item.product_id
          || snapshot.captured_at !== item.captured_at || !Array.isArray(snapshot.rows)
          || !Number.isInteger(snapshot.total) || snapshot.total !== snapshot.rows.length
          || !exists.get(item.product_id)) throw new Error('invalid_complete_sku_snapshot');
        const result = upsert.run('sku', item.product_id, 'channel', item.captured_at, snapshot.total, item.json);
        products += result.changes; rows += result.changes ? snapshot.total : 0;
      }
      target.exec('COMMIT');
    } catch (error) { target.exec('ROLLBACK'); throw error; }
    return { published_skus: products, published_shop_rows: rows, scope: 'completed_skus_only' };
  } finally { source.close(); target.close(); }
}
