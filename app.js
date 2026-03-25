/* ─────────────────────────────────────────────────────────────
   OUTREACH TRACKER — app.js
   All application logic, state management, and interactions
───────────────────────────────────────────────────────────── */

'use strict';

/* ══════════════════════════════════════════════════════════════
   DATA LAYER
══════════════════════════════════════════════════════════════ */

const STORAGE_KEY = 'outreach_tracker_data';
const APP_VERSION = '1.0';

const DEFAULT_DATA = () => ({
  meta: { version: APP_VERSION, created: new Date().toISOString(), dailyTarget: 20 },
  sessions: [],
  streak: {
    current: 0, longest: 0, lastActiveDate: null,
    protectionMode: false, freezeActive: false, freezeProgress: 0, freezeDeadline: null
  },
  rewards: { animationsTriggered: [], milestoneStreaksHit: [], milestoneVolumeHit: [] },
  settings: { dailyTarget: 20, notificationsEnabled: false, reminderTime: '20:00' }
});

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_DATA();
    const parsed = JSON.parse(raw);
    // Merge with defaults for forward compat
    const def = DEFAULT_DATA();
    return {
      meta: { ...def.meta, ...parsed.meta },
      sessions: parsed.sessions || [],
      streak: { ...def.streak, ...parsed.streak },
      rewards: { ...def.rewards, ...parsed.rewards },
      settings: { ...def.settings, ...parsed.settings }
    };
  } catch { return DEFAULT_DATA(); }
}

function saveData(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/* ══════════════════════════════════════════════════════════════
   STATE
══════════════════════════════════════════════════════════════ */

let state = loadData();
let activeSessionTimer = null;
let countdownTimer = null;
let currentPage = 'home';
let insightsPeriod = '7';
let chartInstances = {};

/* ══════════════════════════════════════════════════════════════
   DATES & TIME UTILS
══════════════════════════════════════════════════════════════ */

const today = () => new Date().toISOString().slice(0, 10);

function formatDate(isoDate) {
  if (!isoDate) return '—';
  const d = new Date(isoDate + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatTime(isoStr) {
  if (!isoStr) return '—';
  return new Date(isoStr).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(seconds) {
  if (!seconds || seconds < 0) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function elapsed(isoStart) {
  return Math.floor((Date.now() - new Date(isoStart)) / 1000);
}

function toHHMMSS(secs) {
  const h = String(Math.floor(secs / 3600)).padStart(2, '0');
  const m = String(Math.floor((secs % 3600) / 60)).padStart(2, '0');
  const s = String(secs % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function isWithinOutreachWindow() {
  const now = new Date();
  const h = now.getHours();
  return h >= 0 && h < 21; // 12AM–8:59PM
}

function secondsUntil9PM() {
  const now = new Date();
  const ninepm = new Date(now);
  ninepm.setHours(21, 0, 0, 0);
  if (ninepm <= now) return 0;
  return Math.floor((ninepm - now) / 1000);
}

/* ══════════════════════════════════════════════════════════════
   SESSION HELPERS
══════════════════════════════════════════════════════════════ */

function activeSession() {
  return state.sessions.find(s => s.status === 'running');
}

function pendingSessions() {
  return state.sessions.filter(s => s.status === 'pending' || s.status === 'auto-closed');
}

function sessionsForDate(date) {
  return state.sessions.filter(s => s.date === date && s.dataLogged);
}

function todayTotals() {
  const sessions = sessionsForDate(today());
  return sessions.reduce((acc, s) => ({
    outreaches: acc.outreaches + (s.outreaches || 0),
    demoRequests: acc.demoRequests + (s.demoRequests || 0),
    closes: acc.closes + (s.closes || 0),
    duration: acc.duration + (s.duration || 0)
  }), { outreaches: 0, demoRequests: 0, closes: 0, duration: 0 });
}

function allTimeTotals() {
  const logged = state.sessions.filter(s => s.dataLogged);
  return logged.reduce((acc, s) => ({
    outreaches: acc.outreaches + (s.outreaches || 0),
    demoRequests: acc.demoRequests + (s.demoRequests || 0),
    closes: acc.closes + (s.closes || 0),
    followUpsSent: acc.followUpsSent + (s.followUpsSent || 0),
    followUpResponses: acc.followUpResponses + (s.followUpResponses || 0),
    continuedConversations: acc.continuedConversations + (s.continuedConversations || 0),
    nos: acc.nos + (s.nos || 0),
    duration: acc.duration + (s.duration || 0)
  }), { outreaches: 0, demoRequests: 0, closes: 0, followUpsSent: 0, followUpResponses: 0, continuedConversations: 0, nos: 0, duration: 0 });
}

function sevenDayAvg() {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  const totals = days.map(d => sessionsForDate(d).reduce((a, s) => a + (s.outreaches || 0), 0));
  const sum = totals.reduce((a, b) => a + b, 0);
  return Math.round(sum / 7);
}

function bestDay() {
  const byDate = {};
  state.sessions.filter(s => s.dataLogged).forEach(s => {
    byDate[s.date] = (byDate[s.date] || 0) + (s.outreaches || 0);
  });
  let best = { date: null, count: 0 };
  Object.entries(byDate).forEach(([date, count]) => {
    if (count > best.count) best = { date, count };
  });
  return best;
}

/* ══════════════════════════════════════════════════════════════
   STREAK ENGINE
══════════════════════════════════════════════════════════════ */

function recalcStreak() {
  // Get all dates with at least 1 outreach, sorted desc
  const byDate = {};
  state.sessions.filter(s => s.dataLogged && s.outreaches > 0).forEach(s => {
    byDate[s.date] = true;
  });
  const activeDates = Object.keys(byDate).sort().reverse();
  if (!activeDates.length) {
    state.streak.current = 0;
    state.streak.protectionMode = false;
    return;
  }

  const todayStr = today();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  // Check if streak is alive
  const lastActive = activeDates[0];
  let streakCurrent = 0;

  if (lastActive === todayStr || lastActive === yesterdayStr) {
    // Count consecutive days back
    let d = new Date(lastActive + 'T12:00:00');
    while (byDate[d.toISOString().slice(0, 10)]) {
      streakCurrent++;
      d.setDate(d.getDate() - 1);
    }
    state.streak.protectionMode = (lastActive === yesterdayStr && !byDate[todayStr]);
  } else {
    // Streak broken but check freeze
    if (state.streak.freezeActive && state.streak.freezeDeadline) {
      const deadline = new Date(state.streak.freezeDeadline);
      if (new Date() <= deadline) {
        // Freeze still valid, current streak continues
        state.streak.protectionMode = false;
        return;
      }
    }
    state.streak.current = 0;
    state.streak.protectionMode = false;
    state.streak.freezeActive = false;
    streakCurrent = 0;
  }

  state.streak.current = streakCurrent;
  if (streakCurrent > state.streak.longest) state.streak.longest = streakCurrent;
  state.streak.lastActiveDate = lastActive;
  saveData(state);
}

function checkFreezeEligibility() {
  // Eligible if: missed a day, have 7-day avg, logged enough bonus outreaches
  if (!state.streak.protectionMode) return false;
  const avg = sevenDayAvg();
  const required = avg + 20;
  const todayOut = todayTotals().outreaches;
  state.streak.freezeProgress = Math.min(todayOut / required, 1);
  if (todayOut >= required && !state.streak.freezeActive) {
    state.streak.freezeActive = true;
    const deadline = new Date();
    deadline.setDate(deadline.getDate() + 7);
    state.streak.freezeDeadline = deadline.toISOString();
    state.streak.protectionMode = false;
    saveData(state);
    return true;
  }
  return false;
}

/* ══════════════════════════════════════════════════════════════
   LOG FORM FIELDS HTML
══════════════════════════════════════════════════════════════ */

const LOG_FIELDS = [
  { id: 'outreaches', label: 'Outreaches', helper: 'Total number of people you sent a cold message to this session' },
  { id: 'nos', label: "Explicit No's", helper: 'Prospects who clearly declined or said not interested' },
  { id: 'demoRequests', label: 'Demo Requests', helper: 'Prospects who asked to see a demo of your work' },
  { id: 'followUpsSent', label: 'Post-Demo Follow-Ups Sent', helper: 'Follow-up messages sent to prospects after showing a demo' },
  { id: 'followUpResponses', label: 'Post-Demo Follow-Up Responses', helper: 'Responses received from post-demo follow-ups' },
  { id: 'continuedConversations', label: 'Continued Conversations', helper: 'Prospects who replied and kept the conversation going without you prompting' },
  { id: 'closes', label: 'Closes', helper: 'Prospects who agreed to pay / become a client' },
];

function buildLogFormFields(prefix, data = {}) {
  return LOG_FIELDS.map(f => `
    <div class="form-group">
      <label for="${prefix}-${f.id}">${f.label}</label>
      <div class="form-helper">${f.helper}</div>
      <input type="number" id="${prefix}-${f.id}" class="form-input" min="0" value="${data[f.id] || 0}" inputmode="numeric" />
    </div>
  `).join('') + `
    <div class="form-group">
      <label for="${prefix}-notes">Notes <span class="opt-label">(optional)</span></label>
      <div class="form-helper">Any context worth remembering about this session</div>
      <textarea id="${prefix}-notes" class="form-input" rows="3">${data.notes || ''}</textarea>
    </div>
  `;
}

function readLogForm(prefix) {
  const obj = { notes: '' };
  LOG_FIELDS.forEach(f => {
    obj[f.id] = parseInt(document.getElementById(`${prefix}-${f.id}`)?.value) || 0;
  });
  obj.notes = document.getElementById(`${prefix}-notes`)?.value || '';
  return obj;
}

/* ══════════════════════════════════════════════════════════════
   UI RENDERING
══════════════════════════════════════════════════════════════ */

/* ── Header date ── */
function renderHeaderDate() {
  const now = new Date();
  const str = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  document.getElementById('header-date').textContent = str;
  document.getElementById('log-header-date').textContent = str;
}

/* ── Streak Hero ── */
function renderStreakHero() {
  const { current, protectionMode, freezeActive, freezeProgress } = state.streak;
  const card = document.getElementById('streak-hero-card');
  const numEl = document.getElementById('streak-number');
  const badge = document.getElementById('streak-status-badge');
  const freezeBar = document.getElementById('streak-freeze-bar');
  const freezeFill = document.getElementById('freeze-progress-fill');
  const flameIcon = document.getElementById('streak-flame-icon');

  // Animate number
  animateCount(numEl, current, 800, false);

  // States
  card.classList.remove('at-risk', 'freeze-active');
  badge.className = 'streak-status';
  badge.textContent = '';

  if (freezeActive) {
    card.classList.add('freeze-active');
    badge.classList.add('freeze-badge');
    badge.innerHTML = '<i class="fa-solid fa-shield-halved"></i> Freeze Active';
    flameIcon.className = 'fa-solid fa-shield-halved streak-flame';
    freezeBar.style.display = 'none';
  } else if (protectionMode) {
    card.classList.add('at-risk');
    badge.classList.add('at-risk-badge');
    badge.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Streak at Risk';
    flameIcon.className = 'fa-solid fa-fire streak-flame';
    freezeBar.style.display = 'flex';
    freezeFill.style.width = `${(freezeProgress || 0) * 100}%`;
  } else {
    flameIcon.className = 'fa-solid fa-fire streak-flame';
    if (current > 0) {
      badge.innerHTML = '<i class="fa-solid fa-circle-check"></i>';
      badge.style.color = 'var(--success)';
    }
    freezeBar.style.display = 'none';
  }
}

/* ── Countdown ── */
function renderCountdown() {
  const el = document.getElementById('countdown-timer');
  const secs = secondsUntil9PM();
  if (secs <= 0) {
    el.textContent = 'Outreach window closed';
    el.className = 'countdown-timer expired';
  } else {
    el.textContent = toHHMMSS(secs);
    el.className = 'countdown-timer';
  }
}

/* ── Active Session Banner ── */
function renderActiveBanner() {
  const active = activeSession();
  const banner = document.getElementById('active-session-banner');
  if (active) {
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
    clearInterval(activeSessionTimer);
    activeSessionTimer = null;
  }
}

function startActiveTimer() {
  clearInterval(activeSessionTimer);
  activeSessionTimer = setInterval(() => {
    const active = activeSession();
    if (!active) { clearInterval(activeSessionTimer); return; }
    const el = document.getElementById('active-session-elapsed');
    if (el) el.textContent = toHHMMSS(elapsed(active.startTime));
    // Auto-close at 9PM
    if (!isWithinOutreachWindow()) {
      const now = new Date();
      if (now.getHours() === 21 && now.getMinutes() === 0) {
        autoCloseSession(active.id);
      }
    }
  }, 1000);
}

/* ── Pending Warning ── */
function renderPendingWarning() {
  const pending = pendingSessions();
  const el = document.getElementById('pending-warning');
  const txt = document.getElementById('pending-warning-text');
  el.className = 'pending-warning';
  if (pending.length === 0) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  if (pending.length >= 3) {
    el.classList.add('red');
    txt.textContent = '3 sessions awaiting data — log data before starting a new session';
  } else {
    el.classList.add('amber');
    txt.textContent = `${pending.length} session${pending.length > 1 ? 's' : ''} awaiting data`;
  }
}

/* ── Today Summary ── */
function renderTodaySummary() {
  const t = todayTotals();
  const target = state.settings.dailyTarget;
  const pct = target > 0 ? Math.min((t.outreaches / target) * 100, 100) : 0;

  document.getElementById('today-outreaches').textContent = t.outreaches || '—';
  document.getElementById('today-time').textContent = t.duration > 0 ? formatDuration(t.duration) : '—';
  document.getElementById('today-demos').textContent = t.demoRequests || '—';
  document.getElementById('today-closes').textContent = t.closes || '—';
  document.getElementById('today-progress-bar').style.width = pct + '%';
  document.getElementById('today-progress-pct').textContent = Math.round(pct) + '%';
  document.getElementById('today-progress-label').textContent = `${t.outreaches} / ${target}`;
}

/* ── Quick Stats ── */
function renderQuickStats() {
  const avg = sevenDayAvg();
  const best = bestDay();
  const total = allTimeTotals();
  document.getElementById('qs-avg').textContent = avg || '—';
  document.getElementById('qs-best').textContent = best.count || '—';
  document.getElementById('qs-best-date').textContent = best.date ? formatDate(best.date) : '';
  document.getElementById('qs-total').textContent = total.outreaches || '—';
}

/* ── Start Session Button ── */
function renderStartBtn() {
  const btn = document.getElementById('start-session-btn');
  const pending = pendingSessions();
  const active = activeSession();
  const inWindow = isWithinOutreachWindow();
  const blocked = pending.length >= 3 || !!active || !inWindow;
  btn.disabled = blocked;
  if (active) btn.querySelector('span:last-child').textContent = 'Session Running';
  else if (!inWindow) btn.querySelector('span:last-child').textContent = 'Window Closed';
  else if (pending.length >= 3) btn.querySelector('span:last-child').textContent = 'Log Pending Sessions First';
  else btn.querySelector('span:last-child').textContent = 'Start Session';
}

/* ── Pending Sessions List (Log page) ── */
function renderPendingList() {
  const pending = pendingSessions();
  const list = document.getElementById('pending-sessions-list');
  const empty = document.getElementById('pending-empty');
  const badge = document.getElementById('pending-count-badge');
  badge.textContent = pending.length;

  // Remove existing cards
  list.querySelectorAll('.pending-session-card').forEach(c => c.remove());

  if (pending.length === 0) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  pending.forEach(session => {
    const div = document.createElement('div');
    div.className = 'pending-session-card';
    div.dataset.id = session.id;
    const end = session.endTime ? formatTime(session.endTime) : (session.status === 'auto-closed' ? '9:00 PM (auto)' : 'Running');
    const dur = session.endTime ? formatDuration(Math.floor((new Date(session.endTime) - new Date(session.startTime)) / 1000)) : '—';
    div.innerHTML = `
      <div class="psc-header">
        <span class="psc-date">${formatDate(session.date)}</span>
        <span class="psc-status ${session.status}">${session.status === 'auto-closed' ? 'Auto-closed' : 'Pending'}</span>
      </div>
      <div class="psc-meta">${formatTime(session.startTime)} → ${end} · ${dur}</div>
      <button class="log-data-btn" data-session-id="${session.id}">
        <i class="fa-solid fa-pen-to-square"></i> Log Data
      </button>
      <div class="log-form-container" id="lf-${session.id}" style="display:none"></div>
    `;
    list.appendChild(div);
  });
}

/* ── Session History ── */
function renderSessionHistory() {
  const logged = state.sessions
    .filter(s => s.dataLogged)
    .sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
  const list = document.getElementById('session-history-list');
  const empty = document.getElementById('history-empty');
  list.querySelectorAll('.session-history-card').forEach(c => c.remove());

  if (!logged.length) { empty.style.display = 'block'; return; }
  empty.style.display = 'none';

  logged.forEach(s => {
    const dur = s.duration ? formatDuration(s.duration) : '—';
    const card = document.createElement('div');
    card.className = 'session-history-card';
    card.dataset.id = s.id;
    card.innerHTML = `
      <div class="shc-row">
        <div>
          <div class="shc-date">${formatDate(s.date)}</div>
          <div class="shc-meta">${formatTime(s.startTime)} · ${dur}</div>
        </div>
        <div class="shc-stat">${s.outreaches || 0} out.</div>
        <span class="shc-status complete">Logged</span>
        <i class="fa-solid fa-chevron-down" style="color:var(--text-muted);font-size:12px"></i>
      </div>
      <div class="shc-expand" id="she-${s.id}">
        <div class="shc-detail-grid">
          <div class="shc-detail-cell"><div class="shc-detail-val">${s.outreaches||0}</div><div class="shc-detail-lbl">Outreaches</div></div>
          <div class="shc-detail-cell"><div class="shc-detail-val">${s.nos||0}</div><div class="shc-detail-lbl">No's</div></div>
          <div class="shc-detail-cell"><div class="shc-detail-val">${s.demoRequests||0}</div><div class="shc-detail-lbl">Demos</div></div>
          <div class="shc-detail-cell"><div class="shc-detail-val">${s.followUpsSent||0}</div><div class="shc-detail-lbl">F/U Sent</div></div>
          <div class="shc-detail-cell"><div class="shc-detail-val">${s.followUpResponses||0}</div><div class="shc-detail-lbl">F/U Resp</div></div>
          <div class="shc-detail-cell"><div class="shc-detail-val">${s.closes||0}</div><div class="shc-detail-lbl">Closes</div></div>
        </div>
        ${s.notes ? `<div class="shc-notes">${s.notes}</div>` : ''}
      </div>
    `;
    card.querySelector('.shc-row').addEventListener('click', () => {
      const exp = document.getElementById(`she-${s.id}`);
      exp.classList.toggle('open');
      const icon = card.querySelector('.fa-chevron-down');
      icon.style.transform = exp.classList.contains('open') ? 'rotate(180deg)' : '';
    });
    list.appendChild(card);
  });
}

/* ── INSIGHTS ── */
function getFilteredSessions(period) {
  const all = state.sessions.filter(s => s.dataLogged);
  if (period === 'all') return all;
  const days = parseInt(period);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  cutoff.setHours(0, 0, 0, 0);
  return all.filter(s => new Date(s.startTime) >= cutoff);
}

function renderInsights() {
  const sessions = getFilteredSessions(insightsPeriod);

  // KPI
  const totals = sessions.reduce((a, s) => ({
    outreaches: a.outreaches + (s.outreaches || 0),
    closes: a.closes + (s.closes || 0),
    demoRequests: a.demoRequests + (s.demoRequests || 0)
  }), { outreaches: 0, closes: 0, demoRequests: 0 });

  const demoRate = totals.outreaches > 0 ? ((totals.demoRequests / totals.outreaches) * 100).toFixed(1) : '0.0';
  const closeRate = totals.outreaches > 0 ? ((totals.closes / totals.outreaches) * 100).toFixed(2) : '0.00';

  animateCount(document.getElementById('kpi-outreaches'), totals.outreaches);
  animateCount(document.getElementById('kpi-closes'), totals.closes);
  animateCountText(document.getElementById('kpi-demo-rate'), parseFloat(demoRate), '%', 1);
  animateCountText(document.getElementById('kpi-close-rate'), parseFloat(closeRate), '%', 2);

  // Streak block
  animateCount(document.getElementById('ins-current-streak'), state.streak.current);
  animateCount(document.getElementById('ins-longest-streak'), state.streak.longest);

  // Active days vs total
  const allDates = [...new Set(state.sessions.filter(s => s.dataLogged).map(s => s.date))];
  const activeDates = [...new Set(state.sessions.filter(s => s.dataLogged && s.outreaches > 0).map(s => s.date))];
  document.getElementById('isb-active-days').textContent = `${activeDates.length}/${allDates.length}`;
  renderConsistencyDonut(activeDates.length, allDates.length);

  // Charts
  renderVolumeChart(sessions);
  renderOutcomesChart(sessions);
  renderFunnelChart(sessions);
  renderTimeChart(sessions);
  renderBestHoursChart(sessions);
  renderDataTable(sessions);
  renderWeeklySummary(sessions);
}

function renderConsistencyDonut(active, total) {
  const canvas = document.getElementById('consistency-donut');
  const ctx = canvas.getContext('2d');
  if (chartInstances['donut']) { chartInstances['donut'].destroy(); }
  const pct = total > 0 ? active / total : 0;
  chartInstances['donut'] = new Chart(ctx, {
    type: 'doughnut',
    data: {
      datasets: [{
        data: [pct, 1 - pct],
        backgroundColor: ['#D4AF37', 'rgba(255,255,255,0.05)'],
        borderWidth: 0
      }]
    },
    options: {
      cutout: '75%',
      responsive: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      animation: { duration: 3000 }
    }
  });
}

function getDailyData(sessions, period) {
  const days = period === 'all' ? 30 : parseInt(period);
  const map = {};
  sessions.forEach(s => { map[s.date] = map[s.date] || []; map[s.date].push(s); });
  const result = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const ss = map[key] || [];
    result.push({
      date: key, label,
      outreaches: ss.reduce((a, s) => a + (s.outreaches || 0), 0),
      nos: ss.reduce((a, s) => a + (s.nos || 0), 0),
      demoRequests: ss.reduce((a, s) => a + (s.demoRequests || 0), 0),
      closes: ss.reduce((a, s) => a + (s.closes || 0), 0),
      continuedConversations: ss.reduce((a, s) => a + (s.continuedConversations || 0), 0),
      duration: ss.reduce((a, s) => a + (s.duration || 0), 0)
    });
  }
  return result;
}

function chartDefaults() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { labels: { color: '#A09880', font: { family: 'DM Sans', size: 11 }, boxWidth: 10, padding: 12 } },
      tooltip: {
        backgroundColor: '#1C1C1C', borderColor: 'rgba(212,175,55,0.3)', borderWidth: 1,
        titleColor: '#F5F0E8', bodyColor: '#A09880',
        titleFont: { family: 'DM Sans', size: 12 }, bodyFont: { family: 'DM Sans', size: 11 }
      }
    },
    scales: {
      x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#5A5040', font: { family: 'DM Sans', size: 10 } } },
      y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#5A5040', font: { family: 'DM Sans', size: 10 } }, beginAtZero: true }
    }
  };
}

function renderVolumeChart(sessions) {
  const daily = getDailyData(sessions, insightsPeriod);
  const labels = daily.map(d => d.label);
  const values = daily.map(d => d.outreaches);
  const target = state.settings.dailyTarget;

  // 7-day rolling average
  const rolling = values.map((_, i) => {
    const slice = values.slice(Math.max(0, i - 6), i + 1);
    return Math.round(slice.reduce((a, b) => a + b, 0) / slice.length);
  });

  const canvas = document.getElementById('chart-volume');
  if (chartInstances['volume']) chartInstances['volume'].destroy();
  chartInstances['volume'] = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Outreaches',
          data: values,
          borderColor: '#D4AF37',
          backgroundColor: 'rgba(212,175,55,0.06)',
          borderWidth: 2,
          pointBackgroundColor: '#D4AF37',
          pointRadius: 3,
          tension: 0.4,
          fill: true
        },
        {
          label: '7-Day Avg',
          data: rolling,
          borderColor: 'rgba(139,105,20,0.6)',
          borderWidth: 1.5,
          borderDash: [4, 4],
          pointRadius: 0,
          tension: 0.4,
          fill: false
        },
        {
          label: 'Target',
          data: labels.map(() => target),
          borderColor: 'rgba(255,255,255,0.12)',
          borderWidth: 1,
          borderDash: [6, 3],
          pointRadius: 0,
          fill: false
        }
      ]
    },
    options: { ...chartDefaults(), animation: { duration: 5000 } }
  });
}

function renderOutcomesChart(sessions) {
  const daily = getDailyData(sessions, insightsPeriod);
  // Show weekly if > 30 days
  const isWeekly = daily.length > 30;
  let labels, data;
  if (isWeekly) {
    // Group into weeks
    const weeks = {};
    daily.forEach(d => {
      const wk = getWeekLabel(d.date);
      if (!weeks[wk]) weeks[wk] = { nos: 0, demoRequests: 0, continuedConversations: 0, closes: 0 };
      weeks[wk].nos += d.nos;
      weeks[wk].demoRequests += d.demoRequests;
      weeks[wk].continuedConversations += d.continuedConversations;
      weeks[wk].closes += d.closes;
    });
    labels = Object.keys(weeks);
    data = Object.values(weeks);
  } else {
    labels = daily.map(d => d.label);
    data = daily;
  }

  const canvas = document.getElementById('chart-outcomes');
  if (chartInstances['outcomes']) chartInstances['outcomes'].destroy();
  chartInstances['outcomes'] = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: "No's", data: data.map(d => d.nos), backgroundColor: 'rgba(192,57,43,0.5)' },
        { label: 'Demos', data: data.map(d => d.demoRequests), backgroundColor: 'rgba(212,175,55,0.6)' },
        { label: 'Conversations', data: data.map(d => d.continuedConversations), backgroundColor: 'rgba(100,160,255,0.5)' },
        { label: 'Closes', data: data.map(d => d.closes), backgroundColor: 'rgba(39,174,96,0.7)' }
      ]
    },
    options: { ...chartDefaults(), animation: { duration: 2500 } }
  });
}

function getWeekLabel(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const wk = Math.ceil(d.getDate() / 7);
  return `${d.toLocaleDateString('en-US', { month: 'short' })} W${wk}`;
}

function renderFunnelChart(sessions) {
  const totals = sessions.reduce((a, s) => ({
    outreaches: a.outreaches + (s.outreaches || 0),
    demoRequests: a.demoRequests + (s.demoRequests || 0),
    followUpsSent: a.followUpsSent + (s.followUpsSent || 0),
    followUpResponses: a.followUpResponses + (s.followUpResponses || 0),
    closes: a.closes + (s.closes || 0)
  }), { outreaches: 0, demoRequests: 0, followUpsSent: 0, followUpResponses: 0, closes: 0 });

  const canvas = document.getElementById('chart-funnel');
  if (chartInstances['funnel']) chartInstances['funnel'].destroy();
  chartInstances['funnel'] = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: ['Outreaches', 'Demo Reqs', 'Follow-Ups', 'F/U Resp', 'Closes'],
      datasets: [{
        data: [totals.outreaches, totals.demoRequests, totals.followUpsSent, totals.followUpResponses, totals.closes],
        backgroundColor: [
          'rgba(212,175,55,0.7)', 'rgba(212,175,55,0.55)', 'rgba(212,175,55,0.4)',
          'rgba(212,175,55,0.28)', 'rgba(39,174,96,0.8)'
        ],
        borderRadius: 4
      }]
    },
    options: {
      ...chartDefaults(),
      indexAxis: 'y',
      plugins: { ...chartDefaults().plugins, legend: { display: false } },
      animation: { duration: 2500 }
    }
  });
}

function renderTimeChart(sessions) {
  const daily = getDailyData(sessions, insightsPeriod);
  const canvas = document.getElementById('chart-time');
  if (chartInstances['time']) chartInstances['time'].destroy();
  chartInstances['time'] = new Chart(canvas, {
    type: 'line',
    data: {
      labels: daily.map(d => d.label),
      datasets: [{
        label: 'Hours',
        data: daily.map(d => parseFloat((d.duration / 3600).toFixed(2))),
        borderColor: '#D4AF37',
        backgroundColor: 'rgba(212,175,55,0.12)',
        borderWidth: 2,
        pointRadius: 2,
        tension: 0.4,
        fill: true
      }]
    },
    options: { ...chartDefaults(), animation: { duration: 2500 } }
  });
}

function renderBestHoursChart(sessions) {
  const el = document.getElementById('best-hours-content');
  if (sessions.length < 5) {
    el.innerHTML = '<div class="chart-placeholder">Come back after a few more sessions for hour-by-hour insights.</div>';
    return;
  }
  // Aggregate by start hour
  const byHour = {};
  sessions.forEach(s => {
    if (!s.startTime) return;
    const h = new Date(s.startTime).getHours();
    byHour[h] = byHour[h] || { demoRequests: 0, closes: 0 };
    byHour[h].demoRequests += (s.demoRequests || 0);
    byHour[h].closes += (s.closes || 0);
  });
  const hours = Object.keys(byHour).sort((a, b) => a - b);
  const labels = hours.map(h => {
    const hr = parseInt(h);
    return hr === 0 ? '12AM' : hr < 12 ? `${hr}AM` : hr === 12 ? '12PM' : `${hr - 12}PM`;
  });

  el.innerHTML = '<div class="chart-wrap chart-wrap-sm"><canvas id="chart-hours"></canvas></div>';
  const canvas = document.getElementById('chart-hours');
  if (chartInstances['hours']) chartInstances['hours'].destroy();
  chartInstances['hours'] = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Demo Reqs', data: hours.map(h => byHour[h].demoRequests), backgroundColor: 'rgba(212,175,55,0.6)' },
        { label: 'Closes', data: hours.map(h => byHour[h].closes), backgroundColor: 'rgba(39,174,96,0.7)' }
      ]
    },
    options: {
      ...chartDefaults(),
      indexAxis: 'y',
      animation: { duration: 500 }
    }
  });
}

function renderDataTable(sessions) {
  const sorted = [...sessions].sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
  const tbody = document.getElementById('data-table-body');
  const tfoot = document.getElementById('data-table-foot');
  tbody.innerHTML = '';
  tfoot.innerHTML = '';
  if (!sorted.length) {
    tbody.innerHTML = `<tr><td colspan="13" style="text-align:center;color:var(--text-muted);padding:24px">No sessions in this period</td></tr>`;
    return;
  }
  sorted.forEach(s => {
    const tr = document.createElement('tr');
    tr.dataset.id = s.id;
    tr.innerHTML = `
      <td>${s.date}</td>
      <td>${formatTime(s.startTime)}</td>
      <td>${formatTime(s.endTime)}</td>
      <td>${s.duration ? formatDuration(s.duration) : '—'}</td>
      <td>${s.outreaches || 0}</td>
      <td>${s.nos || 0}</td>
      <td>${s.demoRequests || 0}</td>
      <td>${s.followUpsSent || 0}</td>
      <td>${s.followUpResponses || 0}</td>
      <td>${s.continuedConversations || 0}</td>
      <td>${s.closes || 0}</td>
      <td style="max-width:120px;overflow:hidden;text-overflow:ellipsis">${s.notes || ''}</td>
      <td><button class="edit-row-btn" data-id="${s.id}" title="Edit"><i class="fa-solid fa-pencil"></i></button></td>
    `;
    tbody.appendChild(tr);
  });

  // Totals row
  const t = sorted.reduce((a, s) => ({
    outreaches: a.outreaches + (s.outreaches || 0),
    nos: a.nos + (s.nos || 0),
    demoRequests: a.demoRequests + (s.demoRequests || 0),
    followUpsSent: a.followUpsSent + (s.followUpsSent || 0),
    followUpResponses: a.followUpResponses + (s.followUpResponses || 0),
    continuedConversations: a.continuedConversations + (s.continuedConversations || 0),
    closes: a.closes + (s.closes || 0)
  }), { outreaches: 0, nos: 0, demoRequests: 0, followUpsSent: 0, followUpResponses: 0, continuedConversations: 0, closes: 0 });
  tfoot.innerHTML = `<tr>
    <td colspan="4">TOTALS</td>
    <td>${t.outreaches}</td><td>${t.nos}</td><td>${t.demoRequests}</td>
    <td>${t.followUpsSent}</td><td>${t.followUpResponses}</td>
    <td>${t.continuedConversations}</td><td>${t.closes}</td><td></td><td></td>
  </tr>`;
}

function renderWeeklySummary(sessions) {
  const el = document.getElementById('weekly-summary-text');
  if (!sessions.length) {
    el.textContent = 'No data in this period. Start logging sessions to see your summary.';
    return;
  }
  const days = insightsPeriod === 'all' ? 'all time' : `the last ${insightsPeriod} days`;
  const t = sessions.reduce((a, s) => ({
    outreaches: a.outreaches + (s.outreaches || 0),
    closes: a.closes + (s.closes || 0),
    demoRequests: a.demoRequests + (s.demoRequests || 0),
    duration: a.duration + (s.duration || 0)
  }), { outreaches: 0, closes: 0, demoRequests: 0, duration: 0 });
  const sessionCount = sessions.length;
  const avgDuration = sessionCount > 0 ? t.duration / sessionCount : 0;
  const demoRate = t.outreaches > 0 ? ((t.demoRequests / t.outreaches) * 100).toFixed(1) : '0.0';
  const closeRate = t.outreaches > 0 ? ((t.closes / t.outreaches) * 100).toFixed(2) : '0.00';
  el.textContent = `Over ${days}, you sent ${t.outreaches.toLocaleString()} outreaches across ${sessionCount} session${sessionCount !== 1 ? 's' : ''}. Your demo request rate was ${demoRate}% and your close rate was ${closeRate}%. Average session length: ${formatDuration(Math.round(avgDuration))}. Total closes: ${t.closes}.`;
}

/* ── Settings ── */
function renderSettings() {
  document.getElementById('daily-target-input').value = state.settings.dailyTarget;
  document.getElementById('settings-current-streak').textContent = state.streak.current;
  document.getElementById('settings-longest-streak').textContent = state.streak.longest;
  document.getElementById('notif-toggle').checked = state.settings.notificationsEnabled;
  document.getElementById('reminder-time-input').value = state.settings.reminderTime;
}

/* ══════════════════════════════════════════════════════════════
   ANIMATION UTILITIES
══════════════════════════════════════════════════════════════ */

function animateCount(el, target, duration = 600, comma = true) {
  if (!el) return;
  const start = performance.now();
  const from = 0;
  function step(now) {
    const t = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    const val = Math.round(from + (target - from) * eased);
    el.textContent = comma ? val.toLocaleString() : val;
    if (t < 1) requestAnimationFrame(step);
    else el.textContent = comma ? target.toLocaleString() : target;
  }
  requestAnimationFrame(step);
}

function animateCountText(el, target, suffix = '', decimals = 0) {
  if (!el) return;
  const start = performance.now();
  const duration = 600;
  function step(now) {
    const t = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    const val = (target * eased).toFixed(decimals);
    el.textContent = val + suffix;
    if (t < 1) requestAnimationFrame(step);
    else el.textContent = target.toFixed(decimals) + suffix;
  }
  requestAnimationFrame(step);
}

/* ══════════════════════════════════════════════════════════════
   REWARD SYSTEM
══════════════════════════════════════════════════════════════ */

const STREAK_MILESTONES = [1, 3, 7, 14, 25, 50, 75, 100, 125, 150, 200];
const VOLUME_MILESTONES = [50, 100, 200, 400, 500, 1000, 1500];

const MILESTONE_LABELS = {
  1: { label: 'First Flame 🔥', sub: 'The journey begins' },
  3: { label: 'Three Strong', sub: 'Building momentum' },
  7: { label: 'One Week Strong', sub: '7 days of discipline' },
  14: { label: 'Two Week Warrior', sub: 'Habit is forming' },
  25: { label: 'Quarter Century', sub: '25 days of consistency' },
  50: { label: 'Half Century', sub: 'Unstoppable' },
  75: { label: 'Three Quarters', sub: '75 days of dominance' },
  100: { label: 'Century Mark 👑', sub: 'Elite territory' },
  125: { label: '125 Days Reigning', sub: 'You are the standard' },
  150: { label: 'Sesquicentennial', sub: '150 days of mastery' },
  200: { label: 'The 200 Club', sub: 'Legendary status' }
};

let rewardTimeout = null;

function checkAndTriggerRewards() {
  const streak = state.streak.current;
  const totalOut = allTimeTotals().outreaches;
  const todayOut = todayTotals().outreaches;
  const triggered = state.rewards.animationsTriggered;

  // Daily streak animation (≥15 outreaches today, once per day)
  const dailyKey = `daily-${today()}`;
  if (todayOut >= 15 && !triggered.includes(dailyKey)) {
    state.rewards.animationsTriggered.push(dailyKey);
    saveData(state);
    setTimeout(() => showDailyAnimation(streak), 300);
    return;
  }

  // Milestone streak
  const mKey = `streak-${streak}`;
  const isMilestone = STREAK_MILESTONES.includes(streak) || (streak >= 200 && streak % 25 === 0);
  if (streak > 0 && isMilestone && !state.rewards.milestoneStreaksHit.includes(streak)) {
    state.rewards.milestoneStreaksHit.push(streak);
    saveData(state);
    setTimeout(() => showMilestoneAnimation(streak), 300);
    return;
  }

  // Volume milestone
  const volMilestones = [...VOLUME_MILESTONES];
  // Add every 500 after 1500
  let v = 2000;
  while (v <= totalOut + 500) { volMilestones.push(v); v += 500; }
  const nextVol = volMilestones.find(m => totalOut >= m && !state.rewards.milestoneVolumeHit.includes(m));
  if (nextVol) {
    state.rewards.milestoneVolumeHit.push(nextVol);
    saveData(state);
    setTimeout(() => showVolumeAnimation(nextVol), 300);
  }
}

function showDailyAnimation(streak) {
  showReward({
    icon: '<i class="fa-solid fa-fire" style="color:#FFD700"></i>',
    number: `Day ${streak}`,
    label: 'Streak',
    sublabel: 'Keep the fire burning',
    duration: 2500,
    type: 'daily'
  });
}

function showMilestoneAnimation(streak) {
  const info = MILESTONE_LABELS[streak] || { label: `${streak} Day Streak`, sub: 'Remarkable consistency' };
  showReward({
    icon: '<i class="fa-solid fa-crown" style="color:#FFD700"></i>',
    number: streak,
    label: info.label,
    sublabel: info.sub,
    duration: 3000,
    type: 'milestone'
  });
}

function showVolumeAnimation(vol) {
  showReward({
    icon: '<i class="fa-solid fa-paper-plane" style="color:#FFD700"></i>',
    number: vol.toLocaleString(),
    label: 'Total Outreaches',
    sublabel: 'Volume milestone unlocked',
    duration: 4000,
    type: 'volume'
  });
}

function showReward({ icon, number, label, sublabel, duration, type }) {
  const overlay = document.getElementById('reward-overlay');
  const canvas = document.getElementById('reward-canvas');
  const iconEl = document.getElementById('reward-icon');
  const numEl = document.getElementById('reward-number');
  const labelEl = document.getElementById('reward-label');
  const subEl = document.getElementById('reward-sublabel');

  iconEl.innerHTML = icon;
  numEl.textContent = number;
  labelEl.textContent = label;
  subEl.textContent = sublabel;

  overlay.classList.remove('hidden');
  startParticles(canvas, type);

  if (rewardTimeout) clearTimeout(rewardTimeout);
  rewardTimeout = setTimeout(() => dismissReward(), duration);
}

function dismissReward() {
  const overlay = document.getElementById('reward-overlay');
  overlay.classList.add('hidden');
  stopParticles();
  if (rewardTimeout) clearTimeout(rewardTimeout);
}

/* Particle canvas */
let particleRAF = null;
let particles = [];

function startParticles(canvas, type) {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  particles = [];
  const count = type === 'milestone' ? 120 : 70;
  const colors = type === 'volume'
    ? ['#FFD700', '#FFF8DC', '#FFFFFF', '#D4AF37']
    : ['#FFD700', '#D4AF37', '#FFF8DC', '#B8860B', '#FFFFFF'];

  for (let i = 0; i < count; i++) {
    particles.push({
      x: Math.random() * canvas.width,
      y: canvas.height + Math.random() * 40,
      vx: (Math.random() - 0.5) * 4,
      vy: -(Math.random() * 8 + 4),
      size: Math.random() * 6 + 2,
      color: colors[Math.floor(Math.random() * colors.length)],
      alpha: 1,
      gravity: 0.12,
      rotation: Math.random() * Math.PI * 2,
      rotSpeed: (Math.random() - 0.5) * 0.2
    });
  }
  animateParticles(canvas);
}

function animateParticles(canvas) {
  const ctx = canvas.getContext('2d');
  function frame() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach(p => {
      p.vy += p.gravity;
      p.x += p.vx;
      p.y += p.vy;
      p.rotation += p.rotSpeed;
      p.alpha -= 0.008;
      if (p.alpha <= 0) return;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = p.color;
      ctx.shadowBlur = 8;
      ctx.shadowColor = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      ctx.restore();
    });
    particles = particles.filter(p => p.alpha > 0 && p.y < canvas.height + 20);
    if (particles.length > 0) {
      particleRAF = requestAnimationFrame(frame);
    }
  }
  if (particleRAF) cancelAnimationFrame(particleRAF);
  particleRAF = requestAnimationFrame(frame);
}

function stopParticles() {
  if (particleRAF) cancelAnimationFrame(particleRAF);
  particles = [];
}

/* ══════════════════════════════════════════════════════════════
   SESSION ACTIONS
══════════════════════════════════════════════════════════════ */

function startSession() {
  if (!isWithinOutreachWindow()) return;
  if (pendingSessions().length >= 3) return;
  if (activeSession()) return;

  const session = {
    id: uuid(),
    date: today(),
    startTime: new Date().toISOString(),
    endTime: null,
    duration: null,
    status: 'running',
    isSessionless: false,
    outreaches: 0, nos: 0, demoRequests: 0, followUpsSent: 0,
    followUpResponses: 0, continuedConversations: 0, closes: 0,
    notes: '', dataLogged: false
  };
  state.sessions.push(session);
  saveData(state);
  renderAll();
  startActiveTimer();

  if (typeof gsap !== 'undefined') {
    gsap.fromTo('#active-session-banner',
      { y: -16, opacity: 0 },
      { y: 0, opacity: 1, duration: 0.35, ease: 'back.out(1.5)', clearProps: 'all' }
    );
  }
}

function stopSession(id) {
  const s = state.sessions.find(s => s.id === id);
  if (!s) return;
  const end = new Date();
  s.endTime = end.toISOString();
  s.duration = Math.floor((end - new Date(s.startTime)) / 1000);
  s.status = 'pending';
  saveData(state);
  renderAll();
}

function autoCloseSession(id) {
  const s = state.sessions.find(s => s.id === id);
  if (!s) return;
  const ninepm = new Date();
  ninepm.setHours(21, 0, 0, 0);
  s.endTime = ninepm.toISOString();
  s.duration = Math.floor((ninepm - new Date(s.startTime)) / 1000);
  s.status = 'auto-closed';
  saveData(state);
  renderAll();
}

function openLogForm(sessionId) {
  const container = document.getElementById(`lf-${sessionId}`);
  if (!container) return;
  if (container.style.display !== 'none') {
    container.style.display = 'none';
    return;
  }
  const s = state.sessions.find(s => s.id === sessionId);
  if (!s) return;
  const prefix = `lf-${sessionId}`;
  container.innerHTML = `
    <div class="log-form" id="log-form-${sessionId}">
      <div class="log-form-ref">${s.date} · ${formatTime(s.startTime)} → ${formatTime(s.endTime)} · ${s.duration ? formatDuration(s.duration) : '—'}</div>
      ${buildLogFormFields(prefix, s)}
      <button class="form-submit-btn" id="save-log-${sessionId}">
        <i class="fa-solid fa-floppy-disk"></i> Save Session Data
      </button>
    </div>
  `;
  container.style.display = 'block';
  document.getElementById(`save-log-${sessionId}`).addEventListener('click', () => saveLogData(sessionId));
  if (typeof gsap !== 'undefined') {
    gsap.fromTo(`#log-form-${sessionId}`,
      { y: 10, opacity: 0 },
      { y: 0, opacity: 1, duration: 0.25, ease: 'power2.out', clearProps: 'all' }
    );
  }
}

function saveLogData(sessionId) {
  const s = state.sessions.find(s => s.id === sessionId);
  if (!s) return;
  const data = readLogForm(`lf-${sessionId}`);
  Object.assign(s, data);
  s.status = 'complete';
  s.dataLogged = true;
  saveData(state);
  recalcStreak();
  checkAndTriggerRewards();
  renderAll();

  // Success flash
  const card = document.querySelector(`[data-id="${sessionId}"]`);
  if (card) {
    card.classList.add('success-flash');
    setTimeout(() => {
      card.classList.remove('success-flash');
    }, 600);
  }
}

function saveSessionlessLog() {
  const prefix = 'sl';
  const data = readLogForm(prefix);
  const startT = document.getElementById('sl-start-time').value;
  const endT = document.getElementById('sl-end-time').value;
  const dateStr = today();

  if (startT && endT) {
    // Create as a session for today
    const startDt = new Date(`${dateStr}T${startT}:00`);
    const endDt = new Date(`${dateStr}T${endT}:00`);
    const duration = Math.max(0, Math.floor((endDt - startDt) / 1000));
    const session = {
      id: uuid(), date: dateStr,
      startTime: startDt.toISOString(), endTime: endDt.toISOString(),
      duration, status: 'complete', isSessionless: true, dataLogged: true,
      ...data
    };
    state.sessions.push(session);
  } else {
    // Attach to most recent completed session
    const recent = state.sessions.filter(s => s.dataLogged).sort((a, b) => new Date(b.startTime) - new Date(a.startTime))[0];
    if (recent) {
      Object.keys(data).forEach(k => {
        if (k === 'notes') recent.notes = [recent.notes, data.notes].filter(Boolean).join(' | ');
        else if (k !== 'notes') recent[k] = (recent[k] || 0) + (data[k] || 0);
      });
    } else {
      // No session exists, create sessionless entry
      const session = {
        id: uuid(), date: dateStr,
        startTime: new Date().toISOString(), endTime: new Date().toISOString(),
        duration: 0, status: 'complete', isSessionless: true, dataLogged: true,
        ...data
      };
      state.sessions.push(session);
    }
  }
  saveData(state);
  recalcStreak();
  checkAndTriggerRewards();
  renderAll();
  // Reset form
  document.getElementById('sl-start-time').value = '';
  document.getElementById('sl-end-time').value = '';
  buildSessionlessForm();
  document.getElementById('sessionless-toggle').setAttribute('aria-expanded', 'false');
  document.getElementById('sessionless-body').style.display = 'none';
  document.querySelector('#sessionless-toggle .collapsible-chevron').style.transform = '';
}

function buildSessionlessForm() {
  const el = document.getElementById('sessionless-form-fields');
  if (el) el.innerHTML = buildLogFormFields('sl');
}

/* ══════════════════════════════════════════════════════════════
   INLINE TABLE EDIT
══════════════════════════════════════════════════════════════ */

function openInlineEdit(sessionId) {
  const s = state.sessions.find(s => s.id === sessionId);
  if (!s) return;
  const row = document.querySelector(`tr[data-id="${sessionId}"]`);
  if (!row) return;
  row.innerHTML = `
    <td colspan="12">
      <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:6px;padding:4px 0">
        ${LOG_FIELDS.map(f => `
          <div>
            <div style="font-size:10px;color:var(--text-muted);margin-bottom:3px">${f.label.split(' ')[0]}</div>
            <input type="number" class="form-input" id="ie-${f.id}-${sessionId}" value="${s[f.id]||0}" min="0" inputmode="numeric" />
          </div>
        `).join('')}
      </div>
      <div style="margin-top:8px">
        <input type="text" class="form-input" id="ie-notes-${sessionId}" value="${s.notes||''}" placeholder="Notes..." />
      </div>
    </td>
    <td>
      <button class="save-inline-btn" id="sie-${sessionId}"><i class="fa-solid fa-check"></i></button>
      <button class="cancel-inline-btn" id="cie-${sessionId}"><i class="fa-solid fa-xmark"></i></button>
    </td>
  `;
  document.getElementById(`sie-${sessionId}`).addEventListener('click', () => saveInlineEdit(sessionId));
  document.getElementById(`cie-${sessionId}`).addEventListener('click', () => renderInsights());
}

function saveInlineEdit(sessionId) {
  const s = state.sessions.find(s => s.id === sessionId);
  if (!s) return;
  LOG_FIELDS.forEach(f => {
    const el = document.getElementById(`ie-${f.id}-${sessionId}`);
    if (el) s[f.id] = parseInt(el.value) || 0;
  });
  const notesEl = document.getElementById(`ie-notes-${sessionId}`);
  if (notesEl) s.notes = notesEl.value;
  saveData(state);
  recalcStreak();
  renderInsights();
}

/* ══════════════════════════════════════════════════════════════
   EXPORT / IMPORT
══════════════════════════════════════════════════════════════ */

function exportData(sessions, filename) {
  const exportPayload = {
    meta: state.meta,
    sessions,
    streak: state.streak,
    rewards: state.rewards,
    settings: state.settings
  };
  const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const imported = JSON.parse(e.target.result);
      if (!imported.sessions || !Array.isArray(imported.sessions)) throw new Error('Invalid format');
      let added = 0;
      const existingIds = new Set(state.sessions.map(s => s.id));
      imported.sessions.forEach(s => {
        if (!existingIds.has(s.id)) {
          state.sessions.push(s);
          added++;
        }
      });
      saveData(state);
      recalcStreak();
      renderAll();
      showToast(`Import successful: ${added} new session${added !== 1 ? 's' : ''} added.`);
    } catch (err) {
      showToast('Import failed: invalid or corrupted JSON file.', 'error');
    }
  };
  reader.readAsText(file);
}

/* ══════════════════════════════════════════════════════════════
   MODALS
══════════════════════════════════════════════════════════════ */

function showModal(html) {
  const overlay = document.getElementById('modal-overlay');
  const box = document.getElementById('modal-box');
  box.innerHTML = html;
  overlay.classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
}

function showClearDataModal() {
  const a = Math.floor(Math.random() * 20) + 1;
  const b = Math.floor(Math.random() * 20) + 1;
  const answer = a + b;
  showModal(`
    <div class="modal-title">Clear All Data</div>
    <div class="modal-sub">This action is permanent and cannot be undone. All sessions, streak data, and rewards will be lost.</div>
    <div class="form-group">
      <label>Solve this: ${a} + ${b} = ?</label>
      <input type="number" id="clear-math" class="form-input" inputmode="numeric" placeholder="Your answer" />
    </div>
    <div class="form-group">
      <label>Type <strong>DELETE</strong> to confirm</label>
      <input type="text" id="clear-confirm" class="form-input" placeholder="DELETE" />
    </div>
    <div class="modal-btn-row">
      <button class="modal-cancel-btn" id="clear-cancel-btn">Cancel</button>
      <button class="modal-danger-btn" id="clear-execute-btn" disabled>Erase Everything</button>
    </div>
  `);
  const mathEl = document.getElementById('clear-math');
  const confirmEl = document.getElementById('clear-confirm');
  const execBtn = document.getElementById('clear-execute-btn');
  function checkInputs() {
    const mathOk = parseInt(mathEl.value) === answer;
    const textOk = confirmEl.value.trim() === 'DELETE';
    execBtn.disabled = !(mathOk && textOk);
  }
  mathEl.addEventListener('input', checkInputs);
  confirmEl.addEventListener('input', checkInputs);
  document.getElementById('clear-cancel-btn').addEventListener('click', closeModal);
  execBtn.addEventListener('click', () => {
    state = DEFAULT_DATA();
    saveData(state);
    closeModal();
    renderAll();
    showToast('All data cleared.');
  });
}

function showStreakResetModal() {
  showModal(`
    <div class="modal-title">Reset Streak</div>
    <div class="modal-sub">Are you sure you want to reset your current streak? Your session history will be preserved.</div>
    <div class="form-group">
      <label>Reason (optional)</label>
      <input type="text" id="streak-reset-reason" class="form-input" placeholder="Why are you resetting?" />
    </div>
    <div class="modal-btn-row">
      <button class="modal-cancel-btn" id="sr-cancel">Cancel</button>
      <button class="modal-danger-btn" id="sr-confirm">Reset Streak</button>
    </div>
  `);
  document.getElementById('sr-cancel').addEventListener('click', closeModal);
  document.getElementById('sr-confirm').addEventListener('click', () => {
    state.streak.current = 0;
    state.streak.protectionMode = false;
    state.streak.freezeActive = false;
    saveData(state);
    closeModal();
    renderAll();
    showToast('Streak reset.');
  });
}

/* ══════════════════════════════════════════════════════════════
   TOAST NOTIFICATIONS
══════════════════════════════════════════════════════════════ */

function showToast(message, type = 'success') {
  const existing = document.getElementById('app-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'app-toast';
  toast.style.cssText = `
    position:fixed;bottom:calc(var(--nav-h) + 16px);left:50%;transform:translateX(-50%);
    background:${type === 'error' ? 'rgba(192,57,43,0.9)' : 'rgba(39,174,96,0.9)'};
    color:#fff;padding:12px 20px;border-radius:12px;font-size:13px;font-weight:600;
    z-index:9998;max-width:90vw;text-align:center;
    box-shadow:0 4px 16px rgba(0,0,0,0.4);
    animation:fadeInDown 0.3s ease;
  `;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity 0.3s'; setTimeout(() => toast.remove(), 300); }, 3000);
}

/* ══════════════════════════════════════════════════════════════
   NAVIGATION
══════════════════════════════════════════════════════════════ */

function navigateTo(page) {
  currentPage = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`page-${page}`).classList.add('active');
  document.querySelector(`[data-page="${page}"]`).classList.add('active');

  if (page === 'insights') {
    setTimeout(() => {
      renderInsights();
      if (typeof AOS !== 'undefined') AOS.refresh();
    }, 100);
  }
  if (page === 'settings') renderSettings();
  if (page === 'log') {
    renderPendingList();
    renderSessionHistory();
    buildSessionlessForm();
  }
}

/* ══════════════════════════════════════════════════════════════
   FULL RENDER PASS
══════════════════════════════════════════════════════════════ */

function renderAll() {
  recalcStreak();
  renderHeaderDate();
  renderStreakHero();
  renderCountdown();
  renderActiveBanner();
  renderPendingWarning();
  renderTodaySummary();
  renderQuickStats();
  renderStartBtn();
  if (currentPage === 'log') {
    renderPendingList();
    renderSessionHistory();
  }
  if (currentPage === 'insights') renderInsights();
  if (currentPage === 'settings') renderSettings();
}

/* ══════════════════════════════════════════════════════════════
   NOTIFICATIONS
══════════════════════════════════════════════════════════════ */

function scheduleNotification() {
  if (!state.settings.notificationsEnabled) return;
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') {
    Notification.requestPermission().then(p => { if (p === 'granted') scheduleNotification(); });
    return;
  }
  // Use service worker if available
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    const [h, m] = state.settings.reminderTime.split(':').map(Number);
    const now = new Date();
    const target = new Date();
    target.setHours(h, m, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    const delay = target - now;
    setTimeout(() => {
      const todayOut = todayTotals().outreaches;
      if (todayOut === 0) {
        new Notification('Outreach Tracker', {
          body: 'No outreaches logged today. The window closes at 9PM!',
          icon: 'OT-Logo.png'
        });
      }
    }, delay);
  }
}

/* ══════════════════════════════════════════════════════════════
   EVENT BINDING
══════════════════════════════════════════════════════════════ */

function bindEvents() {
  // Nav
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => navigateTo(btn.dataset.page));
  });

  // Start session
  document.getElementById('start-session-btn').addEventListener('click', () => {
    startSession();
    navigateTo('log');
  });

  // Stop session
  document.getElementById('stop-session-btn').addEventListener('click', () => {
    const active = activeSession();
    if (active) stopSession(active.id);
  });

  // Log data buttons (delegated)
  document.getElementById('pending-sessions-list').addEventListener('click', e => {
    const btn = e.target.closest('.log-data-btn');
    if (btn) openLogForm(btn.dataset.sessionId);
  });

  // Sessionless toggle
  document.getElementById('sessionless-toggle').addEventListener('click', function () {
    const body = document.getElementById('sessionless-body');
    const expanded = this.getAttribute('aria-expanded') === 'true';
    this.setAttribute('aria-expanded', !expanded);
    body.style.display = expanded ? 'none' : 'block';
    this.querySelector('.collapsible-chevron').style.transform = expanded ? '' : 'rotate(180deg)';
  });

  // Sessionless submit
  document.getElementById('sessionless-submit-btn').addEventListener('click', saveSessionlessLog);

  // Period selector
  document.getElementById('period-selector').addEventListener('click', e => {
    const btn = e.target.closest('.period-btn');
    if (!btn) return;
    document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    insightsPeriod = btn.dataset.period;
    renderInsights();
  });

  // Inline table edit (delegated)
  document.getElementById('data-table-body').addEventListener('click', e => {
    const btn = e.target.closest('.edit-row-btn');
    if (btn) openInlineEdit(btn.dataset.id);
  });

  // Export all
  document.getElementById('export-all-btn').addEventListener('click', () => {
    exportData(state.sessions, 'outreach-data-all.json');
  });

  // Export range toggle
  document.getElementById('export-range-btn').addEventListener('click', () => {
    const el = document.getElementById('export-range-inputs');
    el.classList.toggle('hidden');
  });

  // Export range confirm
  document.getElementById('export-range-confirm-btn').addEventListener('click', () => {
    const from = document.getElementById('export-from').value;
    const to = document.getElementById('export-to').value;
    if (!from || !to) { showToast('Please select a date range.', 'error'); return; }
    const filtered = state.sessions.filter(s => s.date >= from && s.date <= to);
    exportData(filtered, `outreach-data-${from}-${to}.json`);
  });

  // Import
  document.getElementById('import-file').addEventListener('change', e => {
    if (e.target.files[0]) importData(e.target.files[0]);
    e.target.value = '';
  });

  // Clear all
  document.getElementById('clear-data-btn').addEventListener('click', showClearDataModal);

  // Settings - save goal
  document.getElementById('save-goal-btn').addEventListener('click', () => {
    const val = parseInt(document.getElementById('daily-target-input').value);
    if (val > 0) {
      state.settings.dailyTarget = val;
      state.meta.dailyTarget = val;
      saveData(state);
      renderAll();
      showToast('Goal saved!');
    }
  });
  document.getElementById('goal-dec').addEventListener('click', () => {
    const inp = document.getElementById('daily-target-input');
    inp.value = Math.max(1, parseInt(inp.value) - 1);
  });
  document.getElementById('goal-inc').addEventListener('click', () => {
    const inp = document.getElementById('daily-target-input');
    inp.value = Math.min(500, parseInt(inp.value) + 1);
  });

  // Settings - reset streak
  document.getElementById('reset-streak-btn').addEventListener('click', showStreakResetModal);

  // Settings - notifications
  document.getElementById('save-notif-btn').addEventListener('click', () => {
    const enabled = document.getElementById('notif-toggle').checked;
    const time = document.getElementById('reminder-time-input').value;
    state.settings.notificationsEnabled = enabled;
    state.settings.reminderTime = time;
    saveData(state);
    if (enabled) scheduleNotification();
    showToast('Notification settings saved!');
  });

  // Modal overlay click outside
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-overlay')) closeModal();
  });

  // Reward overlay dismiss
  document.getElementById('reward-overlay').addEventListener('click', dismissReward);

  // Summary copy
  document.getElementById('summary-copy-btn').addEventListener('click', () => {
    const text = document.getElementById('weekly-summary-text').textContent;
    navigator.clipboard.writeText(text).then(() => showToast('Summary copied!')).catch(() => showToast('Copy failed.', 'error'));
  });

  // History card expand (log page) — delegated
  document.getElementById('session-history-list').addEventListener('click', e => {
    const card = e.target.closest('.session-history-card');
    if (card) {
      const exp = card.querySelector('.shc-expand');
      if (exp) exp.classList.toggle('open');
    }
  });
}

/* ══════════════════════════════════════════════════════════════
   TIMERS
══════════════════════════════════════════════════════════════ */

function startCountdownLoop() {
  clearInterval(countdownTimer);
  countdownTimer = setInterval(renderCountdown, 1000);
}

/* ══════════════════════════════════════════════════════════════
   GSAP PAGE ENTRANCE
══════════════════════════════════════════════════════════════ */

function pageEntrance() {
  if (typeof gsap === 'undefined') return;

  // Pre-set starting states explicitly
  const targets = [
    '.app-header',
    '.streak-hero-card',
    '.countdown-card',
    '.today-summary-grid .summary-cell',
    '.quick-stat-card',
    '.start-session-btn'
  ];

  // Safety: ensure everything is visible even if GSAP fails
  targets.forEach(sel => {
    document.querySelectorAll(sel).forEach(el => {
      el.style.opacity = '0';
    });
  });

  const tl = gsap.timeline({
    onComplete: () => {
      // Guarantee all elements are fully visible after animation
      targets.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => {
          el.style.opacity = '';
          el.style.transform = '';
        });
      });
    }
  });

  tl.fromTo('.app-header',
    { y: -16, opacity: 0 },
    { y: 0, opacity: 1, duration: 0.45, ease: 'power2.out', clearProps: 'all' }, 0)
  .fromTo('.streak-hero-card',
    { scale: 0.94, opacity: 0 },
    { scale: 1, opacity: 1, duration: 0.55, ease: 'back.out(1.4)', clearProps: 'all' }, 0.12)
  .fromTo('.countdown-card',
    { x: -16, opacity: 0 },
    { x: 0, opacity: 1, duration: 0.35, ease: 'power2.out', clearProps: 'all' }, 0.28)
  .fromTo('.today-summary-grid .summary-cell',
    { y: 14, opacity: 0 },
    { y: 0, opacity: 1, stagger: 0.06, duration: 0.35, ease: 'power2.out', clearProps: 'all' }, 0.38)
  .fromTo('.quick-stat-card',
    { y: 10, opacity: 0 },
    { y: 0, opacity: 1, stagger: 0.07, duration: 0.3, ease: 'power2.out', clearProps: 'all' }, 0.52)
  .fromTo('.start-session-btn',
    { y: 16, opacity: 0 },
    { y: 0, opacity: 1, duration: 0.4, ease: 'back.out(1.2)', clearProps: 'all' }, 0.62);
}

/* ══════════════════════════════════════════════════════════════
   SERVICE WORKER
══════════════════════════════════════════════════════════════ */

function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

/* ══════════════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════════════ */

function init() {
  registerSW();
  if (typeof AOS !== 'undefined') {
    AOS.init({
      duration: 400,
      once: true,
      offset: 10,
      disable: false,
      startEvent: 'DOMContentLoaded',
      // Only use translate, never opacity — opacity causes invisible elements
      anchorPlacement: 'top-bottom',
    });
    // Override AOS default styles to never use opacity
    const styleEl = document.createElement('style');
    styleEl.textContent = `
      [data-aos] { opacity: 1 !important; visibility: visible !important; }
      [data-aos="fade-up"] { transform: translateY(16px); }
      [data-aos="fade-up"].aos-animate { transform: translateY(0); transition: transform 0.4s ease; }
    `;
    document.head.appendChild(styleEl);
  }
  buildSessionlessForm();
  bindEvents();
  recalcStreak();
  renderAll();
  startCountdownLoop();

  // Restore running session timer if refreshed mid-session
  if (activeSession()) {
    startActiveTimer();
    renderActiveBanner();
  }

  // Page entrance animation
  setTimeout(pageEntrance, 80);

  // Check autoclose for sessions stuck as running past 9PM
  const now = new Date();
  if (now.getHours() >= 21) {
    const running = activeSession();
    if (running) autoCloseSession(running.id);
  }
}

document.addEventListener('DOMContentLoaded', init);
