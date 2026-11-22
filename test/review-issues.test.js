import test from 'node:test';
import assert from 'node:assert/strict';
import { describeReviewIssue } from '../server/review-issues.js';

test('核对文案解释现有提示，空金额按0不称坏数据，疑似重复不称确认重复', () => {
  const message = 'N10：金额为空或公式没有已保存的计算结果，已按0保存。';
  const zero = describeReviewIssue({ code: 'ZERO_DEFAULTED', message }, new Map());
  assert.equal(zero.title, '空金额按0处理');
  assert.equal(zero.message, message);
  assert.equal(zero.action, '已按约定计为0；如需补充金额，在 Excel 修改后重新上传。');
  const duplicate = describeReviewIssue({ code: 'POSSIBLE_DUPLICATE', message: '可能重叠，请人工核对。' }, new Map());
  assert.match(duplicate.title, /疑似/);
  assert.match(duplicate.action, /确认是否为同一笔/);
  const sameFlow = describeReviewIssue({ code: 'DUPLICATE_FLOW', message: '同一流程可能为分笔记录。' }, new Map());
  assert.equal(sameFlow.title, '同流程号存在多笔记录');
  assert.match(sameFlow.action, /分笔记录还是重复登记/);
});

test('付款进度提示按既有原因展示，明确未付款和重新申请不冒充缺失或异常', () => {
  for (const [message, title] of [
    ['当前付款依据缺少可用的“付款进度整理”，计未付，请核对。', '缺少付款进度依据'],
    ['没有有效流程号，无法关联“付款进度整理”，计未付，请核对。', '无有效付款流程号'],
    ['“付款进度整理”未匹配流程号 MDST-DGFK20261101001，计未付，请核对。', '付款进度未匹配流程号'],
    ['流程号已找到，但申请金额、供应商或付款主体不一致，计未付，请核对。', '同流程号的付款信息不一致'],
    ['同流程号及金额、供应商、付款主体存在相互冲突的付款状态，计未付，请核对。', '同笔付款状态冲突'],
    ['同流程号及金额、供应商、付款主体仍对应多笔记录，无法确定付款依据，计未付，请核对。', '付款进度仍对应多笔记录'],
    ['“付款进度整理”的“是否已付款”为空，计未付。', '付款进度未填写状态'],
    ['“付款进度整理”的“是否已付款”为“未付款”，计未付。', '付款进度标记未付款'],
    ['“付款进度整理”的“是否已付款”为“重新申请”，计未付。', '付款进度标记重新申请'],
    ['“付款进度整理”的“是否已付款”为“审核中”，计未付。', '付款状态待确认'],
  ]) {
    const issue = describeReviewIssue({ code: 'PAYMENT_PROGRESS_REVIEW', message }, new Map());
    assert.equal(issue.title, title);
    assert.equal(issue.message, message);
    assert.ok(issue.action.length > 0);
  }
});

test('未知提示保留原消息并给安全回退，不假造来源或关联位置', () => {
  const issue = { code: 'toString', message: '来源中新的核对提示', filename: '原文件.xlsx', relatedRecordKeys: ['不存在'] };
  const result = describeReviewIssue(issue, new Map());
  assert.equal(result.title, issue.message);
  assert.equal(result.message, issue.message);
  assert.equal(result.action, '对照来源文件确认该项内容。');
  assert.equal(result.filename, issue.filename);
  assert.deepEqual(result.relatedRecordKeys, ['不存在']);
  assert.deepEqual(result.relatedLocations, []);
});
