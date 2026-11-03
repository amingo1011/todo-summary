(() => {
'use strict';
const cfg = window.TODO_CONFIG;
const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey);
const $ = s => document.querySelector(s);

const state = { user: null, todos: [], lastSync: null, filter: 'open', q: '', project: '', mode: 'day', editingId: null };

/* ---------- 日期工具(一律用本地時間) ---------- */
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => ymd(new Date());
const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const WEEK = '日一二三四五六';
const fmtDate = s => { const d = parseYmd(s); return `${d.getMonth() + 1}/${d.getDate()}（${WEEK[d.getDay()]}）`; };
function weekRange() {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const start = addDays(t, -((t.getDay() + 6) % 7));   // 週一開始
  return { start: ymd(start), end: ymd(addDays(start, 6)), startDate: start };
}
const dayDiff = s => Math.round((parseYmd(s) - parseYmd(today())) / 86400000);
const fmtTime = iso => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

const PRI = { high: '高', medium: '中', low: '低' };
const STATUS = { todo: '待辦', doing: '進行中', done: '已完成' };
const PRI_ORDER = { high: 0, medium: 1, low: 2 };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function dueInfo(t) {
  if (!t.due_date) return { label: '未設期限', cls: '' };
  if (t.status === 'done') return { label: `${fmtDate(t.due_date)} 到期`, cls: '' };
  const diff = dayDiff(t.due_date);
  if (diff < 0) return { label: `逾期 ${-diff} 天`, cls: 'overdue' };
  if (diff === 0) return { label: '今天到期', cls: 'today' };
  if (diff === 1) return { label: '明天到期', cls: 'soon' };
  return { label: `${fmtDate(t.due_date)} 到期`, cls: diff <= 3 ? 'soon' : '' };
}

/* ---------- 提示訊息 ---------- */
let toastTimer;
function toast(msg) {
  const el = $('#toast'); el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.hidden = true, 2600);
}
function errText(error) {
  const m = error?.message || String(error);
  if (/rate limit|security purposes/i.test(m)) return '寄送太頻繁,請稍等一分鐘後再試。';
  if (/Failed to fetch|NetworkError/i.test(m)) return '連不上 Supabase,請確認網路連線。';
  if (/JWT|not authorized|permission denied/i.test(m)) return '登入狀態已失效,請重新登入。';
  return m;
}

/* ---------- 登入 ---------- */
function showLoginMsg(text, isError) {
  const el = $('#loginMsg'); el.textContent = text; el.hidden = false; el.classList.toggle('error', !!isError);
}
$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const email = $('#email').value.trim();
  const btn = $('#loginBtn'); btn.disabled = true; btn.textContent = '寄送中…';
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: location.origin + location.pathname },
  });
  btn.disabled = false; btn.textContent = '寄送登入連結';
  if (error) showLoginMsg(errText(error), true);
  else showLoginMsg(`已寄出登入連結到 ${email}。請到信箱點連結登入(連結約 1 小時內有效,也請檢查垃圾郵件)。`);
});
$('#logout').addEventListener('click', async () => { await sb.auth.signOut(); toast('已登出'); });

function setUser(user) {
  const changed = user?.id !== state.user?.id;
  state.user = user;
  $('#login').hidden = !!user;
  $('#app').hidden = !user;
  if (!user) { state.todos = []; return; }
  $('#who').textContent = user.email;
  if (location.hash.includes('access_token')) history.replaceState(null, '', location.pathname + location.search);
  if (changed) setTimeout(load, 0);   // 不在 onAuthStateChange 內直接呼叫 Supabase,避免卡住
}

/* ---------- 讀取資料 ---------- */
async function load() {
  $('#app').classList.add('loading');
  const [todosRes, syncRes] = await Promise.all([
    sb.from('todos').select('*').order('created_at', { ascending: false }),
    sb.from('sync_runs').select('run_at,emails_scanned,todos_added').order('run_at', { ascending: false }).limit(1),
  ]);
  $('#app').classList.remove('loading');
  if (todosRes.error) { toast(errText(todosRes.error)); return; }
  state.todos = todosRes.data;
  state.lastSync = syncRes.data?.[0] ?? null;
  render();
}
$('#reload').addEventListener('click', async () => { await load(); toast('已更新'); });

/* ---------- 篩選與排序 ---------- */
const open = t => t.status !== 'done';
const FILTERS = {
  open:    { name: '未完成', test: open },
  today:   { name: '今天到期', test: t => open(t) && t.due_date === today() },
  overdue: { name: '已逾期', test: t => open(t) && t.due_date && t.due_date < today() },
  week:    { name: '本週到期', test: t => { const w = weekRange(); return open(t) && t.due_date && t.due_date >= w.start && t.due_date <= w.end; } },
  email:   { name: '來自信件', test: t => open(t) && t.source === 'email' },
  done:    { name: '已完成', test: t => t.status === 'done' },
};
function sortTodos(list, filter) {
  if (filter === 'done') return [...list].sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || ''));
  return [...list].sort((a, b) =>
    (a.due_date ? 0 : 1) - (b.due_date ? 0 : 1) ||
    (a.due_date || '').localeCompare(b.due_date || '') ||
    PRI_ORDER[a.priority] - PRI_ORDER[b.priority] ||
    b.created_at.localeCompare(a.created_at));
}
function matchesQuery(t, q) {
  if (!q) return true;
  q = q.toLowerCase();
  return [t.title, t.detail, t.project, t.email_from, t.email_subject].some(v => (v || '').toLowerCase().includes(q));
}

/* ---------- 畫面 ---------- */
function render() {
  renderSync(); renderStats(); renderTabs(); renderProjects(); renderList(); renderDist(); renderSummary();
}
function renderSync() {
  const s = state.lastSync;
  $('#syncInfo').textContent = s
    ? `最後整理信件:${fmtTime(s.run_at)} · 掃描 ${s.emails_scanned} 封、新增 ${s.todos_added} 項`
    : '尚未從信件整理過代辦';
}
function weekDone() {
  const w = weekRange();
  return state.todos.filter(t => t.status === 'done' && t.completed_at && new Date(t.completed_at) >= w.startDate);
}
function renderStats() {
  const ts = state.todos;
  const nToday = ts.filter(FILTERS.today.test).length;
  const nOver = ts.filter(FILTERS.overdue.test).length;
  const nOpen = ts.filter(open).length;
  const nDoing = ts.filter(t => t.status === 'doing').length;
  const done = weekDone().length;
  const pending = ts.filter(t => FILTERS.week.test(t) || FILTERS.overdue.test(t)).length;
  const rate = done + pending ? Math.round(done / (done + pending) * 100) : null;
  $('#stToday').textContent = nToday;
  $('#stOverdue').textContent = nOver;
  $('#stOverdueCard').classList.toggle('alert', nOver > 0);
  $('#stOpen').textContent = nOpen;
  $('#stDoing').textContent = `進行中 ${nDoing} 項`;
  $('#stRate').textContent = rate === null ? '—' : `${rate}%`;
  $('#stRateBar').style.width = `${rate ?? 0}%`;
  $('#stWeekDone').textContent = `本週完成 ${done} 項 · 尚有 ${pending} 項本週該完成`;
}
function renderTabs() {
  $('#tabs').innerHTML = Object.entries(FILTERS).map(([k, f]) =>
    `<button class="tab" type="button" data-filter="${k}" aria-pressed="${state.filter === k}">${f.name}<span class="n">${state.todos.filter(f.test).length}</span></button>`).join('');
}
function projects() {
  return [...new Set(state.todos.map(t => t.project).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
}
function renderProjects() {
  const ps = projects();
  if (state.project && !ps.includes(state.project)) state.project = '';
  $('#projectFilter').innerHTML = `<option value="">全部專案</option>` + ps.map(p => `<option${p === state.project ? ' selected' : ''}>${esc(p)}</option>`).join('');
  $('#projectList').innerHTML = ps.map(p => `<option value="${esc(p)}"></option>`).join('');
}
function renderList() {
  const f = FILTERS[state.filter];
  const list = sortTodos(state.todos.filter(t => f.test(t) && matchesQuery(t, state.q) && (!state.project || t.project === state.project)), state.filter);
  const el = $('#list');
  if (!state.todos.length) {
    el.innerHTML = `<li class="empty"><strong>還沒有任何代辦</strong>按「+ 新增代辦」手動加一筆,或請 Claude 幫你整理 Outlook 信件。</li>`;
    return;
  }
  if (!list.length) {
    el.innerHTML = `<li class="empty"><strong>這個分類目前沒有代辦</strong>${state.q || state.project ? '換個關鍵字或專案再試試。' : '可以切換上方的分類看看。'}</li>`;
    return;
  }
  el.innerHTML = list.map(t => {
    const due = dueInfo(t);
    const mail = t.source === 'email';
    return `<li class="todo p-${t.priority}${t.status === 'done' ? ' done' : ''}" data-id="${t.id}">
      <input class="check" type="checkbox" ${t.status === 'done' ? 'checked' : ''} aria-label="標記完成:${esc(t.title)}">
      <div>
        <div class="title">${esc(t.title)}</div>
        <div class="chips">
          <span class="chip pri-${t.priority}">${PRI[t.priority]}優先</span>
          <span class="chip ${due.cls}">${due.label}</span>
          ${t.project ? `<span class="chip">${esc(t.project)}</span>` : ''}
          ${mail ? '<span class="chip mail">來自信件</span>' : ''}
          ${t.status === 'done' && t.completed_at ? `<span class="chip">完成於 ${fmtTime(t.completed_at)}</span>` : ''}
        </div>
        ${t.detail ? `<p class="detail">${esc(t.detail)}</p>` : ''}
        ${mail ? `<div class="from">寄件人:${esc(t.email_from || '未知')}${t.email_subject ? ` · 主旨:${esc(t.email_subject)}` : ''}${t.email_received_at ? ` · ${fmtTime(t.email_received_at)}` : ''}</div>` : ''}
      </div>
      <div class="actions">
        <select data-act="status" aria-label="變更狀態">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}"${k === t.status ? ' selected' : ''}>${v}</option>`).join('')}</select>
        <div class="row">
          <button class="btn ghost" type="button" data-act="edit">編輯</button>
          <button class="btn ghost danger" type="button" data-act="delete">刪除</button>
        </div>
      </div>
    </li>`;
  }).join('');
}
function bars(rows, max) {
  if (!rows.length) return '<li class="note">目前沒有未完成的代辦</li>';
  return rows.map(([name, n, color]) =>
    `<li style="--c:${color}"><span class="name" title="${esc(name)}">${esc(name)}</span><span class="bar"><i style="width:${max ? n / max * 100 : 0}%"></i></span><span class="n">${n}</span></li>`).join('');
}
function renderDist() {
  const op = state.todos.filter(open);
  const pr = ['high', 'medium', 'low'].map(p => [`${PRI[p]}優先`, op.filter(t => t.priority === p).length, `var(--${p})`]);
  $('#byPriority').innerHTML = op.length ? bars(pr, Math.max(...pr.map(r => r[1]))) : bars([], 0);
  const counts = {};
  op.forEach(t => { const k = t.project || '未分類'; counts[k] = (counts[k] || 0) + 1; });
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => [k, n, 'var(--accent)']);
  $('#byProject').innerHTML = bars(rows, rows[0]?.[1] || 0);
}

/* ---------- 文字摘要 ---------- */
function lines(list, fn) { return list.length ? list.map(fn).join('\n') : '- 無'; }
const item = t => `- ${t.title}${t.project ? `〔${t.project}〕` : ''}`;
const itemDue = t => `- ${t.title}${t.project ? `〔${t.project}〕` : ''}${t.due_date ? `(${fmtDate(t.due_date)})` : ''}`;
function buildSummary() {
  const ts = state.todos, now = new Date(), td = today();
  if (state.mode === 'day') {
    const doneToday = ts.filter(t => t.status === 'done' && t.completed_at && ymd(new Date(t.completed_at)) === td);
    const doing = sortTodos(ts.filter(t => t.status === 'doing'), 'open');
    const dueToday = sortTodos(ts.filter(FILTERS.today.test), 'open');
    const over = sortTodos(ts.filter(FILTERS.overdue.test), 'open');
    const tomorrow = ymd(addDays(now, 1));
    const dueTomorrow = sortTodos(ts.filter(t => open(t) && t.due_date === tomorrow), 'open');
    return [
      `【工作日報】${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}(${WEEK[now.getDay()]})`,
      '',
      `今日完成(${doneToday.length}):`, lines(doneToday, item), '',
      `進行中(${doing.length}):`, lines(doing, itemDue), '',
      `今天到期(${dueToday.length}):`, lines(dueToday, item), '',
      `已逾期(${over.length}):`, lines(over, itemDue), '',
      `明日到期(${dueTomorrow.length}):`, lines(dueTomorrow, item),
    ].join('\n');
  }
  const w = weekRange();
  const done = weekDone();
  const added = ts.filter(t => new Date(t.created_at) >= w.startDate);
  const fromMail = added.filter(t => t.source === 'email');
  const remain = sortTodos(ts.filter(t => FILTERS.week.test(t)), 'open');
  const over = sortTodos(ts.filter(FILTERS.overdue.test), 'open');
  const nextStart = ymd(addDays(parseYmd(w.end), 1)), nextEnd = ymd(addDays(parseYmd(w.end), 7));
  const next = sortTodos(ts.filter(t => open(t) && t.due_date && t.due_date >= nextStart && t.due_date <= nextEnd), 'open');
  return [
    `【工作週報】${fmtDate(w.start)} ~ ${fmtDate(w.end)}`,
    '',
    `本週新增 ${added.length} 項(其中 ${fromMail.length} 項來自信件),完成 ${done.length} 項,目前未完成共 ${ts.filter(open).length} 項。`,
    '',
    `本週完成(${done.length}):`, lines(done, item), '',
    `本週到期尚未完成(${remain.length}):`, lines(remain, itemDue), '',
    `已逾期(${over.length}):`, lines(over, itemDue), '',
    `下週到期(${next.length}):`, lines(next, itemDue),
  ].join('\n');
}
function renderSummary() { $('#summary').textContent = buildSummary(); }
document.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => {
  state.mode = b.dataset.mode;
  document.querySelectorAll('.seg button').forEach(x => x.setAttribute('aria-pressed', x === b));
  renderSummary();
}));
$('#copyBtn').addEventListener('click', async () => {
  const text = $('#summary').textContent;
  try { await navigator.clipboard.writeText(text); toast('已複製摘要,可以貼到 Teams 或 Email'); }
  catch { const r = document.createRange(); r.selectNodeContents($('#summary')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast('已選取摘要,請按 Ctrl+C 複製'); }
});

/* ---------- 互動:篩選 ---------- */
$('#tabs').addEventListener('click', e => {
  const b = e.target.closest('.tab'); if (!b) return;
  state.filter = b.dataset.filter; renderTabs(); renderList();
});
document.querySelectorAll('.stat').forEach(b => b.addEventListener('click', () => {
  state.filter = b.dataset.go; renderTabs(); renderList();
  $('#list').scrollIntoView({ behavior: 'smooth', block: 'start' });
}));
let qTimer;
$('#q').addEventListener('input', e => { clearTimeout(qTimer); qTimer = setTimeout(() => { state.q = e.target.value.trim(); renderList(); }, 150); });
$('#projectFilter').addEventListener('change', e => { state.project = e.target.value; renderList(); });

/* ---------- 互動:更新資料 ---------- */
async function update(id, patch) {
  const { data, error } = await sb.from('todos').update(patch).eq('id', id).select().single();
  if (error) { toast(errText(error)); render(); return null; }
  state.todos = state.todos.map(t => t.id === id ? data : t);
  render();
  return data;
}
const pendingDelete = new Map();
$('#list').addEventListener('change', async e => {
  const li = e.target.closest('.todo'); if (!li) return;
  if (e.target.matches('.check')) {
    const r = await update(li.dataset.id, { status: e.target.checked ? 'done' : 'todo' });
    if (r) toast(r.status === 'done' ? '已完成,辛苦了' : '已改回待辦');
  } else if (e.target.dataset.act === 'status') {
    const r = await update(li.dataset.id, { status: e.target.value });
    if (r) toast(`狀態改為「${STATUS[r.status]}」`);
  }
});
$('#list').addEventListener('click', async e => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const id = b.closest('.todo').dataset.id;
  if (b.dataset.act === 'edit') openForm(state.todos.find(t => t.id === id));
  if (b.dataset.act === 'delete') {
    // 第一次按顯示確認,3 秒內再按一次才真的刪除
    if (!pendingDelete.has(id)) {
      b.textContent = '確定刪除?';
      pendingDelete.set(id, setTimeout(() => { pendingDelete.delete(id); b.textContent = '刪除'; }, 3000));
      return;
    }
    clearTimeout(pendingDelete.get(id)); pendingDelete.delete(id);
    const { error } = await sb.from('todos').delete().eq('id', id);
    if (error) { toast(errText(error)); return; }
    state.todos = state.todos.filter(t => t.id !== id);
    render(); toast('已刪除');
  }
});

/* ---------- 新增 / 編輯 ---------- */
const dlg = $('#dlg');
function openForm(t) {
  state.editingId = t?.id ?? null;
  $('#dlgTitle').textContent = t ? '編輯代辦' : '新增代辦';
  $('#fTitle').value = t?.title ?? '';
  $('#fDetail').value = t?.detail ?? '';
  $('#fDue').value = t?.due_date ?? '';
  $('#fProject').value = t?.project ?? '';
  $('#fPriority').value = t?.priority ?? 'medium';
  $('#fStatus').value = t?.status ?? 'todo';
  $('#formMsg').hidden = true;
  dlg.showModal();
  $('#fTitle').focus();
}
$('#addBtn').addEventListener('click', () => openForm(null));
$('#cancelBtn').addEventListener('click', () => dlg.close());
$('#todoForm').addEventListener('submit', async e => {
  e.preventDefault();
  const row = {
    title: $('#fTitle').value.trim(),
    detail: $('#fDetail').value.trim() || null,
    due_date: $('#fDue').value || null,
    project: $('#fProject').value.trim() || null,
    priority: $('#fPriority').value,
    status: $('#fStatus').value,
  };
  if (!row.title) { const m = $('#formMsg'); m.textContent = '請填寫標題。'; m.hidden = false; return; }
  const btn = $('#saveBtn'); btn.disabled = true;
  let result;
  if (state.editingId) {
    result = await update(state.editingId, row);
  } else {
    const { data, error } = await sb.from('todos').insert(row).select().single();
    if (error) { const m = $('#formMsg'); m.textContent = errText(error); m.hidden = false; }
    else { state.todos = [data, ...state.todos]; render(); result = data; }
  }
  btn.disabled = false;
  if (result) { dlg.close(); toast(state.editingId ? '已儲存變更' : '已新增代辦'); }
});

/* ---------- 啟動 ---------- */
(async function init() {
  if (location.protocol === 'file:') $('#fileWarn').hidden = false;
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('error_description')) {
    showLoginMsg('登入連結無效或已過期,請重新寄送一次。', true);
    history.replaceState(null, '', location.pathname + location.search);
  }
  const { data: { session } } = await sb.auth.getSession();
  setUser(session?.user ?? null);
  sb.auth.onAuthStateChange((_event, session) => setUser(session?.user ?? null));
  // 跨日時自動更新「今天到期」等計算
  setInterval(() => { if (state.user) render(); }, 5 * 60 * 1000);
})();
})();
