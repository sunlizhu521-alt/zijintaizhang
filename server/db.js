import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export function openDatabase(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
      is_admin INTEGER NOT NULL DEFAULT 0 CHECK(is_admin IN (0, 1)),
      permissions_json TEXT NOT NULL DEFAULT '[]',
      must_change_password INTEGER NOT NULL DEFAULT 0 CHECK(must_change_password IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('login', 'operation', 'security')),
      actor_id TEXT NOT NULL DEFAULT '',
      actor_name TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '',
      outcome TEXT NOT NULL CHECK(outcome IN ('success', 'failure', 'blocked')),
      ip TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT '',
      method TEXT NOT NULL DEFAULT '',
      path TEXT NOT NULL DEFAULT '',
      status INTEGER NOT NULL DEFAULT 0,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_logs_created_at ON audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS audit_logs_kind_created ON audit_logs(kind, created_at);
    CREATE INDEX IF NOT EXISTS audit_logs_actor ON audit_logs(actor_id, created_at);
  `);
  pruneLogs(db);
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
  return db;
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    if (result && typeof result.then === 'function') throw new TypeError('事务回调必须同步执行');
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function cleanDetails(value, depth = 0) {
  if (depth > 8) return '[省略]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, 2000);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => cleanDetails(item, depth + 1));
  if (!value || typeof value !== 'object') return undefined;
  return Object.fromEntries(Object.entries(value).slice(0, 100)
    .filter(([key]) => !/password|passwd|token|secret|authorization|cookie/i.test(key))
    .map(([key, item]) => [key.slice(0, 100), cleanDetails(item, depth + 1)]));
}

export function audit(db, event) {
  const id = randomUUID();
  const actor = typeof event.actor === 'string' ? { username: event.actor } : (event.actor || {});
  const details = cleanDetails(event.details || {});
  const detailsJson = JSON.stringify(details);
  const text = (value, max = 500) => String(value ?? '').slice(0, max);
  db.prepare(`INSERT INTO audit_logs (
    id,kind,actor_id,actor_name,action,target,outcome,ip,user_agent,method,path,status,details_json,created_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, event.kind, text(actor.id, 100), text(actor.username || actor.name, 100),
    text(event.action, 100), text(event.target), event.outcome,
    text(event.ip, 100), text(event.userAgent, 1000), text(event.method, 10),
    text(String(event.path || '').split('?')[0], 1000), Number(event.status) || 0,
    detailsJson.length <= 16000 ? detailsJson : JSON.stringify({ truncated: true }), new Date().toISOString(),
  );
  return id;
}

export function serializeAudit(row) {
  return {
    id: row.id, kind: row.kind, actorId: row.actor_id, actorName: row.actor_name,
    action: row.action, target: row.target, outcome: row.outcome, ip: row.ip,
    userAgent: row.user_agent, method: row.method, path: row.path, status: row.status,
    details: JSON.parse(row.details_json || '{}'), createdAt: row.created_at,
  };
}

export function pruneLogs(db, now = Date.now()) {
  const cutoff = new Date(now - 365 * 24 * 60 * 60 * 1000).toISOString();
  return db.prepare('DELETE FROM audit_logs WHERE created_at < ?').run(cutoff).changes;
}
