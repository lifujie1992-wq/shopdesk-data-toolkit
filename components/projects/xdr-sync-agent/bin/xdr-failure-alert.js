#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { notifyTaskFailure, nativeRunId } from '../src/failure-alerts.js';
const { values } = parseArgs({ options: Object.fromEntries(['task','reason','phase','log','business-date','id'].map(name => [name, { type: 'string' }])) });
try {
  const result = await notifyTaskFailure({ id: values.id || nativeRunId(values.task) || `native:${values.task}:${process.ppid}:${Date.now()}`,
    task: values.task, reason: values.reason, phase: values.phase, log: values.log,
    business_date: values['business-date'], failed_at: new Date().toISOString() });
  console.log(JSON.stringify({ failure_alert: result }));
  if (result.pending) process.exitCode = 1;
} catch {
  console.error(JSON.stringify({ failure_alert: { error: 'alert_unavailable' } }));
  process.exitCode = 1;
}
