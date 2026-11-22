import { useRef, useState } from 'react';
import { CATEGORIES, MAX_UPLOAD_BYTES, ORDER_SLOT, SLOTS } from '../shared/constants.js';
import { isInformationIssue } from '../shared/issue-level.js';
import { api, download, useResource } from './api.js';
import { can, dateTime } from './format.js';
import { Empty, ErrorNotice, InformationNotes, IssuesTable, Loading, Modal, Notice, RecordsTable } from './components.jsx';

export default function Files({ user, orders = false }) {
  const [refresh, setRefresh] = useState(0);
  const { data, error, loading } = useResource(orders ? '/orders' : '/files', refresh);
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState(null);
  const [message, setMessage] = useState('');
  const [preview, setPreview] = useState(null);
  const [selection, setSelection] = useState([]);
  const [history, setHistory] = useState(null);
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const inputs = useRef({});
  const slots = data?.slots || [];
  const definitions = orders ? [ORDER_SLOT] : SLOTS;

  async function upload(slot, file) {
    if (!file) return;
    setActionError(null); setMessage('');
    if (!/\.xlsx$/i.test(file.name)) { setActionError(new Error('请选择 .xlsx 工作簿。')); return; }
    if (!file.size || file.size > MAX_UPLOAD_BYTES) { setActionError(new Error('文件不能为空且不能超过 20 MB。')); return; }
    setBusy(slot.id);
    try {
      const body = new FormData(); body.append('file', file);
      const result = await api(`/files/${slot.id}/preview`, { method: 'POST', body });
      setPreview({ ...result, slot });
      setSelection(result.selectedSheets || result.sheets?.filter(sheet => sheet.eligible && sheet.defaultSelected).map(sheet => sheet.name) || []);
    } catch (err) { setActionError(err); } finally { setBusy(''); if (inputs.current[slot.id]) inputs.current[slot.id].value = ''; }
  }
  async function activate() {
    setBusy('activate'); setActionError(null);
    try {
      await api(`/files/${preview.slot.id}/activate`, { method: 'POST', body: { token: preview.token, baseRevision: preview.baseRevision, selectedSheets: selection } });
      setMessage(`${preview.slot.label}已更新；旧版本已保留。`); setPreview(null); setRefresh(value => value + 1);
    } catch (err) {
      setActionError(err);
      if (err.status === 409) { setPreview(null); setRefresh(value => value + 1); }
    } finally { setBusy(''); }
  }
  return <div className="page-stack">
    <div className="page-heading"><div><p className="eyebrow">{orders ? '订单文件 · 版本留存' : '四个槽位 · 独立更新'}</p><h1>{orders ? '采购订单跟进' : '文件管理'}</h1><p className="subtitle">{orders ? '上传金蝶导出的采购订单，集中保存最新文件与历史版本。' : '在 Excel 修改业务数据，上传校验后替换当前版本。'}</p></div><button onClick={() => setRefresh(value => value + 1)} disabled={loading || Boolean(busy)}>刷新状态</button></div>
    {!orders && <Notice>“谈判付款”按“是否谈判分批”分为谈判付款-谈判付款表（是）和正常付款-谈判付款表（否）；“正常付款”中填写“预估时间”的归为正常付款-未完成对账，其余归为正常付款-正常对账表。三个预估槽位各自上传实际数据。</Notice>}
    <ErrorNotice error={error || (!preview ? actionError : null)} /><Notice type="success">{message}</Notice>
    {loading ? <Loading /> : <div className={`file-grid${orders ? ' order-file-grid' : ''}`}>{definitions.map(definition => {
      const slot = { ...definition, ...slots.find(value => value.id === definition.id) };
      return <section className="panel file-card" key={slot.id}>
        <div className="file-card-heading"><span className="file-icon" aria-hidden="true">X</span><div><h2>{slot.label}</h2><span className={`tag ${slot.currentVersionId ? 'success' : 'neutral'}`}>{slot.currentVersionId ? '已有有效版本' : '尚未上传'}</span></div></div>
        <p className="file-description">{orders ? '保存完整原始工作簿。上传新版本后，旧文件仍可下载或恢复。' : slot.id === 'schedule' ? '须包含谈判付款、正常付款、付款进度整理；谈判表须填写“是否谈判分批”。进度表提供付款依据。' : '按人员工作表读取预估月份、供应商、付款主体、金额和备注。'}</p>
        {slot.currentVersionId ? <><div className="file-name" title={slot.filename}>{slot.filename}</div><dl className="file-metadata"><div><dt>上传人</dt><dd>{slot.uploadedBy || '—'}</dd></div><div><dt>上传时间</dt><dd>{dateTime(slot.uploadedAt)}</dd></div>{!orders && <><div><dt>有效记录</dt><dd>{slot.recordCount ?? 0} 条</dd></div><div><dt>待核对</dt><dd>{slot.issueCount ?? 0} 项</dd></div></>}</dl></> : <div className="file-placeholder">上传后显示文件版本与上传信息</div>}
        <div className="file-actions">
          {can(user, 'upload') && <><input ref={node => { inputs.current[slot.id] = node; }} type="file" accept=".xlsx" className="sr-only" id={`upload-${slot.id}`} aria-label={`上传${slot.label}`} onChange={event => upload(slot, event.target.files[0])} /><button className="primary" disabled={Boolean(busy) || loading || Boolean(error)} onClick={() => inputs.current[slot.id]?.click()}>{busy === slot.id ? '正在读取…' : slot.currentVersionId ? '上传新版本' : '上传文件'}</button></>}
          {orders && slot.currentVersionId && can(user, 'download') && <button disabled={Boolean(busy)} onClick={async () => { setBusy('download'); setActionError(null); try { await download(`/files/${slot.id}/versions/${slot.currentVersionId}/download`, slot.filename); } catch (err) { setActionError(err); } finally { setBusy(''); } }}>下载原文件</button>}
          <button disabled={!slot.currentVersionId || Boolean(busy)} onClick={() => { setHistory(slot); setActionError(null); }}>版本记录</button>
        </div>
      </section>;
    })}</div>}
    <p className="scope-note">{orders ? '仅支持 .xlsx，单文件不超过 20 MB。本页提供文件保存与版本管理，订单明细和跟进统计待业务规则确定后添加。文件时间均按北京时间显示。' : '仅支持 .xlsx，单文件不超过 20 MB。金额为空或公式无已保存计算结果时按 0 保存；其他校验失败时，当前有效数据保持不变。文件时间均按北京时间显示。'}</p>
    {preview && <Modal title={`校验并替换 · ${preview.slot.label}`} onClose={() => { if (!busy) { setPreview(null); setActionError(null); } }} wide>
      <p className="file-name">{preview.filename}</p>
      <Notice>{orders ? '确认文件后保存完整工作簿，所有工作表和原始内容均保留。旧文件保留在版本记录中。' : '确认读取的工作表后，点击“校验并替换”。系统会重新校验并整体更新这个槽位，旧文件保留在版本记录中。'}</Notice>
      {orders ? <WorkbookSheets sheets={preview.sheets} /> : <>
      <fieldset className="sheet-picker"><legend>读取的工作表</legend>{preview.sheets?.map(sheet => <label className="check-row" key={sheet.name}><input type="checkbox" checked={selection.includes(sheet.name)} disabled={preview.slot.id === 'schedule' || !sheet.eligible || Boolean(busy)} onChange={event => setSelection(previous => event.target.checked ? [...previous, sheet.name] : previous.filter(name => name !== sheet.name))} /><span><strong>{sheet.name}</strong><small>{sheet.reason || (sheet.defaultSelected ? '默认读取' : '默认不读取，可自行选择')}</small></span></label>)}</fieldset>
      {preview.slot.id === 'schedule' && <p className="muted">固定读取谈判付款、正常付款和付款进度整理。进度表只提供付款依据，不重复计入金额。</p>}
      <div className="import-summary"><span>默认选择：<strong>{preview.recordCount ?? '—'}</strong> 条记录</span><span>待核对：<strong>{preview.issueCount ?? preview.issues?.length ?? 0}</strong> 项</span>{preview.categoryCounts && Object.entries(preview.categoryCounts).map(([key, count]) => <span key={key}>{CATEGORIES[key] || key}：{count} 条</span>)}</div>
      <p className="muted">更改工作表选择后，以最终校验结果为准。</p>
      </>}
      {preview.validationError && <Notice type="warning">{typeof preview.validationError === 'string' ? preview.validationError : preview.validationError.message || '默认工作表校验未通过，请检查原文件或调整工作表选择。'}</Notice>}
      <ErrorNotice error={actionError} />
      {!!preview.issues?.some(issue => !isInformationIssue(issue)) && <details><summary>查看默认工作表的核对项</summary><IssuesTable issues={preview.issues.filter(issue => !isInformationIssue(issue))} /></details>}
      <InformationNotes issues={preview.issues?.filter(isInformationIssue)} />
      <div className="modal-actions"><button disabled={Boolean(busy)} onClick={() => { setPreview(null); setActionError(null); }}>取消</button><button className="primary" disabled={Boolean(busy) || !selection.length} onClick={activate}>{busy === 'activate' ? '正在校验并保存…' : '校验并替换'}</button></div>
    </Modal>}
    {history && <History slot={{ ...history, ...slots.find(slot => slot.id === history.id) }} user={user} refresh={historyRefresh} onClose={() => setHistory(null)} onRestore={() => { setRefresh(value => value + 1); setHistoryRefresh(value => value + 1); setMessage(`${history.label}已恢复所选历史版本。`); }} />}
  </div>;
}

function History({ slot, user, refresh, onClose, onRestore }) {
  const orders = slot.id === ORDER_SLOT.id;
  const { data, loading, error } = useResource(`/files/${slot.id}/versions`, refresh);
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState(null);
  async function action(version, type) {
    if (type === 'restore' && !window.confirm(`将“${version.filename}”（${dateTime(version.uploadedAt)}）恢复为当前版本？现有版本仍会保留。`)) return;
    setBusy(`${version.id}-${type}`); setActionError(null);
    try {
      if (type === 'download') await download(`/files/${slot.id}/versions/${version.id}/download`, version.filename || `${slot.id}.xlsx`);
      if (type === 'view') setDetail(await api(`/files/${slot.id}/versions/${version.id}`));
      if (type === 'restore') { await api(`/files/${slot.id}/restore`, { method: 'POST', body: { versionId: version.id, baseRevision: slot.revision } }); onRestore(); setDetail(null); }
    } catch (err) { setActionError(err); } finally { setBusy(''); }
  }
  return <Modal title={`${slot.label} · 版本记录`} onClose={onClose} wide>
    <ErrorNotice error={error || actionError} />
    {loading ? <Loading /> : !data?.versions?.length ? <Empty title="暂无历史版本" /> : <div className="table-wrap"><table aria-label="文件版本记录"><thead><tr><th>文件 / 状态</th><th>上传人</th><th>上传时间</th><>{!orders && <><th className="numeric">记录数</th><th className="numeric">核对项</th></>}</><th>操作</th></tr></thead><tbody>{data.versions.map(version => <tr key={version.id}><td><strong>{version.filename}</strong>{version.current && <span className="tag success current-tag">当前有效</span>}</td><td>{version.uploadedBy || '—'}</td><td className="nowrap">{dateTime(version.uploadedAt)}</td>{!orders && <><td className="numeric">{version.recordCount}</td><td className="numeric">{version.issueCount}</td></>}<td><div className="row-actions"><button disabled={Boolean(busy)} onClick={() => action(version, 'view')}>查看</button>{can(user, 'download') && <button disabled={Boolean(busy)} onClick={() => action(version, 'download')}>下载</button>}{can(user, 'restore') && !version.current && <button disabled={Boolean(busy)} onClick={() => action(version, 'restore')}>恢复为当前</button>}</div></td></tr>)}</tbody></table></div>}
    {busy && <Loading />}
    {detail && <div className="history-detail"><div className="section-heading"><h3>{detail.version?.filename || '历史版本内容'}</h3><button onClick={() => setDetail(null)}>收起内容</button></div><>{orders ? <WorkbookSheets sheets={detail.sheets} /> : <><p className="muted">以下是该历史文件的数据，不影响当前看板。</p>
      {detail.progressScope && <Notice>{detail.progressScope === 'self' ? '付款依据使用本历史文件自身的付款进度整理。' : '付款依据使用当前有效付款节奏，随当前版本更新。'}{detail.progressSource ? ` 文件：${detail.progressSource.filename}；版本：${detail.progressSource.id?.slice(0, 8)}。` : '当前没有可关联的付款节奏版本，相关付款计未付。'}</Notice>}
      <RecordsTable records={detail.records} label="历史文件明细" /><details><summary>历史文件待核对事项</summary><IssuesTable issues={detail.issues.filter(issue => !isInformationIssue(issue))} /></details><InformationNotes issues={detail.issues.filter(isInformationIssue)} /></>}</></div>}
  </Modal>;
}

function WorkbookSheets({ sheets = [] }) {
  return <div className="table-wrap"><table aria-label="原文件工作表"><thead><tr><th>完整保存的工作表（{sheets.length} 张）</th></tr></thead><tbody>{sheets.map(sheet => <tr key={sheet.name}><td>{sheet.name}</td></tr>)}</tbody></table></div>;
}
