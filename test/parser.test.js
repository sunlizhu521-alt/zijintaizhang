import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { inspectWorkbook, parseWorkbook, parseDate, parseMoney } from '../server/parser.js';

const forecastHeaders = ['预估付款月份', '供应商名称', '付款主体', '摘要', '申请付款金额', '账期', '备注'];
const negotiatedHeaders = ['创跟单员', '供应商', '付款主体', '对公付款0A流程号', '摘要', 'OA-申请付款金额', '应付款时间', '已付金额', '剩余付款金额', '是否结清', '流程状态', '2026年11月支付', '2026年12月支付', '备注'];
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
  negotiated.addRow(['甲', '样例供应商甲', '示例主体', 'MDST-DGFK20261101001', '分期款', 1234.56, 46327, 200, 1034.56, '否', '未归档', 500, 734.56, '原备注']);
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

test('付款节奏读取两张指定表，月计划不按申请日期归月，空已付不推断归档为支付', async () => {
  const { workbook, negotiated } = scheduleBook();
  negotiated.getCell('N2').note = '11月核对备注';
  const parsed = await parseWorkbook(await asBuffer(workbook), { slotId: 'schedule' });
  assert.equal(parsed.records.length, 2);
  const first = parsed.records[0];
  assert.equal(first.key, 'schedule:谈判付款:2');
  assert.equal(first.amountCents, 123456);
  assert.deepEqual(first.plans, [{ month: '2026-11', amountCents: 50000 }, { month: '2026-12', amountCents: 73456 }]);
  assert.equal(first.comments.N2, '11月核对备注');
  assert.equal(parsed.records[1].paidCents, null);
  assert.equal(parsed.records[1].remainingCents, 100000);
  assert.ok(parsed.issues.some(issue => issue.code === 'MISSING_PAID'));
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

test('公式只读已保存结果，缺失计算结果和无效金额拒绝激活并提供行列位置', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = forecastSheet(workbook, '甲', [['2026-11-01', '供应商甲', '主体', '预估', { formula: '10+20', result: 30 }, '', '']]);
  assert.equal((await parseWorkbook(await asBuffer(workbook), { slotId: 'shipment' })).records[0].amountCents, 3000);
  sheet.getCell('E2').value = { formula: '10-10', result: 0 };
  assert.equal((await parseWorkbook(await asBuffer(workbook), { slotId: 'shipment' })).records[0].amountCents, 0);
  sheet.getCell('E2').value = { formula: '10+20' };
  await assert.rejects(parseWorkbook(await asBuffer(workbook), { slotId: 'shipment' }), error => error.status === 422 && error.issues[0].sourceRow === 2 && error.issues[0].message.includes('E2'));
  sheet.getCell('E2').value = '一千';
  await assert.rejects(parseWorkbook(await asBuffer(workbook), { slotId: 'shipment' }), error => error.issues[0].message.includes('E2'));
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

test('实际付款样表基准：126 条谈判、41 条正常，月计划总额与申请总额相符', { skip: !process.env.SCHEDULE_SAMPLE }, async () => {
  const parsed = await parseWorkbook(await fs.readFile(process.env.SCHEDULE_SAMPLE), { slotId: 'schedule' });
  assert.equal(parsed.records.filter(record => record.category === 'negotiated').length, 126);
  assert.equal(parsed.records.filter(record => record.category === 'normal').length, 41);
  assert.equal(parsed.issues.filter(issue => issue.code === 'PLAN_AMOUNT_MISMATCH').length, 0);
  assert.ok(parsed.records.every(record => Number.isSafeInteger(record.amountCents)));
});

test('实际预估样表默认排除原始备份，不重复计入', { skip: !process.env.FORECAST_SAMPLE }, async () => {
  const parsed = await parseWorkbook(await fs.readFile(process.env.FORECAST_SAMPLE), { slotId: 'shipment' });
  assert.ok(!parsed.selectedSheets.includes('邢芳芳-原始表'));
  assert.ok(parsed.records.every(record => record.sourceSheet !== '邢芳芳-原始表'));
});
