import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { CaptureError } from './common.mjs';
import { atomicFile } from './store.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TABLES = ['staff_daily', 'shop_daily', 'shop_snapshots', 'runs', 'shop_runs'];
export const CLOUD_FILE = '/var/lib/xdr-sync/data/feige-customer.sqlite';
export function prepareSnapshot(source, output, {id = randomUUID(), now = new Date().toISOString()} = {}) {
  const input = new DatabaseSync(source, {readOnly: true});
  try { input.exec(`VACUUM INTO '${output.replaceAll("'", "''")}'`); }
  finally { input.close(); }
  fs.chmodSync(output, 0o600);
  const db = new DatabaseSync(output);
  try {
    if (Object.values(db.prepare('PRAGMA quick_check').get())[0] !== 'ok') throw new CaptureError('invalid_snapshot', '本地SQLite完整性校验失败。');
    const incomplete = db.prepare(`SELECT s.stat_date,s.shop_id FROM shop_snapshots s LEFT JOIN staff_daily d
      ON d.stat_date=s.stat_date AND d.shop_id=s.shop_id GROUP BY s.stat_date,s.shop_id HAVING count(d.staff_id)<>s.total_staff LIMIT 1`).get();
    if (incomplete || !db.prepare('SELECT 1 FROM shop_snapshots LIMIT 1').get()) {
      throw new CaptureError('invalid_snapshot', '本地快照为空或逐店客服行数不完整，未上传。');
    }
    const fields = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/fields.json'), 'utf8')).fields;
    const columns = fields.map(f => `json_extract(metrics_json,'$.${f.key}') AS "${f.key}"`).join(',');
    db.exec(`CREATE VIEW v_staff_daily AS SELECT stat_date,shop_id,shop_name,staff_id,staff_name,staff_account,rank,fetched_at,${columns} FROM staff_daily;
      CREATE VIEW v_shop_daily AS SELECT stat_date,shop_id,shop_name,row_kind,fetched_at,${columns} FROM shop_daily;
      CREATE VIEW v_shop_core_daily AS SELECT s.stat_date,s.shop_id,s.shop_name,s.total_staff,s.fetched_at,
        CAST(MAX(CASE WHEN json_extract(j.value,'$.index_name')='loginStaffCnt' THEN json_extract(j.value,'$.y') END) AS INTEGER) AS login_staff,
        CAST(MAX(CASE WHEN json_extract(j.value,'$.index_name')='onlineStaffCnt' THEN json_extract(j.value,'$.y') END) AS INTEGER) AS online_staff,
        CAST(MAX(CASE WHEN json_extract(j.value,'$.index_name')='servStaffCnt' THEN json_extract(j.value,'$.y') END) AS INTEGER) AS serving_staff,
        CAST(MAX(CASE WHEN json_extract(j.value,'$.index_name')='targetHitCnt' THEN json_extract(j.value,'$.y') END) AS INTEGER) AS qualified_staff,
        CAST(NULLIF(json_extract(s.core_json,'$.avgOnlineInfo.index_value'),'') AS REAL) AS avg_online_seconds,
        CAST(NULLIF(json_extract(s.core_json,'$.avgNapInfo.index_value'),'') AS REAL) AS avg_nap_seconds
        FROM shop_snapshots s LEFT JOIN json_each(s.core_json,'$.coreChartInfo.chart_info.data') j
        GROUP BY s.stat_date,s.shop_id;`);
    const counts = Object.fromEntries(TABLES.map(table => [table, db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]));
    const schema = Object.fromEntries(TABLES.map(table => [table, db.prepare(`PRAGMA table_info(${table})`).all().map(c => ({name: c.name, type: c.type, pk: c.pk}))]));
    const contract = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/warehouse-schema.json'), 'utf8'));
    if (JSON.stringify(schema) !== JSON.stringify(contract.tables)) throw new CaptureError('warehouse_schema_changed', '本地表结构与数仓契约不一致，未发布。');
    const dates = db.prepare(`SELECT stat_date,count(*) AS staff_rows,count(distinct shop_id) AS shops FROM staff_daily GROUP BY stat_date ORDER BY stat_date`).all();
    const metadata = {dataset: 'feige_customer', schema_version: 1, publication_id: id, prepared_at: now,
      source: 'feige-customer-daily', target: CLOUD_FILE, row_counts: counts, dates, schema};
    db.exec('CREATE TABLE _warehouse_publication(id INTEGER PRIMARY KEY CHECK(id=1),metadata_json TEXT NOT NULL)');
    db.prepare('INSERT INTO _warehouse_publication VALUES(1,?)').run(JSON.stringify(metadata));
    db.close();
    const sha256 = createHash('sha256').update(fs.readFileSync(output)).digest('hex');
    return {...metadata, sha256, size_bytes: fs.statSync(output).size};
  } finally { if (db.isOpen) db.close(); }
}
function serverConfig() {
  const configFile = path.join(os.homedir(), '.config/xdr-sync-agent/config.json');
  const configured = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')).server || {} : {};
  const identity = configured.identity_file || '~/.ssh/xdr_mac';
  const result = {host: configured.host || '47.114.33.246', port: configured.port || 22,
    identity: identity.startsWith('~/') ? path.join(os.homedir(), identity.slice(2)) : identity};
  if (!/^[a-zA-Z0-9.-]+$/.test(result.host) || !Number.isInteger(Number(result.port))) throw new CaptureError('invalid_cloud_config', '数仓SSH配置格式无效。');
  return result;
}
async function execute(file, args, input, timeout = 180000) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, {timeout, maxBuffer: 2 * 1024 * 1024}, (error, stdout) => {
      if (error) reject(new CaptureError('cloud_transport_failed', '阿里云数仓连接、上传或校验失败。'));
      else resolve(stdout);
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}
export async function publishWarehouse({source, stateDir, executeImpl = execute, config = serverConfig(), sleep = delay} = {}) {
  const id = randomUUID(), staging = path.join(stateDir, 'cloud-staging');
  fs.mkdirSync(staging, {recursive: true, mode: 0o700});
  const snapshot = path.join(staging, id + '.sqlite');
  let manifest;
  const statusPath = path.join(stateDir, 'cloud-status.json');
  try {
    manifest = prepareSnapshot(source, snapshot, {id});
    const sshArgs = ['-i', config.identity, '-p', String(config.port), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', `root@${config.host}`, 'python3', '-'];
    const helper = fs.readFileSync(path.join(ROOT, 'cloud/apply-snapshot.py'), 'utf8');
    const remote = async action => {
      const request = Buffer.from(JSON.stringify({action, manifest})).toString('base64');
      const script = `import base64,json\nREQUEST=json.loads(base64.b64decode("${request}"))\n` + helper;
      let result;
      try { result = JSON.parse(await executeImpl('ssh', sshArgs, script)); }
      catch (error) { if (error instanceof CaptureError) throw error; throw new CaptureError('cloud_invalid_ack', '数仓未返回有效确认结果。'); }
      if (!result.ok) throw new CaptureError('cloud_rejected', `数仓拒绝发布：${result.code || 'validation_failed'}。`);
      return result;
    };
    const remotePath = `/var/lib/xdr-sync/incoming/feige-customer/${id}.sqlite`;
    let receipt;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await remote('prepare');
        await executeImpl('scp', ['-O', '-i', config.identity, '-P', String(config.port), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
          snapshot, `root@${config.host}:${remotePath}`]);
        receipt = await remote('apply');
        break;
      } catch (error) { if (attempt === 2 || error.code === 'cloud_rejected') throw error; await sleep(1000 * (attempt + 1)); }
    }
    if (receipt.sha256 !== manifest.sha256 || TABLES.some(table => receipt.row_counts?.[table] !== manifest.row_counts[table])) {
      throw new CaptureError('cloud_ack_mismatch', '云端确认的校验和或行数与本地不一致。');
    }
    const status = {status: 'success', synced_at: new Date().toISOString(), host: config.host, ...receipt};
    atomicFile(statusPath, JSON.stringify(status, null, 2) + '\n');
    return status;
  } catch (error) {
    atomicFile(statusPath, JSON.stringify({status: 'failed', at: new Date().toISOString(), code: error.code || 'cloud_sync_failed',
      target: CLOUD_FILE, publication_id: id}, null, 2) + '\n');
    throw error;
  } finally { fs.rmSync(snapshot, {force: true}); }
}
