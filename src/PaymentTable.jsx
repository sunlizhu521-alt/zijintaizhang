import { useEffect, useState } from 'react';
import { money, moneyInWan, monthText } from './format.js';
import { Empty, Modal, RecordsTable } from './components.jsx';

const measures = [['paidCents', '已付'], ['unpaidCents', '未付'], ['totalCents', '合计']];

function detailRecords(records, selection) {
  if (!selection) return [];
  return records.filter(record => selection.categories.includes(record.category)).flatMap(record => {
    const plans = (record.selectedPlans || record.plans).filter(plan =>
      (selection.month === 'period' ? plan.month !== null : (plan.month || 'pending') === selection.month) &&
      (selection.measure === 'totalCents' || plan[selection.measure] == null || plan[selection.measure] !== 0));
    return plans.length ? [{ ...record, selectedPlans: plans, selectedPlanCents: plans.reduce((sum, plan) => sum + plan.amountCents, 0) }] : [];
  });
}

export default function PaymentTable({ table, records = [] }) {
  const [expanded, setExpanded] = useState(new Set());
  const [selection, setSelection] = useState(null);
  useEffect(() => { setSelection(null); }, [records]);
  const rows = table?.rows || [];
  const months = table?.months || [];
  const parents = new Set(rows.map(row => row.parentId).filter(Boolean));
  const byId = new Map(rows.map(row => [row.id, row]));
  const visibleRows = rows.filter(row => {
    let parent = row.parentId;
    while (parent) {
      if (!expanded.has(parent)) return false;
      parent = byId.get(parent)?.parentId;
    }
    return true;
  });
  const columns = [...months, 'period'];
  const monthLabel = month => month === 'period' ? '所选期间合计' : monthText(month);
  function toggle(id) {
    setExpanded(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  return <section className="panel payment-panel">
    <div className="section-heading"><div><h2>月度付款汇总</h2><p>展开分类查看明细，点击金额查看付款依据。时间待定单列，不计入期间合计。</p></div>
      {months.length > 0 && <button onClick={() => setExpanded(expanded.size ? new Set() : new Set(parents))}>{expanded.size ? '全部收起' : '全部展开'}</button>}
    </div>
    {!months.length ? <Empty title="当前区间暂无计划">可调整月份筛选，或在文件管理中上传数据。</Empty> : <div className="table-wrap payment-table-wrap" tabIndex={0} role="region" aria-label="可横向滚动的月度付款汇总">
      <table className="payment-table" aria-label="月度付款父子汇总表">
        <thead>
          <tr><th className="payment-category" rowSpan={2} scope="col">分类</th>{columns.map(month => <th className={`payment-month-group ${month === 'period' ? 'payment-period' : ''}`} colSpan={3} scope="colgroup" key={month}>{monthLabel(month)}</th>)}</tr>
          <tr>{columns.flatMap(month => measures.map(([key, label]) => <th className={`numeric payment-${key} ${key === 'paidCents' ? 'payment-group-start' : ''} ${month === 'period' ? 'payment-period' : ''}`} scope="col" key={`${month}-${key}`}>{key === 'totalCents' && month !== 'period' && month !== 'pending' ? '本月合计' : label}</th>))}</tr>
        </thead>
        <tbody>{visibleRows.map(row => <tr key={row.id} data-row-id={row.id} className={`${row.parentId ? 'payment-child' : 'payment-parent'} ${row.id === 'total' ? 'payment-grand-total' : ''}`}>
          <th className="payment-category" scope="row" style={{ paddingLeft: `${12 + row.depth * 16}px` }}>
            {parents.has(row.id) ? <button className="payment-toggle" aria-expanded={expanded.has(row.id)} aria-label={`${expanded.has(row.id) ? '收起' : '展开'}${row.label}`} onClick={() => toggle(row.id)}><span aria-hidden="true">{expanded.has(row.id) ? '▾' : '▸'}</span><span>{row.label}</span></button> : <span className="payment-leaf">{row.label}</span>}
            {row.available && row.missingSources?.length > 0 && <small className="payment-partial" title={`尚未上传：${row.missingSources.join('、')}`}>已上传部分</small>}
          </th>
          {columns.flatMap(month => {
            const cell = month === 'period' ? row.period : row.cells[month];
            return measures.map(([key, label]) => <td className={`numeric payment-${key} ${key === 'paidCents' ? 'payment-group-start' : ''} ${month === 'period' ? 'payment-period' : ''}`} key={`${month}-${key}`}>
              {!row.available ? <span className="payment-unavailable">未上传</span> : <button className="payment-amount" aria-label={`${row.label} ${monthLabel(month)} ${label} 查看明细`} onClick={() => setSelection({ categories: row.categories, month, measure: key, title: `${row.label} · ${monthLabel(month)} · ${label}` })}>
                {cell?.[key] == null ? <><span>待核对</span><small>{cell?.uncertainCount || 0} 笔计划</small></> : <><span>{money(cell[key])} 元</span><small>{moneyInWan(cell[key])} 万元</small></>}
              </button>}
            </td>);
          })}
        </tr>)}</tbody>
      </table>
    </div>}
    {selection && <Modal title={selection.title} onClose={() => setSelection(null)} wide><RecordsTable records={detailRecords(records, selection)} label="汇总金额对应明细" /></Modal>}
  </section>;
}
