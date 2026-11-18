import React, { useState } from 'react';
import { api } from './api.js';
import { RATING_BANDS, ratingReferences } from '../shared/rating.js';

export default function RulesEditor({ rule, perform, busy }) {
  const [items, setItems] = useState(() => rule.items.map(i => ({ ...i, references: ratingReferences(i) })));
  const total = items.reduce((sum, i) => sum + (Number(i.max) || 0), 0);
  const edit = (id, key, value) => setItems(current => current.map(i => i.id === id ? { ...i, [key]: value } : i));
  return <div className="rule-editor-content">
    <h3>当前最新版本 V{rule.id}</h3>
    <p>维度、项目、满分、标准和参考分值均可编辑，也可新增或删除评分项。发布后仅用于此后新开启的月份，已有月份保留原规则。</p>
    <form onSubmit={e => { e.preventDefault(); perform(() => api('/rules', { method: 'POST', body: { baseId: rule.id, items } }), '新版本规则已发布，后续新开启月份生效'); }}>
      <fieldset className="rule-fields" disabled={busy}>
        <div className="scroll"><table className="rule-edit-table"><thead><tr><th>维度</th><th>项目</th><th>满分</th><th>标准</th><th>参考分值（从高到低）</th><th>操作</th></tr></thead>
          <tbody>{items.map((item, n) => <tr key={item.id} aria-label={`第${n + 1}项评分规则`}>
            <td><input aria-label={`第${n + 1}项维度`} required maxLength="50" value={item.group} onChange={e => edit(item.id, 'group', e.target.value)} /></td>
            <td><input aria-label={`第${n + 1}项项目`} required maxLength="100" value={item.name} onChange={e => edit(item.id, 'name', e.target.value)} /></td>
            <td><input aria-label={`第${n + 1}项满分`} type="number" min="1" max="100" step="1" required value={item.max ?? ''} onChange={e => edit(item.id, 'max', e.target.value === '' ? null : Number(e.target.value))} /></td>
            <td><textarea aria-label={`第${n + 1}项标准`} required maxLength="2000" rows="2" value={item.standard} onChange={e => edit(item.id, 'standard', e.target.value)} /></td>
            <td><div className="reference-inputs">{item.references.map((value, index) => <input key={index} aria-label={`第${n + 1}项第${index + 1}档参考分值`} title={RATING_BANDS[index][1]} type="number" min="0" max={item.max ?? 100} step="1" required value={value ?? ''} onChange={e => edit(item.id, 'references', item.references.map((v, j) => j === index ? e.target.value === '' ? null : Number(e.target.value) : v))} />)}</div></td>
            <td><button type="button" disabled={items.length === 1} onClick={() => setItems(current => current.filter(i => i.id !== item.id))}>删除此项</button></td>
          </tr>)}</tbody>
        </table></div>
        <div className="actions"><button type="button" disabled={items.length >= 100} onClick={() => setItems(current => [...current, { id: crypto.randomUUID(), group: '', name: '', max: 5, standard: '', references: ratingReferences({ max: 5 }) }])}>新增评分项</button><strong>共 {items.length} 项 · 满分合计 {total} / 100</strong><button className="primary" disabled={total !== 100}>发布新版本</button></div>
        <p className="muted">各项满分合计须为 100 分，至少保留 1 项。参考分值为 5 档，从高到低排列，可相同；每档须在 0 至该项满分之间。调整满分后请同步核对参考分值。</p>
      </fieldset>
    </form>
  </div>;
}
