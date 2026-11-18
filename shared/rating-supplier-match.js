const nameKey = name => name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').replace(/(?:股份有限公司|有限责任公司|有限公司|公司|工厂|厂)$/u, '');
const comparison = name => { const key = nameKey(name); return { key, pairs: new Set(Array.from({ length: Math.max(0, key.length - 1) }, (_, i) => key.slice(i, i + 2))) }; };
function similarity({ key: a, pairs: x }, { key: b, pairs: y }) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (Math.min(a.length, b.length) >= 2 && (a.includes(b) || b.includes(a))) return .5 + Math.min(a.length, b.length) / Math.max(a.length, b.length) / 2;
  let shared = 0; for (const pair of x) if (y.has(pair)) shared++;
  const score = 2 * shared / (x.size + y.size || 1);
  return score >= .65 ? score : 0;
}

// Similarity proposes a comparison only. Different names never merge without a decision.
export function reviewSupplierNames(preview, needed, decisions = {}) {
  const options = preview.existingSuppliers.map(s => ({ id: s.id, name: s.name, canonicalName: s.name, code: s.code, comparison: comparison(s.name) }));
  const rows = [];
  for (const source of preview.suppliers.filter(s => needed.has(s.index)).sort((a, b) => a.index - b.index)) {
    const decision = decisions[source.index] || {}, candidates = new Map(), sourceComparison = comparison(source.name);
    for (const option of options) {
      const score = similarity(sourceComparison, option.comparison);
      if (score && score > (candidates.get(option.id)?.score || 0)) candidates.set(option.id, { ...option, score });
    }
    const same = options.find(s => s.id === decision.sameAs);
    const invalid = !!decision.sameAs && !same;
    const candidate = [...candidates.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'zh-CN')).find(s => !decision.different?.includes(s.id));
    const target = source.matchedSupplierId || same?.id || (!invalid && !candidate && source.canCreate ? 'new' : '');
    const targetName = target === 'new' ? source.name : options.find(s => s.id === target)?.canonicalName;
    rows.push({ ...source, target, targetName, candidate: same || candidate, invalid, needsReview: !source.matchedSupplierId && (!!candidate || !!decision.sameAs || !!decision.different?.length || !target) });
    if (target) options.push({ id: target === 'new' ? `source:${source.index}` : target, name: source.name, canonicalName: targetName, comparison: sourceComparison });
  }
  return rows;
}
