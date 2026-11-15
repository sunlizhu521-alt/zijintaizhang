const normalize = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, '').trim();

export function isArchived(status) {
  return ['归档', '已归档'].includes(normalize(status));
}

export function commentPaymentState(comment) {
  const text = String(comment ?? '').normalize('NFKC');
  const paid = /已支付|已付款|已付/.test(text);
  const unpaid = /未支付|未付款|未付/.test(text);
  if (!paid) return /部分(?:付款|支付)|(?:付款|支付)部分/.test(text) ? 'uncertain' : unpaid ? 'unpaid' : 'none';
  if (unpaid || /部分|分次|尚未|未确认|未完成|取消|撤销|退款|退回|冲正|失败|预计|拟付|待确认|待核实|疑似|可能|是否|[?？]/.test(text)) return 'uncertain';
  const lines = text.split(/[\n\r;；。]/);
  const completed = lines.some(line => {
    const match = line.match(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日\s*(?:核实|确认|实际)?\s*[-—－:：,，]?\s*(?:已支付|已付款|已付)(?=$|[\s，,！!])/);
    if (!match) return false;
    const year = Number(match[1] || 2000), month = Number(match[2]), day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  });
  return completed ? 'paid' : 'uncertain';
}

export function classifyPlanPayments({ category, status, plans, installments = [], warn }) {
  const forecast = !['negotiated', 'negotiated_normal', 'normal'].includes(category);
  if (category !== 'negotiated') {
    const paid = !forecast && isArchived(status);
    for (const plan of plans) {
      plan.paidCents = paid ? plan.amountCents : 0;
      plan.unpaidCents = paid ? 0 : plan.amountCents;
      plan.paymentBasis = forecast ? '预估金额全部计入未付。' : paid ? `流程状态为“${String(status).trim()}”，按该笔计划金额计已付。` : '流程状态不是归档或已归档，按该笔计划金额计未付。';
      plan.paymentEvidence = [];
    }
    return;
  }
  const relevant = installments.filter(item => ['paid', 'uncertain'].includes(item.state));
  const unassigned = relevant.filter(item => !item.month || !plans.some(plan => plan.month === item.month));
  for (const plan of plans) {
    const items = installments.filter(item => item.month && item.month === plan.month);
    const paidItems = items.filter(item => item.state === 'paid');
    const direct = commentPaymentState(plan.sourceComment);
    const evidence = [...(direct !== 'none' ? [{ sourceCell: plan.sourceCell, amountCents: plan.amountCents, comment: plan.sourceComment }] : []), ...items.filter(item => item.state !== 'none').map(({ sourceCell, amountCents, comment }) => ({ sourceCell, amountCents, comment }))];
    const unresolved = unassigned.length || direct === 'uncertain' || items.some(item => item.state === 'uncertain') ||
      (direct === 'paid' && items.some(item => item.state === 'unpaid')) || (direct === 'unpaid' && paidItems.length);
    let paid = direct === 'paid' ? BigInt(plan.amountCents) : paidItems.reduce((sum, item) => sum + BigInt(item.amountCents), 0n);
    const total = BigInt(plan.amountCents);
    const outOfRange = total >= 0n ? paid < 0n || paid > total : paid > 0n || paid < total;
    if (unresolved || outOfRange) {
      plan.paidCents = null;
      plan.unpaidCents = null;
      plan.paymentBasis = unassigned.length ? '已付批注所在分期无法对应月支付列，已付与未付待核对。' : outOfRange ? '批注识别的已付金额超出该月金额范围，已付与未付待核对。' : '批注存在部分付款、缺少明确日期或状态矛盾，已付与未付待核对。';
      plan.paymentEvidence = [...evidence, ...unassigned.map(({ sourceCell, amountCents, comment }) => ({ sourceCell, amountCents, comment }))];
      warn('PAYMENT_STATUS_UNCERTAIN', `${plan.month || '时间待定'}：${plan.paymentBasis} 来源：${plan.paymentEvidence.map(item => item.sourceCell).filter(Boolean).join('、') || '原表批注'}。`);
    } else {
      plan.paidCents = Number(paid);
      plan.unpaidCents = Number(total - paid);
      plan.paymentBasis = direct === 'paid' ? '月支付金额格有明确日期及已付批注，整格金额计已付；分期标记不重复累加。' : paidItems.length ? '按分期金额格中明确日期及已付批注识别已付，其他金额计未付；月份按计划列归属。' : '没有明确日期及已付批注，该月金额全部计未付。';
      plan.paymentEvidence = evidence;
    }
  }
}
