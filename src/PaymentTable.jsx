import { useEffect, useRef, useState } from 'react';
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

export default function PaymentTable({ table, records = [], pending = false }) {
  const [expanded, setExpanded] = useState(new Set());
  const [selection, setSelection] = useState(null);
  const [columnsPerTable, setColumnsPerTable] = useState(4);
  const panelRef = useRef(null);
  useEffect(() => { setSelection(null); }, [records]);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      setColumnsPerTable(Math.max(1, Math.floor((width - (width < 500 ? 126 : 180)) / 205)));
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
  return <section ref={panelRef} className="panel payment-panel" aria-label={title}>
    <div className="section-heading"><div><h2>{title}</h2><p>{pending ? '未明确计划月份的记录单独汇总，不受月份范围筛选影响。' : '仅汇总明确计划月份的记录，点击金额查看付款依据。'}</p></div>
      {hasRecords && <button aria-label={`${title} ${expanded.size ? '全部收起' : '全部展开'}`} onClick={() => setExpanded(expanded.size ? new Set() : new Set(parents))}>{expanded.size ? '全部收起' : '全部展开'}</button>}
    </div>
    {!hasRecords ? <Empty title={pending ? '暂无时间待定记录' : '当前区间暂无计划'}>{pending ? '当前筛选条件下，没有未明确计划月份的记录。' : '可调整月份筛选，或在文件管理中上传数据。'}</Empty> : <div className="payment-table-groups">
      {groups.length > 1 && <p className="payment-split-note">月份依次向下排列，各月份和期间合计只展示一次。</p>}
      {groups.map((group, groupIndex) => <div className="table-wrap payment-table-wrap" key={group[0]}>
      <table className="payment-table" aria-label={`${pending ? '时间待定付款父子汇总表' : '月度付款父子汇总表'}${groups.length > 1 ? `（第${groupIndex + 1}组）` : ''}`}>
        <thead>
          <tr><th className="payment-category" scope="col">分类</th>{group.map(month => <th className={`payment-month-group ${month === 'period' ? 'payment-period' : ''}`} scope="col" key={month}>{monthLabel(month)}</th>)}</tr>
        </thead>
        <tbody>{visibleRows.map(row => <tr key={row.id} data-row-id={row.id} className={`${row.parentId ? 'payment-child' : 'payment-parent'} ${row.id === 'total' ? 'payment-grand-total' : ''}`}>
          <th className="payment-category" scope="row" style={{ paddingLeft: `${12 + row.depth * 16}px` }}>
            {parents.has(row.id) ? <button className="payment-toggle" aria-expanded={expanded.has(row.id)} aria-label={`${expanded.has(row.id) ? '收起' : '展开'}${row.label}`} onClick={() => toggle(row.id)}><span aria-hidden="true">{expanded.has(row.id) ? '▾' : '▸'}</span><span>{row.label}</span></button> : <span className="payment-leaf">{row.label}</span>}
            {row.available && row.missingSources?.length > 0 && <small className="payment-partial" title={`尚未上传：${row.missingSources.join('、')}`}>已上传部分</small>}
          </th>
          {group.map(month => {
            const cell = month === 'period' ? row.period : row.cells[month];
            return <td className={`payment-month-cell ${month === 'period' ? 'payment-period' : ''}`} key={month}>
              {measures.map(([key, label]) => <div className={`payment-measure payment-${key}`} key={key}>
              <span className="payment-measure-label">{key === 'totalCents' && month !== 'period' && month !== 'pending' ? '本月合计' : label}</span>
              {!row.available ? <span className="payment-unavailable">未上传</span> : <button className="payment-amount" aria-label={`${row.label} ${monthLabel(month)} ${label} 查看明细`} onClick={() => setSelection({ categories: row.categories, month, measure: key, title: `${row.label} · ${monthLabel(month)} · ${label}` })}>
                {cell?.[key] == null ? <><span>待核对</span><small>{cell?.uncertainCount || 0} 笔计划</small></> : <><span>{money(cell[key])} 元</span><small>{moneyInWan(cell[key])} 万元</small></>}
              </button>}
              </div>)}
            </td>;
          })}
        </tr>)}</tbody>
      </table>
      </div>)}
    </div>}
    {selection && <Modal title={selection.title} onClose={() => setSelection(null)} wide><RecordsTable records={detailRecords(records, selection)} label="汇总金额对应明细" fitWidth /></Modal>}
  </section>;
}
