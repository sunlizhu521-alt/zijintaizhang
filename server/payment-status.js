export function commentPaymentDates(comment) {
  const dates = [];
  const paymentText = String(comment ?? '').normalize('NFKC').replace(/(?:申请|提交)(?:日期|时间)[^，,;；\n\r。]*/g, '');
  for (const line of paymentText.split(/[\n\r;；。]/)) {
    for (const match of line.matchAll(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日\s*(?:核实|确认|实际)?\s*[-—－:：,，]?\s*(?:已支付|已付款|已付)(?=$|[\s，,！!])/g)) {
      const year = match[1] ? Number(match[1]) : null, month = Number(match[2]), day = Number(match[3]);
      // 缺年份只校验月日，不把用于闰日校验的年份写入付款日期。
      const checkYear = year ?? 2000;
      const date = new Date(Date.UTC(checkYear, month - 1, day));
      if ((year !== null && (year < 1900 || year > 9999)) || date.getUTCFullYear() !== checkYear || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) continue;
      dates.push(year === null ? `${month}月${day}日` : `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
    }
  }
  return [...new Set(dates)];
}

export function commentPaymentState(comment) {
  const text = String(comment ?? '').normalize('NFKC');
  const paid = /已支付|已付款|已付/.test(text);
  const unpaid = /未支付|未付款|未付/.test(text);
  if (!paid) return /部分(?:付款|支付)|(?:付款|支付)部分/.test(text) ? 'uncertain' : unpaid ? 'unpaid' : 'none';
  if (unpaid || /部分|分次|尚未|未确认|未完成|取消|撤销|退款|退回|冲正|失败|预计|拟付|待确认|待核实|疑似|可能|是否|[?？]/.test(text)) return 'uncertain';
  return commentPaymentDates(text).length ? 'paid' : 'uncertain';
}

export function classifyPlanPayments({ category, plans, installments = [], warn }) {
  if (!['negotiated', 'negotiated_normal'].includes(category)) {
    for (const plan of plans) {
      plan.paidCents = 0;
      plan.unpaidCents = plan.amountCents;
      plan.paymentBasis = '需关联当前付款节奏的“付款进度整理”；未明确匹配已付款前计未付。';
      plan.paymentEvidence = [];
      plan.paymentDates = [];
    }
    return;
  }
  const relevant = installments.filter(item => ['paid', 'uncertain'].includes(item.state));
  const unassigned = relevant.filter(item => !item.month || !plans.some(plan => plan.month === item.month));
  for (const plan of plans) {
    const items = installments.filter(item => item.month && item.month === plan.month);
    const paidItems = items.filter(item => item.state === 'paid');
    const direct = commentPaymentState(plan.sourceComment);
    const evidenceFor = ({ sourceCell, amountCents, comment }) => ({ sourceCell, amountCents, comment, paymentDates: commentPaymentDates(comment) });
    const evidence = [...(direct !== 'none' ? [evidenceFor({ sourceCell: plan.sourceCell, amountCents: plan.amountCents, comment: plan.sourceComment })] : []), ...items.filter(item => item.state !== 'none').map(evidenceFor)];
    const unresolved = unassigned.length || direct === 'uncertain' || items.some(item => item.state === 'uncertain') ||
      (direct === 'paid' && items.some(item => item.state === 'unpaid')) || (direct === 'unpaid' && paidItems.length);
    let paid = direct === 'paid' ? BigInt(plan.amountCents) : paidItems.reduce((sum, item) => sum + BigInt(item.amountCents), 0n);
    const total = BigInt(plan.amountCents);
    const outOfRange = total >= 0n ? paid < 0n || paid > total : paid > 0n || paid < total;
    if (unresolved || outOfRange) {
      plan.paidCents = null;
      plan.unpaidCents = null;
      plan.paymentBasis = unassigned.length ? '已付批注所在分期无法对应月支付列，已付与未付待核对。' : outOfRange ? '批注识别的已付金额超出该月金额范围，已付与未付待核对。' : '批注存在部分付款、缺少明确日期或状态矛盾，已付与未付待核对。';
      plan.paymentEvidence = [...evidence, ...unassigned.map(evidenceFor)];
      warn('PAYMENT_STATUS_UNCERTAIN', `${plan.month || '时间待定'}：${plan.paymentBasis} 来源：${plan.paymentEvidence.map(item => item.sourceCell).filter(Boolean).join('、') || '原表批注'}。`);
    } else {
      plan.paidCents = Number(paid);
      plan.unpaidCents = Number(total - paid);
      plan.paymentBasis = direct === 'paid' ? '月支付金额格有明确日期及已付批注，整格金额计已付；分期标记不重复累加。' : paidItems.length ? '按分期金额格中明确日期及已付批注识别已付，其他金额计未付；月份按计划列归属。' : '没有明确日期及已付批注，该月金额全部计未付。';
      plan.paymentEvidence = evidence;
    }
    plan.paymentDates = [...new Set(plan.paymentEvidence.flatMap(item => item.paymentDates))];
  }
}
