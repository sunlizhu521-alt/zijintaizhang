import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import { RATING_ITEMS, RATING_MONTH_LABELS, calculateRating, isWeightedRule, roundScore } from '../shared/rating.js';
import './scoring-weighted.css';

const scoreDraft = saved => ({ scores: saved?.scores || {}, notes: saved?.notes || {}, verified: saved?.verified || false, revision: saved?.revision || 0, status: saved?.status || 'draft' });
const scoreText = value => value == null ? '—' : roundScore(value).toFixed(1);

export default function Scoring({ bundle, user, perform, busy, Modal }) {
  const assigned = bundle.assignments.filter(a => a.raters.some(r => r.id === user.id));
  const scores = new Map(bundle.scores.filter(s => s.user_id === user.id).map(s => [s.supplier_id, s]));
  const expected = assigned.filter(a => !a.exempt).length;
  const submitted = assigned.filter(a => !a.exempt && scores.get(a.supplier_id)?.status === 'submitted').length;
  const weighted = isWeightedRule(bundle.rule);
  return <>
    <div className="stats">{[['本月应评', expected], ['已提交', submitted], ['待提交', expected - submitted], ['月份状态', RATING_MONTH_LABELS[bundle.month.status]]].map(([title, value]) => <div className="stat" key={title}><span>{title}</span><strong>{value}</strong></div>)}</div>
    <section className="panel scoring-panel">
      <div className="section-heading"><div><h2>我的供应商评分</h2><p className="muted">全部 {assigned.length} 家供应商，每家一行。填写 {bundle.rule.items.length} 项分数后逐行保存或提交，评分依据选填。</p></div><span className="tag">本月规则 V{bundle.rule.id}</span></div>
      {bundle.month.status !== 'open' && <p className="notice" role="status">{bundle.month.status === 'paused' ? '此月份已临时关闭，请等待管理员恢复评分。' : '此月份已结月，评分仅供查看。'}已有评分和依据均已保留。</p>}
      {assigned.length ? <div className="scroll scoring-scroll" role="region" aria-label="我的供应商评分表，可左右滚动" tabIndex="0"><table className={`scoring-table${weighted ? ' weighted-score-table' : ''}`} style={{ minWidth: Math.max(800, (weighted ? 940 : 700) + bundle.rule.items.length * 88) }}>
        <thead><tr><th scope="col" className="supplier-cell">供应商名称</th>{bundle.rule.items.map(item => <th scope="col" key={item.id} title={item.standard}>{item.name}<small>{item.max} 分{weighted && <> · {item.group}内 {item.weight}%</>}</small></th>)}{weighted ? <><th scope="col" className="score-result-col">交付 D<small>满分 100</small></th><th scope="col" className="score-result-col">服务 S<small>满分 100</small></th><th scope="col" className="score-result-col">贡献分<small>满分 30</small></th></> : <th scope="col">合计</th>}<th scope="col">评分依据（选填）</th><th scope="col">已核实</th><th scope="col">状态</th><th scope="col" className="row-actions">操作</th></tr></thead>
        <tbody>{assigned.map(a => <ScoreRow key={`${bundle.rule.id}/${a.supplier_id}`} assignment={a} saved={scores.get(a.supplier_id)} bundle={bundle} user={user} perform={perform} busy={busy} Modal={Modal} />)}</tbody>
      </table></div> : <div className="empty">本月履约表中尚未识别到您对应的供应商，请联系管理员核对。</div>}
      <p className="muted scoring-hint">空白表示尚未评分，0 分是有效评分。“已核实”表示已核实当月业务和评分依据；确认无相关事件时可手动给满分，未知情况不按满分处理。评分标准见下方。</p>
      {weighted && <p className="muted scoring-hint">交付、服务分别按组内权重计算；贡献分 = 交付分 × 20% + 服务分 × 10%，满分 30，不评综合等级。参考分档仅作指引；10 分制可保留一位小数。</p>}
    </section>
  </>;
}

function ScoreRow({ assignment: a, saved, bundle, user, perform, busy, Modal }) {
  const draftBase = `supplier-rating:${user.id}:${bundle.month.month}:${a.supplier_id}`;
  const draftKey = `${draftBase}:rule:${bundle.rule.id}`;
  const [state, setState] = useState(() => {
    try {
      const local = JSON.parse(sessionStorage.getItem(draftKey));
      if (local?.ruleId === bundle.rule.id && local.scores && local.notes && Number.isInteger(local.revision)) return { draft: scoreDraft(local), dirty: true };
    } catch {}
    return { draft: scoreDraft(saved), dirty: false };
  });
  const [oldDrafts] = useState(() => {
    try { return Object.keys(sessionStorage).filter(key => key === draftBase || (key.startsWith(`${draftBase}:rule:`) && key !== draftKey)).map(key => {
      const raw = sessionStorage.getItem(key);
      let data; try { data = JSON.parse(raw); } catch {}
      return { key, raw, data, label: key === draftBase ? '旧版未标记规则的草稿' : `规则 V${key.slice(`${draftBase}:rule:`.length)} 的草稿` };
    }); } catch { return []; }
  });
  const [evidence, setEvidence] = useState(false), [oldDraftIndex, setOldDraftIndex] = useState(null);
  const { draft, dirty } = state;
  // A refresh after saving another row must not replace this row's unsaved inputs.
  useEffect(() => { setState(current => current.dirty ? current : { draft: scoreDraft(saved), dirty: false }); }, [saved?.revision, saved?.status]);
  useEffect(() => {
    if (!dirty) return;
    try { sessionStorage.setItem(draftKey, JSON.stringify({ ...draft, ruleId: bundle.rule.id, items: bundle.rule.items.map(({ id, name, max }) => ({ id, name, max })) })); } catch {}
    const warn = e => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [draft, dirty, draftKey, bundle.rule]);
  const edit = (key, value) => setState(current => ({ draft: { ...current.draft, [key]: value }, dirty: true }));
  const isSubmitted = saved?.status === 'submitted' || draft.status === 'submitted';
  const readonly = busy || bundle.month.status !== 'open' || isSubmitted || a.exempt;
  const items = bundle.rule.items, weighted = isWeightedRule(bundle.rule);
  const filled = items.filter(i => draft.scores[i.id] != null);
  const evidenceCount = items.filter(i => draft.notes[i.id]?.trim()).length;
  const result = calculateRating(bundle.rule, draft.scores);
  const status = a.exempt ? '不参评' : isSubmitted ? '已提交' : dirty ? '未保存' : saved ? '草稿' : '未评分';
  async function submit(status) {
    const result = await perform(() => api(`/months/${bundle.month.month}/scores/${a.supplier_id}`, { method: 'PUT', body: { ...draft, status, ruleId: bundle.rule.id } }), `${a.name}：${status === 'submitted' ? '评分已提交并计入汇总' : '草稿已保存'}`);
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
  const oldDraft = oldDraftIndex == null ? null : oldDrafts[oldDraftIndex];
  function downloadOldDraft() {
    const url = URL.createObjectURL(new Blob([oldDraft.raw], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url;
    link.download = `旧版未保存草稿_${bundle.month.month}_${a.name.slice(0, 60).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')}.json`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <tr aria-label={a.name}>
    <th scope="row" className="supplier-cell">{a.name}{a.exempt && <small>{a.reason}</small>}{oldDrafts.length > 0 && <button className="old-draft-link" onClick={() => setOldDraftIndex(0)}>旧版未保存内容（{oldDrafts.length}）</button>}
      {oldDraft && <Modal title={`${a.name} · 旧版未保存内容`} onClose={() => setOldDraftIndex(null)}><p className="muted">这些内容仅保存在原浏览器中，尚未提交到服务器，未套用到当前规则。可查看、下载留存后按新规则重新评分。</p>{oldDrafts.length > 1 && <label>选择旧草稿<select value={oldDraftIndex} onChange={e => setOldDraftIndex(Number(e.target.value))}>{oldDrafts.map((d, index) => <option key={d.key} value={index}>{d.label}</option>)}</select></label>}<p>{oldDraft.label}</p>{oldDraft.data?.scores && typeof oldDraft.data.scores === 'object' && !Array.isArray(oldDraft.data.scores) ? <div className="scroll"><table><thead><tr><th>项目</th><th>原分数</th><th>原依据</th></tr></thead><tbody>{Object.entries(oldDraft.data.scores).map(([id, value]) => <tr key={id}><td>{(Array.isArray(oldDraft.data.items) ? oldDraft.data.items : RATING_ITEMS).find(i => i.id === id)?.name || id}</td><td>{value == null ? '未填' : String(value)}</td><td>{String(oldDraft.data.notes?.[id] || '—')}</td></tr>)}</tbody></table></div> : <pre className="old-draft-raw">{oldDraft.raw}</pre>}<div className="actions"><button onClick={downloadOldDraft}>下载原始草稿</button><button className="primary" onClick={() => setOldDraftIndex(null)}>返回评分表</button></div></Modal>}
    </th>
    {items.map(item => <td key={item.id}><input aria-label={`${a.name}·${item.name}得分`} type="number" min="0" max={item.max} step={weighted && item.max === 10 ? 0.1 : 1} disabled={readonly} value={draft.scores[item.id] ?? ''} onChange={e => edit('scores', { ...draft.scores, [item.id]: e.target.value === '' ? null : Number(e.target.value) })} /></td>)}
    {weighted ? <><td><strong className="total">{scoreText(a.exempt ? null : result.groups['交付'])}</strong>{result.capApplied && !a.exempt && <small className="score-cap-note">急单低分<br />交付封顶 {bundle.rule.cap.max}</small>}</td><td><strong className="total">{scoreText(a.exempt ? null : result.groups['服务'])}</strong></td><td><strong className="total">{scoreText(a.exempt ? null : result.totalRaw)}</strong>{!a.exempt && <small>{filled.length}/{items.length} 项</small>}</td></> : <td><strong className="total">{a.exempt || !filled.length ? '—' : filled.reduce((n, i) => n + Number(draft.scores[i.id]), 0)}</strong>{!a.exempt && <small>{filled.length}/{items.length} 项</small>}</td>}
    <td><button disabled={busy || a.exempt} onClick={() => setEvidence(true)} aria-label={`${a.name}·评分依据（选填）`}>{evidenceCount ? `查看 ${evidenceCount} 项` : '点击填写'}</button>
      {evidence && <Modal title={`${a.name} · 评分依据（选填）`} onClose={() => setEvidence(false)}><p className="muted">评分依据选填，不填写也可提交。可填写订单号、发生日期或事实说明；填写后请在本行保存草稿或提交评分。</p><div className="evidence-fields">{items.map(item => <label key={item.id}>{item.name}（{draft.scores[item.id] ?? '未填'} / {item.max} 分）<textarea aria-label={`${a.name}·${item.name}依据`} rows="2" maxLength="2000" disabled={readonly} value={draft.notes[item.id] || ''} onChange={e => edit('notes', { ...draft.notes, [item.id]: e.target.value })} /></label>)}</div><button className="primary" disabled={busy} onClick={() => setEvidence(false)}>返回评分表</button></Modal>}
    </td>
    <td><input type="checkbox" aria-label={`${a.name}·已核实评分依据`} disabled={readonly} checked={draft.verified} onChange={e => edit('verified', e.target.checked)} /></td>
    <td><span className={`score-status ${isSubmitted ? 'submitted' : ''}`}>{status}</span>{dirty && draft.revision !== (saved?.revision || 0) && <small className="evidence-required">云端有更新，请核对后重新加载</small>}</td>
    <td className="row-actions">{!a.exempt && <div className="score-row-actions">{isSubmitted ? <button disabled={busy || bundle.month.status !== 'open'} onClick={() => perform(() => api(`/months/${bundle.month.month}/scores/${a.supplier_id}/withdraw`, { method: 'POST', body: { revision: saved?.revision || draft.revision, ruleId: bundle.rule.id } }), `${a.name}：已撤回，暂不计入汇总`)}>撤回修改</button> : <><button disabled={readonly} onClick={() => submit('draft')}>保存草稿</button><button className="primary" disabled={readonly} onClick={() => submit('submitted')}>提交评分</button></>}{dirty && <button disabled={busy} onClick={discard}>重新加载</button>}</div>}</td>
  </tr>;
}
