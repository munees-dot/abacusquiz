/* ═══════════════════════════════════════════════════════════
   QuizMaster Pro – app.js  (Supabase edition)
   Abacus Academy · Admin + Student + Live Quiz Engine
   ─────────────────────────────────────────────────────────
   STEP 1: Paste your Supabase Project URL and anon key below.
           (Supabase Dashboard → Project Settings → API)
═══════════════════════════════════════════════════════════ */

'use strict';

const CONFIG = {
  SUPABASE_URL: 'https://wrzssivgxituefcwobbr.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_3mi5iJCxekZfiyXojUFtQg_gDASyEWm',

  // Students log in with Admission No. Behind the scenes it becomes "<admno>@<this domain>".
  // No email is ever sent. Change only BEFORE students start signing up.
  LOGIN_EMAIL_DOMAIN: 'quiz.edupros.in',

  CENTRES: ['Abacus Academy Puthur Pallikkal', 'Abacus Academy Parambil Peedika'],
  CLASSES: ['5', '6', '7', '8', '9', '10'],
};

// ════════════════════════════════════════════════════════
// GLOBAL STATE
// ════════════════════════════════════════════════════════

let sb = null;                 // Supabase client
let me = null;                 // logged-in profile row
let serverOffset = 0;          // server clock − device clock (ms)
const cache = { subjects: [], chapters: [], questions: [], quizzes: [], attempts: [], profiles: [] };
let myAttempts = [];           // student: own attempts summary
let quizState = null;
let quizTimer = null;
let dashboardTimer = null;
let dashboardRefresh = null;
let currentBulkParsed = [];
let bulkInputDebounce = null;
let selectedColor = '#667eea';
let editingQuestionId = null;
let editingQuizId = null;
let editingStudentId = null;
let currentAdminSection = 'overview';
let questionListLimit = 100;

const ERR = {
  NOT_LOGGED_IN: 'Please sign in again.',
  NOT_APPROVED: 'ടീച്ചർ നിങ്ങളുടെ account ഇതുവരെ approve ചെയ്തിട്ടില്ല.',
  QUIZ_NOT_ACTIVE: 'ഈ quiz ഇപ്പോൾ ലഭ്യമല്ല.',
  NOT_FOR_YOU: 'ഈ quiz നിങ്ങളുടെ ക്ലാസിനുള്ളതല്ല.',
  ALREADY_SUBMITTED: 'നിങ്ങൾ ഈ quiz ഇതിനകം submit ചെയ്തു.',
  TIME_OVER: 'സമയം കഴിഞ്ഞു. നിങ്ങളുടെ ഉത്തരങ്ങൾ submit ചെയ്തു.',
  NOT_STARTED: 'Quiz ഇതുവരെ തുടങ്ങിയിട്ടില്ല.',
  ENTRY_CLOSED: 'Quiz-ൽ കയറാനുള്ള സമയം കഴിഞ്ഞു.',
  QUIZ_CLOSED: 'ഈ quiz അടച്ചു (Close time കഴിഞ്ഞു).',
  NO_QUESTIONS: 'ഈ quiz-ൽ ചോദ്യങ്ങളില്ല.',
  REVIEW_LOCKED: 'Quiz എല്ലാവർക്കും അവസാനിച്ച ശേഷം ഉത്തരങ്ങൾ കാണാം.',
  NOT_SUBMITTED: 'Quiz ഇതുവരെ submit ചെയ്തിട്ടില്ല.',
};

// ════════════════════════════════════════════════════════
// SMALL HELPERS
// ════════════════════════════════════════════════════════

const $ = id => document.getElementById(id);
const val = id => ($(id) ? $(id).value.trim() : '');
const serverNow = () => Date.now() + serverOffset;

function escapeHTML(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtSecs(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function fmtCountdown(ms) {
  let s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const hms = [h, m, s].map(x => String(x).padStart(2, '0')).join(':');
  return d > 0 ? `${d}d ${hms}` : hms;
}

// <input type="datetime-local"> ⇄ ISO
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fromLocalInput(v) { return v ? new Date(v).toISOString() : null; }

function pct(score, total) { return total > 0 ? (score / total) * 100 : 0; }
function fmtPct(p) { return (Math.round(p * 10) / 10) + '%'; }

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Same order every time for the same seed (used for option shuffling)
function seededShuffle(arr, seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) { h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  const rand = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

function optionOrder(questionId, options, shuffle, seed) {
  const keys = ['A', 'B', 'C', 'D'].filter(k => options && String(options[k] || '').trim() !== '');
  return shuffle ? seededShuffle(keys, seed + ':' + questionId) : keys;
}

function downloadCSV(rows, filename) {
  const csv = '﻿' + rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function fillSelect(id, items, { placeholder = null, valueKey = 'id', labelKey = 'name', selected = '' } = {}) {
  const el = $(id);
  if (!el) return;
  const opts = [];
  if (placeholder !== null) opts.push(`<option value="">${escapeHTML(placeholder)}</option>`);
  items.forEach(it => {
    const v = typeof it === 'object' ? it[valueKey] : it;
    const l = typeof it === 'object' ? it[labelKey] : it;
    opts.push(`<option value="${escapeHTML(v)}" ${String(v) === String(selected) ? 'selected' : ''}>${escapeHTML(l)}</option>`);
  });
  el.innerHTML = opts.join('');
}

function setBusy(btn, busy, text) {
  if (!btn) return;
  if (busy) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = text || 'Please wait…'; }
  else { btn.disabled = false; if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
}

// ════════════════════════════════════════════════════════
// TOASTS
// ════════════════════════════════════════════════════════

function showToast(msg, type = 'info') {
  const icons = {
    success: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`,
    error: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
    warning: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
    info: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`
  };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<div class="toast-icon">${icons[type] || icons.info}</div><div class="toast-msg">${escapeHTML(msg)}</div>`;
  $('toast-container').appendChild(toast);
  setTimeout(() => { toast.classList.add('out'); setTimeout(() => toast.remove(), 300); }, type === 'error' ? 5000 : 3000);
}

function dbError(error, fallback = 'Something went wrong.') {
  console.error(error);
  const msg = (error && (error.message || error.error_description)) || fallback;
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return showToast('Network problem. Check internet and try again.', 'error');
  showToast(ERR[msg] || msg, 'error');
}

// ════════════════════════════════════════════════════════
// PAGE / MODAL SYSTEM
// ════════════════════════════════════════════════════════

function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  $(id).classList.add('active');
  window.scrollTo(0, 0);
}

function openModal(id) { $(id).classList.add('open'); }
function closeModal(id) { $(id).classList.remove('open'); }

document.addEventListener('click', e => {
  if (e.target.classList && e.target.classList.contains('modal-overlay') && !e.target.dataset.sticky) {
    e.target.classList.remove('open');
  }
});

function switchLoginTab(tab) {
  document.querySelectorAll('.login-tabs .tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.login-form').forEach(f => f.classList.toggle('active', f.id === `form-${tab}`));
}

function togglePassword(inputId, btn) {
  const el = $(inputId);
  el.type = el.type === 'password' ? 'text' : 'password';
  btn.style.color = el.type === 'text' ? 'var(--purple)' : '';
}

// ════════════════════════════════════════════════════════
// SUPABASE DATA HELPERS
// ════════════════════════════════════════════════════════

async function fetchAll(table, order = 'created_at', ascending = true) {
  const out = [];
  const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await sb.from(table).select('*').order(order, { ascending }).range(from, from + size - 1);
    if (error) throw error;
    out.push(...data);
    if (data.length < size) break;
  }
  return out;
}

async function rpc(fn, args = {}) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw error;
  return data;
}

async function syncServerClock() {
  try {
    const t0 = Date.now();
    const iso = await rpc('qm_server_time');
    const t1 = Date.now();
    serverOffset = new Date(iso).getTime() - (t0 + t1) / 2;
  } catch (e) { serverOffset = 0; }
}

const subjectName = id => (cache.subjects.find(s => s.id === id) || {}).name || '';
const chapterName = id => (cache.chapters.find(c => c.id === id) || {}).name || '';
const profileById = id => cache.profiles.find(p => p.id === id) || {};

// Quiz timing status (same rules as the server)
function quizStatus(q) {
  const now = serverNow();
  const start = q.start_at ? new Date(q.start_at).getTime() : null;
  const close = q.entry_close_at ? new Date(q.entry_close_at).getTime() : null;      // last time to START
  const endAt = q.end_at ? new Date(q.end_at).getTime() : null;                      // quiz closes completely
  const ends = [endAt, close ? close + q.duration_min * 60000 : null].filter(x => x !== null);
  const end = ends.length ? Math.min(...ends) : null;                                 // over for everybody
  const lastStart = [close, endAt].filter(x => x !== null);
  const startBy = lastStart.length ? Math.min(...lastStart) : null;                   // nobody can start after this
  const r = { start, close, end, endAt, startBy };
  if (!q.active) return { key: 'draft', label: 'Off', ...r };
  if (end && now >= end) return { key: 'ended', label: 'Closed', ...r };
  if (start && now < start) return { key: 'scheduled', label: 'Scheduled', ...r };
  if (!startBy || now < startBy) return { key: 'live', label: 'LIVE', ...r };
  return { key: 'closing', label: 'Entry closed', ...r };
}

// ════════════════════════════════════════════════════════
// AUTH
// ════════════════════════════════════════════════════════

function admissionToEmail(adm) {
  const slug = String(adm || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug ? `${slug}@${CONFIG.LOGIN_EMAIL_DOMAIN}` : '';
}

async function signIn() {
  const adm = val('si-adm'), pass = $('si-pass').value;
  if (!adm || !pass) return showToast('Admission No-ഉം password-ഉം നൽകുക.', 'error');
  const btn = $('btn-signin');
  setBusy(btn, true, 'Signing in…');
  const { data, error } = await sb.auth.signInWithPassword({ email: admissionToEmail(adm), password: pass });
  setBusy(btn, false);
  if (error) {
    if (/confirm/i.test(error.message)) return showToast('Supabase-ൽ "Confirm email" ഓഫ് ചെയ്യണം (setup guide നോക്കുക).', 'error');
    if (/Invalid login/i.test(error.message)) return showToast('Admission No അല്ലെങ്കിൽ password തെറ്റാണ്.', 'error');
    return dbError(error);
  }
  await onSession(data.session);
}

// Sign-up: look the admission number up in the Abacus "students" list as the student types
let signupLookup = { adm: '', found: false, taken: false };
let signupLookupTimer = null;

function onSignupAdmInput() {
  clearTimeout(signupLookupTimer);
  const adm = val('su-adm');
  signupLookup = { adm: '', found: false, taken: false };
  renderSignupLookup('');
  if (!adm) return;
  signupLookupTimer = setTimeout(() => lookupAdmission(adm), 450);
}

async function lookupAdmission(adm) {
  renderSignupLookup('checking');
  try {
    const r = await rpc('qm_lookup_admission', { p_adm: adm });
    if (val('su-adm') !== adm) return;            // user kept typing
    signupLookup = { adm, ...r };
    renderSignupLookup(r.taken ? 'taken' : r.found ? 'found' : 'notfound');
  } catch (e) {
    renderSignupLookup('');                        // lookup not available → normal manual form
  }
}

function renderSignupLookup(state) {
  const box = $('su-adm-check'), details = $('su-details');
  const r = signupLookup;
  box.className = 'adm-check ' + state;
  details.style.display = state === 'found' ? 'none' : '';
  if (state === 'checking') box.innerHTML = 'Checking…';
  else if (state === 'found') box.innerHTML = `<b>✓ ${escapeHTML(r.full_name)}</b><span>Class ${escapeHTML(r.class_name)}${r.batch ? ' ' + escapeHTML(r.batch) : ''} · ${escapeHTML(shortCentre(r.centre))}</span><span class="t-muted small">ഇത് നിങ്ങളാണെങ്കിൽ password ഉണ്ടാക്കിയാൽ മതി.</span>`;
  else if (state === 'taken') box.innerHTML = `<b>ഈ Admission No-ൽ account ഉണ്ട്.</b><span>Sign In ചെയ്യുക. നിങ്ങൾ ഉണ്ടാക്കിയതല്ലെങ്കിൽ ടീച്ചറോട് പറയുക.</span>`;
  else if (state === 'notfound') box.innerHTML = `<span>Student list-ൽ ഈ നമ്പർ ഇല്ല. താഴെ വിവരങ്ങൾ നൽകുക. ടീച്ചർ approve ചെയ്യണം.</span>`;
  else box.innerHTML = '';
}

async function signUp() {
  const adm = val('su-adm');
  const listed = signupLookup.found && !signupLookup.taken && signupLookup.adm === adm;
  if (signupLookup.taken && signupLookup.adm === adm) return showToast('ഈ Admission No-ൽ account ഉണ്ട്. Sign In ചെയ്യുക.', 'error');
  const name = listed ? signupLookup.full_name : val('su-name');
  const centre = listed ? signupLookup.centre : val('su-centre');
  const cls = listed ? signupLookup.class_name : val('su-class');
  const batch = listed ? signupLookup.batch : val('su-batch');
  const pass = $('su-pass').value, pass2 = $('su-pass2').value;
  if (!name || !adm || !centre || !cls || !pass) return showToast('എല്ലാ fields-ഉം പൂരിപ്പിക്കുക.', 'error');
  if (!admissionToEmail(adm)) return showToast('Admission No-ൽ അക്ഷരങ്ങളോ അക്കങ്ങളോ വേണം.', 'error');
  if (pass.length < 6) return showToast('Password കുറഞ്ഞത് 6 അക്ഷരം വേണം.', 'error');
  if (pass !== pass2) return showToast('രണ്ട് password-ഉം ഒരുപോലെയല്ല.', 'error');

  const btn = $('btn-signup');
  setBusy(btn, true, 'Creating account…');
  const { data, error } = await sb.auth.signUp({
    email: admissionToEmail(adm),
    password: pass,
    options: { data: { app: 'quizmaster', full_name: name, admission_no: adm, centre, class_name: cls, batch } }
  });
  setBusy(btn, false);
  if (error) {
    if (/already registered|already exists/i.test(error.message)) return showToast('ഈ Admission No-ൽ account ഉണ്ട്. Sign In ചെയ്യുക.', 'error');
    return dbError(error);
  }
  if (!data.session) {
    return showToast('Account ഉണ്ടാക്കി, പക്ഷേ login ആയില്ല: Supabase → Authentication → "Confirm email" ഓഫ് ചെയ്യണം.', 'warning');
  }
  showToast('Account ഉണ്ടാക്കി! 🎉', 'success');
  await onSession(data.session);
}

async function onSession(session) {
  if (!session) return showPage('page-login');
  const { data: prof, error } = await sb.from('qm_profiles').select('*').eq('id', session.user.id).maybeSingle();
  if (error) { dbError(error); return showPage('page-login'); }
  if (!prof) {
    showToast('ഈ account-ന് QuizMaster profile ഇല്ല. പുതിയതായി Sign Up ചെയ്യുക.', 'error');
    await sb.auth.signOut();
    return showPage('page-login');
  }
  me = prof;
  await syncServerClock();

  if (me.role === 'admin') {
    $('admin-name').textContent = me.full_name || 'Admin';
    $('admin-avatar').textContent = (me.full_name || 'A').trim().charAt(0).toUpperCase();
    showPage('page-admin');
    await loadAdminData();
    showAdminSection(currentAdminSection || 'overview', { skipFetch: true });   // stay where the teacher clicked while loading
  } else if (me.status !== 'approved') {
    $('pending-name').textContent = me.full_name;
    $('pending-adm').textContent = me.admission_no || '';
    const rejected = me.status === 'rejected';
    $('pending-title').textContent = rejected ? 'Account rejected' : 'Approval pending';
    $('pending-msg').textContent = rejected
      ? 'ടീച്ചർ ഈ account അംഗീകരിച്ചില്ല. വിവരങ്ങൾ ശരിയാണോ എന്ന് ടീച്ചറോട് ചോദിക്കുക.'
      : 'നിങ്ങളുടെ account ഉണ്ടാക്കി. ടീച്ചർ approve ചെയ്താൽ quiz എഴുതാം. കുറച്ച് കഴിഞ്ഞ് "Check again" അമർത്തുക.';
    showPage('page-pending');
  } else {
    await openStudentDashboard();
  }
}

async function recheckApproval() { const { data } = await sb.auth.getSession(); await onSession(data.session); }

async function logout() {
  if (quizState && !confirm('Quiz നടന്നുകൊണ്ടിരിക്കുന്നു. Logout ചെയ്യട്ടെ? (സമയം തുടർന്നും ഓടും)')) return;
  stopQuizRuntime();
  clearInterval(dashboardTimer); clearInterval(dashboardRefresh); clearInterval(adminLiveTimer);
  quizState = null; me = null;
  Object.keys(cache).forEach(k => cache[k] = []);
  await sb.auth.signOut();
  ['si-adm', 'si-pass'].forEach(id => { if ($(id)) $(id).value = ''; });
  showPage('page-login');
  showToast('Logged out.', 'info');
}

// ════════════════════════════════════════════════════════
// STARTUP
// ════════════════════════════════════════════════════════

function configMissing() {
  return !CONFIG.SUPABASE_URL || CONFIG.SUPABASE_URL.includes('YOUR-PROJECT') ||
         !CONFIG.SUPABASE_ANON_KEY || CONFIG.SUPABASE_ANON_KEY.includes('YOUR-ANON');
}

function hideSplash() {
  const s = $('splash');
  if (s) { s.classList.add('fade-out'); setTimeout(() => s.remove(), 600); }
}

async function init() {
  fillSelect('su-centre', CONFIG.CENTRES, { placeholder: 'Select centre' });
  fillSelect('su-class', CONFIG.CLASSES.map(c => ({ id: c, name: 'Class ' + c })), { placeholder: 'Select class' });

  if (configMissing()) { showPage('page-setup'); hideSplash(); return; }
  if (!window.supabase) { showPage('page-setup'); $('setup-extra').textContent = 'Supabase library could not load. Check internet.'; hideSplash(); return; }

  sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'quizmaster-auth' }
  });
  try {
    const { data } = await sb.auth.getSession();
    await onSession(data.session);
  } catch (e) {
    dbError(e);
    showPage('page-login');
  }
  hideSplash();
}

document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (document.activeElement && document.activeElement.closest('#form-signin')) signIn();
  if (document.activeElement && document.activeElement.closest('#form-signup') && document.activeElement.tagName === 'INPUT') signUp();
});

// ════════════════════════════════════════════════════════
// SMART QUESTION PARSER (unchanged from the original QuizMaster)
// ════════════════════════════════════════════════════════
function smartParseQuestionsText(rawText, separateAnswerKey) {
  if (!rawText || !rawText.trim()) return [];

  let text = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    // (added) clean text copied from ChatGPT / Claude / Word: **bold**, # headings, bullets, odd spaces
    .replace(/\*\*|__/g, '')
    .replace(/[*_](Explanation|Exp|വിശദീകരണം|Answer|Ans|ഉത്തരം|Correct)\s*(:?)\s*[*_]/gi, '$1$2 ')
    .replace(/^[ \t]*#{1,6}[ \t]*/gm, '')
    .replace(/^[ \t]*[-•▪◦][ \t]+/gm, '')
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/[\u200B\uFEFF]/g, '');
  const answerKeyMap = {}; // qNum -> { answer, explanation }

  // 1. Separate answer key text if provided
  if (separateAnswerKey && separateAnswerKey.trim()) {
    parseAnswerKeyBlock(separateAnswerKey, answerKeyMap);
  }

  // 2. Embedded Answer Key section at bottom
  const ansKeyHeaderRegex = /(?:^|\n)\s*(?:ഉത്തരങ്ങൾ|ഉത്തരം|വിശദീകരണങ്ങൾ|answer\s*keys?|answers?|key\b)[^\n]*?(?:[:\-—]|\(answer\s*key\))/i;
  // (fixed: an inline "Answer: B" / "ഉത്തരം: A" line under a question is NOT an answer-key header)
  let ansKeyMatch = -1;
  {
    const hdr = new RegExp(ansKeyHeaderRegex.source, 'gi');
    let hm;
    while ((hm = hdr.exec(text)) !== null) {
      const lineStart = hm.index + (text[hm.index] === '\n' ? 1 : 0);
      const lineEnd = text.indexOf('\n', lineStart);
      const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
      const afterColon = line.replace(/^[^:\-—]*[:\-—]/, '').trim();
      const isInlineAnswer = /^\(?[A-Da-d]\)?(\W|$)/.test(afterColon) && !/\d/.test(afterColon);
      if (!isInlineAnswer) { ansKeyMatch = hm.index; break; }
    }
  }
  if (ansKeyMatch !== -1) {
    const questionsBlock = text.slice(0, ansKeyMatch);
    const answersBlock = text.slice(ansKeyMatch);
    parseAnswerKeyBlock(answersBlock, answerKeyMap);
    text = questionsBlock;
  }

  function parseAnswerKeyBlock(str, map) {
    const lines = str.split('\n');
    for (const line of lines) {
      const match = line.match(/(?:Q(?:uestion)?\s*)?(\d+)[\.\)\:\-\s]+([A-Da-d])\b(?:\s*[\—\-\:\)]\s*(.*))?/i);
      const pairCount = (line.match(/\d+[\.\)\:\-\s]*[A-Da-d]\b/gi) || []).length;   // (fixed: "1-C, 2-A, 3-B" on one line)
      if (match && pairCount < 2) {
        const qNum = parseInt(match[1]);
        const ans = match[2].toUpperCase();
        const exp = match[3] ? match[3].trim() : '';
        map[qNum] = { answer: ans, explanation: exp };
      } else {
        const pairs = line.matchAll(/(\d+)[\.\)\:\-\s]*([A-Da-d])\b/gi);
        for (const p of pairs) {
          map[parseInt(p[1])] = { answer: p[2].toUpperCase(), explanation: '' };
        }
      }
    }
  }

  // 3. Extract Question Blocks
  const lines = text.split('\n');
  const blocks = [];
  let currentBlock = [];
  let seenFirstQ = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // (fixed) also accepts "1.Question" (no space), "Q.1", "(1)", "1 )" – but not "2.5"
    const isQStart = /^\s*(?:(?:ചോദ്യം|Question|Qn|Q)\s*[\.\:\-]?\s*(\d{1,3})(?!\d)\s*[\.\)\:\-]?|\(?(\d{1,3})\s*[\.\)\:\-](?!\d))\s*(?=\S)/i.test(line);

    if (isQStart) {
      seenFirstQ = true;
      if (currentBlock.length > 0) {
        blocks.push(currentBlock.join('\n'));
        currentBlock = [];
      }
      currentBlock.push(line);
    } else if (seenFirstQ) {
      currentBlock.push(line);
    }
  }
  if (currentBlock.length > 0) {
    blocks.push(currentBlock.join('\n'));
  }

  if (blocks.length === 0 && text.trim()) {
    const paragraphs = text.split(/\n\s*\n+/);
    for (const p of paragraphs) {
      if (p.trim()) blocks.push(p);
    }
  }

  const parsedQuestions = [];

  blocks.forEach((block, idx) => {
    const numMatch = block.match(/^\s*(?:(?:ചോദ്യം|Question|Qn|Q)\s*[\.\:\-]?\s*(\d{1,3})(?!\d)\s*[\.\)\:\-]?|\(?(\d{1,3})\s*[\.\)\:\-](?!\d))\s*(?=\S)/i);
    const qNumber = numMatch ? parseInt(numMatch[1] || numMatch[2]) : (idx + 1);

    let inlineAnswer = null;
    let inlineExplanation = '';

    const ansLineMatch = block.match(/(?:Ans(?:wer)?|ഉത്തരം|Correct)\s*[:\-=]\s*([A-Da-d])\b/i);
    if (ansLineMatch) {
      inlineAnswer = ansLineMatch[1].toUpperCase();
    }

    const expLineMatch = block.match(/(?:Explanation|വിശദീകരണം|Exp)\s*[:\-=]\s*(.+)/i);
    if (expLineMatch) {
      inlineExplanation = expLineMatch[1].trim();
    }

    // Clean block from answer and explanation lines
    let cleanBlock = block
      .replace(/(?:Ans(?:wer)?|ഉത്തരം|Correct)\s*[:\-=]\s*([A-Da-d])\b.*$/gim, '')
      .replace(/(?:Explanation|വിശദീകരണം|Exp)\s*[:\-=]\s*.+$/gim, '')
      .trim();

    // Remove leading number or prefix like "1. ", "ചോദ്യം 1: ", "1. ചോദ്യം 1: "
    // (fixed: the second "ചോദ്യം/Question" is removed only when a number follows it)
    cleanBlock = cleanBlock.replace(/^\s*(?:(?:ചോദ്യം|Question|Qn|Q)\s*[\.\:\-]?\s*\d{1,3}(?!\d)\s*[\.\)\:\-]?|\(?\d{1,3}\s*[\.\)\:\-](?!\d))\s*/i, '')
      .replace(/^(?:ചോദ്യം|Question|Q)\s*\d+[\.\)\:\-]\s*/i, '');

    // Identify options A, B, C, D  (also "(a) x (b) y" / "a) x b) y" written on one line)
    const optRegex = /(?:^|\n|\s{2,}|\s(?=\(?[A-Da-d]\)\s))([*]?\s*(?:[A-Da-d][\.\)]|\([A-Da-d]\))\s*[*]?)\s*/g;
    const matches = [];
    let m;
    while ((m = optRegex.exec(cleanBlock)) !== null) {
      const letterMatch = m[1].match(/([A-Da-d])/i);
      if (letterMatch) {
        matches.push({
          letter: letterMatch[1].toUpperCase(),
          index: m.index + (m[0].length - m[1].length),
          endIndex: optRegex.lastIndex,
          hasAsterisk: m[1].includes('*')
        });
      }
    }

    let questionText = cleanBlock;
    const options = { A: '', B: '', C: '', D: '' };
    let asteriskAnswer = null;

    if (matches.length >= 2) {
      questionText = cleanBlock.slice(0, matches[0].index).trim();
      for (let i = 0; i < matches.length; i++) {
        const cur = matches[i];
        const next = matches[i + 1];
        let optText = cleanBlock.slice(cur.endIndex, next ? next.index : undefined).trim();

        if (cur.hasAsterisk || optText.includes('*')) {
          asteriskAnswer = cur.letter;
          optText = optText.replace(/\*/g, '').trim();
        }

        if (['A', 'B', 'C', 'D'].includes(cur.letter)) {
          options[cur.letter] = optText;
        }
      }
    }

    let finalAnswer = asteriskAnswer || inlineAnswer;
    let finalExp = inlineExplanation;

    if (!finalAnswer && answerKeyMap[qNumber]) {
      finalAnswer = answerKeyMap[qNumber].answer;
      if (!finalExp && answerKeyMap[qNumber].explanation) {
        finalExp = answerKeyMap[qNumber].explanation;
      }
    }

    parsedQuestions.push({
      num: qNumber,
      text: questionText,
      options,
      correct: finalAnswer || '',
      explanation: finalExp || '',
      marks: 1
    });
  });

  return parsedQuestions;
}

// ════════════════════════════════════════════════════════
// ADMIN – DATA + NAVIGATION
// ════════════════════════════════════════════════════════

async function loadAdminData() {
  try {
    await rpc('qm_admin_finalize_expired').catch(() => 0);   // close attempts whose time ran out
    const [subjects, chapters, questions, quizzes, attempts, profiles] = await Promise.all([
      fetchAll('qm_subjects'), fetchAll('qm_chapters', 'sort_order'), fetchAll('qm_questions'),
      fetchAll('qm_quizzes', 'created_at', false), fetchAll('qm_attempts', 'started_at', false), fetchAll('qm_profiles')
    ]);
    Object.assign(cache, { subjects, chapters, questions, quizzes, attempts, profiles });
    updateAdminBadges();
  } catch (e) { dbError(e, 'Could not load data'); }
}

async function reload(...tables) {
  const map = {
    subjects: () => fetchAll('qm_subjects'), chapters: () => fetchAll('qm_chapters', 'sort_order'),
    questions: () => fetchAll('qm_questions'), quizzes: () => fetchAll('qm_quizzes', 'created_at', false),
    attempts: () => fetchAll('qm_attempts', 'started_at', false), profiles: () => fetchAll('qm_profiles')
  };
  try {
    const res = await Promise.all(tables.map(t => map[t]()));
    tables.forEach((t, i) => cache[t] = res[i]);
    updateAdminBadges();
  } catch (e) { dbError(e); }
}

async function refreshAdmin() {
  const btn = $('btn-admin-refresh');
  setBusy(btn, true, '↻');
  await loadAdminData();
  setBusy(btn, false);
  showAdminSection(currentAdminSection, { skipFetch: true });
  showToast('Data refreshed', 'success');
}

const SECTION_TITLES = {
  overview: 'Dashboard', students: 'Students', subjects: 'Subjects & Chapters', questions: 'Question Bank',
  quizzes: 'Quizzes', results: 'Results', analytics: 'Mark Analysis'
};

const SECTION_RENDER = () => ({
  overview: renderOverview, students: renderStudents, subjects: renderSubjects, questions: renderQuestions,
  quizzes: renderQuizzes, results: renderResults, analytics: renderAnalytics
});
// live data each section needs fresh from the server (students sign up / submit while you watch)
const SECTION_LIVE = { overview: ['attempts', 'profiles'], students: ['profiles'], quizzes: ['attempts'], results: ['attempts', 'profiles'], analytics: ['attempts', 'profiles'] };
let adminLiveTimer = null;

function showAdminSection(name, { skipFetch = false } = {}) {
  currentAdminSection = name;
  document.querySelectorAll('.admin-section').forEach(s => s.classList.toggle('active', s.id === `section-${name}`));
  document.querySelectorAll('.sidebar-nav .nav-item').forEach(n => n.classList.toggle('active', n.dataset.section === name));
  $('admin-section-title').textContent = SECTION_TITLES[name] || '';
  closeSidebar();
  SECTION_RENDER()[name]();
  if (!skipFetch) liveRefresh(name);
  clearInterval(adminLiveTimer);
  adminLiveTimer = setInterval(() => {
    if ($('page-admin').classList.contains('active') && !document.hidden && !document.querySelector('.modal-overlay.open')) liveRefresh(currentAdminSection);
  }, 30000);
}

// Live refresh downloads only attempts from the last ~36 hours (keeps Supabase data transfer small
// even after a year of quizzes). Full history is loaded at login and with the ↻ Refresh button.
async function refreshRecentAttempts() {
  const since = new Date(serverNow() - 36 * 3600 * 1000).toISOString();
  const { data, error } = await sb.from('qm_attempts').select('*').gte('started_at', since)
    .order('started_at', { ascending: false }).limit(5000);
  if (error) throw error;
  const map = new Map(cache.attempts.map(a => [a.id, a]));
  data.forEach(a => map.set(a.id, a));
  cache.attempts = [...map.values()].sort((a, b) => b.started_at.localeCompare(a.started_at));
}

async function liveRefresh(name) {
  const tables = SECTION_LIVE[name];
  if (!tables || !me) return;
  if (tables.includes('attempts')) {
    await rpc('qm_admin_finalize_expired').catch(() => 0);
    await refreshRecentAttempts().catch(e => console.warn(e));
  }
  const others = tables.filter(t => t !== 'attempts');
  if (others.length) await reload(...others);
  else updateAdminBadges();
  if (currentAdminSection === name && !document.querySelector('.modal-overlay.open')) SECTION_RENDER()[name]();
}

function toggleSidebar() { $('sidebar').classList.toggle('open'); }
function closeSidebar() { $('sidebar').classList.remove('open'); }

function updateAdminBadges() {
  const live = cache.quizzes.filter(q => ['live', 'closing'].includes(quizStatus(q).key)).length;
  $('active-quiz-badge').style.display = live ? 'flex' : 'none';
  $('active-quiz-count').textContent = live;
  const pending = cache.profiles.filter(p => p.status === 'pending').length;
  const nb = $('nav-pending-count');
  nb.textContent = pending; nb.style.display = pending ? 'inline-flex' : 'none';
}

const students = () => cache.profiles.filter(p => p.role !== 'admin');
const submittedAttempts = () => cache.attempts.filter(a => a.submitted_at);

// ════════════════════════════════════════════════════════
// OVERVIEW
// ════════════════════════════════════════════════════════

function renderOverview() {
  const today = new Date().toDateString();
  const st = students();
  const stats = [
    { label: 'Approved students', value: st.filter(s => s.status === 'approved').length, color: '#667eea', icon: 'users' },
    { label: 'Waiting for approval', value: st.filter(s => s.status === 'pending').length, color: '#fa8231', icon: 'user-plus', go: 'students' },
    { label: 'Questions in bank', value: cache.questions.length, color: '#4facfe', icon: 'list' },
    { label: 'Live now', value: cache.quizzes.filter(q => ['live', 'closing'].includes(quizStatus(q).key)).length, color: '#43e97b', icon: 'zap', go: 'quizzes' },
    { label: 'Submissions today', value: submittedAttempts().filter(a => new Date(a.submitted_at).toDateString() === today).length, color: '#f093fb', icon: 'check' },
  ];
  $('overview-stats').innerHTML = stats.map(s => `
    <div class="stat-card ${s.go ? 'clickable' : ''}" style="--accent:${s.color}" ${s.go ? `onclick="showAdminSection('${s.go}')"` : ''}>
      <div class="stat-icon" style="background:${s.color}1a">${icon(s.icon)}</div>
      <div class="stat-info"><h3>${s.value}</h3><p>${s.label}</p></div>
    </div>`).join('');

  const upcoming = cache.quizzes.filter(q => ['live', 'closing', 'scheduled'].includes(quizStatus(q).key))
    .sort((a, b) => (a.start_at || '').localeCompare(b.start_at || ''));
  $('overview-upcoming').innerHTML = upcoming.length ? upcoming.map(q => {
    const s = quizStatus(q);
    const n = cache.attempts.filter(a => a.quiz_id === q.id).length;
    return `<div class="mini-row">
      <span class="status-pill st-${s.key}">${s.label}</span>
      <span class="mini-title">${escapeHTML(q.title)}</span>
      <span class="mini-meta">${q.start_at ? fmtDateTime(q.start_at) : 'Open now'} · ${n} joined</span>
      <button class="btn-link" onclick="openAnalyticsFor('${q.id}')">Analysis →</button>
    </div>`;
  }).join('') : '<div class="empty-state small">No live or scheduled quizzes. Create one from <b>Quizzes</b> or <b>Bulk Import</b>.</div>';

  const recent = submittedAttempts().sort((a, b) => b.submitted_at.localeCompare(a.submitted_at)).slice(0, 8);
  $('overview-recent').innerHTML = recent.length ? resultsTableHTML(recent, false) : '<div class="empty-state small">No submissions yet.</div>';
}

// ════════════════════════════════════════════════════════
// STUDENTS (approve / reject / edit / reset password)
// ════════════════════════════════════════════════════════

function renderStudents() {
  fillSelect('stu-filter-class', CONFIG.CLASSES.map(c => ({ id: c, name: 'Class ' + c })), { placeholder: 'All classes', selected: val('stu-filter-class') });
  fillSelect('stu-filter-centre', CONFIG.CENTRES, { placeholder: 'All centres', selected: val('stu-filter-centre') });
  const status = val('stu-filter-status'), cls = val('stu-filter-class'), centre = val('stu-filter-centre');
  const q = val('stu-search').toLowerCase();
  let list = students();
  const pendingCount = list.filter(s => s.status === 'pending').length;
  $('btn-approve-all').style.display = pendingCount ? 'flex' : 'none';
  $('btn-approve-all').querySelector('span').textContent = `Approve all pending (${pendingCount})`;

  if (status) list = list.filter(s => s.status === status);
  if (cls) list = list.filter(s => s.class_name === cls);
  if (centre) list = list.filter(s => s.centre === centre);
  if (q) list = list.filter(s => (s.full_name + ' ' + s.admission_no).toLowerCase().includes(q));
  list.sort((a, b) => (a.status === 'pending' ? -1 : 0) - (b.status === 'pending' ? -1 : 0) || a.full_name.localeCompare(b.full_name));

  $('students-count').textContent = `${list.length} student${list.length === 1 ? '' : 's'}`;
  if (!list.length) { $('students-table').innerHTML = '<div class="empty-state">No students found. Students join using <b>Sign Up</b> on the login page.</div>'; return; }

  $('students-table').innerHTML = `<div class="results-table-wrapper"><table class="results-table">
    <thead><tr><th>Name</th><th>Admission No</th><th>Centre</th><th>Class</th><th>Status</th><th>Joined</th><th>Actions</th></tr></thead>
    <tbody>${list.map(s => `<tr>
      <td><b class="t-primary">${escapeHTML(s.full_name)}</b>${s.batch ? `<div class="t-muted small">Batch: ${escapeHTML(s.batch)}</div>` : ''}</td>
      <td>${escapeHTML(s.admission_no || '')}</td>
      <td>${escapeHTML(shortCentre(s.centre))}</td>
      <td>${escapeHTML(s.class_name)}</td>
      <td><span class="status-pill st-${s.status}">${s.status}</span></td>
      <td>${fmtDate(s.created_at)}</td>
      <td><div class="row-actions">
        ${s.status !== 'approved' ? `<button class="chip-btn ok" onclick="setStudentStatus('${s.id}','approved')">✓ Approve</button>` : ''}
        ${s.status !== 'rejected' ? `<button class="chip-btn bad" onclick="setStudentStatus('${s.id}','rejected')">✕ Reject</button>` : ''}
        <button class="chip-btn" onclick="openEditStudent('${s.id}')">Edit</button>
        <button class="chip-btn" onclick="resetStudentPassword('${s.id}')">Reset password</button>
        <button class="chip-btn" onclick="openStudentAnalytics('${s.id}')">Report</button>
      </div></td></tr>`).join('')}</tbody></table></div>`;
}

function shortCentre(c) { return String(c || '').replace(/^Abacus Academy\s*/i, ''); }

async function setStudentStatus(id, status) {
  const { error } = await sb.from('qm_profiles').update({ status }).eq('id', id);
  if (error) return dbError(error);
  await reload('profiles');
  showToast(status === 'approved' ? 'Student approved ✓' : 'Student ' + status, status === 'approved' ? 'success' : 'info');
  renderStudents();
}

async function approveAllPending() {
  const ids = students().filter(s => s.status === 'pending').map(s => s.id);
  if (!ids.length || !confirm(`Approve all ${ids.length} pending students?`)) return;
  const { error } = await sb.from('qm_profiles').update({ status: 'approved' }).in('id', ids);
  if (error) return dbError(error);
  await reload('profiles');
  showToast(`${ids.length} students approved ✓`, 'success');
  renderStudents();
}

function openEditStudent(id) {
  const s = profileById(id);
  editingStudentId = id;
  $('es-name').value = s.full_name || '';
  $('es-adm').value = s.admission_no || '';
  fillSelect('es-centre', CONFIG.CENTRES, { selected: s.centre });
  fillSelect('es-class', CONFIG.CLASSES.map(c => ({ id: c, name: 'Class ' + c })), { selected: s.class_name });
  $('es-batch').value = s.batch || '';
  openModal('modal-edit-student');
}

async function saveStudent() {
  const upd = { full_name: val('es-name'), centre: val('es-centre'), class_name: val('es-class'), batch: val('es-batch') };
  if (!upd.full_name) return showToast('Name is required', 'error');
  const { error } = await sb.from('qm_profiles').update(upd).eq('id', editingStudentId);
  if (error) return dbError(error);
  closeModal('modal-edit-student');
  await reload('profiles');
  showToast('Student updated', 'success');
  renderStudents();
}

async function resetStudentPassword(id) {
  const s = profileById(id);
  const pw = prompt(`New password for ${s.full_name} (${s.admission_no}) – minimum 6 characters:`);
  if (pw === null) return;
  if (pw.length < 6) return showToast('Minimum 6 characters', 'error');
  try {
    await rpc('qm_admin_reset_password', { p_user: id, p_new_password: pw });
    showToast(`Password changed. Tell ${s.full_name}: ${pw}`, 'success');
  } catch (e) { dbError(e); }
}

// ════════════════════════════════════════════════════════
// SUBJECTS & CHAPTERS
// ════════════════════════════════════════════════════════

function renderSubjects() {
  const grid = $('subjects-grid');
  if (!cache.subjects.length) { grid.innerHTML = '<div class="empty-state">No subjects yet. Click <b>Add Subject</b>.</div>'; return; }
  grid.innerHTML = cache.subjects.map(s => {
    const chs = cache.chapters.filter(c => c.subject_id === s.id);
    return `<div class="subject-card">
      <div class="subject-card-header">
        <div class="subject-color-dot" style="background:${escapeHTML(s.color)}">${escapeHTML(s.name.charAt(0))}</div>
        <div><div class="subject-name">${escapeHTML(s.name)}</div><div class="subject-code">${escapeHTML(s.code || '')} · ${cache.questions.filter(q => q.subject_id === s.id).length} questions</div></div>
        <div class="subject-actions"><button class="icon-btn danger" title="Delete subject" onclick="deleteSubject('${s.id}')">${icon('trash')}</button></div>
      </div>
      <div class="subject-card-body"><div class="chapters-list">
        ${chs.map((c, i) => `<div class="chapter-item clickable" title="Show the quizzes of this chapter" onclick="openChapterInQuizzes('${c.id}')"><span class="chapter-num">${i + 1}</span><span class="chapter-name">${escapeHTML(c.name)}</span>
          <span class="chapter-q-count">${cache.quizzes.filter(z => z.chapter_id === c.id).length} quiz</span>
          <span class="chapter-q-count">${cache.questions.filter(q => q.chapter_id === c.id).length} Q</span>
          <button class="icon-btn danger tiny" title="Delete chapter" onclick="event.stopPropagation();deleteChapter('${c.id}')">${icon('x')}</button></div>`).join('')}
      </div>
      <button class="add-chapter-btn" onclick="openAddChapter('${s.id}')">${icon('plus')} Add Chapter</button></div>
    </div>`;
  }).join('');
}

function openAddSubject() { $('subject-name').value = ''; $('subject-code').value = ''; openModal('modal-add-subject'); }

function selectSubjectColor(el) {
  document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
  el.classList.add('active');
  selectedColor = el.dataset.color;
}

async function addSubject() {
  const name = val('subject-name');
  if (!name) return showToast('Subject name is required', 'error');
  const { error } = await sb.from('qm_subjects').insert({ name, code: val('subject-code'), color: selectedColor });
  if (error) return dbError(error);
  closeModal('modal-add-subject');
  await reload('subjects');
  showToast(`Subject "${name}" added`, 'success');
  renderSubjects();
}

function openAddChapter(subjectId) { $('chapter-subject-id').value = subjectId; $('chapter-name').value = ''; openModal('modal-add-chapter'); }

async function addChapter() {
  const name = val('chapter-name'), subject_id = val('chapter-subject-id');
  if (!name) return showToast('Chapter name is required', 'error');
  const order = cache.chapters.filter(c => c.subject_id === subject_id).length + 1;
  const { error } = await sb.from('qm_chapters').insert({ name, subject_id, sort_order: order });
  if (error) return dbError(error);
  closeModal('modal-add-chapter');
  await reload('chapters');
  showToast(`Chapter "${name}" added`, 'success');
  renderSubjects();
}

async function deleteSubject(id) {
  const n = cache.questions.filter(q => q.subject_id === id).length;
  if (!confirm(`Delete "${subjectName(id)}"?${n ? `\n${n} questions in it will also be deleted.` : ''}`)) return;
  const { error } = await sb.from('qm_subjects').delete().eq('id', id);
  if (error) return dbError(error);
  await reload('subjects', 'chapters', 'questions');
  showToast('Subject deleted', 'warning');
  renderSubjects();
}

async function deleteChapter(id) {
  if (!confirm(`Delete chapter "${chapterName(id)}"? (Its questions stay in the subject.)`)) return;
  const { error } = await sb.from('qm_chapters').delete().eq('id', id);
  if (error) return dbError(error);
  await reload('chapters', 'questions');
  showToast('Chapter deleted', 'warning');
  renderSubjects();
}

function chaptersOf(subjectId) { return cache.chapters.filter(c => c.subject_id === subjectId); }

function populateSubjectSelect(id, placeholder = 'Select subject', selected = '') {
  fillSelect(id, cache.subjects, { placeholder, selected });
}
function populateChapterSelect(id, subjectId, placeholder = 'All chapters', selected = '') {
  fillSelect(id, subjectId ? chaptersOf(subjectId) : [], { placeholder, selected });
}

// ════════════════════════════════════════════════════════
// QUESTION BANK
// ════════════════════════════════════════════════════════

function renderQuestions() {
  const fs = val('q-filter-subject'), fc = val('q-filter-chapter');
  populateSubjectSelect('q-filter-subject', 'All subjects', fs);
  populateChapterSelect('q-filter-chapter', fs, 'All chapters', fc);
  const search = val('q-search').toLowerCase();
  let list = cache.questions;
  if (fs) list = list.filter(q => q.subject_id === fs);
  if (val('q-filter-chapter')) list = list.filter(q => q.chapter_id === val('q-filter-chapter'));
  if (search) list = list.filter(q => (q.text + ' ' + (q.text_en || '') + ' ' + Object.values(q.options || {}).join(' ')).toLowerCase().includes(search));
  list = [...list].reverse();

  $('questions-count').textContent = `${list.length} question${list.length === 1 ? '' : 's'}`;
  if (!list.length) { $('questions-list').innerHTML = '<div class="empty-state">No questions. Use <b>Bulk Import</b> to paste 20 questions at once.</div>'; return; }
  const shown = list.slice(0, questionListLimit);
  $('questions-list').innerHTML = shown.map(q => `
    <div class="question-card">
      <div class="question-card-header">
        <div class="q-badge"><span class="badge">${escapeHTML(subjectName(q.subject_id))}</span>
          ${q.chapter_id ? `<span class="badge chapter">${escapeHTML(chapterName(q.chapter_id))}</span>` : ''}
          <span class="badge muted">${q.marks} mark${q.marks == 1 ? '' : 's'}</span></div>
        <div class="row-actions">
          <button class="icon-btn" title="Edit" onclick="openEditQuestion('${q.id}')">${icon('edit')}</button>
          <button class="icon-btn danger" title="Delete" onclick="deleteQuestion('${q.id}')">${icon('trash')}</button>
        </div>
      </div>
      <div class="q-text">${escapeHTML(q.text)}${q.text_en ? `<div class="q-text-en">${escapeHTML(q.text_en)}</div>` : ''}</div>
      <div class="options-display">${['A', 'B', 'C', 'D'].filter(k => (q.options || {})[k]).map(k =>
        `<div class="option-display ${q.correct === k ? 'correct' : ''}"><b>${k})</b> ${escapeHTML(q.options[k])}${q.options_en && q.options_en[k] && q.options_en[k] !== q.options[k] ? `<span class="opt-en"> · ${escapeHTML(q.options_en[k])}</span>` : ''}</div>`).join('')}</div>
      ${q.explanation ? `<div class="review-explanation">💡 ${escapeHTML(q.explanation)}</div>` : ''}
    </div>`).join('') +
    (list.length > shown.length ? `<button class="btn-secondary" onclick="questionListLimit+=100;renderQuestions()">Show more (${list.length - shown.length} more)</button>` : '');
}

function onQuestionFilterSubject() { $('q-filter-chapter').value = ''; questionListLimit = 100; renderQuestions(); }

function openAddQuestion() {
  editingQuestionId = null;
  $('modal-question-title').textContent = 'Add Question';
  populateSubjectSelect('q-subject', 'Select subject', val('q-filter-subject'));
  populateChapterSelect('q-chapter', val('q-subject'), 'No chapter', val('q-filter-chapter'));
  ['q-text', 'q-opt-A', 'q-opt-B', 'q-opt-C', 'q-opt-D', 'q-explanation', 'q-text-en', 'q-opt-en-A', 'q-opt-en-B', 'q-opt-en-C', 'q-opt-en-D', 'q-explanation-en'].forEach(id => $(id).value = '');
  $('q-marks').value = 1;
  document.querySelectorAll('input[name="q-correct"]').forEach(r => r.checked = r.value === 'A');
  openModal('modal-add-question');
}

function openEditQuestion(id) {
  const q = cache.questions.find(x => x.id === id);
  if (!q) return;
  editingQuestionId = id;
  $('modal-question-title').textContent = 'Edit Question';
  populateSubjectSelect('q-subject', 'Select subject', q.subject_id);
  populateChapterSelect('q-chapter', q.subject_id, 'No chapter', q.chapter_id || '');
  $('q-text').value = q.text;
  ['A', 'B', 'C', 'D'].forEach(k => $('q-opt-' + k).value = (q.options || {})[k] || '');
  $('q-explanation').value = q.explanation || '';
  $('q-text-en').value = q.text_en || '';
  ['A', 'B', 'C', 'D'].forEach(k => $('q-opt-en-' + k).value = (q.options_en || {})[k] || '');
  $('q-explanation-en').value = q.explanation_en || '';
  $('q-marks').value = q.marks;
  document.querySelectorAll('input[name="q-correct"]').forEach(r => r.checked = r.value === q.correct);
  openModal('modal-add-question');
}

async function saveQuestion() {
  const row = {
    subject_id: val('q-subject'), chapter_id: val('q-chapter') || null, text: val('q-text'),
    options: { A: val('q-opt-A'), B: val('q-opt-B'), C: val('q-opt-C'), D: val('q-opt-D') },
    correct: (document.querySelector('input[name="q-correct"]:checked') || {}).value,
    explanation: val('q-explanation'), marks: parseFloat($('q-marks').value) || 1,
    text_en: val('q-text-en'), explanation_en: val('q-explanation-en')
  };
  const optEn = { A: val('q-opt-en-A'), B: val('q-opt-en-B'), C: val('q-opt-en-C'), D: val('q-opt-en-D') };
  row.options_en = Object.values(optEn).some(Boolean) ? optEn : null;
  if (!row.subject_id) return showToast('Select a subject', 'error');
  if (!row.text) return showToast('Question text is required', 'error');
  if (!row.options.A || !row.options.B) return showToast('At least options A and B are required', 'error');
  if (!row.correct || !row.options[row.correct]) return showToast('Choose the correct option (it must have text)', 'error');
  const { error } = editingQuestionId
    ? await sb.from('qm_questions').update(row).eq('id', editingQuestionId)
    : await sb.from('qm_questions').insert(row);
  if (error) return dbError(error);
  closeModal('modal-add-question');
  await reload('questions');
  showToast(editingQuestionId ? 'Question updated' : 'Question added', 'success');
  renderQuestions();
}

async function deleteQuestion(id) {
  const used = cache.quizzes.filter(z => (z.question_ids || []).includes(id));
  if (!confirm(`Delete this question?${used.length ? `\nIt is used in ${used.length} quiz(zes): it will disappear from them.` : ''}`)) return;
  const { error } = await sb.from('qm_questions').delete().eq('id', id);
  if (error) return dbError(error);
  for (const z of used) {
    await sb.from('qm_quizzes').update({ question_ids: z.question_ids.filter(x => x !== id) }).eq('id', z.id);
  }
  await reload('questions', 'quizzes');
  showToast('Question deleted', 'warning');
  renderQuestions();
}

// ════════════════════════════════════════════════════════
// QUIZ SETTINGS FORM (shared by "Create Quiz" and "Bulk Import")
// ════════════════════════════════════════════════════════

function scheduleHTML(p) {
  return `<div class="settings-box">
    <div class="settings-box-title">${icon('clock')} Open & close time</div>
    <div class="form-row">
      <div class="form-group"><label>🟢 Opens at <span class="hint">(empty = opens now)</span></label><input id="${p}-start" type="datetime-local" class="modal-input" oninput="updateSchedulePreview('${p}')"></div>
      <div class="form-group"><label>🔴 Closes at <span class="hint">(empty = until you switch OFF)</span></label><input id="${p}-end" type="datetime-local" class="modal-input" oninput="updateSchedulePreview('${p}')"></div>
    </div>
    <div class="quick-chips">
      <span class="hint">Open:</span>
      <button type="button" class="chip-btn" onclick="quickSchedule('${p}','now')">Now</button>
      <button type="button" class="chip-btn" onclick="quickSchedule('${p}','today21')">Today 9 PM</button>
      <button type="button" class="chip-btn" onclick="quickSchedule('${p}','tomorrow21')">Tomorrow 9 PM</button>
    </div>
    <div class="quick-chips">
      <span class="hint">Close:</span>
      <button type="button" class="chip-btn" onclick="quickSchedule('${p}','end30')">+30 min</button>
      <button type="button" class="chip-btn" onclick="quickSchedule('${p}','end60')">+1 hour</button>
      <button type="button" class="chip-btn" onclick="quickSchedule('${p}','endDay')">Same day 11:59 PM</button>
      <button type="button" class="chip-btn" onclick="quickSchedule('${p}','end7')">+7 days</button>
      <button type="button" class="chip-btn" onclick="quickSchedule('${p}','clear')">Clear</button>
    </div>
    <details class="en-details"><summary>Late entry limit (optional)</summary>
      <div class="form-group"><label>Students must START before</label><input id="${p}-close" type="datetime-local" class="modal-input" oninput="updateSchedulePreview('${p}')"></div>
    </details>
    <div class="schedule-preview" id="${p}-schedule-preview"></div>
  </div>`;
}

function quizSettingsHTML(p) {
  return `
  <div class="form-group"><label>Quiz title</label><input id="${p}-title" class="modal-input" placeholder="e.g. Electrochemistry – Daily Test 1"></div>
  <div class="form-row">
    <div class="form-group"><label>Duration (minutes)</label><input id="${p}-duration" type="number" min="1" max="600" class="modal-input" value="20" oninput="updateSchedulePreview('${p}')"></div>
    <div class="form-group"><label>Pass mark (%)</label><input id="${p}-pass" type="number" min="0" max="100" class="modal-input" value="40"></div>
  </div>
  ${scheduleHTML(p)}
  <div class="settings-box">
    <div class="settings-box-title">${icon('zap')} Answer feedback</div>
    <div class="mode-cards">
      <label class="mode-card"><input type="radio" name="${p}-mode" value="practice" onchange="updateSchedulePreview('${p}')">
        <div><b>Practice mode</b><span>ഓരോ ചോദ്യത്തിനും ഉടനെ ശരി / തെറ്റ് + ശരിയുത്തരം + വിശദീകരണം. ഉത്തരം മാറ്റാൻ പറ്റില്ല.</span></div></label>
      <label class="mode-card"><input type="radio" name="${p}-mode" value="exam" checked onchange="updateSchedulePreview('${p}')">
        <div><b>Exam mode</b><span>ഫലം അവസാനം മാത്രം. Submit ചെയ്യുന്നതുവരെ ഉത്തരം മാറ്റാം.</span></div></label>
    </div>
    <div class="form-group" id="${p}-review-wrap"><label>When can students see correct answers? (Exam mode)</label>
      <select id="${p}-review" class="modal-input">
        <option value="after_end">After the quiz ends for everyone (recommended)</option>
        <option value="immediate">Immediately after submitting</option>
        <option value="never">Never (only marks)</option>
      </select></div>
  </div>
  <div class="form-row three-eq">
    <div class="form-group"><label>Only for class</label><select id="${p}-tclass" class="modal-input"></select></div>
    <div class="form-group"><label>Only for batch</label><select id="${p}-tbatch" class="modal-input"></select></div>
    <div class="form-group"><label>Only for centre</label><select id="${p}-tcentre" class="modal-input"></select></div>
  </div>
  <div class="toggle-stack">
    <label class="toggle-label"><input type="checkbox" id="${p}-shuffle-q"> Shuffle question order for each student</label>
    <label class="toggle-label"><input type="checkbox" id="${p}-shuffle-o"> Shuffle options (A/B/C/D) for each student</label>
    <label class="toggle-label"><input type="checkbox" id="${p}-active" checked> Switch ON now (students can see it; it opens at the start time)</label>
  </div>`;
}

function mountQuizSettings(containerId, p, quiz = null) {
  $(containerId).innerHTML = quizSettingsHTML(p);
  fillSelect(`${p}-tclass`, CONFIG.CLASSES.map(c => ({ id: c, name: 'Class ' + c })), { placeholder: 'All classes', selected: quiz ? quiz.target_class : '' });
  fillSelect(`${p}-tcentre`, CONFIG.CENTRES, { placeholder: 'All centres', selected: quiz ? quiz.target_centre : '' });
  const batches = [...new Set(students().map(s => (s.batch || '').trim()).filter(Boolean).concat(quiz && quiz.target_batch ? [quiz.target_batch] : []))].sort();
  fillSelect(`${p}-tbatch`, batches, { placeholder: 'All batches', selected: quiz ? quiz.target_batch : '' });
  if (quiz) {
    $(`${p}-title`).value = quiz.title;
    $(`${p}-duration`).value = quiz.duration_min;
    $(`${p}-pass`).value = quiz.pass_pct;
    $(`${p}-start`).value = toLocalInput(quiz.start_at);
    $(`${p}-close`).value = toLocalInput(quiz.entry_close_at);
    $(`${p}-end`).value = toLocalInput(quiz.end_at);
    document.querySelectorAll(`input[name="${p}-mode"]`).forEach(r => r.checked = r.value === quiz.mode);
    $(`${p}-review`).value = quiz.review_policy;
    $(`${p}-shuffle-q`).checked = quiz.shuffle_questions;
    $(`${p}-shuffle-o`).checked = quiz.shuffle_options;
    $(`${p}-active`).checked = quiz.active;
  }
  updateSchedulePreview(p);
}

function quickSchedule(p, kind) {
  const set = (id, d) => { $(`${p}-${id}`).value = d ? toLocalInput(d.toISOString()) : ''; };
  const openAt = () => $(`${p}-start`).value ? new Date($(`${p}-start`).value) : new Date();
  if (kind === 'now') set('start', null);
  else if (kind === 'today21' || kind === 'tomorrow21') {
    const d = new Date(); if (kind === 'tomorrow21') d.setDate(d.getDate() + 1); d.setHours(21, 0, 0, 0);
    set('start', d);
    if (!$(`${p}-end`).value) set('end', new Date(d.getTime() + 60 * 60000));   // default: open for 1 hour
  }
  else if (kind === 'end30') set('end', new Date(openAt().getTime() + 30 * 60000));
  else if (kind === 'end60') set('end', new Date(openAt().getTime() + 60 * 60000));
  else if (kind === 'endDay') { const d = openAt(); d.setHours(23, 59, 0, 0); set('end', d); }
  else if (kind === 'end7') set('end', new Date(openAt().getTime() + 7 * 86400000));
  else { set('start', null); set('end', null); set('close', null); }
  updateSchedulePreview(p);
}

function updateSchedulePreview(p) {
  const el = $(`${p}-schedule-preview`);
  if (!el) return;
  const mode = (document.querySelector(`input[name="${p}-mode"]:checked`) || {}).value;
  if ($(`${p}-review-wrap`)) $(`${p}-review-wrap`).style.display = mode === 'practice' ? 'none' : '';
  const s = $(`${p}-start`).value ? new Date($(`${p}-start`).value) : null;
  const e = $(`${p}-end`) && $(`${p}-end`).value ? new Date($(`${p}-end`).value) : null;
  const c = $(`${p}-close`) && $(`${p}-close`).value ? new Date($(`${p}-close`).value) : null;
  const dur = parseInt(($(`${p}-duration`) || {}).value) || 0;
  const t = d => d.toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
  let html;
  if (e && s && e <= s) html = `<span class="warn">⚠ Close time must be after the open time.</span>`;
  else if (c && s && c <= s) html = `<span class="warn">⚠ Late-entry time must be after the open time.</span>`;
  else if (e && e <= new Date()) html = `<span class="warn">⚠ This close time is already over – students will not be able to start.</span>`;
  else {
    html = (s ? `🟢 Opens <b>${t(s)}</b>` : '🟢 Opens <b>as soon as it is ON</b>') +
      (e ? ` · 🔴 Closes <b>${t(e)}</b>` : ' · stays open until you switch it OFF') +
      (c ? ` · must start before <b>${t(c)}</b>` : '') +
      ` · each student gets <b>${dur} min</b> from the moment they start` +
      (e ? ' (less if the close time comes first – then it submits automatically).' : '.');
  }
  el.innerHTML = html;
}

function readQuizSettings(p) {
  const start = fromLocalInput($(`${p}-start`).value), close = fromLocalInput($(`${p}-close`).value), end = fromLocalInput($(`${p}-end`).value);
  const s = {
    title: val(`${p}-title`),
    duration_min: Math.min(600, Math.max(1, parseInt($(`${p}-duration`).value) || 20)),
    pass_pct: Math.min(100, Math.max(0, parseInt($(`${p}-pass`).value) || 0)),
    start_at: start, entry_close_at: close, end_at: end,
    mode: (document.querySelector(`input[name="${p}-mode"]:checked`) || {}).value || 'exam',
    review_policy: val(`${p}-review`) || 'after_end',
    target_class: val(`${p}-tclass`), target_centre: val(`${p}-tcentre`), target_batch: val(`${p}-tbatch`),
    shuffle_questions: $(`${p}-shuffle-q`).checked, shuffle_options: $(`${p}-shuffle-o`).checked,
    active: $(`${p}-active`).checked
  };
  if (!s.title) { showToast('Quiz title is required', 'error'); return null; }
  if (start && close && new Date(close) <= new Date(start)) { showToast('Late-entry time must be after the open time', 'error'); return null; }
  if (start && end && new Date(end) <= new Date(start)) { showToast('Close time must be after the open time', 'error'); return null; }
  return s;
}

// ════════════════════════════════════════════════════════
// BULK IMPORT (paste 20 questions → quiz)
// ════════════════════════════════════════════════════════

function openBulkImportModal() {
  populateSubjectSelect('bulk-subject', 'Select subject', val('q-filter-subject'));
  populateChapterSelect('bulk-chapter', val('bulk-subject'), 'Select chapter', val('q-filter-chapter'));
  $('bulk-questions-input').value = '';
  if ($('bulk-answerkey-input')) $('bulk-answerkey-input').value = '';
  $('bulk-auto-create-quiz').checked = true;
  mountQuizSettings('bulk-quiz-fields', 'bq');
  toggleBulkQuizFields();
  currentBulkParsed = [];
  renderBulkPreview();
  openModal('modal-bulk-import');
  setTimeout(() => $('bulk-questions-input').focus(), 100);
}

function loadChaptersForBulk() { populateChapterSelect('bulk-chapter', val('bulk-subject'), 'Select chapter'); suggestBulkTitle(); }

function suggestBulkTitle() {
  const t = $('bq-title');
  if (!t || t.dataset.touched) return;
  const ch = chapterName(val('bulk-chapter')), sub = subjectName(val('bulk-subject'));
  if (ch || sub) t.value = `${ch || sub} – Quiz ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`;
}

function toggleBulkQuizFields() {
  $('bulk-quiz-fields').style.display = $('bulk-auto-create-quiz').checked ? '' : 'none';
  const t = $('bq-title');
  if (t) t.oninput = () => t.dataset.touched = '1';
  suggestBulkTitle();
}

async function quickCreateSubject() {
  const name = prompt('New subject name:');
  if (!name || !name.trim()) return;
  const { data, error } = await sb.from('qm_subjects').insert({ name: name.trim(), color: '#667eea' }).select().single();
  if (error) return dbError(error);
  await reload('subjects');
  populateSubjectSelect('bulk-subject', 'Select subject', data.id);
  loadChaptersForBulk();
  showToast(`Subject "${data.name}" created`, 'success');
}

async function quickCreateChapter() {
  const sid = val('bulk-subject');
  if (!sid) return showToast('Select a subject first', 'error');
  const name = prompt('New chapter name:');
  if (!name || !name.trim()) return;
  const { data, error } = await sb.from('qm_chapters').insert({ name: name.trim(), subject_id: sid, sort_order: chaptersOf(sid).length + 1 }).select().single();
  if (error) return dbError(error);
  await reload('chapters');
  populateChapterSelect('bulk-chapter', sid, 'Select chapter', data.id);
  suggestBulkTitle();
  showToast(`Chapter "${data.name}" created`, 'success');
}

function toggleBulkAnswerKeyBox() {
  const box = $('bulk-anskey-box'), ic = $('bulk-anskey-toggle-icon');
  const show = box.style.display === 'none';
  box.style.display = show ? 'block' : 'none';
  ic.textContent = show ? '▲ Hide' : '▼ Show';
}

function loadSamplePasteFormat() {
  $('bulk-questions-input').value = `1. ഗാൽവാനിക് സെല്ലിൽ നടക്കുന്ന ഊർജമാറ്റം ഏത്?
A) വൈദ്യുതോർജം → രാസോർജം
B) രാസോർജം → വൈദ്യുതോർജം
C) താപോർജം → വൈദ്യുതോർജം
D) പ്രകാശോർജം → രാസോർജം
Ans: B
വിശദീകരണം: സ്വയം നടക്കുന്ന റിഡോക്സ് പ്രവർത്തനം വൈദ്യുതി ഉണ്ടാക്കുന്നു.

2. ഡാനിയൽ സെല്ലിൽ ആനോഡായി പ്രവർത്തിക്കുന്ന ലോഹം ഏത്?
A) സിങ്ക്
B) കോപ്പർ
C) സിൽവർ
D) പ്ലാറ്റിനം
Ans: A
വിശദീകരണം: Zn ഓക്സീകരിക്കപ്പെടുന്നു: Zn → Zn²⁺ + 2e⁻`;
  showToast('Sample loaded – paste your own questions the same way', 'info');
  parseBulkQuestionsInput();
}

function onBulkInputChanged() {
  clearTimeout(bulkInputDebounce);
  bulkInputDebounce = setTimeout(parseBulkQuestionsInput, 250);
}

function parseBulkQuestionsInput() {
  const defaultMarks = parseFloat($('bulk-q-marks') ? $('bulk-q-marks').value : 1) || 1;
  const raw = $('bulk-questions-input').value;
  currentBulkParsed = parseTabularQuestions(raw) || smartParseQuestionsText(raw, $('bulk-answerkey-input') ? $('bulk-answerkey-input').value : '');
  currentBulkParsed.forEach(q => q.marks = defaultMarks);
  renderBulkPreview();
}

// Rows copied from Excel / Google Sheets:  [No] | Question | A | B | C | D | Answer | [Explanation]
function parseTabularQuestions(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').filter(l => l.trim());
  if (!lines.length) return null;
  const tabbed = lines.filter(l => (l.match(/\t/g) || []).length >= 4);
  if (tabbed.length < Math.max(1, lines.length * 0.6)) return null;
  const out = [];
  tabbed.forEach(line => {
    let c = line.split('\t').map(x => x.trim());
    if (/^\d+[.)]?$/.test(c[0])) c = c.slice(1);                       // serial number column
    if (out.length === 0 && c.some(x => /^(question|ചോദ്യം)/i.test(x))) return;   // header row
    const [text, A = '', B = '', C = '', D = '', ans = '', exp = ''] = c;
    let correct = (ans.match(/^\(?([A-Da-d])\)?$/) || [])[1];
    if (!correct && ans) {                                               // answer written as the option text
      const hit = Object.entries({ A, B, C, D }).find(([, v]) => v && v.toLowerCase() === ans.toLowerCase());
      if (hit) correct = hit[0];
    }
    out.push({ num: out.length + 1, text, options: { A, B, C, D }, correct: correct ? correct.toUpperCase() : '', explanation: exp, marks: 1 });
  });
  return out.length ? out : null;
}

function bulkProblems(q) {
  const probs = [];
  if (!q.text) probs.push('No question text');
  const filled = ['A', 'B', 'C', 'D'].filter(k => (q.options[k] || '').trim());
  if (filled.length < 2) probs.push('Options not found');
  if (!q.correct || !['A', 'B', 'C', 'D'].includes(q.correct)) probs.push('Select answer');
  else if (!(q.options[q.correct] || '').trim()) probs.push('Answer option is empty');
  return probs;
}

function renderBulkPreview() {
  const container = $('bulk-preview-container'), badge = $('bulk-preview-badge'), status = $('bulk-import-status');
  const count = currentBulkParsed.length;
  badge.textContent = `${count} Question${count === 1 ? '' : 's'}`;
  if (!count) {
    container.innerHTML = `<p class="t-muted small" style="text-align:center;padding:24px 0">Paste questions above – the live preview appears here.</p>`;
    status.textContent = ''; return;
  }
  let bad = 0;
  container.innerHTML = currentBulkParsed.map((q, i) => {
    const probs = bulkProblems(q);
    if (probs.length) bad++;
    return `<div class="bulk-preview-card ${probs.length ? 'has-error' : ''}" id="bpc-${i}">
      <div class="bulk-preview-header">
        <div class="bulk-preview-q-title"><span class="bulk-preview-badge-num">Q${i + 1}</span><span class="pre">${escapeHTML(q.text) || '<i>(no text)</i>'}</span></div>
        ${probs.map(p => `<span class="err-chip">${p}</span>`).join('')}
      </div>
      <div class="bulk-preview-options-grid">
        ${['A', 'B', 'C', 'D'].map(k => `<label class="bulk-opt-chip ${q.correct === k ? 'selected' : ''}" onclick="updateBulkQuestionAnswer(${i}, '${k}')">
          <input type="radio" name="bulk-correct-${i}" value="${k}" ${q.correct === k ? 'checked' : ''} />
          <span class="bulk-opt-key">${k})</span><span style="flex:1">${escapeHTML(q.options[k] || '—')}</span>${q.correct === k ? '<span>✓</span>' : ''}</label>`).join('')}
      </div>
      <div class="bulk-preview-footer">
        <span class="exp">${q.explanation ? '💡 ' + escapeHTML(q.explanation) : '<span style="opacity:0.5">No explanation</span>'}</span>
        <button type="button" onclick="removeBulkQuestion(${i})">✕ Delete</button>
      </div></div>`;
  }).join('');
  // numbering check: 1,2,3,5… → question 4 was probably merged into 3 (format problem)
  const nums = currentBulkParsed.map(q => q.num).filter(n => Number.isFinite(n));
  const missing = [];
  if (nums.length) for (let n = Math.min(...nums); n <= Math.max(...nums); n++) if (!nums.includes(n)) missing.push(n);
  const gapMsg = missing.length ? `<br><span style="color:var(--orange)">⚠️ Question number(s) ${missing.slice(0, 15).join(', ')} not found – they may be joined with the question before. Check that each question starts on a new line with its number (e.g. "4. ...").</span>` : '';
  status.innerHTML = (bad
    ? `<span style="color:var(--orange)">⚠️ ${bad} question(s) need fixing (red cards). Click the correct option to set the answer.</span>`
    : `<span style="color:var(--green)">✓ All ${count} questions are ready!</span>`) + gapMsg;
}

function updateBulkQuestionAnswer(i, k) { if (currentBulkParsed[i]) { currentBulkParsed[i].correct = k; renderBulkPreview(); } }
function removeBulkQuestion(i) { currentBulkParsed.splice(i, 1); renderBulkPreview(); }

async function executeBulkImport() {
  const subject_id = val('bulk-subject'), chapter_id = val('bulk-chapter');
  if (!subject_id) return showToast('Please select a Subject', 'error');
  if (!chapter_id) return showToast('Please select a Chapter', 'error');
  if (!currentBulkParsed.length) return showToast('Paste questions first', 'error');
  const badIdx = currentBulkParsed.findIndex(q => bulkProblems(q).length);
  if (badIdx !== -1) {
    showToast(`Question ${badIdx + 1}: ${bulkProblems(currentBulkParsed[badIdx]).join(', ')}`, 'error');
    const el = $(`bpc-${badIdx}`); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  const makeQuiz = $('bulk-auto-create-quiz').checked;
  const settings = makeQuiz ? readQuizSettings('bq') : null;
  if (makeQuiz && !settings) return;

  const btn = $('btn-bulk-import');
  setBusy(btn, true, 'Saving…');
  const rows = currentBulkParsed.map(q => ({
    subject_id, chapter_id, text: q.text,
    options: { A: q.options.A || '', B: q.options.B || '', C: q.options.C || '', D: q.options.D || '' },
    correct: q.correct, marks: q.marks || 1, explanation: q.explanation || ''
  }));
  const { data: inserted, error } = await sb.from('qm_questions').insert(rows).select('id, created_at');
  if (error) { setBusy(btn, false); return dbError(error); }

  // keep the pasted order (insert returns rows in the same order)
  const ids = inserted.map(r => r.id);
  let quizMsg = '';
  if (makeQuiz) {
    const { error: e2 } = await sb.from('qm_quizzes').insert({ ...settings, subject_id, chapter_id, question_ids: ids });
    if (e2) { setBusy(btn, false); await reload('questions'); return dbError(e2); }
    quizMsg = ` and created quiz "${settings.title}"`;
  }
  setBusy(btn, false);
  closeModal('modal-bulk-import');
  currentBulkParsed = [];
  await reload('questions', 'quizzes');
  showToast(`🎉 Imported ${ids.length} questions${quizMsg}!`, 'success');
  showAdminSection(makeQuiz ? 'quizzes' : 'questions');
}

// ════════════════════════════════════════════════════════
// IMPORT QUIZ FILE (all-chapters-quiz.html format)
// ════════════════════════════════════════════════════════
// Format: [{ s, sml, sen, u, t:{ml,en}, Q:[{ q:{ml,en}, o:[{ml,en}×4], a:0-3, e:{ml,en} }] }]
// The file may be the HTML page (with  const ALL=[...]) or plain JSON.

let fileImportData = [];

function openFileImport() {
  fileImportData = [];
  $('fi-file').value = '';
  $('fi-summary').innerHTML = '';
  $('fi-list').innerHTML = '';
  $('fi-settings').style.display = 'none';
  $('btn-file-import').disabled = true;
  fillSelect('fi-class', CONFIG.CLASSES.map(c => ({ id: c, name: 'Class ' + c })), { placeholder: 'All classes', selected: '10' });
  const batches = [...new Set(students().map(s => (s.batch || '').trim()).filter(Boolean))].sort();
  fillSelect('fi-batch', batches, { placeholder: 'All batches' });
  fillSelect('fi-centre', CONFIG.CENTRES, { placeholder: 'All centres' });
  $('fi-schedule').innerHTML = scheduleHTML('fi');
  updateSchedulePreview('fi');
  openModal('modal-file-import');
}

// find the JSON array that follows "const ALL=" (or the first "[{" ) using bracket matching
function extractQuizArray(text) {
  const t = String(text || '').trim();
  if (t.startsWith('[') || t.startsWith('{')) {
    const j = JSON.parse(t);
    return Array.isArray(j) ? j : (j.ALL || j.quizzes || [j]);
  }
  let start = -1;
  const m = t.match(/(?:const|let|var)\s+ALL\s*=\s*\[/);
  if (m) start = m.index + m[0].length - 1;
  else { const k = t.search(/\[\s*\{\s*"s"\s*:/); if (k !== -1) start = k; }
  if (start === -1) throw new Error('Quiz data (const ALL=[...]) not found in this file.');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') { depth--; if (depth === 0) return JSON.parse(t.slice(start, i + 1)); }
  }
  throw new Error('Quiz data is incomplete (file cut off?).');
}

const biText = (x) => (x && typeof x === 'object') ? { ml: String(x.ml || x.en || '').trim(), en: String(x.en || x.ml || '').trim() } : { ml: String(x || '').trim(), en: String(x || '').trim() };

function normaliseQuizFile(arr) {
  return arr.map((x, i) => {
    // "Physics Part 1" / "Physics Part 2" → one subject "Physics" (chapters keep their own numbers)
    const subjEn = String(x.sen || x.subject || x.s || 'General').trim().replace(/\s*[-–(]?\s*Part\s*\d+\)?$/i, '');
    const subjEnNice = subjEn.charAt(0).toUpperCase() + subjEn.slice(1);
    const title = biText(x.t || x.title || ('Quiz ' + (i + 1)));
    const unit = x.u ?? x.unit ?? '';
    const qs = (x.Q || x.questions || []).map(q => ({
      q: biText(q.q || q.question), o: (q.o || q.options || []).map(biText),
      a: typeof q.a === 'number' ? q.a : ['A', 'B', 'C', 'D'].indexOf(String(q.a || q.answer || '').toUpperCase()),
      e: biText(q.e || q.explanation || '')
    }));
    const problems = qs.filter(q => !q.q.ml || q.o.length < 2 || q.a < 0 || q.a >= q.o.length).length;
    const label = String(x.lab || (unit !== '' ? 'Unit ' + unit : '')).trim();   // "Unit 5" / "Ch 1"
    return {
      subject: subjEnNice, subjectMl: String(x.sml || '').trim().replace(/\s*ഭാഗം\s*\d+$/, ''), unit, title,
      chapter: (label ? `${label} – ` : '') + title.en + (title.ml && title.ml !== title.en ? ` (${title.ml})` : ''),
      quizTitleBase: `${subjEnNice}${label ? ' ' + label : ''} – ${title.en}`,
      questions: qs, problems, selected: problems === 0 && qs.length > 0
    };
  });
}

async function onQuizFileChosen(file) {
  if (!file) return;
  try {
    const text = await file.text();
    fileImportData = normaliseQuizFile(extractQuizArray(text));
    if (!fileImportData.length) throw new Error('No quizzes found in the file.');
  } catch (e) {
    fileImportData = [];
    $('fi-summary').innerHTML = `<div class="adm-check taken"><b>ഈ ഫയൽ വായിക്കാൻ കഴിഞ്ഞില്ല</b><span>${escapeHTML(e.message)}</span></div>`;
    $('fi-list').innerHTML = ''; $('fi-settings').style.display = 'none'; $('btn-file-import').disabled = true;
    return;
  }
  $('fi-settings').style.display = '';
  renderFileImportList();
}

function fileQuizTitle(item) {
  const lang = val('fi-lang');
  return item.quizTitleBase + (lang === 'ml' ? ' (MM)' : lang === 'en' ? ' (EM)' : '');
}

function renderFileImportList() {
  if (!fileImportData.length) return;
  const existing = new Set(cache.quizzes.map(q => q.title));
  const subjects = [...new Set(fileImportData.map(x => x.subject))];
  const totalQ = fileImportData.reduce((n, x) => n + x.questions.length, 0);
  $('fi-summary').innerHTML = `<div class="adm-check found"><b>✓ ${fileImportData.length} quizzes · ${totalQ} questions</b><span>${subjects.map(escapeHTML).join(', ')}</span></div>`;
  $('fi-list').innerHTML = fileImportData.map((x, i) => {
    const exists = existing.has(fileQuizTitle(x));
    if (exists) { x.selected = false; x.wasExists = true; }
    else if (x.wasExists) { x.selected = !x.problems && x.questions.length > 0; x.wasExists = false; }
    const subjExists = cache.subjects.some(s => s.name.toLowerCase() === x.subject.toLowerCase());
    return `<label class="fi-row ${exists ? 'exists' : ''}">
      <input type="checkbox" ${x.selected ? 'checked' : ''} ${exists || x.problems ? 'disabled' : ''} onchange="fileImportData[${i}].selected=this.checked;updateFileImportBtn()">
      <div class="fi-main"><b>${escapeHTML(fileQuizTitle(x))}</b>
        <span class="t-muted small">${escapeHTML(x.subject)}${x.subjectMl ? ' / ' + escapeHTML(x.subjectMl) : ''} ${subjExists ? '' : '<span class="t-green">(new subject)</span>'} · ${escapeHTML(x.chapter)}</span></div>
      <span class="badge muted">${x.questions.length} Q</span>
      ${exists ? '<span class="badge muted">Already imported</span>' : x.problems ? `<span class="err-chip">${x.problems} bad question(s)</span>` : ''}
    </label>`;
  }).join('');
  updateFileImportBtn();
}

function updateFileImportBtn() {
  const n = fileImportData.filter(x => x.selected).length;
  $('btn-file-import').disabled = !n;
  $('btn-file-import').innerHTML = `${icon('upload')} Import ${n} quiz${n === 1 ? '' : 'zes'}`;
}

async function executeFileImport() {
  const chosen = fileImportData.filter(x => x.selected);
  if (!chosen.length) return;
  const lang = val('fi-lang');
  // both → Malayalam in text/options/explanation and English in *_en (students switch with the toggle)
  const main = x => lang === 'en' ? x.en : x.ml;
  const eng = x => lang === 'both' && x.en !== x.ml ? x.en : '';
  const L = ['A', 'B', 'C', 'D'];
  const fiStart = fromLocalInput($('fi-start').value), fiEnd = fromLocalInput($('fi-end').value), fiClose = fromLocalInput($('fi-close').value);
  if (fiStart && fiEnd && new Date(fiEnd) <= new Date(fiStart)) return showToast('Close time must be after the open time', 'error');
  const settings = {
    start_at: fiStart, end_at: fiEnd, entry_close_at: fiClose,
    duration_min: Math.min(600, Math.max(1, parseInt($('fi-duration').value) || 20)), pass_pct: 40,
    mode: val('fi-mode'), review_policy: val('fi-mode') === 'practice' ? 'immediate' : 'after_end',
    shuffle_questions: false, shuffle_options: false,
    target_class: val('fi-class'), target_batch: val('fi-batch'), target_centre: val('fi-centre'), active: $('fi-active').checked
  };
  const btn = $('btn-file-import');
  setBusy(btn, true, 'Importing…');
  let done = 0;
  try {
    for (const x of chosen) {
      btn.innerHTML = `Importing ${done + 1} / ${chosen.length}…`;
      // subject: find by name (English or Malayalam), else create
      let sub = cache.subjects.find(s => s.name.toLowerCase() === x.subject.toLowerCase() || (x.subjectMl && s.name === x.subjectMl));
      if (!sub) {
        const colors = { physics: '#4facfe', chemistry: '#43e97b', biology: '#f093fb', mathematics: '#fa8231', maths: '#fa8231' };
        const { data, error } = await sb.from('qm_subjects').insert({ name: x.subject, code: x.subject.slice(0, 4).toUpperCase(), color: colors[x.subject.toLowerCase()] || '#667eea' }).select().single();
        if (error) throw error;
        cache.subjects.push(data); sub = data;
      }
      // chapter: find by name inside the subject, else create
      let ch = cache.chapters.find(c => c.subject_id === sub.id && c.name === x.chapter);
      if (!ch) {
        const { data, error } = await sb.from('qm_chapters').insert({ subject_id: sub.id, name: x.chapter, sort_order: Number(x.unit) || chaptersOf(sub.id).length + 1 }).select().single();
        if (error) throw error;
        cache.chapters.push(data); ch = data;
      }
      const rows = x.questions.map(q => {
        const hasEn = lang === 'both' && (q.q.en !== q.q.ml || q.o.some(o => o.en !== o.ml) || q.e.en !== q.e.ml);
        return {
          subject_id: sub.id, chapter_id: ch.id, text: main(q.q),
          options: Object.fromEntries(q.o.slice(0, 4).map((o, j) => [L[j], main(o)])),
          text_en: hasEn ? q.q.en : '', explanation_en: hasEn ? q.e.en : '',
          options_en: hasEn ? Object.fromEntries(q.o.slice(0, 4).map((o, j) => [L[j], o.en])) : null,
          correct: L[q.a], explanation: main(q.e), marks: 1
        };
      });
      const { data: ins, error: e1 } = await sb.from('qm_questions').insert(rows).select('id');
      if (e1) throw e1;
      const { error: e2 } = await sb.from('qm_quizzes').insert({ ...settings, title: fileQuizTitle(x), subject_id: sub.id, chapter_id: ch.id, question_ids: ins.map(r => r.id) });
      if (e2) throw e2;
      done++;
    }
    setBusy(btn, false);
    closeModal('modal-file-import');
    showToast(`🎉 ${done} quizzes imported!`, 'success');
  } catch (e) {
    setBusy(btn, false);
    dbError(e);
    if (done) showToast(`${done} quizzes were imported before the error. Choose the file again to import the rest.`, 'warning');
  }
  await reload('subjects', 'chapters', 'questions', 'quizzes');
  showAdminSection('quizzes', { skipFetch: true });
}

// ════════════════════════════════════════════════════════
// QUIZZES
// ════════════════════════════════════════════════════════

let quizChapterFilter = '';
function openChapterInQuizzes(chapterId) { quizChapterFilter = chapterId; showAdminSection('quizzes'); }
function clearQuizFilter() { quizChapterFilter = ''; renderQuizzes(); }

function renderQuizzes() {
  const grid = $('quizzes-grid');
  const fc = $('quiz-filter-chip');
  if (quizChapterFilter && !cache.chapters.some(c => c.id === quizChapterFilter)) quizChapterFilter = '';
  fc.innerHTML = quizChapterFilter ? `<span class="filter-chip">${icon('book')} ${escapeHTML(subjectName((cache.chapters.find(c => c.id === quizChapterFilter) || {}).subject_id))} › ${escapeHTML(chapterName(quizChapterFilter))}
    <button onclick="clearQuizFilter()" title="Show all quizzes">✕ Show all</button></span>` : '';
  if (!cache.quizzes.length) { grid.innerHTML = '<div class="empty-state">No quizzes yet. Fastest way: <b>Question Bank → Bulk Import</b> → paste 20 questions → set the time.</div>'; return; }
  const order = { live: 0, closing: 1, scheduled: 2, draft: 3, ended: 4 };
  const list = cache.quizzes.filter(q => !quizChapterFilter || q.chapter_id === quizChapterFilter)
    .sort((a, b) => order[quizStatus(a).key] - order[quizStatus(b).key] || b.created_at.localeCompare(a.created_at));
  if (!list.length) { grid.innerHTML = '<div class="empty-state">No quizzes in this chapter yet. Use <b>Paste questions</b> or <b>Import quiz file</b>.</div>'; return; }
  grid.innerHTML = list.map(q => {
    const s = quizStatus(q);
    const att = cache.attempts.filter(a => a.quiz_id === q.id);
    const done = att.filter(a => a.submitted_at).length;
    const inProg = att.length - done;
    return `<div class="quiz-card">
      <div class="quiz-card-header">
        <div class="quiz-card-title">${escapeHTML(q.title)}</div>
        <div class="quiz-meta">
          <span class="quiz-meta-chip">${escapeHTML(subjectName(q.subject_id) || '—')}${q.chapter_id ? ' › ' + escapeHTML(chapterName(q.chapter_id)) : ''}</span>
          <span class="quiz-meta-chip">${icon('list')} ${(q.question_ids || []).length} Q</span>
          <span class="quiz-meta-chip">${icon('clock')} ${q.duration_min} min</span>
          <span class="quiz-meta-chip mode-${q.mode}">${q.mode === 'practice' ? '⚡ Practice' : '📝 Exam'}</span>
          ${q.target_class ? `<span class="quiz-meta-chip">Class ${escapeHTML(q.target_class)}</span>` : ''}
          ${q.target_batch ? `<span class="quiz-meta-chip">${escapeHTML(q.target_batch)}</span>` : ''}
          ${q.target_centre ? `<span class="quiz-meta-chip">${escapeHTML(shortCentre(q.target_centre))}</span>` : ''}
        </div>
      </div>
      <div class="quiz-card-body">
        <div class="quiz-status-row">
          <span class="status-pill st-${s.key}">${s.key === 'live' ? '● ' : ''}${s.label}</span>
          <label class="quiz-toggle" title="Switch ON / OFF"><input type="checkbox" ${q.active ? 'checked' : ''} onchange="toggleQuizActive('${q.id}', this)"><span class="quiz-toggle-slider"></span></label>
        </div>
        <div class="quiz-schedule">
          <div>${icon('calendar')} ${q.start_at ? 'Starts ' + fmtDateTime(q.start_at) : 'Opens when ON'}</div>
          <div>${icon('clock')} ${q.end_at ? (s.key === 'ended' ? 'Closed ' : 'Closes ') + fmtDateTime(q.end_at) : 'No close time (open until OFF)'}</div>
          ${q.entry_close_at ? `<div>${icon('clock')} Must start before ${fmtDateTime(q.entry_close_at)}</div>` : ''}
          <div>${icon('users')} ${done} submitted${inProg ? ` · <span class="t-green">${inProg} writing now</span>` : ''}</div>
        </div>
        <div class="quiz-card-actions">
          <button class="icon-btn" onclick="openEditQuiz('${q.id}')">${icon('edit')} Edit</button>
          <button class="icon-btn" onclick="duplicateQuiz('${q.id}')">${icon('copy')} Copy</button>
          ${['live', 'closing'].includes(s.key) ? `<button class="icon-btn danger" onclick="closeQuizNow('${q.id}')">${icon('lock')} Close now</button>` : ''}
          <button class="icon-btn" onclick="openAnalyticsFor('${q.id}')">${icon('chart')} Analysis</button>
          <button class="icon-btn danger" onclick="deleteQuiz('${q.id}')">${icon('trash')}</button>
        </div>
      </div></div>`;
  }).join('');
}

function openCreateQuiz() {
  editingQuizId = null;
  $('modal-quiz-title').textContent = 'Create Quiz';
  $('quiz-source-box').style.display = '';
  $('quiz-repick-wrap').style.display = 'none';
  populateSubjectSelect('quiz-subject', 'Select subject');
  populateChapterSelect('quiz-chapter', '', 'All chapters');
  $('quiz-num-q').value = 20;
  mountQuizSettings('quiz-settings-fields', 'qz');
  updatePoolInfo();
  openModal('modal-create-quiz');
}

function openEditQuiz(id) {
  const q = cache.quizzes.find(x => x.id === id);
  if (!q) return;
  editingQuizId = id;
  $('modal-quiz-title').textContent = 'Edit Quiz';
  populateSubjectSelect('quiz-subject', 'Select subject', q.subject_id || '');
  populateChapterSelect('quiz-chapter', q.subject_id, 'All chapters', q.chapter_id || '');
  $('quiz-num-q').value = (q.question_ids || []).length || 20;
  $('quiz-repick').checked = false;
  $('quiz-repick-wrap').style.display = '';
  $('quiz-current-q').textContent = `${(q.question_ids || []).length} questions in this quiz`;
  $('quiz-source-box').style.display = 'none';
  mountQuizSettings('quiz-settings-fields', 'qz', q);
  updatePoolInfo();
  openModal('modal-create-quiz');
}

function onQuizRepickToggle() { $('quiz-source-box').style.display = $('quiz-repick').checked ? '' : 'none'; }
function onQuizSubjectChange() { populateChapterSelect('quiz-chapter', val('quiz-subject'), 'All chapters'); updatePoolInfo(); }

function quizPool() {
  const sid = val('quiz-subject'), cid = val('quiz-chapter');
  let pool = cache.questions.filter(q => q.subject_id === sid);
  if (cid) pool = pool.filter(q => q.chapter_id === cid);
  return pool;
}

function updatePoolInfo() {
  const n = quizPool().length;
  $('quiz-pool-info').textContent = val('quiz-subject') ? `${n} question${n === 1 ? '' : 's'} available` : '';
}

async function saveQuiz() {
  const settings = readQuizSettings('qz');
  if (!settings) return;
  const row = { ...settings };
  const needPick = !editingQuizId || $('quiz-repick').checked;
  if (needPick) {
    if (!val('quiz-subject')) return showToast('Select a subject', 'error');
    const pool = quizPool();
    const n = parseInt($('quiz-num-q').value) || 0;
    if (n < 1) return showToast('Number of questions?', 'error');
    if (pool.length < n) return showToast(`Only ${pool.length} questions available here`, 'warning');
    const how = val('quiz-pick-mode');
    const picked = how === 'random' ? shuffleArray([...pool]).slice(0, n) : [...pool].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, n).reverse();
    row.question_ids = picked.map(q => q.id);
    row.subject_id = val('quiz-subject');
    row.chapter_id = val('quiz-chapter') || null;
  }
  if (editingQuizId && cache.attempts.some(a => a.quiz_id === editingQuizId) && needPick &&
      !confirm('Students have already attempted this quiz. Changing its questions will make old results inconsistent. Continue?')) return;

  const { error } = editingQuizId
    ? await sb.from('qm_quizzes').update(row).eq('id', editingQuizId)
    : await sb.from('qm_quizzes').insert(row);
  if (error) return dbError(error);
  closeModal('modal-create-quiz');
  await reload('quizzes');
  showToast(editingQuizId ? 'Quiz updated' : `Quiz "${row.title}" created`, 'success');
  renderQuizzes();
}

async function toggleQuizActive(id, cb) {
  const { error } = await sb.from('qm_quizzes').update({ active: cb.checked }).eq('id', id);
  if (error) { cb.checked = !cb.checked; return dbError(error); }
  await reload('quizzes');
  const q = cache.quizzes.find(x => x.id === id);
  showToast(cb.checked ? `"${q.title}" is ON – ${quizStatus(q).key === 'scheduled' ? 'opens at ' + fmtDateTime(q.start_at) : 'students can start now'}` : `"${q.title}" switched OFF`, cb.checked ? 'success' : 'info');
  renderQuizzes();
}

async function closeQuizNow(id) {
  const q = cache.quizzes.find(x => x.id === id);
  const writing = cache.attempts.filter(a => a.quiz_id === id && !a.submitted_at).length;
  if (!confirm(`Close "${q.title}" now?${writing ? `\n${writing} student(s) still writing will be submitted automatically.` : ''}`)) return;
  const { error } = await sb.from('qm_quizzes').update({ end_at: new Date(serverNow()).toISOString() }).eq('id', id);
  if (error) return dbError(error);
  await rpc('qm_admin_finalize_expired').catch(() => 0);
  await reload('quizzes', 'attempts');
  showToast(`"${q.title}" closed`, 'info');
  renderQuizzes();
}

async function duplicateQuiz(id) {
  const q = cache.quizzes.find(x => x.id === id);
  if (!q) return;
  const { id: _i, created_at: _c, ...rest } = q;
  const { data, error } = await sb.from('qm_quizzes').insert({ ...rest, title: q.title + ' (copy)', active: false, start_at: null, entry_close_at: null, end_at: null }).select().single();
  if (error) return dbError(error);
  await reload('quizzes');
  showToast('Quiz copied (switched OFF). Set the new time and switch it ON.', 'success');
  openEditQuiz(data.id);
}

async function deleteQuiz(id) {
  const n = cache.attempts.filter(a => a.quiz_id === id).length;
  if (!confirm(`Delete this quiz?${n ? `\n${n} student results of this quiz will also be deleted!` : ''}`)) return;
  const { error } = await sb.from('qm_quizzes').delete().eq('id', id);
  if (error) return dbError(error);
  await reload('quizzes', 'attempts');
  showToast('Quiz deleted', 'warning');
  renderQuizzes();
}

// ════════════════════════════════════════════════════════
// RESULTS
// ════════════════════════════════════════════════════════

function renderResults() {
  fillSelect('res-filter-quiz', cache.quizzes, { placeholder: 'All quizzes', labelKey: 'title', selected: val('res-filter-quiz') });
  fillSelect('res-filter-centre', CONFIG.CENTRES, { placeholder: 'All centres', selected: val('res-filter-centre') });
  fillSelect('res-filter-class', CONFIG.CLASSES.map(c => ({ id: c, name: 'Class ' + c })), { placeholder: 'All classes', selected: val('res-filter-class') });
  const list = filteredResults();
  $('results-count').textContent = `${list.length} result${list.length === 1 ? '' : 's'}`;
  $('results-table').innerHTML = list.length ? resultsTableHTML(list, true) : '<div class="empty-state">No results for this filter.</div>';
}

function filteredResults() {
  const qz = val('res-filter-quiz'), centre = val('res-filter-centre'), cls = val('res-filter-class');
  const s = val('res-search').toLowerCase();
  return submittedAttempts().filter(a => {
    const p = profileById(a.student_id);
    return (!qz || a.quiz_id === qz) && (!centre || p.centre === centre) && (!cls || p.class_name === cls) &&
      (!s || ((p.full_name || '') + ' ' + (p.admission_no || '')).toLowerCase().includes(s));
  }).sort((a, b) => b.submitted_at.localeCompare(a.submitted_at));
}

function resultsTableHTML(list, withActions) {
  return `<div class="results-table-wrapper"><table class="results-table">
    <thead><tr><th>Student</th><th>Centre / Class</th><th>Quiz</th><th>Score</th><th>%</th><th>Time</th>${withActions ? '<th>Tab switch</th>' : ''}<th>Submitted</th>${withActions ? '<th></th>' : ''}</tr></thead>
    <tbody>${list.map(a => {
      const p = profileById(a.student_id), q = cache.quizzes.find(z => z.id === a.quiz_id) || {};
      const pc = pct(a.score, a.total_marks), pass = pc >= (q.pass_pct ?? 40);
      return `<tr>
        <td><b class="t-primary">${escapeHTML(p.full_name || '?')}</b><div class="t-muted small">${escapeHTML(p.admission_no || '')}</div></td>
        <td>${escapeHTML(shortCentre(p.centre))}<div class="t-muted small">Class ${escapeHTML(p.class_name || '')}</div></td>
        <td>${escapeHTML(q.title || '(deleted)')}</td>
        <td><span class="score-pill ${pass ? 'pass' : 'fail'}">${+a.score} / ${+a.total_marks}</span></td>
        <td>${fmtPct(pc)}</td>
        <td>${fmtSecs(a.time_taken_sec)}${a.auto_submitted ? '<div class="t-muted small">auto</div>' : ''}</td>
        ${withActions ? `<td>${a.tab_switches ? `<span class="t-orange">${a.tab_switches}×</span>` : '0'}</td>` : ''}
        <td>${fmtDateTime(a.submitted_at)}</td>
        ${withActions ? `<td><div class="row-actions"><button class="chip-btn" onclick="openReview('${a.id}')">Answers</button>
          <button class="chip-btn bad" title="Delete this result so the student can write again" onclick="allowReattempt('${a.id}')">Re-attempt</button></div></td>` : ''}
      </tr>`;
    }).join('')}</tbody></table></div>`;
}

async function allowReattempt(attemptId) {
  const a = cache.attempts.find(x => x.id === attemptId);
  const p = profileById(a.student_id);
  if (!confirm(`Delete ${p.full_name}'s result so they can write this quiz again?`)) return;
  const { error } = await sb.from('qm_attempts').delete().eq('id', attemptId);
  if (error) return dbError(error);
  await reload('attempts');
  showToast('Result removed – student can attempt again (while the quiz is open)', 'info');
  renderResults();
}

function exportResults() {
  const list = filteredResults();
  const rows = [['Student Name', 'Admission No', 'Centre', 'Class', 'Quiz', 'Score', 'Total', 'Percentage', 'Result', 'Correct', 'Wrong', 'Skipped', 'Time (sec)', 'Tab switches', 'Submitted']];
  list.forEach(a => {
    const p = profileById(a.student_id), q = cache.quizzes.find(z => z.id === a.quiz_id) || {};
    const pc = pct(a.score, a.total_marks);
    rows.push([p.full_name, p.admission_no, p.centre, p.class_name, q.title, a.score, a.total_marks, pc.toFixed(1), pc >= (q.pass_pct ?? 40) ? 'Pass' : 'Fail',
      a.correct_count, a.wrong_count, a.skipped_count, a.time_taken_sec, a.tab_switches, new Date(a.submitted_at).toLocaleString('en-IN')]);
  });
  downloadCSV(rows, 'quiz_results.csv');
  showToast('Results exported', 'success');
}

// ════════════════════════════════════════════════════════
// MARK ANALYSIS
// ════════════════════════════════════════════════════════

let analyticsQSort = 'order';

function openAnalyticsFor(quizId) {
  showAdminSection('analytics');
  switchAnalyticsTab('quiz');
  $('an-quiz').value = quizId;
  renderQuizAnalytics();
}

function openStudentAnalytics(studentId) {
  showAdminSection('analytics');
  switchAnalyticsTab('student');
  $('an-student').value = studentId;
  renderStudentAnalytics();
}

function switchAnalyticsTab(tab) {
  document.querySelectorAll('.an-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('an-quiz-view').style.display = tab === 'quiz' ? '' : 'none';
  $('an-student-view').style.display = tab === 'student' ? '' : 'none';
}

function renderAnalytics() {
  const prevQ = val('an-quiz'), prevS = val('an-student');
  const quizzesWithResults = cache.quizzes.filter(q => submittedAttempts().some(a => a.quiz_id === q.id));
  fillSelect('an-quiz', quizzesWithResults.length ? quizzesWithResults : cache.quizzes, { placeholder: 'Select a quiz', labelKey: 'title', selected: prevQ });
  const st = students().filter(s => s.status === 'approved').sort((a, b) => a.full_name.localeCompare(b.full_name));
  fillSelect('an-student', st.map(s => ({ id: s.id, name: `${s.full_name} (${s.admission_no || ''}) – ${shortCentre(s.centre)} ${s.class_name}` })), { placeholder: 'Select a student', selected: prevS });
  fillSelect('an-centre', CONFIG.CENTRES, { placeholder: 'All centres', selected: val('an-centre') });
  if (!val('an-quiz') && quizzesWithResults.length) $('an-quiz').value = quizzesWithResults[0].id;
  renderQuizAnalytics();
  renderStudentAnalytics();
}

function eligibleStudents(q) {
  return students().filter(s => s.status === 'approved' &&
    (!q.target_class || s.class_name === q.target_class) && (!q.target_centre || s.centre === q.target_centre) &&
    (!q.target_batch || (s.batch || '').toUpperCase() === q.target_batch.toUpperCase()));
}

function renderQuizAnalytics() {
  const out = $('an-quiz-body');
  const q = cache.quizzes.find(z => z.id === val('an-quiz'));
  if (!q) { out.innerHTML = '<div class="empty-state">Select a quiz to see its analysis.</div>'; return; }
  const centre = val('an-centre');
  let atts = submittedAttempts().filter(a => a.quiz_id === q.id);
  if (centre) atts = atts.filter(a => profileById(a.student_id).centre === centre);
  const inProgress = cache.attempts.filter(a => a.quiz_id === q.id && !a.submitted_at);
  let eligible = eligibleStudents(q);
  if (centre) eligible = eligible.filter(s => s.centre === centre);
  const attemptedIds = new Set(cache.attempts.filter(a => a.quiz_id === q.id).map(a => a.student_id));
  const absent = eligible.filter(s => !attemptedIds.has(s.id));

  if (!atts.length) {
    out.innerHTML = `<div class="empty-state">No submissions yet for this quiz${centre ? ' at this centre' : ''}.
      ${inProgress.length ? `<br><b class="t-green">${inProgress.length} student(s) writing now.</b>` : ''}</div>` + absentHTML(absent);
    return;
  }

  const total = +atts[0].total_marks || 0;
  const pcs = atts.map(a => pct(a.score, a.total_marks));
  const scores = atts.map(a => +a.score);
  const avg = pcs.reduce((x, y) => x + y, 0) / pcs.length;
  const sorted = [...pcs].sort((a, b) => a - b);
  const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const passN = pcs.filter(p => p >= q.pass_pct).length;
  const avgTime = atts.reduce((x, a) => x + (a.time_taken_sec || 0), 0) / atts.length;

  const stat = (label, value, sub, color) => `<div class="stat-card compact" style="--accent:${color}"><div class="stat-info"><h3>${value}</h3><p>${label}${sub ? `<br><span class="t-muted small">${sub}</span>` : ''}</p></div></div>`;
  let html = `<div class="an-head">
      <div><h2>${escapeHTML(q.title)}</h2>
      <p class="t-muted">${escapeHTML(subjectName(q.subject_id))}${q.chapter_id ? ' › ' + escapeHTML(chapterName(q.chapter_id)) : ''} · ${(q.question_ids || []).length} questions · ${total} marks · ${q.mode === 'practice' ? 'Practice' : 'Exam'} mode</p></div>
      <div class="row-actions no-print"><button class="btn-secondary" onclick="exportAnalyticsCSV()">${icon('download')} Rank list CSV</button><button class="btn-secondary" onclick="window.print()">${icon('printer')} Print / PDF</button></div>
    </div>
    <div class="stats-grid">
      ${stat('Submitted', atts.length, `${absent.length} not attempted${inProgress.length ? ` · ${inProgress.length} writing` : ''}`, '#667eea')}
      ${stat('Average', fmtPct(avg), `${(scores.reduce((x, y) => x + y, 0) / scores.length).toFixed(1)} / ${total} marks`, '#4facfe')}
      ${stat('Highest', Math.max(...scores) + ' / ' + total, `Lowest ${Math.min(...scores)} · Median ${fmtPct(median)}`, '#43e97b')}
      ${stat('Pass rate', fmtPct(pct(passN, atts.length)), `${passN} of ${atts.length} scored ≥ ${q.pass_pct}%`, '#f093fb')}
      ${stat('Avg. time', fmtSecs(avgTime), `of ${q.duration_min} min`, '#fa8231')}
    </div>`;

  // distribution
  const buckets = Array.from({ length: 10 }, (_, i) => ({ lo: i * 10, hi: i === 9 ? 100 : i * 10 + 9, n: 0 }));
  pcs.forEach(p => buckets[Math.min(9, Math.floor(p / 10))].n++);
  const maxB = Math.max(...buckets.map(b => b.n), 1);
  html += `<div class="an-card"><h3>Score distribution</h3><p class="t-muted small">How many students scored in each percentage band</p>
    <div class="histogram">${buckets.map(b => `<div class="hist-col" title="${b.lo}–${b.hi}%: ${b.n} student${b.n === 1 ? '' : 's'}">
      <span class="hist-val">${b.n || ''}</span><div class="hist-bar ${b.lo + 10 <= q.pass_pct ? 'below' : ''}" style="height:${(b.n / maxB) * 100}%"></div><span class="hist-label">${b.lo}${b.lo === 90 ? '+' : ''}</span></div>`).join('')}</div>
    <p class="t-muted small">Lighter bars = below the pass mark (${q.pass_pct}%).</p></div>`;

  // question-wise
  const qstats = questionStats(q, atts);
  const qs = analyticsQSort === 'hard' ? [...qstats].sort((a, b) => a.pc - b.pc) : qstats;
  html += `<div class="an-card"><div class="an-card-head"><div><h3>Question-wise analysis</h3>
      <p class="t-muted small">Which questions students found difficult, and the wrong option they chose most (common misunderstanding).</p></div>
      <div class="seg no-print"><button class="${analyticsQSort === 'order' ? 'active' : ''}" onclick="analyticsQSort='order';renderQuizAnalytics()">Paper order</button><button class="${analyticsQSort === 'hard' ? 'active' : ''}" onclick="analyticsQSort='hard';renderQuizAnalytics()">Hardest first</button></div></div>
    <div class="qa-list">${qs.map(s => `<div class="qa-row">
      <div class="qa-num">Q${s.no}</div>
      <div class="qa-main">
        <div class="qa-text">${escapeHTML(s.q ? s.q.text : '(question deleted)')}</div>
        <div class="qa-bar-wrap"><div class="qa-bar" style="width:${s.pc}%"></div></div>
        <div class="qa-opts">${['A', 'B', 'C', 'D'].filter(k => s.q && s.q.options[k]).map(k =>
          `<span class="qa-opt ${s.q.correct === k ? 'right' : (k === s.topWrong && s.counts[k] > 0 ? 'trap' : '')}" title="${escapeHTML(s.q.options[k])}">${k}: ${s.counts[k]}${s.q.correct === k ? ' ✓' : ''}</span>`).join('')}
          <span class="qa-opt">Skipped: ${s.skipped}</span></div>
        ${s.topWrong && s.counts[s.topWrong] > 0 ? `<div class="qa-trap">Most chosen wrong answer: <b>${s.topWrong})</b> ${escapeHTML(s.q.options[s.topWrong])} — ${s.counts[s.topWrong]} student${s.counts[s.topWrong] === 1 ? '' : 's'}</div>` : ''}
      </div>
      <div class="qa-pc"><b>${Math.round(s.pc)}%</b><span class="diff diff-${s.level}">${s.level}</span></div>
    </div>`).join('')}</div></div>`;

  // centre / class comparison
  const groupBy = (keyFn) => {
    const m = {};
    atts.forEach(a => { const k = keyFn(profileById(a.student_id)) || '—'; (m[k] = m[k] || []).push(pct(a.score, a.total_marks)); });
    return Object.entries(m).map(([k, arr]) => ({ k, n: arr.length, avg: arr.reduce((x, y) => x + y, 0) / arr.length })).sort((a, b) => b.avg - a.avg);
  };
  const byCentre = groupBy(p => shortCentre(p.centre)), byClass = groupBy(p => p.class_name ? 'Class ' + p.class_name : '');
  const hbars = rows => rows.map(r => `<div class="hbar-row" title="${escapeHTML(r.k)}: average ${fmtPct(r.avg)} (${r.n} students)"><span class="hbar-label">${escapeHTML(r.k)}</span><div class="hbar-track"><div class="hbar" style="width:${r.avg}%"></div></div><span class="hbar-val">${fmtPct(r.avg)} <span class="t-muted">· ${r.n}</span></span></div>`).join('');
  if (byCentre.length > 1 || byClass.length > 1) {
    html += `<div class="an-grid2">
      ${byCentre.length > 1 ? `<div class="an-card"><h3>Centre comparison</h3><p class="t-muted small">Average % · number of students</p>${hbars(byCentre)}</div>` : ''}
      ${byClass.length > 1 ? `<div class="an-card"><h3>Class comparison</h3><p class="t-muted small">Average % · number of students</p>${hbars(byClass)}</div>` : ''}</div>`;
  }

  // rank list
  const ranked = rankAttempts(atts);
  html += `<div class="an-card"><h3>Rank list</h3><div class="results-table-wrapper"><table class="results-table">
    <thead><tr><th>Rank</th><th>Student</th><th>Centre / Class</th><th>Score</th><th>%</th><th>✓ / ✗ / –</th><th>Time</th><th>Tab switch</th></tr></thead>
    <tbody>${ranked.map(r => { const p = profileById(r.a.student_id); const pc = pct(r.a.score, r.a.total_marks); return `<tr>
      <td><b class="rank rank-${r.rank <= 3 ? r.rank : 'n'}">${r.rank <= 3 ? ['🥇', '🥈', '🥉'][r.rank - 1] : r.rank}</b></td>
      <td><b class="t-primary">${escapeHTML(p.full_name || '?')}</b><div class="t-muted small">${escapeHTML(p.admission_no || '')}</div></td>
      <td>${escapeHTML(shortCentre(p.centre))}<div class="t-muted small">Class ${escapeHTML(p.class_name || '')}</div></td>
      <td><span class="score-pill ${pc >= q.pass_pct ? 'pass' : 'fail'}">${+r.a.score} / ${+r.a.total_marks}</span></td>
      <td>${fmtPct(pc)}</td><td>${r.a.correct_count} / ${r.a.wrong_count} / ${r.a.skipped_count}</td>
      <td>${fmtSecs(r.a.time_taken_sec)}</td><td>${r.a.tab_switches ? `<span class="t-orange">${r.a.tab_switches}×</span>` : '0'}</td></tr>`; }).join('')}</tbody></table></div></div>`;

  html += absentHTML(absent);
  out.innerHTML = html;
}

function absentHTML(absent) {
  if (!absent.length) return '';
  return `<div class="an-card"><h3>Not attempted (${absent.length})</h3><p class="t-muted small">Approved students of this class/centre who did not start the quiz</p>
    <div class="absent-list">${absent.sort((a, b) => a.full_name.localeCompare(b.full_name)).map(s => `<span class="absent-chip">${escapeHTML(s.full_name)} <span class="t-muted">${escapeHTML(s.admission_no || '')}</span></span>`).join('')}</div></div>`;
}

function questionStats(q, atts) {
  return (q.question_ids || []).map((qid, i) => {
    const qq = cache.questions.find(x => x.id === qid);
    const counts = { A: 0, B: 0, C: 0, D: 0 };
    let skipped = 0, right = 0;
    atts.forEach(a => {
      const c = (a.answers || {})[qid];
      if (!c) skipped++; else { counts[c] = (counts[c] || 0) + 1; if (qq && c === qq.correct) right++; }
    });
    const pc = atts.length ? (right / atts.length) * 100 : 0;
    const wrongKeys = ['A', 'B', 'C', 'D'].filter(k => qq && k !== qq.correct);
    const topWrong = wrongKeys.sort((a, b) => counts[b] - counts[a])[0];
    return { no: i + 1, q: qq, counts, skipped, right, pc, topWrong, level: pc >= 75 ? 'Easy' : pc >= 40 ? 'Medium' : 'Hard' };
  });
}

function rankAttempts(atts) {
  const s = [...atts].sort((a, b) => b.score - a.score || (a.time_taken_sec || 0) - (b.time_taken_sec || 0));
  let rank = 0, prev = null;
  return s.map((a, i) => { if (prev === null || +a.score !== prev) { rank = i + 1; prev = +a.score; } return { a, rank }; });
}

function exportAnalyticsCSV() {
  const q = cache.quizzes.find(z => z.id === val('an-quiz'));
  if (!q) return;
  const centre = val('an-centre');
  let atts = submittedAttempts().filter(a => a.quiz_id === q.id);
  if (centre) atts = atts.filter(a => profileById(a.student_id).centre === centre);
  const rows = [['Rank', 'Name', 'Admission No', 'Centre', 'Class', 'Score', 'Total', '%', 'Correct', 'Wrong', 'Skipped', 'Time (sec)', 'Tab switches']];
  rankAttempts(atts).forEach(({ a, rank }) => {
    const p = profileById(a.student_id);
    rows.push([rank, p.full_name, p.admission_no, p.centre, p.class_name, a.score, a.total_marks, pct(a.score, a.total_marks).toFixed(1), a.correct_count, a.wrong_count, a.skipped_count, a.time_taken_sec, a.tab_switches]);
  });
  rows.push([]);
  rows.push(['Question', 'Correct answer', '% correct', 'A', 'B', 'C', 'D', 'Skipped']);
  questionStats(q, atts).forEach(s => rows.push([`Q${s.no}: ${s.q ? s.q.text : ''}`, s.q ? s.q.correct : '', s.pc.toFixed(1), s.counts.A, s.counts.B, s.counts.C, s.counts.D, s.skipped]));
  downloadCSV(rows, `${q.title.replace(/[^\wഀ-ൿ]+/g, '_')}_analysis.csv`);
}

// Student report
function renderStudentAnalytics() {
  const out = $('an-student-body');
  const s = profileById(val('an-student'));
  if (!s.id) { out.innerHTML = '<div class="empty-state">Select a student to see their progress across quizzes.</div>'; return; }
  const atts = submittedAttempts().filter(a => a.student_id === s.id).sort((a, b) => a.submitted_at.localeCompare(b.submitted_at));
  if (!atts.length) { out.innerHTML = `<div class="empty-state">${escapeHTML(s.full_name)} has not completed any quiz yet.</div>`; return; }
  const rows = atts.map(a => {
    const q = cache.quizzes.find(z => z.id === a.quiz_id) || {};
    const all = submittedAttempts().filter(x => x.quiz_id === a.quiz_id);
    const classAvg = all.reduce((x, y) => x + pct(y.score, y.total_marks), 0) / all.length;
    const rank = (rankAttempts(all).find(r => r.a.id === a.id) || {}).rank;
    return { a, q, pc: pct(a.score, a.total_marks), classAvg, rank, of: all.length };
  });
  const avg = rows.reduce((x, r) => x + r.pc, 0) / rows.length;
  const bySub = {};
  rows.forEach(r => { const k = subjectName(r.q.subject_id) || '—'; (bySub[k] = bySub[k] || []).push(r.pc); });
  const subRows = Object.entries(bySub).map(([k, arr]) => ({ k, n: arr.length, avg: arr.reduce((x, y) => x + y, 0) / arr.length })).sort((a, b) => b.avg - a.avg);

  out.innerHTML = `<div class="an-head"><div><h2>${escapeHTML(s.full_name)}</h2><p class="t-muted">${escapeHTML(s.admission_no || '')} · ${escapeHTML(s.centre)} · Class ${escapeHTML(s.class_name)}</p></div>
      <div class="row-actions no-print"><button class="btn-secondary" onclick="window.print()">${icon('printer')} Print / PDF</button></div></div>
    <div class="stats-grid">
      <div class="stat-card compact" style="--accent:#667eea"><div class="stat-info"><h3>${rows.length}</h3><p>Quizzes completed</p></div></div>
      <div class="stat-card compact" style="--accent:#4facfe"><div class="stat-info"><h3>${fmtPct(avg)}</h3><p>Average score</p></div></div>
      <div class="stat-card compact" style="--accent:#43e97b"><div class="stat-info"><h3>${fmtPct(Math.max(...rows.map(r => r.pc)))}</h3><p>Best score</p></div></div>
      <div class="stat-card compact" style="--accent:#fa8231"><div class="stat-info"><h3>${rows.filter(r => r.pc >= (r.q.pass_pct ?? 40)).length}/${rows.length}</h3><p>Passed</p></div></div>
    </div>
    <div class="an-card"><h3>Progress over time</h3><p class="t-muted small">Score % in each quiz (dashed line = class average)</p>${lineChartSVG(rows.map(r => ({ y: r.pc, y2: r.classAvg, label: r.q.title || '' })))}</div>
    ${subRows.length > 1 ? `<div class="an-card"><h3>Subject-wise average</h3>${subRows.map(r => `<div class="hbar-row"><span class="hbar-label">${escapeHTML(r.k)}</span><div class="hbar-track"><div class="hbar" style="width:${r.avg}%"></div></div><span class="hbar-val">${fmtPct(r.avg)} <span class="t-muted">· ${r.n}</span></span></div>`).join('')}</div>` : ''}
    <div class="an-card"><h3>All quizzes</h3><div class="results-table-wrapper"><table class="results-table">
      <thead><tr><th>Quiz</th><th>Date</th><th>Score</th><th>%</th><th>Class avg</th><th>Rank</th><th></th></tr></thead>
      <tbody>${[...rows].reverse().map(r => `<tr><td>${escapeHTML(r.q.title || '(deleted)')}</td><td>${fmtDate(r.a.submitted_at)}</td>
        <td><span class="score-pill ${r.pc >= (r.q.pass_pct ?? 40) ? 'pass' : 'fail'}">${+r.a.score} / ${+r.a.total_marks}</span></td><td>${fmtPct(r.pc)}</td>
        <td>${fmtPct(r.classAvg)}</td><td>${r.rank} of ${r.of}</td><td><button class="chip-btn" onclick="openReview('${r.a.id}')">Answers</button></td></tr>`).join('')}</tbody></table></div></div>`;
}

function lineChartSVG(points) {
  const W = 640, H = 220, L = 36, R = 12, T = 12, B = 28;
  const n = points.length;
  const x = i => n === 1 ? (L + (W - L - R) / 2) : L + i * (W - L - R) / (n - 1);
  const y = v => T + (100 - v) * (H - T - B) / 100;
  const grid = [0, 50, 100].map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="lc-grid"/><text x="${L - 6}" y="${y(v) + 4}" class="lc-axis" text-anchor="end">${v}</text>`).join('');
  const path = k => points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join(' ');
  const dots = points.map((p, i) => `<g class="lc-pt"><circle cx="${x(i)}" cy="${y(p.y)}" r="9" class="lc-hit"/><circle cx="${x(i)}" cy="${y(p.y)}" r="4.5" class="lc-dot"/><title>${escapeHTML(p.label)}: ${fmtPct(p.y)} (class avg ${fmtPct(p.y2)})</title></g>`).join('');
  const xl = n <= 12 ? points.map((p, i) => `<text x="${x(i)}" y="${H - 8}" class="lc-axis" text-anchor="middle">${i + 1}</text>`).join('') : '';
  return `<svg viewBox="0 0 ${W} ${H}" class="line-chart" role="img" aria-label="Score trend">${grid}
    <path d="${path('y2')}" class="lc-line2"/><path d="${path('y')}" class="lc-line"/>${dots}${xl}</svg>`;
}

// ════════════════════════════════════════════════════════
// ANSWER REVIEW (student + admin)
// ════════════════════════════════════════════════════════

let lastReview = null;
async function openReview(attemptId) {
  $('review-body').innerHTML = '<div class="empty-state">Loading…</div>';
  openModal('modal-review');
  try {
    const r = await rpc('qm_get_review', { p_attempt: attemptId });
    if (r.error) { lastReview = null; $('review-body').innerHTML = `<div class="empty-state">🔒 ${escapeHTML(ERR[r.error] || r.error)}${r.quiz_end ? `<br><span class="t-muted small">Opens after ${fmtDateTime(r.quiz_end)}</span>` : ''}</div>`; return; }
    lastReview = { r, attemptId };
    renderReview(r, attemptId);
  } catch (e) { $('review-body').innerHTML = ''; closeModal('modal-review'); dbError(e); }
}

function renderReview(r, attemptId) {
  $('review-title').textContent = r.title;
  updateLangButtons();
  const right = r.items.filter(it => it.chosen === it.correct).length;
  $('review-body').innerHTML = `<p class="t-muted">${right} of ${r.items.length} correct</p>` + r.items.map((it, i) => {
    const order = optionOrder(it.id, it.options, r.shuffle_options, attemptId);
    const L = ['A', 'B', 'C', 'D'];
    const exp = tExp(it);
    return `<div class="review-item ${it.chosen === it.correct ? 'ok' : it.chosen ? 'bad' : 'skip'}">
      <div class="review-q"><span class="review-status">${it.chosen === it.correct ? '✓' : it.chosen ? '✗' : '–'}</span> ${i + 1}. <span class="pre">${escapeHTML(tText(it))}</span></div>
      <div class="review-options">${order.map((k, j) => {
        const cls = k === it.correct ? 'correct-answer' : (k === it.chosen ? 'wrong-answer' : '');
        return `<div class="review-option ${cls}"><b>${L[j]})</b> ${escapeHTML(tOpt(it, k))}${k === it.chosen ? ' <span class="your-tag">your answer</span>' : ''}</div>`;
      }).join('')}</div>
      ${!it.chosen ? '<div class="review-explanation">Not answered</div>' : ''}
      ${exp ? `<div class="review-explanation">💡 ${escapeHTML(exp)}</div>` : ''}
    </div>`;
  }).join('');
}

// ════════════════════════════════════════════════════════
// STUDENT DASHBOARD
// ════════════════════════════════════════════════════════

async function openStudentDashboard() {
  $('student-greeting-text').textContent = `Welcome, ${me.full_name.split(' ')[0]}! 👋`;
  $('student-class-badge').textContent = `Class ${me.class_name} · ${shortCentre(me.centre)}`;
  showPage('page-student');
  updateLangButtons();
  switchStudentTab('quizzes');
  await loadStudentData();
  clearInterval(dashboardTimer); clearInterval(dashboardRefresh);
  dashboardTimer = setInterval(tickStudentDashboard, 1000);
  dashboardRefresh = setInterval(() => { if (!quizState && $('page-student').classList.contains('active')) loadStudentData(true); }, 60000);
}

async function loadStudentData(silent = false) {
  try {
    const [quizzes, subjects, chapters, mine] = await Promise.all([
      fetchAll('qm_quizzes', 'created_at', false), fetchAll('qm_subjects'), fetchAll('qm_chapters', 'sort_order'), rpc('qm_my_attempts')
    ]);
    Object.assign(cache, { quizzes, subjects, chapters });
    myAttempts = mine || [];
    renderAvailableQuizzes();
    renderStudentResults();
  } catch (e) { if (!silent) dbError(e); }
}

async function refreshStudent() {
  const btn = $('btn-student-refresh');
  setBusy(btn, true, '↻');
  await syncServerClock();
  await loadStudentData();
  setBusy(btn, false);
}

function switchStudentTab(tab) {
  document.querySelectorAll('.stab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.student-section').forEach(s => s.classList.toggle('active', s.id === `stu-${tab}`));
}

function studentQuizState(q) {
  const att = myAttempts.find(a => a.quiz_id === q.id);
  const s = quizStatus(q);
  const now = serverNow();
  if (att && att.submitted_at) return { key: 'done', att, s };
  if (att && new Date(att.deadline).getTime() > now) return { key: 'resume', att, s };
  if (att) return { key: 'expired', att, s };
  if (s.key === 'scheduled') return { key: 'soon', s, ms: s.start - now };
  if (s.key === 'live') return { key: 'open', s, closeMs: s.startBy ? s.startBy - now : null };
  return { key: 'closed', s };
}

// ── Student home: Subject buttons → chapter list. Tap a chapter to open its quiz. ──
const SUBJECT_ML = { physics: 'ഭൗതികശാസ്ത്രം', chemistry: 'രസതന്ത്രം', biology: 'ജീവശാസ്ത്രം', english: 'ഇംഗ്ലീഷ്', mathematics: 'ഗണിതം', maths: 'ഗണിതം',
  history: 'ചരിത്രം', geography: 'ഭൂമിശാസ്ത്രം', 'social science': 'സാമൂഹ്യശാസ്ത്രം', malayalam: 'മലയാളം', hindi: 'ഹിന്ദി', 'information technology': 'വിവരസാങ്കേതികവിദ്യ', it: 'ഐ.ടി.' };
function subjectLabel(name) {
  const ml = SUBJECT_ML[String(name || '').toLowerCase()];
  return getLang() === 'ml' && ml ? ml : name;
}
// "Unit 5 – Electrical Energy (വൈദ്യുതോർജം)" → shows the Malayalam or English part by the medium toggle
function chapterLabel(name) {
  const m = String(name || '').match(/^(.*?)\s+–\s+(.*?)\s+\(([^()]*)\)\s*$/);
  if (!m) {
    const k = String(name || '').match(/^((?:Unit|Ch|Chapter)\s*\d+)\s+–\s+(.*)$/);   // "Ch 1 – खिड़की"
    return k ? { label: k[1], text: k[2] } : { label: '', text: name || '' };
  }
  return { label: m[1], text: getLang() === 'ml' && /[ഀ-ൿ]/.test(m[3]) ? m[3] : m[2] };
}
const SUBJECT_ORDER = ['physics', 'chemistry', 'biology', 'mathematics', 'maths', 'social science', 'history', 'geography', 'economics', 'english', 'malayalam', 'hindi', 'information technology', 'it'];
function subjectRank(name) { const i = SUBJECT_ORDER.indexOf(String(name || '').toLowerCase()); return i === -1 ? 99 : i; }
let studentSubject = (() => { try { return localStorage.getItem('qm_subj') || ''; } catch (e) { return ''; } })();
function pickStudentSubject(id) { studentSubject = id; try { localStorage.setItem('qm_subj', id); } catch (e) { } renderAvailableQuizzes(); const a = document.querySelector('.subj-chip.active'); if (a) a.scrollIntoView({ block: 'nearest', inline: 'center' }); }

function renderAvailableQuizzes() {
  const grid = $('student-quizzes-grid');
  const en = getLang() === 'en';
  const list = cache.quizzes.map(q => ({ q, st: studentQuizState(q) })).filter(x => x.st.key !== 'closed');
  if (!list.length) {
    $('student-subject-chips').innerHTML = '';
    grid.innerHTML = '<div class="empty-state">ഇപ്പോൾ quiz ഒന്നുമില്ല. ടീച്ചർ quiz ഇടുമ്പോൾ ഇവിടെ കാണാം.<br><span class="small">No quizzes right now.</span></div>';
    return;
  }
  // subjects that have quizzes
  const subjIds = [...new Set(list.map(x => x.q.subject_id || ''))];
  const subjects = subjIds.map(id => ({ id, name: subjectName(id) || (en ? 'Other' : 'മറ്റുള്ളവ'), color: (cache.subjects.find(s => s.id === id) || {}).color || '#667eea' }))
    .sort((a, b) => subjectRank(a.name) - subjectRank(b.name) || a.name.localeCompare(b.name));
  if (studentSubject && !subjIds.includes(studentSubject)) studentSubject = '';
  const liveCount = id => list.filter(x => (!id || x.q.subject_id === id) && ['open', 'resume'].includes(x.st.key)).length;
  $('student-subject-chips').innerHTML = [{ id: '', name: en ? 'All' : 'എല്ലാം', color: '#667eea' }, ...subjects].map(s => {
    const n = liveCount(s.id);
    return `<button class="subj-chip ${studentSubject === s.id ? 'active' : ''}" style="--c:${escapeHTML(s.color)}" onclick="pickStudentSubject('${s.id}')">
      ${s.id ? `<span class="subj-dot"></span>` : ''}${escapeHTML(s.id ? subjectLabel(s.name) : s.name)}${n ? `<span class="subj-live">${n}</span>` : ''}</button>`;
  }).join('');

  const shown = subjects.filter(s => !studentSubject || s.id === studentSubject);
  grid.innerHTML = shown.map(s => {
    const items = list.filter(x => (x.q.subject_id || '') === s.id).sort((a, b) => {
      const ca = cache.chapters.find(c => c.id === a.q.chapter_id) || {}, cb = cache.chapters.find(c => c.id === b.q.chapter_id) || {};
      return (ca.sort_order || 0) - (cb.sort_order || 0) || a.q.title.localeCompare(b.q.title);
    });
    // how many quizzes share a chapter → then show the quiz title too
    const perChapter = {};
    items.forEach(x => perChapter[x.q.chapter_id] = (perChapter[x.q.chapter_id] || 0) + 1);
    return `<section class="subj-block">
      <div class="subj-head" style="--c:${escapeHTML(s.color)}"><span class="subj-dot"></span><h3>${escapeHTML(subjectLabel(s.name))}</h3><span class="t-muted small">${items.length} ${en ? 'chapters' : 'അധ്യായങ്ങൾ'}</span></div>
      <div class="ch-list">${items.map(x => chapterRowHTML(x.q, x.st, perChapter[x.q.chapter_id] > 1 || !x.q.chapter_id)).join('')}</div>
    </section>`;
  }).join('');
}

function chapterRowHTML(q, st, showTitle) {
  const en = getLang() === 'en';
  const ch = chapterLabel(chapterName(q.chapter_id) || q.title);
  const num = (ch.label.match(/\d+/) || [''])[0];
  const nQ = (q.question_ids || []).length;
  let status = '', act = '';
  if (st.key === 'open') {
    act = `<span class="ch-btn go">${en ? 'Start' : 'തുടങ്ങുക'} ${icon('play')}</span>`;
    if (st.closeMs !== null) status = `<span class="warn">${icon('clock')} ${en ? 'Closes in' : 'അടയാൻ'} <span class="countdown" data-until="${st.s.startBy}">${fmtCountdown(st.closeMs)}</span></span>`;
  } else if (st.key === 'resume') {
    act = `<span class="ch-btn resume">${en ? 'Continue' : 'തുടരുക'} ${icon('play')}</span>`;
    status = `<span class="warn">${en ? 'In progress' : 'എഴുതിക്കൊണ്ടിരിക്കുന്നു'}</span>`;
  } else if (st.key === 'soon') {
    act = `<span class="ch-btn wait">${icon('clock')} <span class="countdown" data-until="${st.s.start}">${fmtCountdown(st.ms)}</span></span>`;
    status = `${en ? 'Opens' : 'തുറക്കുന്നത്'} ${fmtDateTime(q.start_at)}`;
  } else if (st.key === 'done') {
    const p = pct(st.att.score, st.att.total_marks);
    act = `<span class="ch-score ${p >= (st.att.pass_pct ?? 40) ? 'pass' : 'fail'}">${+st.att.score}/${+st.att.total_marks}</span>`;
    status = `<span class="t-green">✓ ${en ? 'Done' : 'പൂർത്തിയായി'}</span> · ${st.att.review_open ? (en ? 'tap to see answers' : 'ഉത്തരങ്ങൾ കാണാൻ തൊടുക') : '🔒 ' + (en ? 'answers later' : 'ഉത്തരങ്ങൾ പിന്നീട്')}`;
  } else {
    act = `<span class="ch-btn off">${en ? 'Time over' : 'സമയം കഴിഞ്ഞു'}</span>`;
  }
  return `<div class="ch-row state-${st.key}" data-title="${escapeHTML(q.title)}" role="button" tabindex="0" onclick="openChapterQuiz('${q.id}')" onkeydown="if(event.key==='Enter')openChapterQuiz('${q.id}')">
    <div class="ch-num">${num || icon('list')}</div>
    <div class="ch-main">
      <div class="ch-name">${escapeHTML(ch.text)}</div>
      ${showTitle ? `<div class="ch-title">${escapeHTML(q.title)}</div>` : ''}
      <div class="ch-sub">${nQ} Q · ${q.duration_min} min · ${q.mode === 'practice' ? '⚡' : '📝'}${status ? ' · ' + status : ''}</div>
    </div>
    <div class="ch-act">${act}</div>
  </div>`;
}

function openChapterQuiz(quizId) {
  const q = cache.quizzes.find(z => z.id === quizId);
  if (!q) return;
  const st = studentQuizState(q), en = getLang() === 'en';
  if (st.key === 'open' || st.key === 'resume') return startQuiz(quizId);
  if (st.key === 'done') return st.att.review_open ? openReview(st.att.attempt_id)
    : showToast(en ? 'Answers will be shown after the quiz ends for everyone.' : ERR.REVIEW_LOCKED, 'info');
  if (st.key === 'soon') return showToast((en ? 'This quiz opens at ' : 'ഈ quiz തുറക്കുന്നത്: ') + fmtDateTime(q.start_at), 'info');
  showToast(en ? 'Time for this quiz is over.' : 'ഈ quiz-ന്റെ സമയം കഴിഞ്ഞു.', 'warning');
}

function tickStudentDashboard() {
  if (!$('page-student').classList.contains('active')) return;
  let needRender = false;
  document.querySelectorAll('.countdown[data-until]').forEach(el => {
    const ms = +el.dataset.until - serverNow();
    if (ms <= 0) needRender = true;
    el.textContent = fmtCountdown(ms);
  });
  if (needRender) renderAvailableQuizzes();
}

function renderStudentResults() {
  const done = myAttempts.filter(a => a.submitted_at);
  const box = $('student-results-list');
  if (!done.length) { box.innerHTML = '<div class="empty-state">ഇതുവരെ quiz ഒന്നും എഴുതിയിട്ടില്ല.</div>'; $('student-results-summary').innerHTML = ''; return; }
  const pcs = done.map(a => pct(a.score, a.total_marks));
  const avg = pcs.reduce((x, y) => x + y, 0) / pcs.length;
  $('student-results-summary').innerHTML = `<div class="stats-grid">
    <div class="stat-card compact" style="--accent:#667eea"><div class="stat-info"><h3>${done.length}</h3><p>Quizzes written</p></div></div>
    <div class="stat-card compact" style="--accent:#4facfe"><div class="stat-info"><h3>${fmtPct(avg)}</h3><p>Average</p></div></div>
    <div class="stat-card compact" style="--accent:#43e97b"><div class="stat-info"><h3>${fmtPct(Math.max(...pcs))}</h3><p>Best</p></div></div></div>
    ${done.length > 1 ? `<div class="an-card"><h3>My progress</h3>${lineChartSVG([...done].reverse().map(a => ({ y: pct(a.score, a.total_marks), y2: pct(a.score, a.total_marks), label: a.title })))}</div>` : ''}`;
  box.innerHTML = `<div class="results-table-wrapper"><table class="results-table">
    <thead><tr><th>Quiz</th><th>Date</th><th>Score</th><th>%</th><th>✓ / ✗ / –</th><th></th></tr></thead>
    <tbody>${done.map(a => { const pc = pct(a.score, a.total_marks); return `<tr><td>${escapeHTML(a.title)}</td><td>${fmtDate(a.submitted_at)}</td>
      <td><span class="score-pill ${pc >= a.pass_pct ? 'pass' : 'fail'}">${+a.score} / ${+a.total_marks}</span></td><td>${fmtPct(pc)}</td>
      <td>${a.correct} / ${a.wrong} / ${a.skipped}</td>
      <td>${a.review_open ? `<button class="chip-btn" onclick="openReview('${a.attempt_id}')">Answers</button>` : '<span class="t-muted small">🔒 later</span>'}</td></tr>`; }).join('')}</tbody></table></div>`;
}

// ════════════════════════════════════════════════════════
// QUIZ ENGINE (student)
// ════════════════════════════════════════════════════════

async function startQuiz(quizId) {
  const q = cache.quizzes.find(z => z.id === quizId);
  const resuming = myAttempts.some(a => a.quiz_id === quizId);
  if (!resuming && !confirm(`"${q.title}" തുടങ്ങട്ടെ?\n\n• ${(q.question_ids || []).length} ചോദ്യങ്ങൾ, ${q.duration_min} മിനിറ്റ്\n• Start അമർത്തിയാൽ സമയം ഓടിത്തുടങ്ങും (page അടച്ചാലും നിൽക്കില്ല)\n${q.mode === 'practice' ? '• ഓരോ ഉത്തരവും ഉടനെ ശരിയാണോ എന്ന് കാണിക്കും. ഒരിക്കൽ തിരഞ്ഞെടുത്താൽ മാറ്റാൻ പറ്റില്ല.' : '• Submit ചെയ്യുന്നതുവരെ ഉത്തരം മാറ്റാം.'}`)) return;

  let r;
  try { r = await rpc('qm_start_attempt', { p_quiz: quizId }); }
  catch (e) { return dbError(e); }
  if (r.error) { showToast(ERR[r.error] || r.error, r.error === 'TIME_OVER' ? 'warning' : 'error'); return loadStudentData(true); }

  serverOffset = new Date(r.server_now).getTime() - Date.now();
  quizState = {
    attemptId: r.attempt_id, quizId: r.quiz_id, title: r.title, mode: r.mode, shuffleOptions: r.shuffle_options,
    deadline: new Date(r.deadline).getTime(), questions: r.questions, answers: r.answers || {}, feedback: r.feedback || {},
    pending: {}, busy: false, currentIdx: 0, tabSwitches: +(localStorage.getItem(`qm_tabs_${r.attempt_id}`) || 0), submitting: false
  };
  // re-send answers that were saved on this phone while offline
  try { Object.assign(quizState.pending, JSON.parse(localStorage.getItem(`qm_pending_${r.attempt_id}`) || '{}')); } catch (e) { }
  Object.assign(quizState.answers, quizState.pending);

  const firstOpen = quizState.questions.findIndex(x => !quizState.answers[x.id]);
  quizState.currentIdx = firstOpen === -1 ? 0 : firstOpen;

  $('quiz-taking-title').textContent = r.title;
  $('quiz-taking-subtitle').textContent = [subjectName(q.subject_id), chapterName(q.chapter_id)].filter(Boolean).join(' › ');
  $('quiz-mode-chip').textContent = r.mode === 'practice' ? '⚡ Practice' : '📝 Exam';
  showPage('page-quiz');
  buildQuizNav();
  renderQuizQuestion();
  startQuizRuntime();
  if (resuming) showToast('Quiz തുടരുന്നു – സമയം നിന്നിട്ടില്ല.', 'info');
  flushPending();
}

function startQuizRuntime() {
  stopQuizRuntime();
  updateTimerDisplay();
  quizTimer = setInterval(() => {
    updateTimerDisplay();
    if (quizState && quizState.deadline - serverNow() <= 0) { stopQuizRuntime(); showToast('സമയം കഴിഞ്ഞു! Submitting…', 'warning'); submitQuiz(true); }
  }, 500);
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('beforeunload', onBeforeUnload);
  window.addEventListener('online', flushPending);
}

function stopQuizRuntime() {
  clearInterval(quizTimer); quizTimer = null; clearTimeout(autoNextTimer);
  document.removeEventListener('visibilitychange', onVisibilityChange);
  window.removeEventListener('beforeunload', onBeforeUnload);
  window.removeEventListener('online', flushPending);
}

function onVisibilityChange() {
  if (document.hidden && quizState) {
    quizState.tabSwitches++;
    localStorage.setItem(`qm_tabs_${quizState.attemptId}`, quizState.tabSwitches);
  } else if (!document.hidden && quizState) {
    syncServerClock();
    flushPending();
  }
}

function onBeforeUnload(e) { if (quizState && !quizState.submitting) { e.preventDefault(); e.returnValue = ''; } }

function updateTimerDisplay() {
  if (!quizState) return;
  const left = Math.max(0, Math.floor((quizState.deadline - serverNow()) / 1000));
  const h = Math.floor(left / 3600), m = Math.floor((left % 3600) / 60), s = left % 60;
  $('timer-display').textContent = (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  $('quiz-timer').classList.toggle('warning', left <= 60);
}

const DISPLAY_LETTERS = ['A', 'B', 'C', 'D'];

// ── Malayalam / English medium ──
// Malayalam is stored in text/options/explanation, English in *_en. A missing English version falls back to Malayalam.
function getLang() {
  try { const v = localStorage.getItem('qm_lang'); if (v === 'ml' || v === 'en') return v; } catch (e) { }
  return me && /\bEM\b|ENGLISH/i.test(me.batch || '') ? 'en' : 'ml';
}
function setLang(l) {
  try { localStorage.setItem('qm_lang', l); } catch (e) { }
  updateLangButtons();
  if ($('page-student').classList.contains('active')) { renderAvailableQuizzes(); renderStudentResults(); }
  if (quizState && $('page-quiz').classList.contains('active')) renderQuizQuestion();
  if ($('modal-review').classList.contains('open') && lastReview) renderReview(lastReview.r, lastReview.attemptId);
}
function updateLangButtons() {
  const l = getLang();
  document.querySelectorAll('.lang-toggle button').forEach(b => b.classList.toggle('active', b.dataset.lang === l));
}
const tText = q => (getLang() === 'en' && q.text_en) ? q.text_en : q.text;
const tOpt = (q, k) => (getLang() === 'en' && q.options_en && q.options_en[k]) ? q.options_en[k] : (q.options || {})[k];
const tExp = q => (getLang() === 'en' && q.explanation_en) ? q.explanation_en : (q.explanation || '');

function renderQuizQuestion() {
  const st = quizState, q = st.questions[st.currentIdx], total = st.questions.length;
  $('q-current').textContent = st.currentIdx + 1;
  $('q-total').textContent = total;
  $('question-number-badge').textContent = `Question ${st.currentIdx + 1} of ${total}${+q.marks !== 1 ? ` · ${+q.marks} marks` : ''}`;
  $('question-text').textContent = tText(q);
  updateLangButtons();
  $('quiz-progress-bar').style.width = (Object.keys(st.answers).length / total * 100) + '%';

  const order = optionOrder(q.id, q.options, st.shuffleOptions, st.attemptId);
  const chosen = st.answers[q.id];
  const fb = st.mode === 'practice' ? st.feedback[q.id] : null;
  $('options-grid').innerHTML = order.map((k, i) => {
    let cls = 'option-btn';
    if (fb) {
      if (k === fb.correct) cls += ' is-correct';
      else if (k === fb.chosen) cls += ' is-wrong';
      else cls += ' is-dim';
    } else if (chosen === k) cls += ' selected';
    const mark = fb ? (k === fb.correct ? '<span class="opt-mark">✓</span>' : (k === fb.chosen ? '<span class="opt-mark">✗</span>' : '')) : '';
    return `<button class="${cls}" ${fb || st.busy ? 'disabled' : ''} onclick="selectOption('${k}')"><span class="option-label">${DISPLAY_LETTERS[i]}</span><span class="opt-text">${escapeHTML(tOpt(q, k))}</span>${mark}</button>`;
  }).join('');

  const fbBox = $('answer-feedback');
  if (fb) {
    const correctLetter = DISPLAY_LETTERS[order.indexOf(fb.correct)];
    fbBox.className = 'answer-feedback ' + (fb.is_correct ? 'good' : 'bad');
    // only right / wrong here – explanations are shown in "See answers" after the quiz
    const en = getLang() === 'en';
    const last = st.currentIdx === total - 1;
    const nextNote = st.autoNext === q.id && !last ? `<span class="fb-next">${en ? 'Next question…' : 'അടുത്ത ചോദ്യം…'}</span>` : '';
    fbBox.innerHTML = fb.is_correct
      ? `<div class="fb-title">✓ ${en ? 'Correct!' : 'ശരി!'}${nextNote}</div>`
      : `<div class="fb-title">✗ ${en ? 'Wrong · Answer' : 'തെറ്റ് · ശരിയുത്തരം'}: ${correctLetter}${nextNote}</div>`;
  } else if (st.busy) {
    fbBox.className = 'answer-feedback checking'; fbBox.innerHTML = '<div class="fb-title">Checking…</div>';
  } else { fbBox.className = 'answer-feedback'; fbBox.innerHTML = ''; }

  // one question at a time: Next / Submit only after this question is answered
  const answered = st.mode === 'practice' ? !!st.feedback[q.id] : !!st.answers[q.id];
  const isLast = st.currentIdx === total - 1;
  $('btn-prev').style.display = 'none';
  $('btn-next').style.display = isLast ? 'none' : 'flex';
  $('btn-next').disabled = !answered;
  $('btn-submit').style.display = isLast ? 'flex' : 'none';
  $('btn-submit').disabled = !answered;
  $('answer-hint').textContent = answered ? '' : (getLang() === 'en' ? 'Choose an answer to continue' : 'തുടരാൻ ഒരു ഉത്തരം തിരഞ്ഞെടുക്കുക');
  updatePracticeScore();
  updateNavGrid();
}

function updatePracticeScore() {
  const el = $('quiz-practice-score');
  if (quizState.mode !== 'practice') { el.style.display = 'none'; return; }
  const f = Object.values(quizState.feedback);
  el.style.display = '';
  el.innerHTML = `<span class="t-green">✓ ${f.filter(x => x.is_correct).length}</span> <span class="t-red">✗ ${f.filter(x => !x.is_correct).length}</span>`;
}

async function selectOption(key) {
  const st = quizState;
  if (!st || st.submitting) return;
  const q = st.questions[st.currentIdx];

  if (st.mode === 'practice') {
    if (st.feedback[q.id] || st.busy) return;
    st.busy = true;
    st.answers[q.id] = key;
    renderQuizQuestion();
    try {
      const r = await rpc('qm_answer', { p_attempt: st.attemptId, p_question: q.id, p_choice: key });
      if (r.error) return handleAnswerError(r.error);
      st.feedback[q.id] = { chosen: r.chosen, correct: r.correct, is_correct: r.is_correct, explanation: r.explanation, explanation_en: r.explanation_en };
      st.answers[q.id] = r.chosen;
      scheduleAutoNext(st, q.id, r.is_correct ? 1200 : 2000);
    } catch (e) {
      delete st.answers[q.id];
      showToast('Network problem – ഉത്തരം വീണ്ടും തിരഞ്ഞെടുക്കുക.', 'error');
    } finally {
      st.busy = false;
      if (quizState === st && $('page-quiz').classList.contains('active')) renderQuizQuestion();
    }
    return;
  }

  // exam mode: save in background, can change until submit
  st.answers[q.id] = key;
  st.pending[q.id] = key;
  savePendingLocal();
  renderQuizQuestion();
  flushPending();
}

function savePendingLocal() {
  if (!quizState) return;
  localStorage.setItem(`qm_pending_${quizState.attemptId}`, JSON.stringify(quizState.pending));
}

let flushing = false;
async function flushPending() {
  const st = quizState;
  if (!st || flushing || st.mode === 'practice') return true;
  const ids = Object.keys(st.pending);
  if (!ids.length) { setSyncStatus('saved'); return true; }
  flushing = true;
  setSyncStatus('saving');
  let ok = true;
  for (const qid of ids) {
    const choice = st.pending[qid];
    try {
      const r = await rpc('qm_answer', { p_attempt: st.attemptId, p_question: qid, p_choice: choice });
      if (r.error) { flushing = false; handleAnswerError(r.error); return false; }
      if (st.pending[qid] === choice) delete st.pending[qid];
    } catch (e) { ok = false; break; }
  }
  savePendingLocal();
  flushing = false;
  if (!ok) { setSyncStatus('offline'); setTimeout(flushPending, 4000); return false; }
  if (Object.keys(st.pending).length) return flushPending();
  setSyncStatus('saved');
  return true;
}

function setSyncStatus(s) {
  const el = $('btn-auto-save-status');
  if (!el) return;
  el.className = 'btn-auto-save sync-' + s;
  el.innerHTML = s === 'saving' ? `${icon('refresh')} Saving…` : s === 'offline' ? `${icon('wifi-off')} Offline – will retry` : `${icon('check')} Saved`;
}

function handleAnswerError(code) {
  if (code === 'TIME_OVER' || code === 'ALREADY_SUBMITTED') {
    showToast(ERR[code], 'warning');
    submitQuiz(true);
  } else showToast(ERR[code] || code, 'error');
}

// after an answer: wait a moment (longer when wrong, to see the right answer), then go to the next question
let autoNextTimer = null;
function scheduleAutoNext(st, qid, ms) {
  clearTimeout(autoNextTimer);
  const idx = st.questions.findIndex(x => x.id === qid);
  if (idx >= st.questions.length - 1) return;           // last question → student presses Submit
  st.autoNext = qid;
  autoNextTimer = setTimeout(() => {
    if (quizState !== st || st.submitting || st.questions[st.currentIdx].id !== qid) return;  // student moved already
    st.autoNext = null;
    goToQuestion(idx + 1);
  }, ms);
}
function cancelAutoNext() { clearTimeout(autoNextTimer); if (quizState) quizState.autoNext = null; }

function currentAnswered() {
  const st = quizState, q = st.questions[st.currentIdx];
  return st.mode === 'practice' ? !!st.feedback[q.id] : !!st.answers[q.id];
}
function quizNext() {
  if (!quizState || !currentAnswered()) return;                 // must answer before moving on
  cancelAutoNext();
  if (quizState.currentIdx < quizState.questions.length - 1) { quizState.currentIdx++; renderQuizQuestion(); scrollQuizTop(); }
}
function quizPrev() { /* going back is not allowed */ }
function goToQuestion(i) {
  // only used internally (auto-next); never lets a student skip ahead past an unanswered question
  const st = quizState;
  if (i > st.currentIdx && !currentAnswered()) return;
  st.currentIdx = i; renderQuizQuestion(); scrollQuizTop();
}
function scrollQuizTop() { const qp = document.querySelector('.question-panel'); if (qp) qp.scrollTop = 0; if (window.innerWidth < 900 && window.innerWidth > 640) $('quiz-container').scrollIntoView({ behavior: 'smooth', block: 'start' }); }

function buildQuizNav() {
  // progress only – students cannot jump to any question they like
  const html = quizState.questions.map((_, i) => `<span class="nav-btn locked">${i + 1}</span>`).join('');
  $('question-nav-grid').innerHTML = html;
  $('mobile-nav-strip').innerHTML = html;
}

function updateNavGrid() {
  const st = quizState;
  ['question-nav-grid', 'mobile-nav-strip'].forEach(id => {
    $(id).querySelectorAll('.nav-btn').forEach((btn, i) => {
      const q = st.questions[i];
      const fb = st.feedback[q.id];
      btn.className = 'nav-btn locked';
      if (i === st.currentIdx) btn.classList.add('current');
      else if (st.mode === 'practice' && fb) btn.classList.add(fb.is_correct ? 'right' : 'wrong');
      else if (st.answers[q.id]) btn.classList.add('answered');
    });
  });
  const cur = $('mobile-nav-strip').querySelector('.current');
  if (cur) cur.scrollIntoView({ block: 'nearest', inline: 'center' });
}

async function submitQuiz(auto = false) {
  const st = quizState;
  if (!st || st.submitting) return;
  if (!auto && !currentAnswered()) return showToast(getLang() === 'en' ? 'Answer this question first' : 'ആദ്യം ഈ ചോദ്യത്തിന് ഉത്തരം നൽകുക', 'warning');
  if (!auto) {
    const left = st.questions.filter(q => !st.answers[q.id]).length;
    if (!confirm(left ? `${left} ചോദ്യങ്ങൾക്ക് ഉത്തരം നൽകിയിട്ടില്ല. എങ്കിലും submit ചെയ്യട്ടെ?` : 'Quiz submit ചെയ്യട്ടെ? ഇനി മാറ്റാൻ പറ്റില്ല.')) return;
  }
  st.submitting = true;
  stopQuizRuntime();
  $('btn-submit').disabled = true;
  showToast('Submitting…', 'info');

  if (st.mode === 'exam') await flushPending();
  let res = null;
  for (let attempt = 0; attempt < 4 && !res; attempt++) {
    try { res = await rpc('qm_submit', { p_attempt: st.attemptId, p_tab_switches: st.tabSwitches, p_auto: auto }); }
    catch (e) { await new Promise(r => setTimeout(r, 2000)); }
  }
  $('btn-submit').disabled = false;
  if (!res || res.error) {
    st.submitting = false;
    startQuizRuntime();
    return showToast('Submit ചെയ്യാൻ കഴിഞ്ഞില്ല (network). Internet ശരിയാക്കി വീണ്ടും Submit അമർത്തുക. സമയം കഴിഞ്ഞാലും ഉത്തരങ്ങൾ server-ൽ ഉണ്ട്.', 'error');
  }
  ['qm_pending_', 'qm_tabs_'].forEach(k => localStorage.removeItem(k + st.attemptId));
  const attemptId = st.attemptId;
  quizState = null;
  showResultPage(res, attemptId);
  loadStudentData(true);
}

function showResultPage(res, attemptId) {
  const p = pct(res.score, res.total_marks), passed = p >= res.pass_pct;
  const circumference = 2 * Math.PI * 54;
  const ring = $('result-progress-ring');
  ring.style.strokeDasharray = circumference;
  ring.style.strokeDashoffset = circumference;
  ring.style.stroke = passed ? '#43e97b' : '#f5576c';
  setTimeout(() => { ring.style.strokeDashoffset = circumference - (p / 100) * circumference; }, 100);
  $('result-score-num').textContent = +res.score;
  $('result-score-out').textContent = `/ ${+res.total_marks}`;
  $('result-title').textContent = p >= 90 ? 'Outstanding! 🏆' : p >= 75 ? 'Excellent! 🎉' : passed ? 'Well done! 👍' : 'Keep practising 💪';
  $('result-subtitle').textContent = `${res.title} · ${fmtPct(p)}`;
  $('rs-correct').textContent = res.correct;
  $('rs-wrong').textContent = res.wrong;
  $('rs-skipped').textContent = res.skipped;
  $('rs-time').textContent = fmtSecs(res.time_taken_sec);
  const rb = $('btn-review-answers');
  if (res.review_open) { rb.style.display = ''; rb.onclick = () => openReview(attemptId); $('review-later-note').textContent = ''; }
  else {
    rb.style.display = 'none';
    $('review-later-note').textContent = res.quiz_end ? `🔒 ശരിയുത്തരങ്ങൾ ${fmtDateTime(res.quiz_end)}-ന് ശേഷം "My Results"-ൽ കാണാം.` : '🔒 ശരിയുത്തരങ്ങൾ quiz അവസാനിച്ച ശേഷം കാണാം.';
  }
  showPage('page-result');
}

function backToDashboard() { showPage('page-student'); switchStudentTab('quizzes'); renderAvailableQuizzes(); }

// ════════════════════════════════════════════════════════
// ICONS (inline SVG)
// ════════════════════════════════════════════════════════

const ICONS = {
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  'user-plus': '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  chart: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  play: '<polygon points="5 3 19 12 5 21 5 3"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  printer: '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  'wifi-off': '<line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.58 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>',
  home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  quiz: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  menu: '<line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/>',
  'chev-left': '<polyline points="15 18 9 12 15 6"/>',
  'chev-right': '<polyline points="9 18 15 12 9 6"/>',
  send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  'eye-off': '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>',
  key: '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>',
  mail: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>',
};

function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

function hydrateIcons(root = document) {
  root.querySelectorAll('i[data-icon]').forEach(el => { el.outerHTML = icon(el.dataset.icon); });
}

document.addEventListener('DOMContentLoaded', () => { hydrateIcons(); init(); });

// home-screen app (Android "Install app"); the service worker does not cache anything
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => { }));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { extractQuizArray, normaliseQuizFile, smartParseQuestionsText, parseTabularQuestions, seededShuffle, optionOrder, rankAttempts, fmtCountdown };
}
