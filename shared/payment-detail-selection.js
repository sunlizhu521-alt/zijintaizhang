export function detailRecords(records, selection) {
  if (!selection) return [];
  const supplierSearch = (selection.supplierSearch || '').normalize('NFKC').trim().toLowerCase();
  return records.filter(record => selection.categories.includes(record.category) &&
    (record.supplier || '').normalize('NFKC').toLowerCase().includes(supplierSearch)).flatMap(record => {
    const plans = (record.selectedPlans || record.plans || []).filter(plan =>
      (selection.month === 'period' ? Boolean(plan.month) : (plan.month || 'pending') === selection.month) &&
      (selection.measure !== 'unappliedUnpaidCents' || plan.applicationState !== 'applied') &&
      (selection.measure === 'totalCents' || plan.amountCents === 0 || plan[selection.measure] == null || plan[selection.measure] !== 0));
    return plans.length ? [{ ...record, selectedPlans: plans, selectedPlanCents: plans.reduce((sum, plan) => sum + plan.amountCents, 0) }] : [];
  });
}
