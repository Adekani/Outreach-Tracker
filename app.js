/* ─────────────────────────────────────────────────────────────
   OUTREACH TRACKER v2 — app.js
   All application logic, state management, and interactions
───────────────────────────────────────────────────────────── */

'use strict';

/* ══════════════════════════════════════════════════════════════
   DATA LAYER
══════════════════════════════════════════════════════════════ */

const STORAGE_KEY = 'outreach_tracker_data';
const APP_VERSION = '2.0';

const DEFAULT_DATA = () => ({
  meta: { version: APP_VERSION, created: new Date().toISOString(), dailyTarget: 20 },
  sessions: [],
  streak: {
    current: 0, longest: 0, lastActiveDate: null,
    freezeTokens: 0,
    freezeUsedThisWeek: false,
    frozenAt: 0,
    freezeCoveredDate: null,
    protectionMode: false, freezeActive: false, freezeProgress: 0, freezeDeadline: null
  },
  rewards: { animationsTriggered: [], milestoneStreaksHit: [], milestoneVolumeHit: [] },
  settings: { dailyTarget: 20, notificationsEnabled: false, reminderTime: '20:00' },
  backup: { lastBackupDate: null, promptShown: false }
});

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_DATA();
    const parsed = JSON.parse(raw);
    const def = DEFAULT_DATA();
    const data = {
      meta: { ...def.meta, ...parsed.meta },
      sessions: parsed.sessions || [],
      streak: { ...def.streak, ...parsed.streak },
      rewards: { ...def.rewards, ...parsed.rewards },
      settings: { ...def.settings, ...parsed.settings },
      backup: { ...def.backup, ...(parsed.backup || {}) }
    };
    // Migration: if old freezeActive was true and no tokens exist, convert 1 token
    if (parsed.streak && parsed.streak.freezeActive && !parsed.streak.freezeTokens) {
      data.streak.freezeTokens = 1;
    }
    // Clear legacy fields we no longer write
    data.streak.protectionMode = false;
    data.streak.freezeActive = false;
    data.streak.freezeProgress = 0;
    return data;
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
// Store previous chart data for animated transitions
let prevChartData = {};
// Track pending stop-log sheet session id
let stopLogSessionId = null;

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
  const h = new Date().getHours();
  return h >= 0 && h < 21;
}

function secondsUntil9PM() {
  const now = new Date();
  const ninepm = new Date(now);
  ninepm.setHours(21, 0, 0, 0);
  if (ninepm <= now) return 0;
  return Math.floor((ninepm - now) / 1000);
}

function dateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
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
    // Only sum duration for sessions that actually have a measured duration (not misc)
    duration: acc.duration + (s.isMisc ? 0 : (s.duration || 0))
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
    duration: acc.duration + (s.isMisc ? 0 : (s.duration || 0))
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
  return Math.round(totals.reduce((a, b) => a + b, 0) / 7);
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
   STREAK ENGINE v2
   Corrected trigger logic:
   - lastActive = today → normal
   - lastActive = yesterday → normal (have all day)
   - lastActive = yesterday AND past 8PM AND nothing today → at-risk warning
   - lastActive = 2+ days ago → streak broken (unless freeze covers it)
══════════════════════════════════════════════════════════════ */

function recalcStreak() {
  const byDate = {};
  state.sessions.filter(s => s.dataLogged && s.outreaches > 0).forEach(s => {
    byDate[s.date] = true;
  });
  const activeDates = Object.keys(byDate).sort().reverse();

  const todayStr = today();
  const yesterdayStr = dateOffset(-1);

  if (!activeDates.length) {
    state.streak.current = 0;
    state.streak.lastActiveDate = null;
    if (state.streak.longest === undefined) state.streak.longest = 0;
    saveData(state);
    return;
  }

  const lastActive = activeDates[0];
  let streakCurrent = 0;

  if (lastActive === todayStr || lastActive === yesterdayStr) {
    // Streak alive — count consecutive days back
    let d = new Date(lastActive + 'T12:00:00');
    while (byDate[d.toISOString().slice(0, 10)]) {
      streakCurrent++;
      d.setDate(d.getDate() - 1);
    }
    // If a freeze covered the day just before the streak chain, add it in
    const dayBeforeChain = new Date(lastActive + 'T12:00:00');
    dayBeforeChain.setDate(dayBeforeChain.getDate() - streakCurrent);
    const dayBeforeStr = dayBeforeChain.toISOString().slice(0, 10);
    if (
      (state.streak.frozenAt || 0) > 0 &&
      state.streak.freezeCoveredDate === dayBeforeStr
    ) {
      streakCurrent = state.streak.frozenAt + (streakCurrent);
      state.streak.frozenAt = 0;
      state.streak.freezeCoveredDate = null;
    }
    state.streak.current = streakCurrent;
    state.streak.lastActiveDate = lastActive;
    if (streakCurrent > (state.streak.longest || 0)) state.streak.longest = streakCurrent;
  } else {
    // Streak appears broken — check if a freeze covers exactly a 1-day gap
    const twoDaysAgo = dateOffset(-2);
    const freezeCoversGap =
      (state.streak.frozenAt || 0) > 0 &&
      state.streak.freezeCoveredDate === yesterdayStr &&
      lastActive === twoDaysAgo;

    if (freezeCoversGap) {
      // Hold the streak at frozenAt — don't reset, wait for today's log
      state.streak.current = state.streak.frozenAt;
      state.streak.lastActiveDate = lastActive;
      if (state.streak.current > (state.streak.longest || 0)) {
        state.streak.longest = state.streak.current;
      }
    } else {
      // Genuine break — reset
      state.streak.current = 0;
      state.streak.frozenAt = 0;
      state.streak.freezeCoveredDate = null;
      state.streak.freezeUsedThisWeek = false;
      state.streak.lastActiveDate = lastActive;
    }
  }

  saveData(state);
}

function isStreakAtRisk() {
  // At-risk = last active was yesterday, nothing logged today, past 8PM
  const todayStr = today();
  const yesterdayStr = dateOffset(-1);
  const lastActive = state.streak.lastActiveDate;
  const hour = new Date().getHours();
  const todayOut = todayTotals().outreaches;

  if (lastActive === yesterdayStr && todayOut === 0 && hour >= 20) return true;
  return false;
}

function isStreakBroken() {
  const todayStr = today();
  const yesterdayStr = dateOffset(-1);
  const lastActive = state.streak.lastActiveDate;
  if (!lastActive) return false;
  return lastActive !== todayStr && lastActive !== yesterdayStr;
}

function useFreezeToken() {
  if (state.streak.freezeTokens <= 0) {
    showToast('No freeze tokens available.', 'error');
    return;
  }
  const canUse = isStreakAtRisk() || isStreakBroken();
  if (!canUse) {
    showToast('Freeze can only be used when streak is at risk.', 'error');
    return;
  }

  // If a freeze is already active, don't burn another token or overwrite it
  if ((state.streak.frozenAt || 0) > 0 && state.streak.freezeCoveredDate) {
    showToast('❄️ Streak is already frozen! Log outreaches today to continue.', 'success');
    return;
  }

  state.streak.freezeTokens = Math.max(0, state.streak.freezeTokens - 1);
  state.streak.freezeUsedThisWeek = true;
  state.streak.frozenAt = state.streak.current;
  state.streak.freezeCoveredDate = isStreakAtRisk() ? today() : dateOffset(-1);

  saveData(state);
  renderAll();
  showToast('❄️ Streak frozen at ' + state.streak.frozenAt + ' days! Log outreaches tomorrow to continue.', 'success');
}

function checkPerfectWeek() {
  const streak = state.streak.current;
  // Perfect week fires exactly when streak hits a new multiple of 7 with no freeze used that cycle
  if (streak > 0 && streak % 7 === 0 && !state.streak.freezeUsedThisWeek) {
    const weekKey = `perfectweek-${streak}`;
    if (!state.rewards.animationsTriggered.includes(weekKey)) {
      state.rewards.animationsTriggered.push(weekKey);
      state.streak.freezeTokens = (state.streak.freezeTokens || 0) + 1;
      // Reset the weekly freeze flag for the NEXT 7-day cycle
      state.streak.freezeUsedThisWeek = false;
      saveData(state);
      setTimeout(() => showPerfectWeekAnimation(streak), 400);
      return true;
    }
  }
  // When streak crosses a new multiple-of-7 threshold (new week starts), reset the flag
  if (streak % 7 === 1 && streak > 1) {
    // Just started a new week cycle
    state.streak.freezeUsedThisWeek = false;
  }
  return false;
}

/* ══════════════════════════════════════════════════════════════
   LOG FORM FIELDS HTML
══════════════════════════════════════════════════════════════ */

const LOG_FIELDS = [
  { id: 'outreaches', label: 'Outreaches', helper: 'Total cold messages sent this session' },
  { id: 'nos', label: "Explicit No's", helper: 'Prospects who clearly declined' },
  { id: 'demoRequests', label: 'Demo Requests', helper: 'Prospects who asked to see a demo' },
  { id: 'followUpsSent', label: 'Follow-Ups Sent', helper: 'Post-demo follow-up messages sent' },
  { id: 'followUpResponses', label: 'Follow-Up Responses', helper: 'Responses from post-demo follow-ups' },
  { id: 'continuedConversations', label: 'Continued Conversations', helper: 'Prospects who kept the conversation going' },
  { id: 'closes', label: 'Closes', helper: 'Prospects who agreed to become a client' },
];

// Quick add only shows these minimal fields
const QUICK_FIELDS = [
  { id: 'outreaches', label: 'Outreaches' },
  { id: 'nos', label: "No's" },
  { id: 'demoRequests', label: 'Demos' },
  { id: 'closes', label: 'Closes' },
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
      <textarea id="${prefix}-notes" class="form-input" rows="3">${data.notes || ''}</textarea>
    </div>
  `;
}

function buildQuickFormFields(prefix, data = {}) {
  return `<div class="quick-fields-grid">` +
    QUICK_FIELDS.map(f => `
      <div class="quick-field-cell">
        <label class="quick-field-label" for="${prefix}-${f.id}">${f.label}</label>
        <input type="number" id="${prefix}-${f.id}" class="form-input num-center" min="0" value="${data[f.id] || 0}" inputmode="numeric" />
      </div>
    `).join('') +
    `</div>
    <div class="form-group" style="margin-top:14px">
      <input type="text" id="${prefix}-notes" class="form-input" placeholder="Notes (optional)" value="${data.notes || ''}" />
    </div>`;
}

function readLogForm(prefix) {
  const obj = { notes: '' };
  LOG_FIELDS.forEach(f => {
    obj[f.id] = parseInt(document.getElementById(`${prefix}-${f.id}`)?.value) || 0;
  });
  obj.notes = document.getElementById(`${prefix}-notes`)?.value || '';
  return obj;
}

function readQuickForm(prefix) {
  const obj = { notes: '' };
  QUICK_FIELDS.forEach(f => {
    obj[f.id] = parseInt(document.getElementById(`${prefix}-${f.id}`)?.value) || 0;
  });
  obj.notes = document.getElementById(`${prefix}-notes`)?.value || '';
  return obj;
}

/* ══════════════════════════════════════════════════════════════
   UI RENDERING
══════════════════════════════════════════════════════════════ */

function renderHeaderDate() {
  const now = new Date();
  const str = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  document.getElementById('header-date').textContent = str;
  document.getElementById('log-header-date').textContent = str;
}

/* ── Streak Hero v2 ── */
function renderStreakHero() {
  const { current, freezeTokens } = state.streak;
  const card = document.getElementById('streak-hero-card');
  const numEl = document.getElementById('streak-number');
  const badge = document.getElementById('streak-status-badge');
  const flameIcon = document.getElementById('streak-flame-icon');
  const tokenDisplay = document.getElementById('freeze-token-display');
  const tokenCount = document.getElementById('freeze-token-count');
  const useFreezeRow = document.getElementById('streak-use-freeze-row');

  animateCount(numEl, current, 900, false);

  card.classList.remove('at-risk', 'freeze-active');
  badge.className = 'streak-status';
  badge.textContent = '';

  const atRisk = isStreakAtRisk();
  const broken = isStreakBroken();

  if (atRisk || broken) {
    card.classList.add('at-risk');
    badge.classList.add('at-risk-badge');
    badge.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Streak at Risk';
    flameIcon.className = 'fa-solid fa-fire streak-flame';
    // Show use-freeze button if they have tokens
    if ((freezeTokens || 0) > 0) {
      useFreezeRow.style.display = 'flex';
    } else {
      useFreezeRow.style.display = 'none';
    }
  } else {
    flameIcon.className = 'fa-solid fa-fire streak-flame';
    if (current > 0) {
      badge.innerHTML = '<i class="fa-solid fa-circle-check"></i>';
      badge.style.color = 'var(--success)';
    }
    useFreezeRow.style.display = 'none';
  }

  // Freeze token display
  if ((freezeTokens || 0) > 0) {
    tokenDisplay.style.display = 'flex';
    tokenCount.textContent = freezeTokens;
  } else {
    tokenDisplay.style.display = 'none';
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
    if (!isWithinOutreachWindow()) {
      const now = new Date();
      if (now.getHours() === 21 && now.getMinutes() === 0) {
        autoCloseSession(active.id);
      }
    }
  }, 1000);
}

/* ── Pending Warning (soft) ── */
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
  el.classList.add('amber');
  txt.textContent = `${pending.length} session${pending.length > 1 ? 's' : ''} awaiting data`;
}

/* ── Nav badge for pending sessions ── */
function renderNavBadge() {
  const pending = pendingSessions();
  const badge = document.getElementById('nav-log-badge');
  if (pending.length > 0) {
    badge.textContent = pending.length;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

/* ── Today Summary ── */
function renderTodaySummary() {
  const t = todayTotals();
  const target = state.settings.dailyTarget;
  const pct = target > 0 ? Math.min((t.outreaches / target) * 100, 100) : 0;

  const outEl = document.getElementById('today-outreaches');
  const timeEl = document.getElementById('today-time');
  const demoEl = document.getElementById('today-demos');
  const closeEl = document.getElementById('today-closes');

  if (t.outreaches > 0) animateCount(outEl, t.outreaches, 700, false);
  else outEl.textContent = '—';
  timeEl.textContent = t.duration > 0 ? formatDuration(t.duration) : '—';
  if (t.demoRequests > 0) animateCount(demoEl, t.demoRequests, 700, false);
  else demoEl.textContent = '—';
  if (t.closes > 0) animateCount(closeEl, t.closes, 700, false);
  else closeEl.textContent = '—';

  document.getElementById('today-progress-bar').style.width = pct + '%';
  document.getElementById('today-progress-pct').textContent = Math.round(pct) + '%';
  document.getElementById('today-progress-label').textContent = `${t.outreaches} / ${target}`;
}

/* ── Quick Stats ── */
function renderQuickStats() {
  const avg = sevenDayAvg();
  const best = bestDay();
  const total = allTimeTotals();
  const avgEl = document.getElementById('qs-avg');
  const bestEl = document.getElementById('qs-best');
  const totalEl = document.getElementById('qs-total');

  if (avg > 0) animateCount(avgEl, avg, 800, false);
  else avgEl.textContent = '—';
  if (best.count > 0) animateCount(bestEl, best.count, 800, false);
  else bestEl.textContent = '—';
  document.getElementById('qs-best-date').textContent = best.date ? formatDate(best.date) : '';
  if (total.outreaches > 0) animateCount(totalEl, total.outreaches, 1000, true);
  else totalEl.textContent = '—';
}

/* ── Start Session Button ── */
function renderStartBtn() {
  const btn = document.getElementById('start-session-btn');
  const active = activeSession();
  const inWindow = isWithinOutreachWindow();
  // v2: no hard block on pending count, just soft warning
  const blocked = !!active || !inWindow;
  btn.disabled = blocked;
  if (active) btn.querySelector('span:last-child').textContent = 'Session Running';
  else if (!inWindow) btn.querySelector('span:last-child').textContent = 'Window Closed';
  else btn.querySelector('span:last-child').textContent = 'Start Session';
}

/* ── Pending Sessions List (Log page) ── */
function renderPendingList() {
  const pending = pendingSessions();
  const list = document.getElementById('pending-sessions-list');
  const empty = document.getElementById('pending-empty');
  const badge = document.getElementById('pending-count-badge');
  badge.textContent = pending.length;

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
    .sort((a, b) => new Date(b.startTime || b.date) - new Date(a.startTime || a.date));
  const list = document.getElementById('session-history-list');
  const empty = document.getElementById('history-empty');
  list.querySelectorAll('.session-history-card').forEach(c => c.remove());

  if (!logged.length) { empty.style.display = 'block'; return; }
  empty.style.display = 'none';

  logged.forEach(s => {
    const dur = (!s.isMisc && s.duration) ? formatDuration(s.duration) : '—';
    const card = document.createElement('div');
    card.className = 'session-history-card';
    card.dataset.id = s.id;
    card.innerHTML = `
      <div class="shc-row">
        <div>
          <div class="shc-date">${formatDate(s.date)}${s.isMisc ? ' <span class="misc-tag">misc</span>' : ''}</div>
          <div class="shc-meta">${s.startTime ? formatTime(s.startTime) : '—'} · ${dur}</div>
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

/* ══════════════════════════════════════════════════════════════
   IN-APP NUDGE SYSTEM
══════════════════════════════════════════════════════════════ */

function checkAndShowNudge() {
  const hour = new Date().getHours();
  const todayOut = todayTotals().outreaches;
  const banner = document.getElementById('nudge-banner');
  const text = document.getElementById('nudge-text');

  if (todayOut > 0) {
    banner.classList.add('hidden');
    return;
  }

  if (hour >= 20) {
    // 8PM+ — streak at risk warning
    const secsLeft = secondsUntil9PM();
    const hrsLeft = Math.floor(secsLeft / 3600);
    const minsLeft = Math.floor((secsLeft % 3600) / 60);
    const timeStr = hrsLeft > 0 ? `${hrsLeft}h ${minsLeft}m` : `${minsLeft}m`;
    banner.className = 'nudge-banner nudge-urgent';
    text.textContent = `No outreaches yet today. Window closes in ${timeStr}.`;
    banner.classList.remove('hidden');
  } else if (hour >= 18) {
    // 6PM+ — gentle reminder
    banner.className = 'nudge-banner nudge-soft';
    const secsLeft = secondsUntil9PM();
    const hrsLeft = Math.floor(secsLeft / 3600);
    text.textContent = `No outreaches logged today. ${hrsLeft} hour${hrsLeft !== 1 ? 's' : ''} remaining in the window.`;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

/* ══════════════════════════════════════════════════════════════
   INSIGHTS PAGE
══════════════════════════════════════════════════════════════ */

function getFilteredSessions(period) {
  const all = state.sessions.filter(s => s.dataLogged);
  if (period === 'all') return all;
  const days = parseInt(period);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  cutoff.setHours(0, 0, 0, 0);
  return all.filter(s => {
    const d = s.startTime ? new Date(s.startTime) : new Date(s.date + 'T12:00:00');
    return d >= cutoff;
  });
}

function getDailyData(sessions, period) {
  // Fix: 'all' shows ALL available days, not a hard cap
  let days;
  let startDate;

  if (period === 'all') {
    // Find earliest date in data
    const dates = sessions.map(s => s.date).filter(Boolean).sort();
    if (!dates.length) {
      days = 7;
      startDate = new Date();
      startDate.setDate(startDate.getDate() - 6);
    } else {
      startDate = new Date(dates[0] + 'T12:00:00');
      const todayDate = new Date();
      days = Math.ceil((todayDate - startDate) / 86400000) + 1;
    }
  } else {
    days = parseInt(period);
    startDate = new Date();
    startDate.setDate(startDate.getDate() - days + 1);
  }

  const map = {};
  sessions.forEach(s => { map[s.date] = map[s.date] || []; map[s.date].push(s); });

  const result = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(startDate);
    d.setDate(startDate.getDate() + i);
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
      duration: ss.reduce((a, s) => a + (s.isMisc ? 0 : (s.duration || 0)), 0)
    });
  }
  return result;
}

function renderInsights() {
  const sessions = getFilteredSessions(insightsPeriod);

  const totals = sessions.reduce((a, s) => ({
    outreaches: a.outreaches + (s.outreaches || 0),
    closes: a.closes + (s.closes || 0),
    demoRequests: a.demoRequests + (s.demoRequests || 0)
  }), { outreaches: 0, closes: 0, demoRequests: 0 });

  const demoRate = totals.outreaches > 0 ? ((totals.demoRequests / totals.outreaches) * 100).toFixed(1) : '0.0';
  const closeRate = totals.outreaches > 0 ? ((totals.closes / totals.outreaches) * 100).toFixed(2) : '0.00';

  animateCount(document.getElementById('kpi-outreaches'), totals.outreaches, 900);
  animateCount(document.getElementById('kpi-closes'), totals.closes, 900);
  animateCountText(document.getElementById('kpi-demo-rate'), parseFloat(demoRate), '%', 1);
  animateCountText(document.getElementById('kpi-close-rate'), parseFloat(closeRate), '%', 2);

  animateCount(document.getElementById('ins-current-streak'), state.streak.current, 900);
  animateCount(document.getElementById('ins-longest-streak'), state.streak.longest, 900);

  renderWeekHeatmap();
  renderVolumeChart(sessions);
  renderFunnelChart(sessions);
  renderOutcomesChart(sessions);
  renderTimeChart(sessions);
  renderBestHoursChart(sessions);
  renderDataTable(sessions);
  renderPeriodSummary(sessions);
}

/* ── 7-Day Activity Heatmap ── */
function renderWeekHeatmap() {
  const container = document.getElementById('week-heatmap');
  if (!container) return;
  const target = state.settings.dailyTarget;
  container.innerHTML = '';

  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const dayLabel = d.toLocaleDateString('en-US', { weekday: 'short' });
    const count = sessionsForDate(key).reduce((a, s) => a + (s.outreaches || 0), 0);
    const cls = count === 0 ? 'hm-miss' : count >= target ? 'hm-hit' : 'hm-partial';
    const cell = document.createElement('div');
    cell.className = `hm-cell ${cls}`;
    cell.title = `${dayLabel}: ${count} outreaches`;
    cell.innerHTML = `<span class="hm-day-label">${dayLabel[0]}</span>`;
    container.appendChild(cell);
  }
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

/* Chart helper — always destroys and recreates so the full draw animation
   plays every time the Insights page is visited or a period tab is switched. */
function updateOrCreateChart(key, canvas, config) {
  if (chartInstances[key]) {
    chartInstances[key].destroy();
    delete chartInstances[key];
  }
  config.options = {
    ...config.options,
    animation: { duration: 3000, easing: 'easeInOutQuart' }
  };
  chartInstances[key] = new Chart(canvas, config);
}

function renderVolumeChart(sessions) {
  const daily = getDailyData(sessions, insightsPeriod);
  // Thin out labels if too many data points
  const maxLabels = 20;
  const step = daily.length > maxLabels ? Math.ceil(daily.length / maxLabels) : 1;
  const labels = daily.map((d, i) => i % step === 0 ? d.label : '');
  const values = daily.map(d => d.outreaches);
  const target = state.settings.dailyTarget;

  const rolling = values.map((_, i) => {
    const slice = values.slice(Math.max(0, i - 6), i + 1);
    return Math.round(slice.reduce((a, b) => a + b, 0) / slice.length);
  });

  const canvas = document.getElementById('chart-volume');
  updateOrCreateChart('volume', canvas, {
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
          pointRadius: daily.length > 30 ? 0 : 3,
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
    options: chartDefaults()
  });
}

function renderOutcomesChart(sessions) {
  // Simplified: show No's, Demos, Closes only (no Continued Conversations)
  const daily = getDailyData(sessions, insightsPeriod);
  const isWeekly = daily.length > 30;
  let labels, data;

  if (isWeekly) {
    const weeks = {};
    daily.forEach(d => {
      const wk = getWeekLabel(d.date);
      if (!weeks[wk]) weeks[wk] = { nos: 0, demoRequests: 0, closes: 0 };
      weeks[wk].nos += d.nos;
      weeks[wk].demoRequests += d.demoRequests;
      weeks[wk].closes += d.closes;
    });
    labels = Object.keys(weeks);
    data = Object.values(weeks);
  } else {
    labels = daily.map(d => d.label);
    data = daily;
  }

  const canvas = document.getElementById('chart-outcomes');
  updateOrCreateChart('outcomes', canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: "No's", data: data.map(d => d.nos), backgroundColor: 'rgba(192,57,43,0.5)' },
        { label: 'Demos', data: data.map(d => d.demoRequests), backgroundColor: 'rgba(212,175,55,0.6)' },
        { label: 'Closes', data: data.map(d => d.closes), backgroundColor: 'rgba(39,174,96,0.7)' }
      ]
    },
    options: chartDefaults()
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
  updateOrCreateChart('funnel', canvas, {
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
      plugins: { ...chartDefaults().plugins, legend: { display: false } }
    }
  });
}

function renderTimeChart(sessions) {
  const daily = getDailyData(sessions, insightsPeriod);
  const step = daily.length > 20 ? Math.ceil(daily.length / 20) : 1;
  const labels = daily.map((d, i) => i % step === 0 ? d.label : '');
  const canvas = document.getElementById('chart-time');
  updateOrCreateChart('time', canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Hours',
        data: daily.map(d => parseFloat((d.duration / 3600).toFixed(2))),
        borderColor: '#D4AF37',
        backgroundColor: 'rgba(212,175,55,0.12)',
        borderWidth: 2,
        pointRadius: daily.length > 30 ? 0 : 2,
        tension: 0.4,
        fill: true
      }]
    },
    options: chartDefaults()
  });
}

function renderBestHoursChart(sessions) {
  const el = document.getElementById('best-hours-content');
  // Raised threshold to 10 sessions
  if (sessions.length < 10) {
    el.innerHTML = '<div class="chart-placeholder">Come back after a few more sessions for hour-by-hour insights.</div>';
    return;
  }
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

  // Always recreate the canvas so the destroyed chart has a clean target
  el.innerHTML = '<div class="chart-wrap chart-wrap-sm"><canvas id="chart-hours"></canvas></div>';
  const canvas = document.getElementById('chart-hours');
  if (canvas) {
    updateOrCreateChart('hours', canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Demo Reqs', data: hours.map(h => byHour[h].demoRequests), backgroundColor: 'rgba(212,175,55,0.6)' },
          { label: 'Closes', data: hours.map(h => byHour[h].closes), backgroundColor: 'rgba(39,174,96,0.7)' }
        ]
      },
      options: { ...chartDefaults(), indexAxis: 'y' }
    });
  }
}

function renderDataTable(sessions) {
  const sorted = [...sessions].sort((a, b) => {
    const aTime = a.startTime || (a.date + 'T12:00:00');
    const bTime = b.startTime || (b.date + 'T12:00:00');
    return new Date(bTime) - new Date(aTime);
  });
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
      <td>${s.startTime ? formatTime(s.startTime) : '—'}</td>
      <td>${s.endTime ? formatTime(s.endTime) : '—'}</td>
      <td>${(!s.isMisc && s.duration) ? formatDuration(s.duration) : '—'}</td>
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

/* ── Period Summary — actual insights, not a template ── */
function renderPeriodSummary(sessions) {
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
    duration: a.duration + (s.isMisc ? 0 : (s.duration || 0))
  }), { outreaches: 0, closes: 0, demoRequests: 0, duration: 0 });

  const sessionCount = sessions.filter(s => !s.isMisc).length;
  const measuredSessions = sessions.filter(s => !s.isMisc && s.duration > 0);
  const avgDuration = measuredSessions.length > 0 ? t.duration / measuredSessions.length : 0;
  const demoRate = t.outreaches > 0 ? ((t.demoRequests / t.outreaches) * 100).toFixed(1) : '0.0';
  const closeRate = t.outreaches > 0 ? ((t.closes / t.outreaches) * 100).toFixed(2) : '0.00';

  // Find best day of week
  const byDOW = {};
  sessions.forEach(s => {
    if (!s.date) return;
    const dow = new Date(s.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' });
    byDOW[dow] = (byDOW[dow] || 0) + (s.outreaches || 0);
  });
  const dowEntries = Object.entries(byDOW).sort((a, b) => b[1] - a[1]);
  const bestDOW = dowEntries.length > 0 ? dowEntries[0][0] : null;

  // Compare to previous period for demo rate trend
  let trendNote = '';
  if (insightsPeriod !== 'all' && parseInt(insightsPeriod) <= 30) {
    const days_n = parseInt(insightsPeriod);
    const prevSessions = (() => {
      const prevCutoff = new Date();
      prevCutoff.setDate(prevCutoff.getDate() - days_n * 2);
      const prevEnd = new Date();
      prevEnd.setDate(prevEnd.getDate() - days_n);
      return state.sessions.filter(s => {
        if (!s.dataLogged) return false;
        const d = s.startTime ? new Date(s.startTime) : new Date(s.date + 'T12:00:00');
        return d >= prevCutoff && d < prevEnd;
      });
    })();
    if (prevSessions.length > 0) {
      const prevOut = prevSessions.reduce((a, s) => a + (s.outreaches || 0), 0);
      const prevDemo = prevSessions.reduce((a, s) => a + (s.demoRequests || 0), 0);
      const prevDemoRate = prevOut > 0 ? (prevDemo / prevOut) * 100 : 0;
      const curDemoRate = parseFloat(demoRate);
      const diff = (curDemoRate - prevDemoRate).toFixed(1);
      if (Math.abs(parseFloat(diff)) >= 0.3) {
        trendNote = ` Demo rate is ${parseFloat(diff) > 0 ? 'up' : 'down'} ${Math.abs(parseFloat(diff))}% vs the previous period.`;
      }
    }
  }

  // Active days
  const activeDaySet = new Set(sessions.filter(s => s.outreaches > 0).map(s => s.date));
  const totalDaySpan = (() => {
    if (insightsPeriod === 'all') {
      const dates = sessions.map(s => s.date).filter(Boolean).sort();
      if (!dates.length) return 0;
      const start = new Date(dates[0] + 'T12:00:00');
      const end = new Date();
      return Math.ceil((end - start) / 86400000) + 1;
    }
    return parseInt(insightsPeriod);
  })();

  let summary = `Over ${days}, you sent ${t.outreaches.toLocaleString()} outreaches across ${sessionCount} session${sessionCount !== 1 ? 's' : ''}. Demo rate: ${demoRate}% · Close rate: ${closeRate}%.${trendNote}`;
  if (bestDOW) summary += ` Your strongest day of the week is ${bestDOW}.`;
  summary += ` You were active ${activeDaySet.size} of ${totalDaySpan} day${totalDaySpan !== 1 ? 's' : ''}.`;
  if (avgDuration > 0) summary += ` Avg session length: ${formatDuration(Math.round(avgDuration))}.`;
  if (t.closes > 0) summary += ` Total closes: ${t.closes}.`;

  el.textContent = summary;
}

/* ── Settings ── */
function renderSettings() {
  document.getElementById('daily-target-input').value = state.settings.dailyTarget;
  document.getElementById('settings-current-streak').textContent = state.streak.current;
  document.getElementById('settings-longest-streak').textContent = state.streak.longest;
  document.getElementById('settings-freeze-tokens').textContent = state.streak.freezeTokens || 0;
  renderBackupStatus();
}

function renderBackupStatus() {
  const el = document.getElementById('backup-status-text');
  if (!el) return;
  const last = state.backup && state.backup.lastBackupDate;
  if (last) {
    const d = new Date(last);
    const daysSince = Math.floor((Date.now() - d) / 86400000);
    el.innerHTML = `Last backup: <strong>${formatDate(last)}</strong> (${daysSince} day${daysSince !== 1 ? 's' : ''} ago). Weekly auto-backup is active.`;
  } else {
    el.innerHTML = 'No backup taken yet. Tap below to backup now, or it will auto-backup weekly.';
  }
}

/* ══════════════════════════════════════════════════════════════
   ANIMATION UTILITIES
══════════════════════════════════════════════════════════════ */

function animateCount(el, target, duration = 900, comma = true) {
  if (!el) return;
  const start = performance.now();
  function step(now) {
    const t = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    const val = Math.round(target * eased);
    el.textContent = comma ? val.toLocaleString() : val;
    if (t < 1) requestAnimationFrame(step);
    else el.textContent = comma ? target.toLocaleString() : target;
  }
  requestAnimationFrame(step);
}

function animateCountText(el, target, suffix = '', decimals = 0, duration = 900) {
  if (!el) return;
  const start = performance.now();
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
   REWARD SYSTEM v2 — CINEMATIC GSAP TIMELINES
══════════════════════════════════════════════════════════════ */

const STREAK_MILESTONES = [1, 3, 7, 14, 25, 50, 75, 100, 125, 150, 200];
const VOLUME_MILESTONES = [50, 100, 200, 400, 500, 1000, 1500];

const MILESTONE_LABELS = {
  1:   { label: 'First Flame', sub: 'The journey begins' },
  3:   { label: 'Three Strong', sub: 'Building momentum' },
  7:   { label: 'One Week Strong', sub: '7 days of discipline' },
  14:  { label: 'Two Week Warrior', sub: 'Habit is forming' },
  25:  { label: 'Quarter Century', sub: '25 days of consistency' },
  50:  { label: 'Half Century', sub: 'Unstoppable' },
  75:  { label: 'Three Quarters', sub: '75 days of dominance' },
  100: { label: 'Century Mark', sub: 'Elite territory' },
  125: { label: '125 Days Reigning', sub: 'You are the standard' },
  150: { label: 'Sesquicentennial', sub: '150 days of mastery' },
  200: { label: 'The 200 Club', sub: 'Legendary status' }
};

let rewardTimeout = null;
let particleRAF = null;
let particles = [];
let rewardActive = false;

function checkAndTriggerRewards() {
  const streak = state.streak.current;
  const totalOut = allTimeTotals().outreaches;
  const todayOut = todayTotals().outreaches;
  const triggered = state.rewards.animationsTriggered;

  // Daily target completion (once per day)
  const dailyKey = `daily-${today()}`;
  if (todayOut >= state.settings.dailyTarget && !triggered.includes(dailyKey)) {
    state.rewards.animationsTriggered.push(dailyKey);
    saveData(state);
    setTimeout(() => showDailyAnimation(streak), 300);
    return;
  }

  // Streak milestone
  const isMilestone = STREAK_MILESTONES.includes(streak) || (streak >= 200 && streak % 25 === 0);
  if (streak > 0 && isMilestone && !state.rewards.milestoneStreaksHit.includes(streak)) {
    state.rewards.milestoneStreaksHit.push(streak);
    saveData(state);
    setTimeout(() => showMilestoneAnimation(streak), 300);
    return;
  }

  // Volume milestone
  const volMilestones = [...VOLUME_MILESTONES];
  let v = 2000;
  while (v <= totalOut + 500) { volMilestones.push(v); v += 500; }
  const nextVol = volMilestones.find(m => totalOut >= m && !state.rewards.milestoneVolumeHit.includes(m));
  if (nextVol) {
    state.rewards.milestoneVolumeHit.push(nextVol);
    saveData(state);
    setTimeout(() => showVolumeAnimation(nextVol), 300);
  }
}

/* ── Tier determination ── */
function getStreakTier(streak) {
  if (streak >= 100) return 'elite';
  if (streak >= 25) return 'mid';
  return 'early';
}

/* ── Daily Completion Animation (3.5s) ── */
function showDailyAnimation(streak) {
  openRewardOverlay();
  const overlay = document.getElementById('reward-overlay');
  const canvas = document.getElementById('reward-canvas');
  const iconEl = document.getElementById('reward-icon');
  const numEl = document.getElementById('reward-number');
  const labelEl = document.getElementById('reward-label');
  const subEl = document.getElementById('reward-sublabel');
  const glow = document.getElementById('reward-screen-glow');
  document.getElementById('reward-token-slot').classList.add('hidden');

  iconEl.innerHTML = '<i class="fa-solid fa-fire" style="color:#FFD700"></i>';
  numEl.textContent = '';
  labelEl.textContent = 'Daily Target Hit';
  subEl.textContent = `Day ${streak} — keep the fire burning`;

  // Particles rising from bottom
  startParticles(canvas, 'daily');

  if (typeof gsap === 'undefined') {
    autoCloseReward(3500);
    return;
  }

  const tl = gsap.timeline({ onComplete: () => autoCloseReward(0) });
  tl.set([iconEl, numEl, labelEl, subEl, glow], { opacity: 0 })
    .to(glow, { opacity: 1, duration: 0.6, ease: 'power2.out' }, 0.3)
    .fromTo(iconEl, { scale: 0.4, opacity: 0 }, { scale: 1.1, opacity: 1, duration: 0.5, ease: 'back.out(2)' }, 0.5)
    .to(iconEl, { scale: 1, duration: 0.2 }, 1)
    .fromTo(labelEl, { y: 20, opacity: 0 }, { y: 0, opacity: 1, duration: 0.4, ease: 'power2.out' }, 1.1)
    .fromTo(subEl, { y: 15, opacity: 0 }, { y: 0, opacity: 1, duration: 0.35, ease: 'power2.out' }, 1.4)
    .to(glow, { opacity: 0, duration: 0.8, ease: 'power2.in' }, 2.5)
    .to([iconEl, labelEl, subEl], { opacity: 0, duration: 0.4, ease: 'power2.in' }, 2.8);

  tl.totalDuration(3.5);
}

/* ── Streak Milestone Animations ── */
function showMilestoneAnimation(streak) {
  const tier = getStreakTier(streak);
  openRewardOverlay();
  const canvas = document.getElementById('reward-canvas');
  const iconEl = document.getElementById('reward-icon');
  const numEl = document.getElementById('reward-number');
  const labelEl = document.getElementById('reward-label');
  const subEl = document.getElementById('reward-sublabel');
  const glow = document.getElementById('reward-screen-glow');
  document.getElementById('reward-token-slot').classList.add('hidden');

  const info = MILESTONE_LABELS[streak] || { label: `${streak} Day Streak`, sub: 'Remarkable consistency' };

  numEl.textContent = '';
  labelEl.textContent = info.label;
  subEl.textContent = info.sub;

  if (tier === 'early') {
    iconEl.innerHTML = '<i class="fa-solid fa-fire" style="color:#FFD700"></i>';
    startParticles(canvas, 'confetti');
    if (typeof gsap === 'undefined') { autoCloseReward(4000); return; }

    const tl = gsap.timeline({ onComplete: () => autoCloseReward(0) });
    tl.set([iconEl, numEl, labelEl, subEl, glow], { opacity: 0 })
      .to(glow, { opacity: 0.7, duration: 0.4 }, 0.4)
      .to(glow, { opacity: 0, duration: 0.3 }, 0.8) // flash
      .fromTo(iconEl, { scale: 0.2, opacity: 0 }, { scale: 1.2, opacity: 1, duration: 0.3, ease: 'back.out(3)' }, 0.5)
      .to(iconEl, { scale: 1, duration: 0.15 }, 0.8)
      .fromTo(numEl, { scale: 0.3, opacity: 0 }, { scale: 1.15, opacity: 1, duration: 0.35, ease: 'back.out(2)' }, 0.7)
      .to(numEl, { scale: 1, duration: 0.2 }, 1.05)
      .call(() => animateCount(numEl, streak, 600, false), [], 0.7)
      .fromTo(labelEl, { y: 18, opacity: 0 }, { y: 0, opacity: 1, duration: 0.35 }, 1.2)
      .fromTo(subEl, { y: 12, opacity: 0 }, { y: 0, opacity: 1, duration: 0.3 }, 1.5)
      .to([numEl, iconEl, labelEl, subEl], { opacity: 0, duration: 0.5 }, 3.3);
    tl.totalDuration(4);

  } else if (tier === 'mid') {
    iconEl.innerHTML = '<i class="fa-solid fa-crown" style="color:#FFD700"></i>';
    startParticles(canvas, 'spiral');
    if (typeof gsap === 'undefined') { autoCloseReward(5500); return; }

    const tl = gsap.timeline({ onComplete: () => autoCloseReward(0) });
    tl.set([iconEl, numEl, labelEl, subEl, glow], { opacity: 0 })
      .to(glow, { opacity: 1, duration: 0.8, ease: 'power2.out' }, 0.5)
      .fromTo(iconEl, { scale: 0.3, opacity: 0, rotation: -30 }, { scale: 1.15, opacity: 1, rotation: 0, duration: 0.5, ease: 'back.out(2)' }, 0.8)
      .to(iconEl, { scale: 1, duration: 0.2 }, 1.3)
      .fromTo(numEl, { scale: 0.3, opacity: 0 }, { scale: 1.2, opacity: 1, duration: 0.4, ease: 'back.out(2)' }, 1.1)
      .call(() => animateCount(numEl, streak, 1000, false), [], 1.1)
      .to(numEl, { scale: 1, duration: 0.2 }, 1.5)
      .to(glow, { opacity: 0.3, duration: 0.4 }, 2.0)
      .to(glow, { opacity: 1, duration: 0.4 }, 2.4) // second pulse
      .to(glow, { opacity: 0, duration: 0.6 }, 2.8)
      .fromTo(labelEl, { y: 20, opacity: 0 }, { y: 0, opacity: 1, duration: 0.4 }, 1.8)
      .fromTo(subEl, { y: 14, opacity: 0 }, { y: 0, opacity: 1, duration: 0.35 }, 2.1)
      .to([numEl, iconEl, labelEl, subEl], { opacity: 0, duration: 0.6 }, 4.6);
    tl.totalDuration(5.5);

  } else {
    // Elite
    iconEl.innerHTML = '<i class="fa-solid fa-crown" style="color:#FFD700"></i>';
    startParticles(canvas, 'elite');
    if (typeof gsap === 'undefined') { autoCloseReward(8000); return; }

    const tl = gsap.timeline({ onComplete: () => autoCloseReward(0) });
    // Darkness → single spark → explosion
    tl.set([iconEl, numEl, labelEl, subEl, glow], { opacity: 0 })
      // Initial darkness
      .to(glow, { opacity: 0.05, duration: 1.2, ease: 'none' }, 0)
      // Spark flash
      .to(glow, { opacity: 1, duration: 0.15 }, 1.2)
      .to(glow, { opacity: 0.4, duration: 0.15 }, 1.35)
      // Explosion with screen shake
      .to('.reward-content', { x: 6, duration: 0.05 }, 1.5)
      .to('.reward-content', { x: -6, duration: 0.05 }, 1.55)
      .to('.reward-content', { x: 4, duration: 0.05 }, 1.6)
      .to('.reward-content', { x: 0, duration: 0.08 }, 1.65)
      .fromTo(iconEl, { scale: 0.1, opacity: 0 }, { scale: 1.3, opacity: 1, duration: 0.4, ease: 'back.out(3)' }, 1.5)
      .to(iconEl, { scale: 1, duration: 0.25 }, 1.9)
      .fromTo(numEl, { scale: 0.2, opacity: 0 }, { scale: 1.15, opacity: 1, duration: 0.45, ease: 'back.out(2)' }, 1.8)
      .call(() => animateCount(numEl, streak, 1500, false), [], 1.8)
      .to(numEl, { scale: 1, duration: 0.25 }, 2.25)
      .to(glow, { opacity: 0.2, duration: 0.6 }, 2.3) // shimmer
      // Typewriter effect for label
      .call(() => typewriterEffect(labelEl, info.label), [], 2.5)
      .set(labelEl, { opacity: 1 }, 2.5)
      .fromTo(subEl, { y: 12, opacity: 0 }, { y: 0, opacity: 1, duration: 0.4 }, 4.2)
      // Sustained shimmer
      .to(glow, { opacity: 0.4, duration: 0.5, repeat: 3, yoyo: true }, 4.5)
      .to([numEl, iconEl, labelEl, subEl, glow], { opacity: 0, duration: 0.7 }, 7.0);
    tl.totalDuration(8);
  }
}

/* ── Volume Milestone Animation (4.5s) ── */
function showVolumeAnimation(vol) {
  openRewardOverlay();
  const canvas = document.getElementById('reward-canvas');
  const iconEl = document.getElementById('reward-icon');
  const numEl = document.getElementById('reward-number');
  const labelEl = document.getElementById('reward-label');
  const subEl = document.getElementById('reward-sublabel');
  const glow = document.getElementById('reward-screen-glow');
  document.getElementById('reward-token-slot').classList.add('hidden');

  // Paper plane icons
  iconEl.innerHTML = '<i class="fa-solid fa-paper-plane" style="color:#FFD700"></i>';
  labelEl.textContent = 'Total Outreaches';
  subEl.textContent = 'Volume milestone unlocked';

  startParticles(canvas, 'planes');

  if (typeof gsap === 'undefined') { autoCloseReward(4500); return; }

  const tl = gsap.timeline({ onComplete: () => autoCloseReward(0) });
  tl.set([iconEl, numEl, labelEl, subEl, glow], { opacity: 0 })
    .to(glow, { opacity: 0.8, duration: 0.5 }, 0.3)
    .fromTo(iconEl, { x: -80, opacity: 0 }, { x: 0, opacity: 1, duration: 0.5, ease: 'power3.out' }, 0.4)
    .fromTo(numEl, { scale: 0.4, opacity: 0 }, { scale: 1.1, opacity: 1, duration: 0.4, ease: 'back.out(2)' }, 0.7)
    .call(() => animateCount(numEl, vol, 1200, true), [], 0.7)
    .to(numEl, { scale: 1, duration: 0.2 }, 1.1)
    .fromTo(labelEl, { y: 16, opacity: 0 }, { y: 0, opacity: 1, duration: 0.35 }, 1.3)
    .fromTo(subEl, { y: 12, opacity: 0 }, { y: 0, opacity: 1, duration: 0.3 }, 1.6)
    .to(glow, { opacity: 0, duration: 0.8 }, 3.4)
    .to([numEl, iconEl, labelEl, subEl], { opacity: 0, duration: 0.4 }, 3.9);
  tl.totalDuration(4.5);
}

/* ── Perfect Week Animation (5s) — platinum silver instead of gold ── */
function showPerfectWeekAnimation(streak) {
  openRewardOverlay();
  const canvas = document.getElementById('reward-canvas');
  const iconEl = document.getElementById('reward-icon');
  const numEl = document.getElementById('reward-number');
  const labelEl = document.getElementById('reward-label');
  const subEl = document.getElementById('reward-sublabel');
  const glow = document.getElementById('reward-screen-glow');
  const tokenSlot = document.getElementById('reward-token-slot');

  iconEl.innerHTML = '<i class="fa-solid fa-star" style="color:#C0C0C0;filter:drop-shadow(0 0 12px #C0C0C0)"></i>';
  numEl.style.background = 'linear-gradient(90deg, #A8A9AD, #D4D5D9, #F8F8F8, #D4D5D9, #A8A9AD)';
  numEl.style.backgroundSize = '200% auto';
  numEl.style.webkitBackgroundClip = 'text';
  numEl.style.webkitTextFillColor = 'transparent';
  numEl.style.backgroundClip = 'text';
  numEl.textContent = '';
  labelEl.textContent = 'Perfect Week';
  subEl.textContent = 'No freeze used — discipline rewarded';
  tokenSlot.classList.remove('hidden');

  startParticles(canvas, 'platinum');

  if (typeof gsap === 'undefined') {
    autoCloseReward(5000);
    return;
  }

  const tl = gsap.timeline({ onComplete: () => { resetRewardNumStyle(); autoCloseReward(0); } });
  tl.set([iconEl, numEl, labelEl, subEl, glow, tokenSlot], { opacity: 0 })
    .to(glow, { opacity: 0.7, duration: 0.6, ease: 'power2.out' }, 0.3)
    .fromTo(iconEl, { scale: 0.3, opacity: 0 }, { scale: 1.1, opacity: 1, duration: 0.45, ease: 'back.out(2)' }, 0.6)
    .to(iconEl, { scale: 1, duration: 0.2 }, 1.05)
    .fromTo(numEl, { scale: 0.4, opacity: 0 }, { scale: 1.1, opacity: 1, duration: 0.4, ease: 'back.out(2)' }, 0.9)
    .call(() => animateCount(numEl, streak, 700, false), [], 0.9)
    .to(numEl, { scale: 1, duration: 0.2 }, 1.3)
    .fromTo(labelEl, { y: 18, opacity: 0 }, { y: 0, opacity: 1, duration: 0.35 }, 1.5)
    .fromTo(subEl, { y: 14, opacity: 0 }, { y: 0, opacity: 1, duration: 0.3 }, 1.8)
    // Token drops into slot
    .fromTo(tokenSlot, { y: -40, opacity: 0 }, { y: 0, opacity: 1, duration: 0.5, ease: 'bounce.out' }, 2.4)
    .to(glow, { opacity: 0, duration: 0.7 }, 4.0)
    .to([iconEl, numEl, labelEl, subEl, tokenSlot], { opacity: 0, duration: 0.4 }, 4.4);
  tl.totalDuration(5);
}

function resetRewardNumStyle() {
  const numEl = document.getElementById('reward-number');
  numEl.style.background = '';
  numEl.style.backgroundSize = '';
  numEl.style.webkitBackgroundClip = '';
  numEl.style.webkitTextFillColor = '';
  numEl.style.backgroundClip = '';
}

function typewriterEffect(el, text, speed = 60) {
  el.textContent = '';
  el.style.opacity = 1;
  let i = 0;
  const interval = setInterval(() => {
    el.textContent += text[i];
    i++;
    if (i >= text.length) clearInterval(interval);
  }, speed);
}

function openRewardOverlay() {
  rewardActive = true;
  const overlay = document.getElementById('reward-overlay');
  overlay.classList.remove('hidden');
}

function autoCloseReward(delay) {
  if (delay > 0) {
    rewardTimeout = setTimeout(dismissReward, delay);
  } else {
    // Grace period before dismissing
    rewardTimeout = setTimeout(dismissReward, 1200);
  }
}

function dismissReward() {
  if (!rewardActive) return;
  rewardActive = false;
  const overlay = document.getElementById('reward-overlay');
  if (typeof gsap !== 'undefined') {
    gsap.to(overlay, {
      opacity: 0, duration: 0.4, ease: 'power2.in',
      onComplete: () => {
        overlay.classList.add('hidden');
        overlay.style.opacity = '';
        resetRewardNumStyle();
      }
    });
  } else {
    overlay.classList.add('hidden');
  }
  stopParticles();
  if (rewardTimeout) clearTimeout(rewardTimeout);
  // Kill any running GSAP timelines on reward content
  if (typeof gsap !== 'undefined') {
    gsap.killTweensOf('#reward-content > *');
    gsap.killTweensOf('.reward-content');
  }
}

/* ── Particle canvas ── */
function startParticles(canvas, type) {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  particles = [];

  const configs = {
    daily: { count: 60, colors: ['#FFD700', '#D4AF37', '#FFF8DC'], fromBottom: true },
    confetti: { count: 100, colors: ['#FFD700', '#D4AF37', '#FFF8DC', '#B8860B'], fromCenter: true },
    spiral: { count: 120, colors: ['#FFD700', '#D4AF37', '#FFF8DC', '#B8860B', '#FFFFFF'], spiral: true },
    elite: { count: 180, colors: ['#FFD700', '#D4AF37', '#FFF8DC', '#B8860B', '#FFFFFF', '#FF8C00'], multi: true },
    planes: { count: 30, colors: ['#FFD700', '#FFF8DC', '#D4AF37'], planes: true },
    platinum: { count: 90, colors: ['#C0C0C0', '#D4D5D9', '#F8F8F8', '#A8A9AD', '#FFFFFF'] }
  };

  const cfg = configs[type] || configs.confetti;

  for (let i = 0; i < cfg.count; i++) {
    const p = {
      x: cfg.fromBottom ? Math.random() * canvas.width : canvas.width / 2 + (Math.random() - 0.5) * 200,
      y: cfg.fromBottom ? canvas.height + Math.random() * 40 : cfg.spiral
          ? canvas.height / 2
          : canvas.height / 2 + (Math.random() - 0.5) * 100,
      vx: cfg.spiral
          ? Math.cos(i / cfg.count * Math.PI * 2) * (Math.random() * 5 + 3)
          : (Math.random() - 0.5) * (cfg.multi ? 8 : 5),
      vy: cfg.fromBottom
          ? -(Math.random() * 10 + 5)
          : cfg.spiral
          ? Math.sin(i / cfg.count * Math.PI * 2) * (Math.random() * 5 + 3)
          : -(Math.random() * 9 + 3),
      size: Math.random() * (cfg.multi ? 8 : 6) + 2,
      color: cfg.colors[Math.floor(Math.random() * cfg.colors.length)],
      alpha: 1,
      gravity: cfg.spiral ? 0.05 : 0.1,
      rotation: Math.random() * Math.PI * 2,
      rotSpeed: (Math.random() - 0.5) * 0.15,
      shape: cfg.planes ? 'plane' : (Math.random() > 0.5 ? 'rect' : 'circle')
    };
    particles.push(p);
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
      p.alpha -= 0.006;
      if (p.alpha <= 0) return;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.globalAlpha = Math.max(0, p.alpha);
      ctx.fillStyle = p.color;
      ctx.shadowBlur = 10;
      ctx.shadowColor = p.color;
      if (p.shape === 'circle') {
        ctx.beginPath();
        ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      }
      ctx.restore();
    });
    particles = particles.filter(p => p.alpha > 0 && p.y < canvas.height + 30);
    if (particles.length > 0) particleRAF = requestAnimationFrame(frame);
  }
  if (particleRAF) cancelAnimationFrame(particleRAF);
  particleRAF = requestAnimationFrame(frame);
}

function stopParticles() {
  if (particleRAF) cancelAnimationFrame(particleRAF);
  particleRAF = null;
  particles = [];
}

/* ══════════════════════════════════════════════════════════════
   SESSION ACTIONS v2
══════════════════════════════════════════════════════════════ */

function startSession() {
  if (!isWithinOutreachWindow()) return;
  if (activeSession()) return;

  const session = {
    id: uuid(),
    date: today(),
    startTime: new Date().toISOString(),
    endTime: null,
    duration: null,
    status: 'running',
    isSessionless: false,
    isMisc: false,
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
  // Show the Stop → Log bottom sheet
  stopLogSessionId = id;
  openStopLogSheet(s);
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

/* ── Stop → Log Bottom Sheet ── */
function openStopLogSheet(session) {
  const sheet = document.getElementById('stop-log-sheet');
  const metaEl = document.getElementById('stop-log-meta');
  const formWrap = document.getElementById('stop-log-form-wrap');
  const dur = session.duration ? formatDuration(session.duration) : '—';

  metaEl.textContent = `${formatTime(session.startTime)} → ${formatTime(session.endTime)} · ${dur}`;
  formWrap.classList.add('hidden');
  formWrap.innerHTML = '';

  sheet.classList.remove('hidden');
  if (typeof gsap !== 'undefined') {
    gsap.fromTo('#stop-log-panel',
      { y: '100%' },
      { y: 0, duration: 0.4, ease: 'power3.out' }
    );
  }
}

function closeStopLogSheet() {
  const sheet = document.getElementById('stop-log-sheet');
  if (typeof gsap !== 'undefined') {
    gsap.to('#stop-log-panel', {
      y: '100%', duration: 0.3, ease: 'power2.in',
      onComplete: () => sheet.classList.add('hidden')
    });
  } else {
    sheet.classList.add('hidden');
  }
  stopLogSessionId = null;
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

function saveLogData(sessionId, fromSheet = false) {
  const s = state.sessions.find(s => s.id === sessionId);
  if (!s) return;
  const prefix = fromSheet ? `sheet-log-${sessionId}` : `lf-${sessionId}`;
  const data = readLogForm(prefix);
  Object.assign(s, data);
  s.status = 'complete';
  s.dataLogged = true;
  saveData(state);
  recalcStreak();
  checkPerfectWeek();
  checkAndTriggerRewards();
  renderAll();

  if (fromSheet) {
    closeStopLogSheet();
  } else {
    const card = document.querySelector(`[data-id="${sessionId}"]`);
    if (card) {
      card.classList.add('success-flash');
      setTimeout(() => card.classList.remove('success-flash'), 600);
    }
  }
}

/* ── Quick Add (misc bucket) ── */
function openQuickAdd() {
  const sheet = document.getElementById('quick-add-sheet');
  const fields = document.getElementById('quick-add-fields');
  fields.innerHTML = buildQuickFormFields('qa');
  sheet.classList.remove('hidden');
  if (typeof gsap !== 'undefined') {
    gsap.fromTo('#quick-add-panel',
      { y: '100%' },
      { y: 0, duration: 0.35, ease: 'power3.out' }
    );
  }
}

function closeQuickAdd() {
  const sheet = document.getElementById('quick-add-sheet');
  if (typeof gsap !== 'undefined') {
    gsap.to('#quick-add-panel', {
      y: '100%', duration: 0.3, ease: 'power2.in',
      onComplete: () => sheet.classList.add('hidden')
    });
  } else {
    sheet.classList.add('hidden');
  }
}

function saveQuickAdd() {
  const data = readQuickForm('qa');
  const dateStr = today();

  // Bug fix: sessionless entries with no time range excluded from duration calcs
  // by marking as isMisc = true — they have no startTime/endTime/duration
  const total = Object.values(data).some(v => (typeof v === 'number' && v > 0));
  if (!total && !data.notes) {
    closeQuickAdd();
    return;
  }

  const entry = {
    id: uuid(),
    date: dateStr,
    startTime: null,
    endTime: null,
    duration: null,
    status: 'complete',
    isSessionless: true,
    isMisc: true,
    dataLogged: true,
    outreaches: data.outreaches || 0,
    nos: data.nos || 0,
    demoRequests: data.demoRequests || 0,
    followUpsSent: 0,
    followUpResponses: 0,
    continuedConversations: 0,
    closes: data.closes || 0,
    notes: data.notes || ''
  };

  state.sessions.push(entry);
  saveData(state);
  recalcStreak();
  checkPerfectWeek();
  checkAndTriggerRewards();
  renderAll();
  closeQuickAdd();
  showToast(`Quick add saved: ${entry.outreaches} outreaches`);
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
  checkPerfectWeek();
  renderInsights();
}

/* ══════════════════════════════════════════════════════════════
   EXPORT / IMPORT
══════════════════════════════════════════════════════════════ */

function exportData(sessions, filename, fullState = true) {
  let exportPayload;
  if (fullState) {
    exportPayload = {
      meta: state.meta,
      sessions,
      streak: state.streak,
      rewards: state.rewards,
      settings: state.settings
    };
  } else {
    // Range export: only sessions data (bug fix — no conflicting state)
    exportPayload = {
      meta: { exportedAt: new Date().toISOString(), version: APP_VERSION },
      sessions
    };
  }
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
  // Also restore streak data if present in the import file
  if (imported.streak) {
    state.streak = { ...state.streak, ...imported.streak };
  }
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
   AUTO-BACKUP SYSTEM
══════════════════════════════════════════════════════════════ */

function checkAutoBackup() {
  if (!state.backup) state.backup = { lastBackupDate: null, promptShown: false };

  // First run prompt
  if (!state.backup.promptShown) {
    state.backup.promptShown = true;
    saveData(state);
    showModal(`
      <div class="modal-title">Enable Auto-Backup?</div>
      <div class="modal-sub">Once a week, your data will automatically download as a JSON file. This protects against accidental data loss. No server required.</div>
      <div class="modal-btn-row">
        <button class="modal-cancel-btn" id="backup-skip-btn">Maybe Later</button>
        <button class="modal-confirm-btn" id="backup-enable-btn">Enable</button>
      </div>
    `);
    document.getElementById('backup-skip-btn').addEventListener('click', closeModal);
    document.getElementById('backup-enable-btn').addEventListener('click', () => {
      closeModal();
      triggerBackup();
    });
    return;
  }

  // Weekly check
  if (state.backup.lastBackupDate) {
    const daysSince = Math.floor((Date.now() - new Date(state.backup.lastBackupDate)) / 86400000);
    if (daysSince >= 7) {
      triggerBackup();
    }
  }
}

function triggerBackup() {
  exportData(state.sessions, `outreach-backup-${today()}.json`, true);
  state.backup.lastBackupDate = new Date().toISOString();
  saveData(state);
  renderBackupStatus();
  showToast('📦 Weekly backup downloaded.');
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
    execBtn.disabled = !(parseInt(mathEl.value) === answer && confirmEl.value.trim() === 'DELETE');
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
    state.streak.freezeUsedThisWeek = false;
    saveData(state);
    closeModal();
    renderAll();
    showToast('Streak reset.');
  });
}

/* ══════════════════════════════════════════════════════════════
   TOAST
══════════════════════════════════════════════════════════════ */

function showToast(message, type = 'success') {
  const existing = document.getElementById('app-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'app-toast';
  toast.style.cssText = `
    position:fixed;bottom:calc(var(--nav-h) + 16px);left:50%;transform:translateX(-50%);
    background:${type === 'error' ? 'rgba(192,57,43,0.92)' : 'rgba(27,110,60,0.92)'};
    color:#fff;padding:12px 20px;border-radius:12px;font-size:13px;font-weight:600;
    z-index:9998;max-width:90vw;text-align:center;
    box-shadow:0 4px 24px rgba(0,0,0,0.5);
    animation:fadeInDown 0.3s ease;
    font-family:'DM Sans',sans-serif;
  `;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
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

  // FAB visibility: only on Home and Log pages
  const fab = document.getElementById('fab-quick-add');
  if (page === 'home' || page === 'log') {
    fab.classList.remove('fab-hidden');
  } else {
    fab.classList.add('fab-hidden');
  }

  if (page === 'insights') {
    setTimeout(() => {
      renderInsights();
      animateInsightSections();
    }, 100);
  }
  if (page === 'settings') renderSettings();
  if (page === 'log') {
    renderPendingList();
    renderSessionHistory();
  }
  if (page === 'home') {
    checkAndShowNudge();
  }
}

/* GSAP scroll animations for insights page — transform only, never opacity on chart containers */
function animateInsightSections() {
  if (typeof gsap === 'undefined' || typeof ScrollTrigger === 'undefined') return;
  const sections = document.querySelectorAll('#page-insights .chart-section, #page-insights .kpi-grid, #page-insights .insight-streak-block, #page-insights .summary-card');
  sections.forEach(el => {
    if (el.dataset.scrollAnimated) return;
    el.dataset.scrollAnimated = '1';
    gsap.fromTo(el,
      { y: 18 },
      {
        y: 0, duration: 0.5, ease: 'power2.out',
        scrollTrigger: {
          trigger: el,
          scroller: '#page-insights .page-scroll',
          start: 'top 95%',
          toggleActions: 'play none none none'
        }
      }
    );
  });
}

/* ══════════════════════════════════════════════════════════════
   FULL RENDER PASS
══════════════════════════════════════════════════════════════ */

function renderAll() {
  renderHeaderDate();
  renderStreakHero();
  renderCountdown();
  renderActiveBanner();
  renderPendingWarning();
  renderNavBadge();
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
   TIMERS
══════════════════════════════════════════════════════════════ */

function startCountdownLoop() {
  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    renderCountdown();
    // Re-check nudge every minute
    if (new Date().getSeconds() === 0) checkAndShowNudge();
  }, 1000);
}

/* ══════════════════════════════════════════════════════════════
   GSAP PAGE ENTRANCE
══════════════════════════════════════════════════════════════ */

function pageEntrance() {
  if (typeof gsap === 'undefined') return;

  const targets = [
    '.app-header',
    '.streak-hero-card',
    '.countdown-card',
    '.today-summary-grid .summary-cell',
    '.quick-stat-card',
    '.start-session-btn'
  ];

  targets.forEach(sel => {
    document.querySelectorAll(sel).forEach(el => { el.style.opacity = '0'; });
  });

  const tl = gsap.timeline({
    onComplete: () => {
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
   EVENT BINDING
══════════════════════════════════════════════════════════════ */

function bindEvents() {
  // Nav
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => navigateTo(btn.dataset.page));
  });

  // Start session
  document.getElementById('start-session-btn').addEventListener('click', () => {
    if (pendingSessions().length >= 3) {
      showToast(`${pendingSessions().length} sessions awaiting data — consider logging them first.`, 'error');
    }
    startSession();
    navigateTo('log');
  });

  // Stop session
  document.getElementById('stop-session-btn').addEventListener('click', () => {
    const active = activeSession();
    if (active) stopSession(active.id);
  });

  // Stop → Log sheet
  document.getElementById('stop-log-now').addEventListener('click', () => {
    if (!stopLogSessionId) return;
    const s = state.sessions.find(s => s.id === stopLogSessionId);
    if (!s) return;
    const formWrap = document.getElementById('stop-log-form-wrap');
    formWrap.innerHTML = `
      <div class="log-form" id="log-form-${stopLogSessionId}">
        ${buildLogFormFields(`sheet-log-${stopLogSessionId}`, s)}
        <button class="form-submit-btn" id="sheet-save-${stopLogSessionId}">
          <i class="fa-solid fa-floppy-disk"></i> Save Session Data
        </button>
      </div>
    `;
    formWrap.classList.remove('hidden');
    document.getElementById(`sheet-save-${stopLogSessionId}`).addEventListener('click', () => {
      saveLogData(stopLogSessionId, true);
    });
  });

  document.getElementById('stop-log-later').addEventListener('click', closeStopLogSheet);
  document.getElementById('stop-log-backdrop').addEventListener('click', closeStopLogSheet);

  // Log data buttons on log page (delegated)
  document.getElementById('pending-sessions-list').addEventListener('click', e => {
    const btn = e.target.closest('.log-data-btn');
    if (btn) openLogForm(btn.dataset.sessionId);
  });

  // Pending warning link → navigate to log
  document.getElementById('pending-warning-link').addEventListener('click', () => navigateTo('log'));

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
    exportData(state.sessions, `outreach-data-all-${today()}.json`, true);
  });

  // Export range toggle
  document.getElementById('export-range-btn').addEventListener('click', () => {
    document.getElementById('export-range-inputs').classList.toggle('hidden');
  });

  // Export range confirm (bug fix: sessions only, no full state)
  document.getElementById('export-range-confirm-btn').addEventListener('click', () => {
    const from = document.getElementById('export-from').value;
    const to = document.getElementById('export-to').value;
    if (!from || !to) { showToast('Please select a date range.', 'error'); return; }
    const filtered = state.sessions.filter(s => s.date >= from && s.date <= to);
    exportData(filtered, `outreach-data-${from}-${to}.json`, false);
  });

  // Import
  document.getElementById('import-file').addEventListener('change', e => {
    if (e.target.files[0]) importData(e.target.files[0]);
    e.target.value = '';
  });

  // Clear all
  document.getElementById('clear-data-btn').addEventListener('click', showClearDataModal);

  // Quick Add FAB
  document.getElementById('fab-quick-add').addEventListener('click', openQuickAdd);
  document.getElementById('quick-add-close').addEventListener('click', closeQuickAdd);
  document.getElementById('quick-add-backdrop').addEventListener('click', closeQuickAdd);
  document.getElementById('quick-add-submit').addEventListener('click', saveQuickAdd);

  // Use Freeze Token
  document.getElementById('use-freeze-btn').addEventListener('click', useFreezeToken);

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

  // Settings - backup now
  document.getElementById('backup-now-btn').addEventListener('click', triggerBackup);

  // Modal overlay click outside
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-overlay')) closeModal();
  });

  // Reward overlay dismiss
  document.getElementById('reward-overlay').addEventListener('click', dismissReward);

  // Nudge dismiss
  document.getElementById('nudge-dismiss').addEventListener('click', () => {
    document.getElementById('nudge-banner').classList.add('hidden');
  });

  // Summary copy
  document.getElementById('summary-copy-btn').addEventListener('click', () => {
    const text = document.getElementById('weekly-summary-text').textContent;
    navigator.clipboard.writeText(text).then(() => showToast('Summary copied!')).catch(() => showToast('Copy failed.', 'error'));
  });
}

/* ══════════════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════════════ */

function init() {
  registerSW();
  if (typeof ScrollTrigger !== 'undefined' && typeof gsap !== 'undefined') {
    gsap.registerPlugin(ScrollTrigger);
  }

  bindEvents();
  recalcStreak();
  renderAll();
  startCountdownLoop();
  checkAndShowNudge();

  // Restore running session timer if refreshed mid-session
  if (activeSession()) {
    startActiveTimer();
    renderActiveBanner();
  }

  setTimeout(pageEntrance, 80);

  // Auto-close sessions stuck as running past 9PM
  const now = new Date();
  if (now.getHours() >= 21) {
    const running = activeSession();
    if (running) autoCloseSession(running.id);
  }

  // Auto-backup check (slight delay to not block init)
  setTimeout(checkAutoBackup, 2000);
}

document.addEventListener('DOMContentLoaded', init);
