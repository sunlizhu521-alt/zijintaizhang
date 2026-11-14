import { Worker } from 'node:worker_threads';
import { fail } from './storage.js';
let running = 0;
export async function runParser(action, buffer, options) {
  if (running >= 1) throw fail(429, '正在处理其他文件，请稍后重试');
  running++;
  try {
    return await new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./parser-worker.js', import.meta.url), {
        workerData: { action, buffer, options }, resourceLimits: { maxOldGenerationSizeMb: 128 },
      });
      let settled = false;
      const finish = (error, value) => {
        if (settled) return; settled = true; clearTimeout(timer); void worker.terminate();
        error ? reject(error) : resolve(value);
      };
      const timer = setTimeout(() => finish(fail(422, '文件处理超过30秒，请减少文件内容后重新上传')), 30_000);
      worker.once('message', m => finish(m.error ? Object.assign(fail(m.status, m.error), { issues: m.issues }) : null, m.result));
      worker.once('error', error => {
        console.error('Workbook worker failed:', error.code || error.name);
        finish(fail(422, '文件处理失败或超过内存限制，请检查文件格式和大小'));
      });
      worker.once('exit', code => { if (!settled) finish(fail(422, `文件处理未完成（${code}）`)); });
    });
  } finally { running--; }
}
