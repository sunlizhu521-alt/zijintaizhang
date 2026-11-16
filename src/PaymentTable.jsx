import { useEffect, useMemo, useState } from 'react';
import { moneyInWan, monthText } from './format.js';
import { Empty, Modal } from './components.jsx';
import PaymentDetails from './PaymentDetails.jsx';
import './payment-table.css';

const measures = [['totalCents', '总金额'], ['paidCents', '已支付金额'], ['unpaidCents', '未支付金额'], ['unappliedUnpaidCents', '未提交申请单金额']];

function detailRecords(records, selection) {
  if (!selection) return [];
  return records.filter(record => selection.categories.includes(record.category)).flatMap(record => {
    if (selection.measure === 'unappliedUnpaidCents' && record.applicationState === 'applied') return [];
    const plans = (record.selectedPlans || record.plans || []).filter(plan =>
      (selection.month === 'period' ? Boolean(plan.month) : (plan.month || 'pending') === selection.month) &&
      (selection.measure === 'totalCents' || plan.amountCents === 0 || plan[selection.measure] == null || plan[selection.measure] !== 0));
    return plans.length ? [{ ...record, selectedPlans: plans, selectedPlanCents: plans.reduce((sum, plan) => sum + plan.amountCents, 0) }] : [];
  });
}

export default function PaymentTable({ table, records = [], pending = false }) {
  const [expanded, setExpanded] = useState(false);
  const [selection, setSelection] = useState(null);
  const selectedRecords = useMemo(() => detailRecords(records, selection), [records, selection]);
  useEffect(() => { setSelection(null); }, [records]);
  const rows = table?.rows || [];
  const months = table?.months || [];
  const parents = rows.filter(row => !row.parentId && row.id !== 'total');
  const total = rows.find(row => row.id === 'total');
  const title = pending ? '时间待定付款汇总' : '月度付款汇总';
  const hasRecords = table?.hasRecords ?? months.length > 0;
  const columns = pending ? months : [...months, 'period'];
  const monthLabel = month => month === 'period' ? '合计' : monthText(month);

  function categoryLabel(row) {
    return <>{row.label}{row.available && row.missingSources?.length > 0 && <small className="ps-partial" title={`尚未上传：${row.missingSources.join('、')}`}>部分上传</small>}</>;
  }
  function amountCells(row) {
    return columns.flatMap(month => measures.map(([key, label], index) => {
      const cell = month === 'period' ? row.period : row.cells[month];
      return <td key={`${month}-${key}`} className={`ps-${key}${index === 0 ? ' ps-month-start' : ''}${month === 'period' ? ' ps-period' : ''}`}>
        {!row.available ? <span className="ps-unavailable">未上传</span> : <button className="ps-amount" aria-label={`${row.label} ${monthLabel(month)} ${label} 查看明细`} title={cell?.[key] == null ? `${label}待核对，点击查看对应记录` : undefined} onClick={() => setSelection({ categories: row.categories, month, measure: key, title: `${row.label} · ${monthLabel(month)} · ${label}` })}>
          {cell?.[key] == null ? '待核对' : moneyInWan(cell[key])}
        </button>}
      </td>;
    }));
  }

  return <section className="panel payment-panel" aria-label={title}>
    <div className="section-heading"><div><h2>{title}</h2><p>单位：万元 · 点击金额查看明细</p></div>
      {hasRecords && <button className="text-button" aria-expanded={expanded} aria-label={expanded ? '收起付款分类' : '展开付款分类'} onClick={() => setExpanded(value => !value)}>{expanded ? '收起' : '查看'}</button>}
    </div>
    {!hasRecords ? <Empty title={pending ? '暂无时间待定记录' : '当前区间暂无计划'} /> : <div className="payment-summary-scroll" tabIndex={0} role="region" aria-label={`${title}表格，可横向滚动`}>
      <table className={`payment-summary-table${expanded ? ' ps-expanded' : ''}`} style={{ minWidth: `${(expanded ? 302 : 164) + columns.length * measures.length * 96}px` }} aria-label={pending ? '时间待定付款父子汇总表' : '月度付款父子汇总表'}>
        <colgroup><col style={{ width: expanded ? '118px' : '164px' }} />{expanded && <col style={{ width: '184px' }} />}{columns.flatMap(month => measures.map(([key]) => <col key={`${month}-${key}`} />))}</colgroup>
        <thead><tr><th rowSpan={2} colSpan={expanded ? 2 : 1} className="ps-category ps-category-heading" scope="col">分类</th>{columns.map(month => <th colSpan={measures.length} scope="colgroup" className={`ps-month-start${month === 'period' ? ' ps-period' : ''}`} key={month}>{monthLabel(month)}</th>)}</tr>
          <tr>{columns.flatMap(month => measures.map(([key, label], index) => <th key={`${month}-${key}`} scope="col" title={key === 'unappliedUnpaidCents' ? '未支付金额中，尚未确认提交申请单的部分' : undefined} className={`ps-${key}${index === 0 ? ' ps-month-start' : ''}${month === 'period' ? ' ps-period' : ''}`}>{label}</th>))}</tr>
        </thead>
        {parents.map(parent => {
          const children = expanded ? rows.filter(row => row.parentId === parent.id) : [];
          return <tbody key={parent.id} className={`ps-family-${parent.id}`}>
            {children.length ? children.map((row, index) => <tr key={row.id} data-row-id={row.id}>
              {index === 0 && <th className="ps-category ps-parent-category" scope="rowgroup" rowSpan={children.length}>{categoryLabel(parent)}</th>}
              <th scope="row" className="ps-child-category">{categoryLabel(row)}</th>{amountCells(row)}
            </tr>) : <tr data-row-id={parent.id}><th scope="row" colSpan={expanded ? 2 : 1} className="ps-category">{categoryLabel(parent)}</th>{amountCells(parent)}</tr>}
          </tbody>;
        })}
        {total && <tfoot><tr data-row-id="total"><th scope="row" colSpan={expanded ? 2 : 1} className="ps-category">{categoryLabel(total)}</th>{amountCells(total)}</tr></tfoot>}
      </table>
    </div>}
    {selection && <Modal title={selection.title} onClose={() => setSelection(null)} wide><PaymentDetails records={selectedRecords} measure={selection.measure} /></Modal>}
  </section>;
}
