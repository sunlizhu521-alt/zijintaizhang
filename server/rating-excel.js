import ExcelJS from 'exceljs';
import { checkArchive } from './parser.js';
import { normalizeWorksheetParts } from './xlsx-compat.js';
import { fail, textValue } from './rating-store.js';
import { RATING_MONTH_LABELS } from '../shared/rating.js';
export async function parseRatingSuppliers(buffer) {
  await checkArchive(buffer);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await normalizeWorksheetParts(buffer));
  const sheet = book.getWorksheet('供应商名单') || book.worksheets.find(s => s.state === 'visible');
  if (!sheet || sheet.rowCount > 5001) throw fail('请选择不超过5000行的供应商名单', 422);
  const headers = sheet.getRow(1).values.map(value => String(value || '').replace(/\s/g, ''));
  const nameColumns = headers.flatMap((value, index) => ['供应商名称', '供应商', '供应商简称'].includes(value) ? [index] : []), stateCol = headers.indexOf('状态');
  if (nameColumns.length !== 1) throw fail('首行需要唯一的“供应商名称”列，请使用模板', 422);
  const nameCol = nameColumns[0], rows = [], seen = new Map();
  sheet.eachRow((row, index) => {
    if (index === 1) return;
    const nameCell = row.getCell(nameCol);
    const status = stateCol > 0 ? row.getCell(stateCol).text.trim() : '';
    if (nameCell.type === ExcelJS.ValueType.Formula || nameCell.type === ExcelJS.ValueType.Error) throw fail(`第${index}行供应商名称不能是公式或错误值`, 422);
    if (!nameCell.text.trim() && !status) return;
    const name = textValue(nameCell.text, `第${index}行供应商名称`, 200);
    if (!['', '启用', '停用'].includes(status)) throw fail(`第${index}行状态须为启用或停用`, 422);
    const active = status ? status === '启用' : undefined;
    if (seen.has(name)) { if (seen.get(name).active !== active) throw fail(`第${index}行同名供应商的状态不一致，请核对`, 422); return; }
    const value = { name, ...(active === undefined ? {} : { active }) }; seen.set(name, value); rows.push(value);
  });
  if (!rows.length) throw fail('名单没有有效供应商', 422);
  return rows;
}
function sheet(book, name, headers, rows) {
  const s = book.addWorksheet(name);
  s.addRow(headers); rows.forEach(r => s.addRow(r));
  s.views = [{ state: 'frozen', ySplit: 1 }];
  s.autoFilter = { from: { row: 1, column: 1 }, to: { row: s.rowCount, column: headers.length } };
  s.columns.forEach((c, i) => { c.width = /依据|说明|措施|标准|原因|问题/.test(headers[i]) ? 40 : 22; });
  s.eachRow((row, n) => { row.height = n === 1 ? 32 : Math.min(120, Math.max(28, ...row.values.filter(Boolean).map(v => Math.ceil(String(v).length / 20) * 18)));
    row.eachCell(c => { c.font = { name: '微软雅黑', size: 11, ...(n === 1 ? { color: { argb: 'FFFFFFFF' }, bold: true } : {}) }; c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: n === 1 ? 'FF8265E7' : 'FFFFFFFF' } }; c.border = Object.fromEntries(['top', 'bottom', 'left', 'right'].map(k => [k, { style: 'thin', color: { argb: 'FFDDE1E9' } }])); if (c.value instanceof Date) c.numFmt = 'yyyy-mm-dd'; });
  });
  return s;
}
export async function supplierTemplate() {
  const book = new ExcelJS.Workbook();
  sheet(book, '供应商名单', ['供应商名称'], [['示例供应商（导入前请替换）']]);
  return book.xlsx.writeBuffer();
}
const date = value => value ? new Date(`${value}T00:00:00Z`) : '';
export async function exportRating(bundle) {
  const book = new ExcelJS.Workbook();
  const names = new Map(bundle.assignments.map(a => [a.supplier_id, a]));
  sheet(book, '评分汇总', ['月份', '供应商名称', '交期', '数量', '配合', '总分', '等级', '已评人数', '应评人数', '状态', '说明'], bundle.summaries.map(s => [s.month, s.name, ...['交期', '数量', '配合'].map(g => s.groups[g] == null ? '' : Math.round(s.groups[g] * 10) / 10), s.total ?? '', s.grade, s.count, s.expected, s.exempt ? '不参评' : RATING_MONTH_LABELS[bundle.month.status], s.exempt ? s.reason : s.count < s.expected ? '部分评分结果' : '']));
  sheet(book, '个人评分', ['月份', '供应商名称', '评价人', '状态', ...bundle.rule.items.map(i => `${i.name}(${i.max}分)`), '总分', '评分依据'], bundle.scores.map(s => [s.month, names.get(s.supplier_id)?.name, s.raterName, s.status === 'submitted' ? '已提交' : '草稿', ...bundle.rule.items.map(i => s.scores[i.id] ?? ''), s.status === 'submitted' ? Object.values(s.scores).reduce((a, b) => a + b, 0) : '', bundle.rule.items.map(i => `${i.name}：${s.notes[i.id] || ''}`).join('\n')]));
  sheet(book, '过程记录', ['月份', '供应商名称', '项目', '问题及依据', '责任归属', '改善措施', '负责人', '计划完成日期', '实际完成日期', '状态', '采购复核意见'], bundle.records.map(r => [r.month, names.get(r.supplier_id)?.name, bundle.rule.items.find(i => i.id === r.item)?.name || r.item, r.issue, r.attribution, r.action, r.owner, date(r.dueDate), date(r.completedDate), r.state, r.review]));
  sheet(book, '规则说明', ['规则版本', '维度', '项目', '满分', '评分标准'], bundle.rule.items.map(i => [bundle.rule.id, i.group, i.name, i.max, i.standard]));
  sheet(book, '统计口径', ['项目', '说明'], [['评分性质', '人工评价分；无质量维度；不是自动计算的交付达成率'], ['月度分', '已提交完整个人评分等权平均；草稿、撤回、缺评不计入；不参评不计分'], ['等级', '最终成绩四舍五入保留1位小数后定级：A≥90、B≥80、C≥70、D<70'], ['规则', '确认无欠交、风险或异常时相应处理项可满分；不了解情况不能自动满分'], ['季度年度', '只汇总已结月且有评分的月份，按月等权；不足完整期间为阶段结果'], ['报告状态', bundle.month.status === 'closed' ? '结月快照；后续重开生成新版本，旧版本保留' : bundle.month.status === 'paused' ? '临时关闭；已有评分保留，尚未结月' : '当前实时数据，尚未结月']]);
  return book.xlsx.writeBuffer();
}
export async function exportRatingPeriod(data, year, period) {
  const book = new ExcelJS.Workbook();
  const rows = data.periods.filter(s => s.period === period);
  sheet(book, '期间评分汇总', ['年度', '期间', '供应商名称', '交期', '数量', '配合', '总分', '等级', '有效月份', '说明'], rows.map(s => [Number(year), period === 'year' ? '全年' : period.replace('Q', '') + '季度', s.name, ...['交期', '数量', '配合'].map(g => Math.round(s.groups[g] * 10) / 10), s.total, s.grade, s.months.join('、'), s.partial ? '阶段结果 / 含缺评' : '完整期间']));
  const keys = new Set(rows.flatMap(s => s.months.map(m => `${s.supplierId}/${m}`)));
  sheet(book, '月度计算依据', ['月份', '供应商名称', '总分', '等级', '已评', '应评'], data.monthly.filter(s => keys.has(`${s.supplierId}/${s.month}`)).map(s => [s.month, s.name, s.total, s.grade, s.count, s.expected]));
  sheet(book, '统计口径', ['项目', '说明'], [['汇总', '按已结月且有评分的月均分等权计算，中间保留精度，最终成绩保留1位小数后定级'], ['范围', '只展示全部纳入月份均有权查看的期间汇总；不足完整期间或含缺评时标注阶段结果'], ['评分', '人工履约评价；缺评不补零，不参评不计分']]);
  return book.xlsx.writeBuffer();
}
