import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPlanPayments, commentPaymentState, isArchived } from '../server/payment-status.js';

function classify(category, plans, extra = {}) {
  const issues = [];
  classifyPlanPayments({ category, plans, warn: (code, message) => issues.push({ code, message }), ...extra });
  return { plans, issues };
}
const plan = (month = '2026-11', amountCents = 10000, sourceComment = '') => ({ month, amountCents, sourceCell: 'AK2', sourceComment });
const item = (amountCents, comment, month = '2026-11', sourceCell = 'U2') => ({ month, amountCents, sourceCell, comment, state: commentPaymentState(comment) });

test('批注仅识别日期加明确已付，支持核实和已支付，负向和不完整表述不误判', () => {
  for (const note of ['11月5日-已付', '11月5日核实-已支付\n申请日期：2026年11月2日', '2027年1月3日－已付款', '11月5日-已付\n11月5日-已付']) assert.equal(commentPaymentState(note), 'paid', note);
  for (const note of ['申请日期：2026年11月2日', '11月5日-OA已评论', '']) assert.equal(commentPaymentState(note), 'none');
  assert.equal(commentPaymentState('11月5日-未付'), 'unpaid');
  for (const note of ['11月5日-预计已付', '11月5日-已付部分', '11月5日-已付\n11月6日-未付', '11月5日-已付？', '已付', '2月30日-已付', '11月5日-已付50元']) assert.equal(commentPaymentState(note), 'uncertain', note);
});

test('两类正常付款精确按归档识别，三类预估即使写归档也计未付', () => {
  for (const category of ['normal', 'negotiated_normal']) {
    for (const status of ['归档', ' 已归档 ']) {
      const result = classify(category, [plan()], { status });
      assert.equal(result.plans[0].paidCents, 10000);
      assert.equal(result.plans[0].unpaidCents, 0);
    }
    for (const status of ['', '未归档', '未已归档', '归档中', '归档抄送']) assert.equal(classify(category, [plan()], { status }).plans[0].paidCents, 0);
  }
  for (const category of ['shipment', 'after_sales', 'unregistered']) {
    const result = classify(category, [plan()], { status: '归档' });
    assert.equal(result.plans[0].paidCents, 0);
    assert.equal(result.plans[0].unpaidCents, 10000);
  }
  assert.equal(isArchived('未归档'), false);
});

test('谈判付款按具体分期金额拆已付未付，批注跨月不迁移月份，重复标记不翻倍', () => {
  const result = classify('negotiated', [plan()], { status: '归档', installments: [item(4000, '12月1日-已付\n12月1日-已付')] });
  assert.equal(result.plans[0].paidCents, 4000);
  assert.equal(result.plans[0].unpaidCents, 6000);
  assert.equal(result.plans[0].month, '2026-11');
  assert.equal(result.plans[0].paymentEvidence[0].sourceCell, 'U2');
  assert.equal(result.issues.length, 0);
  const unmarked = classify('negotiated', [plan()], { status: '归档' });
  assert.equal(unmarked.plans[0].paidCents, 0);
  assert.equal(unmarked.plans[0].unpaidCents, 10000);
});

test('月支付格明确已付只计整格一次，分期未付矛盾则保留待核对', () => {
  const result = classify('negotiated', [plan('2026-11', 10000, '11月5日-已付')], { installments: [item(4000, '11月5日-已付')] });
  assert.equal(result.plans[0].paidCents, 10000);
  assert.equal(result.plans[0].unpaidCents, 0);
  const conflict = classify('negotiated', [plan('2026-11', 10000, '11月5日-已付')], { installments: [item(4000, '11月5日-未付')] });
  assert.equal(conflict.plans[0].paidCents, null);
  assert.equal(conflict.plans[0].unpaidCents, null);
  assert.equal(conflict.issues[0].code, 'PAYMENT_STATUS_UNCERTAIN');
});

test('部分付款、超出月额、缺年份或无对应月份不猜金额或月份', () => {
  for (const installments of [[item(4000, '11月5日-已付部分')], [item(12000, '11月5日-已付')], [item(4000, '11月5日-已付', null)], [item(4000, '11月5日-已付', '2025-11')]]) {
    const result = classify('negotiated', [plan()], { installments });
    assert.equal(result.plans[0].amountCents, 10000);
    assert.equal(result.plans[0].paidCents, null);
    assert.equal(result.plans[0].unpaidCents, null);
    assert.equal(result.issues.length, 1);
  }
});

test('零、负数、时间待定与跨年月份保持原值，已付加未付始终等于合计', () => {
  for (const [amount, paid] of [[0, 0], [-10000, -4000], [10000, 4000]]) {
    const result = classify('negotiated', [plan('2027-01', amount)], { installments: [item(paid, '12月31日-已付', '2027-01')] });
    assert.equal(result.plans[0].paidCents, paid);
    assert.equal(result.plans[0].paidCents + result.plans[0].unpaidCents, amount);
  }
  assert.equal(classify('negotiated', [plan(null)]).plans[0].unpaidCents, 10000);
  assert.equal(classify('normal', [plan(null, -10000)], { status: '归档' }).plans[0].paidCents, -10000);
});
