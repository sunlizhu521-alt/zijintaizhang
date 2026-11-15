const normalize = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, '');
const selectedPlans = record => record.selectedPlans ?? record.plans ?? [];

function sum(values) {
  const result = values.reduce((total, value) => total + BigInt(value), 0n);
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('汇总金额超过可安全计算范围。');
  return Number(result);
}

export function groupSuppliers(records = []) {
  const groups = new Map();
  for (const record of records) {
    const supplier = String(record.supplier ?? '').trim();
    if (!groups.has(supplier)) groups.set(supplier, { supplier, categories: [], months: [], amountCents: 0, records: [] });
    const group = groups.get(supplier);
    group.records.push(record);
    if (!group.categories.includes(record.category)) group.categories.push(record.category);
    for (const plan of selectedPlans(record)) if (!group.months.includes(plan.month ?? null)) group.months.push(plan.month ?? null);
  }
  for (const group of groups.values()) {
    group.amountCents = sum(group.records.map(record => record.selectedPlanCents ?? sum(selectedPlans(record).map(plan => plan.amountCents))));
    group.months.sort((a, b) => a === null ? 1 : b === null ? -1 : a.localeCompare(b));
  }
  return [...groups.values()];
}

function rawField(raw, names) {
  for (const name of names) {
    const entry = Object.entries(raw).find(([key]) => normalize(key) === name);
    if (entry && entry[1] !== null && entry[1] !== undefined && String(entry[1]).trim() !== '') return String(entry[1]);
  }
  return '';
}

function installmentDate(header) {
  const text = normalize(header).replace(/\(\d+\)$/, '');
  const match = text.match(/^(?:(\d{4})[年/.-])?(\d{1,2})[月/.-](\d{1,2})(?:日)?(?:T00:00:00(?:\.000)?Z)?$/);
  if (!match) return null;
  const year = match[1] ? Number(match[1]) : 2000, month = Number(match[2]), day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1900 || year > 9999 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return match[1] ? `${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : `${month}月${day}日`;
}

// 日期金额列保留元值；仅在展示时换算成分，不重新计算月度付款或付款状态。
function installmentMoney(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  let text = String(value).normalize('NFKC').trim().replace(/^[¥￥]\s*/, '').replace(/\s*元$/, '');
  if (/^\(.*\)$/.test(text)) text = `-${text.slice(1, -1)}`;
  if (typeof value === 'number' && /e/i.test(text)) text = value.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text) || text.length > 80) return null;
  const [whole, fraction = ''] = text.replaceAll(',', '').replace(/^[+-]/, '').split('.');
  let cents = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
  if (Number(fraction[2] ?? 0) >= 5) cents++;
  if (text.startsWith('-')) cents = -cents;
  return cents > BigInt(Number.MAX_SAFE_INTEGER) || cents < BigInt(Number.MIN_SAFE_INTEGER) ? null : Number(cents);
}

export function supplierRecordDetails(record) {
  const raw = record.raw ?? {};
  const installments = Object.entries(raw).flatMap(([header, value]) => {
    const date = installmentDate(header);
    return date && value != null && String(value).trim() !== '' ? [{ date, amountCents: installmentMoney(value) }] : [];
  });
  const declaredCount = rawField(raw, ['分几批', '分批次数', '分期次数']);
  const countMatch = declaredCount.normalize('NFKC').trim().match(/^(\d+)\s*(?:批|次|期)?$/);
  const plans = selectedPlans(record);
  const unknownPlans = !plans.length || plans.some(plan => plan.paidCents == null || plan.unpaidCents == null);
  const paidCents = Object.hasOwn(record, 'selectedPaidCents') ? record.selectedPaidCents : unknownPlans ? null : sum(plans.map(plan => plan.paidCents));
  const unpaidCents = Object.hasOwn(record, 'selectedUnpaidCents') ? record.selectedUnpaidCents : unknownPlans ? null : sum(plans.map(plan => plan.unpaidCents));
  const uncertain = unknownPlans || paidCents == null || unpaidCents == null;
  const paymentStatus = uncertain ? '待核对' : plans.every(plan => plan.amountCents === 0) ? '金额为0' :
    plans.every(plan => plan.unpaidCents === 0) ? '已支付' : plans.every(plan => plan.paidCents === 0) ? '未支付' : '部分已支付';
  return {
    negotiation: rawField(raw, ['谈判明细']),
    installmentFlag: rawField(raw, ['是否谈判分批', '是否分批']),
    installmentCount: countMatch ? Number(countMatch[1]) : installments.length || null,
    installmentCountSource: countMatch ? 'declared' : installments.length ? 'dated_columns' : null,
    installments,
    applicationStatus: rawField(raw, ['是否提交付款申请单', '是否已申请', '是否申请']) || record.applicationStatus || '',
    currentNode: record.currentNode || rawField(raw, ['当前节点']),
    paymentStatus, paidCents, unpaidCents,
    remark: rawField(raw, ['孙立柱备注']),
  };
}
