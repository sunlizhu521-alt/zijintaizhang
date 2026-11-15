import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { ORDER_SLOT, SLOTS } from '../shared/constants.js';
import { inspectWorkbook, parseWorkbook } from '../server/parser.js';
import { appFixture, syntheticSchedule, syntheticForecast } from './helpers.js';

const slotId = ORDER_SLOT.id;
const filePath = `/files/${slotId}`;
async function orderWorkbook(quantity = 0) {
  const workbook = new ExcelJS.Workbook();
  const orders = workbook.addWorksheet('采购订单');
  orders.addRow(['单据编号', '物料编码', '数量', '交货日期']);
  orders.addRow(['PO-20261115001', 'SKU-001', quantity, null]);
  const hidden = workbook.addWorksheet('隐藏原始表', { state: 'hidden' });
  hidden.addRow(['原始备注', '不按业务字段解析']);
  workbook.addWorksheet('空白模板');
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test('订单保存全部工作表与原始字节，版本恢复和重启后仍可下载', async t => {
  const f = await appFixture(t);
  const admin = await f.login();
  const initial = await f.request('/orders', { session: admin });
  assert.equal(initial.status, 200);
  assert.equal(initial.data.slots.length, 1);
  assert.equal(initial.data.slots[0].label, '金蝶采购订单');
  assert.equal(initial.data.slots[0].currentVersionId, null);
  const original = await orderWorkbook();
  const v1 = await f.upload(slotId, original, admin, '金蝶采购订单_V1.xlsx');
  assert.equal(v1.draft.data.kind, 'archive');
  assert.equal(v1.draft.data.validationError, undefined);
  assert.deepEqual(v1.draft.data.selectedSheets, ['采购订单', '隐藏原始表', '空白模板']);
  assert.deepEqual(v1.draft.data.sheets, [
    { name: '采购订单', rowCount: 2, columnCount: 4 },
    { name: '隐藏原始表', rowCount: 1, columnCount: 2 },
    { name: '空白模板', rowCount: 0, columnCount: 0 },
  ]);
  assert.equal(v1.activated.data.slot.id, slotId);
  assert.equal(v1.activated.data.slot.filename, '金蝶采购订单_V1.xlsx');
  const detail = await f.request(`${filePath}/versions/${v1.versionId}`, { session: admin });
  assert.equal(detail.data.kind, 'archive');
  assert.deepEqual(detail.data.sheets, v1.draft.data.sheets);
  assert.deepEqual(detail.data.selectedSheets, v1.draft.data.selectedSheets);
  assert.deepEqual(detail.data.records, []);
  assert.deepEqual(detail.data.issues, []);
  const v2Bytes = await orderWorkbook(50);
  const v2 = await f.upload(slotId, v2Bytes, admin, '金蝶采购订单_V2.xlsx');
  const history = await f.request(`${filePath}/versions`, { session: admin });
  assert.deepEqual(history.data.versions.map(version => [version.id, version.current]), [[v2.versionId, true], [v1.versionId, false]]);
  for (const [id, expected] of [[v1.versionId, original], [v2.versionId, v2Bytes]]) {
    const download = await f.request(`${filePath}/versions/${id}/download`, { session: admin });
    assert.equal(download.status, 200);
    assert.deepEqual(download.bytes, expected);
  }
  const restored = await f.request(`${filePath}/restore`, { method: 'POST', session: admin,
    body: { versionId: v1.versionId, baseRevision: 2 } });
  assert.equal(restored.status, 200);
  assert.equal(restored.data.slot.currentVersionId, v1.versionId);
  assert.equal(restored.data.slot.revision, 3);
  await f.restart();
  assert.equal((await f.request('/orders', { session: admin })).data.slots[0].currentVersionId, v1.versionId);
  assert.deepEqual((await f.request(`${filePath}/versions/${v1.versionId}/download`, { session: admin })).bytes, original);
  assert.deepEqual((await f.request(`${filePath}/versions/${v1.versionId}`, { session: admin })).data.sheets, v1.draft.data.sheets);
});

test('订单空模板可归档，任意订单文件均不进入资金看板或原四个文件槽位', async t => {
  const f = await appFixture(t);
  const admin = await f.login();
  await f.upload('schedule', await syntheticSchedule(), admin);
  await f.upload('shipment', await syntheticForecast(0), admin);
  const before = (await f.request('/dashboard', { session: admin })).data;
  assert.equal(before.summary.missingSourceCount, 2);
  const empty = new ExcelJS.Workbook(); empty.addWorksheet('金蝶采购订单空模板');
  const template = await f.upload(slotId, Buffer.from(await empty.xlsx.writeBuffer()), admin);
  assert.equal(template.draft.data.sheets[0].rowCount, 0);
  // Even a workbook shaped like the payment source remains an order archive.
  await f.upload(slotId, await syntheticSchedule(), admin);
  assert.deepEqual((await f.request('/dashboard', { session: admin })).data, before);
  assert.deepEqual((await f.request('/files', { session: admin })).data.slots.map(slot => slot.id), SLOTS.map(slot => slot.id));
  assert.equal((await f.request('/orders', { session: admin })).data.slots.length, 1);
});

test('订单拒绝损坏、零字节、无工作表与部分选表，失败不替换已保存文件', async t => {
  const f = await appFixture(t);
  const admin = await f.login();
  const bytes = await orderWorkbook();
  const saved = await f.upload(slotId, bytes, admin);
  const noSheets = Buffer.from(await new ExcelJS.Workbook().xlsx.writeBuffer());
  for (const bad of [Buffer.alloc(0), Buffer.from('not-xlsx'), noSheets]) {
    assert.equal((await f.preview(slotId, bad, admin)).status, 422);
  }
  assert.equal((await f.preview(slotId, bytes, admin, '旧格式.xls')).status, 422);
  const draft = await f.preview(slotId, bytes, admin);
  for (const selection of [[], ['采购订单'], ['采购订单', '采购订单', '空白模板'], ['采购订单', '隐藏原始表', '不存在']]) {
    const rejected = await f.activate(slotId, draft, admin, { selectedSheets: selection });
    assert.equal(rejected.status, 422);
    assert.match(rejected.data.error, /全部工作表/);
  }
  assert.equal((await f.request('/orders', { session: admin })).data.slots[0].currentVersionId, saved.versionId);
  assert.equal((await f.request(`${filePath}/versions`, { session: admin })).data.versions.length, 1);
  await assert.rejects(inspectWorkbook(Buffer.alloc(21 * 1024 * 1024), slotId), /20 MB/);
  const external = Buffer.from(bytes);
  const name = Buffer.from('xl/sharedStrings.xml');
  const replacement = Buffer.from('xl/externalLinks/' + 'x'.repeat(name.length - 'xl/externalLinks/'.length));
  let offset = external.indexOf(name), count = 0;
  while (offset !== -1) { replacement.copy(external, offset); count++; offset = external.indexOf(name, offset + name.length); }
  assert.ok(count >= 2);
  await assert.rejects(inspectWorkbook(external, slotId), /外部工作簿链接/);
  const parsed = await parseWorkbook(bytes, { slotId });
  assert.equal(parsed.kind, 'archive');
  assert.deepEqual(parsed.selectedSheets, draft.data.selectedSheets);
});

test('订单并发与过期草稿受版本保护，用户之间不能使用对方草稿', async t => {
  const f = await appFixture(t);
  const admin = await f.login();
  const { session: uploader } = await f.newUser(admin, 'order-uploader', ['files', 'upload']);
  const bytes = await orderWorkbook();
  await f.upload(slotId, bytes, admin);
  const a = await f.preview(slotId, bytes, admin, '管理员.xlsx');
  const b = await f.preview(slotId, bytes, uploader, '上传者.xlsx');
  assert.equal((await f.activate(slotId, a, uploader)).status, 409);
  const results = await Promise.all([f.activate(slotId, a, admin), f.activate(slotId, b, uploader)]);
  assert.equal(results.filter(result => result.status === 200).length, 1);
  assert.ok(results.some(result => [409, 429].includes(result.status)));
  const winner = results.find(result => result.status === 200);
  const loserIndex = results.findIndex(result => result.status !== 200);
  assert.equal((await f.activate(slotId, [a, b][loserIndex], [admin, uploader][loserIndex])).status, 409);
  assert.equal((await f.request('/orders', { session: admin })).data.slots[0].currentVersionId, winner.data.version.id);
  const expired = await f.preview(slotId, bytes, admin);
  f.db.prepare('UPDATE upload_drafts SET created_at=? WHERE token=?')
    .run(new Date(Date.now() - 7200000).toISOString(), expired.data.token);
  assert.equal((await f.activate(slotId, expired, admin)).status, 409);
  assert.equal((await f.request(`${filePath}/versions`, { session: admin })).data.versions.length, 2);
});

test('订单沿用文件操作权限、CSRF 和槽位版本隔离', async t => {
  const f = await appFixture(t);
  assert.equal((await f.request('/orders')).status, 401);
  const admin = await f.login();
  const bytes = await orderWorkbook();
  const saved = await f.upload(slotId, bytes, admin);
  const { session: dashboardOnly } = await f.newUser(admin, 'order-no-files', ['dashboard']);
  for (const path of ['/orders', `${filePath}/versions`, `${filePath}/versions/${saved.versionId}`, `${filePath}/versions/${saved.versionId}/download`]) {
    assert.equal((await f.request(path, { session: dashboardOnly })).status, 403, path);
  }
  const { session: viewer } = await f.newUser(admin, 'order-viewer', ['files']);
  assert.equal((await f.request('/orders', { session: viewer })).status, 200);
  assert.equal((await f.request(`${filePath}/versions/${saved.versionId}`, { session: viewer })).status, 200);
  assert.equal((await f.preview(slotId, bytes, viewer)).status, 403);
  assert.equal((await f.request(`${filePath}/versions/${saved.versionId}/download`, { session: viewer })).status, 403);
  assert.equal((await f.request(`${filePath}/restore`, { method: 'POST', session: viewer,
    body: { versionId: saved.versionId, baseRevision: 1 } })).status, 403);
  assert.equal((await f.request(`${filePath}/restore`, { method: 'POST', session: admin, csrf: false,
    body: { versionId: saved.versionId, baseRevision: 1 } })).status, 403);
  for (const suffix of ['', '/download']) {
    assert.equal((await f.request(`/files/shipment/versions/${saved.versionId}${suffix}`, { session: admin })).status, 404);
  }
  assert.equal((await f.request('/files/shipment/restore', { method: 'POST', session: admin,
    body: { versionId: saved.versionId, baseRevision: 0 } })).status, 404);
});

test('独立订单地址使用订单标题和描述，原入口保持原样且非精确路径返回404', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'order-page-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const html = '<!doctype html><html><head><title>资金台账</title><meta name="description" content="采购付款计划、资金预估与文件版本管理" /></head><body><script src="/zijintaizhang/assets/app.js"></script></body></html>';
  await writeFile(join(directory, 'index.html'), html);
  const f = await appFixture(t, { distDir: directory });
  const page = await fetch(`${f.origin}/caigoudingdangenjin/`);
  assert.equal(page.status, 200);
  const body = await page.text();
  assert.match(body, /<title>采购订单跟进<\/title>/);
  assert.match(body, /content="金蝶采购订单原始文件与版本管理"/);
  assert.match(body, /\/zijintaizhang\/assets\/app.js/);
  assert.equal(await (await fetch(`${f.origin}/zijintaizhang/`)).text(), html);
  const redirect = await fetch(`${f.origin}/caigoudingdangenjin`, { redirect: 'manual' });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('location'), '/caigoudingdangenjin/');
  assert.equal((await fetch(`${f.origin}/caigoudingdangenjin/unknown`)).status, 404);
});
