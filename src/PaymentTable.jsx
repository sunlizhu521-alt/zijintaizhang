import { useEffect, useMemo, useState } from 'react';
import { moneyInWan, monthText } from './format.js';
import { Empty, Modal } from './components.jsx';
import PaymentDetails from './PaymentDetails.jsx';
import DashboardDownload from './DashboardDownload.jsx';
import { detailRecords } from '../shared/payment-detail-selection.js';
import './payment-table.css';

const measures = [['totalCents', '总金额'], ['paidCents', '已支付金额'], ['unpaidCents', '未支付金额'], ['unappliedUnpaidCents', '未提交申请单金额']];

export default function PaymentTable({ table, records = [], pending = false }) {
  const [expandedGroups, setExpandedGroups] = useState([]);
  const [selection, setSelection] = useState(null);
  const selectedRecords = useMemo(() => detailRecords(records, selection), [records, selection]);
  useEffect(() => { setSelection(null); }, [records]);
  const rows = table?.rows || [];
  const months = table?.months || [];
  const parents = rows.filter(row => !row.parentId && row.id !== 'total');
  const expanded = parents.some(row => expandedGroups.includes(row.id));
  const allExpanded = parents.length > 0 && parents.every(row => expandedGroups.includes(row.id));
  const total = rows.find(row => row.id === 'total');
  const title = pending ? '时间待定付款汇总' : '月度付款汇总';
  const hasRecords = table?.hasRecords ?? months.length > 0;
  const columns = pending ? months : [...months, 'period'];
  const monthLabel = month => month === 'period' ? '合计' : monthText(month);
  const downloadSelection = selection && { exportView: 'drilldown', table: pending ? 'pending' : 'monthly', rowId: selection.rowId, detailMonth: selection.month, measure: selection.measure, supplierSearch: selection.supplierSearch || '' };

  function categoryLabel(row) {
    const expandable = parents.some(parent => parent.id === row.id);
    const open = expandedGroups.includes(row.id);
    return <>{expandable ? <button className="ps-category-toggle" aria-expanded={open} aria-label={`${open ? '收起' : '展开'}${row.label}汇总`} onClick={() => setExpandedGroups(ids => open ? ids.filter(id => id !== row.id) : [...ids, row.id])}><span aria-hidden="true">{open ? '▾' : '▸'}</span> {row.label}</button> : row.label}{row.available && row.missingSources?.length > 0 && <small className="ps-partial" title={`尚未上传：${row.missingSources.join('、')}`}>部分上传</small>}</>;
  }
  function amountCells(row) {
    return columns.flatMap(month => measures.map(([key, label], index) => {
      const cell = month === 'period' ? row.period : row.cells[month];
      return <td key={`${month}-${key}`} className={`ps-${key}${index === 0 ? ' ps-month-start' : ''}${month === 'period' ? ' ps-period' : ''}`}>
        {!row.available ? <span className="ps-unavailable">未上传</span> : <button className="ps-amount" aria-label={`${row.label} ${monthLabel(month)} ${label} 查看明细`} title={cell?.[key] == null ? `${label}待核对，点击查看对应记录` : undefined} onClick={() => setSelection({ rowId: row.id, categories: row.categories, month, measure: key, title: `${row.label} · ${monthLabel(month)} · ${label}` })}>
          {cell?.[key] == null ? '待核对' : moneyInWan(cell[key])}
        </button>}
      </td>;
    }));
  }

  return <section className="panel payment-panel" aria-label={title}>
    <div className="section-heading"><div><h2>{title}</h2><p>单位：万元 · 点击金额查看明细</p></div>
      <div className="download-actions"><DashboardDownload options={{ exportView: pending ? 'pending' : 'monthly' }} />{hasRecords && <button className="text-button" aria-expanded={allExpanded} aria-label={allExpanded ? '收起付款分类' : '展开付款分类'} onClick={() => setExpandedGroups(allExpanded ? [] : parents.map(row => row.id))}>{allExpanded ? '收起' : '查看'}</button>}</div>
    </div>
    {!hasRecords ? <Empty title={pending ? '暂无时间待定记录' : '当前区间暂无计划'} /> : <div className="payment-summary-scroll" tabIndex={0} role="region" aria-label={`${title}表格，可横向滚动`}>
      <table className={`payment-summary-table${expanded ? ' ps-expanded' : ''}`} style={{ minWidth: `${(expanded ? 302 : 164) + columns.length * measures.length * 96}px` }} aria-label={pending ? '时间待定付款父子汇总表' : '月度付款父子汇总表'}>
        <colgroup><col style={{ width: expanded ? '118px' : '164px' }} />{expanded && <col style={{ width: '184px' }} />}{columns.flatMap(month => measures.map(([key]) => <col key={`${month}-${key}`} />))}</colgroup>
        <thead><tr><th rowSpan={2} colSpan={expanded ? 2 : 1} className="ps-category ps-category-heading" scope="col">分类</th>{columns.map(month => <th colSpan={measures.length} scope="colgroup" className={`ps-month-start${month === 'period' ? ' ps-period' : ''}`} key={month}>{monthLabel(month)}</th>)}</tr>
          <tr>{columns.flatMap(month => measures.map(([key, label], index) => <th key={`${month}-${key}`} scope="col" title={key === 'unappliedUnpaidCents' ? '未支付金额中，尚未确认提交申请单的部分' : undefined} className={`ps-${key}${index === 0 ? ' ps-month-start' : ''}${month === 'period' ? ' ps-period' : ''}`}>{label}</th>))}</tr>
        </thead>
        {parents.map(parent => {
          const children = expandedGroups.includes(parent.id) ? rows.filter(row => row.parentId === parent.id) : [];
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
    {selection && <Modal title={selection.title} onClose={() => setSelection(null)} wide actions={<DashboardDownload options={downloadSelection} />}>
      <div className="pd-supplier-search"><label>供应商搜索<input type="search" placeholder="输入供应商名称" maxLength={500} value={selection.supplierSearch || ''} onChange={event => setSelection(current => ({ ...current, supplierSearch: event.target.value }))} /></label>{selection.supplierSearch && <button className="text-button" onClick={() => setSelection(current => ({ ...current, supplierSearch: '' }))}>清除搜索</button>}</div>
      <PaymentDetails records={selectedRecords} measure={selection.measure} downloadSelection={downloadSelection} />
    </Modal>}
  </section>;
}
