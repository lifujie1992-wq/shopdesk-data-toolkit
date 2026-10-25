#!/usr/bin/env node
// Explicit acceptance test: real Codex, isolated toy project, no business data or notifications.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPAIR_ROOT, loadRepairConfig, atomicJson, enqueueIncident } from '../src/failure-incidents.js';
import { repairOnce } from '../src/failure-repair.js';
const root = join(REPAIR_ROOT, 'var/acceptance', new Date().toISOString().replaceAll(/[:.]/g, '-'));
const project = join(root, 'demo'); mkdirSync(join(project, 'src'), { recursive: true, mode: 0o700 }); mkdirSync(join(project, 'test'));
writeFileSync(join(project, 'package.json'), '{"type":"module"}');
writeFileSync(join(project, 'README.md'), '隔离验收样例：parseAmount应接受千位逗号；真实业务目录禁止修改。请只修src/amount.js。\n');
writeFileSync(join(project, 'src/amount.js'), 'export function parseAmount(value) { return Number(value); }\n');
writeFileSync(join(project, 'test/amount.test.js'), "import test from 'node:test';import assert from 'node:assert/strict';import {parseAmount} from '../src/amount.js';test('thousands separator',()=>assert.equal(parseAmount('1,234.50'),1234.5));test('plain decimal',()=>assert.equal(parseAmount('12.5'),12.5));\n");
const actual = loadRepairConfig(), configPath = join(root, 'config.json'), stateDir = join(root, 'state');
atomicJson(configPath, { ...actual, enabled: true, workerStatuses: [], inventory: join(root, 'board.json'), maxAttempts: 2,
  projects: { smoke: { root: project, autoApply: true, allowPrefixes: ['src/', 'test/'], tests: [[process.execPath, '--test']] } },
  tasks: [{ match: '^acceptance-demo$', project: 'smoke' }] });
atomicJson(join(root, 'board.json'), { tasks: [] });
enqueueIncident({ id: 'acceptance:separator', task: 'acceptance-demo', reason: "隔离验收：parseAmount('1,234.50')返回NaN，test/amount.test.js期望1234.5。请定位、修复并验证。" }, { configPath, stateDir });
const result = await repairOnce({ configPath, stateDir, alertState: join(root, 'alerts'),
  probe: async () => ({ running: false, runs: 1, exit: '1', coalition: 'acceptance' }),
  notify: async event => atomicJson(join(root, 'notification-preview.json'), event), deliver: async () => [] });
atomicJson(join(root, 'result.json'), result);
console.log(JSON.stringify({ root, ...result, fixed_source: readFileSync(join(project, 'src/amount.js'), 'utf8') }));
if (result.status !== 'applied') process.exitCode = 1;
