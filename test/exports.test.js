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
  assert.equal(value(book.getWorksheet('已申请未付'), '合成供应商', '已申请未付金额（元）'), '待核对');
  assert.equal(value(book.getWorksheet('已申请未付'), '合成供应商', '节点'), '审核中');
  const pendingBook = new ExcelJS.Workbook();
  await pendingBook.xlsx.load(await dashboardExport(buildDashboard([record], [], slots, { month: 'pending' })));
  assert.equal(value(pendingBook.getWorksheet('统计口径'), '期间计划（含预估）', '金额或说明'), 3.21);
  assert.equal(value(pendingBook.getWorksheet('统计口径'), '已申请未付', '金额或说明'), 3.21);
});
