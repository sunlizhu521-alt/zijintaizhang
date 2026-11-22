import { useEffect, useState } from 'react';
import { isValidPassword, PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, PASSWORD_MESSAGE } from '../shared/password.js';
import { api, setCsrfToken } from './api.js';
import { can } from './format.js';
import { Empty, ErrorNotice, Loading, Modal, Notice } from './components.jsx';
import Dashboard from './Dashboard.jsx';
import Files from './Files.jsx';
import System from './System.jsx';
import Delivery from './Delivery.jsx';
import PaymentAnalysis from './PaymentAnalysis.jsx';

const ordersPage = window.location.pathname.replace(/\/$/, '') === '/caigoudingdangenjin';
const deliveryPage = window.location.pathname.replace(/\/$/, '') === '/gongyingshangjiaofu';
const appTitle = deliveryPage ? '供应商交付管理' : ordersPage ? '采购订单跟进' : '资金台账';
const authClass = deliveryPage ? 'auth-page delivery-auth' : ordersPage ? 'auth-page' : 'auth-page funds-auth';

export default function App() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(ordersPage ? 'orders' : 'dashboard');
  const [changingPassword, setChangingPassword] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  async function refreshSession() {
    try { const result = await api('/auth/session'); setCsrfToken(result.csrfToken); setSession(result); setError(null); }
    catch (err) { if (err.status === 401) { setSession(null); setCsrfToken(''); } else setError(err); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    refreshSession();
    const expired = () => { setSession(null); setCsrfToken(''); setChangingPassword(false); setError(new Error('登录已失效，请重新登录。')); };
    window.addEventListener('session-expired', expired);
    return () => window.removeEventListener('session-expired', expired);
  }, []);
  function loggedIn(value) { setCsrfToken(value.csrfToken); setSession(value); setError(null); }
  async function logout() {
    setLoggingOut(true); setError(null);
    try { await api('/auth/logout', { method: 'POST', body: {} }); setSession(null); setCsrfToken(''); }
    catch (err) { if (err.status === 401) { setSession(null); setCsrfToken(''); } else setError(err); }
    finally { setLoggingOut(false); }
  }
  if (loading) return <div className={authClass}><Loading /></div>;
  if (!session?.user) return <Login onLogin={loggedIn} sessionError={error} />;
  const user = session.user;
  if (user.mustChangePassword) return <div className={authClass}><section className="auth-card"><Brand /><h1>请设置自己的密码</h1><p className="subtitle">首次登录或管理员重置后，需要修改密码才能使用系统。</p><PasswordForm onSaved={loggedIn} /><button className="text-button auth-logout" onClick={logout} disabled={loggingOut}>退出登录</button><ErrorNotice error={error} /></section></div>;
  if (deliveryPage) return <div className="delivery-shell"><Delivery user={user} onPassword={() => setChangingPassword(true)} onLogout={logout} loggingOut={loggingOut} sessionError={error} />{changingPassword && <Modal title="修改密码" onClose={() => setChangingPassword(false)}><PasswordForm onSaved={result => { loggedIn(result); setChangingPassword(false); }} /></Modal>}</div>;
  const navigation = ordersPage ? (can(user, 'files') ? [{ id: 'orders', label: '采购订单跟进', mark: '▤' }] : []) : [
    ...(can(user, 'dashboard') ? [{ id: 'dashboard', label: '资金简报', mark: '▥' }, { id: 'payment-analysis', label: '资金付款分析', mark: '▥' }] : []),
    ...(can(user, 'files') ? [{ id: 'files', label: '文件管理', mark: '▤' }] : []),
    ...(user.isAdmin || ['logsLogin', 'logsOperation', 'logsSecurity'].some(permission => can(user, permission)) ? [{ id: 'system', label: '系统管理', mark: '⚙' }] : []),
  ];
  const active = navigation.find(item => item.id === page)?.id || navigation[0]?.id;
  return <div className={ordersPage ? 'app-shell' : 'app-shell funds-shell'}>
    <a href="#main-content" className="skip-link">跳至主要内容</a>
    <aside className="sidebar"><Brand /><p className="sidebar-description">{ordersPage ? '订单文件与版本管理' : '采购付款与资金计划'}</p><nav aria-label="主导航">{navigation.map(item => <button key={item.id} className={active === item.id ? 'active' : ''} aria-current={active === item.id ? 'page' : undefined} onClick={() => { setPage(item.id); setError(null); }}><span aria-hidden="true">{item.mark}</span>{item.label}</button>)}</nav><div className="sidebar-bottom"><div className="account"><span className="avatar" aria-hidden="true">{(user.displayName || user.username).slice(0, 1)}</span><div><strong>{user.displayName || user.username}</strong><small>{user.isAdmin ? '管理员' : '授权用户'}</small></div></div><div className="account-actions"><button onClick={() => setChangingPassword(true)}>修改密码</button><button onClick={logout} disabled={loggingOut}>{loggingOut ? '退出中…' : '退出登录'}</button></div><span className="sidebar-footnote">{appTitle} · 业务数据来自上传文件</span></div></aside>
    <main id="main-content" tabIndex={-1}><ErrorNotice error={error} />{active === 'orders' ? <Files user={user} orders /> : active === 'dashboard' ? <Dashboard user={user} /> : active === 'payment-analysis' ? <PaymentAnalysis user={user} /> : active === 'files' ? <Files user={user} /> : active === 'system' ? <System user={user} onUserChanged={refreshSession} /> : <Empty title="账号尚未获得页面权限">请联系管理员分配所需页面与操作权限。</Empty>}</main>
    {changingPassword && <Modal title="修改密码" onClose={() => setChangingPassword(false)}><PasswordForm onSaved={result => { loggedIn(result); setChangingPassword(false); }} /></Modal>}
  </div>;
}

function Brand() { return <div className="brand"><span className="brand-mark" aria-hidden="true">{deliveryPage ? '▥' : ordersPage ? '▤' : '¥'}</span><span>{appTitle}<small>{deliveryPage ? '订单 · 生产 · 交付' : ordersPage ? '金蝶采购订单' : '付款计划管理'}</small></span></div>; }

function Login({ onLogin, sessionError }) {
  const [initialized, setInitialized] = useState(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { let alive = true; api('/auth/status').then(result => { if (alive) setInitialized(result.initialized); }).catch(err => { if (alive) setError(err); }); return () => { alive = false; }; }, []);
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError(null);
    try { onLogin(await api('/auth/login', { method: 'POST', body: { username, password } })); setPassword(''); }
    catch (err) { setError(err); setPassword(''); }
    finally { setBusy(false); }
  }
  return <div className={authClass}><section className="auth-card"><Brand /><h1>登录{appTitle}</h1><p className="subtitle">{deliveryPage || ordersPage ? '使用资金台账的账号登录，沿用现有操作权限。' : '使用管理员为你创建的账号登录。'}</p><ErrorNotice error={error || sessionError} />{initialized === false ? <Notice>系统尚未初始化。请管理员先在服务器完成首个账号设置，随后刷新本页。</Notice> : initialized == null && !error ? <Loading /> : <form onSubmit={submit} className="form-stack"><label>账号<input required name="username" autoComplete="username" maxLength={64} value={username} onChange={event => setUsername(event.target.value)} autoFocus /></label><label>密码<input type="password" required name="password" autoComplete="current-password" maxLength={PASSWORD_MAX_LENGTH * 2} value={password} onChange={event => setPassword(event.target.value)} /></label><button className="primary login-button" disabled={busy}>{busy ? '正在登录…' : '登录'}</button></form>}<p className="auth-footnote">文件、版本和操作记录在服务器保存。</p></section></div>;
}

function PasswordForm({ onSaved }) {
  const [values, setValues] = useState({ currentPassword: '', newPassword: '', repeat: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function submit(event) {
    event.preventDefault(); setError(null);
    if (values.newPassword !== values.repeat) { setError(new Error('两次输入的新密码不一致。')); return; }
    if (!isValidPassword(values.newPassword)) { setError(new Error(PASSWORD_MESSAGE)); return; }
    setBusy(true);
    try { const result = await api('/auth/password', { method: 'POST', body: { currentPassword: values.currentPassword, newPassword: values.newPassword } }); setValues({ currentPassword: '', newPassword: '', repeat: '' }); onSaved(result); }
    catch (err) { setError(err); }
    finally { setBusy(false); }
  }
  return <form onSubmit={submit} className="form-stack"><label>当前密码<input type="password" required autoComplete="current-password" value={values.currentPassword} onChange={event => setValues(previous => ({ ...previous, currentPassword: event.target.value }))} /></label><label>新密码<input type="password" required minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH * 2} autoComplete="new-password" value={values.newPassword} onChange={event => setValues(previous => ({ ...previous, newPassword: event.target.value }))} /><small>{PASSWORD_MESSAGE}。</small></label><label>再次输入新密码<input type="password" required minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH * 2} autoComplete="new-password" value={values.repeat} onChange={event => setValues(previous => ({ ...previous, repeat: event.target.value }))} /></label><ErrorNotice error={error} /><button className="primary" disabled={busy}>{busy ? '正在保存…' : '保存新密码'}</button></form>;
}
