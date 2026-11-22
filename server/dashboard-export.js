import ExcelJS from 'exceljs';
import { CATEGORIES } from '../shared/constants.js';
import { isInformationIssue } from '../shared/issue-level.js';
import { detailRecords } from '../shared/payment-detail-selection.js';
import { supplierRecordDetails } from '../shared/supplier-data.js';
import { makeSheet } from './exports.js';
import { paymentTableTotals } from './payment-table.js';
import { sumApplicationAmounts } from './payment-application.js';

const titles = { monthly: '月度付款汇总', pending: '时间待定付款汇总', suppliers: '供应商明细',
  'pending-suppliers': '时间待定供应商明细', payments: '付款明细', review: '待核对', issues: '待核对事项', notices: '普通提示', drilldown: '付款金额明细' };
const measures = [['totalCents', '总金额'], ['paidCents', '已支付金额'], ['unpaidCents', '未支付金额'], ['unappliedUnpaidCents', '未提交申请单金额']];
const amount = cents => cents == null ? '待核对' : cents / 100;
const text = value => (value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value))
  .replace(/(\d{4}-\d{2}-\d{2})T00:00:00(?:\.000)?Z/g, '$1');
const monthText = month => !month || month === 'pending' ? '时间待定' : month === 'period' ? '所选期间' : month;
const applicationLabel = state => ({ applied: '已提交', unapplied: '未提交', partial: '部分已提交', review: '待核对' })[state] || '—';
const invalid = message => { throw Object.assign(new Error(message || '下载范围无效，请刷新页面后重试。'), { status: 400 }); };
const selectedPlans = record => record.selectedPlans || record.plans || [];

export function dashboardExportScope(query) {
  const scope = {};
  for (const key of ['exportView', 'detailSupplier', 'table', 'rowId', 'detailMonth', 'measure', 'recordKey']) {
    if (!Object.hasOwn(query, key)) continue;
    if (typeof query[key] !== 'string' || query[key].length > 500) invalid();
    scope[key] = query[key];
  }
  if (!Object.hasOwn(scope, 'exportView')) {
    if (Object.keys(scope).length) invalid();
    return null;
  }
  if (!Object.hasOwn(titles, scope.exportView)) invalid();
  if (Object.hasOwn(scope, 'detailSupplier') && !['suppliers', 'pending-suppliers', 'review'].includes(scope.exportView)) invalid();
  if (scope.exportView === 'drilldown') {
    if (!['monthly', 'pending'].includes(scope.table) || !scope.rowId || !scope.detailMonth || !measures.some(([key]) => key === scope.measure)) invalid();
    if (scope.table === 'pending' ? scope.detailMonth !== 'pending' : scope.detailMonth !== 'period' && !/^\d{4}-(0[1-9]|1[0-2])$/.test(scope.detailMonth)) invalid();
    if (Object.hasOwn(scope, 'recordKey') && !scope.recordKey) invalid();
  } else if (['table', 'rowId', 'detailMonth', 'measure', 'recordKey'].some(key => Object.hasOwn(scope, key))) invalid();
  return scope;
}

const sourceColumns = [['来源文件', 'filename', 42], ['来源工作表', 'sourceSheet', 22], ['原始行', 'sourceRow', 12]];
const identityColumns = [['供应商', 'supplier', 34], ['跟单员', 'owner'], ['付款主体', 'payer', 22], ['分类', 'category', 26]];
function identity(record) { return { ...record, category: CATEGORIES[record.category] || record.category }; }
function writeIssues(book, issues, title = '待核对事项') {
  makeSheet(book, title, [[title === '普通提示' ? '提示事项' : '核对事项', 'title', 28], ['问题', 'message', 65], [title === '普通提示' ? '说明与处理' : '需要核对', 'action', 65], ...sourceColumns,
    ['关联位置', 'related', 65]], issues.map(issue => ({ ...issue, related: (issue.relatedLocations || []).map(location =>
    [location.filename, location.sourceSheet, location.sourceRow == null ? '' : `第${location.sourceRow}行`, location.supplier].filter(Boolean).join(' · ')).join('\n') })));
}
function writeSummary(book, title, table, pending) {
  const periods = [...table.months, ...(!pending ? ['period'] : [])];
  const labels = Object.fromEntries(table.rows.map(row => [row.id, row.label]));
  makeSheet(book, title, [['分类', 'label', 28], ['上级分类', 'parent', 24], ['数据状态', 'sourceStatus', 35],
    ...periods.flatMap(month => measures.map(([key, label]) => [`${monthText(month)}${label}（元）`, `${month}:${key}`, 24]))],
  table.rows.map(row => ({ label: row.label, parent: labels[row.parentId] || '—',
    sourceStatus: !row.available ? '未上传' : row.missingSources.length ? `部分上传；缺少：${row.missingSources.join('、')}` : '完整',
    ...Object.fromEntries(periods.flatMap(month => measures.map(([key]) => [ `${month}:${key}`,
      !row.available ? '未上传' : amount((month === 'period' ? row.period : row.cells[month])[key]) ]))) })));
}
function writePlans(book, records) {
  const rows = records.flatMap(record => selectedPlans(record).map(plan => ({ ...identity(record), month: monthText(plan.month),
    total: amount(plan.amountCents), paid: amount(plan.paidCents), unpaid: amount(plan.unpaidCents),
    unapplied: amount(plan.unappliedUnpaidCents), applied: amount(plan.appliedUnpaidCents),
    negotiation: supplierRecordDetails(record).negotiation, paymentDates: plan.paymentDates?.join('、'),
    paymentBasis: plan.paymentBasis, applicationLabel: applicationLabel(plan.applicationState), applicationBasis: plan.applicationBasis,
    applicationDates: plan.applicationDates?.join('、'), sourceCell: plan.sourceCell,
    jiaRemark: supplierRecordDetails(record).jiaRemark, remark: supplierRecordDetails(record).remark })));
  const plans = records.flatMap(selectedPlans);
  const totals = paymentTableTotals(plans);
  rows.push({ supplier: '合计', total: amount(totals.totalCents), paid: amount(totals.paidCents), unpaid: amount(totals.unpaidCents),
    unapplied: amount(totals.unappliedUnpaidCents), applied: amount(sumApplicationAmounts(plans, 'appliedUnpaidCents')) });
  makeSheet(book, '付款金额明细', [...identityColumns, ['月份', 'month'], ['摘要', 'summary', 45],
    ['总金额（元）', 'total', 22], ['已付（元）', 'paid', 22], ['未付（元）', 'unpaid', 22], ['未提交申请单金额（元）', 'unapplied', 26],
    ['已申请未付（元）', 'applied', 24], ['谈判明细', 'negotiation', 55], ['付款日期', 'paymentDates', 28], ['付款判定依据', 'paymentBasis', 60],
    ['申请单判定', 'applicationLabel'], ['原表申请状态', 'applicationStatus'], ['申请判定依据', 'applicationBasis', 60], ['批注申请日期', 'applicationDates', 28],
    ['付款OA号', 'flowCode', 32], ['当前节点', 'currentNode', 24], ['贾总备注', 'jiaRemark', 45], ['孙立柱备注', 'remark', 45],
    ...sourceColumns, ['金额单元格', 'sourceCell'], ['备注', 'notes', 60]], rows);
}
function writePaymentRecords(book, records) {
  const rows = records.map(record => ({ ...identity(record), total: amount(record.selectedPlanCents),
    applied: amount(record.selectedAppliedUnpaidCents), unapplied: amount(record.selectedUnappliedUnpaidCents),
    applicationLabel: applicationLabel(record.applicationState) }));
  const plans = records.flatMap(selectedPlans), totals = paymentTableTotals(plans);
  rows.push({ supplier: '合计', total: amount(totals.totalCents), applied: amount(sumApplicationAmounts(plans, 'appliedUnpaidCents')), unapplied: amount(totals.unappliedUnpaidCents) });
  makeSheet(book, '付款明细', [...identityColumns, ['总金额（元）', 'total', 24], ['已申请未付（元）', 'applied', 24],
    ['未申请金额（元）', 'unapplied', 24], ['是否提交申请单', 'applicationLabel'], ['原表申请状态', 'applicationStatus'],
    ['付款OA号', 'flowCode', 32], ['节点', 'currentNode', 24], ['申请判定依据', 'applicationBasis', 60], ...sourceColumns], rows);
}
function writeSuppliers(book, groups) {
  makeSheet(book, '供应商汇总', [['供应商', 'supplier', 34], ['分类', 'categories', 45], ['期间金额（元）', 'total', 24],
    ['已付（元）', 'paid', 24], ['未付（元）', 'unpaid', 24], ['月份', 'months', 32]], groups.map(group => ({ ...group,
    categories: group.categories.map(category => CATEGORIES[category]).join('、'), total: amount(group.amountCents),
    paid: amount(group.paidCents), unpaid: amount(group.unpaidCents), months: group.months.map(monthText).join('、') })));
  makeSheet(book, '供应商付款明细', [...identityColumns, ['摘要', 'summary', 45], ['期间金额（元）', 'total', 24],
    ['已付（元）', 'paid', 24], ['未付（元）', 'unpaid', 24], ['谈判明细', 'negotiation', 55], ['是否分批', 'installmentFlag'], ['分几批', 'installmentCount'],
    ['申请时间', 'dates', 40], ['每批付款（元）', 'amounts', 40], ['是否申请', 'applicationStatus'], ['当前节点', 'currentNode', 24],
    ['是否支付', 'paymentStatus'], ['贾总备注', 'jiaRemark', 45], ['孙立柱备注', 'remark', 45], ['付款OA号', 'flowCode', 32], ...sourceColumns],
  groups.flatMap(group => group.records).map(record => {
    const details = supplierRecordDetails(record);
    return { ...identity(record), ...details, total: amount(record.selectedPlanCents), paid: amount(details.paidCents), unpaid: amount(details.unpaidCents),
      installmentCount: details.installmentCount == null ? '—' : details.installmentCountSource === 'declared' ? `${details.installmentCount} 批` : `已登记 ${details.installmentCount} 笔`,
      dates: details.installments.map((item, index) => `第${index + 1}笔：${item.date}`).join('\n'),
      amounts: details.installments.map((item, index) => `第${index + 1}笔：${amount(item.amountCents)}`).join('\n') };
  }));
}
function writeReviews(book, groups, issues) {
  makeSheet(book, '待核对供应商', [['供应商', 'supplier', 34], ['需要核对', 'reasons', 65], ['相关记录金额（元）', 'total', 26]],
    groups.map(group => ({ ...group, total: amount(group.totalCents), reasons: [...new Set(group.reviewIssues.map(issue => issue.title || issue.message))].join('\n') })));
  makeSheet(book, '待核对明细', [...identityColumns, ['核对事项', 'reasons', 70], ...sourceColumns, ['原台账金额（元）', 'total', 24],
    ['原台账已付（元）', 'paid', 24], ['原台账剩余（元）', 'remaining', 24], ['余额不一致', 'mismatch'], ['是否提交申请单', 'applicationStatus'],
    ['付款OA号', 'flowCode', 32], ['当前节点', 'currentNode', 24], ['孙立柱备注', 'remark', 45]],
  groups.flatMap(group => group.records).map(record => ({ ...identity(record), total: amount(record.amountCents), paid: amount(record.paidCents),
    remaining: amount(record.reviewRemainingCents), mismatch: record.reviewBalanceMismatch ? '是' : '否', remark: supplierRecordDetails(record).remark,
    reasons: record.reviewIssues.map(issue => [issue.title, issue.message, issue.action].filter(Boolean).join('；')).join('\n') })));
  writeIssues(book, issues);
}
function writeEvidence(book, records) {
  const base = record => ({ supplier: record.supplier, filename: record.filename, sourceSheet: record.sourceSheet, sourceRow: record.sourceRow });
  const columns = [['供应商', 'supplier', 34], ['计划月份', 'month'], ...sourceColumns, ['依据位置', 'position', 30], ['依据金额（元）', 'amount', 24],
    ['日期', 'dates', 30], ['判定', 'state'], ['依据原文', 'comment', 70], ['付款依据版本', 'version', 65]];
  for (const type of ['payment', 'application']) {
    makeSheet(book, type === 'payment' ? '付款依据' : '申请依据', columns, records.flatMap(record => selectedPlans(record).flatMap(plan =>
      (plan[`${type}Evidence`] || []).map(evidence => ({ ...base(record), month: monthText(plan.month),
        position: [evidence.sourceSheet || record.sourceSheet, evidence.sourceCell || `第${evidence.sourceRow || record.sourceRow}行`].join(' · '),
        amount: amount(evidence.amountCents), dates: evidence[`${type}Dates`]?.join('、'),
        state: type === 'application' ? applicationLabel(evidence.applicationState) : evidence.status || plan.paymentBasis || '—',
        comment: evidence.comment || (type === 'application' ? plan.applicationBasis : plan.paymentBasis),
        version: plan.paymentProgressVersion ? `${plan.paymentProgressVersion.filename}（${plan.paymentProgressVersion.id}）` : '' })))));
  }
  for (const [name, field] of [['原始字段', 'raw'], ['单元格批注', 'comments']]) {
    makeSheet(book, name, [['供应商', 'supplier', 34], ...sourceColumns, ['字段或单元格', 'field', 32], ['原文', 'value', 80]],
      records.flatMap(record => Object.entries(record[field] || {}).map(([key, value]) => ({ ...base(record), field: text(key), value: text(value) }))));
  }
}

export async function scopedDashboardExport(data, scope, filters = {}) {
  const book = new ExcelJS.Workbook(); book.creator = '资金台账';
  const view = scope.exportView;
  let title = titles[view], records = [], groups;
  if (view === 'monthly' || view === 'pending') {
    const pending = view === 'pending';
    const table = pending ? data.pendingPaymentTable : data.paymentTable;
    records = pending ? data.pendingRecords : detailRecords(data.records, { categories: Object.keys(CATEGORIES), month: 'period', measure: 'totalCents' });
    writeSummary(book, title, table, pending); writePlans(book, records);
  } else if (view === 'suppliers' || view === 'pending-suppliers') {
    groups = view === 'pending-suppliers' ? data.pendingSupplierGroups : data.supplierGroups;
    if (Object.hasOwn(scope, 'detailSupplier')) groups = groups.filter(group => group.supplier === scope.detailSupplier);
    records = groups.flatMap(group => group.records); writeSuppliers(book, groups);
  } else if (view === 'payments') {
    records = data.records; writePaymentRecords(book, records);
  } else if (view === 'review') {
    groups = data.reviewSuppliers;
    if (Object.hasOwn(scope, 'detailSupplier')) groups = groups.filter(group => group.supplier === scope.detailSupplier);
    records = groups.flatMap(group => group.records);
    const keys = new Set(records.map(record => record.key));
    writeReviews(book, groups, data.issues.filter(issue => !isInformationIssue(issue) && (!Object.hasOwn(scope, 'detailSupplier') || keys.has(issue.recordKey))));
  } else if (view === 'issues') writeIssues(book, data.issues.filter(issue => !isInformationIssue(issue)));
  else if (view === 'notices') writeIssues(book, data.issues.filter(isInformationIssue), '普通提示');
  else if (view === 'drilldown') {
    const table = scope.table === 'pending' ? data.pendingPaymentTable : data.paymentTable;
    const row = table.rows.find(item => item.id === scope.rowId);
    if (!row || scope.detailMonth !== 'period' && !table.months.includes(scope.detailMonth)) invalid();
    records = detailRecords(scope.table === 'pending' ? data.pendingRecords : data.records,
      { categories: row.categories, month: scope.detailMonth, measure: scope.measure });
    if (scope.recordKey) {
      records = records.filter(record => record.key === scope.recordKey);
      if (!records.length) invalid('该记录已不在当前下载范围，请刷新页面后重试。');
    }
    title = `${row.label}-${monthText(scope.detailMonth)}-${measures.find(([key]) => key === scope.measure)[1]}`;
    writePlans(book, records);
  }
  if (records.length) writeEvidence(book, records);
  makeSheet(book, '下载说明', [['项目', 'name', 26], ['内容', 'value', 90]], [
    { name: '下载内容', value: title }, { name: '数据截至', value: data.updatedAt && Number.isFinite(Date.parse(data.updatedAt))
      ? new Date(data.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—' },
    { name: '筛选条件', value: Object.entries({ ...filters, ...scope }).map(([key, value]) => `${key}：${value}`).join('\n') },
    { name: '原记录数', value: records.length }, { name: '范围', value: '包含当前筛选范围的全部分页记录；不受当前页码及展开折叠影响。' },
    { name: '金额单位', value: '元，精确到分；网页以万元显示。有效零金额保留0，未知金额保留待核对。' },
    { name: '月份', value: '计划月份决定汇总月份；付款日期和申请日期仅作依据。月度汇总不含时间待定，时间待定单独下载。' },
    { name: '汇总注意', value: '父级和子级存在包含关系，请勿再次累加。明细末尾合计行不重复计入业务记录。' },
  ]);
  // Generated text dates use the same display form as the dashboard, including raw evidence.
  book.eachSheet(sheet => sheet.eachRow(row => row.eachCell(cell => { if (typeof cell.value === 'string') cell.value = text(cell.value); })));
  return { title, buffer: await book.xlsx.writeBuffer() };
}
