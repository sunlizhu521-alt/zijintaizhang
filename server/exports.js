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
  const metrics = [['paidCents', '已付'], ['unpaidCents', '未付'], ['totalCents', '合计']];
  for (const [name, table, includePeriod] of [
    ['月度付款汇总', data.paymentTable, true], ['时间待定付款汇总', data.pendingPaymentTable, false],
  ]) {
    const periods = [...table.months.map(month => [month, month === 'pending' ? '时间待定' : month]), ...(includePeriod ? [['period', '所选期间']] : [])];
    const labels = Object.fromEntries(table.rows.map(row => [row.id, row.label]));
    const monthly = makeSheet(book, name, [['分类', 'label', 28], ['上级分类', 'parent', 24], ['数据状态', 'sourceStatus', 40],
      ...periods.flatMap(([id, label]) => metrics.map(([key, title]) => [`${label}${title}（元）`, `${id}:${key}`, 22]))],
    table.rows.map(row => ({ label: row.label, parent: labels[row.parentId] || '—',
      sourceStatus: !row.available ? '未上传' : row.missingSources.length ? `已上传部分；缺少：${row.missingSources.join('、')}` : '完整',
      ...Object.fromEntries(periods.flatMap(([id]) => metrics.map(([key]) => {
        const value = (id === 'period' ? row.period : row.cells[id])[key];
        return [`${id}:${key}`, !row.available ? '未上传' : value === null ? '待核对' : value / 100];
      }))) })));
    monthly.views = [{ state: 'frozen', xSplit: 1, ySplit: 1 }];
    table.rows.forEach((item, index) => {
      const row = monthly.getRow(index + 2);
      row.getCell(1).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true, indent: item.depth };
      if (!item.parentId || item.id === 'forecast_group') row.eachCell(cell => {
        cell.font = { ...cell.font, bold: true };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: item.id === 'total' ? 'FFFBEADF' : 'FFF3F5F7' } };
      });
    });
  }
  makeSheet(book, '筛选明细', [
    ['类别', 'category'], ['供应商', 'supplier', 34], ['付款主体', 'payer', 24], ['跟单员', 'owner'],
    ['选定期间计划金额', 'plan', 24], ['原台账申请金额', 'amount', 24], ['原台账累计已付', 'paid', 24], ['原台账剩余金额', 'remaining', 24],
    ['计划月份', 'months', 28], ['流程号', 'flowCode', 30], ['流程状态', 'status'], ['申请状态', 'applicationStatus'],
    ['摘要', 'summary', 40], ['备注', 'notes', 60], ['来源文件', 'filename', 45], ['工作表', 'sourceSheet'], ['原始行', 'sourceRow'],
    ['选定范围已付（新规则）', 'selectedPaid', 26], ['选定范围未付（新规则）', 'selectedUnpaid', 26], ['付款判定依据', 'paymentBasis', 70],
    ['批注付款日期', 'paymentDates', 32], ['付款依据版本', 'progressVersion', 60],
  ], data.records.map(r => ({ ...r, category: CATEGORIES[r.category], plan: r.selectedPlanCents / 100,
    amount: r.amountCents / 100, paid: r.paidCents == null ? '未填写' : r.paidCents / 100,
    remaining: r.remainingCents == null ? '未填写' : r.remainingCents / 100,
    selectedPaid: r.selectedPaidCents == null ? '待核对' : r.selectedPaidCents / 100,
    selectedUnpaid: r.selectedUnpaidCents == null ? '待核对' : r.selectedUnpaidCents / 100,
    paymentBasis: (r.selectedPlans || r.plans).map(p => `${p.month || '时间待定'}：${p.paymentBasis || '待核对'}${p.paymentEvidence?.length ? '\n' + p.paymentEvidence.map(e => `${e.sourceSheet || r.sourceSheet}!${e.sourceCell || `第${e.sourceRow}行`}（${e.amountCents == null ? '金额待核对' : e.amountCents / 100 + '元'}）：${e.comment || e.status || ''}`).join('\n') : ''}`).join('\n'),
    paymentDates: (r.selectedPlans || r.plans).filter(p => p.paymentDates?.length).map(p => `${p.month || '时间待定'}：${p.paymentDates.join('、')}`).join('\n'),
    progressVersion: [...new Set((r.selectedPlans || r.plans).map(p => p.paymentProgressVersion).filter(Boolean).map(v => `${v.filename}（${v.id}）`))].join('\n'),
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
    { name: '金额空值口径', value: '金额为空或公式没有已保存计算结果时按0计入；不重新计算公式。' },
    { name: '缺失已付记录数', value: uploaded.has('schedule') ? String(data.summary.missingPaidCount) : '未上传' },
    { name: '缺失剩余记录数', value: uploaded.has('schedule') ? String(data.summary.missingRemainingCount) : '未上传' },
    { name: '父子汇总', value: '谈判付款仅含谈判表-谈判付款；正常付款包含另两类付款及三类预估。预估合计是正常付款的子项，总合计只累加六个原始分类一次，父级和子级不可再次累加。' },
    { name: '月内已付与未付', value: '谈判付款工作表的两类付款按金额格批注判定：明确的“付款时间（付款节奏跟进）：日期”或“付款时间：日期”直接代表已付，也保留日期及已付/已支付标记的写法；付款日期优先取明确付款时间，申请日期不代表已付。正常付款工作表及三类预估关联当前付款节奏的付款进度整理，只有明确匹配已付款才计已付。未匹配、空状态、未付款、重新申请或匹配冲突均计未付并说明原因；不再按归档状态判断。谈判批注的部分付款或矛盾金额显示待核对。' },
    { name: '月份与期间合计', value: '月份沿用月支付列或应付时间，批注付款日期不迁移计划月份，未写年份不推测。月度表及期间合计不含时间待定，时间待定另表展示且不重复列期间合计；月份筛选仅影响月度表。金额以元导出，网页同时显示万元近似值。' },
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
