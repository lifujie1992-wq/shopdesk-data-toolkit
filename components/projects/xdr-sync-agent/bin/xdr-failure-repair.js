#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { repairOnce, repairStatus } from '../src/failure-repair.js';
import { enqueueIncident, REPAIR_CONFIG, REPAIR_STATE } from '../src/failure-incidents.js';
const { values } = parseArgs({ options: {
  status: { type: 'boolean' }, once: { type: 'boolean' }, 'config': { type: 'string', default: REPAIR_CONFIG },
  'state-dir': { type: 'string', default: REPAIR_STATE }, task: { type: 'string' }, reason: { type: 'string' }, id: { type: 'string' },
} });
try {
  const options = { configPath: values.config, stateDir: values['state-dir'] };
  if (values.status) console.log(JSON.stringify(repairStatus(options.stateDir), null, 2));
  else if (values.task) {
    if (!values.reason) throw new Error('missing_reason');
    const key = enqueueIncident({ task: values.task, id: values.id || `manual:${values.task}:${Date.now()}`, reason: values.reason, failed_at: new Date().toISOString() }, options);
    console.log(JSON.stringify({ queued: key }));
  } else console.log(JSON.stringify({ at: new Date().toISOString(), repair: await repairOnce(options) }));
} catch {
  console.error(JSON.stringify({ at: new Date().toISOString(), repair: { error: 'repair_worker_failed', hint: '检查var/failure-repair状态及failure-repair.err.log；原始告警30分钟后兜底' } }));
  process.exitCode = 1;
}
