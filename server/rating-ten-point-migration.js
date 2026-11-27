import { transaction } from './db.js';
import { calculateRating, isWeightedRule, validRatingScore } from '../shared/rating.js';
import { rules, now, history } from './rating-store.js';

export const TEN_POINT_MIGRATION = 'rating-ten-point-2026-11-27-v1';

// Deployment backs up the database before startup. This transaction also retains
// the exact affected rows; the marker prevents later administrator edits being rescaled.
export function migrateRatingToTenPoints(db) {
  return transaction(db, () => {
    if (db.prepare('SELECT id FROM rating_history WHERE id=?').get(TEN_POINT_MIGRATION)) return false;
    const latest = rules(db);
    const needsScale = rule => isWeightedRule(rule) && rule.items.some(item => item.max === 100);
    const months = db.prepare("SELECT * FROM rating_months WHERE status IN ('open','paused') ORDER BY month").all()
      .filter(month => needsScale(rules(db, month.rule_id)));
    const ruleIds = new Set(months.map(month => month.rule_id));
    if (needsScale(latest)) ruleIds.add(latest.id);
    const originalRules = [...ruleIds].sort((a, b) => a - b).map(id => db.prepare('SELECT * FROM rating_rules WHERE id=?').get(id));
    const originalScores = months.flatMap(month => db.prepare('SELECT * FROM rating_scores WHERE month=?').all(month.month));
    const targets = new Map();
    for (const row of originalRules) {
      const rule = JSON.parse(row.data_json);
      const converted = { ...rule, items: rule.items.map(item => item.max === 100 ? { ...item, max: 10 } : item) };
      const result = db.prepare('INSERT INTO rating_rules(data_json,created_at) VALUES(?,?)').run(JSON.stringify(converted), now());
      targets.set(row.id, Number(result.lastInsertRowid));
    }
    // Converting an older active month must not replace a newer custom template.
    if (targets.size && !targets.has(latest.id)) {
      db.prepare('INSERT INTO rating_rules(data_json,created_at) VALUES(?,?)').run(db.prepare('SELECT data_json FROM rating_rules WHERE id=?').get(latest.id).data_json, now());
    }
    for (const month of months) {
      const beforeRule = rules(db, month.rule_id), afterRule = rules(db, targets.get(month.rule_id));
      for (const row of originalScores.filter(score => score.month === month.month)) {
        const before = JSON.parse(row.data_json), scores = { ...before.scores };
        for (const item of beforeRule.items) {
          const value = scores[item.id];
          if (value == null) continue;
          if (!validRatingScore(beforeRule, item, value)) throw new Error(`${month.month}存在无效评分，未执行10分制转换`);
          if (item.max === 100) scores[item.id] = value / 10;
        }
        const oldResult = calculateRating(beforeRule, before.scores), newResult = calculateRating(afterRule, scores);
        for (const key of Object.keys(oldResult.groups)) {
          const a = oldResult.groups[key], b = newResult.groups[key];
          if (a == null ? b != null : b == null || Math.abs(a - b) > 1e-8) throw new Error('10分制转换后结果不一致，已回滚');
        }
        db.prepare('UPDATE rating_scores SET data_json=?,revision=revision+1 WHERE month=? AND supplier_id=? AND user_id=?')
          .run(JSON.stringify({ ...before, scores }), row.month, row.supplier_id, row.user_id);
      }
      db.prepare('UPDATE rating_months SET rule_id=?,revision=revision+1 WHERE month=?').run(afterRule.id, month.month);
      history(db, { id: '', displayName: '系统升级' }, '评分项目改为10分制，原评分按比例保留', month.month, '', { fromRuleId: beforeRule.id, toRuleId: afterRule.id });
    }
    db.prepare('INSERT INTO rating_history(id,month,supplier_id,user_id,action,data_json,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(TEN_POINT_MIGRATION, '', '', '', '10分制升级备份', JSON.stringify({ rules: originalRules, months, scores: originalScores, targets: Object.fromEntries(targets) }), now());
    return true;
  });
}
