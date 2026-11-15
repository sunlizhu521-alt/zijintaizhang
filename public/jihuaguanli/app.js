import { today, shiftDate, weekStart, weekLabel, exerciseStats, parseEntries } from './logic.js';

const API = '/zijintaizhang/api';
const $ = (selector, root = document) => root.querySelector(selector);
const e = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths = {
  plan:'M5 4h14v17H5z M9 2v4m6-4v4M8 11l2 2 4-4m-6 8h8', todo:'M8 6h12M8 12h12M8 18h12M3 6h.1M3 12h.1M3 18h.1',
  inspiration:'M9 18h6m-5 3h4M8 14a7 7 0 1 1 8 0c-1 1-1 2-1 2H9s0-1-1-2',work:'M3 7h18v13H3zM8 7V4h8v3M3 11l9 4 9-4',
  life:'M3 11l9-8 9 8M5 10v11h14V10M9 21v-7h6v7',book:'M3 4c4-1 6 0 9 2 3-2 5-3 9-2v16c-4-1-6 0-9 1-3-1-5-2-9-1zM12 6v15',
  quote:'M4 6h6v7H4zM14 6h6v7h-6zM10 13c0 4-3 5-5 5m15-5c0 4-3 5-5 5',exercise:'M3 9v6m3-9v12m12-12v12m3-9v6M6 12h12',
  learning:'M2 8l10-5 10 5-10 5zM6 10v7l6 3 6-3v-7M22 8v9',mood:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M8 9h.1m7 0h.1M8 14c2 3 6 3 8 0',
  weekly:'M4 5h16v16H4zM8 3v4m8-4v4M4 10h16M8 14h2m4 0h2m-8 3h2',worklog:'M12 3H4v18h16v-9M10 14l1-4 9-9 3 3-9 9z',
  input:'M4 4h16v16H4zM8 12h8m-4-4v8',arrow:'M5 12h14m-6-6 6 6-6 6',trash:'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
  edit:'M12 4H4v16h16v-8M10 14l1-4 8-8 3 3-8 8z',close:'M6 6l12 12M6 18 18 6',sun:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 1v3m0 16v3M1 12h3m16 0h3M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2',
  check:'M5 12l4 4L20 5',refresh:'M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 14-2l1 6M4 12l1 6a8 8 0 0 0 14-2',leaf:'M20 3C9 1 1 8 6 16s14 0 14-13M5 21l10-12',logout:'M9 4H4v16h5m5-13 5 5-5 5M9 12h12',menu:'M4 6h16M4 12h16M4 18h16',cloud:'M7 18a5 5 0 1 1 0-10 6 6 0 0 1 11 2 4 4 0 1 1 0 8z',
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.plan}"/></svg>`;
const NAV = [['plan','每日计划'],['todo','待办事项'],['inspiration','选题每日灵感'],['work','工作复盘'],['life','生活复盘'],['book','读书笔记'],['quote','好句笔记'],['exercise','运动打卡'],['learning','每日学习汇报'],['mood','心情日记'],['weekly','周复盘'],['worklog','每日工作记录输入'],['input','待办事项输入']];
const intros = {plan:['A LITTLE PROGRESS, EVERY DAY','把重要的小事，慢慢做成日常。'],todo:['ONE THING AT A TIME','给琐事一个位置，把专注留给当下。'],inspiration:['COLLECT YOUR SPARKS','灵感不必完整，先把闪光的念头留下来。'],work:['REFLECT & GROW','回看今天的努力，让明天更有方向。'],life:['LIFE IN THE LITTLE THINGS','认真生活，也温柔地回看自己。'],book:['READ, THINK, REMEMBER','让读过的文字，成为自己的收获。'],quote:['WORDS WORTH KEEPING','把打动你的句子，收藏在这里。'],exercise:['MOVE A LITTLE, FEEL BETTER','每一次出发，都算数。'],learning:['GROW AT YOUR OWN PACE','今天多学一点，未来的你会感谢现在的自己。'],mood:['A MOMENT FOR YOURSELF','今天的你，心情是什么颜色？'],weekly:['PAUSE, REFLECT, BEGIN AGAIN','给这一周一个回应，也给下一周一点期待。'],worklog:['MAKE YOUR WORK VISIBLE','写下工作内容，让每一份努力都有迹可循。'],input:['CLEAR YOUR MIND','把想到的事写下来，下一步就更清楚了。']};
let session, csrf = '', items = [], trashed = [], page = 'plan', date = today(), clockDate = today(), editing = '', category = '', todoFilter = 'pending', busy = false, lastDeleted, preview = [], noticeTimer;
const app = $('#app');
const dialog = $('#dialog');
const list = kind => items.filter(item => item.kind === kind && !item.deleted);
const atDate = kind => list(kind).filter(item => item.date === date);
const recordById = id => items.find(item => item.id === id);
const label = kind => NAV.find(n => n[0] === kind)?.[1] || kind;
const longDate = day => new Date(`${day}T12:00:00+08:00`).toLocaleDateString('zh-CN', {timeZone:'Asia/Shanghai',month:'long',day:'numeric',weekday:'long'});
const tags = value => [...new Set(String(value || '').split(/[,，、\s]+/).map(s => s.replace(/^#/, '')).filter(Boolean))].slice(0,12);
const draftKey = (kind = page) => `planner-draft:${session?.user.id}:${kind}:${kind === 'weekly' ? weekStart(date) : date}:${editing}`;
function draftGet(key = draftKey()) { try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { return null; } }
function draftSet(key, value) { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { notify('浏览器草稿空间不足，请及时保存当前内容。', true); } }
function draftClear(key) { try { sessionStorage.removeItem(key); } catch {} }
function notify(message, error = false, undo = false) {
  clearTimeout(noticeTimer); const el = $('#notice');
  el.className = 'show'; el.innerHTML = `${e(message)}${undo ? '<button data-action="undo">撤销删除</button>' : ''}`;
  el.setAttribute('role', error ? 'alert' : 'status');
  noticeTimer = setTimeout(() => { el.className = ''; }, error ? 12000 : undo ? 10000 : 4500);
}
async function api(path, method = 'GET', body) {
  let response;
  try { response = await fetch(`${API}${path}`, {method,credentials:'same-origin',headers:{...(body ? {'Content-Type':'application/json'} : {}),...(method !== 'GET' ? {'X-CSRF-Token':csrf} : {})},...(body ? {body:JSON.stringify(body)} : {})}); }
  catch { throw new Error('暂时无法连接服务器，内容尚未保存，请保留页面后重试。'); }
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(response.status === 409 ? '这条记录已在其他页面更新。请先刷新数据，再核对并保存；当前草稿已保留。' : value.error || `请求未完成（${response.status}）`);
    error.status = response.status;
    if (response.status === 401 && session) { resetSession(); authView('登录已过期，请重新登录，当前设备的草稿会保留。'); }
    throw error;
  }
  return value;
}
async function run(fn) {
  if (busy) return;
  busy = true; app.inert = true; dialog.inert = true;
  try { await fn(); } catch (err) { notify(err.message, true); }
  finally { busy = false; app.inert = false; dialog.inert = false; }
}
async function load() { const [result,trash] = await Promise.all([api(`/planner?date=${date}`),api('/planner/trash')]); items = result.items; trashed = trash.items; }
async function save(kind, id, day, data, baseRevision) {
  const original = items.find(r => r.id === id && r.kind === kind);
  const {item} = await api(`/planner/${kind}/${id}`, 'PUT', {date:day,data,revision:baseRevision ?? original?.revision ?? 0});
  items = items.filter(r => !(r.id === id && r.kind === kind)); items.push(item); return item;
}
function authView(message = '') {
  app.innerHTML = `<div class="auth-wrap"><section class="auth-card"><div class="brand"><img src="./icon.svg" alt=""><div><strong>计划管理</strong><small>YOUR DAILY WORKBUDDY</small></div></div><h1>欢迎回到你的日常</h1><p>用资金台账账号登录，开启今天的小小计划。</p><form id="login-form" class="form-stack"><label>账号<input name="username" required autocomplete="username" maxlength="64" placeholder="请输入账号"></label><label>密码<input name="password" type="password" required autocomplete="current-password" maxlength="256" placeholder="请输入密码"></label><div class="error" role="alert">${e(message)}</div><button type="submit" class="primary">登录工作台 ${icon('arrow')}</button></form><div class="auth-foot">你的记录按账号保存，只有自己可以查看。</div></section></div>`;
}
async function init() {
  try { session = await api('/auth/session'); csrf = session.csrfToken; await afterLogin(); }
  catch (err) { if (err.status === 401) authView(); else authView(err.message); }
}
async function afterLogin() {
  if (session.user.mustChangePassword) { app.innerHTML = `<div class="auth-wrap"><section class="auth-card"><h1>请先完成密码设置</h1><p>此账号首次登录或已重置密码，请在资金台账完成修改后回到这里。</p><a href="/zijintaizhang/" class="chip">前往资金台账设置密码 →</a><button data-action="retry-login">我已设置，重新载入</button></section></div>`; return; }
  await load(); render();
}
function hero() {
  const [en, sub] = intros[page];
  const daily = ['plan','work','life','learning','mood','worklog','input','exercise','book','quote','inspiration'].includes(page);
  return `<header class="hero"><div><div class="eyebrow">${en}</div><h1>${e(label(page))}${page === 'plan' ? ' <span aria-hidden="true">☀</span>' : ''}</h1><p>${page === 'learning' || page === 'mood' ? `${e(longDate(date))} · ` : ''}${sub}</p></div>${daily ? `<div class="date-control"><input type="date" aria-label="查看日期" value="${date}" min="1900-01-01" max="2100-12-31"><button data-action="today">回到今天</button></div>` : `<span class="hero-art">${icon(page === 'quote' ? 'quote' : 'sun')}</span>`}</header>`;
}
function stats(values) { return `<div class="stats">${values.map(([name,n,unit,ico]) => `<div class="stat"><div><div class="label">${name}</div><div class="number">${n}<small>${unit}</small></div></div>${icon(ico)}</div>`).join('')}</div>`; }
function empty(title, sub = '不着急，从第一条记录开始。', ico = page) { return `<div class="empty">${icon(ico)}<strong>${e(title)}</strong><p>${e(sub)}</p></div>`; }
function tools(item) { return `<div class="record-tools"><button class="icon-btn" data-action="edit" data-id="${e(item.id)}" aria-label="编辑${e(item.data.title || label(item.kind))}">${icon('edit')}</button><button class="icon-btn" data-action="delete" data-id="${e(item.id)}" aria-label="删除${e(item.data.title || label(item.kind))}">${icon('trash')}</button></div>`; }
function taskRows(rows) { return rows.map(r => `<div class="task ${r.data.done ? 'done' : ''}"><input type="checkbox" ${r.data.done ? 'checked' : ''} aria-label="完成${e(r.data.title)}" data-toggle="${e(r.id)}"><div class="task-copy"><div class="task-title">${e(r.data.title)}</div><div class="task-meta">${r.data.preset ? '<span>每日小习惯</span>' : ''}${r.kind === 'todo' ? `<span class="${r.date && r.date < today() && !r.data.done ? 'overdue' : ''}">${r.date ? `${r.date} 截止` : '日期待定'}</span><span>${e(r.data.priority || '普通')}</span>` : ''}${(r.data.tags || []).map(t => `<span>#${e(t)}</span>`).join('')}</div></div>${tools(r)}</div>`).join(''); }
function calendar() {
  const first = date.slice(0,7) + '-01'; const start = (new Date(first + 'T12:00:00Z').getUTCDay() + 6) % 7;
  const count = new Date(Date.UTC(Number(date.slice(0,4)),Number(date.slice(5,7)),0)).getUTCDate();
  return `<section class="panel calendar"><div class="calendar-head"><span>${date.slice(0,4)}年 ${Number(date.slice(5,7))}月</span>${icon('weekly')}</div><div class="calendar-grid">${'一二三四五六日'.split('').map(d => `<small>${d}</small>`).join('')}${'<span></span>'.repeat(start)}${Array.from({length:count},(_,i) => { const d = first.slice(0,8) + String(i+1).padStart(2,'0'); return `<button class="${d === date ? 'selected' : d === today() ? 'today' : ''}" data-date="${d}" aria-label="查看${d}">${i+1}</button>`; }).join('')}</div><div class="calendar-foot">${e(longDate(date))} · 每天都可以重新开始</div></section>`;
}
function planPage() {
  const rows = atDate('plan'); const done = rows.filter(r => r.data.done).length; const percent = rows.length ? Math.round(done / rows.length * 100) : 0;
  return stats([['今日计划已完成',`${done}<small>/ ${rows.length}</small>`,'项','check'],['等待处理的事项',list('todo').filter(r => !r.data.done).length,'项','todo'],['今日留下的记录',items.filter(r => r.date === date && !['plan','todo'].includes(r.kind)).length,'条','book']]) + `<div class="columns"><section class="panel"><div class="section-head"><div><h2>今天，想完成什么？</h2><p>专注眼前的一件小事就好。</p></div><span class="chip">${e(longDate(date))}</span></div>${rows.length ? taskRows(rows) : empty('今天的清单还是空白','写下一件想做的小事，给今天一个开始。','plan')}<form id="quick-plan" class="quick-form"><input name="title" maxlength="300" required aria-label="新增每日计划" placeholder="＋ 添加一项今天的小计划…"><button class="yellow" type="submit">添加计划</button></form><div class="progress-track"><div class="progress-fill" style="width:${percent}%"></div></div><div class="progress-text"><span>${done === rows.length && rows.length ? '今天的清单都完成了，给自己一个小小的肯定。' : '每完成一件，都离期待的自己近一点。'}</span><span>${percent}%</span></div></section><aside class="stack rail">${calendar()}<div class="encourage">${icon('leaf')}<h3>慢慢来，也在向前</h3><p>不必把每一天都填满。<br>留一点空白，给生活的小惊喜。</p></div></aside></div><p class="quote-foot">把平凡的每一天，过成喜欢的样子。</p>`;
}
function todoPage() {
  let rows = list('todo').filter(r => todoFilter === 'all' || Boolean(r.data.done) === (todoFilter === 'done'));
  rows = rows.sort((a,b) => Number(a.data.done)-Number(b.data.done) || (a.date || '9999').localeCompare(b.date || '9999'));
  return `<section class="panel"><div class="section-head"><div><h2>待办清单</h2><p>先做重要的事，也记得给自己留一点余地。</p></div><button class="yellow" data-page="input">${icon('input')} 批量录入</button></div><form id="quick-todo" class="form-grid"><label class="wide">待办内容<input name="title" required maxlength="300" placeholder="需要完成什么？"></label><label>截止日期（选填）<input type="date" name="date" min="1900-01-01" max="2100-12-31"></label><label>优先级<select name="priority"><option>普通</option><option>重要</option><option>紧急</option></select></label><div class="wide form-actions"><button class="primary" type="submit">添加待办</button></div></form><div class="filterbar"><select id="todo-filter" aria-label="待办状态"><option value="pending" ${todoFilter==='pending'?'selected':''}>未完成</option><option value="done" ${todoFilter==='done'?'selected':''}>已完成</option><option value="all" ${todoFilter==='all'?'selected':''}>全部事项</option></select><span>${rows.length} 项</span></div>${rows.length ? taskRows(rows) : empty('当前没有待办事项','把想到的事情写下来，让大脑轻松一点。','todo')}</section>`;
}
const reviewFields = {work:[['completed','今天完成了什么','具体记录推进的事项和成果。'],['problems','问题与思考','哪些事情不太顺利？原因是什么？'],['next','下一步行动','给明天留下一件可执行的小事。']],life:[['moments','今天的生活片段','记录一件平凡而值得记住的事。'],['feelings','感受与发现','听听自己内心的声音。'],['next','想做的小改变','下一次，可以对自己更好一点。']],weekly:[['completed','完成了什么','这一周，有哪些事情往前走了一步？'],['problems','问题&阻碍','是什么阻碍了你？你发现了什么？'],['next','下周改进','写下下周想尝试的具体行动。'],['highlight','高光时刻','收藏一个值得为自己鼓掌的瞬间。']]};
function formValues(kind = page, forcedId) {
  const id = forcedId || editing || (['weekly','work','life','mood','learning'].includes(kind) ? `${kind}-${kind === 'weekly' ? weekStart(date) : date}` : '');
  const item = list(kind).find(r => r.id === id);
  const draft = draftGet();
  return {id: id || draft?.__id || crypto.randomUUID(), data:{...(item?.data || {}),...(draft || {})}, item};
}
const inputField = (name, text, value = '', placeholder = '', type = 'text', required = false) => `<label>${text}<input name="${name}" type="${type}" value="${e(value)}" placeholder="${e(placeholder)}" ${required?'required':''} ${type==='number'?'min="0" max="100000" step="1"':'maxlength="500"'}></label>`;
const areaField = (name, text, value = '', placeholder = '', required = false) => `<label>${text}<textarea name="${name}" maxlength="8000" placeholder="${e(placeholder)}" ${required?'required':''}>${e(value)}</textarea></label>`;
function saveFooter(item, text = '保存记录') { return `<div class="form-actions"><small>${item ? '已保存过此记录，可继续修改。' : '想法不必完美，先记录下来。'}</small>${editing ? '<button type="button" data-action="cancel-edit">取消编辑</button>' : ''}<button type="submit" class="primary">${text} ${icon('check')}</button></div>`; }
function reviewPage() {
  const week = page === 'weekly'; const {id,data,item} = formValues();
  const fields = reviewFields[page];
  return `${week ? `<div class="week-toolbar"><button data-week="-7">← 上一周</button><strong>${e(weekLabel(date))}</strong><button data-week="7">下一周 →</button><button data-action="today">回到本周</button></div><div class="note-banner">按自然周（周一至周日）独立记录，每周都是新的空白页。切换周次可查看历史。</div>` : ''}<form id="record-form" data-kind="${page}" data-id="${id}" data-draft="${e(draftKey())}"><div class="form-grid">${fields.map(([key,title,placeholder],i) => `<section class="review-section ${!week&&i===2?'wide':''}"><div class="section-mark">0${i+1} / ${['LOOK BACK','REFLECT','MOVE FORWARD','SHINE'][i]}</div>${areaField(key,title,data[key],placeholder)}</section>`).join('')}</div>${saveFooter(item,week?'保存本周复盘':'保存复盘')}</form>${!week ? historyCards(page) : `<div class="filterbar"><span>已记录 ${list('weekly').length} 个自然周</span></div><div class="filterbar">${list('weekly').sort((a,b)=>b.date.localeCompare(a.date)).map(r => `<button data-date="${r.date}" class="chip">${e(weekLabel(r.date))}</button>`).join('')}</div>`}`;
}
function notePage() {
  const {id,data,item} = formValues(); let fields;
  if (page === 'quote') fields = `${areaField('content','记下一句好句',data.content,'此刻，有哪句话打动了你？',true)}<div class="form-grid">${inputField('category','分类',data.category,'如：生活、成长、写作')}${inputField('source','出处（选填）',data.source,'作者、书籍或播客')}</div>`;
  else if (page === 'book') fields = `<div class="form-grid">${inputField('title','书名',data.title,'正在读的那本书', 'text',true)}${inputField('author','作者（选填）',data.author,'作者姓名')}</div>${areaField('content','阅读笔记',data.content,'喜欢的段落、自己的理解、想尝试的行动…',true)}${inputField('category','分类',data.category,'如：文学、成长、商业')}`;
  else fields = `${inputField('title','灵感标题',data.title,'一个选题、一句标题、一个有趣的发现…','text',true)}${areaField('content','灵感内容',data.content,'记录切入角度、内容结构，或值得参考的细节。',true)}<div class="form-grid"><label>参考平台<select name="platform">${['日常灵感','抖音','小红书'].map(p=>`<option ${data.platform===p?'selected':''}>${p}</option>`).join('')}</select></label>${inputField('category','分类',data.category,'如：职场、生活、知识分享')}</div>`;
  return `${page === 'inspiration' ? `<div class="platforms"><a class="platform-link" href="https://www.douyin.com/" target="_blank" rel="noopener noreferrer"><span class="platform-icon">♪</span><div><strong>抖音</strong><small>发现热门内容与创作灵感</small></div>${icon('arrow')}</a><a class="platform-link" href="https://www.xiaohongshu.com/explore" target="_blank" rel="noopener noreferrer"><span class="platform-icon">小红书</span><div><strong>小红书</strong><small>收集生活里的好选题</small></div>${icon('arrow')}</a></div>` : ''}<section class="panel"><div class="section-head"><h2>${editing?'编辑记录':page === 'quote'?'快速收藏':page === 'book'?'写一篇读书笔记':'留住这一刻的灵感'}</h2><span class="chip">${page==='quote'?'WORDS & THOUGHTS':'CAPTURE A THOUGHT'}</span></div><form id="record-form" data-kind="${page}" data-id="${id}" data-draft="${e(draftKey())}" class="form-stack">${fields}${saveFooter(item)}</form></section>${historyCards(page,true)}`;
}
function moodPage() {
  const {id,data,item} = formValues();
  const choices = [['开心','😊'],['平静','😌'],['充实','🤗'],['疲惫','😴'],['低落','😔']];
  return `<section class="panel"><div class="section-head"><div><h2>给今天的心情留一个位置</h2><p>没有标准答案，每一种情绪都值得被看见。</p></div><span class="chip">${date}</span></div><form id="record-form" data-kind="mood" data-id="${id}" data-draft="${e(draftKey())}"><label>今天的心情</label><input type="hidden" name="mood" value="${e(data.mood || '')}"><div class="moods" role="group" aria-label="选择今天的情绪">${choices.map(([name,emoji])=>`<button type="button" class="mood" data-mood="${name}" aria-pressed="${data.mood===name}" aria-label="${name}"><span>${emoji}</span><small>${name}</small></button>`).join('')}</div><div class="form-stack">${areaField('content','当日感想',data.content,'今天发生了什么？你想对自己说些什么？',true)}${areaField('progress','今日微小进步（选填）',data.progress,'哪怕只是一件很小的事，也值得肯定。')}</div>${saveFooter(item,'记下来')}</form></section>${!atDate('mood').length ? empty('今天的故事，等你落笔','记录此刻的感受，就是一次温柔的自我照顾。','mood') : ''}${historyCards('mood')}`;
}
function learningPage() {
  const {id,data,item} = formValues(); const saved = atDate('learning').reduce((a,r)=>({minutes:a.minutes+(Number(r.data.minutes)||0),words:a.words+(Number(r.data.words)||0),pages:a.pages+(Number(r.data.pages)||0)}),{minutes:0,words:0,pages:0});
  return stats([['今日学习时长',saved.minutes,'分钟','learning'],['今日积累词语',saved.words,'个','book'],['今日阅读页数',saved.pages,'页','quote']])+`<section class="panel"><div class="section-head"><div><h2>${e(longDate(date))} · 学习小结</h2><p>今天的每一点积累，都会在未来发光。</p></div></div><form id="record-form" data-kind="learning" data-id="${id}" data-draft="${e(draftKey())}" class="form-stack"><div class="form-grid">${inputField('title','今天学了什么',data.title,'课程、书籍、技能…','text',true)}${inputField('minutes','学习时长（分钟）',data.minutes ?? '', '0','number')}${inputField('words','词语积累（个）',data.words ?? '', '0','number')}${inputField('pages','阅读页数（页）',data.pages ?? '', '0','number')}</div>${areaField('content','学习收获',data.content,'用自己的话，记录今天理解了什么。')}${saveFooter(item,'保存学习汇报')}</form></section>${historyCards('learning')}`;
}
const TRAINING = [{title:'唤醒身体 · 活力有氧',duration:20,tags:'有氧',details:'热身 3 分钟\n快走或原地踏步 12 分钟\n轻松走与拉伸 5 分钟',icon:'sun'},{title:'积攒力量 · 基础训练',duration:25,tags:'力量',details:'热身 5 分钟\n自重深蹲 3 组 × 10 次\n靠墙俯卧撑 3 组 × 10 次\n组间充分休息，最后拉伸',icon:'exercise'},{title:'舒展一下 · 轻松拉伸',duration:10,tags:'拉伸',details:'肩颈放松 2 分钟\n胸背伸展 3 分钟\n腿部轻柔拉伸 3 分钟\n放松呼吸 2 分钟',icon:'leaf'}];
function exercisePage() {
  const s = exerciseStats(list('exercise'),date);
  return stats([['本周打卡次数',s.thisWeek,'天','check'],['总打卡记录',s.total,'次','exercise'],['连续打卡周数',s.streak,'周','weekly']])+`<div class="section-head"><div><h2>今天，动一动</h2><p>本周：${e(weekLabel(date))} · 每个打卡日计一次</p></div><button data-action="exercise-custom">自定义运动</button></div><div class="training-grid">${TRAINING.map((p,i)=>`<section class="training"><div class="training-icon">${icon(p.icon)}</div><h3>${p.title}</h3><span class="chip">${p.duration} 分钟 · ${p.tags}</span><p>${p.details}</p><button data-train="${i}">开始练&打卡 ${icon('arrow')}</button></section>`).join('')}</div><p class="muted" style="font-size:11px;margin-top:12px">按自己的节奏调整强度，完成后再记录打卡。</p>${historyCards('exercise',true)}`;
}
function inputPage() {
  const work = page === 'worklog'; const draft = draftGet();
  if (!preview.length && draft?.__preview) preview = draft.__preview;
  return `<section class="panel"><div class="section-head"><h2>${work?'写下今天的工作':'把待办一次写下来'}</h2><span class="chip">${work?'WORK JOURNAL':'QUICK CAPTURE'}</span></div><div class="input-intro">支持换行、分号或编号分条，可识别“明天 / 下周一 / 11月20日”、优先级和 #标签。识别结果可以修改，未明确的日期留空，确认后才保存。</div><form id="parse-form" data-draft="${e(draftKey())}"><label>${work?'每日工作内容':'待办内容'}<textarea class="input-raw" name="raw" required maxlength="5000" placeholder="${work?'1. 完成项目资料整理 #项目\n2. 明天跟进供应商进度，重要 #采购':'1. 明天整理本周报表，重要 #工作\n2. 下周一确认会议安排\n3. 预约周末活动 #生活'}">${e(draft?.raw || '')}</textarea></label><div class="form-actions"><small>按当前查看日期 ${date} 识别相对日期。</small><button class="yellow" type="submit">${icon('inspiration')} 识别并整理</button></div></form><div id="parse-preview">${previewHTML()}</div></section>${work ? historyCards('worklog') : ''}`;
}
function previewHTML() {
  if (!preview.length) return '';
  return `<div class="batch-heading"><h3>识别出 ${preview.length} 条记录</h3><small>核对内容、日期和优先级后保存</small></div><form id="batch-form">${preview.map((r,i)=>`<div class="preview-row" data-index="${i}"><span>${String(i+1).padStart(2,'0')}</span><input name="entry-title" value="${e(r.title)}" maxlength="1000" required aria-label="第${i+1}条内容"><input name="entry-date" type="date" value="${e(r.date)}" min="1900-01-01" max="2100-12-31" aria-label="第${i+1}条日期"><select name="entry-priority" aria-label="第${i+1}条优先级">${['普通','重要','紧急'].map(p=>`<option ${r.priority===p?'selected':''}>${p}</option>`).join('')}</select><button type="button" class="icon-btn" data-remove-preview="${i}" aria-label="移除第${i+1}条">${icon('close')}</button></div>`).join('')}<div class="form-actions"><small>原始输入会随记录保留，方便回查。</small><button type="submit" class="primary">确认保存 ${preview.length} 条${page==='input'?'待办':'工作记录'}</button></div></form>`;
}
function historyCards(kind, categorized = false) {
  let rows = list(kind).sort((a,b)=>b.date.localeCompare(a.date));
  const categories = [...new Set(rows.flatMap(r => kind==='exercise' ? r.data.tags || [] : [r.data.category || '未分类']))].sort();
  if (category) rows = rows.filter(r => kind==='exercise' ? r.data.tags?.includes(category) : (r.data.category || '未分类') === category);
  return `<div class="section-head history-title"><h2>${kind === 'quote' ? '我的句子收藏' : kind === 'worklog' ? '已保存的工作记录' : '过往记录'}</h2><span class="chip">${rows.length} 条记录</span></div>${categorized ? `<div class="filterbar"><select id="category-filter" aria-label="分类筛选"><option value="">全部分类</option>${categories.map(c=>`<option value="${e(c)}" ${category===c?'selected':''}>${e(c)}</option>`).join('')}</select><span>按日期从新到旧</span></div>` : ''}<div class="records">${rows.length ? rows.map(r=>recordCard(r)).join('') : empty(category?'此分类暂时没有记录':'这里还没有记录','保存的内容会在这里慢慢积累。',kind)}</div>`;
}
function recordCard(r) {
  const d = r.data;
  const title = d.title || (r.kind==='mood' ? `${d.mood || '心情'}的一天` : r.kind==='exercise' ? '运动打卡' : label(r.kind));
  let body = r.kind === 'quote' ? `<blockquote>${e(d.content)}</blockquote>` : `<h3>${e(title)}</h3>`;
  if (reviewFields[r.kind]) body += reviewFields[r.kind].filter(([key])=>d[key]).map(([key,text])=>`<div class="content"><strong>${text}</strong><br>${e(d[key])}</div>`).join('');
  else if (r.kind !== 'quote') body += `<div class="content">${e(d.content || '')}</div>`;
  if (d.progress) body += `<div class="content">今日微小进步：${e(d.progress)}</div>`;
  if (r.kind === 'learning') body += `<div class="content">学习 ${e(d.minutes || 0)} 分钟 · 积累 ${e(d.words || 0)} 个词语 · 阅读 ${e(d.pages || 0)} 页</div>`;
  if (r.kind === 'exercise') body += `<div class="content">${e(d.duration || 0)} 分钟 · ${(d.tags || []).map(e).join(' / ')}</div>`;
  if (r.kind === 'worklog' && d.source) body += `<details class="saved-source"><summary>查看原始输入</summary>${e(d.source)}</details>`;
  return `<article class="record"><div class="record-head"><div style="min-width:0">${body}</div>${tools(r)}</div><div class="record-footer"><span>${e(r.date || '日期待定')}${d.author ? ` · ${e(d.author)}` : ''}${r.kind==='quote'&&d.source?` · ${e(d.source)}`:''}</span><span>${d.category?`<span class="pill">${e(d.category)}</span>`:''}${d.platform?`<span class="pill">${e(d.platform)}</span>`:''}${d.priority?`<span class="pill ${d.priority==='紧急'?'urgent':''}">${e(d.priority)}</span>`:''}</span></div></article>`;
}
function render() {
  if (!session) return;
  const deletedDaily = ['weekly','work','life','mood','learning'].includes(page) ? trashed.find(r=>r.kind===page && r.id===`${page}-${page==='weekly'?weekStart(date):date}`) : null;
  const content = deletedDaily ? `<section class="panel"><h2>这份记录已移入回收站</h2><p class="muted">恢复后可以继续填写，原来的内容也会保留。</p><div class="form-actions"><button class="primary" data-restore="${deletedDaily.id}" data-kind="${page}" data-revision="${deletedDaily.revision}">恢复并继续填写</button></div></section>` : page==='plan'?planPage():page==='todo'?todoPage():reviewFields[page]?reviewPage():['book','quote','inspiration'].includes(page)?notePage():page==='mood'?moodPage():page==='learning'?learningPage():page==='exercise'?exercisePage():inputPage();
  app.innerHTML = `<div class="shell"><aside class="sidebar"><a class="brand" href="#plan" data-page="plan"><img src="./icon.svg" alt=""><div><strong>计划管理</strong><small>YOUR DAILY WORKBUDDY</small></div></a><div class="nav-label">我的工作台 / WORKSPACE</div><nav aria-label="工作台栏目">${NAV.map(([id,name])=>`<button class="nav-item ${page===id?'active':''}" data-page="${id}" ${page===id?'aria-current="page"':''}>${icon(id)}<span>${name}</span></button>`).join('')}</nav><div class="sidebar-footer"><p class="side-note">一点计划，一点记录，一点成长。</p><div class="account"><span class="avatar">${e((session.user.displayName || session.user.username).slice(0,1))}</span><div><strong>${e(session.user.displayName || session.user.username)}</strong><small>我的私人工作台</small></div><button class="icon-btn" data-action="logout" aria-label="退出登录">${icon('logout')}</button></div></div></aside><div class="workspace"><div class="topbar"><button class="icon-btn mobile-menu" data-action="menu" aria-label="打开栏目">${icon('menu')}</button><div class="crumb"><span>我的工作台</span><span>/</span><span>${e(label(page))}</span></div><div class="top-actions"><span class="sync">${navigator.onLine?'已连接云端':'网络已断开'}</span><button data-action="refresh">${icon('refresh')}刷新数据</button><button data-action="trash">${icon('trash')}回收站</button></div></div><main id="main" tabindex="-1">${hero()}${content}</main></div></div>`;
  restoreDrafts();
}
function captureForm(form, force = false) {
  if (!force && form.dataset.dirty !== 'true') return;
  const data = Object.fromEntries(new FormData(form));
  if (form.dataset.id) data.__id = form.dataset.id;
  if (form.dataset.revision !== undefined) data.__revision = Number(form.dataset.revision);
  if (form.id === 'parse-form') data.__preview = preview;
  if (form.dataset.draft) draftSet(form.dataset.draft, data);
  return data;
}
function restoreDrafts() {
  for (const form of document.querySelectorAll('form[data-draft]')) {
    const draft = draftGet(form.dataset.draft);
    const item = items.find(r => r.id === form.dataset.id && r.kind === form.dataset.kind);
    form.dataset.revision = draft?.__revision ?? item?.revision ?? 0;
    if (!draft) continue;
    form.dataset.dirty = 'true';
    for (const [key,value] of Object.entries(draft)) { const control = form.elements.namedItem(key); if (control && typeof value !== 'object') control.value = value; }
    if (item && Number(form.dataset.revision) !== item.revision) form.insertAdjacentHTML('afterbegin','<div class="note-banner wide">云端已有新版本，当前显示的是本设备草稿。保存不会覆盖新版本，请先核对。<button type="button" data-action="load-latest">放弃草稿并载入云端版本</button></div>');
  }
}
function captureAll() { document.querySelectorAll('form[data-draft]').forEach(captureForm); }
function navigate(next) { captureAll(); page = next; editing = ''; category = ''; preview = []; render(); }
async function setDate(value) { captureAll();const previous=date;date=value;try{await load();}catch(err){date=previous;const control=$('[aria-label="查看日期"]');if(control)control.value=date;throw err;}editing='';preview=[];render(); }
function openDialog(title, html) { dialog.innerHTML = `<div class="dialog-head"><h2>${title}</h2><button class="icon-btn" data-action="close-dialog" aria-label="关闭">${icon('close')}</button></div>${html}`; if (!dialog.open) dialog.showModal(); }
function exerciseDialog(plan = {}, item) {
  const d = item?.data || {title:plan.title || '',duration:plan.duration || '',tags:plan.tags ? [plan.tags] : [],content:''};
  openDialog(item?'编辑运动记录':plan.title || '自定义运动', `<p>${e(plan.details || '记下完成的运动，为今天的坚持留个印记。').replace(/\n/g,'<br>')}</p><form id="exercise-form" data-id="${item?.id || crypto.randomUUID()}" class="form-stack" style="margin-top:22px">${inputField('title','运动名称',d.title,'如：晚间快走','text',true)}<div class="form-grid">${inputField('duration','运动时长（分钟）',d.duration,'0','number',true)}${inputField('date','打卡日期',item?.date || date,'','date',true)}</div>${inputField('tags','分类标签',d.tags?.join('、'),'有氧、力量、拉伸')}${areaField('content','运动感受（选填）',d.content,'今天的状态怎么样？')}<div class="error" role="alert"></div><button class="primary" type="submit">${item?'保存修改':'完成训练，确认打卡'}</button></form>`);
}
function simpleEdit(item) {
  openDialog('编辑记录', `<form id="simple-edit" data-id="${item.id}" class="form-stack">${inputField('title','内容',item.data.title,'','text',true)}${inputField('date',item.kind==='todo'?'截止日期（选填）':'记录日期（选填）',item.date,'','date')}<label>优先级<select name="priority">${['普通','重要','紧急'].map(p=>`<option ${item.data.priority===p?'selected':''}>${p}</option>`).join('')}</select></label><div class="error" role="alert"></div><button type="submit" class="primary">保存修改</button></form>`);
}
async function remove(id) { const r = recordById(id); if (!r) return; const {item} = await api(`/planner/${r.kind}/${r.id}`,'DELETE',{revision:r.revision}); lastDeleted=item;trashed.push(item);items=items.filter(v=>!(v.id===r.id&&v.kind===r.kind)); render(); notify(r.data.preset?'已删除，此预设任务以后不会自动复原。':'已移入回收站。',false,true); }
async function restore(item) { const {item:restored}=await api(`/planner/${item.kind}/${item.id}/restore`,'POST',{revision:item.revision}); items.push(restored);trashed=trashed.filter(r=>!(r.id===item.id&&r.kind===item.kind)); render();notify('记录已恢复。'); }
async function trashDialog() { const {items:trash}=await api('/planner/trash'); openDialog('回收站',`<p>删除的记录会保留在这里，可以随时恢复。</p><div class="records">${trash.length?trash.map(r=>`<div class="record"><h3>${e(r.data.title || r.data.content?.slice(0,40) || label(r.kind))}</h3><div class="record-footer"><span>${e(label(r.kind))} · ${e(r.date || '日期待定')}</span><button data-restore="${e(r.id)}" data-kind="${r.kind}" data-revision="${r.revision}">恢复记录</button></div></div>`).join(''):empty('回收站是空的','删除后的记录会显示在这里。','trash')}</div>`); }

document.addEventListener('input', event => {
  if(busy)return;
  const form = event.target.closest('form[data-draft]'); if(form) { form.dataset.dirty='true'; captureForm(form); }
  if (event.target.closest('#batch-form')) syncPreview();
});
function syncPreview() { document.querySelectorAll('.preview-row').forEach(row => { const r=preview[Number(row.dataset.index)]; if(r) Object.assign(r,{title:$('[name=entry-title]',row).value,date:$('[name=entry-date]',row).value,priority:$('[name=entry-priority]',row).value}); }); const form=$('#parse-form');if(form)captureForm(form,true); }
document.addEventListener('change',event=>{
  if(busy){if(event.target.dataset.toggle)event.target.checked=!event.target.checked;return;}
  if(event.target.matches('[aria-label="查看日期"]')) { if(event.target.value&&event.target.validity.valid)run(()=>setDate(event.target.value)); return; }
  if(event.target.matches('#todo-filter')){captureAll();todoFilter=event.target.value;render();}
  if(event.target.matches('#category-filter')){captureAll();category=event.target.value;render();}
  if(event.target.closest('#batch-form'))syncPreview();
  if(event.target.dataset.toggle) { const id=event.target.dataset.toggle;const checked=event.target.checked;run(async()=>{const item=recordById(id);try{await save(item.kind,item.id,item.date,{...item.data,done:checked});render();notify(checked?'又完成了一件小事。':'已标记为未完成。');}catch(err){event.target.checked=!checked;throw err;}}); }
  const form=event.target.closest('form[data-draft]');if(form){form.dataset.dirty='true';captureForm(form);}
});
document.addEventListener('click',event=>{
  const b=event.target.closest('button,a[data-page]');if(!b)return;
  if(busy){event.preventDefault();notify('正在保存，请稍候再切换。');return;}
  if(b.dataset.page){event.preventDefault();navigate(b.dataset.page);return;}
  if(b.dataset.date){run(()=>setDate(b.dataset.date));return;}
  if(b.dataset.week){run(()=>setDate(shiftDate(date,Number(b.dataset.week))));return;}
  if(b.dataset.mood){const f=$('#record-form');f.elements.mood.value=b.dataset.mood;f.querySelectorAll('[data-mood]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));f.dataset.dirty='true';captureForm(f);return;}
  if(b.dataset.train!==undefined){exerciseDialog(TRAINING[Number(b.dataset.train)]);return;}
  if(b.dataset.removePreview!==undefined){syncPreview();preview.splice(Number(b.dataset.removePreview),1);captureForm($('#parse-form'));$('#parse-preview').innerHTML=previewHTML();return;}
  if(b.dataset.restore){const inDialog=dialog.contains(b);run(async()=>{await restore({id:b.dataset.restore,kind:b.dataset.kind,revision:Number(b.dataset.revision)});if(inDialog)await trashDialog();});return;}
  const action=b.dataset.action;
  if(action==='menu'){$('.shell').classList.toggle('menu-open');return;}
  if(action==='close-dialog'){dialog.close();return;}
  if(action==='exercise-custom'){exerciseDialog();return;}
  if(action==='cancel-edit'){editing='';render();return;}
  if(action==='load-latest'){draftClear(b.closest('form').dataset.draft);render();return;}
  if(action==='edit'){const item=recordById(b.dataset.id);if(!item)return;captureAll();if(['plan','todo','worklog'].includes(item.kind)){simpleEdit(item);return;}if(item.kind==='exercise'){exerciseDialog({},item);return;}page=item.kind;editing=item.id;if(item.date)date=item.date;render();$('#record-form')?.scrollIntoView({behavior:'smooth',block:'center'});return;}
  if(!action)return;
  run(async()=>{
    if(action==='today')await setDate(today());
    else if(action==='refresh'){captureAll();await load();render();notify('已刷新云端记录，未提交草稿已保留。');}
    else if(action==='delete'){captureAll();await remove(b.dataset.id);}
    else if(action==='undo'&&lastDeleted){await restore(lastDeleted);lastDeleted=null;}
    else if(action==='trash')await trashDialog();
    else if(action==='logout'){captureAll();await api('/auth/logout','POST',{});resetSession();authView();}
    else if(action==='retry-login')await init();
  });
});
document.addEventListener('submit', event=>{
  event.preventDefault();const form=event.target;const values=Object.fromEntries(new FormData(form));
  if(busy)return;
  if(form.id==='parse-form'){
    if(!values.raw.trim()){notify('先写下需要整理的内容。',true);return;}
    preview=parseEntries(values.raw,date).map(r=>({...r,id:crypto.randomUUID()}));
    if(preview.length>60){notify('一次最多识别 60 条，请分批输入。',true);preview=[];return;}
    captureForm(form,true);$('#parse-preview').innerHTML=previewHTML();if(!preview.length)notify('没有识别到有效条目，请补充内容。',true);return;
  }
  run(async()=>{
    try {
      if(form.id==='login-form') { try{resetSession();session=await api('/auth/login','POST',values);csrf=session.csrfToken;await afterLogin();}catch(err){form.elements.password.value='';$('.error',form).textContent=err.message;throw err;}return; }
      if(form.id==='quick-plan'||form.id==='quick-todo'){
        if(!values.title.trim())throw new Error('请输入有效的任务内容。');
        await save(form.id==='quick-plan'?'plan':'todo',crypto.randomUUID(),form.id==='quick-plan'?date:values.date,{title:values.title.trim(),done:false,priority:values.priority||'普通'});render();notify('已添加，慢慢完成就好。');return;
      }
      if(form.id==='record-form'){
        captureForm(form,true);const kind=form.dataset.kind;const data={...values};
        if(kind==='mood'&&!data.mood)throw new Error('先选一个代表今天的心情。');
        if(!Object.values(data).some(v=>String(v).trim()))throw new Error('先写一点内容再保存。');
        if(reviewFields[kind]&&!reviewFields[kind].some(([key])=>data[key]?.trim()))throw new Error('至少填写一个复盘分区。');
        if(kind==='learning')for(const key of ['minutes','words','pages'])data[key]=values[key]===''?0:Number(values[key]);
        if(kind==='quote'&&!data.content?.trim())throw new Error('请先写下想收藏的句子。');
        await save(kind,form.dataset.id,kind==='weekly'?weekStart(date):date,data,Number(form.dataset.revision));draftClear(form.dataset.draft);editing='';render();notify('已经记下来，今天又多了一点积累。');return;
      }
      if(form.id==='batch-form'){
        syncPreview();const work=page==='worklog';const raw=$('#parse-form').elements.raw.value;const key=draftKey();let count=0;
        try{
          while(preview.length){const entry=preview[0];if(!entry.title.trim())throw new Error('条目内容不能为空。');await save(work?'worklog':'todo',entry.id,work?(entry.date||date):entry.date,{title:entry.title.trim(),priority:entry.priority,tags:entry.tags,done:false,source:raw});preview.shift();count++;captureForm($('#parse-form'));}
        }catch(err){$('#parse-preview').innerHTML=previewHTML();throw new Error(`已保存 ${count} 条，其余条目已保留。${err.message}`);}
        draftClear(key);preview=[];if(!work)page='todo';render();notify(`已保存 ${count} 条${work?'工作记录':'待办事项'}。`);return;
      }
      if(form.id==='exercise-form'){
        if(!values.title.trim())throw new Error('请填写运动名称。');
        await save('exercise',form.dataset.id,values.date,{title:values.title.trim(),duration:Number(values.duration),tags:tags(values.tags),content:values.content});dialog.close();render();notify('打卡成功，为今天的坚持点赞。');return;
      }
      if(form.id==='simple-edit'){
        const item=recordById(form.dataset.id);if(!values.title.trim())throw new Error('内容不能为空。');
        await save(item.kind,item.id,values.date,{...item.data,title:values.title.trim(),priority:values.priority});dialog.close();render();notify('修改已保存。');
      }
    }catch(err){const field=$('.error',form);if(field)field.textContent=err.message;throw err;}
  });
});
window.addEventListener('online',()=>notify('网络已恢复，可以继续保存记录。'));
window.addEventListener('offline',()=>notify('网络已断开，当前输入会保留为草稿，联网后再保存。',true));
window.addEventListener('beforeunload',captureAll);
function resetSession(){session=null;csrf='';items=[];trashed=[];preview=[];editing='';lastDeleted=null;category='';page='plan';date=today();if(dialog.open)dialog.close();dialog.innerHTML='';clearTimeout(noticeTimer);$('#notice').className='';}
setInterval(()=>{const next=today();if(next!==clockDate){const previous=clockDate;clockDate=next;if(session&&date===previous&&!busy)run(()=>setDate(next));}},30000);
init();
