import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.js';
import { initAdmin } from '../server/auth.js';
import { createApp } from '../server/app.js';
import { API_PATH } from '../shared/constants.js';

async function fixture(t) {
  const db = openDatabase(':memory:');
  await initAdmin(db, { username: 'admin', displayName: '测试管理员', password: 'Admin1' });
  const admin = db.prepare('SELECT * FROM users WHERE username=?').get('admin');
  db.prepare(`INSERT INTO users(id,username,display_name,password_hash,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
    .run('second-user', 'second', '测试个人用户', admin.password_hash, admin.created_at, admin.updated_at);
  const app = createApp({ db, distDir: '/nonexistent-planner-test-dist' });
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', error => error ? reject(error) : resolve(instance));
    instance.once('error', reject);
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    db.close();
  });
  const base = `http://127.0.0.1:${server.address().port}${API_PATH}`;
  async function request(path, { method = 'GET', body, session, csrf = true, headers = {} } = {}) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(session ? { Cookie: session.cookie, ...(csrf ? { 'X-CSRF-Token': session.csrfToken } : {}) } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    return { status: response.status, data, cookie: (response.headers.get('set-cookie') || '').split(';')[0], csrfToken: data.csrfToken };
  }
  const login = (username = 'admin') => request('/auth/login', { method: 'POST', body: { username, password: 'Admin1' } });
  return { db, request, login };
}

const entry = (data = { title: '测试工作内容', done: false }, revision = 0, date = '2026-11-15') => ({ date, data, revision });

test('计划接口沿用登录、CSRF和来源保护；无财务权限的用户只访问自己的记录', async t => {
  const { db, request, login } = await fixture(t);
  assert.equal((await request('/planner?date=2026-11-15')).status, 401);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM planner_seeded_days').get().n, 0);
  const admin = await login();
  const second = await login('second');
  const path = '/planner/todo/private-record';
  assert.equal((await request(path, { method: 'PUT', body: entry(), session: admin, csrf: false })).status, 403);
  assert.equal((await request(path, { method: 'PUT', body: entry(), session: admin, headers: { Origin: 'https://other.example' } })).status, 403);
  assert.equal((await request(path, { method: 'PUT', body: entry({ title: '个人内容甲', done: false }), session: admin })).status, 201);
  assert.equal((await request('/planner?date=2026-11-15', { session: second })).data.items.some(item => item.id === 'private-record'), false);
  assert.equal((await request(path, { method: 'PUT', body: entry({ title: '越权修改' }, 1), session: second })).status, 409);
  assert.equal((await request(path, { method: 'DELETE', body: { revision: 1 }, session: second })).status, 404);
  assert.equal((await request(`${path}/restore`, { method: 'POST', body: { revision: 1 }, session: second })).status, 404);
  assert.equal((await request(path, { method: 'PUT', body: entry({ title: '个人内容乙' }), session: second })).status, 201);
  const own = (await request('/planner?date=2026-11-15', { session: admin })).data.items.find(item => item.id === 'private-record');
  assert.equal(own.data.title, '个人内容甲');
  assert.equal((await request(path, { method: 'DELETE', body: { revision: 1 }, session: admin })).status, 200);
  assert.equal((await request('/planner/trash', { session: second })).data.items.length, 0);
  assert.equal((await request('/planner/trash', { session: admin })).data.items[0].data.title, '个人内容甲');
  const logs = JSON.stringify(db.prepare('SELECT * FROM audit_logs').all());
  assert.ok(!logs.includes('个人内容甲') && !logs.includes('个人内容乙') && !logs.includes('越权修改'));
});

test('创建与更新版本冲突不覆盖；删除和恢复可回溯并保留零值、空文本及false', async t => {
  const { request, login } = await fixture(t);
  const session = await login();
  const path = '/planner/learning/concurrent';
  const initial = { title: '', minutes: 0, done: false, note: null, tags: [] };
  const created = await Promise.all([1, 2].map(() => request(path, { method: 'PUT', body: entry(initial), session })));
  assert.deepEqual(created.map(result => result.status).sort(), [201, 409]);
  const item = created.find(result => result.status === 201).data.item;
  assert.deepEqual(item, { id: 'concurrent', kind: 'learning', date: '2026-11-15', data: initial, revision: 1, deleted: false });
  const updates = await Promise.all(['甲', '乙'].map(title => request(path, { method: 'PUT', body: entry({ ...initial, title }, 1), session })));
  assert.deepEqual(updates.map(result => result.status).sort(), [200, 409]);
  const changed = updates.find(result => result.status === 200).data.item;
  assert.equal(changed.revision, 2);
  assert.equal((await request(path, { method: 'DELETE', body: { revision: 1 }, session })).status, 409);
  const removed = await request(path, { method: 'DELETE', body: { revision: 2 }, session });
  assert.equal(removed.data.item.revision, 3);
  assert.equal(removed.data.item.deleted, true);
  assert.equal((await request('/planner?date=2026-11-15', { session })).data.items.some(row => row.id === item.id), false);
  assert.equal((await request(path, { method: 'PUT', body: entry({ title: '不能直接覆盖回收站' }, 3), session })).status, 409);
  assert.equal((await request(`${path}/restore`, { method: 'POST', body: { revision: 2 }, session })).status, 409);
  const restored = await request(`${path}/restore`, { method: 'POST', body: { revision: 3 }, session });
  assert.equal(restored.data.item.revision, 4);
  assert.equal(restored.data.item.deleted, false);
  assert.deepEqual(restored.data.item.data, changed.data);
  assert.equal((await request('/planner/trash', { session })).data.items.length, 0);
  assert.equal((await request(`${path}/restore`, { method: 'POST', body: { revision: 4 }, session })).status, 409);
});

test('每日默认任务只初始化一次；删除预设跨日不复原，恢复历史也不重新启用', async t => {
  const { db, request, login } = await fixture(t);
  const session = await login();
  const list = date => request(`/planner?date=${date}`, { session });
  const first = await Promise.all([list('2026-11-15'), list('2026-11-15')]);
  assert.equal(first[0].data.items.length, 2);
  assert.equal(first[1].data.items.length, 2);
  const words = first[0].data.items.find(item => item.data.preset === 'words');
  assert.equal(words.data.title, '词语积累10个');
  assert.equal(words.data.done, false);
  const path = `/planner/plan/${words.id}`;
  assert.equal((await request(path, { method: 'DELETE', body: { revision: 0 }, session })).status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM planner_disabled_presets').get().n, 0);
  const updated = await request(path, { method: 'PUT', body: entry({ title: '词语积累10个', done: true }, 1), session });
  assert.equal(updated.data.item.data.preset, 'words');
  assert.equal((await request(path, { method: 'PUT', body: entry({ title: '改标记', preset: 'review' }, 2), session })).status, 400);
  assert.equal((await request(path, { method: 'DELETE', body: { revision: 2 }, session })).status, 200);
  assert.equal((await list('2026-11-15')).data.items.length, 1);
  const tomorrow = (await list('2026-11-16')).data.items;
  assert.equal(tomorrow.length, 2);
  assert.equal(tomorrow.filter(item => item.date === '2026-11-16').length, 1);
  assert.ok(tomorrow.every(item => item.data.preset === 'review'));
  assert.equal((await request(`${path}/restore`, { method: 'POST', body: { revision: 3 }, session })).status, 200);
  const later = (await list('2026-11-17')).data.items;
  assert.equal(later.filter(item => item.data.preset === 'words').length, 1);
  assert.equal(later.find(item => item.data.preset === 'words').date, '2026-11-15');
  const review = later.find(item => item.date === '2026-11-17');
  await request(`/planner/plan/${review.id}`, { method: 'DELETE', body: { revision: 1 }, session });
  const none = (await list('2026-11-18')).data.items;
  assert.equal(none.filter(item => item.date === '2026-11-18').length, 0);
  assert.equal((await list('2026-11-18')).data.items.length, none.length);
  const otherSession = await login('second');
  assert.equal((await request('/planner?date=2026-11-18', { session: otherSession })).data.items.length, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM planner_seeded_days WHERE date=?').get('2026-11-18').n, 2);
});

test('真实日期、类型、标识、版本和记录大小均校验，失败不会写入', async t => {
  const { db, request, login } = await fixture(t);
  const session = await login();
  const put = (body, path = '/planner/worklog/validation') => request(path, { method: 'PUT', body, session });
  for (const date of ['2026-2-03', '2026-02-29', '2026-04-31', '2026-13-01', 'not-a-date', null]) {
    assert.equal((await put(entry({ text: '内容' }, 0, date))).status, 400, `date=${date}`);
  }
  assert.equal((await request('/planner?date=2026-02-30', { session })).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM planner_seeded_days').get().n, 0);
  for (const revision of [-1, 0.1, '0', null, Number.MAX_SAFE_INTEGER]) {
    assert.equal((await put(entry({ text: '内容' }, revision))).status, 400);
  }
  for (const data of [null, [], '', 0, { text: 'x'.repeat(16001) }, { tags: Array(1001).fill('x') },
    Object.fromEntries(Array.from({ length: 61 }, (_, index) => [`field${index}`, 'x'])),
    JSON.parse('{"__proto__":{"polluted":true}}'), { minutes: Number.MAX_SAFE_INTEGER + 1 },
    { a: { b: { c: { d: { e: { f: { g: 'deep' } } } } } } }]) {
    assert.equal((await put(entry(data))).status, 400);
  }
  assert.equal((await put(entry({ text: '汉'.repeat(11000) }))).status, 413);
  assert.equal((await put(entry({ text: '内容' }), '/planner/unsupported/id')).status, 400);
  assert.equal((await put(entry({ text: '内容' }), '/planner/worklog/invalid%20id')).status, 400);
  assert.equal((await put(entry({ text: '内容' }), `/planner/worklog/${'x'.repeat(129)}`)).status, 400);
  assert.equal((await put(entry({ title: '伪造预设', preset: 'words' }), '/planner/plan/custom')).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM planner_items').get().n, 0);
  assert.equal((await put(entry({ text: '', minutes: 0 }, 0, '2028-02-29'))).status, 201);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM planner_items').get().n, 1);
  const current = await request('/planner', { session });
  assert.equal(current.data.date, new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10));
  assert.ok(current.data.items.some(item => item.date === '2028-02-29'));
});

test('仅待办和工作记录允许日期待定；保存字段类型保证页面可渲染', async t => {
  const { request, login } = await fixture(t);
  const session = await login();
  for (const kind of ['todo', 'worklog']) {
    const result = await request(`/planner/${kind}/undated-${kind}`, { method: 'PUT', session,
      body: entry({ title: '日期待定事项', tags: ['工作'], done: false }, 0, '') });
    assert.equal(result.status, 201);
    assert.equal(result.data.item.date, '');
  }
  for (const kind of ['plan', 'weekly', 'exercise', 'learning', 'mood']) {
    assert.equal((await request(`/planner/${kind}/no-date`, { method: 'PUT', session,
      body: entry({ title: '缺少日期' }, 0, '') })).status, 400);
  }
  const invalid = [{ tags: '工作' }, { tags: {} }, { tags: [12] }, { tags: [['工作']] }, { content: 123 },
    { category: {} }, { title: [] }, { completed: false }, { done: 'false' }, { done: null },
    { minutes: '10' }, { words: -1 }, { pages: 1.5 }, { duration: 100001 }];
  for (const data of invalid) {
    assert.equal((await request('/planner/exercise/bad-shape', { method: 'PUT', session, body: entry(data) })).status, 400);
  }
  const safe = { title: '零值训练', tags: null, content: null, duration: 0, done: false };
  assert.equal((await request('/planner/exercise/safe-shape', { method: 'PUT', session, body: entry(safe) })).status, 201);
  const list = (await request('/planner?date=2026-11-15', { session })).data.items;
  assert.equal(list.filter(row => row.date === '').length, 2);
  assert.deepEqual(list.find(row => row.id === 'safe-shape').data, safe);
});
