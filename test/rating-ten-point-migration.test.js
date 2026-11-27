import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.js';
import { initializeRating, rules, monthBundle } from '../server/rating-store.js';
import { QCDS_RULE, RATING_ITEMS } from '../shared/rating.js';
import { migrateRatingToTenPoints, TEN_POINT_MIGRATION } from '../server/rating-ten-point-migration.js';

const rows = (db, table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
function fixture(t) {
  const db = openDatabase(':memory:'); t.after(() => db.close()); initializeRating(db);
  db.prepare('INSERT INTO users(id,username,display_name,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('rater', 'rater', '合成评价人', 'unused', '2026-11-01', '2026-11-01');
  const old = { ...QCDS_RULE, items: QCDS_RULE.items.map(i => ({ ...i, max: 100, standard: '保留人工标准' })) };
  const insertRule = rule => Number(db.prepare('INSERT INTO rating_rules(data_json,created_at) VALUES(?,?)').run(JSON.stringify(rule), '2026-11-01').lastInsertRowid);
  const legacyId = insertRule({ items: RATING_ITEMS }), oldId = insertRule(old);
  db.prepare('INSERT INTO rating_suppliers(id,code,name) VALUES(?,?,?)').run('supplier', 'internal', '合成供应商');
  for (const [month, state, ruleId] of [['2026-08', 'open', legacyId], ['2026-09', 'closed', oldId], ['2026-10', 'open', oldId], ['2026-11', 'paused', oldId]]) {
    db.prepare('INSERT INTO rating_months(month,status,rule_id) VALUES(?,?,?)').run(month, state, ruleId);
    db.prepare('INSERT INTO rating_assignments(month,supplier_id,data_json) VALUES(?,?,?)').run(month, 'supplier', JSON.stringify({ name: '合成供应商', raters: [{ id: 'rater', name: '合成评价人' }] }));
    const scores = Object.fromEntries((ruleId === legacyId ? RATING_ITEMS : old.items).map(i => [i.id, i.max]));
    if (ruleId === oldId) { scores.urgent = 40; scores.after_sales = 0; scores.delivery_ontime = 85; }
    if (state === 'paused') { scores.urgent = null; delete scores.cooperation; }
    db.prepare('INSERT INTO rating_scores(month,supplier_id,user_id,status,data_json,updated_at) VALUES(?,?,?,?,?,?)').run(month, 'supplier', 'rater', state === 'paused' ? 'draft' : 'submitted', JSON.stringify({ scores, notes: { urgent: '保留原依据' }, verified: state !== 'paused', raterName: '合成评价人' }), '2026-11-01');
  }
  db.prepare('INSERT INTO rating_snapshots(month,version,data_json,created_at) VALUES(?,?,?,?)').run('2026-09', 1, JSON.stringify(monthBundle(db, '2026-09', { isAdmin: true })), '2026-11-01');
  db.prepare('INSERT INTO rating_records(id,month,supplier_id,user_id,data_json,updated_at) VALUES(?,?,?,?,?,?)').run('record', '2026-11', 'supplier', 'rater', JSON.stringify({ item: 'urgent', issue: '原过程记录', state: '处理中' }), '2026-11-01');
  return { db, oldId, insertRule };
}
const tables = ['rating_rules', 'rating_months', 'rating_scores', 'rating_assignments', 'rating_history', 'rating_records', 'rating_snapshots'];
const snapshot = db => Object.fromEntries(tables.map(table => [table, rows(db, table)]));

test('当前D/S月份原位等值换算，暂停/草稿/依据保留，已结月和旧模型不变，重复启动不重改', t => {
  const { db } = fixture(t), before = snapshot(db);
  const summary = monthBundle(db, '2026-10', { isAdmin: true }).summaries[0];
  assert.equal(migrateRatingToTenPoints(db), true);
  const after = monthBundle(db, '2026-10', { isAdmin: true });
  assert.ok(after.rule.items.every(i => i.max === 10 && i.standard === '保留人工标准'));
  assert.deepEqual(after.summaries[0].groups, summary.groups); assert.equal(after.summaries[0].total, summary.total);
  assert.equal(after.scores[0].scores.delivery_ontime, 8.5); assert.equal(after.scores[0].scores.after_sales, 0);
  assert.equal(after.scores[0].notes.urgent, '保留原依据'); assert.equal(after.scores[0].status, 'submitted');
  assert.equal(after.scores[0].revision, 2); assert.equal(after.scores[0].updated_at, '2026-11-01');
  const paused = monthBundle(db, '2026-11', { isAdmin: true });
  assert.equal(paused.month.status, 'paused'); assert.equal(paused.scores[0].status, 'draft');
  assert.equal(paused.scores[0].scores.urgent, null); assert.equal(paused.scores[0].scores.cooperation, undefined);
  for (const table of ['rating_months', 'rating_scores']) assert.deepEqual(rows(db, table).filter(r => r.month < '2026-10'), before[table].filter(r => r.month < '2026-10'));
  assert.deepEqual(rows(db, 'rating_assignments'), before.rating_assignments);
  assert.deepEqual(rows(db, 'rating_records'), before.rating_records); assert.deepEqual(rows(db, 'rating_snapshots'), before.rating_snapshots);
  const backup = JSON.parse(db.prepare('SELECT data_json FROM rating_history WHERE id=?').get(TEN_POINT_MIGRATION).data_json);
  assert.deepEqual(backup.scores, before.rating_scores.filter(r => r.month >= '2026-10').map(r => ({ ...r })));
  const applied = snapshot(db); assert.equal(migrateRatingToTenPoints(db), false); assert.deepEqual(snapshot(db), applied);
});

test('迁移中断完全回滚，重试可成功；最新定制模板不被旧月份覆盖', t => {
  const { db, insertRule } = fixture(t);
  insertRule({ ...QCDS_RULE, items: QCDS_RULE.items.map(i => ({ ...i, standard: '最新定制标准' })) });
  const before = snapshot(db);
  db.exec("CREATE TRIGGER fail_scale BEFORE UPDATE OF rule_id ON rating_months BEGIN SELECT RAISE(ABORT,'合成迁移中断'); END");
  assert.throws(() => migrateRatingToTenPoints(db), /合成迁移中断/); assert.deepEqual(snapshot(db), before);
  db.exec('DROP TRIGGER fail_scale'); migrateRatingToTenPoints(db);
  assert.ok(rules(db).items.every(i => i.max === 10 && i.standard === '最新定制标准'));
});

test('无效旧分数阻止迁移且不部分写入', t => {
  const { db } = fixture(t);
  db.prepare("UPDATE rating_scores SET data_json=json_set(data_json,'$.scores.urgent',101) WHERE month='2026-10'").run();
  const before = snapshot(db); assert.throws(() => migrateRatingToTenPoints(db), /无效评分/); assert.deepEqual(snapshot(db), before);
});
