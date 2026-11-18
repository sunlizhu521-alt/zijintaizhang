import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import { RATING_MONTH_LABELS } from '../shared/rating.js';

const scoreDraft = saved => ({ scores: saved?.scores || {}, notes: saved?.notes || {}, verified: saved?.verified || false, revision: saved?.revision || 0, status: saved?.status || 'draft' });

export default function Scoring({ bundle, user, perform, busy, Modal }) {
  const assigned = bundle.assignments.filter(a => a.raters.some(r => r.id === user.id));
  const scores = new Map(bundle.scores.filter(s => s.user_id === user.id).map(s => [s.supplier_id, s]));
  const expected = assigned.filter(a => !a.exempt).length;
  const submitted = assigned.filter(a => !a.exempt && scores.get(a.supplier_id)?.status === 'submitted').length;
  return <>
    <div className="stats">{[['本月应评', expected], ['已提交', submitted], ['待提交', expected - submitted], ['月份状态', RATING_MONTH_LABELS[bundle.month.status]]].map(([title, value]) => <div className="stat" key={title}><span>{title}</span><strong>{value}</strong></div>)}</div>
    <section className="panel scoring-panel">
      <div className="section-heading"><div><h2>我的供应商评分</h2><p className="muted">全部 {assigned.length} 家供应商，每家一行。填写 {bundle.rule.items.length} 项分数，扣分时补充依据，再逐行保存或提交。</p></div><span className="tag">本月规则 V{bundle.rule.id}</span></div>
      {bundle.month.status !== 'open' && <p className="notice" role="status">{bundle.month.status === 'paused' ? '此月份已临时关闭，请等待管理员恢复评分。' : '此月份已结月，评分仅供查看。'}已有评分和依据均已保留。</p>}
      {assigned.length ? <div className="scroll scoring-scroll" role="region" aria-label="我的供应商评分表，可左右滚动" tabIndex="0"><table className="scoring-table">
        <thead><tr><th scope="col" className="supplier-cell">供应商名称</th>{bundle.rule.items.map(item => <th scope="col" key={item.id} title={item.standard}>{item.name}<small>{item.max} 分</small></th>)}<th scope="col">合计</th><th scope="col">评分依据</th><th scope="col">已核实</th><th scope="col">状态</th><th scope="col" className="row-actions">操作</th></tr></thead>
        <tbody>{assigned.map(a => <ScoreRow key={a.supplier_id} assignment={a} saved={scores.get(a.supplier_id)} bundle={bundle} user={user} perform={perform} busy={busy} Modal={Modal} />)}</tbody>
      </table></div> : <div className="empty">本月履约表中尚未识别到您对应的供应商，请联系管理员核对。</div>}
      <p className="muted scoring-hint">空白表示尚未评分，0 分是有效评分。“已核实”表示已核实当月业务和评分依据，未知情况不按满分处理。评分标准见下方。</p>
    </section>
  </>;
}

function ScoreRow({ assignment: a, saved, bundle, user, perform, busy, Modal }) {
  const draftKey = `supplier-rating:${user.id}:${bundle.month.month}:${a.supplier_id}`;
  const [state, setState] = useState(() => {
    try {
      const local = JSON.parse(sessionStorage.getItem(draftKey));
      if (local && local.scores && local.notes && Number.isInteger(local.revision)) return { draft: { ...scoreDraft(saved), ...local }, dirty: true };
    } catch {}
    return { draft: scoreDraft(saved), dirty: false };
  });
  const [evidence, setEvidence] = useState(false);
  const { draft, dirty } = state;
  // A refresh after saving another row must not replace this row's unsaved inputs.
  useEffect(() => { setState(current => current.dirty ? current : { draft: scoreDraft(saved), dirty: false }); }, [saved?.revision, saved?.status]);
  useEffect(() => {
    if (!dirty) return;
    try { sessionStorage.setItem(draftKey, JSON.stringify(draft)); } catch {}
    const warn = e => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [draft, dirty, draftKey]);
  const edit = (key, value) => setState(current => ({ draft: { ...current.draft, [key]: value }, dirty: true }));
  const isSubmitted = saved?.status === 'submitted' || draft.status === 'submitted';
  const readonly = busy || bundle.month.status !== 'open' || isSubmitted || a.exempt;
  const items = bundle.rule.items;
  const filled = items.filter(i => draft.scores[i.id] != null);
  const missingEvidence = items.filter(i => draft.scores[i.id] != null && draft.scores[i.id] < i.max && !draft.notes[i.id]?.trim());
  const evidenceCount = items.filter(i => draft.notes[i.id]?.trim()).length;
  const status = a.exempt ? '不参评' : isSubmitted ? '已提交' : dirty ? '未保存' : saved ? '草稿' : '未评分';
  async function submit(status) {
    const result = await perform(() => api(`/months/${bundle.month.month}/scores/${a.supplier_id}`, { method: 'PUT', body: { ...draft, status } }), `${a.name}：${status === 'submitted' ? '评分已提交并计入汇总' : '草稿已保存'}`);
    if (result) {
      setState({ draft: scoreDraft(result), dirty: false });
      try { sessionStorage.removeItem(draftKey); } catch {}
    }
  }
  function discard() {
    if (!window.confirm(`丢弃“${a.name}”尚未保存的修改并加载云端评分？`)) return;
    try { sessionStorage.removeItem(draftKey); } catch {}
    setState({ draft: scoreDraft(saved), dirty: false });
  }
  return <tr aria-label={a.name}>
    <th scope="row" className="supplier-cell">{a.name}{a.exempt && <small>{a.reason}</small>}</th>
    {items.map(item => <td key={item.id}><input aria-label={`${a.name}·${item.name}得分`} type="number" min="0" max={item.max} step="1" disabled={readonly} value={draft.scores[item.id] ?? ''} onChange={e => edit('scores', { ...draft.scores, [item.id]: e.target.value === '' ? null : Number(e.target.value) })} /></td>)}
    <td><strong className="total">{a.exempt || !filled.length ? '—' : filled.reduce((n, i) => n + Number(draft.scores[i.id]), 0)}</strong>{!a.exempt && <small>{filled.length}/{items.length} 项</small>}</td>
    <td><button disabled={busy || a.exempt} onClick={() => setEvidence(true)} aria-label={`${a.name}·评分依据`}>{missingEvidence.length ? `待补 ${missingEvidence.length} 项` : evidenceCount ? `查看 ${evidenceCount} 项` : '填写依据'}</button>
      {evidence && <Modal title={`${a.name} · 评分依据`} onClose={() => setEvidence(false)}><p className="muted">扣分项必须写明订单号、发生日期或事实说明。填写后请在本行保存草稿或提交评分。</p><div className="evidence-fields">{items.map(item => <label key={item.id}>{item.name}（{draft.scores[item.id] ?? '未填'} / {item.max} 分）{missingEvidence.some(i => i.id === item.id) && <span className="evidence-required">扣分依据待填写</span>}<textarea aria-label={`${a.name}·${item.name}依据`} rows="2" maxLength="2000" disabled={readonly} value={draft.notes[item.id] || ''} onChange={e => edit('notes', { ...draft.notes, [item.id]: e.target.value })} /></label>)}</div><button className="primary" disabled={busy} onClick={() => setEvidence(false)}>返回评分表</button></Modal>}
    </td>
    <td><input type="checkbox" aria-label={`${a.name}·已核实评分依据`} disabled={readonly} checked={draft.verified} onChange={e => edit('verified', e.target.checked)} /></td>
    <td><span className={`score-status ${isSubmitted ? 'submitted' : ''}`}>{status}</span>{dirty && draft.revision !== (saved?.revision || 0) && <small className="evidence-required">云端有更新，请核对后重新加载</small>}</td>
    <td className="row-actions">{!a.exempt && <div className="score-row-actions">{isSubmitted ? <button disabled={busy || bundle.month.status !== 'open'} onClick={() => perform(() => api(`/months/${bundle.month.month}/scores/${a.supplier_id}/withdraw`, { method: 'POST', body: { revision: saved?.revision || draft.revision } }), `${a.name}：已撤回，暂不计入汇总`)}>撤回修改</button> : <><button disabled={readonly} onClick={() => submit('draft')}>保存草稿</button><button className="primary" disabled={readonly} onClick={() => submit('submitted')}>提交评分</button></>}{dirty && <button disabled={busy} onClick={discard}>重新加载</button>}</div>}</td>
  </tr>;
}
