import { CATEGORIES, LEDGER_CATEGORIES } from '../shared/constants.js';
import { buildPaymentTable, paymentPlanTotals, paymentTableTotals } from './payment-table.js';
import { describeReviewIssue } from './review-issues.js';
import { isInformationIssue } from '../shared/issue-level.js';
import { classifyPlanApplications, sumApplicationAmounts } from './payment-application.js';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const ledgerCategories = new Set(LEDGER_CATEGORIES);
const normalize = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, '').trim();
const monthNumber = value => value ? Number(value.slice(0, 4)) * 12 + Number(value.slice(5)) - 1 : null;

function add(a, b) {
  const result = a + b;
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(result)) throw Object.assign(new Error('汇总金额超过可安全计算范围。'), { status: 422 });
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

function scopedRecord(record, plans) {
  const selectedPlans = classifyPlanApplications(record, plans);
  const totals = paymentTableTotals(selectedPlans);
  const states = new Set(selectedPlans.map(plan => plan.applicationState));
  const applicationState = states.has('review') ? 'review' : states.size === 1 ? [...states][0] : 'partial';
  const applicationEvidence = [...new Map(selectedPlans.flatMap(plan => plan.applicationEvidence)
    .map(item => [JSON.stringify([item.sourceCell, item.amountCents, item.comment]), item])).values()];
  return { ...record, applicationState,
    applicationBasis: selectedPlans.map(plan => `${plan.month || '时间待定'}：${plan.applicationBasis}`).join('\n'),
    applicationEvidence, applicationDates: [...new Set(selectedPlans.flatMap(plan => plan.applicationDates))],
    selectedPlans, selectedPlanCents: totals.totalCents,
    selectedPaidCents: totals.paidCents, selectedUnpaidCents: totals.unpaidCents,
    selectedAppliedUnpaidCents: sumApplicationAmounts(selectedPlans, 'appliedUnpaidCents'),
    selectedUnappliedUnpaidCents: totals.unappliedUnpaidCents };
}

function supplierGroups(records) {
  const grouped = new Map();
  for (const record of records) {
    const supplier = String(record.supplier ?? '').trim();
    if (!grouped.has(supplier)) grouped.set(supplier, { supplier, categories: [], months: [], records: [] });
    const group = grouped.get(supplier);
    group.records.push(record);
    if (!group.categories.includes(record.category)) group.categories.push(record.category);
    for (const plan of record.selectedPlans) if (!group.months.includes(plan.month ?? null)) group.months.push(plan.month ?? null);
  }
  return [...grouped.values()].map(group => {
    const totals = paymentPlanTotals(group.records.flatMap(record => record.selectedPlans));
    group.months.sort((a, b) => a === null ? 1 : b === null ? -1 : a.localeCompare(b));
    return { ...group, amountCents: totals.totalCents, paidCents: totals.paidCents, unpaidCents: totals.unpaidCents, uncertainCount: totals.uncertainCount };
  });
}

export function buildDashboard(records, issues = [], slots = [], filters = {}) {
  validateFilters(filters);
  const relevant = records.filter(record => ['supplier', 'payer', 'owner', 'category'].every(name =>
    !filters[name] || normalize(record[name]) === normalize(filters[name])));
  const pending = filters.month === 'pending';
  const monthMatches = month => pending ? month === null : month !== null &&
    (filters.month ? month === filters.month : (!filters.from || month >= filters.from) && (!filters.to || month <= filters.to));
  const select = matches => relevant.flatMap(record => {
    const plans = record.plans.filter(plan => matches(plan.month));
    return plans.length ? [scopedRecord(record, plans)] : [];
  });
  const selectedRecords = select(monthMatches);
  const pendingRecords = pending ? selectedRecords : select(month => month === null);
  const plans = selectedRecords.flatMap(record => record.selectedPlans);
  const totals = paymentPlanTotals(plans);
  const applicationReviewRecords = selectedRecords.filter(record => record.selectedPlans.some(plan => plan.applicationState === 'review' && plan.unappliedUnpaidCents === null));
  const summary = {
    planCents: totals.totalCents, paidCents: totals.paidCents, remainingCents: totals.unpaidCents,
    appliedUnpaidCents: sumApplicationAmounts(plans, 'appliedUnpaidCents'),
    unappliedUnpaidCents: paymentTableTotals(plans).unappliedUnpaidCents,
    applicationReviewCount: applicationReviewRecords.length,
    applicationReviewCents: paymentPlanTotals(applicationReviewRecords.flatMap(record => record.selectedPlans)
      .filter(plan => plan.applicationState === 'review' && plan.unappliedUnpaidCents === null)).unpaidCents,
    uncertainCount: totals.uncertainCount,
    forecastCents: { shipment: 0, after_sales: 0, unregistered: 0 },
    pendingPlanCents: 0, pendingForecastCents: { shipment: 0, after_sales: 0, unregistered: 0 },
    missingPaidCount: selectedRecords.filter(record => record.selectedPaidCents === null).length,
    missingRemainingCount: selectedRecords.filter(record => record.selectedUnpaidCents === null).length,
    ledgerRecordCount: selectedRecords.filter(record => ledgerCategories.has(record.category)).length,
    missingSourceCount: slots.filter(slot => !slot.currentVersionId).length,
    scopeLabel: pending ? '时间待定范围，包含三类预估；已付和未付按付款依据统计。' : '所选期间，包含三类预估，不含时间待定；已付和未付按付款依据统计。',
  };
  const monthly = new Map();
  for (const record of selectedRecords) {
    if (!ledgerCategories.has(record.category)) summary.forecastCents[record.category] = add(summary.forecastCents[record.category], record.selectedPlanCents);
    for (const plan of record.selectedPlans) {
      const month = plan.month ?? 'pending';
      if (!monthly.has(month)) monthly.set(month, { month, ...Object.fromEntries(Object.keys(CATEGORIES).map(category => [category, 0])) });
      const line = monthly.get(month);
      line[record.category] = add(line[record.category], plan.amountCents);
    }
  }
  for (const record of pendingRecords) {
    if (ledgerCategories.has(record.category)) summary.pendingPlanCents = add(summary.pendingPlanCents, record.selectedPlanCents);
    else summary.pendingForecastCents[record.category] = add(summary.pendingForecastCents[record.category], record.selectedPlanCents);
  }
  const reviewableRecords = records.filter(record => !normalize(record.flowCode).includes('不支付'));
  const recordsByKey = new Map(reviewableRecords.map(record => [record.key, record]));
  const relevantKeys = new Set(selectedRecords.filter(record => recordsByKey.has(record.key)).map(record => record.key));
  // 从当前需核对记录重建重复提示，避免缓存仍将“不支付”记录列为关联项。
  const combinedIssues = [...issues.filter(issue => !['DUPLICATE_FLOW', 'POSSIBLE_DUPLICATE'].includes(issue.code)), ...findDuplicateIssues(reviewableRecords),
    ...applicationReviewRecords.map(record => issueFor(record, 'APPLICATION_PARTIAL_REVIEW', record.applicationBasis))].filter(issue =>
    !issue.recordKey || relevantKeys.has(issue.recordKey));
  for (const slot of slots) if (!slot.currentVersionId) combinedIssues.push({
    code: 'MISSING_FILE', severity: 'warning', message: `${slot.label}尚未上传有效文件，相关金额未包含该来源。`,
    slotId: slot.id, sourceSheet: '', sourceRow: null,
  });
  const uniqueIssues = [...new Map(combinedIssues.map(issue =>
    [JSON.stringify([issue.code, issue.recordKey, issue.slotId, issue.message]), issue])).values()]
    .map(issue => describeReviewIssue(issue, recordsByKey));
  const option = field => [...new Set(records.map(record => record[field]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const months = [...monthly.values()].sort((a, b) => a.month === 'pending' ? 1 : b.month === 'pending' ? -1 : a.month.localeCompare(b.month));
  const groups = supplierGroups(selectedRecords);
  const issuesByRecord = new Map();
  for (const issue of uniqueIssues) {
    if (!issue.recordKey || isInformationIssue(issue)) continue;
    if (!issuesByRecord.has(issue.recordKey)) issuesByRecord.set(issue.recordKey, []);
    issuesByRecord.get(issue.recordKey).push(issue);
  }
  const reviews = new Map();
  for (const record of selectedRecords) {
    const reviewIssues = issuesByRecord.get(record.key);
    if (!reviewIssues) continue;
    if (!reviews.has(record.supplier)) reviews.set(record.supplier, { supplier: record.supplier, totalCents: 0, records: [], reviewIssues: [] });
    const group = reviews.get(record.supplier);
    group.totalCents = add(group.totalCents, record.amountCents);
    group.reviewIssues.push(...reviewIssues);
    const reviewBalanceMismatch = record.paidCents != null && record.remainingCents != null &&
      BigInt(record.paidCents) + BigInt(record.remainingCents) !== BigInt(record.amountCents);
    group.records.push({ ...record, reviewBalanceMismatch, reviewIssues,
      reviewRemainingCents: record.remainingCents ?? (record.paidCents == null ? null : add(record.amountCents, -record.paidCents)) });
  }
  const updatedAt = slots.filter(slot => slot.currentVersionId).map(slot => Number.isFinite(Date.parse(slot.updatedAt)) ? slot.updatedAt : slot.uploadedAt)
    .filter(value => Number.isFinite(Date.parse(value)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? new Date().toISOString();
  return {
    summary,
    months,
    paymentTable: buildPaymentTable(selectedRecords, months.filter(row => row.month !== 'pending').map(row => row.month), slots),
    pendingPaymentTable: buildPaymentTable(pendingRecords, ['pending'], slots),
    records: selectedRecords,
    pendingRecords,
    supplierGroups: groups,
    pendingSupplierGroups: pending ? groups : supplierGroups(pendingRecords),
    topSuppliers: groups.filter(group => group.unpaidCents !== null && group.unpaidCents > 0)
      .sort((a, b) => b.unpaidCents - a.unpaidCents || a.supplier.localeCompare(b.supplier, 'zh-CN'))
      .slice(0, 10).map(({ supplier, unpaidCents, uncertainCount }) => ({ supplier, unpaidCents, uncertainCount })),
    monthlyTrend: months.filter(row => row.month !== 'pending').map(({ month }) => ({ month,
      ...paymentPlanTotals(plans.filter(plan => plan.month === month)) })),
    appliedUnpaidRecords: selectedRecords.filter(record => record.selectedAppliedUnpaidCents !== 0 && record.selectedAppliedUnpaidCents !== null),
    reviewSuppliers: [...reviews.values()],
    issues: uniqueIssues,
    reviewIssues: uniqueIssues.filter(issue => !isInformationIssue(issue)),
    notices: uniqueIssues.filter(isInformationIssue),
    options: { suppliers: option('supplier'), payers: option('payer'), owners: option('owner'),
      months: [...new Set(records.flatMap(record => record.plans.map(plan => plan.month)).filter(Boolean))].sort() },
    slots, updatedAt,
  };
}
