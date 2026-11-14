import ExcelJS from 'exceljs';
import yauzl from 'yauzl';
import { MAX_UPLOAD_BYTES, PARSER_VERSION, SLOTS } from '../shared/constants.js';
import { findDuplicateIssues } from './dashboard.js';

const MAX_EXPANDED_BYTES = 200 * 1024 * 1024;
const MAX_RECORDS = 100000;
const SLOT_IDS = new Set(SLOTS.map(slot => slot.id));
const normalize = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, '').trim();

function invalid(message, issues = []) {
  return Object.assign(new Error(message), { status: 422, issues });
}

async function checkArchive(buffer) {
  if (!Buffer.isBuffer(buffer)) throw invalid('上传内容不是有效文件。');
  if (!buffer.length || buffer.length > MAX_UPLOAD_BYTES) throw invalid('Excel 文件不能为空且不能超过 20 MB。');
  return new Promise((resolve, reject) => {
    let finished = false;
    let archive;
    const fail = error => {
      if (finished) return;
      finished = true;
      archive?.close();
      reject(error?.status === 422 ? error : invalid('Excel 压缩结构损坏或文件并非 .xlsx。'));
    };
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return fail(error);
      archive = zip;
      let entries = 0;
      let declaredBytes = 0;
      let actualBytes = 0;
      const names = new Set();
      zip.on('error', fail);
      zip.on('end', () => {
        if (finished) return;
        if (!names.has('[Content_Types].xml') || !names.has('xl/workbook.xml')) return fail(invalid('文件缺少 Excel 工作簿结构。'));
        finished = true;
        resolve();
      });
      zip.on('entry', entry => {
        if (finished) return;
        names.add(entry.fileName);
        declaredBytes += entry.uncompressedSize;
        if (++entries > 5000 || declaredBytes > MAX_EXPANDED_BYTES) return fail(invalid('Excel 解压内容过大，请精简文件后上传。'));
        if ((entry.generalPurposeBitFlag & 1) !== 0) return fail(invalid('不支持加密 Excel，请先取消文件密码。'));
        if (/vbaProject\.bin$/i.test(entry.fileName) || /^xl\/externalLinks\//i.test(entry.fileName)) {
          return fail(invalid('文件含宏或外部工作簿链接，请保存为不含宏和外链的 .xlsx。'));
        }
        if (entry.fileName.endsWith('/')) return zip.readEntry();
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return fail(streamError);
          stream.on('error', fail);
          stream.on('data', chunk => {
            actualBytes += chunk.length;
            if (actualBytes > MAX_EXPANDED_BYTES) {
              stream.destroy();
              fail(invalid('Excel 实际解压内容超过限制。'));
            }
          });
          stream.on('end', () => { if (!finished) zip.readEntry(); });
        });
      });
      zip.readEntry();
    });
  });
}

async function loadWorkbook(buffer, slotId) {
  if (!SLOT_IDS.has(slotId)) throw invalid('文件槽位不存在。');
  await checkArchive(buffer);
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(buffer); }
  catch { throw invalid('无法读取 Excel，请用 Excel 或 WPS 重新保存为 .xlsx 后上传。'); }
  return workbook;
}

function valueOf(cell) {
  const value = cell?.value;
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value !== 'object') return value;
  // ExcelJS 的 value 对象会省略为 0 的公式结果，result getter 保留有效零值。
  if ('formula' in value || 'sharedFormula' in value) return cell.result ?? value.result ?? null;
  if (value.error) return value.error;
  if (value.richText) return value.richText.map(part => part.text).join('');
  if ('text' in value) return value.text;
  return null;
}

function textOf(cell) {
  const value = valueOf(cell);
  return value === null ? '' : value instanceof Date ? value.toISOString().slice(0, 10) : String(value).trim();
}

function decimalString(value) {
  const text = String(value);
  if (!/[eE]/.test(text)) return text;
  const match = text.match(/^([+-]?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/);
  if (!match) return text;
  const [, sign, whole, fraction = '', exp] = match;
  const digits = whole + fraction;
  const position = whole.length + Number(exp);
  if (position <= 0) return `${sign}0.${'0'.repeat(-position)}${digits}`;
  if (position >= digits.length) return sign + digits + '0'.repeat(position - digits.length);
  return `${sign}${digits.slice(0, position)}.${digits.slice(position)}`;
}

export function parseMoney(value) {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return null;
  if (typeof value !== 'number' && typeof value !== 'string') throw invalid('金额必须为数字。');
  if (typeof value === 'number' && !Number.isFinite(value)) throw invalid('金额不是有限数字。');
  let text = (typeof value === 'number' ? decimalString(value) : value).normalize('NFKC').trim().replace(/^[¥￥]\s*/, '').replace(/\s*元$/, '');
  if (text.length > 80) throw invalid('金额超过可安全计算范围。');
  if (/^\(.*\)$/.test(text)) text = '-' + text.slice(1, -1);
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) throw invalid('金额格式不正确。');
  text = text.replaceAll(',', '');
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace(/^[+-]/, '').split('.');
  let cents = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
  if (fraction.length > 2 && Number(fraction[2]) >= 5) cents++;
  if (negative) cents = -cents;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER) || cents < BigInt(Number.MIN_SAFE_INTEGER)) throw invalid('金额超过可安全计算范围。');
  return Number(cents);
}

export function parseDate(value, date1904 = false) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || value > 2958465) return null;
    const serial = Math.floor(value);
    const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, serial < 60 ? 31 : 30);
    value = new Date(epoch + serial * 86400000);
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null;
    const date = value.toISOString().slice(0, 10);
    return { date, month: date.slice(0, 7) };
  }
  const input = String(value).normalize('NFKC').trim().replace(/[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?$/, '');
  const text = normalize(input);
  if (/^\d{5}(?:\.\d+)?$/.test(text)) return parseDate(Number(text), date1904);
  const match = text.match(/^(\d{4})[年/.-](\d{1,2})(?:[月/.-](\d{1,2}))?(?:日|月)?(?:周)?(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?$/);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = match[3] ? Number(match[3]) : 1;
  if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  const monthText = `${year}-${String(month).padStart(2, '0')}`;
  return { date: match[3] ? `${monthText}-${String(day).padStart(2, '0')}` : monthText, month: monthText };
}

function headersOf(sheet) {
  for (let rowNumber = 1; rowNumber <= Math.min(sheet.rowCount, 10); rowNumber++) {
    const headers = [];
    sheet.getRow(rowNumber).eachCell({ includeEmpty: false }, (cell, column) => {
      const label = textOf(cell);
      if (label) headers.push({ label, name: normalize(label), column });
    });
    if (headers.some(header => ['供应商', '供应商名称'].includes(header.name))) return { rowNumber, headers };
  }
  return { rowNumber: 1, headers: [] };
}

function columnOf(headers, names) {
  return headers.find(header => names.map(normalize).includes(header.name))?.column;
}

function sheetMetadata(workbook, slotId) {
  return workbook.worksheets.map(sheet => {
    const { headers, rowNumber } = headersOf(sheet);
    const supplier = columnOf(headers, ['供应商', '供应商名称']);
    const isSchedule = slotId === 'schedule';
    const expected = isSchedule && ['谈判付款', '正常付款'].includes(sheet.name);
    const forecast = ['预估付款月份', '供应商名称', '付款主体', '摘要', '申请付款金额', '账期', '备注'].every(label => columnOf(headers, [label]));
    const eligible = isSchedule ? expected && !!supplier : forecast;
    const backup = /原始|备份|汇总|合计/.test(sheet.name);
    let count = 0;
    if (supplier) sheet.eachRow({ includeEmpty: false }, (row, number) => {
      if (number > rowNumber && textOf(row.getCell(supplier)) && !/^(合计|总计|小计|汇总)$/.test(textOf(row.getCell(supplier)))) count++;
    });
    return { name: sheet.name, eligible, defaultSelected: eligible && (isSchedule || (!backup && sheet.state === 'visible')),
      reason: !eligible ? (isSchedule ? '不属于付款节奏的指定工作表，或缺少表头。' : '缺少预估模板必需表头。') : backup ? '原始、备份或汇总工作表，默认不计入。' : sheet.state !== 'visible' ? '隐藏工作表，默认不计入。' : '', recordCount: count };
  });
}

export async function inspectWorkbook(buffer, slotId) {
  const workbook = await loadWorkbook(buffer, slotId);
  return { sheets: sheetMetadata(workbook, slotId) };
}

function noteOf(cell) {
  if (typeof cell.note === 'string') return cell.note;
  return cell.note?.texts?.map(part => part.text ?? '').join('') ?? '';
}

export async function parseWorkbook(buffer, { slotId, selectedSheets } = {}) {
  const workbook = await loadWorkbook(buffer, slotId);
  const sheets = sheetMetadata(workbook, slotId);
  if (selectedSheets !== undefined && (!Array.isArray(selectedSheets) || selectedSheets.some(name => typeof name !== 'string'))) throw invalid('工作表选择格式不正确。');
  const selected = slotId === 'schedule' ? ['谈判付款', '正常付款'] : [...new Set(selectedSheets ?? sheets.filter(sheet => sheet.defaultSelected).map(sheet => sheet.name))];
  if (!selected.length) throw invalid('请选择至少一张符合格式的工作表。');
  for (const name of selected) {
    const metadata = sheets.find(sheet => sheet.name === name);
    if (!metadata?.eligible) throw invalid(`工作表“${name}”不存在或缺少必需表头。`, [{ code: 'INVALID_SHEET', sourceSheet: name, sourceRow: 1, message: '工作表不存在或缺少必需表头。' }]);
  }
  const records = [], issues = [], errors = [];
  for (const sheetName of selected) {
    const sheet = workbook.getWorksheet(sheetName);
    const { headers, rowNumber } = headersOf(sheet);
    const sourceCategory = slotId === 'schedule' ? (sheetName === '谈判付款' ? 'negotiated' : 'normal') : slotId;
    const supplierCol = columnOf(headers, ['供应商', '供应商名称']);
    const amountCol = columnOf(headers, sourceCategory === 'negotiated' ? ['OA-申请付款金额'] : sourceCategory === 'normal' ? ['本次申请付款金额'] : ['申请付款金额']);
    const payerCol = columnOf(headers, ['付款主体']);
    const dateCol = columnOf(headers, sourceCategory === 'normal' ? ['应付时间'] : sourceCategory === 'negotiated' ? ['应付款时间'] : ['预估付款月份']);
    const splitCol = columnOf(headers, ['是否谈判分批']);
    const paidCol = columnOf(headers, ['已付金额']);
    const remainingCol = columnOf(headers, ['剩余付款金额', '剩余金额']);
    const summaryCol = columnOf(headers, ['摘要']);
    const monthlyCols = headers.map(header => ({ ...header, match: header.name.match(/^(\d{4})年(\d{1,2})月支付$/) })).filter(header => header.match);
    if (sourceCategory === 'negotiated' && !splitCol) {
      throw invalid(`工作表“${sheetName}”缺少“是否谈判分批”字段。`, [{ code: 'MISSING_HEADER', sourceSheet: sheetName, sourceRow: rowNumber, message: '请保留“是否谈判分批”表头，并填写是或否。' }]);
    }
    if (!amountCol || !payerCol || !summaryCol || !dateCol || (slotId === 'schedule' && (!paidCol || !remainingCol)) || (sourceCategory === 'negotiated' && !monthlyCols.length)) {
      throw invalid(`工作表“${sheetName}”缺少必需字段。`, [{ code: 'MISSING_HEADER', sourceSheet: sheetName, sourceRow: rowNumber, message: '请保留模板中的金额、日期、付款主体、摘要及已付/剩余字段；谈判付款还须有带年份的月支付列。' }]);
    }
    const seenMonths = new Set();
    for (const header of monthlyCols) {
      const month = Number(header.match[2]);
      header.month = `${header.match[1]}-${String(month).padStart(2, '0')}`;
      if (month < 1 || month > 12 || seenMonths.has(header.month)) throw invalid(`工作表“${sheetName}”的支付月份表头无效或重复。`);
      seenMonths.add(header.month);
    }
    sheet.eachRow({ includeEmpty: false }, (row, number) => {
      if (number <= rowNumber) return;
      const supplier = textOf(row.getCell(supplierCol));
      const sourceAmount = valueOf(row.getCell(amountCol));
      if (/^(合计|总计|小计|汇总)$/.test(supplier)) return;
      if (!supplier && (sourceAmount === null || sourceAmount === '')) return;
      const key = `${slotId}:${sheetName}:${number}`;
      const location = { sourceSheet: sheetName, sourceRow: number, recordKey: key, slotId };
      const warn = (code, message) => issues.push({ ...location, code, severity: 'warning', message });
      const error = message => errors.push({ ...location, code: 'INVALID_ROW', message });
      let category = sourceCategory;
      if (sourceCategory === 'negotiated') {
        const split = normalize(textOf(row.getCell(splitCol)));
        if (!['是', '否'].includes(split)) {
          error(`${row.getCell(splitCol).address}：“是否谈判分批”须填写是或否。`);
          return;
        }
        category = split === '是' ? 'negotiated' : 'negotiated_normal';
      }
      const zeroedCells = [];
      const money = column => {
        const cell = row.getCell(column);
        try {
          const value = parseMoney(valueOf(cell));
          if (value === null) zeroedCells.push(cell.address);
          return value ?? 0;
        } catch (cause) {
          error(`${cell.address}：${cause.message}`);
          return null;
        }
      };
      if (!supplier) error(`第 ${number} 行缺少供应商。`);
      const amountCents = money(amountCol);
      if (!supplier || amountCents === null) return;
      const paidCents = slotId === 'schedule' ? money(paidCol) : null;
      const remainingCents = slotId === 'schedule' ? money(remainingCol) : null;
      const date = parseDate(valueOf(row.getCell(dateCol)), workbook.properties.date1904);
      const getText = names => {
        const column = columnOf(headers, names);
        return column ? textOf(row.getCell(column)) : '';
      };
      const raw = {}, comments = {}, notes = [];
      for (const header of headers) {
        const cell = row.getCell(header.column);
        let label = header.label;
        let duplicate = 2;
        while (Object.hasOwn(raw, label)) label = `${header.label}（${duplicate++}）`;
        const value = valueOf(cell);
        raw[label] = value instanceof Date ? value.toISOString().slice(0, 10) : value;
        if (/备注|沟通记录|谈判明细/.test(header.name) && textOf(cell)) notes.push(`${label}：${textOf(cell)}`);
        const note = noteOf(cell);
        if (note) comments[cell.address] = note;
      }
      const plans = [];
      if (sourceCategory === 'negotiated') {
        for (const header of monthlyCols) {
          const cell = row.getCell(header.column);
          const hasFormula = cell.value && typeof cell.value === 'object' && ('formula' in cell.value || 'sharedFormula' in cell.value);
          // 空白月份不凭空指定付款时间；显式零值和无缓存结果的公式保留为当月零元。
          if (!hasFormula && textOf(cell) === '') continue;
          const value = money(header.column);
          if (value !== null) plans.push({ month: header.month, amountCents: value });
        }
        if (!plans.length) {
          plans.push({ month: null, amountCents });
          warn('MISSING_MONTH', '没有明确的月支付金额，原申请金额单列为时间待定。');
        } else {
          const total = plans.reduce((sum, plan) => sum + BigInt(plan.amountCents), 0n);
          if (total !== BigInt(amountCents)) warn('PLAN_AMOUNT_MISMATCH', '各月计划金额之和与 OA 申请付款金额不一致，请核对原表。');
        }
      } else {
        plans.push({ month: date?.month ?? null, amountCents });
        if (!date) warn('MISSING_MONTH', '付款日期或月份缺失、无年份或格式不明确，单列为时间待定。');
      }
      const settled = getText(['是否结清']);
      const status = getText(['流程状态']);
      const payer = textOf(row.getCell(payerCol));
      if (!payer) warn('MISSING_PAYER', '付款主体为空，请核对原表。');
      if (slotId === 'schedule') {
        if (paidCents !== null && remainingCents !== null && BigInt(paidCents) + BigInt(remainingCents) !== BigInt(amountCents)) warn('BALANCE_MISMATCH', '已付金额加剩余金额与申请金额不一致，请核对原表。');
        if ((settled === '是' && remainingCents !== null && remainingCents !== 0) || (status === '归档' && remainingCents !== null && remainingCents > 0)) warn('STATUS_CONFLICT', '结清或流程状态与剩余金额存在矛盾；未据此改动已付金额。');
      }
      if (zeroedCells.length) warn('ZERO_DEFAULTED', `${zeroedCells.join('、')}：金额为空或公式没有已保存的计算结果，已按0保存。`);
      if ([amountCents, paidCents, remainingCents, ...plans.map(plan => plan.amountCents)].some(value => value !== null && value < 0)) warn('NEGATIVE_AMOUNT', '记录含负金额，已按原值保留，请确认是否为退款或冲减。');
      records.push({ key, slotId, sourceSheet: sheetName, sourceRow: number, category,
        owner: getText(['跟单员', '创跟单员']) || (slotId === 'schedule' ? '' : sheetName),
        supplier, payer, summary: textOf(row.getCell(summaryCol)),
        flowCode: getText(['对公付款OA流程号', '对公付款0A流程号', '流程编号']) || (slotId !== 'schedule' ? notes.join('\n').match(/MDST-DGFK\d+/)?.[0] ?? '' : ''),
        amountCents, paidCents, remainingCents, status, settled,
        applicationStatus: getText(['是否提交付款申请单']), dueDate: date?.date ?? null,
        notes: notes.join('\n'), plans, raw, comments,
      });
      if (records.length > MAX_RECORDS) throw invalid('文件有效记录超过 100,000 条，请拆分后上传。');
    });
  }
  if (errors.length) throw invalid(`发现 ${errors.length} 处数据错误，未替换当前文件。`, errors);
  if (!records.length) throw invalid('所选工作表没有有效业务记录，未替换当前文件。');
  issues.push(...findDuplicateIssues(records));
  return { parserVersion: PARSER_VERSION, records, issues, selectedSheets: selected, sheets };
}
