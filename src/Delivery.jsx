import { useEffect, useMemo, useRef, useState } from 'react';
import { api, download, queryString, useResource } from './api.js';
import { can } from './format.js';
import { Empty, ErrorNotice, Loading, Modal, Notice, Pager } from './components.jsx';
import { MAX_UPLOAD_BYTES } from '../shared/constants.js';
import './delivery.css';

const STAGES = { receipts: '收料', inbound: '入库' };
const STATUS = { closed: '已关闭', review: '待核对', unknown: '缺少交付文件', zero: '零数量订单', completed: '已交齐', overdue: '已延期', warning: '即将到期', pending: '待交付', partial: '部分交付' };
const CHECKS = { pending: '待核验', pass: '一致', issue: '异常' };
const FIELD_NAMES = { orderNumber: '采购订单号', documentNumber: '单据编号', lineNumber: '单据行号', sourceLineNumber: '源单行号', supplier: '供应商', productCode: '物料编码', productName: '产品名称', specification: '规格型号', unit: '单位', quantity: '数量', createdDate: '创建时间', dueDate: '交货日期', deliveryDate: '交付日期', labelRequirement: '标签要求', receivingInfo: '收货信息' };
const FILE_DESCRIPTIONS = {
  delivery_orders: '以采购日期作为创建时间，读取交货日期、供应商和产品数量，作为交付要求。',
  delivery_inbound: '以源单单号关联订单单据编号，兼容源单编号及经收料单追溯，读取入库日期和数量。',
  delivery_receipts: '以源单单号关联采购订单的单据编号，读取收料日期和数量。',
};
const initialFilters = { from: '', to: '', supplier: '', status: '', search: '' };
const number = value => value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 6 });
const percent = value => value == null || !Number.isFinite(Number(value)) ? '—' : `${(Number(value) * 100).toFixed(1)}%`;
function date(value) {
  if (!value) return '—';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(parsed);
}
const text = value => value == null || value === '' ? '—' : String(value);
function Status({ value }) { return <span className={`delivery-status ${value || 'pending'}`}>{STATUS[value] || value || '待核对'}</span>; }
function PackageIcon() { return <svg viewBox="0 0 40 40" aria-hidden="true"><path d="M6 11 20 4l14 7v18l-14 7L6 29Zm0 0 14 7 14-7M20 18v18M13 7l14 7v8" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" /></svg>; }

export default function Delivery({ user, onPassword, onLogout, loggingOut, sessionError }) {
  const [tab, setTab] = useState(can(user, 'dashboard') ? 'dashboard' : 'files');
  const [refresh, setRefresh] = useState(0);
  const [filters, setFilters] = useState(initialFilters);
  const [searchInput, setSearchInput] = useState('');
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [message, setMessage] = useState('');
  const query = queryString(filters);
  const { data, loading, error } = useResource(can(user, 'dashboard') && tab !== 'files' ? `/delivery/dashboard?${query}` : null, refresh);
  const updateFilter = (key, value) => { setFilters(previous => ({ ...previous, [key]: value })); setActionError(null); };
  const nav = [
    ...(can(user, 'dashboard') ? [{ id: 'dashboard', name: '交付看板' }, { id: 'tracking', name: '订单跟进' }] : []),
    ...(can(user, 'files') ? [{ id: 'files', name: '文件管理' }] : []),
  ];
  async function exportData() {
    setBusy(true); setActionError(null);
    try { await download(`/delivery/export?${query}`, '供应商交付管理_V1.xlsx'); }
    catch (err) { setActionError(err); } finally { setBusy(false); }
  }
  return <>
    <a className="skip-link" href="#delivery-main">跳至主要内容</a>
    <header className="delivery-header"><div className="delivery-identity"><div className="delivery-logo"><PackageIcon /></div><div><span className="delivery-eyebrow">SUPPLIER DELIVERY</span><h1>供应商交付管理</h1><p>从订单要求到按期交付，每一步有据可查。</p></div></div><div className="delivery-account"><span className="delivery-avatar">{(user.displayName || user.username).slice(0, 1)}</span><div><strong>{user.displayName || user.username}</strong><div><button onClick={onPassword}>修改密码</button><span>·</span><button disabled={loggingOut} onClick={onLogout}>{loggingOut ? '退出中…' : '退出登录'}</button></div></div></div></header>
    <div className="delivery-navigation"><nav aria-label="供应商交付导航">{nav.map(item => <button key={item.id} aria-current={tab === item.id ? 'page' : undefined} className={tab === item.id ? 'active' : ''} onClick={() => { setTab(item.id); setMessage(''); setActionError(null); }}>{item.name}</button>)}</nav><span className="delivery-live-dot">{data ? `数据截至 ${date(data.asOfDate)}` : '独立交付工作台'}</span></div>
    <main id="delivery-main" tabIndex={-1} className="delivery-main"><ErrorNotice error={sessionError} />
      {!nav.length ? <Empty title="账号尚未获得页面权限">请联系管理员分配看板或文件权限。</Empty> : tab === 'files' ? <DeliveryFiles user={user} onChange={() => setRefresh(value => value + 1)} /> : <>
        <div className="delivery-section-title"><div><h2>{tab === 'dashboard' ? '供应商交付概览' : '订单交付跟进'}</h2><p>收料与入库同屏展示、分别统计，交付数量不相加。</p></div><div className="delivery-actions"><button onClick={() => setRefresh(value => value + 1)} disabled={loading || busy}>刷新数据</button>{can(user, 'export') && <button className="primary" onClick={exportData} disabled={loading || busy || !data}>{busy ? '正在导出…' : '导出指标与明细'}</button>}</div></div>
        <section className="delivery-filter-panel" aria-label="交付筛选"><div className="delivery-filters"><label>交期起始月<input type="month" value={filters.from} onChange={event => updateFilter('from', event.target.value)} /></label><label>交期结束月<input type="month" value={filters.to} onChange={event => updateFilter('to', event.target.value)} /></label><label>供应商<select value={filters.supplier} onChange={event => updateFilter('supplier', event.target.value)}><option value="">全部供应商</option>{(data?.options?.suppliers || []).map(supplier => <option key={supplier} value={supplier}>{supplier}</option>)}</select></label><label>交付状态（任一类型）<select value={filters.status} onChange={event => updateFilter('status', event.target.value)}><option value="">全部状态</option>{Object.entries(STATUS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><form className="delivery-search" onSubmit={event => { event.preventDefault(); updateFilter('search', searchInput.trim()); }}><label>订单 / 物料 / 供应商<input type="search" maxLength={200} placeholder="输入关键词" value={searchInput} onChange={event => setSearchInput(event.target.value)} /></label><button type="submit">查询</button></form><button className="delivery-reset" onClick={() => { setFilters(initialFilters); setSearchInput(''); }}>重置</button></div></section>
        <ErrorNotice error={error || actionError} /><Notice type="success">{message}</Notice>
        {loading ? <Loading /> : data && <>
          <div className="delivery-link-map"><strong>采购订单 · 单据编号</strong><span aria-hidden="true">→</span><div><span>收料通知单 · 源单单号</span><span>采购入库单 · 源单单号</span></div><small>兼容“源单编号”；入库可经收料单唯一追溯</small></div>
          {tab === 'dashboard' && <>
            <div className="delivery-order-summary"><div><span>采购订单</span><strong>{number(data.summary?.orderCount)}</strong><small>单</small></div><div><span>订单明细</span><strong>{number(data.summary?.lineCount)}</strong><small>行</small></div><div><span>已关闭</span><strong>{number(data.summary?.closedCount)}</strong><small>行 · 保留历史指标，停止预警</small></div></div>
            <div className="delivery-dual-metrics">{Object.entries(STAGES).map(([kind, label]) => <MetricCards key={kind} summary={data.summaries?.[kind] || {}} kind={kind} label={label} />)}</div>
            <div className="delivery-dual-quantities">{Object.entries(STAGES).map(([kind, label]) => <QuantityBreakdown key={kind} rows={data.summaries?.[kind]?.quantityByUnit || []} kind={kind} label={label} />)}</div>
            <div className="delivery-chart-grid"><Chart title="月度按期交齐率" subtitle="按交货月份汇总 · 已到期订单行 · 最近 18 个月" values={(data.monthly || []).map(row => ({ label: row.month === 'pending' ? '交期待定' : row.month, receipts: row.receipts?.onTimeRate, inbound: row.inbound?.onTimeRate, receiptsDetail: `${number(row.receipts?.onTimeCount)} / ${number(row.receipts?.dueCount)} 行`, inboundDetail: `${number(row.inbound?.onTimeCount)} / ${number(row.inbound?.dueCount)} 行` }))} /><Chart title="供应商交齐率" subtitle="当前筛选下的订单行 · 展示前 10 家" values={(data.suppliers || []).slice(0, 10).map(row => ({ label: row.supplier || '供应商待核对', receipts: row.receipts?.completionRate, inbound: row.inbound?.completionRate, receiptsDetail: `已交齐 ${number(row.receipts?.completedCount)} 行`, inboundDetail: `已交齐 ${number(row.inbound?.completedCount)} 行` }))} /></div>
            <SupplierTable rows={data.suppliers || []} onSelect={supplier => updateFilter('supplier', supplier)} />
          </>}
          <OrderTable rows={data.rows || []} user={user} onSelect={setSelected} tracking={tab === 'tracking'} />
          <DataIssues issues={data.issues || []} outsideScopeCount={data.outsideScopeCount || 0} />
          <details className="delivery-policy"><summary>查看统计规则与数据范围</summary>{Array.isArray(data.policy) ? data.policy.map((item, index) => <p key={index}>{item}</p>) : typeof data.policy === 'string' && <p>{data.policy}</p>}</details>
        </>}
      </>}
    </main>
    {selected && <Followup row={selected} user={user} onClose={() => setSelected(null)} onSaved={() => { setSelected(null); setMessage('跟进记录已保存。'); setRefresh(value => value + 1); }} />}
    <footer className="delivery-footer">供应商交付管理 <span>订单要求清晰 · 交付过程可追溯 · 异常及时跟进</span></footer>
  </>;
}

function MetricCards({ summary, kind, label }) {
  const metrics = [
    { label: '交齐率', value: percent(summary.completionRate), detail: `已交齐 ${number(summary.completedCount)} 行`, icon: '✓', tone: 'green' },
    { label: '按期交齐率', value: percent(summary.onTimeRate), detail: `${number(summary.onTimeCount)} / ${number(summary.dueCount)} 条到期订单行`, icon: '◷', tone: 'purple' },
    { label: '延期未交齐', value: number(summary.overdueCount), detail: `未来 7 天到期 ${number(summary.warningCount)} 行`, icon: '!', tone: 'coral' },
  ];
  return <section className={`delivery-metric-group ${kind}`} aria-label={`${label}交付指标`}><div className="delivery-metric-group-title"><h3>{label}交付指标</h3><span>{kind === 'receipts' ? '来自收料通知单' : '来自采购入库单'}</span></div><div className="delivery-metrics">{metrics.map(item => <div className={`delivery-metric ${item.tone}`} key={item.label}><div className="delivery-metric-head"><span>{item.label}</span><i aria-hidden="true">{item.icon}</i></div><strong>{item.value}</strong><p>{item.detail}</p></div>)}</div>{!summary.stageAvailable ? <p className="delivery-data-note">尚未上传{label}文件，相关指标显示“—”。</p> : <p className="delivery-data-note">有效可判定 {number(summary.validLineCount)} 行{summary.reviewCount > 0 && <> · <strong>{number(summary.reviewCount)}</strong> 行待核对，未计入交齐率</>}</p>}</section>;
}

function Chart({ title, subtitle, values }) {
  const chartValues = values.slice(-18);
  const chartDescription = chartValues.map(item => `${item.label}：收料 ${percent(item.receipts)}，入库 ${percent(item.inbound)}`).join('；');
  return <section className="delivery-panel delivery-chart"><div className="delivery-panel-heading"><div><h2>{title}</h2><p>{subtitle}</p></div><div className="delivery-chart-legends"><span className="delivery-legend purple">收料</span><span className="delivery-legend coral">入库</span></div></div>{!chartValues.length ? <Empty title="暂无可展示的指标">上传订单及对应交付文件后生成。</Empty> : <div className="delivery-bars" role="img" aria-label={`${title}：${chartDescription}`}><div className="delivery-chart-axis"><span>100%</span><span>50%</span><span>0%</span></div><div className="delivery-chart-plot" style={{ minWidth: Math.max(220, chartValues.length * 54) }}>{chartValues.map((item, index) => <div className="delivery-chart-column delivery-dual-column" key={`${item.label}-${index}`}>{Object.entries(STAGES).map(([kind, label]) => <div key={kind} className="delivery-chart-bar-space"><span className="delivery-chart-value">{percent(item[kind]).replace('.0%', '%')}</span><div className={`delivery-chart-bar ${kind === 'receipts' ? 'purple' : 'coral'}${item[kind] == null ? ' unknown' : ''}`} style={{ height: `${item[kind] == null ? 0 : Math.max(0, Math.min(1, item[kind])) * 100}%` }} title={`${item.label} · ${label}：${percent(item[kind])} · ${item[`${kind}Detail`]}`} /></div>)}<span className="delivery-chart-label" title={item.label}>{item.label}</span></div>)}</div></div>}</section>;
}

function SupplierTable({ rows, onSelect }) {
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [rows]);
  return <section className="delivery-panel"><div className="delivery-panel-heading"><div><h2>供应商指标 <span className="delivery-count">{rows.length}</span></h2><p>收料、入库指标并排展示 · 点击供应商查看对应订单。</p></div></div>{!rows.length ? <Empty title="暂无供应商指标" /> : <><div className="delivery-table-wrap"><table className="delivery-table delivery-supplier-table" aria-label="供应商交付指标"><thead><tr><th rowSpan={2}>供应商</th><th rowSpan={2} className="numeric">订单数</th><th rowSpan={2} className="numeric">订单行数</th><th rowSpan={2} className="numeric">已关闭</th><th colSpan={6} className="delivery-receipts-head">收料通知单指标</th><th colSpan={6} className="delivery-inbound-head">采购入库单指标</th></tr><tr>{Object.entries(STAGES).map(([kind]) => ['已交齐', '交齐率', '按期交齐率', '延期未交齐', '即将到期', '待核对'].map(label => <th key={`${kind}-${label}`} className={`numeric delivery-${kind}-head`}>{label}</th>))}</tr></thead><tbody>{rows.slice((page - 1) * 10, page * 10).map((row, index) => <tr key={`${row.supplier}-${index}`}><td><button className="text-button" onClick={() => onSelect(row.supplier)}>{row.supplier || '供应商待核对'}</button></td><td className="numeric">{number(row.receipts?.orderCount)}</td><td className="numeric">{number(row.receipts?.lineCount)}</td><td className="numeric">{number(row.receipts?.closedCount)}</td>{Object.keys(STAGES).map(kind => ['completedCount', 'completionRate', 'onTimeRate', 'overdueCount', 'warningCount', 'reviewCount'].map(field => <td key={`${kind}-${field}`} className={`numeric${field === 'overdueCount' ? ' delivery-coral-text' : ''}${field.includes('Rate') ? ' delivery-rate' : ''}`}>{field.includes('Rate') ? percent(row[kind]?.[field]) : number(row[kind]?.[field])}</td>))}</tr>)}</tbody></table></div><Pager page={page} total={rows.length} size={10} onChange={setPage} /></>}</section>;
}

function OrderTable({ rows, user, onSelect, tracking }) {
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState('dueDate');
  const [direction, setDirection] = useState(1);
  useEffect(() => setPage(1), [rows, sort, direction]);
  const sorted = useMemo(() => {
    const value = row => sort.split('.').reduce((part, key) => part?.[key], row);
    return [...rows].sort((a, b) => String(value(a) || '\uffff').localeCompare(String(value(b) || '\uffff'), 'zh-CN', { numeric: true }) * direction);
  }, [rows, sort, direction]);
  const sortBy = key => { if (sort === key) setDirection(value => -value); else { setSort(key); setDirection(1); } };
  const heading = (key, name, className) => <th key={key} className={className} aria-sort={sort === key ? direction === 1 ? 'ascending' : 'descending' : undefined}><button onClick={() => sortBy(key)}>{name}<span aria-hidden="true">{sort === key ? direction === 1 ? ' ▴' : ' ▾' : ' ▿'}</span></button></th>;
  return <section className="delivery-panel delivery-detail"><div className="delivery-panel-heading"><div><h2>订单交付明细 <span className="delivery-count">{rows.length}</span></h2><p>收料、入库数量与状态同时展示 · 两类数量不相加 · 点击列名排序</p></div><span className="delivery-table-hint">左右滚动查看完整字段 →</span></div>{!rows.length ? <Empty title="暂无符合条件的订单">上传金蝶采购订单，或调整当前筛选条件。</Empty> : <><div className="delivery-table-wrap" tabIndex={0} role="region" aria-label="可横向滚动的订单交付明细"><table className="delivery-table delivery-order-table" aria-label="订单交付明细"><thead><tr>
    {heading('orderNumber', '采购订单号（单据编号）')}{heading('createdDate', '创建时间')}{heading('dueDate', '交货日期')}{heading('supplier', '供应商')}{heading('productCode', '物料编码')}<th>产品名称</th><th>规格型号</th><th>单位</th><th className="numeric">订购数量</th>
    {Object.entries(STAGES).flatMap(([kind, label]) => [<th key={`${kind}-quantity`} className={`numeric delivery-${kind}-head`}>{label}数量</th>, <th key={`${kind}-dates`} className={`delivery-${kind}-head`}>最近{label} / 交齐日期</th>, <th key={`${kind}-remaining`} className={`numeric delivery-${kind}-head`}>未{label}数量</th>, heading(`${kind}.status`, `${label}状态`, `delivery-${kind}-head`)])}
    <th>分批交付情况</th><th>生产 / 发货</th><th>标签要求 / 收货信息</th><th>核验 / 异常</th><th>负责人 / 预计发货</th><th>跟进</th>
  </tr></thead><tbody>{sorted.slice((page - 1) * 20, page * 20).map((row, index) => {
    const follow = row.followup?.data || {};
    const checks = ['productCheck', 'specificationCheck', 'quantityCheck', 'labelCheck', 'receivingCheck'];
    const issueCount = checks.filter(key => follow[key] === 'issue').length;
    const passCount = checks.filter(key => follow[key] === 'pass').length;
    return <tr key={`${row.key}-${index}`}><td><strong className="delivery-order-number">{text(row.orderNumber)}</strong><small>行号 {text(row.lineNumber)}</small>{row.closed && <small className="delivery-closed-note">订单已关闭</small>}</td><td className="nowrap">{date(row.createdDate)}</td><td className="nowrap">{date(row.dueDate)}</td><td>{text(row.supplier)}</td><td className="mono">{text(row.productCode)}</td><td>{text(row.productName)}</td><td>{text(row.specification)}</td><td>{text(row.unit)}</td><td className="numeric">{number(row.quantity)}</td>
      {Object.keys(STAGES).flatMap(kind => [<td key={`${kind}-quantity`} className="numeric">{row[kind]?.available ? number(row[kind].quantity) : '—'}</td>, <td key={`${kind}-dates`} className="nowrap">{date(row[kind]?.lastDeliveryDate)}<small>交齐 {date(row[kind]?.completionDate)}</small></td>, <td key={`${kind}-remaining`} className="numeric">{number(row[kind]?.remainingQuantity)}</td>, <td key={`${kind}-status`}><Status value={row[kind]?.status} /></td>])}
      <td><BatchSummary info={row.batchInfo} onClick={() => onSelect(row)} /></td><td>{follow.productionStatus || '未登记'}<small>{follow.shippingStatus || '未登记'}</small></td><td><span className="delivery-long-cell">{text(row.labelRequirement)}<small>{text(row.receivingInfo)}</small></span></td><td>{issueCount ? <span className="delivery-coral-text">{issueCount} 项核验异常</span> : passCount === 5 ? '五项一致' : `${passCount}/5 项已核验`}<small className="delivery-long-cell">{follow.exception || '未登记异常'}</small></td><td>{text(follow.owner)}<small>{date(follow.expectedShipDate)}</small></td><td><button className="delivery-row-button" onClick={() => onSelect(row)}>{can(user, 'files') && can(user, 'upload') && row.followupAllowed ? '查看 / 跟进' : '查看详情'}</button>{tracking && row.followup?.updatedAt && <small>{date(row.followup.updatedAt)}</small>}</td></tr>;
  })}</tbody></table></div><Pager page={page} total={rows.length} size={20} onChange={setPage} /></>}</section>;
}

function IssueTable({ issues = [], pagination }) {
  const [localPage, setLocalPage] = useState(1);
  useEffect(() => setLocalPage(1), [issues]);
  const page = pagination?.page || localPage;
  const pageIssues = pagination ? issues : issues.slice((page - 1) * 20, page * 20);
  if (!issues.length) return <Empty title="暂无待核对事项" />;
  return <><div className="delivery-table-wrap"><table className="delivery-table" aria-label="交付待核对事项"><thead><tr><th>采购订单 / 来源</th><th>工作表 / 行</th><th>核对内容</th></tr></thead><tbody>{pageIssues.map((issue, index) => <tr key={index}><td>{text(issue.orderNumber)}<small>{issue.filename || ({ orders: '采购订单', receipts: '收料通知单', inbound: '采购入库单' }[issue.sourceType]) || ''}</small></td><td>{issue.sourceSheet || issue.sheet || '—'}{issue.sourceRow || issue.row ? ` · 第 ${issue.sourceRow || issue.row} 行` : ''}</td><td>{issue.message || String(issue)}</td></tr>)}</tbody></table></div><Pager page={page} total={pagination?.total ?? issues.length} size={pagination?.pageSize || 20} onChange={pagination?.onChange || setLocalPage} /></>;
}

function Followup({ row, user, onClose, onSaved }) {
  const initial = { productionStatus: '未开始', shippingStatus: '未发货', expectedShipDate: '', owner: '', productCheck: 'pending', specificationCheck: 'pending', quantityCheck: 'pending', labelCheck: 'pending', receivingCheck: 'pending', exception: '', action: '', note: '', ...(row.followup?.data || {}) };
  const [values, setValues] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const editable = can(user, 'files') && can(user, 'upload') && row.followupAllowed;
  const set = (key, value) => setValues(previous => ({ ...previous, [key]: value }));
  async function save(event) {
    event.preventDefault(); setBusy(true); setError(null);
    try { await api(`/delivery/followups/${encodeURIComponent(row.key)}`, { method: 'PATCH', body: { revision: row.followup?.revision || 0, data: values } }); onSaved(); }
    catch (err) { setError(err); } finally { setBusy(false); }
  }
  return <Modal title={`订单跟进 · ${row.orderNumber || '订单待核对'}`} onClose={() => { if (!busy) onClose(); }} wide><div className="delivery-modal-content"><dl className="delivery-order-facts">{[['供应商', row.supplier], ['产品 / 规格', [row.productName, row.specification].filter(Boolean).join(' / ')], ['物料编码', row.productCode], ['订购数量', `${number(row.quantity)} ${row.unit || ''}`], ['创建时间', date(row.createdDate)], ['交货日期', date(row.dueDate)], ['标签要求', row.labelRequirement], ['收货信息', row.receivingInfo]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{text(value)}</dd></div>)}</dl>
    {row.closed && <Notice>该订单已关闭。历史交付、差额及指标保留，不再产生延期或临期预警。</Notice>}<BatchDetails info={row.batchInfo} /><div className="delivery-event-grid">{Object.entries(STAGES).map(([stage, label]) => <section key={stage}><h3>{label}记录 <span className="delivery-count">{(row[stage]?.events || []).length}</span></h3><div className="delivery-table-wrap"><table className="delivery-table" aria-label={`${label}单据记录`}><thead><tr><th>单据编号 / 关联依据</th><th>交付日期</th><th className="numeric">数量</th><th>来源 / 原始字段</th></tr></thead><tbody>{(row[stage]?.events || []).map((item, index) => <tr key={index}><td>{text(item.documentNumber)}{item.originalSourceNumber && <small>源单 {item.originalSourceNumber}</small>}{item.viaReceiptNumber && <small>经收料单 {item.viaReceiptNumber}</small>}</td><td>{date(item.deliveryDate)}</td><td className="numeric">{number(item.quantity)}</td><td>{item.sourceSheet} · {item.sourceRow}<OriginalFields fields={item.rawFields} /></td></tr>)}</tbody></table>{!(row[stage]?.events || []).length && <p className="delivery-muted delivery-event-empty">{row[stage]?.available ? '暂无可关联记录' : '尚未上传文件'}</p>}</div></section>)}</div>
    {[...(row.reviewReasons || []), ...(row.receipts?.reviewReasons || []), ...(row.inbound?.reviewReasons || [])].length > 0 && <Notice type="warning"><strong>待核对依据</strong><ul>{[...new Set([...(row.reviewReasons || []), ...(row.receipts?.reviewReasons || []), ...(row.inbound?.reviewReasons || [])])].map(reason => <li key={reason}>{reason}</li>)}</ul></Notice>}<h3>生产、发货与一致性核验</h3>{!row.followupAllowed && <Notice type="warning">该订单行无法唯一识别，请先核对订单号、行号和物料信息后再登记跟进。</Notice>}
    <form onSubmit={save}><fieldset disabled={!editable || busy} className="delivery-followup-fields"><div className="delivery-form-grid"><label>生产进度<select value={values.productionStatus} onChange={event => set('productionStatus', event.target.value)}>{['未开始', '生产中', '已完成', '暂停'].map(value => <option key={value}>{value}</option>)}</select></label><label>发货进度<select value={values.shippingStatus} onChange={event => set('shippingStatus', event.target.value)}>{['未发货', '部分发货', '已发货'].map(value => <option key={value}>{value}</option>)}</select></label><label>预计发货日期<input type="date" value={values.expectedShipDate} onChange={event => set('expectedShipDate', event.target.value)} /></label><label>跟进负责人<input maxLength={100} value={values.owner} onChange={event => set('owner', event.target.value)} /></label></div><div className="delivery-check-grid">{[['productCheck', '产品'], ['specificationCheck', '规格'], ['quantityCheck', '数量'], ['labelCheck', '标签'], ['receivingCheck', '收货信息']].map(([key, label]) => <label key={key}>{label}核验<select value={values[key]} onChange={event => set(key, event.target.value)}>{Object.entries(CHECKS).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>)}</div><div className="delivery-form-grid textareas"><label>异常情况<textarea rows={3} maxLength={2000} placeholder="登记延期、错发或核验不一致的情况" value={values.exception} onChange={event => set('exception', event.target.value)} /></label><label>协调措施 / 更正进展<textarea rows={3} maxLength={2000} placeholder="记录处理安排、协调结果及下一步" value={values.action} onChange={event => set('action', event.target.value)} /></label><label className="full">跟进备注<textarea rows={2} maxLength={2000} value={values.note} onChange={event => set('note', event.target.value)} /></label></div></fieldset><p className="delivery-muted">{row.followup?.updatedAt ? `最近更新：${date(row.followup.updatedAt)} · ${row.followup.updatedBy || '—'}` : '尚未保存人工跟进记录。'}</p><ErrorNotice error={error} /><div className="modal-actions"><button type="button" disabled={busy} onClick={onClose}>关闭</button>{editable && <button className="primary" disabled={busy}>{busy ? '正在保存…' : '保存跟进'}</button>}</div></form>
    <details className="delivery-raw"><summary>原始订单字段与来源</summary><p className="delivery-muted">{row.filename} · {row.sourceSheet} · 第 {row.sourceRow} 行</p><dl className="delivery-order-facts">{Object.entries(row.rawFields || {}).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === 'object' && value !== null ? JSON.stringify(value) : text(value)}</dd></div>)}</dl></details></div></Modal>;
}

function DeliveryFiles({ user, onChange }) {
  const [refresh, setRefresh] = useState(0);
  const { data, loading, error } = useResource('/delivery/files', refresh);
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState(null);
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState(null);
  const [selection, setSelection] = useState([]);
  const [history, setHistory] = useState(null);
  const inputs = useRef({});
  const slots = data?.slots || [];
  const changed = () => { setRefresh(value => value + 1); onChange(); };
  async function upload(slot, file) {
    if (!file) return;
    setActionError(null); setMessage('');
    if (!/\.xlsx?$/i.test(file.name) || !file.size || file.size > MAX_UPLOAD_BYTES) { setActionError(new Error('请选择有效的 .xls 或 .xlsx 文件，大小不超过 20 MB。')); if (inputs.current[slot.id]) inputs.current[slot.id].value = ''; return; }
    setBusy(slot.id);
    try { const body = new FormData(); body.append('file', file); const result = await api(`/files/${slot.id}/preview`, { method: 'POST', body }); setPreview({ ...result, slot }); setSelection(result.selectedSheets || []); }
    catch (err) { setActionError(err); } finally { setBusy(''); if (inputs.current[slot.id]) inputs.current[slot.id].value = ''; }
  }
  async function activate() {
    setBusy('activate'); setActionError(null);
    try { await api(`/files/${preview.slot.id}/activate`, { method: 'POST', body: { token: preview.token, baseRevision: preview.baseRevision, selectedSheets: selection } }); setMessage(`${preview.slot.label}已更新，旧版本已保留。`); setPreview(null); changed(); }
    catch (err) { setActionError(err); if (err.status === 409) { setPreview(null); changed(); } } finally { setBusy(''); }
  }
  async function getOriginal(slot) {
    setBusy('download'); setActionError(null);
    try { await download(`/files/${slot.id}/versions/${slot.currentVersionId}/download`, slot.filename); }
    catch (err) { setActionError(err); } finally { setBusy(''); }
  }
  return <div className="delivery-files"><div className="delivery-section-title"><div><h2>交付数据文件</h2><p>三个文件槽位独立更新，原始工作簿与历史版本完整保留。</p></div><button disabled={loading || !!busy} onClick={() => setRefresh(value => value + 1)}>刷新状态</button></div><ErrorNotice error={error || (!preview ? actionError : null)} /><Notice type="success">{message}</Notice>{loading ? <Loading /> : <div className="delivery-file-grid">{slots.map((slot, index) => <section className="delivery-panel delivery-file-card" key={slot.id}><div className="delivery-file-title"><span>{String(index + 1).padStart(2, '0')}</span><div><h2>{slot.label}</h2><small>{slot.currentVersionId ? '已有有效文件' : '等待上传'}</small></div></div><p>{FILE_DESCRIPTIONS[slot.id]}</p>{slot.currentVersionId ? <><div className="delivery-file-name">{slot.filename}</div><dl className="delivery-file-meta"><div><dt>上传人</dt><dd>{text(slot.uploadedBy)}</dd></div><div><dt>上传日期</dt><dd>{date(slot.uploadedAt)}</dd></div><div><dt>读取记录</dt><dd>{number(slot.recordCount)} 条</dd></div><div><dt>待核对</dt><dd>{number(slot.issueCount)} 项</dd></div></dl></> : <div className="delivery-file-empty"><PackageIcon /><span>选择金蝶导出的 Excel 工作簿</span><small>.xls / .xlsx · 最大 20 MB</small></div>}<div className="delivery-file-actions">{can(user, 'upload') && <><input type="file" accept=".xls,.xlsx" className="sr-only" aria-label={`上传${slot.label}`} ref={node => { inputs.current[slot.id] = node; }} onChange={event => upload(slot, event.target.files[0])} /><button className="primary" disabled={!!busy} onClick={() => inputs.current[slot.id]?.click()}>{busy === slot.id ? '正在读取…' : slot.currentVersionId ? '上传新版本' : '上传文件'}</button></>}{can(user, 'download') && slot.currentVersionId && <button disabled={!!busy} onClick={() => getOriginal(slot)}>下载原文件</button>}<button disabled={!!busy || !slot.currentVersionId} onClick={() => setHistory(slot)}>版本记录</button></div></section>)}</div>}
    <section className="delivery-panel delivery-file-guide"><h2>上传与关联说明</h2><ol><li>先上传采购订单，再上传收料通知单和采购入库单；每个槽位上传的是当前完整数据。</li><li>采购订单的“单据编号”分别对应收料通知单和采购入库单的“源单单号”，兼容实际文件中的“源单编号”。入库也支持经收料通知单唯一追溯采购订单；同单多物料或多交期结合物料、行号等字段核对。</li><li>采购订单的“采购日期”按确认约定作为创建时间。系统按表头名称识别字段，列位置可以调整，可增删非必需列；新增列保留在原始字段中。必需列缺失或含糊时提示核对，不自行猜测。</li><li>确认预览中的工作表和字段映射后保存；校验失败时，现有有效数据保持不变。收料与入库分别统计，缺失日期、数量、物料或关联冲突会提示核对，不自动补齐业务值。上传及恢复历史版本后，看板按当前有效文件重新计算。</li></ol></section>
    {preview && <Modal title={`预览并确认 · ${preview.slot.label}`} onClose={() => { if (!busy) { setPreview(null); setActionError(null); } }} wide><div className="delivery-modal-content"><p className="delivery-file-name">{preview.filename}</p><Notice>检查需要读取的工作表与字段映射，确认后替换当前有效文件。原始文件和旧版本均保留。</Notice><fieldset className="delivery-sheet-picker"><legend>读取工作表</legend>{(preview.sheets || []).map(sheet => <div className="delivery-sheet" key={sheet.name}><label className="check-row"><input type="checkbox" checked={selection.includes(sheet.name)} disabled={!sheet.eligible || !!busy} onChange={event => setSelection(previous => event.target.checked ? [...previous, sheet.name] : previous.filter(name => name !== sheet.name))} /><span><strong>{sheet.name}</strong><small>{sheet.reason || (sheet.defaultSelected ? '默认读取' : '可选择读取')}</small></span></label>{sheet.mapping && <details><summary>查看字段映射</summary><dl className="delivery-mapping">{Object.entries(sheet.mapping).map(([key, value]) => <div key={key}><dt>{FIELD_NAMES[key] || key}</dt><dd>{typeof value === 'object' && value !== null ? value.header || value.name || JSON.stringify(value) : String(value)}</dd></div>)}</dl></details>}</div>)}</fieldset><div className="delivery-preview-summary"><span>默认读取 <strong>{number(preview.recordCount)}</strong> 条</span><span>待核对 <strong>{number(preview.issueCount)}</strong> 项</span><small>更改工作表后，以保存时重新校验结果为准。</small></div>{preview.validationError && <Notice type="warning">{typeof preview.validationError === 'string' ? preview.validationError : preview.validationError.message}</Notice>}<ErrorNotice error={actionError} />{!!preview.issues?.length && <details><summary>查看默认工作表待核对事项</summary><IssueTable issues={preview.issues} /></details>}<div className="modal-actions"><button disabled={!!busy} onClick={() => { setPreview(null); setActionError(null); }}>取消</button><button className="primary" disabled={!!busy || !selection.length} onClick={activate}>{busy === 'activate' ? '正在校验并保存…' : '校验并替换'}</button></div></div></Modal>}
    {history && <FileHistory slot={slots.find(slot => slot.id === history.id) || history} user={user} onClose={() => setHistory(null)} onRestored={() => { setMessage(`${history.label}已恢复所选版本。`); changed(); }} />}
  </div>;
}

function FileHistory({ slot, user, onClose, onRestored }) {
  const [refresh, setRefresh] = useState(0);
  const { data, loading, error } = useResource(`/files/${slot.id}/versions`, refresh);
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState(null);
  const [detail, setDetail] = useState(null);
  const [restore, setRestore] = useState(null);
  async function action(version, type) {
    setBusy(type); setActionError(null);
    try {
      if (type === 'download') await download(`/files/${slot.id}/versions/${version.id}/download`, version.filename);
      if (type === 'view') setDetail(await api(`/files/${slot.id}/versions/${version.id}`));
      if (type === 'restore') { await api(`/files/${slot.id}/restore`, { method: 'POST', body: { versionId: version.id, baseRevision: slot.revision } }); setRestore(null); setDetail(null); setRefresh(value => value + 1); onRestored(); }
    } catch (err) { setActionError(err); } finally { setBusy(''); }
  }
  return <Modal title={`${slot.label} · 版本记录`} onClose={() => { if (!busy) onClose(); }} wide><div className="delivery-modal-content"><ErrorNotice error={error || actionError} />{loading ? <Loading /> : <div className="delivery-table-wrap"><table className="delivery-table" aria-label="交付文件版本记录"><thead><tr><th>文件名称</th><th>上传人</th><th>上传日期</th><th>记录数</th><th>核对项</th><th>操作</th></tr></thead><tbody>{(data?.versions || []).map(version => <tr key={version.id}><td>{version.filename}{version.current && <span className="delivery-current">当前有效</span>}</td><td>{text(version.uploadedBy)}</td><td>{date(version.uploadedAt)}</td><td>{number(version.recordCount)}</td><td>{number(version.issueCount)}</td><td><div className="delivery-actions"><button disabled={!!busy} onClick={() => action(version, 'view')}>查看</button>{can(user, 'download') && <button disabled={!!busy} onClick={() => action(version, 'download')}>下载</button>}{can(user, 'restore') && !version.current && <button disabled={!!busy} onClick={() => setRestore(version)}>恢复</button>}</div></td></tr>)}</tbody></table></div>}{restore && <div className="delivery-restore-confirm"><p>将“{restore.filename}”（{date(restore.uploadedAt)}）恢复为当前有效版本？当前版本仍保留在历史记录中。</p><div className="delivery-actions"><button disabled={!!busy} onClick={() => setRestore(null)}>取消</button><button className="primary" disabled={!!busy} onClick={() => action(restore, 'restore')}>确认恢复</button></div></div>}{busy && <Loading />}{detail && <section className="delivery-history-detail"><div className="delivery-panel-heading"><h3>{detail.version?.filename}</h3><button onClick={() => setDetail(null)}>收起</button></div><p className="delivery-muted">此处为所选历史文件原始解析记录，不改变当前看板。</p><RawRecordTable records={detail.records || []} /><details><summary>历史文件待核对事项（{detail.issues?.length || 0}）</summary><IssueTable issues={detail.issues || []} /></details></section>}</div></Modal>;
}

function RawRecordTable({ records }) {
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [records]);
  const fields = ['orderNumber', 'documentNumber', 'lineNumber', 'sourceLineNumber', 'supplier', 'productCode', 'productName', 'specification', 'unit', 'quantity', 'createdDate', 'dueDate', 'deliveryDate'];
  return !records.length ? <Empty title="该工作簿暂无读取记录" /> : <><div className="delivery-table-wrap"><table className="delivery-table" aria-label="历史交付文件明细"><thead><tr>{fields.map(key => <th key={key}>{FIELD_NAMES[key]}</th>)}<th>来源 / 原始字段</th></tr></thead><tbody>{records.slice((page - 1) * 20, page * 20).map((row, index) => <tr key={index}>{fields.map(key => <td key={key}>{key.endsWith('Date') ? date(row[key]) : key === 'quantity' ? number(row[key]) : text(row[key])}</td>)}<td>{row.sourceSheet} · {row.sourceRow}<OriginalFields fields={row.rawFields} /></td></tr>)}</tbody></table></div><Pager page={page} total={records.length} size={20} onChange={setPage} /></>;
}

function OriginalFields({ fields }) {
  if (!fields || !Object.keys(fields).length) return null;
  return <details className="delivery-original-fields"><summary>原始字段</summary><dl>{Object.entries(fields).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === 'object' && value !== null ? JSON.stringify(value) : text(value)}</dd></div>)}</dl></details>;
}

function QuantityBreakdown({ rows, kind, label }) {
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [rows]);
  return <details className={`delivery-quantity-breakdown ${kind}`}><summary>{label}数量明细 <span className="delivery-count">{rows.length}</span><span>按物料、单位分别汇总</span></summary><div className="delivery-table-wrap"><table className="delivery-table" aria-label={`${label}按物料交付数量`}><thead><tr><th>物料编码</th><th>产品名称</th><th>单位</th><th className="numeric">订购数量</th><th className="numeric">已{label}数量</th><th className="numeric">未{label}数量</th><th className="numeric">数量完成率</th></tr></thead><tbody>{rows.slice((page - 1) * 20, page * 20).map(item => <tr key={`${item.productCode}|${item.unit}`}><td>{text(item.productCode)}</td><td>{text(item.productName)}</td><td>{item.unit || '同物料默认单位'}</td><td className="numeric">{number(item.orderedQuantity)}</td><td className="numeric">{number(item.deliveredQuantity)}</td><td className="numeric">{number(item.outstandingQuantity)}</td><td className="numeric">{percent(item.quantityRate)}</td></tr>)}</tbody></table></div><Pager page={page} total={rows.length} size={20} onChange={setPage} /></details>;
}

function DataIssues({ issues, outsideScopeCount }) {
  return <section className="delivery-panel delivery-issues"><details><summary>待核对事项 <span className="delivery-count">{issues.length}</span></summary><p className="delivery-muted">单据关联不唯一、数量或日期异常的记录，请结合原文件核对。以下核对列表覆盖全部来源，不随订单筛选隐藏。</p><IssueTable issues={issues} /></details>{outsideScopeCount > 0 && <OutsideScopeIssues count={outsideScopeCount} />}</section>;
}

function OutsideScopeIssues({ count }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const { data, loading, error } = useResource(open ? `/delivery/outside-scope?page=${page}&pageSize=20` : null);
  return <details className="delivery-outside-scope" onToggle={event => { setOpen(event.currentTarget.open); if (!event.currentTarget.open) setPage(1); }}><summary>当前订单范围外的历史交付 <span className="delivery-count">{count}</span></summary>{open && <><p className="delivery-muted">这些交付单据对应的采购订单不在当前采购订单文件中，暂不参与本次订单指标。这是数据范围提示，不代表交付单据本身错误。列表覆盖全部来源，不随订单筛选变化；展开后按页加载。</p><ErrorNotice error={error} />{loading ? <Loading /> : data && <IssueTable issues={data.items || []} pagination={{ page: data.page, total: data.total, pageSize: data.pageSize, onChange: setPage }} />}</>}</details>;
}

function BatchSummary({ info, onClick }) {
  if (!info) return '—';
  return <div className="delivery-batch-summary"><strong>{info.isSplit ? '存在分批' : '暂无分批'}</strong><small>计划 {number(info.plannedCount)} 批 · 收料 {number(info.receiptCount)} 批 · 入库 {number(info.inboundCount)} 批</small><button className="text-button" onClick={onClick}>{info.allocationPending ? '待匹配 · 查看组内批次' : '查看每批日期与数量'}</button></div>;
}

function BatchDetails({ info }) {
  if (!info) return null;
  return <section className="delivery-batch-detail"><div className="delivery-panel-heading"><div><h3>分批交付记录</h3><p>{info.isSplit ? '存在多批计划或交付记录' : '当前尚未出现多批计划或交付记录'} · 计划 {number(info.plannedCount)} 批 / 收料 {number(info.receiptCount)} 批 / 入库 {number(info.inboundCount)} 批</p></div></div>{info.shared && <Notice type={info.allocationPending ? 'warning' : 'info'}>{info.allocationPending ? '以下是同一采购订单、同一物料组的批次依据，尚不能唯一分配到当前交期行。数量仅供核对，不重复计入每个订单行，也不自动按先后顺序分摊。' : '以下按同一采购订单、同一物料组展示计划与交付批次；各订单行的统计仍以实际关联结果为准。'}</Notice>}<div className="delivery-batch-grid">{[['plannedBatches', '计划交货批次'], ['receiptBatches', '收料交付批次'], ['inboundBatches', '入库交付批次']].map(([key, title]) => <BatchTable key={key} title={title} rows={info[key] || []} planned={key === 'plannedBatches'} />)}</div></section>;
}

function BatchTable({ title, rows, planned }) {
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [rows]);
  return <section><h4>{title} <span className="delivery-count">{rows.length}</span></h4>{!rows.length ? <p className="delivery-muted">暂无批次记录</p> : <><div className="delivery-table-wrap"><table className="delivery-table" aria-label={title}><thead><tr><th>批次 / 日期</th><th className="numeric">数量</th><th>{planned ? '计划依据' : '单据 / 关联情况'}</th></tr></thead><tbody>{rows.slice((page - 1) * 10, page * 10).map((batch, index) => <tr key={`${batch.date}-${batch.documentNumber}-${index}`}><td>第 {(page - 1) * 10 + index + 1} 批<small>{date(batch.date)}</small></td><td className="numeric">{number(batch.quantity)}{batch.review && <small className="delivery-coral-text">待核对</small>}</td><td>{planned ? `${number(batch.lineCount)} 条计划行` : text(batch.documentNumber)}{!planned && batch.allocated === false && <small>尚未分配到当前行</small>}{!!batch.sourceRows?.length && <details><summary>查看来源</summary>{batch.sourceRows.map((source, sourceIndex) => <small key={sourceIndex}>{source.sourceSheet} · 第 {source.sourceRow} 行</small>)}</details>}{!!batch.reviewReasons?.length && <small className="delivery-coral-text">{batch.reviewReasons.join('；')}</small>}</td></tr>)}</tbody></table></div>{rows.length > 10 && <Pager page={page} total={rows.length} size={10} onChange={setPage} />}</>}</section>;
}
