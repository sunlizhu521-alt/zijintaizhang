export function money(cents) {
  if (cents == null || !Number.isFinite(Number(cents))) return '未提供';
  return (Number(cents) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function moneyInWan(cents) {
  if (cents == null || !Number.isFinite(Number(cents))) return '待核对';
  if (Number(cents) === 0) return '—';
  return (Math.trunc(Number(cents) / 10_000) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function dateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date);
}
export function monthText(value) { return value && value !== 'pending' ? `${value.slice(0, 4)}年${Number(value.slice(5, 7))}月` : '时间待定'; }
export function upcomingMonths() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  const year = Number(parts.find(p => p.type === 'year').value);
  const month = Number(parts.find(p => p.type === 'month').value);
  const end = new Date(Date.UTC(year, month + 1, 1));
  return { from: `${year}-${String(month).padStart(2, '0')}`, to: `${end.getUTCFullYear()}-${String(end.getUTCMonth() + 1).padStart(2, '0')}` };
}
export function can(user, permission) { return Boolean(user?.isAdmin || user?.permissions?.includes(permission)); }
export function planAmount(record) { return record.selectedPlanCents ?? record.plans?.reduce((sum, plan) => sum + plan.amountCents, 0) ?? record.amountCents; }
