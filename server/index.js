import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { openDatabase, pruneLogs } from './db.js';
import { createApp } from './app.js';
import { initializeStorage } from './storage.js';
import { refreshParsedVersions } from './refresh-parsed.js';

const port = Number(process.env.PORT || 4010);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT必须是1024至65535之间的独立端口');
const production = process.env.NODE_ENV === 'production';
const origin = process.env.PUBLIC_ORIGIN || '';
if (production && !/^https:\/\/[^/]+$/.test(origin)) throw new Error('生产环境必须设置PUBLIC_ORIGIN为HTTPS正式入口（不带路径）');
const dataDir = path.resolve(process.env.DATA_DIR || 'data');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const db = openDatabase(path.join(dataDir, 'zijintaizhang.sqlite'));
initializeStorage(db);
await refreshParsedVersions(db);
const ratingDb = openDatabase(path.join(dataDir, 'gongyingshangpingji.sqlite'));
const app = createApp({ db, ratingDb, secureCookies: production, publicOrigin: origin,
  trustProxy: process.env.TRUST_PROXY === 'loopback' ? 'loopback' : false });
const server = app.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`资金台账：http://127.0.0.1:${port}/zijintaizhang/`));
server.requestTimeout = 60_000; server.headersTimeout = 15_000;
const cleanup = setInterval(() => {
  pruneLogs(db);
  pruneLogs(ratingDb);
  db.prepare('DELETE FROM upload_drafts WHERE created_at < ?').run(new Date(Date.now() - 3600_000).toISOString());
}, 86400_000).unref();
function stop() { clearInterval(cleanup); server.close(() => { db.close(); ratingDb.close(); process.exit(0); }); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
