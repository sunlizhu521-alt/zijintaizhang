import { PARSER_VERSION } from '../shared/constants.js';

const SOURCES = { delivery_orders: 'orders', delivery_receipts: 'receipts', delivery_inbound: 'inbound' };
const common = {
  lineNumber: ['分录行号', '明细行号', '行号', '分录号'],
  supplier: ['供应商名称', '供应商', '供货方', '供货方名称', '供应商.名称'],
  productCode: ['物料编码', '物料代码', '产品编码', '商品编码', '物料.编码'],
  productName: ['物料名称', '产品名称', '商品名称', '物料.名称'],
  specification: ['规格型号', '规格', '型号', '物料.规格型号'],
  unit: ['采购单位', '单位', '计量单位', '库存单位', '单位名称'],
};
const fields = {
  orders: { ...common, orderNumber: ['采购订单号', '采购订单编号', '单据编号', '订单编号', '订单号'],
    quantity: ['采购数量', '订单数量', '数量'], createdDate: ['创建时间', '创建日期', '订单创建时间', '订单创建日期', '采购日期'],
    dueDate: ['交货日期', '交货时间', '计划交货日期', '要求交货日期', '约定交货日期', '交期'],
    labelRequirement: ['标签要求', '标签信息', '标签'], receivingInfo: ['收货信息', '收货地址', '收货地点'] },
  receipts: { ...common, unit: ['收料单位', '单位', '计量单位', '采购单位', '单位名称'], documentNumber: ['收料通知单号', '收料通知单编号', '单据编号', '单据号'],
    orderNumber: ['源单单号', '源单编号', '源单据编号', '源订单号'],
    sourceLineNumber: ['源单行号', '源单分录行号', '源分录行号', '源订单行号'],
    quantity: ['收料数量', '交货数量', '通知数量', '交付数量', '实收数量', '数量'],
    deliveryDate: ['交付时间', '交付日期', '收料日期', '收料时间', '业务日期', '单据日期', '日期'] },
  inbound: { ...common, unit: ['库存单位', '单位', '计量单位', '采购单位', '单位名称'], documentNumber: ['采购入库单号', '采购入库单编号', '入库单号', '单据编号', '单据号'],
    orderNumber: ['源单单号', '源单编号', '源单据编号', '源订单号'],
    sourceLineNumber: ['源单行号', '源单分录行号', '源分录行号', '源订单行号'],
    quantity: ['实收数量', '入库数量', '交付数量', '数量'],
    deliveryDate: ['交付时间', '交付日期', '入库日期', '入库时间', '业务日期', '单据日期', '日期'] },
};
const required = {
  orders: ['orderNumber', 'supplier', 'productCode', 'quantity', 'createdDate', 'dueDate'],
  receipts: ['documentNumber', 'orderNumber', 'productCode', 'quantity', 'deliveryDate'],
  inbound: ['documentNumber', 'orderNumber', 'productCode', 'quantity', 'deliveryDate'],
};
const normalize = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, '').trim();
const invalid = (message, issues = []) => Object.assign(new Error(message), { status: 422, issues });
export const isDeliverySlot = slotId => Object.hasOwn(SOURCES, slotId);

function valueOf(cell) {
  const value = cell?.value;
  if (value == null || value instanceof Date || typeof value !== 'object') return value ?? null;
  if ('formula' in value || 'sharedFormula' in value) return cell.result ?? value.result ?? null;
  if (value.richText) return value.richText.map(part => part.text).join('');
  if ('text' in value) return value.text;
  return value.error ?? null;
}
const textOf = cell => {
  const value = valueOf(cell);
  return value == null ? '' : value instanceof Date ? value.toISOString().slice(0, 10) : String(value).trim();
};

function columnsOf(headers, sourceType) {
  const columns = {}, conflicts = [];
  for (const [key, names] of Object.entries(fields[sourceType])) {
    // Prefer the explicit business field over generic 日期/数量 when both are exported.
    for (const name of names) {
      const matches = headers.filter(header => header.name === normalize(name));
      if (!matches.length) continue;
      if (matches.length > 1) conflicts.push(names[0]);
      columns[key] = matches[0];
      break;
    }
  }
  return { columns, conflicts };
}

function headersOf(sheet, sourceType) {
  let best = { rowNumber: 1, headers: [], columns: {}, conflicts: [], score: -1 };
  for (let rowNumber = 1; rowNumber <= Math.min(sheet.rowCount, 20); rowNumber++) {
    const headers = [];
    sheet.getRow(rowNumber).eachCell({ includeEmpty: false }, (cell, column) => {
      const label = textOf(cell);
      if (label) headers.push({ label, name: normalize(label), column });
    });
    const { columns, conflicts } = columnsOf(headers, sourceType);
    const score = required[sourceType].filter(key => columns[key]).length * 10 + Object.keys(columns).length;
    if (score > best.score) best = { rowNumber, headers, columns, conflicts, score };
  }
  return best;
}

export function deliverySheetMetadata(workbook, slotId) {
  const sourceType = SOURCES[slotId];
  return workbook.worksheets.map(sheet => {
    const { rowNumber, columns, conflicts } = headersOf(sheet, sourceType);
    const missing = required[sourceType].filter(key => !columns[key]).map(key => fields[sourceType][key][0]);
    const eligible = !missing.length && !conflicts.length;
    const backup = /原始|备份|汇总|合计/.test(sheet.name);
    return { name: sheet.name, rowCount: sheet.rowCount, headerRow: rowNumber, eligible,
      defaultSelected: eligible && !backup && sheet.state === 'visible',
      reason: missing.length ? `缺少必需字段：${missing.join('、')}` : conflicts.length ? `表头重复，无法确定读取列：${conflicts.join('、')}` : backup ? '原始、备份或汇总工作表，默认不计入。' : sheet.state !== 'visible' ? '隐藏工作表，默认不计入。' : '',
      mapping: Object.fromEntries(Object.entries(columns).map(([key, header]) => [key, header.label])) };
  });
}

function quantityOf(value) {
  if (value == null || value === '') return { value: null, problem: '数量为空或公式没有已保存结果' };
  if (typeof value !== 'number' && typeof value !== 'string') return { value: null, problem: '数量不是有效数字' };
  let text = String(value).normalize('NFKC').trim();
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) text = text.replace(/,/g, '');
  if (typeof value === 'number' && Number.isFinite(value) && /e/i.test(text)) text = value.toFixed(6);
  if (!/^[+]?\d+(?:\.\d+)?$/.test(text)) return { value: null, problem: '数量须为非负数字；负数退货须先核对' };
  const [whole, fraction = ''] = text.replace(/^\+/, '').split('.');
  if (fraction.replace(/0+$/, '').length > 6) return { value: null, problem: '数量超过 6 位小数，未自动舍入' };
  const scaled = BigInt(whole) * 1000000n + BigInt((fraction + '000000').slice(0, 6));
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER)) return { value: null, problem: '数量超过可安全计算范围' };
  const number = Number(scaled) / 1000000;
  if (typeof value === 'number' && number !== value) return { value: null, problem: '数量超过 6 位小数，未自动舍入' };
  return { value: number };
}

function fullDate(value, date1904, parseDate) {
  const parsed = parseDate(value, date1904)?.date;
  return parsed && /^\d{4}-\d{2}-\d{2}$/.test(parsed) && parsed >= '1900-01-01' ? parsed : null;
}

export function parseDeliveryWorkbook(workbook, { slotId, selectedSheets }, parseDate) {
  const sourceType = SOURCES[slotId];
  const sheets = deliverySheetMetadata(workbook, slotId);
  if (selectedSheets !== undefined && (!Array.isArray(selectedSheets) || selectedSheets.some(name => typeof name !== 'string'))) throw invalid('工作表选择格式不正确。');
  const selected = [...new Set(selectedSheets ?? sheets.filter(sheet => sheet.defaultSelected).map(sheet => sheet.name))];
  if (!selected.length) throw invalid('请选择至少一张符合交付字段要求的工作表。', sheets.filter(s => !s.eligible).map(s => ({ code: 'MISSING_HEADER', sourceSheet: s.name, sourceRow: s.headerRow, message: s.reason })));
  for (const name of selected) {
    const metadata = sheets.find(sheet => sheet.name === name);
    if (!metadata?.eligible) throw invalid(`工作表“${name}”${metadata ? `：${metadata.reason}` : '不存在'}`);
  }
  const records = [], issues = [];
  for (const name of selected) {
    const sheet = workbook.getWorksheet(name);
    const { rowNumber, headers, columns } = headersOf(sheet, sourceType);
    sheet.eachRow({ includeEmpty: false }, (row, number) => {
      if (number <= rowNumber) return;
      const mappedValues = Object.fromEntries(Object.entries(columns).map(([key, header]) => [key, valueOf(row.getCell(header.column))]));
      if (!Object.values(mappedValues).some(value => value !== null && value !== '')) return;
      const identityKeys = ['orderNumber', 'documentNumber', 'supplier', 'productCode', 'productName'];
      const identities = identityKeys.filter(key => columns[key]).map(key => normalize(mappedValues[key]));
      const isTotal = value => /^(合计|总计|小计|汇总)(?:[:：])?$/.test(normalize(value));
      if (identities.some(isTotal) || (identities.every(value => !value) && headers.some(header => isTotal(valueOf(row.getCell(header.column)))))) return;
      if (required[sourceType].every(key => normalize(mappedValues[key]) === columns[key].name)) return;
      const record = { id: `${slotId}:${name}:${number}`, sourceType, sourceSheet: name, sourceRow: number, rawFields: {}, invalidFields: [] };
      const seenHeaders = new Map();
      for (const header of headers) {
        const count = (seenHeaders.get(header.label) || 0) + 1;
        seenHeaders.set(header.label, count);
        const raw = valueOf(row.getCell(header.column));
        const cellValue = row.getCell(header.column).value;
        record.rawFields[`${header.label}${count > 1 ? `（${count}）` : ''}`] = raw instanceof Date ? raw.toISOString().slice(0, 10) : raw ?? (cellValue?.formula ? `=${cellValue.formula}（无已保存结果）` : '');
      }
      const issue = (key, message, code = 'INVALID_DELIVERY_FIELD') => {
        if (!record.invalidFields.includes(key)) record.invalidFields.push(key);
        issues.push({ code, severity: 'warning', sourceSheet: name, sourceRow: number, sourceType, orderNumber: String(mappedValues.orderNumber ?? '').trim(), recordKey: record.id, message: `${name} 第 ${number} 行：${message}` });
      };
      for (const key of Object.keys(fields[sourceType])) {
        if (key === 'quantity' || key.endsWith('Date')) continue;
        record[key] = columns[key] ? textOf(row.getCell(columns[key].column)) : '';
        if (required[sourceType].includes(key) && !record[key]) issue(key, `${fields[sourceType][key][0]}为空`);
      }
      if (columns.unit && !record.unit) issue('unit', '已导出的单位字段为空，请核对该行单位');
      const quantity = quantityOf(mappedValues.quantity);
      record.quantity = quantity.value;
      if (quantity.problem) issue('quantity', quantity.problem, 'INVALID_DELIVERY_QUANTITY');
      for (const key of sourceType === 'orders' ? ['createdDate', 'dueDate'] : ['deliveryDate']) {
        record[key] = fullDate(mappedValues[key], workbook.properties.date1904, parseDate);
        if (!record[key]) issue(key, `${fields[sourceType][key][0]}为空或不是明确的年月日`, 'INVALID_DELIVERY_DATE');
      }
      if (record.createdDate && record.dueDate && record.dueDate < record.createdDate) issue('dueDate', '交货日期早于创建日期，请核对', 'DELIVERY_DATE_CONFLICT');
      records.push(record);
      if (records.length > 100000) throw invalid('交付记录超过 100,000 条，请精简后上传。');
    });
  }
  return { parserVersion: PARSER_VERSION, kind: 'delivery', sourceType, records, issues, selectedSheets: selected, sheets };
}
