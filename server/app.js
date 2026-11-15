import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { API_PATH, BASE_PATH, MAX_UPLOAD_BYTES, ORDER_SLOT } from '../shared/constants.js';
import { createAuth } from './auth.js';
import { initializePlanner, createPlannerRouter } from './planner.js';
import { audit, serializeAudit } from './db.js';
import { buildDashboard } from './dashboard.js';
import { runParser } from './parse-job.js';
import { dashboardExport, logsExport } from './exports.js';
import { initializeStorage, fail, requireSlot, listSlots, createDraft, getDraft, activateDraft,
  listVersions, getVersion, versionDetails, restoreVersion, activeData } from './storage.js';

const distDefault = fileURLToPath(new URL('../dist/', import.meta.url));
function requestEvent(req) {
  return { actor: req.user?.username || '', ip: req.ip, userAgent: (req.get('user-agent') || '').slice(0, 500),
    method: req.method, path: req.originalUrl.split('?')[0], status: 200 };
}
function filtersFrom(query) {
  const filters = {};
  for (const key of ['from', 'to', 'supplier', 'payer', 'owner', 'category', 'month']) {
    const value = query[key];
    if (value == null || value === '') continue;
    if (typeof value !== 'string' || value.length > 250) throw fail(400, '筛选条件无效');
    filters[key] = value;
  }
  for (const key of ['from', 'to']) if (filters[key] && !/^\d{4}-(0[1-9]|1[0-2])$/.test(filters[key])) throw fail(400, '月份格式应为 YYYY-MM');
  if (filters.month && filters.month !== 'pending' && !/^\d{4}-(0[1-9]|1[0-2])$/.test(filters.month)) throw fail(400, '月份筛选无效');
  if (filters.from && filters.to && filters.from > filters.to) throw fail(400, '开始月份不能晚于结束月份');
  return filters;
}
function excelResponse(res, title, buffer) {
  const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false }).replace(/[: ]/g, '-');
  res.attachment(`${title}_${stamp}_V1.xlsx`).type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(Buffer.from(buffer));
}
function logQuery(db, query, all = false) {
  const kind = query.kind || 'operation';
  if (!['login', 'operation', 'security'].includes(kind)) throw fail(400, '记录类型无效');
  const clauses = ['kind=?']; const params = [kind];
  for (const key of ['from', 'to']) {
    if (!query[key]) continue;
    if (typeof query[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(query[key])) throw fail(400, '日志日期格式无效');
    const date = new Date(`${query[key]}T00:00:00+08:00`);
    if (!Number.isFinite(date.getTime())) throw fail(400, '日志日期无效');
    if (key === 'to') date.setTime(date.getTime() + 86400_000);
    clauses.push(`created_at ${key === 'from' ? '>=' : '<'} ?`); params.push(date.toISOString());
  }
  if (query.actor) {
    if (typeof query.actor !== 'string' || query.actor.length > 100) throw fail(400, '账号筛选无效');
    clauses.push("(instr(actor_name,?)>0 OR instr(COALESCE(json_extract(details_json,'$.attemptedUsername'),''),?)>0)"); params.push(query.actor, query.actor);
  }
  if (query.outcome) {
    if (!['success', 'failure', 'blocked'].includes(query.outcome)) throw fail(400, '结果筛选无效');
    clauses.push('outcome=?'); params.push(query.outcome);
  }
  const where = clauses.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) n FROM audit_logs WHERE ${where}`).get(...params).n;
  const page = Math.max(1, Math.min(100000, Number.parseInt(query.page, 10) || 1));
  const pageSize = all ? 10000 : 50;
  if (all && total > pageSize) throw fail(422, '导出最多10000条，请缩小时间范围');
  const items = db.prepare(`SELECT * FROM audit_logs WHERE ${where} ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, all ? 0 : (page - 1) * pageSize).map(serializeAudit);
  return { items, total, page, pageSize };
}
export function createApp({ db, secureCookies = false, publicOrigin = '', trustProxy = false, distDir = distDefault } = {}) {
  initializeStorage(db);
  initializePlanner(db);
  const app = express(); app.disable('x-powered-by'); app.set('trust proxy', trustProxy);
  const auth = createAuth(db, { secureCookies });
  app.use(helmet({ contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"],
    upgradeInsecureRequests: secureCookies ? [] : null,
  } }, strictTransportSecurity: secureCookies ? undefined : false }));
  const api = express.Router();
  app.use(API_PATH, api);
  api.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  api.use(auth.securityMiddleware);
  api.use((req, res, next) => {
    if (/(?:^|\/)(?:\.env(?:\.|\/|$)|\.git(?:\/|$)|wp-admin(?:\/|$))|\.php(?:\/|$)/i.test(req.path)) {
      audit(db, { ...requestEvent(req), kind: 'security', action: '疑似路径探测', outcome: 'blocked', status: 404 });
      return res.status(404).json({ error: '接口不存在' });
    }
    next();
  });
  api.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const expected = publicOrigin || `${req.protocol}://${req.get('host')}`;
    const origin = req.get('origin');
    if ((origin && origin !== expected) || req.get('sec-fetch-site') === 'cross-site') {
      audit(db, { ...requestEvent(req), kind: 'security', action: '跨站请求已拦截', outcome: 'blocked', status: 403 });
      return res.status(403).json({ error: '请求来源不匹配，请从系统正式地址操作' });
    }
    next();
  });
  api.use(express.json({ limit: '128kb' }));
  api.use((req, res, next) => {
    if (['POST', 'PATCH', 'PUT'].includes(req.method) && !req.is('multipart/form-data') &&
      (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) throw fail(400, '请求内容必须是有效的JSON对象');
    next();
  });
  api.get('/health', (req, res) => res.json({ status: 'ok', app: 'zijintaizhang', release: process.env.RELEASE_SHA || 'local' }));
  api.use(auth.csrfProtection);
  api.use('/auth', auth.router);
  api.use(auth.authenticate);
  api.use('/planner', createPlannerRouter(db));
  api.use('/users', auth.userRouter);
  const permission = auth.requirePermission;
  const dashboard = query => { const data = activeData(db); return buildDashboard(data.records, data.issues, data.slots, filtersFrom(query)); };
  api.get('/dashboard', permission('dashboard'), (req, res) => res.json(dashboard(req.query)));
  api.get('/dashboard/export', permission('dashboard'), permission('export'), async (req, res) => {
    const buffer = await dashboardExport(dashboard(req.query));
    audit(db, { ...requestEvent(req), kind: 'operation', action: '导出看板明细', outcome: 'success', details: filtersFrom(req.query) });
    excelResponse(res, '资金台账', buffer);
  });
  api.get('/files', permission('files'), (req, res) => res.json({ slots: listSlots(db) }));
  api.get('/orders', permission('files'), (req, res) => res.json({ slots: listSlots(db, [ORDER_SLOT]) }));
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0, parts: 1 },
    fileFilter(req, file, cb) { cb(/\.xlsx$/i.test(file.originalname) ? null : fail(422, '仅支持 .xlsx 文件'), /\.xlsx$/i.test(file.originalname)); } });
  api.post('/files/:slotId/preview', permission('files'), permission('upload'), (req, res, next) => { requireSlot(db, req.params.slotId); next(); },
    upload.single('file'), async (req, res) => {
      if (!req.file) throw fail(422, '请选择 Excel 文件');
      const { slotId } = req.params;
      const inspected = await runParser('inspect', req.file.buffer, { slotId });
      const selectedSheets = inspected.sheets.filter(s => inspected.kind === 'archive' || (s.eligible && s.defaultSelected)).map(s => s.name);
      let parsed; let validationError;
      try { parsed = await runParser('parse', req.file.buffer, { slotId, selectedSheets }); }
      catch (error) { if (error.status !== 422) throw error; validationError = error.message; parsed = { records: [], issues: error.issues || [] }; }
      // Browsers send UTF-8 multipart filenames; busboy exposes their header bytes as latin1.
      const decoded = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
      const filename = path.basename(decoded.includes('\uFFFD') ? req.file.originalname : decoded).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 240);
      const draft = createDraft(db, { slotId, userId: req.user.id, filename, content: req.file.buffer });
      const categoryCounts = {};
      parsed.records.forEach(r => { categoryCounts[r.category] = (categoryCounts[r.category] || 0) + 1; });
      res.json({ ...draft, ...(inspected.kind ? { kind: inspected.kind } : {}), filename, sheets: inspected.sheets, selectedSheets, recordCount: parsed.records.length,
        issueCount: parsed.issues.length, issues: parsed.issues, categoryCounts, validationError });
    });
  api.post('/files/:slotId/activate', permission('files'), permission('upload'), async (req, res) => {
    const draft = getDraft(db, req.body.token, req.params.slotId, req.user.id);
    const selectedSheets = req.body.selectedSheets;
    if (!Array.isArray(selectedSheets) || selectedSheets.length > (req.params.slotId === ORDER_SLOT.id ? 5000 : 100) || selectedSheets.some(s => typeof s !== 'string' || s.length > 100)) throw fail(400, '请选择有效的工作表');
    const parsed = await runParser('parse', Buffer.from(draft.content), { slotId: req.params.slotId, selectedSheets });
    // A permission reset during workbook parsing must take effect before activation.
    auth.authenticate(req, res, () => permission('files')(req, res, () => permission('upload')(req, res, () => {
      res.json(activateDraft(db, draft, parsed, req.body.baseRevision, requestEvent(req)));
    })));
  });
  api.get('/files/:slotId/versions', permission('files'), (req, res) => res.json({ versions: listVersions(db, req.params.slotId) }));
  api.get('/files/:slotId/versions/:versionId', permission('files'), (req, res) => res.json(versionDetails(db, req.params.slotId, req.params.versionId)));
  api.get('/files/:slotId/versions/:versionId/download', permission('files'), permission('download'), (req, res) => {
    const version = getVersion(db, req.params.slotId, req.params.versionId);
    audit(db, { ...requestEvent(req), kind: 'operation', action: '下载原始文件', target: version.id, outcome: 'success', details: { slotId: req.params.slotId, filename: version.filename } });
    res.attachment(version.filename).type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(Buffer.from(version.content));
  });
  api.post('/files/:slotId/restore', permission('files'), permission('restore'), (req, res) => {
    res.json(restoreVersion(db, req.params.slotId, req.body.versionId, req.body.baseRevision, requestEvent(req)));
  });
  const logAccess = (req, res, next) => {
    const key = { login: 'logsLogin', operation: 'logsOperation', security: 'logsSecurity' }[req.query.kind || 'operation'];
    if (!key) throw fail(400, '记录类型无效');
    return permission(key)(req, res, next);
  };
  api.get('/logs', logAccess, (req, res) => res.json(logQuery(db, req.query)));
  api.get('/logs/export', logAccess, permission('export'), async (req, res) => {
    const data = logQuery(db, req.query, true);
    audit(db, { ...requestEvent(req), kind: 'operation', action: '导出系统记录', target: req.query.kind || 'operation', outcome: 'success' });
    excelResponse(res, '系统记录', await logsExport(data.items));
  });
  api.use((req, res) => {
    audit(db, { ...requestEvent(req), kind: 'security', action: '访问不存在的接口', outcome: 'blocked', status: 404 });
    res.status(404).json({ error: '接口不存在' });
  });
  const plannerDist = path.join(distDir, 'jihuaguanli');
  if (existsSync(path.join(plannerDist, 'index.html'))) {
    app.get(/^\/jihuaguanli$/, (_req, res) => res.redirect(308, '/jihuaguanli/'));
    app.get(/^\/zijintaizhang\/jihuaguanli\/?$/, (_req, res) => res.redirect(308, '/jihuaguanli/'));
    app.use('/jihuaguanli', express.static(plannerDist, { index: 'index.html', dotfiles: 'deny', maxAge: 0 }));
  }
  if (existsSync(path.join(distDir, 'index.html'))) {
    const ordersHtml = readFileSync(path.join(distDir, 'index.html'), 'utf8')
      .replace(/<title>[^<]*<\/title>/, '<title>采购订单跟进</title>')
      .replace(/(<meta\s+name="description"\s+content=")[^"]*(")/, '$1金蝶采购订单原始文件与版本管理$2');
    app.get(/^\/caigoudingdangenjin\/?$/, (req, res) => {
      if (!req.path.endsWith('/')) return res.redirect(308, '/caigoudingdangenjin/');
      res.set('Cache-Control', 'no-store').type('html').send(ordersHtml);
    });
    app.use(BASE_PATH, express.static(distDir, { index: 'index.html', dotfiles: 'deny', maxAge: 0 }));
    app.get(BASE_PATH, (req, res) => res.redirect(`${BASE_PATH}/`));
  }
  app.get('/', (req, res) => res.redirect(`${BASE_PATH}/`));
  app.use((req, res) => {
    if (/\.(?:env|php)|wp-admin|\.git|\.\./i.test(req.path)) audit(db, { ...requestEvent(req), kind: 'security', action: '疑似路径探测', outcome: 'blocked', status: 404 });
    res.status(404).send('页面不存在');
  });
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error instanceof multer.MulterError ? 422 : (error.status >= 400 && error.status < 600 ? error.status : 500);
    audit(db, { ...requestEvent(req), kind: status === 413 || status === 400 ? 'security' : 'operation',
      action: req.path.includes('/files/') ? '文件操作失败' : '请求失败', outcome: 'failure', status,
      details: { code: error.code || 'REQUEST_ERROR' } });
    if (status === 500) console.error('Request failed:', error.message);
    res.status(status).json({ error: error instanceof multer.MulterError ? '文件超出限制：仅能上传一个不超过20MB的Excel文件' : status === 500 ? '服务器处理失败，请稍后重试' : error.message,
      ...(error.issues ? { issues: error.issues } : {}) });
  });
  return app;
}
