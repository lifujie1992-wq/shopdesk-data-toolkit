import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('生产launchd每分钟执行有上限的一轮，不常驻或快速重启', () => {
  const plist = fs.readFileSync(new URL('../launchd/local.invoice-mac-agent.plist', import.meta.url), 'utf8');
  assert.match(plist, /<string>[^<]*\/agent\.mjs<\/string>\s*<string>--once<\/string>/);
  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>60<\/integer>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.doesNotMatch(plist, /<key>(KeepAlive|ThrottleInterval)<\/key>/);
});

test('采集清理独立在每日04:10以后台低CPU和IO优先级执行', () => {
  const plist = fs.readFileSync(new URL('../launchd/local.invoice-capture-cleanup.plist', import.meta.url), 'utf8');
  assert.match(plist, /<string>[^<]*\/capture-cleanup-cli\.mjs<\/string>\s*<string>--once<\/string>/);
  assert.match(plist, /<key>Hour<\/key><integer>4<\/integer><key>Minute<\/key><integer>10<\/integer>/);
  assert.match(plist, /<key>ProcessType<\/key><string>Background<\/string>/);
  assert.match(plist, /<key>Nice<\/key><integer>10<\/integer>/);
  assert.match(plist, /<key>LowPriorityIO<\/key><true\/>/);
  assert.doesNotMatch(plist, /<key>(KeepAlive|RunAtLoad|StartInterval)<\/key>/);
});
