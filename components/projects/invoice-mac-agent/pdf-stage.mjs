// PDF 下载落盘、完整性校验（%PDF- 魔数 + SHA256）
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export class PdfIntegrityError extends Error {
  constructor(message) { super(message); this.name = 'PdfIntegrityError'; }
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeFileName(value) {
  const name = path.basename(String(value || 'invoice.pdf')).replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').slice(0, 160);
  return name.toLowerCase().endsWith('.pdf') ? name : `${name || 'invoice'}.pdf`;
}

export async function stagePdf(cloud, job, stagingDir) {
  if (!job || typeof job.job_id !== 'string' || !job.job_id) throw Error('任务缺少 job_id');
  const dir = path.join(stagingDir, job.job_id.replace(/[^a-zA-Z0-9._-]/g, '_'));
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  fs.chmodSync(dir, 0o700);
  const dest = path.join(dir, safeFileName(job.payload?.fileName));
  const downloaded = await cloud.download(job, dest);
  const bytes = fs.readFileSync(downloaded.path);
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new PdfIntegrityError(`文件不是 PDF（魔数错误）: ${job.job_id}`);
  }
  return {path: downloaded.path, sha256: sha256(bytes), size: bytes.length};
}

export function cleanupStage(jobId, stagingDir) {
  const safeJobId = String(jobId).replace(/[^a-zA-Z0-9._-]/g, '_');
  fs.rmSync(path.join(stagingDir, safeJobId), {recursive: true, force: true});
}
