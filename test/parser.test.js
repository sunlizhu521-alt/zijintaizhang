import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { inspectWorkbook, parseWorkbook, parseDate, parseMoney } from '../server/parser.js';

const forecastHeaders = ['预估付款月份', '供应商名称', '付款主体', '摘要', '申请付款金额', '账期', '备注'];
const negotiatedHeaders = ['创跟单员', '供应商', '付款主体', '对公付款0A流程号', '摘要', 'OA-申请付款金额', '应付款时间', '已付金额', '剩余付款金额', '是否结清', '流程状态', '2026年11月支付', '2026年12月支付', '备注', '是否谈判分批'];
const normalHeaders = ['跟单员', '供应商名称', '付款主体', '对公付款0A流程号', '摘要', '本次申请付款金额', '应付时间', '已付金额', '剩余金额', '是否结清', '流程状态'];

async function asBuffer(workbook) { return Buffer.from(await workbook.xlsx.writeBuffer()); }
function forecastSheet(workbook, name, rows, headers = forecastHeaders) {
  const sheet = workbook.addWorksheet(name);
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(row);
  return sheet;
}
function scheduleBook() {
  const workbook = new ExcelJS.Workbook();
  const negotiated = workbook.addWorksheet('谈判付款');
  negotiated.addRow(negotiatedHeaders);
  negotiated.addRow(['甲', '样例供应商甲', '示例主体', 'MDST-DGFK20261101001', '分期款', 1234.56, 46327, 200, 1034.56, '否', '未归档', 500, 734.56, '原备注', '是']);
  const normal = workbook.addWorksheet('正常付款');
  normal.addRow(normalHeaders);
  normal.addRow(['乙', '样例供应商乙', '示例主体', 'MDST-DGFK20261101002', '正常款', '1,000.00', '2026年11月15日', null, 1000, '', '归档']);
  return { workbook, negotiated, normal };
}

test('金额转换保留空与零，精确舍入分并拒绝非法或超界数值', () => {
  assert.equal(parseMoney(null), null);
  assert.equal(parseMoney(''), null);
  assert.equal(parseMoney('0.00'), 0);
  assert.equal(parseMoney('¥1,234.56'), 123456);
  assert.equal(parseMoney('（12.30）'), -1230);
  assert.equal(parseMoney(1.005), 101);
  assert.equal(parseMoney(-1.005), -101);
  assert.equal(parseMoney(1e-7), 0);
  for (const invalid of ['1,2,3', '=1+2', '待定', '1e1000000000', Infinity, true, '999999999999999999']) assert.throws(() => parseMoney(invalid));
});

test('日期支持 Excel 序号、1904 系统、文本、时间戳和跨年，拒绝无年份及非法日期', () => {
  assert.deepEqual(parseDate(46327), { date: '2026-11-01', month: '2026-11' });
  assert.deepEqual(parseDate('46327'), { date: '2026-11-01', month: '2026-11' });
  assert.deepEqual(parseDate('2027年1月'), { date: '2027-01', month: '2027-01' });
  assert.deepEqual(parseDate('2026-11-01 00:00:00'), { date: '2026-11-01', month: '2026-11' });
  assert.equal(parseDate(0, true).date, '1904-01-01');
  assert.equal(parseDate(new Date('2027-01-01T00:00:00Z')).month, '2027-01');
  for (const invalid of ['11月', '/', '2026-02-30', '2026年13月', null]) assert.equal(parseDate(invalid), null);
});

test('付款节奏读取两张指定表，月计划不按申请日期归月，空已付记零但不推断归档为支付', async () => {
  const { workbook, negotiated } = scheduleBook();
  negotiated.getCell('N2').note = '11月核对备注';
  const parsed = await parseWorkbook(await asBuffer(workbook), { slotId: 'schedule' });
  assert.equal(parsed.records.length, 2);
  const first = parsed.records[0];
  assert.equal(first.key, 'schedule:谈判付款:2');
  assert.equal(first.amountCents, 123456);
  assert.deepEqual(first.plans, [{ month: '2026-11', amountCents: 50000 }, { month: '2026-12', amountCents: 73456 }]);
  assert.equal(first.comments.N2, '11月核对备注');
  assert.equal(parsed.records[1].paidCents, 0);
  assert.equal(parsed.records[1].remainingCents, 100000);
  assert.ok(!parsed.issues.some(issue => issue.code === 'MISSING_PAID'));
  assert.ok(parsed.issues.some(issue => issue.code === 'STATUS_CONFLICT'));
});

test('预估默认排除原始和隐藏表，保留重复备注列，支持显式选表', async () => {
  const workbook = new ExcelJS.Workbook();
  forecastSheet(workbook, '甲', [['2026年11月', '供应商甲', '主体', '预估', 0, '30天', '第一备注', '第二备注']], [...forecastHeaders, '备注']);
  forecastSheet(workbook, '甲-原始表', [['2026-11-01', '供应商甲', '主体', '预估', 500, '', '旧数据']]);
  forecastSheet(workbook, '隐藏数据', [['2026-11-01', '供应商乙', '主体', '预估', 600, '', '']]).state = 'hidden';
  forecastSheet(workbook, '空白人员', []);
  const buffer = await asBuffer(workbook);
  const inspected = await inspectWorkbook(buffer, 'shipment');
  assert.equal(inspected.sheets.find(sheet => sheet.name === '甲-原始表').defaultSelected, false);
  assert.equal(inspected.sheets.find(sheet => sheet.name === '隐藏数据').defaultSelected, false);
  const parsed = await parseWorkbook(buffer, { slotId: 'shipment' });
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].amountCents, 0);
  assert.equal(parsed.records[0].raw['备注（2）'], '第二备注');
  const explicit = await parseWorkbook(buffer, { slotId: 'shipment', selectedSheets: ['甲-原始表'] });
  assert.equal(explicit.records[0].amountCents, 50000);
  assert.equal(explicit.records.length, 1);
});

test('格式化到 XFD 的空单元格不会扩大字段，缺月份和负金额保留并标记', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = forecastSheet(workbook, '甲', [[null, '供应商甲', '主体', '退款', -1.23, '', '退回款']]);
  sheet.getCell('XFD2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
  sheet.addRow(['', '', '', '', '', '', '仅备注，非业务记录']);
  sheet.addRow(['', '合计', '', '', -1.23]);
  const parsed = await parseWorkbook(await asBuffer(workbook), { slotId: 'after_sales' });
  assert.equal(parsed.records.length, 1);
  assert.deepEqual(parsed.records[0].plans, [{ month: null, amountCents: -123 }]);
  assert.ok(parsed.issues.some(issue => issue.code === 'MISSING_MONTH'));
  assert.ok(parsed.issues.some(issue => issue.code === 'NEGATIVE_AMOUNT'));
});

test('金额公式读取保存结果，空金额和无结果公式记零，非法金额仍指出行列位置', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = forecastSheet(workbook, '甲', [['2026-11-01', '供应商甲', '主体', '预估', { formula: '10+20', result: 30 }, '', '']]);
  assert.equal((await parseWorkbook(await asBuffer(workbook), { slotId: 'shipment' })).records[0].amountCents, 3000);
  sheet.getCell('E2').value = { formula: '10-10', result: 0 };
  assert.equal((await parseWorkbook(await asBuffer(workbook), { slotId: 'shipment' })).records[0].amountCents, 0);
  for (const value of [null, '', '  ', { formula: '10+20' }, { formula: '""', result: '' }]) {
    sheet.getCell('E2').value = value;
    const parsed = await parseWorkbook(await asBuffer(workbook), { slotId: 'shipment' });
    assert.equal(parsed.records.length, 1);
    assert.equal(parsed.records[0].amountCents, 0);
    assert.deepEqual(parsed.records[0].plans, [{ month: '2026-11', amountCents: 0 }]);
  }
  for (const value of ['一千', { formula: '1/0', result: { error: '#DIV/0!' } }]) {
    sheet.getCell('E2').value = value;
    await assert.rejects(parseWorkbook(await asBuffer(workbook), { slotId: 'shipment' }), error => error.status === 422 && error.issues.some(issue => issue.sourceRow === 2 && issue.message.includes('E2')));
  }
  sheet.getCell('E2').value = { formula: '10+20' };
  sheet.addRow(['2026-11-01', '供应商乙', '主体', '共享公式', { sharedFormula: 'E2' }, '', '']);
  const shared = await parseWorkbook(await asBuffer(workbook), { slotId: 'shipment' });
  assert.deepEqual(shared.records.map(record => record.amountCents), [0, 0]);
});

test('谈判表按是否谈判分批区分两类，否仍按月支付列取计划，正常付款表不受其标记影响', async () => {
  const { workbook, negotiated, normal } = scheduleBook();
  negotiated.addRow(['丙', '样例供应商丙', '示例主体', 'MDST-DGFK20261101003', '非分批款', 90, '2027-01-01', 0, 90, '否', '未归档', 20, 70, '', ' 否 ']);
  normal.getCell('L1').value = '是否谈判付款';
  normal.getCell('L2').value = '是';
  const parsed = await parseWorkbook(await asBuffer(workbook), { slotId: 'schedule' });
  assert.deepEqual(parsed.records.map(record => record.category), ['negotiated', 'negotiated_normal', 'normal']);
  const second = parsed.records[1];
  assert.equal(second.sourceSheet, '谈判付款');
  assert.equal(second.sourceRow, 3);
  assert.equal(second.dueDate, '2027-01-01');
  assert.deepEqual(second.plans, [{ month: '2026-11', amountCents: 2000 }, { month: '2026-12', amountCents: 7000 }]);
});

test('谈判分类缺失、未知或缺表头时拒绝并定位，不默认为任一付款类别', async () => {
  const { workbook, negotiated } = scheduleBook();
  for (const value of [null, '待定', '1']) {
    negotiated.getCell('O2').value = value;
    await assert.rejects(parseWorkbook(await asBuffer(workbook), { slotId: 'schedule' }), error => error.status === 422 && error.issues.some(issue => issue.sourceSheet === '谈判付款' && issue.sourceRow === 2 && issue.message.includes('是否谈判分批') && issue.message.includes('O2')));
  }
  negotiated.getCell('O1').value = null;
  await assert.rejects(parseWorkbook(await asBuffer(workbook), { slotId: 'schedule' }), error => error.status === 422 && error.issues.some(issue => issue.sourceSheet === '谈判付款' && issue.sourceRow === 1 && issue.message.includes('是否谈判分批')));
});

test('付款申请、已付、剩余的空值和无缓存公式保存为零，月支付公式不凭空计算', async () => {
  const { workbook, negotiated, normal } = scheduleBook();
  for (const address of ['F2', 'H2', 'I2']) negotiated.getCell(address).value = { formula: '1+2' };
  negotiated.getCell('L2').value = { formula: '1+2' };
  negotiated.getCell('M2').value = 0;
  for (const address of ['F2', 'H2', 'I2']) normal.getCell(address).value = null;
  const parsed = await parseWorkbook(await asBuffer(workbook), { slotId: 'schedule' });
  for (const record of parsed.records) {
    assert.equal(record.amountCents, 0);
    assert.equal(record.paidCents, 0);
    assert.equal(record.remainingCents, 0);
  }
  assert.deepEqual(parsed.records[0].plans, [{ month: '2026-11', amountCents: 0 }, { month: '2026-12', amountCents: 0 }]);
  assert.equal(parsed.records[0].raw['OA-申请付款金额'], null);
  negotiated.getCell('F2').value = 25;
  negotiated.getCell('L2').value = null;
  negotiated.getCell('M2').value = null;
  const pending = await parseWorkbook(await asBuffer(workbook), { slotId: 'schedule' });
  assert.deepEqual(pending.records[0].plans, [{ month: null, amountCents: 2500 }]);
});

test('缺必需表、空数据、不合法选表及损坏归档均失败', async () => {
  const workbook = new ExcelJS.Workbook();
  forecastSheet(workbook, '甲', []);
  const buffer = await asBuffer(workbook);
  await assert.rejects(parseWorkbook(buffer, { slotId: 'schedule' }), /谈判付款/);
  await assert.rejects(parseWorkbook(buffer, { slotId: 'shipment' }), /没有有效业务记录/);
  await assert.rejects(parseWorkbook(buffer, { slotId: 'shipment', selectedSheets: ['不存在'] }), /不存在/);
  await assert.rejects(parseWorkbook(buffer, { slotId: 'shipment', selectedSheets: [] }), /至少一张/);
  await assert.rejects(inspectWorkbook(Buffer.from('bad xlsx'), 'shipment'), /结构损坏|并非/);
  await assert.rejects(inspectWorkbook(Buffer.alloc(21 * 1024 * 1024), 'shipment'), /20 MB/);
  await assert.rejects(inspectWorkbook(buffer, 'wrong'), /槽位不存在/);
});

test('压缩文件外链和过大的解压声明在读取工作簿前拒绝', async () => {
  const { workbook } = scheduleBook();
  const original = await asBuffer(workbook);
  const outside = Buffer.from(original);
  const oldName = Buffer.from('xl/sharedStrings.xml');
  const prefix = 'xl/externalLinks/';
  const newName = Buffer.from(prefix + 'x'.repeat(oldName.length - prefix.length));
  let offset = outside.indexOf(oldName), replaced = 0;
  while (offset !== -1) { newName.copy(outside, offset); replaced++; offset = outside.indexOf(oldName, offset + oldName.length); }
  assert.ok(replaced >= 2);
  await assert.rejects(inspectWorkbook(outside, 'schedule'), /外部工作簿链接/);
  const oversized = Buffer.from(original);
  const central = oversized.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(central >= 0);
  oversized.writeUInt32LE(201 * 1024 * 1024, central + 24);
  await assert.rejects(inspectWorkbook(oversized, 'schedule'), /解压内容过大/);
});

test('同流程号多笔记录保留并提示核对', async () => {
  const { workbook, normal } = scheduleBook();
  normal.getCell('D2').value = 'MDST-DGFK20261101001';
  const parsed = await parseWorkbook(await asBuffer(workbook), { slotId: 'schedule' });
  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.issues.filter(issue => issue.code === 'DUPLICATE_FLOW').length, 2);
});

test('实际付款样表基准：谈判表56条分批、70条非分批，正常表41条，总记录和计划金额保持', { skip: !process.env.SCHEDULE_SAMPLE }, async () => {
  const parsed = await parseWorkbook(await fs.readFile(process.env.SCHEDULE_SAMPLE), { slotId: 'schedule' });
  assert.equal(parsed.records.length, 167);
  assert.equal(parsed.records.filter(record => record.category === 'negotiated').length, 56);
  assert.equal(parsed.records.filter(record => record.category === 'negotiated_normal').length, 70);
  assert.equal(parsed.records.filter(record => record.category === 'normal').length, 41);
  assert.equal(parsed.issues.filter(issue => issue.code === 'PLAN_AMOUNT_MISMATCH').length, 0);
  assert.ok(parsed.records.every(record => Number.isSafeInteger(record.amountCents)));
});

test('实际预估样表默认排除原始备份，不重复计入', { skip: !process.env.FORECAST_SAMPLE }, async () => {
  const parsed = await parseWorkbook(await fs.readFile(process.env.FORECAST_SAMPLE), { slotId: 'shipment' });
  assert.ok(!parsed.selectedSheets.includes('邢芳芳-原始表'));
  assert.ok(parsed.records.every(record => record.sourceSheet !== '邢芳芳-原始表'));
});
