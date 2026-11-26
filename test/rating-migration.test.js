import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../server/db.js';
import { initAdmin } from '../server/auth.js';
import { initializeRating, rules, monthBundle } from '../server/rating-store.js';
import { RATING_ITEMS } from '../shared/rating.js';
import { applyQcdsMigration, previewQcdsMigration, QCDS_MIGRATION_KEY } from '../server/rating-migration.js';

async function fixture(t, status = 'open') {
  const dir = mkdtempSync(join(tmpdir(), 'rating-migration-')), path = join(dir, 'rating.sqlite');
  const db = openDatabase(path);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const actor = await initAdmin(db, { username: 'migration-admin', displayName: '合成管理员', password: 'Migration123' });
  initializeRating(db);
  const legacy = Number(db.prepare('INSERT INTO rating_rules(data_json,created_at) VALUES(?,?)').run(JSON.stringify({ items: RATING_ITEMS }), '2026-11-01T00:00:00.000Z').lastInsertRowid);
  const draftUser = randomUUID();
  db.prepare("INSERT INTO users(id,username,display_name,password_hash,is_admin,permissions_json,created_at,updated_at) SELECT ?, 'draft-user','合成评价人',password_hash,0,'[]',created_at,updated_at FROM users WHERE id=?").run(draftUser, actor.id);
  const supplier = randomUUID();
  db.prepare('INSERT INTO rating_suppliers(id,code,name) VALUES(?,?,?)').run(supplier, 'T1', '合成供应商');
  const stamp = '2026-11-20T08:00:00.000Z';
  if (status) {
    db.prepare('INSERT INTO rating_months(month,rule_id,status,revision) VALUES(?,?,?,3)').run('2026-11', legacy, status);
    db.prepare('INSERT INTO rating_assignments(month,supplier_id,data_json) VALUES(?,?,?)').run('2026-11', supplier, JSON.stringify({ name: '合成供应商', code: 'T1', exempt: false, reason: '', raters: [{ id: actor.id, name: '合成管理员' }, { id: draftUser, name: '合成评价人' }] }));
    for (const [userId, state, data] of [[actor.id, 'submitted', { scores: Object.fromEntries(RATING_ITEMS.map(i => [i.id, i.max])), notes: {}, verified: true, raterName: '合成管理员' }], [draftUser, 'draft', { scores: { ontime: 25, promise: null }, notes: { ontime: '原始草稿依据' }, verified: false, raterName: '合成评价人' }]]) {
      db.prepare('INSERT INTO rating_scores(month,supplier_id,user_id,status,data_json,revision,updated_at) VALUES(?,?,?,?,?,4,?)').run('2026-11', supplier, userId, state, JSON.stringify(data), stamp);
    }
    db.prepare('INSERT INTO rating_records(id,month,supplier_id,user_id,data_json,revision,updated_at) VALUES(?,?,?,?,?,4,?)').run(randomUUID(), '2026-11', supplier, actor.id, JSON.stringify({ item: 'ontime', issue: '旧异常', action: '催交', owner: '合成管理员', state: '处理中', dueDate: '2026-11-30', review: '', attribution: '供应商', completedDate: '' }), stamp);
    const snapshot = monthBundle(db, '2026-11', { isAdmin: true });
    db.prepare('INSERT INTO rating_snapshots(month,version,data_json,created_at) VALUES(?,1,?,?)').run('2026-11', JSON.stringify(snapshot), stamp);
    db.prepare('INSERT INTO rating_assignment_imports(id,month,user_id,filename,content,data_json,created_at,committed) VALUES(?,?,?,?,?,?,?,1)').run(randomUUID(), '2026-11', actor.id, '合成履约.xlsx', Buffer.from('original-file'), '{}', stamp);
  }
  const opts = () => { const p = previewQcdsMigration(db); return { expectedRuleId: p.expectedRuleId, expectedRevision: p.expectedRevision, expectedLatestRuleId: p.latestRuleId, actorId: actor.id }; };
  return { dir, path, db, actor, supplier, draftUser, legacy, opts };
}
const rows = (db, table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
const preserved = db => Object.fromEntries(['rating_assignments', 'rating_assignment_imports', 'rating_snapshots', 'rating_suppliers', 'users'].map(table => [table, rows(db, table)]));

test('新安装默认D/S，11月切换完整归档含草稿，原名单附件历史报告保留且可幂等重跑', async t => {
  const f = await fixture(t);
  assert.equal(rules(f.db, 1).model, 'ds'); assert.equal(rules(f.db, 1).items.length, 7);
  const originalScores = rows(f.db, 'rating_scores'), originalRecords = rows(f.db, 'rating_records'), originals = preserved(f.db), options = f.opts();
  const result = applyQcdsMigration(f.db, options);
  assert.equal(result.switched, true); assert.equal(result.archivedScoreCount, 2);
  assert.deepEqual(preserved(f.db), originals);
  const month = monthBundle(f.db, '2026-11', { isAdmin: true });
  assert.equal(month.month.status, 'open'); assert.equal(month.month.revision, 4); assert.equal(month.rule.model, 'ds'); assert.equal(month.scores.length, 0);
  assert.equal(month.records[0].sourceRuleId, f.legacy); assert.equal(month.records[0].itemName, RATING_ITEMS[0].name); assert.equal(month.records[0].revision, 5);
  assert.equal(month.records[0].updated_at, originalRecords[0].updated_at);
  const archive = f.db.prepare('SELECT * FROM rating_rule_archives WHERE migration_key=?').get(QCDS_MIGRATION_KEY), bundle = JSON.parse(archive.data_json);
  assert.equal(bundle.rule.id, f.legacy); assert.equal(bundle.scores.length, originalScores.length);
  assert.deepEqual(bundle.scores.find(s => s.user_id === f.draftUser).scores, { ontime: 25, promise: null });
  assert.equal(bundle.scores.find(s => s.user_id === f.draftUser).notes.ontime, '原始草稿依据');
  assert.equal(bundle.records[0].revision, 4); assert.equal(bundle.records[0].state, '处理中');
  f.db.prepare('INSERT INTO rating_scores(month,supplier_id,user_id,status,data_json,updated_at) VALUES(?,?,?,?,?,?)').run('2026-11', f.supplier, f.actor.id, 'draft', JSON.stringify({ scores: { urgent: 80 }, notes: {}, verified: false }), '2026-11-26T00:00:00.000Z');
  const newScores = rows(f.db, 'rating_scores'), ruleCount = rows(f.db, 'rating_rules').length;
  assert.equal(applyQcdsMigration(f.db, options).applied, false);
  assert.deepEqual(rows(f.db, 'rating_scores'), newScores); assert.equal(rows(f.db, 'rating_rules').length, ruleCount); assert.equal(rows(f.db, 'rating_rule_archives').length, 1);
});
test('临时关闭状态保留；版本冲突和迁移后半程异常均不产生部分切换', async t => {
  const f = await fixture(t, 'paused'), options = f.opts();
  assert.throws(() => applyQcdsMigration(f.db, { ...options, expectedRevision: 2 }), /重新预览/);
  const tables = ['rating_rules', 'rating_scores', 'rating_records', 'rating_months', 'rating_history', 'rating_rule_archives'];
  const before = Object.fromEntries(tables.map(table => [table, rows(f.db, table)]));
  f.db.exec("CREATE TRIGGER fail_transition BEFORE UPDATE OF rule_id ON rating_months BEGIN SELECT RAISE(ABORT,'合成迁移中断'); END");
  assert.throws(() => applyQcdsMigration(f.db, options), /合成迁移中断/);
  assert.deepEqual(Object.fromEntries(tables.map(table => [table, rows(f.db, table)])), before);
  f.db.exec('DROP TRIGGER fail_transition');
  applyQcdsMigration(f.db, options);
  assert.equal(monthBundle(f.db, '2026-11', { isAdmin: true }).month.status, 'paused');
});
test('11月已结月或未开启只发布后续模板，不改旧月份且不创建假归档', async t => {
  for (const status of ['closed', null]) {
    const f = await fixture(t, status), before = Object.fromEntries(['rating_scores', 'rating_records', 'rating_months'].map(table => [table, rows(f.db, table)])), originals = preserved(f.db);
    assert.equal(previewQcdsMigration(f.db).action, 'publish-template-only');
    const result = applyQcdsMigration(f.db, f.opts());
    assert.equal(result.switched, false); assert.equal(rules(f.db).model, 'ds');
    assert.deepEqual(Object.fromEntries(['rating_scores', 'rating_records', 'rating_months'].map(table => [table, rows(f.db, table)])), before);
    assert.deepEqual(preserved(f.db), originals); assert.equal(rows(f.db, 'rating_rule_archives').length, 0);
    const count = rows(f.db, 'rating_rules').length;
    applyQcdsMigration(f.db, f.opts()); assert.equal(rows(f.db, 'rating_rules').length, count);
  }
});
test('已在D/S模型的月份不自动重评，错误管理员不能迁移', async t => {
  const f = await fixture(t);
  assert.throws(() => applyQcdsMigration(f.db, { ...f.opts(), actorId: f.draftUser }), /启用的管理员/);
  f.db.prepare('UPDATE rating_months SET rule_id=1 WHERE month=?').run('2026-11');
  const before = rows(f.db, 'rating_scores');
  assert.equal(previewQcdsMigration(f.db).action, 'already-ds'); assert.equal(applyQcdsMigration(f.db, f.opts()).applied, false);
  assert.deepEqual(rows(f.db, 'rating_scores'), before);
});
test('迁移CLI默认只读，apply须显式版本与管理员；先生成600权限可校验的完整备份', async t => {
  const f = await fixture(t), options = f.opts(), backupDir = join(f.dir, 'backups');
  const run = args => spawnSync(process.execPath, [resolve('scripts/rating-migrate-qcds.js'), '--database', f.path, '--backup-dir', backupDir, ...args], { encoding: 'utf8' });
  const before = rows(f.db, 'rating_scores');
  const preview = run([]); assert.equal(preview.status, 0, preview.stderr); assert.match(preview.stdout, /switch-and-reevaluate/);
  assert.deepEqual(rows(f.db, 'rating_scores'), before); assert.equal(existsSync(backupDir), false);
  const invalid = run(['--apply']); assert.notEqual(invalid.status, 0); assert.equal(existsSync(backupDir), false);
  const apply = run(['--apply', '--expected-rule', String(options.expectedRuleId), '--expected-revision', String(options.expectedRevision), '--expected-latest-rule', String(options.expectedLatestRuleId), '--actor', 'migration-admin']);
  assert.equal(apply.status, 0, apply.stderr); assert.match(apply.stdout, /"switched": true/);
  const files = readdirSync(backupDir); assert.equal(files.length, 1);
  const backupPath = join(backupDir, files[0]); assert.equal(statSync(backupPath).mode & 0o777, 0o600); assert.equal(statSync(backupDir).mode & 0o777, 0o700);
  const backupDb = new DatabaseSync(backupPath, { readOnly: true });
  try { assert.deepEqual(rows(backupDb, 'rating_scores'), before); assert.equal(backupDb.prepare('PRAGMA foreign_key_check').all().length, 0); assert.equal(backupDb.prepare('SELECT rule_id FROM rating_months WHERE month=?').get('2026-11').rule_id, f.legacy); }
  finally { backupDb.close(); }
});
