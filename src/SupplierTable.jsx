import { Fragment, useEffect, useId, useState } from 'react';
import { CATEGORIES } from '../shared/constants.js';
import { Empty, Pager } from './components.jsx';
import { moneyInWan, monthText, planAmount } from './format.js';
import { supplierRecordDetails } from './supplier-data.js';
import './supplier-table.css';

function Amount({ cents }) {
  return <span className={`supplier-amount${cents == null ? ' supplier-uncertain' : ''}`}>{moneyInWan(cents)}</span>;
}
const display = value => value == null || value === '' ? '—' : String(value).replace(/(\d{4}-\d{2}-\d{2})T00:00:00(?:\.000)?Z/g, '$1');

function recordFields(record) {
  const detail = supplierRecordDetails(record);
  const batchLines = field => detail.installments.length ? detail.installments.map((item, index) => <span className="batch-line" key={index}>第 {index + 1} 笔：{field === 'date' ? display(item.date) : moneyInWan(item.amountCents)}</span>) : '—';
  return [
    ['供应商', <>{display(record.supplier)}<small className="cell-secondary">{record.sourceSheet} · 第 {record.sourceRow} 行</small>{record.filename && <small className="cell-secondary">{record.filename}</small>}</>],
    ['付款主体', display(record.payer)], ['数据类别', CATEGORIES[record.category] || '—'], ['跟单员', display(record.owner)],
    ['摘要', <>{display(record.summary)}{record.flowCode && <small className="cell-secondary">OA：{record.flowCode}</small>}</>],
    ['期间金额', <Amount cents={planAmount(record)} />], ['已付', <Amount cents={detail.paidCents} />], ['未付', <Amount cents={detail.unpaidCents} />],
    ['谈判明细', display(detail.negotiation)], ['是否分批', display(detail.installmentFlag)],
    ['分几批', detail.installmentCount == null ? '—' : detail.installmentCountSource === 'declared' ? `${detail.installmentCount} 批` : `已登记 ${detail.installmentCount} 笔`],
    ['申请时间', batchLines('date')], ['每批付多少钱', batchLines('amountCents')],
    ['是否申请', display(detail.applicationStatus)],
    ['当前节点', <>{display(detail.currentNode)}{record.status && <small className="cell-secondary">流程状态：{record.status}</small>}</>],
    ['是否支付', <span className={`tag ${detail.paymentStatus === '已支付' ? 'success' : 'neutral'}`}>{detail.paymentStatus}</span>],
    ['贾总备注', display(detail.jiaRemark)], ['孙立柱备注', display(detail.remark)],
  ];
}

function SupplierDetails({ group }) {
  const [page, setPage] = useState(1);
  const rows = group.records.slice((page - 1) * 20, page * 20).map(recordFields);
  return <div className="supplier-detail-content">
    <p className="supplier-detail-note">共 {group.records.length} 笔 · 单位：万元 · 分批安排按原表展示</p>
    <div className="supplier-detail-scroll" tabIndex={0} role="region" aria-label="供应商付款明细，可横向滚动">
      <table className="supplier-detail-table" aria-label={`${group.supplier || '未填写供应商'}付款明细`}>
        <thead><tr>{rows[0].map(([label]) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>{rows.map((fields, index) => <tr key={index}>{fields.map(([label, value]) => <td key={label}>{value}</td>)}</tr>)}</tbody>
      </table>
    </div>
    <Pager page={page} total={group.records.length} onChange={setPage} />
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
    <p className="supplier-detail-note">单位：万元</p>
    <div className="supplier-table-wrap" tabIndex={0} role="region" aria-label="供应商汇总，可横向滚动"><table className="supplier-summary-table" aria-label="供应商明细">
      <colgroup><col className="supplier-col-name" /><col className="supplier-col-category" /><col /><col /><col /><col className="supplier-col-month" /><col className="supplier-col-action" /></colgroup>
      <thead><tr><th scope="col">供应商</th><th scope="col">分类</th><th scope="col">期间金额</th><th scope="col">已付</th><th scope="col">未付</th><th scope="col">月份</th><th scope="col">详情</th></tr></thead>
      <tbody>{groups.slice((page - 1) * 20, page * 20).map((group, index) => {
        const open = expanded.has(group.supplier);
        const detailId = `${id}-supplier-${page}-${index}`;
        return <Fragment key={group.supplier}>
          <tr className={open ? 'supplier-expanded' : undefined}>
            <th scope="row">{group.supplier || '未填写供应商'}</th>
            <td>{group.categories.map(category => <span className={`tag category-${category}`} key={category}>{CATEGORIES[category] || category}</span>)}</td>
            <td><Amount cents={group.amountCents} /></td><td><Amount cents={group.paidCents} /></td><td><Amount cents={group.unpaidCents} /></td>
            <td>{group.months.map(month => <span className="supplier-month" key={month || 'pending'}>{monthText(month)}</span>)}</td>
            <td><button className="text-button" aria-expanded={open} aria-controls={detailId} aria-label={`${open ? '收起' : '查看'}${group.supplier || '未填写供应商'}详情`} onClick={() => toggle(group.supplier)}>{open ? '收起' : '查看详情'}</button></td>
          </tr>
          {open && <tr className="supplier-expanded-detail" id={detailId}><td colSpan={7}><SupplierDetails group={group} /></td></tr>}
        </Fragment>;
      })}</tbody>
    </table></div>
    <Pager page={page} total={groups.length} onChange={value => { setPage(value); setExpanded(new Set()); }} />
  </div>;
}
