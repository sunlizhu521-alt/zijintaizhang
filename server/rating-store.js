import { randomUUID } from 'node:crypto';
import { transaction, audit } from './db.js';
import { QCDS_RULE, calculateRating, ratingModel, normalizeRatingScore, ratingMonth, roundScore, ratingGrade } from '../shared/rating.js';
export const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export const textValue = (value, name, max = 2000, required = true) => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw fail(`${name}无效或未填写`);
  return value.trim();
};
export function monthValue(value) { if (typeof value !== 'string' || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(value)) throw fail('月份格式应为 YYYY-MM'); return value; }
export const now = () => new Date().toISOString();
export const decode = row => row ? { ...row, ...JSON.parse(row.data_json || '{}'), data_json: undefined } : null;
export function initializeRating(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS rating_rules(id INTEGER PRIMARY KEY AUTOINCREMENT, data_json TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS rating_suppliers(id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS rating_months(month TEXT PRIMARY KEY, rule_id INTEGER NOT NULL REFERENCES rating_rules(id), status TEXT NOT NULL DEFAULT 'open', revision INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS rating_assignments(month TEXT NOT NULL REFERENCES rating_months(month), supplier_id TEXT NOT NULL REFERENCES rating_suppliers(id), data_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(month,supplier_id));
    CREATE TABLE IF NOT EXISTS rating_scores(month TEXT NOT NULL, supplier_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL DEFAULT 'draft', data_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, PRIMARY KEY(month,supplier_id,user_id), FOREIGN KEY(month,supplier_id) REFERENCES rating_assignments(month,supplier_id));
    CREATE TABLE IF NOT EXISTS rating_records(id TEXT PRIMARY KEY, month TEXT NOT NULL, supplier_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), data_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, FOREIGN KEY(month,supplier_id) REFERENCES rating_assignments(month,supplier_id));
    CREATE TABLE IF NOT EXISTS rating_history(id TEXT PRIMARY KEY, month TEXT NOT NULL, supplier_id TEXT NOT NULL DEFAULT '', user_id TEXT NOT NULL, action TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS rating_snapshots(month TEXT NOT NULL REFERENCES rating_months(month), version INTEGER NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(month,version));
    CREATE TABLE IF NOT EXISTS rating_rule_archives(migration_key TEXT PRIMARY KEY, month TEXT NOT NULL REFERENCES rating_months(month), from_rule_id INTEGER NOT NULL REFERENCES rating_rules(id), to_rule_id INTEGER NOT NULL REFERENCES rating_rules(id), data_json TEXT NOT NULL, created_at TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS rating_imports(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), filename TEXT NOT NULL, content BLOB NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL, committed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS rating_assignment_imports(id TEXT PRIMARY KEY, month TEXT NOT NULL REFERENCES rating_months(month), user_id TEXT NOT NULL REFERENCES users(id), filename TEXT NOT NULL, content BLOB NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL, committed INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS rating_records_month ON rating_records(month,supplier_id);`);
  if (!db.prepare('SELECT id FROM rating_rules LIMIT 1').get()) db.prepare('INSERT INTO rating_rules(data_json,created_at) VALUES(?,?)').run(JSON.stringify(QCDS_RULE), now());
}
export function rules(db, id) { return decode(id ? db.prepare('SELECT * FROM rating_rules WHERE id=?').get(id) : db.prepare('SELECT * FROM rating_rules ORDER BY id DESC LIMIT 1').get()); }
export function monthRow(db, month, writable = false) {
  monthValue(month);
  const row = db.prepare('SELECT * FROM rating_months WHERE month=?').get(month);
  if (!row) throw fail('管理员尚未开启此月份', 404);
  if (writable && row.status !== 'open') throw fail(row.status === 'paused' ? '此月份已临时关闭，请管理员恢复评分后操作' : '此月份已结月，请管理员重开后操作', 409);
  return row;
}
export function checkRevision(row, revision) { if ((row?.revision || 0) !== revision) throw fail('数据已更新，请刷新后核对；未保存内容仍保留', 409); }
export function checkRule(m, ruleId) { if (m.rule_id !== ruleId) throw fail('本月评分规则已变化，请刷新后按新规则重新评分；旧版内容未自动套用', 409); }
export function assignment(db, month, supplierId, user, writable = false) {
  monthRow(db, month, writable);
  const row = decode(db.prepare('SELECT * FROM rating_assignments WHERE month=? AND supplier_id=?').get(month, supplierId));
  if (!row || (!user.isAdmin && !row.raters.some(r => r.id === user.id))) throw fail('没有此供应商当月的访问权限', 403);
  if (writable && row.exempt) throw fail('此供应商本月不参评', 409);
  return row;
}
export function history(db, user, action, month = '', supplierId = '', data = {}) {
  db.prepare('INSERT INTO rating_history VALUES(?,?,?,?,?,?,?)').run(randomUUID(), month, supplierId, user.id, action, JSON.stringify(data), now());
  audit(db, { actor: user, kind: 'operation', action, target: `${month}/${supplierId}`, outcome: 'success' });
}
export function monthBundle(db, month, user) {
  const m = monthRow(db, month);
  const rule = rules(db, m.rule_id);
  const assignments = db.prepare("SELECT * FROM rating_assignments WHERE month=? ORDER BY json_extract(data_json,'$.code')").all(month).map(decode).filter(a => user.isAdmin || a.raters.some(r => r.id === user.id));
  const ids = new Set(assignments.map(a => a.supplier_id));
  const scores = db.prepare('SELECT * FROM rating_scores WHERE month=?').all(month).map(decode).filter(s => ids.has(s.supplier_id));
  const avg = values => values.reduce((sum, value) => sum + value, 0) / values.length;
  const model = ratingModel(rule), totalMax = model === 'ds' ? 30 : 100;
  const summaries = assignments.map(a => {
    const submitted = scores.filter(s => s.supplier_id === a.supplier_id && s.status === 'submitted' && a.raters.some(r => r.id === s.user_id));
    const count = a.exempt ? 0 : submitted.length;
    const itemScores = Object.fromEntries(rule.items.map(item => [item.id, count ? submitted.reduce((sum, s) => sum + s.scores[item.id], 0) / count : null]));
    const calculated = count ? submitted.map(s => calculateRating(rule, s.scores)) : [];
    const totalRaw = count ? avg(calculated.map(s => s.totalRaw)) : null;
    const groups = Object.fromEntries([...new Set(rule.items.map(i => i.group))].map(g => [g, count ? avg(calculated.map(s => s.groups[g])) : null]));
    const normalizedItemScores = Object.fromEntries(rule.items.map(i => [i.id, normalizeRatingScore(i, itemScores[i.id])]));
    return { supplierId: a.supplier_id, code: a.code, name: a.name, month, ruleId: rule.id, model, totalMax, capCount: calculated.filter(s => s.capApplied).length, itemNames: Object.fromEntries(rule.items.map(i => [i.id, i.name])), exempt: a.exempt, reason: a.reason, expected: a.exempt ? 0 : a.raters.length, count, totalRaw, total: roundScore(totalRaw), grade: model === 'ds' ? '—' : ratingGrade(totalRaw), groups, itemScores, normalizedItemScores, status: m.status, closed: m.status === 'closed' };
  });
  const recordRules = new Map([[rule.id, rule]]);
  const records = db.prepare('SELECT * FROM rating_records WHERE month=? ORDER BY updated_at DESC').all(month).map(decode).filter(r => ids.has(r.supplier_id) && (user.isAdmin || r.user_id === user.id)).map(r => {
    const sourceRuleId = r.sourceRuleId || rule.id;
    if (!recordRules.has(sourceRuleId)) recordRules.set(sourceRuleId, rules(db, sourceRuleId));
    return { ...r, sourceRuleId, itemName: r.itemName || recordRules.get(sourceRuleId)?.items.find(i => i.id === r.item)?.name || r.item };
  });
  return { month: m, rule, assignments: assignments.map(a => user.isAdmin ? a : { ...a, raters: a.raters.filter(r => r.id === user.id) }), summaries,
    scores: scores.filter(s => user.isAdmin || s.user_id === user.id),
    records,
    ruleArchives: user.isAdmin ? db.prepare('SELECT migration_key,month,from_rule_id,to_rule_id,created_at FROM rating_rule_archives WHERE month=? ORDER BY created_at DESC').all(month) : [],
    snapshots: db.prepare('SELECT month,version,created_at FROM rating_snapshots WHERE month=? ORDER BY version DESC').all(month),
    assignmentImport: user.isAdmin ? db.prepare('SELECT id,filename,created_at,json_extract(data_json,\'$.summary\') summary FROM rating_assignment_imports WHERE month=? AND committed=1 ORDER BY created_at DESC,rowid DESC LIMIT 1').get(month) || null : null };
}
export function dashboard(db, year, user) {
  if (!/^20\d{2}$/.test(String(year))) throw fail('年份无效');
  const months = db.prepare('SELECT month FROM rating_months WHERE substr(month,1,4)=? ORDER BY month').all(String(year));
  const all = months.flatMap(m => monthBundle(db, m.month, { isAdmin: true }).summaries);
  const visible = months.flatMap(m => monthBundle(db, m.month, user).summaries);
  const groups = [];
  const supplierIds = [...new Set(visible.map(s => s.supplierId))];
  for (const supplierId of supplierIds) for (const model of ['legacy', 'ds']) for (let q = 0; q <= 4; q++) {
    const relevant = all.filter(s => s.supplierId === supplierId && s.model === model && (q === 0 || Math.ceil(Number(s.month.slice(5)) / 3) === q) && s.closed && s.count);
    if (!relevant.length || relevant.some(s => !visible.some(v => v.month === s.month && v.supplierId === supplierId))) continue;
    const avg = values => values.reduce((a, b) => a + b, 0) / values.length;
    const totalRaw = avg(relevant.map(s => s.totalRaw));
    const dimensions = [...new Set(relevant.flatMap(s => Object.keys(s.groups)))];
    const itemIds = [...new Set(relevant.flatMap(s => Object.keys(s.normalizedItemScores)))];
    // A dimension absent from an older rule is not a zero score.
    groups.push({ supplierId, code: relevant[0].code, name: relevant.at(-1).name, model, totalMax: model === 'ds' ? 30 : 100, period: q ? `Q${q}` : 'year', months: relevant.map(s => s.month), count: relevant.length, partial: relevant.length < (q ? 3 : 12) || relevant.some(s => s.count < s.expected), mixedRules: new Set(relevant.map(s => s.ruleId)).size > 1, totalRaw, total: roundScore(totalRaw), grade: model === 'ds' ? '—' : ratingGrade(totalRaw), capCount: relevant.reduce((sum, s) => sum + s.capCount, 0), itemNames: Object.assign({}, ...relevant.map(s => s.itemNames)), normalizedItemScores: Object.fromEntries(itemIds.map(id => [id, relevant.every(s => s.normalizedItemScores[id] != null) ? avg(relevant.map(s => s.normalizedItemScores[id])) : null])), groups: Object.fromEntries(dimensions.map(g => [g, relevant.every(s => Object.hasOwn(s.groups, g) && s.groups[g] != null) ? avg(relevant.map(s => s.groups[g])) : null])) });
  }
  return { monthly: visible, periods: groups };
}
export function openMonth(db, user, month, sourceMonth) {
  monthValue(month);
  if (month > ratingMonth()) throw fail('尚未到该月份，不能提前开启评分');
  return transaction(db, () => {
    if (db.prepare('SELECT month FROM rating_months WHERE month=?').get(month)) throw fail('该月份已开启', 409);
    if (sourceMonth) { monthValue(sourceMonth); if (sourceMonth >= month) throw fail('只能复制更早月份的名单'); }
    db.prepare('INSERT INTO rating_months(month,rule_id) VALUES(?,?)').run(month, rules(db).id);
    if (sourceMonth) {
      for (const a of db.prepare('SELECT * FROM rating_assignments WHERE month=?').all(sourceMonth).map(decode)) {
        const s = db.prepare('SELECT * FROM rating_suppliers WHERE id=? AND active=1').get(a.supplier_id);
        if (!s) continue;
        const raters = a.raters.filter(r => db.prepare('SELECT id FROM users WHERE id=? AND active=1').get(r.id));
        db.prepare('INSERT INTO rating_assignments(month,supplier_id,data_json) VALUES(?,?,?)').run(month, s.id, JSON.stringify({ code: s.code, name: s.name, raters, exempt: false, reason: '' }));
      }
    }
    history(db, user, '开启评分月份', month, '', { sourceMonth });
    return monthRow(db, month);
  });
}
