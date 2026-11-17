import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { appFixture, syntheticSchedule, syntheticForecast } from './helpers.js';

const views = ['monthly', 'pending', 'suppliers', 'pending-suppliers', 'payments', 'review', 'issues', 'drilldown'];
const drill = { table: 'monthly', rowId: 'total', detailMonth: '2026-11', measure: 'totalCents' };
const exportPath = options => `/dashboard/export?${new URLSearchParams({ from: '2026-11', to: '2026-12', ...options })}`;
async function workbook(result) {
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.match(result.headers.get('content-type'), /spreadsheetml/);
  assert.match(result.headers.get('content-disposition'), /attachment/);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(result.bytes);
  assert.ok(book.worksheets.length);
  return book;
}
function contains(book, value) {
  return book.worksheets.some(sheet => sheet.getSheetValues().some(row => row?.some(cell => cell === value)));
}

test('子页面下载仅允许同时拥有看板和导出权限的账号，并校验范围参数', async t => {
  const f = await appFixture(t);
  const admin = await f.login();
  const viewer = (await f.newUser(admin, 'scope-viewer', ['dashboard'])).session;
  const exporter = (await f.newUser(admin, 'scope-exporter', ['export'])).session;
  const permitted = (await f.newUser(admin, 'scope-permitted', ['dashboard', 'export'])).session;
  for (const exportView of views) {
    const path = exportPath({ exportView, ...(exportView === 'drilldown' ? drill : {}) });
    assert.equal((await f.request(path)).status, 401, exportView);
    assert.equal((await f.request(path, { session: viewer })).status, 403, exportView);
    assert.equal((await f.request(path, { session: exporter })).status, 403, exportView);
  }
  await workbook(await f.request(exportPath({ exportView: 'payments' }), { session: permitted }));
  for (const options of [
    { exportView: 'unrecognized' },
    { exportView: 'drilldown', ...drill, table: 'all' },
    { exportView: 'drilldown', ...drill, rowId: 'not-a-category' },
    { exportView: 'drilldown', ...drill, detailMonth: '2026-13' },
    { exportView: 'drilldown', ...drill, measure: 'amountCents' },
    { exportView: 'drilldown', ...drill, recordKey: 'another-record' },
  ]) assert.equal((await f.request(exportPath(options), { session: admin })).status, 400, JSON.stringify(options));
  for (const suffix of ['exportView=monthly&exportView=payments', 'exportView=drilldown&table=monthly&table=pending']) {
    assert.equal((await f.request(`/dashboard/export?${suffix}`, { session: admin })).status, 400, suffix);
  }
});

test('子页面下载包含全部分页记录，月度与待定分离，供应商和下钻范围与页面一致', async t => {
  const f = await appFixture(t);
  const admin = await f.login();
  const source = new ExcelJS.Workbook(); await source.xlsx.load(await syntheticSchedule());
  const normal = source.getWorksheet('正常付款');
  for (let i = 0; i < 25; i++) normal.addRow(['测试跟单员', `分页供应商${i}`, '合成主体', '', '分页校验', i + 1,
    '2026-11-10', 0, i + 1, '否', '未归档']);
  await f.upload('schedule', Buffer.from(await source.xlsx.writeBuffer()), admin);
  await f.upload('shipment', await syntheticForecast(50, { pending: true }), admin);
  const data = (await f.request('/dashboard?from=2026-11&to=2026-12', { session: admin })).data;
  assert.ok(data.records.length > 20);
  const payments = await workbook(await f.request(exportPath({ exportView: 'payments' }), { session: admin }));
  for (const record of data.records) assert.ok(contains(payments, record.supplier), record.supplier);
  assert.equal(contains(payments, '合成预估供应商'), false);
  const monthly = await workbook(await f.request(exportPath({ exportView: 'monthly' }), { session: admin }));
  assert.ok(monthly.getWorksheet('月度付款汇总'));
  assert.equal(monthly.getWorksheet('时间待定付款汇总'), undefined);
  assert.equal(contains(monthly, '合成预估供应商'), false);
  const pending = await workbook(await f.request(exportPath({ exportView: 'pending' }), { session: admin }));
  assert.ok(pending.getWorksheet('时间待定付款汇总'));
  assert.equal(pending.getWorksheet('月度付款汇总'), undefined);
  assert.ok(contains(pending, '合成预估供应商'));
  assert.equal(contains(pending, '合成供应商甲'), false);
  const supplier = await workbook(await f.request(exportPath({ exportView: 'suppliers', detailSupplier: '分页供应商24' }), { session: admin }));
  assert.ok(contains(supplier, '分页供应商24'));
  assert.equal(contains(supplier, '分页供应商23'), false);
  const november = await workbook(await f.request(exportPath({ exportView: 'drilldown', ...drill }), { session: admin }));
  assert.ok(contains(november, '合成供应商甲'));
  assert.ok(contains(november, '分页供应商24'));
  assert.equal(contains(november, '合成供应商丙'), false);
  assert.equal(contains(november, '合成预估供应商'), false);
  const firstRecord = data.records.find(record => record.supplier === '分页供应商24');
  const evidence = await workbook(await f.request(exportPath({ exportView: 'drilldown', ...drill, recordKey: firstRecord.key }), { session: admin }));
  assert.ok(contains(evidence, '分页供应商24'));
  assert.equal(contains(evidence, '分页供应商23'), false);
  const whole = await workbook(await f.request(exportPath({}), { session: admin }));
  assert.ok(whole.getWorksheet('月度付款汇总'));
  assert.ok(whole.getWorksheet('时间待定付款汇总'));
  const logs = (await f.request('/logs?kind=operation', { session: admin })).data.items;
  assert.ok(logs.some(log => log.details?.exportView === 'drilldown'), '下载操作记录应包含当前子页面范围');
});
