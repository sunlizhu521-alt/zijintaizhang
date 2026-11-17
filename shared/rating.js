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
export const ratingMonth = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).format(new Date());
export const roundScore = value => value == null ? null : Math.round((value + Number.EPSILON) * 10) / 10;
export function ratingGrade(value) { const score = roundScore(value); return score == null ? '—' : score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : 'D'; }
