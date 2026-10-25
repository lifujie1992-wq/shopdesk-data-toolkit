import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {stagePdf, cleanupStage, PdfIntegrityError} from '../pdf-stage.mjs';

test('stagePdf 校验 PDF、计算 SHA256，并清理 staging', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-stage-test-'));
  const bytes = Buffer.from('%PDF-1.4\nfixture');
  const cloud = {async download(_job, dest) { fs.mkdirSync(path.dirname(dest), {recursive: true}); fs.writeFileSync(dest, bytes); return {path: dest, size: bytes.length}; }};
  const result = await stagePdf(cloud, {job_id: 'job/unsafe', payload: {fileName: '../发票.pdf'}}, root);
  assert.equal(result.size, bytes.length);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(path.dirname(result.path), path.join(root, 'job_unsafe'));
  cleanupStage('job/unsafe', root);
  assert.equal(fs.existsSync(path.join(root, 'job_unsafe')), false);
});

test('stagePdf 拒绝非 PDF 内容', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-stage-test-'));
  const cloud = {async download(_job, dest) { fs.mkdirSync(path.dirname(dest), {recursive: true}); fs.writeFileSync(dest, 'not-pdf'); return {path: dest, size: 7}; }};
  await assert.rejects(() => stagePdf(cloud, {job_id: 'job-2', payload: {fileName: 'x.pdf'}}, root), PdfIntegrityError);
});
