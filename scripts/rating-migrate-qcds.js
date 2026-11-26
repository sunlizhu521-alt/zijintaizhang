import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync, mkdirSync, renameSync, rmSync, chmodSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { previewQcdsMigration, applyQcdsMigration } from '../server/rating-migration.js';

const flags = new Map();
for (let index = 2; index < process.argv.length; index++) {
  const key = process.argv[index];
  if (['--apply', '--help'].includes(key)) { if (flags.has(key)) throw new Error(`重复参数 ${key}`); flags.set(key, true); }
  else if (['--database', '--backup-dir', '--expected-rule', '--expected-revision', '--expected-latest-rule', '--actor'].includes(key) && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) { if (flags.has(key)) throw new Error(`重复参数 ${key}`); flags.set(key, process.argv[++index]); }
  else throw new Error(`未知参数或缺少参数值：${key}`);
}
if (flags.has('--help')) {
  console.log('默认只读预览。应用：node scripts/rating-migrate-qcds.js --database /绝对路径/gongyingshangpingji.sqlite --apply --expected-rule 原月份规则ID或0 --expected-revision 原月份版本或0 --expected-latest-rule 最新规则ID --actor 管理员账号');
  process.exit(0);
}
const databasePath = resolve(flags.get('--database') || join(process.env.DATA_DIR || 'data', 'gongyingshangpingji.sqlite'));
if (!existsSync(databasePath)) throw new Error('评级数据库不存在；未创建空库，请指定服务器现有数据库');
const readOnly = new DatabaseSync(databasePath, { readOnly: true });
let database;
try {
  const preview = previewQcdsMigration(readOnly);
  console.log(JSON.stringify({ preview }, null, 2));
  if (flags.has('--apply') && !['already-applied', 'already-ds'].includes(preview.action)) {
    const number = key => { const value = flags.get(key); if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`应用须提供有效的 ${key}`); return Number(value); };
    const expectedRuleId = number('--expected-rule'), expectedRevision = number('--expected-revision'), expectedLatestRuleId = number('--expected-latest-rule');
    if (expectedRuleId !== preview.expectedRuleId || expectedRevision !== preview.expectedRevision || expectedLatestRuleId !== preview.latestRuleId) throw new Error('预期版本与现状不符，未写入数据库');
    const actor = readOnly.prepare('SELECT id,username FROM users WHERE username=? AND active=1 AND is_admin=1').get(flags.get('--actor') || '');
    if (!actor) throw new Error('应用须通过 --actor 指定启用的管理员账号');
    if (!readOnly.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rating_rule_archives'").get()) throw new Error('请先部署并启动支持QCDS迁移的新版本，再执行迁移');
    process.umask(0o077);
    const backupDir = resolve(flags.get('--backup-dir') || join(dirname(databasePath), '../backups'));
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const backupPath = join(backupDir, `rating-before-qcds-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.sqlite`), temporary = `${backupPath}.tmp`;
    try {
      await backup(readOnly, temporary);
      chmodSync(temporary, 0o600);
      const copy = new DatabaseSync(temporary);
      try { copy.exec('PRAGMA journal_mode=DELETE'); const checked = copy.prepare('PRAGMA quick_check').all(); if (checked.length !== 1 || Object.values(checked[0])[0] !== 'ok' || copy.prepare('PRAGMA foreign_key_check').all().length) throw new Error('迁移前数据库备份校验失败'); }
      finally { copy.close(); }
      renameSync(temporary, backupPath);
      chmodSync(backupPath, 0o600);
    } catch (error) { rmSync(temporary, { force: true }); throw error; }
    database = new DatabaseSync(databasePath);
    database.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const result = applyQcdsMigration(database, { expectedRuleId, expectedRevision, expectedLatestRuleId, actorId: actor.id });
    console.log(JSON.stringify({ backupPath, result }, null, 2));
  } else if (flags.has('--apply')) console.log('未重复执行：已有迁移结果或11月已使用D/S模型，评分保留。');
} finally { database?.close(); readOnly.close(); }
