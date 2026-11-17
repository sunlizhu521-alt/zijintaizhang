import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import XLSX from 'xlsx';
import { appFixture } from './helpers.js';
import { DELIVERY_SLOTS } from '../shared/constants.js';

async function workbook(type, quantity) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet(type === 'orders' ? '采购订单' : type === 'receipts' ? '收料通知单' : '采购入库单');
  sheet.addRow(type === 'orders'
    ? ['单据编号', '分录行号', '供应商名称', '物料编码', '物料名称', '规格型号', '单位', '数量', '创建时间', '交货日期']
    : ['单据编号', '分录行号', '源单单号', '源单行号', '供应商名称', '物料编码', '物料名称', '规格型号', '单位', '数量', '日期']);
  sheet.addRow(type === 'orders'
    ? ['PO-DEMO', '1', '合成供应商', 'DEMO-001', '合成产品', 'A', '件', quantity, '2026-01-01', '2026-02-01']
    : [type === 'receipts' ? 'SL-001' : 'RK-001', '1', 'PO-DEMO', '1', '合成供应商', 'DEMO-001', '合成产品', 'A', '件', quantity, '2026-01-25']);
  return Buffer.from(await book.xlsx.writeBuffer());
}

test('delivery file versions stay separate from finance and order archive, with original bytes and restored metrics', async t => {
  const f = await appFixture(t);
  const admin = await f.login();
  const slots = await f.request('/delivery/files', { session: admin });
  assert.deepEqual(slots.data.slots.map(s => s.id), DELIVERY_SLOTS.map(s => s.id));
  const orders = await workbook('orders', 100);
  const saved = await f.upload('delivery_orders', orders, admin);
  await f.upload('delivery_receipts', await workbook('receipts', 60), admin);
  await f.upload('delivery_inbound', await workbook('inbound', 50), admin);
  const board = await f.request('/delivery/dashboard', { session: admin });
  assert.equal(board.status, 200, JSON.stringify(board.data));
  assert.equal(board.data.rows.length, 1);
  assert.equal(board.data.rows[0].receipts.quantity, 60);
  assert.equal(board.data.rows[0].inbound.quantity, 50);
  assert.equal(board.data.summaries.receipts.deliveredQuantity, 60);
  assert.equal(board.data.summaries.inbound.deliveredQuantity, 50);
  assert.equal(board.data.rows[0].receipts.remainingQuantity, 40);
  assert.equal(board.data.rows[0].inbound.remainingQuantity, 50);
  assert.equal(board.data.rows[0].receipts.events[0].orderNumber, 'PO-DEMO');
  assert.equal(board.data.rows[0].inbound.events[0].orderNumber, 'PO-DEMO');
  assert.equal(board.data.suppliers[0].receipts.deliveredQuantity, 60);
  assert.equal(board.data.suppliers[0].inbound.deliveredQuantity, 50);
  assert.equal(board.data.monthly[0].receipts.deliveredQuantity, 60);
  assert.equal(board.data.monthly[0].inbound.deliveredQuantity, 50);
  assert.equal(board.data.summary.deliveredQuantity, undefined);
  assert.equal(board.data.stage, undefined);
  assert.equal(board.data.rows[0].status, undefined);
  assert.equal((await f.request('/delivery/dashboard?stage=inbound', { session: admin })).status, 400);
  const financeSlots = await f.request('/files', { session: admin });
  assert.equal(financeSlots.data.slots.length, 4);
  assert.ok(financeSlots.data.slots.every(s => !s.currentVersionId));
  const archive = await f.request('/orders', { session: admin });
  assert.equal(archive.data.slots.length, 1);
  assert.equal(archive.data.slots[0].currentVersionId, null);
  const history = await f.request(`/files/delivery_orders/versions/${saved.versionId}`, { session: admin });
  assert.equal(history.data.kind, 'delivery');
  assert.equal(history.data.records[0].quantity, 100);
  assert.equal(history.data.progressSource, undefined);
  const downloaded = await f.request(`/files/delivery_orders/versions/${saved.versionId}/download`, { session: admin });
  assert.deepEqual(downloaded.bytes, orders);
  await f.upload('delivery_orders', await workbook('orders', 200), admin);
  const currentSlots = await f.request('/delivery/files', { session: admin });
  const revision = currentSlots.data.slots.find(s => s.id === 'delivery_orders').revision;
  const restored = await f.request('/files/delivery_orders/restore', { method: 'POST', session: admin, body: { versionId: saved.versionId, baseRevision: revision } });
  assert.equal(restored.status, 200);
  await f.restart();
  const after = await f.request('/delivery/dashboard', { session: await f.login() });
  assert.equal(after.data.rows[0].quantity, 100);
  assert.equal(after.data.rows[0].receipts.quantity, 60);
});

test('delivery has a separate entry and authenticated data API, preserving existing home pages', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'delivery-page-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'index.html'), '<html><head><title>资金台账</title><meta name="description" content="资金"></head><body><script src="/zijintaizhang/assets/app.js"></script></body></html>');
  const f = await appFixture(t, { distDir: dir });
  const response = await fetch(`${f.origin}/gongyingshangjiaofu/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<title>供应商交付管理<\/title>/);
  const redirect = await fetch(`${f.origin}/gongyingshangjiaofu`, { redirect: 'manual' });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('location'), '/gongyingshangjiaofu/');
  assert.equal((await fetch(`${f.origin}/gongyingshangjiaofu/unknown`)).status, 404);
  assert.match(await (await fetch(`${f.origin}/zijintaizhang/`)).text(), /<title>资金台账<\/title>/);
  assert.match(await (await fetch(`${f.origin}/caigoudingdangenjin/`)).text(), /<title>采购订单跟进<\/title>/);
  assert.equal((await f.request('/delivery/dashboard')).status, 401);
  assert.equal((await f.request('/delivery/files')).status, 401);
});

test('legacy XLS is accepted only in delivery slots and downloaded without conversion', async t => {
  const f = await appFixture(t), admin = await f.login();
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ['单据编号', '源单单号', '物料编码', '交货数量', '收料日期', '收料单位'],
    ['SL-XLS', 'PO-XLS', 'SKU-XLS', 0, '2026-11-01', '个'],
  ]), '收料通知单');
  const original = Buffer.from(XLSX.write(book, { type: 'buffer', bookType: 'biff8' }));
  const saved = await f.upload('delivery_receipts', original, admin, '旧版收料.xls');
  const result = await f.request(`/files/delivery_receipts/versions/${saved.versionId}/download`, { session: admin });
  assert.equal(result.headers.get('content-type'), 'application/vnd.ms-excel');
  assert.deepEqual(result.bytes, original);
  assert.equal((await f.preview('schedule', original, admin, '旧版收料.xls')).status, 422);
  assert.equal((await f.request('/files', { session: admin })).data.slots.length, 4);
});
