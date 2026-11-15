import { CATEGORIES, LEDGER_CATEGORIES, SLOTS } from '../shared/constants.js';

const forecasts = ['shipment', 'after_sales', 'unregistered'];
const normal = ['negotiated_normal', 'normal', ...forecasts];
const leaf = (id, parentId, depth) => ({ id, label: CATEGORIES[id], parentId, depth, categories: [id] });
const rows = [
  { id: 'negotiated_group', label: '谈判付款', parentId: null, depth: 0, categories: ['negotiated'] },
  leaf('negotiated', 'negotiated_group', 1),
  { id: 'normal_group', label: '正常付款（含预估）', parentId: null, depth: 0, categories: normal },
  leaf('negotiated_normal', 'normal_group', 1), leaf('normal', 'normal_group', 1),
  { id: 'forecast_group', label: '预估合计', parentId: 'normal_group', depth: 1, categories: forecasts },
  ...forecasts.map(id => leaf(id, 'forecast_group', 2)),
  { id: 'total', label: '总合计', parentId: null, depth: 0, categories: Object.keys(CATEGORIES) },
];
const emptyCell = () => ({ paidCents: 0, unpaidCents: 0, totalCents: 0, uncertainCount: 0 });

function add(a, b) {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(a + b)) {
    throw Object.assign(new Error('月度付款金额超过可安全计算范围或不是整数分。'), { status: 422 });
  }
  return a + b;
}

export function paymentPlanTotals(plans) {
  const result = emptyCell();
  for (const plan of plans) {
    result.totalCents = add(result.totalCents, plan.amountCents);
    if (plan.paidCents == null || plan.unpaidCents == null) {
      result.paidCents = result.unpaidCents = null;
      result.uncertainCount++;
    } else {
      if (add(plan.paidCents, plan.unpaidCents) !== plan.amountCents) {
        throw Object.assign(new Error('月度已付加未付与计划金额不一致，请重新解析文件。'), { status: 422 });
      }
      if (result.paidCents !== null) result.paidCents = add(result.paidCents, plan.paidCents);
      if (result.unpaidCents !== null) result.unpaidCents = add(result.unpaidCents, plan.unpaidCents);
    }
  }
  return result;
}

export function buildPaymentTable(records, months, slots) {
  const uploaded = new Set(slots.filter(slot => slot.currentVersionId).map(slot => slot.id));
  const slotNames = Object.fromEntries(SLOTS.map(slot => [slot.id, slot.label]));
  // 父级始终从原始分类求和，不累加已包含子级的中间合计。
  return { months, rows: rows.map(row => {
    const sourceSlots = [...new Set(row.categories.map(category => LEDGER_CATEGORIES.includes(category) ? 'schedule' : category))];
    const plans = records.filter(record => row.categories.includes(record.category)).flatMap(record => record.selectedPlans);
    const monthly = Object.fromEntries(months.map(month => [month, []]));
    const dated = [];
    for (const plan of plans) {
      monthly[plan.month || 'pending'].push(plan);
      if (plan.month) dated.push(plan);
    }
    return { ...row, available: sourceSlots.some(slot => uploaded.has(slot)),
      missingSources: sourceSlots.filter(slot => !uploaded.has(slot)).map(slot => slotNames[slot]),
      cells: Object.fromEntries(months.map(month => [month, paymentPlanTotals(monthly[month])])),
      period: paymentPlanTotals(dated) };
  }) };
}
