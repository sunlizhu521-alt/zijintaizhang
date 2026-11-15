import { useEffect, useId, useState } from 'react';
import { CATEGORIES } from '../shared/constants.js';
import { moneyInWan, monthText } from './format.js';
import { Modal, Pager } from './components.jsx';
import { supplierRecordDetails } from './supplier-data.js';

export function SupplierSearch({ options, value, onChange }) {
  const id = useId();
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  useEffect(() => setText(value), [value]);
  const matches = text.trim() ? options.filter(option => option.toLocaleLowerCase().includes(text.trim().toLocaleLowerCase())) : ['', ...options];
  function choose(item) { onChange(item); setText(item); setOpen(false); }
  return <div className="supplier-search" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) { setOpen(false); setText(value); } }}>
    <label htmlFor={id}>供应商</label><div className="supplier-search-control"><input id={id} role="combobox" aria-expanded={open} aria-controls={`${id}-options`} aria-autocomplete="list" aria-activedescendant={open && matches.length ? `${id}-option-${Math.min(index, matches.length - 1)}` : undefined} autoComplete="off" placeholder="全部供应商" value={text} onFocus={() => { setOpen(true); setIndex(0); }} onChange={event => { setText(event.target.value); setOpen(true); setIndex(0); }} onKeyDown={event => {
      if (event.key === 'Escape') { setOpen(false); setText(value); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); setIndex(previous => Math.max(0, Math.min(matches.length - 1, previous + (event.key === 'ArrowDown' ? 1 : -1)))); }
      if (event.key === 'Enter' && open && matches.length) { event.preventDefault(); choose(matches[Math.min(index, matches.length - 1)]); }
    }} /><button type="button" className="text-button" onClick={() => choose('')} aria-label="清除供应商筛选">清除</button></div>
    {open && <div id={`${id}-options`} role="listbox" aria-label="供应商选项" className="supplier-options">{!matches.length && <p className="brief-empty">无匹配供应商</p>}{matches.map((option, i) => <button id={`${id}-option-${i}`} role="option" aria-selected={option === value} key={option} className={i === index ? 'highlighted' : ''} onMouseDown={event => event.preventDefault()} onMouseEnter={() => setIndex(i)} onClick={() => choose(option)}>{option || '全部供应商'}</button>)}</div>}
  </div>;
}

export function Trend({ months, pending }) {
  if (pending || !months.length) return <p className="brief-empty">{pending ? '时间待定记录暂无月度走势' : '暂无月度数据'}</p>;
  const values = months.flatMap(month => [month.paidCents, month.unpaidCents]).filter(value => value != null);
  const min = Math.min(0, ...values), max = Math.max(1, ...values);
  const top = 24, bottom = 174;
  const y = value => top + (max - value) / (max - min) * (bottom - top);
  const x = position => `${2 + 96 * position / months.length}%`;
  const barWidth = 36;
  return <><div className="trend-scroll"><svg style={{ minWidth: Math.max(320, months.length * 112) }} role="img" aria-label="按月展示已付和未付金额，柱顶数值单位万元">
    <title>月度已付、未付金额（万元）</title>
    {Array.from({ length: 5 }, (_, index) => {
      const amount = min + (max - min) * index / 4;
      return <line key={index} x1="2%" x2="98%" y1={y(amount)} y2={y(amount)} stroke="#E7ECF2" />;
    })}
    {months.map((month, index) => <g key={month.month}>
      <text x={x(index + .5)} y="204" textAnchor="middle" fill="#6B7280" fontSize="11">{month.month}</text>
      {[['paidCents', '#2BB8C6', '已付'], ['unpaidCents', '#4C8DFF', '未付']].map(([key, fill, label], metricIndex) => {
        const amount = month[key], center = x(index + .25 + metricIndex * .5);
        if (amount == null) return <text key={key} x={center} y={y(0) - 8} textAnchor="middle" fontSize="11" fill="#94683B"><title>{monthText(month.month)}{label}金额待核对</title>?</text>;
        return <g key={key}>
          <rect x={center} transform={`translate(${-barWidth / 2},0)`} y={Math.min(y(amount), y(0))} width={barWidth} height={Math.abs(y(amount) - y(0))} rx="3" fill={fill}><title>{monthText(month.month)} {label} {moneyInWan(amount)} 万元</title></rect>
          <text className="trend-value" x={center} y={amount < 0 ? y(amount) + 14 : y(amount) - 8} textAnchor="middle" fill={fill} fontSize="11" fontWeight="600">{moneyInWan(amount)}</text>
        </g>;
      })}
    </g>)}
  </svg></div>{months.some(month => month.uncertainCount > 0) && <p className="muted compact-empty">? 表示金额待核对</p>}</>;
}

export function AppliedTable({ records = [], total, size = 20, reviewCount = 0, onReview }) {
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [records]);
  return <>{!records.length ? <p className="brief-empty">暂无已确认的申请未付记录</p> : <><div className="table-wrap brief-scroll-table applied-scroll"><table aria-label="已申请未付明细"><thead><tr><th>供应商</th><th>分类</th><th>已申请未付（万元）</th><th>是否提交申请单</th><th>付款 OA 号</th><th>节点</th></tr></thead><tbody>{records.slice((page - 1) * size, page * size).map(record => <tr key={record.key}><td>{record.supplier || '—'}</td><td>{CATEGORIES[record.category]}</td><td>{moneyInWan(record.selectedUnpaidCents)}</td><td><span className="tag neutral">{record.applicationStatus || '—'}</span><span className="application-basis" title={record.applicationBasis}>{record.applicationBasis?.includes('OA') ? '依据 OA' : '依据申请状态'}</span></td><td>{record.flowCode || '—'}</td><td>{record.currentNode || '—'}</td></tr>)}</tbody><tfoot><tr><th colSpan={2}>筛选合计</th><td>{moneyInWan(total)}</td><td colSpan={3}>全部 {records.length} 条</td></tr></tfoot></table></div><Pager page={page} total={records.length} size={size} onChange={setPage} /></>}{reviewCount > 0 && <p className="application-review-note">{reviewCount} 条申请金额待核对 <button className="text-button" onClick={onReview}>查看 →</button></p>}</>;
}

export function ReviewTable({ groups }) {
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null);
  useEffect(() => { setPage(1); setSelected(null); }, [groups]);
  return <>{!groups.length ? <p className="brief-empty">暂无待核对供应商</p> : <><div className="table-wrap"><table aria-label="待核对供应商"><thead><tr><th>供应商</th><th>总金额（万元）</th><th>查看详情</th></tr></thead><tbody>{groups.slice((page - 1) * 20, page * 20).map(group => <tr key={group.supplier}><td>{group.supplier || '—'}</td><td>{moneyInWan(group.totalCents)}</td><td><button className="text-button" onClick={() => setSelected(group)}>查看详情</button></td></tr>)}</tbody></table></div><Pager page={page} total={groups.length} onChange={setPage} /></>}{selected && <Modal title={`${selected.supplier || '未填写供应商'} · 待核对明细`} onClose={() => setSelected(null)} wide><ReviewRecords records={selected.records} /></Modal>}</>;
}
function ReviewRecords({ records }) {
  const [page, setPage] = useState(1);
  return <><p className="unit-label">单位：万元 · 原台账金额</p><div className="table-wrap brief-scroll-table review-records"><table aria-label="待核对供应商明细"><thead><tr>{['供应商', '分类', '谈判明细金额', '已付金额', '剩余金额', '是否提交申请单', '付款OA号', '节点', '孙立柱备注'].map(title => <th key={title}>{title}</th>)}</tr></thead><tbody>{records.slice((page - 1) * 20, page * 20).map(record => { const details = supplierRecordDetails(record); return <tr key={record.key}><td>{record.supplier || '—'}</td><td>{CATEGORIES[record.category]}</td><td>{moneyInWan(record.amountCents)}</td><td>{moneyInWan(record.paidCents)}</td><td>{moneyInWan(record.reviewRemainingCents)}{record.reviewBalanceMismatch && <span className="cell-secondary">余额不一致</span>}</td><td>{record.applicationStatus || '—'}</td><td>{record.flowCode || '—'}</td><td>{record.currentNode || '—'}</td><td>{details.remark || '—'}</td></tr>; })}</tbody></table></div><Pager page={page} total={records.length} onChange={setPage} /></>;
}
