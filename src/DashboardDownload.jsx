import { createContext, useContext, useState } from 'react';
import { download } from './api.js';

export const DashboardDownloadContext = createContext(null);

export default function DashboardDownload({ options = {}, label = '下载 Excel' }) {
  const context = useContext(DashboardDownloadContext);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!context?.allowed) return null;
  async function save() {
    setBusy(true); setError('');
    // Preserve an empty detailSupplier: it selects the unnamed supplier group.
    const params = new URLSearchParams(Object.entries({ ...context.filters, ...options }).filter(([, value]) => value != null));
    try { await download(`/dashboard/export?${params}`, '资金台账明细.xlsx'); }
    catch (err) { setError(err.message || '下载失败，请重试'); }
    finally { setBusy(false); }
  }
  return <span className="dashboard-download">
    <button type="button" onClick={save} disabled={busy} title="下载当前筛选下的全部记录，金额单位为元">{busy ? '正在下载…' : label}</button>
    {error && <span className="download-error" role="alert">{error}</span>}
  </span>;
}
