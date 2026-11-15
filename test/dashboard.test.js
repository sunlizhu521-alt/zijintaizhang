import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboard, findDuplicateIssues } from '../server/dashboard.js';

function record(key, category, plans, extra = {}) {
  return { key, slotId: ['normal', 'normal_unreconciled', 'negotiated', 'negotiated_normal'].includes(category) ? 'schedule' : category,
    sourceSheet: '样表', sourceRow: Number(key.replace(/\D/g, '')) || 2,
    category, supplier: '供应商甲', payer: '主体甲', owner: '跟单甲', amountCents: plans.reduce((sum, item) => sum + item.amountCents, 0),
    paidCents: null, remainingCents: null, flowCode: '', plans, ...extra };
}
const plan = (month, amountCents, paidCents = 0) => ({ month, amountCents, paidCents, unpaidCents: paidCents === null ? null : amountCents - paidCents });

test('期间KPI含三种预估且仅按筛选计划统计，原台账累计不混入', () => {
  const records = [
    record('r1', 'negotiated', [plan('2026-11', 100, 40), plan('2026-12', 200, 50)], { paidCents: 80, remainingCents: 220 }),
    record('r2', 'normal', [plan('2026-10', 1000)], { paidCents: 100, remainingCents: 900 }),
    record('r3', 'shipment', [plan('2026-11', 40, 10)]),
    record('r4', 'after_sales', [plan('2026-11', 50)]),
    record('r5', 'unregistered', [plan('2026-11', 60)]),
  ];
  const result = buildDashboard(records, [], [], { from: '2026-11', to: '2026-11' });
  assert.equal(result.summary.planCents, 250);
  assert.equal(result.summary.paidCents, 50);
  assert.equal(result.summary.remainingCents, 200);
  assert.equal(result.summary.unappliedUnpaidCents, 200);
  assert.equal(result.summary.appliedUnpaidCents, 0);
  assert.equal(result.paymentTable.rows.find(row => row.id === 'total').period.totalCents, result.summary.planCents);
  assert.deepEqual(result.summary.forecastCents, { shipment: 40, after_sales: 50, unregistered: 60 });
  assert.equal(result.records.find(item => item.key === 'r1').selectedPlanCents, 100);
  assert.ok(!result.records.some(item => item.key === 'r2'));
  assert.equal(result.months[0].negotiated, 100);
});

test('谈判表正常付款独立筛选，预估并入计划但待定始终独立', () => {
  const records = [
    record('r1', 'negotiated', [plan('2026-11', 100)], { paidCents: 10, remainingCents: 90 }),
    record('r2', 'negotiated_normal', [plan('2026-11', 200), plan(null, 50)], { paidCents: 20, remainingCents: 230 }),
    record('r3', 'normal', [plan('2026-11', 300)], { paidCents: 30, remainingCents: 270 }),
    record('r4', 'shipment', [plan('2026-11', 400)]),
  ];
  const result = buildDashboard(records);
  assert.equal(result.summary.planCents, 1000);
  assert.equal(result.summary.pendingPlanCents, 50);
  assert.equal(result.summary.paidCents, 0);
  assert.equal(result.summary.remainingCents, 1000);
  assert.equal(result.summary.ledgerRecordCount, 3);
  assert.deepEqual(result.summary.forecastCents, { shipment: 400, after_sales: 0, unregistered: 0 });
  assert.equal(result.months[0].negotiated_normal, 200);
  assert.equal(result.months.some(row => row.month === 'pending'), false);
  assert.equal(result.pendingRecords[0].selectedPlanCents, 50);
  assert.equal(result.records.find(row => row.key === 'r2').selectedPlanCents, 200);
  for (const [category, cents] of [['negotiated', 100], ['negotiated_normal', 200], ['normal', 300]]) {
    const filtered = buildDashboard(records, [], [], { category, month: '2026-11' });
    assert.equal(filtered.records.length, 1);
    assert.equal(filtered.records[0].category, category);
    assert.equal(filtered.summary.planCents, cents);
    assert.equal(filtered.summary.ledgerRecordCount, 1);
  }
});

test('未明确月份单列且不冒充当期计划，时间待定模式四项汇总都按待定', () => {
  const records = [record('r1', 'normal', [plan(null, 500)], { paidCents: 0, remainingCents: 500 }),
    record('r2', 'normal', [plan('2027-01', 100)]), record('r3', 'shipment', [plan(null, 90)])];
  const result = buildDashboard(records, [], [], { from: '2026-11', to: '2026-12' });
  assert.equal(result.summary.planCents, 0);
  assert.equal(result.summary.pendingPlanCents, 500);
  assert.equal(result.summary.pendingForecastCents.shipment, 90);
  assert.equal(result.summary.missingPaidCount, 0);
  assert.equal(result.summary.missingRemainingCount, 0);
  assert.equal(result.months.length, 0);
  assert.equal(result.records.length, 0);
  const pending = buildDashboard(records, [], [], { month: 'pending' });
  assert.equal(pending.records.length, 2);
  assert.equal(pending.summary.planCents, 590);
  assert.equal(pending.summary.remainingCents, 590);
  assert.equal(pending.summary.unappliedUnpaidCents, 590);
  assert.deepEqual(pending.monthlyTrend, []);
  assert.equal(pending.topSuppliers[0].unpaidCents, 590);
});

test('未完成对账属于付款台账且可独立筛选，不进入三个预估槽位金额', () => {
  const records = [record('r1', 'normal', [plan('2026-11', 200)]),
    record('r2', 'normal_unreconciled', [plan('2026-11', 300, 100), plan(null, 50)], { paidCents: 100, remainingCents: 250 }),
    record('r3', 'shipment', [plan('2026-11', 90)])];
  const data = buildDashboard(records, [], [], { category: 'normal_unreconciled', month: '2026-11' });
  assert.equal(data.records.length, 1);
  assert.equal(data.summary.planCents, 300);
  assert.equal(data.summary.pendingPlanCents, 50);
  assert.equal(data.summary.ledgerRecordCount, 1);
  assert.equal(data.summary.paidCents, 100);
  assert.deepEqual(data.summary.forecastCents, { shipment: 0, after_sales: 0, unregistered: 0 });
  assert.equal(data.months[0].normal_unreconciled, 300);
  assert.equal(data.pendingRecords[0].selectedPlanCents, 50);
});

test('供应商等条件影响期间金额，空结果不会丢失筛选选项', () => {
  const records = [record('r1', 'normal', [plan('2026-11', 100)], { paidCents: 20, remainingCents: 80 }),
    record('r2', 'normal', [plan('2026-11', 200, 50)], { supplier: '供应商乙', paidCents: 999, remainingCents: 150 })];
  const result = buildDashboard(records, [], [], { supplier: '供应商乙' });
  assert.equal(result.summary.planCents, 200);
  assert.equal(result.summary.paidCents, 50);
  assert.deepEqual(result.options.suppliers, ['供应商甲', '供应商乙']);
  assert.equal(buildDashboard(records, [], [], { supplier: '无匹配' }).records.length, 0);
});

test('已提交状态或有效OA均算已申请，空值和占位值不算，期间明细与金额一致', () => {
  const inputs = [
    ['是', '', true], ['已经提交全部', '', true], ['已提交', '', true], ['已申请', '', true],
    ['已经提交部分', 'MDST-DGFK20261101004', true], ['未申请', 'MDST-DGFK20261101005', true],
    ['未提交', 'mdst-dgfk20261101006', true], ['', 'MDST-DGFK20261101007', true],
    ['未申请', '', false], ['', '—', false], ['否', '未提供', false], ['待提交', '', false],
  ];
  const records = inputs.map(([applicationStatus, flowCode], i) => record(`r${i}`, 'normal',
    [plan('2026-11', 100 + i, 10), plan(null, 500)], { applicationStatus, flowCode, supplier: `供应商${i}` }));
  const data = buildDashboard(records, [], [], { month: '2026-11' });
  const expected = inputs.reduce((sum, [, , applied], i) => sum + (applied ? 90 + i : 0), 0);
  assert.equal(data.summary.appliedUnpaidCents, expected);
  assert.equal(data.summary.appliedUnpaidCents + data.summary.unappliedUnpaidCents, data.summary.remainingCents);
  assert.equal(data.appliedUnpaidRecords.reduce((sum, row) => sum + row.selectedUnpaidCents, 0), expected);
  assert.equal(data.records.reduce((sum, row) => sum + row.selectedAppliedUnpaidCents, 0), data.summary.appliedUnpaidCents);
  assert.equal(data.records.reduce((sum, row) => sum + row.selectedUnappliedUnpaidCents, 0), data.summary.unappliedUnpaidCents);
  data.records.forEach((row, i) => {
    assert.equal(row.selectedAppliedUnpaidCents, inputs[i][2] ? 90 + i : 0);
    assert.equal(row.selectedUnappliedUnpaidCents, inputs[i][2] ? 0 : 90 + i);
    assert.equal(row.selectedAppliedUnpaidCents + row.selectedUnappliedUnpaidCents, row.selectedUnpaidCents);
  });
  data.pendingRecords.forEach((row, i) => {
    assert.equal(row.selectedAppliedUnpaidCents, inputs[i][2] ? 500 : 0);
    assert.equal(row.selectedUnappliedUnpaidCents, inputs[i][2] ? 0 : 500);
  });
  assert.deepEqual(data.records.map(row => row.applicationState), inputs.map(([, , yes]) => yes ? 'applied' : 'unapplied'));
  assert.equal(data.records[5].applicationStatus, '未申请');
  assert.match(data.records[5].applicationBasis, /OA/);
});

test('部分申请无OA无申请金额时列待核对，不推算申请额，未知付款拆分不会变零', () => {
  const partial = record('p1', 'negotiated', [plan('2026-11', 100, 30)], { applicationStatus: '已经提交部分' });
  const data = buildDashboard([partial]);
  assert.equal(data.summary.remainingCents, 70);
  assert.equal(data.summary.applicationReviewCents, 70);
  assert.equal(data.summary.applicationReviewCount, 1);
  assert.equal(data.summary.appliedUnpaidCents, null);
  assert.equal(data.summary.unappliedUnpaidCents, null);
  assert.equal(data.records[0].selectedAppliedUnpaidCents, null);
  assert.equal(data.records[0].selectedUnappliedUnpaidCents, null);
  assert.equal(data.appliedUnpaidRecords.length, 0);
  assert.ok(data.issues.some(issue => issue.code === 'APPLICATION_PARTIAL_REVIEW'));
  const paid = buildDashboard([{ ...partial, plans: [plan('2026-11', 100, 100)] }]);
  assert.equal(paid.summary.applicationReviewCount, 0);
  assert.equal(paid.summary.appliedUnpaidCents, 0);
  assert.equal(paid.records[0].selectedAppliedUnpaidCents, 0);
  assert.equal(paid.records[0].selectedUnappliedUnpaidCents, 0);
  const unknown = buildDashboard([record('u1', 'negotiated', [plan('2026-11', 200, null)], { applicationStatus: '已提交' })]);
  assert.equal(unknown.summary.planCents, 200);
  assert.equal(unknown.summary.paidCents, null);
  assert.equal(unknown.summary.remainingCents, null);
  assert.equal(unknown.summary.appliedUnpaidCents, null);
  assert.equal(unknown.summary.uncertainCount, 1);
  assert.equal(unknown.monthlyTrend[0].unpaidCents, null);
  assert.equal(unknown.topSuppliers.length, 0);
  assert.equal(unknown.supplierGroups[0].paidCents, null);
  assert.equal(unknown.records[0].selectedAppliedUnpaidCents, null);
  assert.equal(unknown.records[0].selectedUnappliedUnpaidCents, 0);
  const unknownUnapplied = buildDashboard([record('u2', 'negotiated', [plan('2026-11', 200, null)])]);
  assert.equal(unknownUnapplied.records[0].selectedAppliedUnpaidCents, 0);
  assert.equal(unknownUnapplied.records[0].selectedUnappliedUnpaidCents, null);
  assert.equal(unknownUnapplied.summary.unappliedUnpaidCents, null);
});

test('逐笔申请未付拆分保留已付清零、有效零和冲减金额，合计与期间汇总一致', () => {
  const records = [
    record('r1', 'normal', [plan('2026-11', 100, 100)], { applicationStatus: '是' }),
    record('r2', 'normal', [plan('2026-11', 50, 50)]),
    record('r3', 'normal', [plan('2026-11', 0)], { applicationStatus: '已经提交部分' }),
    record('r4', 'normal', [plan('2026-11', -30)], { applicationStatus: '是' }),
    record('r5', 'normal', [plan('2026-11', -10)]),
  ];
  const data = buildDashboard(records);
  assert.deepEqual(data.records.map(row => [row.selectedAppliedUnpaidCents, row.selectedUnappliedUnpaidCents]),
    [[0, 0], [0, 0], [0, 0], [-30, 0], [0, -10]]);
  assert.equal(data.summary.appliedUnpaidCents, -30);
  assert.equal(data.summary.unappliedUnpaidCents, -10);
  assert.equal(data.summary.remainingCents, -40);
});

test('待核对供应商按当前期间recordKey去重，原台账金额与期间金额隔离', () => {
  const records = [
    record('r1', 'negotiated', [plan('2026-11', 100, 10), plan(null, 300)], { amountCents: 1500, paidCents: 200, remainingCents: 1200 }),
    record('r2', 'normal', [plan('2026-11', 50, 50)], { amountCents: 500, paidCents: 50, remainingCents: null }),
    record('r3', 'shipment', [plan('2026-11', 70)], { amountCents: 700 }),
    record('r4', 'normal', [plan('2027-01', 1000)]),
  ];
  const issues = [{ recordKey: 'r1', code: 'ONE' }, { recordKey: 'r1', code: 'TWO' },
    { recordKey: 'r2', code: 'THREE' }, { recordKey: 'r3', code: 'FOUR' }, { recordKey: 'r4', code: 'OUTSIDE' }, { code: 'FILE_WARNING' }];
  const data = buildDashboard(records, issues, [], { month: '2026-11' });
  assert.equal(data.summary.planCents, 220);
  assert.equal(data.summary.paidCents, 60);
  assert.equal(data.reviewSuppliers[0].totalCents, 2700);
  assert.equal(data.reviewSuppliers[0].records.length, 3);
  assert.equal(data.reviewSuppliers[0].records[0].reviewRemainingCents, 1200);
  assert.equal(data.reviewSuppliers[0].records[0].reviewBalanceMismatch, true);
  assert.equal(data.reviewSuppliers[0].records[1].reviewRemainingCents, 450);
  assert.equal(data.reviewSuppliers[0].records[2].reviewRemainingCents, null);
  assert.ok(!data.issues.some(issue => issue.code === 'OUTSIDE'));
  assert.ok(data.issues.some(issue => issue.code === 'FILE_WARNING'));
});

test('供应商聚合、Top10及跨年月度趋势均服从同一范围，更新时间取最新来源', () => {
  const records = Array.from({ length: 12 }, (_, i) => record(`r${i}`, 'normal',
    [plan('2026-12', i * 100), plan('2027-01', 25, 5), plan(null, 5000)], { supplier: `供应商${i}` }));
  const slots = [
    { id: 'schedule', currentVersionId: 'v1', uploadedAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-15T03:00:00.000Z' },
    { id: 'shipment', currentVersionId: 'v2', uploadedAt: '2026-11-14T00:00:00.000Z', updatedAt: 'invalid' },
    { id: 'after_sales', currentVersionId: null, updatedAt: '2027-01-01T00:00:00.000Z' },
  ];
  const data = buildDashboard(records, [], slots, { from: '2026-12', to: '2027-01' });
  assert.equal(data.topSuppliers.length, 10);
  assert.equal(data.topSuppliers[0].supplier, '供应商11');
  assert.equal(data.topSuppliers[0].unpaidCents, 1120);
  assert.equal(data.supplierGroups[0].amountCents, 25);
  assert.equal(data.supplierGroups[0].paidCents, 5);
  assert.equal(data.supplierGroups[0].unpaidCents, 20);
  assert.equal(data.pendingSupplierGroups[0].amountCents, 5000);
  assert.deepEqual(data.monthlyTrend, [
    { month: '2026-12', totalCents: 6600, paidCents: 0, unpaidCents: 6600, uncertainCount: 0 },
    { month: '2027-01', totalCents: 300, paidCents: 60, unpaidCents: 240, uncertainCount: 0 },
  ]);
  assert.equal(data.updatedAt, slots[0].updatedAt);
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
