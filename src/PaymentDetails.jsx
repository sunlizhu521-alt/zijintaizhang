import { Fragment, useEffect, useMemo, useState } from 'react';
import { CATEGORIES } from '../shared/constants.js';
import { paymentPlanTotals } from '../server/payment-table.js';
import { Empty, Pager } from './components.jsx';
import { money, moneyInWan, monthText } from './format.js';
import './payment-details.css';

const measures = [['totalCents', '计划金额'], ['paidCents', '已付'], ['unpaidCents', '未付']];
const display = value => value == null || value === '' ? '未提供' : (typeof value === 'object' ? JSON.stringify(value) : String(value)).replace(/(\d{4}-\d{2}-\d{2})T00:00:00(?:\.000)?Z/g, '$1');
function Amount({ value }) {
  return value == null ? <span className="pd-uncertain">待核对</span> : <span className="pd-amount"><span className="pd-value-full">{money(value)}</span><span className="pd-value-compact">{money(value).replaceAll(',', '')}</span><small>{moneyInWan(value)} 万</small></span>;
}
function FieldsTable({ label, fields }) {
  return <table className="pd-fields-table" aria-label={label}><tbody>{fields.map(([title, value], index) => <tr key={index}><th scope="row">{title}</th><td>{display(value)}</td></tr>)}</tbody></table>;
}
function Evidence({ record, plan }) {
  return <div className="pd-evidence">
    <FieldsTable label="付款判定与来源" fields={[
      ['付款时间', plan.paymentDates?.length ? plan.paymentDates.join('、') : '未提供'], ['判定依据', plan.paymentBasis],
      ['供应商 / 付款主体', `${record.supplier || '未提供'} / ${record.payer || '未提供'}`],
      ['类别 / 跟单员', `${CATEGORIES[record.category] || '未提供'} / ${record.owner || '未提供'}`],
      ['摘要', record.summary], ['流程号', record.flowCode], ['付款申请状态', record.applicationStatus], ['流程状态', record.status],
      ['来源文件', record.filename], ['原表位置', `${record.sourceSheet} · 第 ${record.sourceRow} 行${plan.sourceCell ? ` · ${plan.sourceCell}` : ''}`],
      ['备注', record.notes],
      ...(plan.paymentProgressVersion ? [['付款依据版本', `${plan.paymentProgressVersion.filename} · ${plan.paymentProgressVersion.id?.slice(0, 8) || ''}`]] : []),
    ]} />
    {plan.paymentEvidence?.map((evidence, index) => <FieldsTable key={index} label={`第${index + 1}条付款依据`} fields={[
      [`依据 ${index + 1} 位置`, `${evidence.sourceSheet || record.sourceSheet || ''}${evidence.sourceRow ? ` · 第 ${evidence.sourceRow} 行` : ''}${evidence.sourceCell ? ` · ${evidence.sourceCell}` : ''}`],
      ['依据金额', evidence.amountCents == null ? '未提供' : `${money(evidence.amountCents)} 元`],
      ...(evidence.paymentDates?.length ? [['付款日期', evidence.paymentDates.join('、')]] : []),
      ...(evidence.status != null ? [['是否已付款', evidence.status || '空白']] : []),
      ...(evidence.flowCode ? [['流程号', evidence.flowCode]] : []),
      ...(evidence.comment ? [['批注原文', evidence.comment]] : []),
    ]} />)}
    {record.raw && <details><summary>查看原始字段</summary><FieldsTable label="原始字段" fields={Object.entries(record.raw)} /></details>}
    {record.comments && Object.keys(record.comments).length > 0 && <details><summary>查看全部单元格批注</summary><FieldsTable label="全部单元格批注" fields={Object.entries(record.comments)} /></details>}
  </div>;
}

export default function PaymentDetails({ records = [], measure = 'totalCents' }) {
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState(null);
  const rows = useMemo(() => records.flatMap((record, recordIndex) => (record.selectedPlans ?? record.plans ?? []).map((plan, planIndex) => ({ record, plan, id: `${recordIndex}-${planIndex}` }))), [records]);
  const totals = useMemo(() => paymentPlanTotals(rows.map(row => row.plan)), [rows]);
  useEffect(() => { setPage(1); setExpanded(null); }, [records, measure]);
  const selectedLabel = measures.find(([key]) => key === measure)?.[1] || '计划金额';
  const amountClass = key => `pd-money${measure === key ? ' pd-selected' : ''}`;
  if (!rows.length) return <Empty title="暂无付款明细" />;
  function detailButton(row) {
    const open = expanded === row.id;
    return <button className="text-button" aria-expanded={open} aria-label={`${open ? '收起' : '查看'}${row.record.supplier || '该供应商'}${monthText(row.plan.month)}第${row.record.sourceRow}行付款依据`} onClick={() => setExpanded(open ? null : row.id)}>{open ? '收起依据' : '查看依据'}</button>;
  }
  return <div className="payment-drilldown">
    <p className="pd-summary">共 {rows.length} 笔<strong>{selectedLabel}：{totals[measure] == null ? '待核对' : `${money(totals[measure])} 元（${moneyInWan(totals[measure])} 万元）`}</strong></p>
    <p className="pd-note">单位：元；小字为万元。</p>
    <table className="pd-table" aria-label="汇总金额对应明细">
      <thead><tr><th scope="col" className="pd-supplier">供应商<span className="pd-compact"> / 月份</span></th><th scope="col" className="pd-extra pd-payer">付款主体</th><th scope="col" className="pd-extra pd-category">类别</th><th scope="col" className="pd-extra pd-month">月份</th><th scope="col" className="pd-extra pd-description">摘要</th>{measures.map(([key, label]) => <th scope="col" className={amountClass(key)} key={key}>{label}{measure === key && <span className="sr-only">（当前查看列）</span>}</th>)}<th scope="col" className="pd-extra pd-action">详情</th></tr></thead>
      <tbody>{rows.slice((page - 1) * 20, page * 20).map(row => <Fragment key={row.id}>
        <tr className={expanded === row.id ? 'pd-expanded-row' : undefined}>
          <th scope="row" className="pd-supplier">{row.record.supplier || '未填写'}<small>跟单员：{row.record.owner || '未填写'}</small><span className="pd-compact">{monthText(row.plan.month)}<br />{CATEGORIES[row.record.category]}<br />{detailButton(row)}</span></th>
          <td className="pd-extra">{row.record.payer || '—'}</td><td className="pd-extra">{CATEGORIES[row.record.category]}</td><td className="pd-extra">{monthText(row.plan.month)}</td><td className="pd-extra pd-description">{row.record.summary || '—'}</td>
          {measures.map(([key]) => <td key={key} className={amountClass(key)}><Amount value={row.plan[key === 'totalCents' ? 'amountCents' : key]} /></td>)}
          <td className="pd-extra">{detailButton(row)}</td>
        </tr>
        {expanded === row.id && <tr className="pd-evidence-row"><td colSpan={9}><Evidence record={row.record} plan={row.plan} /></td></tr>}
      </Fragment>)}</tbody>
      <tfoot><tr><th colSpan={5} scope="row" className="pd-extra">全部合计（{rows.length} 笔）</th><th scope="row" className="pd-compact">全部合计<br />{rows.length} 笔</th>{measures.map(([key]) => <td key={key} className={amountClass(key)}><Amount value={totals[key]} /></td>)}<td className="pd-extra" /></tr></tfoot>
    </table>
    <Pager page={page} total={rows.length} onChange={value => { setPage(value); setExpanded(null); }} />
  </div>;
}
