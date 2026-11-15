import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { transaction } from './db.js';
import { fail } from './storage.js';

const KINDS = new Set(['plan', 'todo', 'inspiration', 'work', 'life', 'book', 'quote', 'exercise', 'learning', 'mood', 'weekly', 'worklog']);
const PRESETS = { words: '词语积累10个', review: '复盘' };
const MAX_BYTES = 32 * 1024;
const TEXT_FIELDS = ['title', 'content', 'category', 'source', 'author', 'platform', 'mood', 'progress',
  'completed', 'problems', 'next', 'highlight', 'moments', 'feelings', 'priority', 'preset'];

export function initializePlanner(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS planner_items (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, id TEXT NOT NULL, date TEXT NOT NULL,
      data_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)),
      preset TEXT, updated_at TEXT NOT NULL,
      PRIMARY KEY(user_id,kind,id)
    );
    CREATE INDEX IF NOT EXISTS planner_items_user_date ON planner_items(user_id,date);
    CREATE TABLE IF NOT EXISTS planner_seeded_days (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date TEXT NOT NULL, PRIMARY KEY(user_id,date)
    );
    CREATE TABLE IF NOT EXISTS planner_disabled_presets (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      preset TEXT NOT NULL, PRIMARY KEY(user_id,preset)
    );
  `);
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw fail(400, '日期格式应为 YYYY-MM-DD');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw fail(400, '请选择有效日期');
  return value;
}

function validRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) throw fail(400, '记录版本无效，请刷新后重试');
  return value;
}

function validData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw fail(400, '记录内容必须为对象');
  for (const key of TEXT_FIELDS) {
    if (Object.hasOwn(data, key) && data[key] !== null && typeof data[key] !== 'string') throw fail(400, '文本字段必须填写文字');
  }
  if (Object.hasOwn(data, 'tags') && data.tags !== null &&
    (!Array.isArray(data.tags) || data.tags.some(tag => typeof tag !== 'string'))) throw fail(400, '标签必须为文字列表');
  if (Object.hasOwn(data, 'done') && typeof data.done !== 'boolean') throw fail(400, '完成状态必须为勾选状态');
  for (const key of ['minutes', 'words', 'pages', 'duration']) {
    if (Object.hasOwn(data, key) && (!Number.isInteger(data[key]) || data[key] < 0 || data[key] > 100000)) throw fail(400, '学习和运动数据须为0至100000的整数');
  }
  let nodes = 0;
  function visit(value, depth = 0) {
    if (++nodes > 3000 || depth > 6) throw fail(400, '记录结构过于复杂');
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'string') {
      if (value.length > 16000) throw fail(400, '单个内容字段不能超过16000个字符');
      return;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) throw fail(400, '数值超出支持范围');
      return;
    }
    if (Array.isArray(value)) {
      if (value.length > 1000) throw fail(400, '单个列表不能超过1000项');
      value.forEach(item => visit(item, depth + 1));
      return;
    }
    if (value && typeof value === 'object') {
      const entries = Object.entries(value);
      if (entries.length > 60) throw fail(400, '记录字段过多');
      for (const [key, item] of entries) {
        if (!key || key.length > 100 || ['__proto__', 'prototype', 'constructor'].includes(key)) throw fail(400, '记录字段名称无效');
        visit(item, depth + 1);
      }
      return;
    }
    throw fail(400, '记录包含不支持的内容');
  }
  visit(data);
  const json = JSON.stringify(data);
  if (Buffer.byteLength(json, 'utf8') > MAX_BYTES) throw fail(413, '单条记录不能超过32KB，请缩短内容');
  return json;
}

function itemFrom(row) {
  return { id: row.id, kind: row.kind, date: row.date, data: JSON.parse(row.data_json), revision: row.revision, deleted: Boolean(row.deleted) };
}

function seedPlans(db, userId, date) {
  transaction(db, () => {
    if (!db.prepare('INSERT OR IGNORE INTO planner_seeded_days(user_id,date) VALUES (?,?)').run(userId, date).changes) return;
    const disabled = new Set(db.prepare('SELECT preset FROM planner_disabled_presets WHERE user_id=?').all(userId).map(row => row.preset));
    const insert = db.prepare(`INSERT INTO planner_items(user_id,kind,id,date,data_json,preset,updated_at) VALUES (?,'plan',?,?,?,?,?)`);
    for (const [preset, title] of Object.entries(PRESETS)) {
      if (!disabled.has(preset)) insert.run(userId, randomUUID(), date, JSON.stringify({ title, done: false, preset }), preset, new Date().toISOString());
    }
  });
}

export function createPlannerRouter(db) {
  const router = Router();
  const read = (req) => db.prepare('SELECT * FROM planner_items WHERE user_id=? AND kind=? AND id=?').get(req.user.id, req.params.kind, req.params.id);
  router.get('/', (req, res) => {
    const date = validDate(req.query.date === undefined ? new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10) : req.query.date);
    seedPlans(db, req.user.id, date);
    const rows = db.prepare('SELECT * FROM planner_items WHERE user_id=? AND deleted=0 ORDER BY date DESC,rowid').all(req.user.id);
    res.json({ items: rows.map(itemFrom), date });
  });
  router.get('/trash', (req, res) => {
    const rows = db.prepare('SELECT * FROM planner_items WHERE user_id=? AND deleted=1 ORDER BY updated_at DESC,rowid').all(req.user.id);
    res.json({ items: rows.map(itemFrom) });
  });
  router.use('/:kind/:id', (req, _res, next) => {
    if (!KINDS.has(req.params.kind)) throw fail(400, '记录类型无效');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(req.params.id)) throw fail(400, '记录标识无效');
    next();
  });
  router.put('/:kind/:id', (req, res) => {
    const date = ['todo', 'worklog'].includes(req.params.kind) && req.body.date === '' ? '' : validDate(req.body.date);
    const revision = validRevision(req.body.revision);
    validData(req.body.data);
    const item = transaction(db, () => {
      const existing = read(req);
      if (existing ? existing.revision !== revision || existing.deleted : revision !== 0) throw fail(409, '记录已变化，请刷新后重试；已删除的记录请先恢复');
      const data = { ...req.body.data };
      if (Object.hasOwn(data, 'preset') && data.preset !== existing?.preset) throw fail(400, '预设任务标记不能手动设置或更改');
      if (existing?.preset) data.preset = existing.preset;
      const json = validData(data);
      if (existing) {
        db.prepare('UPDATE planner_items SET date=?,data_json=?,revision=revision+1,updated_at=? WHERE user_id=? AND kind=? AND id=?')
          .run(date, json, new Date().toISOString(), req.user.id, req.params.kind, req.params.id);
      } else {
        db.prepare('INSERT INTO planner_items(user_id,kind,id,date,data_json,updated_at) VALUES (?,?,?,?,?,?)')
          .run(req.user.id, req.params.kind, req.params.id, date, json, new Date().toISOString());
      }
      return itemFrom(read(req));
    });
    res.status(revision === 0 ? 201 : 200).json({ item });
  });
  function setDeleted(req, deleted) {
    const revision = validRevision(req.body?.revision);
    return transaction(db, () => {
      const existing = read(req);
      if (!existing) throw fail(404, '记录不存在');
      if (existing.revision !== revision || Boolean(existing.deleted) === deleted) throw fail(409, '记录已变化，请刷新后重试');
      if (deleted && existing.kind === 'plan' && existing.preset) {
        db.prepare('INSERT OR IGNORE INTO planner_disabled_presets(user_id,preset) VALUES (?,?)').run(req.user.id, existing.preset);
      }
      db.prepare('UPDATE planner_items SET deleted=?,revision=revision+1,updated_at=? WHERE user_id=? AND kind=? AND id=?')
        .run(deleted ? 1 : 0, new Date().toISOString(), req.user.id, req.params.kind, req.params.id);
      return itemFrom(read(req));
    });
  }
  router.delete('/:kind/:id', (req, res) => res.json({ item: setDeleted(req, true) }));
  router.post('/:kind/:id/restore', (req, res) => res.json({ item: setDeleted(req, false) }));
  return router;
}
