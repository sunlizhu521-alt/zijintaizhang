import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { migrateRatingToTenPoints } from './rating-ten-point-migration.js';
import { createAuth } from './auth.js';
import { transaction, audit, serializeAudit } from './db.js';
import { runParser } from './parse-job.js';
import { RATING_BASE, RATING_PERMISSIONS, validRatingScore, validateRatingRule } from '../shared/rating.js';
import { initializeRating, fail, textValue, monthValue, now, decode, rules, monthRow, checkRevision, checkRule, assignment, history, monthBundle, dashboard, openMonth } from './rating-store.js';
import { supplierTemplate, exportRating, exportRatingPeriod } from './rating-excel.js';
import { prepareAssignmentImport, applyAssignmentImport } from './rating-assignment-import.js';
const can = (user, key) => user.isAdmin || user.permissions.includes(key);
function filterModel(data, model) {
  if (model !== undefined && !['ds', 'legacy'].includes(model)) throw fail('评分模型无效');
  return model ? { model, monthly: data.monthly.filter(s => s.model === model), periods: data.periods.filter(s => s.model === model) } : data;
}
function exportResponse(res, name, buffer) { res.attachment(`${name}.xlsx`).type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(Buffer.from(buffer)); }
function supplierInput(input, before) { return { code: textValue(input.code ?? before?.code ?? `S${randomUUID()}`, '供应商标识', 80), name: textValue(input.name, '供应商名称', 200), active: input.active === undefined ? before ? !!before.active : true : input.active !== false }; }
export function createRatingApi(db, { secureCookies = false, publicOrigin = '' } = {}) {
  initializeRating(db);
  migrateRatingToTenPoints(db);
  const api = express.Router();
  const auth = createAuth(db, { secureCookies, basePath: RATING_BASE, apiPath: `${RATING_BASE}/api`, cookieName: 'gongyingshangpingji_session', permissions: RATING_PERMISSIONS });
  api.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  api.use(auth.securityMiddleware);
  api.use((req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && ((req.get('origin') && req.get('origin') !== (publicOrigin || `${req.protocol}://${req.get('host')}`)) || req.get('sec-fetch-site') === 'cross-site')) throw fail('请求来源不匹配', 403);
    next();
  });
  api.use(express.json({ limit: '128kb' }));
  api.use((req, res, next) => { if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('multipart/form-data') && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) throw fail('请求内容必须是JSON对象'); next(); });
  api.get('/health', (_req, res) => res.json({ status: 'ok', app: 'gongyingshangpingji', release: process.env.RELEASE_SHA || 'local' }));
  api.use(auth.csrfProtection);
  api.use('/auth', auth.router);
  api.use(auth.authenticate);
  api.use('/users', auth.userRouter);
  api.get('/bootstrap', (req, res) => res.json({ months: db.prepare('SELECT * FROM rating_months ORDER BY month DESC').all().filter(m => req.user.isAdmin || db.prepare('SELECT data_json FROM rating_assignments WHERE month=?').all(m.month).some(a => JSON.parse(a.data_json).raters.some(r => r.id === req.user.id))), rule: rules(db), suppliers: req.user.isAdmin ? db.prepare('SELECT * FROM rating_suppliers ORDER BY code').all() : [], users: req.user.isAdmin ? db.prepare('SELECT id,display_name,username,active,is_admin FROM users ORDER BY display_name').all() : [] }));
  api.get('/months/:month', (req, res) => {
    if (!can(req.user, 'rate') && !can(req.user, 'dashboard')) throw fail('没有查看权限', 403);
    const bundle = monthBundle(db, req.params.month, req.user);
    if (!can(req.user, 'dashboard')) bundle.summaries = [];
    res.json(bundle);
  });
  api.get('/dashboard', auth.requirePermission('dashboard'), (req, res) => res.json(filterModel(dashboard(db, req.query.year, req.user), req.query.model)));
  api.get('/dashboard/export', auth.requirePermission('dashboard'), auth.requirePermission('export'), async (req, res) => {
    const { year, period, supplier, grade, model } = req.query;
    if (!['Q1', 'Q2', 'Q3', 'Q4', 'year'].includes(period)) throw fail('请选择季度或全年');
    if (supplier !== undefined && (typeof supplier !== 'string' || supplier.length > 80)) throw fail('供应商筛选无效');
    if (grade !== undefined && !['A', 'B', 'C', 'D'].includes(grade)) throw fail('等级无效');
    const data = filterModel(dashboard(db, year, req.user), model);
    data.periods = data.periods.filter(s => (!supplier || s.supplierId === supplier) && (!grade || s.grade === grade));
    const buffer = await exportRatingPeriod(data, year, period);
    audit(db, { actor: req.user, kind: 'operation', action: '导出期间评级汇总', target: `${year}/${period}`, outcome: 'success' });
    exportResponse(res, `供应商评级_${year}_${period === 'year' ? '全年' : period}_V1`, buffer);
  });
  api.post('/months', auth.requireAdmin, (req, res) => res.json(openMonth(db, req.user, req.body.month, req.body.sourceMonth)));
  api.put('/months/:month/assignments/:supplier', auth.requireAdmin, (req, res) => res.json(transaction(db, () => {
    const month = req.params.month, supplierId = req.params.supplier;
    monthRow(db, month, true);
    const supplier = db.prepare('SELECT * FROM rating_suppliers WHERE id=?').get(supplierId);
    if (!supplier) throw fail('供应商不存在', 404);
    const before = decode(db.prepare('SELECT * FROM rating_assignments WHERE month=? AND supplier_id=?').get(month, supplierId));
    checkRevision(before, req.body.revision);
    if (!Array.isArray(req.body.userIds) || req.body.userIds.length > 200 || new Set(req.body.userIds).size !== req.body.userIds.length) throw fail('评价人名单无效');
    const raters = req.body.userIds.map(id => { const row = db.prepare('SELECT * FROM users WHERE id=?').get(id); if (!row || (!row.active && !before?.raters.some(r => r.id === id)) || (!row.is_admin && !JSON.parse(row.permissions_json).includes('rate'))) throw fail('评价人不存在、停用或没有评分权限'); return { id, name: row.display_name }; });
    const exempt = req.body.exempt === true, reason = textValue(req.body.reason || '', '不参评原因', 2000, exempt);
    // Legacy exempt entries may have no raters; restore first, then the workbook fills them.
    if (!exempt && !raters.length && !(before?.exempt && !before.raters.length)) throw fail('请上传履约表识别至少一位评价人');
    const submitted = db.prepare("SELECT user_id FROM rating_scores WHERE month=? AND supplier_id=? AND status='submitted'").all(month, supplierId);
    if (submitted.some(s => exempt || !raters.some(r => r.id === s.user_id))) throw fail('请先由原评价人撤回已提交评分，再调整范围', 409);
    const data = { code: before?.code || supplier.code, name: before?.name || supplier.name, raters, exempt, reason };
    db.prepare('INSERT INTO rating_assignments(month,supplier_id,data_json) VALUES(?,?,?) ON CONFLICT(month,supplier_id) DO UPDATE SET data_json=excluded.data_json,revision=revision+1').run(month, supplierId, JSON.stringify(data));
    history(db, req.user, '调整评价范围', month, supplierId, { before, after: data });
    return { ok: true };
  })));
  api.put('/months/:month/scores/:supplier', auth.requirePermission('rate'), (req, res) => res.json(transaction(db, () => {
    const month = req.params.month, supplierId = req.params.supplier;
    const a = assignment(db, month, supplierId, req.user, true);
    if (!a.raters.some(r => r.id === req.user.id)) throw fail('未被指定为此供应商的评价人', 403);
    const m = monthRow(db, month); checkRule(m, req.body.ruleId);
    const before = decode(db.prepare('SELECT * FROM rating_scores WHERE month=? AND supplier_id=? AND user_id=?').get(month, supplierId, req.user.id));
    checkRevision(before, req.body.revision);
    if (before?.status === 'submitted') throw fail('请先撤回已提交评分再修改', 409);
    const { scores, notes, verified } = req.body;
    if (!scores || typeof scores !== 'object' || Array.isArray(scores) || !notes || typeof notes !== 'object' || Array.isArray(notes)) throw fail('评分内容无效');
    if (!['draft', 'submitted'].includes(req.body.status)) throw fail('评分状态无效');
    const rule = rules(db, m.rule_id), items = rule.items;
    const values = {}, evidence = {};
    for (const item of items) {
      const value = scores[item.id];
      if (value !== null && value !== undefined && !validRatingScore(rule, item, value)) throw fail(`${item.name}须为0至${item.max}分${rule.model === 'ds' && item.max === 10 ? '，最多一位小数' : '的整数'}`);
      values[item.id] = value ?? null;
      evidence[item.id] = textValue(notes[item.id] || '', `${item.name}依据`, 2000, false);
      if (req.body.status === 'submitted' && values[item.id] === null) throw fail(`${item.name}未填写`);
    }
    if (req.body.status === 'submitted' && verified !== true) throw fail('请确认已核实当月业务和评分依据');
    const data = { scores: values, notes: evidence, verified: verified === true, raterName: req.user.displayName };
    db.prepare('INSERT INTO rating_scores(month,supplier_id,user_id,status,data_json,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(month,supplier_id,user_id) DO UPDATE SET status=excluded.status,data_json=excluded.data_json,updated_at=excluded.updated_at,revision=revision+1').run(month, supplierId, req.user.id, req.body.status, JSON.stringify(data), now());
    history(db, req.user, req.body.status === 'submitted' ? '提交评分' : '保存草稿', month, supplierId, { before, after: data });
    return decode(db.prepare('SELECT * FROM rating_scores WHERE month=? AND supplier_id=? AND user_id=?').get(month, supplierId, req.user.id));
  })));
  api.post('/months/:month/scores/:supplier/withdraw', auth.requirePermission('rate'), (req, res) => res.json(transaction(db, () => {
    const { month, supplier } = req.params;
    assignment(db, month, supplier, req.user, true);
    checkRule(monthRow(db, month), req.body.ruleId);
    const row = decode(db.prepare('SELECT * FROM rating_scores WHERE month=? AND supplier_id=? AND user_id=?').get(month, supplier, req.user.id));
    if (!row || row.status !== 'submitted') throw fail('没有可撤回的评分', 409);
    checkRevision(row, req.body.revision);
    db.prepare("UPDATE rating_scores SET status='draft',revision=revision+1,updated_at=? WHERE month=? AND supplier_id=? AND user_id=?").run(now(), month, supplier, req.user.id);
    history(db, req.user, '撤回评分', month, supplier, row);
    return { ok: true };
  })));
  api.post('/months/:month/pause', auth.requireAdmin, (req, res) => res.json(transaction(db, () => {
    const m = monthRow(db, req.params.month); checkRevision(m, req.body.revision);
    if (m.status !== 'open') throw fail('仅评分中的月份可临时关闭', 409);
    db.prepare("UPDATE rating_months SET status='paused',revision=revision+1 WHERE month=?").run(m.month);
    history(db, req.user, '临时关闭评价', m.month);
    return { ok: true };
  })));
  api.post('/months/:month/resume', auth.requireAdmin, (req, res) => res.json(transaction(db, () => {
    const m = monthRow(db, req.params.month); checkRevision(m, req.body.revision);
    if (m.status !== 'paused') throw fail('仅临时关闭的月份可恢复评分', 409);
    db.prepare("UPDATE rating_months SET status='open',revision=revision+1 WHERE month=?").run(m.month);
    history(db, req.user, '恢复评分', m.month);
    return { ok: true };
  })));
  api.post('/months/:month/close', auth.requireAdmin, (req, res) => res.json(transaction(db, () => {
    const m = monthRow(db, req.params.month, true); checkRevision(m, req.body.revision);
    const bundle = monthBundle(db, m.month, req.user);
    if (!bundle.assignments.length) throw fail('请先设置供应商及评价范围');
    if (bundle.assignments.some(a => !a.exempt && !a.raters.length)) throw fail('存在未分配评价人的供应商，请先完善名单');
    const incomplete = bundle.summaries.some(s => !s.exempt && s.count < s.expected);
    const reason = textValue(req.body.reason || '', '缺评结月原因', 2000, incomplete);
    if (incomplete && req.body.confirmPartial !== true) throw fail('存在缺评，请核对后明确确认', 409);
    db.prepare("UPDATE rating_months SET status='closed',revision=revision+1 WHERE month=?").run(m.month);
    const version = db.prepare('SELECT COALESCE(MAX(version),0)+1 n FROM rating_snapshots WHERE month=?').get(m.month).n;
    const snapshot = { ...monthBundle(db, m.month, req.user), closeReason: reason };
    db.prepare('INSERT INTO rating_snapshots VALUES(?,?,?,?)').run(m.month, version, JSON.stringify(snapshot), now());
    history(db, req.user, '结月', m.month, '', { version, reason, incomplete });
    return { ok: true, version };
  })));
  api.post('/months/:month/reopen', auth.requireAdmin, (req, res) => res.json(transaction(db, () => {
    const m = monthRow(db, req.params.month); checkRevision(m, req.body.revision);
    if (m.status !== 'closed') throw fail('该月份尚未结月', 409);
    const reason = textValue(req.body.reason, '重开原因');
    db.prepare("UPDATE rating_months SET status='open',revision=revision+1 WHERE month=?").run(m.month);
    history(db, req.user, '重开月份', m.month, '', { reason });
    return { ok: true };
  })));
  api.put('/records/:id', auth.requirePermission('rate'), (req, res) => res.json(transaction(db, () => {
    const before = decode(db.prepare('SELECT * FROM rating_records WHERE id=?').get(req.params.id));
    checkRevision(before, req.body.revision);
    const month = before?.month || monthValue(req.body.month), supplierId = before?.supplier_id || textValue(req.body.supplierId, '供应商ID', 80);
    assignment(db, month, supplierId, req.user);
    if (before && !req.user.isAdmin && before.user_id !== req.user.id) throw fail('不能修改他人的过程记录', 403);
    const m = monthRow(db, month);
    if (!before) checkRule(m, req.body.ruleId);
    const sourceRuleId = before?.sourceRuleId || m.rule_id;
    const sourceRule = rules(db, sourceRuleId);
    const data = {};
    for (const key of ['item', 'issue', 'attribution', 'action', 'owner', 'dueDate', 'completedDate', 'state', 'review']) data[key] = textValue(req.body[key] || '', key, 2000, ['item', 'issue', 'state'].includes(key));
    if (before && sourceRuleId !== m.rule_id && data.item !== before.item) throw fail('原规则过程记录的关联项目不能更改');
    const item = sourceRule?.items.find(i => i.id === data.item);
    if (!item || !['待处理', '处理中', '已完成'].includes(data.state)) throw fail('项目或状态无效');
    data.sourceRuleId = sourceRuleId; data.itemName = item.name;
    for (const key of ['dueDate', 'completedDate']) if (data[key] && (!/^20\d{2}-\d{2}-\d{2}$/.test(data[key]) || !Number.isFinite(Date.parse(data[key])) || new Date(data[key]).toISOString().slice(0, 10) !== data[key])) throw fail('日期无效');
    if (data.state === '已完成' && !data.completedDate) throw fail('完成记录须填写实际完成日期');
    if (!req.user.isAdmin) data.review = before?.review || '';
    if (!/^[a-f0-9-]{36}$/.test(req.params.id)) throw fail('过程记录ID无效');
    const id = req.params.id;
    db.prepare('INSERT INTO rating_records(id,month,supplier_id,user_id,data_json,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at,revision=revision+1').run(id, month, supplierId, before?.user_id || req.user.id, JSON.stringify(data), now());
    history(db, req.user, '保存过程记录', month, supplierId, { id, before, after: data });
    return { ok: true, id };
  })));
  api.post('/suppliers', auth.requireAdmin, (req, res) => res.json(transaction(db, () => {
    const s = supplierInput(req.body);
    if (db.prepare('SELECT id FROM rating_suppliers WHERE code=?').get(s.code)) throw fail('供应商编码已存在', 409);
    if (db.prepare('SELECT id FROM rating_suppliers WHERE name=?').get(s.name)) throw fail('供应商名称已存在，请在名单中查看或编辑', 409);
    const id = randomUUID(); db.prepare('INSERT INTO rating_suppliers(id,code,name,active) VALUES(?,?,?,?)').run(id, s.code, s.name, Number(s.active));
    history(db, req.user, '新增供应商', '', id, s); return { id };
  })));
  api.put('/suppliers/:id', auth.requireAdmin, (req, res) => res.json(transaction(db, () => {
    const before = db.prepare('SELECT * FROM rating_suppliers WHERE id=?').get(req.params.id);
    if (!before) throw fail('供应商不存在', 404); checkRevision(before, req.body.revision);
    const s = supplierInput(req.body, before); if (s.code !== before.code) throw fail('供应商历史关联不能修改');
    if (db.prepare('SELECT id FROM rating_suppliers WHERE name=? AND id<>?').get(s.name, before.id)) throw fail('该供应商名称已存在，请核对是否同一家', 409);
    db.prepare('UPDATE rating_suppliers SET name=?,active=?,revision=revision+1 WHERE id=?').run(s.name, Number(s.active), before.id);
    history(db, req.user, '更新供应商', '', before.id, { before, after: s }); return { ok: true };
  })));
  api.get('/suppliers/template', auth.requireAdmin, async (_req, res) => exportResponse(res, '供应商名单模板_仅名称', await supplierTemplate()));
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 0, parts: 1 } });
  api.post('/months/:month/assignment-import/preview', auth.requireAdmin, upload.single('file'), async (req, res) => {
    monthRow(db, req.params.month, true);
    if (!req.file || !/\.xlsx$/i.test(req.file.originalname)) throw fail('请选择 .xlsx 采购履约表');
    const parsed = await runParser('ratingAssignments', req.file.buffer, {});
    auth.authenticate(req, res, () => auth.requireAdmin(req, res, () => {
      const preview = prepareAssignmentImport(db, req.params.month, parsed), id = randomUUID();
      const filename = Buffer.from(req.file.originalname, 'latin1').toString('utf8').slice(0, 240);
      db.prepare('DELETE FROM rating_assignment_imports WHERE committed=0 AND created_at<?').run(new Date(Date.now() - 3600000).toISOString());
      db.prepare('INSERT INTO rating_assignment_imports(id,month,user_id,filename,content,data_json,created_at) VALUES(?,?,?,?,?,?,?)').run(id, req.params.month, req.user.id, filename, req.file.buffer, JSON.stringify(preview), now());
      const { baseline, ...visible } = preview;
      res.json({ ...visible, id, filename });
    }));
  });
  api.post('/months/:month/assignment-import/commit', auth.requireAdmin, (req, res) => res.json(transaction(db, () => {
    const draft = db.prepare('SELECT * FROM rating_assignment_imports WHERE id=? AND month=? AND user_id=? AND committed=0 AND created_at>?').get(req.body.id, req.params.month, req.user.id, new Date(Date.now() - 3600000).toISOString());
    if (!draft) throw fail('导入预览失效，请重新上传', 409);
    return applyAssignmentImport(db, req.user, draft, req.body);
  })));
  api.get('/months/:month/assignment-import/:id/download', auth.requireAdmin, (req, res) => {
    const file = db.prepare('SELECT filename,content FROM rating_assignment_imports WHERE id=? AND month=? AND committed=1').get(req.params.id, req.params.month);
    if (!file) throw fail('未找到已确认的履约表', 404);
    res.attachment(file.filename).type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(Buffer.from(file.content));
  });
  api.post('/suppliers/import/preview', auth.requireAdmin, upload.single('file'), async (req, res) => {
    if (!req.file || !/\.xlsx$/i.test(req.file.originalname)) throw fail('请选择 .xlsx 文件');
    const rows = await runParser('ratingSuppliers', req.file.buffer, {});
    auth.authenticate(req, res, () => auth.requireAdmin(req, res, () => {
      const preview = rows.map(row => {
        const matches = db.prepare('SELECT * FROM rating_suppliers WHERE name=?').all(row.name);
        if (matches.length > 1) throw fail(`“${row.name}”存在多条同名记录，请先在名单中核对`, 409);
        const before = matches[0];
        return { ...row, code: before?.code || `S${randomUUID()}`, active: row.active ?? (before ? !!before.active : true), byName: true, before: before || null };
      });
      const id = randomUUID();
      db.prepare('DELETE FROM rating_imports WHERE committed=0 AND created_at<?').run(new Date(Date.now() - 3600000).toISOString());
      db.prepare('INSERT INTO rating_imports(id,user_id,filename,content,data_json,created_at) VALUES(?,?,?,?,?,?)').run(id, req.user.id, Buffer.from(req.file.originalname, 'latin1').toString('utf8').slice(0, 240), req.file.buffer, JSON.stringify(preview), now());
      res.json({ id, rows: preview });
    }));
  });
  api.post('/suppliers/import/commit', auth.requireAdmin, (req, res) => res.json(transaction(db, () => {
    const draft = db.prepare('SELECT * FROM rating_imports WHERE id=? AND user_id=? AND committed=0 AND created_at>?').get(req.body.id, req.user.id, new Date(Date.now() - 3600000).toISOString());
    if (!draft) throw fail('导入预览失效，请重新上传', 409);
    const rows = JSON.parse(draft.data_json);
    for (const s of rows) {
      if (s.byName) {
        const matches = db.prepare('SELECT * FROM rating_suppliers WHERE name=?').all(s.name);
        if (matches.length > 1 || (matches[0]?.id || null) !== (s.before?.id || null)) throw fail('供应商名单已变化，请重新上传核对', 409);
      }
      const before = db.prepare('SELECT * FROM rating_suppliers WHERE code=?').get(s.code);
      checkRevision(before, s.before?.revision || 0);
      if (before) db.prepare('UPDATE rating_suppliers SET name=?,active=?,revision=revision+1 WHERE id=?').run(s.name, Number(s.active), before.id);
      else db.prepare('INSERT INTO rating_suppliers(id,code,name,active) VALUES(?,?,?,?)').run(randomUUID(), s.code, s.name, Number(s.active));
    }
    db.prepare('UPDATE rating_imports SET committed=1 WHERE id=?').run(draft.id);
    history(db, req.user, '导入供应商名单', '', '', { importId: draft.id, count: rows.length }); return { count: rows.length };
  })));
  api.post('/rules', auth.requireAdmin, (req, res) => res.json(transaction(db, () => {
    if (req.body.baseId !== rules(db).id) throw fail('规则已更新，请刷新核对', 409);
    let clean;
    try { clean = validateRatingRule(req.body); } catch (error) { throw fail(error.message); }
    db.prepare('INSERT INTO rating_rules(data_json,created_at) VALUES(?,?)').run(JSON.stringify(clean), now());
    history(db, req.user, '发布新评分规则', '', '', clean); return rules(db);
  })));
  api.get('/months/:month/rule-archives/:archive/export', auth.requireAdmin, async (req, res) => {
    const month = monthValue(req.params.month);
    const archive = db.prepare('SELECT * FROM rating_rule_archives WHERE month=? AND migration_key=?').get(month, req.params.archive);
    if (!archive) throw fail('原规则评分备份不存在', 404);
    const bundle = JSON.parse(archive.data_json);
    audit(db, { actor: req.user, kind: 'operation', action: '下载原规则评分备份', target: `${month}/${archive.migration_key}`, outcome: 'success' });
    exportResponse(res, `供应商评级_${month}_切换前备份_规则V${archive.from_rule_id}`, await exportRating(bundle));
  });
  api.get('/months/:month/export', auth.requirePermission('export'), async (req, res) => {
    if (!can(req.user, 'dashboard')) throw fail('需要汇总查看权限', 403);
    let bundle = monthBundle(db, req.params.month, req.user), version = 0;
    const selected = req.query.version;
    if (selected !== undefined && !/^[1-9]\d*$/.test(selected)) throw fail('报告版本无效');
    const snap = selected ? db.prepare('SELECT * FROM rating_snapshots WHERE month=? AND version=?').get(req.params.month, Number(selected)) : bundle.month.status === 'closed' ? db.prepare('SELECT * FROM rating_snapshots WHERE month=? ORDER BY version DESC LIMIT 1').get(req.params.month) : null;
    if (selected && !snap) throw fail('报告版本不存在', 404);
    if (snap) {
      const permitted = new Set(bundle.assignments.map(a => a.supplier_id));
      bundle = JSON.parse(snap.data_json); version = snap.version;
      if (!req.user.isAdmin) {
        for (const key of ['assignments', 'scores', 'records']) bundle[key] = bundle[key].filter(r => permitted.has(r.supplier_id) && (key === 'assignments' || r.user_id === req.user.id));
        bundle.summaries = bundle.summaries.filter(s => permitted.has(s.supplierId));
      }
    }
    audit(db, { actor: req.user, kind: 'operation', action: '导出评级报告', target: `${req.params.month}/V${version || 1}`, outcome: 'success' });
    exportResponse(res, `供应商评级_${req.params.month}${version ? '' : '_实时'}_V${version || 1}`, await exportRating(bundle));
  });
  api.get('/history', auth.requireAdmin, (req, res) => {
    const month = req.query.month ? monthValue(req.query.month) : '';
    res.json({ items: db.prepare('SELECT h.id,h.month,h.supplier_id,h.action,h.created_at,COALESCE(u.display_name,\'系统升级\') display_name FROM rating_history h LEFT JOIN users u ON u.id=h.user_id WHERE (?=\'\' OR h.month=?) ORDER BY h.created_at DESC LIMIT 200').all(month, month) });
  });
  api.get('/logs', auth.requireAdmin, (_req, res) => res.json({ items: db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100').all().map(serializeAudit) }));
  api.use((_req, _res, next) => next(fail('接口不存在', 404)));
  api.use((error, req, res, _next) => {
    const status = error instanceof multer.MulterError ? 422 : error.status >= 400 && error.status < 600 ? error.status : 500;
    audit(db, { actor: req.user, kind: status === 403 ? 'security' : 'operation', action: '评级请求失败', path: req.originalUrl, outcome: 'failure', status });
    if (status === 500) console.error('Rating request failed:', error.message);
    res.status(status).json({ error: error instanceof multer.MulterError ? '仅支持一个不超过20MB的Excel文件' : status === 500 ? '服务器处理失败，请稍后重试' : error.message });
  });
  return api;
}
