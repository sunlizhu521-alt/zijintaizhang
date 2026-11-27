import test from 'node:test';
import assert from 'node:assert/strict';
import { QCDS_RULE as TEN_POINT_RULE, RATING_ITEMS, calculateRating, normalizeRatingScore, ratingGrade, ratingReferenceText, validateRatingRule } from '../shared/rating.js';
const QCDS_RULE = { ...TEN_POINT_RULE, items: TEN_POINT_RULE.items.map(item => ({ ...item, max: 100 })) };

const filled = (rule = QCDS_RULE, value) => Object.fromEntries(rule.items.map(item => [item.id, value ?? item.max]));
const copyRule = () => structuredClone(QCDS_RULE);

test('10分制默认、参考分档和百分制等值，允许一位小数且保留急单封顶', () => {
  assert.ok(TEN_POINT_RULE.items.every(item => item.max === 10));
  const scores = { delivery_ontime: 8.5, delivery_quantity: 7.6, urgent: 4, after_sales: 0, rectification: 9.1, coordination: 8, cooperation: 10 };
  const result = calculateRating(TEN_POINT_RULE, scores);
  const old = calculateRating(QCDS_RULE, Object.fromEntries(Object.entries(scores).map(([id, value]) => [id, Math.round(value * 10)])));
  assert.equal(result.complete, true); assert.deepEqual(result.groups, old.groups); assert.equal(result.total, old.total);
  assert.equal(result.capApplied, true);
  assert.equal(calculateRating(TEN_POINT_RULE, { ...scores, urgent: 4.1 }).capApplied, false);
  assert.match(ratingReferenceText(TEN_POINT_RULE, TEN_POINT_RULE.items[0]), /9—10分/);
  assert.match(ratingReferenceText(TEN_POINT_RULE, TEN_POINT_RULE.items[0]), /7.5—8.9分/);
  for (const value of [-0.1, 10.1, 8.55, '', null, '8.5', NaN, Infinity]) assert.equal(calculateRating(TEN_POINT_RULE, { ...scores, urgent: value }).complete, false);
});

test('七项按组加权，D/S各100分、贡献满分30，售后零分不扣光整个服务项', () => {
  const full = calculateRating(QCDS_RULE, filled());
  assert.equal(full.complete, true);
  assert.deepEqual(full.groups, { 交付: 100, 服务: 100 });
  assert.equal(full.totalRaw, 30); assert.equal(full.total, 30);
  assert.equal(full.totalMax, 30); assert.equal(full.grade, '—'); assert.equal(full.model, 'ds');
  const afterSales = calculateRating(QCDS_RULE, { ...filled(), after_sales: 0 });
  assert.equal(afterSales.groups['服务'], 70); assert.equal(afterSales.totalRaw, 27);
  const varied = calculateRating(QCDS_RULE, { delivery_ontime: 80, delivery_quantity: 70, urgent: 60, after_sales: 90, rectification: 80, coordination: 70, cooperation: 60 });
  assert.equal(varied.groups['交付'], 73);
  assert.equal(varied.groups['服务'], 76.5);
  assert.ok(Math.abs(varied.totalRaw - 22.25) < 1e-10); assert.equal(varied.total, 22.3);
  const half = calculateRating(QCDS_RULE, { delivery_ontime: 13, delivery_quantity: 7, urgent: 1, after_sales: 96, rectification: 90, coordination: 84, cooperation: 78 });
  assert.ok(Math.abs(half.totalRaw - 10.55) < 1e-10); assert.equal(half.total, 10.6);
});

test('个人急单40分封顶、41分不封顶，低于70不抬高，多人须先封顶后平均', () => {
  const lowUrgent = calculateRating(QCDS_RULE, { ...filled(), urgent: 40 });
  assert.equal(lowUrgent.capApplied, true); assert.equal(lowUrgent.groups['交付'], 70); assert.equal(lowUrgent.total, 24);
  const justAbove = calculateRating(QCDS_RULE, { ...filled(), urgent: 41 });
  assert.equal(justAbove.capApplied, false); assert.equal(justAbove.groups['交付'], 88.2); assert.equal(justAbove.total, 27.6);
  const lower = calculateRating(QCDS_RULE, { ...filled(), delivery_ontime: 0, delivery_quantity: 0, urgent: 40 });
  assert.equal(lower.groups['交付'], 8);
  const full = calculateRating(QCDS_RULE, filled());
  assert.equal((lowUrgent.groups['交付'] + full.groups['交付']) / 2, 85);
  assert.equal((lowUrgent.totalRaw + full.totalRaw) / 2, 27);
  assert.equal(calculateRating(QCDS_RULE, { ...filled(), urgent: 70 }).groups['交付'], 94);
  const uncapped = calculateRating({ ...QCDS_RULE, cap: null }, { ...filled(), urgent: 40 });
  assert.equal(uncapped.capApplied, false); assert.equal(uncapped.groups['交付'], 88);
});

test('零分有效，空白或非法输入不生成总分，单个完整维度可独立预览', () => {
  const zero = calculateRating(QCDS_RULE, filled(QCDS_RULE, 0));
  assert.equal(zero.complete, true); assert.equal(zero.total, 0);
  for (const value of [null, undefined, '', '60', NaN, Infinity, -1, 101, 59.5]) {
    const result = calculateRating(QCDS_RULE, { ...filled(), after_sales: value });
    assert.equal(result.complete, false, String(value)); assert.equal(result.total, null);
    assert.equal(result.normalizedScores.after_sales, null);
    assert.equal(result.groups['服务'], null); assert.equal(result.groups['交付'], 100);
  }
  assert.equal(calculateRating(QCDS_RULE, {}).total, null);
  assert.equal(calculateRating(null).complete, false);
});

test('允许参考分档间隙的整数', () => {
  const urgent = QCDS_RULE.items.find(i => i.id === 'urgent');
  assert.equal(calculateRating(QCDS_RULE, { ...filled(), urgent: 59, after_sales: 1 }).complete, true);
  assert.match(ratingReferenceText(QCDS_RULE, urgent), /0—40分：装死、不配合/);
  assert.match(ratingReferenceText(QCDS_RULE, QCDS_RULE.items.find(i => i.id === 'after_sales')), /0分：电话不接、微信不回、推卸责任/);
});

test('管理员调整满分后仍先折算百分制再判封顶，不提前舍入', () => {
  const rule = copyRule(); rule.items.find(i => i.id === 'urgent').max = 50;
  const urgent = rule.items.find(i => i.id === 'urgent');
  assert.equal(normalizeRatingScore(urgent, 20), 40);
  assert.equal(normalizeRatingScore(urgent, 20.5), 41);
  assert.equal(normalizeRatingScore(urgent, 51), null);
  assert.equal(normalizeRatingScore(urgent, null), null);
  assert.equal(calculateRating(rule, { ...filled(rule), urgent: 20 }).groups['交付'], 70);
  assert.equal(calculateRating(rule, { ...filled(rule), urgent: 21 }).groups['交付'], 88.4);
  assert.equal(calculateRating(rule, filled(rule)).totalRaw, 30);
});

test('旧规则保持原项目加和、五档参考、等级', () => {
  const rule = { items: RATING_ITEMS };
  const full = calculateRating(rule, filled(rule));
  assert.equal(full.totalRaw, 100); assert.equal(full.grade, 'A'); assert.equal(full.totalMax, 100); assert.equal(full.model, 'legacy');
  assert.deepEqual(full.groups, { 交期: 50, 数量: 30, 配合: 20 });
  const scores = { ...filled(rule), ontime: 29 };
  assert.equal(calculateRating(rule, scores).totalRaw, 89); assert.equal(calculateRating(rule, scores).grade, 'B');
  assert.equal(ratingReferenceText(rule, RATING_ITEMS[0]), '40 / 32 / 24 / 16 / 0');
  const clean = validateRatingRule({ baseId: 1, ...rule });
  assert.deepEqual(Object.keys(clean), ['items']);
  assert.equal(clean.items.length, 8); assert.deepEqual(clean.items[0].references, [40, 32, 24, 16, 0]);
  assert.equal(calculateRating(clean, filled(clean)).total, 100);
  assert.equal(ratingGrade(89.94), 'B'); assert.equal(ratingGrade(89.96), 'A');
});

test('新版规则校验维度权重、参考区间、危险标识及封顶关联，不接受隐式失效', () => {
  assert.deepEqual(validateRatingRule(QCDS_RULE), QCDS_RULE);
  assert.equal(validateRatingRule({ ...QCDS_RULE, cap: null }).cap, null);
  const failures = [
    r => { r.model = 'unknown'; }, r => { r.items = []; }, r => { r.items = Array(101).fill(r.items[0]); },
    r => { r.items[0].weight = 49; }, r => { r.items[0].weight = 50.5; }, r => { r.items[0].weight = 0; },
    r => { r.items[0].group = '质量'; }, r => { r.items[0].max = 0; }, r => { r.items[0].max = 101; },
    r => { r.items[0].id = 'constructor'; }, r => { r.items[0].id = '__proto__'; }, r => { r.items[0].id = r.items[1].id; },
    r => { r.items[0].name = ''; }, r => { r.items[0].standard = null; },
    r => { r.items[0].bands = []; }, r => { r.items[0].bands[0].max = 101; },
    r => { r.items[0].bands[1].max = 90; }, r => { r.items[0].bands[0].min = 100.5; },
    r => { r.items[0].bands[0].label = ''; }, r => { r.items[0].bands[3].min = -1; },
    r => { r.cap.itemId = 'after_sales'; }, r => { r.cap.itemId = 'missing'; }, r => { r.cap.threshold = 41; },
    r => { r.cap.max = 71; }, r => { r.evidenceBelow = 61; },
  ];
  for (const mutate of failures) { const rule = copyRule(); mutate(rule); assert.throws(() => validateRatingRule(rule)); }
  const changedMax = copyRule(); changedMax.items[0].max = 50;
  assert.equal(validateRatingRule(changedMax).items[0].max, 50);
  const minimal = copyRule(); minimal.cap = null;
  minimal.items = [minimal.items[0], minimal.items[3]].map(i => ({ ...i, weight: 100 }));
  assert.equal(validateRatingRule(minimal).items.length, 2);
  const invalidOld = { items: RATING_ITEMS.map((i, n) => n ? i : { ...i, references: [40, 32, 24, 0] }) };
  assert.throws(() => validateRatingRule(invalidOld), /5个/);
});
