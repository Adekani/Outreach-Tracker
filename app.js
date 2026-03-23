/* ============================================================
   OUTREACH TRACKER — app.js
   All application logic: data, UI, charts, rewards, PWA
   ============================================================ */

'use strict';

// ─── Service Worker ───────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// ─── Constants ────────────────────────────────────────────────
const STORAGE_KEY = 'outreach_tracker_data';
const SESSION_CUTOFF_HOUR = 21; // 9 PM
const MAX_PENDING = 3;
const MIN_STREAK_OUTREACHES = 15; // for daily animation
const STREAK_MILESTONES = [1, 3, 7, 14, 25, 50, 75, 100, 125, 150, 200];
const VOLUME_MILESTONES = [50, 100, 200, 400, 500, 1000, 1500];
const MILESTONE_LABELS = {
  1: { label: 'First Flame', icon: 'fa-fire' },
  3: { label: 'Three-Day Run', icon: 'fa-bolt' },
  7: { label: 'One Week Strong', icon: 'fa-star' },
  14: { label: 'Fortnight Warrior', icon: 'fa-shield' },
  25: { label: 'Silver Mark', icon: 'fa-medal' },
  50: { label: 'Golden Fifty', icon: 'fa-trophy' },
  75: { label: 'Diamond Grind', icon: 'fa-gem' },
  100: { label: 'Century Mark', icon: 'fa-crown' },
  125: { label: 'Unstoppable', icon: 'fa-infinity' },
  150: { label: 'Elite Tier', icon: 'fa-star-half-stroke' },
  200: { label: 'Legend', icon: 'fa-dragon' },
};

// ─── Data Layer ───────────────────────────────────────────────
function defaultData() {
  return {
    meta: { version: '1.0', created: new Date().toISOString(), dailyTarget: 20 },
    sessions: [],
    streak: {
      current: 0, longest: 0, lastActiveDate: null,
      protectionMode: false, freezeActive: false,
      freezeProgress: 0, freezeDeadline: null
    },
    rewards: { animationsTriggered: [], milestoneStreaksHit: [], milestoneVolumeHit: [] },
    settings: { dailyTarget: 20, notificationsEnabled: false, reminderTime: '20:00' }
  };
}

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultData();
    const d = JSON.parse(raw);
    // Merge with defaults for any missing keys
    const def = defaultData();
    return {
      meta: { ...def.meta, ...d.meta },
      sessions: Array.isArray(d.sessions) ? d.sessions : [],
      streak: { ...def.streak, ...d.streak },
      rewards: { ...def.rewards, ...d.rewards },
      settings: { ...def.settings, ...d.settings }
    };
  } catch (e) { return defaultData(); }
}

function saveData(data) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) { showToast('Storage error — data may not be saved', 'error'); }
}

let appData = loadData();

function save() { saveData(appData); }

// ─── Utility ──────────────────────────────────────────────────
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function dateStr(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function fmtDate(isoStr) {
  if (!isoStr) return '—';
  const d = new Date(isoStr.length === 10 ? isoStr + 'T00:00:00' : isoStr);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtTime(isoStr) {
  if (!isoStr) return '—';
  return new Date(isoStr).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function fmtDuration(seconds) {
  if (!seconds || seconds < 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function fmtDurationShort(seconds) {
  if (!seconds || seconds < 0) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function elapsed(startIso) {
  return Math.floor((Date.now() - new Date(startIso).getTime()) / 1000);
}

function sessionDuration(s) {
  if (!s.startTime) return 0;
  const end = s.endTime ? new Date(s.endTime).getTime() : Date.now();
  return Math.floor((end - new Date(s.startTime).getTime()) / 1000);
}

function completedSessions() {
  return appData.sessions.filter(s => s.status === 'complete' || s.status === 'auto-closed');
}

function pendingSessions() {
  return appData.sessions.filter(s => (s.status === 'pending' || s.status === 'auto-closed') && !s.dataLogged);
}

function activeSession() {
  return appData.sessions.find(s => s.status === 'pending' && !s.endTime);
}

function sessionsForDate(dateStr_) {
  return appData.sessions.filter(s => s.date === dateStr_ && (s.dataLogged || s.status === 'complete' || s.status === 'auto-closed'));
}

function outreachesForDate(dateStr_) {
  return sessionsForDate(dateStr_).reduce((t, s) => t + (s.outreaches || 0), 0);
}

function allLoggedDates() {
  const dates = new Set();
  appData.sessions.forEach(s => { if (s.dataLogged && s.outreaches > 0) dates.add(s.date); });
  return [...dates].sort();
}

function countUpNumber(el, target, duration = 800) {
  if (!el) return;
  const start = Date.now();
  const startVal = 0;
  function tick() {
    const progress = Math.min((Date.now() - start) / duration, 1);
    const ease = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(startVal + (target - startVal) * ease);
    if (progress < 1) requestAnimationFrame(tick);
    else el.textContent = target;
  }
  requestAnimationFrame(tick);
}

// ─── Streak Logic ──────────────────────────────────────────────
function recalcStreak() {
  const dates = allLoggedDates();
  if (!dates.length) {
    appData.streak.current = 0;
    appData.streak.protectionMode = false;
    return;
  }

  const today = todayStr();
  let streak = 1;
  let longest = appData.streak.longest || 0;

  // Walk backwards from latest date
  for (let i = dates.length - 1; i > 0; i--) {
    const curr = new Date(dates[i] + 'T00:00:00');
    const prev = new Date(dates[i-1] + 'T00:00:00');
    const diff = (curr - prev) / (1000 * 60 * 60 * 24);
    if (diff === 1) { streak++; }
    else { break; }
  }

  // Check if today or yesterday is the most recent
  const lastDate = dates[dates.length - 1];
  const todayDt = new Date(today + 'T00:00:00');
  const lastDt = new Date(lastDate + 'T00:00:00');
  const diffToToday = Math.floor((todayDt - lastDt) / (1000 * 60 * 60 * 24));

  if (diffToToday === 0) {
    // Logged today — streak is live
    appData.streak.protectionMode = false;
  } else if (diffToToday === 1) {
    // Missed today but yesterday was logged — protection mode
    appData.streak.protectionMode = true;
  } else {
    // More than 1 day gap — streak ended (already factored in)
    streak = outreachesForDate(today) > 0 ? 1 : 0;
    appData.streak.protectionMode = false;
  }

  appData.streak.current = streak;
  if (streak > longest) {
    appData.streak.longest = streak;
    longest = streak;
  }
  appData.streak.lastActiveDate = lastDate;
  save();
}

// ─── Session Management ───────────────────────────────────────
function startSession() {
  const pending = pendingSessions();
  if (pending.length >= MAX_PENDING) { showToast('Log pending sessions first', 'error'); return; }

  const now = new Date();
  const hour = now.getHours();
  if (hour >= SESSION_CUTOFF_HOUR) { showToast('Outreach window closed for today', 'error'); return; }

  const active = activeSession();
  if (active) { showToast('A session is already running', 'error'); return; }

  const session = {
    id: uuid(), date: todayStr(), startTime: now.toISOString(),
    endTime: null, duration: 0, status: 'pending', isSessionless: false,
    outreaches: 0, nos: 0, demoRequests: 0, followUpsSent: 0,
    followUpResponses: 0, continuedConversations: 0, closes: 0,
    notes: '', dataLogged: false
  };
  appData.sessions.push(session);
  save();
  showToast('Session started', 'gold');
  renderAll();
}

function stopSession() {
  const active = activeSession();
  if (!active) return;
  active.endTime = new Date().toISOString();
  active.duration = sessionDuration(active);
  // Keep status pending until data logged
  save();
  showToast('Session stopped. Log your data.', 'gold');
  renderAll();
  navigateTo('log');
}

function autoCloseSessions() {
  const now = new Date();
  if (now.getHours() < SESSION_CUTOFF_HOUR) return;
  const active = activeSession();
  if (active) {
    const cutoff = new Date();
    cutoff.setHours(SESSION_CUTOFF_HOUR, 0, 0, 0);
    active.endTime = cutoff.toISOString();
    active.duration = sessionDuration(active);
    active.status = 'auto-closed';
    save();
  }
}

function logSessionData(sessionId, formData) {
  const session = appData.sessions.find(s => s.id === sessionId);
  if (!session) return;
  Object.assign(session, formData);
  session.dataLogged = true;
  if (session.status === 'pending') session.status = 'complete';
  session.duration = sessionDuration(session);
  save();
  recalcStreak();
  checkRewards();
  showToast('Session data saved', 'success');
  renderAll();
}

function logSessionlessData(formData, startTime, endTime) {
  const today = todayStr();
  if (startTime && endTime) {
    // Treat as a standalone session
    const now = new Date();
    const [sh, sm] = startTime.split(':').map(Number);
    const [eh, em] = endTime.split(':').map(Number);
    const startDt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), sh, sm, 0);
    const endDt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), eh, em, 0);
    const session = {
      id: uuid(), date: today, startTime: startDt.toISOString(),
      endTime: endDt.toISOString(), duration: Math.max(0, (endDt - startDt) / 1000),
      status: 'complete', isSessionless: false, dataLogged: true,
      ...formData
    };
    appData.sessions.push(session);
  } else {
    // Attach to most recent completed session or add as sessionless
    const lastComplete = [...appData.sessions].reverse().find(s => s.status === 'complete' || s.status === 'auto-closed');
    if (lastComplete) {
      lastComplete.outreaches += formData.outreaches || 0;
      lastComplete.nos += formData.nos || 0;
      lastComplete.demoRequests += formData.demoRequests || 0;
      lastComplete.followUpsSent += formData.followUpsSent || 0;
      lastComplete.followUpResponses += formData.followUpResponses || 0;
      lastComplete.continuedConversations += formData.continuedConversations || 0;
      lastComplete.closes += formData.closes || 0;
      if (formData.notes) lastComplete.notes = (lastComplete.notes ? lastComplete.notes + '\n' : '') + formData.notes;
    } else {
      const session = {
        id: uuid(), date: today, startTime: null, endTime: null,
        duration: 0, status: 'complete', isSessionless: true, dataLogged: true,
        ...formData
      };
      appData.sessions.push(session);
    }
  }
  save();
  recalcStreak();
  checkRewards();
  showToast('Activity logged', 'success');
  renderAll();
}

// ─── Rewards ──────────────────────────────────────────────────
function checkRewards() {
  const total = appData.sessions.reduce((t, s) => t + (s.outreaches || 0), 0);
  const today = todayStr();
  const todayOutreaches = outreachesForDate(today);
  const { current } = appData.streak;

  // Daily animation (≥15 today, once per day)
  const dailyKey = `daily-${today}`;
  if (todayOutreaches >= MIN_STREAK_OUTREACHES && !appData.rewards.animationsTriggered.includes(dailyKey)) {
    appData.rewards.animationsTriggered.push(dailyKey);
    save();
    // Check if a milestone also triggers, prefer milestone
    const milestoneHit = [...STREAK_MILESTONES, ...generateExtraMilestones()].find(m => m === current && !appData.rewards.milestoneStreaksHit.includes(m));
    if (!milestoneHit) setTimeout(() => triggerDailyAnimation(current), 400);
  }

  // Milestone streak
  const allMilestones = [...STREAK_MILESTONES, ...generateExtraMilestones()];
  for (const milestone of allMilestones) {
    if (current >= milestone && !appData.rewards.milestoneStreaksHit.includes(milestone)) {
      appData.rewards.milestoneStreaksHit.push(milestone);
      save();
      setTimeout(() => triggerMilestoneAnimation(milestone), 400);
      return; // One at a time
    }
  }

  // Volume milestones
  const allVolMilestones = [...VOLUME_MILESTONES, ...generateExtraVolMilestones(total)];
  for (const milestone of allVolMilestones) {
    if (total >= milestone && !appData.rewards.milestoneVolumeHit.includes(milestone)) {
      appData.rewards.milestoneVolumeHit.push(milestone);
      save();
      setTimeout(() => triggerVolumeAnimation(milestone), 600);
      return;
    }
  }
}

function generateExtraMilestones() {
  const extras = [];
  for (let i = 225; i <= 1000; i += 25) extras.push(i);
  return extras;
}

function generateExtraVolMilestones(total) {
  const extras = [];
  for (let i = 2000; i <= total + 500; i += 500) extras.push(i);
  return extras;
}

// ─── Reward Animations ────────────────────────────────────────
let rewardCanvas, rewardCtx, rewardParticles = [], rewardAnimId;

function triggerDailyAnimation(streakN) {
  const overlay = document.getElementById('reward-overlay');
  const content = document.getElementById('reward-content');
  overlay.className = 'reward-overlay daily';
  content.innerHTML = `
    <i class="fa-solid fa-fire reward-icon" style="color:#FFD700"></i>
    <div class="reward-number gold-text">${streakN}</div>
    <div class="reward-title gold-text">Day Streak</div>
    <div class="reward-subtitle">Keep the fire burning.</div>
  `;
  showRewardOverlay(3000);
}

function triggerMilestoneAnimation(n) {
  const info = MILESTONE_LABELS[n] || { label: `${n}-Day Streak`, icon: 'fa-crown' };
  const overlay = document.getElementById('reward-overlay');
  const content = document.getElementById('reward-content');
  overlay.className = 'reward-overlay milestone';
  content.innerHTML = `
    <i class="fa-solid ${info.icon} reward-icon"></i>
    <div class="reward-number gold-text">${n}</div>
    <div class="reward-title gold-text">${info.label}</div>
    <div class="reward-subtitle">Milestone reached. You earned this.</div>
  `;
  showRewardOverlay(5000);
}

function triggerVolumeAnimation(n) {
  const overlay = document.getElementById('reward-overlay');
  const content = document.getElementById('reward-content');
  overlay.className = 'reward-overlay volume';
  content.innerHTML = `
    <i class="fa-solid fa-paper-plane reward-icon" style="color:#FFF8DC"></i>
    <div class="reward-number gold-text" id="vol-counter">0</div>
    <div class="reward-title">Total Outreaches</div>
    <div class="reward-subtitle">Volume compounds. Keep going.</div>
  `;
  showRewardOverlay(4000);
  // Count up
  const el = document.getElementById('vol-counter');
  if (el) countUpNumber(el, n, 2000);
}

function showRewardOverlay(duration) {
  const overlay = document.getElementById('reward-overlay');
  overlay.classList.remove('hidden');
  initRewardCanvas();
  spawnParticles();

  const dismiss = () => { hideRewardOverlay(); };
  overlay.addEventListener('click', dismiss, { once: true });
  setTimeout(dismiss, duration);
}

function hideRewardOverlay() {
  const overlay = document.getElementById('reward-overlay');
  overlay.classList.add('hidden');
  cancelAnimationFrame(rewardAnimId);
  rewardParticles = [];
  if (rewardCtx && rewardCanvas) {
    rewardCtx.clearRect(0, 0, rewardCanvas.width, rewardCanvas.height);
  }
}

function initRewardCanvas() {
  rewardCanvas = document.getElementById('reward-canvas');
  rewardCtx = rewardCanvas.getContext('2d');
  rewardCanvas.width = window.innerWidth;
  rewardCanvas.height = window.innerHeight;
}

function spawnParticles() {
  rewardParticles = [];
  const count = 80;
  for (let i = 0; i < count; i++) {
    rewardParticles.push({
      x: Math.random() * rewardCanvas.width,
      y: rewardCanvas.height + Math.random() * 50,
      vx: (Math.random() - 0.5) * 4,
      vy: -(Math.random() * 6 + 3),
      alpha: 1,
      size: Math.random() * 5 + 2,
      color: ['#FFD700', '#D4AF37', '#FFF8DC', '#B8860B', '#ffffff'][Math.floor(Math.random() * 5)],
      rotation: Math.random() * Math.PI * 2,
      rotSpeed: (Math.random() - 0.5) * 0.2,
    });
  }
  animateParticles();
}

function animateParticles() {
  if (!rewardCtx) return;
  rewardCtx.clearRect(0, 0, rewardCanvas.width, rewardCanvas.height);
  rewardParticles = rewardParticles.filter(p => p.alpha > 0.02);
  rewardParticles.forEach(p => {
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.12; // gravity
    p.alpha -= 0.012;
    p.rotation += p.rotSpeed;
    rewardCtx.save();
    rewardCtx.globalAlpha = Math.max(0, p.alpha);
    rewardCtx.translate(p.x, p.y);
    rewardCtx.rotate(p.rotation);
    rewardCtx.fillStyle = p.color;
    rewardCtx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
    rewardCtx.restore();
  });
  if (rewardParticles.length > 0) {
    rewardAnimId = requestAnimationFrame(animateParticles);
  }
}

// ─── Toast ────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, type = '') {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = 'toast'; }, 2800);
}

// ─── Modal ────────────────────────────────────────────────────
function showModal(html) {
  document.getElementById('modal-body').innerHTML = html;
  document.getElementById('modal-backdrop').classList.remove('hidden');
}

function hideModal() {
  document.getElementById('modal-backdrop').classList.add('hidden');
}

document.getElementById('modal-backdrop').addEventListener('click', e => {
  if (e.target.id === 'modal-backdrop') hideModal();
});

// ─── Navigation ───────────────────────────────────────────────
let currentPage = 'home';
const navTabs = document.querySelectorAll('.nav-tab');
const pages = document.querySelectorAll('.page');

function navigateTo(page) {
  if (page === currentPage) return;
  currentPage = page;

  navTabs.forEach(tab => {
    const active = tab.dataset.page === page;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active);
  });

  pages.forEach(p => {
    const active = p.id === `page-${page}`;
    p.classList.toggle('active', active);
    p.style.display = active ? 'block' : 'none';
    if (active) {
      // Trigger re-paint then animate in
      requestAnimationFrame(() => {
        p.style.opacity = '1';
        p.style.transform = 'translateY(0)';
      });
    }
  });

  if (page === 'insights') renderInsights();
  if (page === 'settings') renderSettings();
  if (page === 'log') renderLog();
  if (page === 'home') renderHome();
}

navTabs.forEach(tab => {
  tab.addEventListener('click', () => navigateTo(tab.dataset.page));
});

// Init page display
pages.forEach(p => {
  if (!p.classList.contains('active')) p.style.display = 'none';
  else { p.style.opacity = '1'; p.style.transform = 'translateY(0)'; }
});

// ─── Countdown Timer ──────────────────────────────────────────
let countdownInterval;

function updateCountdown() {
  const display = document.getElementById('countdown-display');
  const section = document.getElementById('countdown-section');
  if (!display) return;

  const now = new Date();
  const todaySessions = appData.sessions.filter(s => s.date === todayStr() && s.dataLogged);

  // Hide if already logged a session today
  if (todaySessions.length > 0 || activeSession()) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');

  const cutoff = new Date();
  cutoff.setHours(SESSION_CUTOFF_HOUR, 0, 0, 0);
  const diff = cutoff - now;

  if (diff <= 0) {
    display.textContent = 'Outreach window closed for today';
    display.className = 'countdown-display closed';
    return;
  }

  display.className = 'countdown-display';
  const h = String(Math.floor(diff / 3600000)).padStart(2, '0');
  const m = String(Math.floor((diff % 3600000) / 60000)).padStart(2, '0');
  const s = String(Math.floor((diff % 60000) / 1000)).padStart(2, '0');
  display.textContent = `${h}:${m}:${s}`;
}

// ─── Active Session Ticker ─────────────────────────────────────
let sessionTickInterval;

function startTicker() {
  clearInterval(sessionTickInterval);
  sessionTickInterval = setInterval(() => {
    const active = activeSession();
    const banner = document.getElementById('active-session-banner');
    const elapsedEl = document.getElementById('active-session-elapsed');
    if (active && banner && elapsedEl) {
      banner.classList.remove('hidden');
      elapsedEl.textContent = fmtDuration(elapsed(active.startTime));
    } else if (banner) {
      banner.classList.add('hidden');
    }
    // Auto-close check
    autoCloseSessions();
  }, 1000);
}

// ─── Build Log Form Fields HTML ───────────────────────────────
const LOG_FIELDS = [
  { key: 'outreaches', label: 'Outreaches', helper: 'Total number of people you sent a cold message to this session' },
  { key: 'nos', label: "Explicit No's", helper: 'Prospects who clearly declined or said not interested' },
  { key: 'demoRequests', label: 'Demo Requests', helper: 'Prospects who asked to see a demo of your work' },
  { key: 'followUpsSent', label: 'Post-Demo Follow-Ups Sent', helper: 'Follow-up messages sent to prospects after showing a demo' },
  { key: 'followUpResponses', label: 'Post-Demo Follow-Up Responses', helper: 'Responses received from post-demo follow-ups' },
  { key: 'continuedConversations', label: 'Continued Conversations', helper: 'Prospects who replied and kept the conversation going without you prompting' },
  { key: 'closes', label: 'Closes', helper: 'Prospects who agreed to pay / become a client' },
];

function buildFormFieldsHTML(values = {}) {
  return LOG_FIELDS.map(f => `
    <div class="form-group">
      <label for="field-${f.key}">${f.label}</label>
      <span class="helper-text-label">${f.helper}</span>
      <input type="number" id="field-${f.key}" class="form-input" min="0" value="${values[f.key] || 0}" inputmode="numeric" />
    </div>
  `).join('') + `
    <div class="form-group">
      <label for="field-notes">Notes <span class="optional">(optional)</span></label>
      <textarea id="field-notes" class="form-input" placeholder="Any context worth remembering...">${values.notes || ''}</textarea>
    </div>
  `;
}

function readFormValues(prefix = 'field') {
  const data = {};
  LOG_FIELDS.forEach(f => {
    const el = document.getElementById(`${prefix}-${f.key}`);
    data[f.key] = el ? Math.max(0, parseInt(el.value) || 0) : 0;
  });
  data.notes = (document.getElementById(`${prefix}-notes`) || {}).value || '';
  return data;
}

// ─── Render: Home ─────────────────────────────────────────────
function renderHome() {
  // Header date
  const dateEl = document.getElementById('header-date');
  if (dateEl) {
    const d = new Date();
    dateEl.textContent = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  }

  // Streak
  recalcStreak();
  const streakHero = document.getElementById('streak-hero');
  const streakNum = document.getElementById('streak-number');
  const streakLabel = document.getElementById('streak-label');
  const streakMsg = document.getElementById('streak-status-msg');
  const streakFlame = document.getElementById('streak-flame-icon');

  if (streakNum) streakNum.textContent = appData.streak.current;

  streakHero.classList.remove('at-risk', 'freeze-active');
  streakMsg.classList.add('hidden');

  if (appData.streak.freezeActive) {
    streakHero.classList.add('freeze-active');
    streakFlame.className = 'fa-solid fa-shield streak-flame';
    streakFlame.style.color = '#D4AF37';
    streakMsg.innerHTML = '<i class="fa-solid fa-shield"></i> Streak Freeze Active';
    streakMsg.style.color = 'var(--gold-solid)';
    streakMsg.classList.remove('hidden');
  } else if (appData.streak.protectionMode) {
    streakHero.classList.add('at-risk');
    streakFlame.className = 'fa-solid fa-triangle-exclamation streak-flame';
    streakFlame.style.color = 'var(--danger)';
    streakMsg.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Streak at Risk';
    streakMsg.style.color = 'var(--danger)';
    streakMsg.classList.remove('hidden');
    if (streakLabel) streakLabel.textContent = 'Day Streak';
  } else {
    streakFlame.className = 'fa-solid fa-fire streak-flame';
    streakFlame.style.color = '';
  }

  // Pending warning
  const pending = pendingSessions();
  const pwarn = document.getElementById('pending-warning');
  if (pending.length >= MAX_PENDING) {
    pwarn.innerHTML = '<i class="fa-solid fa-ban"></i> Log data before starting a new session';
    pwarn.className = 'pending-warning red card';
    pwarn.classList.remove('hidden');
  } else if (pending.length > 0) {
    pwarn.innerHTML = `<i class="fa-solid fa-clock"></i> ${pending.length} session${pending.length > 1 ? 's' : ''} awaiting data`;
    pwarn.className = 'pending-warning amber card';
    pwarn.classList.remove('hidden');
  } else {
    pwarn.classList.add('hidden');
  }

  // Today summary
  const today = todayStr();
  const todaySessions = appData.sessions.filter(s => s.date === today && s.dataLogged);
  const todayOut = todaySessions.reduce((t, s) => t + (s.outreaches || 0), 0);
  const todayTime = todaySessions.reduce((t, s) => t + (s.duration || 0), 0);
  const todayDemos = todaySessions.reduce((t, s) => t + (s.demoRequests || 0), 0);
  const todayCloses = todaySessions.reduce((t, s) => t + (s.closes || 0), 0);
  const hasData = todaySessions.length > 0;

  const setEl = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
  const setHidden = (id, hidden) => { const e = document.getElementById(id); if (e) e.classList.toggle('hidden', hidden); };

  if (hasData) {
    setEl('today-outreaches', todayOut);
    setEl('today-time', fmtDurationShort(todayTime));
    setEl('today-demos', todayDemos);
    setEl('today-closes', todayCloses);
    setHidden('today-empty', true);
    setHidden('goal-progress-wrap', false);
    // Goal bar
    const target = appData.settings.dailyTarget || 20;
    const pct = Math.min(100, Math.round((todayOut / target) * 100));
    const bar = document.getElementById('goal-bar');
    const goalText = document.getElementById('goal-progress-text');
    if (bar) bar.style.width = pct + '%';
    if (goalText) goalText.textContent = `${todayOut} / ${target}`;
  } else {
    setEl('today-outreaches', '—');
    setEl('today-time', '—');
    setEl('today-demos', '—');
    setEl('today-closes', '—');
    setHidden('today-empty', false);
    setHidden('goal-progress-wrap', true);
  }

  // Quick Stats
  const allSessions = appData.sessions.filter(s => s.dataLogged);
  // 7-day avg
  const sevenDaysAgo = new Date(); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const sevenDayStr = dateStr(sevenDaysAgo);
  const last7 = allSessions.filter(s => s.date >= sevenDayStr);
  const last7Total = last7.reduce((t, s) => t + (s.outreaches || 0), 0);
  const avg7 = last7Total > 0 ? (last7Total / 7).toFixed(1) : '—';

  // Best day
  const byDate = {};
  allSessions.forEach(s => { byDate[s.date] = (byDate[s.date] || 0) + (s.outreaches || 0); });
  const bestDay = Object.entries(byDate).sort((a, b) => b[1] - a[1])[0];

  const alltimeTotal = allSessions.reduce((t, s) => t + (s.outreaches || 0), 0);

  setEl('qs-avg7', avg7);
  setEl('qs-best', bestDay ? bestDay[1] : '—');
  setEl('qs-alltime', alltimeTotal || '—');

  // Start session button
  const btn = document.getElementById('start-session-btn');
  if (btn) {
    const isRunning = !!activeSession();
    const blocked = pending.length >= MAX_PENDING || new Date().getHours() >= SESSION_CUTOFF_HOUR;
    btn.disabled = blocked || isRunning;
    btn.innerHTML = isRunning
      ? '<i class="fa-solid fa-circle-dot"></i><span>Session Running…</span>'
      : '<i class="fa-solid fa-play"></i><span>Start Session</span>';
  }
}

// ─── Render: Log ──────────────────────────────────────────────
let activeLogSessionId = null;

function renderLog() {
  const pending = pendingSessions();
  const queueEl = document.getElementById('pending-queue');
  const emptyEl = document.getElementById('pending-empty');

  if (pending.length === 0) {
    queueEl.innerHTML = '';
    emptyEl.classList.remove('hidden');
  } else {
    emptyEl.classList.add('hidden');
    queueEl.innerHTML = pending.map(s => `
      <div class="pending-card" data-id="${s.id}">
        <div class="pending-card-header">
          <div>
            <div class="pending-card-date">${fmtDate(s.date)}</div>
            <div class="pending-card-meta">${s.isSessionless ? 'Sessionless log' : 'Timed session'}</div>
          </div>
          <span class="status-badge ${s.status}">${s.status === 'auto-closed' ? 'Auto-closed' : 'Pending'}</span>
        </div>
        <div class="pending-card-time">
          ${s.startTime ? fmtTime(s.startTime) : '—'} →
          ${s.endTime ? fmtTime(s.endTime) : 'Still running'} ·
          ${fmtDuration(sessionDuration(s))}
        </div>
        <button class="btn-primary full-width log-data-btn" data-id="${s.id}">
          <i class="fa-solid fa-pen-to-square"></i> Log Data
        </button>
      </div>
    `).join('');

    queueEl.querySelectorAll('.log-data-btn').forEach(btn => {
      btn.addEventListener('click', () => openLogForm(btn.dataset.id));
    });
  }

  // Log form state
  if (activeLogSessionId) {
    openLogForm(activeLogSessionId);
  } else {
    document.getElementById('log-form-section').classList.add('hidden');
  }

  renderSessionHistory();
  buildSessionlessFields();
}

function openLogForm(sessionId) {
  activeLogSessionId = sessionId;
  const session = appData.sessions.find(s => s.id === sessionId);
  if (!session) return;

  const formSection = document.getElementById('log-form-section');
  const refEl = document.getElementById('log-form-session-ref');
  const fieldsEl = document.getElementById('log-form-fields');

  formSection.classList.remove('hidden');
  refEl.innerHTML = `
    <strong>${fmtDate(session.date)}</strong><br/>
    ${session.startTime ? fmtTime(session.startTime) : '—'} → ${session.endTime ? fmtTime(session.endTime) : 'ongoing'}<br/>
    Duration: ${fmtDuration(sessionDuration(session))}
  `;
  fieldsEl.innerHTML = buildFormFieldsHTML(session);
  formSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

document.getElementById('log-form-save').addEventListener('click', () => {
  if (!activeLogSessionId) return;
  const data = readFormValues();
  logSessionData(activeLogSessionId, data);
  activeLogSessionId = null;
  document.getElementById('log-form-section').classList.add('hidden');
  renderLog();
});

document.getElementById('log-form-cancel').addEventListener('click', () => {
  activeLogSessionId = null;
  document.getElementById('log-form-section').classList.add('hidden');
});

function buildSessionlessFields() {
  document.getElementById('sessionless-fields').innerHTML = buildFormFieldsHTML();
}

document.getElementById('sessionless-toggle').addEventListener('click', () => {
  const btn = document.getElementById('sessionless-toggle');
  const section = document.getElementById('sessionless-section');
  const expanded = btn.getAttribute('aria-expanded') === 'true';
  btn.setAttribute('aria-expanded', !expanded);
  section.classList.toggle('hidden', expanded);
});

document.getElementById('sessionless-save').addEventListener('click', () => {
  const startTime = document.getElementById('sl-start').value;
  const endTime = document.getElementById('sl-end').value;
  const formData = readFormValues('field');
  logSessionlessData(formData, startTime, endTime);
  document.getElementById('sl-start').value = '';
  document.getElementById('sl-end').value = '';
  buildSessionlessFields();
  document.getElementById('sessionless-section').classList.add('hidden');
  document.getElementById('sessionless-toggle').setAttribute('aria-expanded', 'false');
});

function renderSessionHistory() {
  const histEl = document.getElementById('session-history');
  const histEmpty = document.getElementById('history-empty');
  const sessions = appData.sessions.filter(s => s.dataLogged).sort((a, b) => new Date(b.startTime || b.date) - new Date(a.startTime || a.date));

  if (!sessions.length) {
    histEl.innerHTML = '';
    histEmpty.classList.remove('hidden');
    return;
  }
  histEmpty.classList.add('hidden');
  histEl.innerHTML = sessions.map(s => `
    <div class="history-card" data-id="${s.id}">
      <div class="history-card-summary">
        <div class="history-card-main">
          <div class="history-card-date">${fmtDate(s.date)}</div>
          <div class="history-card-meta">${s.isSessionless ? 'Sessionless' : fmtTime(s.startTime) + ' → ' + fmtTime(s.endTime)} · ${fmtDuration(s.duration)}</div>
        </div>
        <div class="history-card-stats">
          <div class="history-stat">
            <span class="history-stat-val">${s.outreaches || 0}</span>
            <span class="history-stat-lbl">Out.</span>
          </div>
          <div class="history-stat">
            <span class="history-stat-val">${s.closes || 0}</span>
            <span class="history-stat-lbl">Close</span>
          </div>
        </div>
        <span class="status-badge ${s.isSessionless ? 'sessionless' : 'complete'}">${s.isSessionless ? 'SL' : 'Done'}</span>
        <i class="fa-solid fa-chevron-down history-card-expand-icon"></i>
      </div>
      <div class="history-card-details">
        Outreaches: ${s.outreaches||0} · No's: ${s.nos||0} · Demos: ${s.demoRequests||0}<br/>
        Follow-ups sent: ${s.followUpsSent||0} · F/U Responses: ${s.followUpResponses||0}<br/>
        Continued convos: ${s.continuedConversations||0} · Closes: ${s.closes||0}<br/>
        ${s.notes ? `<em style="color:var(--text-muted);font-size:0.75rem">${s.notes}</em>` : ''}
      </div>
    </div>
  `).join('');

  histEl.querySelectorAll('.history-card').forEach(card => {
    card.querySelector('.history-card-summary').addEventListener('click', () => {
      card.classList.toggle('expanded');
    });
  });
}

// ─── Render: Insights ─────────────────────────────────────────
let insightsPeriod = 7;
let chartInstances = {};

function getInsightsSessions(period) {
  const all = appData.sessions.filter(s => s.dataLogged);
  if (period === 'all') return all;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - parseInt(period));
  const cutoffStr = dateStr(cutoff);
  return all.filter(s => s.date >= cutoffStr);
}

function destroyChart(id) {
  if (chartInstances[id]) { chartInstances[id].destroy(); delete chartInstances[id]; }
}

function renderInsights() {
  const sessions = getInsightsSessions(insightsPeriod);
  const total = sessions.reduce((t, s) => t + (s.outreaches || 0), 0);
  const closes = sessions.reduce((t, s) => t + (s.closes || 0), 0);
  const demos = sessions.reduce((t, s) => t + (s.demoRequests || 0), 0);
  const demoRate = total ? ((demos / total) * 100).toFixed(1) + '%' : '0%';
  const closeRate = total ? ((closes / total) * 100).toFixed(1) + '%' : '0%';

  animateKPI('kpi-outreaches', total);
  animateKPI('kpi-closes', closes);
  document.getElementById('kpi-demo-rate').textContent = demoRate;
  document.getElementById('kpi-close-rate').textContent = closeRate;

  // Streak block
  recalcStreak();
  const allDates = allLoggedDates();
  const totalDays = allDates.length;
  const allLoggedTotal = appData.sessions.filter(s => s.dataLogged).length;
  const daysSinceFirst = allDates.length > 0
    ? Math.ceil((new Date() - new Date(allDates[0] + 'T00:00:00')) / (1000 * 60 * 60 * 24)) + 1
    : 0;

  document.getElementById('ins-current-streak').textContent = appData.streak.current;
  document.getElementById('ins-longest-streak').textContent = appData.streak.longest;
  document.getElementById('ins-active-ratio').textContent = `${totalDays}/${daysSinceFirst}`;
  renderDonutChart(totalDays, daysSinceFirst);

  renderVolumeChart(sessions);
  renderOutcomeChart(sessions);
  renderFunnelChart(sessions);
  renderTimeChart(sessions);
  renderHoursChart(sessions);
  renderWeeklySummary(sessions);
  renderDataTable(sessions);
}

function animateKPI(id, val) {
  const el = document.getElementById(id);
  if (el) countUpNumber(el, val, 700);
}

function renderDonutChart(active, total) {
  destroyChart('donut');
  const canvas = document.getElementById('donut-chart');
  if (!canvas) return;
  const inactive = Math.max(0, total - active);
  chartInstances['donut'] = new Chart(canvas.getContext('2d'), {
    type: 'doughnut',
    data: {
      datasets: [{
        data: [active, inactive],
        backgroundColor: ['#D4AF37', '#222222'],
        borderWidth: 0,
      }]
    },
    options: {
      responsive: false,
      cutout: '70%',
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      animation: { duration: 600 }
    }
  });
}

function groupByDate(sessions, key) {
  const map = {};
  sessions.forEach(s => {
    map[s.date] = (map[s.date] || 0) + (s[key] || 0);
  });
  return map;
}

function getDaysRange(sessions, period) {
  const days = [];
  const n = period === 'all' ? 30 : parseInt(period);
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    days.push(dateStr(d));
  }
  return days;
}

const CHART_DEFAULTS = {
  responsive: true,
  maintainAspectRatio: true,
  aspectRatio: 2.2,
  plugins: {
    legend: {
      labels: { color: '#A09880', font: { family: "'DM Sans'", size: 11 }, boxWidth: 10, padding: 12 }
    },
    tooltip: {
      backgroundColor: '#1C1C1C',
      borderColor: 'rgba(212,175,55,0.3)',
      borderWidth: 1,
      titleColor: '#F5F0E8',
      bodyColor: '#A09880',
      padding: 10,
    }
  },
  scales: {
    x: {
      grid: { color: 'rgba(255,255,255,0.04)' },
      ticks: { color: '#5A5040', font: { family: "'DM Sans'", size: 10 }, maxRotation: 45 }
    },
    y: {
      grid: { color: 'rgba(255,255,255,0.04)' },
      ticks: { color: '#5A5040', font: { family: "'JetBrains Mono'", size: 10 } },
      beginAtZero: true
    }
  }
};

function renderVolumeChart(sessions) {
  destroyChart('volume');
  const canvas = document.getElementById('volume-chart');
  if (!canvas) return;
  const days = getDaysRange(sessions, insightsPeriod);
  const byDate = groupByDate(sessions, 'outreaches');
  const labels = days.map(d => d.slice(5));
  const data = days.map(d => byDate[d] || 0);
  const target = appData.settings.dailyTarget || 20;
  const rolling7 = data.map((_, i) => {
    const slice = data.slice(Math.max(0, i - 6), i + 1);
    return (slice.reduce((a, b) => a + b, 0) / slice.length).toFixed(1);
  });

  chartInstances['volume'] = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Outreaches',
          data,
          borderColor: '#D4AF37',
          backgroundColor: 'rgba(212,175,55,0.08)',
          fill: true,
          tension: 0.4,
          pointBackgroundColor: '#D4AF37',
          pointRadius: 3,
          borderWidth: 2,
        },
        {
          label: '7-Day Avg',
          data: rolling7,
          borderColor: 'rgba(212,175,55,0.3)',
          backgroundColor: 'transparent',
          borderDash: [4, 4],
          tension: 0.4,
          pointRadius: 0,
          borderWidth: 1.5,
        },
        {
          label: 'Target',
          data: days.map(() => target),
          borderColor: 'rgba(192,57,43,0.4)',
          backgroundColor: 'transparent',
          borderDash: [6, 3],
          pointRadius: 0,
          borderWidth: 1,
        }
      ]
    },
    options: { ...CHART_DEFAULTS, animation: { duration: 700 } }
  });
}

function renderOutcomeChart(sessions) {
  destroyChart('outcome');
  const canvas = document.getElementById('outcome-chart');
  if (!canvas) return;
  const days = getDaysRange(sessions, insightsPeriod);
  const labels = days.map(d => d.slice(5));
  const mkData = key => days.map(d => sessions.filter(s => s.date === d).reduce((t, s) => t + (s[key] || 0), 0));

  chartInstances['outcome'] = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: "No's", data: mkData('nos'), backgroundColor: 'rgba(192,57,43,0.6)', borderRadius: 4 },
        { label: 'Demos', data: mkData('demoRequests'), backgroundColor: 'rgba(212,175,55,0.7)', borderRadius: 4 },
        { label: 'Convos', data: mkData('continuedConversations'), backgroundColor: 'rgba(39,174,96,0.6)', borderRadius: 4 },
        { label: 'Closes', data: mkData('closes'), backgroundColor: 'rgba(255,215,0,0.9)', borderRadius: 4 },
      ]
    },
    options: { ...CHART_DEFAULTS, scales: { ...CHART_DEFAULTS.scales, x: { ...CHART_DEFAULTS.scales.x, stacked: false } } }
  });
}

function renderFunnelChart(sessions) {
  destroyChart('funnel');
  const canvas = document.getElementById('funnel-chart');
  if (!canvas) return;
  const sum = key => sessions.reduce((t, s) => t + (s[key] || 0), 0);
  const stages = [
    { label: 'Outreaches', val: sum('outreaches') },
    { label: 'Demo Requests', val: sum('demoRequests') },
    { label: 'Follow-Ups', val: sum('followUpsSent') },
    { label: 'FU Responses', val: sum('followUpResponses') },
    { label: 'Closes', val: sum('closes') },
  ];

  chartInstances['funnel'] = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: stages.map(s => s.label),
      datasets: [{
        label: 'Count',
        data: stages.map(s => s.val),
        backgroundColor: stages.map((_, i) => `rgba(212,175,55,${0.9 - i * 0.15})`),
        borderRadius: 6,
      }]
    },
    options: {
      ...CHART_DEFAULTS,
      indexAxis: 'y',
      plugins: { ...CHART_DEFAULTS.plugins, legend: { display: false } },
      scales: {
        x: { ...CHART_DEFAULTS.scales.x },
        y: { ...CHART_DEFAULTS.scales.y, grid: { display: false } }
      }
    }
  });
}

function renderTimeChart(sessions) {
  destroyChart('time');
  const canvas = document.getElementById('time-chart');
  if (!canvas) return;
  const days = getDaysRange(sessions, insightsPeriod);
  const labels = days.map(d => d.slice(5));
  const data = days.map(d => {
    const mins = sessions.filter(s => s.date === d).reduce((t, s) => t + (s.duration || 0), 0);
    return (mins / 60).toFixed(2);
  });

  chartInstances['time'] = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Hours',
        data,
        borderColor: '#FFD700',
        backgroundColor: 'rgba(255,215,0,0.07)',
        fill: true,
        tension: 0.4,
        pointRadius: 3,
        pointBackgroundColor: '#FFD700',
        borderWidth: 2,
      }]
    },
    options: { ...CHART_DEFAULTS }
  });
}

function renderHoursChart(sessions) {
  destroyChart('hours');
  const canvas = document.getElementById('hours-chart');
  const placeholder = document.getElementById('hours-placeholder');
  if (!canvas) return;

  if (sessions.length < 5) {
    canvas.classList.add('hidden');
    placeholder.classList.remove('hidden');
    return;
  }
  canvas.classList.remove('hidden');
  placeholder.classList.add('hidden');

  const hourBuckets = Array(24).fill(0);
  sessions.forEach(s => {
    if (!s.startTime) return;
    const hour = new Date(s.startTime).getHours();
    hourBuckets[hour] += (s.demoRequests || 0) + (s.closes || 0);
  });

  const labels = hourBuckets.map((_, i) => `${String(i).padStart(2,'0')}:00`);
  chartInstances['hours'] = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Demos + Closes',
        data: hourBuckets,
        backgroundColor: 'rgba(212,175,55,0.65)',
        borderRadius: 4,
      }]
    },
    options: {
      ...CHART_DEFAULTS,
      indexAxis: 'y',
      plugins: { ...CHART_DEFAULTS.plugins, legend: { display: false } },
      scales: {
        x: { ...CHART_DEFAULTS.scales.x },
        y: {
          ...CHART_DEFAULTS.scales.y,
          grid: { display: false },
          ticks: { ...CHART_DEFAULTS.scales.y.ticks, font: { family: "'JetBrains Mono'", size: 9 } }
        }
      }
    }
  });
}

function renderWeeklySummary(sessions) {
  const el = document.getElementById('weekly-summary-text');
  if (!el || !sessions.length) {
    if (el) el.textContent = 'No data for this period yet.';
    return;
  }
  const period = insightsPeriod === 'all' ? 'all time' : `last ${insightsPeriod} days`;
  const totalOut = sessions.reduce((t, s) => t + (s.outreaches || 0), 0);
  const totalCloses = sessions.reduce((t, s) => t + (s.closes || 0), 0);
  const totalDemos = sessions.reduce((t, s) => t + (s.demoRequests || 0), 0);
  const totalMins = sessions.reduce((t, s) => t + (s.duration || 0), 0);
  const uniqueDays = new Set(sessions.map(s => s.date)).size;
  const avgTime = sessions.length ? fmtDurationShort(totalMins / sessions.length) : '—';
  const demoRate = totalOut ? ((totalDemos / totalOut) * 100).toFixed(1) : '0';
  const closeRate = totalOut ? ((totalCloses / totalOut) * 100).toFixed(1) : '0';

  el.textContent = `Over the ${period}, you completed ${sessions.length} session${sessions.length !== 1 ? 's' : ''} across ${uniqueDays} active day${uniqueDays !== 1 ? 's' : ''}, sending ${totalOut} outreaches. Your demo request rate was ${demoRate}% and close rate was ${closeRate}%, resulting in ${totalCloses} close${totalCloses !== 1 ? 's' : ''}. Average session time: ${avgTime}.`;
}

function renderDataTable(sessions) {
  const tbody = document.getElementById('data-table-body');
  const tfoot = document.getElementById('data-table-foot');
  const empty = document.getElementById('table-empty');

  if (!sessions.length) {
    if (tbody) tbody.innerHTML = '';
    if (tfoot) tfoot.innerHTML = '';
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');

  const sorted = [...sessions].sort((a, b) => new Date(b.startTime || b.date) - new Date(a.startTime || a.date));

  tbody.innerHTML = sorted.map(s => `
    <tr data-id="${s.id}">
      <td>${s.date}</td>
      <td>${fmtTime(s.startTime)}</td>
      <td>${fmtTime(s.endTime)}</td>
      <td>${fmtDurationShort(s.duration)}</td>
      <td>${s.outreaches||0}</td>
      <td>${s.nos||0}</td>
      <td>${s.demoRequests||0}</td>
      <td>${s.followUpsSent||0}</td>
      <td>${s.followUpResponses||0}</td>
      <td>${s.continuedConversations||0}</td>
      <td>${s.closes||0}</td>
      <td style="max-width:80px;overflow:hidden;text-overflow:ellipsis">${s.notes||''}</td>
      <td><button class="btn-edit-row" data-id="${s.id}" title="Edit row"><i class="fa-solid fa-pen"></i></button></td>
    </tr>
  `).join('');

  // Totals row
  const tot = (key) => sorted.reduce((t, s) => t + (s[key] || 0), 0);
  tfoot.innerHTML = `
    <tr>
      <td colspan="4">Totals</td>
      <td>${tot('outreaches')}</td>
      <td>${tot('nos')}</td>
      <td>${tot('demoRequests')}</td>
      <td>${tot('followUpsSent')}</td>
      <td>${tot('followUpResponses')}</td>
      <td>${tot('continuedConversations')}</td>
      <td>${tot('closes')}</td>
      <td colspan="2"></td>
    </tr>
  `;

  // Inline edit
  tbody.querySelectorAll('.btn-edit-row').forEach(btn => {
    btn.addEventListener('click', () => openInlineEdit(btn.dataset.id));
  });
}

function openInlineEdit(sessionId) {
  const session = appData.sessions.find(s => s.id === sessionId);
  if (!session) return;
  const row = document.querySelector(`#data-table-body tr[data-id="${sessionId}"]`);
  if (!row) return;

  if (row.classList.contains('inline-edit-row')) {
    // Save
    const getValue = (key) => parseInt(row.querySelector(`input[data-key="${key}"]`)?.value || 0);
    LOG_FIELDS.forEach(f => { session[f.key] = getValue(f.key); });
    session.notes = row.querySelector('input[data-key="notes"]')?.value || session.notes;
    save();
    recalcStreak();
    renderInsights();
    showToast('Row updated', 'success');
    return;
  }

  row.classList.add('inline-edit-row');
  const cells = row.querySelectorAll('td');
  const keys = ['outreaches', 'nos', 'demoRequests', 'followUpsSent', 'followUpResponses', 'continuedConversations', 'closes', 'notes'];
  keys.forEach((key, i) => {
    const td = cells[i + 4];
    if (!td) return;
    td.innerHTML = `<input type="${key === 'notes' ? 'text' : 'number'}" data-key="${key}" value="${session[key] || 0}" min="0" style="width:${key==='notes'?'70px':'50px'}" />`;
  });
  const editBtn = cells[cells.length - 1].querySelector('.btn-edit-row');
  if (editBtn) editBtn.innerHTML = '<i class="fa-solid fa-check" style="color:var(--success)"></i>';
}

// Period selector
document.querySelectorAll('.period-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.period-btn').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    insightsPeriod = btn.dataset.period;
    renderInsights();
  });
});

// ─── Data Export / Import ─────────────────────────────────────
document.getElementById('export-all-btn').addEventListener('click', () => {
  exportData(appData.sessions, 'outreach-data-all');
});

document.getElementById('export-range-btn').addEventListener('click', () => {
  const start = document.getElementById('export-start').value;
  const end = document.getElementById('export-end').value;
  if (!start || !end) { showToast('Select a date range', 'error'); return; }
  const filtered = { ...appData, sessions: appData.sessions.filter(s => s.date >= start && s.date <= end) };
  exportData(filtered.sessions, `outreach-data-${start}-${end}`);
});

function exportData(sessions, filename) {
  const blob = new Blob([JSON.stringify({ ...appData, sessions }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename + '.json';
  a.click();
  showToast('Data exported', 'success');
}

document.getElementById('import-btn').addEventListener('click', () => {
  document.getElementById('import-file-input').click();
});

document.getElementById('import-file-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const imported = JSON.parse(ev.target.result);
      if (!imported.sessions || !Array.isArray(imported.sessions)) throw new Error('Invalid format');
      let added = 0;
      const existingIds = new Set(appData.sessions.map(s => s.id));
      imported.sessions.forEach(s => {
        if (!existingIds.has(s.id)) { appData.sessions.push(s); added++; }
      });
      save();
      recalcStreak();
      renderAll();
      showToast(`Imported ${added} new session${added !== 1 ? 's' : ''}`, 'success');
    } catch (err) {
      showToast('Import failed — invalid JSON', 'error');
    }
    e.target.value = '';
  };
  reader.readAsText(file);
});

document.getElementById('clear-data-btn').addEventListener('click', () => {
  const a = Math.floor(Math.random() * 20) + 5;
  const b = Math.floor(Math.random() * 15) + 2;
  const answer = a + b;
  showModal(`
    <div class="modal-title" style="color:var(--danger)"><i class="fa-solid fa-triangle-exclamation"></i> Clear All Data</div>
    <p class="modal-desc">This will permanently delete all sessions, streak data, and history. This cannot be undone.</p>
    <div class="form-group">
      <label>Solve to confirm: What is ${a} + ${b}?</label>
      <input type="number" id="clear-math" class="form-input" inputmode="numeric" placeholder="Answer" />
    </div>
    <div class="form-group">
      <label>Type DELETE to confirm</label>
      <input type="text" id="clear-confirm" class="form-input" placeholder="DELETE" autocomplete="off" />
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="hideModal()">Cancel</button>
      <button class="btn-danger" id="clear-confirm-btn" disabled>Clear Everything</button>
    </div>
  `);

  const checkReady = () => {
    const mathOk = parseInt(document.getElementById('clear-math')?.value) === answer;
    const confirmOk = document.getElementById('clear-confirm')?.value === 'DELETE';
    const btn = document.getElementById('clear-confirm-btn');
    if (btn) btn.disabled = !(mathOk && confirmOk);
  };

  setTimeout(() => {
    document.getElementById('clear-math')?.addEventListener('input', checkReady);
    document.getElementById('clear-confirm')?.addEventListener('input', checkReady);
    document.getElementById('clear-confirm-btn')?.addEventListener('click', () => {
      appData = defaultData();
      save();
      hideModal();
      renderAll();
      showToast('All data cleared', 'error');
    });
  }, 100);
});

// ─── Render: Settings ─────────────────────────────────────────
function renderSettings() {
  const goalInput = document.getElementById('daily-goal-input');
  if (goalInput) goalInput.value = appData.settings.dailyTarget;

  recalcStreak();
  document.getElementById('settings-current-streak').textContent = appData.streak.current;
  document.getElementById('settings-longest-streak').textContent = appData.streak.longest;

  const notifToggle = document.getElementById('notif-toggle');
  if (notifToggle) notifToggle.checked = appData.settings.notificationsEnabled;

  const reminderInput = document.getElementById('reminder-time-input');
  if (reminderInput) reminderInput.value = appData.settings.reminderTime;
}

// Goal input
document.getElementById('daily-goal-input').addEventListener('change', e => {
  appData.settings.dailyTarget = Math.max(1, parseInt(e.target.value) || 20);
  appData.meta.dailyTarget = appData.settings.dailyTarget;
  save();
  showToast('Goal updated', 'success');
});

document.getElementById('goal-dec').addEventListener('click', () => {
  const el = document.getElementById('daily-goal-input');
  el.value = Math.max(1, parseInt(el.value) - 1);
  el.dispatchEvent(new Event('change'));
});

document.getElementById('goal-inc').addEventListener('click', () => {
  const el = document.getElementById('daily-goal-input');
  el.value = parseInt(el.value) + 1;
  el.dispatchEvent(new Event('change'));
});

// Streak reset
document.getElementById('streak-reset-btn').addEventListener('click', () => {
  showModal(`
    <div class="modal-title">Reset Streak</div>
    <p class="modal-desc">Are you sure you want to manually reset your streak? Your session history will be preserved.</p>
    <div class="form-group">
      <label>Reason (optional)</label>
      <input type="text" id="reset-reason" class="form-input" placeholder="e.g. Took a planned break" />
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="hideModal()">Cancel</button>
      <button class="btn-danger" id="do-streak-reset">Reset Streak</button>
    </div>
  `);
  setTimeout(() => {
    document.getElementById('do-streak-reset')?.addEventListener('click', () => {
      appData.streak.current = 0;
      appData.streak.protectionMode = false;
      appData.streak.freezeActive = false;
      save();
      hideModal();
      renderAll();
      showToast('Streak reset', 'error');
    });
  }, 100);
});

// Notifications
document.getElementById('notif-toggle').addEventListener('change', e => {
  const enabled = e.target.checked;
  if (enabled && 'Notification' in window) {
    Notification.requestPermission().then(perm => {
      appData.settings.notificationsEnabled = perm === 'granted';
      if (perm !== 'granted') {
        e.target.checked = false;
        showToast('Notification permission denied', 'error');
      } else {
        showToast('Reminders enabled', 'success');
      }
      save();
    });
  } else {
    appData.settings.notificationsEnabled = false;
    save();
  }
});

document.getElementById('reminder-time-input').addEventListener('change', e => {
  appData.settings.reminderTime = e.target.value;
  save();
});

// Notifications scheduler
function scheduleNotification() {
  if (!appData.settings.notificationsEnabled) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const [h, m] = (appData.settings.reminderTime || '20:00').split(':').map(Number);
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0);
  if (target <= now) return; // Already past
  const todaySessions = appData.sessions.filter(s => s.date === todayStr() && s.dataLogged);
  if (todaySessions.length > 0) return; // Already logged
  const delay = target - now;
  setTimeout(() => {
    new Notification('Outreach Tracker', {
      body: `Don't let your streak slip! Outreach window closes at 9PM.`,
      icon: 'OT-Logo.png'
    });
  }, delay);
}

// ─── Button Wiring ────────────────────────────────────────────
document.getElementById('start-session-btn').addEventListener('click', () => {
  startSession();
});

document.getElementById('stop-session-btn').addEventListener('click', () => {
  stopSession();
});

// ─── Render All ───────────────────────────────────────────────
function renderAll() {
  renderHome();
  if (currentPage === 'log') renderLog();
  if (currentPage === 'insights') renderInsights();
  if (currentPage === 'settings') renderSettings();
}

// ─── Init ─────────────────────────────────────────────────────
function init() {
  recalcStreak();
  renderAll();
  autoCloseSessions();
  startTicker();
  scheduleNotification();

  // Countdown every second
  updateCountdown();
  setInterval(updateCountdown, 1000);

  // Daily auto-close check every minute
  setInterval(autoCloseSessions, 60000);

  // Rewards check on startup (in case new milestones from imported data)
  setTimeout(checkRewards, 1500);
}

init();
