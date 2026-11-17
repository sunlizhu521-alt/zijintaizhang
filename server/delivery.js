import { Router } from 'express';
import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { DELIVERY_SLOTS } from '../shared/constants.js';
import { audit, transaction } from './db.js';
import { fail, listSlots } from './storage.js';

const STAGES = ['receipts', 'inbound'];
const STATUS = { review: '待核对', unknown: '未上传交付单', zero: '零数量', completed: '已交齐', closed: '已关闭', overdue: '延期未交齐', warning: '7天内到期', pending: '待交付', partial: '部分交付' };
const CHECKS = ['productCheck', 'specificationCheck', 'quantityCheck', 'labelCheck', 'receivingCheck'];
const SCALE = 1_000_000;
const text = value => String(value ?? '').normalize('NFKC').trim();
const keyText = value => text(value).toUpperCase();
const digest = values => createHash('sha256').update(JSON.stringify(values)).digest('hex');
const dateValid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
const daysAfter = (date, count) => new Date(Date.parse(`${date}T00:00:00Z`) + count * 86400000).toISOString().slice(0, 10);
const qtyValid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && Number.isSafeInteger(Math.round(value * SCALE)) && Math.abs(value - Math.round(value * SCALE) / SCALE) <= Number.EPSILON * Math.max(1, value) * 2;
function sum(values) {
  let total = 0;
  for (const value of values) {
    total += Math.round(value * SCALE);
    if (!Number.isSafeInteger(total)) throw fail(422, '数量合计超过安全计算范围，请缩小数据范围');
  }
  return total / SCALE;
}
const subtract = (a, b) => Math.max(0, Math.round((a - b) * SCALE) / SCALE);
const ratio = (a, b) => b > 0 ? a / b : null;
const defaultFollowup = () => ({ revision: 0, data: { productionStatus: '未开始', shippingStatus: '未发货', expectedShipDate: '', owner: '', ...Object.fromEntries(CHECKS.map(key => [key, 'pending'])), exception: '', action: '', note: '' }, updatedAt: null, updatedBy: '' });
const parseFollowup = row => row ? ({ revision: row.revision, data: JSON.parse(row.data_json), updatedAt: row.updated_at, updatedBy: row.updated_by }) : defaultFollowup();

export function initializeDelivery(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS delivery_followups (
    order_key TEXT PRIMARY KEY, data_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL, updated_by TEXT NOT NULL
  )`);
}

function orderKey(row) {
  const identity = row.lineNumber ? ['line', row.orderNumber, row.lineNumber, row.supplier, row.productCode, row.specification, row.unit] : ['item', row.orderNumber, row.supplier, row.productCode, row.specification, row.unit];
  return digest(identity.map(keyText));
}
const groupKey = row => JSON.stringify([keyText(row.orderNumber), keyText(row.productCode)]);
function issueFor(row, code, message) {
  return { code, message, sourceType: row.sourceType, orderNumber: row.orderNumber, sourceSheet: row.sourceSheet, sourceRow: row.sourceRow, filename: row.filename || '', documentNumber: row.documentNumber || '' };
}
function baseReasons(row) {
  const reasons = [...new Set(row.invalidFields || [])].map(field => `原始字段待核对：${field}`);
  for (const [key, label] of [['orderNumber', '采购订单号'], ['supplier', '供应商'], ['productCode', '物料编码']]) if (!text(row[key])) reasons.push(`缺少${label}`);
  if (!qtyValid(row.quantity)) reasons.push('订单数量无效');
  if (!dateValid(row.createdDate)) reasons.push('创建时间无效');
  if (!dateValid(row.dueDate)) reasons.push('交货日期无效');
  if (dateValid(row.createdDate) && dateValid(row.dueDate) && row.createdDate > row.dueDate) reasons.push('创建时间晚于交货日期');
  return [...new Set(reasons)];
}
function documentIdentity(row) {
  if (!text(row.documentNumber)) return null;
  if (text(row.lineNumber)) return digest(['line', row.documentNumber, row.lineNumber].map(keyText));
  const raw = Object.keys(row.rawFields || {}).sort().map(key => [key, row.rawFields[key]]);
  // A report without entry IDs can contain separate same-item lines; only identical full records are duplicate candidates.
  return digest([['record', row.documentNumber, row.originalSourceNumber || row.orderNumber, row.sourceLineNumber, row.supplier, row.productCode, row.specification, row.unit, row.quantity, row.deliveryDate].map(keyText), raw]);
}
const compatible = (a, b) => ['supplier', 'unit', 'specification'].every(field => !text(a[field]) || !text(b[field]) || keyText(a[field]) === keyText(b[field]));
const effectiveUnit = row => text(row.unit) || text(row.traceConstraints?.unit);

function traceInbound(document, orderIndex, receiptIndex) {
  const originalSourceNumber = document.orderNumber;
  if (orderIndex.has(keyText(originalSourceNumber))) return { ...document, originalSourceNumber };
  const candidates = (receiptIndex.get(keyText(originalSourceNumber)) || []).filter(receipt => keyText(receipt.productCode) === keyText(document.productCode) &&
    (!text(document.sourceLineNumber) || !text(receipt.lineNumber) || keyText(document.sourceLineNumber) === keyText(receipt.lineNumber)));
  const targets = new Map();
  for (const receipt of candidates) {
    if (!text(receipt.orderNumber)) continue;
    targets.set(JSON.stringify([keyText(receipt.orderNumber), keyText(receipt.sourceLineNumber)]), receipt);
  }
  if (targets.size !== 1) return { ...document, originalSourceNumber, traceOrderNumbers: [...targets.values()].map(receipt => receipt.orderNumber),
    linkReviewReasons: targets.size > 1 ? ['入库源收料单的同物料对应多个采购订单或订单行，不能自动分摊'] : [] };
  const receipt = [...targets.values()][0];
  const traceReceipts = candidates.filter(item => keyText(item.orderNumber) === keyText(receipt.orderNumber) && keyText(item.sourceLineNumber) === keyText(receipt.sourceLineNumber));
  const traceConstraints = {}, linkReviewReasons = [];
  for (const [field, label] of [['supplier', '供应商'], ['unit', '计量单位'], ['specification', '规格']]) {
    const values = new Map(traceReceipts.filter(item => text(item[field])).map(item => [keyText(item[field]), item[field]]));
    if (values.size > 1) linkReviewReasons.push(`源收料单同物料存在不同${label}，不能选取其中一行作为追溯依据`);
    else if (values.size === 1) traceConstraints[field] = [...values.values()][0];
  }
  if (!compatible(document, traceConstraints)) linkReviewReasons.push('入库单与源收料单的供应商、规格或计量单位不一致');
  return { ...document, originalSourceNumber, viaReceiptNumber: originalSourceNumber, orderNumber: receipt.orderNumber,
    sourceLineNumber: receipt.sourceLineNumber || '', receiptSourceSheet: receipt.sourceSheet, receiptSourceRow: receipt.sourceRow,
    traceConstraints, linkReviewReasons, receiptSources: traceReceipts.map(item => ({ sourceSheet: item.sourceSheet, sourceRow: item.sourceRow })) };
}
function stageResult(row, events, available, reasons, asOfDate) {
  const reviewReasons = [...new Set([...row.reviewReasons, ...reasons])];
  const conflictingUnits = new Set(events.map(effectiveUnit).filter(Boolean)).size > 1;
  const validQuantity = conflictingUnits ? null : sum(events.map(event => event.quantity));
  let accumulated = 0, completionDate = null;
  for (const event of conflictingUnits ? [] : [...events].sort((a, b) => a.deliveryDate.localeCompare(b.deliveryDate))) {
    accumulated = sum([accumulated, event.quantity]);
    if (!completionDate && row.quantity > 0 && accumulated >= row.quantity) completionDate = event.deliveryDate;
  }
  const quantity = available && !reviewReasons.length ? validQuantity : null;
  const onTimeQuantity = !conflictingUnits && dateValid(row.dueDate) ? sum(events.filter(event => event.deliveryDate <= row.dueDate).map(event => event.quantity)) : null;
  let status = 'pending';
  if (reviewReasons.length) status = 'review';
  else if (!available) status = 'unknown';
  else if (row.quantity === 0) status = 'zero';
  else if (quantity >= row.quantity) status = 'completed';
  else if (row.closed) status = 'closed';
  else if (row.dueDate < asOfDate) status = 'overdue';
  else if (row.dueDate <= daysAfter(asOfDate, 7)) status = 'warning';
  else if (quantity > 0) status = 'partial';
  return { available, review: reviewReasons.length > 0, reviewReasons, quantity, validQuantity,
    completionDate, lastDeliveryDate: events.map(event => event.deliveryDate).sort().at(-1) || null,
    onTimeQuantity, status, events };
}

function summaryFor(rows, stage, stageAvailable, asOfDate) {
  const valid = rows.filter(row => !row.reviewReasons.length && !row[stage].review);
  const positive = valid.filter(row => row.quantity > 0);
  const due = positive.filter(row => row.dueDate <= asOfDate);
  const completed = positive.filter(row => row[stage].status === 'completed');
  const onTime = due.filter(row => row[stage].completionDate && row[stage].completionDate <= row.dueDate);
  const units = new Map();
  for (const row of valid) {
    const unit = text(row.unit) || row[stage].events.map(effectiveUnit).find(Boolean) || '';
    const key = JSON.stringify([row.productCode, unit]);
    if (!units.has(key)) units.set(key, []);
    units.get(key).push(row);
  }
  const quantityByUnit = [...units.keys()].sort().map(key => {
    const group = units.get(key), { productCode, productName } = group[0], unit = JSON.parse(key)[1];
    const orderedQuantity = sum(group.map(row => row.quantity));
    const deliveredQuantity = stageAvailable ? sum(group.map(row => row[stage].quantity)) : null;
    const outstandingQuantity = stageAvailable ? sum(group.map(row => subtract(row.quantity, row[stage].quantity))) : null;
    const fulfilled = stageAvailable ? sum(group.map(row => Math.min(row.quantity, row[stage].quantity))) : null;
    return { productCode, productName, unit, orderedQuantity, deliveredQuantity, outstandingQuantity, quantityRate: stageAvailable ? ratio(fulfilled, orderedQuantity) : null };
  });
  const physical = quantityByUnit.length === 1 ? quantityByUnit[0] : { orderedQuantity: null, deliveredQuantity: null, outstandingQuantity: null, quantityRate: null };
  return { orderCount: new Set(rows.map(row => row.orderNumber).filter(Boolean)).size, lineCount: rows.length, validLineCount: valid.length,
    orderedQuantity: physical.orderedQuantity, deliveredQuantity: physical.deliveredQuantity, outstandingQuantity: physical.outstandingQuantity, quantityRate: physical.quantityRate,
    completedCount: stageAvailable ? completed.length : null, completionRate: stageAvailable ? ratio(completed.length, positive.length) : null,
    dueCount: due.length, onTimeCount: stageAvailable ? onTime.length : null, onTimeRate: stageAvailable ? ratio(onTime.length, due.length) : null,
    overdueCount: stageAvailable ? rows.filter(row => row.status === 'overdue').length : null,
    warningCount: stageAvailable ? rows.filter(row => row.status === 'warning').length : null,
    reviewCount: rows.filter(row => row.status === 'review').length, exceptionCount: rows.filter(row => row.hasException).length, closedCount: rows.filter(row => row.closed).length,
    stageAvailable, quantityByUnit };
}

function batchInfo(group, eventsByStage) {
  const planned = new Map(), identities = new Map();
  for (const row of group) {
    const rawIdentity = digest(Object.keys(row.rawFields || {}).length ? Object.keys(row.rawFields).sort().map(key => [key, row.rawFields[key]]) :
      [row.orderNumber, row.lineNumber, row.productCode, row.quantity, row.dueDate, row.supplier, row.unit, row.specification]);
    identities.set(rawIdentity, (identities.get(rawIdentity) || 0) + 1);
  }
  for (const row of group) {
    const date = row.dueDate || '';
    if (!planned.has(date)) planned.set(date, []);
    planned.get(date).push(row);
  }
  const source = row => ({ sourceSheet: row.sourceSheet, sourceRow: row.sourceRow, filename: row.filename || '', quantity: row.quantity });
  const plannedBatches = [...planned.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, rows]) => {
    const duplicates = rows.some(row => {
      const rawIdentity = digest(Object.keys(row.rawFields || {}).length ? Object.keys(row.rawFields).sort().map(key => [key, row.rawFields[key]]) :
        [row.orderNumber, row.lineNumber, row.productCode, row.quantity, row.dueDate, row.supplier, row.unit, row.specification]);
      return identities.get(rawIdentity) > 1;
    });
    const review = duplicates || !dateValid(date) || rows.some(row => !qtyValid(row.quantity)) || new Set(rows.map(row => text(row.unit)).filter(Boolean)).size > 1;
    return { date: date || null, quantity: review ? null : sum(rows.map(row => row.quantity)), lineCount: rows.length, review, sourceRows: rows.map(source) };
  });
  const stageBatches = stage => {
    const batches = new Map();
    for (const item of eventsByStage[stage] || []) {
      const id = JSON.stringify([item.document.documentNumber, item.document.deliveryDate]);
      if (!batches.has(id)) batches.set(id, []);
      batches.get(id).push(item);
    }
    return [...batches.values()].map(items => {
      const first = items[0].document, conflictingUnits = new Set(items.map(item => effectiveUnit(item.document)).filter(Boolean)).size > 1;
      const reviewReasons = [...new Set(items.flatMap(item => item.reviewReasons))];
      if (conflictingUnits) reviewReasons.push('同批存在不同单位，数量不能直接合计');
      const validQuantity = conflictingUnits ? null : sum(items.filter(item => !item.reviewReasons.length).map(item => item.document.quantity));
      return { date: first.deliveryDate, documentNumber: first.documentNumber, quantity: reviewReasons.length ? null : validQuantity, validQuantity,
        eventCount: items.length, review: reviewReasons.length > 0, reviewReasons, allocated: items.every(item => item.allocated), sourceRows: items.map(item => source(item.document)) };
    }).sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.documentNumber.localeCompare(b.documentNumber));
  };
  const receiptBatches = stageBatches('receipts'), inboundBatches = stageBatches('inbound');
  return { shared: group.length > 1, allocationPending: (group.length > 1 && group.some(row => !row.lineNumber)) || [...(eventsByStage.receipts || []), ...(eventsByStage.inbound || [])].some(item => !item.allocated),
    isSplit: plannedBatches.length > 1 || receiptBatches.length > 1 || inboundBatches.length > 1,
    plannedCount: plannedBatches.length, receiptCount: receiptBatches.length, inboundCount: inboundBatches.length, plannedBatches, receiptBatches, inboundBatches };
}

export function deliveryFilters(query = {}) {
  const filters = { stage: 'receipts' };
  for (const key of ['from', 'to', 'supplier', 'status', 'search', 'stage']) {
    if (query[key] == null || query[key] === '') continue;
    if (typeof query[key] !== 'string' || query[key].length > 250) throw fail(400, '筛选条件无效');
    filters[key] = query[key].trim();
  }
  if (!STAGES.includes(filters.stage)) throw fail(400, '交付口径无效');
  for (const key of ['from', 'to']) if (filters[key] && !/^\d{4}-(0[1-9]|1[0-2])$/.test(filters[key])) throw fail(400, '月份格式应为 YYYY-MM');
  if (filters.from && filters.to && filters.from > filters.to) throw fail(400, '开始月份不能晚于结束月份');
  if (filters.status && !Object.hasOwn(STATUS, filters.status)) throw fail(400, '交付状态无效');
  return filters;
}

export function buildDeliveryDashboard({ records = [], issues: sourceIssues = [], slots = [], followups = new Map(), filters: query = {}, asOfDate = today() } = {}) {
  const filters = deliveryFilters(query), stage = filters.stage;
  if (!dateValid(asOfDate)) throw fail(400, '统计日期无效');
  const issues = [...sourceIssues], rows = records.filter(row => row.sourceType === 'orders').map(row => ({ ...row, key: orderKey(row), reviewReasons: baseReasons(row),
    closed: text(row.rawFields?.['业务关闭']) === '业务关闭' || text(row.rawFields?.['关闭状态']) === '已关闭' }));
  const index = new Map(), keyCounts = new Map(), groups = new Map(), groupEvents = new Map();
  for (const row of rows) {
    const order = keyText(row.orderNumber);
    if (!index.has(order)) index.set(order, []);
    index.get(order).push(row); keyCounts.set(row.key, (keyCounts.get(row.key) || 0) + 1);
    const group = groupKey(row);
    if (!groups.has(group)) { groups.set(group, []); groupEvents.set(group, { receipts: [], inbound: [] }); }
    groups.get(group).push(row);
  }
  for (const row of rows) {
    row.followupAllowed = Boolean(row.orderNumber && row.productCode && keyCounts.get(row.key) === 1);
    if (keyCounts.get(row.key) > 1) row.reviewReasons.push('订单行重复或缺少可区分的行号，不能自动分摊交付');
    row.reviewReasons.forEach(message => issues.push(issueFor(row, 'ORDER_REVIEW', message)));
    row.followup = followups.get(row.key) || defaultFollowup();
    row.hasException = CHECKS.some(key => row.followup.data[key] === 'issue') || Boolean(row.followup.data.exception);
  }
  const receiptIndex = new Map();
  for (const receipt of records.filter(row => row.sourceType === 'receipts')) {
    const number = keyText(receipt.documentNumber);
    if (!receiptIndex.has(number)) receiptIndex.set(number, []);
    receiptIndex.get(number).push(receipt);
  }
  for (const sourceType of STAGES) {
    const available = Boolean(slots.find(slot => slot.id === `delivery_${sourceType}`)?.currentVersionId);
    const assigned = new Map(rows.map(row => [row, []])), warnings = new Map(rows.map(row => [row, []]));
    const documents = records.filter(row => row.sourceType === sourceType).map(row => sourceType === 'inbound' ? traceInbound(row, index, receiptIndex) : row), identities = new Map(), documentDates = new Map();
    documents.forEach(row => {
      const id = documentIdentity(row); if (id) identities.set(id, (identities.get(id) || 0) + 1);
      const number = keyText(row.documentNumber);
      if (!documentDates.has(number)) documentDates.set(number, new Set());
      if (dateValid(row.deliveryDate)) documentDates.get(number).add(row.deliveryDate);
    });
    for (const document of documents) {
      const orderRows = document.traceOrderNumbers?.length ? [...new Set(document.traceOrderNumbers.flatMap(number => index.get(keyText(number)) || []))] : index.get(keyText(document.orderNumber)) || [];
      if (!orderRows.length && text(document.orderNumber)) {
        issues.push(issueFor(document, 'OUTSIDE_ORDER_SCOPE', '源单未被当前采购订单文件覆盖，或无法经当前收料文件追溯；未计入订单指标'));
        continue;
      }
      const candidates = orderRows.filter(row => {
        if (text(document.sourceLineNumber) && keyText(document.sourceLineNumber) !== keyText(row.lineNumber)) return false;
        if (keyText(document.productCode) !== keyText(row.productCode)) return false;
        return compatible(row, document) && compatible(row, document.traceConstraints || {});
      });
      const reasons = [...(document.linkReviewReasons || [])];
      if (!text(document.orderNumber)) reasons.push('缺少源单单号');
      if (!text(document.documentNumber)) reasons.push('缺少交付单据编号，不能排查重复');
      if (!text(document.productCode)) reasons.push('缺少物料编码');
      if (!qtyValid(document.quantity)) reasons.push('交付数量无效');
      if (!dateValid(document.deliveryDate)) reasons.push('交付日期无效');
      else if (document.deliveryDate > asOfDate) reasons.push('交付日期晚于统计日期，不能计入已交数量');
      if ((document.invalidFields || []).length) reasons.push(`字段待核对：${document.invalidFields.join('、')}`);
      if (identities.get(documentIdentity(document)) > 1) reasons.push('交付单据重复，待核对后计入');
      if (documentDates.get(keyText(document.documentNumber))?.size > 1) reasons.push('同一单据编号存在不同业务日期，请核对版本或单据内容');
      const batchReviewReasons = [...reasons];
      if (!candidates.length) reasons.push(orderRows.length ? '源订单存在，但物料、源行号、规格、单位或供应商不匹配' : '源单单号未找到采购订单');
      if (candidates.length > 1) reasons.push('同一订单存在多个可匹配行，需要源单行号消歧');
      if (candidates.length === 1 && dateValid(candidates[0].createdDate) && dateValid(document.deliveryDate) && document.deliveryDate < candidates[0].createdDate) reasons.push('交付时间早于订单创建时间');
      if (candidates.some(row => dateValid(row.createdDate) && dateValid(document.deliveryDate) && document.deliveryDate < row.createdDate)) batchReviewReasons.push('交付时间早于订单创建时间');
      for (const key of new Set(candidates.map(groupKey))) groupEvents.get(key)[sourceType].push({ document, reviewReasons: batchReviewReasons,
        allocated: candidates.length === 1 && !reasons.length && !candidates[0].reviewReasons.length });
      if (reasons.length) {
        reasons.forEach(message => issues.push(issueFor(document, 'DELIVERY_REVIEW', message)));
        // Matching failures with a known order can affect its apparent outstanding quantity.
        for (const row of candidates.length ? candidates : orderRows) warnings.get(row).push(...reasons);
      } else assigned.get(candidates[0]).push(document);
    }
    for (const row of rows) {
      if (new Set(assigned.get(row).map(effectiveUnit).filter(Boolean)).size > 1) warnings.get(row).push('同一物料出现不同计量单位，不能直接合计');
      row[sourceType] = stageResult(row, assigned.get(row), available, warnings.get(row), asOfDate);
      if (qtyValid(row.quantity) && row[sourceType].validQuantity != null && row[sourceType].validQuantity > row.quantity) issues.push(issueFor(row, 'OVER_DELIVERY', `${sourceType === 'receipts' ? '收料' : '入库'}数量超过订单数量，请核对超交`));
    }
  }
  const batchByGroup = new Map([...groups].map(([key, group]) => [key, batchInfo(group, groupEvents.get(key))]));
  for (const row of rows) {
    row.batchInfo = batchByGroup.get(groupKey(row));
    row.selectedStage = stage; row.status = row[stage].status;
    row.remainingQuantity = row[stage].quantity == null || !qtyValid(row.quantity) ? null : subtract(row.quantity, row[stage].quantity);
  }
  const supplierOptions = [...new Set(rows.map(row => row.supplier).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const filtered = rows.filter(row => (!filters.supplier || row.supplier === filters.supplier) && (!filters.status || row.status === filters.status) &&
    (!filters.from || (row.dueDate && row.dueDate.slice(0, 7) >= filters.from)) && (!filters.to || (row.dueDate && row.dueDate.slice(0, 7) <= filters.to)) &&
    (!filters.search || [row.orderNumber, row.supplier, row.productCode, row.productName, row.specification, row.followup.data.owner].some(value => keyText(value).includes(keyText(filters.search)))));
  const stageAvailable = Boolean(slots.find(slot => slot.id === `delivery_${stage}`)?.currentVersionId);
  const groupSummary = key => {
    const groups = new Map();
    for (const row of filtered) {
      const value = key === 'month' ? row.dueDate?.slice(0, 7) || 'pending' : row[key];
      if (!groups.has(value)) groups.set(value, []);
      groups.get(value).push(row);
    }
    return [...groups.keys()].sort((a, b) => a.localeCompare(b, 'zh-CN')).map(value => ({ [key]: value, ...summaryFor(groups.get(value), stage, stageAvailable, asOfDate) }));
  };
  const outsideScopeCount = issues.filter(issue => issue.code === 'OUTSIDE_ORDER_SCOPE').length;
  issues.sort((a, b) => Number(a.code === 'OUTSIDE_ORDER_SCOPE') - Number(b.code === 'OUTSIDE_ORDER_SCOPE'));
  return { asOfDate, stage, filters, slots, rows: filtered, outsideScopeCount, summary: { ...summaryFor(filtered, stage, stageAvailable, asOfDate), outsideScopeCount },
    monthly: groupSummary('month'), suppliers: groupSummary('supplier'), issues,
    options: { suppliers: supplierOptions, statuses: STATUS }, policy: [
      '收料通知单和采购入库单分别统计，不相加。切换口径后，交付率、交齐、延期和预警按所选单据独立计算。',
      '以源单单号关联采购订单；入库源单为收料单时，通过收料单号和物料编码唯一追溯采购订单。保留原源单编号与收料单依据，不以收料数量替代入库数量。多目标或规格、单位、供应商冲突进入待核对，不自动分摊。',
      '按期交齐率＝截至统计日已到期且按交期交齐的有效订单行÷截至统计日已到期的有效正数量订单行。交齐日期为累计有效交付首次达到订单数量的日期。',
      '缺失、负数、重复、无法匹配、未来交付或无有效日期的记录不作为已交依据；受影响订单行从指标分母排除并标待核对。零数量行保留，不计交齐率分母。',
      '按用户确认，同一物料的采购、收料和入库数量采用一致的默认计量单位；原表未导出单位时保留为空。数量仅按同物料编码和单位汇总，不跨物料相加；明确不同单位不得直接合计。数量完成率逐行以订单数量封顶，超交单独提示。',
      '数量汇总分组优先使用订单原单位；原单位未导出时，使用当前交付口径单据（含追溯收料单）的唯一明确单位作为分组依据，不回填订单原字段。',
      '无分录行号时保留同一单据的不同原始明细行；完整字段相同的记录列为疑似重复，不自动计入。同一单据日期冲突列待核对。未上传交付槽位显示未知，不视为零交付。',
      '同一采购订单同物料有多个交期时，展示计划批次与实际收料、入库单据批次；未明确对应关系时不按FIFO分配，不把组级交付数量重复计入各订单行。',
      '原表业务关闭为“业务关闭”或关闭状态为“已关闭”的订单保留历史指标和未交差额，停止延期和到期预警。当前采购订单范围外的交付记录单独列示，不计入订单异常行数。',
      '月份按采购订单交货日期归属。7天内到期预警含今天和第7天；延期为交期早于统计日且未交齐。待核对列表展示全部来源问题，不随订单筛选隐藏。',
      '生产、发货、标签及收货信息核验由跟进人员维护；单据日期和数量不能自动证明产品、标签及收货信息一致。文件替换或恢复不覆盖人工跟进。',
    ] };
}

function currentData(db, filters) {
  const records = [], issues = [], orderNumbers = new Set(), receiptNumbersForScope = new Set();
  for (const slotId of ['delivery_orders', 'delivery_receipts', 'delivery_inbound']) {
    const version = db.prepare('SELECT v.id,v.filename,v.parsed_json FROM file_slots s JOIN file_versions v ON v.id=s.current_version_id WHERE s.id=?').get(slotId);
    if (!version) continue;
    const parsed = JSON.parse(version.parsed_json);
    for (const row of parsed.records) {
      const direct = orderNumbers.has(keyText(row.orderNumber));
      if (slotId === 'delivery_orders') orderNumbers.add(keyText(row.orderNumber));
      if (slotId === 'delivery_receipts' && direct) receiptNumbersForScope.add(keyText(row.documentNumber));
      const keepRaw = slotId === 'delivery_orders' || direct || (slotId === 'delivery_inbound' && receiptNumbersForScope.has(keyText(row.orderNumber)));
      // Historical rows outside the order scope only need normalized link fields; originals stay in their saved version.
      const { rawFields, ...fields } = row;
      records.push({ ...fields, ...(keepRaw ? { rawFields } : {}), filename: version.filename, versionId: version.id, slotId });
    }
    issues.push(...parsed.issues.map(issue => ({ ...issue, filename: version.filename, slotId })));
  }
  const followups = new Map(db.prepare('SELECT * FROM delivery_followups').all().map(row => [row.order_key, parseFollowup(row)]));
  return buildDeliveryDashboard({ records, issues, slots: listSlots(db, DELIVERY_SLOTS), followups, filters });
}
function validatedFollowup(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw fail(400, '跟进内容格式无效');
  const defaults = defaultFollowup().data, result = {};
  if (Object.keys(data).some(key => !Object.hasOwn(defaults, key))) throw fail(400, '包含未知跟进字段');
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = data[key] ?? fallback;
    if (typeof value !== 'string' || value.length > (['exception', 'action', 'note'].includes(key) ? 2000 : 200)) throw fail(400, '跟进字段过长或格式无效');
    result[key] = value.trim();
  }
  if (!['未开始', '生产中', '已完成', '暂停'].includes(result.productionStatus) || !['未发货', '部分发货', '已发货'].includes(result.shippingStatus)) throw fail(400, '生产或发货状态无效');
  if (CHECKS.some(key => !['pending', 'pass', 'issue'].includes(result[key]))) throw fail(400, '核验状态无效');
  if (result.expectedShipDate && !dateValid(result.expectedShipDate)) throw fail(400, '预计发货日期无效');
  return result;
}
const nativeDate = value => dateValid(value) ? new Date(`${value}T00:00:00Z`) : null;
export async function deliveryExport(data) {
  const book = new ExcelJS.stream.xlsx.WorkbookWriter({ useStyles: true, useSharedStrings: false }); book.creator = '供应商交付管理';
  const add = async (name, columns, rows) => {
    const sheet = book.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = columns.map(([header, key, width = 18]) => ({ header, key, width }));
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, rows.length + 1), column: columns.length } };
    const write = (row, header, source = {}) => {
      row.height = header ? 32 : 40;
      row.eachCell(cell => {
        cell.font = { name: 'Microsoft YaHei', size: 10, bold: header, color: { argb: header ? 'FFFFFFFF' : 'FF243247' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: header ? 'FF8373E7' : 'FFFFFFFF' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        const edge = { style: 'thin', color: { argb: 'FFD5DCE5' } };
        cell.border = { top: edge, right: edge, bottom: edge, left: edge };
        if (cell.value instanceof Date) cell.numFmt = 'yyyy-mm-dd';
        else if (typeof cell.value === 'number') cell.numFmt = ['onTimeRate', 'quantityRate'].includes(columns[cell.col - 1][1]) || (columns[cell.col - 1][1] === 'value' && source.label?.includes('率')) ? '0.00%' : '#,##0.######';
        if (typeof cell.value === 'string' && cell.value.length > 70) row.height = Math.min(180, Math.max(row.height, Math.ceil(cell.value.length / 30) * 15));
      });
      row.commit();
    };
    write(sheet.getRow(1), true);
    for (let i = 0; i < rows.length; i++) {
      write(sheet.addRow(rows[i]), false, rows[i]);
      if (i % 500 === 499) await new Promise(resolve => setImmediate(resolve));
    }
    sheet.commit();
    await new Promise(resolve => setImmediate(resolve));
  };
  const metrics = [['订单数', 'orderCount'], ['订单行数', 'lineCount'], ['有效计入行数', 'validLineCount'], ['已交齐行数', 'completedCount'], ['到期行数', 'dueCount'], ['按期交齐行数', 'onTimeCount'], ['按期交齐率', 'onTimeRate'], ['延期行数', 'overdueCount'], ['7天预警行数', 'warningCount'], ['待核对行数', 'reviewCount'], ['人工异常行数', 'exceptionCount'], ['已关闭行数', 'closedCount']];
  await add('指标汇总', [['指标', 'label', 28], ['数值', 'value', 22]], metrics.map(([label, key]) => ({ label, value: data.summary[key] ?? '未知/不适用' })));
  for (const [name, field, label, list] of [['供应商指标', 'supplier', '供应商', data.suppliers], ['月度指标', 'month', '交期月份', data.monthly]]) {
    await add(name, [[label, field, 30], ...metrics], list);
  }
  await add('数量分物料', [['物料编码', 'productCode', 24], ['物料名称', 'productName', 32], ['单位（未导出为空）', 'unit', 24], ['订单数量', 'orderedQuantity'], ['已交数量', 'deliveredQuantity'], ['未交数量', 'outstandingQuantity'], ['数量完成率', 'quantityRate']], data.summary.quantityByUnit);
  const rows = data.rows.map(row => ({ ...row, status: STATUS[row.status], createdDate: nativeDate(row.createdDate), dueDate: nativeDate(row.dueDate),
    receiptsQuantity: row.receipts.quantity, inboundQuantity: row.inbound.quantity, receiptsDate: nativeDate(row.receipts.lastDeliveryDate), inboundDate: nativeDate(row.inbound.lastDeliveryDate),
    ...row.followup.data, expectedShipDate: nativeDate(row.followup.data.expectedShipDate),
    checks: CHECKS.map(key => `${({ productCheck: '产品', specificationCheck: '规格', quantityCheck: '数量', labelCheck: '标签', receivingCheck: '收货信息' })[key]}：${({ pending: '待核验', pass: '一致', issue: '异常' })[row.followup.data[key]]}`).join('\n'),
    review: row[data.stage].reviewReasons.join('；'), closedText: row.closed ? '已关闭' : '未关闭',
    batchText: `计划${row.batchInfo.plannedCount}批；收料${row.batchInfo.receiptCount}批；入库${row.batchInfo.inboundCount}批${row.batchInfo.shared ? '（同订单同物料组）' : ''}${row.batchInfo.allocationPending ? '；尚未分配到交期' : ''}` }));
  await add('交付明细', [['订单号', 'orderNumber', 26], ['行号', 'lineNumber'], ['创建时间', 'createdDate'], ['交货日期', 'dueDate'], ['供应商', 'supplier', 30], ['物料编码', 'productCode', 24], ['产品', 'productName', 26], ['规格', 'specification', 26], ['单位', 'unit'], ['订单数量', 'quantity'], ['收料数量', 'receiptsQuantity'], ['最近收料日期', 'receiptsDate'], ['入库数量', 'inboundQuantity'], ['最近入库日期', 'inboundDate'], ['当前口径未交数量', 'remainingQuantity'], ['当前状态', 'status'], ['关闭标记', 'closedText'], ['交付批次备注', 'batchText', 50], ['生产进度', 'productionStatus'], ['发货进度', 'shippingStatus'], ['预计发货日期', 'expectedShipDate'], ['负责人', 'owner'], ['一致性核验', 'checks', 30], ['异常', 'exception', 45], ['处理措施', 'action', 45], ['备注', 'note', 40], ['标签要求', 'labelRequirement', 35], ['收货信息', 'receivingInfo', 40], ['待核对', 'review', 50], ['来源文件', 'filename', 40], ['工作表', 'sourceSheet', 24], ['原始行', 'sourceRow']], rows);
  const batchGroups = [...new Map(data.rows.map(row => [groupKey(row), row])).values()];
  await add('交付批次', [['订单号', 'orderNumber', 26], ['物料编码', 'productCode', 24], ['批次类型', 'type'], ['单据号', 'documentNumber', 26], ['批次日期', 'date'], ['候选数量', 'quantity'], ['有效数量', 'validQuantity'], ['分配状态', 'allocation', 35], ['核对说明', 'review', 50], ['来源位置', 'locations', 60]],
    batchGroups.flatMap(row => [['plannedBatches', '计划'], ['receiptBatches', '收料'], ['inboundBatches', '入库']].flatMap(([key, type]) => row.batchInfo[key].map(batch => ({
      orderNumber: row.orderNumber, productCode: row.productCode, type, documentNumber: batch.documentNumber || '', date: nativeDate(batch.date), quantity: batch.quantity,
      validQuantity: key === 'plannedBatches' ? batch.quantity : batch.validQuantity, allocation: row.batchInfo.shared ? batch.allocated ? '已按明确来源分配' : '组级批次，未分配到交期' : '本订单行批次',
      review: (batch.reviewReasons || (batch.review ? ['数量或原始明细待核对'] : [])).join('；'), locations: batch.sourceRows.map(source => `${source.filename || ''} ${source.sourceSheet} 第${source.sourceRow}行（原数量${source.quantity ?? '待核对'}）`).join('\n'),
    })))));
  await add('交付依据', [['交付类型', 'stage'], ['采购订单号', 'orderNumber', 26], ['原源单编号', 'originalSourceNumber', 26], ['追溯收料单', 'viaReceiptNumber', 26], ['交付单号', 'documentNumber', 26], ['物料编码', 'productCode', 24], ['交付日期', 'deliveryDate'], ['数量', 'quantity'], ['单位', 'unit'], ['来源文件', 'filename', 40], ['工作表', 'sourceSheet', 24], ['原始行', 'sourceRow']],
    data.rows.flatMap(row => STAGES.flatMap(stage => row[stage].events.map(event => ({ ...event, stage: stage === 'receipts' ? '收料' : '入库', originalSourceNumber: event.originalSourceNumber || event.orderNumber, deliveryDate: nativeDate(event.deliveryDate) })))));
  const issueColumns = [['问题', 'message', 65], ['类型', 'code', 24], ['订单号', 'orderNumber', 26], ['单据类型', 'sourceType'], ['来源文件', 'filename', 40], ['工作表', 'sourceSheet', 24], ['原始行', 'sourceRow']];
  await add('待核对', issueColumns, data.issues.filter(issue => issue.code !== 'OUTSIDE_ORDER_SCOPE'));
  await add('订单范围外单据', issueColumns, data.issues.filter(issue => issue.code === 'OUTSIDE_ORDER_SCOPE'));
  await add('统计口径', [['项目', 'name', 28], ['说明', 'value', 100]], [
    { name: '统计日期', value: nativeDate(data.asOfDate) }, { name: '当前口径', value: data.stage === 'receipts' ? '收料通知单' : '采购入库单' },
    { name: '筛选条件', value: JSON.stringify(data.filters) }, ...data.policy.map((value, i) => ({ name: `口径 ${i + 1}`, value })),
    ...data.slots.map(slot => ({ name: slot.label, value: slot.filename ? `${slot.filename}；版本 ${slot.currentVersionId}` : '未上传' })),
  ]);
  await book.commit();
  return book.stream.read();
}

export function createDeliveryRouter(db, permission) {
  const router = Router();
  let exporting = false;
  router.get('/files', permission('files'), (_req, res) => res.json({ slots: listSlots(db, DELIVERY_SLOTS) }));
  router.get('/dashboard', permission('dashboard'), (req, res) => {
    const data = currentData(db, deliveryFilters(req.query));
    data.issues = data.issues.filter(issue => issue.code !== 'OUTSIDE_ORDER_SCOPE');
    res.json(data);
  });
  router.get('/outside-scope', permission('dashboard'), (req, res) => {
    const pageText = req.query.page ?? '1', sizeText = req.query.pageSize ?? '20';
    if (typeof pageText !== 'string' || !/^\d{1,6}$/.test(pageText) || Number(pageText) < 1 || Number(pageText) > 100000 ||
      !['20', '50', '100'].includes(sizeText)) throw fail(400, '分页参数无效');
    const page = Number(pageText), pageSize = Number(sizeText);
    const outside = currentData(db).issues.filter(issue => issue.code === 'OUTSIDE_ORDER_SCOPE');
    res.json({ items: outside.slice((page - 1) * pageSize, page * pageSize), total: outside.length, page, pageSize });
  });
  router.get('/export', permission('dashboard'), permission('export'), async (req, res) => {
    if (exporting) throw fail(429, '正在生成交付报表，请稍后重试');
    exporting = true;
    try {
      const data = currentData(db, deliveryFilters(req.query));
      const output = await deliveryExport(data);
      audit(db, { actor: req.user, kind: 'operation', action: '导出供应商交付指标', outcome: 'success', details: data.filters });
      res.attachment(`供应商交付管理_${data.asOfDate}_V1.xlsx`).type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(output);
    } finally { exporting = false; }
  });
  router.patch('/followups/:key', permission('files'), permission('upload'), (req, res) => {
    const { key } = req.params, revision = req.body.revision;
    if (!/^[a-f0-9]{64}$/.test(key)) throw fail(400, '订单行标识无效');
    if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER) throw fail(400, '跟进版本无效');
    const data = validatedFollowup(req.body.data);
    const row = currentData(db).rows.find(item => item.key === key);
    if (!row || !row.followupAllowed) throw fail(409, '当前订单行不存在或无法唯一识别，请刷新并核对原始订单');
    const followup = transaction(db, () => {
      const existing = db.prepare('SELECT * FROM delivery_followups WHERE order_key=?').get(key);
      if ((existing?.revision || 0) !== revision) throw fail(409, '跟进记录已被更新，请刷新后重新填写');
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO delivery_followups VALUES (?,?,?,?,?) ON CONFLICT(order_key) DO UPDATE SET data_json=excluded.data_json,revision=excluded.revision,updated_at=excluded.updated_at,updated_by=excluded.updated_by`).run(key, JSON.stringify(data), revision + 1, now, req.user.username);
      audit(db, { actor: req.user, kind: 'operation', action: '更新供应商交付跟进', target: key, outcome: 'success', details: { orderNumber: row.orderNumber, revision: revision + 1 } });
      return { revision: revision + 1, data, updatedAt: now, updatedBy: req.user.username };
    });
    res.json({ followup });
  });
  return router;
}
