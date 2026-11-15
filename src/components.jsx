import { useEffect, useRef, useState } from 'react';
import { CATEGORIES } from '../shared/constants.js';
import { money, monthText, planAmount } from './format.js';

export function Notice({ children, type = 'info' }) {
  if (!children) return null;
  return <div className={`notice ${type}`} role={type === 'error' ? 'alert' : 'status'}>{children}</div>;
}
export function ErrorNotice({ error }) {
  if (!error) return null;
  return <Notice type="error"><strong>{error.message || String(error)}</strong>{error.issues?.length > 0 && <ul>{error.issues.slice(0, 8).map((issue, i) => <li key={i}>{issue.sourceSheet || issue.sheet} {issue.sourceRow || issue.row ? `第 ${issue.sourceRow || issue.row} 行：` : ''}{issue.message || String(issue)}</li>)}</ul>}</Notice>;
}
export function Empty({ title = '暂无数据', children }) { return <div className="empty"><span className="empty-mark" aria-hidden="true">≡</span><strong>{title}</strong>{children && <p>{children}</p>}</div>; }
export function Loading() { return <div className="loading" role="status"><span className="spinner" />正在读取…</div>; }
export function Modal({ title, onClose, children, wide = false }) {
  const ref = useRef(null);
  useEffect(() => { const dialog = ref.current; dialog.showModal(); return () => { if (dialog.open) dialog.close(); }; }, []);
  return <dialog ref={ref} className={wide ? 'modal wide' : 'modal'} onCancel={event => { event.preventDefault(); onClose(); }} aria-label={title}>
    <div className="modal-heading"><h2>{title}</h2><button type="button" className="icon-button" aria-label="关闭弹窗" onClick={onClose}>×</button></div>
    <div className="modal-content">{children}</div>
  </dialog>;
}
export function Pager({ page, total, size = 20, onChange }) {
  const pages = Math.max(1, Math.ceil(total / size));
  return <div className="pagination"><span>共 {total} 条 · 第 {Math.min(page, pages)} / {pages} 页</span><div><button disabled={page <= 1} onClick={() => onChange(page - 1)}>上一页</button><button disabled={page >= pages} onClick={() => onChange(page + 1)}>下一页</button></div></div>;
}
function selectedPayment(record, key) {
  const plans = record.selectedPlans || record.plans || [];
  return plans.some(plan => plan[key] == null) ? '待核对' : money(plans.reduce((sum, plan) => sum + plan[key], 0));
}
function PaymentEvidence({ plan }) {
  return <>{plan.paymentBasis || '未提供'}
    {plan.paymentProgressVersion && <span>付款依据版本：{plan.paymentProgressVersion.filename} · {plan.paymentProgressVersion.id?.slice(0, 8)}</span>}
    {plan.paymentEvidence?.map((evidence, index) => <div key={index}>
      <strong>{evidence.sourceSheet}{evidence.sourceRow ? ` · 第 ${evidence.sourceRow} 行` : ''}{evidence.sourceCell}{evidence.amountCents == null ? '' : ` · ${money(evidence.amountCents)} 元`}</strong>
      {evidence.status != null && <span>是否已付款：{evidence.status || '空白'}</span>}
      {evidence.flowCode && <span>流程号：{evidence.flowCode}</span>}
      {evidence.comment && <span>{evidence.comment}</span>}
    </div>)}
  </>;
}
export function RecordDetail({ record, onClose, fitWidth = false }) {
  return <Modal title="记录详情" onClose={onClose} wide>
    <dl className="detail-grid">
      {[
        ['供应商', record.supplier], ['付款主体', record.payer], ['数据类别', CATEGORIES[record.category]], ['跟单员', record.owner],
        ['摘要', record.summary], ['流程号', record.flowCode], ['原台账金额（元）', money(record.amountCents)], ['原台账已付（元）', money(record.paidCents)],
        ['原台账剩余（元）', money(record.remainingCents)], ['流程状态', record.status], ['结清状态', record.settled], ['付款申请状态', record.applicationStatus],
        ['来源文件', record.filename], ['工作表 / 行号', `${record.sourceSheet} · 第 ${record.sourceRow} 行`], ['备注', record.notes],
      ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value == null || value === '' ? '—' : String(value)}</dd></div>)}
    </dl>
    <h3>付款计划与判定依据</h3>{fitWidth ? <div className="plan-card-list" role="list" aria-label="记录付款计划与依据">
      {(record.selectedPlans || record.plans)?.map((plan, i) => <article className="plan-card" role="listitem" key={i}>
        <h3>{monthText(plan.month)}</h3>
        <dl className="record-card-fields">
          {[
            ['计划金额（元）', money(plan.amountCents)], ['计划已付（元）', plan.paidCents == null ? '待核对' : money(plan.paidCents)],
            ['计划未付（元）', plan.unpaidCents == null ? '待核对' : money(plan.unpaidCents)], ['付款时间', plan.paymentDates?.length ? plan.paymentDates.join('、') : '未提供'],
          ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
        <div className="payment-evidence"><PaymentEvidence plan={plan} /></div>
      </article>)}
    </div> : <div className="table-wrap"><table aria-label="记录付款计划与依据">
      <thead><tr><th>计划月份</th><th className="numeric">计划金额（元）</th><th className="numeric">计划已付（元）</th><th className="numeric">计划未付（元）</th><th>付款时间</th><th>判定依据</th></tr></thead>
      <tbody>{(record.selectedPlans || record.plans)?.map((plan, i) => <tr key={i}>
        <td className="nowrap">{monthText(plan.month)}</td><td className="numeric">{money(plan.amountCents)}</td>
        <td className="numeric">{plan.paidCents == null ? '待核对' : money(plan.paidCents)}</td><td className="numeric">{plan.unpaidCents == null ? '待核对' : money(plan.unpaidCents)}</td>
        <td className="nowrap">{plan.paymentDates?.length ? plan.paymentDates.join('、') : '未提供'}</td>
        <td className="payment-evidence"><PaymentEvidence plan={plan} /></td>
      </tr>)}</tbody>
    </table></div>}
    {record.raw && <details className="raw-details"><summary>查看原始字段</summary><dl className="detail-grid">{Object.entries(record.raw).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '')}</dd></div>)}</dl></details>}
    {record.comments && Object.keys(record.comments).length > 0 && <details className="raw-details"><summary>查看单元格批注（{Object.keys(record.comments).length}）</summary><dl className="detail-grid">{Object.entries(record.comments).map(([cell, comment]) => <div key={cell}><dt>{cell}</dt><dd>{String(comment)}</dd></div>)}</dl></details>}
  </Modal>;
}
export function RecordsTable({ records = [], label = '供应商明细', fitWidth = false }) {
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null);
  useEffect(() => { setPage(1); setSelected(null); }, [records]);
  const pageRecords = records.slice((page - 1) * 20, page * 20);
  return <>
    {!records.length ? <Empty title="没有符合条件的记录">可调整筛选条件，或在文件管理中上传数据。</Empty> : <>
      {fitWidth ? <div className="record-card-list" role="list" aria-label={label}>{pageRecords.map((record, i) => <article className="record-card" role="listitem" key={`${record.slotId}-${record.key}-${i}`}>
        <div className="record-card-heading"><h3>{record.supplier || '未填写'}</h3><span className={`tag category-${record.category}`}>{CATEGORIES[record.category]}</span></div>
        <p className="record-card-summary">{record.summary || '—'}</p>
        <dl className="record-card-fields">{[
          ['所选计划（元）', money(planAmount(record))], ['计划已付（元）', selectedPayment(record, 'paidCents')], ['计划未付（元）', selectedPayment(record, 'unpaidCents')],
          ['原台账已付（元）', money(record.paidCents)], ['原台账剩余（元）', money(record.remainingCents)], ['流程状态', record.status || '—'],
          ['付款主体', record.payer || '—'], ['跟单员', record.owner || '—'],
        ].map(([title, value]) => <div key={title}><dt>{title}</dt><dd>{value}</dd></div>)}</dl>
        <div className="record-card-footer"><span>{record.sourceSheet} · 第 {record.sourceRow} 行</span><button className="text-button" onClick={() => setSelected(record)} aria-label={`查看${record.supplier || '该记录'}第${record.sourceRow}行详情`}>查看详情</button></div>
      </article>)}</div> : <div className="table-wrap"><table aria-label={label}><thead><tr><th>供应商 / 摘要</th><th>类别</th><th>付款主体</th><th>跟单员</th><th className="numeric">所选计划（元）</th><th className="numeric">计划已付（元）</th><th className="numeric">计划未付（元）</th><th className="numeric">原台账已付（元）</th><th className="numeric">原台账剩余（元）</th><th>流程状态</th><th>来源</th><th>详情</th></tr></thead><tbody>
        {pageRecords.map((record, i) => <tr key={`${record.slotId}-${record.key}-${i}`}><td><strong className="supplier-name">{record.supplier || '未填写'}</strong><span className="cell-secondary">{record.summary || '—'}</span></td><td><span className={`tag category-${record.category}`}>{CATEGORIES[record.category]}</span></td><td>{record.payer || '—'}</td><td>{record.owner || '—'}</td><td className="numeric amount">{money(planAmount(record))}</td><td className="numeric">{selectedPayment(record, 'paidCents')}</td><td className="numeric">{selectedPayment(record, 'unpaidCents')}</td><td className="numeric">{money(record.paidCents)}</td><td className="numeric">{money(record.remainingCents)}</td><td>{record.status || '—'}</td><td className="muted">{record.sourceSheet}<span className="cell-secondary">第 {record.sourceRow} 行</span></td><td><button className="text-button" onClick={() => setSelected(record)} aria-label={`查看${record.supplier || '该记录'}第${record.sourceRow}行详情`}>查看</button></td></tr>)}
      </tbody></table></div>}<Pager page={page} total={records.length} onChange={setPage} />
    </>}
    {selected && <RecordDetail record={selected} onClose={() => setSelected(null)} fitWidth={fitWidth} />}
  </>;
}
export function IssuesTable({ issues = [] }) {
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [issues]);
  if (!issues.length) return <p className="muted compact-empty">当前没有待核对事项。</p>;
  const showAction = issues.some(issue => issue.action);
  return <><div className="table-wrap"><table aria-label="待核对事项"><thead><tr><th>位置</th><th>说明</th>{showAction && <th>需要核对</th>}</tr></thead><tbody>{issues.slice((page - 1) * 15, page * 15).map((issue, i) => <tr key={i}><td className="nowrap">{issue.sourceSheet || issue.sheet || '文件状态'}{issue.sourceRow || issue.row ? <span className="cell-secondary">第 {issue.sourceRow || issue.row} 行</span> : null}</td><td>{issue.message || String(issue)}</td>{showAction && <td>{issue.action || '—'}</td>}</tr>)}</tbody></table></div><Pager page={page} total={issues.length} size={15} onChange={setPage} /></>;
}
