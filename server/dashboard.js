import { CATEGORIES } from '../shared/constants.js';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const ledgerCategories = new Set(['normal', 'negotiated']);
const normalize = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, '').trim();
const monthNumber = value => value ? Number(value.slice(0, 4)) * 12 + Number(value.slice(5)) - 1 : null;

function add(a, b) {
  const result = a + b;
  if (!Number.isSafeInteger(result)) throw Object.assign(new Error('汇总金额超过可安全计算范围。'), { status: 422 });
  return result;
}

function issueFor(record, code, message, relatedRecordKeys) {
  return { code, severity: 'warning', message, sourceSheet: record.sourceSheet, sourceRow: record.sourceRow,
    recordKey: record.key, slotId: record.slotId, ...(relatedRecordKeys ? { relatedRecordKeys } : {}) };
}

export function findDuplicateIssues(records) {
  const issues = [];
  const flows = new Map();
  const amounts = new Map();
  for (const record of records) {
    const code = normalize(record.flowCode).toUpperCase();
    if (/^[A-Z0-9_-]{6,}$/.test(code) && /\d{5}/.test(code)) {
      if (!flows.has(code)) flows.set(code, []);
      flows.get(code).push(record);
    }
    for (const plan of record.plans) {
      // 零金额不构成重复付款线索。
      if (!plan.amountCents) continue;
      const key = JSON.stringify([normalize(record.supplier), normalize(record.payer), plan.amountCents]);
      if (!amounts.has(key)) amounts.set(key, new Map());
      const months = amounts.get(key);
      const month = monthNumber(plan.month);
      if (!months.has(month)) months.set(month, new Map());
      months.get(month).set(record.key, record);
    }
  }
  for (const group of flows.values()) {
    if (group.length < 2) continue;
    for (const record of group) issues.push(issueFor(record, 'DUPLICATE_FLOW',
      `相同流程号出现在 ${group.length} 条记录中，请核对是否为分笔记录或重复登记；未自动删除。`,
      group.filter(other => other.key !== record.key).slice(0, 10).map(other => other.key)));
  }
  const flagged = new Set();
  for (const months of amounts.values()) {
    for (const [month, group] of months) {
      const nearby = month === null ? [null] : [month - 1, month, month + 1];
      for (const record of group.values()) {
        if (flagged.has(record.key)) continue;
        const related = new Set();
        for (const candidateMonth of nearby) {
          for (const candidate of months.get(candidateMonth)?.values() ?? []) {
            if (candidate.key !== record.key) related.add(candidate.key);
            if (related.size >= 10) break;
          }
          if (related.size >= 10) break;
        }
        if (related.size) {
          flagged.add(record.key);
          issues.push(issueFor(record, 'POSSIBLE_DUPLICATE',
            '供应商、付款主体、计划金额相同，且月份相同或相邻（或均未明确）；可能重叠，请人工核对。', [...related]));
        }
      }
    }
  }
  return issues;
}

function validateFilters(filters) {
  for (const name of ['from', 'to', 'month', 'supplier', 'payer', 'owner', 'category']) {
    if (filters[name] !== undefined && typeof filters[name] !== 'string') {
      throw Object.assign(new Error(`筛选条件 ${name} 格式不正确。`), { status: 400 });
    }
  }
  for (const name of ['from', 'to', 'month']) {
    const value = filters[name];
    if (value && !(name === 'month' && value === 'pending') && !MONTH.test(value)) {
      throw Object.assign(new Error('月份须为 YYYY-MM 格式。'), { status: 400 });
    }
  }
  if (filters.from && filters.to && filters.from > filters.to) {
    throw Object.assign(new Error('开始月份不能晚于结束月份。'), { status: 400 });
  }
  if (filters.category && !Object.hasOwn(CATEGORIES, filters.category)) {
    throw Object.assign(new Error('数据类别不正确。'), { status: 400 });
  }
}

export function buildDashboard(records, issues = [], slots = [], filters = {}) {
  validateFilters(filters);
  const relevant = records.filter(record => ['supplier', 'payer', 'owner', 'category'].every(name =>
    !filters[name] || normalize(record[name]) === normalize(filters[name])));
  const monthMatches = month => {
    if (filters.month) return filters.month === 'pending' ? month === null : month === filters.month;
    // 未明确月份始终单列，且不计入期间金额卡片。
    return month === null || ((!filters.from || month >= filters.from) && (!filters.to || month <= filters.to));
  };
  const summary = {
    planCents: 0, paidCents: 0, remainingCents: 0,
    forecastCents: { shipment: 0, after_sales: 0, unregistered: 0 },
    pendingPlanCents: 0, pendingForecastCents: { shipment: 0, after_sales: 0, unregistered: 0 },
    missingPaidCount: 0, missingRemainingCount: 0, ledgerRecordCount: 0,
    missingSourceCount: slots.filter(slot => !slot.currentVersionId).length,
    scopeLabel: '付款计划按所选月份；台账累计已付与剩余仅受供应商、付款主体、跟单员、类别筛选，不受月份筛选。',
  };
  const monthly = new Map();
  const selectedRecords = [];
  for (const record of relevant) {
    if (ledgerCategories.has(record.category)) {
      summary.ledgerRecordCount++;
      if (record.paidCents === null) summary.missingPaidCount++;
      else summary.paidCents = add(summary.paidCents, record.paidCents);
      if (record.remainingCents === null) summary.missingRemainingCount++;
      else summary.remainingCents = add(summary.remainingCents, record.remainingCents);
    }
    const plans = record.plans.filter(plan => monthMatches(plan.month));
    if (!plans.length) continue;
    let selectedPlanCents = 0;
    for (const plan of plans) {
      selectedPlanCents = add(selectedPlanCents, plan.amountCents);
      const month = plan.month ?? 'pending';
      if (!monthly.has(month)) monthly.set(month, { month, normal: 0, negotiated: 0, shipment: 0, after_sales: 0, unregistered: 0 });
      const line = monthly.get(month);
      line[record.category] = add(line[record.category], plan.amountCents);
      if (ledgerCategories.has(record.category)) {
        const target = plan.month === null ? 'pendingPlanCents' : 'planCents';
        summary[target] = add(summary[target], plan.amountCents);
      } else {
        const target = plan.month === null ? summary.pendingForecastCents : summary.forecastCents;
        target[record.category] = add(target[record.category], plan.amountCents);
      }
    }
    selectedRecords.push({ ...record, selectedPlanCents, selectedPlans: plans });
  }
  const relevantKeys = new Set(relevant.map(record => record.key));
  const combinedIssues = [...issues, ...findDuplicateIssues(records)].filter(issue =>
    !issue.recordKey || relevantKeys.has(issue.recordKey));
  for (const slot of slots) if (!slot.currentVersionId) combinedIssues.push({
    code: 'MISSING_FILE', severity: 'warning', message: `${slot.label}尚未上传有效文件，相关金额未包含该来源。`,
    slotId: slot.id, sourceSheet: '', sourceRow: null,
  });
  const uniqueIssues = [...new Map(combinedIssues.map(issue =>
    [JSON.stringify([issue.code, issue.recordKey, issue.slotId, issue.message]), issue])).values()];
  const option = field => [...new Set(records.map(record => record[field]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  return {
    summary,
    months: [...monthly.values()].sort((a, b) => a.month === 'pending' ? 1 : b.month === 'pending' ? -1 : a.month.localeCompare(b.month)),
    records: selectedRecords,
    issues: uniqueIssues,
    options: { suppliers: option('supplier'), payers: option('payer'), owners: option('owner'),
      months: [...new Set(records.flatMap(record => record.plans.map(plan => plan.month)).filter(Boolean))].sort() },
    slots,
  };
}
