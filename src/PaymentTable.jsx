import { useEffect, useMemo, useRef, useState } from 'react';
import { money, moneyInWan, monthText } from './format.js';
import { Empty, Modal } from './components.jsx';
import PaymentDetails from './PaymentDetails.jsx';

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

export default function PaymentTable({ table, records = [], pending = false }) {
  const [expanded, setExpanded] = useState(new Set());
  const [selection, setSelection] = useState(null);
  const selectedRecords = useMemo(() => detailRecords(records, selection), [records, selection]);
  const [columnsPerTable, setColumnsPerTable] = useState(4);
  const panelRef = useRef(null);
  useEffect(() => { setSelection(null); }, [records]);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      setColumnsPerTable(Math.max(1, Math.floor((width - (width < 500 ? 142 : 204)) / 185)));
    });
    observer.observe(panelRef.current);
    return () => observer.disconnect();
  }, []);
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
  const title = pending ? '时间待定付款汇总' : '月度付款汇总';
  const hasRecords = table?.hasRecords ?? months.length > 0;
  const columns = pending ? months : [...months, 'period'];
  const groups = Array.from({ length: Math.ceil(columns.length / columnsPerTable) }, (_, index) => columns.slice(index * columnsPerTable, (index + 1) * columnsPerTable));
  const monthLabel = month => month === 'period' ? '所选期间合计' : monthText(month);
  function toggle(id) {
    setExpanded(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  const content = <>
    <div className="section-heading"><div>{!pending && <h2>{title}</h2>}<p>{pending ? '不受月份筛选影响。' : '点击金额查看明细'}</p></div>
      {hasRecords && <button aria-label={`${title} ${expanded.size ? '全部收起' : '全部展开'}`} onClick={() => setExpanded(expanded.size ? new Set() : new Set(parents))}>{expanded.size ? '全部收起' : '全部展开'}</button>}
    </div>
    {!hasRecords ? <Empty title={pending ? '暂无时间待定记录' : '当前区间暂无计划'}>{pending ? '当前筛选条件下，没有未明确计划月份的记录。' : '可调整月份筛选，或在文件管理中上传数据。'}</Empty> : <div className="payment-table-groups">
      {groups.map((group, groupIndex) => <div className="table-wrap payment-table-wrap" key={group[0]}>
      <table className="payment-table" aria-label={`${pending ? '时间待定付款父子汇总表' : '月度付款父子汇总表'}${groups.length > 1 ? `（第${groupIndex + 1}组）` : ''}`}>
        <thead>
          <tr><th className="payment-category" scope="col">分类</th><th className="payment-measure-heading" scope="col">金额</th>{group.map(month => <th className={`payment-month-group ${month === 'period' ? 'payment-period' : ''}`} scope="col" key={month}>{monthLabel(month)}</th>)}</tr>
        </thead>
        {visibleRows.map(row => <tbody key={row.id} data-row-id={row.id} className={`${row.parentId ? 'payment-child' : 'payment-parent'} payment-family-${row.parentId || row.id} ${row.id === 'total' ? 'payment-grand-total' : ''}`}>
          {measures.map(([key, label], measureIndex) => <tr key={key} className={`payment-measure-row payment-${key}`}>
          {measureIndex === 0 && <th className="payment-category" scope="rowgroup" rowSpan={3} style={{ paddingLeft: `${10 + row.depth * 13}px` }}>
            {parents.has(row.id) ? <button className="payment-toggle" aria-expanded={expanded.has(row.id)} aria-label={`${expanded.has(row.id) ? '收起' : '展开'}${row.label}`} onClick={() => toggle(row.id)}><span aria-hidden="true">{expanded.has(row.id) ? '▾' : '▸'}</span><span>{row.label}</span></button> : <span className="payment-leaf">{row.label}</span>}
            {row.available && row.missingSources?.length > 0 && <small className="payment-partial" title={`尚未上传：${row.missingSources.join('、')}`}>已上传部分</small>}
          </th>}
          <th className="payment-measure-label" scope="row">{label}</th>
          {group.map(month => {
            const cell = month === 'period' ? row.period : row.cells[month];
            return <td className={`payment-month-cell ${month === 'period' ? 'payment-period' : ''}`} key={month}>
              {!row.available ? <span className="payment-unavailable">未上传</span> : <button className="payment-amount" aria-label={`${row.label} ${monthLabel(month)} ${label} 查看明细`} onClick={() => setSelection({ categories: row.categories, month, measure: key, title: `${row.label} · ${monthLabel(month)} · ${label}` })}>
                {cell?.[key] == null ? <><span>待核对</span><small>{cell?.uncertainCount || 0} 笔计划</small></> : <><span>{money(cell[key])} 元</span><small>{moneyInWan(cell[key])} 万元</small></>}
              </button>}
            </td>;
          })}
          </tr>)}
        </tbody>)}
      </table>
      </div>)}
    </div>}
    {selection && <Modal title={selection.title} onClose={() => setSelection(null)} wide><PaymentDetails records={selectedRecords} measure={selection.measure} /></Modal>}
  </>;
  return <section ref={panelRef} className="panel payment-panel" aria-label={title}>
    {pending ? <details className="section-collapse" onToggle={event => { if (!event.currentTarget.open) setExpanded(new Set()); }}><summary><h2>{title}</h2></summary>{content}</details> : content}
  </section>;
}
