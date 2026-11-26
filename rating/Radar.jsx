import React from 'react';

const scoreText = value => value == null ? '未评分' : Number(value).toFixed(1);

export default function Radar({ row, supplierSelected, periodLabel }) {
  const items = Object.entries(row?.itemNames || {}).map(([id, name]) => ({ id, name, value: row.normalizedItemScores?.[id] ?? null }));
  const available = items.filter(item => item.value != null);
  const point = (index, value, radius = 122) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / items.length;
    return [260 + Math.cos(angle) * radius * value / 100, 190 + Math.sin(angle) * radius * value / 100];
  };
  const polygon = value => items.map((_, i) => point(i, value).join(',')).join(' ');
  return <section className="panel radar-panel" aria-labelledby="radar-title">
    <div className="section-heading"><div><h2 id="radar-title">评分内容雷达图</h2><p className="muted">{row ? `${row.name} · ${periodLabel}` : supplierSelected ? `${periodLabel} · 暂无已提交评分` : '选择具体供应商，查看各项表现'}</p></div><span className="tag">各项统一折算为百分制</span></div>
    {!row ? <div className="empty">{supplierSelected ? '所选供应商在当前期间暂无符合统计条件的评分；跨期仅纳入已结月月份。' : '请在上方选择一家供应商。'}</div> : !available.length ? <div className="empty">该供应商在当前期间尚无已提交评分，未评分不按 0 分展示。</div> : <div className="radar-content">
      {items.length >= 3 && <svg viewBox="0 0 520 400" role="img" aria-label={`${row.name}评分雷达：${items.map(item => `${item.name}${scoreText(item.value)}`).join('；')}`}>
        <title>{`${row.name} · 评分内容雷达图`}</title>
        {[25, 50, 75, 100].map(value => <g key={value}><polygon points={polygon(value)} className="radar-grid" /><text x="267" y={190 - 122 * value / 100 + 4} className="radar-tick">{value}</text></g>)}
        <text x="267" y="194" className="radar-tick">0</text>
        {items.map((item, index) => { const [x, y] = point(index, 100); return <line key={item.id} x1="260" y1="190" x2={x} y2={y} className="radar-grid" />; })}
        {available.length === items.length && <polygon points={items.map((item, index) => point(index, item.value).join(',')).join(' ')} className="radar-area" />}
        {items.map((item, index) => {
          const [x, y] = point(index, item.value ?? 0), [labelX, labelY] = point(index, 100, 157);
          const chunks = item.name.match(/.{1,6}/gu) || [item.name];
          return <g key={item.id}>{item.value != null && <circle cx={x} cy={y} r="4" className="radar-point"><title>{`${item.name}：${scoreText(item.value)}`}</title></circle>}<text x={labelX} y={labelY - (chunks.length - 1) * 7} textAnchor={labelX < 250 ? 'end' : labelX > 270 ? 'start' : 'middle'} className="radar-label">{chunks.map((text, i) => <tspan key={i} x={labelX} dy={i ? 17 : 0}>{text}</tspan>)}</text></g>;
        })}
      </svg>}
      <div className="radar-values"><dl>{items.map(item => <div key={item.id}><dt>{item.name}</dt><dd>{scoreText(item.value)}<small> / 100</small></dd></div>)}</dl>
        <p className="muted">雷达图展示各项评分均值；交付分按个人先执行急单封顶，再取平均。</p>
        {available.length !== items.length && <p className="muted">部分项目未覆盖所有纳入月份，留空且不连成完整轮廓。</p>}
        {row.months && <p className="muted">纳入月份：{row.months.join('、')}；按月等权平均。</p>}
      </div>
    </div>}
  </section>;
}
