import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { buildDashboard } from '../server/dashboard.js';
import { dashboardExport } from '../server/exports.js';
import { SLOTS } from '../shared/constants.js';

const slots = SLOTS.map(slot => ({ ...slot, currentVersionId: slot.id }));
function value(sheet, label, header) {
  const column = sheet.getRow(1).values.indexOf(header);
  let result;
  sheet.eachRow(row => { if (row.getCell(1).value === label) result = row.getCell(column).value; });
  return result;
}

test('导出按新版期间统计且保留精确元、待定来源与未知付款拆分', async () => {
  const plans = [{ month: '2026-11', amountCents: 10001, paidCents: null, unpaidCents: null },
    { month: null, amountCents: 321, paidCents: 0, unpaidCents: 321 }];
  const record = { key: 'schedule:谈判付款:2', slotId: 'schedule', category: 'negotiated', supplier: '合成供应商',
    sourceSheet: '谈判付款', sourceRow: 2, amountCents: 10322, paidCents: 2500, remainingCents: 7822,
    applicationStatus: '是', flowCode: '', currentNode: '审核中', plans };
  const data = buildDashboard([record], [], slots, { month: '2026-11' });
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await dashboardExport(data));
  const stats = book.getWorksheet('统计口径');
  assert.equal(value(stats, '期间计划（含预估）', '金额或说明'), 100.01);
  for (const label of ['期间已付', '期间未付', '已申请未付']) assert.equal(value(stats, label, '金额或说明'), '待核对');
  assert.equal(value(book.getWorksheet('月度付款汇总'), '总合计', '所选期间合计（元）'), 100.01);
  assert.equal(value(book.getWorksheet('时间待定付款汇总'), '总合计', '时间待定合计（元）'), 3.21);
  assert.equal(value(book.getWorksheet('筛选明细'), '谈判表-谈判付款', '原台账累计已付'), 25);
  assert.equal(value(book.getWorksheet('筛选明细'), '谈判表-谈判付款', '选定范围已付（新规则）'), '待核对');
  assert.equal(value(book.getWorksheet('付款明细'), '合成供应商', '总金额（元）'), 100.01);
  assert.equal(value(book.getWorksheet('付款明细'), '合成供应商', '已申请未付金额（元）'), '待核对');
  assert.equal(value(book.getWorksheet('付款明细'), '合成供应商', '未申请金额（元）'), 0);
  assert.equal(value(book.getWorksheet('付款明细'), '合成供应商', '节点'), '审核中');
  const pendingBook = new ExcelJS.Workbook();
  await pendingBook.xlsx.load(await dashboardExport(buildDashboard([record], [], slots, { month: 'pending' })));
  assert.equal(value(pendingBook.getWorksheet('统计口径'), '期间计划（含预估）', '金额或说明'), 3.21);
  assert.equal(value(pendingBook.getWorksheet('统计口径'), '已申请未付', '金额或说明'), 3.21);
});

test('付款明细导出全部期间记录含已付及零值，部分申请和未知未申请金额不补零', async () => {
  const rows = [
    ['已付供应商', 12345, 12345, '未申请'],
    ['零值供应商', 0, 0, ''],
    ['部分申请供应商', 10001, 2000, '已经提交部分'],
    ['未知付款供应商', 501, null, ''],
  ];
  const records = rows.map(([supplier, amountCents, paidCents, applicationStatus], index) => ({
    key: `schedule:正常付款:${index + 2}`, slotId: 'schedule', category: 'normal', supplier,
    sourceSheet: '正常付款', sourceRow: index + 2, amountCents, paidCents, remainingCents: paidCents == null ? null : amountCents - paidCents,
    applicationStatus, flowCode: '', currentNode: '', plans: [{ month: '2026-11', amountCents, paidCents,
      unpaidCents: paidCents == null ? null : amountCents - paidCents }],
  }));
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await dashboardExport(buildDashboard(records, [], slots, { month: '2026-11' })));
  assert.equal(book.getWorksheet('已申请未付'), undefined);
  const sheet = book.getWorksheet('付款明细');
  assert.equal(sheet.rowCount, rows.length + 1);
  assert.equal(value(sheet, '已付供应商', '总金额（元）'), 123.45);
  assert.equal(value(sheet, '已付供应商', '已申请未付金额（元）'), 0);
  assert.equal(value(sheet, '已付供应商', '未申请金额（元）'), 0);
  assert.equal(value(sheet, '零值供应商', '总金额（元）'), 0);
  assert.equal(value(sheet, '部分申请供应商', '总金额（元）'), 100.01);
  assert.equal(value(sheet, '部分申请供应商', '已申请未付金额（元）'), '待核对');
  assert.equal(value(sheet, '部分申请供应商', '未申请金额（元）'), '待核对');
  assert.equal(value(sheet, '未知付款供应商', '已申请未付金额（元）'), 0);
  assert.equal(value(sheet, '未知付款供应商', '未申请金额（元）'), '待核对');
  assert.match(value(book.getWorksheet('统计口径'), '付款明细口径', '金额或说明'), /全部记录.*包含已付.*尚未申请且未支付/);
});

test('待核对导出保留原列及问题，并补具体事项、操作提示和筛选外关联位置', async () => {
  const records = ['2026-11', '2027-01'].map((month, i) => ({ key: `schedule:正常付款:${i + 2}`, slotId: 'schedule',
    category: 'normal', supplier: `供应商${i}`, filename: `来源${i}.xlsx`, sourceSheet: '正常付款', sourceRow: i + 2,
    amountCents: 100, paidCents: 0, remainingCents: 100, flowCode: 'MDST-DGFK20261101001',
    plans: [{ month, amountCents: 100, paidCents: 0, unpaidCents: 100 }] }));
  const message = 'N2：金额为空或公式没有已保存的计算结果，已按0保存。';
  const data = buildDashboard(records, [{ code: 'ZERO_DEFAULTED', recordKey: records[0].key, message }], slots, { month: '2026-11' });
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await dashboardExport(data));
  const sheet = book.getWorksheet('待核对');
  assert.deepEqual(sheet.getRow(1).values.slice(1), ['问题', '来源工作表', '原始行', '类型', '核对事项', '需要核对', '来源文件', '关联位置']);
  assert.equal(value(sheet, message, '来源工作表'), '正常付款');
  assert.equal(value(sheet, message, '原始行'), 2);
  assert.equal(value(sheet, message, '核对事项'), '空金额按0处理');
  assert.match(value(sheet, message, '需要核对'), /确认列出的单元格是否确实为0/);
  assert.equal(value(sheet, message, '来源文件'), '来源0.xlsx');
  const duplicateMessage = data.issues.find(issue => issue.code === 'DUPLICATE_FLOW').message;
  assert.equal(value(sheet, duplicateMessage, '关联位置'), '来源1.xlsx · 正常付款 第3行 · 供应商1');
});
