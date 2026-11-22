import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPlanApplications, commentApplication, sumApplicationAmounts } from '../server/payment-application.js';
import { classifyPlanPayments, commentPaymentState } from '../server/payment-status.js';
import { buildDashboard } from '../server/dashboard.js';

const applied = '申请日期（付款节奏跟进）：2026年11月2日';
const paid = '付款时间（付款节奏跟进）：2026年11月3日';
const plan = (month = '2026-11', amountCents = 10000, sourceComment = '') => ({ month, amountCents, sourceCell: `月支付-${month}`, sourceComment });
const item = (sourceCell, amountCents, comment = '', month = '2026-11') => ({ sourceCell, amountCents, comment, month, state: commentPaymentState(comment) });
function record(plans, applicationInstallments = [], category = 'negotiated') {
  classifyPlanPayments({ category, plans, installments: applicationInstallments.filter(row => row.state !== 'none'), warn() {} });
  return { key: 'r1', supplier: '测试供应商', payer: '付款主体', category, sourceSheet: '谈判付款', slotId: 'schedule', sourceRow: 2,
    amountCents: plans.reduce((sum, row) => sum + row.amountCents, 0), plans, applicationInstallments };
}
const result = row => classifyPlanApplications(row, row.plans);
const amounts = row => result(row).map(p => [p.appliedUnpaidCents, p.unappliedUnpaidCents]);

test('申请日期与明确申请单提交独立于付款时间和 OA，日期验证不猜年份', () => {
  for (const text of [applied, '申请日期:2026-11-02', '申请时间：2026/11/02', '申请单已提交', '已提交付款申请单', '付款申请单：已提交', '是否提交付款申请单：是']) {
    assert.equal(commentApplication(text).state, 'applied', text);
  }
  assert.deepEqual(commentApplication(applied).dates, ['2026-11-02']);
  assert.deepEqual(commentApplication('申请日期：2月29日').dates, ['2月29日']);
  for (const text of ['', paid, 'OA已提交部分', '付款OA申请已提交', 'OA备注时间（付款节奏跟进）：已备注，时间未填', '预计申请日期：2026年11月2日',
    '申请日期：2026年2月29日', '申请日期：2026年13月2日', '付款申请单：未提交', '是否提交付款申请单：否']) {
    assert.equal(commentApplication(text).state, 'unapplied', text);
  }
  for (const text of ['付款申请单：部分提交', '付款申请单：已提交50元', `${applied}\n付款申请单：未提交`, `${applied}\n付款申请单已撤销`]) {
    assert.equal(commentApplication(text).state, 'review', text);
  }
});

test('有效申请日期后的批次归属待核对说明仍计已申请，保留原文与逐批月份', () => {
  const note = '申请日期（付款节奏跟进）：2026年11月19日（批次归属待核对）';
  for (const text of [note, '申请日期:2026-11-19(批次归属待核对)', '申请时间：2026/11/19（批次归属待核对）']) {
    assert.equal(commentApplication(text).state, 'applied', text);
    assert.deepEqual(commentApplication(text).dates, ['2026-11-19']);
  }
  for (const text of ['申请日期：2026年2月29日（批次归属待核对）', '申请日期：（批次归属待核对）',
    '预计申请日期：2026年11月19日（批次归属待核对）', 'OA备注时间：2026年11月19日（批次归属待核对）']) {
    assert.equal(commentApplication(text).state, 'unapplied', text);
  }
  for (const text of [`${note}\n付款申请单：未提交`, `${note}\n付款申请单已撤销`, `${note}\n付款申请单：部分提交`]) {
    assert.equal(commentApplication(text).state, 'review', text);
  }
  for (const category of ['negotiated', 'negotiated_normal']) {
    const row = record([plan('2026-11', 9000000), plan('2026-12', 8309000)],
      [item('V9', 9000000, `${note}\n付款时间（付款节奏跟进）：未记录`), item('Y9', 8309000, '', '2026-12')], category);
    const original = JSON.stringify(row);
    assert.deepEqual(amounts(row), [[9000000, 0], [0, 8309000]]);
    assert.deepEqual(result(row).map(p => p.month), ['2026-11', '2026-12']);
    assert.match(result(row)[0].applicationEvidence[0].comment, /（批次归属待核对）/);
    assert.equal(JSON.stringify(row), original);
    for (const amount of [0, -10000]) {
      assert.deepEqual(amounts(record([plan('2026-11', amount, note)], [], category)), [[amount, 0]]);
    }
  }
});

test('两类谈判均只看金额格批注，同额不同月和申请日期跨月互不覆盖', () => {
  for (const category of ['negotiated', 'negotiated_normal']) {
    const row = record([plan('2026-10', 9000000), plan('2026-11', 9000000), plan('2026-12', 8309000)],
      [item('T8', 9000000, applied, '2026-10'), item('V8', 9000000), item('X8', 8309000, '', '2026-12')], category);
    row.flowCode = 'MDST-DGFK20260722011'; row.applicationStatus = '已经提交全部';
    assert.deepEqual(amounts(row), [[9000000, 0], [0, 9000000], [0, 8309000]]);
    assert.equal(result(row)[0].month, '2026-10');
    assert.deepEqual(result(row)[0].applicationDates, ['2026-11-02']);
    assert.equal(result(row)[0].applicationEvidence[0].sourceCell, 'T8');
  }
});

test('逐批申请与已付取交集，不把另一个批次已支付金额扣到已提交批次', () => {
  const row = record([plan()], [item('U2', 4000, applied), item('V2', 3000, paid), item('W2', 3000)]);
  assert.deepEqual(amounts(row), [[4000, 3000]]);
  const both = record([plan()], [item('U2', 4000, `${applied}\n${paid}`), item('V2', 2000, applied), item('W2', 4000)]);
  assert.deepEqual(amounts(both), [[2000, 4000]]);
  assert.equal(result(both)[0].applicationState, 'partial');
  const dashboard = buildDashboard([both]);
  assert.equal(dashboard.summary.appliedUnpaidCents, 2000);
  assert.equal(dashboard.summary.unappliedUnpaidCents, 4000);
  assert.equal(dashboard.appliedUnpaidRecords.length, 1);
  assert.equal(dashboard.summary.applicationReviewCount, 0);
});

test('月支付格明确提交只计一次，空白分期不覆盖，明确冲突才待核对', () => {
  const full = record([plan('2026-11', 10000, applied)], [item('U2', 4000, applied), item('V2', 6000)]);
  assert.deepEqual(amounts(full), [[10000, 0]]);
  const conflict = record([plan('2026-11', 10000, applied)], [item('U2', 4000, '付款申请单：未提交')]);
  assert.deepEqual(amounts(conflict), [[null, null]]);
  assert.equal(result(conflict)[0].applicationState, 'review');
});

test('正常和预估无论 OA 与节点均以申请单状态为准，空白待核对算未提交', () => {
  for (const category of ['normal', 'normal_unreconciled', 'shipment', 'after_sales', 'unregistered']) {
    for (const [applicationStatus, expected] of [['已提交', [10000, 0]], ['已经提交全部', [10000, 0]], ['未申请', [0, 10000]],
      ['未提交', [0, 10000]], ['', [0, 10000]], ['待核对（无流程号）', [0, 10000]], ['已经提交部分', [null, null]], ['已提交；未提交', [null, null]]]) {
      const row = record([plan()], [], category);
      Object.assign(row, { applicationStatus, flowCode: 'MDST-DGFK20261101001', currentNode: '已归档' });
      assert.deepEqual(amounts(row), [expected], `${category}:${applicationStatus}`);
    }
  }
});

test('缺年份分期和超额无法归属申请额，已付归属不明时不猜交集', () => {
  for (const applicationInstallments of [[item('U2', 4000, applied, null)], [item('U2', 12000, applied)],
    [item('U2', 4000, '付款申请单：部分提交')]]) {
    assert.deepEqual(amounts(record([plan()], applicationInstallments)), [[null, null]]);
  }
  const row = record([plan()], [item('U2', 4000, applied)]);
  row.plans[0].paidCents = 3000; row.plans[0].unpaidCents = 7000;
  assert.deepEqual(amounts(row), [[null, null]]);
  assert.match(result(row)[0].applicationBasis, /对应到具体分期/);
});

test('已付清与真实零不误报；负数逐批保留，未知值不变零且原始对象不变', () => {
  for (const total of [0, 10000, -10000]) {
    const settled = record([plan('2026-11', total, paid)], [item('U2', total, '付款申请单：部分提交')]);
    assert.deepEqual(amounts(settled), [[0, 0]]);
    assert.equal(buildDashboard([settled]).summary.applicationReviewCount, 0);
  }
  const negative = record([plan('2026-11', -10000)], [item('U2', -4000, applied), item('V2', -2000, paid), item('W2', -4000)]);
  assert.deepEqual(amounts(negative), [[-4000, -4000]]);
  const unknown = record([plan('2026-11', 10000, '11月5日-已付部分')]);
  assert.deepEqual(amounts(unknown), [[0, null]]);
  unknown.plans[0].sourceComment += `\n${applied}`;
  assert.deepEqual(amounts(unknown), [[null, 0]]);
  const clone = JSON.stringify(unknown);
  result(unknown);
  assert.equal(JSON.stringify(unknown), clone);
  assert.throws(() => sumApplicationAmounts([{ amount: Number.MAX_SAFE_INTEGER }, { amount: 1 }], 'amount'), /安全计算/);
});
