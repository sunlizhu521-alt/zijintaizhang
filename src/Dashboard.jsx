import { useMemo, useState } from 'react';
import { CATEGORIES } from '../shared/constants.js';
import { download, queryString, useResource } from './api.js';
import { can, monthText, upcomingMonths } from './format.js';
import { ErrorNotice, IssuesTable, Loading } from './components.jsx';
import PaymentTable from './PaymentTable.jsx';
import SupplierTable from './SupplierTable.jsx';
import { groupSuppliers } from './supplier-data.js';

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
  const suppliers = useMemo(() => groupSuppliers(data?.records || []), [data?.records]);
  const update = (name, value) => setFilters(previous => ({ ...previous, [name]: value, month: period === 'pending' ? 'pending' : '' }));
  function changePeriod(value) {
    setPeriod(value);
    setFilters(previous => ({ ...previous, ...(value === 'upcoming' ? upcomingMonths() : { from: '', to: '' }), month: value === 'pending' ? 'pending' : '' }));
  }
  async function exportRows() {
    setActionError(null); setExporting(true);
    try { await download(`/dashboard/export?${query}`, '资金台账查询结果.xlsx'); } catch (err) { setActionError(err); } finally { setExporting(false); }
  }
  return <div className="page-stack dashboard-page">
    <div className="page-heading"><div><p className="eyebrow">付款计划与资金预估</p><h1>资金看板</h1><p className="subtitle">先看每月安排，再定位供应商明细。</p></div><button onClick={() => setRefresh(value => value + 1)} disabled={loading}>刷新数据</button></div>
    <section className="panel filters-panel" aria-label="看板筛选">
      <div className="filter-grid">
        <label>月份范围<select value={period} onChange={event => changePeriod(event.target.value)}><option value="upcoming">本月及后两个月</option><option value="all">全部月份</option><option value="custom">自选区间</option><option value="pending">时间待定</option></select></label>
        {period === 'custom' && <><label>开始月份<input type="month" value={filters.from} max={filters.to || undefined} onChange={event => update('from', event.target.value)} /></label><label>结束月份<input type="month" value={filters.to} min={filters.from || undefined} onChange={event => update('to', event.target.value)} /></label></>}
        {[['supplier', '供应商', options.suppliers], ['payer', '付款主体', options.payers], ['owner', '跟单员', options.owners]].map(([key, title, items]) => <label key={key}>{title}<select value={filters[key]} onChange={event => update(key, event.target.value)}><option value="">全部{title}</option>{items?.map(value => <option key={value} value={value}>{value}</option>)}</select></label>)}
        <label>数据类别<select value={filters.category} onChange={event => update('category', event.target.value)}><option value="">全部类别</option>{Object.entries(CATEGORIES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <button className="filter-reset" onClick={() => { setFilters(newFilters()); setPeriod('upcoming'); }}>重置筛选</button>
      </div>
      {period === 'upcoming' && <p className="filter-caption">当前区间：{monthText(filters.from)}至{monthText(filters.to)}。月份按北京时间确定。</p>}
    </section>
    <ErrorNotice error={error || actionError} />
    {loading ? <Loading /> : data && <>
      {filters.month !== 'pending' && <PaymentTable key="monthly" table={data.paymentTable} records={data.records} />}
      <section className="panel"><div className="section-heading"><div><h2>供应商明细 <span className="count">{suppliers.length} 家</span></h2><p>每个供应商一行，金额包含所选月份及时间待定记录；点击查看详情展开原始付款明细。</p></div>{can(user, 'export') && <button onClick={exportRows} disabled={exporting}>{exporting ? '正在导出…' : '导出当前结果'}</button>}</div><SupplierTable groups={suppliers} /></section>
      <PaymentTable key="pending" table={data.pendingPaymentTable} records={data.records} pending />
      <section className="panel"><details className="section-collapse"><summary><h2>待核对事项 <span className="count warning">{data.issues?.length || 0}</span></h2></summary><p className="collapse-note">提示用于核对原表，不自动更改、删除或合并记录。</p><IssuesTable issues={data.issues} /></details></section>
    </>}
  </div>;
}
