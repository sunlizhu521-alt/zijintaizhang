import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { buildDeliveryDashboard, deliveryFilters, deliveryExport } from '../server/delivery.js';
import { DELIVERY_SLOTS } from '../shared/constants.js';
import { appFixture } from './helpers.js';

const slots = DELIVERY_SLOTS.map(slot => ({ ...slot, currentVersionId: slot.id }));
const order = (extra = {}) => ({ sourceType: 'orders', orderNumber: 'PO-1', lineNumber: '1', supplier: '合成供应商', productCode: 'SKU-1', productName: '产品甲', specification: '标准', unit: '件', quantity: 10, createdDate: '2026-11-01', dueDate: '2026-11-10', invalidFields: [], sourceSheet: '订单', sourceRow: 2, ...extra });
const event = (extra = {}) => ({ sourceType: 'receipts', documentNumber: 'SL-1', lineNumber: '1', orderNumber: 'PO-1', sourceLineNumber: '1', supplier: '合成供应商', productCode: 'SKU-1', specification: '标准', unit: '件', quantity: 10, deliveryDate: '2026-11-10', invalidFields: [], sourceSheet: '收料', sourceRow: 2, ...extra });
const build = (records, extra = {}) => buildDeliveryDashboard({ records, slots, asOfDate: '2026-11-17', ...extra });

test('收料与入库独立累计，多批交齐日期和到期分母可复核', () => {
  const records = [order(), order({ orderNumber: 'PO-2', dueDate: '2026-11-20' }), order({ orderNumber: 'PO-0', quantity: 0 }),
    event({ quantity: 4, deliveryDate: '2026-11-09' }), event({ documentNumber: 'SL-2', quantity: 6 }),
    event({ sourceType: 'inbound', documentNumber: 'RK-1', quantity: 3, deliveryDate: '2026-11-11' })];
  const data = build(records);
  assert.equal(data.rows[0].receipts.quantity, 10);
  assert.equal(data.rows[0].receipts.completionDate, '2026-11-10');
  assert.equal(data.rows[0].inbound.quantity, 3);
  assert.equal(data.rows[0].inbound.status, 'overdue');
  assert.equal(data.summary.orderedQuantity, 20);
  assert.equal(data.summary.deliveredQuantity, 10);
  assert.equal(data.summary.quantityRate, 0.5);
  assert.equal(data.summary.onTimeRate, 1);
  assert.equal(data.summary.dueCount, 1);
  assert.equal(data.summary.warningCount, 1);
  assert.equal(data.rows[2].status, 'zero');
  const inbound = build(records, { filters: { stage: 'inbound' } });
  assert.equal(inbound.summary.deliveredQuantity, 3);
  assert.equal(inbound.summary.overdueCount, 1);
  assert.equal(inbound.summary.onTimeRate, 0);
  assert.equal(inbound.rows[0].remainingQuantity, 7);
});

test('按期分批不足、后续补齐应判定逾期交齐；超交不提高数量完成率', () => {
  const data = build([order(), event({ quantity: 4, deliveryDate: '2026-11-09' }), event({ documentNumber: 'SL-2', quantity: 9, deliveryDate: '2026-11-12' })]);
  assert.equal(data.rows[0].status, 'completed');
  assert.equal(data.rows[0].receipts.completionDate, '2026-11-12');
  assert.equal(data.rows[0].receipts.onTimeQuantity, 4);
  assert.equal(data.summary.onTimeRate, 0);
  assert.equal(data.summary.quantityRate, 1);
  assert.equal(data.summary.deliveredQuantity, 13);
  assert.equal(data.summary.outstandingQuantity, 0);
  assert.ok(data.issues.some(issue => issue.code === 'OVER_DELIVERY'));
});

test('重复单据、源行号缺失的同物料多行和匹配冲突均排除且保留证据', () => {
  const duplicate = build([order(), event(), event({ sourceRow: 3 })]);
  assert.equal(duplicate.rows[0].status, 'review');
  assert.equal(duplicate.rows[0].receipts.quantity, null);
  assert.equal(duplicate.summary.dueCount, 0);
  assert.ok(duplicate.issues.some(issue => issue.message.includes('重复')));
  const revisedDuplicate = build([order(), event({ lineNumber: '', quantity: 6 }), event({ lineNumber: '', quantity: 7, deliveryDate: '2026-11-12' })]);
  assert.equal(revisedDuplicate.rows[0].receipts.quantity, null);
  assert.equal(revisedDuplicate.rows[0].status, 'review');
  const ambiguous = build([order(), order({ lineNumber: '2', dueDate: '2026-11-12' }), event({ sourceLineNumber: '' })]);
  assert.deepEqual(ambiguous.rows.map(row => row.status), ['review', 'review']);
  const exact = build([order(), order({ lineNumber: '2', dueDate: '2026-11-12' }), event()]);
  assert.deepEqual(exact.rows.map(row => row.receipts.quantity), [10, 0]);
  const conflict = build([order(), event({ unit: '箱' })]);
  assert.equal(conflict.rows[0].status, 'review');
  assert.ok(conflict.issues.some(issue => issue.message.includes('不匹配')));
  const noLine = build([order({ lineNumber: '' }), order({ lineNumber: '', dueDate: '2026-12-01' })]);
  assert.equal(noLine.rows[0].followupAllowed, false);
  assert.equal(noLine.summary.reviewCount, 2);
});

test('缺失槽位为未知，合法零值保留，空日期/负数/未来和历史倒置均不计入', () => {
  const missing = build([order()], { slots: slots.filter(slot => slot.id !== 'delivery_receipts') });
  assert.equal(missing.rows[0].status, 'unknown');
  assert.equal(missing.summary.deliveredQuantity, null);
  assert.equal(missing.summary.onTimeRate, null);
  const zero = build([order(), event({ quantity: 0 })]);
  assert.equal(zero.rows[0].receipts.quantity, 0);
  assert.equal(zero.rows[0].status, 'overdue');
  for (const change of [{ quantity: null }, { quantity: -1 }, { deliveryDate: null }, { deliveryDate: '2026-12-01' }, { deliveryDate: '2026-10-01' }, { unit: '', invalidFields: ['unit'] }]) {
    const data = build([order(), event(change)]);
    assert.equal(data.rows[0].status, 'review', JSON.stringify(change));
    assert.equal(data.rows[0].receipts.quantity, null);
    assert.equal(data.rows[0].receipts.validQuantity, 0);
  }
  const malformedOrder = build([order({ quantity: null }), order({ orderNumber: 'PO-2', dueDate: null })]);
  assert.equal(malformedOrder.summary.reviewCount, 2);
  assert.equal(malformedOrder.summary.validLineCount, 0);
});

test('同物料默认单位可比且不跨物料汇总；同单不同数量的真实明细保留', () => {
  const data = build([order({ unit: '', quantity: 220 }), order({ orderNumber: 'PO-2', productCode: 'SKU-2', unit: '' }),
    event({ unit: '个', lineNumber: '', quantity: 20 }), event({ unit: '个', lineNumber: '', quantity: 200, sourceRow: 3 })]);
  assert.equal(data.rows[0].receipts.quantity, 220);
  assert.equal(data.rows[0].status, 'completed');
  assert.equal(data.summary.deliveredQuantity, null);
  assert.equal(data.summary.quantityByUnit.length, 2);
  assert.equal(data.summary.quantityByUnit.find(row => row.productCode === 'SKU-1').deliveredQuantity, 220);
  const wrongUnits = build([order({ unit: '' }), event({ unit: '个', lineNumber: '' }), event({ documentNumber: 'SL-2', unit: '箱' })]);
  assert.equal(wrongUnits.rows[0].status, 'review');
});

test('入库通过收料单唯一追溯采购订单并保留原编号，多采购目标不分摊', () => {
  const source = event({ documentNumber: 'CGSL-1', lineNumber: '', unit: '个' });
  const inbound = event({ sourceType: 'inbound', documentNumber: 'RK-1', orderNumber: 'CGSL-1', sourceLineNumber: '', unit: '', quantity: 8 });
  const data = build([order({ unit: '' }), source, inbound], { filters: { stage: 'inbound' } });
  assert.equal(data.rows[0].inbound.quantity, 8);
  const evidence = data.rows[0].inbound.events[0];
  assert.equal(evidence.orderNumber, 'PO-1');
  assert.equal(evidence.originalSourceNumber, 'CGSL-1');
  assert.equal(evidence.viaReceiptNumber, 'CGSL-1');
  const ambiguous = build([order({ unit: '' }), source, { ...source, orderNumber: 'PO-OTHER', quantity: 7 }, inbound], { filters: { stage: 'inbound' } });
  assert.equal(ambiguous.rows[0].status, 'review');
  assert.equal(ambiguous.rows[0].inbound.quantity, null);
  assert.ok(ambiguous.issues.some(issue => issue.message.includes('多个采购订单')));
  const direct = build([order({ unit: '' }), { ...inbound, orderNumber: 'PO-1' }], { filters: { stage: 'inbound' } });
  assert.equal(direct.rows[0].inbound.quantity, 8);
});

test('入库缺少字段时仍保留源收料规格单位供应商约束，同目标冲突不取最后一条', () => {
  const incoming = event({ sourceType: 'inbound', documentNumber: 'RK-1', orderNumber: 'SL-1', sourceLineNumber: '', unit: '', specification: '', supplier: '', rawFields: { 源单编号: 'SL-1', 新增字段: '保留原值' } });
  for (const change of [{ specification: '不同规格' }, { unit: '箱' }, { supplier: '其他供应商' }]) {
    const data = build([order(), event(change), incoming], { filters: { stage: 'inbound' } });
    assert.equal(data.rows[0].inbound.status, 'review', JSON.stringify(change));
    assert.equal(data.rows[0].inbound.quantity, null);
    assert.equal(data.summary.onTimeRate, null);
    assert.ok(data.issues.some(issue => issue.sourceType === 'inbound' && issue.message.includes('不匹配')));
  }
  const sameTargetConflict = [order(), event({ lineNumber: '1' }), event({ lineNumber: '2', unit: '箱', quantity: 2, sourceRow: 3 }), incoming];
  const conflicted = build(sameTargetConflict, { filters: { stage: 'inbound' } });
  assert.equal(conflicted.rows[0].inbound.quantity, null);
  assert.ok(conflicted.rows[0].inbound.reviewReasons.some(reason => reason.includes('不同计量单位')));
  const explicitInboundUnit = build(sameTargetConflict.map(row => row.sourceType === 'inbound' ? { ...row, unit: '件' } : row), { filters: { stage: 'inbound' } });
  assert.equal(explicitInboundUnit.rows[0].inbound.quantity, null);
  const exactReceiptLine = build(sameTargetConflict.map(row => row.sourceType === 'inbound' ? { ...row, sourceLineNumber: '1' } : row), { filters: { stage: 'inbound' } });
  assert.equal(exactReceiptLine.rows[0].inbound.quantity, 10);
  assert.equal(exactReceiptLine.rows[0].inbound.events[0].traceConstraints.unit, '件');
  assert.equal(exactReceiptLine.rows[0].inbound.events[0].unit, '');
  assert.equal(exactReceiptLine.rows[0].inbound.events[0].supplier, '');
  assert.deepEqual(exactReceiptLine.rows[0].inbound.events[0].rawFields, incoming.rawFields);
  assert.deepEqual(exactReceiptLine.rows[0].inbound.events[0].receiptSources, [{ sourceSheet: '收料', sourceRow: 2 }]);
});

test('追溯单位冲突不产生混合有效数量或交齐日，批次及跨订单汇总也不混加', () => {
  const receipts = [event({ documentNumber: 'SL-1', unit: '件', quantity: 5 }), event({ documentNumber: 'SL-2', unit: '箱', quantity: 5 })];
  const incoming = receipts.map((receipt, index) => event({ sourceType: 'inbound', documentNumber: `RK-${index + 1}`, orderNumber: receipt.documentNumber,
    sourceLineNumber: '', lineNumber: String(index + 1), quantity: 5, unit: '' }));
  for (const sameDocument of [false, true]) {
    const data = build([order({ unit: '' }), ...receipts, ...incoming.map(row => sameDocument ? { ...row, documentNumber: 'RK-1' } : row)], { filters: { stage: 'inbound' } });
    const row = data.rows[0];
    assert.equal(row.inbound.status, 'review');
    assert.equal(row.inbound.quantity, null);
    assert.equal(row.inbound.validQuantity, null);
    assert.equal(row.inbound.onTimeQuantity, null);
    assert.equal(row.inbound.completionDate, null);
    assert.equal(row.inbound.events.length, 2);
    assert.equal(row.unit, '');
    assert.equal(data.summary.onTimeRate, null);
    if (sameDocument) {
      assert.equal(row.batchInfo.inboundBatches[0].quantity, null);
      assert.equal(row.batchInfo.inboundBatches[0].validQuantity, null);
    } else assert.deepEqual(row.batchInfo.inboundBatches.map(batch => batch.quantity), [5, 5]);
  }
  const differentOrders = build([order({ unit: '', quantity: 5 }), order({ orderNumber: 'PO-2', unit: '', quantity: 5 }),
    receipts[0], { ...receipts[1], orderNumber: 'PO-2' }, ...incoming], { filters: { stage: 'inbound' } });
  assert.equal(differentOrders.summary.deliveredQuantity, null);
  assert.equal(differentOrders.summary.quantityByUnit.length, 2);
  assert.deepEqual(differentOrders.summary.quantityByUnit.map(row => [row.unit, row.deliveredQuantity]).sort(), [['件', 5], ['箱', 5]]);
  assert.deepEqual(differentOrders.rows.map(row => row.unit), ['', '']);
});

test('数量按单位分组并以六位小数精确相加；筛选按交期月份且问题不隐藏', () => {
  const records = [order({ quantity: 0.3 }), event({ quantity: 0.1 }), event({ documentNumber: 'SL-2', quantity: 0.2 }), order({ orderNumber: 'PO-2', unit: '箱', dueDate: '2026-12-01' }), event({ orderNumber: 'MISSING', documentNumber: 'UNMATCHED' })];
  const data = build(records);
  assert.equal(data.summary.deliveredQuantity, null);
  assert.equal(data.summary.quantityByUnit.find(row => row.unit === '件').deliveredQuantity, 0.3);
  assert.equal(data.rows[0].receipts.completionDate, '2026-11-10');
  assert.equal(build([order({ quantity: 9000.123456 }), event({ quantity: 9000.123456 })]).rows[0].status, 'completed');
  const filtered = build(records, { filters: { from: '2026-12', to: '2026-12', search: 'po-2' } });
  assert.equal(filtered.rows.length, 1);
  assert.equal(filtered.summary.orderedQuantity, 10);
  assert.ok(filtered.issues.some(issue => issue.orderNumber === 'MISSING'));
  assert.throws(() => deliveryFilters({ from: '2026-13' }), /月份/);
  assert.throws(() => deliveryFilters({ from: '2026-12', to: '2026-11' }), /开始/);
  assert.throws(() => deliveryFilters({ stage: 'combined' }), /口径/);
  assert.throws(() => deliveryFilters({ status: ['overdue'] }), /筛选/);
});

test('稳定订单行key与物料位置无关；人工异常保留但不改写单据数量', () => {
  const baseline = build([order()]).rows[0];
  const followups = new Map([[baseline.key, { revision: 1, data: { labelCheck: 'issue', exception: '标签错误', owner: '甲' }, updatedAt: '2026-11-17T00:00:00Z', updatedBy: 'test' }]]);
  const data = build([order({ sourceSheet: '新导出', sourceRow: 99 }), event()], { followups });
  assert.equal(data.rows[0].key, baseline.key);
  assert.equal(data.rows[0].followup.data.exception, '标签错误');
  assert.equal(data.rows[0].status, 'completed');
  assert.equal(data.summary.exceptionCount, 1);
  assert.notEqual(build([order({ productCode: 'REPLACED-SKU' })]).rows[0].key, baseline.key);
});

test('同订单同物料多交期可查看计划与实际批次，不自动FIFO或重复计入各行', () => {
  const data = build([order({ lineNumber: '', quantity: 10 }), order({ lineNumber: '', dueDate: '2026-11-20', quantity: 20 }),
    event({ sourceLineNumber: '', quantity: 8, deliveryDate: '2026-11-08' }), event({ documentNumber: 'SL-2', sourceLineNumber: '', quantity: 12, deliveryDate: '2026-11-16' })]);
  for (const row of data.rows) {
    assert.equal(row.status, 'review');
    assert.equal(row.receipts.quantity, null);
    assert.equal(row.batchInfo.shared, true);
    assert.equal(row.batchInfo.allocationPending, true);
    assert.equal(row.batchInfo.isSplit, true);
    assert.deepEqual(row.batchInfo.plannedBatches.map(batch => [batch.date, batch.quantity]), [['2026-11-10', 10], ['2026-11-20', 20]]);
    assert.deepEqual(row.batchInfo.receiptBatches.map(batch => [batch.date, batch.quantity, batch.allocated]), [['2026-11-08', 8, false], ['2026-11-16', 12, false]]);
  }
  assert.equal(data.summary.completedCount, 0);
  assert.equal(data.summary.dueCount, 0);
  const duplicated = build([order(), event(), event()]);
  assert.equal(duplicated.rows[0].batchInfo.receiptBatches[0].quantity, null);
  assert.equal(duplicated.rows[0].batchInfo.receiptBatches[0].validQuantity, 0);
  assert.equal(duplicated.rows[0].batchInfo.receiptBatches[0].review, true);
});

test('关闭订单保留历史差额和指标，停止延期预警；范围外记录单列且不影响异常行数', () => {
  const data = build([order({ rawFields: { 业务关闭: '业务关闭' } }), event({ quantity: 3 }),
    order({ orderNumber: 'PO-2', dueDate: '2026-11-20', rawFields: { 关闭状态: '已关闭' } }),
    event({ orderNumber: 'PO-OUTSIDE', documentNumber: 'SL-OUTSIDE' })]);
  assert.deepEqual(data.rows.map(row => row.status), ['closed', 'closed']);
  assert.equal(data.rows[0].remainingQuantity, 7);
  assert.equal(data.summary.closedCount, 2);
  assert.equal(data.summary.overdueCount, 0);
  assert.equal(data.summary.warningCount, 0);
  assert.equal(data.summary.dueCount, 1);
  assert.equal(data.summary.onTimeRate, 0);
  assert.equal(data.summary.reviewCount, 0);
  assert.equal(data.outsideScopeCount, 1);
  assert.equal(data.issues.at(-1).code, 'OUTSIDE_ORDER_SCOPE');
  assert.equal(build([order({ rawFields: { 关闭状态: '已关闭' } }), event()]).rows[0].status, 'completed');
});

function seedOrders(db, records = [order()], slotId = 'delivery_orders') {
  const version = `${slotId}-test-version`;
  db.prepare('INSERT INTO file_versions VALUES (?,?,?,?,?,?,?,?,?,?)').run(version, slotId, '合成订单.xlsx', Buffer.from('synthetic'), JSON.stringify({ kind: 'delivery', records, issues: [], selectedSheets: ['订单'] }), '["订单"]', 'admin', new Date().toISOString(), records.length, 0);
  db.prepare('UPDATE file_slots SET current_version_id=? WHERE id=?').run(version, slotId);
}

test('跟进接口检查权限CSRF来源与并发，重启及文件版本变化不丢人工内容', async t => {
  const f = await appFixture(t); seedOrders(f.db);
  assert.equal((await f.request('/delivery/dashboard')).status, 401);
  const admin = await f.login();
  const data = (await f.request('/delivery/dashboard', { session: admin })).data;
  const key = data.rows[0].key, path = `/delivery/followups/${key}`;
  const body = { revision: 0, data: { productionStatus: '生产中', shippingStatus: '未发货', labelCheck: 'issue', exception: '合成异常', owner: '跟进甲', expectedShipDate: '2026-11-19' } };
  assert.equal((await f.request(path, { method: 'PATCH', session: admin, body, csrf: false })).status, 403);
  assert.equal((await f.request(path, { method: 'PATCH', session: admin, body, headers: { Origin: 'https://other.example' } })).status, 403);
  const { session: viewer } = await f.newUser(admin, 'delivery-viewer', ['dashboard', 'files']);
  assert.equal((await f.request('/delivery/dashboard', { session: viewer })).status, 200);
  assert.equal((await f.request(path, { method: 'PATCH', session: viewer, body })).status, 403);
  assert.equal((await f.request('/delivery/export', { session: viewer })).status, 403);
  const results = await Promise.all([1, 2].map(() => f.request(path, { method: 'PATCH', session: admin, body })));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal((await f.request(path, { method: 'PATCH', session: admin, body: { revision: 1, data: { expectedShipDate: '2026-02-30' } } })).status, 400);
  assert.equal((await f.request(path, { method: 'PATCH', session: admin, body: { revision: 1, data: { labelCheck: 'yes' } } })).status, 400);
  assert.equal((await f.request(`/delivery/followups/${'f'.repeat(64)}`, { method: 'PATCH', session: admin, body })).status, 409);
  await f.restart();
  const persisted = (await f.request('/delivery/dashboard', { session: admin })).data.rows[0].followup;
  assert.equal(persisted.revision, 1);
  assert.equal(persisted.data.exception, '合成异常');
  assert.ok(f.db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='更新供应商交付跟进'").get().n === 1);
});

test('范围外来源按需分页，主看板不携带全量历史明细，并发导出有资源保护', async t => {
  const f = await appFixture(t); seedOrders(f.db);
  seedOrders(f.db, Array.from({ length: 25 }, (_, index) => event({ orderNumber: 'OUTSIDE', documentNumber: `SL-${index}`, sourceRow: index + 2 })), 'delivery_receipts');
  const admin = await f.login();
  assert.equal((await f.request('/delivery/outside-scope')).status, 401);
  const board = await f.request('/delivery/dashboard', { session: admin });
  assert.equal(board.data.outsideScopeCount, 25);
  assert.equal(board.data.issues.length, 0);
  const page = await f.request('/delivery/outside-scope?page=2&pageSize=20', { session: admin });
  assert.equal(page.data.total, 25);
  assert.equal(page.data.items.length, 5);
  assert.equal(page.data.items[0].sourceRow, 22);
  assert.equal((await f.request('/delivery/outside-scope?page=0', { session: admin })).status, 400);
  assert.equal((await f.request('/delivery/outside-scope?pageSize=5000', { session: admin })).status, 400);
  const exports = await Promise.all([1, 2].map(() => f.request('/delivery/export', { session: admin })));
  assert.deepEqual(exports.map(result => result.status).sort(), [200, 429]);
});

test('导出保存原生日期、数值、普通可取消筛选和原始位置，收料入库分列', async () => {
  const data = build([order(), event()]);
  const bytes = await deliveryExport(data);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes);
  const detail = workbook.getWorksheet('交付明细');
  assert.equal(detail.getCell('C2').value.toISOString().slice(0, 10), '2026-11-01');
  assert.equal(detail.getCell('C2').numFmt, 'yyyy-mm-dd');
  assert.equal(detail.getCell('K2').value, 10);
  assert.equal(detail.getCell('M2').value, 0);
  assert.ok(detail.autoFilter);
  assert.equal(Object.keys(detail.tables).length, 0);
  assert.equal(detail.getCell('J2').alignment.horizontal, 'center');
  assert.equal(detail.getCell('J2').fill.fgColor.argb, 'FFFFFFFF');
  assert.equal(detail.getCell('J2').border.bottom.style, 'thin');
  assert.equal(workbook.getWorksheet('供应商指标').getCell('H2').numFmt, '0.00%');
});
