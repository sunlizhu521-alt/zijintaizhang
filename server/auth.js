import { Router } from 'express';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { BASE_PATH, API_PATH, PERMISSIONS } from '../shared/constants.js';
import { isValidPassword, PASSWORD_MESSAGE } from '../shared/password.js';
import { audit, transaction } from './db.js';

const deriveKey = promisify(scrypt);
const SESSION_COOKIE = 'zijintaizhang_session';
const SESSION_MS = 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const ALL_PERMISSIONS = Object.keys(PERMISSIONS);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const nowText = () => new Date().toISOString();

function problem(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function validPassword(password) {
  if (!isValidPassword(password)) throw problem(PASSWORD_MESSAGE);
  return password;
}

function validUsername(username) {
  if (typeof username !== 'string') throw problem('请填写账号');
  const value = username.trim().toLowerCase();
  if (!/^[\p{L}\p{N}_.@-]{2,64}$/u.test(value)) throw problem('账号须为2至64个字母、汉字、数字或 _.@-');
  return value;
}

function validDisplayName(displayName, fallback) {
  if (displayName !== undefined && typeof displayName !== 'string') throw problem('显示姓名格式无效');
  const value = typeof displayName === 'string' ? displayName.trim() : fallback;
  if (!value || [...value].length > 100) throw problem('显示姓名须为1至100个字符');
  return value;
}

function validPermissions(permissions) {
  if (!Array.isArray(permissions) || permissions.some((item) => !ALL_PERMISSIONS.includes(item))) {
    throw problem('包含无效权限');
  }
  return [...new Set(permissions)];
}

export async function hashPassword(password) {
  validPassword(password);
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || password.length > 256 || typeof stored !== 'string') return false;
  const [algorithm, n, r, p, saltText, hashText, extra] = stored.split('$');
  if (algorithm !== 'scrypt' || n !== '16384' || r !== '8' || p !== '1' || extra !== undefined) return false;
  const salt = Buffer.from(saltText || '', 'base64url');
  const expected = Buffer.from(hashText || '', 'base64url');
  if (salt.length !== 16 || expected.length !== 64) return false;
  const actual = await deriveKey(password, salt, expected.length, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return timingSafeEqual(actual, expected);
}

function publicUser(row) {
  return {
    id: row.id, username: row.username, displayName: row.display_name,
    active: Boolean(row.active), isAdmin: Boolean(row.is_admin),
    permissions: row.is_admin ? [...ALL_PERMISSIONS] : JSON.parse(row.permissions_json),
    mustChangePassword: Boolean(row.must_change_password), createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export async function initAdmin(db, { username, displayName, password }) {
  username = validUsername(username);
  displayName = validDisplayName(displayName, username);
  const passwordHash = await hashPassword(password);
  return transaction(db, () => {
    if (db.prepare('SELECT id FROM users WHERE is_admin = 1 LIMIT 1').get()) throw problem('管理员已初始化，请在系统内管理账号', 409);
    if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) throw problem('该账号已存在', 409);
    const id = randomUUID();
    const now = nowText();
    db.prepare(`INSERT INTO users (id,username,display_name,password_hash,is_admin,permissions_json,created_at,updated_at)
      VALUES (?,?,?,?,1,?,?,?)`).run(id, username, displayName, passwordHash, JSON.stringify(ALL_PERMISSIONS), now, now);
    const user = publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
    audit(db, { kind: 'operation', actor: user, action: '初始化管理员', target: username, outcome: 'success', details: { source: '本地管理员初始化工具' } });
    return user;
  });
}

export function createAuth(db, { secureCookies = false } = {}) {
  const router = Router();
  const userRouter = Router();
  for (const routes of [router, userRouter]) routes.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const globalRates = new Map();
  const ipFailures = new Map();
  const accountFailures = new Map();
  let lastCleanup = 0;
  const dummyHash = hashPassword(`a1${randomBytes(32).toString('hex')}`);
  const cookieOptions = { httpOnly: true, secure: secureCookies, sameSite: 'strict', path: BASE_PATH };
  const readUser = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const requestPath = (req) => (req.originalUrl || req.path || '').split('?')[0];
  const auditRequest = (req, event) => audit(db, {
    actor: req.user, ip: req.ip || '', userAgent: req.get('user-agent') || '', method: req.method,
    path: requestPath(req), ...event,
  });
  const fail = (res, status, error, code) => res.status(status).json({ error, ...(code ? { code } : {}) });

  function confirmAdminSession(req) {
    const row = readUser(req.user?.id);
    const session = db.prepare('SELECT token_hash FROM sessions WHERE token_hash=? AND expires_at>?').get(req.session?.tokenHash || '', nowText());
    if (!row?.active || !row.is_admin || row.must_change_password || !session) throw problem('登录或权限已变化，请重新登录', 401);
  }

  function readSession(req) {
    const cookies = String(req.headers.cookie || '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${SESSION_COOKIE}=`));
    if (cookies.length !== 1) return null;
    const token = cookies[0].slice(SESSION_COOKIE.length + 1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const tokenHash = digest(token);
    const session = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash);
    if (!session) return null;
    if (session.expires_at <= nowText()) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
      return null;
    }
    const row = readUser(session.user_id);
    if (!row?.active) return null;
    req.user = publicUser(row);
    req.session = { tokenHash, csrfToken: session.csrf_token, expiresAt: session.expires_at };
    return req.session;
  }

  function authenticate(req, res, next) {
    if (!readSession(req)) return fail(res, 401, '请重新登录');
    const allowed = ['session', 'password', 'logout'].map((action) => `${API_PATH}/auth/${action}`);
    if (req.user.mustChangePassword && !allowed.includes(requestPath(req))) {
      return fail(res, 403, '请先修改初始密码', 'PASSWORD_CHANGE_REQUIRED');
    }
    next();
  }

  function requirePermission(name) {
    if (!ALL_PERMISSIONS.includes(name)) throw new Error(`未知权限：${name}`);
    return (req, res, next) => {
      if (req.user && (req.user.isAdmin || req.user.permissions.includes(name))) return next();
      auditRequest(req, { kind: 'security', action: '访问未授权功能', target: name, outcome: 'blocked', status: 403 });
      return fail(res, 403, '没有此功能的权限');
    };
  }

  function requireAdmin(req, res, next) {
    if (req.user?.isAdmin) return next();
    auditRequest(req, { kind: 'security', action: '访问管理员功能', outcome: 'blocked', status: 403 });
    return fail(res, 403, '仅管理员可操作');
  }

  function csrfProtection(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || requestPath(req) === `${API_PATH}/auth/login`) return next();
    if (!readSession(req)) {
      auditRequest(req, { kind: 'security', actor: undefined, action: '未登录写入请求', outcome: 'blocked', status: 401 });
      return fail(res, 401, '请重新登录');
    }
    const token = Buffer.from(req.get('x-csrf-token') || '');
    const expected = Buffer.from(req.session.csrfToken);
    const valid = token.length === expected.length && timingSafeEqual(token, expected);
    if (!valid) {
      auditRequest(req, { kind: 'security', action: '请求校验失败', outcome: 'blocked', status: 403, details: { reason: 'csrf' } });
      return fail(res, 403, '请求校验失败，请刷新页面后重试');
    }
    next();
  }

  function securityMiddleware(req, res, next) {
    const now = Date.now();
    if (now - lastCleanup > 60000) {
      for (const [key, value] of globalRates) if (value.until <= now) globalRates.delete(key);
      for (const map of [ipFailures, accountFailures]) {
        for (const [key, value] of map) if (Math.max(value.windowUntil, value.blockedUntil) <= now) map.delete(key);
      }
      lastCleanup = now;
    }
    const key = req.ip || 'unknown';
    let state = globalRates.get(key);
    if (!state || state.until <= now) {
      state = { count: 0, until: now + 60000 };
      globalRates.set(key, state);
    }
    state.count += 1;
    if (state.count > 120) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((state.until - now) / 1000))));
      auditRequest(req, { kind: 'security', actor: undefined, action: '请求频率超限', outcome: 'blocked', status: 429, details: { count: state.count, windowSeconds: 60, limit: 120 } });
      return fail(res, 429, '请求过于频繁，请稍后重试');
    }
    next();
  }

  function createSession(row, res) {
    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions (token_hash,user_id,csrf_token,created_at,expires_at) VALUES (?,?,?,?,?)')
      .run(digest(token), row.id, csrfToken, nowText(), new Date(Date.now() + SESSION_MS).toISOString());
    res.cookie(SESSION_COOKIE, token, { ...cookieOptions, maxAge: SESSION_MS });
    return { user: publicUser(row), csrfToken };
  }

  function registerFailure(map, key, now) {
    let state = map.get(key);
    if (!state || (state.windowUntil <= now && state.blockedUntil <= now)) state = { count: 0, windowUntil: now + LOGIN_WINDOW_MS, blockedUntil: 0 };
    state.count += 1;
    if (state.count >= 5) state.blockedUntil = now + LOGIN_WINDOW_MS;
    map.set(key, state);
    return state;
  }

  router.get('/status', (_req, res) => {
    res.json({ initialized: Boolean(db.prepare('SELECT id FROM users WHERE is_admin = 1 LIMIT 1').get()) });
  });
  router.get('/session', authenticate, (req, res) => res.json({ user: req.user, csrfToken: req.session.csrfToken }));
  router.post('/login', async (req, res) => {
    const submittedUsername = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
    const username = submittedUsername.slice(0, 64);
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const blockedUntil = Math.max(ipFailures.get(ip)?.blockedUntil || 0, accountFailures.get(username)?.blockedUntil || 0);
    if (blockedUntil > now) {
      res.set('Retry-After', String(Math.ceil((blockedUntil - now) / 1000)));
      auditRequest(req, { kind: 'security', actor: undefined, action: '登录尝试被限制', target: username, outcome: 'blocked', status: 429, details: { attemptedUsername: username, identityVerified: false } });
      return fail(res, 429, '登录尝试过多，请15分钟后重试');
    }
    const validAccount = /^[\p{L}\p{N}_.@-]{2,64}$/u.test(submittedUsername);
    const row = validAccount ? db.prepare('SELECT * FROM users WHERE username = ?').get(username) : undefined;
    const verified = await verifyPassword(req.body?.password, row?.password_hash || await dummyHash);
    if (!row?.active || !verified) {
      const ipState = registerFailure(ipFailures, ip, now);
      const accountState = registerFailure(accountFailures, username, now);
      auditRequest(req, { kind: 'login', actor: undefined, action: '登录', target: username, outcome: 'failure', status: 401, details: { attemptedUsername: username, identityVerified: false } });
      if (ipState.count === 5 || accountState.count === 5) {
        auditRequest(req, { kind: 'security', actor: undefined, action: '连续登录失败', target: username, outcome: 'blocked', status: 401, details: { attemptedUsername: username, identityVerified: false, ipFailures: ipState.count, accountFailures: accountState.count, blockedMinutes: 15 } });
      }
      return fail(res, 401, '账号或密码不正确');
    }
    const current = readUser(row.id);
    if (!current?.active || current.password_hash !== row.password_hash) return fail(res, 401, '账号或密码不正确');
    accountFailures.delete(username);
    const payload = transaction(db, () => {
      const result = createSession(current, res);
      auditRequest(req, { kind: 'login', actor: result.user, action: '登录', target: username, outcome: 'success', status: 200 });
      return result;
    });
    res.json(payload);
  });
  router.post('/logout', authenticate, (req, res) => {
    transaction(db, () => {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.session.tokenHash);
      auditRequest(req, { kind: 'login', action: '退出登录', target: req.user.username, outcome: 'success', status: 200 });
    });
    res.clearCookie(SESSION_COOKIE, cookieOptions);
    res.json({ ok: true });
  });
  router.post('/password', authenticate, async (req, res) => {
    validPassword(req.body?.newPassword);
    const before = readUser(req.user.id);
    if (!(await verifyPassword(req.body?.currentPassword, before.password_hash))) {
      auditRequest(req, { kind: 'operation', action: '修改密码', target: req.user.username, outcome: 'failure', status: 400 });
      return fail(res, 400, '当前密码不正确');
    }
    if (req.body.currentPassword === req.body.newPassword) throw problem('新密码须与当前密码不同');
    const passwordHash = await hashPassword(req.body.newPassword);
    let payload;
    transaction(db, () => {
      const current = readUser(req.user.id);
      if (!current?.active || current.password_hash !== before.password_hash || !db.prepare('SELECT token_hash FROM sessions WHERE token_hash = ?').get(req.session.tokenHash)) throw problem('登录已失效，请重新登录', 401);
      db.prepare('UPDATE users SET password_hash=?,must_change_password=0,updated_at=? WHERE id=?').run(passwordHash, nowText(), current.id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(current.id);
      payload = createSession(readUser(current.id), res);
      auditRequest(req, { kind: 'operation', action: '修改密码', target: current.username, outcome: 'success', status: 200, details: { previousSessionsRevoked: true } });
    });
    res.json(payload);
  });

  userRouter.use(requireAdmin);
  userRouter.get('/', (_req, res) => res.json({ users: db.prepare('SELECT * FROM users ORDER BY created_at,id').all().map(publicUser) }));
  userRouter.post('/', async (req, res) => {
    const username = validUsername(req.body?.username);
    const displayName = validDisplayName(req.body?.displayName, username);
    const permissions = validPermissions(req.body?.permissions === undefined ? [] : req.body.permissions);
    if (req.body?.isAdmin !== undefined && typeof req.body.isAdmin !== 'boolean') throw problem('管理员标记无效');
    const passwordHash = await hashPassword(req.body?.password);
    let user;
    transaction(db, () => {
      confirmAdminSession(req);
      if (db.prepare('SELECT id FROM users WHERE username=?').get(username)) throw problem('该账号已存在', 409);
      const id = randomUUID();
      const now = nowText();
      db.prepare(`INSERT INTO users(id,username,display_name,password_hash,is_admin,permissions_json,must_change_password,created_at,updated_at)
        VALUES(?,?,?,?,?,?,1,?,?)`).run(id, username, displayName, passwordHash, req.body?.isAdmin ? 1 : 0, JSON.stringify(permissions), now, now);
      user = publicUser(readUser(id));
      auditRequest(req, { kind: 'operation', action: '创建用户', target: username, outcome: 'success', status: 201, details: { after: user } });
    });
    res.status(201).json({ user });
  });
  userRouter.patch('/:id', (req, res) => {
    let user;
    transaction(db, () => {
      confirmAdminSession(req);
      const before = readUser(req.params.id);
      if (!before) throw problem('用户不存在', 404);
      if (!['displayName', 'active', 'permissions', 'isAdmin'].some((field) => Object.hasOwn(req.body || {}, field))) throw problem('没有可更新的内容');
      for (const field of ['active', 'isAdmin']) if (req.body[field] !== undefined && typeof req.body[field] !== 'boolean') throw problem('账号状态或管理员标记无效');
      const active = req.body.active === undefined ? before.active : Number(req.body.active);
      const isAdmin = req.body.isAdmin === undefined ? before.is_admin : Number(req.body.isAdmin);
      const displayName = req.body.displayName === undefined ? before.display_name : validDisplayName(req.body.displayName, before.display_name);
      const permissions = req.body.permissions === undefined ? JSON.parse(before.permissions_json) : validPermissions(req.body.permissions);
      if (before.active && before.is_admin && (!active || !isAdmin)) {
        const count = db.prepare('SELECT COUNT(*) AS count FROM users WHERE active=1 AND is_admin=1').get().count;
        if (count <= 1) throw problem('不能停用或降级最后一位管理员');
      }
      db.prepare('UPDATE users SET display_name=?,active=?,is_admin=?,permissions_json=?,updated_at=? WHERE id=?')
        .run(displayName, active, isAdmin, JSON.stringify(permissions), nowText(), before.id);
      const accessChanged = active !== before.active || isAdmin !== before.is_admin || JSON.stringify([...permissions].sort()) !== JSON.stringify(JSON.parse(before.permissions_json).sort());
      if (accessChanged) db.prepare('DELETE FROM sessions WHERE user_id=?').run(before.id);
      user = publicUser(readUser(before.id));
      auditRequest(req, { kind: 'operation', action: '更新用户及权限', target: before.username, outcome: 'success', status: 200, details: { before: publicUser(before), after: user, sessionsRevoked: accessChanged } });
    });
    res.json({ user });
  });
  userRouter.post('/:id/reset-password', async (req, res) => {
    const passwordHash = await hashPassword(req.body?.password);
    transaction(db, () => {
      confirmAdminSession(req);
      const user = readUser(req.params.id);
      if (!user) throw problem('用户不存在', 404);
      db.prepare('UPDATE users SET password_hash=?,must_change_password=1,updated_at=? WHERE id=?').run(passwordHash, nowText(), user.id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
      auditRequest(req, { kind: 'operation', action: '重置用户密码', target: user.username, outcome: 'success', status: 200, details: { sessionsRevoked: true, mustChangePassword: true } });
    });
    res.json({ ok: true });
  });
  return { router, userRouter, authenticate, requirePermission, requireAdmin, csrfProtection, securityMiddleware };
}
