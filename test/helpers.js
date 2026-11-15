import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { openDatabase } from '../server/db.js';
import { initAdmin } from '../server/auth.js';
import { createApp } from '../server/app.js';
import { API_PATH } from '../shared/constants.js';

export const ADMIN_PASSWORD = 'Synthetic-integration-admin-2026!';
export const USER_PASSWORD = 'Synthetic-integration-user-2026!';
export const CHANGED_PASSWORD = 'Changed-integration-user-2026!';

export async function appFixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'zijintaizhang-app-'));
  const filename = join(directory, 'integration.sqlite');
  let db = openDatabase(filename);
  await initAdmin(db, { username: 'admin', displayName: '合成验收管理员', password: ADMIN_PASSWORD });
  let server;
  let origin;
  async function stop() {
    if (server?.listening) {
      const stopped = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await stopped;
    }
  }
  async function start() {
    const app = createApp({ db, distDir: join(directory, 'no-static-output'), ...options });
    server = await new Promise((resolve, reject) => {
      const instance = app.listen(0, '127.0.0.1');
      instance.once('error', reject);
      instance.once('listening', () => resolve(instance));
    });
    origin = `http://127.0.0.1:${server.address().port}`;
  }
  t.after(async () => {
    await stop();
    db.close();
    await rm(directory, { recursive: true, force: true });
  });
  await start();

  async function request(path, { method = 'GET', body, rawBody, form, session, csrf = true, headers = {} } = {}) {
    const response = await fetch(`${origin}${API_PATH}${path}`, {
      method,
      headers: {
        ...(['GET', 'HEAD'].includes(method) ? {} : { Origin: origin }),
        ...(body === undefined && rawBody === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(session ? { Cookie: session.cookie, ...(csrf ? { 'X-CSRF-Token': session.csrfToken } : {}) } : {}),
        ...headers,
      },
      ...(form ? { body: form } : rawBody !== undefined ? { body: rawBody } : body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    const data = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(bytes.toString('utf8')) : undefined;
    return { status: response.status, headers: response.headers, bytes, data,
      cookie: (response.headers.get('set-cookie') || '').split(';')[0], csrfToken: data?.csrfToken };
  }
  const login = (username = 'admin', password = ADMIN_PASSWORD) => request('/auth/login', { method: 'POST', body: { username, password } });
  async function newUser(admin, username, permissions = []) {
    const created = await request('/users', { method: 'POST', session: admin,
      body: { username, displayName: `合成用户-${username}`, password: USER_PASSWORD, permissions } });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const initial = await login(username, USER_PASSWORD);
    assert.equal(initial.status, 200, JSON.stringify(initial.data));
    const session = await request('/auth/password', { method: 'POST', session: initial,
      body: { currentPassword: USER_PASSWORD, newPassword: CHANGED_PASSWORD } });
    assert.equal(session.status, 200, JSON.stringify(session.data));
    return { session, user: created.data.user };
  }
  async function preview(slotId, content, session, filename = '合成测试.xlsx') {
    const form = new FormData();
    form.append('file', new Blob([content], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename);
    return request(`/files/${slotId}/preview`, { method: 'POST', session, form });
  }
  const activate = (slotId, previewResult, session, overrides = {}) => request(`/files/${slotId}/activate`, {
    method: 'POST', session, body: { token: previewResult.data.token, baseRevision: previewResult.data.baseRevision,
      selectedSheets: previewResult.data.selectedSheets, ...overrides },
  });
  async function upload(slotId, content, session, filename) {
    const draft = await preview(slotId, content, session, filename);
    assert.equal(draft.status, 200, JSON.stringify(draft.data));
    const activated = await activate(slotId, draft, session);
    assert.equal(activated.status, 200, JSON.stringify(activated.data));
    return { draft, activated, versionId: activated.data.version.id };
  }
  async function restart() { await stop(); db.close(); db = openDatabase(filename); await start(); }
  return { get db() { return db; }, get origin() { return origin; }, request, login, newUser, preview, activate, upload, restart };
}

export async function syntheticSchedule() {
  const workbook = new ExcelJS.Workbook();
  const negotiated = workbook.addWorksheet('谈判付款');
  negotiated.addRow(['创跟单员', '供应商', '付款主体', '对公付款0A流程号', '摘要', 'OA-申请付款金额', '应付款时间', '已付金额', '剩余付款金额', '是否结清', '流程状态', '2026年11月支付', '2026年12月支付', '备注', '是否谈判分批']);
  negotiated.addRow(['甲', '合成供应商甲', '合成主体', 'MDST-DGFK20261101001', '=1+1', 1000, '2026-11-01', 250, 750, '否', '未归档', 600, 400, '', '是']);
  const normal = workbook.addWorksheet('正常付款');
  normal.addRow(['跟单员', '供应商名称', '付款主体', '对公付款0A流程号', '摘要', '本次申请付款金额', '应付时间', '已付金额', '剩余金额', '是否结清', '流程状态']);
  normal.addRow(['乙', '合成供应商乙', '合成主体', 'MDST-DGFK20261101002', '正常款', 200, '2026年11月05日', 200, 0, '是', '归档']);
  normal.addRow(['乙', '合成供应商丙', '合成主体', 'MDST-DGFK20261101003', '正常款', 300, '2026年12月05日', null, 300, '否', '未归档']);
  const progress = workbook.addWorksheet('付款进度整理');
  progress.addRow(['对公付款OA号', '申请付款金额', '供应商名称', '付款主体', '是否已付款']);
  progress.addRow(['MDST-DGFK20261101002', 200, '合成供应商乙', '合成主体', '已付款']);
  progress.addRow(['MDST-DGFK20261101003', 300, '合成供应商丙', '合成主体', '未付款']);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function syntheticForecast(amount = 50, { pending = false, invalid = false } = {}) {
  const workbook = new ExcelJS.Workbook();
  const headers = ['预估付款月份', '供应商名称', '付款主体', '摘要', '申请付款金额', '账期', '备注'];
  const actual = workbook.addWorksheet('合成人员');
  actual.addRow(headers);
  actual.addRow([pending ? null : '2026-11-01', '合成预估供应商', '合成主体', '预估', invalid ? '错误金额' : amount, '30天', '原始备注']);
  const backup = workbook.addWorksheet('合成人员-原始表');
  backup.addRow(headers);
  backup.addRow(['2026-11-01', '不应计入的原始表', '合成主体', '旧数据', 9999, '30天', '']);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
