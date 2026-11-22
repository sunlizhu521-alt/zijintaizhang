import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { parseWorkbook, inspectWorkbook } from '../server/parser.js';
import { cashierDates } from '../server/oa-parser.js';
import { buildPaymentAnalysis, oaFlowList, analysisFilters } from '../server/payment-analysis.js';
import { paymentAnalysisExport } from '../server/payment-analysis-export.js';
import { appFixture, syntheticSchedule } from './helpers.js';
const now = new Date('2026-11-22T04:00:00Z');
const empty = () => ({ records: [], issues: [], version: null });
const signature = date => `[出纳执行]\n同意\n任意姓名 ${date} 11:30:00\n[结束]\n管理员 2026-12-31 12:00:00`;
const oaRow = (key, date, amountCents = 10000, supplier = '供应商甲') => ({ key, flowKey: key, flowCode: key, supplier, payer: '主体甲', amountCents, originalAmountCents: amountCents, currency: '人民币', sourceSheet: 'OA', sourceRow: 2, signature: date ? signature(date) : '', paymentDate: date, sources: [{ sourceSheet: 'OA', sourceRow: 2 }], executionDates: date ? [date] : [] });
const note = date => `付款时间（付款节奏跟进）：${date}`;
const negotiation = (key, flowCode, category = 'negotiated') => ({ key, flowCode, supplier: '供应商甲', payer: '主体甲', category, sourceSheet: '谈判付款', sourceRow: 2,
  plans: [{ month: '2026-12', amountCents: 1000000, sourceCell: 'AK2', sourceComment: '' }],
  applicationInstallments: [{ month: '2026-12', amountCents: 300000, sourceCell: 'Z2', comment: note('2026年11月19日') }] });
async function source(rows, headerName = '签字意见') {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('OA');
  sheet.addRow(['流程编号', '收款单位', '业务所属公司', '付款金额', '币种', headerName, '判断金额', '原币金额', '判断汇率', '请求标题']);
  rows.forEach(row => sheet.addRow(row));
  return Buffer.from(await book.xlsx.writeBuffer());
}
const sourceRow = (key = 'MDST-DGFK20261101001', date = '2026-11-19', amount = 100) => [key, '供应商甲', '主体甲', amount, '人民币', date ? signature(date) : '', null, amount, 1, '付款摘要'];

test('出纳执行只读取对应节点日期、忽略姓名、去重并取最晚有效日期', () => {
  assert.deepEqual(cashierDates(`${signature('2026-11-19')}\n[出纳执行]\n其他人 2026-11-21 09:00:00\n[出纳执行]\n姚某 2026-11-21 10:00:00`), ['2026-11-19', '2026-11-21']);
  assert.deepEqual(cashierDates('[出纳执行]\n张三 2026-02-30\n[审批]李四 2026-11-20'), []);
  assert.deepEqual(cashierDates('[出纳执行]\n张三 2024年2月29日'), ['2024-02-29']);
});
test('OA重复发票行只统计一次，保留来源行；外币用判断金额；空值和零不同', async () => {
  const rows = [sourceRow(), sourceRow(), ['FX1', '外币供应商', '主体甲', 13785, '美元', signature('2026-11-19'), 92865.41, 13785, 6.7367], sourceRow('ZERO', null, 0), sourceRow('EMPTY', null, null)];
  const buffer = await source(rows, '签字');
  assert.equal((await inspectWorkbook(buffer, 'corporate_oa')).sheets[0].eligible, true);
  const parsed = await parseWorkbook(buffer, { slotId: 'corporate_oa' });
  assert.equal(parsed.records.length, 4);
  assert.equal(parsed.records[0].sources.length, 2);
  assert.equal(parsed.records[1].amountCents, 9286541);
  assert.equal(parsed.records[2].amountCents, 0);
  assert.equal(parsed.records[3].amountCents, null);
  assert.equal(parsed.issues.length, 1);
  assert.equal(buildPaymentAnalysis(parsed, empty(), { paymentCategory: 'all', year: '2026' }, now).summary.currentCents, 9296541);
});
test('OA缺表头、坏金额拒绝；同号冲突保留待核对并排除统计', async () => {
  await assert.rejects(parseWorkbook(await source([sourceRow('x', null, '非金额')]), { slotId: 'corporate_oa' }), /金额格式/);
  await assert.rejects(parseWorkbook(await source([sourceRow()]), { slotId: 'corporate_oa', selectedSheets: [] }), /全部/);
  await assert.rejects(parseWorkbook(await syntheticSchedule(), { slotId: 'corporate_oa' }), /必需表头/);
  const parsed = await parseWorkbook(await source([sourceRow(), sourceRow(undefined, '2026-11-19', 200)]), { slotId: 'corporate_oa' });
  assert.equal(parsed.records[0].conflict, true);
  assert.equal(buildPaymentAnalysis(parsed, empty(), { paymentCategory: 'all', year: '2026' }, now).records.length, 0);
  assert.equal(oaFlowList(parsed, { paymentState: 'review' }).records.length, 1);
});
test('两类谈判表按已付分期实际日期优先，无OA或OA未执行仍计入，不叠加OA总金额', () => {
  const oa = { records: [oaRow('A', '2026-11-20', 1000000), oaRow('B', null, 1000000)] };
  const schedule = { records: [negotiation('one', ' a '), negotiation('two', 'B', 'negotiated_normal'), negotiation('three', 'MISSING')] };
  const result = buildPaymentAnalysis(oa, schedule, { year: '2026' }, now);
  assert.equal(result.summary.currentCents, 900000);
  assert.equal(result.records.length, 3);
  assert.ok(result.records.every(r => r.paymentDate === '2026-11-19'));
  assert.equal(result.records.find(r => r.flowCode === 'MISSING').annotation, '未匹配 OA');
  assert.equal(result.records.find(r => r.flowCode === 'B').annotation, 'OA 无出纳执行记录');
});
test('分期与月汇总不双计，金额不同只统计分期并提示；申请日期不是付款日期', () => {
  const r = negotiation('one', 'A'); r.plans[0].sourceComment = note('2026年11月19日');
  const result = buildPaymentAnalysis(empty(), { records: [r] }, { year: '2026' }, now);
  assert.equal(result.summary.currentCents, 300000);
  assert.match(result.issues[0].message, /仅统计明确/);
  r.applicationInstallments[0].comment = '申请日期（付款节奏跟进）：2026年11月19日'; r.plans[0].sourceComment = '';
  assert.equal(buildPaymentAnalysis(empty(), { records: [r] }, { year: '2026' }, now).records.length, 0);
});
test('月格独有证据可计入；缺年份、多日期、部分付款、未来日期保留核对而不猜测', () => {
  const r = negotiation('one', 'A'); r.applicationInstallments = []; r.plans[0].sourceComment = note('2026年11月19日');
  assert.equal(buildPaymentAnalysis(empty(), { records: [r] }, { year: '2026' }, now).summary.currentCents, 1000000);
  for (const comment of [note('11月19日'), `${note('2026年11月19日')}\n${note('2026年11月20日')}`, '部分支付，金额待确认', note('2026年12月1日')]) {
    r.plans[0].sourceComment = comment;
    const d = buildPaymentAnalysis(empty(), { records: [r] }, { year: '2026' }, now);
    assert.equal(d.records.length, 0, comment); assert.ok(d.issues.length, comment);
  }
});
test('年度同比使用相同截止日期；当前未来月份留空；过滤、月度下钻和供应商排序一致', () => {
  const oa = { records: [oaRow('1', '2026-11-20', 500), oaRow('2', '2025-11-22', 100), oaRow('3', '2025-11-23', 9000), oaRow('4', '2026-11-20', 200, '供应商乙')] };
  const result = buildPaymentAnalysis(oa, empty(), { paymentCategory: 'all', year: '2026' }, now);
  assert.equal(result.summary.currentCents, 700); assert.equal(result.summary.previousCents, 100);
  assert.equal(result.summary.changePercent, 600); assert.equal(result.monthly[11].currentCents, null);
  assert.equal(result.top10[0].supplier, '供应商甲');
  const drill = buildPaymentAnalysis(oa, empty(), { paymentCategory: 'all', year: '2026', detailMonth: '2025-11', supplierSearch: '甲' }, now);
  assert.equal(drill.records.length, 1); assert.equal(drill.detailTotalCents, 100);
  const filtered = buildPaymentAnalysis(oa, empty(), { paymentCategory: 'all', year: '2026', supplier: '乙' }, now);
  assert.equal(filtered.summary.previousCents, 0); assert.equal(filtered.summary.changePercent, null);
  assert.equal(buildPaymentAnalysis(oa, empty(), { paymentCategory: 'all', year: '2025' }, now).summary.currentCents, 9100);
});
test('闰年同期截止、无上年数据、零付款、负金额、筛选校验', () => {
  const leap = buildPaymentAnalysis({ records: [oaRow('1', '2024-02-29', 0), oaRow('2', '2023-02-28', 0), oaRow('3', '2023-03-01', 200)] }, empty(), { paymentCategory: 'all', year: '2024' }, new Date('2024-02-29T04:00:00Z'));
  assert.equal(leap.priorEnd, '2023-02-28'); assert.equal(leap.summary.previousCents, 0); assert.equal(leap.records.length, 1);
  const d = buildPaymentAnalysis({ records: [oaRow('1', '2026-11-20', -100)] }, empty(), { paymentCategory: 'all', year: '2026' }, now);
  assert.equal(d.summary.currentCents, -100); assert.equal(d.summary.previousCents, null); assert.equal(d.issues.length, 1);
  for (const query of [{ year: 'abc' }, { year: ['2026'] }, { detailMonth: '2026-13' }, { supplier: {} }, { paymentState: 'other' }]) assert.throws(() => analysisFilters(query, '2026-11-22'));
});
test('下载完整筛选付款，不局限20笔，保留精确元值及原文', async () => {
  const oa = { records: Array.from({ length: 25 }, (_, i) => oaRow(String(i), '2026-11-20', 101 + i)), version: { id: 'original', filename: '合成源表.xlsx' } };
  const data = buildPaymentAnalysis(oa, empty(), { paymentCategory: 'all', year: '2026', supplier: '甲' }, now);
  const book = new ExcelJS.Workbook(); await book.xlsx.load(await paymentAnalysisExport(data));
  const sheet = book.getWorksheet('资金付款台账');
  assert.equal(sheet.rowCount, 26);
  const total = sheet.getColumn(6).values.slice(2).reduce((sum, value) => sum + Math.round(value * 100), 0);
  assert.equal(total, data.detailTotalCents); assert.equal(sheet.getCell('A2').value, '2026-11-20');
  assert.equal(sheet.getCell('E2').value, null);
});

test('OA上传、失败保留、恢复、重启以及资金付款台账隔离；解析结果实时联动', async t => {
  const f = await appFixture(t), admin = await f.login();
  const initial = await f.upload('corporate_oa', await source([sourceRow()]), admin);
  let result = await f.request('/payment-analysis?paymentCategory=all&year=2026', { session: admin });
  assert.equal(result.data.summary.currentCents, 10000);
  assert.equal((await f.request('/dashboard?from=2026-11&to=2026-12', { session: admin })).data.records.length, 0);
  assert.equal((await f.request('/files', { session: admin })).data.slots.length, 4);
  const badDraft = await f.preview('corporate_oa', await source([sourceRow('x', null, '错误')]), admin);
  assert.equal((await f.activate('corporate_oa', badDraft, admin)).status, 422);
  assert.equal((await f.request('/oa-flows', { session: admin })).data.version.id, initial.versionId);
  const second = await f.upload('corporate_oa', await source([sourceRow(undefined, '2026-11-20', 200)]), admin);
  const restored = await f.request('/files/corporate_oa/restore', { method: 'POST', session: admin, body: { versionId: initial.versionId, baseRevision: second.activated.data.slot.revision } });
  assert.equal(restored.status, 200);
  await f.restart();
  assert.equal((await f.request('/payment-analysis?paymentCategory=all&year=2026', { session: admin })).data.summary.currentCents, 10000);
  const scheduleBook = new ExcelJS.Workbook(); await scheduleBook.xlsx.load(await syntheticSchedule());
  scheduleBook.getWorksheet('谈判付款').getCell('L2').note = note('2026年11月19日');
  const scheduleFirst = await f.upload('schedule', Buffer.from(await scheduleBook.xlsx.writeBuffer()), admin);
  result = await f.request('/payment-analysis?paymentCategory=all&year=2026', { session: admin });
  assert.equal(result.data.summary.currentCents, 60000, '匹配谈判表后用分期，替代OA整笔');
  scheduleBook.getWorksheet('谈判付款').getCell('L2').note = '';
  const scheduleSecond = await f.upload('schedule', Buffer.from(await scheduleBook.xlsx.writeBuffer()), admin);
  assert.equal((await f.request('/payment-analysis?paymentCategory=all&year=2026', { session: admin })).data.summary.currentCents, 0);
  await f.request('/files/schedule/restore', { method: 'POST', session: admin, body: { versionId: scheduleFirst.versionId, baseRevision: scheduleSecond.activated.data.slot.revision } });
  assert.equal((await f.request('/payment-analysis?paymentCategory=all&year=2026', { session: admin })).data.summary.currentCents, 60000);
  const detail = await f.request(`/files/corporate_oa/versions/${initial.versionId}`, { session: admin });
  assert.equal(detail.data.kind, 'corporate_oa'); assert.equal(detail.data.records[0].paymentDate, '2026-11-19');
});
test('分析、OA及导出均服务器鉴权，导出包含对应筛选并记录操作', async t => {
  const f = await appFixture(t), admin = await f.login();
  for (const path of ['/payment-analysis', '/payment-analysis/export', '/oa-flows', '/oa-flows/export']) assert.equal((await f.request(path)).status, 401);
  const viewer = (await f.newUser(admin, 'analysisviewer', ['dashboard'])).session;
  const files = (await f.newUser(admin, 'oaviewer', ['files'])).session;
  assert.equal((await f.request('/payment-analysis', { session: viewer })).status, 200);
  assert.equal((await f.request('/payment-analysis/export', { session: viewer })).status, 403);
  assert.equal((await f.request('/oa-flows', { session: viewer })).status, 403);
  assert.equal((await f.request('/payment-analysis', { session: files })).status, 403);
  assert.equal((await f.request('/oa-flows/export', { session: files })).status, 403);
  await f.upload('corporate_oa', await source([sourceRow()]), admin);
  const exported = await f.request('/payment-analysis/export?year=2026&supplier=不存在', { session: admin });
  assert.equal(exported.status, 200); const book = new ExcelJS.Workbook(); await book.xlsx.load(exported.bytes);
  assert.equal(book.getWorksheet('资金付款台账').rowCount, 1);
  assert.equal((await f.request('/oa-flows/export', { session: admin })).status, 200);
  const logs = (await f.request('/logs?kind=operation', { session: admin })).data.items;
  assert.ok(logs.some(r => r.action === '导出资金付款分析' && r.details.supplier === '不存在'));
});

test('默认采购付款按两张表的完整供应商名单分类，历史、零值、核对和下钻一致', async () => {
  const schedule = { records: [
    { category: 'normal', supplier: '供应商甲' }, { category: 'normal_unreconciled', supplier: '供应商乙' },
    { category: 'negotiated', supplier: '供应商丙' }, { category: 'negotiated_normal', supplier: '供应商丁' },
    { category: 'normal', supplier: '' }, { category: 'shipment', supplier: '预估供应商' },
  ] };
  const oa = { records: [
    { ...oaRow('A', '2026-11-19', 100, '供应商甲'), payer: '不同主体' }, oaRow('B', '2026-11-19', 0, ' 供应商乙 '),
    oaRow('C', '2026-11-19', 300, '供应商丙'), oaRow('D', '2026-11-19', 400, '供应商丁'),
    oaRow('E', '2026-11-19', 500, '其他供应商'), oaRow('F', '2026-11-19', 600, ''),
    oaRow('G', '2026-11-19', 700, '供应商甲分公司'), oaRow('H', '2026-11-19', 800, '预估供应商'),
    oaRow('OLD-A', '2025-11-19', 50, '供应商甲'), oaRow('OLD-E', '2025-11-19', 90, '其他供应商'),
    oaRow('UNKNOWN-A', '2026-11-19', null, '供应商甲'), oaRow('UNKNOWN-E', '2026-11-19', null, '其他供应商'),
  ] };
  const purchase = buildPaymentAnalysis(oa, schedule, { year: '2026' }, now);
  const other = buildPaymentAnalysis(oa, schedule, { year: '2026', paymentCategory: 'other' }, now);
  const all = buildPaymentAnalysis(oa, schedule, { year: '2026', paymentCategory: 'all' }, now);
  assert.equal(purchase.filters.paymentCategory, 'procurement');
  assert.equal(purchase.summary.currentCents, 800); assert.equal(purchase.summary.previousCents, 50);
  assert.equal(purchase.records.length, 4); assert.ok(purchase.records.some(r => r.amountCents === 0));
  assert.equal(other.summary.currentCents, 2600); assert.equal(other.summary.previousCents, 90);
  assert.equal(all.summary.currentCents, purchase.summary.currentCents + other.summary.currentCents);
  assert.equal(all.monthly[10].currentCents, purchase.monthly[10].currentCents + other.monthly[10].currentCents);
  assert.deepEqual(purchase.top10.map(r => r.supplier), ['供应商丁', '供应商丙', '供应商甲', ' 供应商乙 ']);
  assert.deepEqual(purchase.issues.map(r => r.supplier), ['供应商甲']);
  assert.deepEqual(other.issues.map(r => r.supplier), ['其他供应商']);
  const prior = buildPaymentAnalysis(oa, schedule, { year: '2026', detailMonth: '2025-11', supplierSearch: '甲' }, now);
  assert.equal(prior.records.length, 1); assert.equal(prior.detailTotalCents, 50);
  const filtered = buildPaymentAnalysis(oa, schedule, { year: '2026', supplier: '甲', payer: '不同主体' }, now);
  assert.equal(filtered.detailTotalCents, 100);
  assert.equal(buildPaymentAnalysis(oa, empty(), { year: '2026' }, now).records.length, 0);
  assert.equal(buildPaymentAnalysis(oa, empty(), { year: '2026', paymentCategory: 'other' }, now).summary.currentCents, all.summary.currentCents);
  const onlyOtherPrior = { records: oa.records.filter(r => r.flowCode !== 'OLD-A') };
  assert.equal(buildPaymentAnalysis(onlyOtherPrior, schedule, { year: '2026' }, now).summary.previousCents, null);
  const book = new ExcelJS.Workbook(); await book.xlsx.load(await paymentAnalysisExport(purchase));
  assert.equal(book.getWorksheet('资金付款台账').rowCount, 5);
  assert.equal(book.getWorksheet('年度月度对比').getCell('B12').value, 8);
  assert.ok(book.getWorksheet('统计说明').getColumn(2).values.includes('采购付款'));
  for (const paymentCategory of ['unknown', ['procurement'], {}]) assert.throws(() => analysisFilters({ paymentCategory }, '2026-11-22'));
});

test('分类接口默认采购；替换及恢复付款节奏实时改变名单，导出与OA全部列表保持正确范围', async t => {
  const f = await appFixture(t), admin = await f.login();
  const otherRow = sourceRow('OTHER', '2026-11-19', 300); otherRow[1] = '其他供应商';
  await f.upload('corporate_oa', await source([sourceRow('DIFFERENT-OA'), otherRow]), admin);
  const query = '/payment-analysis?year=2026';
  assert.equal((await f.request(query, { session: admin })).data.summary.currentCents, 0);
  assert.equal((await f.request(`${query}&paymentCategory=all`, { session: admin })).data.summary.currentCents, 40000);
  const schedule = new ExcelJS.Workbook(); await schedule.xlsx.load(await syntheticSchedule());
  schedule.getWorksheet('正常付款').getCell('B2').value = '供应商甲';
  const first = await f.upload('schedule', Buffer.from(await schedule.xlsx.writeBuffer()), admin);
  const purchase = await f.request(query, { session: admin });
  assert.equal(purchase.data.filters.paymentCategory, 'procurement');
  assert.equal(purchase.data.summary.currentCents, 10000);
  assert.equal((await f.request(`${query}&paymentCategory=other`, { session: admin })).data.summary.currentCents, 30000);
  assert.equal((await f.request('/oa-flows', { session: admin })).data.records.length, 2);
  const output = await f.request('/payment-analysis/export?year=2026&paymentCategory=other&detailMonth=2026-11', { session: admin });
  assert.equal(output.status, 200);
  const book = new ExcelJS.Workbook(); await book.xlsx.load(output.bytes);
  assert.equal(book.getWorksheet('资金付款台账').rowCount, 2);
  assert.equal(book.getWorksheet('资金付款台账').getCell('B2').value, '其他供应商');
  assert.equal(book.getWorksheet('资金付款台账').getCell('F2').value, 300);
  assert.ok(book.getWorksheet('统计说明').getColumn(2).values.includes('其他付款'));
  assert.equal((await f.request(`${query}&paymentCategory=bad`, { session: admin })).status, 400);
  schedule.getWorksheet('正常付款').getCell('B2').value = '更名供应商';
  const second = await f.upload('schedule', Buffer.from(await schedule.xlsx.writeBuffer()), admin);
  assert.equal((await f.request(query, { session: admin })).data.summary.currentCents, 0);
  await f.request('/files/schedule/restore', { method: 'POST', session: admin, body: { versionId: first.versionId, baseRevision: second.activated.data.slot.revision } });
  assert.equal((await f.request(query, { session: admin })).data.summary.currentCents, 10000);
  const logs = (await f.request('/logs?kind=operation', { session: admin })).data.items;
  assert.ok(logs.some(r => r.action === '导出资金付款分析' && r.details.paymentCategory === 'other'));
});
