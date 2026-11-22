import ExcelJS from 'exceljs';
import { CATEGORIES } from '../shared/constants.js';
import { isInformationIssue } from '../shared/issue-level.js';

export function makeSheet(book, name, columns, rows) {
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
  const amount = cents => cents == null ? '待核对' : cents / 100;
  const metrics = [['totalCents', '合计'], ['paidCents', '已付'], ['unpaidCents', '未付'], ['unappliedUnpaidCents', '未提交申请单金额']];
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
      if (!item.parentId) row.eachCell(cell => {
        cell.font = { ...cell.font, bold: true };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: item.id === 'total' ? 'FFFBEADF' : 'FFF3F5F7' } };
      });
    });
  }
  const detailColumns = [
    ['类别', 'category'], ['供应商', 'supplier', 34], ['付款主体', 'payer', 24], ['跟单员', 'owner'],
    ['选定期间计划金额', 'plan', 24], ['原台账申请金额', 'amount', 24], ['原台账累计已付', 'paid', 24], ['原台账剩余金额', 'remaining', 24],
    ['计划月份', 'months', 28], ['流程号', 'flowCode', 30], ['流程状态', 'status'], ['申请状态', 'applicationStatus'],
    ['摘要', 'summary', 40], ['备注', 'notes', 60], ['来源文件', 'filename', 45], ['工作表', 'sourceSheet'], ['原始行', 'sourceRow'],
    ['选定范围已付（新规则）', 'selectedPaid', 26], ['选定范围未付（新规则）', 'selectedUnpaid', 26], ['付款判定依据', 'paymentBasis', 70],
    ['批注付款日期', 'paymentDates', 32], ['付款依据版本', 'progressVersion', 60],
    ['申请判定依据', 'applicationBasis', 55], ['批注申请日期', 'applicationDates', 32], ['申请依据位置及原文', 'applicationEvidence', 70], ['当前节点', 'currentNode', 24],
  ];
  const detailRows = records => records.map(r => ({ ...r, category: CATEGORIES[r.category], plan: r.selectedPlanCents / 100,
    amount: r.amountCents / 100, paid: r.paidCents == null ? '未填写' : r.paidCents / 100,
    remaining: r.remainingCents == null ? '未填写' : r.remainingCents / 100,
    selectedPaid: r.selectedPaidCents == null ? '待核对' : r.selectedPaidCents / 100,
    selectedUnpaid: r.selectedUnpaidCents == null ? '待核对' : r.selectedUnpaidCents / 100,
    paymentBasis: (r.selectedPlans || r.plans).map(p => `${p.month || '时间待定'}：${p.paymentBasis || '待核对'}${p.paymentEvidence?.length ? '\n' + p.paymentEvidence.map(e => `${e.sourceSheet || r.sourceSheet}!${e.sourceCell || `第${e.sourceRow}行`}（${e.amountCents == null ? '金额待核对' : e.amountCents / 100 + '元'}）：${e.comment || e.status || ''}`).join('\n') : ''}`).join('\n'),
    paymentDates: (r.selectedPlans || r.plans).filter(p => p.paymentDates?.length).map(p => `${p.month || '时间待定'}：${p.paymentDates.join('、')}`).join('\n'),
    applicationDates: (r.selectedPlans || r.plans).filter(p => p.applicationDates?.length).map(p => `${p.month || '时间待定'}：${p.applicationDates.join('、')}`).join('\n'),
    applicationEvidence: (r.selectedPlans || r.plans).map(p => `${p.month || '时间待定'}：${p.applicationBasis || ''}${p.applicationEvidence?.length ? '\n' + p.applicationEvidence.map(e => `${r.sourceSheet}!${e.sourceCell || `第${r.sourceRow}行`}（${amount(e.amountCents)}元）：${e.comment || '无申请批注'}`).join('\n') : ''}`).join('\n'),
    progressVersion: [...new Set((r.selectedPlans || r.plans).map(p => p.paymentProgressVersion).filter(Boolean).map(v => `${v.filename}（${v.id}）`))].join('\n'),
    months: [...new Set((r.selectedPlans || r.plans).map(p => p.month || '时间待定'))].join('、') }));
  makeSheet(book, '筛选明细', detailColumns, detailRows(data.records));
  makeSheet(book, '时间待定明细', detailColumns, detailRows(data.pendingRecords));
  makeSheet(book, '付款明细', [
    ['供应商', 'supplier', 34], ['分类', 'category', 28], ['总金额（元）', 'total', 26],
    ['已申请未付金额（元）', 'appliedUnpaid', 26], ['未申请金额（元）', 'unappliedUnpaid', 26],
    ['是否提交申请单', 'applicationStatus', 24], ['申请单判定', 'applicationLabel', 20], ['付款OA号', 'flowCode', 30], ['节点', 'currentNode', 24],
    ['申请判定依据', 'applicationBasis', 55], ['来源工作表', 'sourceSheet', 24], ['原始行', 'sourceRow'],
  ], data.records.map(record => ({ ...record, category: CATEGORIES[record.category], total: amount(record.selectedPlanCents),
    applicationLabel: ({ applied: '已提交', unapplied: '未提交', partial: '部分已提交', review: '待核对' })[record.applicationState] || '—',
    appliedUnpaid: amount(record.selectedAppliedUnpaidCents), unappliedUnpaid: amount(record.selectedUnappliedUnpaidCents) })));
  makeSheet(book, '统计口径', [['项目', 'name', 26], ['金额或说明', 'value', 90]], [
    { name: '期间计划（含预估）', value: amount(data.summary.planCents) },
    { name: '期间已付', value: amount(data.summary.paidCents) },
    { name: '期间未付', value: amount(data.summary.remainingCents) },
    { name: '已申请未付', value: amount(data.summary.appliedUnpaidCents) },
    { name: '未申请未付', value: amount(data.summary.unappliedUnpaidCents) },
    { name: '申请金额待核对记录数', value: data.summary.applicationReviewCount },
    { name: '申请金额待核对涉及未付', value: amount(data.summary.applicationReviewCents) },
    { name: '付款拆分待核对计划数', value: data.summary.uncertainCount },
    { name: '统计范围', value: data.summary.scopeLabel },
    { name: '金额空值口径', value: '金额为空或公式没有已保存计算结果时按0计入；不重新计算公式。' },
    { name: '付款拆分未知口径', value: '无法按付款依据拆分已付与未付时保留待核对，不按0计入；原台账金额只在明细中保留，不替代期间统计。' },
    { name: '父子汇总', value: '谈判付款仅含谈判付款-谈判付款表；正常付款包含其余六类（正常付款-谈判付款表、正常付款-正常对账表、正常付款-未完成对账及三类预估）。总合计只累加七个原始分类一次，父级和子级不可再次累加。' },
    { name: '已申请未付口径', value: '谈判付款工作表两类付款逐金额格读取申请批注：有效“申请日期（付款节奏跟进）”或明确申请单已提交表示该批已提交；有效申请日期后附“（批次归属待核对）”仍计该金额格已提交，保留批注原文，不覆盖其他批次。正常付款和三类预估读取原表申请单状态；OA号、节点、OA已备注不作为提交依据。无申请依据、空白或待核对状态计未提交；明确部分提交金额不明、申请依据矛盾或无法定位同批已付金额时列待核对。已申请未付与未提交申请单金额之和等于范围内未付，已付款不重复计入。' },
    { name: '付款明细口径', value: '展示当前筛选范围全部记录，含已付及有效零金额。总金额为所选范围计划金额，包含已付；未申请金额仅为尚未申请且未支付的金额，不包含已付。申请或付款拆分无法确定时保留待核对，不补零。' },
    { name: '正常付款分类与月份', value: '正常付款工作表中预估时间有内容的归为正常付款-未完成对账，按预估时间归月；其余归为正常付款-正常对账表，按应付时间归月。预估时间无有效年份或日期时单列时间待定，不退回应付时间；是否对账原字段保留供核对，不用于本分类。' },
    { name: '月内已付与未付', value: '谈判付款工作表的两类付款按金额格批注判定：明确的“付款时间（付款节奏跟进）：日期”或“付款时间：日期”直接代表已付，也保留日期及已付/已支付标记的写法；付款日期优先取明确付款时间，申请日期不代表已付。正常付款工作表及三类预估关联当前付款节奏的付款进度整理，只有明确匹配已付款才计已付。未匹配、空状态、未付款、重新申请或匹配冲突均计未付并说明原因；不再按归档状态判断。谈判批注的部分付款或矛盾金额显示待核对。' },
    { name: '月份与期间合计', value: '月份按来源读取月支付列、应付时间或预估时间，批注付款日期不迁移计划月份，未写年份不推测。普通期间统计不含时间待定；筛选时间待定时统计仅含待定记录。待定汇总和明细另表保留，不重复计入月度表。金额以元精确导出，网页仅显示万元近似值。' },
  ]);
  for (const [name, informational] of [['待核对', false], ['普通提示', true]]) makeSheet(book, name, [['问题', 'message', 70], ['来源工作表', 'sourceSheet', 24], ['原始行', 'sourceRow'], ['类型', 'code', 28],
    ['核对事项', 'title', 32], ['需要核对', 'action', 65], ['来源文件', 'filename', 45], ['关联位置', 'relatedLocationsText', 70]],
  data.issues.filter(issue => isInformationIssue(issue) === informational).map(issue => ({ ...issue, relatedLocationsText: (issue.relatedLocations ?? []).map(location =>
    [location.filename, `${location.sourceSheet || ''}${location.sourceRow == null ? '' : ` 第${location.sourceRow}行`}`, location.supplier]
      .filter(Boolean).join(' · ')).join('\n') })));
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
