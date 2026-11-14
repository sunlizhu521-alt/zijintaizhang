import ExcelJS from 'exceljs';
import { CATEGORIES } from '../shared/constants.js';

function makeSheet(book, name, columns, rows) {
  const sheet = book.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = columns.map(([header, key, width = 18]) => ({ header, key, width }));
  rows.forEach(row => sheet.addRow(row));
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, sheet.rowCount), column: columns.length } };
  sheet.eachRow((row, index) => {
    row.height = index === 1 ? 32 : 40;
    row.eachCell(cell => {
      cell.font = { name: 'Microsoft YaHei', size: 10, bold: index === 1, color: { argb: 'FF243247' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: index === 1 ? 'FFEAF0F5' : 'FFFFFFFF' } };
      cell.alignment = { horizontal: typeof cell.value === 'number' ? 'right' : 'center', vertical: 'middle', wrapText: true };
      const edge = { style: 'thin', color: { argb: 'FFD5DCE5' } };
      cell.border = { top: edge, right: edge, bottom: edge, left: edge };
      if (typeof cell.value === 'number') cell.numFmt = '#,##0.00';
      if (typeof cell.value === 'string' && cell.value.length > 70) row.height = Math.min(180, Math.max(row.height, Math.ceil(cell.value.length / 30) * 15));
    });
  });
  return sheet;
}
export async function dashboardExport(data) {
  const book = new ExcelJS.Workbook(); book.creator = '资金台账';
  const uploaded = new Set(data.slots.filter(slot => slot.currentVersionId).map(slot => slot.id));
  const amount = (slotId, cents) => uploaded.has(slotId) ? (cents ?? 0) / 100 : '未上传';
  makeSheet(book, '月度计划', [['月份', 'month'], ...Object.entries(CATEGORIES).map(([id, name]) => [name, id, 24])],
    data.months.map(m => ({ month: !m.month || m.month === 'pending' ? '时间待定' : m.month,
      ...Object.fromEntries(Object.keys(CATEGORIES).map(k => [k, amount(k === 'normal' || k === 'negotiated' ? 'schedule' : k, m[k])])) })));
  makeSheet(book, '筛选明细', [
    ['类别', 'category'], ['供应商', 'supplier', 34], ['付款主体', 'payer', 24], ['跟单员', 'owner'],
    ['选定期间计划金额', 'plan', 24], ['原台账申请金额', 'amount', 24], ['原台账累计已付', 'paid', 24], ['原台账剩余金额', 'remaining', 24],
    ['计划月份', 'months', 28], ['流程号', 'flowCode', 30], ['流程状态', 'status'], ['申请状态', 'applicationStatus'],
    ['摘要', 'summary', 40], ['备注', 'notes', 60], ['来源文件', 'filename', 45], ['工作表', 'sourceSheet'], ['原始行', 'sourceRow'],
  ], data.records.map(r => ({ ...r, category: CATEGORIES[r.category], plan: r.selectedPlanCents / 100,
    amount: r.amountCents / 100, paid: r.paidCents == null ? '未填写' : r.paidCents / 100,
    remaining: r.remainingCents == null ? '未填写' : r.remainingCents / 100,
    months: [...new Set((r.selectedPlans || r.plans).map(p => p.month || '时间待定'))].join('、') })));
  makeSheet(book, '统计口径', [['项目', 'name', 26], ['金额或说明', 'value', 90]], [
    { name: '明确月份付款计划', value: amount('schedule', data.summary.planCents) },
    { name: '时间待定付款计划', value: amount('schedule', data.summary.pendingPlanCents) },
    ...['shipment', 'after_sales', 'unregistered'].flatMap(category => [
      { name: CATEGORIES[category], value: amount(category, data.summary.forecastCents[category]) },
      { name: `${CATEGORIES[category]}（时间待定）`, value: amount(category, data.summary.pendingForecastCents?.[category]) },
    ]),
    { name: '台账累计已付（已知）', value: amount('schedule', data.summary.paidCents) },
    { name: '台账剩余金额（已知）', value: amount('schedule', data.summary.remainingCents) },
    { name: '累计金额范围', value: '已付、剩余受供应商、主体、人员和类别筛选影响，不受月份筛选；不按月份分摊部分已付款。' },
    { name: '缺失已付记录数', value: uploaded.has('schedule') ? String(data.summary.missingPaidCount) : '未上传' },
    { name: '缺失剩余记录数', value: uploaded.has('schedule') ? String(data.summary.missingRemainingCount) : '未上传' },
    { name: '预估与付款计划', value: '三类预估分别展示，可能与付款计划重复，未经核对不直接相加。' },
  ]);
  makeSheet(book, '待核对', [['问题', 'message', 70], ['来源工作表', 'sourceSheet', 24], ['原始行', 'sourceRow'], ['类型', 'code', 28]], data.issues);
  return book.xlsx.writeBuffer();
}
export async function logsExport(items) {
  const book = new ExcelJS.Workbook();
  makeSheet(book, '操作记录', [['北京时间', 'time', 26], ['账号', 'actor', 20], ['动作', 'action', 28], ['对象', 'target', 30],
    ['结果', 'outcome'], ['来源IP', 'ip', 24], ['状态码', 'status'], ['详细信息', 'details', 65]], items.map(i => ({ ...i,
      time: new Date(i.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
      actor: i.actorName || i.details?.attemptedUsername || '未登录',
      details: JSON.stringify(i.details), outcome: ({ success: '成功', failure: '失败', blocked: '已拦截' })[i.outcome] || i.outcome,
    })));
  return book.xlsx.writeBuffer();
}
