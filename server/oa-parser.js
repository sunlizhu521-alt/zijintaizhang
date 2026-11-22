import { PARSER_VERSION } from '../shared/constants.js';

export const oaFlowKey = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, '').toUpperCase();
const norm = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, '');
const fields = {
  flowCode: ['流程编号'], supplier: ['收款单位'], payer: ['业务所属公司'],
  amount: ['付款金额'], currency: ['币种'], signature: ['签字意见', '签字'],
  converted: ['判断金额'], original: ['原币金额'], rate: ['判断汇率'],
  summary: ['请求标题', '摘要'], status: ['流程状态'], node: ['当前节点'],
};
const required = ['flowCode', 'supplier', 'payer', 'amount', 'currency', 'signature'];
const invalid = message => Object.assign(new Error(message), { status: 422 });

export function cashierDates(signature) {
  const dates = [];
  const text = String(signature ?? '').normalize('NFKC');
  for (const block of text.matchAll(/\[\s*出纳执行\s*\]([^\[]*)/g)) {
    for (const match of block[1].matchAll(/\b(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})(?:日)?(?=$|[\sT,，;；。])/g)) {
      const [, y, m, d] = match, date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
      if (Number(y) >= 1900 && date.getUTCFullYear() === Number(y) && date.getUTCMonth() + 1 === Number(m) && date.getUTCDate() === Number(d)) dates.push(date.toISOString().slice(0, 10));
    }
  }
  return [...new Set(dates)].sort();
}

function header(sheet, textOf) {
  let best = { row: 1, columns: {}, missing: required };
  for (let n = 1; n <= Math.min(sheet.rowCount, 10); n++) {
    const names = new Map();
    sheet.getRow(n).eachCell({ includeEmpty: false }, (cell, col) => { const name = norm(textOf(cell)); if (!names.has(name)) names.set(name, col); });
    const columns = Object.fromEntries(Object.entries(fields).map(([key, aliases]) => [key, aliases.map(norm).map(name => names.get(name)).find(Boolean)]));
    const missing = required.filter(key => !columns[key]);
    if (missing.length < best.missing.length) best = { row: n, columns, missing };
  }
  return best;
}
export function oaSheetMetadata(workbook, textOf) {
  return workbook.worksheets.map(sheet => {
    const h = header(sheet, textOf), eligible = !h.missing.length;
    return { name: sheet.name, eligible, defaultSelected: eligible, reason: eligible ? '按流程编号去重读取' : `缺少：${h.missing.map(k => fields[k][0]).join('、')}` };
  });
}
export function parseOaWorkbook(workbook, selectedSheets, { textOf, valueOf, parseMoney }) {
  const sheets = oaSheetMetadata(workbook, textOf), eligible = sheets.filter(s => s.eligible).map(s => s.name);
  if (!eligible.length) throw invalid(`未找到 OA 流程表，必需表头：${required.map(k => fields[k][0]).join('、')}。`);
  if (selectedSheets !== undefined && (!Array.isArray(selectedSheets) || selectedSheets.length !== eligible.length || eligible.some(name => !selectedSheets.includes(name)))) throw invalid('对公付款OA流程须读取全部符合格式的工作表。');
  const records = new Map(), issues = [];
  let sourceCount = 0;
  for (const name of eligible) {
    const sheet = workbook.getWorksheet(name), h = header(sheet, textOf);
    sheet.eachRow({ includeEmpty: false }, (row, n) => {
      if (n <= h.row) return;
      const get = key => h.columns[key] ? textOf(row.getCell(h.columns[key])) : '';
      if (!get('flowCode') && !get('supplier')) return;
      if (/^(合计|总计|小计|汇总)$/.test(get('flowCode') || get('supplier'))) return;
      if (++sourceCount > 100000) throw invalid('OA 文件超过 100,000 行，请精简后上传。');
      const flowCode = get('flowCode'), flowKey = oaFlowKey(flowCode), source = { sourceSheet: name, sourceRow: n };
      const key = flowKey || `missing:${name}:${n}`;
      const currency = get('currency');
      const rmb = /^(人民币|人民币元|CNY|RMB|元|￥|¥)$/i.test(currency);
      const money = field => {
        if (!h.columns[field]) return null;
        try { return parseMoney(valueOf(row.getCell(h.columns[field]))); }
        catch { throw invalid(`${name} 第${n}行“${fields[field][0]}”：金额格式不正确，未替换当前文件。`); }
      };
      const amountCents = currency ? money(rmb ? 'amount' : 'converted') : null;
      const signature = get('signature'), executionDates = cashierDates(signature);
      const current = { key, category: 'corporate_oa', flowCode, flowKey, supplier: get('supplier'), payer: get('payer'),
        amountCents, originalAmountCents: money('original'), paymentAmountCents: money('amount'), currency, exchangeRate: get('rate'),
        summary: get('summary'), status: get('status'), currentNode: get('node'), signature, executionDates,
        paymentDate: executionDates.at(-1) || null, ...source, sources: [source], conflict: false };
      const previous = records.get(key);
      if (previous) {
        previous.sources.push(source);
        if (['supplier', 'payer', 'amountCents', 'currency', 'paymentAmountCents', 'originalAmountCents', 'signature'].some(field => previous[field] !== current[field])) {
          previous.conflict = true;
          (previous.conflicts ||= []).push({ ...current, sources: undefined, signature: current.signature });
        }
      } else records.set(key, current);
    });
  }
  for (const r of records.values()) {
    const add = message => issues.push({ code: 'OA_REVIEW', severity: 'warning', recordKey: r.key, sourceSheet: r.sourceSheet, sourceRow: r.sourceRow, supplier: r.supplier, flowCode: r.flowCode, message });
    if (!r.flowKey) add('缺少流程编号，无法关联和去重，暂不计入付款统计。');
    if (r.conflict) add('同一流程的金额、主体、币种或签字内容不同，请核对重复来源行；暂不计入付款统计。');
    if (r.amountCents === null) add('缺少可用人民币金额；外币须填写判断金额，暂不计入付款统计。');
    if (/\[\s*出纳执行\s*\]/.test(r.signature.normalize('NFKC')) && !r.paymentDate) add('有出纳执行节点，但没有有效完整付款日期，请核对签字内容。');
  }
  if (!records.size) throw invalid('OA 文件没有有效流程记录。');
  return { kind: 'corporate_oa', parserVersion: PARSER_VERSION, selectedSheets: eligible, records: [...records.values()], issues, sourceCount };
}
