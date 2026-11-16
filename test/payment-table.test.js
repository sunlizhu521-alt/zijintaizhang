import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { buildDashboard } from '../server/dashboard.js';
import { dashboardExport } from '../server/exports.js';
import { paymentPlanTotals, paymentTableTotals } from '../server/payment-table.js';
import { SLOTS } from '../shared/constants.js';

const slots = SLOTS.map(slot => ({ ...slot, currentVersionId: slot.id }));
const plan = (month, amountCents, paidCents = 0) => ({ month, amountCents, paidCents, unpaidCents: paidCents === null ? null : amountCents - paidCents });
const record = (category, plans) => ({ key: category, category, slotId: ['normal', 'normal_unreconciled', 'negotiated', 'negotiated_normal'].includes(category) ? 'schedule' : category,
  supplier: category, payer: '合成主体', owner: '合成跟单员', sourceSheet: '合成表', sourceRow: 2, flowCode: '',
  paidCents: 0, remainingCents: 0, amountCents: plans.reduce((s, p) => s + p.amountCents, 0), plans });
const rowOf = (data, id) => data.paymentTable.rows.find(row => row.id === id);

test('父子表仅汇总叶子，正常付款包含预估，期间排除时间待定', () => {
  const data = buildDashboard([
    record('negotiated', [plan('2026-11', 1000, 400), plan('2026-12', 200)]),
    record('negotiated_normal', [plan('2026-11', 300, 300)]),
    record('normal', [plan('2026-11', 500, 500), plan(null, 90)]),
    record('shipment', [plan('2026-11', 70)]), record('after_sales', [plan('2026-11', 20)]),
    record('unregistered', [plan('2026-11', 10)]),
  ], [], slots);
  assert.equal(data.paymentTable.rows.length, 10);
  assert.deepEqual(data.paymentTable.months, ['2026-11', '2026-12']);
  assert.deepEqual(data.pendingPaymentTable.months, ['pending']);
  assert.equal(rowOf(data, 'forecast_group'), undefined);
  assert.deepEqual(rowOf(data, 'normal_group').cells['2026-11'], { paidCents: 800, unpaidCents: 100, totalCents: 900, uncertainCount: 0, unappliedUnpaidCents: 100 });
  assert.deepEqual(rowOf(data, 'total').cells['2026-11'], { paidCents: 1200, unpaidCents: 700, totalCents: 1900, uncertainCount: 0, unappliedUnpaidCents: 700 });
  assert.deepEqual(rowOf(data, 'total').period, { paidCents: 1200, unpaidCents: 900, totalCents: 2100, uncertainCount: 0, unappliedUnpaidCents: 900 });
  assert.equal(rowOf(data, 'total').cells.pending, undefined);
  assert.equal(data.pendingPaymentTable.rows.find(row => row.id === 'total').cells.pending.totalCents, 90);
  assert.equal(rowOf(data, 'shipment').parentId, 'normal_group');
});

test('月份与类别筛选同步影响父子表、期间值和明细，无效零与缺文件区分', () => {
  const records = [record('negotiated', [plan('2026-11', 1000, 500)]), record('shipment', [plan('2026-11', 0), plan('2026-12', 700)])];
  const data = buildDashboard(records, [], slots.filter(slot => slot.id === 'shipment'), { category: 'shipment', from: '2026-11', to: '2026-11' });
  assert.equal(rowOf(data, 'total').period.totalCents, 0);
  assert.equal(rowOf(data, 'shipment').available, true);
  assert.equal(rowOf(data, 'negotiated_group').available, false);
  assert.equal(rowOf(data, 'normal_group').available, true);
  assert.deepEqual(rowOf(data, 'normal_group').missingSources, ['付款节奏', '售后配件预估', '已发货未登记台账预估']);
  assert.equal(data.records[0].selectedPaidCents, 0);
  assert.equal(data.records[0].selectedUnpaidCents, 0);
  assert.equal(data.records.length, 1);
  const pending = buildDashboard([record('normal', [plan(null, 20, 20), plan('2026-11', 30)])], [], slots, { month: 'pending' });
  assert.equal(rowOf(pending, 'total').period.totalCents, 0);
  assert.deepEqual(pending.paymentTable.months, []);
  assert.equal(pending.pendingPaymentTable.rows.find(row => row.id === 'total').cells.pending.paidCents, 20);
});

test('待定表独立于月份范围，跨年、自选月份、类别和其他筛选均保持对应范围', () => {
  const records = [record('normal', [plan(null, 50, 20), plan('2026-12', 100), plan('2027-01', 200, 200)]),
    record('shipment', [plan(null, 0), plan('2026-11', 70)])];
  for (const filters of [{ from: '2027-01', to: '2027-01' }, { month: '2027-01' }]) {
    const data = buildDashboard(records, [], slots, filters);
    assert.deepEqual(data.paymentTable.months, ['2027-01']);
    assert.equal(rowOf(data, 'total').period.totalCents, 200);
    assert.deepEqual(data.pendingPaymentTable.rows.find(row => row.id === 'total').cells.pending,
      { paidCents: 20, unpaidCents: 30, totalCents: 50, uncertainCount: 0, unappliedUnpaidCents: 30 });
  }
  const pendingZero = buildDashboard(records, [], slots, { category: 'shipment', from: '2028-01' });
  assert.equal(pendingZero.paymentTable.hasRecords, false);
  assert.equal(pendingZero.pendingPaymentTable.hasRecords, true);
  assert.equal(pendingZero.pendingPaymentTable.rows.find(row => row.id === 'total').cells.pending.totalCents, 0);
  for (const filters of [{ supplier: '无匹配' }, { payer: '无匹配' }, { owner: '无匹配' }]) {
    const empty = buildDashboard(records, [], slots, filters);
    assert.equal(empty.paymentTable.hasRecords, false);
    assert.equal(empty.pendingPaymentTable.hasRecords, false);
  }
  assert.equal(buildDashboard([record('normal', [plan('2026-12', 0)])], [], slots).pendingPaymentTable.hasRecords, false);
});

test('不明确的月内已付只影响相关月份和父项，不把未知当零；负金额与安全边界保留', () => {
  const data = buildDashboard([record('negotiated', [plan('2026-11', 100, null), plan('2026-12', -50, -50)])], [], slots);
  assert.deepEqual(rowOf(data, 'total').cells['2026-11'], { paidCents: null, unpaidCents: null, totalCents: 100, uncertainCount: 1, unappliedUnpaidCents: null });
  assert.equal(rowOf(data, 'total').cells['2026-12'].paidCents, -50);
  assert.equal(rowOf(data, 'total').period.totalCents, 50);
  assert.equal(rowOf(data, 'total').period.paidCents, null);
  assert.equal(rowOf(data, 'normal_group').period.paidCents, 0);
  assert.throws(() => paymentPlanTotals([plan('2026-11', Number.MAX_SAFE_INTEGER), plan('2026-11', 1)]), /安全计算/);
  assert.throws(() => paymentPlanTotals([{ amountCents: 10, paidCents: 5, unpaidCents: 6 }]), /不一致/);
});

test('未提交申请单金额按每期未申请且未付汇总，父子、期间、待定及明细一致', () => {
  const records = [
    { ...record('negotiated', [plan('2026-11', 1000, 400), plan('2026-12', 200), plan(null, 70, 20)]), applicationStatus: '未提交' },
    { ...record('normal', [plan('2026-11', 300)]), key: 'submitted', applicationStatus: '已提交' },
    { ...record('normal', [plan('2026-11', 500, 50)]), key: 'oa', applicationStatus: '未申请', flowCode: 'MDST-DGFK20261101001' },
    record('shipment', [plan('2026-11', 70, 20), plan('2027-01', -20), plan(null, 0)]),
    record('normal_unreconciled', [plan('2026-11', 90, 90), plan('2026-12', 0)]),
  ];
  const data = buildDashboard(records, [], slots);
  const total = rowOf(data, 'total');
  assert.deepEqual(data.paymentTable.months.map(month => total.cells[month].unappliedUnpaidCents), [650, 200, -20]);
  assert.equal(rowOf(data, 'negotiated_group').period.unappliedUnpaidCents, 800);
  assert.equal(rowOf(data, 'normal_group').period.unappliedUnpaidCents, 30);
  assert.equal(total.period.unappliedUnpaidCents, 830);
  assert.equal(data.summary.unappliedUnpaidCents, 830);
  assert.equal(data.records.reduce((sum, row) => sum + row.selectedUnappliedUnpaidCents, 0), 830);
  for (const month of data.paymentTable.months) {
    const plans = data.records.flatMap(row => row.selectedPlans).filter(p => p.month === month);
    assert.equal(paymentTableTotals(plans).unappliedUnpaidCents, total.cells[month].unappliedUnpaidCents);
    const childSum = data.paymentTable.rows.filter(row => row.parentId).reduce((sum, row) => sum + row.cells[month].unappliedUnpaidCents, 0);
    assert.equal(childSum, total.cells[month].unappliedUnpaidCents);
  }
  assert.equal(data.pendingPaymentTable.rows.find(row => row.id === 'total').cells.pending.unappliedUnpaidCents, 50);
  assert.equal(data.records.find(row => row.key === 'oa').selectedPlans[0].unappliedUnpaidCents, 0);
  assert.equal(data.records.find(row => row.key === 'submitted').selectedPlans[0].unappliedUnpaidCents, 0);
  assert.ok(records.every(row => row.plans.every(p => !Object.hasOwn(p, 'unappliedUnpaidCents'))), '只装饰查询结果，不改原始计划');
  const january = buildDashboard(records, [], slots, { from: '2027-01', to: '2027-01' });
  assert.equal(rowOf(january, 'total').period.unappliedUnpaidCents, -20);
  const supplier = buildDashboard(records, [], slots, { supplier: 'shipment' });
  assert.equal(rowOf(supplier, 'total').period.unappliedUnpaidCents, 30);
  const pending = buildDashboard(records, [], slots, { month: 'pending' });
  assert.equal(pending.summary.unappliedUnpaidCents, 50);
  assert.equal(rowOf(pending, 'total').period.unappliedUnpaidCents, 0);
  assert.equal(paymentTableTotals([]).unappliedUnpaidCents, 0);
});

test('部分申请或未付未知按月保留待核对，已付清和真实零值不误报，跨月冲减不消除未知', () => {
  const partial = { ...record('negotiated', [plan('2026-11', 100), plan('2026-12', -100), plan('2027-01', 20, 20), plan(null, 0)]), applicationStatus: '部分提交' };
  const data = buildDashboard([partial], [], slots);
  const total = rowOf(data, 'total');
  assert.deepEqual(data.records[0].selectedPlans.map(p => p.unappliedUnpaidCents), [null, null, 0]);
  assert.equal(total.cells['2026-11'].unappliedUnpaidCents, null);
  assert.equal(total.cells['2026-12'].unappliedUnpaidCents, null);
  assert.equal(total.cells['2027-01'].unappliedUnpaidCents, 0);
  assert.equal(total.period.unappliedUnpaidCents, null);
  assert.equal(data.summary.unappliedUnpaidCents, null);
  assert.equal(data.summary.appliedUnpaidCents, null);
  assert.equal(data.summary.applicationReviewCount, 1);
  assert.equal(data.records[0].selectedUnappliedUnpaidCents, null);
  assert.equal(data.records[0].selectedAppliedUnpaidCents, null);
  assert.ok(data.issues.some(issue => issue.code === 'APPLICATION_PARTIAL_REVIEW'));
  assert.equal(data.pendingPaymentTable.rows.find(row => row.id === 'total').cells.pending.unappliedUnpaidCents, 0);
  const unknown = record('normal', [plan('2026-11', 100, null)]);
  assert.equal(rowOf(buildDashboard([unknown], [], slots), 'total').period.unappliedUnpaidCents, null);
  assert.equal(rowOf(buildDashboard([{ ...unknown, applicationStatus: '已提交' }], [], slots), 'total').period.unappliedUnpaidCents, 0);
  assert.throws(() => paymentTableTotals([{ ...plan('2026-11', 0), unappliedUnpaidCents: Number.MAX_SAFE_INTEGER },
    { ...plan('2026-11', 0), unappliedUnpaidCents: 1 }]), /安全计算/);
});


test('正常付款包含其余六个子类，月度和待定结构一致且总金额只加一次', () => {
  const categories = ['negotiated', 'negotiated_normal', 'normal', 'normal_unreconciled', 'shipment', 'after_sales', 'unregistered'];
  const data = buildDashboard(categories.map((category, i) => record(category, [plan('2027-01', (i + 1) * 100, 0), plan(null, i + 1)])), [], slots);
  for (const table of [data.paymentTable, data.pendingPaymentTable]) {
    assert.deepEqual(table.rows.filter(row => row.parentId === 'normal_group').map(row => row.label),
      ['谈判表-正常付款', '正常付款-已对账', '正常付款-未完成对账', '发货计划预估', '售后配件预估', '已发货未登记台账预估']);
    assert.deepEqual(table.rows.filter(row => !row.parentId).map(row => row.label), ['谈判付款', '正常付款', '总合计']);
    const month = table === data.paymentTable ? '2027-01' : 'pending';
    const factor = table === data.paymentTable ? 100 : 1;
    for (const [id, expected] of [['normal_group', 27], ['total', 28]]) {
      assert.equal(table.rows.find(row => row.id === id).cells[month].totalCents, expected * factor);
    }
  }
});

test('导出的月度及待定汇总保留未提交申请单金额、真实零与待核对，金额以元输出', async () => {
  const data = buildDashboard([
    { ...record('negotiated', [plan('2026-11', 100), plan('2026-12', 100, 100), plan(null, 20)]), applicationStatus: '部分提交' },
    record('normal', [plan('2026-11', 5099, 1000), plan('2026-12', 0), plan(null, 50, 20)]),
  ], [], slots);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await dashboardExport(data));
  const value = (sheetName, label, header) => {
    const sheet = book.getWorksheet(sheetName);
    const column = sheet.getRow(1).values.indexOf(header);
    const row = sheet.getRows(2, sheet.rowCount - 1).find(r => r.getCell(1).value === label);
    assert.ok(column > 0 && row, `${sheetName} ${label} ${header}`);
    return row.getCell(column).value;
  };
  assert.equal(value('月度付款汇总', '总合计', '2026-11未提交申请单金额（元）'), '待核对');
  assert.equal(value('月度付款汇总', '正常付款', '2026-11未提交申请单金额（元）'), 40.99);
  assert.equal(value('月度付款汇总', '总合计', '2026-12未提交申请单金额（元）'), 0);
  assert.equal(value('月度付款汇总', '总合计', '所选期间未提交申请单金额（元）'), '待核对');
  assert.equal(value('时间待定付款汇总', '总合计', '时间待定未提交申请单金额（元）'), '待核对');
  assert.equal(value('时间待定付款汇总', '正常付款', '时间待定未提交申请单金额（元）'), 0.3);
});
