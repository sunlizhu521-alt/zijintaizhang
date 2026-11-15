const normalize = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, '').trim();
const flowKey = value => {
  const key = normalize(value).toUpperCase();
  return /^[A-Z0-9_-]{6,}$/.test(key) && /\d{5}/.test(key) ? key : '';
};

export function resolveProgressPayments(records, progress, sourceVersion = null) {
  const byFlow = new Map();
  for (const row of progress?.rows ?? []) {
    const key = flowKey(row.flowCode);
    if (!key) continue;
    if (!byFlow.has(key)) byFlow.set(key, []);
    byFlow.get(key).push(row);
  }
  const issues = [];
  const resolved = records.map(record => {
    if (['negotiated', 'negotiated_normal'].includes(record.category)) return record;
    const warn = (code, message) => issues.push({ code, message, severity: 'warning', recordKey: record.key,
      slotId: record.slotId, sourceSheet: record.sourceSheet, sourceRow: record.sourceRow });
    const key = flowKey(record.flowCode);
    const candidates = byFlow.get(key) ?? [];
    let matches = candidates;
    let reason;
    if (!progress?.available) reason = '当前付款依据缺少可用的“付款进度整理”，计未付，请核对。';
    else if (!key) reason = '没有有效流程号，无法关联“付款进度整理”，计未付，请核对。';
    else if (!candidates.length) reason = `“付款进度整理”未匹配流程号 ${record.flowCode}，计未付，请核对。`;
    else {
      matches = candidates.filter(row => row.amountCents === record.amountCents && ['supplier', 'payer'].every(field => {
        const expected = normalize(record[field]), actual = normalize(row[field]);
        return candidates.length > 1 ? expected === actual : !expected || !actual || expected === actual;
      }));
      if (!matches.length) reason = '流程号已找到，但申请金额、供应商或付款主体不一致，计未付，请核对。';
      else if (matches.length > 1) reason = new Set(matches.map(row => normalize(row.status))).size > 1
        ? '同流程号及金额、供应商、付款主体存在相互冲突的付款状态，计未付，请核对。'
        : '同流程号及金额、供应商、付款主体仍对应多笔记录，无法确定付款依据，计未付，请核对。';
    }
    const match = !reason && matches.length === 1 ? matches[0] : null;
    const paid = match && normalize(match.status) === '已付款';
    const status = match ? String(match.status ?? '').trim() : '';
    const basis = reason ?? (paid ? '“付款进度整理”的“是否已付款”为“已付款”，计已付。'
      : `“付款进度整理”的“是否已付款”${status ? `为“${status}”` : '为空'}，计未付。`);
    if (reason || !paid) warn('PAYMENT_PROGRESS_REVIEW', basis);
    const evidence = (match ? [match] : candidates).map(row => ({ ...row }));
    const plans = record.plans.map(plan => ({ ...plan, paidCents: paid ? plan.amountCents : 0,
      unpaidCents: paid ? 0 : plan.amountCents, paymentBasis: basis, paymentDates: [],
      paymentEvidence: evidence, paymentProgressVersion: sourceVersion ? { ...sourceVersion } : null }));
    if (record.category === 'normal' && record.paidCents != null &&
      plans.reduce((sum, plan) => sum + BigInt(plan.paidCents), 0n) !== BigInt(record.paidCents)) {
      warn('RULE_PAID_MISMATCH', '按付款进度整理识别的已付合计与原台账已付不同；原台账金额保留供核对，未用于推算各月付款。');
    }
    return { ...record, plans };
  });
  return { records: resolved, issues };
}
