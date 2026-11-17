export const BASE_PATH = '/zijintaizhang';
export const API_PATH = `${BASE_PATH}/api`;
export const SLOTS = [
  { id: 'schedule', label: '付款节奏' },
  { id: 'shipment', label: '发货计划预估' },
  { id: 'after_sales', label: '售后配件预估' },
  { id: 'unregistered', label: '已发货未登记台账预估' },
];
export const ORDER_SLOT = { id: 'kingdee_orders', label: '金蝶采购订单' };
export const ALL_SLOTS = [...SLOTS, ORDER_SLOT];
export const CATEGORIES = {
  negotiated: '谈判表-谈判付款', negotiated_normal: '谈判表-正常付款', normal: '正常付款-已对账', normal_unreconciled: '正常付款-未完成对账', shipment: '发货计划预估',
  after_sales: '售后配件预估', unregistered: '已发货未登记台账预估',
};
export const LEDGER_CATEGORIES = ['negotiated', 'negotiated_normal', 'normal', 'normal_unreconciled'];
export const PARSER_VERSION = 9;
export const PERMISSIONS = {
  dashboard: '查看资金看板', files: '查看文件管理', upload: '上传并替换文件',
  download: '下载原始文件', export: '导出查询结果', restore: '恢复历史版本',
  logsLogin: '查看登录记录', logsOperation: '查看操作记录', logsSecurity: '查看安全异常',
};
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
