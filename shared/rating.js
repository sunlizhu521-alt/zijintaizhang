export const RATING_BASE = '/gongyingshangpingji';
export const RATING_MONTH_LABELS = { open: '评分中', paused: '临时关闭', closed: '已结月' };
export const RATING_PERMISSIONS = { rate: '填写本人评分', dashboard: '查看授权供应商汇总', export: '导出授权记录' };
export const RATING_ITEMS = [
  { id: 'ontime', group: '交期', name: '按期交付表现', max: 40, standard: '按双方确认的交期完成交付；依据延期天数、次数及对计划的实际影响评价。' },
  { id: 'promise', group: '交期', name: '交期承诺可靠性', max: 10, standard: '承诺真实可行并兑现，不反复改期或临时跳票；我方变更造成的调整单独说明。' },
  { id: 'quantity', group: '数量', name: '约定数量交付完成情况', max: 25, standard: '按约定交足数量，不擅自减量或拆分；依据应交与实交数量评价。' },
  { id: 'shortage', group: '数量', name: '尾数、欠交处理', max: 5, standard: '欠交按约及时补齐，无长期拖欠。已核实无欠交可满分。' },
  { id: 'feedback', group: '配合', name: '订单确认及进度反馈', max: 5, standard: '及时确认订单，并按约提供完整、真实的备料和生产进度。' },
  { id: 'warning', group: '配合', name: '风险提前预警', max: 5, standard: '提前告知交付风险并提供可执行的应对方案。已核实无相关风险可满分。' },
  { id: 'resolution', group: '配合', name: '异常处理与整改', max: 5, standard: '明确责任和措施，按约完成整改，避免问题重复。已核实无异常可满分。' },
  { id: 'documents', group: '配合', name: '单据及对账协同', max: 5, standard: '送货单、物流信息及对账资料及时、完整、准确。' },
];
export const RATING_BANDS = [
  [1, '全部按约完成'], [.8, '轻微偏差，及时纠正'], [.6, '反复催办或影响计划'], [.4, '严重偏差，补救不及时'], [0, '该项未履行或拒绝配合'],
];
// Older rule versions did not store reference values; retain their original bands.
export const ratingReferences = item => item.references ?? RATING_BANDS.map(([factor]) => Math.round(item.max * factor));
export const ratingMonth = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).format(new Date());
export const roundScore = value => value == null ? null : Math.round((value + Number.EPSILON * Math.max(1, Math.abs(value))) * 10) / 10;
export function ratingGrade(value) { const score = roundScore(value); return score == null ? '—' : score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : 'D'; }

const bands = (labels, lowestMax = 59) => [[90, 100], [75, 89], [60, 74], [0, lowestMax]].map(([min, max], n) => ({ min, max, label: labels[n] }));
export const QCDS_RULE = {
  model: 'ds', evidenceBelow: 60, cap: { itemId: 'urgent', threshold: 40, max: 70 },
  items: [
    { id: 'delivery_ontime', group: '交付', name: '按期交付率', max: 10, weight: 50, standard: '凭感觉打：货按约定交期到了吗？', bands: bands(['基本都按期，偶尔小延误', '大部分按期，少数延误', '一半按期，延误不少', '经常延误、交期没谱']) },
    { id: 'delivery_quantity', group: '交付', name: '发货数量满足率', max: 10, weight: 30, standard: '凭感觉打：每次发货需求给到供应商，能及时发齐吗？', bands: bands(['基本都能及时发齐', '大部分能及时发齐，偶尔短交', '有时发不齐、要催几次', '经常短交、不及时']) },
    { id: 'urgent', group: '交付', name: '急单响应', max: 10, weight: 20, standard: '凭感觉打：有急单，配合吗？', bands: bands(['急单都按时办', '大部分急单能办', '正常单配合、急单勉强', '装死、不配合'], 40) },
    { id: 'after_sales', group: '服务', name: '售后响应时效', max: 10, weight: 30, standard: '凭感觉打：出了问题，联系得上吗？', bands: bands(['随时能联系、及时处理', '基本能联系上', '要催几次才回', '电话不接、微信不回、推卸责任'], 0) },
    { id: 'rectification', group: '服务', name: '异常处理与整改', max: 10, weight: 25, standard: '按次打：质量或交期异常，整改到位吗？结合当月发生次数和表现，每月填写一个分数。', bands: bands(['主动出整改报告、闭环快', '按期出报告、能整改', '要催才出、整改慢', '逾期不出、同类问题反复']) },
    { id: 'coordination', group: '服务', name: '订单协同反馈', max: 10, weight: 25, standard: '按次打：订单进度、风险，主动说吗？结合当月发生次数和表现，每月填写一个分数。', bands: bands(['主动报进度、提前预警', '问了能及时回', '要催才回', '该报不报、对账拖延']) },
    { id: 'cooperation', group: '服务', name: '配合程度', max: 10, weight: 20, standard: '按次打：合同回传、盖章、单据，配合吗？结合当月发生次数和表现，每月填写一个分数。', bands: bands(['都主动配合', '基本配合', '要催才办', '拖延、推诿']) },
  ],
};

export const ratingModel = rule => rule?.model === 'ds' ? 'ds' : 'legacy';
export const isWeightedRule = rule => ratingModel(rule) === 'ds';
export function normalizeRatingScore(item, value) {
  return Number.isFinite(value) && Number.isFinite(item?.max) && item.max > 0 && value >= 0 && value <= item.max ? value * 100 / item.max : null;
}
export function validRatingScore(rule, item, value) {
  const units = isWeightedRule(rule) && item.max === 10 ? 10 : 1;
  return Number.isFinite(value) && value >= 0 && value <= item.max && Math.abs(value * units - Math.round(value * units)) < 1e-9;
}
export const ratingBandScore = (item, value) => Math.round(value * item.max) / 100;
export function ratingReferenceText(rule, item) {
  return isWeightedRule(rule) ? (item.bands || []).map(b => `${b.min === b.max ? ratingBandScore(item, b.min) : `${ratingBandScore(item, b.min)}—${ratingBandScore(item, b.max)}`}分：${b.label}`).join('\n') : ratingReferences(item).join(' / ');
}
export function calculateRating(rule, scores = {}) {
  const items = rule?.items || [], model = ratingModel(rule), weighted = model === 'ds';
  const normalizedScores = Object.fromEntries(items.map(i => [i.id, validRatingScore(rule, i, scores?.[i.id]) ? normalizeRatingScore(i, scores[i.id]) : null]));
  const complete = items.length > 0 && items.every(i => normalizedScores[i.id] !== null);
  const groups = Object.fromEntries([...new Set(items.map(i => i.group))].map(group => {
    const members = items.filter(i => i.group === group);
    return [group, members.every(i => normalizedScores[i.id] !== null) ? members.reduce((sum, i) => sum + (weighted ? normalizedScores[i.id] * i.weight / 100 : scores[i.id]), 0) : null];
  }));
  const capApplied = Boolean(weighted && rule.cap && groups['交付'] != null && normalizedScores[rule.cap.itemId] != null && normalizedScores[rule.cap.itemId] <= rule.cap.threshold);
  if (capApplied) groups['交付'] = Math.min(groups['交付'], rule.cap.max);
  const totalRaw = complete ? weighted ? groups['交付'] != null && groups['服务'] != null ? groups['交付'] * .2 + groups['服务'] * .1 : null : Object.values(groups).reduce((sum, value) => sum + value, 0) : null;
  return { complete, totalRaw, total: roundScore(totalRaw), groups, normalizedScores, capApplied, grade: weighted ? '—' : ratingGrade(totalRaw), model, totalMax: weighted ? 30 : 100 };
}

export function validateRatingRule(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || (input.model !== undefined && !['legacy', 'ds'].includes(input.model))) throw new Error('评分模式无效');
  const weighted = isWeightedRule(input), items = input.items;
  if (!Array.isArray(items) || !items.length || items.length > 100) throw new Error('请保留至少1项评分项目，最多100项');
  const text = (value, label, max) => {
    if (typeof value !== 'string' || value.length > max || !value.trim()) throw new Error(`${label}无效或未填写`);
    return value.trim();
  };
  const ids = new Set();
  const clean = items.map((item, n) => {
    const prefix = `第${n + 1}项`;
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(item.id) || Object.hasOwn(Object.prototype, item.id) || item.id === 'prototype' || ids.has(item.id)) throw new Error(`${prefix}标识无效或重复`);
    ids.add(item.id);
    if (!Number.isInteger(item.max) || item.max < 1 || item.max > 100) throw new Error(`${prefix}满分须为1至100的整数`);
    const result = { id: item.id, group: text(item.group, `${prefix}维度`, 50), name: text(item.name, `${prefix}项目`, 100), max: item.max, standard: text(item.standard, `${prefix}标准`, 2000) };
    if (weighted) {
      if (!['交付', '服务'].includes(result.group)) throw new Error(`${prefix}维度须为交付或服务`);
      if (!Number.isInteger(item.weight) || item.weight < 1 || item.weight > 100) throw new Error(`${prefix}权重须为1至100的整数`);
      if (!Array.isArray(item.bands) || item.bands.length !== 4) throw new Error(`${prefix}须填写4档参考区间`);
      result.weight = item.weight;
      result.bands = item.bands.map((band, index) => {
        if (!band || typeof band !== 'object' || Array.isArray(band) || !Number.isInteger(band.min) || !Number.isInteger(band.max) || band.min < 0 || band.max > 100 || band.min > band.max || (index > 0 && band.max >= item.bands[index - 1].min)) throw new Error(`${prefix}参考区间须在0至100之间，按从高到低排列且不能重叠`);
        return { min: band.min, max: band.max, label: text(band.label, `${prefix}第${index + 1}档说明`, 500) };
      });
    } else {
      const references = item.references === undefined ? ratingReferences(item) : item.references;
      if (!Array.isArray(references) || references.length !== 5 || references.some((v, index) => !Number.isInteger(v) || v < 0 || v > item.max || (index > 0 && v > references[index - 1]))) throw new Error(`${prefix}参考分值须为5个从高到低的整数，范围为0至${item.max}`);
      result.references = [...references];
    }
    return result;
  });
  if (!weighted) {
    if (clean.reduce((sum, item) => sum + item.max, 0) !== 100) throw new Error('各项满分合计必须为100分');
    return { items: clean };
  }
  for (const group of ['交付', '服务']) if (clean.filter(i => i.group === group).reduce((sum, i) => sum + i.weight, 0) !== 100) throw new Error(`${group}组内权重合计必须为100%`);
  if (input.evidenceBelow !== undefined && input.evidenceBelow !== 60) throw new Error('新版低分依据阈值须为60分');
  const cap = input.cap === undefined ? QCDS_RULE.cap : input.cap;
  if (cap !== null && (!cap || typeof cap !== 'object' || Array.isArray(cap) || cap.threshold !== 40 || cap.max !== 70 || !clean.some(i => i.id === cap.itemId && i.group === '交付'))) throw new Error('急单封顶须关联交付项目，条件为不超过40分时交付分最高70分');
  return { model: 'ds', items: clean, evidenceBelow: 60, cap: cap === null ? null : { itemId: cap.itemId, threshold: 40, max: 70 } };
}
