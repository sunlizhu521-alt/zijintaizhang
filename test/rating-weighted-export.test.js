import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { QCDS_RULE as TEN_POINT_RULE, RATING_ITEMS, calculateRating, roundScore, ratingGrade } from '../shared/rating.js';
const QCDS_RULE = { ...TEN_POINT_RULE, items: TEN_POINT_RULE.items.map(item => ({ ...item, max: 100 })) };
import { exportRating, exportRatingPeriod } from '../server/rating-excel.js';

const headers = worksheet => worksheet.getRow(1).values.slice(1);
const valueAt = (worksheet, header, row = 2) => {
  const column = worksheet.getRow(1).values.indexOf(header);
  assert.ok(column > 0, `缺少列：${header}`);
  return worksheet.getCell(row, column).value;
};
const readBook = async buffer => {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer);
  return book;
};
function bundle(rule, month, inputs) {
  const scores = inputs.map((input, n) => ({ month, supplier_id: 'supplier-1', user_id: `rater-${n}`, raterName: `合成评价人${n}`, status: 'submitted', notes: {}, scores: input }));
  const results = scores.map(score => calculateRating(rule, score.scores));
  const avg = values => values.reduce((sum, n) => sum + n, 0) / values.length;
  const groups = Object.fromEntries(Object.keys(results[0].groups).map(group => [group, avg(results.map(r => r.groups[group]))]));
  const totalRaw = avg(results.map(r => r.totalRaw)), model = results[0].model;
  return {
    month: { month, status: 'closed', rule_id: rule.id }, rule,
    assignments: [{ supplier_id: 'supplier-1', name: '合成供应商', raters: scores.map(s => ({ id: s.user_id, name: s.raterName })) }],
    scores, records: [],
    summaries: [{ supplierId: 'supplier-1', name: '合成供应商', month, ruleId: rule.id, model, groups, totalRaw, total: roundScore(totalRaw), grade: model === 'ds' ? '—' : ratingGrade(totalRaw), capCount: results.filter(r => r.capApplied).length, count: scores.length, expected: scores.length, exempt: false }],
  };
}
const full = rule => Object.fromEntries(rule.items.map(i => [i.id, i.max]));

test('新版月报与个人明细保留三类分数，先个人封顶后平均且不导出综合等级', async () => {
  const rule = { ...QCDS_RULE, id: 2 };
  const data = bundle(rule, '2026-11', [{ ...full(rule), urgent: 40 }, full(rule)]);
  data.scores.push({ month: '2026-11', supplier_id: 'supplier-1', user_id: 'draft', raterName: '未提交合成评价', status: 'draft', notes: {}, scores: full(rule) });
  const book = await readBook(await exportRating(data));
  const summary = book.getWorksheet('评分汇总'), individuals = book.getWorksheet('个人评分');
  for (const name of ['交付分(100分)', '服务分(100分)', '贡献分(30分)']) {
    assert.ok(headers(summary).includes(name)); assert.ok(headers(individuals).includes(name));
  }
  for (const worksheet of [summary, individuals]) {
    assert.ok(!headers(worksheet).includes('总分')); assert.ok(!headers(worksheet).includes('等级'));
    assert.ok(worksheet.autoFilter); assert.equal(Object.keys(worksheet.tables).length, 0);
  }
  assert.equal(valueAt(summary, '交付分(100分)'), 85);
  assert.equal(valueAt(summary, '服务分(100分)'), 100);
  assert.equal(valueAt(summary, '贡献分(30分)'), 27);
  assert.match(valueAt(summary, '说明'), /1份评价触发交付封顶/);
  assert.equal(valueAt(individuals, '急单响应(100分)'), 40);
  assert.equal(valueAt(individuals, '交付分(100分)'), 70);
  assert.equal(valueAt(individuals, '贡献分(30分)'), 24);
  assert.equal(valueAt(individuals, '贡献分(30分)', 3), 30);
  assert.match(valueAt(individuals, '封顶说明'), /70分/);
  assert.equal(valueAt(individuals, '贡献分(30分)', 4), '');
  assert.equal((valueAt(individuals, '贡献分(30分)', 2) + valueAt(individuals, '贡献分(30分)', 3)) / 2, valueAt(summary, '贡献分(30分)'));
});

test('新版导出包含组内权重、四档原文、选填依据及旧过程项目来源', async () => {
  const rule = { ...QCDS_RULE, id: 5 }, data = bundle(rule, '2026-11', [full(rule)]);
  data.records.push({ month: '2026-11', supplier_id: 'supplier-1', item: 'old-item', itemName: '原交付承诺项目', sourceRuleId: 1, issue: '合成旧问题', attribution: '供应商', action: '继续跟进', owner: '合成负责人', dueDate: '2026-11-30', completedDate: '', state: '处理中', review: '' });
  const book = await readBook(await exportRating(data)), rules = book.getWorksheet('规则说明');
  assert.equal(rules.rowCount, 8);
  assert.equal(valueAt(rules, '组内权重(%)'), 50);
  assert.equal(valueAt(rules, '组内权重(%)', 5), 30);
  assert.match(valueAt(rules, '参考区间(项目分值)'), /90—100分：基本都按期，偶尔小延误/);
  assert.equal(valueAt(rules, '参考区间(项目分值)').split('\n').length, 4);
  assert.match(valueAt(rules, '参考区间(项目分值)', 4), /0—40分：装死、不配合/);
  assert.match(valueAt(rules, '参考区间(项目分值)', 5), /0分：电话不接、微信不回、推卸责任/);
  assert.equal(valueAt(book.getWorksheet('过程记录'), '项目'), '原交付承诺项目（原规则V1）');
  const dueDateColumn = headers(book.getWorksheet('过程记录')).indexOf('计划完成日期') + 1;
  assert.equal(book.getWorksheet('过程记录').getCell(2, dueDateColumn).numFmt, 'yyyy-mm-dd');
  const statements = book.getWorksheet('统计口径').getColumn(2).values.filter(Boolean).join('\n');
  assert.match(statements, /评分依据选填/); assert.match(statements, /每位评价人先/); assert.match(statements, /满分30/);
});

test('旧规则和旧快照继续导出原100分列、等级、五档参考，不冒充30分贡献', async () => {
  const rule = { id: 1, items: RATING_ITEMS };
  const data = bundle(rule, '2026-10', [full(rule), Object.fromEntries(rule.items.map(i => [i.id, i.max * .8]))]);
  delete data.summaries[0].model;
  const original = JSON.stringify(data), book = await readBook(await exportRating(data));
  assert.equal(JSON.stringify(data), original);
  assert.deepEqual(headers(book.getWorksheet('评分汇总')), ['月份', '供应商名称', '交期', '数量', '配合', '总分', '等级', '已评人数', '应评人数', '状态', '说明']);
  assert.equal(valueAt(book.getWorksheet('评分汇总'), '总分'), 90);
  assert.equal(valueAt(book.getWorksheet('评分汇总'), '等级'), 'A');
  assert.equal(valueAt(book.getWorksheet('个人评分'), '总分'), 100);
  assert.equal(valueAt(book.getWorksheet('个人评分'), '总分', 3), 80);
  assert.equal(valueAt(book.getWorksheet('规则说明'), '参考分值'), '40 / 32 / 24 / 16 / 0');
  assert.ok(!headers(book.getWorksheet('规则说明')).includes('组内权重(%)'));
});

test('混合模式期间导出拆成新旧汇总及月度依据，单一旧模式保留原表名', async () => {
  const legacyRule = { id: 1, items: RATING_ITEMS }, weightedRule = { ...QCDS_RULE, id: 2 };
  const legacy = bundle(legacyRule, '2026-10', [full(legacyRule)]).summaries[0]; delete legacy.model;
  const weighted = bundle(weightedRule, '2026-11', [{ ...full(weightedRule), urgent: 40 }]).summaries[0];
  const period = summary => ({ ...summary, period: 'Q4', months: [summary.month], partial: true, mixedRules: false });
  const data = { monthly: [legacy, weighted], periods: [period(legacy), period(weighted)] };
  const book = await readBook(await exportRatingPeriod(data, '2026', 'Q4'));
  assert.ok(book.getWorksheet('新版期间评分汇总')); assert.ok(book.getWorksheet('历史期间评分汇总'));
  assert.equal(book.getWorksheet('期间评分汇总'), undefined);
  assert.equal(valueAt(book.getWorksheet('新版期间评分汇总'), '贡献分(30分)'), 24);
  assert.equal(valueAt(book.getWorksheet('历史期间评分汇总'), '总分'), 100);
  assert.equal(valueAt(book.getWorksheet('历史期间评分汇总'), '等级'), 'A');
  assert.ok(!headers(book.getWorksheet('新版期间评分汇总')).includes('等级'));
  assert.equal(book.getWorksheet('新版月度计算依据').rowCount, 2);
  assert.equal(valueAt(book.getWorksheet('新版月度计算依据'), '月份'), '2026-11');
  assert.equal(book.getWorksheet('历史月度计算依据').rowCount, 2);
  assert.equal(valueAt(book.getWorksheet('历史月度计算依据'), '月份'), '2026-10');
  const oldOnly = await readBook(await exportRatingPeriod({ monthly: [legacy], periods: [period(legacy)] }, '2026', 'Q4'));
  assert.ok(oldOnly.getWorksheet('期间评分汇总')); assert.ok(oldOnly.getWorksheet('月度计算依据'));
  assert.equal(valueAt(oldOnly.getWorksheet('期间评分汇总'), '总分'), 100);
  const emptyNew = await readBook(await exportRatingPeriod({ model: 'ds', monthly: [], periods: [] }, '2026', 'year'));
  assert.ok(headers(emptyNew.getWorksheet('期间评分汇总')).includes('贡献分(30分)'));
  assert.ok(!headers(emptyNew.getWorksheet('期间评分汇总')).includes('等级'));
});
