import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboard } from '../server/dashboard.js';
import { paymentPlanTotals } from '../server/payment-table.js';
import { SLOTS } from '../shared/constants.js';

const slots = SLOTS.map(slot => ({ ...slot, currentVersionId: slot.id }));
const plan = (month, amountCents, paidCents = 0) => ({ month, amountCents, paidCents, unpaidCents: paidCents === null ? null : amountCents - paidCents });
const record = (category, plans) => ({ key: category, category, slotId: ['normal', 'normal_unreconciled', 'negotiated', 'negotiated_normal'].includes(category) ? 'schedule' : category,
  supplier: category, payer: '合成主体', owner: '合成跟单员', sourceSheet: '合成表', sourceRow: 2, flowCode: '',
  paidCents: 0, remainingCents: 0, amountCents: plans.reduce((s, p) => s + p.amountCents, 0), plans });
const rowOf = (data, id) => data.paymentTable.rows.find(row => row.id === id);

test('父子表仅汇总叶子，正常付款与预估平级，期间排除时间待定', () => {
  const data = buildDashboard([
    record('negotiated', [plan('2026-11', 1000, 400), plan('2026-12', 200)]),
    record('negotiated_normal', [plan('2026-11', 300, 300)]),
    record('normal', [plan('2026-11', 500, 500), plan(null, 90)]),
    record('shipment', [plan('2026-11', 70)]), record('after_sales', [plan('2026-11', 20)]),
    record('unregistered', [plan('2026-11', 10)]),
  ], [], slots);
  assert.equal(data.paymentTable.rows.length, 11);
  assert.deepEqual(data.paymentTable.months, ['2026-11', '2026-12']);
  assert.deepEqual(data.pendingPaymentTable.months, ['pending']);
  assert.deepEqual(rowOf(data, 'forecast_group').cells['2026-11'], { paidCents: 0, unpaidCents: 100, totalCents: 100, uncertainCount: 0 });
  assert.deepEqual(rowOf(data, 'normal_group').cells['2026-11'], { paidCents: 800, unpaidCents: 0, totalCents: 800, uncertainCount: 0 });
  assert.deepEqual(rowOf(data, 'total').cells['2026-11'], { paidCents: 1200, unpaidCents: 700, totalCents: 1900, uncertainCount: 0 });
  assert.deepEqual(rowOf(data, 'total').period, { paidCents: 1200, unpaidCents: 900, totalCents: 2100, uncertainCount: 0 });
  assert.equal(rowOf(data, 'total').cells.pending, undefined);
  assert.equal(data.pendingPaymentTable.rows.find(row => row.id === 'total').cells.pending.totalCents, 90);
  assert.equal(rowOf(data, 'shipment').parentId, 'forecast_group');
  assert.equal(rowOf(data, 'forecast_group').parentId, null);
});

test('月份与类别筛选同步影响父子表、期间值和明细，无效零与缺文件区分', () => {
  const records = [record('negotiated', [plan('2026-11', 1000, 500)]), record('shipment', [plan('2026-11', 0), plan('2026-12', 700)])];
  const data = buildDashboard(records, [], slots.filter(slot => slot.id === 'shipment'), { category: 'shipment', from: '2026-11', to: '2026-11' });
  assert.equal(rowOf(data, 'total').period.totalCents, 0);
  assert.equal(rowOf(data, 'shipment').available, true);
  assert.equal(rowOf(data, 'negotiated_group').available, false);
  assert.equal(rowOf(data, 'normal_group').available, false);
  assert.deepEqual(rowOf(data, 'forecast_group').missingSources, ['售后配件预估', '已发货未登记台账预估']);
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
      { paidCents: 20, unpaidCents: 30, totalCents: 50, uncertainCount: 0 });
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
  assert.deepEqual(rowOf(data, 'total').cells['2026-11'], { paidCents: null, unpaidCents: null, totalCents: 100, uncertainCount: 1 });
  assert.equal(rowOf(data, 'total').cells['2026-12'].paidCents, -50);
  assert.equal(rowOf(data, 'total').period.totalCents, 50);
  assert.equal(rowOf(data, 'total').period.paidCents, null);
  assert.equal(rowOf(data, 'normal_group').period.paidCents, 0);
  assert.throws(() => paymentPlanTotals([plan('2026-11', Number.MAX_SAFE_INTEGER), plan('2026-11', 1)]), /安全计算/);
  assert.throws(() => paymentPlanTotals([{ amountCents: 10, paidCents: 5, unpaidCents: 6 }]), /不一致/);
});


test('正常付款只有三个子类，预估为平级父类，月度和待定结构一致且总金额只加一次', () => {
  const categories = ['negotiated', 'negotiated_normal', 'normal', 'normal_unreconciled', 'shipment', 'after_sales', 'unregistered'];
  const data = buildDashboard(categories.map((category, i) => record(category, [plan('2027-01', (i + 1) * 100, 0), plan(null, i + 1)])), [], slots);
  for (const table of [data.paymentTable, data.pendingPaymentTable]) {
    assert.deepEqual(table.rows.filter(row => row.parentId === 'normal_group').map(row => row.label),
      ['谈判表-正常付款', '正常付款-已对账', '正常付款-未完成对账']);
    assert.deepEqual(table.rows.filter(row => !row.parentId).map(row => row.label), ['谈判付款', '正常付款', '预估合计', '总合计']);
    const month = table === data.paymentTable ? '2027-01' : 'pending';
    const factor = table === data.paymentTable ? 100 : 1;
    for (const [id, expected] of [['normal_group', 9], ['forecast_group', 18], ['total', 28]]) {
      assert.equal(table.rows.find(row => row.id === id).cells[month].totalCents, expected * factor);
    }
  }
});
