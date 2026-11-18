import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, download } from './api.js';
import { reviewSupplierNames } from '../shared/rating-supplier-match.js';

export default function FulfillmentImport({ month, bundle, perform, busy, error, onPrepareMonth }) {
  const [preview, setPreview] = useState(null), [sheets, setSheets] = useState({}), [decisions, setDecisions] = useState({});
  const dialog = useRef(), fileInput = useRef();
  useEffect(() => { if (preview) dialog.current.showModal(); }, [preview?.id]);
  const file = bundle?.assignmentImport, summary = file?.summary ? JSON.parse(file.summary) : null;
  const writable = bundle?.month.status === 'open';
  const prepareAction = bundle?.month.status === 'paused' ? '恢复评分' : bundle?.month.status === 'closed' ? '重开月份' : '开启月份';
  const monthStatus = bundle?.month.status === 'paused' ? '临时关闭' : bundle?.month.status === 'closed' ? '已结月' : '尚未开启';
  async function upload(e) {
    const file = e.target.files[0]; e.target.value = ''; if (!file || busy || !writable) return;
    const body = new FormData(); body.append('file', file);
    const result = await perform(() => api(`/months/${month}/assignment-import/preview`, { method: 'POST', body }), '已读取履约表，请核对工作表、账号和供应商对应关系');
    if (!result) return;
    setSheets(Object.fromEntries(result.sheets.map(s => [s.index, { included: !!s.matchedUserId, userId: s.matchedUserId }])));
    setDecisions({});
    setPreview(result);
  }
  const selected = useMemo(() => preview?.sheets.filter(s => sheets[s.index]?.included) || [], [preview, sheets]);
  const visibleSuppliers = useMemo(() => preview ? reviewSupplierNames(preview, new Set(selected.flatMap(s => s.suppliers.map(s => s.index))), decisions) : [], [preview, selected, decisions]);
  const questions = visibleSuppliers.filter(s => s.needsReview);
  const resetDecision = index => setDecisions(current => { const next = { ...current }; delete next[index]; return next; });
  const incomplete = !selected.length || selected.some(s => !sheets[s.index].userId) || visibleSuppliers.some(s => !s.target);
  async function commit() {
    const body = { id: preview.id, sheets: selected.map(s => ({ index: s.index, userId: sheets[s.index].userId })), suppliers: visibleSuppliers.map(s => ({ index: s.index, supplierId: s.target })) };
    if (await perform(() => api(`/months/${month}/assignment-import/commit`, { method: 'POST', body }), `${month} 履约表分配已完成，已有评分和人工分配保留`)) setPreview(null);
  }
  return <section className="panel">
    <div className="section-heading"><div><h2>采购履约表 · 按工作表分配</h2><p className="muted">以工作表命名人对应评价账号，只读取供应商名称；不使用采购下单人、创建人或下单月份。</p></div><button type="button" className="primary" disabled={busy} aria-describedby={!writable ? 'fulfillment-upload-status' : undefined} onClick={() => writable ? fileInput.current.click() : onPrepareMonth()}>{busy ? '正在处理…' : writable ? file ? '上传更新文件' : '上传采购履约表' : `${prepareAction}后上传`}</button><input ref={fileInput} hidden type="file" aria-label="选择采购履约表文件" accept=".xlsx" disabled={busy || !writable} onChange={upload} /></div>
    <p>同一供应商在多人工作表出现时，追加多位评价人。已有分配和评分保留，未匹配账号或供应商需在预览中确认。</p>
    {!writable && <p id="fulfillment-upload-status" className="notice" role="status">{month} {monthStatus}，暂不能上传。点击“{prepareAction}后上传”可前往“评价管理”，完成{prepareAction}后返回“供应商管理”选择文件。</p>}
    {file ? <div className="actions"><div><strong>{file.filename}</strong><p className="muted">{new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(file.created_at))} · {summary?.sheets}张工作表 · {summary?.suppliers}家供应商 · 追加{summary?.addedRaters}个人员分配</p></div><button disabled={busy} onClick={() => perform(() => download(`/months/${month}/assignment-import/${file.id}/download`), '履约表原文件已下载')}>下载已导入原文件</button></div> : <p className="muted">本月尚未导入履约表。支持 .xlsx，最多20MB；预览确认后保存原文件和分配依据。</p>}
    {preview && <dialog className="assignment-import" ref={dialog} onCancel={e => { if (busy) e.preventDefault(); else setPreview(null); }}>
      <header><h2>履约表分配预览 · {month}</h2><button disabled={busy} aria-label="关闭履约表预览" onClick={() => setPreview(null)}>×</button></header>
      {error && <div className="alert" role="alert">{error}</div>}
      <p>{preview.filename}</p><p>按工作表名称精确匹配账号。未匹配工作表默认不纳入，请核对；示例、汇总等工作表不要勾选。缺少账号时，请先到“用户管理”创建，再重新上传。</p>
      <div className="scroll"><table><thead><tr><th>纳入</th><th>工作表命名人</th><th>供应商数</th><th>评价账号</th></tr></thead><tbody>{preview.sheets.map(s => <tr key={s.index}><td><input type="checkbox" aria-label={`纳入工作表${s.name}`} disabled={busy} checked={!!sheets[s.index]?.included} onChange={e => setSheets({ ...sheets, [s.index]: { ...sheets[s.index], included: e.target.checked } })} /></td><td>{s.name}{!s.matchedUserId && <small>未自动匹配账号</small>}{s.blankRows > 0 && <small>{s.blankRows}行空供应商或汇总行未纳入</small>}</td><td>{s.suppliers.length}</td><td><select aria-label={`${s.name}对应评价账号`} disabled={busy} value={sheets[s.index]?.userId || ''} onChange={e => setSheets({ ...sheets, [s.index]: { userId: e.target.value, included: !!e.target.value } })}><option value="">请选择账号或排除此工作表</option>{preview.users.map(u => <option key={u.id} value={u.id}>{u.name}（{u.username}）</option>)}</select></td></tr>)}</tbody></table></div>
      {preview.skipped.length > 0 && <details><summary>未读取的工作表（{preview.skipped.length}）</summary>{preview.skipped.map(s => <p key={s.name}>{s.name}：{s.reason}</p>)}</details>}
      <h3>确认是不是同一家供应商</h3><p>相同名称已自动对应。下面列出相近名称，您只需判断是否同一家，其余由系统整理。</p>
      {questions.length > 0 ? <div className="scroll"><table><thead><tr><th>表内名称</th><th>对比名称</th><th>是不是同一家？</th></tr></thead><tbody>{questions.map(s => <tr key={s.index}><td>{s.name}</td><td>{s.candidate?.name || '按表内名称分别保留'}{s.issue && <small>{s.issue}</small>}{s.issue && s.candidate?.code && <small>名单编号：{s.candidate.code}</small>}</td><td>{s.invalid ? <><p>对比名称已变化，请重新判断。</p><button disabled={busy} onClick={() => resetDecision(s.index)}>重新判断</button></> : s.target ? <><strong>{s.target === 'new' ? '不是同一家，分别保留' : '是，同一家'}</strong><small>{s.targetName}</small><button disabled={busy} onClick={() => resetDecision(s.index)}>重新判断</button></> : s.candidate ? <div className="supplier-choices"><button disabled={busy} aria-label={`确认${s.name}与${s.candidate.name}是同一家`} onClick={() => setDecisions({ ...decisions, [s.index]: { ...decisions[s.index], sameAs: s.candidate.id } })}>是，同一家</button><button disabled={busy} aria-label={`确认${s.name}与${s.candidate.name}不是同一家`} onClick={() => setDecisions({ ...decisions, [s.index]: { sameAs: '', different: [...(decisions[s.index]?.different || []), s.candidate.id] } })}>不是同一家</button></div> : <><small>请先在供应商名单核对同名记录，再重新上传。</small>{decisions[s.index]?.different?.length > 0 && <button disabled={busy} onClick={() => resetDecision(s.index)}>重新判断</button>}</>}</td></tr>)}</tbody></table></div> : <p className="notice">供应商名称已整理，无需逐项确认。</p>}
      <details><summary>查看全部供应商及来源（{visibleSuppliers.length}个名称）</summary><div className="scroll"><table><thead><tr><th>表内名称</th><th>整理结果</th><th>来源</th></tr></thead><tbody>{visibleSuppliers.map(s => <tr key={s.index}><td>{s.name}</td><td>{s.targetName || '待判断'}</td><td>{selected.filter(sheet => sheet.suppliers.some(v => v.index === s.index)).map(sheet => { const rows = sheet.suppliers.find(v => v.index === s.index).rows; return <small key={sheet.index}>{sheet.name}：第{rows.slice(0, 12).join('、')}{rows.length > 12 ? `…（共${rows.length}行）` : ''}行</small>; })}</td></tr>)}</tbody></table></div></details>
      <p>本次纳入{selected.length}张工作表、{visibleSuppliers.length}个供应商名称；确认后系统自动整理名单，并追加所选月份的评价人。</p>
      {incomplete && <p className="muted">请选好工作表和评价账号，并完成上面的同一家判断。</p>}
      <button className="primary" disabled={busy || incomplete} onClick={commit}>确认并追加分配</button>
    </dialog>}
  </section>;
}
