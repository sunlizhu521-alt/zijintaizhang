import test from 'node:test';
import assert from 'node:assert/strict';
import { groupSuppliers, supplierRecordDetails } from '../src/supplier-data.js';

const plan = (month, amountCents, paidCents = 0) => ({ month, amountCents, paidCents, unpaidCents: amountCents - paidCents });

test('一供应商一行，保留多条来源和分类；月份和金额仅用筛选计划且保留待定及零', () => {
  const records = [
    { supplier: '供应商甲', category: 'negotiated', amountCents: 999999, plans: [plan('2026-10', 900), plan('2026-11', 100)], selectedPlans: [plan('2026-11', 100)], selectedPlanCents: 100 },
    { supplier: '供应商甲', category: 'normal', plans: [plan(null, 50), plan('2027-01', 0)] },
    { supplier: '供应商甲', category: 'normal', plans: [plan('2026-11', 200)] },
    { supplier: '供应商乙', category: 'normal', plans: [plan('2026-11', 0)], selectedPlanCents: 0 },
  ];
  const result = groupSuppliers(records);
  assert.equal(result.length, 2);
  assert.equal(result[0].amountCents, 350);
  assert.deepEqual(result[0].categories, ['negotiated', 'normal']);
  assert.deepEqual(result[0].months, ['2026-11', '2027-01', null]);
  assert.deepEqual(result[0].records, records.slice(0, 3));
  assert.equal(result[1].amountCents, 0);
  assert.deepEqual(groupSuppliers([]), []);
  assert.equal(groupSuppliers([{ supplier: '甲', plans: [plan('2026-10', 300)], selectedPlans: [] }])[0].amountCents, 0);
});

test('按原表明确日期列列出分批，月支付列和空日期金额不重复算批次；零保留', () => {
  const detail = supplierRecordDetails({ plans: [plan('2026-11', 7950000, 7950000)], raw: {
    '谈判明细': '11月25日－79,500.00', '是否谈判分批': '否', '2026年11月2日': 79500,
    '2026年11月16日': null, '2026年11月30日': '', '2026年11月支付': 79500, '2027-01-02T00:00:00.000Z': 0,
    '2026年2月30日': 100, '11月2日': 1.005,
    '是否提交付款申请单': '已经提交全部', '当前节点': '办理人执行', '孙立柱备注': '原备注\n第二行',
  }});
  assert.equal(detail.negotiation, '11月25日－79,500.00');
  assert.equal(detail.installmentFlag, '否');
  assert.equal(detail.installmentCount, 3);
  assert.equal(detail.installmentCountSource, 'dated_columns');
  assert.deepEqual(detail.installments, [{ date: '2026-11-02', amountCents: 7950000 }, { date: '2027-01-02', amountCents: 0 }, { date: '11月2日', amountCents: 101 }]);
  assert.equal(detail.applicationStatus, '已经提交全部');
  assert.equal(detail.currentNode, '办理人执行');
  assert.equal(detail.remark, '原备注\n第二行');
  assert.equal(detail.paymentStatus, '已支付');
  assert.equal(detail.paidCents, 7950000);
});

test('支付状态沿已解析的所选计划，不使用累计已付和归档状态推测', () => {
  const record = { status: '已归档', paidCents: 999999, plans: [plan('2026-10', 100, 100), plan('2026-11', 200, 50)] };
  assert.equal(supplierRecordDetails(record).paymentStatus, '部分已支付');
  const selected = supplierRecordDetails({ ...record, selectedPlans: [record.plans[1]] });
  assert.equal(selected.paidCents, 50);
  assert.equal(selected.unpaidCents, 150);
  assert.equal(supplierRecordDetails({ ...record, selectedPlans: [plan(null, 100)] }).paymentStatus, '未支付');
  assert.equal(supplierRecordDetails({ plans: [plan('2026-11', 0)] }).paymentStatus, '金额为0');
  assert.equal(supplierRecordDetails({ plans: [plan('2026-11', -100, -100)] }).paymentStatus, '已支付');
  const uncertain = supplierRecordDetails({ plans: [{ month: '2026-11', amountCents: 100, paidCents: null, unpaidCents: null }] });
  assert.equal(uncertain.paymentStatus, '待核对');
  assert.equal(uncertain.paidCents, null);
  assert.equal(supplierRecordDetails({}).paymentStatus, '待核对');
  const serverUnknown = supplierRecordDetails({ plans: [plan('2026-11', 0)], selectedPaidCents: null, selectedUnpaidCents: null });
  assert.equal(serverUnknown.paidCents, null);
  assert.equal(serverUnknown.paymentStatus, '待核对');
  const serverZero = supplierRecordDetails({ plans: [plan('2026-11', 0)], selectedPaidCents: 0, selectedUnpaidCents: 0 });
  assert.equal(serverZero.paidCents, 0);
  assert.equal(serverZero.unpaidCents, 0);
});

test('缺少分批字段不猜测；明确次数优先，金额异常不静默补零', () => {
  const empty = supplierRecordDetails({ plans: [plan(null, 0)] });
  assert.equal(empty.installmentCount, null);
  assert.equal(empty.installmentFlag, '');
  assert.deepEqual(empty.installments, []);
  const detail = supplierRecordDetails({ applicationStatus: '已申请', raw: {
    '分几批': '3批', '2026年11月2日': '￥1,234.56元', '2026年12月2日': '(100.005)',
    '2027年1月2日': '待确认', '2027年2月2日': 0.000001, '是否已申请': '未申请',
  }});
  assert.equal(detail.installmentCount, 3);
  assert.equal(detail.installmentCountSource, 'declared');
  assert.deepEqual(detail.installments.map(item => item.amountCents), [123456, -10001, null, 0]);
  assert.equal(detail.applicationStatus, '未申请');
});

test('供应商汇总使用整数分并拒绝超过安全范围', () => {
  assert.equal(groupSuppliers([{ supplier: '甲', plans: [plan(null, 1)] }, { supplier: '甲', plans: [plan(null, 2)] }])[0].amountCents, 3);
  assert.throws(() => groupSuppliers([{ supplier: '甲', plans: [plan(null, Number.MAX_SAFE_INTEGER)] }, { supplier: '甲', plans: [plan(null, 1)] }]), /安全计算范围/);
});

test('详情优先使用解析后的当前节点，保留专属备注与原申请日期', () => {
  const detail = supplierRecordDetails({ currentNode: '财务付款', notes: '合并备注不应替代孙立柱备注',
    raw: { '当前节点': '旧节点', '贾总反馈备注': '按对账单付款\n保留原文', '孙立柱备注': '请确认账期', '2026年11月16日': 0 } });
  assert.equal(detail.currentNode, '财务付款');
  assert.equal(detail.jiaRemark, '按对账单付款\n保留原文');
  assert.equal(supplierRecordDetails({ raw: { '贾总备注': '另一个表头' } }).jiaRemark, '另一个表头');
  assert.equal(supplierRecordDetails({ notes: '合并备注', raw: { '贾总反馈备注': '' } }).jiaRemark, '');
  assert.equal(detail.remark, '请确认账期');
  assert.deepEqual(detail.installments, [{ date: '2026-11-16', amountCents: 0 }]);
  assert.equal(supplierRecordDetails({ currentNode: '', raw: { '当前节点': '办理中' } }).currentNode, '办理中');
  assert.equal(supplierRecordDetails({ notes: '其他备注' }).remark, '');
});
