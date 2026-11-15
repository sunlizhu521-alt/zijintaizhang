import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboard } from '../server/dashboard.js';
import { paymentPlanTotals } from '../server/payment-table.js';
import { SLOTS } from '../shared/constants.js';

const slots = SLOTS.map(slot => ({ ...slot, currentVersionId: slot.id }));
const plan = (month, amountCents, paidCents = 0) => ({ month, amountCents, paidCents, unpaidCents: paidCents === null ? null : amountCents - paidCents });
const record = (category, plans) => ({ key: category, category, slotId: ['normal', 'negotiated', 'negotiated_normal'].includes(category) ? 'schedule' : category,
  supplier: category, payer: '合成主体', owner: '合成跟单员', sourceSheet: '合成表', sourceRow: 2, flowCode: '',
  paidCents: 0, remainingCents: 0, amountCents: plans.reduce((s, p) => s + p.amountCents, 0), plans });
const rowOf = (data, id) => data.paymentTable.rows.find(row => row.id === id);

test('父子表仅汇总叶子，正常付款包含两类台账与三类预估，期间排除时间待定', () => {
  const data = buildDashboard([
    record('negotiated', [plan('2026-11', 1000, 400), plan('2026-12', 200)]),
    record('negotiated_normal', [plan('2026-11', 300, 300)]),
    record('normal', [plan('2026-11', 500, 500), plan(null, 90)]),
    record('shipment', [plan('2026-11', 70)]), record('after_sales', [plan('2026-11', 20)]),
    record('unregistered', [plan('2026-11', 10)]),
  ], [], slots);
  assert.equal(data.paymentTable.rows.length, 10);
  assert.deepEqual(data.paymentTable.months, ['2026-11', '2026-12', 'pending']);
  assert.deepEqual(rowOf(data, 'forecast_group').cells['2026-11'], { paidCents: 0, unpaidCents: 100, totalCents: 100, uncertainCount: 0 });
  assert.deepEqual(rowOf(data, 'normal_group').cells['2026-11'], { paidCents: 800, unpaidCents: 100, totalCents: 900, uncertainCount: 0 });
  assert.deepEqual(rowOf(data, 'total').cells['2026-11'], { paidCents: 1200, unpaidCents: 700, totalCents: 1900, uncertainCount: 0 });
  assert.deepEqual(rowOf(data, 'total').period, { paidCents: 1200, unpaidCents: 900, totalCents: 2100, uncertainCount: 0 });
  assert.equal(rowOf(data, 'total').cells.pending.totalCents, 90);
  assert.equal(rowOf(data, 'shipment').parentId, 'forecast_group');
  assert.equal(rowOf(data, 'forecast_group').parentId, 'normal_group');
});

test('月份与类别筛选同步影响父子表、期间值和明细，无效零与缺文件区分', () => {
  const records = [record('negotiated', [plan('2026-11', 1000, 500)]), record('shipment', [plan('2026-11', 0), plan('2026-12', 700)])];
  const data = buildDashboard(records, [], slots.filter(slot => slot.id === 'shipment'), { category: 'shipment', from: '2026-11', to: '2026-11' });
  assert.equal(rowOf(data, 'total').period.totalCents, 0);
  assert.equal(rowOf(data, 'shipment').available, true);
  assert.equal(rowOf(data, 'negotiated_group').available, false);
  assert.equal(rowOf(data, 'normal_group').available, true);
  assert.deepEqual(rowOf(data, 'forecast_group').missingSources, ['售后配件预估', '已发货未登记台账预估']);
  assert.equal(data.records[0].selectedPaidCents, 0);
  assert.equal(data.records[0].selectedUnpaidCents, 0);
  assert.equal(data.records.length, 1);
  const pending = buildDashboard([record('normal', [plan(null, 20, 20), plan('2026-11', 30)])], [], slots, { month: 'pending' });
  assert.equal(rowOf(pending, 'total').period.totalCents, 0);
  assert.equal(rowOf(pending, 'total').cells.pending.paidCents, 20);
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
