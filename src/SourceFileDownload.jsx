import { useState } from 'react';
import { download, useResource } from './api.js';
import { dateTime } from './format.js';
import { ErrorNotice, Loading, Modal } from './components.jsx';

export default function SourceFileDownload({ onClose }) {
  const [refresh, setRefresh] = useState(0);
  const funds = useResource('/files', refresh);
  const oa = useResource('/oa-flows', refresh);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState(null);
  const loading = funds.loading || oa.loading;
  const slots = [...(funds.data?.slots || []), ...(oa.data?.slots || [])];

  async function downloadFile(slot) {
    setBusy(slot.id); setError(null);
    try {
      await download(`/files/${slot.id}/versions/${slot.currentVersionId}/download`, slot.filename);
    } catch (err) { setError(err); }
    finally { setBusy(''); }
  }

  return <Modal title="下载底表" onClose={onClose} wide actions={<button disabled={loading || Boolean(busy)} onClick={() => { setError(null); setRefresh(value => value + 1); }}>刷新列表</button>}>
    <p className="muted">下载文件管理中的当前有效原文件。</p>
    <ErrorNotice error={funds.error || oa.error || error} />
    {loading ? <Loading /> : <div className="table-wrap"><table className="source-file-table" aria-label="当前底表文件">
      <thead><tr><th>文件类别</th><th>当前文件</th><th>上传时间</th><th>操作</th></tr></thead>
      <tbody>{slots.map(slot => <tr key={slot.id}>
        <th scope="row">{slot.label}</th>
        <td>{slot.filename || '尚未上传'}</td>
        <td>{slot.currentVersionId ? dateTime(slot.uploadedAt) : '—'}</td>
        <td>{slot.currentVersionId ? <button disabled={Boolean(busy)} aria-label={`下载${slot.label}原文件`} onClick={() => downloadFile(slot)}>{busy === slot.id ? '下载中…' : '下载原文件'}</button> : '—'}</td>
      </tr>)}</tbody>
    </table></div>}
  </Modal>;
}
