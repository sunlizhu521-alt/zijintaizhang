import { useState } from 'react';
import { CATEGORIES, LEDGER_CATEGORIES, SLOTS } from '../shared/constants.js';
import { download, queryString, useResource } from './api.js';
import { can, dateTime, money, monthText, upcomingMonths } from './format.js';
import { Empty, ErrorNotice, IssuesTable, Loading, Notice, RecordsTable } from './components.jsx';

const categoryKeys = Object.keys(CATEGORIES);
const newFilters = () => ({ ...upcomingMonths(), supplier: '', payer: '', owner: '', category: '', month: '' });

export default function Dashboard({ user }) {
  const [filters, setFilters] = useState(newFilters);
  const [period, setPeriod] = useState('upcoming');
  const [refresh, setRefresh] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [actionError, setActionError] = useState(null);
  const query = queryString(filters);
  const { data, loading, error } = useResource(`/dashboard?${query}`, refresh);
  const options = data?.options || {};
  const update = (name, value) => setFilters(previous => ({ ...previous, [name]: value, ...(name !== 'month' ? { month: '' } : {}) }));
  function changePeriod(value) {
    setPeriod(value);
    setFilters(previous => ({ ...previous, ...(value === 'upcoming' ? upcomingMonths() : { from: '', to: '' }), month: value === 'pending' ? 'pending' : '' }));
  }
  async function exportRows() {
    setActionError(null); setExporting(true);
    try { await download(`/dashboard/export?${query}`, '资金台账查询结果.xlsx'); } catch (err) { setActionError(err); } finally { setExporting(false); }
  }
  const slots = data?.slots || [];
  const hasSlot = id => Boolean(slots.find(slot => slot.id === id)?.currentVersionId);
  const hasCategory = category => hasSlot(LEDGER_CATEGORIES.includes(category) ? 'schedule' : category);
  const sourceAmount = (slotId, cents) => hasSlot(slotId) ? `${money(cents)} 元` : '未上传';
  const summary = data?.summary || {};
  const pendingView = filters.month === 'pending';
  const maximum = Math.max(1, ...(data?.months || []).flatMap(row => categoryKeys.map(key => Math.abs(row[key] || 0))));
  const metric = (title, value, note, emphasis = false) => <article className={`metric-card ${emphasis ? 'emphasis' : ''}`} key={title}><span>{title}</span><strong>{value == null ? '—' : money(value)}<small>元</small></strong><p>{note}</p></article>;
  return <div className="page-stack">
    <div className="page-heading"><div><p className="eyebrow">付款计划与资金预估</p><h1>资金看板</h1><p className="subtitle">先看每月安排，再定位供应商明细。</p></div><button onClick={() => setRefresh(value => value + 1)} disabled={loading}>刷新数据</button></div>
    <section className="panel filters-panel" aria-label="看板筛选">
      <div className="filter-grid">
        <label>月份范围<select value={period} onChange={event => changePeriod(event.target.value)}><option value="upcoming">本月及后两个月</option><option value="all">全部月份</option><option value="custom">自选区间</option><option value="pending">时间待定</option></select></label>
        {period === 'custom' && <><label>开始月份<input type="month" value={filters.from} max={filters.to || undefined} onChange={event => update('from', event.target.value)} /></label><label>结束月份<input type="month" value={filters.to} min={filters.from || undefined} onChange={event => update('to', event.target.value)} /></label></>}
        {[['supplier', '供应商', options.suppliers], ['payer', '付款主体', options.payers], ['owner', '跟单员', options.owners]].map(([key, title, items]) => <label key={key}>{title}<select value={filters[key]} onChange={event => update(key, event.target.value)}><option value="">全部{title}</option>{items?.map(value => <option key={value} value={value}>{value}</option>)}</select></label>)}
        <label>数据类别<select value={filters.category} onChange={event => update('category', event.target.value)}><option value="">全部类别</option>{Object.entries(CATEGORIES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <button className="filter-reset" onClick={() => { setFilters(newFilters()); setPeriod('upcoming'); }}>重置筛选</button>
      </div>
      {filters.month && period !== 'pending' && <div className="drilldown"><span>正在查看：{monthText(filters.month)}</span><button className="text-button" onClick={() => update('month', '')}>返回区间汇总 ×</button></div>}
      {period === 'upcoming' && <p className="filter-caption">当前区间：{monthText(filters.from)}至{monthText(filters.to)}。月份按北京时间确定。</p>}
    </section>
    <ErrorNotice error={error || actionError} />
    {loading ? <Loading /> : data && <>
      <div className="slot-status-strip" aria-label="数据文件状态">{SLOTS.map(slot => { const state = slots.find(value => value.id === slot.id); return <div key={slot.id}><span className={`status-dot ${state?.currentVersionId ? 'ready' : ''}`} /><strong>{slot.label}</strong><span>{state?.currentVersionId ? dateTime(state.uploadedAt || state.updatedAt) : '尚未上传'}</span></div>; })}</div>
      {slots.every(slot => !slot.currentVersionId) && <Notice>尚无有效业务文件。请由有上传权限的人员在“文件管理”上传付款节奏和三类预估。</Notice>}
      <div className="metric-grid">
        {metric(pendingView ? '时间待定付款计划' : '选定期间付款计划', hasSlot('schedule') ? pendingView ? summary.pendingPlanCents : summary.planCents : null, '谈判表两类付款与正常付款的计划金额', true)}
        {metric('台账累计已付', hasSlot('schedule') ? summary.paidCents : null, `不受月份筛选影响${summary.missingPaidCount ? ` · ${summary.missingPaidCount} 条未提供已付金额` : ''}`)}
        {metric('台账剩余金额', hasSlot('schedule') ? summary.remainingCents : null, `不受月份筛选影响${summary.missingRemainingCount ? ` · ${summary.missingRemainingCount} 条未提供剩余金额` : ''}`)}
      </div>
      <p className="scope-note">累计已付与剩余金额按供应商、付款主体、跟单员及类别筛选后统计，共 {summary.ledgerRecordCount || 0} 条台账记录。金额为空或公式无已保存计算结果时按 0 计入。流程归档不自动视为已付款。</p>
      <div className="forecast-grid">{['shipment', 'after_sales', 'unregistered'].map(key => metric(CATEGORIES[key], hasSlot(key) ? (pendingView ? summary.pendingForecastCents?.[key] : summary.forecastCents?.[key]) : null, `${pendingView ? '时间待定' : '选定期间'}预估 · 独立展示`))}</div>
      {!pendingView && data.months?.some(row => row.month === 'pending') && <Notice type="warning">另有时间待定记录，未计入上方期间金额。付款计划：{sourceAmount('schedule', summary.pendingPlanCents)}；发货计划预估：{sourceAmount('shipment', summary.pendingForecastCents?.shipment)}；售后配件预估：{sourceAmount('after_sales', summary.pendingForecastCents?.after_sales)}；已发货未登记预估：{sourceAmount('unregistered', summary.pendingForecastCents?.unregistered)}。<button className="text-button" onClick={() => changePeriod('pending')}>查看时间待定记录</button></Notice>}
      <section className="panel">
        <div className="section-heading"><div><h2>月度安排</h2><p>单位：元。预估与付款计划可能重叠，分别展示，不直接相加。</p></div><span className="tag neutral">点击月份查看明细</span></div>
        {!data.months?.length ? <Empty title="当前区间暂无计划">可查看全部月份或时间待定记录。</Empty> : <>
          <div className="table-wrap"><table aria-label="月度付款与预估汇总"><thead><tr><th>月份</th>{categoryKeys.map(key => <th key={key} className="numeric">{CATEGORIES[key]}</th>)}</tr></thead><tbody>{data.months.map((row, index) => <tr key={row.month || index}><td><button className="text-button month-button" onClick={() => update('month', row.month || 'pending')}>{monthText(row.month)}</button></td>{categoryKeys.map(key => <td className="numeric" key={key}>{hasCategory(key) ? money(row[key]) : '未上传'}</td>)}</tr>)}</tbody></table></div>
          <details className="chart-details" open><summary>月度金额对比</summary><div className="chart-legend">{categoryKeys.map(key => <span key={key}><i className={`swatch category-${key}`} />{CATEGORIES[key]}</span>)}</div><div className="monthly-chart" aria-label="月度金额柱形对比">{data.months.map((row, index) => <div className="chart-month" key={row.month || index}><strong>{monthText(row.month)}</strong><div className="chart-bars">{categoryKeys.map(key => <div className="bar-line" key={key}><span className="sr-only">{CATEGORIES[key]}：</span>{hasCategory(key) && <div className={`bar category-${key}`} style={{ width: `${Math.max(row[key] ? 1 : 0, Math.abs(row[key] || 0) / maximum * 100)}%` }} />}<span className="bar-value">{hasCategory(key) ? money(row[key]) : '未上传'}</span></div>)}</div></div>)}</div></details>
        </>}
      </section>
      <section className="panel"><div className="section-heading"><div><h2>供应商明细 <span className="count">{data.records?.length || 0}</span></h2><p>期间计划按当前月份筛选；已付与剩余为该笔记录的原台账金额。</p></div>{can(user, 'export') && <button onClick={exportRows} disabled={exporting}>{exporting ? '正在导出…' : '导出当前结果'}</button>}</div><RecordsTable records={data.records} /></section>
      <section className="panel"><div className="section-heading"><div><h2>待核对事项 <span className="count warning">{data.issues?.length || 0}</span></h2><p>提示用于核对原表，不自动更改、删除或合并记录。</p></div></div><IssuesTable issues={data.issues} /></section>
    </>}
  </div>;
}
