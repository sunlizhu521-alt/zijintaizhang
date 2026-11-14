import { useState } from 'react';
import { PERMISSIONS } from '../shared/constants.js';
import { isValidPassword, PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, PASSWORD_MESSAGE } from '../shared/password.js';
import { api, download, queryString, useResource } from './api.js';
import { can, dateTime } from './format.js';
import { Empty, ErrorNotice, Loading, Modal, Notice, Pager } from './components.jsx';

export default function System({ user, onUserChanged }) {
  const tabs = [
    ...(user.isAdmin ? [{ id: 'users', label: '用户与权限' }] : []),
    ...(can(user, 'logsLogin') ? [{ id: 'login', label: '登录记录' }] : []),
    ...(can(user, 'logsOperation') ? [{ id: 'operation', label: '操作记录' }] : []),
    ...(can(user, 'logsSecurity') ? [{ id: 'security', label: '安全异常' }] : []),
  ];
  const [selected, setSelected] = useState(tabs[0]?.id);
  const active = tabs.find(tab => tab.id === selected)?.id || tabs[0]?.id;
  return <div className="page-stack"><div className="page-heading"><div><p className="eyebrow">账号、操作与访问记录</p><h1>系统管理</h1><p className="subtitle">记录谁在何时操作，以及被拒绝或触发规则的访问。</p></div></div><nav className="tabs" aria-label="系统管理分类">{tabs.map(tab => <button key={tab.id} className={active === tab.id ? 'active' : ''} aria-current={active === tab.id ? 'page' : undefined} onClick={() => setSelected(tab.id)}>{tab.label}</button>)}</nav>{active === 'users' ? <Users currentUser={user} onUserChanged={onUserChanged} /> : active ? <Logs key={active} kind={active} user={user} /> : <Empty title="当前账号没有系统管理权限" />}</div>;
}

const emptyUser = () => ({ username: '', displayName: '', password: '', isAdmin: false, active: true, permissions: ['dashboard'] });

function Users({ currentUser, onUserChanged }) {
  const [refresh, setRefresh] = useState(0);
  const { data, loading, error } = useResource('/users', refresh);
  const [editing, setEditing] = useState(null);
  const [resetUser, setResetUser] = useState(null);
  const [resetPassword, setResetPassword] = useState('');
  const [actionError, setActionError] = useState(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const edit = (name, value) => setEditing(previous => ({ ...previous, [name]: value }));
  async function saveUser(event) {
    event.preventDefault(); setBusy(true); setActionError(null); setMessage('');
    try {
      const { id, username, displayName, password, isAdmin, permissions, active } = editing;
      if (!id && !isValidPassword(password)) throw new Error(PASSWORD_MESSAGE);
      await api(id ? `/users/${id}` : '/users', { method: id ? 'PATCH' : 'POST', body: id ? { displayName, isAdmin, active, ...(!isAdmin ? { permissions } : {}) } : { username, displayName, password, isAdmin, permissions: isAdmin ? [] : permissions } });
      setEditing(null); setRefresh(value => value + 1); setMessage(id ? '用户信息和权限已更新。' : '账号已创建，首次登录需要修改初始密码。');
      if (id === currentUser.id) await onUserChanged();
    } catch (err) { setActionError(err); } finally { setBusy(false); }
  }
  async function reset(event) {
    event.preventDefault(); setBusy(true); setActionError(null); setMessage('');
    try {
      if (!isValidPassword(resetPassword)) throw new Error(PASSWORD_MESSAGE);
      await api(`/users/${resetUser.id}/reset-password`, { method: 'POST', body: { password: resetPassword } });
      setMessage(`已重置 ${resetUser.displayName || resetUser.username} 的密码，原会话已失效。`);
      const self = resetUser.id === currentUser.id;
      setResetUser(null); setResetPassword(''); setRefresh(value => value + 1);
      if (self) await onUserChanged();
    } catch (err) { setActionError(err); } finally { setBusy(false); }
  }
  async function toggleActive(account) {
    if (account.active && !window.confirm(`停用 ${account.displayName || account.username}？该账号的已登录会话将立即失效。`)) return;
    setBusy(true); setActionError(null); setMessage('');
    try { await api(`/users/${account.id}`, { method: 'PATCH', body: { active: !account.active } }); setRefresh(value => value + 1); setMessage(account.active ? '账号已停用。' : '账号已启用。'); } catch (err) { setActionError(err); } finally { setBusy(false); }
  }
  return <section className="panel"><div className="section-heading"><div><h2>用户与权限</h2><p>按页面和操作逐项授权；获准页面内可查看全部业务数据。</p></div><button className="primary" onClick={() => { setEditing(emptyUser()); setActionError(null); }} disabled={busy}>创建用户</button></div>
    <ErrorNotice error={error || (!editing && !resetUser ? actionError : null)} /><Notice type="success">{message}</Notice>
    {loading ? <Loading /> : <div className="table-wrap"><table aria-label="账号列表"><thead><tr><th>姓名 / 账号</th><th>角色</th><th>账号状态</th><th>权限</th><th>创建时间</th><th>操作</th></tr></thead><tbody>{data?.users?.map(account => <tr key={account.id}><td><strong>{account.displayName || account.username}</strong><span className="cell-secondary">{account.username}{account.id === currentUser.id ? '（当前账号）' : ''}</span></td><td>{account.isAdmin ? '管理员' : '普通用户'}</td><td><span className={`tag ${account.active ? 'success' : 'neutral'}`}>{account.active ? '启用' : '停用'}</span>{account.mustChangePassword && <span className="cell-secondary">下次登录须改密</span>}</td><td className="permission-summary">{account.isAdmin ? '全部权限' : account.permissions?.map(key => PERMISSIONS[key]).filter(Boolean).join('、') || '未授权'}</td><td className="nowrap">{dateTime(account.createdAt)}</td><td><div className="row-actions"><button disabled={busy} onClick={() => { setEditing({ ...account, permissions: [...(account.permissions || [])] }); setActionError(null); }}>编辑权限</button><button disabled={busy} onClick={() => { setResetUser(account); setResetPassword(''); setActionError(null); }}>重置密码</button>{account.id !== currentUser.id && <button disabled={busy} onClick={() => toggleActive(account)}>{account.active ? '停用' : '启用'}</button>}</div></td></tr>)}</tbody></table></div>}
    {editing && <Modal title={editing.id ? '编辑用户权限' : '创建用户'} onClose={() => { if (!busy) setEditing(null); }}><form onSubmit={saveUser}><div className="form-stack"><label>登录账号<input required maxLength={64} autoComplete="off" disabled={Boolean(editing.id)} value={editing.username} onChange={event => edit('username', event.target.value)} /></label><label>显示姓名<input required maxLength={80} autoComplete="off" value={editing.displayName} onChange={event => edit('displayName', event.target.value)} /></label>{!editing.id && <label>初始密码<input type="password" required minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH * 2} autoComplete="new-password" value={editing.password} onChange={event => edit('password', event.target.value)} /><small>{PASSWORD_MESSAGE}；首次登录必须修改。</small></label>}<label className="check-row"><input type="checkbox" checked={Boolean(editing.isAdmin)} onChange={event => edit('isAdmin', event.target.checked)} /><span>管理员（拥有全部权限及账号管理能力）</span></label>{!editing.isAdmin && <fieldset className="permission-picker"><legend>页面与操作权限</legend>{Object.entries(PERMISSIONS).map(([key, label]) => <label className="check-row" key={key}><input type="checkbox" checked={editing.permissions.includes(key)} onChange={event => edit('permissions', event.target.checked ? [...editing.permissions, key] : editing.permissions.filter(item => item !== key))} /><span>{label}</span></label>)}</fieldset>}<p className="muted">上传、下载和恢复需同时拥有“查看文件管理”；导出需拥有对应页面的查看权限。</p><ErrorNotice error={actionError} /></div><div className="modal-actions"><button type="button" disabled={busy} onClick={() => setEditing(null)}>取消</button><button className="primary" disabled={busy}>{busy ? '保存中…' : '保存'}</button></div></form></Modal>}
    {resetUser && <Modal title={`重置密码 · ${resetUser.displayName || resetUser.username}`} onClose={() => { if (!busy) { setResetUser(null); setResetPassword(''); } }}><form onSubmit={reset}><div className="form-stack"><Notice>重置后原会话立即失效，该用户再次登录时必须修改初始密码。</Notice><label>新的初始密码<input type="password" minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH * 2} required autoComplete="new-password" value={resetPassword} onChange={event => setResetPassword(event.target.value)} /><small>{PASSWORD_MESSAGE}。</small></label><ErrorNotice error={actionError} /></div><div className="modal-actions"><button type="button" disabled={busy} onClick={() => { setResetUser(null); setResetPassword(''); }}>取消</button><button className="primary" disabled={busy}>{busy ? '保存中…' : '重置密码'}</button></div></form></Modal>}
  </section>;
}

const titles = { login: '登录记录', operation: '操作记录', security: '安全异常' };
const outcomeLabels = { success: '成功', failure: '失败', blocked: '已拦截' };
const actorLabel = item => item.actorName || item.actor || (item.details?.attemptedUsername ? `${item.details.attemptedUsername}（未验证）` : '未登录访问');
function Logs({ kind, user }) {
  const [draft, setDraft] = useState({ from: '', to: '', actor: '', outcome: '' });
  const [filters, setFilters] = useState(draft);
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [actionError, setActionError] = useState(null);
  const query = queryString({ ...filters, kind, page });
  const { data, loading, error } = useResource(`/logs?${query}`, refresh);
  const [selected, setSelected] = useState(null);
  async function exportRows() {
    setExporting(true); setActionError(null);
    try { await download(`/logs/export?${queryString({ ...filters, kind })}`, `${titles[kind]}.xlsx`); } catch (err) { setActionError(err); } finally { setExporting(false); }
  }
  return <section className="panel"><div className="section-heading"><div><h2>{titles[kind]}</h2><p>北京时间 · 默认保留一年</p></div><div className="row-actions"><button disabled={loading} onClick={() => setRefresh(value => value + 1)}>刷新</button>{can(user, 'export') && <button disabled={exporting} onClick={exportRows}>{exporting ? '导出中…' : '导出记录'}</button>}</div></div>
    {kind === 'security' && <Notice type="warning">这里显示触发网站规则的疑似异常和拦截结果，例如连续登录失败、越权访问、异常路径或请求过密。不代表已确认攻击者，也不包含腾讯云服务器安全告警。</Notice>}
    <form className="log-filters" onSubmit={event => { event.preventDefault(); setFilters({ ...draft }); setPage(1); }}><label>开始日期<input type="date" value={draft.from} max={draft.to || undefined} onChange={event => setDraft(previous => ({ ...previous, from: event.target.value }))} /></label><label>结束日期<input type="date" value={draft.to} min={draft.from || undefined} onChange={event => setDraft(previous => ({ ...previous, to: event.target.value }))} /></label><label>账号 / 姓名<input value={draft.actor} maxLength={80} placeholder="按操作人筛选" onChange={event => setDraft(previous => ({ ...previous, actor: event.target.value }))} /></label><label>结果<select value={draft.outcome} onChange={event => setDraft(previous => ({ ...previous, outcome: event.target.value }))}><option value="">全部结果</option>{Object.entries(outcomeLabels).map(([key, value]) => <option value={key} key={key}>{value}</option>)}</select></label><button type="submit">查询</button><button type="button" onClick={() => { const clear = { from: '', to: '', actor: '', outcome: '' }; setDraft(clear); setFilters(clear); setPage(1); }}>重置</button></form>
    <ErrorNotice error={error || actionError} />
    {loading ? <Loading /> : !data?.items?.length ? <Empty title="当前条件下暂无记录" /> : <><div className="table-wrap"><table aria-label={titles[kind]}><thead><tr><th>时间（北京时间）</th><th>账号 / 姓名</th><th>操作 / 事件</th><th>对象</th><th>来源 IP</th><th>结果</th><th>详情</th></tr></thead><tbody>{data.items.map(item => <tr key={item.id}><td className="nowrap">{dateTime(item.createdAt)}</td><td>{actorLabel(item)}</td><td>{item.action || '—'}</td><td className="log-target">{item.target || item.path || '—'}</td><td className="mono">{item.ip || '—'}</td><td><span className={`tag ${item.outcome === 'success' ? 'success' : 'warning'}`}>{outcomeLabels[item.outcome] || item.outcome || '—'}</span></td><td><button className="text-button" onClick={() => setSelected(item)}>查看</button></td></tr>)}</tbody></table></div><Pager page={data.page || page} total={data.total || 0} size={data.pageSize || 20} onChange={setPage} /></>}
    {selected && <Modal title="记录详情" onClose={() => setSelected(null)}><dl className="detail-grid">{[['时间', dateTime(selected.createdAt)], ['操作人', actorLabel(selected)], ['事件', selected.action], ['对象', selected.target], ['来源 IP', selected.ip], ['浏览器', selected.userAgent], ['请求', `${selected.method || ''} ${selected.path || ''}`], ['状态码', selected.status], ['结果', outcomeLabels[selected.outcome] || selected.outcome]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{String(value ?? '—')}</dd></div>)}</dl>{selected.details && <><h3>事件内容</h3><pre className="log-details">{typeof selected.details === 'string' ? selected.details : JSON.stringify(selected.details, null, 2)}</pre></>}</Modal>}
  </section>;
}
