import ExcelJS from 'exceljs';
import { makeSheet } from './exports.js';
const amount = value => value === null || value === undefined ? '待核对' : value / 100;
export async function paymentAnalysisExport(data) {
  const book = new ExcelJS.Workbook(); book.creator = '资金台账';
  makeSheet(book, '资金付款台账', [
    ['付款日期', 'paymentDate'], ['供应商', 'supplier', 36], ['付款主体', 'payer'], ['OA流程编号', 'flowCode', 32], ['摘要', 'summary', 45],
    ['本次付款金额（元）', 'amount', 24], ['付款依据', 'basis', 30], ['依据说明', 'annotation', 36], ['来源文件', 'filename', 48],
    ['版本', 'versionId', 40], ['工作表', 'sourceSheet'], ['原始行', 'sourceRow'], ['金额格', 'sourceCell'],
    ['付款批注', 'comment', 60], ['备注及谈判明细', 'notes', 60], ['OA签字原文', 'signature', 70],
    ['币种', 'currency'], ['原币金额', 'original', 22], ['判断汇率', 'exchangeRate'], ['OA人民币金额（勿重复求和）', 'oaAmount', 30],
    ['OA来源文件', 'oaFilename', 48], ['OA版本', 'oaVersionId', 40], ['OA来源位置', 'oaSourcesText', 45],
  ], data.records.map(r => ({ ...r, amount: amount(r.amountCents), original: amount(r.originalAmountCents), oaAmount: amount(r.oaAmountCents),
    oaSourcesText: (r.oaSources || []).map(s => `${s.sourceSheet}!第${s.sourceRow}行`).join('、') })));
  makeSheet(book, '年度月度对比', [['月份', 'month'], [`${data.year}已付（元）`, 'current', 24], [`${data.year - 1}同期已付（元）`, 'previous', 24]],
    data.monthly.map(r => ({ month: r.month, current: r.currentCents === null ? '未到统计期间' : amount(r.currentCents), previous: r.previousCents === null ? '暂无同期数据或未到期间' : amount(r.previousCents) })));
  makeSheet(book, '供应商汇总', [['供应商', 'supplier', 36], ['已付金额（元）', 'amount', 24], ['付款笔数', 'count']], data.suppliers.map(r => ({ ...r, amount: amount(r.amountCents) })));
  makeSheet(book, '待核对', [['供应商', 'supplier', 36], ['OA流程编号', 'flowCode', 32], ['需要核对', 'message', 70], ['来源文件', 'filename', 48], ['工作表', 'sourceSheet'], ['原始行', 'sourceRow'], ['金额格', 'sourceCell'], ['批注', 'comment', 60]], data.issues);
  makeSheet(book, '统计说明', [['项目', 'name', 30], ['说明', 'value', 100]], [
    { name: '当前年统计截至', value: data.currentEnd }, { name: '上年同期截至', value: data.priorEnd },
    { name: '统计口径', value: '实际付款日期归月；OA按流程编号去重，取最晚出纳执行日期；谈判表两类优先按明确已付分期批注计款，不叠加整笔OA。未匹配OA的明确分期仍计入并标明来源。' },
    { name: '筛选范围', value: JSON.stringify(data.filters) },
    { name: '台账范围合计（元）', value: amount(data.detailTotalCents) },
    { name: '数据范围', value: '仅按当前上传数据统计，历史数据是否完整取决于上传文件。日期或金额无法确定的款项列为核对，不按0替代。台账遵循下钻范围，对比和供应商汇总遵循页面年份及全局筛选。' },
    ...Object.entries(data.versions).map(([name, version]) => ({ name: name === 'oa' ? 'OA版本' : '付款节奏版本', value: version ? `${version.filename} / ${version.id}` : '尚未上传' })),
  ]);
  return book.xlsx.writeBuffer();
}
export async function oaFlowsExport(data) {
  const book = new ExcelJS.Workbook();
  makeSheet(book, '对公付款OA流程', [['流程编号', 'flowCode', 32], ['供应商', 'supplier', 36], ['付款主体', 'payer'], ['人民币金额（元）', 'amount', 24],
    ['OA执行状态', 'paymentLabel'], ['最晚出纳执行日期', 'paymentDate', 24], ['币种', 'currency'], ['原币金额', 'original'], ['判断汇率', 'exchangeRate'],
    ['摘要', 'summary', 50], ['签字原文', 'signature', 70], ['来源位置', 'sourcesText', 50], ['来源文件', 'filename', 45], ['版本', 'versionId', 40]],
  data.records.map(r => ({ ...r, amount: amount(r.amountCents), original: amount(r.originalAmountCents),
    paymentLabel: ({ paid: '出纳已执行', unpaid: '无出纳执行记录', review: '待核对' })[r.paymentState], sourcesText: r.sources.map(s => `${s.sourceSheet}!第${s.sourceRow}行`).join('、') })));
  return book.xlsx.writeBuffer();
}
