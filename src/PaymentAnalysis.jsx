import { Fragment, useEffect, useState } from 'react';
import { download, queryString, useResource } from './api.js';
import { can, moneyInWan, money } from './format.js';
import { Empty, ErrorNotice, Loading, Modal, Notice, Pager } from './components.jsx';
import './payment-analysis.css';

function Download({ path, user }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(null);
  if (!can(user, 'export')) return null;
  return <span><button disabled={busy} onClick={async () => { setBusy(true); setError(null); try { await download(path, '资金付款分析.xlsx'); } catch (err) { setError(err); } finally { setBusy(false); } }}>{busy ? '下载中…' : '下载 Excel'}</button><ErrorNotice error={error} /></span>;
}
function Evidence({ record, oa = false }) {
  const rows = oa ? [
    ['摘要', record.summary], ['流程状态 / 当前节点', [record.status, record.currentNode].filter(Boolean).join(' / ')],
    ['币种 / 原币金额', `${record.currency || '—'} / ${record.originalAmountCents == null ? '—' : money(record.originalAmountCents)}`],
    ['判断汇率', record.exchangeRate], ['签字原文', record.signature],
    ['重复来源核对', record.conflict ? '同号关键内容不同，暂不计入 OA 付款统计。' : '同号重复明细仅计一次。'],
    ['冲突来源内容', record.conflicts?.map(r => `${r.sourceSheet}!第${r.sourceRow}行 · ${r.supplier} · ${r.payer} · ${r.currency} · 人民币金额 ${money(r.amountCents)} 元\n${r.signature}`).join('\n\n')],
  ] : [
    ['依据说明', record.annotation || record.basis], ['付款批注', record.comment], ['谈判明细及备注', record.notes],
    ['OA 人民币金额', record.oaAmountCents == null ? '—' : `${money(record.oaAmountCents)} 元（整笔金额，不重复计入）`],
    ['币种 / 原币金额', `${record.currency || '—'} / ${record.originalAmountCents == null ? '—' : money(record.originalAmountCents)}`],
    ['判断汇率', record.exchangeRate], ['OA 签字原文', record.signature], ['OA 文件 / 版本', [record.oaFilename, record.oaVersionId].filter(Boolean).join(' / ')],
  ];
  rows.push(['来源文件 / 版本', [record.filename, record.versionId].filter(Boolean).join(' / ')],
    ['原表位置', `${record.sourceSheet || ''} · 第 ${record.sourceRow || '—'} 行 ${record.sourceCell || ''}`],
    ['OA 明细来源行', (record.oaSources || record.sources || []).map(r => `${r.sourceSheet}!第${r.sourceRow}行`).join('、')]);
  return <table className="analysis-evidence"><tbody>{rows.filter(([, value]) => value).map(([label, value]) => <tr key={label}><th>{label}</th><td>{value}</td></tr>)}</tbody></table>;
}
export function PaymentLedger({ records = [] }) {
  const [page, setPage] = useState(1), [expanded, setExpanded] = useState(null);
  useEffect(() => { setPage(1); setExpanded(null); }, [records]);
  if (!records.length) return <Empty title="当前范围暂无已确认付款" />;
  return <><div className="table-wrap analysis-table"><table><thead><tr>{['付款日期', '供应商', '付款主体', 'OA流程编号', '摘要', '本次付款（万元）', '付款依据', '详情'].map(s => <th key={s}>{s}</th>)}</tr></thead><tbody>{records.slice((page - 1) * 20, page * 20).map(r => <Fragment key={r.id}><tr>
    <td className="nowrap">{r.paymentDate}</td><td>{r.supplier || '—'}</td><td>{r.payer || '—'}</td><td>{r.flowCode || '—'}</td><td>{r.summary || '—'}</td><td className="numeric">{moneyInWan(r.amountCents)}</td><td>{r.basis}{r.annotation && <small>{r.annotation}</small>}</td><td><button className="text-button" onClick={() => setExpanded(expanded === r.id ? null : r.id)}>{expanded === r.id ? '收起依据' : '查看依据'}</button></td>
  </tr>{expanded === r.id && <tr><td colSpan={8}><Evidence record={r} /></td></tr>}</Fragment>)}</tbody></table></div><Pager page={page} onChange={setPage} total={records.length} /></>;
}
export function OaRows({ records = [] }) {
  const [page, setPage] = useState(1), [expanded, setExpanded] = useState(null);
  useEffect(() => { setPage(1); setExpanded(null); }, [records]);
  if (!records.length) return <Empty title="暂无匹配的 OA 流程" />;
  return <><div className="table-wrap analysis-table"><table><thead><tr>{['流程编号', '供应商', '付款主体', '人民币金额（万元）', 'OA执行状态', '最晚出纳执行日期', '详情'].map(s => <th key={s}>{s}</th>)}</tr></thead><tbody>{records.slice((page - 1) * 20, page * 20).map(r => <Fragment key={r.key}><tr>
    <td>{r.flowCode || '—'}</td><td>{r.supplier || '—'}</td><td>{r.payer || '—'}</td><td>{moneyInWan(r.amountCents)}</td><td>{r.conflict || r.amountCents == null || !r.flowKey ? '待核对' : r.paymentDate ? '出纳已执行' : '无有效执行日期'}</td><td className="nowrap">{r.paymentDate || '—'}</td><td><button className="text-button" onClick={() => setExpanded(expanded === r.key ? null : r.key)}>{expanded === r.key ? '收起' : '查看依据'}</button></td>
  </tr>{expanded === r.key && <tr><td colSpan={7}><Evidence record={r} oa /></td></tr>}</Fragment>)}</tbody></table></div><Pager page={page} onChange={setPage} total={records.length} /></>;
}
export function OaFlows({ user, refresh }) {
  const [filters, setFilters] = useState({ supplier: '', flowCode: '', paymentState: '' });
  const query = queryString(filters), { data, loading, error } = useResource(`/oa-flows?${query}`, refresh);
  return <section className="panel"><div className="section-heading"><h2>全部对公付款流程</h2><Download user={user} path={`/oa-flows/export?${query}`} /></div><div className="analysis-filters">
    <label>供应商<input placeholder="搜索供应商" value={filters.supplier} onChange={e => setFilters({ ...filters, supplier: e.target.value })} /></label>
    <label>流程编号<input placeholder="搜索流程编号" value={filters.flowCode} onChange={e => setFilters({ ...filters, flowCode: e.target.value })} /></label>
    <label>OA执行状态<select value={filters.paymentState} onChange={e => setFilters({ ...filters, paymentState: e.target.value })}><option value="">全部</option><option value="paid">出纳已执行</option><option value="unpaid">无出纳执行记录</option><option value="review">待核对</option></select></label>
  </div><p className="scope-note">本表显示 OA 原始执行情况；资金付款分析对谈判表匹配流程优先采用分期批注。</p><ErrorNotice error={error} />{loading ? <Loading /> : data && <OaRows records={data.records} />}</section>;
}

function Trend({ data, onSelect }) {
  const values = data.monthly.flatMap(r => [r.currentCents, r.previousCents]).filter(v => v != null);
  const min = Math.min(0, ...values), max = Math.max(1, ...values), range = max - min;
  const y = v => 65 + (max - v) / range * 175, zero = y(0);
  return <section className="panel"><div className="section-heading"><h2>月度付款对比</h2><span className="muted"><i className="analysis-dot current" />{data.year}<i className="analysis-dot previous" />{data.year - 1} · 万元</span></div>
    <div className="analysis-chart"><svg viewBox="0 0 1080 280" role="img" aria-label="本年与上年同期每月实际付款金额对比">
      {[0, .5, 1].map(f => <line key={f} x1="10" x2="1070" y1={65 + f * 175} y2={65 + f * 175} stroke="#e6ecf1" />)}
      {data.monthly.map((r, i) => <g key={r.month}>{[['currentCents', r.currentMonth, -17, '#24b5bc'], ['previousCents', r.previousMonth, 17, '#7a9fe5']].map(([field, month, offset, color]) => {
        const value = r[field], x = 45 + i * 90 + offset, py = value == null ? zero : y(value);
        return <g key={field} role={value == null ? undefined : 'button'} tabIndex={value == null ? undefined : 0} aria-label={`${month}付款 ${value == null ? '无数据' : moneyInWan(value) + '万元'}`} onClick={() => value !== null && onSelect(month)} onKeyDown={e => { if (value !== null && ['Enter', ' '].includes(e.key)) { e.preventDefault(); onSelect(month); } }} style={{ cursor: value === null ? 'default' : 'pointer' }}>
          <title>{month}：{value == null ? '暂无数据或未到统计期间' : `${money(value)} 元`}</title>
          {value !== null && <rect x={x - 12} y={Math.min(py, zero)} width="24" height={Math.max(value === 0 ? 0 : 1, Math.abs(py - zero))} rx="3" fill={color} />}
          <text x={x} y={value != null && value < 0 ? py + 15 : py - 9} textAnchor="middle" fontSize="10" fill={color}>{value === null ? '' : moneyInWan(value)}</text>
        </g>;
      })}<text x={45 + i * 90} y="272" textAnchor="middle" fontSize="13" fill="#687588">{Number(r.month)}月</text></g>)}
    </svg></div><p className="scope-note">本期截至 {data.currentEnd}，上年同期截至 {data.priorEnd}。点击柱形查看对应月份明细。{!data.previousAvailable && ' 暂无上年付款数据。'}</p></section>;
}
function Drilldown({ filters, detail, user, refresh, onClose }) {
  const [search, setSearch] = useState('');
  const query = queryString({ ...filters, ...detail, supplierSearch: search });
  const { data, loading, error } = useResource(`/payment-analysis?${query}`, refresh);
  return <Modal title={detail.detailMonth ? `${detail.detailMonth} · 付款明细` : `${detail.detailSupplier || '未填写供应商'} · 付款明细`} onClose={onClose} wide actions={<Download user={user} path={`/payment-analysis/export?${query}`} />}>
    <div className="analysis-filters"><label>供应商搜索<input placeholder="输入供应商名称" value={search} onChange={e => setSearch(e.target.value)} /></label><strong>合计 {moneyInWan(data?.detailTotalCents)} 万元</strong></div>
    <ErrorNotice error={error} />{loading ? <Loading /> : data && <PaymentLedger records={data.records} />}
  </Modal>;
}
export default function PaymentAnalysis({ user }) {
  const currentYear = new Intl.DateTimeFormat('en', { year: 'numeric', timeZone: 'Asia/Shanghai' }).format(new Date());
  const [filters, setFilters] = useState({ year: currentYear, supplier: '', payer: '' });
  const [refresh, setRefresh] = useState(0), [detail, setDetail] = useState(null);
  const query = queryString(filters), { data, error, loading } = useResource(`/payment-analysis?${query}`, refresh);
  const versions = Object.values(data?.versions || {}).filter(Boolean);
  const updated = versions.map(v => v.uploadedAt).sort().at(-1);
  return <div className="page-stack payment-analysis">
    <div className="page-heading"><div><h1>资金付款分析</h1><p className="subtitle">实际付款 · 按当前上传数据统计{updated ? ` · 数据截至 ${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(updated))}` : ''}</p></div><div className="row-actions"><button disabled={loading} onClick={() => setRefresh(v => v + 1)}>刷新</button><Download user={user} path={`/payment-analysis/export?${query}`} /></div></div>
    <section className="panel analysis-filters"><label>年份<select value={filters.year} onChange={e => setFilters({ ...filters, year: e.target.value })}>{[...new Set([+currentYear, +currentYear - 1, +currentYear - 2, ...(data?.years || [])])].sort((a, b) => b - a).map(y => <option key={y} value={y}>{y}年</option>)}</select></label>
      <label>供应商<input placeholder="搜索供应商名称" value={filters.supplier} onChange={e => setFilters({ ...filters, supplier: e.target.value })} /></label>
      <label>付款主体<select value={filters.payer} onChange={e => setFilters({ ...filters, payer: e.target.value })}><option value="">全部主体</option>{data?.payers.map(payer => <option key={payer}>{payer}</option>)}</select></label>
      {(filters.supplier || filters.payer) && <button className="text-button" onClick={() => setFilters({ ...filters, supplier: '', payer: '' })}>清空筛选</button>}
    </section>
    <ErrorNotice error={error} />{loading ? <Loading /> : data && <>
      {(!data.versions.oa || !data.versions.schedule) && <Notice>当前尚未上传{!data.versions.oa ? '对公付款OA流程' : '付款节奏'}，以下只统计已有文件中可确认的付款。</Notice>}
      <div className="analysis-cards"><section><span>{data.year}年已付</span><strong>{moneyInWan(data.summary.currentCents)}<small>万元</small></strong></section><section><span>{data.year - 1}年同期已付</span><strong>{data.previousAvailable ? moneyInWan(data.summary.previousCents) : '暂无数据'}<small>{data.previousAvailable ? '万元' : ''}</small></strong></section><section><span>同比增减</span><strong>{data.summary.changePercent === null ? '—' : `${data.summary.changePercent > 0 ? '+' : ''}${data.summary.changePercent.toFixed(2)}%`}</strong><small>{data.summary.previousCents === 0 ? '上年同期金额为零' : data.summary.changeCents === null ? '暂无同期数据' : `增减 ${moneyInWan(data.summary.changeCents)} 万元`}</small></section></div>
      <Trend data={data} onSelect={detailMonth => setDetail({ detailMonth })} />
      <section className="panel"><div className="section-heading"><h2>付款供应商 Top10</h2><span className="muted">万元</span></div>{data.top10.length ? <div className="table-wrap"><table className="analysis-top"><thead><tr><th>排名</th><th>供应商</th><th>已付金额</th><th>付款笔数</th></tr></thead><tbody>{data.top10.map((r, i) => <tr key={r.supplier}><td>{i + 1}</td><td><button className="text-button" onClick={() => setDetail({ detailSupplier: r.supplier })}>{r.supplier || '未填写供应商'}</button></td><td>{moneyInWan(r.amountCents)}</td><td>{r.count}</td></tr>)}</tbody></table></div> : <Empty title="当前范围暂无已确认付款" />}</section>
      <section className="panel"><div className="section-heading"><h2>资金付款台账</h2><Download user={user} path={`/payment-analysis/export?${query}`} /></div><p className="scope-note">共 {data.records.length} 笔 · 合计 {moneyInWan(data.detailTotalCents)} 万元</p><PaymentLedger records={data.records} /></section>
      <details className="panel"><summary>待核对 {data.issues.length} 项</summary><p className="scope-note">已确认金额照常统计；以下事项含日期未定记录及来源冲突，跟随供应商和付款主体筛选。</p>{data.issues.length ? <div className="table-wrap"><table><thead><tr><th>供应商</th><th>流程编号</th><th>需要核对</th><th>原表位置</th></tr></thead><tbody>{data.issues.map((r, i) => <tr key={i}><td>{r.supplier || '—'}</td><td>{r.flowCode || '—'}</td><td>{r.message}</td><td>{r.filename} · {r.sourceSheet} · 第{r.sourceRow}行 {r.sourceCell}</td></tr>)}</tbody></table></div> : <p>暂无待核对事项</p>}</details>
    </>}
    {detail && <Drilldown filters={filters} detail={detail} user={user} refresh={refresh} onClose={() => setDetail(null)} />}
  </div>;
}
