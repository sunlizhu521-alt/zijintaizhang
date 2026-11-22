import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { dashboardExportScope, scopedDashboardExport } from '../server/dashboard-export.js';
import { detailRecords } from '../shared/payment-detail-selection.js';
import { buildPaymentTable } from '../server/payment-table.js';
import { SLOTS } from '../shared/constants.js';

const slots = SLOTS.map(slot => ({ ...slot, currentVersionId: slot.id }));
const plan = (month, amountCents, state = 'unapplied') => ({ month, amountCents, paidCents: 0, unpaidCents: amountCents,
  applicationState: state, appliedUnpaidCents: state === 'applied' ? amountCents : 0, unappliedUnpaidCents: state === 'applied' ? 0 : amountCents,
  paymentDates: [], paymentBasis: '尚未付款', applicationDates: [], applicationBasis: '批注未申请' });
const record = (key, supplier, plans) => ({ key, supplier, category: 'negotiated', sourceSheet: '谈判付款', sourceRow: Number(key) || 2,
  filename: '合成来源.xlsx', plans, selectedPlans: plans, selectedPlanCents: plans.reduce((sum, item) => sum + item.amountCents, 0),
  amountCents: 100000, paidCents: 0, remainingCents: 100000, raw: { 谈判明细: '两批，按期申请', 贾总备注: '保留贾总备注', 孙立柱备注: '保留孙备注' } });
function dataFor(records) {
  return { records, pendingRecords: [], paymentTable: buildPaymentTable(records, ['2026-11', '2026-12'], slots),
    pendingPaymentTable: buildPaymentTable([], ['pending'], slots), supplierGroups: [], pendingSupplierGroups: [], reviewSuppliers: [], issues: [],
    updatedAt: '2026-11-17T00:00:00.000Z' };
}
async function workbook(data, scope) {
  const result = await scopedDashboardExport(data, dashboardExportScope(scope));
  const book = new ExcelJS.Workbook(); await book.xlsx.load(result.buffer); return book;
}
function rows(sheet) {
  const headers = sheet.getRow(1).values.slice(1);
  return sheet.getRows(2, sheet.rowCount - 1)?.map(row => Object.fromEntries(headers.map((header, i) => [header, row.getCell(i + 1).value]))) || [];
}
const selection = { exportView: 'drilldown', table: 'monthly', rowId: 'negotiated_group', detailMonth: 'period', measure: 'unappliedUnpaidCents' };

test('金额下钻逐计划筛选：跨月不同申请状态、零和未知值与页面一致，保留精确元及依据', async () => {
  const first = plan('2026-11', 10001), applied = plan('2026-12', 30002, 'applied');
  first.applicationEvidence = [{ sourceCell: 'AK2', amountCents: 10001, applicationState: 'unapplied', comment: '申请日期：未填写' }];
  first.paymentEvidence = [{ sourceCell: 'AK2', amountCents: 10001, comment: '无付款时间' }];
  const mixed = record('2', '跨月供应商', [first, applied]);
  mixed.comments = { AK2: '原始批注 2026-11-01T00:00:00.000Z' };
  mixed.raw['申请日期'] = '2026-11-01T00:00:00.000Z';
  const zero = record('3', '零金额', [plan('2026-11', 0)]);
  const unknownPlan = { ...plan('2026-11', 500), paidCents: null, unpaidCents: null, unappliedUnpaidCents: null, applicationState: 'review' };
  const unknown = record('4', '未知金额', [unknownPlan]);
  const data = dataFor([mixed, zero, unknown]);
  const selected = detailRecords(data.records, { categories: ['negotiated'], month: 'period', measure: selection.measure });
  assert.deepEqual(selected.map(item => [item.key, item.selectedPlans.length]), [['2', 1], ['3', 1], ['4', 1]]);
  const book = await workbook(data, selection);
  const detailRows = rows(book.getWorksheet('付款金额明细'));
  assert.equal(detailRows.length, 4);
  assert.deepEqual(detailRows.slice(0, 3).map(row => row['月份']), ['2026-11', '2026-11', '2026-11']);
  assert.equal(detailRows[0]['总金额（元）'], 100.01);
  assert.equal(detailRows[0]['谈判明细'], '两批，按期申请');
  assert.equal(detailRows[0]['贾总备注'], '保留贾总备注');
  assert.equal(detailRows[1]['未提交申请单金额（元）'], 0);
  assert.equal(detailRows[2]['未提交申请单金额（元）'], '待核对');
  assert.equal(detailRows[3]['总金额（元）'], 105.01);
  assert.equal(detailRows[3]['未提交申请单金额（元）'], '待核对');
  assert.equal(rows(book.getWorksheet('申请依据'))[0]['依据金额（元）'], 100.01);
  assert.equal(rows(book.getWorksheet('付款依据'))[0]['判定'], first.paymentBasis);
  assert.equal(rows(book.getWorksheet('原始字段')).find(row => row['字段或单元格'] === '申请日期')['原文'], '2026-11-01');
  assert.equal(rows(book.getWorksheet('单元格批注'))[0]['原文'], '原始批注 2026-11-01');

  const periodBook = await workbook(data, { ...selection, measure: 'totalCents' });
  assert.equal(rows(periodBook.getWorksheet('付款金额明细')).filter(row => row['供应商'] === '跨月供应商').length, 2);
  const oneBook = await workbook(data, { ...selection, detailMonth: '2026-11', recordKey: '2' });
  assert.equal(rows(oneBook.getWorksheet('付款金额明细')).length, 2);
});

test('空供应商按精确空值收窄，待核对单供应商排除他人和无记录事项，总页保留全部事项', async () => {
  const blank = record('2', '', [plan('2026-11', 100)]), other = record('3', '其他供应商', [plan('2026-11', 200)]);
  const issues = [{ recordKey: '2', title: '空名核对', message: '待核对', action: '补名称' },
    { recordKey: '3', title: '其他核对', message: '待核对', action: '确认' }, { title: '缺少文件', code: 'MISSING_FILE', message: '尚未上传' }];
  const group = (item, issue) => ({ supplier: item.supplier, records: [{ ...item, reviewIssues: [issue], reviewRemainingCents: item.amountCents }],
    totalCents: item.amountCents, reviewIssues: [issue], categories: ['negotiated'], months: ['2026-11'], amountCents: item.selectedPlanCents, paidCents: 0, unpaidCents: item.selectedPlanCents });
  const data = { ...dataFor([blank, other]), issues, reviewSuppliers: [group(blank, issues[0]), group(other, issues[1])],
    supplierGroups: [group(blank, issues[0]), group(other, issues[1])] };
  const review = await workbook(data, { exportView: 'review', detailSupplier: '' });
  assert.equal(rows(review.getWorksheet('待核对明细')).length, 1);
  assert.deepEqual(rows(review.getWorksheet('待核对事项')).map(row => row['核对事项']), ['空名核对']);
  const all = await workbook(data, { exportView: 'review' });
  assert.equal(rows(all.getWorksheet('待核对事项')).length, 3);
  const suppliers = await workbook(data, { exportView: 'suppliers', detailSupplier: '' });
  assert.equal(rows(suppliers.getWorksheet('供应商付款明细')).length, 1);
});

test('普通提示独立下载，待核对导出不混入补零和明确未付款信息', async () => {
  const data = dataFor([]);
  data.issues = [{ code: 'ZERO_DEFAULTED', title: '空金额按0处理', message: '按0保存', sourceRow: 2 },
    { code: 'PAYMENT_PROGRESS_REVIEW', title: '未付款', message: '“付款进度整理”的“是否已付款”为“未付款”，计未付。', sourceRow: 3 },
    { code: 'BALANCE_MISMATCH', title: '余额不一致', message: '金额需核对', sourceRow: 4 }];
  const notices = await workbook(data, { exportView: 'notices' });
  assert.deepEqual(rows(notices.getWorksheet('普通提示')).map(row => row['原始行']), [2, 3]);
  const review = await workbook(data, { exportView: 'issues' });
  assert.deepEqual(rows(review.getWorksheet('待核对事项')).map(row => row['原始行']), [4]);
  assert.throws(() => dashboardExportScope({ exportView: 'notices', detailSupplier: '供应商' }), /下载范围无效/);
});

test('空数据仍可下载有效空表；无效范围不会扩大到全部数据', async () => {
  const data = dataFor([]);
  for (const exportView of ['monthly', 'pending', 'suppliers', 'pending-suppliers', 'payments', 'review', 'issues', 'notices']) {
    const book = await workbook(data, { exportView });
    assert.ok(book.worksheets.length > 1);
    assert.ok(book.getWorksheet('下载说明'));
  }
  for (const updatedAt of [null, undefined, '', 'invalid']) {
    const book = await workbook({ ...data, updatedAt }, { exportView: 'payments' });
    assert.equal(rows(book.getWorksheet('下载说明')).find(row => row['项目'] === '数据截至')['内容'], '—');
  }
  assert.throws(() => dashboardExportScope({ exportView: 'drilldown', ...selection, table: 'pending' }), /下载范围无效/);
  assert.throws(() => dashboardExportScope({ exportView: 'monthly', recordKey: '2' }), /下载范围无效/);
  await assert.rejects(() => workbook(data, { ...selection, detailMonth: '2027-01' }), /下载范围无效/);
  await assert.rejects(() => workbook(data, { ...selection, recordKey: 'not-in-scope' }), /不在当前下载范围/);
});
