import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { openDatabase, audit, pruneLogs, serializeAudit } from '../server/db.js';
import { createAuth, hashPassword, verifyPassword, initAdmin } from '../server/auth.js';
import { API_PATH } from '../shared/constants.js';

const ADMIN_PASSWORD = 'Admin1';
const USER_PASSWORD = 'User12';
const NEW_PASSWORD = 'Next12';

async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'zijintaizhang-auth-'));
  const db = openDatabase(join(dir, 'test.sqlite'));
  let server;
  t.after(async () => {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await initAdmin(db, { username: 'admin', displayName: '合成测试管理员', password: ADMIN_PASSWORD });
  const auth = createAuth(db, options);
  const app = express();
  app.use(API_PATH, auth.securityMiddleware);
  app.use(express.json());
  app.use(API_PATH, auth.csrfProtection);
  app.use(`${API_PATH}/auth`, auth.router);
  app.use(API_PATH, auth.authenticate);
  app.use(`${API_PATH}/users`, auth.userRouter);
  app.get(`${API_PATH}/restricted`, auth.requirePermission('download'), (_req, res) => res.json({ ok: true }));
  app.get(`${API_PATH}/view`, auth.requirePermission('dashboard'), (_req, res) => res.json({ ok: true }));
  app.post(`${API_PATH}/write`, auth.requirePermission('upload'), (_req, res) => res.json({ ok: true }));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve(instance));
    instance.once('error', reject);
  });
  const url = `http://127.0.0.1:${server.address().port}${API_PATH}`;
  async function request(path, { method = 'GET', body, session, csrf = true, headers = {} } = {}) {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(session ? { Cookie: session.cookie, ...(csrf ? { 'X-CSRF-Token': session.csrfToken } : {}) } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    const cookie = response.headers.get('set-cookie') || '';
    return { status: response.status, data, headers: response.headers, cookie: cookie.split(';')[0], csrfToken: data.csrfToken };
  }
  const login = (username = 'admin', password = ADMIN_PASSWORD) => request('/auth/login', { method: 'POST', body: { username, password } });
  return { db, request, login };
}

test('密码按完整字符保存，6至128个字符必须含英文字母与数字，拒绝损坏哈希', async () => {
  const password = '  A1密码保留首尾空格🙂  ';
  const hash = await hashPassword(password);
  assert.ok(!hash.includes(password));
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword(password.trim(), hash), false);
  assert.equal(await verifyPassword('wrong-password-value', hash), false);
  assert.equal(await verifyPassword(password, 'malformed'), false);
  for (const value of ['', 'A1bcd', 'abcdef', '123456', '中文密码123', 'Ａ12345', 'abc１２３',
    ' '.repeat(20), `A1${'x'.repeat(127)}`, `A1${'🙂'.repeat(127)}`, null]) {
    await assert.rejects(hashPassword(value));
  }
  for (const value of ['Abc123', 'a1!中🙂?', `A1${'🙂'.repeat(126)}`]) {
    const acceptedHash = await hashPassword(value);
    assert.equal(await verifyPassword(value, acceptedHash), true);
  }
});

test('创建、修改和重置密码统一校验，失败不会创建用户、改密码或撤销会话', async (t) => {
  const { db, request, login } = await fixture(t);
  const admin = await login();
  const invalidCreate = await request('/users', { method: 'POST', session: admin,
    body: { username: 'policy-user', password: 'Abc12', permissions: ['dashboard'] } });
  assert.equal(invalidCreate.status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);

  const created = await request('/users', { method: 'POST', session: admin,
    body: { username: 'policy-user', password: USER_PASSWORD, permissions: ['dashboard'] } });
  assert.equal(created.status, 201);
  const id = created.data.user.id;
  const initial = await login('policy-user', USER_PASSWORD);
  const hashBefore = db.prepare('SELECT password_hash FROM users WHERE id=?').get(id).password_hash;
  const invalidChange = await request('/auth/password', { method: 'POST', session: initial,
    body: { currentPassword: USER_PASSWORD, newPassword: '123456' } });
  assert.equal(invalidChange.status, 400);
  assert.equal((await request('/auth/session', { session: initial })).status, 200);
  assert.equal(db.prepare('SELECT password_hash FROM users WHERE id=?').get(id).password_hash, hashBefore);

  const invalidReset = await request(`/users/${id}/reset-password`, { method: 'POST', session: admin,
    body: { password: 'abcdef' } });
  assert.equal(invalidReset.status, 400);
  assert.equal((await request('/auth/session', { session: initial })).status, 200);
  assert.equal(db.prepare('SELECT password_hash FROM users WHERE id=?').get(id).password_hash, hashBefore);
  assert.equal((await login('policy-user', USER_PASSWORD)).status, 200);
});

test('会话只保存token哈希、cookie受保护，错误登录保留未验证账号且不泄露密码', async (t) => {
  const { db, request, login } = await fixture(t, { secureCookies: true });
  assert.equal((await request('/auth/status')).data.initialized, true);
  assert.equal((await request('/auth/session')).status, 401);
  const failed = await login('admin', 'bad-password-that-is-long');
  assert.equal(failed.status, 401);
  const failedLog = serializeAudit(db.prepare("SELECT * FROM audit_logs WHERE kind='login'").get());
  assert.equal(failedLog.actorName, '');
  assert.equal(failedLog.details.attemptedUsername, 'admin');
  assert.equal(failedLog.details.identityVerified, false);
  const session = await login();
  assert.equal(session.status, 200);
  assert.match(session.headers.get('set-cookie'), /HttpOnly/);
  assert.match(session.headers.get('set-cookie'), /SameSite=Strict/);
  assert.match(session.headers.get('set-cookie'), /Secure/);
  assert.match(session.headers.get('set-cookie'), /Path=\/zijintaizhang/);
  const stored = db.prepare('SELECT * FROM sessions').get();
  assert.notEqual(stored.token_hash, session.cookie.split('=')[1]);
  assert.equal(stored.token_hash.length, 64);
  const current = await request('/auth/session', { session });
  assert.equal(current.status, 200);
  assert.equal(current.data.user.username, 'admin');
  assert.equal(current.data.user.password_hash, undefined);
  assert.equal(current.data.csrfToken, session.csrfToken);
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM audit_logs').all()).includes(ADMIN_PASSWORD));
});

test('写入需要独立CSRF校验，错误UTF-8 token不致500，首次登录必须先改密码', async (t) => {
  const { request, login } = await fixture(t);
  const admin = await login();
  const body = { username: 'viewer', displayName: '测试查看者', password: USER_PASSWORD, permissions: ['dashboard'] };
  assert.equal((await request('/users', { method: 'POST', body, session: admin, csrf: false })).status, 403);
  assert.equal((await request('/users', { method: 'POST', body, session: admin, headers: { 'X-CSRF-Token': 'é'.repeat(43) } })).status, 403);
  assert.equal((await request('/users', { method: 'POST', body, session: admin })).status, 201);
  const first = await login('viewer', USER_PASSWORD);
  assert.equal(first.data.user.mustChangePassword, true);
  assert.equal((await request('/view', { session: first })).data.code, 'PASSWORD_CHANGE_REQUIRED');
  const changed = await request('/auth/password', { method: 'POST', session: first, body: { currentPassword: USER_PASSWORD, newPassword: NEW_PASSWORD } });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.user.mustChangePassword, false);
  assert.equal((await request('/auth/session', { session: first })).status, 401);
  assert.equal((await request('/view', { session: changed })).status, 200);
  assert.equal((await request('/restricted', { session: changed })).status, 403);
  assert.equal((await request('/users', { session: changed })).status, 403);
  assert.equal((await request('/write', { method: 'POST', body: {}, session: changed })).status, 403);
});

test('停用、改权限和管理员重置密码撤销已有会话，最后管理员不能停用或降级', async (t) => {
  const { db, request, login } = await fixture(t);
  const admin = await login();
  const adminId = admin.data.user.id;
  for (const body of [{ active: false }, { isAdmin: false }]) {
    assert.equal((await request(`/users/${adminId}`, { method: 'PATCH', session: admin, body })).status, 400);
  }
  const created = await request('/users', { method: 'POST', session: admin, body: { username: 'worker', password: USER_PASSWORD, permissions: ['dashboard'] } });
  const id = created.data.user.id;
  const initial = await login('worker', USER_PASSWORD);
  let worker = await request('/auth/password', { method: 'POST', session: initial, body: { currentPassword: USER_PASSWORD, newPassword: NEW_PASSWORD } });
  assert.equal((await request(`/users/${id}`, { method: 'PATCH', session: admin, body: { permissions: ['dashboard', 'download'] } })).status, 200);
  assert.equal((await request('/auth/session', { session: worker })).status, 401);
  worker = await login('worker', NEW_PASSWORD);
  assert.equal((await request('/restricted', { session: worker })).status, 200);
  assert.equal((await request(`/users/${id}`, { method: 'PATCH', session: admin, body: { active: false } })).status, 200);
  assert.equal((await request('/auth/session', { session: worker })).status, 401);
  assert.equal((await login('worker', NEW_PASSWORD)).status, 401);
  await request(`/users/${id}`, { method: 'PATCH', session: admin, body: { active: true } });
  worker = await login('worker', NEW_PASSWORD);
  assert.equal((await request(`/users/${id}/reset-password`, { method: 'POST', session: admin, body: { password: USER_PASSWORD } })).status, 200);
  assert.equal((await request('/auth/session', { session: worker })).status, 401);
  const resetLogin = await login('worker', USER_PASSWORD);
  assert.equal(resetLogin.data.user.mustChangePassword, true);
  assert.equal((await request('/restricted', { session: resetLogin })).status, 403);
  const updateLog = db.prepare("SELECT details_json FROM audit_logs WHERE action='更新用户及权限' ORDER BY created_at LIMIT 1").get();
  assert.deepEqual(JSON.parse(updateLog.details_json).before.permissions, ['dashboard']);
  assert.deepEqual(JSON.parse(updateLog.details_json).after.permissions, ['dashboard', 'download']);
  assert.equal((await request(`/users/${id}`, { method: 'PATCH', session: admin, body: { permissions: ['unknown'] } })).status, 400);
});

test('五次登录失败触发短限，成功登录不清零同IP失败计数', async (t) => {
  const { db, login } = await fixture(t);
  for (let i = 0; i < 4; i++) assert.equal((await login('admin', 'incorrect-password-value')).status, 401);
  assert.equal((await login()).status, 200);
  assert.equal((await login('missing', 'incorrect-password-value')).status, 401);
  const blocked = await login();
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE kind='security' AND outcome='blocked'").get().n >= 2);
});

test('全局限流120次每分钟并保存拦截事件', async (t) => {
  const { db, request } = await fixture(t);
  for (let i = 0; i < 120; i++) assert.equal((await request('/auth/status')).status, 200);
  assert.equal((await request('/auth/status')).status, 429);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action='请求频率超限'").get().n, 1);
});

test('日志同步持久化、过滤敏感字段，并只清理365天之外的事件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zijintaizhang-audit-'));
  const filename = join(dir, 'audit.sqlite');
  let db = openDatabase(filename);
  try {
    const id = audit(db, { kind: 'security', action: '合成事件', outcome: 'blocked', path: '/api/test?token=secret', details: { password: 'hidden', nested: { token: 'hidden', reason: 'test' } } });
    db.close();
    db = openDatabase(filename);
    const row = db.prepare('SELECT * FROM audit_logs WHERE id=?').get(id);
    assert.equal(row.path, '/api/test');
    assert.deepEqual(JSON.parse(row.details_json), { nested: { reason: 'test' } });
    db.prepare('UPDATE audit_logs SET created_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z', id);
    audit(db, { kind: 'operation', action: '新事件', outcome: 'success' });
    assert.equal(pruneLogs(db), 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
