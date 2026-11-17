import { useEffect, useState } from 'react';
import { queryString, useResource } from './api.js';
import { can, dateTime, moneyInWan, monthText, upcomingMonths } from './format.js';
import { ErrorNotice, IssuesTable, Loading } from './components.jsx';
import PaymentTable from './PaymentTable.jsx';
import SupplierTable from './SupplierTable.jsx';
import { PaymentRecordsTable, ReviewTable, SupplierSearch, Trend } from './brief-sections.jsx';
import DashboardDownload, { DashboardDownloadContext } from './DashboardDownload.jsx';

const newFilters = () => ({ ...upcomingMonths(), supplier: '', month: '' });
const tabs = [['monthly', '月度汇总'], ['suppliers', '供应商明细'], ['applied', '付款明细'], ['pending', '时间待定'], ['review', '待核对']];

export default function Dashboard({ user }) {
  const [filters, setFilters] = useState(newFilters);
  const [period, setPeriod] = useState('upcoming');
  const [view, setView] = useState('brief');
  const [tab, setTab] = useState('monthly');
  const [refresh, setRefresh] = useState(0);
  const [refreshedAt, setRefreshedAt] = useState(null);
  const query = queryString(filters);
  const { data, loading, error } = useResource(`/dashboard?${query}`, refresh);
  useEffect(() => { if (data) setRefreshedAt(new Date().toISOString()); }, [data]);
  const summary = data?.summary || {};
  const isPending = filters.month === 'pending';
  const range = isPending ? '时间待定' : filters.from || filters.to
    ? `${filters.from ? monthText(filters.from) : '最早月份'} — ${filters.to ? monthText(filters.to) : '最晚月份'}` : '全部月份';
  const update = (name, value) => setFilters(previous => ({ ...previous, [name]: value }));
  function changePeriod(value) {
    setPeriod(value);
    setFilters(previous => ({ ...previous, ...(value === 'upcoming' || value === 'custom' ? upcomingMonths() : { from: '', to: '' }), month: value === 'pending' ? 'pending' : '' }));
  }
  function detail(nextTab) { setTab(nextTab); setView('ledger'); }
  const table = <PaymentTable table={isPending ? data?.pendingPaymentTable : data?.paymentTable} records={data?.records || []} pending={isPending} />;

  return <DashboardDownloadContext.Provider value={{ filters, allowed: can(user, 'export') }}><div className="page-stack dashboard-page">
    <header className="page-heading brief-heading"><div>{view === 'ledger' && <button className="text-button back-brief" onClick={() => setView('brief')}>← 返回简报</button>}<h1>{view === 'brief' ? '资金简报' : '详细台账'}</h1><p className="subtitle">数据截至 {dateTime(data?.updatedAt || refreshedAt)}</p></div><div className="heading-actions"><button className="refresh-button" onClick={() => setRefresh(value => value + 1)} disabled={loading}>刷新数据</button>{view === 'brief' ? <button className="primary" onClick={() => detail('monthly')}>查看详细台账 →</button> : <DashboardDownload label="下载全部结果" />}</div></header>
    <section className="panel brief-filters" aria-label="资金筛选"><div className="brief-filter-fields">
      <label>时间<select value={period} onChange={event => changePeriod(event.target.value)}><option value="upcoming">本月及后两个月</option><option value="all">全部月份</option><option value="custom">自选区间</option><option value="pending">时间待定</option></select></label>
      {period === 'custom' && <><label>开始月份<input type="month" value={filters.from} max={filters.to || undefined} onChange={event => update('from', event.target.value)} /></label><label>结束月份<input type="month" value={filters.to} min={filters.from || undefined} onChange={event => update('to', event.target.value)} /></label></>}
      <SupplierSearch options={data?.options?.suppliers || []} value={filters.supplier} onChange={value => update('supplier', value)} />
      <span className="range-label">{range}</span>
    </div></section>
    <ErrorNotice error={error} />
    {loading ? <Loading /> : data && (view === 'brief' ? <>
      <section className="kpi-grid" aria-label="期间资金指标">{[
        ['期间计划', summary.planCents, 'blue', 'monthly'], ['台账已付', summary.paidCents, 'green', 'monthly'],
        ['未付 / 剩余', summary.remainingCents, 'orange', 'monthly'], ['已申请未付', summary.appliedUnpaidCents, 'purple', 'applied'],
      ].map(([label, value, tone, target]) => <button className={`kpi-card ${tone}`} key={label} onClick={() => detail(target)}><span className="kpi-label"><i aria-hidden="true" />{label}</span><span className="kpi-value">{moneyInWan(value)}<small>万元</small></span></button>)}</section>
      {(summary.uncertainCount > 0 || summary.applicationReviewCount > 0 || summary.missingSourceCount > 0) && <div className="brief-data-note"><span>{summary.missingSourceCount > 0 ? '部分文件尚未上传。' : ''}{summary.uncertainCount > 0 || summary.applicationReviewCount > 0 ? '部分金额待核对。' : ''}</span><button className="text-button" onClick={() => detail('review')}>查看待核对 →</button></div>}
      <div className="brief-charts"><section className="panel top-suppliers"><div className="section-heading"><h2>{isPending ? '时间待定待付 Top10' : filters.from === upcomingMonths().from && filters.to === filters.from ? '本月待付 Top10' : '期间待付 Top10'}</h2><span className="unit-label">万元</span></div>
        {data.topSuppliers?.length ? <div className="top-table-scroll"><table aria-label="待付供应商 Top10"><thead><tr><th>供应商</th><th>未付金额</th></tr></thead><tbody>{data.topSuppliers.map(row => <tr key={row.supplier}><td><button className="text-button" onClick={() => { update('supplier', row.supplier); detail('suppliers'); }}>{row.supplier || '未填写供应商'}</button></td><td>{moneyInWan(row.unpaidCents)}</td></tr>)}</tbody></table></div> : <p className="brief-empty">暂无可确定的未付金额</p>}
        {summary.uncertainCount > 0 && <p className="muted compact-empty">待核对金额未参与排名</p>}
      </section><section className="panel trend-panel"><div className="section-heading"><h2>月度走势</h2><div className="trend-legend"><span className="paid">已付</span><span className="unpaid">未付</span><small>万元</small></div></div><Trend months={data.monthlyTrend || []} pending={isPending} /></section></div>
      {table}
      <section className="panel"><div className="section-heading"><h2>付款明细</h2><div className="download-actions"><DashboardDownload options={{ exportView: 'payments' }} /><button className="text-button" onClick={() => detail('applied')}>查看全部 →</button></div></div><PaymentRecordsTable records={data.records} summary={summary} size={10} reviewCount={summary.applicationReviewCount} onReview={() => detail('review')} /></section>
    </> : <>
      <nav className="tabs ledger-tabs" aria-label="台账页签">{tabs.map(([id, label]) => <button key={id} aria-current={tab === id ? 'page' : undefined} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}</nav>
      {tab === 'monthly' && table}
      {tab === 'suppliers' && <section className="panel"><div className="section-heading"><h2>供应商明细 <span className="count">{data.supplierGroups?.length || 0} 家</span></h2><div className="download-actions"><span className="unit-label">万元</span><DashboardDownload options={{ exportView: 'suppliers' }} /></div></div><SupplierTable groups={data.supplierGroups || []} /></section>}
      {tab === 'applied' && <section className="panel"><div className="section-heading"><h2>付款明细</h2><div className="download-actions"><span className="unit-label">万元</span><DashboardDownload options={{ exportView: 'payments' }} /></div></div><PaymentRecordsTable records={data.records} summary={summary} reviewCount={summary.applicationReviewCount} onReview={() => detail('review')} /></section>}
      {tab === 'pending' && <><PaymentTable table={data.pendingPaymentTable} records={data.pendingRecords || []} pending /><section className="panel"><div className="section-heading"><h2>时间待定明细</h2><div className="download-actions"><span className="unit-label">万元 · 跟随供应商筛选</span><DashboardDownload options={{ exportView: 'pending-suppliers' }} /></div></div><SupplierTable exportView="pending-suppliers" groups={data.pendingSupplierGroups || []} /></section></>}
      {tab === 'review' && <><section className="panel"><div className="section-heading"><h2>待核对供应商</h2><div className="download-actions"><span className="unit-label">万元 · 原台账金额</span><DashboardDownload options={{ exportView: 'review' }} /></div></div><ReviewTable groups={data.reviewSuppliers || []} /></section><section className="panel"><div className="section-heading"><h2>待核对事项 <span className="count">{data.issues?.length || 0}</span></h2><DashboardDownload options={{ exportView: 'issues' }} /></div><IssuesTable issues={data.issues} /></section></>}
    </>)}
  </div></DashboardDownloadContext.Provider>;
}
