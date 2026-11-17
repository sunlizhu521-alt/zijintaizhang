import { Fragment, useEffect, useMemo, useState } from 'react';
import { CATEGORIES } from '../shared/constants.js';
import { paymentTableTotals } from '../server/payment-table.js';
import { Empty, Pager } from './components.jsx';
import { moneyInWan, monthText } from './format.js';
import { supplierRecordDetails } from './supplier-data.js';
import './payment-details.css';

const measures = [['totalCents', '总金额'], ['paidCents', '已付'], ['unpaidCents', '未付'], ['unappliedUnpaidCents', '未提交申请单金额']];
const display = value => value == null || value === '' ? '—' : (typeof value === 'object' ? JSON.stringify(value) : String(value)).replace(/(\d{4}-\d{2}-\d{2})T00:00:00(?:\.000)?Z/g, '$1');
function Amount({ value }) {
  return <span className={value == null ? 'pd-uncertain' : 'pd-amount'}>{moneyInWan(value)}</span>;
}
function FieldsTable({ label, fields }) {
  return <table className="pd-fields-table" aria-label={label}><tbody>{fields.map(([title, value], index) => <tr key={index}><th scope="row">{title}</th><td>{display(value)}</td></tr>)}</tbody></table>;
}
function Evidence({ record, plan }) {
  return <div className="pd-evidence">
    <FieldsTable label="付款判定与来源" fields={[
      ['付款时间', plan.paymentDates?.length ? plan.paymentDates.join('、') : '—'], ['判定依据', plan.paymentBasis],
      ['供应商 / 付款主体', `${record.supplier || '—'} / ${record.payer || '—'}`],
      ['类别 / 跟单员', `${CATEGORIES[record.category] || '—'} / ${record.owner || '—'}`],
      ['摘要', record.summary], ['谈判明细', supplierRecordDetails(record).negotiation],
      ['付款 OA 号', record.flowCode], ['原表申请状态', record.applicationStatus],
      ['申请判定依据', plan.applicationBasis], ['批注申请日期', plan.applicationDates?.join('、')], ['流程状态', record.status],
      ['当前节点', record.currentNode || record.raw?.['当前节点']],
      ['来源文件', record.filename], ['原表位置', `${record.sourceSheet} · 第 ${record.sourceRow} 行${plan.sourceCell ? ` · ${plan.sourceCell}` : ''}`],
      ['备注', record.notes],
      ...(plan.paymentProgressVersion ? [['付款依据版本', `${plan.paymentProgressVersion.filename} · ${plan.paymentProgressVersion.id?.slice(0, 8) || ''}`]] : []),
    ]} />
    {plan.applicationEvidence?.map((evidence, index) => <FieldsTable key={`application-${index}`} label={`第${index + 1}条申请依据`} fields={[
      ['申请依据位置', `${record.sourceSheet || ''} · ${evidence.sourceCell || `第 ${record.sourceRow} 行`}`],
      ['该批金额（万元）', moneyInWan(evidence.amountCents)],
      ['申请单判定', ({ applied: '已提交', unapplied: '未提交', partial: '部分已提交', review: '待核对' })[evidence.applicationState]],
      ['批注申请日期', evidence.applicationDates?.join('、')], ['申请批注原文', evidence.comment || '无申请批注'],
    ]} />)}
    {plan.paymentEvidence?.map((evidence, index) => <FieldsTable key={index} label={`第${index + 1}条付款依据`} fields={[
      [`依据 ${index + 1} 位置`, `${evidence.sourceSheet || record.sourceSheet || ''}${evidence.sourceRow ? ` · 第 ${evidence.sourceRow} 行` : ''}${evidence.sourceCell ? ` · ${evidence.sourceCell}` : ''}`],
      ['依据金额（万元）', moneyInWan(evidence.amountCents)],
      ...(evidence.paymentDates?.length ? [['付款日期', evidence.paymentDates.join('、')]] : []),
      ...(evidence.status != null ? [['是否已付款', evidence.status || '—']] : []),
      ...(evidence.flowCode ? [['付款 OA 号', evidence.flowCode]] : []),
      ...(evidence.comment ? [['批注原文', evidence.comment]] : []),
    ]} />)}
    {record.raw && <details><summary>查看原始字段（保留原表单位）</summary><FieldsTable label="原始字段" fields={Object.entries(record.raw)} /></details>}
    {record.comments && Object.keys(record.comments).length > 0 && <details><summary>查看全部单元格批注</summary><FieldsTable label="全部单元格批注" fields={Object.entries(record.comments)} /></details>}
  </div>;
}

export default function PaymentDetails({ records = [], measure = 'totalCents' }) {
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState(null);
  const rows = useMemo(() => records.flatMap((record, recordIndex) => (record.selectedPlans ?? record.plans ?? []).map((plan, planIndex) => ({ record, plan, id: `${recordIndex}-${planIndex}` }))), [records]);
  const totals = useMemo(() => paymentTableTotals(rows.map(row => row.plan)), [rows]);
  useEffect(() => { setPage(1); setExpanded(null); }, [records, measure]);
  const selectedLabel = measures.find(([key]) => key === measure)?.[1] || '总金额';
  const amountClass = key => `pd-money${measure === key ? ' pd-selected' : ''}`;
  if (!rows.length) return <Empty title="暂无付款明细" />;
  function detailButton(row) {
    const open = expanded === row.id;
    return <button className="text-button" aria-expanded={open} aria-label={`${open ? '收起' : '查看'}${row.record.supplier || '该供应商'}${monthText(row.plan.month)}第${row.record.sourceRow}行付款依据`} onClick={() => setExpanded(open ? null : row.id)}>{open ? '收起依据' : '查看依据'}</button>;
  }
  return <div className="payment-drilldown">
    <p className="pd-summary">共 {rows.length} 笔<strong>{selectedLabel}：{moneyInWan(totals[measure])}</strong><span>单位：万元</span></p>
    <div className="pd-table-scroll" tabIndex={0} role="region" aria-label="付款金额明细，可横向滚动"><table className="pd-table" aria-label="汇总金额对应明细">
      <thead><tr><th scope="col" className="pd-supplier">供应商</th><th scope="col" className="pd-owner">跟单员</th><th scope="col" className="pd-payer">付款主体</th><th scope="col" className="pd-category">类别</th><th scope="col" className="pd-month">月份</th><th scope="col" className="pd-description">摘要</th>{measures.map(([key, label]) => <th scope="col" className={amountClass(key)} key={key}>{label}{measure === key && <span className="sr-only">（当前查看列）</span>}</th>)}<th scope="col" className="pd-action">详情</th></tr></thead>
      <tbody>{rows.slice((page - 1) * 20, page * 20).map(row => <Fragment key={row.id}>
        <tr className={expanded === row.id ? 'pd-expanded-row' : undefined}>
          <th scope="row" className="pd-supplier">{row.record.supplier || '—'}</th>
          <td>{row.record.owner || '—'}</td><td>{row.record.payer || '—'}</td><td>{CATEGORIES[row.record.category] || '—'}</td><td>{monthText(row.plan.month)}</td><td className="pd-description">{row.record.summary || '—'}</td>
          {measures.map(([key]) => <td key={key} className={amountClass(key)}><Amount value={row.plan[key === 'totalCents' ? 'amountCents' : key]} /></td>)}
          <td>{detailButton(row)}</td>
        </tr>
        {expanded === row.id && <tr className="pd-evidence-row"><td colSpan={7 + measures.length}><Evidence record={row.record} plan={row.plan} /></td></tr>}
      </Fragment>)}</tbody>
      <tfoot><tr><th colSpan={6} scope="row">全部合计（{rows.length} 笔）</th>{measures.map(([key]) => <td key={key} className={amountClass(key)}><Amount value={totals[key]} /></td>)}<td /></tr></tfoot>
    </table></div>
    <Pager page={page} total={rows.length} onChange={value => { setPage(value); setExpanded(null); }} />
  </div>;
}
