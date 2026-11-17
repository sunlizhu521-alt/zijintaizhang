import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { inspectWorkbook, parseWorkbook } from '../server/parser.js';

const orderHeaders = ['单据编号', '分录行号', '供应商名称', '物料编码', '物料名称', '规格型号', '采购单位', '采购数量', '创建时间', '交货日期', '标签要求', '收货地址'];
const deliveryHeaders = ['单据编号', '分录行号', '源单单号', '源单行号', '供应商名称', '物料编码', '物料名称', '规格型号', '单位', '数量', '日期'];
const orderRow = ['PO-001', 1, '供应商甲', 'SKU-001', '产品甲', 'A型', '件', 100, '2026-11-01 09:31:00', '2026-11-20', '中文标签', '上海仓'];
const deliveryRow = ['IN-001', 1, 'PO-001', 1, '供应商甲', 'SKU-001', '产品甲', 'A型', '件', 50, '2026-11-15'];
async function buffer(headers = orderHeaders, rows = [orderRow], prepare) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('业务数据');
  sheet.addRow(headers);
  rows.forEach(row => sheet.addRow(row));
  prepare?.(workbook, sheet);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
const parse = (bytes, slotId = 'delivery_orders', extra = {}) => parseWorkbook(bytes, { slotId, ...extra });

test('交付槽位保留订单创建日期和交期、字段映射、人工标签和收货要求', async () => {
  const bytes = await buffer();
  const inspected = await inspectWorkbook(bytes, 'delivery_orders');
  assert.equal(inspected.kind, 'delivery');
  assert.equal(inspected.sheets[0].mapping.createdDate, '创建时间');
  assert.equal(inspected.sheets[0].defaultSelected, true);
  const parsed = await parse(bytes);
  assert.equal(parsed.kind, 'delivery');
  assert.equal(parsed.records.length, 1);
  const row = parsed.records[0];
  assert.equal(row.orderNumber, 'PO-001');
  assert.equal(row.lineNumber, '1');
  assert.equal(row.sourceType, 'orders');
  assert.equal(row.sourceRow, 2);
  assert.equal(row.createdDate, '2026-11-01');
  assert.equal(row.dueDate, '2026-11-20');
  assert.equal(row.quantity, 100);
  assert.equal(row.labelRequirement, '中文标签');
  assert.equal(row.receivingInfo, '上海仓');
  assert.equal(row.rawFields['创建时间'], '2026-11-01 09:31:00');
  assert.deepEqual(row.invalidFields, []);
});

test('收料和入库只由源单单号读取采购订单，保留各自日期数量与源单行号', async () => {
  for (const [slotId, sourceType] of [['delivery_receipts', 'receipts'], ['delivery_inbound', 'inbound']]) {
    const parsed = await parse(await buffer(deliveryHeaders, [deliveryRow]), slotId);
    assert.equal(parsed.records[0].documentNumber, 'IN-001');
    assert.equal(parsed.records[0].orderNumber, 'PO-001');
    assert.equal(parsed.records[0].sourceLineNumber, '1');
    assert.equal(parsed.records[0].sourceType, sourceType);
    assert.equal(parsed.records[0].deliveryDate, '2026-11-15');
    assert.equal(parsed.records[0].quantity, 50);
  }
  const wrongHeader = deliveryHeaders.map(label => label === '源单单号' ? '采购订单号' : label);
  const inspected = await inspectWorkbook(await buffer(wrongHeader, [deliveryRow]), 'delivery_inbound');
  assert.equal(inspected.sheets[0].eligible, false);
  assert.match(inspected.sheets[0].reason, /源单单号/);
});

test('缺少必需字段、含糊重复列拒绝读取，创建时间不从单据日期猜测', async () => {
  const missing = await buffer(orderHeaders.map(label => label === '创建时间' ? '单据日期' : label));
  await assert.rejects(() => parse(missing), /至少一张/);
  const inspected = await inspectWorkbook(missing, 'delivery_orders');
  assert.match(inspected.sheets[0].reason, /创建时间/);
  const duplicate = await buffer([...orderHeaders, '采购数量'], [[...orderRow, 999]]);
  assert.equal((await inspectWorkbook(duplicate, 'delivery_orders')).sheets[0].eligible, false);
  await assert.rejects(() => parse(duplicate, 'delivery_orders', { selectedSheets: ['业务数据'] }), /表头重复/);
});

test('空数量与未缓存公式保留为 null，零公式和 6 位小数精确保留，负数非法值不统计', async () => {
  const quantities = [null, { formula: '1+1' }, { formula: '1-1', result: 0 }, 0, '1,234.123456', -1, '待定', '1.1234567', { formula: '1/0', result: { error: '#DIV/0!' } }, 1e-7, 1e20];
  const rows = quantities.map((quantity, i) => orderRow.map((value, col) => col === 0 ? `PO-${i}` : col === 7 ? quantity : value));
  const parsed = await parse(await buffer(orderHeaders, rows));
  assert.equal(parsed.records.length, quantities.length);
  assert.deepEqual(parsed.records.map(row => row.quantity), [null, null, 0, 0, 1234.123456, null, null, null, null, null, null]);
  assert.match(parsed.records[1].rawFields['采购数量'], /无已保存结果/);
  assert.equal(parsed.issues.filter(issue => issue.code === 'INVALID_DELIVERY_QUANTITY').length, 8);
  assert.ok(parsed.issues.every(issue => issue.sourceType === 'orders' && issue.orderNumber.startsWith('PO-')));
});

test('明确日期解析支持原生日期、1904 日期与缓存公式，月份和无年份不补日期', async () => {
  const dates = [new Date('2026-11-20T00:00:00Z'), '2026年11月', '11月20日', '2026-02-30', { formula: 'DATE(2026,11,20)', result: 46346 }, null];
  const rows = dates.map((date, i) => orderRow.map((value, col) => col === 0 ? `PO-${i}` : col === 9 ? date : value));
  const parsed = await parse(await buffer(orderHeaders, rows));
  assert.deepEqual(parsed.records.map(row => row.dueDate), ['2026-11-20', null, null, null, '2026-11-20', null]);
  assert.equal(parsed.issues.filter(issue => issue.code === 'INVALID_DELIVERY_DATE').length, 4);
  const older = await parse(await buffer(orderHeaders, [orderRow.map((value, i) => i === 8 ? 0 : i === 9 ? 1 : value)], workbook => { workbook.properties.date1904 = true; }));
  assert.equal(older.records[0].createdDate, '1904-01-01');
  assert.equal(older.records[0].dueDate, '1904-01-02');
});

test('真实合并单元格可读取，未合并空值不向下猜填，空表和零数量行保留', async () => {
  const second = orderRow.map((value, i) => i === 0 || i === 2 ? null : i === 1 ? 2 : i === 7 ? 0 : value);
  const bytes = await buffer(orderHeaders, [orderRow, second], (_wb, sheet) => { sheet.mergeCells('A2:A3'); });
  const parsed = await parse(bytes);
  assert.equal(parsed.records[1].orderNumber, 'PO-001');
  assert.equal(parsed.records[1].supplier, '');
  assert.equal(parsed.records[1].quantity, 0);
  assert.ok(parsed.records[1].invalidFields.includes('supplier'));
  assert.equal((await parse(await buffer(orderHeaders, []))).records.length, 0);
});

test('前20行表头识别、重复标题和合计行排除，辅助及隐藏表不默认计入', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('采购明细');
  sheet.getCell('A1').value = '导出报表';
  sheet.getRow(20).values = orderHeaders;
  sheet.addRow(orderRow);
  sheet.addRow(orderHeaders);
  sheet.addRow(['合计', '', '', '', '', '', '', 100]);
  for (const name of ['采购备份', '隐藏']) {
    const other = workbook.addWorksheet(name);
    other.addRow(orderHeaders); other.addRow(orderRow);
    if (name === '隐藏') other.state = 'hidden';
  }
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  const inspected = await inspectWorkbook(bytes, 'delivery_orders');
  assert.equal(inspected.sheets[0].headerRow, 20);
  assert.deepEqual(inspected.sheets.map(sheet => sheet.defaultSelected), [true, false, false]);
  assert.equal((await parse(bytes)).records.length, 1);
  assert.equal((await parse(bytes, 'delivery_orders', { selectedSheets: ['采购备份'] })).records.length, 1);
});

test('单位空值及创建晚于交期明确进入核对项', async () => {
  const row = orderRow.map((value, i) => i === 6 ? null : i === 9 ? '2026-10-01' : value);
  const parsed = await parse(await buffer(orderHeaders, [row]));
  assert.ok(parsed.records[0].invalidFields.includes('unit'));
  assert.ok(parsed.records[0].invalidFields.includes('dueDate'));
  assert.ok(parsed.issues.some(issue => issue.code === 'DELIVERY_DATE_CONFLICT'));
});


test('入库实际数量优先配库存单位，普通序号不冒充分录行号', async () => {
  const headers = [...deliveryHeaders.filter(header => header !== '分录行号' && header !== '单位'), '库存单位', '采购单位', '序号'];
  const row = [...deliveryRow.filter((_value, i) => i !== 1 && i !== 8), '件', '箱', 99];
  const parsed = await parse(await buffer(headers, [row]), 'delivery_inbound');
  assert.equal(parsed.records[0].unit, '件');
  assert.equal(parsed.records[0].lineNumber, '');
  assert.equal(parsed.sheets[0].mapping.unit, '库存单位');
});


test('按表头匹配不依赖列位置，额外列和可选列增减不改变业务读取', async () => {
  const headers = ['无关附加字段', '源单编号', '入库日期', '实收数量', '供货方', '物料编码', '单据编号', '单位'];
  const row = ['保留原值', 'PO-1', '2026-11-02', 12, '供应商甲', 'SKU-1', 'RK-1', '件'];
  const normal = await parse(await buffer(headers, [row]), 'delivery_inbound');
  const shuffled = await parse(await buffer([...headers].reverse(), [[...row].reverse()]), 'delivery_inbound');
  for (const key of ['supplier', 'orderNumber', 'documentNumber', 'productCode', 'unit', 'quantity', 'deliveryDate']) assert.equal(shuffled.records[0][key], normal.records[0][key]);
  assert.equal(shuffled.records[0].supplier, '供应商甲');
  assert.equal(shuffled.records[0].rawFields['无关附加字段'], '保留原值');
  assert.deepEqual(shuffled.records[0].invalidFields, []);
});


test('金蝶合计标签位于日期列时排除尾行，收料交货数量和收料单位可识别', async () => {
  const headers = ['日期', '单据编号', '源单编号', '供应商', '物料编码', '交货数量', '收料单位'];
  const parsed = await parse(await buffer(headers, [
    ['2026-11-01', 'SL1', 'PO1', '供应商甲', 'SKU1', 10, '件'],
    ['合计', null, null, null, null, 10, null],
  ]), 'delivery_receipts');
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].quantity, 10);
  assert.equal(parsed.records[0].unit, '件');
  assert.deepEqual(parsed.issues, []);
});


test('用户确认采购日期作为创建日期，未导出单位保留空而不误报全表异常', async () => {
  const headers = ['采购日期', '供应商', '单据编号', '物料编码', '采购数量', '交货日期'];
  const parsed = await parse(await buffer(headers, [['2026-11-01', '供应商甲', 'PO1', 'SKU1', 10, '2026-11-20']]));
  assert.equal(parsed.records[0].createdDate, '2026-11-01');
  assert.equal(parsed.records[0].unit, '');
  assert.deepEqual(parsed.records[0].invalidFields, []);
  assert.equal(parsed.sheets[0].mapping.createdDate, '采购日期');
});


test('明确主键列优先于新增别名列，两类交付仍兼容源单编号并保留全部原字段', async () => {
  const orderColumns = [...orderHeaders, '采购订单号', '采购订单编号'];
  const orderValues = [...orderRow, 'OPTIONAL-ORDER', 'OPTIONAL-NUMBER'];
  const orders = await parse(await buffer(orderColumns, [orderValues]));
  assert.equal(orders.records[0].orderNumber, 'PO-001');
  assert.equal(orders.sheets[0].mapping.orderNumber, '单据编号');
  assert.equal(orders.records[0].rawFields['采购订单号'], 'OPTIONAL-ORDER');
  assert.equal(orders.records[0].rawFields['采购订单编号'], 'OPTIONAL-NUMBER');
  assert.equal(orders.records[0].rawFields['单据编号'], 'PO-001');
  for (const slotId of ['delivery_receipts', 'delivery_inbound']) {
    // Put aliases before the declared source field to verify column order cannot override it.
    const columns = ['源单编号', '源订单号', ...deliveryHeaders];
    const values = ['OPTIONAL-SOURCE', 'OPTIONAL-ORDER', ...deliveryRow];
    const delivery = await parse(await buffer(columns, [values]), slotId);
    assert.equal(delivery.records[0].orderNumber, 'PO-001');
    assert.equal(delivery.records[0].documentNumber, 'IN-001');
    assert.equal(delivery.sheets[0].mapping.orderNumber, '源单单号');
    assert.equal(delivery.records[0].rawFields['源单编号'], 'OPTIONAL-SOURCE');
    assert.equal(delivery.records[0].rawFields['源订单号'], 'OPTIONAL-ORDER');
    assert.equal(delivery.records[0].rawFields['源单单号'], 'PO-001');
    const aliasOnly = await parse(await buffer(deliveryHeaders.map(header => header === '源单单号' ? '源单编号' : header), [deliveryRow]), slotId);
    assert.equal(aliasOnly.records[0].orderNumber, 'PO-001');
    assert.equal(aliasOnly.sheets[0].mapping.orderNumber, '源单编号');
  }
});
