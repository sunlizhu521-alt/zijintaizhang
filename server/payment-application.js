import { commentPaymentState } from './payment-status.js';

const normalize = value => String(value ?? '').normalize('NFKC').trim();
const submittedStatuses = new Set(['是', '已提交', '已申请', '已经提交', '已经申请', '已经提交全部',
  '已提交全部', '全部已提交', '已全部提交', '全部已申请', '已全部申请', '已提交付款申请单']);

export function sumApplicationAmounts(plans, field) {
  let total = 0;
  for (const plan of plans) {
    const amount = plan[field];
    if (amount == null) return null;
    if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(total + amount)) {
      throw Object.assign(new Error('申请金额超过可安全计算范围或不是整数分。'), { status: 422 });
    }
    total += amount;
  }
  return total;
}

export function commentApplication(comment) {
  const text = normalize(comment);
  const dates = [];
  const applicationLines = text.split(/[\n\r;；。]/).filter(line => /申请(?:单|日期|时间)|部分(?:提交|申请)|(?:提交|申请)(?:了)?部分/.test(line))
    .filter(line => !/OA/i.test(line) || /申请(?:单|日期|时间)/.test(line));
  for (const line of applicationLines) {
    // 批次归属备注不否定有效申请日期，申请金额仍归批注所在的金额格。
    const pattern = /(?:^|[,，])\s*申请(?:日期|时间)\s*(?:\(付款节奏跟进\))?\s*:\s*(?:(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日|(\d{4})[-/](\d{1,2})[-/](\d{1,2}))(?=$|[\s,，!！\\]|\(批次归属待核对\))/g;
    for (const match of line.matchAll(pattern)) {
      const year = match[1] || match[4] ? Number(match[1] || match[4]) : null;
      const month = Number(match[2] || match[5]), day = Number(match[3] || match[6]);
      const check = new Date(Date.UTC(year ?? 2000, month - 1, day));
      if ((year !== null && (year < 1900 || year > 9999)) || check.getUTCFullYear() !== (year ?? 2000) || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) continue;
      dates.push(year === null ? `${month}月${day}日` : `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
    }
  }
  const applicationText = applicationLines.join('\n');
  const positive = dates.length > 0 || /(?:(?:付款)?申请单\s*(?:\([^\n)]*\))?\s*[:：]?\s*(?:已经|已)提交(?:全部)?|(?:已经|已)提交(?:了)?(?:付款)?申请单|是否提交(?:付款)?申请单\s*[:：]\s*(?:是|已提交))(?=$|[\s,，!！])/m.test(applicationText);
  const negative = /(?:付款)?申请单\s*[:：]?\s*(?:未|尚未|没有|待)提交|(?:未|尚未|没有|待)提交(?:付款)?申请单|是否提交(?:付款)?申请单\s*[:：]\s*(?:否|未提交)/.test(applicationText);
  const partial = /部分(?:提交|申请)|(?:提交|申请)(?:了)?部分|(?:提交(?:金额)?|申请金额)\s*[:：]?\s*\d/.test(applicationText);
  const doubtful = /预计|拟提交|待确认|待核实|疑似|可能|撤销|取消|[?？]/.test(applicationText);
  return { state: partial || (positive && (negative || doubtful)) ? 'review' : positive ? 'applied' : 'unapplied',
    explicit: positive || negative || partial, dates: [...new Set(dates)] };
}

function statusApplication(status) {
  const value = normalize(status).replace(/\s+/g, '');
  if (submittedStatuses.has(value)) return { state: 'applied', basis: `“是否提交付款申请单”为“${status}”，计已提交。` };
  if (/部分/.test(value) && /提交|申请/.test(value)) return { state: 'review', basis: '申请单状态为部分提交，但没有明确对应金额，申请金额待核对。' };
  if (/(?:已提交|已经提交|已申请)/.test(value) && /未提交|未申请|撤销|取消/.test(value)) {
    return { state: 'review', basis: '申请单状态同时包含已提交和未提交或撤销信息，申请金额待核对。' };
  }
  return { state: 'unapplied', basis: value ? `“是否提交付款申请单”为“${status}”，没有明确已提交依据，计未提交。` : '“是否提交付款申请单”为空，按未提交统计。' };
}

function result(plan, state, basis, evidence = [], applied, unapplied) {
  if (plan.unpaidCents === 0) applied = unapplied = 0;
  else if (applied === undefined) {
    applied = state === 'unapplied' ? 0 : state === 'applied' ? plan.unpaidCents : null;
    unapplied = state === 'applied' ? 0 : state === 'unapplied' ? plan.unpaidCents : null;
  }
  return { ...plan, applicationState: state, applicationBasis: basis, applicationEvidence: evidence,
    applicationDates: [...new Set(evidence.flatMap(item => item.applicationDates))],
    appliedUnpaidCents: applied, unappliedUnpaidCents: unapplied };
}

function negotiatedApplication(record, plan) {
  const direct = commentApplication(plan.sourceComment);
  const allItems = (record.applicationInstallments ?? []).map(item => ({ ...item, application: commentApplication(item.comment),
    state: item.state ?? commentPaymentState(item.comment) }));
  const items = allItems.filter(item => item.month === plan.month);
  const unassigned = allItems.filter(item => item.amountCents !== 0 && item.application.state !== 'unapplied' &&
    (!item.month || !record.plans.some(candidate => candidate.month === item.month)));
  const evidenceFor = (item, application) => ({ sourceCell: item.sourceCell, amountCents: item.amountCents,
    comment: item.comment || '', applicationState: application.state, applicationDates: application.dates });
  const evidence = [ ...(plan.sourceComment ? [evidenceFor({ ...plan, comment: plan.sourceComment }, direct)] : []),
    ...items.map(item => evidenceFor(item, item.application)), ...unassigned.filter(item => !items.includes(item)).map(item => evidenceFor(item, item.application)) ];
  const review = reason => result(plan, 'review', reason, evidence);
  if (direct.state === 'review') return review('月支付金额格的申请批注存在部分提交或矛盾，申请金额待核对。');
  if (unassigned.length) return review('有申请批注的分期无法对应明确的计划月份，申请金额待核对。');
  if (direct.state === 'applied') {
    if (items.some(item => item.amountCents !== 0 && (item.application.state === 'review' || (item.application.explicit && item.application.state === 'unapplied')))) {
      return review('月支付金额格与分期金额格的申请提交依据矛盾，申请金额待核对。');
    }
    return result(plan, 'applied', '月支付金额格批注有有效申请日期或明确申请单已提交，计该月已提交；分期不重复累加。', evidence);
  }
  const submitted = items.filter(item => item.amountCents !== 0 && item.application.state === 'applied');
  const uncertain = items.filter(item => item.amountCents !== 0 && item.application.state === 'review' && item.state !== 'paid');
  if (direct.explicit && submitted.length) return review('月支付金额格标记未提交，但分期批注标记已提交，申请金额待核对。');
  if (uncertain.length) return review('分期申请批注存在部分提交或矛盾，无法确定该月已提交金额。');
  if (!submitted.length) return result(plan, 'unapplied', '该月对应金额格没有有效申请日期或申请单已提交批注，未付金额计未提交。', evidence);
  const submittedAmount = sumApplicationAmounts(submitted, 'amountCents');
  const itemAmount = sumApplicationAmounts(items, 'amountCents');
  const inRange = (amount, total) => total >= 0 ? amount >= 0 && amount <= total : amount <= 0 && amount >= total;
  if (!inRange(itemAmount, plan.amountCents) || !inRange(submittedAmount, plan.amountCents) || items.some(item => !inRange(item.amountCents, plan.amountCents))) {
    return review('分期金额与月支付金额不一致或超出范围，无法确定申请金额。');
  }
  if (submittedAmount === plan.amountCents && items.every(item => item.amountCents === 0 || item.application.state === 'applied')) {
    return result(plan, 'applied', '该月金额均有对应分期的有效申请日期或申请单已提交批注，计已提交。', evidence);
  }
  if (plan.paidCents == null || plan.unpaidCents == null || submitted.some(item => item.state === 'uncertain')) {
    return review('该月已提交分期与已支付金额的对应关系无法确定，申请金额待核对。');
  }
  const identifiedPaid = sumApplicationAmounts(items.filter(item => item.state === 'paid'), 'amountCents');
  if (identifiedPaid !== plan.paidCents) return review('已支付金额不能完整对应到具体分期，无法确定已提交且未付金额。');
  const applied = sumApplicationAmounts(submitted.filter(item => item.state !== 'paid'), 'amountCents');
  const unapplied = sumApplicationAmounts([{ value: plan.unpaidCents }, { value: -applied }], 'value');
  if (!inRange(applied, plan.unpaidCents)) return review('已提交未付金额超出该月未付金额，申请金额待核对。');
  return result(plan, 'partial', '逐分期读取申请批注，并扣除同一金额格已支付部分；无申请依据的其余未付金额计未提交。', evidence, applied, unapplied);
}

export function classifyPlanApplications(record, plans) {
  if (['negotiated', 'negotiated_normal'].includes(record.category)) return plans.map(plan => negotiatedApplication(record, plan));
  const application = statusApplication(record.applicationStatus);
  return plans.map(plan => result(plan, application.state, application.basis));
}
