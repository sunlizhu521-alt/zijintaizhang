import React, { useState } from 'react';
import { api } from './api.js';
import { RATING_BANDS, ratingReferences, isWeightedRule, validateRatingRule } from '../shared/rating.js';
import './scoring-weighted.css';

const numberValue = value => value === '' ? null : Number(value);
const blankBands = () => [[90, 100], [75, 89], [60, 74], [0, 59]].map(([min, max]) => ({ min, max, label: '' }));

export default function RulesEditor({ rule, perform, busy }) {
  const weighted = isWeightedRule(rule);
  const [items, setItems] = useState(() => rule.items.map(i => weighted ? { ...i, bands: i.bands.map(b => ({ ...b })) } : { ...i, references: ratingReferences(i) }));
  const [cap, setCap] = useState(() => rule.cap ? { ...rule.cap } : null);
  const total = items.reduce((sum, i) => sum + (Number(i.max) || 0), 0);
  const weights = Object.fromEntries(['交付', '服务'].map(group => [group, items.filter(i => i.group === group).reduce((sum, i) => sum + (Number(i.weight) || 0), 0)]));
  const canPublish = weighted ? weights['交付'] === 100 && weights['服务'] === 100 : total === 100;
  const edit = (id, key, value) => setItems(current => current.map(i => i.id === id ? { ...i, [key]: value } : i));
  const cancelCap = () => window.confirm('此操作会取消“急单低分时交付分最高70分”的封顶规则。确认取消并继续？');
  function changeGroup(item, group) {
    if (cap?.itemId === item.id && group !== '交付') {
      if (!cancelCap()) return;
      setCap(null);
    }
    edit(item.id, 'group', group);
  }
  function remove(item) {
    if (cap?.itemId === item.id) {
      if (!cancelCap()) return;
      setCap(null);
    }
    setItems(current => current.filter(i => i.id !== item.id));
  }
  function selectCap(id) {
    if (!id && cap && !cancelCap()) return;
    setCap(id ? { itemId: id, threshold: 40, max: 70 } : null);
  }
  return <div className="rule-editor-content">
    <h3>当前最新版本 V{rule.id}</h3>
    <p>{weighted ? '可编辑项目、满分、组内权重、标准和参考分档，也可在交付、服务之间调整项目或新增、删除项目。' : '维度、项目、满分、标准和参考分值均可编辑，也可新增或删除评分项。'}发布后仅用于此后新开启的月份，已有月份保留原规则。</p>
    <form onSubmit={e => { e.preventDefault(); perform(() => {
      const clean = validateRatingRule({ items, ...(weighted ? { model: 'ds', cap, evidenceBelow: rule.evidenceBelow ?? 60 } : {}) });
      return api('/rules', { method: 'POST', body: { baseId: rule.id, ...clean } });
    }, '新版本规则已发布，后续新开启月份生效'); }}>
      <fieldset className="rule-fields" disabled={busy}>
        <div className="scroll"><table className={`rule-edit-table${weighted ? ' weighted-rule-table' : ''}`}><thead><tr><th>维度</th><th>项目</th><th>满分</th>{weighted && <th>组内权重 %</th>}<th>标准</th><th>{weighted ? '参考分档（百分制，从高到低）' : '参考分值（从高到低）'}</th><th>操作</th></tr></thead>
          <tbody>{items.map((item, n) => <tr key={item.id} aria-label={`第${n + 1}项评分规则`}>
            <td>{weighted ? <select aria-label={`第${n + 1}项维度`} value={item.group} onChange={e => changeGroup(item, e.target.value)}><option value="交付">交付 D</option><option value="服务">服务 S</option></select> : <input aria-label={`第${n + 1}项维度`} required maxLength="50" value={item.group} onChange={e => edit(item.id, 'group', e.target.value)} />}</td>
            <td><input aria-label={`第${n + 1}项项目`} required maxLength="100" value={item.name} onChange={e => edit(item.id, 'name', e.target.value)} /></td>
            <td><input aria-label={`第${n + 1}项满分`} type="number" min="1" max="100" step="1" required value={item.max ?? ''} onChange={e => edit(item.id, 'max', numberValue(e.target.value))} /></td>
            {weighted && <td><input aria-label={`第${n + 1}项组内权重`} type="number" min="1" max="100" step="1" required value={item.weight ?? ''} onChange={e => edit(item.id, 'weight', numberValue(e.target.value))} /></td>}
            <td><textarea aria-label={`第${n + 1}项标准`} required maxLength="2000" rows={weighted ? 4 : 2} value={item.standard} onChange={e => edit(item.id, 'standard', e.target.value)} /></td>
            <td>{weighted ? item.bands.map((band, index) => <div className="rule-reference-band" key={index}>
              <span>{index + 1}档</span>
              <input aria-label={`第${n + 1}项第${index + 1}档最低分`} type="number" min="0" max="100" step="1" required value={band.min ?? ''} onChange={e => edit(item.id, 'bands', item.bands.map((b, j) => j === index ? { ...b, min: numberValue(e.target.value) } : b))} />
              <span>至</span>
              <input aria-label={`第${n + 1}项第${index + 1}档最高分`} type="number" min="0" max="100" step="1" required value={band.max ?? ''} onChange={e => edit(item.id, 'bands', item.bands.map((b, j) => j === index ? { ...b, max: numberValue(e.target.value) } : b))} />
              <input aria-label={`第${n + 1}项第${index + 1}档说明`} type="text" required maxLength="500" placeholder="该档评价说明" value={band.label} onChange={e => edit(item.id, 'bands', item.bands.map((b, j) => j === index ? { ...b, label: e.target.value } : b))} />
            </div>) : <div className="reference-inputs">{item.references.map((value, index) => <input key={index} aria-label={`第${n + 1}项第${index + 1}档参考分值`} title={RATING_BANDS[index][1]} type="number" min="0" max={item.max ?? 100} step="1" required value={value ?? ''} onChange={e => edit(item.id, 'references', item.references.map((v, j) => j === index ? numberValue(e.target.value) : v))} />)}</div>}</td>
            <td><button type="button" disabled={items.length === 1} onClick={() => remove(item)}>删除此项</button></td>
          </tr>)}</tbody>
        </table></div>
        {weighted && <div className="rule-cap-setting"><label>交付封顶关联项目<select value={cap?.itemId || ''} onChange={e => selectCap(e.target.value)}><option value="">不启用封顶</option>{items.filter(i => i.group === '交付').map(i => <option key={i.id} value={i.id}>{i.name || '未命名项目'}</option>)}</select></label><p>{cap ? '关联项目折算百分制不超过40分时，个人交付分最高70分；再按已提交评价人数取平均。' : '此规则未启用急单低分封顶。选择一个交付项目可恢复封顶条件。'}</p></div>}
        <div className="actions"><button type="button" disabled={items.length >= 100} onClick={() => setItems(current => [...current, weighted ? { id: crypto.randomUUID(), group: '交付', name: '', max: 100, weight: 5, standard: '', bands: blankBands() } : { id: crypto.randomUUID(), group: '', name: '', max: 5, standard: '', references: ratingReferences({ max: 5 }) }])}>新增评分项</button>{weighted ? <div className="rule-weight-totals"><strong>共 {items.length} 项</strong>{Object.entries(weights).map(([group, weight]) => <strong key={group} className={weight === 100 ? '' : 'rule-weight-invalid'}>{group}权重 {weight}% / 100%</strong>)}</div> : <strong>共 {items.length} 项 · 满分合计 {total} / 100</strong>}<button className="primary" disabled={!canPublish}>发布新版本</button></div>
        <p className="muted">{weighted ? '交付、服务各自至少保留1项，组内权重分别合计100%。每项先按“得分÷满分×100”折算为百分制，再加权；参考分档、低分依据和封顶均按百分制判断。四档从高到低、不得重叠，可以留有间隔；间隔内分数仍可填写。' : '各项满分合计须为 100 分，至少保留 1 项。参考分值为 5 档，从高到低排列，可相同；每档须在 0 至该项满分之间。调整满分后请同步核对参考分值。'}</p>
      </fieldset>
    </form>
  </div>;
}
