import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPlanPayments, commentPaymentState, commentPaymentDates } from '../server/payment-status.js';
import { resolveProgressPayments } from '../server/payment-progress.js';

function classify(category, plans, extra = {}) {
  const issues = [];
  classifyPlanPayments({ category, plans, warn: (code, message) => issues.push({ code, message }), ...extra });
  return { plans, issues };
}
const plan = (month = '2026-11', amountCents = 10000, sourceComment = '') => ({ month, amountCents, sourceCell: 'AK2', sourceComment });
const item = (amountCents, comment, month = '2026-11', sourceCell = 'U2') => ({ month, amountCents, sourceCell, comment, state: commentPaymentState(comment) });

test('付款时间未记录是占位文字，不让已申请未付和同月已付金额变成未知', () => {
  const placeholder = '申请日期（付款节奏跟进）：2026年11月19日\n付款时间（付款节奏跟进）：未记录';
  for (const text of [placeholder, '付款时间:未记录', '申请日期：2026年11月19日，付款时间（付款节奏跟进）：未记录。']) {
    assert.equal(commentPaymentState(text), 'none');
    assert.deepEqual(commentPaymentDates(text), []);
  }
  for (const category of ['negotiated', 'negotiated_normal']) {
    for (const amount of [0, 10000, -10000]) {
      const result = classify(category, [plan('2026-11', amount)], { installments: [item(amount, placeholder)] });
      assert.deepEqual([result.plans[0].paidCents, result.plans[0].unpaidCents], [0, amount]);
      assert.equal(result.issues.length, 0);
    }
    const mixed = classify(category, [plan()], { installments: [item(4000, '付款时间：2026年11月2日'), item(6000, placeholder)] });
    assert.deepEqual([mixed.plans[0].paidCents, mixed.plans[0].unpaidCents], [4000, 6000]);
    assert.equal(mixed.issues.length, 0);
    assert.equal(classify(category, [plan('2026-11', 10000, placeholder)]).plans[0].paidCents, 0);
  }
  assert.equal(commentPaymentState(`${placeholder}\n11月2日-已付`), 'paid');
  for (const text of [`${placeholder}\n已付`, `${placeholder}\n部分付款`, `${placeholder}\n11月2日-已付\n未付款`, '付款时间：未记录但已付']) {
    assert.equal(commentPaymentState(text), 'uncertain', text);
  }
});

test('批注仅识别日期加明确已付，支持核实和已支付，负向和不完整表述不误判', () => {
  for (const note of ['11月5日-已付', '11月5日核实-已支付\n申请日期：2026年11月2日', '2027年1月3日－已付款', '11月5日-已付\n11月5日-已付']) assert.equal(commentPaymentState(note), 'paid', note);
  for (const note of ['申请日期：2026年11月2日', '11月5日-OA已评论', '']) assert.equal(commentPaymentState(note), 'none');
  assert.equal(commentPaymentState('11月5日-未付'), 'unpaid');
  for (const note of ['11月5日-预计已付', '11月5日-已付部分', '11月5日-已付\n11月6日-未付', '11月5日-已付？', '已付', '2月30日-已付', '11月5日-已付50元']) assert.equal(commentPaymentState(note), 'uncertain', note);
});

test('两类谈判付款均读取批注，正常与预估不因归档状态认定已付', () => {
  for (const category of ['negotiated', 'negotiated_normal']) {
    assert.equal(classify(category, [plan()], { status: '已归档' }).plans[0].paidCents, 0);
    assert.equal(classify(category, [plan()], { installments: [item(4000, '11月5日-已付')] }).plans[0].paidCents, 4000);
  }
  for (const category of ['normal', 'normal_unreconciled', 'shipment', 'after_sales', 'unregistered']) {
    const result = classify(category, [plan()], { status: '归档' });
    assert.equal(result.plans[0].paidCents, 0);
    assert.equal(result.plans[0].unpaidCents, 10000);
  }
});

test('谈判付款按具体分期金额拆已付未付，批注跨月不迁移月份，重复标记不翻倍', () => {
  const result = classify('negotiated', [plan()], { status: '归档', installments: [item(4000, '12月1日-已付\n12月1日-已付')] });
  assert.equal(result.plans[0].paidCents, 4000);
  assert.equal(result.plans[0].unpaidCents, 6000);
  assert.equal(result.plans[0].month, '2026-11');
  assert.deepEqual(result.plans[0].paymentDates, ['12月1日']);
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
  assert.equal(classify('normal', [plan(null, -10000)], { status: '归档' }).plans[0].unpaidCents, -10000);
});

test('付款日期只取已付批注且不猜年份，申请日期不能作为付款日期', () => {
  assert.deepEqual(commentPaymentDates('12月31日-已付\n2027年1月2日-已支付\n申请日期：2026年11月2日'), ['12月31日', '2027-01-02']);
  assert.deepEqual(commentPaymentDates('申请日期：2026年11月2日 已付'), []);
  assert.equal(commentPaymentState('申请日期：2026年11月2日 已付'), 'uncertain');
  assert.deepEqual(commentPaymentDates('2026年2月29日-已付\n2月29日-已付'), ['2月29日']);
  for (const note of ['11月5日-已付，申请日期：11月2日', '申请日期：11月2日，11月5日-已付', '提交时间：2026年11月2日,11月5日-已支付']) {
    assert.deepEqual(commentPaymentDates(note), ['11月5日']);
    assert.equal(commentPaymentState(note), 'paid');
  }
  for (const note of ['申请日期：11月2日-已付', '提交日期：11月2日-已支付']) {
    assert.deepEqual(commentPaymentDates(note), []);
    assert.equal(commentPaymentState(note), 'uncertain');
  }
});

test('明确付款时间直接代表已付，实际日期优先于核实日期且重复标记不重复计款', () => {
  const paymentTime = '付款时间（付款节奏跟进）：2026年11月2日';
  for (const note of [paymentTime, '付款时间(付款节奏跟进): 2026年11月2日', '付款时间：2026年11月2日',
    `申请日期：2026年10月30日，${paymentTime}`, `${paymentTime}\\`, `11月5日核实-已支付\n${paymentTime}\n${paymentTime}`]) {
    assert.equal(commentPaymentState(note), 'paid', note);
    assert.deepEqual(commentPaymentDates(note), ['2026-11-02'], note);
  }
  assert.deepEqual(commentPaymentDates('付款时间：2月29日'), ['2月29日']);
  assert.deepEqual(commentPaymentDates('付款时间：2028年2月29日'), ['2028-02-29']);
  for (const category of ['negotiated', 'negotiated_normal']) {
    const result = classify(category, [plan()], { installments: [item(4000, `${paymentTime}\n11月5日-已付`)] });
    assert.deepEqual([result.plans[0].paidCents, result.plans[0].unpaidCents], [4000, 6000]);
    assert.deepEqual(result.plans[0].paymentDates, ['2026-11-02']);
    const direct = classify(category, [plan('2026-11', 10000, paymentTime)], { installments: [item(4000, paymentTime)] });
    assert.deepEqual([direct.plans[0].paidCents, direct.plans[0].unpaidCents], [10000, 0]);
  }
});

test('付款时间须为有效日期，申请/提交时间及预计日期不误判，矛盾仍待核对', () => {
  for (const note of ['申请日期（付款节奏跟进）：2026年11月2日', '提交时间：2026年11月2日',
    '预计付款时间：2026年11月2日', '计划付款时间：2026年11月2日']) {
    assert.equal(commentPaymentState(note), 'none', note);
    assert.deepEqual(commentPaymentDates(note), [], note);
  }
  for (const note of ['付款时间：', '付款时间：2026年2月29日', '付款时间：2026年13月2日',
    '付款时间：2026年11月2日\n未付款', '付款时间：2026年11月2日\n部分付款',
    '付款时间：2026年11月2日\n已撤销', '付款时间：2026年11月2日？']) {
    assert.equal(commentPaymentState(note), 'uncertain', note);
    const result = classify('negotiated', [plan()], { installments: [item(4000, note)] });
    assert.equal(result.plans[0].paidCents, null);
    assert.equal(result.issues[0].code, 'PAYMENT_STATUS_UNCERTAIN');
  }
  for (const amount of [0, -10000]) {
    const result = classify('negotiated', [plan('2026-11', amount, '付款时间：2027年1月2日')]);
    assert.equal(result.plans[0].paidCents, amount);
    assert.equal(result.plans[0].unpaidCents, 0);
    assert.equal(result.plans[0].month, '2026-11');
  }
});

const progressRecord = (extra = {}) => ({ key: 'schedule:正常付款:2', slotId: 'schedule', sourceSheet: '正常付款', sourceRow: 2,
  category: 'normal', flowCode: 'MDST-DGFK20261101001', supplier: '样例供应商', payer: '样例主体', amountCents: 10000,
  paidCents: 0, plans: [plan()], ...extra });
const progressRow = (extra = {}) => ({ sourceSheet: '付款进度整理', sourceRow: 2, flowCode: 'MDST-DGFK20261101001',
  supplier: '样例供应商', payer: '样例主体', amountCents: 10000, status: '已付款', ...extra });
const resolve = (record, rows, available = true) => resolveProgressPayments([record], { rows, available }, { id: 'v1', filename: '样例.xlsx' });

test('正常付款与三类预估明确关联已付款，归档与申请时间不作为依据且不修改原对象', () => {
  for (const category of ['normal', 'normal_unreconciled', 'shipment', 'after_sales', 'unregistered']) {
    const original = progressRecord({ category, sourceSheet: category === 'normal' ? '正常付款' : '谈判付款', status: '未归档' });
    const result = resolve(original, [progressRow()]);
    const resolved = result.records[0].plans[0];
    assert.equal(resolved.paidCents, 10000);
    assert.equal(resolved.unpaidCents, 0);
    assert.deepEqual(resolved.paymentDates, []);
    assert.deepEqual(resolved.paymentProgressVersion, { id: 'v1', filename: '样例.xlsx' });
    assert.equal(resolved.paymentEvidence[0].sourceRow, 2);
    assert.equal(original.plans[0].paidCents, undefined);
  }
  for (const category of ['negotiated', 'negotiated_normal']) {
    const original = progressRecord({ category, sourceSheet: '谈判付款', plans: classify(category, [plan()]).plans });
    assert.equal(resolve(original, [progressRow()]).records[0].plans[0].paidCents, 0);
  }
});

test('进度缺失、无有效流程号、未匹配及非已付款状态全计未付并说明原因', () => {
  const checks = [
    resolve(progressRecord(), [], false), resolve(progressRecord({ flowCode: '' }), [progressRow()]),
    resolve(progressRecord({ flowCode: '未匹配' }), [progressRow({ flowCode: '未匹配' })]),
    resolve(progressRecord(), []),
    ...['', '未付款', '重新申请', '已支付', '未已付款', '已付款中'].map(status => resolve(progressRecord({ status: '已归档' }), [progressRow({ status })])),
  ];
  for (const result of checks) {
    assert.equal(result.records[0].plans[0].paidCents, 0);
    assert.equal(result.records[0].plans[0].unpaidCents, 10000);
    assert.ok(result.issues.some(issue => issue.code === 'PAYMENT_PROGRESS_REVIEW'));
    assert.match(result.records[0].plans[0].paymentBasis, /计未付/);
  }
});

test('未完成对账仍按付款进度判断已付，保留缺失依据与原台账差异提示', () => {
  for (const category of ['normal', 'normal_unreconciled']) {
    const paid = resolve(progressRecord({ category, paidCents: 0 }), [progressRow()]);
    assert.equal(paid.records[0].plans[0].paidCents, 10000);
    assert.ok(paid.issues.some(issue => issue.code === 'RULE_PAID_MISMATCH'));
    const unmatched = resolve(progressRecord({ category }), []);
    assert.equal(unmatched.records[0].plans[0].unpaidCents, 10000);
    assert.ok(unmatched.issues.some(issue => issue.code === 'PAYMENT_PROGRESS_REVIEW'));
  }
});

test('同号多笔按金额供应商付款主体消歧，重复候选与状态冲突不猜已付', () => {
  const rows = [progressRow({ sourceRow: 2, amountCents: 20000, status: '未付款' }),
    progressRow({ sourceRow: 3, supplier: '其他供应商', status: '未付款' }),
    progressRow({ sourceRow: 4, payer: '其他主体', status: '未付款' }), progressRow({ sourceRow: 5 })];
  assert.equal(resolve(progressRecord(), rows).records[0].plans[0].paidCents, 10000);
  assert.equal(resolve(progressRecord(), rows).records[0].plans[0].paymentEvidence[0].sourceRow, 5);
  for (const extra of [progressRow({ sourceRow: 6 }), progressRow({ sourceRow: 6, status: '未付款' })]) {
    const result = resolve(progressRecord(), [...rows, extra]);
    assert.equal(result.records[0].plans[0].paidCents, 0);
    assert.match(result.records[0].plans[0].paymentBasis, /多笔|冲突/);
  }
  assert.match(resolve(progressRecord(), [progressRow({ amountCents: 1 })]).records[0].plans[0].paymentBasis, /不一致/);
});

test('进度解析保留零负金额及待定日期，已付未付之和保持原金额', () => {
  for (const amountCents of [0, -10000, 10000]) {
    for (const status of ['已付款', '未付款']) {
      const result = resolve(progressRecord({ amountCents, plans: [plan(null, amountCents)] }), [progressRow({ amountCents, status })]).records[0].plans[0];
      assert.equal(result.month, null);
      assert.equal(result.paidCents + result.unpaidCents, amountCents);
      assert.equal(result.paidCents, status === '已付款' ? amountCents : 0);
    }
  }
});
