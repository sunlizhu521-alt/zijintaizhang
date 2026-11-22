import { commentPaymentDates, commentPaymentState } from './payment-status.js';
import { oaFlowKey } from './oa-parser.js';

const bad = message => Object.assign(new Error(message), { status: 400 });
export const beijingDate = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
export function analysisFilters(query, today = beijingDate()) {
  const filters = {};
  for (const key of ['year', 'supplier', 'payer', 'detailMonth', 'detailSupplier', 'supplierSearch', 'flowCode', 'paymentState']) {
    const value = query[key];
    if (value == null) continue;
    if (typeof value !== 'string' || value.length > 250) throw bad('筛选条件无效');
    filters[key] = value.trim();
  }
  filters.year ||= today.slice(0, 4);
  if (!/^\d{4}$/.test(filters.year) || +filters.year < 1900 || +filters.year > +today.slice(0, 4)) throw bad('年份无效');
  if (filters.detailMonth && (!/^\d{4}-(0[1-9]|1[0-2])$/.test(filters.detailMonth) || ![+filters.year, +filters.year - 1].includes(+filters.detailMonth.slice(0, 4)))) throw bad('明细月份不在对比年份范围');
  if (filters.paymentState && !['paid', 'unpaid', 'review'].includes(filters.paymentState)) throw bad('付款状态无效');
  return filters;
}
export function sumCents(rows, field = 'amountCents') {
  const value = rows.reduce((total, row) => total + BigInt(row[field] ?? 0), 0n);
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw Object.assign(new Error('汇总金额超过安全计算范围，请缩小范围。'), { status: 422 });
  return Number(value);
}
function paymentEvents(oa, schedule, today) {
  const events = [], issues = [];
  const flows = new Map(oa.records.filter(r => r.flowKey).map(r => [r.flowKey, r]));
  const negotiation = schedule.records.filter(r => ['negotiated', 'negotiated_normal'].includes(r.category));
  const overridden = new Set(negotiation.map(r => oaFlowKey(r.flowCode)).filter(Boolean));
  const issue = (r, message, extra = {}) => issues.push({ supplier: r.supplier, payer: r.payer, flowCode: r.flowCode,
    filename: r.filename, versionId: r.versionId, sourceSheet: r.sourceSheet, sourceRow: r.sourceRow, message, ...extra });
  const add = (r, date, amountCents, basis, extra = {}) => {
    if (!Number.isSafeInteger(amountCents)) { issue(r, '已付金额无法确定，请核对原始金额格。', extra); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) { issue(r, '已付金额没有唯一完整付款日期，不猜年份，暂未进入年月统计。', { amountCents, ...extra }); return; }
    if (date > today) { issue(r, '付款日期晚于今天，请核对；暂未计入实际已付。', { amountCents, paymentDate: date, ...extra }); return; }
    events.push({ id: `${r.versionId || ''}:${r.key}:${extra.sourceCell || 'oa'}`, supplier: r.supplier, payer: r.payer,
      flowCode: r.flowCode, summary: r.summary, amountCents, paymentDate: date, basis,
      filename: r.filename, versionId: r.versionId, sourceSheet: r.sourceSheet, sourceRow: r.sourceRow, ...extra });
    if (amountCents < 0) issue(r, '负金额按原值计入，请确认是否为退款或冲减。', { paymentDate: date, amountCents });
  };
  for (const r of negotiation) {
    const oaRecord = flows.get(oaFlowKey(r.flowCode));
    const annotation = !oaRecord ? '未匹配 OA' : !oaRecord.paymentDate ? 'OA 无出纳执行记录' : '优先按谈判表分期';
    const extra = { evidenceType: 'negotiation', annotation, notes: r.notes || '',
      oaAmountCents: oaRecord?.amountCents ?? null, oaFilename: oaRecord?.filename || '', oaVersionId: oaRecord?.versionId || '',
      signature: oaRecord?.signature || '', currency: oaRecord?.currency || '人民币', originalAmountCents: oaRecord?.originalAmountCents ?? null,
      exchangeRate: oaRecord?.exchangeRate || '', oaSources: oaRecord?.sources || [] };
    const items = r.applicationInstallments || [];
    const used = new Set();
    // One source amount cell represents one installment, independent of its planned month.
    for (const item of items) {
      if (used.has(item.sourceCell)) continue;
      used.add(item.sourceCell);
      const state = commentPaymentState(item.comment);
      if (state === 'uncertain') { issue(r, '分期批注付款状态或金额不明确，请核对。', { sourceCell: item.sourceCell, comment: item.comment }); continue; }
      if (state !== 'paid') continue;
      const dates = commentPaymentDates(item.comment);
      add(r, dates.length === 1 ? dates[0] : null, item.amountCents, '谈判表分期批注', { ...extra, sourceCell: item.sourceCell, comment: item.comment });
    }
    for (const plan of r.plans || []) {
      const state = commentPaymentState(plan.sourceComment);
      if (!['paid', 'uncertain'].includes(state)) continue;
      const related = items.filter(i => i.month === plan.month || !i.month);
      const marked = related.filter(i => commentPaymentState(i.comment) !== 'none');
      if (marked.length) {
        const known = related.filter(i => commentPaymentState(i.comment) === 'paid');
        if (state === 'uncertain' || sumCents(known) !== plan.amountCents) issue(r, '月金额格与分期付款批注不同；仅统计明确的分期金额，请核对月汇总批注。', { sourceCell: plan.sourceCell, comment: plan.sourceComment });
        continue;
      }
      if (state === 'uncertain') { issue(r, '月金额格付款批注不明确，暂未计入。', { sourceCell: plan.sourceCell, comment: plan.sourceComment }); continue; }
      const dates = commentPaymentDates(plan.sourceComment);
      if (!used.has(plan.sourceCell)) add(r, dates.length === 1 ? dates[0] : null, plan.amountCents, '谈判表月金额格批注', { ...extra, sourceCell: plan.sourceCell, comment: plan.sourceComment });
    }
  }
  for (const r of oa.records) {
    const matched = overridden.has(r.flowKey);
    if (matched) {
      const payments = events.filter(e => oaFlowKey(e.flowCode) === r.flowKey);
      if (r.paymentDate && !payments.length) issue(r, 'OA 已出纳执行，但谈判表没有可确定的已付分期金额及日期；未按 OA 整笔重复计款。');
      if (r.amountCents !== null && sumCents(payments) > r.amountCents) issue(r, '谈判表已付分期合计超过 OA 金额，请核对同号记录及分期；当前保留明确批注金额。');
      if (r.conflict) issue(r, 'OA 同号来源内容冲突；已付仍以明确谈判批注为准，请核对 OA。');
      continue;
    }
    if (!r.flowKey || r.conflict || r.amountCents === null) {
      issue(r, !r.flowKey ? '缺少流程编号，无法关联去重。' : r.conflict ? '同号 OA 关键内容冲突，暂未计入。' : '缺少可用人民币金额，暂未计入。');
      continue;
    }
    if (r.paymentDate) add(r, r.paymentDate, r.amountCents, 'OA 出纳执行（最晚日期）', {
      evidenceType: 'oa', signature: r.signature, oaSources: r.sources, currency: r.currency, originalAmountCents: r.originalAmountCents,
      exchangeRate: r.exchangeRate, oaAmountCents: r.amountCents, annotation: '', comment: '', notes: '',
    });
    else if (/\[\s*出纳执行\s*\]/.test(r.signature?.normalize('NFKC') || '')) issue(r, '出纳执行没有完整有效日期，暂未计入实际付款。');
  }
  return { events, issues };
}
const includes = (text, query) => String(text || '').normalize('NFKC').toLowerCase().includes(String(query || '').normalize('NFKC').toLowerCase());
const matches = (r, f) => includes(r.supplier, f.supplier) && (!f.payer || r.payer === f.payer);
export function oaFlowList(oa, query = {}) {
  const filters = analysisFilters(query);
  const records = oa.records.map(r => ({ ...r, paymentState: r.conflict || !r.flowKey || r.amountCents === null || (/\[\s*出纳执行\s*\]/.test(r.signature?.normalize('NFKC') || '') && !r.paymentDate) ? 'review' : r.paymentDate ? 'paid' : 'unpaid' }))
    .filter(r => matches(r, filters) && includes(r.flowCode, filters.flowCode) && (!filters.paymentState || r.paymentState === filters.paymentState));
  return { records, version: oa.version, filters };
}
export function buildPaymentAnalysis(oa, schedule, query = {}, now = new Date()) {
  const today = beijingDate(now), filters = analysisFilters(query, today), year = +filters.year;
  const { events, issues } = paymentEvents(oa, schedule, today);
  const filtered = events.filter(r => matches(r, filters));
  const yearRows = y => filtered.filter(r => +r.paymentDate.slice(0, 4) === y);
  const currentYear = year === +today.slice(0, 4);
  const currentEnd = currentYear ? today : `${year}-12-31`;
  const month = currentYear ? +today.slice(5, 7) : 12;
  const day = currentYear ? +today.slice(8, 10) : 31;
  const priorEnd = `${year - 1}-${String(month).padStart(2, '0')}-${String(Math.min(day, new Date(Date.UTC(year - 1, month, 0)).getUTCDate())).padStart(2, '0')}`;
  const current = yearRows(year).filter(r => r.paymentDate <= currentEnd), previous = yearRows(year - 1).filter(r => r.paymentDate <= priorEnd);
  const previousAvailable = events.some(r => +r.paymentDate.slice(0, 4) === year - 1);
  const currentCents = sumCents(current), previousCents = previousAvailable ? sumCents(previous) : null;
  const monthly = Array.from({ length: 12 }, (_, n) => {
    const suffix = String(n + 1).padStart(2, '0'), active = !currentYear || n + 1 <= month;
    return { month: suffix, currentMonth: `${year}-${suffix}`, previousMonth: `${year - 1}-${suffix}`,
      currentCents: active ? sumCents(current.filter(r => r.paymentDate.slice(5, 7) === suffix)) : null,
      previousCents: active && previousAvailable ? sumCents(previous.filter(r => r.paymentDate.slice(5, 7) === suffix)) : null };
  });
  const supplierGroups = new Map();
  for (const r of current) { if (!supplierGroups.has(r.supplier)) supplierGroups.set(r.supplier, []); supplierGroups.get(r.supplier).push(r); }
  const suppliers = [...supplierGroups].map(([supplier, records]) => ({ supplier, amountCents: sumCents(records), count: records.length })).sort((a, b) => b.amountCents - a.amountCents || a.supplier.localeCompare(b.supplier));
  let records = filters.detailMonth ? [...current, ...previous].filter(r => r.paymentDate.startsWith(filters.detailMonth)) : current;
  if (Object.hasOwn(filters, 'detailSupplier')) records = records.filter(r => r.supplier === filters.detailSupplier);
  if (filters.supplierSearch) records = records.filter(r => includes(r.supplier, filters.supplierSearch));
  records.sort((a, b) => b.paymentDate.localeCompare(a.paymentDate) || a.id.localeCompare(b.id));
  return { filters, year, today, currentEnd, priorEnd, previousAvailable,
    versions: { oa: oa.version, schedule: schedule.version },
    years: [...new Set([+today.slice(0, 4), ...events.map(r => +r.paymentDate.slice(0, 4))])].sort((a, b) => b - a),
    payers: [...new Set(events.map(r => r.payer).filter(Boolean))].sort(),
    summary: { currentCents, previousCents, changeCents: previousCents === null ? null : sumCents([{ amountCents: currentCents }, { amountCents: -previousCents }]),
      changePercent: previousCents === null || previousCents === 0 ? null : (currentCents - previousCents) / Math.abs(previousCents) * 100 },
    monthly, suppliers, top10: suppliers.slice(0, 10), records, detailTotalCents: sumCents(records),
    issues: issues.filter(r => matches(r, filters) && (!r.paymentDate || [year, year - 1].includes(+r.paymentDate.slice(0, 4)))),
  };
}
