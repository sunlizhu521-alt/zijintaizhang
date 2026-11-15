import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboard, findDuplicateIssues } from '../server/dashboard.js';

function record(key, category, plans, extra = {}) {
  return { key, slotId: ['normal', 'normal_unreconciled', 'negotiated', 'negotiated_normal'].includes(category) ? 'schedule' : category,
    sourceSheet: '样表', sourceRow: Number(key.replace(/\D/g, '')) || 2,
    category, supplier: '供应商甲', payer: '主体甲', owner: '跟单甲', amountCents: plans.reduce((sum, item) => sum + item.amountCents, 0),
    paidCents: null, remainingCents: null, flowCode: '', plans, ...extra };
}
const plan = (month, amountCents) => ({ month, amountCents });

test('月份只筛计划，不重复分摊累计已付剩余；三种预估保持独立', () => {
  const records = [
    record('r1', 'negotiated', [plan('2026-11', 100), plan('2026-12', 200)], { paidCents: 80, remainingCents: 220 }),
    record('r2', 'normal', [plan('2026-10', 1000)], { paidCents: 100, remainingCents: 900 }),
    record('r3', 'shipment', [plan('2026-11', 40)]),
    record('r4', 'after_sales', [plan('2026-11', 50)]),
    record('r5', 'unregistered', [plan('2026-11', 60)]),
  ];
  const result = buildDashboard(records, [], [], { from: '2026-11', to: '2026-11' });
  assert.equal(result.summary.planCents, 100);
  assert.equal(result.summary.paidCents, 180);
  assert.equal(result.summary.remainingCents, 1120);
  assert.deepEqual(result.summary.forecastCents, { shipment: 40, after_sales: 50, unregistered: 60 });
  assert.equal(result.records.find(item => item.key === 'r1').selectedPlanCents, 100);
  assert.ok(!result.records.some(item => item.key === 'r2'));
  assert.equal(result.months[0].negotiated, 100);
});

test('谈判表正常付款独立筛选并计入三类付款总额，不混入预估', () => {
  const records = [
    record('r1', 'negotiated', [plan('2026-11', 100)], { paidCents: 10, remainingCents: 90 }),
    record('r2', 'negotiated_normal', [plan('2026-11', 200), plan(null, 50)], { paidCents: 20, remainingCents: 230 }),
    record('r3', 'normal', [plan('2026-11', 300)], { paidCents: 30, remainingCents: 270 }),
    record('r4', 'shipment', [plan('2026-11', 400)]),
  ];
  const result = buildDashboard(records);
  assert.equal(result.summary.planCents, 600);
  assert.equal(result.summary.pendingPlanCents, 50);
  assert.equal(result.summary.paidCents, 60);
  assert.equal(result.summary.remainingCents, 590);
  assert.equal(result.summary.ledgerRecordCount, 3);
  assert.deepEqual(result.summary.forecastCents, { shipment: 400, after_sales: 0, unregistered: 0 });
  assert.equal(result.months[0].negotiated_normal, 200);
  assert.equal(result.months.at(-1).negotiated_normal, 50);
  for (const [category, cents] of [['negotiated', 100], ['negotiated_normal', 200], ['normal', 300]]) {
    const filtered = buildDashboard(records, [], [], { category, month: '2026-11' });
    assert.equal(filtered.records.length, 1);
    assert.equal(filtered.records[0].category, category);
    assert.equal(filtered.summary.planCents, cents);
    assert.equal(filtered.summary.ledgerRecordCount, 1);
  }
});

test('未明确月份单列且不冒充当期计划，空与零的计数不同', () => {
  const records = [record('r1', 'normal', [plan(null, 500)], { paidCents: 0, remainingCents: 500 }),
    record('r2', 'normal', [plan('2027-01', 100)]), record('r3', 'shipment', [plan(null, 90)])];
  const result = buildDashboard(records, [], [], { from: '2026-11', to: '2026-12' });
  assert.equal(result.summary.planCents, 0);
  assert.equal(result.summary.pendingPlanCents, 500);
  assert.equal(result.summary.pendingForecastCents.shipment, 90);
  assert.equal(result.summary.missingPaidCount, 1);
  assert.equal(result.summary.missingRemainingCount, 1);
  assert.equal(result.months.at(-1).month, 'pending');
  assert.equal(buildDashboard(records, [], [], { month: 'pending' }).records.length, 2);
});

test('未完成对账属于付款台账且可独立筛选，不进入三个预估槽位金额', () => {
  const records = [record('r1', 'normal', [plan('2026-11', 200)]),
    record('r2', 'normal_unreconciled', [plan('2026-11', 300), plan(null, 50)], { paidCents: 100, remainingCents: 250 }),
    record('r3', 'shipment', [plan('2026-11', 90)])];
  const data = buildDashboard(records, [], [], { category: 'normal_unreconciled', month: '2026-11' });
  assert.equal(data.records.length, 1);
  assert.equal(data.summary.planCents, 300);
  assert.equal(data.summary.pendingPlanCents, 50);
  assert.equal(data.summary.ledgerRecordCount, 1);
  assert.equal(data.summary.paidCents, 100);
  assert.deepEqual(data.summary.forecastCents, { shipment: 0, after_sales: 0, unregistered: 0 });
  assert.equal(data.months[0].normal_unreconciled, 300);
  assert.equal(data.months.at(-1).normal_unreconciled, 50);
});

test('供应商等条件影响计划和累计，空结果不会丢失筛选选项', () => {
  const records = [record('r1', 'normal', [plan('2026-11', 100)], { paidCents: 20, remainingCents: 80 }),
    record('r2', 'normal', [plan('2026-11', 200)], { supplier: '供应商乙', paidCents: 50, remainingCents: 150 })];
  const result = buildDashboard(records, [], [], { supplier: '供应商乙' });
  assert.equal(result.summary.planCents, 200);
  assert.equal(result.summary.paidCents, 50);
  assert.deepEqual(result.options.suppliers, ['供应商甲', '供应商乙']);
  assert.equal(buildDashboard(records, [], [], { supplier: '无匹配' }).records.length, 0);
});

test('疑似重复仅提示，不删除；同一分期记录跨月不误判成两条', () => {
  const a = record('a1', 'negotiated', [plan('2026-11', 100), plan('2026-12', 100)], { flowCode: 'MDST-DGFK20261101001' });
  assert.deepEqual(findDuplicateIssues([a]), []);
  const b = record('b2', 'shipment', [plan('2027-01', 100)], { flowCode: 'MDST-DGFK20261101001' });
  const issues = findDuplicateIssues([a, b]);
  assert.equal(issues.filter(issue => issue.code === 'DUPLICATE_FLOW').length, 2);
  assert.equal(issues.filter(issue => issue.code === 'POSSIBLE_DUPLICATE').length, 2);
  const result = buildDashboard([a, b], issues);
  assert.equal(result.records.length, 2);
  assert.equal(result.issues.length, 4);
});

test('缺文件提示与有效零金额不同，过大求和和非法筛选被拒绝', () => {
  const result = buildDashboard([], [], [{ id: 'shipment', label: '发货计划预估', currentVersionId: null }]);
  assert.equal(result.summary.missingSourceCount, 1);
  assert.equal(result.issues[0].code, 'MISSING_FILE');
  for (const filters of [{ from: 'bad' }, { month: '2026-13' }, { from: '2027-01', to: '2026-01' }, { supplier: {} }, { category: 'unknown' }]) {
    assert.throws(() => buildDashboard([], [], [], filters), error => error.status === 400);
  }
  const records = [record('a1', 'normal', [plan('2026-11', Number.MAX_SAFE_INTEGER)]), record('b2', 'normal', [plan('2026-11', 1)])];
  assert.throws(() => buildDashboard(records), /安全计算范围/);
});
