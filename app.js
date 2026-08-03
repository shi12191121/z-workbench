/* =========================================================
 * z的工作台 · 主逻辑
 * 数据层：Firebase 实时数据库（云端）优先 + LocalStorage（本地兜底）
 * 任意一端修改 → 毫秒级写入云端 → 另一端 onValue 监听实时刷新
 * ========================================================= */
'use strict';

/* ----------------------- 常量 ----------------------- */
const STORE_KEY = 'z_workbench_v2';
// 同步接口地址：默认同源 '/api/sync'（本地或能跑 Node 的同源主机）。
// 若要指向独立的常驻同步服务（如 Render/Railway/Fly），把它改成 'https://你的主机/api/sync' 即可，其余代码无需改动。
const SYNC_ENDPOINT = '/api/sync';
const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const monthKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; };
function weekStart() {
  const d = new Date(); d.setHours(0,0,0,0);
  const day = (d.getDay() + 6) % 7; // 周一为一周起点
  d.setDate(d.getDate() - day);
  return d;
}
const weekKeyStr = () => { const d = weekStart(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };

/* ----------------------- 工具 ----------------------- */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 1800);
}
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function fmt(n) { return Number(n || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 }); }
function uid() { return Date.now() + Math.floor(Math.random() * 1000); }
function shiftDay(key, n) {  // key 形如 'YYYY-M-D'，返回 +/-n 天的 key
  const [y, m, d] = key.split('-').map(Number);
  const t = new Date(y, m - 1, d + n);
  return `${t.getFullYear()}-${t.getMonth()+1}-${t.getDate()}`;
}
function inWeek(dateStr) { return dateStr >= weekKeyStr(); }

/* ----------------------- 默认数据 ----------------------- */
function defaultState() {
  return {
    currentPage: 'growth',
    reminders: { times: '09:00, 14:30, 21:00', text: '⏰ 每天到点，来看看今天的计划吧～' },
    checkins: {},                 // { '2026-08-01': true }
    todayTasks: [
      { id: 1, name: '英语听力', time: '08:00 - 08:30', freq: 7, done: false, date: todayKey() },
      { id: 2, name: '有氧运动', time: '18:00 - 18:30', freq: 5, done: false, date: todayKey() },
      { id: 3, name: '剪辑视频', time: '20:00 - 21:00', freq: 5, done: false, date: todayKey() },
      { id: 4, name: '今日账单', time: '22:00 - 22:15', freq: 7, done: false, date: todayKey() }
    ],
    nextTaskId: 5,
    todos: [], nextTodoId: 1,
    videos: [], english: [], fitness: [], basketball: [], wps: [], reviews: [], savings: [], bills: [], billBudget: 0,
    enDaily: {}, enWords: [], enBili: [], enLearnedWords: [], enLearnedCount: 0, enStudyCount: 0, enLastStudy: 0,
    fixedSchedule: [], nextFixedId: 1,
    douyin: [], dyMaterial: undefined, dyMatUpdated: '', dyStats: [], diet: { meals: {}, sleepGoal: 7.5, wakeTime: '07:00' }, travel: [],
    courses: [], videos: [], studySeconds: 0, _studyStartTs: 0,
    gfCust: [], gfMem: [], gfInteract: {},
    goal: 10000
  };
}

/* ----------------------- 数据层 Store ----------------------- */
const Store = (function () {
  let state = defaultState();
  let uidLocal = localStorage.getItem('z_uid') || (() => { const id = 'z-' + Math.random().toString(36).slice(2, 10); localStorage.setItem('z_uid', id); return id; })();
  let cloudEnabled = false, dbRef = null, remoteApplying = false;
  // 自托管云端同步（零依赖 server.js）：所有访问同一网址的设备共用同一份数据
  let selfHostEnabled = false, lastSyncVer = 0, lastSyncTs = 0, pollTimer = null;
  const SYNC_POLL_MS = 4000; // 轮询间隔：手机/电脑改动约 4 秒内在对端出现
  // GitHub 仓库同步（永远在线、无需另开主机）：令牌/仓库存在 localStorage，不入代码
  let githubEnabled = false, ghToken = '', ghRepo = '', ghPath = 'z-workbench-sync.json', ghSha = null, ghTimer = null;
  const GH_POLL_MS = 6000;
  const listeners = [];

  function notify() { listeners.forEach(f => f()); }
  // 任务名规范化：今日待办 / Todo 清单 的任务最多 4 个字（与截图一致）
  function normTaskNames(st) {
    if (st && st.todayTasks) st.todayTasks.forEach(t => { if (t.name && t.name.length > 4) t.name = t.name.slice(0, 4); });
    if (st && st.todos) st.todos.forEach(t => { if (t.text && t.text.length > 4) t.text = t.text.slice(0, 4); });
  }
  function localLoad() { try { const r = localStorage.getItem(STORE_KEY); if (r) { state = Object.assign(defaultState(), JSON.parse(r)); normTaskNames(state); localSave(); } } catch (e) {} }
  function localSave() { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }

  // 初始化云端（Firebase 实时数据库）
  function initCloud() {
    if (!FB_CONFIGURED || typeof firebase === 'undefined') return Promise.resolve(false);
    try {
      if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
      const db = firebase.database();
      dbRef = db.ref('users/' + uidLocal);
      // 监听云端变化 → 另一端修改后实时刷新本端
      dbRef.on('value', (snap) => {
        const v = snap.val();
        if (v) {
          remoteApplying = true;
          state = Object.assign(defaultState(), v);
          normTaskNames(state);     // 云端数据也规范到 4 字内
          localSave();              // 本地兜底缓存（断网可用）
          notify();
          setTimeout(() => { remoteApplying = false; }, 60);
        }
      });
      cloudEnabled = true;
      return Promise.resolve(true);
    } catch (e) { console.warn('云端初始化失败：', e); return Promise.resolve(false); }
  }

  function push() {
    localSave();                   // 永远先写本地兜底
    if (cloudEnabled && dbRef && !remoteApplying) {
      dbRef.set(state).catch(e => console.warn('云端写入失败（已保留本地）：', e));
    }
    if (selfHostEnabled && !remoteApplying) {
      // 把当前数据推到自托管云端（last-write-wins）
      fetch(SYNC_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: state })
      }).then(r => r.json()).then(meta => {
        if (meta && meta.ver != null) { lastSyncVer = meta.ver; lastSyncTs = meta.ts; }
      }).catch(e => console.warn('自托管云端写入失败（已保留本地）：', e));
    }
    if (githubEnabled && !remoteApplying) pushGithub();
  }

  // ---- GitHub 仓库同步（写入私有仓库的一个 JSON 文件，作为永远在线的单一真相源）----
  function ghHeaders() {
    return { 'Authorization': 'Bearer ' + ghToken, 'Content-Type': 'application/json', 'Accept': 'application/vnd.github+json' };
  }
  function ghUrl() { return 'https://api.github.com/repos/' + ghRepo + '/contents/' + ghPath; }
  function ghEncode(obj) { return btoa(unescape(encodeURIComponent(JSON.stringify(obj)))); }
  function ghDecode(b64) { return JSON.parse(decodeURIComponent(escape(atob(b64.replace(/\n/g, ''))))); }

  function ghPut(creating) {
    const body = { message: 'z-workbench sync ' + new Date().toISOString(), content: ghEncode(state) };
    if (!creating && ghSha) body.sha = ghSha;
    return fetch(ghUrl(), { method: 'PUT', headers: ghHeaders(), body: JSON.stringify(body) })
      .then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(j => { ghSha = j.content ? j.content.sha : ghSha; });
  }
  function pushGithub() {
    ghPut(false).then(() => {}).catch(e => {
      if (String(e.message).indexOf('409') >= 0) {
        // 冲突（对端已改）：先取最新 sha 再重试一次
        fetch(ghUrl(), { method: 'GET', headers: ghHeaders() }).then(r => r.ok ? r.json() : null).then(j => {
          if (j && j.sha) { ghSha = j.sha; ghPut(false).catch(() => {}); }
        }).catch(() => {});
      } else console.warn('GitHub 写入失败（已保留本地）：', e.message);
    });
  }
  function pullGithub(silent) {
    return fetch(ghUrl(), { method: 'GET', headers: ghHeaders() }).then(r => {
      if (r.status === 404) { // 文件不存在 -> 播种创建
        return ghPut(true).then(() => false);
      }
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    }).then(j => {
      if (j && j.sha && j.sha !== ghSha) {
        const data = ghDecode(j.content);
        if (data) {
          remoteApplying = true;
          state = Object.assign(defaultState(), data);
          normTaskNames(state);
          localSave();
          ghSha = j.sha;
          notify();
          setTimeout(() => { remoteApplying = false; }, 60);
          return true;
        }
      }
      return false;
    }).catch(e => { if (!silent) console.warn('GitHub 拉取失败：', e.message); return false; });
  }
  function initGithub() {
    ghToken = localStorage.getItem('z_gh_token') || '';
    ghRepo = localStorage.getItem('z_gh_repo') || '';
    ghPath = localStorage.getItem('z_gh_path') || 'z-workbench-sync.json';
    if (!ghToken || !ghRepo) { githubEnabled = false; return Promise.resolve(false); }
    githubEnabled = true;
    // 先把本机数据推上去（若存在则更新，不存在则创建），再启动轮询
    return pullGithub(true).then(() => {
      if (ghTimer) clearInterval(ghTimer);
      ghTimer = setInterval(() => { if (!remoteApplying) pullGithub(true); }, GH_POLL_MS);
      return true;
    }).catch(() => { githubEnabled = false; return false; });
  }

  // ---- 自托管云端：探测 + 首次拉取/播种 + 轮询 ----
  function pullFromServer(silent) {
    return fetch(SYNC_ENDPOINT, { method: 'GET', cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(meta => {
        if (!meta) return false;
        if (meta.ver && meta.ver > lastSyncVer) {
          // 云端比本地新 -> 拉取覆盖（云端为单一真相源）
          if (meta.data) {
            remoteApplying = true;
            state = Object.assign(defaultState(), meta.data);
            normTaskNames(state);
            localSave();
            lastSyncVer = meta.ver; lastSyncTs = meta.ts;
            notify();
            setTimeout(() => { remoteApplying = false; }, 60);
            return true;
          }
        }
        return false;
      }).catch(e => { if (!silent) console.warn('云端拉取失败：', e); return false; });
  }

  function initSelfHost() {
    return fetch(SYNC_ENDPOINT, { method: 'GET', cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(meta => {
        selfHostEnabled = true;
        if (meta && meta.data) {
          // 云端已有数据 -> 用云端覆盖本地（首次取回历史数据）
          remoteApplying = true;
          state = Object.assign(defaultState(), meta.data);
          normTaskNames(state);
          localSave();
          lastSyncVer = meta.ver || 0; lastSyncTs = meta.ts || 0;
          notify();
          setTimeout(() => { remoteApplying = false; }, 60);
        } else {
          // 云端为空 -> 把本机当前数据播种上去（首次打开的手机/电脑都能带数据进云）
          fetch(SYNC_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: state })
          }).then(r => r.json()).then(m => { if (m && m.ver != null) { lastSyncVer = m.ver; lastSyncTs = m.ts; } }).catch(() => {});
        }
        // 启动轮询：对端改动约 4 秒内在本端出现
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(() => { if (!remoteApplying) pullFromServer(true); }, SYNC_POLL_MS);
        return true;
      })
      .catch(() => { selfHostEnabled = false; return false; }); // 后端不可用 -> 退回本地模式
  }

  return {
    get state() { return state; },
    get uid() { return uidLocal; },
    get cloud() { return cloudEnabled || selfHostEnabled || githubEnabled; },
    get cloudMode() { return cloudEnabled ? 'firebase' : (githubEnabled ? 'github' : (selfHostEnabled ? 'selfhost' : 'local')); },
    get ghConfigured() { return !!localStorage.getItem('z_gh_token') && !!localStorage.getItem('z_gh_repo'); },
    init() { localLoad(); initCloud(); initSelfHost(); return initGithub(); },
    save() { push(); },
    onChange(f) { listeners.push(f); },
    // 配置 / 关闭 GitHub 同步
    setupGithub(token, repo, path) {
      localStorage.setItem('z_gh_token', token.trim());
      localStorage.setItem('z_gh_repo', repo.trim());
      localStorage.setItem('z_gh_path', (path && path.trim()) || 'z-workbench-sync.json');
      return initGithub();
    },
    clearGithub() {
      localStorage.removeItem('z_gh_token'); localStorage.removeItem('z_gh_repo'); localStorage.removeItem('z_gh_path');
      githubEnabled = false; if (ghTimer) clearInterval(ghTimer);
    },
    // 导入外部数据并覆盖本机（导入按钮 / 多设备迁移用）
    importState(obj) {
      if (!obj) return;
      remoteApplying = true;
      state = Object.assign(defaultState(), obj);
      normTaskNames(state);
      push(); notify();
      setTimeout(() => { remoteApplying = false; }, 60);
    },
    // 切换数据身份（用于多设备取回历史数据）
    setUid(id) { uidLocal = id; localStorage.setItem('z_uid', id); location.reload(); }
  };
})();

let S = defaultState();

/* 派生统计 */
const doneCount = () => S.todayTasks.filter(t => t.done).length;
const weekCount = (arr) => new Set(arr.filter(x => inWeek(x.date)).map(x => x.date)).size;
const monthSave = () => S.savings.filter(s => (s.date || '').startsWith(monthKey())).reduce((a, x) => a + (+x.amount || 0), 0);
const monthBillExpense = () => S.bills.filter(b => b.type === 'expense' && (b.date || '').startsWith(monthKey())).reduce((a, x) => a + (+x.amount || 0), 0);
const dietWeekCount = () => { const m = S.diet && S.diet.meals || {}; return new Set(Object.keys(m).filter(k => inWeek(k) && (m[k].b || m[k].l || m[k].d))).size; };

/* 本周频次（从真实活动数据派生，自动联动）*/
function computeWeeklyFreq() {
  return {
    study:  S.english.filter(x => inWeek(x.date)).length,
    sport:  S.fitness.filter(x => inWeek(x.date)).length + S.basketball.filter(x => inWeek(x.date)).length,
    bill:   S.bills.filter(x => inWeek(x.date)).length,
    review: S.reviews.filter(x => inWeek(x.date)).length
  };
}

/* ----------------------- 导航 ----------------------- */
function switchPage(page) {
  S.currentPage = page; Store.save();
  $$('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.page === page));
  $$('.page-section').forEach(el => el.classList.toggle('active', el.id === 'page-' + page));
  clearAutoFillInputs();
}

/* 清空所有页面级输入框（防 iOS Safari / 小米 / 夸克 等浏览器的自动恢复 / 自动填充） */
function clearAutoFillInputs() {
  document.querySelectorAll('.page-section input, .page-section textarea').forEach(el => {
    if (el.type === 'hidden' || el.type === 'password' || el.type === 'file' || el.type === 'checkbox' || el.type === 'radio' || el.type === 'submit') return;
    try { el.value = ''; } catch (e) {}
  });
}
// 多种时机触发，确保浏览器无论何时注入都被覆盖：load 后 / pageshow（从后台切回） / 短延迟兜底
window.addEventListener('load', () => {
  setTimeout(clearAutoFillInputs, 0);
  setTimeout(clearAutoFillInputs, 100);
  setTimeout(clearAutoFillInputs, 400);
});
window.addEventListener('pageshow', clearAutoFillInputs);
$$('.nav-item').forEach(el => el.addEventListener('click', () => switchPage(el.dataset.page)));

/* Tab 切换（每日计划）*/
$$('.tabs').forEach(tabs => tabs.addEventListener('click', e => {
  const t = e.target.closest('.tab'); if (!t) return;
  const key = t.dataset.tab;
  Array.from(tabs.querySelectorAll('.tab')).forEach(x => x.classList.toggle('active', x === t));
  const section = tabs.closest('.page-section');
  const order = ['overview', 'goal', 'habit', 'record', 'monthly'];
  const idx = order.indexOf(key);
  $$('[data-tabpanel]', section).forEach((p, i) => { p.hidden = (i !== idx); });
}));

/* ----------------------- 今日成长 · 渲染 ----------------------- */
let calYear, calMonth;
function renderCalendar() {
  const now = new Date();
  if (calYear === undefined) { calYear = now.getFullYear(); calMonth = now.getMonth(); }
  const first = new Date(calYear, calMonth, 1);
  const startW = first.getDay();
  const days = new Date(calYear, calMonth + 1, 0).getDate();
  const wk = ['日', '一', '二', '三', '四', '五', '六'];
  let h = `<div class="cal-head">
      <button class="cal-nav" id="calPrev">‹</button>
      <div class="cal-title">${calYear} 年 ${calMonth + 1} 月</div>
      <button class="cal-nav" id="calNext">›</button>
    </div>
    <div class="cal-week">${wk.map(w => `<div>${w}</div>`).join('')}</div>
    <div class="cal-grid">`;
  for (let i = 0; i < startW; i++) h += `<div class="cal-cell empty"></div>`;
  for (let d = 1; d <= days; d++) {
    const ds = `${calYear}-${String(calMonth + 1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const checked = !!S.checkins[ds];
    const isToday = ds === todayKey();
    h += `<div class="cal-cell ${checked ? 'checked' : ''} ${isToday ? 'today' : ''}" data-date="${ds}">
        <span class="cal-num">${d}</span>${checked ? '<span class="cal-check">✓</span>' : ''}
      </div>`;
  }
  h += `</div>`;
  const mKey = `${calYear}-${String(calMonth + 1).padStart(2,'0')}`;
  const mCount = Object.keys(S.checkins).filter(k => k.startsWith(mKey)).length;
  h += `<div class="cal-stat">本月已签到 <b>${mCount}</b> 天 · 累计 <b>${Object.keys(S.checkins).length}</b> 天</div>`;
  $('#calendar').innerHTML = h;

  $('#calPrev').onclick = () => { calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } renderCalendar(); };
  $('#calNext').onclick = () => { calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } renderCalendar(); };
  $$('.cal-cell[data-date]').forEach(c => c.onclick = () => {
    const ds = c.dataset.date;
    if (S.checkins[ds]) delete S.checkins[ds]; else S.checkins[ds] = true;
    Store.save(); renderCalendar();
  });
}

function renderNineGrid() {
  const items = [
    { icon: '✅', label: '今日待办', val: `${S.todayTasks.filter(t => t.date === todayKey() && t.done).length}/${S.todayTasks.filter(t => t.date === todayKey()).length}`, page: 'todo', grad: 'grad-lake' },
    { icon: '💕', label: '乐乐宝宝', val: `${(S.gfMem||[]).length} 回忆`, page: 'lele', grad: 'grad-ice' },
    { icon: '🎬', label: '电脑剪辑', val: `${S.videos.length} 条`, page: 'video', grad: 'grad-ice' },
    { icon: '📖', label: '英语学习', val: `${weekCount(S.english)} 天`, page: 'english', grad: 'grad-fog' },
    { icon: '💪', label: '健身计划', val: `${weekCount(S.fitness)} 次`, page: 'fitness', grad: 'grad-sky' },
    { icon: '🏀', label: '篮球训练', val: `${weekCount(S.basketball)} 次`, page: 'basketball', grad: 'grad-lake' },
    { icon: '🍱', label: '饮食作息', val: `${dietWeekCount()} 天`, page: 'diet', grad: 'grad-ice' },
    { icon: '🎵', label: '抖音创作', val: `${S.douyin.length} 条`, page: 'douyin', grad: 'grad-fog' },
    { icon: '📑', label: 'WPS学习', val: `${S.wps.length} 项`, page: 'wps', grad: 'grad-sky' },
    { icon: '✈️', label: '旅行计划', val: `${S.travel.length} 个`, page: 'travel', grad: 'grad-lake' },
    { icon: '📝', label: '每日复盘', val: `${weekCount(S.reviews)} 天`, page: 'review', grad: 'grad-fog' },
    { icon: '💰', label: '存钱计划', val: `¥${fmt(monthSave())}`, page: 'savings', grad: 'grad-sky' },
    { icon: '🧾', label: '每日账单', val: `¥${fmt(monthBillExpense())}`, page: 'bill', grad: 'grad-lake' }
  ];
  $('#nineGrid').innerHTML = items.map(it => `
    <div class="grid-cell ${it.grad}" data-page="${it.page}">
      <div class="grid-icon">${it.icon}</div>
      <div class="grid-label">${it.label}</div>
      <div class="grid-val">${it.val}</div>
    </div>`).join('');
  $$('#nineGrid .grid-cell').forEach(c => c.onclick = () => switchPage(c.dataset.page));
}

function renderFreq() {
  const f = computeWeeklyFreq();
  const map = { study: 7, sport: 5, bill: 7, review: 7 };
  $$('[data-freq]').forEach(el => {
    const k = el.dataset.freq;
    el.textContent = Math.min(f[k], map[k]);
  });
  // 总量（用于进度感，可自行扩展）
}

function renderGrowth() {
  renderQuote();
  renderWeekView();
  renderCalendar();
  renderNineGrid();
}

function renderQuote() {
  const d = new Date();
  const wk = ['日','一','二','三','四','五','六'];
  const el = $('#gqDate');
  if (el) el.textContent = `${d.getMonth()+1}月${d.getDate()}日 · 周${wk[d.getDay()]}`;
  const list = S.todayTasks.filter(t => !t.date || t.date === todayKey());
  const done = list.filter(t => t.done).length;
  const total = list.length;
  const pct = total ? done / total * 100 : 0;
  const r = 26, circ = 2 * Math.PI * r;
  const rf = $('#ringFill');
  if (rf) { rf.style.strokeDasharray = circ; rf.style.strokeDashoffset = circ * (1 - pct / 100); }
  const rp = $('#ringPct'); if (rp) rp.textContent = Math.round(pct) + '%';
  const gd = $('#gqDone'); if (gd) gd.textContent = done;
  const gt = $('#gqTotal'); if (gt) gt.textContent = total;
  const pf = $('#gqProgressFill'); if (pf) pf.style.width = pct + '%';
  const gs = $('#gqStreak'); if (gs) gs.textContent = computeStreak();
}

function computeStreak() {
  let cnt = 0;
  let d = new Date();
  for (let i = 0; i < 9999; i++) {
    const k = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    if (S.checkins[k]) { cnt++; d.setDate(d.getDate() - 1); }
    else {
      if (k === todayKey() && cnt === 0) { d.setDate(d.getDate() - 1); continue; }
      break;
    }
  }
  return cnt;
}

function renderWeekView() {
  const wk = ['一','二','三','四','五','六','日'];
  const start = weekStart();
  const today = todayKey();
  const end = new Date(start); end.setDate(start.getDate() + 6);
  let c = 0;
  const buildH = (withTasks) => {
    let h = '';
    for (let i = 0; i < 7; i++) {
      const dd = new Date(start); dd.setDate(start.getDate() + i);
      const k = `${dd.getFullYear()}-${String(dd.getMonth()+1).padStart(2,'0')}-${String(dd.getDate()).padStart(2,'0')}`;
      if (S.checkins[k]) c++;
      const isToday = k === today;
      const checked = S.checkins[k];
      const dayTasks = withTasks ? S.todayTasks.filter(t => (t.date || todayKey()) === k) : [];
      const pills = withTasks ? dayTasks.map(t => {
        const isDone = t.done ? 'done' : '';
        const col = 'c' + ((+t.id || 0) % 6);
        return `<div class="wv-pill ${col} ${isDone}" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</div>`;
      }).join('') : '';
      h += `<div class="wv-day ${isToday ? 'today' : ''} ${checked ? 'wv-checked' : ''}">
        <div class="wv-day-name">${wk[i]}</div>
        <div class="wv-day-num">${dd.getDate()}</div>
        ${checked ? '<div class="wv-check">✓</div>' : ''}
        ${withTasks ? `<div class="wv-tasks">${pills}</div>` : ''}
      </div>`;
    }
    return h;
  };
  const wv1 = $('#weekView'); if (wv1) wv1.innerHTML = buildH(false);
  const wv2 = $('#todoWeekView'); if (wv2) wv2.innerHTML = buildH(true);
  const rt = $('#weekRangeText'); if (rt) rt.textContent = `本周 (${start.getMonth()+1}/${start.getDate()}-${end.getMonth()+1}/${end.getDate()})`;
  const wcc = $('#weekCheckCount'); if (wcc) wcc.textContent = c;
}

function renderTodoToday() {
  const list = S.todayTasks.filter(t => !t.date || t.date === todayKey());
  const wrap = $('#todoTodayList');
  if (!wrap) return;
  if (!list.length) wrap.innerHTML = '<div class="td-empty">今日还没有任务，点右上 + 添加</div>';
  else wrap.innerHTML = list.map(t => `
    <div class="td-todo-item ${t.done ? 'done' : ''}" data-today-tg="${t.id}">
      <div class="td-todo-check"></div>
      <div class="td-todo-text">${escapeHtml(t.name)}</div>
      <button class="td-todo-del" data-today-del="${t.id}" title="删除">✕</button>
    </div>`).join('');
}

/* 今日固定行程：用户自填时间+行程，仿参考图样式；勾选表示完成 */
function renderFixedSchedule() {
  const dateText = $('#fixedDateText'); if (dateText) dateText.textContent = todayKey();
  const wrap = $('#fixedScheduleList'); if (!wrap) return;
  const list = S.fixedSchedule || [];
  if (!list.length) {
    wrap.innerHTML = '<div class="td-empty">还没有固定行程，填上你的每日作息吧～</div>';
    return;
  }
  // 按时间升序排序（空时间排到最后）
  const sorted = [...list].sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
  wrap.innerHTML = sorted.map(t => `
    <div class="fixed-row ${t.done ? 'done' : ''}" data-fix="${t.id}">
      <div class="fixed-check"></div>
      <div class="fixed-time">${escapeHtml(t.time || '—')}</div>
      <div class="fixed-content">${escapeHtml(t.content || '')}</div>
      <button class="td-todo-del" data-fix-del="${t.id}" title="删除">✕</button>
    </div>`).join('');
}

/* 今日待办·今日任务点击切换/删除 */
const todoTodayList = $('#todoTodayList');
if (todoTodayList) {
  todoTodayList.addEventListener('click', e => {
    if (e.target.closest('[data-today-del]')) {
      const dl = e.target.closest('[data-today-del]');
      S.todayTasks = S.todayTasks.filter(x => x.id !== +dl.dataset.todayDel);
      Store.save(); renderTodoToday(); renderGrowth(); renderNineGrid(); renderDaily(); toast('已删除');
      return;
    }
    const tg = e.target.closest('[data-today-tg]');
    if (tg) { const t = S.todayTasks.find(x => x.id === +tg.dataset.todayTg); if (t) { t.done = !t.done; Store.save(); renderTodoToday(); renderGrowth(); renderNineGrid(); renderDaily(); } return; }
  });
}
if (todoTodayInput) {
  todoTodayInput.addEventListener('keydown', e => { if (e.key === 'Enter') todoTodayBtn && todoTodayBtn.click(); });
}

/* 今日固定行程：点击勾选 / 删除 / 添加 */
const fixedWrap = $('#fixedScheduleList');
if (fixedWrap) {
  fixedWrap.addEventListener('click', e => {
    if (e.target.closest('[data-fix-del]')) {
      const dl = e.target.closest('[data-fix-del]');
      S.fixedSchedule = (S.fixedSchedule || []).filter(x => x.id !== +dl.dataset.fixDel);
      Store.save(); renderFixedSchedule(); toast('已删除');
      return;
    }
    const r = e.target.closest('[data-fix]');
    if (r) {
      const t = (S.fixedSchedule || []).find(x => x.id === +r.dataset.fix);
      if (t) { t.done = !t.done; Store.save(); renderFixedSchedule(); }
    }
  });
}
const btnAddFixed = $('#btnAddFixed');
const fixedTimeInput = $('#fixedTimeInput');
const fixedContentInput = $('#fixedContentInput');
function addFixedRow() {
  if (!btnAddFixed) return;
  const time = ((fixedTimeInput && fixedTimeInput.value) || '').trim();
  const content = ((fixedContentInput && fixedContentInput.value) || '').trim();
  if (!content) { toast('请填写行程内容'); return; }
  if (!/^\d{1,2}:\d{1,2}$/.test(time)) { toast('时间格式：HH:MM（如 07:00）'); return; }
  S.fixedSchedule = S.fixedSchedule || [];
  S.fixedSchedule.push({ id: S.nextFixedId++, time, content, done: false });
  Store.save();
  if (fixedTimeInput) fixedTimeInput.value = '';
  if (fixedContentInput) fixedContentInput.value = '';
  renderFixedSchedule();
  toast('已添加');
}
if (btnAddFixed) btnAddFixed.onclick = addFixedRow;
if (fixedContentInput) fixedContentInput.addEventListener('keydown', e => { if (e.key === 'Enter') addFixedRow(); });
if (fixedTimeInput) fixedTimeInput.addEventListener('keydown', e => { if (e.key === 'Enter') addFixedRow(); });

/* ----------------------- 每日计划（4 模块）----------------------- */
function renderDaily() {
  const list = S.todayTasks.filter(t => !t.date || t.date === todayKey());
  const wrap = $('#todayTaskList');
  if (!list.length) wrap.innerHTML = '<div class="empty-state"><div class="icon">🌱</div>今日还没有任务，添加一个开始吧～</div>';
  else wrap.innerHTML = list.map(t => `
    <div class="task-item ${t.done ? 'done' : ''}">
      <div class="task-checkbox ${t.done ? 'checked' : ''}" data-toggle="${t.id}"></div>
      <div class="task-info">
        <div class="task-name">${escapeHtml(t.name)}</div>
        <div class="task-meta"><span>⏰ ${escapeHtml(t.time || '自由时间')}</span><span>🎯 ${t.freq} 次/周</span></div>
      </div>
      <div class="task-actions">
        <button class="icon-btn" data-edit="${t.id}" title="编辑"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 113 3L7 19l-4 1 1-4 12.5-12.5z"/></svg></button>
        <button class="icon-btn" data-del="${t.id}" title="删除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button>
      </div>
    </div>`).join('');

  const total = list.length, done = list.filter(t => t.done).length;
  $('#doneCount').textContent = done; $('#totalCount').textContent = total;
  $('#todayDone').textContent = done; $('#todayTotal').textContent = total;
  $('#progressFill').style.width = (total ? done / total * 100 : 0) + '%';
}

$('#todayTaskList').addEventListener('click', e => {
  const tg = e.target.closest('[data-toggle]');
  if (tg) { const t = S.todayTasks.find(x => x.id === +tg.dataset.toggle); if (t) { t.done = !t.done; Store.save(); renderDaily(); renderNineGrid(); } return; }
  const dl = e.target.closest('[data-del]');
  if (dl) { S.todayTasks = S.todayTasks.filter(x => x.id !== +dl.dataset.del); Store.save(); renderDaily(); renderNineGrid(); toast('已删除任务'); return; }
  const ed = e.target.closest('[data-edit]');
  if (ed) { const t = S.todayTasks.find(x => x.id === +ed.dataset.edit); if (t) openTaskModal(t); }
});
$('#btnAddTask').onclick = addTask;
$('#newTaskInput').addEventListener('keydown', e => { if (e.key === 'Enter') addTask(); });
function addTask() {
  const v = $('#newTaskInput').value.trim().slice(0, 4); if (!v) return toast('请输入任务名（≤4字）');
  S.todayTasks.push({ id: S.nextTaskId++, name: v, time: '自由时间', freq: 3, done: false, date: todayKey() });
  Store.save(); $('#newTaskInput').value = ''; renderDaily(); renderNineGrid(); toast('已添加任务');
}

/* 任务编辑弹窗 */
const taskModal = $('#taskModal');
function openTaskModal(t) {
  $('#editTaskId').value = t.id; $('#editTaskName').value = t.name;
  $('#editTaskTime').value = t.time; $('#editTaskFreq').value = t.freq;
  taskModal.classList.add('show');
}
$('#btnCloseTask').onclick = () => taskModal.classList.remove('show');
$('#btnSaveTask').onclick = () => {
  const t = S.todayTasks.find(x => x.id === +$('#editTaskId').value); if (!t) return;
  t.name = ($('#editTaskName').value.trim() || t.name).slice(0, 4);
  t.time = $('#editTaskTime').value.trim() || '自由时间';
  t.freq = +$('#editTaskFreq').value || 1;
  Store.save(); taskModal.classList.remove('show'); renderDaily(); toast('已更新任务');
};

/* 提醒弹窗（首页与每日计划两处按钮共用 .js-reminder-open）*/
const reminderModal = $('#reminderModal');
$$('.js-reminder-open').forEach(btn => {
  btn.onclick = () => { $('#reminderTime').value = S.reminders.times; $('#reminderText').value = S.reminders.text; reminderModal.classList.add('show'); };
});
$('#btnCloseReminder').onclick = () => reminderModal.classList.remove('show');
$('#btnSaveReminder').onclick = () => {
  S.reminders.times = $('#reminderTime').value.trim();
  S.reminders.text = $('#reminderText').value.trim();
  Store.save(); reminderModal.classList.remove('show'); toast('已保存提醒设置'); setupReminder();
};

/* ----------------------- 通用列表渲染 ----------------------- */
function renderList(arr, sel, fn, empty) {
  const c = $(sel);
  if (!arr.length) { c.innerHTML = `<div class="empty-state"><div class="icon">📝</div>${empty}</div>`; return; }
  c.innerHTML = [...arr].reverse().map(fn).join('');
}

/* 今日待办·Todo 清单 */
function renderTodos() {
  const list = S.todos;
  const wrap = $('#todoList');
  if (!wrap) return;
  if (!list.length) wrap.innerHTML = '<div class="td-empty">还没有 Todo，点右下 + 添加</div>';
  else wrap.innerHTML = list.map(t => `
    <div class="td-todo-item ${t.done ? 'done' : ''}" data-tt="${t.id}">
      <div class="td-todo-check"></div>
      <div class="td-todo-text">${escapeHtml(t.text)}</div>
      <button class="td-todo-del" data-td="${t.id}" title="删除">✕</button>
    </div>`).join('');
}
$('#todoList').addEventListener('click', e => {
  if (e.target.closest('[data-td]')) {
    const dl = e.target.closest('[data-td]');
    S.todos = S.todos.filter(x => x.id !== +dl.dataset.td);
    Store.save(); renderTodos(); renderNineGrid(); toast('已删除');
    return;
  }
  const tg = e.target.closest('[data-tt]');
  if (tg) { const t = S.todos.find(x => x.id === +tg.dataset.tt); if (t) { t.done = !t.done; Store.save(); renderTodos(); } }
});

/* 今日待办页：右下 / 右上 + 按钮触发 input */
document.querySelectorAll('.td-icon-btn[data-add]').forEach(btn => {
  btn.addEventListener('click', () => {
    const which = btn.dataset.add;
    const inp = which === 'today' ? $('#todoTodayInput') : $('#todoInput');
    if (!inp) return;
    inp.classList.add('show');
    setTimeout(() => inp.focus(), 50);
  });
});
const hideInput = (inp) => { inp.classList.remove('show'); inp.value = ''; };
['#todoTodayInput', '#todoInput'].forEach(sel => {
  const inp = $(sel);
  if (!inp) return;
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const v = inp.value.trim().slice(0, 4);
      if (!v) { hideInput(inp); return; }
      if (sel === '#todoTodayInput') {
        S.todayTasks.push({ id: S.nextTaskId++, name: v, time: '自由时间', freq: 3, done: false, date: todayKey() });
        Store.save(); renderTodoToday(); renderGrowth(); renderNineGrid(); renderDaily();
      } else {
        S.todos.push({ id: S.nextTodoId++, text: v, done: false, date: todayKey() });
        Store.save(); renderTodos(); renderNineGrid();
      }
      hideInput(inp);
      toast('已添加');
    } else if (e.key === 'Escape') {
      hideInput(inp);
    }
  });
  inp.addEventListener('blur', () => { if (inp.value.trim() === '') hideInput(inp); });
});

/* 页面顶部副标题：自动注入今天日期 + 周X */
function updateTodoPageSub() {
  const el = $('#tdPageSub');
  if (!el) return;
  const d = new Date();
  const wk = ['星期日','星期一','星期二','星期三','星期四','星期五','星期六'];
  el.textContent = `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日 · ${wk[d.getDay()]}`;
}

/* ===== 电脑剪辑 · 课程追踪 ===== */
// 影视飓风「剪辑实战课」（B站：剪辑全能必修课 / 抖音：剪映必修课，49元）
// 真实结构：1 节导学 + 3 单元 14 节正课（已核对课程目录）
const CLIP_UNITS = [
  { title: '第一单元 · 从0基础入门剪辑全流程', lessons: [
    { n: 1, title: '初试成片：10分钟走通专业剪辑全流程', dur: '11:37' },
    { n: 2, title: '高效起步：口播精剪与 A/B-roll 协同', dur: '15:59' },
    { n: 3, title: '节奏掌控：混剪视频与蒙太奇逻辑', dur: '11:34' },
    { n: 4, title: '听觉塑造：音乐处理与音效设计思维', dur: '11:31' },
    { n: 5, title: '最终交付：导出管理与发布规范', dur: '14:53' }
  ]},
  { title: '第二单元 · 用简单工具实现专业效果', lessons: [
    { n: 6, title: '运动控制：关键帧与曲线运动', dur: '10:54' },
    { n: 7, title: '动态节奏：曲线变速与素材帧率', dur: '10:51' },
    { n: 8, title: '空间重组：全能抠像与蒙版合成', dur: '12:11' },
    { n: 9, title: '色彩科学：掌握一级调色工具', dur: '12:53' }
  ]},
  { title: '第三单元 · 剪出和影视飓风一样的视频', lessons: [
    { n: 10, title: '飓多多实操：快速复刻综艺包装', dur: '18:43' },
    { n: 11, title: '影视飓风运镜实操：进阶平面跟踪', dur: '10:55' },
    { n: 12, title: '采访实操：快速上手多机位剪辑', dur: '08:45' },
    { n: 13, title: '亿点点不一样实操：时钟理论应用', dur: '20:35' },
    { n: 14, title: '样片日记实操：Vlog的剪辑结构与色彩', dur: '14:50' }
  ]}
];
function syncCourseProgress(c) {
  if (c.units && c.units.length) {
    const dc = c.units.reduce((s, u) => s + u.lessons.filter(l => l.done).length, 0);
    c.current = dc; c.done = dc >= c.total;
  }
}
function ensureCourses() {
  if (!S.courses) S.courses = [];
  let changed = false;
  if (!S.courses.length) {
    S.courses = [
      { id: uid(), name: '影视飓风 · 剪辑实战课', total: 14, current: 0, done: false,
        intro: { title: '导学：如何更好地学习这门课程？', dur: '01:53' }, units: CLIP_UNITS },
      { id: uid(), name: '影视飓风 · iPhone 摄影课', total: 8, current: 0, done: false }
    ];
    changed = true;
  } else {
    // 迁移：已存在的剪辑实战课补上单元结构并修正总节数（原写为12）
    S.courses.forEach(c => {
      if (c.name && c.name.indexOf('剪辑实战') >= 0 && !c.units) {
        c.units = CLIP_UNITS; c.total = 14;
        if (c.current > 14) c.current = 14;
        if (c.current >= 14) c.done = true;
        changed = true;
      }
    });
  }
  if (changed) Store.save();
}
function renderCourses() {
  ensureCourses();
  const cs = S.courses;
  const studying = cs.filter(c => !c.done).length;
  const done = cs.filter(c => c.done).length;
  const a = document.getElementById('courseStudying'); if (a) a.textContent = studying;
  const b = document.getElementById('courseDone'); if (b) b.textContent = done;
  const wrap = document.getElementById('courseList');
  if (!wrap) return;
  if (!cs.length) { wrap.innerHTML = '<div class="empty-state" style="padding:14px 0;">还没有课程，添加一门开始学吧～</div>'; return; }
  wrap.innerHTML = cs.map(c => (c.units && c.units.length) ? renderCourseDetail(c) : renderCourseSimple(c)).join('');
}
function renderCourseSimple(c) {
  const pct = c.total ? Math.min(100, Math.round((c.current / c.total) * 100)) : 0;
  const prog = c.done ? '已结课 ✓' : `第 <b>${c.current}</b> / <b>${c.total}</b> 节`;
  return `<div class="course-card ${c.done ? 'done' : ''}">
    <div class="course-head">
      <div class="course-name">🎬 ${escapeHtml(c.name)}</div>
      <button class="course-del" data-act="del" data-course="${c.id}" title="删除">✕</button>
    </div>
    <div class="course-bar"><div class="course-fill" style="width:${pct}%"></div></div>
    <div class="course-foot">
      <span class="course-prog">${prog}</span>
      <div class="course-ctrl">
        <button class="course-step" data-act="prev" data-course="${c.id}" ${c.current<=0?'disabled':''}>−</button>
        <button class="course-step" data-act="next" data-course="${c.id}">＋</button>
        <button class="course-set" data-act="set" data-course="${c.id}" title="改总节数">⚙</button>
        <button class="course-finish ${c.done?'on':''}" data-act="finish" data-course="${c.id}">${c.done?'已完成':'标记完成'}</button>
      </div>
    </div>
  </div>`;
}
function renderCourseDetail(c) {
  const total = c.total;
  const doneCount = c.units.reduce((s, u) => s + u.lessons.filter(l => l.done).length, 0);
  const pct = total ? Math.min(100, Math.round((doneCount / total) * 100)) : 0;
  const introHtml = c.intro ? `<div class="course-intro">📌 ${escapeHtml(c.intro.title)} · <span>${escapeHtml(c.intro.dur || '')}</span></div>` : '';
  const unitsHtml = c.units.map((u, ui) => {
    const uDone = u.lessons.filter(l => l.done).length;
    const uTotal = u.lessons.length;
    const uPct = uTotal ? Math.round((uDone / uTotal) * 100) : 0;
    return `<div class="course-unit">
      <div class="cu-head"><span class="cu-title">${escapeHtml(u.title)}</span><span class="cu-prog">${uDone}/${uTotal}</span></div>
      <div class="cu-bar"><div class="cu-fill" style="width:${uPct}%"></div></div>
      <div class="cu-lessons">
        ${u.lessons.map(l => `<div class="lesson-row ${l.done ? 'on' : ''}" data-act="lesson" data-course="${c.id}" data-u="${ui}" data-l="${l.n}">
            <div class="lesson-check ${l.done ? 'checked' : ''}"></div>
            <div class="lesson-main"><div class="lesson-title">${escapeHtml(l.title)}</div><div class="lesson-sub">第 ${l.n} 节 · ⏱ ${escapeHtml(l.dur || '')}</div></div>
          </div>`).join('')}
      </div>
    </div>`;
  }).join('');
  const prog = c.done ? '已结课 ✓' : `已学 <b>${doneCount}</b> / <b>${total}</b> 节`;
  return `<div class="course-card ${c.done ? 'done' : ''}">
    <div class="course-head">
      <div class="course-name">🎬 ${escapeHtml(c.name)}</div>
      <button class="course-del" data-act="del" data-course="${c.id}" title="删除">✕</button>
    </div>
    ${introHtml}
    <div class="course-bar"><div class="course-fill" style="width:${pct}%"></div></div>
    <div class="course-foot">
      <span class="course-prog">${prog}</span>
      <div class="course-ctrl">
        <button class="course-finish ${c.done ? 'on' : ''}" data-act="finish" data-course="${c.id}">${c.done ? '已完成' : '标记完成'}</button>
      </div>
    </div>
    ${unitsHtml}
  </div>`;
}

/* 电脑剪辑 · 剪辑项目 */
function renderVideos() {
  const a = document.getElementById('projCount'); if (a) a.textContent = S.videos.length;
  updateDurationStat();
  const d = document.getElementById('projDone'); if (d) d.textContent = S.videos.filter(v => v.done).length;
  const t = document.getElementById('projTotal'); if (t) t.textContent = S.videos.length;
  renderList(S.videos, '#videoList', v => `
    <div class="list-item">
      <div class="task-checkbox ${v.done ? 'checked' : ''}" data-vt="${v.id}"></div>
      <div class="li-main"><div class="li-title" style="${v.done?'text-decoration:line-through;color:#718096':''}">${escapeHtml(v.name)}</div><div class="li-sub">⏱ ${v.dur} 分钟 · ${v.date}</div></div>
      <button class="icon-btn" data-vd="${v.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button>
    </div>`, '还没有剪辑项目，添加一个开始吧～');
}

/* ===== 电脑剪辑 · 学习计时 ===== */
let studyTimer = null;
function studyTotalSeconds() {
  let s = (S.studySeconds || 0);
  if (S._studyStartTs) s += (Date.now() - S._studyStartTs) / 1000;
  return s;
}
function fmtClock(sec) {
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
function updateDurationStat() {
  const el = document.getElementById('projMinutes');
  if (el) {
    const proj = (S.videos || []).reduce((s, v) => s + (+v.dur || 0), 0);
    el.textContent = proj + Math.floor(studyTotalSeconds() / 60);
  }
}
function renderStudyTimer() {
  const clock = document.getElementById('stClock');
  const toggle = document.getElementById('stToggle');
  const state = document.getElementById('stState');
  const total = document.getElementById('stTotal');
  const timing = !!S._studyStartTs;
  if (clock) clock.textContent = fmtClock(studyTotalSeconds());
  if (toggle) toggle.textContent = timing ? '■ 停止并记录' : '▶ 开始学习';
  if (state) { state.textContent = timing ? '计时中…' : '未开始'; state.classList.toggle('on', timing); }
  if (total) total.textContent = Math.floor(studyTotalSeconds() / 60);
  updateDurationStat();
}
function startStudy() {
  if (S._studyStartTs) return;
  S._studyStartTs = Date.now();
  Store.save();
  if (studyTimer) clearInterval(studyTimer);
  studyTimer = setInterval(renderStudyTimer, 1000);
  renderStudyTimer();
}
function stopStudy() {
  if (!S._studyStartTs) return;
  const inc = (Date.now() - S._studyStartTs) / 1000;
  S.studySeconds = (S.studySeconds || 0) + inc;
  S._studyStartTs = null;
  if (studyTimer) { clearInterval(studyTimer); studyTimer = null; }
  Store.save();
  renderStudyTimer();
  toast('已记录本次学习 ' + fmtClock(inc));
}
const stToggleEl = document.getElementById('stToggle');
if (stToggleEl) stToggleEl.addEventListener('click', () => { if (S._studyStartTs) stopStudy(); else startStudy(); });

/* 课程交互（事件委托） */
const courseListEl = document.getElementById('courseList');
if (courseListEl) {
  courseListEl.addEventListener('click', e => {
    const btn = e.target.closest('[data-act]'); if (!btn) return;
    const id = +btn.dataset.course, act = btn.dataset.act;
    const c = S.courses.find(x => x.id === id); if (!c) return;
    if (act === 'prev') { c.current = Math.max(0, c.current - 1); if (c.current < c.total) c.done = false; }
    else if (act === 'next') { c.current = Math.min(c.total, c.current + 1); if (c.current >= c.total) c.done = true; }
    else if (act === 'finish') { c.done = !c.done; if (c.units) syncCourseProgress(c); else if (c.done) c.current = c.total; else if (c.current >= c.total) c.current = c.total; }
    else if (act === 'lesson') {
      const ui = +btn.dataset.u, ln = +btn.dataset.l;
      const u = c.units && c.units[ui]; if (!u) return;
      const l = u.lessons.find(x => x.n === ln); if (!l) return;
      l.done = !l.done; syncCourseProgress(c);
    }
    else if (act === 'set') {
      const n = prompt('设置总节数（当前 ' + c.total + '）', c.total);
      if (n != null) { const v = parseInt(n, 10); if (v > 0) { c.total = v; if (c.current > v) c.current = v; if (c.current >= v) c.done = true; } }
    }
    else if (act === 'del') { S.courses = S.courses.filter(x => x.id !== id); }
    Store.save(); renderCourses();
  });
}
const btnAddCourse = document.getElementById('btnAddCourse');
if (btnAddCourse) {
  btnAddCourse.addEventListener('click', () => {
    const name = (document.getElementById('courseName').value || '').trim();
    let total = parseInt(document.getElementById('courseTotal').value, 10);
    if (!name) return toast('请填课程名');
    if (!total || total < 1) total = 1;
    S.courses = S.courses || [];
    S.courses.push({ id: uid(), name, total, current: 0, done: false });
    Store.save();
    document.getElementById('courseName').value = '';
    document.getElementById('courseTotal').value = '';
    renderCourses();
    toast('课程已添加 🎬');
  });
}
$('#btnAddVideo').onclick = () => {
  const name = $('#videoName').value.trim(), dur = +$('#videoDur').value;
  if (!name) return toast('请输入项目名称'); if (!dur) return toast('请输入时长');
  S.videos.push({ id: uid(), name, dur, done: false, date: todayKey() });
  Store.save(); $('#videoName').value = ''; $('#videoDur').value = ''; renderVideos(); renderNineGrid(); toast('已添加');
};
$('#videoList').addEventListener('click', e => {
  const tg = e.target.closest('[data-vt]'); if (tg) { const v = S.videos.find(x => x.id === +tg.dataset.vt); if (v) { v.done = !v.done; Store.save(); renderVideos(); } return; }
  const dl = e.target.closest('[data-vd]'); if (dl) { S.videos = S.videos.filter(x => x.id !== +dl.dataset.vd); Store.save(); renderVideos(); renderNineGrid(); toast('已删除'); }
});

/* ============ 英语学习（CET-6 备考） ============ */
const EN_EXAM = new Date(2026, 11, 13);   // 六级笔试 2026-12-13
const EN_START = new Date(2026, 7, 3);    // 备考起点 2026-08-03

function enCountdown() {
  const now = new Date();
  const total = Math.max(1, Math.round((EN_EXAM - EN_START) / 86400000));
  const days = Math.max(0, Math.ceil((EN_EXAM - now) / 86400000));
  const passed = Math.min(total, Math.max(0, Math.round((now - EN_START) / 86400000)));
  $('#enCdDays').textContent = days;
  $('#enCdDays2').textContent = days;
  $('#enCdBill').style.width = Math.round(passed / total * 100) + '%';
  $('#enCdSub').textContent = days > 0 ? `备考进行中 · 已过 ${passed}/${total} 天` : '考试日到了，加油！';
}

// ---- 唤起 APP 的通用工具 ----
function isAndroid() { return /android/i.test(navigator.userAgent); }
function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent); }
// 把 B站网页链接转成 APP 深链 scheme（合集/视频/搜索/UP主主页）
function biliSchemeFromUrl(url) {
  if (!url) return null;
  let m;
  if ((m = url.match(/space\.bilibili\.com\/(\d+)\/channel\/(?:collectiondetail|seriesmore)\?sid=(\d+)/)))
    return 'bilibili://space/' + m[1] + '/channel/' + m[2] + '?sid=' + m[3];
  if ((m = url.match(/space\.bilibili\.com\/(\d+)/))) return 'bilibili://space/' + m[1];
  if ((m = url.match(/bilibili\.com\/video\/(BV[\w]+)/i))) return 'bilibili://video/' + m[1];
  if ((m = url.match(/search\.bilibili\.com\/all\?keyword=([^&]+)/i))) return 'bilibili://search?keyword=' + m[1];
  return null; // b23.tv 等 App Link 短链返回 null，由调用处直接打开（安卓会直接唤起 APP，无选择器）
}
// 是否微信内置浏览器（会屏蔽 APP 跳转）
function isWeChat() { return /micromessenger/i.test(navigator.userAgent); }
function showWxTip() { const el = document.getElementById('wxTip'); if (el) el.hidden = false; }

// ---------- 手动记录学习（用户自己填已学单词数，系统据此计学习次数） ----------
function openLog() {
  const m = document.getElementById('enLogModal');
  const inp = document.getElementById('enLogInput');
  if (inp) inp.value = '';
  if (m) m.hidden = false;
  if (inp) setTimeout(() => inp.focus(), 50);
}
function closeLog() { const m = document.getElementById('enLogModal'); if (m) m.hidden = true; }
function submitLog() {
  const inp = document.getElementById('enLogInput');
  const n = parseInt((inp && inp.value) || '0', 10);
  if (!n || n <= 0) { toast('请输入大于 0 的数字'); return; }
  S.enLearnedCount = (S.enLearnedCount || 0) + n; // 累加已学单词数
  S.enStudyCount = (S.enStudyCount || 0) + 1;       // 每记录一次 = 1 次学习
  Store.save();
  const lw = document.getElementById('enLearnedWords'); if (lw) lw.textContent = S.enLearnedCount;
  const sc = document.getElementById('enStudyCount'); if (sc) sc.textContent = S.enStudyCount;
  const sc2 = document.getElementById('enStudyCount2'); if (sc2) sc2.textContent = S.enStudyCount;
  closeLog();
  toast('已记录 +' + n + ' 个单词');
}

// 已学习次数归零（仅清次数，不动已学单词数）
function zeroEnCount() {
  S.enStudyCount = 0;
  Store.save();
  const sc = document.getElementById('enStudyCount'); if (sc) sc.textContent = 0;
  const sc2 = document.getElementById('enStudyCount2'); if (sc2) sc2.textContent = 0;
  toast('已学习次数已归零');
}

// 跳转 B 站：唤起 APP 搜"英语六级"（安卓/iOS 均用 bilibili:// scheme 直接进 APP，不落主页）
function openBili() {
  if (isWeChat()) { wxJumpBlocked(); return; }
  const kw = encodeURIComponent('英语六级 六级 备考');
  const scheme = 'bilibili://search?keyword=' + kw;
  if (isAndroid() || isIOS()) { location.href = scheme; return; }
  window.open('https://search.bilibili.com/all?keyword=' + kw, '_blank');
}
// 点"去看"：唤起 B站 APP 到该老师/板块内容（安卓用 bilibili:// scheme 直接进 APP，绝不落主页投稿）
function goBili(url) {
  if (!url) return;
  if (isWeChat()) { wxJumpBlocked(); return; }
  const scheme = biliSchemeFromUrl(url); // 视频/空间/频道/搜索 → bilibili://；b23.tv 等 App Link 返回 null
  if (isAndroid()) {
    if (scheme) { location.href = scheme; }   // 直接唤起 APP（搜索/视频/频道）
    else { location.href = url; }              // b23.tv App Link → 直接唤起 APP 到合集
    return;
  }
  if (isIOS()) { location.href = scheme || url; return; } // b23.tv→Universal Link 直开；其余→bilibili://（iOS 一次确认）
  window.open(url, '_blank');
}
// 微信内无法直接跳 APP：弹明确指引（绝不偷偷 window.open 跳到错页面）
function wxJumpBlocked() {
  showWxTip();
  const m = document.getElementById('wxJumpModal');
  if (m) m.hidden = false;
}
if (isWeChat()) showWxTip();
// 微信指引弹窗：点遮罩 / 「知道了」关闭
(() => {
  const m = document.getElementById('wxJumpModal');
  if (!m) return;
  m.addEventListener('click', e => { if (e.target === m) m.hidden = true; });
  const ok = document.getElementById('wxJumpOk');
  if (ok) ok.addEventListener('click', () => { m.hidden = true; });
})();

// 手动记录学习：卡片 → 弹输入框；确认后累加已学单词数 + 学习次数
(() => {
  const card = document.getElementById('enLogStudy');
  if (card) {
    card.addEventListener('click', openLog);
    card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLog(); } });
  }
  // 归零按钮（阻止冒泡，避免触发记录弹窗）
  const zb = document.getElementById('enZeroBtn');
  if (zb) zb.addEventListener('click', e => { e.stopPropagation(); zeroEnCount(); });
  const m = document.getElementById('enLogModal');
  if (m) m.addEventListener('click', e => { if (e.target === m) closeLog(); });
  const cancel = document.getElementById('enLogCancel');
  if (cancel) cancel.addEventListener('click', closeLog);
  const ok = document.getElementById('enLogOk');
  if (ok) ok.addEventListener('click', submitLog);
  const inp = document.getElementById('enLogInput');
  if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') submitLog(); });
})();

// 抖音/B站口碑推荐的六级老师（按试卷板块分类，含刘晓燕；填词题/段落匹配单列）
// 烤鸭TV 用确凿的真实合集短链(b23.tv)；其余老师用 B站 App 内搜索深链——
// 点开直接在哔哩哔哩 APP 里搜到该老师的六级内容（绝不会指错视频）。
// 你若有某老师确切的「合集」分享链接(b23.tv 开头)，发我，我直接钉成合集。
const EN_BILI_RECOMMEND = {
  '听力': [
    { name: '烤鸭TV · 六级听力合集（三小时搞定听力，零基础首选）', url: 'https://search.bilibili.com/all?keyword=' + encodeURIComponent('烤鸭TV 六级听力合集') },
    { name: '温岚之四六级 · 六级听力带练', url: 'https://search.bilibili.com/all?keyword=' + encodeURIComponent('温岚之四六级 六级听力') },
  ],
  '选词填空（填词题）': [
    { name: '刘晓燕 · 六级词汇/语法速成', url: 'https://search.bilibili.com/all?keyword=' + encodeURIComponent('刘晓燕 六级 词汇 语法') },
    { name: '于妙然四六级 · 选词填空解题方法', url: 'https://search.bilibili.com/all?keyword=' + encodeURIComponent('于妙然四六级 六级 选词填空') },
  ],
  '段落匹配（长篇阅读）': [
    { name: '我是瑞斯拜 · 长篇阅读/段落匹配技巧', url: 'https://search.bilibili.com/all?keyword=' + encodeURIComponent('我是瑞斯拜 六级 长篇阅读 段落匹配') },
    { name: '于妙然四六级 · 长篇阅读匹配技巧', url: 'https://search.bilibili.com/all?keyword=' + encodeURIComponent('于妙然四六级 六级 长篇阅读 段落匹配') },
  ],
  '仔细阅读': [
    { name: '我是瑞斯拜 · 六级仔细阅读满分逻辑', url: 'https://search.bilibili.com/all?keyword=' + encodeURIComponent('我是瑞斯拜 六级 仔细阅读') },
    { name: '于妙然四六级 · 仔细阅读定位技巧', url: 'https://search.bilibili.com/all?keyword=' + encodeURIComponent('于妙然四六级 六级 仔细阅读') },
  ],
  '写作': [
    { name: '刘晓燕 · 六级写作功能句/万能模板', url: 'https://search.bilibili.com/all?keyword=' + encodeURIComponent('刘晓燕 六级 写作') },
    { name: '石雷鹏 · 六级作文功能句带写', url: 'https://search.bilibili.com/all?keyword=' + encodeURIComponent('石雷鹏 六级 写作') },
  ],
  '翻译': [
    { name: '刘晓燕 · 六级翻译逐句拆解', url: 'https://search.bilibili.com/all?keyword=' + encodeURIComponent('刘晓燕 六级 翻译') },
    { name: '邹老师四六级翻译 · 汉译英拆解', url: 'https://search.bilibili.com/all?keyword=' + encodeURIComponent('邹老师四六级翻译 六级 翻译') },
  ],
};

function renderEnBili() {
  const svgDel = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>';
  let html = Object.keys(EN_BILI_RECOMMEND).map(sec => {
    const items = EN_BILI_RECOMMEND[sec].map(v => `
      <div class="list-item">
        <div class="li-main"><div class="li-title">${escapeHtml(v.name)}</div></div>
        <span class="en-bili-go" data-url="${escapeHtml(v.url)}" role="button" tabindex="0">去看 ›</span>
      </div>`).join('');
    return `<div class="en-bili-sec"><div class="en-bili-sec-title">${sec}</div>${items}</div>`;
  }).join('');
  const list = S.enBili || [];
  if (list.length) {
    html += `<div class="en-bili-sec"><div class="en-bili-sec-title">我的添加</div>` + list.map(v => `
      <div class="list-item">
        <div class="li-main"><div class="li-title">${escapeHtml(v.name)}</div><div class="li-sub">添加于 ${v.date || ''}</div></div>
        <span class="en-bili-go" data-url="${escapeHtml(v.url)}" role="button" tabindex="0">去看 ›</span>
        <button class="icon-btn" data-bdel="${v.id}">${svgDel}</button>
      </div>`).join('') + `</div>`;
  }
  $('#enBiliList').innerHTML = html;
}

/* 六级大纲词汇查看器 */
let enWordsPage = 1;
const EN_WORDS_PER = 80;
let enWordsFilter = '';
function enWordsFiltered() {
  const all = window.CET6_WORDS || [];
  if (!enWordsFilter) return all;
  const f = enWordsFilter.toLowerCase();
  return all.filter(it => it[0].toLowerCase().includes(f));
}
function renderWordList() {
  const all = enWordsFiltered();
  const totalPages = Math.max(1, Math.ceil(all.length / EN_WORDS_PER));
  if (enWordsPage > totalPages) enWordsPage = totalPages;
  if (enWordsPage < 1) enWordsPage = 1;
  const start = (enWordsPage - 1) * EN_WORDS_PER;
  const slice = all.slice(start, start + EN_WORDS_PER);
  const learned = new Set(S.enLearnedWords || []);
  const list = document.getElementById('enWordsList');
  if (!list) return;
  if (!slice.length) {
    list.innerHTML = '<div class="en-empty" style="grid-column:1/-1">没有匹配的单词</div>';
  } else {
    list.innerHTML = slice.map(it => {
      const done = learned.has(it[0]) ? ' done' : '';
      return `<div class="en-word-item${done}" data-w="${encodeURIComponent(it[0])}"><div class="en-word-w">${escapeHtml(it[0])}</div><div class="en-word-t">${escapeHtml(it[1])}</div></div>`;
    }).join('');
  }
  const pt = document.getElementById('enWordsPage'); if (pt) pt.textContent = enWordsPage + ' / ' + totalPages;
  const tot = document.getElementById('enWTotal'); if (tot) tot.textContent = (window.CET6_WORDS || []).length;
  const tot2 = document.getElementById('enWTotal2'); if (tot2) tot2.textContent = (window.CET6_WORDS || []).length;
  const m = document.getElementById('enWMastered'); if (m) m.textContent = (S.enLearnedWords || []).length;
}
function openWordList() {
  const mask = document.getElementById('enWordsMask');
  if (!mask) return;
  mask.hidden = false;
  enWordsPage = 1;
  renderWordList();
}
function closeWordList() {
  const mask = document.getElementById('enWordsMask');
  if (mask) mask.hidden = true;
}

function renderEnglish() {
  enCountdown();
  const total = (window.CET6_WORDS && window.CET6_WORDS.length) || 0;
  const cnt = document.getElementById('enWordCount'); if (cnt) cnt.textContent = total;
  const lw = document.getElementById('enLearnedWords'); if (lw) lw.textContent = S.enLearnedCount || 0;
  const sc = document.getElementById('enStudyCount'); if (sc) sc.textContent = S.enStudyCount || 0;
  const sc2 = document.getElementById('enStudyCount2'); if (sc2) sc2.textContent = S.enStudyCount || 0;
  renderEnBili();
}

// 大纲词汇查看器（点数据卡打开 / 键盘回车）
$('#enOpenWords').addEventListener('click', openWordList);
$('#enOpenWords').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openWordList(); }
});
// 查看器操作
$('#enWordsClose').addEventListener('click', closeWordList);
$('#enWordsMask').addEventListener('click', e => { if (e.target === e.currentTarget) closeWordList(); });
$('#enWordsPrev').addEventListener('click', () => { enWordsPage--; renderWordList(); });
$('#enWordsNext').addEventListener('click', () => { enWordsPage++; renderWordList(); });
$('#enWordsSearch').addEventListener('input', e => { enWordsFilter = e.target.value.trim(); enWordsPage = 1; renderWordList(); });
$('#enWordsList').addEventListener('click', e => {
  const it = e.target.closest('[data-w]');
  if (!it) return;
  const w = decodeURIComponent(it.dataset.w);
  S.enLearnedWords = S.enLearnedWords || [];
  const i = S.enLearnedWords.indexOf(w);
  if (i >= 0) S.enLearnedWords.splice(i, 1); else S.enLearnedWords.push(w);
  Store.save();
  renderWordList();
  const lw = document.getElementById('enLearnedWords'); if (lw) lw.textContent = S.enLearnedWords.length;
});

// B站搜索
$('#enBiliSearch').addEventListener('click', openBili);

// 添加 B 站视频
$('#btnAddBili').addEventListener('click', () => {
  const name = $('#enBiliName').value.trim();
  const url = $('#enBiliUrl').value.trim();
  if (!name) return toast('请输入课程名');
  if (!url) return toast('请输入视频链接');
  if (!/^https?:\/\//.test(url)) return toast('请输入完整链接（http:// 开头）');
  S.enBili = S.enBili || [];
  S.enBili.push({ id: uid(), name, url, date: todayKey() });
  Store.save();
  $('#enBiliName').value = '';
  $('#enBiliUrl').value = '';
  renderEnglish();
  toast('已添加');
});

// 删除 / 点开 B 站视频
$('#enBiliList').addEventListener('click', e => {
  const go = e.target.closest('[data-url]');
  if (go) { goBili(go.dataset.url); return; }
  const dl = e.target.closest('[data-bdel]');
  if (!dl) return;
  S.enBili = (S.enBili || []).filter(x => x.id != dl.dataset.bdel);
  Store.save();
  renderEnglish();
  toast('已删除');
});

/* 健身 */
function renderFitness() {
  $('#fitDays').textContent = weekCount(S.fitness);
  $('#fitMinutes').textContent = S.fitness.reduce((a, v) => a + (+v.min || 0), 0);
  renderList(S.fitness, '#fitList', v => `
    <div class="list-item"><div class="li-main"><div class="li-title">${escapeHtml(v.text)}</div><div class="li-sub">⏱ ${v.min} 分钟 · ${v.date}</div></div>
      <span class="tag purple">健身</span><button class="icon-btn" data-fd="${v.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button></div>`, '还没有健身记录，开始训练吧～');
}
$('#btnAddFit').onclick = () => {
  const text = $('#fitContent').value.trim(), min = +$('#fitMin').value || 0;
  if (!text) return toast('请输入训练内容'); if (!min) return toast('请输入分钟数');
  S.fitness.push({ id: uid(), text, min, date: todayKey() });
  Store.save(); $('#fitContent').value = ''; $('#fitMin').value = ''; renderFitness(); renderNineGrid(); renderFreq(); toast('已记录');
};
$('#fitList').addEventListener('click', e => { const dl = e.target.closest('[data-fd]'); if (dl) { S.fitness = S.fitness.filter(x => x.id !== +dl.dataset.fd); Store.save(); renderFitness(); renderNineGrid(); renderFreq(); toast('已删除'); } });

/* 篮球 */
function renderBb() {
  $('#bbDays').textContent = weekCount(S.basketball);
  $('#bbHit').textContent = S.basketball.reduce((a, v) => a + (+v.hit || 0), 0);
  $('#bbMinutes').textContent = S.basketball.reduce((a, v) => a + (+v.min || 0), 0);
  renderList(S.basketball, '#bbList', v => `
    <div class="list-item"><div class="li-main"><div class="li-title">${escapeHtml(v.text)}</div><div class="li-sub">⏱ ${v.min} 分钟 · 命中 ${v.hit || 0} 球 · ${v.date}</div></div>
      <span class="tag peach">篮球</span><button class="icon-btn" data-bd="${v.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button></div>`, '还没有篮球训练记录，挥洒汗水吧～');
}
$('#btnAddBb').onclick = () => {
  const text = $('#bbContent').value.trim(), min = +$('#bbMin').value || 0;
  if (!text) return toast('请输入训练内容'); if (!min) return toast('请输入分钟数');
  S.basketball.push({ id: uid(), text, min, hit: 0, date: todayKey() });
  Store.save(); $('#bbContent').value = ''; $('#bbMin').value = ''; renderBb(); renderNineGrid(); renderFreq(); toast('已记录');
};
$('#bbList').addEventListener('click', e => { const dl = e.target.closest('[data-bd]'); if (dl) { S.basketball = S.basketball.filter(x => x.id !== +dl.dataset.bd); Store.save(); renderBb(); renderNineGrid(); renderFreq(); toast('已删除'); } });

/* WPS */
function renderWps() {
  $('#wpsDays').textContent = new Set(S.wps.map(v => v.date)).size;
  $('#wpsSkills').textContent = S.wps.length;
  renderList(S.wps, '#wpsList', v => `
    <div class="list-item"><div class="li-main"><div class="li-title">${escapeHtml(v.text)}</div><div class="li-sub">${v.date}</div></div>
      <span class="tag">WPS</span><button class="icon-btn" data-wd="${v.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button></div>`, '还没有 WPS 学习记录，开始学一个技巧吧～');
}
$('#btnAddWps').onclick = () => {
  const text = $('#wpsContent').value.trim(); if (!text) return toast('请输入内容');
  S.wps.push({ id: uid(), text, date: todayKey() });
  Store.save(); $('#wpsContent').value = ''; renderWps(); renderNineGrid(); toast('已记录');
};
$('#wpsList').addEventListener('click', e => { const dl = e.target.closest('[data-wd]'); if (dl) { S.wps = S.wps.filter(x => x.id !== +dl.dataset.wd); Store.save(); renderWps(); renderNineGrid(); toast('已删除'); } });

/* 每日复盘 */
function renderReview() {
  $('#rvDays').textContent = weekCount(S.reviews);
  $('#rvTotal').textContent = S.reviews.length;
  renderList(S.reviews, '#rvList', v => `
    <div class="list-item" style="flex-direction:column;align-items:flex-start;gap:6px;">
      <div style="display:flex;justify-content:space-between;width:100%;"><div class="li-title">📅 ${v.date}</div>
        <button class="icon-btn" data-rd="${v.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button></div>
      <div class="li-sub">📌 ${escapeHtml(v.ach || '（空）')}</div><div class="li-sub">💡 ${escapeHtml(v.learn || '（空）')}</div><div class="li-sub">🎯 ${escapeHtml(v.next || '（空）')}</div>
    </div>`, '还没有复盘记录，今天写一篇吧～');
}
$('#btnSaveReview').onclick = () => {
  const ach = $('#rvAch').value.trim(), learn = $('#rvLearn').value.trim(), next = $('#rvNext').value.trim();
  if (!ach && !learn && !next) return toast('至少写一项吧');
  const t = todayKey();
  S.reviews = S.reviews.filter(r => r.date !== t);
  S.reviews.push({ id: uid(), date: t, ach, learn, next });
  Store.save(); $('#rvAch').value = ''; $('#rvLearn').value = ''; $('#rvNext').value = '';
  renderReview(); renderNineGrid(); renderFreq(); toast('已保存今日复盘');
};
$('#btnClearReview').onclick = () => { $('#rvAch').value = ''; $('#rvLearn').value = ''; $('#rvNext').value = ''; };
$('#rvList').addEventListener('click', e => { const dl = e.target.closest('[data-rd]'); if (dl) { S.reviews = S.reviews.filter(x => x.id !== +dl.dataset.rd); Store.save(); renderReview(); renderNineGrid(); renderFreq(); toast('已删除'); } });

/* 存钱 */
function renderSavings() {
  const m = monthSave();
  const total = S.savings.reduce((a, x) => a + (+x.amount || 0), 0);
  const goal = S.goal || 10000;
  $('#saveMonth').textContent = fmt(m); $('#saveTotal').textContent = fmt(total); $('#saveGoal').textContent = fmt(goal);
  const pct = goal ? Math.min(100, total / goal * 100) : 0;
  $('#savePercent').textContent = pct.toFixed(1); $('#saveFill').style.width = pct + '%';
  renderList(S.savings, '#svList', s => `
    <div class="list-item"><div class="li-main"><div class="li-title">¥${fmt(s.amount)} · ${escapeHtml(s.name)}</div><div class="li-sub">${s.date}</div></div>
      <span class="tag green">存款</span><button class="icon-btn" data-svd="${s.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button></div>`, '还没有存款记录，存第一笔吧～');
}
$('#btnAddSv').onclick = () => {
  const name = $('#svName').value.trim() || '存款', amount = +$('#svAmount').value;
  if (!amount) return toast('请输入金额');
  S.savings.push({ id: uid(), name, amount, date: todayKey() });
  Store.save(); $('#svName').value = ''; $('#svAmount').value = ''; renderSavings(); renderNineGrid(); toast('已存入');
};
$('#svList').addEventListener('click', e => { const dl = e.target.closest('[data-svd]'); if (dl) { S.savings = S.savings.filter(x => x.id !== +dl.dataset.svd); Store.save(); renderSavings(); renderNineGrid(); toast('已删除'); } });

/* 账单（仿图重做） */
const BILL_CATS = ['餐饮', '交通', '购物', '娱乐', '生活', '通讯', '医疗', '其他'];
const BILL_CAT_EMOJI = { '餐饮': '🍱', '交通': '🚗', '购物': '🛍️', '娱乐': '🎮', '生活': '🏠', '通讯': '📱', '医疗': '💊', '其他': '✨' };

// 记账页 UI 状态（不持久化，刷新回到默认值）
const BUI = {
  date: todayKey(),      // 当前选中的记账日期
  type: 'expense',       // expense / income
  cat: '餐饮',           // 当前选中的类目
};

function billYMD(d) {
  // todayKey() 返回 'YYYY-M-D'，统一补零成 'YYYY-MM-DD'
  const [y, m, day] = d.split('-').map(Number);
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
function billPrettyMonth(d) {
  const [y, m, day] = d.split('-').map(Number);
  return `${m}月 ${y}`;
}
function billWeekDays(centerKey) {
  // 返回以今天所在周（日~六）为中心、前后各 N 周的日期键
  const [y, m, day] = centerKey.split('-').map(Number);
  const t = new Date(y, m - 1, day);
  const dow = t.getDay(); // 0=日
  const sunday = new Date(y, m - 1, day - dow);
  return [0,1,2,3,4,5,6].map(i => {
    const d2 = new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() + i);
    return `${d2.getFullYear()}-${d2.getMonth()+1}-${d2.getDate()}`;
  });
}

function renderBillWeek() {
  const wrap = $('#billWeek');
  if (!wrap) return;
  const days = billWeekDays(BUI.date);
  // 已经有 7 个 bw-dow 表头，渲染 7 个 bw-day
  const dowHead = wrap.querySelectorAll('.bw-dow').length;
  // 重建：清空再渲染
  wrap.innerHTML = '';
  ['日','一','二','三','四','五','六'].forEach(d => {
    const e = document.createElement('div'); e.className = 'bw-dow'; e.textContent = d; wrap.appendChild(e);
  });
  const tk = todayKey();
  days.forEach(k => {
    const day = +k.split('-')[2];
    const e = document.createElement('div');
    e.className = 'bw-day';
    e.textContent = day;
    if (k === tk) e.classList.add('today');
    if (k === BUI.date) e.classList.add('active');
    e.dataset.day = k;
    e.onclick = () => { BUI.date = k; renderBills(); };
    wrap.appendChild(e);
  });
}

function renderBills() {
  const m = monthKey();
  // 兼容老数据：缺字段补默认
  S.bills = (S.bills || []).map(b => ({
    category: '其他', type: 'expense', date: todayKey(), name: '', amount: 0,
    ...b
  }));

  // 1) 本月概览
  const mb = S.bills.filter(b => (b.date || '').startsWith(m));
  const inc = mb.filter(b => b.type === 'income').reduce((a, x) => a + (+x.amount || 0), 0);
  const exp = mb.filter(b => b.type === 'expense').reduce((a, x) => a + (+x.amount || 0), 0);
  $('#bIncome').textContent = fmt(inc);
  $('#bExpense').textContent = fmt(exp);
  // 预算
  const bg = +(S.billBudget || 0);
  if (bg > 0) {
    const left = bg - exp;
    const pct = Math.max(0, Math.min(100, exp / bg * 100));
    $('#bBudgetDisp').innerHTML = `<span style="font-size:16px;">¥${fmt(left)}</span><div style="font-size:10px;color:var(--text-sub);font-weight:500;margin-top:2px;">剩 / 预算 ¥${fmt(bg)}</div><div style="height:4px;background:#e7f3fc;border-radius:2px;margin-top:6px;overflow:hidden;"><div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#4f97d6,#2f6fae);"></div></div>`;
  } else {
    $('#bBudgetDisp').innerHTML = `<span style="font-size:18px;color:var(--text-sub);">未设</span>`;
  }

  // 2) 7天日期
  renderBillWeek();

  // 3) 顶部日期 & 标题副标
  const cur = billYMD(BUI.date);
  $('#billDateHead').textContent = cur;
  $('#billCurDate').textContent = cur;
  $('#billMonthText').textContent = billPrettyMonth(BUI.date);
  const todayList = S.bills.filter(b => b.date === todayKey());
  const todayExp = todayList.filter(b => b.type === 'expense').reduce((a, x) => a + (+x.amount || 0), 0);
  $('#billMonthSum').textContent = `今日 ¥${fmt(todayList.reduce((a,x)=>a+(+x.amount||0),0))} · 支 ¥${fmt(todayExp)}`;

  // 4) 支出/收入按钮高亮
  document.querySelectorAll('#page-bill .bill-type-btn').forEach(b => {
    const on = b.dataset.btype === BUI.type;
    b.classList.toggle('active', on);
    b.classList.toggle('income-active', on && b.dataset.btype === 'income');
  });

  // 5) 类目按钮高亮
  document.querySelectorAll('#page-bill .bill-cat').forEach(b => {
    b.classList.toggle('active', b.dataset.cat === BUI.cat);
  });
  // 5.1) “其他”类目才显示备注框
  const noteRow = document.getElementById('billNoteRow');
  if (noteRow) {
    const showNote = BUI.cat === '其他';
    noteRow.style.display = showNote ? '' : 'none';
    if (!showNote) { const ne = document.getElementById('billNote'); if (ne) ne.value = ''; }
  }

  // 6) 今日消费清单（按 BUI.date 当天）
  const dayList = S.bills.filter(b => b.date === BUI.date);
  const dayExp = dayList.filter(b => b.type === 'expense').reduce((a, x) => a + (+x.amount || 0), 0);
  $('#bListSum').textContent = fmt(dayExp);
  if (!dayList.length) {
    $('#bList').innerHTML = '<div class="empty-state" style="padding:24px 12px;">今天还没有消费记录，记一笔吧 🖊️</div>';
  } else {
    $('#bList').innerHTML = dayList.slice().reverse().map(b => billItemHtml(b)).join('');
  }

  // 7) 最近账目（全部，按时间倒序）
  $('#bAllCount').textContent = S.bills.length;
  if (!S.bills.length) {
    $('#bListAll').innerHTML = '<div class="empty-state" style="padding:24px 12px;">还没有账单，开始记账吧～</div>';
  } else {
    const sorted = S.bills.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 30);
    $('#bListAll').innerHTML = sorted.map(b => billItemHtml(b)).join('');
  }
}
function billItemHtml(b) {
  const isIncome = b.type === 'income';
  const sign = isIncome ? '+' : '−';
  const cat = b.category || '其他';
  const emoji = BILL_CAT_EMOJI[cat] || '✨';
  const catLabel = (b.category === '其他' && b.note) ? `${emoji} ${escapeHtml(b.note)}` : `${emoji} ${escapeHtml(cat)}`;
  return `<div class="list-item" data-bd-row="${b.id}">
    <div class="li-main">
      <div class="li-title">${sign}¥${fmt(b.amount)} · ${catLabel}</div>
      <div class="li-sub">${b.date || ''}</div>
    </div>
    <span class="tag ${isIncome ? 'green' : 'peach'}">${isIncome ? '收入' : '支出'}</span>
    <button class="icon-btn" data-bd="${b.id}" title="删除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button>
  </div>`;
}

// 记一笔（核心）
$('#btnAddBill').onclick = () => {
  const amount = +$('#bAmount').value;
  if (!amount) return toast('请输入金额');
  const b = {
    id: uid(),
    type: BUI.type,
    name: BUI.cat,                  // 项目名=类目（仿图）
    amount,
    category: BUI.cat,
    note: BUI.cat === '其他' ? ($('#billNote').value.trim() || '') : '',
    date: BUI.date,
    ts: Date.now()
  };
  S.bills.push(b);
  Store.save();
  $('#bAmount').value = '';
  const ne = document.getElementById('billNote'); if (ne) ne.value = '';
  renderBills(); renderNineGrid(); renderFreq();
  toast(BUI.type === 'income' ? '已记录收入' : '已记录支出');
};

// 录入今日收入（顶部快捷入口）
if ($('#btnAddTodayIncome')) {
  $('#btnAddTodayIncome').onclick = () => {
    const v = +$('#bTodayIncome').value;
    if (!v) return toast('请输入金额');
    S.bills.push({ id: uid(), type: 'income', name: '今日收入', amount: v, category: '其他', date: todayKey(), ts: Date.now() });
    Store.save();
    $('#bTodayIncome').value = '';
    renderBills(); renderNineGrid(); renderFreq();
    toast('已录入今日收入');
  };
}

// 支出 / 收入 切换
document.querySelectorAll('#page-bill .bill-type-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    BUI.type = btn.dataset.btype;
    renderBills();
  });
});

// 类目选择
document.querySelectorAll('#page-bill .bill-cat').forEach(btn => {
  btn.addEventListener('click', () => {
    BUI.cat = btn.dataset.cat;
    renderBills();
  });
});

// 月份切换
if ($('#billMonthPrev')) $('#billMonthPrev').onclick = () => { const d = shiftDay(BUI.date, -7); BUI.date = d; renderBills(); };
if ($('#billMonthNext')) $('#billMonthNext').onclick = () => { const d = shiftDay(BUI.date, 7); BUI.date = d; renderBills(); };
if ($('#billEditDate'))  $('#billEditDate').onclick  = () => { BUI.date = todayKey(); renderBills(); };

// 设预算（自定义弹窗，替换浏览器原生 prompt）
function openBudgetModal() {
  const modal = $('#billBudgetModal'); if (!modal) return;
  const input = $('#bsBudgetInput');
  if (input) input.value = (S.billBudget && +S.billBudget > 0) ? String(S.billBudget) : '';
  modal.classList.add('show');
  setTimeout(() => { if (input) input.focus(); }, 50);
}
function saveBudget() {
  const input = $('#bsBudgetInput');
  const raw = input ? input.value.trim() : '';
  const n = +raw;
  if (!raw || n <= 0) { S.billBudget = 0; toast('已清除预算'); }
  else { S.billBudget = n; toast('已设预算 ¥' + fmt(n)); }
  Store.save();
  $('#billBudgetModal').classList.remove('show');
  renderBills();
}
if ($('#billSetBudget')) $('#billSetBudget').onclick = openBudgetModal;
if ($('#btnBsBudgetCancel')) $('#btnBsBudgetCancel').onclick = () => $('#billBudgetModal').classList.remove('show');
if ($('#btnBsBudgetSave'))   $('#btnBsBudgetSave').onclick   = saveBudget;
if ($('#billBudgetModal')) {
  $('#billBudgetModal').addEventListener('click', e => { if (e.target === $('#billBudgetModal')) $('#billBudgetModal').classList.remove('show'); });
  const bi = $('#bsBudgetInput'); if (bi) bi.addEventListener('keydown', e => { if (e.key === 'Enter') saveBudget(); });
}

// ============= 月度统计弹窗 =============
const BS = { month: null };  // 当前查看的月份（YYYY-MM）

function shiftMonthStr(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  let nm = m + delta, ny = y;
  while (nm < 1)  { nm += 12; ny -= 1; }
  while (nm > 12) { nm -= 12; ny += 1; }
  return ny + '-' + String(nm).padStart(2, '0');
}

function aggregateMonth(ym) {
  // 1) 每日支出序列
  const [y, m] = ym.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const daily = Array.from({ length: daysInMonth }, (_, i) => ({ day: i + 1, amt: 0 }));
  // 2) 类目汇总（支出 + 收入分开）
  const catAgg = {};        // { 类目: { amount, count, type } }
  let totalIncome = 0, totalExpense = 0;
  (S.bills || []).forEach(b => {
    const d = (b.date || '');
    if (!d.startsWith(ym)) return;
    const day = +d.split('-')[2];
    if (b.type === 'expense') {
      daily[day - 1].amt += +b.amount || 0;
      totalExpense += +b.amount || 0;
    } else if (b.type === 'income') {
      totalIncome += +b.amount || 0;
    }
    const k = b.category || '其他';
    if (!catAgg[k]) catAgg[k] = { cat: k, amount: 0, count: 0, type: b.type };
    catAgg[k].amount += +b.amount || 0;
    catAgg[k].count  += 1;
  });
  const cats = Object.values(catAgg).sort((a, b) => b.amount - a.amount);
  return { ym, daily, daysInMonth, totalIncome, totalExpense, balance: totalIncome - totalExpense, cats };
}

function renderLineChartSVG(agg) {
  const W = 320, H = 160, padL = 30, padR = 10, padT = 14, padB = 22;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const maxAmt = Math.max(1, ...agg.daily.map(d => d.amt));
  // y 顶部刻度：上限取整（10 / 100 / 1000 ... 向上）
  const niceMax = (v) => {
    if (v <= 10)  return Math.ceil(v);       // 整数
    if (v <= 100) return Math.ceil(v / 10) * 10;
    if (v <= 1000) return Math.ceil(v / 100) * 100;
    return Math.ceil(v / 1000) * 1000;
  };
  const yMax = niceMax(maxAmt);
  const xS = (day) => padL + (day - 1) * (innerW / Math.max(1, agg.daysInMonth - 1));
  const yS = (amt) => padT + innerH - (amt / yMax) * innerH;

  // 路径
  const points = agg.daily.map(d => ({ x: xS(d.day), y: yS(d.amt), day: d.day, amt: d.amt }));
  const linePath = points.map((p, i) => (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ' ' + p.y.toFixed(1)).join(' ');
  // 区域路径（线下方）— 需要最后一个点和第一个点的 x 连回去
  const firstP = points[0], lastP = points[points.length - 1];
  const areaPath = linePath + ' L' + lastP.x.toFixed(1) + ' ' + (padT + innerH).toFixed(1) + ' L' + firstP.x.toFixed(1) + ' ' + (padT + innerH).toFixed(1) + ' Z';

  // x 轴标签：1、8、15、22、月末
  const xLabels = [1, 8, 15, 22];
  if (agg.daysInMonth >= 28) xLabels.push(agg.daysInMonth);
  const xLabelsHtml = xLabels.map(d => {
    if (d > agg.daysInMonth) return '';
    const x = xS(d);
    return `<text class="bs-x-label" x="${x}" y="${padT + innerH + 14}" text-anchor="middle">${d}</text>`;
  }).join('');

  // y 轴：3 条虚线 + 顶部数字
  const yLines = [0, 0.5, 1].map(t => {
    const y = padT + innerH * (1 - t);
    const v = yMax * t;
    return `<line class="bs-axis" x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}"/>
            <text class="bs-y-label" x="${padL - 4}" y="${(y + 3).toFixed(1)}" text-anchor="end">${Math.round(v)}</text>`;
  }).join('');

  // 圆点
  const dots = points.filter(p => p.amt > 0).map(p => `<circle class="bs-dot" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3"/>`).join('');

  // 最高点标记
  const maxPt = points.reduce((a, b) => (b.amt > a.amt ? b : a), { amt: 0, x: 0, y: 0, day: 0 });
  const maxTag = (maxPt.amt > 0)
    ? `<circle class="bs-dot bs-dot-max" cx="${maxPt.x.toFixed(1)}" cy="${maxPt.y.toFixed(1)}" r="4"/>
       <text class="bs-max-tag" x="${maxPt.x.toFixed(1)}" y="${(maxPt.y - 8).toFixed(1)}" text-anchor="middle">¥${Math.round(maxPt.amt)}</text>`
    : '';

  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <defs>
      <linearGradient id="bsLineGrad" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#4f97d6"/>
        <stop offset="100%" stop-color="#74b4e6"/>
      </linearGradient>
      <linearGradient id="bsAreaGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#74b4e6" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="#74b4e6" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${yLines}
    <path class="bs-area" d="${areaPath}"/>
    <path class="bs-line" d="${linePath}"/>
    ${dots}
    ${maxTag}
    ${xLabelsHtml}
  </svg>`;
}

function renderBillStats() {
  const agg = aggregateMonth(BS.month);
  // 月份标题
  const [yy, mm] = BS.month.split('-').map(Number);
  $('#bsMonthText').textContent = `${mm}月 ${yy}`;
  // 汇总
  $('#bsIncome').textContent  = '¥' + fmt(agg.totalIncome);
  $('#bsExpense').textContent = '¥' + fmt(agg.totalExpense);
  $('#bsBalance').textContent = '¥' + fmt(agg.balance);
  // 图表
  const chartEl = $('#bsChart');
  if (agg.totalExpense === 0) {
    chartEl.innerHTML = '<div class="bs-empty">这个月还没有支出数据</div>';
  } else {
    chartEl.innerHTML = renderLineChartSVG(agg);
  }
  // 类目表格
  const tableEl = $('#bsTable');
  if (!agg.cats.length) {
    tableEl.innerHTML = '<div class="bs-empty">暂无账目</div>';
  } else {
    const total = agg.totalExpense + agg.totalIncome;
    const rows = agg.cats.map(c => {
      const emoji = BILL_CAT_EMOJI[c.cat] || '✨';
      const pct = total > 0 ? (c.amount / total * 100) : 0;
      const sign = c.type === 'income' ? '+' : '−';
      return `<tr>
        <td><span class="bs-cat-emoji">${emoji}</span>${escapeHtml(c.cat)}</td>
        <td style="text-align:center;color:var(--text-sub);">${c.count} 笔</td>
        <td><span style="color:${c.type === 'income' ? '#2f8a6c' : '#c75a5a'};">${sign}</span>¥${fmt(c.amount)}<span class="bs-pct">${pct.toFixed(1)}%</span></td>
      </tr>`;
    }).join('');
    tableEl.innerHTML = `<table>
      <thead><tr><th>类目</th><th style="text-align:center;">笔数</th><th>金额</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }
}

function openBillStats() {
  // 若未设置过，默认当前月
  if (!BS.month) BS.month = monthKey();
  renderBillStats();
  $('#billStatsModal').classList.add('show');
}
if ($('#bIncomeCard'))  $('#bIncomeCard').onclick  = openBillStats;
if ($('#bExpenseCard')) $('#bExpenseCard').onclick = openBillStats;
// 键盘可达
['bIncomeCard', 'bExpenseCard'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openBillStats(); } });
});
if ($('#bsMonthPrev')) $('#bsMonthPrev').onclick = () => { BS.month = shiftMonthStr(BS.month, -1); renderBillStats(); };
if ($('#bsMonthNext')) $('#bsMonthNext').onclick = () => { BS.month = shiftMonthStr(BS.month, 1);  renderBillStats(); };
if ($('#btnBsClose'))  $('#btnBsClose').onclick  = () => $('#billStatsModal').classList.remove('show');
if ($('#billStatsModal')) $('#billStatsModal').addEventListener('click', e => { if (e.target === $('#billStatsModal')) $('#billStatsModal').classList.remove('show'); });

// 删除账目
$('#bList').addEventListener('click', e => { const dl = e.target.closest('[data-bd]'); if (dl) { S.bills = S.bills.filter(x => x.id !== +dl.dataset.bd); Store.save(); renderBills(); renderNineGrid(); renderFreq(); toast('已删除'); } });
$('#bListAll').addEventListener('click', e => { const dl = e.target.closest('[data-bd]'); if (dl) { S.bills = S.bills.filter(x => x.id !== +dl.dataset.bd); Store.save(); renderBills(); renderNineGrid(); renderFreq(); toast('已删除'); } });

// 金额输入回车
if ($('#bAmount')) $('#bAmount').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btnAddBill').click(); });
if ($('#bTodayIncome')) $('#bTodayIncome').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btnAddTodayIncome').click(); });
// 计算器按钮（不接真实计算器，仅做提示，避免破坏其他功能）
if ($('#billCalc')) $('#billCalc').onclick = () => toast('记账小工具 · 直接在金额框输入即可');

/* ============== 抖音创作 · 河南师大IP ============== */
const DY_CASES = [
  { who: '小烙学长（58万粉·大学生成长）', why: '标题用「数字+否定词」直击痛点，如《简历上的3个致命错误，90%的人都犯了》；内容用「反面教材+解决方案」对比，降低理解成本。', tip: '做「新生办校园卡3个坑」「大一别踩的5个雷」系列，套同款标题公式。' },
  { who: '为铭学长（985计算机硕士）', why: '不做完美学霸，做「陪你踩坑的过来人」，分享真实崩溃与逆袭，拉满共鸣。', tip: '拍「我大一差点挂科的真相」「学长也迷茫」真人真事，比说教更吸粉。' },
  { who: '中南学霸高宇恒（AI建模脸）', why: '「颜值+学霸+高考加油」三重标签叠加，高考季情绪共鸣破圈，一个月从校园火到全网。', tip: '录取季做「河南师大帅学长为2026新生加油」，卡高考 / 报到节点。' },
  { who: '高考季赛博茶话会（无印 / 冷酷小咕）', why: '「知识+情感」复合模式，学长学姐平等交流而非说教，给稀缺的情绪陪伴。', tip: '评论区收集新生问题，做「回答学弟学妹100问」系列，强互动引流。' },
];
const DY_FAILS = [
  '纯搬运 / 二传无个人视角：别人看原版就行，没有关注你的理由。',
  '标题党无干货：点进来发现没用，完播率低、掉粉。',
  '完美人设说教：像辅导员念稿，年轻人直接划走。',
  '更新断更：算法不持续推，粉丝慢慢流失。',
  '不回评论不互动：错过「评论区提问 → 加微信」的引流机会。',
  '一上来硬广校园卡：被当微商，信任瞬间崩塌。',
];
const DY_TOPICS = [
  { cat: '🎓 新生必看', items: [
    '河南师大2026录取分数线 / 位次（按你的省份讲）',
    '一校三区怎么分？建设路 / 平原湖 / 科技创新港区别',
    '宿舍实拍：6-8人间、空调暖气、独立卫浴',
    '新生办校园卡 / 电话卡避坑（顺带你的兼职）',
    '学费 & 奖学金 & 绿色通道全攻略',
    '报到Day1到底先干啥（流程vlog）',
  ]},
  { cat: '🏫 校园日常', items: [
    '化学专业的一天vlog（实验 / 试剂 / 数据）',
    '万人餐厅吃什么（食堂测评）',
    '图书馆 / 自习室抢座攻略',
    '社团 / 学生会值不值得加',
  ]},
  { cat: '💬 学长真心话', items: [
    '大一别踩的5个坑',
    '化学专业就业 / 考研真相（保研率7.31%）',
    '学长也迷茫：如何找自己的方向',
  ]},
  { cat: '💳 校园卡变现（软性）', items: [
    '校园卡怎么选不踩雷',
    '办卡送什么福利（你的兼职卖点）',
    '加学长微信，帮你算哪种套餐最划算',
  ]},
];
const DY_REMIX = [
  { name: '沉浸式入学vlog', how: '一镜到底逛校园 / 宿舍，轻音乐 + 字幕，制造「我也想来」的代入感。', ex: '《30秒带你看河南师大建设路校区》' },
  { name: '评论区点名回答', how: '把粉丝问题做成「学长回答你」系列，强互动、自然引流加微信。', ex: '《评论区问爆的：宿舍真的有空调吗？》' },
  { name: '宿舍好物开箱', how: '展示宿舍神器，软植入你的校园卡 / 生活用品。', ex: '《大一宿舍必入的5件神器》' },
  { name: '一分钟避坑', how: '快节奏卡点，「新生别做X」系列，完播率高。', ex: '《新生办卡，这3个坑千万别踩》' },
  { name: '学长的一天', how: '固定栏目培养追更习惯，人设更立体。', ex: '《化学学长的早八日常》' },
];
const DY_MAT_SEED = [
  { tag: '招生', title: '2026面向31省招10650人，略增', body: '新增地方专项、优师计划公费师范生；省外计划略增。录取进行中（7-8月），新生最关心校区 / 宿舍 / 办卡。' },
  { tag: '学科', title: '化学、物理为「双一流」创建学科', body: '7个学科进入ESI全球前1%（数学、物理、化学、工程学、材料科学、环境/生态学、植物与动物科学）。化学是你的专业，可重点打。' },
  { tag: '生活', title: '宿舍6-8人间·空调+暖气·独立卫浴', body: '住宿费400-900元/年；万人餐厅、民族餐厅。新生高频关注点，适合实拍。' },
  { tag: '费用', title: '学费 & 资助', body: '理工3700/年、文史3400、艺术5700、中外合作15000；国家奖学金8000、励志5000、助学金+绿色通道。' },
  { tag: '信息', title: '招生网 & 电话', body: '招生网 https://www.htu.cn/zs/ 电话0373-3326191/3326836/3326633/3326839。做「录取查询教程」视频很实用。' },
  { tag: '数据', title: '保研率7.31%·80个本科专业·34个国家一流', body: '可做「河南师大值不值得报」客观向内容，建立专业人设。' },
];

function renderDouyin() {
  $('#dyWeek').textContent = S.douyin.filter(x => inWeek(x.date)).length;
  $('#dyTotal').textContent = S.douyin.length;
  $('#dyDone').textContent = S.douyin.filter(x => x.done).length;
  renderList(S.douyin, '#dyList', v => `
    <div class="list-item">
      <div class="task-checkbox ${v.done ? 'checked' : ''}" data-dy="${v.id}"></div>
      <div class="li-main"><div class="li-title" style="${v.done?'text-decoration:line-through;color:#718096':''}">${escapeHtml(v.name)}</div><div class="li-sub">📱 ${v.plat} · ${v.date}</div></div>
      <button class="icon-btn" data-dd="${v.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button>
    </div>`, '还没有创作清单，从上方选题库加一个吧～');
}
function renderDouyinStatic() {
  const cs = document.getElementById('dyCases'); if (cs) cs.innerHTML = DY_CASES.map(c => `
    <div class="dy-case">
      <div class="dy-case-who">${escapeHtml(c.who)}</div>
      <div class="dy-case-why"><b>为什么火：</b>${escapeHtml(c.why)}</div>
      <div class="dy-case-tip"><b>你能借鉴：</b>${escapeHtml(c.tip)}</div>
    </div>`).join('');
  const fl = document.getElementById('dyFails'); if (fl) fl.innerHTML = DY_FAILS.map(f => `<li>${escapeHtml(f)}</li>`).join('');
  const tp = document.getElementById('dyTopics'); if (tp) tp.innerHTML = DY_TOPICS.map(g => `
    <div class="dy-topic-cat">${escapeHtml(g.cat)}</div>
    <div class="dy-topic-items">${g.items.map(t => `<button class="dy-topic-item" data-topic="${escapeHtml(t)}">${escapeHtml(t)}<span class="dy-plus">＋清单</span></button>`).join('')}</div>`).join('');
  const rm = document.getElementById('dyRemix'); if (rm) rm.innerHTML = DY_REMIX.map(r => `
    <div class="dy-remix">
      <div class="dy-remix-name">${escapeHtml(r.name)}</div>
      <div class="dy-remix-how">${escapeHtml(r.how)}</div>
      <div class="dy-remix-ex">示例：${escapeHtml(r.ex)}</div>
    </div>`).join('');
}
function renderDyMaterial() {
  if (S.dyMaterial === undefined) { S.dyMaterial = DY_MAT_SEED.slice(); S.dyMatUpdated = todayKey(); }
  const upd = document.getElementById('dyMatUpdated'); if (upd) upd.textContent = '更新于 ' + (S.dyMatUpdated || todayKey());
  const wrap = document.getElementById('dyMaterial'); if (!wrap) return;
  if (!S.dyMaterial.length) { wrap.innerHTML = '<div class="empty-state" style="padding:12px 0;">还没有素材，收到每日播报后贴这里～</div>'; return; }
  wrap.innerHTML = S.dyMaterial.map((m, i) => `
    <div class="dy-mat">
      <span class="dy-mat-tag">${escapeHtml(m.tag || '素材')}</span>
      <div class="dy-mat-main"><div class="dy-mat-title">${escapeHtml(m.title)}</div>${m.body ? `<div class="dy-mat-body">${escapeHtml(m.body)}</div>` : ''}</div>
      <button class="icon-btn" data-dm="${i}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button>
    </div>`).join('');
}
function renderDyStats() {
  const wrap = document.getElementById('dyStats'); if (!wrap) return;
  const arr = S.dyStats || [];
  if (!arr.length) { wrap.innerHTML = '<div class="empty-state" style="padding:12px 0;">记录第一条视频数据，看哪个选题爆～</div>'; return; }
  const tp = arr.reduce((s, v) => s + (+v.play || 0), 0), tl = arr.reduce((s, v) => s + (+v.like || 0), 0), ta = arr.reduce((s, v) => s + (+v.add || 0), 0);
  const sum = `<div class="dy-stat-sum">总播放 <b>${tp}</b> · 总点赞 <b>${tl}</b> · 总加微 <b>${ta}</b></div>`;
  const list = arr.map((v, i) => `
    <div class="dy-stat">
      <div class="dy-stat-name">${escapeHtml(v.name)}</div>
      <div class="dy-stat-nums"><span>▶ ${v.play || 0}</span><span>❤ ${v.like || 0}</span><span>➕ ${v.add || 0}</span>
      <button class="icon-btn" data-ds="${i}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button></div>
    </div>`).join('');
  wrap.innerHTML = sum + list;
}

$('#btnAddDy').onclick = () => {
  const name = $('#dyName').value.trim(), plat = $('#dyPlat').value;
  if (!name) return toast('请输入作品主题');
  S.douyin.push({ id: uid(), name, plat, done: false, date: todayKey() });
  Store.save(); $('#dyName').value = ''; renderDouyin(); renderNineGrid(); toast('已添加');
};
$('#dyList').addEventListener('click', e => {
  const tg = e.target.closest('[data-dy]'); if (tg) { const v = S.douyin.find(x => x.id === +tg.dataset.dy); if (v) { v.done = !v.done; Store.save(); renderDouyin(); } return; }
  const dl = e.target.closest('[data-dd]'); if (dl) { S.douyin = S.douyin.filter(x => x.id !== +dl.dataset.dd); Store.save(); renderDouyin(); renderNineGrid(); toast('已删除'); }
});
$('#btnCopyHook').onclick = () => {
  const t = document.getElementById('dyHook').textContent;
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(() => toast('话术已复制'), () => fallbackCopy(t));
  else fallbackCopy(t);
};
function fallbackCopy(t) { const ta = document.createElement('textarea'); ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); toast('话术已复制'); } catch (e) { toast('复制失败，请手动复制'); } document.body.removeChild(ta); }
$('#dyTopics').addEventListener('click', e => {
  const b = e.target.closest('[data-topic]'); if (!b) return;
  S.douyin.push({ id: uid(), name: b.dataset.topic, plat: '抖音', done: false, date: todayKey() });
  Store.save(); renderDouyin(); renderNineGrid(); toast('已加入创作清单');
});
$('#btnAddMat').onclick = () => {
  const title = $('#dyMatTitle').value.trim(), body = $('#dyMatBody').value.trim();
  if (!title) return toast('请输入素材标题');
  if (!S.dyMaterial) S.dyMaterial = [];
  S.dyMaterial.unshift({ tag: '自加', title, body });
  S.dyMatUpdated = todayKey(); Store.save();
  $('#dyMatTitle').value = ''; $('#dyMatBody').value = ''; renderDyMaterial(); toast('已添加素材');
};
$('#dyMaterial').addEventListener('click', e => {
  const b = e.target.closest('[data-dm]'); if (!b) return;
  S.dyMaterial.splice(+b.dataset.dm, 1); S.dyMatUpdated = todayKey(); Store.save(); renderDyMaterial();
});
$('#btnAddStat').onclick = () => {
  const name = $('#dyStatName').value.trim(); if (!name) return toast('请输入视频主题');
  const play = +$('#dyStatPlay').value || 0, like = +$('#dyStatLike').value || 0, add = +$('#dyStatAdd').value || 0;
  S.dyStats = S.dyStats || [];
  S.dyStats.unshift({ name, play, like, add, date: todayKey() }); Store.save();
  $('#dyStatName').value = ''; $('#dyStatPlay').value = ''; $('#dyStatLike').value = ''; $('#dyStatAdd').value = '';
  renderDyStats(); toast('已记录');
};
$('#dyStats').addEventListener('click', e => {
  const b = e.target.closest('[data-ds]'); if (!b) return;
  S.dyStats.splice(+b.dataset.ds, 1); Store.save(); renderDyStats();
});

/* 饮食作息 */
function renderDiet() {
  const t = todayKey();
  const m = S.diet.meals[t] || {};
  $('#dietMeals').textContent = ['b','l','d'].filter(k => m[k]).length;
  $('#dietSleep').textContent = S.diet.sleepGoal;
  $('#dietWeek').textContent = Object.keys(S.diet.meals).filter(k => k >= weekKeyStr()).length;
  $('#sleepGoal').value = S.diet.sleepGoal;
  $('#wakeTime').value = S.diet.wakeTime;
  $$('#mealRow .meal-btn').forEach(b => {
    const on = !!m[b.dataset.meal];
    b.classList.toggle('checked', on);
    const st = b.querySelector('.mb-state'); if (st) st.textContent = on ? '已打卡' : '未打卡';
  });
}
$('#mealRow').addEventListener('click', e => {
  const btn = e.target.closest('.meal-btn'); if (!btn) return;
  const t = todayKey();
  if (!S.diet.meals[t]) S.diet.meals[t] = {};
  const k = btn.dataset.meal;
  S.diet.meals[t][k] = !S.diet.meals[t][k];
  Store.save(); renderDiet();
});
$('#btnSaveDiet').onclick = () => {
  S.diet.sleepGoal = +$('#sleepGoal').value || 7.5;
  S.diet.wakeTime = $('#wakeTime').value || '07:00';
  Store.save(); renderDiet(); toast('作息目标已保存');
};

/* 旅行计划 */
function renderTravel() {
  $('#tvWant').textContent = S.travel.filter(x => !x.done).length;
  $('#tvDone').textContent = S.travel.filter(x => x.done).length;
  $('#tvTotal').textContent = S.travel.length;
  renderList(S.travel, '#tvList', v => `
    <div class="list-item">
      <div class="task-checkbox ${v.done ? 'checked' : ''}" data-tv="${v.id}"></div>
      <div class="li-main"><div class="li-title" style="${v.done?'text-decoration:line-through;color:#718096':''}">${escapeHtml(v.name)}</div><div class="li-sub">📅 ${v.date || '未定'} · ${v.done ? '已出发' : '计划中'}</div></div>
      <button class="icon-btn" data-tdv="${v.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button>
    </div>`, '还没有目的地，去添加第一个远方吧～');
}
$('#btnAddTv').onclick = () => {
  const name = $('#tvName').value.trim(), date = $('#tvDate').value.trim();
  if (!name) return toast('请输入目的地');
  S.travel.push({ id: uid(), name, date, done: false });
  Store.save(); $('#tvName').value = ''; $('#tvDate').value = ''; renderTravel(); renderNineGrid(); toast('已添加');
};
$('#tvList').addEventListener('click', e => {
  const tg = e.target.closest('[data-tv]'); if (tg) { const v = S.travel.find(x => x.id === +tg.dataset.tv); if (v) { v.done = !v.done; Store.save(); renderTravel(); } return; }
  const dl = e.target.closest('[data-tdv]'); if (dl) { S.travel = S.travel.filter(x => x.id !== +dl.dataset.tdv); Store.save(); renderTravel(); renderNineGrid(); toast('已删除'); }
});

/* ========== 乐乐宝宝（女朋友栏位） ========== */
// 农历 9-28 → 公历 预计算（2025-2054，lunar-javascript 实测） 离线可用
const LUNAR_928 = {
  2025: '2025-11-17', 2026: '2026-11-06', 2027: '2027-10-27', 2028: '2028-11-14', 2029: '2029-11-04',
  2030: '2030-10-24', 2031: '2031-11-12', 2032: '2032-10-31', 2033: '2033-11-19', 2034: '2034-11-08',
  2035: '2035-10-28', 2036: '2036-11-15', 2037: '2037-11-05', 2038: '2038-10-26', 2039: '2039-11-14',
  2040: '2040-11-02', 2041: '2041-10-22', 2042: '2042-11-10', 2043: '2043-10-31', 2044: '2044-11-18',
  2045: '2045-11-07', 2046: '2046-10-28', 2047: '2047-11-16', 2048: '2048-11-04', 2049: '2049-10-24',
  2050: '2050-11-12', 2051: '2051-11-01', 2052: '2052-10-21', 2053: '2053-11-08', 2054: '2054-10-29'
};
function lunar928Solar(year) {
  if (LUNAR_928[year]) return LUNAR_928[year];
  for (let y = year + 1; y <= year + 5; y++) if (LUNAR_928[y]) return LUNAR_928[y];
  return null;
}
function daysBetween(d1, d2) { // d1 - d2, 返回天数
  const a = new Date(d1 + 'T00:00:00').getTime();
  const b = new Date(d2 + 'T00:00:00').getTime();
  return Math.round((a - b) / 86400000);
}
function nextDateOfYear(monthDay, fromDate) { // "12-19" → 今年的MM-DD（已过则明年）
  const [m, d] = monthDay.split('-').map(Number);
  const now = new Date(fromDate + 'T00:00:00');
  const y = now.getFullYear();
  let cand = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (cand < fromDate) cand = `${y + 1}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return cand;
}
function ageOn(yearBorn, dateStr) { // 在 dateStr 那天几岁
  const d = new Date(dateStr + 'T00:00:00');
  let a = d.getFullYear() - yearBorn;
  if (d.getMonth() + 1 < new Date(yearBorn, 0).getMonth() + 1) a--;
  return a;
}
function renderLele() {
  // 1) 在一起天数
  const today = todayKey();
  const days = Math.max(0, daysBetween(today, '2025-12-19'));
  const dEl = document.getElementById('gfDays'); if (dEl) dEl.textContent = days;

  // 2) 倒计时列表（4个：恋爱纪念日 / 她的生日 / 我的生日 / 用户自定义）
  const cdWrap = document.getElementById('gfCountdowns');
  if (cdWrap) {
    const items = [
      { emoji: '💕', name: '在一起纪念日', date: nextDateOfYear('12-19', today), bornYear: 2025 },
      { emoji: '🎂', name: '她的生日（农历 9-28）', date: lunar928Solar(new Date(today).getFullYear()) || '2026-11-06', bornYear: 2006 },
      { emoji: '🎁', name: '我的生日', date: nextDateOfYear('08-03', today), bornYear: 2007 }
    ];
    (S.gfCust || []).forEach(c => items.push({ emoji: c.emoji || '⭐', name: c.name, date: c.date, custom: true, id: c.id }));
    cdWrap.innerHTML = items.map(it => {
      const d = daysBetween(it.date, today);
      const isToday = d === 0;
      const isPast = d < 0;
      const txt = isToday ? '就是今天 🎉' : (isPast ? '已经 ' + (-d) + ' 天' : '还有 ' + d + ' 天');
      const cls = isToday ? 'gf-cd gf-cd-today' : (isPast ? 'gf-cd gf-cd-past' : 'gf-cd');
      const delBtn = it.custom ? `<button class="gf-cd-del" data-cd="${it.id}">✕</button>` : '';
      const yearTxt = it.bornYear ? `第 ${new Date(it.date).getFullYear() - it.bornYear} 年` : '';
      return `<div class="${cls}">
        <div class="gf-cd-emoji">${it.emoji}</div>
        <div class="gf-cd-name">${escapeHtml(it.name)}</div>
        ${yearTxt ? `<div class="gf-cd-year">${yearTxt}</div>` : ''}
        <div class="gf-cd-date">${it.date}</div>
        <div class="gf-cd-dday">${txt}</div>
        ${delBtn}
      </div>`;
    }).join('');
  }

  // 3) 今日互动打卡
  const todayInteract = (S.gfInteract && S.gfInteract[today]) || {};
  const checks = document.querySelectorAll('.gf-check');
  let cnt = 0;
  checks.forEach(b => {
    const k = b.dataset.key;
    if (todayInteract[k]) { b.classList.add('on'); cnt++; } else { b.classList.remove('on'); }
  });
  const ic = document.getElementById('gfInteractCount'); if (ic) ic.textContent = cnt;

  // 4) 回忆录
  const mc = document.getElementById('gfMemoryCount'); if (mc) mc.textContent = (S.gfMem || []).length;
  const ml = document.getElementById('gfMemoryList');
  if (ml) {
    const arr = (S.gfMem || []).slice().sort((a, b) => a.date < b.date ? 1 : -1);
    if (!arr.length) ml.innerHTML = '<div class="empty-state" style="padding:14px 0;">还没有回忆，添加第一段属于你们的记忆吧～</div>';
    else ml.innerHTML = arr.map(m => `<div class="gf-mem">
      <div class="gf-mem-date">${m.date}</div>
      ${m.img ? `<img class="gf-mem-img" src="${m.img}" alt="" loading="lazy"/>` : ''}
      <div class="gf-mem-body">
        <div class="gf-mem-text">${escapeHtml(m.name)}</div>
        ${m.note ? `<div class="gf-mem-note">${escapeHtml(m.note)}</div>` : ''}
      </div>
      <button class="gf-mem-del" data-mem="${m.id}">✕</button>
    </div>`).join('');
  }
}

/* 互动打卡点击 */
const gfChecks = document.getElementById('gfChecks');
if (gfChecks) {
  gfChecks.addEventListener('click', e => {
    const b = e.target.closest('.gf-check'); if (!b) return;
    const k = b.dataset.key;
    const t = todayKey();
    S.gfInteract = S.gfInteract || {};
    S.gfInteract[t] = S.gfInteract[t] || {};
    S.gfInteract[t][k] = !S.gfInteract[t][k];
    Store.save();
    renderLele();
  });
}

/* 自定义纪念日添加 */
const btnAddGfCust = document.getElementById('btnAddGfCust');
if (btnAddGfCust) {
  btnAddGfCust.addEventListener('click', () => {
    const name = (document.getElementById('gfCustName').value || '').trim();
    const date = document.getElementById('gfCustDate').value;
    let emoji = (document.getElementById('gfCustEmoji').value || '').trim();
    if (!name) return toast('请填纪念日名');
    if (!date) return toast('请选日期');
    if (!emoji) emoji = '⭐';
    S.gfCust = S.gfCust || [];
    S.gfCust.push({ id: uid(), name, date, emoji });
    Store.save();
    document.getElementById('gfCustName').value = '';
    document.getElementById('gfCustDate').value = '';
    document.getElementById('gfCustEmoji').value = '';
    renderLele(); renderNineGrid();
    toast('纪念日已添加 ✨');
  });
}

/* 自定义纪念日删除 */
const gfCountdowns = document.getElementById('gfCountdowns');
if (gfCountdowns) {
  gfCountdowns.addEventListener('click', e => {
    const dl = e.target.closest('[data-cd]');
    if (!dl) return;
    S.gfCust = (S.gfCust || []).filter(x => x.id !== +dl.dataset.cd);
    Store.save(); renderLele(); renderNineGrid(); toast('已删除');
  });
}

/* 回忆录添加（含图片 + 备注） */
const gfMemImg = document.getElementById('gfMemImg');
let gfMemImgData = '';
if (gfMemImg) {
  gfMemImg.addEventListener('change', () => {
    const f = gfMemImg.files && gfMemImg.files[0];
    if (!f) { gfMemImgData = ''; return; }
    const r = new FileReader();
    r.onload = () => {
      // 压缩到 720px 宽以内，控制 base64 体积，避免本地存储爆掉
      const img = new Image();
      img.onload = () => {
        let { width: w, height: h } = img;
        const maxW = 720; if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        try { gfMemImgData = cv.toDataURL('image/jpeg', 0.72); } catch (e) { gfMemImgData = r.result; }
      };
      img.src = r.result;
    };
    r.readAsDataURL(f);
  });
}
const btnAddGfMem = document.getElementById('btnAddGfMem');
if (btnAddGfMem) {
  btnAddGfMem.addEventListener('click', () => {
    const date = document.getElementById('gfMemDate').value;
    const name = (document.getElementById('gfMemName').value || '').trim();
    const note = (document.getElementById('gfMemNote') ? document.getElementById('gfMemNote').value : '').trim();
    if (!name) return toast('请写点什么');
    if (!date) return toast('请选日期');
    S.gfMem = S.gfMem || [];
    S.gfMem.push({ id: uid(), date, name, note, img: gfMemImgData || '' });
    Store.save();
    document.getElementById('gfMemName').value = '';
    const noteEl = document.getElementById('gfMemNote'); if (noteEl) noteEl.value = '';
    if (gfMemImg) { gfMemImg.value = ''; gfMemImgData = ''; }
    renderLele();
    toast('已记录一段回忆 💕');
  });
}

/* 回忆录删除 */
const gfMemList = document.getElementById('gfMemoryList');
if (gfMemList) {
  gfMemList.addEventListener('click', e => {
    const dl = e.target.closest('[data-mem]');
    if (!dl) return;
    S.gfMem = (S.gfMem || []).filter(x => x.id !== +dl.dataset.mem);
    Store.save(); renderLele(); toast('已删除');
  });
}

/* ----------------------- 启动欢迎屏 ----------------------- */
function setupSplash() {
  const splash = $('#splash');
  if (!splash) return;
  const wk = ['日','一','二','三','四','五','六'];
  const d = new Date();
  const dateText = `${d.getMonth()+1}月${d.getDate()}日 · 周${wk[d.getDay()]}`;
  const sd = $('#splashDate'); if (sd) sd.textContent = dateText;
  if (localStorage.getItem('z_splash_seen') === '1') {
    splash.classList.add('hide');
    setTimeout(() => splash.remove(), 600);
    return;
  }
  $('#splashStart').onclick = () => {
    splash.classList.add('hide');
    localStorage.setItem('z_splash_seen', '1');
    setTimeout(() => splash.remove(), 600);
  };
}

/* ----------------------- 同步身份（多端取回数据）----------------------- */
function renderSyncBadge() {
  const badge = $('#syncBadge');
  const mode = Store.cloudMode;
  const label = mode === 'firebase' ? '云端已连接' : (mode === 'github' ? 'GitHub 同步中' : (mode === 'selfhost' ? '云端同步中' : '本地模式'));
  const dot = mode === 'local' ? ' local' : '';
  badge.innerHTML = `<span class="sync-dot${dot}"></span><span class="uid-text">${label}</span>`;
  badge.title = mode === 'github'
    ? 'GitHub 仓库同步已开启：手机与电脑访问同一网址即共用同一份数据，约 6 秒自动同步（永远在线）'
    : (mode === 'selfhost' ? '自托管云端同步已开启：手机与电脑访问同一网址即共用同一份数据，约 4 秒自动同步'
    : (mode === 'firebase' ? 'Firebase 云同步已开启' : '本地模式：数据仅存在本设备浏览器中。点此配置 GitHub 同步，或左下角「导出/导入」迁移'));
}
$('#syncBadge').onclick = () => { openGhModal(); };

/* ----------------------- 提醒 ----------------------- */
let reminderTimer = null;
function setupReminder() {
  if (reminderTimer) { clearInterval(reminderTimer); reminderTimer = null; }
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') Notification.requestPermission();
  reminderTimer = setInterval(() => {
    const now = new Date();
    const cur = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const times = (S.reminders.times || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
    if (times.includes(cur)) {
      try { new Notification('⏰ z的工作台 提醒', { body: S.reminders.text || '该看看今天的计划啦～', icon: 'avatar.jpg' }); } catch (e) {}
    }
  }, 30000);
}

/* ----------------------- 总渲染 ----------------------- */
function renderAll() {
  renderGrowth();
  renderDaily();
  renderTodoToday();
  renderFixedSchedule();
  renderTodos(); renderCourses(); renderVideos(); renderEnglish(); renderFitness(); renderBb();
  renderStudyTimer();
  renderWps(); renderReview(); renderSavings(); renderBills();
  renderDouyin(); renderDouyinStatic(); renderDyMaterial(); renderDyStats(); renderDiet(); renderTravel(); renderLele();
  renderFreq();
  renderSyncBadge();
  updateTodoPageSub();
  clearAutoFillInputs();
}

/* ----------------------- 数据导出 / 导入（兜底 + 备份） ----------------------- */
function setupDataTools() {
  const btnExport = $('#btnExport'), btnImport = $('#btnImport'), importFile = $('#importFile');
  if (btnExport) btnExport.onclick = () => {
    try {
      const payload = JSON.stringify(Store.state, null, 2);
      const blob = new Blob([payload], { type: 'application/json' });
      const a = document.createElement('a');
      const d = new Date();
      a.href = URL.createObjectURL(blob);
      a.download = 'z-workbench-data-' + d.getFullYear() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0') + '.json';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(a.href);
      toast('已导出本机数据（可作为备份）');
    } catch (e) { toast('导出失败：' + e.message); }
  };
  if (btnImport) btnImport.onclick = () => { if (importFile) importFile.click(); };
  if (importFile) importFile.onchange = () => {
    const f = importFile.files && importFile.files[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const obj = JSON.parse(reader.result);
        Store.importState(obj); // 内部会合并默认结构、规范化、写本地+推云端、刷新页面
        toast('导入成功，数据已更新');
      } catch (e) { toast('导入失败：文件格式不正确'); }
      importFile.value = '';
    };
    reader.readAsText(f);
  };
}

/* ----------------------- GitHub 同步设置弹窗 ----------------------- */
function openGhModal() {
  const modal = $('#ghModal'); if (!modal) return;
  const t = $('#ghToken'), r = $('#ghRepo'), p = $('#ghPath');
  if (t) t.value = localStorage.getItem('z_gh_token') || '';
  if (r) r.value = localStorage.getItem('z_gh_repo') || '';
  if (p) p.value = localStorage.getItem('z_gh_path') || 'z-workbench-sync.json';
  modal.classList.add('show');
}
function setupGithubUI() {
  const modal = $('#ghModal'); if (!modal) return;
  const close = () => modal.classList.remove('show');
  $('#btnGhClose').onclick = close;
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  $('#btnGhSave').onclick = () => {
    const token = $('#ghToken').value.trim(), repo = $('#ghRepo').value.trim(), path = $('#ghPath').value.trim();
    if (!token || !repo) { toast('请填写令牌和仓库'); return; }
    Store.setupGithub(token, repo, path).then(ok => {
      if (ok) { toast('GitHub 同步已开启，数据已同步'); renderSyncBadge(); close(); }
      else { toast('连接失败：请检查令牌/仓库是否正确、PAT 是否有 repo 权限'); }
    });
  };
  $('#btnGhClear').onclick = () => { Store.clearGithub(); renderSyncBadge(); toast('已清除 GitHub 同步配置'); close(); };
}

/* ----------------------- 启动 ----------------------- */
Store.onChange(() => { S = Store.state; renderAll(); });
S = defaultState();
Store.init();
S = Store.state;
// 学习计时：若上次未停止，自动续计（避免刷新丢计时）
if (S._studyStartTs) { studyTimer = setInterval(renderStudyTimer, 1000); }
renderStudyTimer();
// 按用户要求：一次性把已学习次数归零（仅执行一次，不清空已学单词数）
if (!S._enZeroed) { S.enStudyCount = 0; S._enZeroed = true; Store.save(); }
switchPage(S.currentPage || 'growth');
renderAll();
setupReminder();
setupSplash();
setupDataTools();
setupGithubUI();

// 注册 Service Worker（仅用于桌面 App 图标封装，联网优先、不锁死旧数据）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}
