import { Fragment, useEffect, useId, useState } from 'react';
import { CATEGORIES } from '../shared/constants.js';
import { Empty, Pager } from './components.jsx';
import { money, moneyInWan, monthText, planAmount } from './format.js';
import { supplierRecordDetails } from './supplier-data.js';

function Amount({ cents }) {
  return <span className="supplier-amount">{money(cents)} 元<small>{moneyInWan(cents)} 万元</small></span>;
}
const display = value => value == null || value === '' ? '未提供' : String(value).replace(/(\d{4}-\d{2}-\d{2})T00:00:00(?:\.000)?Z/g, '$1');

function recordFields(record) {
  const detail = supplierRecordDetails(record);
  const batchLines = field => detail.installments.length ? detail.installments.map((item, index) => <span className="batch-line" key={index}>第 {index + 1} 笔：{field === 'date' ? display(item.date) : `${money(item.amountCents)} 元`}</span>) : '未提供';
  return [
    ['供应商', <>{display(record.supplier)}<small className="cell-secondary">{record.sourceSheet} · 第 {record.sourceRow} 行</small></>],
    ['付款主体', display(record.payer)], ['数据类别', CATEGORIES[record.category] || '未提供'], ['跟单员', display(record.owner)],
    ['摘要', <>{display(record.summary)}{record.flowCode && <small className="cell-secondary">流程号：{record.flowCode}</small>}</>],
    ['总金额', <Amount cents={planAmount(record)} />], ['谈判明细', display(detail.negotiation)], ['是否分批', display(detail.installmentFlag)],
    ['分几批', detail.installmentCount == null ? '未提供' : detail.installmentCountSource === 'declared' ? `${detail.installmentCount} 批` : `已登记 ${detail.installmentCount} 笔`],
    ['申请时间', batchLines('date')], ['每批付多少钱', batchLines('amountCents')],
    ['是否申请', display(detail.applicationStatus)], ['当前节点', display(detail.currentNode)],
    ['是否支付', <>{detail.paymentStatus}<small className="cell-secondary">已付：{detail.paidCents == null ? '待核对' : `${money(detail.paidCents)} 元`}</small><small className="cell-secondary">未付：{detail.unpaidCents == null ? '待核对' : `${money(detail.unpaidCents)} 元`}</small></>],
    ['孙立柱备注', display(detail.remark)],
  ];
}

function SupplierDetails({ group }) {
  const rows = group.records.map(recordFields);
  return <div className="supplier-detail-content">
    <p className="supplier-detail-note">共 {rows.length} 笔 · 金额按筛选统计，分批安排按原表展示（含零金额）。</p>
    <table className="supplier-detail-wide" aria-label={`${group.supplier || '未填写供应商'}付款明细`}>
      <thead><tr>{rows[0].map(([label]) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
      <tbody>{rows.map((fields, index) => <tr key={index}>{fields.map(([label, value]) => <td className={label === '总金额' ? 'numeric' : undefined} key={label}>{value}</td>)}</tr>)}</tbody>
    </table>
    <div className="supplier-detail-narrow">{rows.map((fields, index) => <table key={index} aria-label={`${group.supplier || '未填写供应商'}第${index + 1}笔付款明细`}>
      <caption>第 {index + 1} 笔付款明细</caption>
      <tbody>{fields.map(([label, value]) => <tr key={label}><th scope="row">{label}</th><td>{value}</td></tr>)}</tbody>
    </table>)}</div>
  </div>;
}

export default function SupplierTable({ groups = [] }) {
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState(new Set());
  const id = useId();
  useEffect(() => { setPage(1); setExpanded(new Set()); }, [groups]);
  if (!groups.length) return <Empty title="没有符合条件的供应商">可调整筛选条件，或在文件管理中上传数据。</Empty>;
  function toggle(supplier) {
    setExpanded(previous => {
      const next = new Set(previous);
      if (next.has(supplier)) next.delete(supplier); else next.add(supplier);
      return next;
    });
  }
  return <div className="supplier-tables">
    <div className="table-wrap supplier-table-wrap"><table className="supplier-summary-table" aria-label="供应商明细">
      <colgroup><col className="supplier-col-name" /><col className="supplier-col-category" /><col className="supplier-col-amount" /><col className="supplier-col-month" /><col className="supplier-col-action" /></colgroup>
      <thead><tr><th scope="col">供应商</th><th scope="col">分类</th><th scope="col" className="numeric">总金额</th><th scope="col">月份</th><th scope="col">查看详情</th></tr></thead>
      <tbody>{groups.slice((page - 1) * 20, page * 20).map((group, index) => {
        const open = expanded.has(group.supplier);
        const detailId = `${id}-supplier-${page}-${index}`;
        return <Fragment key={group.supplier}>
          <tr className={open ? 'supplier-expanded' : undefined}>
            <th scope="row">{group.supplier || '未填写供应商'}</th>
            <td>{group.categories.map(category => <span className={`tag category-${category}`} key={category}>{CATEGORIES[category] || category}</span>)}</td>
            <td className="numeric"><Amount cents={group.amountCents} /></td>
            <td>{group.months.map(month => <span className="supplier-month" key={month || 'pending'}>{monthText(month)}</span>)}</td>
            <td><button className="text-button" aria-expanded={open} aria-controls={detailId} aria-label={`${open ? '收起' : '查看'}${group.supplier || '未填写供应商'}详情`} onClick={() => toggle(group.supplier)}>{open ? '收起详情' : '查看详情'}</button></td>
          </tr>
          {open && <tr className="supplier-expanded-detail" id={detailId}><td colSpan={5}><SupplierDetails group={group} /></td></tr>}
        </Fragment>;
      })}</tbody>
    </table></div>
    <Pager page={page} total={groups.length} onChange={setPage} />
  </div>;
}
