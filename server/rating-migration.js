import { transaction } from './db.js';
import { QCDS_RULE, ratingModel, validateRatingRule } from '../shared/rating.js';
import { fail, rules, monthBundle, decode, now, history } from './rating-store.js';

export const QCDS_MIGRATION_KEY = 'qcds-ds-2026-11-v1';
export const QCDS_MIGRATION_MONTH = '2026-11';
const archiveExists = db => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rating_rule_archives'").get();
const migrationRule = db => db.prepare("SELECT id FROM rating_rules WHERE json_extract(data_json,'$.migrationKey')=? ORDER BY id LIMIT 1").get(QCDS_MIGRATION_KEY);

export function previewQcdsMigration(db) {
  const month = db.prepare('SELECT * FROM rating_months WHERE month=?').get(QCDS_MIGRATION_MONTH) || null;
  const archive = archiveExists(db) ? db.prepare('SELECT migration_key,from_rule_id,to_rule_id,created_at FROM rating_rule_archives WHERE migration_key=?').get(QCDS_MIGRATION_KEY) : null;
  const existingTemplate = migrationRule(db);
  const scores = db.prepare("SELECT status,COUNT(*) count FROM rating_scores WHERE month=? GROUP BY status").all(QCDS_MIGRATION_MONTH);
  const action = archive ? 'already-applied' : month && ratingModel(rules(db, month.rule_id)) === 'ds' ? 'already-ds' : !month || month.status === 'closed' ? 'publish-template-only' : 'switch-and-reevaluate';
  return { migrationKey: QCDS_MIGRATION_KEY, month, action, expectedRuleId: month?.rule_id || 0, expectedRevision: month?.revision || 0, latestRuleId: rules(db).id,
    templateRuleId: existingTemplate?.id || null, archive: archive || null, scores: Object.fromEntries(scores.map(s => [s.status, s.count])),
    recordCount: db.prepare('SELECT COUNT(*) count FROM rating_records WHERE month=?').get(QCDS_MIGRATION_MONTH).count,
    note: action === 'publish-template-only' ? month ? '11月已结月，只发布后续月份模板；不重开、不切换、不清除原评分。' : '11月尚未开启，只发布后续新开月份模板。' : action === 'switch-and-reevaluate' ? '归档原评分（含草稿）后清空活动评分，原月份开关状态和评价名单保留。' : '已执行或已使用D/S模型，不重复清空评分。' };
}

// The CLI creates and verifies an SQLite backup before calling this atomic transition.
export function applyQcdsMigration(db, { expectedRuleId, expectedRevision, expectedLatestRuleId, actorId }) {
  return transaction(db, () => {
    const preview = previewQcdsMigration(db);
    if (['already-applied', 'already-ds'].includes(preview.action)) return { ...preview, applied: false };
    if (preview.expectedRuleId !== expectedRuleId || preview.expectedRevision !== expectedRevision || preview.latestRuleId !== expectedLatestRuleId) throw fail('月份或最新规则已变化，请重新预览并核对预期版本', 409);
    const actor = db.prepare('SELECT id,username FROM users WHERE id=? AND active=1 AND is_admin=1').get(actorId);
    if (!actor) throw fail('迁移操作人必须是启用的管理员', 403);
    let target = migrationRule(db);
    if (!target) {
      const result = db.prepare('INSERT INTO rating_rules(data_json,created_at) VALUES(?,?)').run(JSON.stringify({ ...validateRatingRule(QCDS_RULE), migrationKey: QCDS_MIGRATION_KEY }), now());
      target = { id: Number(result.lastInsertRowid) };
      history(db, actor, '发布D/S评分模板', '', '', { ruleId: target.id, migrationKey: QCDS_MIGRATION_KEY });
    }
    if (preview.action === 'publish-template-only') return { ...preview, templateRuleId: target.id, applied: true, switched: false };
    const month = preview.month, snapshot = monthBundle(db, month.month, { isAdmin: true });
    const scoreCount = db.prepare('SELECT COUNT(*) count FROM rating_scores WHERE month=?').get(month.month).count;
    if (snapshot.scores.length !== scoreCount || snapshot.records.length !== preview.recordCount) throw fail('原评分或过程记录快照数量不一致，未切换', 409);
    snapshot.ruleTransition = { migrationKey: QCDS_MIGRATION_KEY, toRuleId: target.id, note: '切换前原规则备份；包含当时已提交评分和服务器草稿' };
    db.prepare('INSERT INTO rating_rule_archives(migration_key,month,from_rule_id,to_rule_id,data_json,created_at,actor_id) VALUES(?,?,?,?,?,?,?)').run(QCDS_MIGRATION_KEY, month.month, month.rule_id, target.id, JSON.stringify(snapshot), now(), actor.id);
    const oldRule = rules(db, month.rule_id);
    for (const row of db.prepare('SELECT * FROM rating_records WHERE month=?').all(month.month)) {
      const record = decode(row), sourceRuleId = record.sourceRuleId || oldRule.id;
      const sourceRule = sourceRuleId === oldRule.id ? oldRule : rules(db, sourceRuleId);
      const data = { ...JSON.parse(row.data_json), sourceRuleId, itemName: record.itemName || sourceRule?.items.find(i => i.id === record.item)?.name || record.item };
      db.prepare('UPDATE rating_records SET data_json=?,revision=revision+1 WHERE id=?').run(JSON.stringify(data), row.id);
    }
    db.prepare('DELETE FROM rating_scores WHERE month=?').run(month.month);
    db.prepare('UPDATE rating_months SET rule_id=?,revision=revision+1 WHERE month=?').run(target.id, month.month);
    history(db, actor, '切换11月D/S规则并保留原评分备份', month.month, '', { migrationKey: QCDS_MIGRATION_KEY, fromRuleId: month.rule_id, toRuleId: target.id, scoreCount, recordCount: preview.recordCount });
    return { ...preview, applied: true, switched: true, templateRuleId: target.id, archivedScoreCount: scoreCount };
  });
}
