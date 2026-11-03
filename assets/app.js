/* AÖF Sınav Robotu — tek dosya uygulama (derleme gerektirmez) */
(function () {
/* AÖF Sınav Robotu v22 — çekirdek: depolama, göç, model */
'use strict';

const APP_VERSION = '22.0';
const LS = {
  data: 'aof_full_data',        // dersler + sorular + soru istatistikleri (v21 ile aynı anahtar)
  wrongOld: 'aof_wrong_bank',   // v21: yanlış soruların tam kopyaları (göç sonrası silinir)
  wrong: 'aof_wrong_ids',       // v22: yanlış soru kimlikleri
  schema: 'aof_schema',
  hist: 'aof_exam_history',
  live: 'aof_exam_live',
  session: 'aof_session',
  settings: 'aof_settings',
  theme: 'aof_theme',
  proxy: 'aof_custom_proxy',
  backup: 'aof_backup_v21'
};
const DAY = 864e5;
const BOX_DAYS = [0, 1, 3, 7, 14, 30];   // Leitner kutu aralıkları (gün)
const MAX_BOX = BOX_DAYS.length - 1;
const NO_KEY = 'Bilinmiyor';

let courses = [];
let wrongIds = new Set();
let examHistory = [];
let settings = { autoAdvance: true, advanceDelay: 900 };
let qIndex = new Map();          // id -> { q, course }
let dataLoadFailed = false;

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
const clampInt = (v, lo, hi) => { v = parseInt(v, 10); if (!Number.isFinite(v)) v = lo; return Math.max(lo, Math.min(hi, v)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const icon = (id, cls = '') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;
const dayStart = (t = Date.now()) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function safeImg(u) {
  try { const x = new URL(String(u)); return x.protocol === 'https:' ? x.href : ''; } catch (e) { return ''; }
}
const CANCELLED = 'İptal';
function normAns(a) {
  const raw = String(a == null ? '' : a).trim();
  const s = raw.toUpperCase();
  if (/^[A-E]$/.test(s)) return s;
  if (raw === 'İ' || s === 'İPTAL' || raw === CANCELLED) return CANCELLED; // aofsoru: iptal edilen soru
  return NO_KEY;
}
function hasKey(q) { return /^[A-E]$/.test(q.ans); }

function readJSON(k, def) {
  try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch (e) { return def; }
}
function writeJSON(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); return true; }
  catch (e) {
    toast('Kaydedilemedi: tarayıcı depolaması dolu olabilir. Ayarlar’dan yedek alıp kullanmadığınız dersleri kaldırın.', 'err', 6000);
    return false;
  }
}

/* ---------- Yükleme ve v21 → v22 göçü ---------- */
function detectUniFromUrl(u) {
  const s = String(u || '').toLowerCase();
  if (s.includes('ataaofsoru')) return 'ata';
  if (s.includes('aofsoru')) return 'anadolu';
  return null;
}
function prettyLegacyTitle(t) {
  // v21 Anadolu başlıkları: "HUK121U TEMEL HUKUK BILGISI DERSI" → "Temel Hukuk Bilgisi"
  if (!/^[A-Z0-9 ]+$/.test(t || '')) return null;
  const parts = t.trim().split(/\s+/);
  let code = '';
  if (/^[A-Z]{2,4}\d{3}[A-Z]?$/.test(parts[0])) code = parts.shift();
  if (parts[parts.length - 1] === 'DERSI') parts.pop();
  const title = parts.map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
  return { code, title };
}
function deriveKey(c) {
  const img = (c.questions[0] && c.questions[0].img) || '';
  const m = img.match(/image\.aofsoru\.com\/\d+\/(.+?)-\d{4}-\d{4}-yili/);
  if (m) return 'anadolu:' + m[1];
  return (c.uni || 'x') + ':t:' + String(c.title || '').toLowerCase();
}
function normalizeCourse(c) {
  const now = Date.now();
  const seen = new Set();
  c.questions = c.questions.filter((q) => q && (q.id || q.img)).map((q) => {
    q.id = String(q.id || q.img);
    q.img = String(q.img || q.id);
    q.ans = normAns(q.ans);
    q.title = String(q.title || '');
    const s = q.qStats = Object.assign({ mastery: 0, correct: 0, wrong: 0 }, q.qStats || {});
    s.mastery = clampInt(s.mastery, 0, 100); s.correct = clampInt(s.correct, 0, 1e6); s.wrong = clampInt(s.wrong, 0, 1e6);
    if (s.box == null) s.box = s.mastery >= 100 ? 2 : s.mastery >= 50 ? 1 : 0;
    s.box = clampInt(s.box, 0, MAX_BOX);
    if (s.seen == null) s.seen = (s.correct + s.wrong) > 0;
    if (s.seen && !Number.isFinite(s.due)) s.due = now;
    return q;
  }).filter((q) => (seen.has(q.id) ? false : (seen.add(q.id), true)));
  c.uni = c.uni || detectUniFromUrl(c.questions[0] && c.questions[0].img) || 'anadolu';
  c.title = String(c.title || 'Ders');
  if (!c.code && !c.key) {
    const p = prettyLegacyTitle(c.title);
    if (p) { c.code = p.code; c.displayTitle = p.title; }
  }
  c.key = c.key || deriveKey(c);
  c.lastIndex = clampInt(c.lastIndex, 0, c.questions.length);
  return c;
}
function rebuildIndex() {
  qIndex = new Map();
  for (const c of courses) for (const q of c.questions) {
    const ex = qIndex.get(q.id);
    if (ex) q.qStats = ex.q.qStats; // aynı soru iki derste: istatistik paylaşılır
    else qIndex.set(q.id, { q, course: c });
  }
}
function loadAll() {
  settings = Object.assign({ autoAdvance: true, advanceDelay: 900 }, readJSON(LS.settings, {}) || {});
  const raw = localStorage.getItem(LS.data);
  let arr = [];
  if (raw) {
    try { arr = JSON.parse(raw); if (!Array.isArray(arr)) throw new Error('format'); }
    catch (e) {
      dataLoadFailed = true;
      try { localStorage.setItem('aof_corrupt_' + Date.now(), raw); } catch (_) {}
      arr = [];
    }
  }
  const schema = localStorage.getItem(LS.schema);
  if (raw && schema !== '2' && !dataLoadFailed) {
    try {
      if (!localStorage.getItem(LS.backup)) {
        localStorage.setItem(LS.backup, JSON.stringify({ at: Date.now(), data: raw, wrong: localStorage.getItem(LS.wrongOld) }));
      }
    } catch (e) { /* yer yoksa yedeği atla */ }
  }
  courses = arr.filter((c) => c && Array.isArray(c.questions)).map(normalizeCourse);
  rebuildIndex();

  let ids = readJSON(LS.wrong, null);
  if (!Array.isArray(ids)) {
    const old = readJSON(LS.wrongOld, []);
    ids = Array.isArray(old) ? old.map((q) => q && (q.id || q.img)).filter(Boolean) : [];
  }
  wrongIds = new Set(ids.filter((id) => qIndex.has(id) && hasKey(qIndex.get(id).q)));
  examHistory = readJSON(LS.hist, []);
  if (!Array.isArray(examHistory)) examHistory = [];

  if (schema !== '2' && !dataLoadFailed) {
    if (saveAll()) {
      localStorage.setItem(LS.schema, '2');
      localStorage.removeItem(LS.wrongOld);
    }
  }
}
let saveTimer = 0;
function saveAll() {
  if (dataLoadFailed && courses.length === 0) return false; // bozuk veriyi boşla ezme
  clearTimeout(saveTimer);
  const ok1 = writeJSON(LS.data, courses);
  const ok2 = writeJSON(LS.wrong, Array.from(wrongIds));
  return ok1 && ok2;
}
function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveAll, 250); }
function saveHistory() { if (examHistory.length > 60) examHistory = examHistory.slice(-60); writeJSON(LS.hist, examHistory); }
function saveSettings() { writeJSON(LS.settings, settings); }

/* ---------- Model yardımcıları ---------- */
function courseName(c) { return c.displayTitle || String(c.title).replace(/\s+Dersi$/i, ''); }
function uniLabel(u) { return u === 'ata' ? 'Atatürk AÖF' : 'Anadolu AÖF'; }
function getCourse(key) { return courses.find((c) => c.key === key); }
function isMastered(q) { return q.qStats.mastery >= 100; }
function isDue(q, now = Date.now()) { const s = q.qStats; return !!s.seen && (!Number.isFinite(s.due) || s.due <= now); }
function allUnique() { return Array.from(qIndex.values()).map((x) => x.q); }

function statsFor(qs) {
  const now = Date.now();
  const st = { total: 0, seen: 0, mastered: 0, correct: 0, wrong: 0, due: 0, wrongNow: 0, flagged: 0, noted: 0, fresh: 0 };
  const seenIds = new Set();
  for (const q of qs) {
    if (seenIds.has(q.id)) continue; seenIds.add(q.id);
    if (!hasKey(q)) continue; // cevap anahtarı olmayan / iptal sorular istatistiğe girmez
    const s = q.qStats; st.total++;
    if (s.seen) st.seen++; else st.fresh++;
    if (isMastered(q)) st.mastered++;
    st.correct += s.correct; st.wrong += s.wrong;
    if (isDue(q, now)) st.due++;
    if (wrongIds.has(q.id)) st.wrongNow++;
    if (s.flag) st.flagged++;
    if (s.note) st.noted++;
  }
  st.pct = st.total ? Math.round((st.mastered / st.total) * 100) : 0;
  st.acc = (st.correct + st.wrong) ? Math.round((st.correct / (st.correct + st.wrong)) * 100) : null;
  return st;
}
function examGroups(c) {
  const map = new Map();
  for (const q of c.questions) {
    const k = q.title || 'Diğer';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(q);
  }
  return Array.from(map, ([title, qs]) => ({ title, qs }));
}

/* Cevap kaydı: kavrama (v21 ile aynı: +50 / sıfırlama) + Leitner kutusu */
function recordAnswer(q, letter) {
  const s = q.qStats;
  const ok = letter === q.ans;
  s.seen = true; s.last = Date.now();
  if (ok) {
    s.correct++;
    s.mastery = Math.min(100, s.mastery + 50);
    s.box = Math.min(MAX_BOX, (s.box || 0) + 1);
    s.due = dayStart() + BOX_DAYS[s.box] * DAY;
    wrongIds.delete(q.id);
  } else {
    s.wrong++;
    s.mastery = 0;
    s.box = 0;
    s.due = Date.now();
    wrongIds.add(q.id);
  }
  return ok;
}
function dueLabel(q) {
  const s = q.qStats;
  if (!s.seen) return 'Yeni soru';
  if (!Number.isFinite(s.due) || s.due <= Date.now()) return 'Tekrar zamanı';
  const d = Math.round((dayStart(s.due) - dayStart()) / DAY);
  return d <= 0 ? 'Bugün' : d === 1 ? 'Yarın tekrar' : `${d} gün sonra tekrar`;
}
/* ---------- Bağlantı: özel Worker + yedek proxyler ---------- */
function cleanAndFormatProxyUrl(raw) {
  if (!raw) return '';
  let url = String(raw).trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  if (!url.includes('?')) url = url.endsWith('/') ? url + '?url=' : url + '/?url=';
  else if (!url.endsWith('=') && !url.endsWith('&') && !url.endsWith('?')) url = url + '&url=';
  return url;
}
function proxyList() {
  const custom = cleanAndFormatProxyUrl(localStorage.getItem(LS.proxy) || '');
  const list = [];
  if (custom) list.push({ name: 'Özel Worker', kind: 'raw', trust: true, build: (u) => custom + encodeURIComponent(u) });
  list.push({ name: 'Doğrudan bağlantı', kind: 'raw', trust: true, build: (u) => u, timeout: 6000 });
  list.push(
    { name: 'AllOrigins', kind: 'raw', trust: true, build: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
    { name: 'AllOrigins (JSON)', kind: 'json', trust: true, build: (u) => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}&_=${Date.now()}` },
    { name: 'CodeTabs', kind: 'raw', trust: false, build: (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}` },
    { name: 'CorsProxy.io', kind: 'raw', trust: false, build: (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}` }
  );
  return list;
}
let preferredProxy = 0;
const NOT_FOUND_MARKERS = ['ARADIĞINIZ SAYFA BULUNAMADI', '<title>Sayfa Bulunamadı'];
function isNotFoundHtml(t) { return NOT_FOUND_MARKERS.some((m) => t.includes(m)); }
function looksLikeSite(t) { return typeof t === 'string' && t.length > 500 && /aofsoru/i.test(t); }

async function fetchWithTimeout(url, ms, extSignal) {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  if (extSignal) { if (extSignal.aborted) ctl.abort(); else extSignal.addEventListener('abort', onAbort, { once: true }); }
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { signal: ctl.signal, credentials: 'omit', cache: 'no-store' }); }
  finally { clearTimeout(t); if (extSignal) extSignal.removeEventListener('abort', onAbort); }
}

/** Sonuç: { html } | { notFound: true } | { error: 'mesaj' } */
async function fetchHtml(url, signal) {
  const list = proxyList();
  if (preferredProxy >= list.length) preferredProxy = 0;
  const order = [preferredProxy, ...list.map((_, i) => i).filter((i) => i !== preferredProxy)];
  let lastErr = 'bağlantı kurulamadı';
  for (const idx of order) {
    if (signal && signal.aborted) return { error: 'iptal edildi' };
    const p = list[idx];
    try {
      const res = await fetchWithTimeout(p.build(url), p.timeout || 15000, signal);
      let text = null, status = res.status;
      if (p.kind === 'json') {
        if (!res.ok) { lastErr = `${p.name}: HTTP ${res.status}`; continue; }
        const j = await res.json();
        text = j && typeof j.contents === 'string' ? j.contents : null;
        if (j && j.status && j.status.http_code) status = j.status.http_code;
      } else {
        text = await res.text();
      }
      if ((status === 404 || status === 410) && p.trust) { preferredProxy = idx; return { notFound: true }; }
      if (text && isNotFoundHtml(text)) { preferredProxy = idx; return { notFound: true }; }
      if (!(status >= 200 && status < 300)) { lastErr = `${p.name}: HTTP ${status}`; continue; }
      if (!looksLikeSite(text)) { lastErr = `${p.name}: beklenmeyen yanıt`; continue; }
      preferredProxy = idx;
      return { html: text, via: p.name };
    } catch (e) {
      lastErr = `${p.name}: ${e && e.name === 'AbortError' ? 'zaman aşımı' : 'erişilemedi'}`;
    }
  }
  return { error: `${list.length} bağlantı yolu denendi; son: ${lastErr}` };
}
function parseDoc(html) { return new DOMParser().parseFromString(html, 'text/html'); }
function absImg(src, host) {
  if (!src) return '';
  src = src.trim();
  if (src.startsWith('//')) src = 'https:' + src;
  else if (!/^https?:/i.test(src)) src = `https://${host}` + (src.startsWith('/') ? '' : '/') + src;
  return safeImg(src.replace(/^http:/i, 'https:'));
}
const PLACEHOLDER_RX = /(soru-bg\.gif|loading\.gif|lazy|placeholder)/i;
function imgSrc(img) {
  const ds = img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('data-lazy') || '';
  const s = img.getAttribute('src') || '';
  return ds || (PLACEHOLDER_RX.test(s) ? '' : s);
}

/* ---------- Link çözümleme ---------- */
const ANA_KINDS = { 'ara': 'Ara Sınav', 'donem-sonu': 'Dönem Sonu (Final)', 'yaz-okulu': 'Yaz Okulu', 'tek-ders': 'Tek Ders', 'butunleme': 'Bütünleme' };
const ATA_KINDS = { 'ara': 'Ara Sınav', 'final': 'Final', 'butunleme': 'Bütünleme', 'yaz-okulu': 'Yaz Okulu', 'mevzuniyet-uc-ders': 'Mezuniyet (3 Ders)', 'mezuniyet-uc-ders': 'Mezuniyet (3 Ders)' };
const ATA_TERMS = { 'guz': 'Güz', 'bahar': 'Bahar', 'yaz-okulu': 'Yaz' };
const TYPE_OPTIONS = {
  anadolu: [
    ['ara', 'Ara sınav (vize)', ['ara']],
    ['final', 'Final (dönem sonu)', ['donem-sonu']],
    ['ara-final', 'Ara + final', ['ara', 'donem-sonu']],
    ['yaz-okulu', 'Yaz okulu', ['yaz-okulu']],
    ['tek-ders', 'Tek ders', ['tek-ders']],
    ['all', 'Tümü', null]
  ],
  ata: [
    ['ara', 'Ara sınav (vize)', ['ara']],
    ['final', 'Final', ['final']],
    ['butunleme', 'Bütünleme', ['butunleme']],
    ['final-but', 'Final + bütünleme', ['final', 'butunleme']],
    ['yaz-okulu', 'Yaz okulu', ['yaz-okulu']],
    ['mezuniyet', 'Mezuniyet (3 ders)', ['mevzuniyet-uc-ders', 'mezuniyet-uc-ders']],
    ['all', 'Tümü', null]
  ]
};
function kindsFor(uni, type) {
  const row = (TYPE_OPTIONS[uni] || []).find((r) => r[0] === type);
  return row ? row[2] : (TYPE_OPTIONS[uni] || [])[0][2];
}
function cleanPath(u) {
  let p = u.pathname.replace(/\/+$/, '');
  p = p.replace(/^\/(mobile|amp)(?=\/)/, '');
  p = p.replace(/\/amp$/, '');
  return p;
}
/** Kullanıcının yapıştırdığı linki çözümler. */
function analyzeLink(raw) {
  let s = String(raw || '').trim();
  if (!s) return { empty: true };
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  let u;
  try { u = new URL(s); } catch (e) { return { error: 'Geçerli bir adres değil' }; }
  const host = u.hostname.replace(/^www\.|^m\./, '');
  const path = cleanPath(u);
  if (host === 'aofsoru.com') {
    let m;
    if ((m = path.match(/^\/(.+?)-(\d{4})-(\d{4})-yili-.+-sinav-sorulari$/))) return { uni: 'anadolu', slug: m[1] };
    if ((m = path.match(/^\/(.+?-dersi)(?:-notlari-ozetleri-ve)?-sinav-sorulari$/))) return { uni: 'anadolu', slug: m[1] };
    if ((m = path.match(/^\/(.+?-dersi)-/))) return { uni: 'anadolu', slug: m[1] };
    if (/-bolumu-sinav-sorulari$/.test(path)) return { error: 'Bu bir bölüm sayfası — dersin kendi sayfasını açın' };
    if ((m = path.match(/^\/(.+?)-sinav-sorulari$/))) return { uni: 'anadolu', slug: m[1] };
    return { error: 'Anadolu ders linki tanınmadı' };
  }
  if (host === 'ataaofsoru.com') {
    if (/^\/ata-aof-.+-dersi-\d+$/.test(path)) return { uni: 'ata', courseUrl: 'https://ataaofsoru.com' + path };
    if (/-sinavi-cikmis-sinav-sorulari-\d+$/.test(path)) return { uni: 'ata', examUrl: 'https://ataaofsoru.com' + path };
    if (/-programi-\d+$/.test(path)) return { error: 'Bu bir bölüm sayfası — dersin kendi sayfasını açın' };
    return { error: 'ATA ders linki tanınmadı' };
  }
  return { error: 'Yalnızca aofsoru.com ve ataaofsoru.com destekleniyor' };
}

/* ---------- Sayfa ayrıştırıcıları ---------- */
function parseAnadoluListing(doc, slug) {
  const out = []; const seen = new Set();
  const rx = /^\/(?:mobile\/|amp\/)?(.+?)-(\d{4})-(\d{4})-yili-(.+?)-sinavi-sinav-sorulari$/;
  doc.querySelectorAll('a[href]').forEach((a, i) => {
    let p; try { p = new URL(a.getAttribute('href'), 'https://aofsoru.com').pathname; } catch (e) { return; }
    const m = p.match(rx);
    if (!m || m[1] !== slug) return;
    const url = `https://aofsoru.com/${m[1]}-${m[2]}-${m[3]}-yili-${m[4]}-sinavi-sinav-sorulari`;
    if (seen.has(url)) return; seen.add(url);
    out.push({ url, y1: +m[2], y2: +m[3], kind: m[4], order: i, label: `${m[2]}–${m[3]} ${ANA_KINDS[m[4]] || cap(m[4])}` });
  });
  return out;
}
function anadoluTitle(doc, slug) {
  const h = (doc.querySelector('h1') && doc.querySelector('h1').textContent || '').replace(/\s+/g, ' ').trim();
  let t = h.replace(/\s*Çıkmış Sınav Soruları.*$/i, '').replace(/\s+Dersi\s+\d{4}.*$/i, '').replace(/\s+Dersi$/i, '').trim();
  if (!t) t = slug.replace(/^[a-z]{2,4}\d{3}[a-z]?-/, '').replace(/-dersi$/, '').split('-').map(cap).join(' ');
  return t;
}
function cap(w) { w = String(w || '').replace(/-/g, ' '); return w.charAt(0).toLocaleUpperCase('tr') + w.slice(1); }
function parseAnadoluExam(doc) {
  const out = [];
  let cards = doc.querySelectorAll('.card[data-value], .card[data-cevap]');
  if (!cards.length) cards = doc.querySelectorAll('.card');
  cards.forEach((card, i) => {
    const img = card.querySelector('img.QuestionImg, img.content, img[data-src*="aofsoru"], img[src*="image.aofsoru"]');
    if (!img) return;
    const src = absImg(imgSrc(img), 'image.aofsoru.com');
    if (!src || PLACEHOLDER_RX.test(src)) return;
    out.push({ img: src, ans: card.getAttribute('data-active') === 'false' ? CANCELLED : normAns(card.getAttribute('data-value') || card.getAttribute('data-cevap')), no: clampInt(card.getAttribute('data-row') || i + 1, 0, 999) });
  });
  return out;
}
function parseAtaListing(doc) {
  const rx = /^\/(.+?)-(\d{4})-(\d{4})-yili-(guz|bahar|yaz-okulu)-donemi-(.+?)-sinavi-cikmis-sinav-sorulari-(\d+)$/;
  const raw = []; const seen = new Set();
  doc.querySelectorAll('a[href]').forEach((a, i) => {
    let p; try { p = new URL(a.getAttribute('href'), 'https://ataaofsoru.com').pathname; } catch (e) { return; }
    const m = p.match(rx); if (!m) return;
    const url = 'https://ataaofsoru.com' + p;
    if (seen.has(url)) return; seen.add(url);
    raw.push({ url, base: m[1], y1: +m[2], y2: +m[3], term: m[4], kind: m[5], order: i,
      label: `${m[2]}–${m[3]} ${ATA_TERMS[m[4]] || ''} ${ATA_KINDS[m[5]] || cap(m[5])}`.replace(/\s+/g, ' ') });
  });
  // Sayfada başka derslere ait link varsa en sık görülen ders kökünü kullan
  const freq = {}; raw.forEach((r) => (freq[r.base] = (freq[r.base] || 0) + 1));
  const top = Object.keys(freq).sort((a, b) => freq[b] - freq[a])[0];
  return raw.filter((r) => r.base === top);
}
function ataCourseTitle(doc) {
  const h = doc.querySelector('h1');
  return (h ? h.textContent : 'ATA Ders').replace(/\s+/g, ' ').replace('Soruları', '').trim() || 'ATA Ders';
}
function parseAtaExam(doc) {
  const out = [];
  const items = doc.querySelectorAll('.question[data-correct], [data-correct]');
  items.forEach((el, i) => {
    const img = el.querySelector('img.content') || Array.from(el.querySelectorAll('img')).find((x) => !x.classList.contains('hint') && !x.closest('.collapse'));
    if (!img) return;
    const src = absImg(imgSrc(img), 'image.ataaofsoru.com');
    if (!src) return;
    const h = el.querySelector('img.hint, .collapse img');
    const hint = h ? absImg(imgSrc(h), 'image.ataaofsoru.com') : '';
    out.push({ img: src, hint: hint || undefined, ans: normAns(el.getAttribute('data-correct')), no: clampInt(el.getAttribute('data-number') || i + 1, 0, 999) });
  });
  if (out.length) return out;
  // Eski düzen için geri dönüş (v21 mantığı, cevap harfi yalnızca açık etiketten alınır)
  doc.querySelectorAll('.card, .soru-kutusu').forEach((card, i) => {
    const imgs = Array.from(card.querySelectorAll('img'));
    const isAns = (im) => /cevap|dogru|answer|hint/i.test((imgSrc(im) || '') + ' ' + (im.className || '')) || !!im.closest('.collapse, .card-footer, .answer, .cevap, .cozum');
    const qi = imgs.find((im) => !isAns(im));
    if (!qi) return;
    const src = absImg(imgSrc(qi), 'image.ataaofsoru.com');
    if (!src || PLACEHOLDER_RX.test(src)) return;
    let ans = card.getAttribute('data-value') || card.getAttribute('data-cevap') || card.getAttribute('data-answer') || '';
    if (!/^[A-E]$/i.test(ans.trim())) { const m = (card.textContent || '').match(/Doğru\s*Cevap\s*[:\-]?\s*\(?([A-E])\)?/i); ans = m ? m[1] : ''; }
    out.push({ img: src, ans: normAns(ans), no: i + 1 });
  });
  return out;
}

/* ---------- İçe aktarma ---------- */
function currentAcademicYear() { const d = new Date(); return d.getMonth() >= 8 ? d.getFullYear() : d.getFullYear() - 1; }
async function runPool(items, n, fn) {
  let i = 0; const res = new Array(items.length);
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; res[k] = await fn(items[k], k); }
  });
  await Promise.all(workers);
  return res;
}
/** Bir ders için sınavları seçer, çeker ve ders nesnesi döndürür. */
async function importCourse(task, ctx) {
  const info = analyzeLink(task.url);
  if (info.error || info.empty) throw new Error(info.error || 'Link boş');
  const kinds = kindsFor(info.uni, task.type);
  const ceiling = task.ceiling || 9999;
  const limit = task.limit || 9999;
  let title = '', code = '', key = '', sourceUrl = '', exams = [];

  if (info.uni === 'anadolu') {
    const slug = info.slug;
    key = 'anadolu:' + slug;
    const cm = slug.match(/^([a-z]{2,4}\d{3}[a-z]?)-/); code = cm ? cm[1].toUpperCase() : '';
    sourceUrl = `https://aofsoru.com/${slug}-sinav-sorulari`;
    ctx.step(`Sınav listesi okunuyor`);
    const r = await fetchHtml(sourceUrl, ctx.signal);
    let listing = [];
    if (r.html) {
      const doc = parseDoc(r.html);
      title = anadoluTitle(doc, slug);
      listing = parseAnadoluListing(doc, slug);
    } else if (r.error) {
      throw new Error('Siteye ulaşılamadı (' + r.error + ')');
    }
    if (!title) title = anadoluTitle(parseDoc('<p></p>'), slug);
    if (listing.length) {
      exams = listing.filter((e) => (!kinds || kinds.includes(e.kind)) && e.y1 <= ceiling)
        .sort((a, b) => b.y1 - a.y1 || a.order - b.order).slice(0, limit);
    } else {
      // Liste sayfası yoksa v21 gibi yıl tahminiyle dene
      const ks = kinds || ['ara', 'donem-sonu'];
      let y = Math.min(ceiling, currentAcademicYear());
      for (; y >= 2012 && exams.length < limit; y--) {
        for (const k of ks) {
          if (exams.length >= limit) break;
          const url = `https://aofsoru.com/${slug}-${y}-${y + 1}-yili-${k}-sinavi-sinav-sorulari`;
          ctx.step(`${y}–${y + 1} ${ANA_KINDS[k] || k} aranıyor`);
          const rr = await fetchHtml(url, ctx.signal);
          if (rr.html && parseAnadoluExam(parseDoc(rr.html)).length) exams.push({ url, y1: y, y2: y + 1, kind: k, label: `${y}–${y + 1} ${ANA_KINDS[k] || cap(k)}`, html: rr.html });
          else if (rr.error) throw new Error('Siteye ulaşılamadı (' + rr.error + ')');
        }
      }
    }
  } else {
    let courseUrl = info.courseUrl;
    if (!courseUrl && info.examUrl) {
      ctx.step('Sınav sayfasından ders bulunuyor');
      const r0 = await fetchHtml(info.examUrl, ctx.signal);
      if (!r0.html) throw new Error(r0.notFound ? 'Sayfa bulunamadı' : 'Siteye ulaşılamadı (' + r0.error + ')');
      const a = Array.from(parseDoc(r0.html).querySelectorAll('a[href*="ata-aof-"][href*="-dersi-"]'))
        .map((x) => x.getAttribute('href')).find((h) => /ata-aof-.+-dersi-\d+$/.test(h || ''));
      if (!a) throw new Error('Ders sayfası bulunamadı');
      courseUrl = new URL(a, 'https://ataaofsoru.com').href;
    }
    sourceUrl = courseUrl;
    key = 'ata:' + new URL(courseUrl).pathname;
    ctx.step('Sınav listesi okunuyor');
    const r = await fetchHtml(courseUrl, ctx.signal);
    if (!r.html) throw new Error(r.notFound ? 'Ders sayfası bulunamadı' : 'Siteye ulaşılamadı (' + r.error + ')');
    const doc = parseDoc(r.html);
    title = ataCourseTitle(doc);
    exams = parseAtaListing(doc).filter((e) => (!kinds || kinds.includes(e.kind)) && e.y1 <= ceiling)
      .sort((a, b) => b.y1 - a.y1 || a.order - b.order).slice(0, limit);
  }

  if (!exams.length) throw new Error('Seçilen türde sınav bulunamadı');
  let done = 0;
  ctx.step(`0 / ${exams.length} sınav`);
  const results = await runPool(exams, localStorage.getItem(LS.proxy) ? 3 : 2, async (ex) => {
    let html = ex.html;
    if (!html) { const r = await fetchHtml(ex.url, ctx.signal); html = r.html; }
    const qs = html ? (info.uni === 'anadolu' ? parseAnadoluExam(parseDoc(html)) : parseAtaExam(parseDoc(html))) : [];
    done++; ctx.step(`${done} / ${exams.length} sınav`); ctx.tick();
    return { ex, qs };
  });
  const questions = [];
  let examsOk = 0;
  for (const { ex, qs } of results) {
    if (qs.length) examsOk++;
    qs.sort((a, b) => a.no - b.no).forEach((p) => questions.push({
      id: p.img, img: p.img, hint: p.hint, ans: p.ans, title: ex.label, year: ex.y1, kind: ex.kind, no: p.no
    }));
  }
  if (!questions.length) throw new Error('Sorular okunamadı');
  return { key, uni: info.uni, title, code, source: { url: sourceUrl, type: task.type, limit: task.limit }, questions, examsOk, examsTotal: exams.length };
}
/** Yeni çekilen dersi mevcut verilerle birleştirir; ilerleme korunur. */
function mergeCourse(nc) {
  let c = courses.find((x) => x.key === nc.key) ||
          courses.find((x) => x.uni === nc.uni && (x.title === nc.title || x.title === (nc.code + ' ' + nc.title).toUpperCase()));
  let added = 0;
  if (!c) {
    c = { key: nc.key, uni: nc.uni, title: nc.title, code: nc.code, source: nc.source, lastIndex: 0, questions: [], addedAt: Date.now() };
    courses.push(c);
  }
  const old = new Map(c.questions.map((q) => [q.id, q]));
  const merged = [];
  for (const p of nc.questions) {
    const g = qIndex.get(p.id);
    let q = old.get(p.id);
    if (q) {
      if (hasKey(p) || p.ans === CANCELLED) q.ans = p.ans;     // site cevabı düzeltmişse / iptal ettiyse güncelle
      if (!hasKey(q)) wrongIds.delete(q.id);
      q.title = p.title; q.year = p.year; q.kind = p.kind; q.no = p.no;
      if (p.hint) q.hint = p.hint;
      old.delete(p.id);
    } else {
      q = { id: p.id, img: p.img, ans: p.ans, title: p.title, year: p.year, kind: p.kind, no: p.no, qStats: g ? g.q.qStats : { mastery: 0, correct: 0, wrong: 0, box: 0, seen: false } };
      if (p.hint) q.hint = p.hint;
      added++;
    }
    merged.push(q);
  }
  for (const q of old.values()) merged.push(q); // sitede artık olmayan sorular da korunur
  const curId = c.questions[c.lastIndex] && c.questions[c.lastIndex].id;
  c.questions = merged;
  c.key = nc.key; c.title = nc.title; c.code = nc.code || c.code; c.source = nc.source; c.updatedAt = Date.now();
  delete c.displayTitle;
  const ni = curId ? merged.findIndex((q) => q.id === curId) : -1;
  c.lastIndex = ni >= 0 ? ni : Math.min(c.lastIndex, merged.length);
  rebuildIndex();
  return { course: c, added, total: merged.length };
}
/* ---------- Genel arayüz yardımcıları ---------- */
let toastTimer = 0;
function toast(msg, kind = '', ms = 2600) {
  const el = $('#toast'); if (!el) return;
  el.textContent = msg; el.className = 'toast show ' + kind;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.className = 'toast ' + kind), ms);
}
function openSheet(html, { onClose, cls = '' } = {}) {
  closeSheet();
  const root = $('#modalRoot');
  root.innerHTML = `<div class="overlay" data-overlay><div class="sheet ${cls}" role="dialog" aria-modal="true"><div class="grabber"></div>${html}</div></div>`;
  const ov = root.firstElementChild;
  ov._onClose = onClose;
  ov.addEventListener('click', (e) => { if (e.target === ov) closeSheet(); });
  const f = ov.querySelector('[autofocus]'); if (f) setTimeout(() => f.focus(), 60);
  return ov.querySelector('.sheet');
}
function closeSheet() {
  const ov = $('#modalRoot .overlay');
  if (!ov) return false;
  const cb = ov._onClose; ov.remove(); if (cb) cb();
  return true;
}
function confirmSheet({ title, body, ok = 'Onayla', danger = false, cancel = 'Vazgeç' }) {
  return new Promise((resolve) => {
    let done = false;
    const s = openSheet(`
      <div class="sheet-head"><div class="h2">${esc(title)}</div></div>
      <p class="muted" style="margin:0 0 18px">${body}</p>
      <div class="btn-row"><button class="btn btn-ghost" data-r="0">${esc(cancel)}</button>
      <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-r="1">${esc(ok)}</button></div>`,
      { onClose: () => { if (!done) resolve(false); } });
    s.addEventListener('click', (e) => { const b = e.target.closest('[data-r]'); if (!b) return; done = true; closeSheet(); resolve(b.dataset.r === '1'); });
  });
}
function fmtDate(t) {
  try { return new Date(t).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return ''; }
}
function fmtDur(sec) { sec = Math.max(0, Math.round(sec)); const m = Math.floor(sec / 60), s = sec % 60; return `${m}:${String(s).padStart(2, '0')}`; }
function themeNow() { return document.documentElement.getAttribute('data-theme'); }
function applyTheme(pref) {
  let t = pref;
  if (t === 'system') t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t === 'light' ? 'light' : 'dark');
  const tc = $('#themeColor'); if (tc) tc.setAttribute('content', t === 'light' ? '#f3f1ec' : '#0f1115');
  const u = $('#themeIconUse'); if (u) u.setAttribute('href', t === 'light' ? '#i-moon' : '#i-sun');
}

/* ---------- Yönlendirme ---------- */
const routes = [];
function route(rx, fn, opts = {}) { routes.push({ rx, fn, opts }); }
let currentRoute = null;
function render() {
  const h = location.hash.replace(/^#/, '') || '/';
  for (const r of routes) {
    const m = h.match(r.rx);
    if (!m) continue;
    if (currentRoute && currentRoute.cleanup) { try { currentRoute.cleanup(); } catch (e) {} }
    currentRoute = { path: h, cleanup: null };
    document.body.classList.toggle('immersive', !!r.opts.immersive);
    $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === r.opts.nav));
    closeSheet();
    const view = $('#view');
    r.fn(view, ...m.slice(1).map((x) => decodeURIComponent(x)));
    if (!r.opts.keepScroll) window.scrollTo(0, 0);
    return;
  }
  location.replace('#/');
}
function go(h) { if (location.hash === h) render(); else location.hash = h; }

/* ---------- Panel ---------- */
function courseCard(c) {
  const st = statsFor(c.questions);
  const seenPct = st.total ? Math.round(((st.seen - st.mastered) / st.total) * 100) : 0;
  return `<a class="course" href="#/ders/${encodeURIComponent(c.key)}">
    <div class="course-top">
      <div style="min-width:0">
        <div class="tags" style="margin-bottom:8px">${c.code ? `<span class="tag accent">${esc(c.code)}</span>` : ''}<span class="tag">${c.uni === 'ata' ? 'ATA' : 'Anadolu'}</span></div>
        <div class="course-title">${esc(courseName(c))}</div>
      </div>
      <div class="pct num">${st.pct}<small>%</small></div>
    </div>
    <div class="bar" aria-hidden="true"><i class="ok" style="width:${st.pct}%"></i><i class="mid" style="width:${Math.max(0, seenPct)}%"></i></div>
    <div class="course-meta"><span><b>${c.questions.length}</b> soru</span><span><b>${st.mastered}</b> kavrandı</span>${st.due ? `<span><b>${st.due}</b> tekrar</span>` : ''}${st.wrongNow ? `<span><b>${st.wrongNow}</b> yanlış</span>` : ''}${st.acc != null ? `<span>Doğruluk <b>%${st.acc}</b></span>` : ''}</div>
  </a>`;
}
function modeTile(act, ic, name, desc, count, arg = '') {
  return `<button class="mode" data-act="${act}" data-arg="${esc(arg)}" ${count ? '' : 'disabled'}>
    <div class="mode-top">${icon(ic)}<span class="mode-count">${count}</span></div>
    <div class="mode-name">${name}</div><div class="mode-desc">${desc}</div></button>`;
}
function viewHome(v) {
  if (!courses.length) {
    v.innerHTML = `
      <div class="eyebrow">Hoş geldiniz</div>
      <h1 class="h1">Çıkmış sorularla,<br>kavrayarak çalışın.</h1>
      <p class="lede">Ders linklerinizi ekleyin; robot geçmiş yılların sınavlarını getirir, siz de aralıklı tekrar ve sınav simülasyonuyla çalışırsınız.</p>
      ${dataLoadFailed ? `<div class="notice err" style="margin-top:16px">${icon('alert')}<div>Kayıtlı veriler okunamadı. Bozuk kopya ayrıca saklandı; Ayarlar’dan yedeğinizi içe aktarabilirsiniz.</div></div>` : ''}
      <div class="card card-pad section">
        <ol class="steps">
          <li><span><b>aofsoru.com</b> (Anadolu) ya da <b>ataaofsoru.com</b> (Atatürk) üzerinde dersinizin sayfasını açın.</span></li>
          <li><span>Adres çubuğundaki linki kopyalayın ve <b>Ders Ekle</b> ekranına yapıştırın. Üniversite linkten otomatik anlaşılır.</span></li>
          <li><span>Sınav türünü ve kaç sınav geriye gidileceğini seçip <b>Soruları getir</b>’e dokunun.</span></li>
        </ol>
        <div class="btn-row" style="margin-top:18px"><a class="btn btn-primary" href="#/ekle">${icon('plus')} Ders ekle</a><button class="btn" data-act="importBackup">${icon('up')} Yedekten yükle</button></div>
      </div>`;
    return;
  }
  const all = allUnique();
  const st = statsFor(all);
  const live = readJSON(LS.live, null);
  const sess = readJSON(LS.session, null);
  const today = new Date().toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long' });
  const primary = st.due
    ? { act: 'startReview', label: 'Tekrara başla', sub: `${st.due} soru tekrar zamanında`, num: st.due, k: 'Tekrar zamanı gelen' }
    : st.total - st.mastered
      ? { act: 'startUnmastered', label: 'Kavranmayanlara çalış', sub: `${st.fresh} yeni, ${st.total - st.mastered - st.fresh} yarım kalan`, num: st.total - st.mastered, k: 'Kavranmayı bekleyen' }
      : { act: 'goExam', label: 'Deneme sınavı aç', sub: 'Tüm sorular kavrandı. Kendinizi sınayın.', num: st.total, k: 'Kavranan soru' };
  v.innerHTML = `
    <div class="eyebrow">${esc(today)}</div>
    <h1 class="h1">Çalışma Paneli</h1>
    ${live && live.ids ? `<div class="notice" style="margin-top:14px">${icon('timer')}<div style="flex:1">Yarım kalan bir sınavınız var: <b>${esc(live.title)}</b></div><a class="btn btn-sm btn-primary" href="#/sinav/canli">Devam</a></div>` : ''}
    <div class="hero section" style="margin-top:16px">
      <div class="eyebrow">${primary.k}</div>
      <div class="hero-row">
        <div><div class="hero-num num">${primary.num}</div><div class="hero-sub">${esc(primary.sub)}</div></div>
        <button class="btn btn-primary" data-act="${primary.act}">${primary.label}</button>
      </div>
    </div>
    <div class="stats">
      <div class="stat accent"><div class="v">%${st.pct}</div><div class="k">Kavrama</div></div>
      <div class="stat"><div class="v">${st.mastered}<span class="muted" style="font-size:14px">/${st.total}</span></div><div class="k">Kavranan</div></div>
      <div class="stat ${st.acc == null ? '' : st.acc >= 70 ? 'ok' : 'err'}"><div class="v">${st.acc == null ? '—' : '%' + st.acc}</div><div class="k">Doğruluk</div></div>
    </div>
    ${sess && sess.ids && sess.i < sess.ids.length && sess.mode !== 'course' ? `<a class="row card" style="margin-top:12px;border-radius:14px" href="#/calis"><span class="row-icon">${icon('book')}</span><span class="row-main"><span class="row-title">Kaldığınız çalışma</span><span class="row-sub">${esc(sess.title)} · ${sess.i + 1}/${sess.ids.length}</span></span><span class="row-end">${icon('right')}</span></a>` : ''}
    <div class="section">
      <div class="section-head"><div class="h2">Çalışma modları</div></div>
      <div class="modes">
        ${modeTile('startReview', 'layers', 'Aralıklı tekrar', 'Zamanı gelenler', st.due)}
        ${modeTile('startWrong', 'alert', 'Yanlışlarım', 'Yanlış defteri', st.wrongNow)}
        ${modeTile('startUnmastered', 'shuffle', 'Karma kavrama', 'Kavranmayanlar', st.total - st.mastered)}
        ${modeTile('startFlagged', 'flag', 'İşaretliler', 'Sonraya bıraktıklarım', st.flagged)}
      </div>
    </div>
    <div class="section">
      <div class="section-head"><div class="h2">Dersler</div><a class="link" href="#/ekle">Ders ekle</a></div>
      <div class="list">${courses.map(courseCard).join('')}</div>
    </div>`;
}

/* ---------- Ders ayrıntısı ---------- */
function viewCourse(v, key) {
  const c = getCourse(key);
  if (!c) { v.innerHTML = `<div class="empty"><div class="h2">Ders bulunamadı</div><p><a class="btn" href="#/">Panele dön</a></p></div>`; return; }
  const st = statsFor(c.questions);
  const groups = examGroups(c);
  const best = examHistory.filter((h) => h.courseKeys && h.courseKeys.length === 1 && h.courseKeys[0] === c.key).reduce((m, h) => Math.max(m, h.score), -1);
  const resumeN = Math.min(c.lastIndex + 1, c.questions.length);
  let filter = 'all', q = '';
  v.innerHTML = `
    <a class="btn btn-ghost btn-sm" href="#/" style="margin-left:-8px">${icon('left')} Panel</a>
    <div class="tags" style="margin-top:10px">${c.code ? `<span class="tag accent">${esc(c.code)}</span>` : ''}<span class="tag">${uniLabel(c.uni)}</span></div>
    <h1 class="h1">${esc(courseName(c))}</h1>
    <div class="stats">
      <div class="stat accent"><div class="v">%${st.pct}</div><div class="k">Kavrama</div></div>
      <div class="stat"><div class="v">${st.due}</div><div class="k">Tekrar</div></div>
      <div class="stat ${st.wrongNow ? 'err' : ''}"><div class="v">${st.wrongNow}</div><div class="k">Yanlış</div></div>
    </div>
    <div class="bar"><i class="ok" style="width:${st.pct}%"></i></div>
    <div class="course-meta"><span><b>${c.questions.length}</b> soru · <b>${groups.length}</b> sınav</span><span><b>${st.seen}</b> görüldü</span>${st.acc != null ? `<span>Doğruluk <b>%${st.acc}</b></span>` : ''}${best >= 0 ? `<span>En iyi deneme <b>${best}</b></span>` : ''}</div>

    <div class="section btn-row">
      <button class="btn btn-primary btn-block" data-act="startCourse" data-arg="${esc(c.key)}">${c.lastIndex > 0 && c.lastIndex < c.questions.length ? `Kaldığın yerden devam · ${resumeN}/${c.questions.length}` : c.lastIndex >= c.questions.length ? 'Baştan çöz' : 'Sırayla çalışmaya başla'}</button>
    </div>
    <div class="modes" style="margin-top:10px">
      ${modeTile('startReview', 'layers', 'Tekrar', 'Zamanı gelenler', st.due, c.key)}
      ${modeTile('startWrong', 'alert', 'Yanlışlar', 'Bu dersin defteri', st.wrongNow, c.key)}
      ${modeTile('startUnmastered', 'shuffle', 'Karma', 'Kavranmayanlar', st.total - st.mastered, c.key)}
      ${modeTile('goExamCourse', 'timer', 'Deneme', 'Süreli sınav', st.total, c.key)}
    </div>

    <div class="section">
      <div class="section-head"><div class="h2">Geçmiş sınavlar</div></div>
      <div class="rows">${groups.map((g, i) => {
        const gs = statsFor(g.qs);
        return `<button class="row" data-act="startGroup" data-arg="${esc(c.key)}" data-i="${i}">
          <span class="row-main"><span class="row-title">${esc(g.title || 'Sınav')}</span><span class="row-sub">${g.qs.length} soru · ${gs.mastered} kavrandı${gs.wrongNow ? ` · ${gs.wrongNow} yanlış` : ''}</span></span>
          <span class="row-end num">%${gs.pct}${icon('right')}</span></button>`;
      }).join('')}</div>
    </div>

    <div class="section">
      <div class="section-head"><div class="h2">Soru haritası</div></div>
      <div class="chips" id="qfilter" style="margin-bottom:12px">
        <button class="chip on" data-f="all">Tümü</button><button class="chip" data-f="wrong">Yanlış</button>
        <button class="chip" data-f="un">Kavranmayan</button><button class="chip" data-f="flag">İşaretli</button><button class="chip" data-f="note">Notlu</button>
      </div>
      <div class="search-wrap" style="margin-bottom:12px">${icon('search')}<input class="input" id="qsearch" type="search" placeholder="Sınav adı ya da notlarda ara" autocomplete="off"></div>
      <div class="qgrid" id="qmap"></div>
      <p class="help" style="margin-top:10px">Yeşil: kavrandı · kırmızı: yanlış defterinde · nokta: işaretli. Bir numaraya dokunup o sorudan başlayın.</p>
    </div>

    <div class="section">
      <div class="section-head"><div class="h2">Ders işlemleri</div></div>
      <div class="rows">
        <button class="row" data-act="refreshCourse" data-arg="${esc(c.key)}"><span class="row-icon">${icon('refresh')}</span><span class="row-main"><span class="row-title">Soruları güncelle</span><span class="row-sub">Yeni sınavları getirir, ilerlemeniz korunur</span></span></button>
        <button class="row" data-act="cacheCourse" data-arg="${esc(c.key)}"><span class="row-icon">${icon('cloud')}</span><span class="row-main"><span class="row-title">Çevrimdışı için indir</span><span class="row-sub">Soru görsellerini cihaza kaydeder</span></span></button>
        <button class="row" data-act="resetCourse" data-arg="${esc(c.key)}"><span class="row-icon">${icon('refresh')}</span><span class="row-main"><span class="row-title">İlerlemeyi sıfırla</span><span class="row-sub">Bu dersin kavrama ve tekrar bilgisi silinir</span></span></button>
        <button class="row" data-act="removeCourse" data-arg="${esc(c.key)}"><span class="row-icon" style="color:var(--err)">${icon('trash')}</span><span class="row-main"><span class="row-title">Dersi kaldır</span><span class="row-sub">Sorular ve ilerleme bu cihazdan silinir</span></span></button>
      </div>
      ${c.source && c.source.url ? `<p class="help" style="margin-top:10px;word-break:break-all">Kaynak: ${esc(c.source.url)}</p>` : ''}
    </div>`;
  const drawMap = () => {
    const needle = q.trim().toLocaleLowerCase('tr');
    const cells = [];
    c.questions.forEach((x, i) => {
      const s = x.qStats;
      if (filter === 'wrong' && !wrongIds.has(x.id)) return;
      if (filter === 'un' && isMastered(x)) return;
      if (filter === 'flag' && !s.flag) return;
      if (filter === 'note' && !s.note) return;
      if (needle && !((x.title || '').toLocaleLowerCase('tr').includes(needle) || (s.note || '').toLocaleLowerCase('tr').includes(needle))) return;
      const cls = wrongIds.has(x.id) ? 'err' : isMastered(x) ? 'ok' : s.seen ? 'done' : '';
      cells.push(`<button class="qcell ${cls} ${s.flag ? 'flag' : ''} ${i === c.lastIndex ? 'cur' : ''}" data-act="startAt" data-arg="${esc(c.key)}" data-i="${i}" aria-label="Soru ${i + 1}">${i + 1}</button>`);
    });
    $('#qmap').innerHTML = cells.join('') || `<p class="muted small" style="grid-column:1/-1">Bu filtreye uyan soru yok.</p>`;
  };
  drawMap();
  $('#qfilter').addEventListener('click', (e) => { const b = e.target.closest('[data-f]'); if (!b) return; filter = b.dataset.f; $$('#qfilter .chip').forEach((x) => x.classList.toggle('on', x === b)); drawMap(); });
  $('#qsearch').addEventListener('input', (e) => { q = e.target.value; drawMap(); });
}

/* ---------- Arama ---------- */
function viewSearch(v) {
  v.innerHTML = `
    <div class="eyebrow">Arama</div><h1 class="h1">Ders, sınav, not</h1>
    <div class="search-wrap section" style="margin-top:14px">${icon('search')}<input class="input" id="gsearch" type="search" placeholder="Örn. anayasa, 2023 final, ‘ezber’" autocomplete="off" autofocus></div>
    <div id="sres" class="section"></div>`;
  const inp = $('#gsearch');
  const draw = () => {
    const n = inp.value.trim().toLocaleLowerCase('tr');
    const box = $('#sres');
    if (!n) { box.innerHTML = `<p class="muted">Soru metinleri görsel olduğundan arama; ders adlarında, sınav başlıklarında ve kendi notlarınızda yapılır.</p>`; return; }
    const parts = n.split(/\s+/);
    const hit = (s) => { s = String(s || '').toLocaleLowerCase('tr'); return parts.every((p) => s.includes(p)); };
    const rows = [];
    for (const c of courses) {
      if (hit(courseName(c) + ' ' + (c.code || ''))) rows.push(`<a class="row" href="#/ders/${encodeURIComponent(c.key)}"><span class="row-icon">${icon('book')}</span><span class="row-main"><span class="row-title">${esc(courseName(c))}</span><span class="row-sub">Ders · ${c.questions.length} soru</span></span>${icon('right')}</a>`);
      examGroups(c).forEach((g, i) => {
        if (hit(courseName(c) + ' ' + g.title)) rows.push(`<button class="row" data-act="startGroup" data-arg="${esc(c.key)}" data-i="${i}"><span class="row-icon">${icon('grid')}</span><span class="row-main"><span class="row-title">${esc(g.title)}</span><span class="row-sub">${esc(courseName(c))} · ${g.qs.length} soru</span></span>${icon('right')}</button>`);
      });
      c.questions.forEach((q, i) => {
        if (q.qStats.note && hit(q.qStats.note)) rows.push(`<button class="row" data-act="startAt" data-arg="${esc(c.key)}" data-i="${i}"><span class="row-icon">${icon('note')}</span><span class="row-main"><span class="row-title">${esc(q.qStats.note.slice(0, 80))}</span><span class="row-sub">${esc(courseName(c))} · ${esc(q.title)} · Soru ${i + 1}</span></span>${icon('right')}</button>`);
      });
    }
    box.innerHTML = rows.length ? `<div class="rows">${rows.slice(0, 80).join('')}</div>` : `<p class="muted">Sonuç yok.</p>`;
  };
  inp.addEventListener('input', draw); draw();
}

/* ---------- Ders ekle ---------- */
let importing = false;
function linkRowHtml(i, val = '', type = '', limit = '4') {
  const info = analyzeLink(val);
  const uni = info.uni || 'anadolu';
  const opts = TYPE_OPTIONS[uni].map((o) => `<option value="${o[0]}" ${o[0] === type ? 'selected' : ''}>${o[1]}</option>`).join('');
  return `<div class="link-row" data-row="${i}">
    <div class="link-row-head"><span class="label">Ders ${i + 1}</span><span class="detect ${info.uni ? 'ok' : info.error ? 'err' : ''}" data-detect>${info.uni ? uniLabel(info.uni) : info.error ? esc(info.error) : 'Link bekleniyor'}</span></div>
    <div class="link-input-wrap"><input class="input" data-url type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="aofsoru.com/… veya ataaofsoru.com/…" value="${esc(val)}">
      <button class="paste-btn" data-act="pasteLink" type="button">Yapıştır</button></div>
    <div class="grid2">
      <select class="select" data-type aria-label="Sınav türü">${opts}</select>
      <select class="select" data-limit aria-label="Sınav sayısı">${[1, 2, 3, 4, 5, 6, 8, 10].map((n) => `<option value="${n}" ${String(n) === String(limit) ? 'selected' : ''}>${n} sınav</option>`).join('')}<option value="999" ${limit === '999' ? 'selected' : ''}>Tümü</option></select>
    </div>
    ${i > 0 ? `<button class="btn btn-ghost btn-sm" data-act="removeRow" style="align-self:flex-start">${icon('x')} Satırı kaldır</button>` : ''}
  </div>`;
}
function viewAdd(v) {
  const cy = currentAcademicYear();
  const draft = readJSON('aof_add_draft', null);
  v.innerHTML = `
    <div class="eyebrow">Ders ekle</div>
    <h1 class="h1">Sınav linklerini girin</h1>
    <p class="lede">Dersin sayfasını <b>aofsoru.com</b> ya da <b>ataaofsoru.com</b> üzerinde açıp linki yapıştırın. Ders sayfası, “sınav soruları” sayfası veya tek bir sınavın linki olabilir.</p>
    <details class="card card-pad section" style="margin-top:16px"><summary style="cursor:pointer;font-weight:600">Link nasıl bulunur?</summary>
      <ol class="steps" style="margin-top:14px">
        <li><span><b>Anadolu:</b> aofsoru.com’da bölümünüze, ardından dersinize girin. Örnek: <code>aofsoru.com/huk121u-temel-hukuk-bilgisi-dersi-sinav-sorulari</code></span></li>
        <li><span><b>Atatürk:</b> ataaofsoru.com’da “Dersler”den dersinizi açın. Örnek: <code>ataaofsoru.com/ata-aof-anayasa-hukuku-dersi-17</code></span></li>
        <li><span>iPhone’da Safari’de adres çubuğuna uzun basıp “Kopyala”, sonra burada <b>Yapıştır</b>.</span></li>
      </ol></details>
    <div class="list section" id="rows" style="margin-top:16px"></div>
    <button class="btn btn-ghost" data-act="addRow" style="margin-top:10px">${icon('plus')} Bir ders daha</button>
    <div class="card card-pad section">
      <div class="field"><label class="label" for="ceiling">En yeni öğretim yılı</label>
        <select class="select" id="ceiling"><option value="">Otomatik (en güncel)</option>${Array.from({ length: 12 }, (_, k) => cy - k).map((y) => `<option value="${y}">${y}–${y + 1}</option>`).join('')}</select>
        <span class="help">Robot bu yıldan geriye doğru seçtiğiniz sayıda sınav getirir. Aynı ders yeniden eklenirse ilerlemeniz korunur.</span></div>
    </div>
    <button class="btn btn-primary btn-block section" id="startBtn" data-act="startImport">${icon('down')} Soruları getir</button>
    <p class="help" style="margin-top:12px;text-align:center">Bağlantı sorunu yaşarsanız <a href="#/ayarlar" style="color:var(--accent)">Ayarlar › Bağlantı</a> bölümünden kendi Cloudflare Worker adresinizi girin.</p>`;
  const rows = $('#rows');
  const list = draft && Array.isArray(draft.rows) && draft.rows.length ? draft.rows : [{ url: '', type: 'ara', limit: '4' }];
  rows.innerHTML = list.map((r, i) => linkRowHtml(i, r.url, r.type, r.limit)).join('');
  if (draft && draft.ceiling) $('#ceiling').value = draft.ceiling;
  rows.addEventListener('input', (e) => { if (e.target.matches('[data-url]')) updateRowDetect(e.target.closest('.link-row')); saveDraft(); });
  rows.addEventListener('change', saveDraft);
  $('#ceiling').addEventListener('change', saveDraft);
}
function updateRowDetect(row) {
  const val = row.querySelector('[data-url]').value;
  const info = analyzeLink(val);
  const d = row.querySelector('[data-detect]');
  d.className = 'detect ' + (info.uni ? 'ok' : info.error ? 'err' : '');
  d.textContent = info.uni ? uniLabel(info.uni) : info.error || 'Link bekleniyor';
  const sel = row.querySelector('[data-type]');
  const uni = info.uni || 'anadolu';
  if (sel.dataset.uni !== uni) {
    const prev = sel.value;
    sel.innerHTML = TYPE_OPTIONS[uni].map((o) => `<option value="${o[0]}">${o[1]}</option>`).join('');
    if (TYPE_OPTIONS[uni].some((o) => o[0] === prev)) sel.value = prev;
    sel.dataset.uni = uni;
  }
}
function collectRows() {
  return $$('#rows .link-row').map((r) => ({ url: r.querySelector('[data-url]').value.trim(), type: r.querySelector('[data-type]').value, limit: r.querySelector('[data-limit]').value }));
}
function saveDraft() { const c = $('#ceiling'); writeJSON('aof_add_draft', { rows: collectRows(), ceiling: c ? c.value : '' }); }

async function runImport(tasks, after = 'home') {
  if (importing) return;
  importing = true;
  const ctl = new AbortController();
  let total = tasks.length, ticks = 0;
  const sheet = openSheet(`
    <div class="sheet-head"><div><div class="eyebrow">Sorular getiriliyor</div><div class="h2" id="impTitle">Bağlanılıyor…</div></div></div>
    <div class="progress"><i id="impBar"></i></div>
    <div class="log" id="impLog"></div>
    <div class="btn-row" style="margin-top:18px"><button class="btn" id="impCancel">Durdur</button></div>`, { onClose: () => ctl.abort() });
  const log = $('#impLog', sheet);
  const bar = $('#impBar', sheet);
  const setBar = () => { bar.style.width = Math.min(100, Math.round((ticks / Math.max(1, total)) * 100)) + '%'; };
  $('#impCancel', sheet).addEventListener('click', () => { ctl.abort(); });
  const summary = [];
  for (let i = 0; i < tasks.length; i++) {
    if (ctl.signal.aborted) break;
    const t = tasks[i];
    const item = document.createElement('div');
    item.className = 'log-item run';
    item.innerHTML = `<span class="dot"></span><span><b>${esc(t.label || t.url)}</b><br><span class="muted small" data-s>Başlıyor…</span></span>`;
    log.appendChild(item); item.scrollIntoView({ block: 'nearest' });
    const s = item.querySelector('[data-s]');
    $('#impTitle', sheet).textContent = `Ders ${i + 1} / ${tasks.length}`;
    try {
      let counted = false;
      const nc = await importCourse(t, {
        signal: ctl.signal,
        step: (m) => { s.textContent = m; const mm = m.match(/^\d+ \/ (\d+) sınav$/); if (mm && !counted) { counted = true; total += +mm[1]; setBar(); } },
        tick: () => { ticks++; setBar(); }
      });
      const r = mergeCourse(nc);
      saveAll();
      item.className = 'log-item ok';
      item.querySelector('b').textContent = courseName(r.course);
      s.textContent = `${nc.examsOk}/${nc.examsTotal} sınav · ${nc.questions.length} soru${r.added ? ` · ${r.added} yeni` : ' · yeni soru yok'}`;
      summary.push({ ok: true, key: r.course.key });
    } catch (e) {
      item.className = 'log-item err';
      s.textContent = ctl.signal.aborted ? 'Durduruldu' : (e && e.message) || 'Hata';
      summary.push({ ok: false });
    }
    ticks++; setBar();
  }
  importing = false;
  bar.style.width = '100%';
  const okN = summary.filter((x) => x.ok).length;
  $('#impTitle', sheet).textContent = okN ? `${okN} ders hazır` : 'Sorular getirilemedi';
  const btns = sheet.querySelector('.btn-row');
  btns.innerHTML = okN
    ? (after === 'stay' ? `<button class="btn btn-primary" data-done="stay">Tamam</button>` : `<button class="btn btn-primary" data-done="home">Panele git</button>`)
    : `<a class="btn" href="#/ayarlar" data-done="settings">Bağlantı ayarları</a><button class="btn btn-primary" data-done="close">Kapat</button>`;
  if (!okN) log.insertAdjacentHTML('beforeend', `<div class="notice err" style="margin-top:6px">${icon('alert')}<div>Genel proxyler çoğu zaman yoğun ya da kapalıdır. En güvenilir yol kendi Cloudflare Worker adresinizi Ayarlar › Bağlantı bölümüne girmektir (ücretsiz, 2 dakika).</div></div>`);
  btns.addEventListener('click', (e) => {
    const b = e.target.closest('[data-done]'); if (!b) return;
    closeSheet();
    if (b.dataset.done === 'home') { localStorage.removeItem('aof_add_draft'); go('#/'); }
    if (b.dataset.done === 'stay') render();
  });
  return okN;
}
/* ---------- Çalışma oturumu ---------- */
let session = null;   // { mode, title, ids, i, courseKey, picks:{}, requeue:{}, startedAt, correct, wrong }
let advanceTimer = 0;
let answerToken = 0;

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function poolFor(courseKey) { const c = courseKey ? getCourse(courseKey) : null; return c ? c.questions : allUnique(); }
function startSession(s) {
  if (!s.ids.length) { toast('Bu modda çalışılacak soru yok.'); return; }
  session = Object.assign({ i: 0, picks: {}, requeue: {}, startedAt: Date.now(), correct: 0, wrong: 0 }, s);
  saveSession();
  go('#/calis');
}
function saveSession() { if (session) writeJSON(LS.session, session); }
function startCourseSession(key, at) {
  const c = getCourse(key); if (!c) return;
  let i = at != null ? at : c.lastIndex;
  if (i >= c.questions.length) i = 0;
  c.lastIndex = i; saveSoon();
  startSession({ mode: 'course', title: courseName(c), courseKey: key, ids: c.questions.map((q) => q.id), i });
}
function startReviewSession(key) {
  const now = Date.now();
  const ids = poolFor(key).filter((q) => hasKey(q) && isDue(q, now))
    .sort((a, b) => (a.qStats.box - b.qStats.box) || ((a.qStats.due || 0) - (b.qStats.due || 0))).map((q) => q.id);
  startSession({ mode: 'review', title: key ? `${courseName(getCourse(key))} · Tekrar` : 'Aralıklı tekrar', courseKey: key || null, ids: Array.from(new Set(ids)) });
}
function startWrongSession(key) {
  const set = new Set(poolFor(key).map((q) => q.id));
  const ids = Array.from(wrongIds).filter((id) => set.has(id));
  startSession({ mode: 'wrong', title: key ? `${courseName(getCourse(key))} · Yanlışlar` : 'Yanlışlarım', courseKey: key || null, ids });
}
function startUnmasteredSession(key) {
  const ids = Array.from(new Set(poolFor(key).filter((q) => hasKey(q) && !isMastered(q)).map((q) => q.id)));
  startSession({ mode: 'unmastered', title: key ? `${courseName(getCourse(key))} · Karma` : 'Karma kavrama', courseKey: key || null, ids: shuffle(ids) });
}
function startFlaggedSession() {
  const ids = Array.from(new Set(allUnique().filter((q) => q.qStats.flag).map((q) => q.id)));
  startSession({ mode: 'flagged', title: 'İşaretliler', ids });
}
function startGroupSession(key, gi) {
  const c = getCourse(key); if (!c) return;
  const g = examGroups(c)[gi]; if (!g) return;
  startSession({ mode: 'group', title: `${courseName(c)} · ${g.title}`, courseKey: key, ids: g.qs.map((q) => q.id) });
}

function viewStudy(v) {
  if (!session) session = readJSON(LS.session, null);
  if (session && session.ids) session.ids = session.ids.filter((id) => qIndex.has(id));
  if (!session || !session.ids || !session.ids.length) { location.replace('#/'); return; }
  session.picks = session.picks || {}; session.requeue = session.requeue || {};
  drawStudy(v, 0);
  const onKey = (e) => {
    if (e.target.closest('input, textarea, select') || $('#modalRoot .overlay') || $('.zoom')) return;
    const k = e.key.toUpperCase();
    const map = { '1': 'A', '2': 'B', '3': 'C', '4': 'D', '5': 'E' };
    const L = map[k] || (/^[A-E]$/.test(k) ? k : null);
    if (L && !e.metaKey && !e.ctrlKey) { const b = $(`.opt[data-l="${L}"]`); if (b && !b.disabled) b.click(); e.preventDefault(); }
    else if (e.key === 'ArrowRight' || ((e.key === 'Enter' || e.key === ' ') && session.picks[session.i])) { studyStep(1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { studyStep(-1); e.preventDefault(); }
    else if (k === 'F') toggleFlag();
    else if (k === 'H' || k === 'Ç') { const b = $('[data-act="showHint"]'); if (b) b.click(); }
    else if (e.key === 'Escape') exitStudy();
  };
  document.addEventListener('keydown', onKey);
  const sw = attachSwipe(v, (dir) => studyStep(dir));
  currentRoute.cleanup = () => { document.removeEventListener('keydown', onKey); sw(); clearTimeout(advanceTimer); answerToken++; };
}
function attachSwipe(el, cb) {
  let x0 = 0, y0 = 0, t0 = 0, ok = false;
  const ts = (e) => { if (e.touches.length !== 1 || e.target.closest('.dock, .p-head, input, textarea')) { ok = false; return; } ok = true; x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now(); };
  const te = (e) => {
    if (!ok) return; ok = false;
    const t = e.changedTouches[0]; const dx = t.clientX - x0, dy = t.clientY - y0;
    if (Math.abs(dx) > 70 && Math.abs(dy) < 50 && Date.now() - t0 < 600) cb(dx < 0 ? 1 : -1);
  };
  el.addEventListener('touchstart', ts, { passive: true });
  el.addEventListener('touchend', te, { passive: true });
  return () => { el.removeEventListener('touchstart', ts); el.removeEventListener('touchend', te); };
}
function studyDone(v) {
  const n = session.correct + session.wrong;
  const c = session.courseKey ? getCourse(session.courseKey) : null;
  v.innerHTML = `
  <div class="player"><div class="p-head"><button class="icon-btn" data-act="exitStudy" aria-label="Kapat">${icon('x')}</button><div class="p-title"><div class="t">${esc(session.title)}</div><div class="s">Tamamlandı</div></div><span style="width:40px"></span></div>
  <div class="p-body" style="text-align:center;padding-top:40px">
    <div class="eyebrow">Oturum özeti</div>
    <div class="score num" style="margin:14px 0 6px">${n ? Math.round((session.correct / n) * 100) : 0}<span class="muted" style="font-size:28px">%</span></div>
    <p class="muted">${session.correct} doğru · ${session.wrong} yanlış${n ? '' : ' · cevaplanan soru yok'}</p>
    <div class="btn-row" style="max-width:420px;margin:26px auto 0;flex-direction:column">
      ${session.mode === 'course' ? `<button class="btn btn-primary" data-act="restartCourse" data-arg="${esc(session.courseKey)}">Baştan çöz</button>` : ''}
      ${statsFor(allUnique()).wrongNow ? `<button class="btn" data-act="startWrong" data-arg="${esc(session.courseKey || '')}">Yanlışları tekrar et</button>` : ''}
      ${c ? `<a class="btn" href="#/ders/${encodeURIComponent(c.key)}">Derse dön</a>` : ''}
      <a class="btn btn-ghost" href="#/">Panele dön</a>
    </div>
  </div></div>`;
}
function drawStudy(v, dir) {
  v = v || $('#view');
  const S = session;
  if (S.i >= S.ids.length) { studyDone(v); return; }
  if (S.i < 0) S.i = 0;
  const entry = qIndex.get(S.ids[S.i]);
  if (!entry) { S.ids.splice(S.i, 1); drawStudy(v, dir); return; }
  const q = entry.q, s = q.qStats, c = entry.course;
  const pick = S.picks[S.i];
  const img = safeImg(q.img);
  const pct = Math.round(((S.i) / S.ids.length) * 100);
  const boxes = Array.from({ length: MAX_BOX }, (_, k) => `<i class="${k < s.box ? 'on' : ''}"></i>`).join('');
  v.innerHTML = `
  <div class="player">
    <div class="p-head">
      <button class="icon-btn" data-act="exitStudy" aria-label="Çık">${icon('x')}</button>
      <div class="p-title"><div class="t">${esc(S.title)}</div><div class="s">${S.i + 1} / ${S.ids.length}</div></div>
      <button class="icon-btn ${s.flag ? 'on' : ''}" data-act="toggleFlag" aria-label="İşaretle" aria-pressed="${s.flag ? 'true' : 'false'}">${icon('flag')}</button>
    </div>
    <div class="p-progress"><i style="width:${pct}%"></i></div>
    <div class="p-body ${dir > 0 ? 'slide-in' : dir < 0 ? 'slide-back' : ''}">
      <div class="p-meta">
        <div class="tags"><span class="tag">${esc(q.title || 'Soru')}</span>${S.courseKey ? '' : `<span class="tag">${esc(courseName(c))}</span>`}</div>
        <span class="boxdots" title="Leitner kutusu ${s.box}/${MAX_BOX}">${boxes}</span>
      </div>
      <div class="paper" data-act="zoom">${img ? `<img src="${esc(img)}" alt="Soru ${S.i + 1}" decoding="async">` : `<div class="img-err">Soru görseli yok</div>`}<span class="zoom-hint">${icon('search')}</span></div>
      <div class="p-meta" style="margin-top:10px">
        ${qStatsHtml(q)}
      </div>
      <div class="feedback" id="fb"></div>
      <div id="extra"></div>
      ${s.note ? `<div class="note-box">${esc(s.note)}</div>` : ''}
    </div>
    <div class="dock">
      <div class="opts" id="opts">${['A', 'B', 'C', 'D', 'E'].map((L) => `<button class="opt" data-l="${L}" data-act="answer">${L}</button>`).join('')}</div>
      <div class="dock-sub">
        <button class="btn btn-ghost btn-sm" data-act="prevQ" ${S.i === 0 ? 'disabled' : ''}>${icon('left')} Önceki</button>
        <span class="kbd-hint">${KBD_HINT()}</span>
        <button class="btn btn-ghost btn-sm" data-act="nextQ">${pick ? 'Sonraki' : 'Atla'} ${icon('right')}</button>
      </div>
    </div>
  </div>`;
  const im = v.querySelector('.paper img');
  if (im) im.addEventListener('error', () => { im.parentElement.innerHTML = `<div class="img-err">Görsel yüklenemedi. İnternet bağlantınızı kontrol edin.</div>`; }, { once: true });
  if (pick) showAnswerState(q, pick, false);
  // sonraki görseli önceden yükle
  const nx = S.ids[S.i + 1] && qIndex.get(S.ids[S.i + 1]);
  if (nx) { const p = new Image(); p.decoding = 'async'; p.src = safeImg(nx.q.img); }
}
function qStatsHtml(q) {
  const s = q.qStats;
  return `<span class="qstats" id="qst"><span>Kavrama <b>%${s.mastery}</b></span><span class="ok">D <b>${s.correct}</b></span><span class="err">Y <b>${s.wrong}</b></span></span><span class="small muted" id="qdue">${esc(dueLabel(q))}</span>`;
}
const KBD_HINT = () => (window.matchMedia && matchMedia('(hover: hover) and (pointer: fine)').matches) ? 'A–E seç · ← → geç · F işaretle' : 'Sağa / sola kaydırın';
function showAnswerState(q, pick, fresh) {
  const qs = $('#qst'); if (qs && fresh) qs.parentElement.innerHTML = qStatsHtml(q);
  const opts = $$('#opts .opt');
  opts.forEach((b) => (b.disabled = true));
  const fb = $('#fb');
  const extra = $('#extra');
  if (!hasKey(q)) {
    opts.forEach((b) => b.classList.toggle('sel', b.dataset.l === pick));
    fb.className = 'feedback warn'; fb.innerHTML = q.ans === CANCELLED ? `${icon('alert')} Bu soru sınavda iptal edilmiş.` : `${icon('alert')} Bu sorunun cevap anahtarı sitede yok.`;
  } else {
    const ok = pick === q.ans;
    opts.forEach((b) => {
      if (b.dataset.l === q.ans) b.classList.add('right');
      else if (b.dataset.l === pick) b.classList.add('wrong');
      else b.classList.add('dim');
    });
    fb.className = 'feedback ' + (ok ? 'ok' : 'err');
    fb.innerHTML = ok ? `${icon('check')} Doğru` : `${icon('x')} Yanlış — doğru cevap ${q.ans}`;
  }
  const hint = q.hint && safeImg(q.hint);
  extra.innerHTML = `<div class="after">
    ${hint ? `<button class="btn btn-sm" data-act="showHint">${icon('bulb')} Site cevabı</button>` : ''}
    <button class="btn btn-sm" data-act="editNote">${icon('note')} ${q.qStats.note ? 'Notu düzenle' : 'Not ekle'}</button>
    <button class="btn btn-sm btn-primary" data-act="nextQ">Sonraki ${icon('right')}</button></div>
    <div class="hint-box hidden" id="hintBox">${hint ? `<div class="paper"><img src="${esc(hint)}" alt="Çözüm" loading="lazy"></div>` : ''}</div>`;
  const nb = $('.dock-sub [data-act="nextQ"]'); if (nb) nb.innerHTML = `Sonraki ${icon('right')}`;
}
function onAnswer(L) {
  const S = session; if (!S || S.picks[S.i]) return;
  const entry = qIndex.get(S.ids[S.i]); if (!entry) return;
  const q = entry.q;
  S.picks[S.i] = L;
  let ok = null;
  if (hasKey(q)) {
    ok = recordAnswer(q, L);
    if (ok) S.correct++; else S.wrong++;
    // tekrar kuyruğu: yanlışı birkaç soru sonra yeniden sor
    const id = q.id; const rq = S.requeue[id] || 0;
    const later = S.ids.indexOf(id, S.i + 1) !== -1;
    if (!later && rq < 3 && ['review', 'wrong', 'unmastered', 'flagged'].includes(S.mode)) {
      if (!ok) { S.ids.splice(Math.min(S.ids.length, S.i + 5), 0, id); S.requeue[id] = rq + 1; }
      else if (S.mode === 'unmastered' && !isMastered(q)) { S.ids.splice(Math.min(S.ids.length, S.i + 9), 0, id); S.requeue[id] = rq + 1; }
    }
    saveAll();
  }
  saveSession();
  showAnswerState(q, L, true);
  if (navigator.vibrate && ok === false) { try { navigator.vibrate(30); } catch (e) {} }
  if (ok && settings.autoAdvance) {
    const tok = ++answerToken;
    clearTimeout(advanceTimer);
    advanceTimer = setTimeout(() => { if (tok === answerToken && session === S) studyStep(1); }, settings.advanceDelay || 900);
  }
}
function studyStep(d) {
  const S = session; if (!S) return;
  answerToken++; clearTimeout(advanceTimer);
  const ni = S.i + d;
  if (ni < 0) return;
  S.i = Math.min(ni, S.ids.length);
  if (S.mode === 'course' && S.courseKey) { const c = getCourse(S.courseKey); if (c) { c.lastIndex = Math.min(S.i, c.questions.length); saveSoon(); } }
  saveSession();
  drawStudy(null, d);
  window.scrollTo(0, 0);
}
function exitStudy() {
  const S = session;
  answerToken++; clearTimeout(advanceTimer);
  if (S && S.mode === 'course' && S.courseKey) { const c = getCourse(S.courseKey); if (c) { c.lastIndex = Math.min(S.i, c.questions.length); } }
  saveAll();
  const back = S && S.courseKey && getCourse(S.courseKey) ? '#/ders/' + encodeURIComponent(S.courseKey) : '#/';
  if (S && S.i >= S.ids.length) { localStorage.removeItem(LS.session); session = null; }
  go(back);
}
function toggleFlag() {
  const S = session; if (!S) return;
  const e = qIndex.get(S.ids[S.i]); if (!e) return;
  e.q.qStats.flag = !e.q.qStats.flag; saveAll();
  const b = $('[data-act="toggleFlag"]');
  if (b) { b.classList.toggle('on', !!e.q.qStats.flag); b.setAttribute('aria-pressed', e.q.qStats.flag ? 'true' : 'false'); }
  toast(e.q.qStats.flag ? 'Soru işaretlendi' : 'İşaret kaldırıldı');
}
function editNote(q, after) {
  const s = openSheet(`
    <div class="sheet-head"><div class="h2">Soru notu</div><button class="icon-btn" data-x>${icon('x')}</button></div>
    <textarea class="textarea" id="noteTxt" placeholder="Kendi açıklamanız, ipucu, ezber cümlesi…" autofocus>${esc(q.qStats.note || '')}</textarea>
    <div class="btn-row" style="margin-top:12px">${q.qStats.note ? `<button class="btn btn-danger" data-del>Sil</button>` : ''}<button class="btn btn-primary" data-save>Kaydet</button></div>`);
  s.addEventListener('click', (e) => {
    if (e.target.closest('[data-x]')) closeSheet();
    if (e.target.closest('[data-del]')) { delete q.qStats.note; saveAll(); closeSheet(); after(); }
    if (e.target.closest('[data-save]')) { const t = $('#noteTxt').value.trim().slice(0, 2000); if (t) q.qStats.note = t; else delete q.qStats.note; saveAll(); closeSheet(); after(); }
  });
}
function openZoom(src) {
  if (!src) return;
  const z = document.createElement('div');
  z.className = 'zoom';
  z.innerHTML = `<img src="${esc(src)}" alt="Büyütülmüş soru"><button class="zoom-close" aria-label="Kapat">${icon('x')}</button>`;
  document.body.appendChild(z);
  let last = 0;
  z.addEventListener('click', (e) => {
    if (e.target.closest('.zoom-close')) { z.remove(); return; }
    const now = Date.now(); if (now - last < 320) z.classList.toggle('big'); last = now;
  });
  const esc_ = (e) => { if (e.key === 'Escape') { z.remove(); document.removeEventListener('keydown', esc_); } };
  document.addEventListener('keydown', esc_);
}

/* ---------- Sınav modu ---------- */
let exam = null; let examTimer = 0;
function viewExamSetup(v, preKey) {
  if (!courses.length) { v.innerHTML = `<div class="eyebrow">Sınav</div><h1 class="h1">Deneme sınavı</h1><div class="empty card section"><p>Önce bir ders ekleyin.</p><a class="btn btn-primary" href="#/ekle">Ders ekle</a></div>`; return; }
  const live = readJSON(LS.live, null);
  const sel = new Set(preKey && getCourse(preKey) ? [preKey] : courses.length === 1 ? [courses[0].key] : []);
  let source = 'mix', count = 20, minutes = 30, groupIdx = 0;
  const hist = examHistory.slice().reverse();
  v.innerHTML = `
    <div class="eyebrow">Sınav</div>
    <h1 class="h1">Deneme sınavı</h1>
    <p class="lede">Gerçek sınav gibi: süre işler, cevaplar sonda açıklanır. Yanlışlarınız deftere, sonuçlar geçmişe yazılır.</p>
    ${live && live.ids ? `<div class="notice section" style="margin-top:16px">${icon('timer')}<div style="flex:1">Devam eden sınav: <b>${esc(live.title)}</b></div><a class="btn btn-sm btn-primary" href="#/sinav/canli">Devam et</a></div>` : ''}
    <div class="card card-pad section" style="margin-top:16px">
      <div class="field"><span class="label">Ders</span><div class="chips" id="exCourses">${courses.map((c) => `<button class="chip ${sel.has(c.key) ? 'on' : ''}" data-k="${esc(c.key)}">${esc(courseName(c))}</button>`).join('')}</div></div>
      <div class="field" style="margin-top:18px"><span class="label">Soru kaynağı</span>
        <div class="seg" id="exSource"><button data-s="mix" class="on">Karma</button><button data-s="real">Geçmiş sınav</button><button data-s="weak">Zayıf konular</button></div>
        <span class="help" id="exSrcHelp"></span></div>
      <div id="exOpts" style="margin-top:14px"></div>
      <button class="btn btn-primary btn-block" id="exStart" style="margin-top:18px">${icon('timer')} Sınavı başlat</button>
    </div>
    <div class="section">
      <div class="section-head"><div class="h2">Sınav geçmişi</div></div>
      ${hist.length ? `<div class="rows">${hist.slice(0, 30).map((h) => `<a class="row" href="#/sonuc/${esc(h.id)}"><span class="row-main"><span class="row-title">${esc(h.title)}</span><span class="row-sub">${fmtDate(h.at)} · ${h.correct}/${h.keyed} doğru · ${fmtDur(h.durSec)}</span></span><span class="row-end"><span class="pct num" style="font-size:20px">${h.score}</span>${icon('right')}</span></a>`).join('')}</div>` : `<p class="muted">Henüz sınav çözülmedi.</p>`}
    </div>`;
  const draw = () => {
    const help = { mix: 'Seçili derslerden rastgele sorular.', real: 'Bir geçmiş sınavı birebir, aynı sırayla.', weak: 'Önce yanlışlar, sonra kavranmayanlar.' };
    $('#exSrcHelp').textContent = help[source];
    const one = sel.size === 1 ? getCourse(Array.from(sel)[0]) : null;
    if (source === 'real') {
      if (!one) { $('#exOpts').innerHTML = `<p class="help">Geçmiş sınav için tek bir ders seçin.</p>`; return; }
      const gs = examGroups(one);
      groupIdx = Math.min(groupIdx, gs.length - 1);
      $('#exOpts').innerHTML = `<div class="grid2"><div class="field"><span class="label">Sınav</span><select class="select" id="exGroup">${gs.map((g, i) => `<option value="${i}" ${i === groupIdx ? 'selected' : ''}>${esc(g.title)} (${g.qs.length})</option>`).join('')}</select></div>
        <div class="field"><span class="label">Süre</span><select class="select" id="exMin">${[10, 15, 20, 30, 40, 45, 60, 90].map((m) => `<option value="${m}" ${m === minutes ? 'selected' : ''}>${m} dakika</option>`).join('')}</select></div></div>`;
    } else {
      $('#exOpts').innerHTML = `<div class="grid2"><div class="field"><span class="label">Soru sayısı</span><select class="select" id="exCount">${[10, 20, 25, 30, 40, 50].map((n) => `<option value="${n}" ${n === count ? 'selected' : ''}>${n} soru</option>`).join('')}</select></div>
        <div class="field"><span class="label">Süre</span><select class="select" id="exMin">${[10, 15, 20, 30, 40, 45, 60, 90].map((m) => `<option value="${m}" ${m === minutes ? 'selected' : ''}>${m} dakika</option>`).join('')}</select></div></div>`;
    }
  };
  draw();
  $('#exCourses').addEventListener('click', (e) => { const b = e.target.closest('[data-k]'); if (!b) return; sel.has(b.dataset.k) ? sel.delete(b.dataset.k) : sel.add(b.dataset.k); b.classList.toggle('on'); draw(); });
  $('#exSource').addEventListener('click', (e) => { const b = e.target.closest('[data-s]'); if (!b) return; source = b.dataset.s; $$('#exSource button').forEach((x) => x.classList.toggle('on', x === b)); draw(); });
  $('#exOpts').addEventListener('change', (e) => {
    if (e.target.id === 'exCount') { count = +e.target.value; minutes = Math.max(10, Math.round(count * 1.5 / 5) * 5); draw(); }
    if (e.target.id === 'exMin') minutes = +e.target.value;
    if (e.target.id === 'exGroup') { groupIdx = +e.target.value; }
  });
  $('#exStart').addEventListener('click', async () => {
    if (!sel.size) { toast('En az bir ders seçin.'); return; }
    if (live && live.ids && !(await confirmSheet({ title: 'Yarım kalan sınav silinsin mi?', body: 'Yeni sınav başlatılırsa devam eden sınavınız kaydedilmeden kapanır.', ok: 'Yeni sınav başlat', danger: true }))) return;
    const keys = Array.from(sel);
    let ids = [], title = '';
    const pool = Array.from(new Set(keys.flatMap((k) => getCourse(k).questions))).filter((q) => hasKey(q));
    if (source === 'real') {
      const c = getCourse(keys[0]); const g = examGroups(c)[groupIdx];
      if (!g) return;
      ids = g.qs.filter(hasKey).map((q) => q.id); title = `${courseName(c)} · ${g.title}`;
    } else if (source === 'weak') {
      const w = shuffle(pool.filter((q) => wrongIds.has(q.id)));
      const u = shuffle(pool.filter((q) => !wrongIds.has(q.id) && !isMastered(q)));
      const r = shuffle(pool.filter((q) => !wrongIds.has(q.id) && isMastered(q)));
      ids = [...w, ...u, ...r].slice(0, count).map((q) => q.id); title = (keys.length === 1 ? courseName(getCourse(keys[0])) : `${keys.length} ders`) + ' · Zayıf konular';
    } else {
      ids = shuffle(pool.slice()).slice(0, count).map((q) => q.id); title = (keys.length === 1 ? courseName(getCourse(keys[0])) : `${keys.length} ders`) + ' · Karma deneme';
    }
    ids = Array.from(new Set(ids));
    if (!ids.length) { toast('Cevap anahtarı olan soru bulunamadı.'); return; }
    exam = { id: uid(), title, courseKeys: keys, ids, answers: {}, i: 0, startedAt: Date.now(), durationSec: minutes * 60, endsAt: Date.now() + minutes * 60 * 1000, source };
    writeJSON(LS.live, exam);
    go('#/sinav/canli');
  });
}
function viewExamLive(v) {
  exam = exam || readJSON(LS.live, null);
  if (!exam || !exam.ids) { location.replace('#/sinav'); return; }
  exam.ids = exam.ids.filter((id) => qIndex.has(id));
  drawExam(v, 0);
  clearInterval(examTimer);
  examTimer = setInterval(tickExam, 1000); tickExam();
  const onKey = (e) => {
    if (e.target.closest('input, textarea, select') || $('#modalRoot .overlay') || $('.zoom')) return;
    const k = e.key.toUpperCase(); const map = { '1': 'A', '2': 'B', '3': 'C', '4': 'D', '5': 'E' };
    const L = map[k] || (/^[A-E]$/.test(k) ? k : null);
    if (L && !e.metaKey && !e.ctrlKey) { examPick(L); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { examStep(1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { examStep(-1); e.preventDefault(); }
  };
  document.addEventListener('keydown', onKey);
  const sw = attachSwipe(v, (d) => examStep(d));
  const onVis = () => { if (!document.hidden) tickExam(); };
  document.addEventListener('visibilitychange', onVis);
  currentRoute.cleanup = () => { clearInterval(examTimer); document.removeEventListener('keydown', onKey); document.removeEventListener('visibilitychange', onVis); sw(); };
}
function tickExam() {
  if (!exam) return;
  const left = Math.round((exam.endsAt - Date.now()) / 1000);
  const t = $('#exTimer');
  if (t) { t.textContent = fmtDur(left); t.classList.toggle('low', left <= 120); }
  if (left <= 0) { clearInterval(examTimer); finishExam(true); }
}
function drawExam(v, dir) {
  v = v || $('#view');
  const E = exam; const q = qIndex.get(E.ids[E.i]).q; const pick = E.answers[E.i];
  const answered = Object.keys(E.answers).length;
  v.innerHTML = `
  <div class="player">
    <div class="p-head">
      <button class="icon-btn" data-act="examMenu" aria-label="Soru haritası">${icon('grid')}</button>
      <div class="p-title"><div class="t">${esc(E.title)}</div><div class="s">${E.i + 1} / ${E.ids.length} · ${answered} cevaplandı</div></div>
      <span class="timer num" id="exTimer">--:--</span>
    </div>
    <div class="p-progress"><i style="width:${Math.round((answered / E.ids.length) * 100)}%"></i></div>
    <div class="p-body ${dir > 0 ? 'slide-in' : dir < 0 ? 'slide-back' : ''}">
      <div class="p-meta"><span class="tag">Soru ${E.i + 1}</span><button class="btn btn-ghost btn-sm" data-act="finishExam">Sınavı bitir</button></div>
      <div class="paper" data-act="zoom"><img src="${esc(safeImg(q.img))}" alt="Soru ${E.i + 1}" decoding="async"><span class="zoom-hint">${icon('search')}</span></div>
    </div>
    <div class="dock">
      <div class="opts">${['A', 'B', 'C', 'D', 'E'].map((L) => `<button class="opt ${pick === L ? 'sel' : ''}" data-l="${L}" data-act="examPick">${L}</button>`).join('')}</div>
      <div class="dock-sub">
        <button class="btn btn-ghost btn-sm" data-act="examPrev" ${E.i === 0 ? 'disabled' : ''}>${icon('left')} Önceki</button>
        <span class="kbd-hint">${pick ? 'Değiştirmek için başka şık seçin' : 'Boş bırakabilirsiniz'}</span>
        ${E.i === E.ids.length - 1 ? `<button class="btn btn-primary btn-sm" data-act="finishExam">Bitir</button>` : `<button class="btn btn-ghost btn-sm" data-act="examNext">Sonraki ${icon('right')}</button>`}
      </div>
    </div>
  </div>`;
  tickExam();
  const nx = E.ids[E.i + 1] && qIndex.get(E.ids[E.i + 1]);
  if (nx) { const p = new Image(); p.src = safeImg(nx.q.img); }
}
function examPick(L) {
  if (!exam) return;
  if (exam.answers[exam.i] === L) delete exam.answers[exam.i]; else exam.answers[exam.i] = L;
  writeJSON(LS.live, exam);
  $$('.opts .opt').forEach((b) => b.classList.toggle('sel', b.dataset.l === exam.answers[exam.i]));
  const answered = Object.keys(exam.answers).length;
  const s = $('.p-title .s'); if (s) s.textContent = `${exam.i + 1} / ${exam.ids.length} · ${answered} cevaplandı`;
  const pr = $('.p-progress i'); if (pr) pr.style.width = Math.round((answered / exam.ids.length) * 100) + '%';
  if (exam.answers[exam.i] && exam.i < exam.ids.length - 1) { const tok = ++answerToken; setTimeout(() => { if (tok === answerToken && exam) examStep(1); }, 350); }
}
function examStep(d) {
  if (!exam) return; answerToken++;
  const ni = exam.i + d; if (ni < 0 || ni >= exam.ids.length) return;
  exam.i = ni; writeJSON(LS.live, exam); drawExam(null, d); window.scrollTo(0, 0);
}
function examMenu() {
  const E = exam;
  const s = openSheet(`<div class="sheet-head"><div class="h2">Soru haritası</div><button class="icon-btn" data-x>${icon('x')}</button></div>
    <div class="qgrid">${E.ids.map((_, i) => `<button class="qcell ${E.answers[i] ? 'done' : ''} ${i === E.i ? 'cur' : ''}" data-j="${i}">${i + 1}</button>`).join('')}</div>
    <p class="help" style="margin-top:12px">${Object.keys(E.answers).length} cevaplandı · ${E.ids.length - Object.keys(E.answers).length} boş</p>
    <div class="btn-row" style="margin-top:12px"><button class="btn btn-danger" data-quit>Sınavı iptal et</button><button class="btn btn-primary" data-fin>Bitir</button></div>`);
  s.addEventListener('click', async (e) => {
    const j = e.target.closest('[data-j]');
    if (j) { closeSheet(); answerToken++; exam.i = +j.dataset.j; writeJSON(LS.live, exam); drawExam(null, 0); }
    if (e.target.closest('[data-x]')) closeSheet();
    if (e.target.closest('[data-fin]')) { closeSheet(); finishExam(false); }
    if (e.target.closest('[data-quit]')) {
      closeSheet();
      if (await confirmSheet({ title: 'Sınav iptal edilsin mi?', body: 'Cevaplarınız kaydedilmez, istatistikler değişmez.', ok: 'İptal et', danger: true })) {
        localStorage.removeItem(LS.live); exam = null; go('#/sinav');
      }
    }
  });
}
async function finishExam(timeUp) {
  if (!exam) return;
  const E = exam;
  if (!timeUp) {
    const empty = E.ids.length - Object.keys(E.answers).length;
    const ok = await confirmSheet({ title: 'Sınav bitirilsin mi?', body: empty ? `${empty} soru boş. Boş sorular yanlış sayılmaz ama puana katkı da vermez.` : 'Tüm sorular cevaplandı.', ok: 'Bitir ve sonucu gör' });
    if (!ok || exam !== E) return;
  }
  clearInterval(examTimer);
  let correct = 0, wrong = 0, emptyN = 0;
  const res = E.ids.map((id, i) => {
    const q = qIndex.get(id).q; const a = E.answers[i];
    if (!a) { emptyN++; return { id, a: null, ok: null }; }
    const ok = recordAnswer(q, a); ok ? correct++ : wrong++;
    return { id, a, ok };
  });
  const keyed = E.ids.length;
  const h = { id: E.id, at: Date.now(), title: E.title, courseKeys: E.courseKeys, source: E.source, total: E.ids.length, keyed, correct, wrong, empty: emptyN,
    score: Math.round((correct / Math.max(1, keyed)) * 100), durSec: Math.min(E.durationSec, Math.round((Date.now() - E.startedAt) / 1000)), timeUp: !!timeUp,
    items: res.map((r) => [r.id, r.a]) };
  examHistory.push(h);
  saveAll(); saveHistory();
  localStorage.removeItem(LS.live); exam = null;
  if (timeUp) toast('Süre doldu — sınav teslim edildi.');
  go('#/sonuc/' + h.id);
}
function viewResult(v, id) {
  const h = examHistory.find((x) => x.id === id);
  if (!h) { location.replace('#/sinav'); return; }
  const items = (h.items || []).filter((it) => qIndex.has(it[0]));
  const wrongList = items.filter((it) => it[1] && qIndex.get(it[0]).q.ans !== it[1]).map((it) => it[0]);
  const emptyList = items.filter((it) => !it[1]).map((it) => it[0]);
  v.innerHTML = `
    <a class="btn btn-ghost btn-sm" href="#/sinav" style="margin-left:-8px">${icon('left')} Sınav</a>
    <div class="eyebrow" style="margin-top:12px">${fmtDate(h.at)}${h.timeUp ? ' · süre doldu' : ''}</div>
    <h1 class="h1">${esc(h.title)}</h1>
    <div class="hero section" style="margin-top:14px">
      <div class="eyebrow">Puan (100 üzerinden)</div>
      <div class="hero-row"><div class="score num">${h.score}</div>
      <div style="text-align:right" class="hero-sub"><div><b>${h.correct}</b> doğru</div><div><b>${h.wrong}</b> yanlış</div><div><b>${h.empty}</b> boş</div><div>${fmtDur(h.durSec)} sürdü</div></div></div>
    </div>
    <div class="btn-row section">
      ${wrongList.length ? `<button class="btn btn-primary" data-act="reviewList" data-ids="${esc(wrongList.join('\n'))}" data-title="Sınav yanlışları">Yanlışları incele (${wrongList.length})</button>` : ''}
      ${emptyList.length ? `<button class="btn" data-act="reviewList" data-ids="${esc(emptyList.join('\n'))}" data-title="Boş bırakılanlar">Boşları çöz (${emptyList.length})</button>` : ''}
      <a class="btn" href="#/sinav">Yeni sınav</a>
    </div>
    <div class="section"><div class="section-head"><div class="h2">Cevap kâğıdı</div></div>
      <div class="qgrid">${items.map((it, i) => { const q = qIndex.get(it[0]).q; const cls = !it[1] ? '' : q.ans === it[1] ? 'ok' : 'err'; return `<button class="qcell ${cls}" data-act="reviewOne" data-id="${esc(it[0])}" data-a="${esc(it[1] || '')}" title="${it[1] ? 'Cevabınız ' + it[1] : 'Boş'} · Doğru ${q.ans}">${i + 1}</button>`; }).join('')}</div>
      <p class="help" style="margin-top:10px">Bir numaraya dokunarak soruyu, cevabınızı ve doğru şıkkı görün.</p></div>`;
}
function reviewOne(id, a) {
  const e = qIndex.get(id); if (!e) return;
  const q = e.q; const hint = q.hint && safeImg(q.hint);
  openSheet(`<div class="sheet-head"><div><div class="eyebrow">${esc(courseName(e.course))}</div><div class="h2">${esc(q.title)}</div></div><button class="icon-btn" data-x onclick="">${icon('x')}</button></div>
    <div class="paper"><img src="${esc(safeImg(q.img))}" alt="Soru"></div>
    <p style="margin:14px 0 0;font-weight:600" class="${!a ? 'muted' : a === q.ans ? '' : ''}">${a ? `Cevabınız <span style="color:${a === q.ans ? 'var(--ok)' : 'var(--err)'}">${esc(a)}</span> · ` : 'Boş bırakıldı · '}Doğru cevap <span style="color:var(--ok)">${esc(q.ans)}</span></p>
    ${hint ? `<div class="hint-box"><div class="eyebrow" style="margin-bottom:6px">Sitedeki cevap</div><div class="paper"><img src="${esc(hint)}" alt="Çözüm" loading="lazy"></div></div>` : ''}`)
    .addEventListener('click', (ev) => { if (ev.target.closest('[data-x]')) closeSheet(); });
}
/* ---------- Ayarlar ---------- */
const WORKER_CODE = `export default {
  async fetch(request) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*'
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const target = new URL(request.url).searchParams.get('url');
    if (!target) return new Response('url parametresi gerekli', { status: 400, headers: cors });
    const host = new URL(target).hostname.replace(/^www\\./, '');
    if (!['aofsoru.com', 'ataaofsoru.com'].includes(host)) {
      return new Response('Bu adrese izin verilmiyor', { status: 403, headers: cors });
    }
    const res = await fetch(target, {
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', 'Accept-Language': 'tr-TR,tr;q=0.9' },
      cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': 3600, '404': 60, '500-599': 0 } }
    });
    const h = new Headers(cors);
    h.set('Content-Type', res.headers.get('Content-Type') || 'text/html; charset=utf-8');
    return new Response(res.body, { status: res.status, headers: h });
  }
};`;

function viewSettings(v) {
  const pref = localStorage.getItem(LS.theme) || 'dark';
  const proxy = localStorage.getItem(LS.proxy) || '';
  let bytes = 0;
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith('aof_')) bytes += (localStorage.getItem(k) || '').length * 2; } } catch (e) {}
  const total = allUnique().length;
  v.innerHTML = `
    <div class="eyebrow">Ayarlar</div><h1 class="h1">Tercihler</h1>

    <div class="section"><div class="section-head"><div class="h2">Görünüm</div></div>
      <div class="card card-pad">
        <div class="seg" id="themeSeg"><button data-t="dark">Koyu</button><button data-t="light">Açık</button><button data-t="system">Sistem</button></div>
        <div class="row" style="padding:16px 0 0;border:0">
          <div class="row-main"><div class="row-title">Doğru cevapta otomatik geç</div><div class="row-sub">Yanlışta, inceleyebilmeniz için durur</div></div>
          <label class="switch"><input type="checkbox" id="autoAdv" ${settings.autoAdvance ? 'checked' : ''}><span></span></label>
        </div>
      </div></div>

    <div class="section" id="baglanti"><div class="section-head"><div class="h2">Bağlantı</div></div>
      <div class="card card-pad">
        <div class="field"><label class="label" for="proxyIn">Cloudflare Worker adresiniz</label>
          <input class="input" id="proxyIn" type="url" inputmode="url" autocapitalize="off" spellcheck="false" placeholder="https://ornek.workers.dev/?url=" value="${esc(proxy)}">
          <span class="help">Sorular, tarayıcı kısıtlamaları nedeniyle bir aracı üzerinden okunur. Kendi Worker’ınız en hızlı ve güvenilir yoldur; boş bırakırsanız genel proxyler denenir.</span></div>
        <div class="btn-row" style="margin-top:14px"><button class="btn" data-act="testProxy">${icon('link')} Test et</button><button class="btn btn-primary" data-act="saveProxy">Kaydet</button></div>
        <div id="proxyRes" class="small" style="margin-top:12px"></div>
        <details style="margin-top:14px"><summary style="cursor:pointer;font-weight:600;font-size:14px">Worker nasıl kurulur?</summary>
          <ol class="steps" style="margin-top:12px">
            <li><span>dash.cloudflare.com’da ücretsiz hesapla <b>Workers &amp; Pages › Create › Worker</b> açın.</span></li>
            <li><span>Aşağıdaki kodu yapıştırıp <b>Deploy</b> edin.</span></li>
            <li><span>Size verilen <code>…workers.dev</code> adresini yukarıya girip kaydedin.</span></li>
          </ol>
          <pre class="code-block" id="workerCode">${esc(WORKER_CODE)}</pre>
          <button class="btn btn-sm" data-act="copyWorker" style="margin-top:8px">Kodu kopyala</button>
        </details>
      </div></div>

    <div class="section"><div class="section-head"><div class="h2">Yedek</div></div>
      <div class="rows">
        <button class="row" data-act="exportBackup"><span class="row-icon">${icon('down')}</span><span class="row-main"><span class="row-title">Yedeği dışa aktar</span><span class="row-sub">Dersler, ilerleme, notlar ve sınav geçmişi (JSON)</span></span></button>
        <button class="row" data-act="importBackup"><span class="row-icon">${icon('up')}</span><span class="row-main"><span class="row-title">Yedekten yükle</span><span class="row-sub">Mevcut verilerle birleştirir</span></span></button>
      </div>
      <p class="help" style="margin-top:10px">${courses.length} ders · ${total} soru · yaklaşık ${(bytes / 1024 / 1024).toFixed(2)} MB. iPhone’da Safari uzun süre açılmazsa site verilerini silebilir; ana ekrana ekleyip ara sıra yedek almanız önerilir.</p>
    </div>

    <div class="section"><div class="section-head"><div class="h2">Veriler</div></div>
      <div class="rows">
        <button class="row" data-act="fullReset"><span class="row-icon" style="color:var(--err)">${icon('trash')}</span><span class="row-main"><span class="row-title" style="color:var(--err)">Tüm verileri sil</span><span class="row-sub">Dersler, ilerleme ve geçmiş silinir. Bağlantı ve tema ayarları kalır.</span></span></button>
      </div>
    </div>
    <p class="help" style="margin-top:28px;text-align:center">AÖF Sınav Robotu · sürüm ${APP_VERSION}<br>Sorular aofsoru.com ve ataaofsoru.com’dan okunur; tüm verileriniz yalnızca bu cihazda tutulur.</p>`;
  $$('#themeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.t === pref));
  $('#themeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-t]'); if (!b) return;
    localStorage.setItem(LS.theme, b.dataset.t); applyTheme(b.dataset.t);
    $$('#themeSeg button').forEach((x) => x.classList.toggle('on', x === b));
  });
  $('#autoAdv').addEventListener('change', (e) => { settings.autoAdvance = e.target.checked; saveSettings(); });
  if (location.hash.includes('baglanti')) setTimeout(() => $('#baglanti').scrollIntoView(), 50);
}
function storeProxyFromInput() {
  const inp = $('#proxyIn'); let val = inp.value.trim();
  if (val) { val = cleanAndFormatProxyUrl(val); inp.value = val; localStorage.setItem(LS.proxy, val); }
  else localStorage.removeItem(LS.proxy);
  preferredProxy = 0;
}
async function testProxy() {
  storeProxyFromInput();
  const out = $('#proxyRes');
  out.innerHTML = `<span class="muted">Deneniyor…</span>`;
  const targets = ['https://aofsoru.com/', 'https://ataaofsoru.com/'];
  const lines = [];
  for (const t of targets) {
    const r = await fetchHtml(t);
    lines.push(r.html ? `<div style="color:var(--ok)">✓ ${esc(new URL(t).hostname)} — ${esc(r.via)} üzerinden</div>` : `<div style="color:var(--err)">✕ ${esc(new URL(t).hostname)} — ${esc(r.error || 'ulaşılamadı')}</div>`);
    out.innerHTML = lines.join('');
  }
}

/* ---------- Yedek ---------- */
function exportBackup() {
  const data = {
    app: 'aof-sinav-robotu', version: 2, appVersion: APP_VERSION, exportedAt: new Date().toISOString(),
    courses, wrongIds: Array.from(wrongIds), examHistory, settings,
    theme: localStorage.getItem(LS.theme) || 'dark', proxy: localStorage.getItem(LS.proxy) || ''
  };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const name = `aof-yedek-${new Date().toISOString().slice(0, 10)}.json`;
  const file = typeof File === 'function' ? new File([blob], name, { type: 'application/json' }) : null;
  if (file && navigator.canShare && navigator.canShare({ files: [file] }) && /iPhone|iPad|Android/i.test(navigator.userAgent)) {
    navigator.share({ files: [file], title: 'AÖF Sınav Robotu yedeği' }).catch(() => downloadBlob(blob, name));
  } else downloadBlob(blob, name);
  localStorage.setItem('aof_last_backup', String(Date.now()));
}
function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  toast('Yedek indirildi', 'ok');
}
function importBackup() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'application/json,.json';
  inp.addEventListener('change', async () => {
    const f = inp.files && inp.files[0]; if (!f) return;
    try {
      const txt = await f.text();
      const r = applyBackup(JSON.parse(txt));
      toast(`Yedek yüklendi: ${r.courses} ders, ${r.added} yeni soru`, 'ok', 3500);
      render();
    } catch (e) { toast('Yedek okunamadı: ' + (e.message || 'geçersiz dosya'), 'err', 4000); }
  });
  document.body.appendChild(inp); inp.click(); setTimeout(() => inp.remove(), 60000);
}
function newerStats(a, b) {
  // daha çok etkileşimi / daha yeni cevabı olanı seç; işaret ve notu birleştir
  const la = a.last || 0, lb = b.last || 0;
  const pick = (lb > la || (lb === la && (b.correct + b.wrong) > (a.correct + a.wrong))) ? b : a;
  const out = Object.assign({}, pick);
  out.flag = !!(a.flag || b.flag) || undefined;
  if (!out.note) out.note = a.note || b.note;
  return out;
}
function applyBackup(d) {
  let list, wr, hist;
  if (Array.isArray(d)) { list = d; wr = []; hist = []; }                  // v21 aof_full_data dizisi
  else if (d && Array.isArray(d.courses)) { list = d.courses; wr = d.wrongIds || []; hist = d.examHistory || []; }
  else throw new Error('tanınmayan biçim');
  let added = 0, n = 0;
  for (const raw of list) {
    if (!raw || !Array.isArray(raw.questions)) continue;
    const c = normalizeCourse(JSON.parse(JSON.stringify(raw)));
    n++;
    const ex = courses.find((x) => x.key === c.key) || courses.find((x) => x.uni === c.uni && x.title === c.title);
    if (!ex) { courses.push(c); added += c.questions.length; continue; }
    const m = new Map(ex.questions.map((q) => [q.id, q]));
    for (const q of c.questions) {
      const cur = m.get(q.id);
      if (!cur) { ex.questions.push(q); added++; }
      else { cur.qStats = newerStats(cur.qStats, q.qStats); if (!hasKey(cur) && hasKey(q)) cur.ans = q.ans; if (q.hint && !cur.hint) cur.hint = q.hint; }
    }
    ex.lastIndex = Math.max(ex.lastIndex || 0, c.lastIndex || 0);
  }
  rebuildIndex();
  for (const id of wr) if (qIndex.has(id)) wrongIds.add(id);
  const have = new Set(examHistory.map((h) => h.id));
  for (const h of hist) if (h && h.id && !have.has(h.id)) examHistory.push(h);
  examHistory.sort((a, b) => a.at - b.at);
  if (d.proxy && !localStorage.getItem(LS.proxy)) localStorage.setItem(LS.proxy, d.proxy);
  dataLoadFailed = false;
  saveAll(); saveHistory();
  localStorage.setItem(LS.schema, '2');
  return { courses: n, added };
}

/* ---------- Çevrimdışı görseller ---------- */
async function cacheCourse(c) {
  const urls = Array.from(new Set(c.questions.flatMap((q) => [q.img, q.hint]).filter(Boolean).map(safeImg).filter(Boolean)));
  if (!('caches' in window) || !navigator.serviceWorker || !navigator.serviceWorker.controller) {
    toast('Çevrimdışı kayıt için sayfayı bir kez yenileyin (uygulama önbelleği hazırlanıyor).', '', 4000); return;
  }
  let done = 0, fail = 0;
  const s = openSheet(`<div class="sheet-head"><div><div class="eyebrow">Çevrimdışı</div><div class="h2">${esc(courseName(c))}</div></div></div>
    <p class="muted" id="cc">0 / ${urls.length} görsel</p><div class="progress"><i id="ccBar"></i></div>
    <div class="btn-row" style="margin-top:16px"><button class="btn" data-x>Kapat</button></div>`);
  let stop = false;
  s.addEventListener('click', (e) => { if (e.target.closest('[data-x]')) { stop = true; closeSheet(); } });
  await runPool(urls, 4, async (u) => {
    if (stop) return;
    try { await fetch(u, { mode: 'no-cors' }); } catch (e) { fail++; }
    done++;
    const cc = $('#cc'); if (cc) cc.textContent = `${done} / ${urls.length} görsel${fail ? ` · ${fail} hata` : ''}`;
    const b = $('#ccBar'); if (b) b.style.width = Math.round((done / urls.length) * 100) + '%';
  });
  const cc = $('#cc'); if (cc && !stop) cc.textContent = `Hazır: ${done - fail} görsel cihaza kaydedildi.`;
}

/* ---------- Eylemler ---------- */
const actions = {
  toggleTheme() {
    const t = themeNow() === 'dark' ? 'light' : 'dark';
    localStorage.setItem(LS.theme, t); applyTheme(t);
    if (location.hash.startsWith('#/ayarlar')) $$('#themeSeg button').forEach((x) => x.classList.toggle('on', x.dataset.t === t));
  },
  startReview: (el) => startReviewSession(el.dataset.arg || null),
  startWrong: (el) => startWrongSession(el.dataset.arg || null),
  startUnmastered: (el) => startUnmasteredSession(el.dataset.arg || null),
  startFlagged: () => startFlaggedSession(),
  startCourse: (el) => startCourseSession(el.dataset.arg),
  restartCourse: (el) => startCourseSession(el.dataset.arg, 0),
  startAt: (el) => startCourseSession(el.dataset.arg, +el.dataset.i),
  startGroup: (el) => startGroupSession(el.dataset.arg, +el.dataset.i),
  goExam: () => go('#/sinav'),
  goExamCourse: (el) => go('#/sinav/ders/' + encodeURIComponent(el.dataset.arg)),
  answer: (el) => onAnswer(el.dataset.l),
  nextQ: () => studyStep(1),
  prevQ: () => studyStep(-1),
  exitStudy: () => exitStudy(),
  toggleFlag: () => toggleFlag(),
  zoom: (el) => { const im = el.querySelector('img'); if (im && im.complete && im.naturalWidth) openZoom(im.src); },
  showHint: () => { const b = $('#hintBox'); if (b) b.classList.toggle('hidden'); },
  editNote: () => { const e = session && qIndex.get(session.ids[session.i]); if (e) editNote(e.q, () => drawStudy(null, 0)); },
  examPick: (el) => examPick(el.dataset.l),
  examNext: () => examStep(1),
  examPrev: () => examStep(-1),
  examMenu: () => examMenu(),
  finishExam: () => finishExam(false),
  reviewList: (el) => startSession({ mode: 'list', title: el.dataset.title || 'İnceleme', ids: el.dataset.ids.split('\n').filter((id) => qIndex.has(id)) }),
  reviewOne: (el) => reviewOne(el.dataset.id, el.dataset.a),
  addRow: () => { const rows = $('#rows'); const n = rows.children.length; if (n >= 20) return; rows.insertAdjacentHTML('beforeend', linkRowHtml(n)); rows.lastElementChild.querySelector('[data-url]').focus(); saveDraft(); },
  removeRow: (el) => { el.closest('.link-row').remove(); $$('#rows .link-row').forEach((r, i) => (r.querySelector('.label').textContent = `Ders ${i + 1}`)); saveDraft(); },
  async pasteLink(el) {
    const row = el.closest('.link-row'); const inp = row.querySelector('[data-url]');
    try { const t = await navigator.clipboard.readText(); if (t) { inp.value = t.trim(); updateRowDetect(row); saveDraft(); } }
    catch (e) { inp.focus(); toast('Pano okunamadı — alana dokunup “Yapıştır”ı seçin.'); }
  },
  async startImport() {
    const ceiling = +($('#ceiling').value || 0) || null;
    const rows = collectRows().filter((r) => r.url);
    if (!rows.length) { toast('En az bir ders linki girin.'); $('#rows [data-url]').focus(); return; }
    const bad = rows.map((r) => analyzeLink(r.url)).find((i) => i.error);
    if (bad) { toast(bad.error, 'err', 3500); return; }
    await runImport(rows.map((r) => ({ url: r.url, type: r.type, limit: +r.limit, ceiling, label: r.url.replace(/^https?:\/\/(www\.)?/, '') })));
  },
  async refreshCourse(el) {
    const c = getCourse(el.dataset.arg); if (!c) return;
    const src = c.source || {};
    let url = src.url;
    if (!url) {
      const m = c.key.match(/^anadolu:(.+)$/);
      if (m && !m[1].startsWith('t:')) url = `https://aofsoru.com/${m[1]}-sinav-sorulari`;
    }
    if (!url) { toast('Bu dersin kaynak linki bilinmiyor; Ders Ekle’den linkini yeniden ekleyin.', '', 4000); go('#/ekle'); return; }
    let type = src.type, limit = src.limit;
    if (!type) {
      // v21 dersleri: türü ve sınav sayısını mevcut başlıklardan çıkar ("2023-2024 ARA")
      const map = { 'ARA': 'ara', 'FINAL': 'final', 'YAZ-OKULU': 'yaz-okulu', 'TEK-DERS': 'tek-ders' };
      const groups = examGroups(c).map((g) => g.title);
      const kinds = new Set(groups.map((t) => map[(t.split(' ')[1] || '').toUpperCase()]).filter(Boolean));
      type = kinds.size === 1 ? Array.from(kinds)[0] : kinds.size === 2 && kinds.has('ara') && kinds.has('final') ? 'ara-final' : 'all';
      limit = Math.max(4, groups.length);
    }
    await runImport([{ url, type, limit: limit || 999, label: courseName(c) }], 'stay');
  },
  cacheCourse: (el) => { const c = getCourse(el.dataset.arg); if (c) cacheCourse(c); },
  async resetCourse(el) {
    const c = getCourse(el.dataset.arg); if (!c) return;
    if (!(await confirmSheet({ title: 'İlerleme sıfırlansın mı?', body: `<b>${esc(courseName(c))}</b> için kavrama, tekrar ve yanlış bilgisi silinir. Sorular ve notlar kalır.`, ok: 'Sıfırla', danger: true }))) return;
    c.questions.forEach((q) => { const note = q.qStats.note, flag = q.qStats.flag; Object.assign(q.qStats, { mastery: 0, correct: 0, wrong: 0, box: 0, seen: false, due: undefined, last: undefined }); q.qStats.note = note; q.qStats.flag = flag; wrongIds.delete(q.id); });
    c.lastIndex = 0; saveAll(); render(); toast('İlerleme sıfırlandı');
  },
  async removeCourse(el) {
    const c = getCourse(el.dataset.arg); if (!c) return;
    if (!(await confirmSheet({ title: 'Ders kaldırılsın mı?', body: `<b>${esc(courseName(c))}</b> ve bu dersteki tüm ilerleme bu cihazdan silinir. İsterseniz önce Ayarlar’dan yedek alın.`, ok: 'Kaldır', danger: true }))) return;
    courses = courses.filter((x) => x !== c); rebuildIndex();
    wrongIds = new Set(Array.from(wrongIds).filter((id) => qIndex.has(id)));
    const ss = readJSON(LS.session, null); if (ss && ss.courseKey === c.key) { localStorage.removeItem(LS.session); session = null; }
    saveAll(); go('#/'); toast('Ders kaldırıldı');
  },
  testProxy: () => testProxy(),
  saveProxy: () => { storeProxyFromInput(); toast('Bağlantı ayarı kaydedildi', 'ok'); },
  copyWorker: async () => { try { await navigator.clipboard.writeText(WORKER_CODE); toast('Kod kopyalandı', 'ok'); } catch (e) { toast('Kopyalanamadı — kodu seçip kopyalayın.'); } },
  exportBackup: () => exportBackup(),
  importBackup: () => importBackup(),
  async fullReset() {
    if (!(await confirmSheet({ title: 'Tüm veriler silinsin mi?', body: 'Dersler, kavrama yüzdeleri, yanlış defteri, notlar ve sınav geçmişi kalıcı olarak silinir. Bu işlem geri alınamaz.', ok: 'Her şeyi sil', danger: true }))) return;
    const keep = new Set([LS.theme, LS.proxy]);
    Object.keys(localStorage).filter((k) => k.startsWith('aof_') && !keep.has(k)).forEach((k) => localStorage.removeItem(k));
    try { if ('caches' in window) await caches.delete('aof-img-v1'); } catch (e) {}
    courses = []; wrongIds = new Set(); examHistory = []; session = null; exam = null; rebuildIndex(); dataLoadFailed = false;
    go('#/'); toast('Veriler silindi');
  }
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.act];
  if (!fn) return;
  e.preventDefault();
  fn(el, e);
});

/* ---------- Rotalar ve başlatma ---------- */
route(/^\/$/, viewHome, { nav: 'home' });
route(/^\/ekle$/, viewAdd, { nav: 'add' });
route(/^\/ders\/(.+)$/, viewCourse, { nav: 'home' });
route(/^\/calis$/, viewStudy, { immersive: true });
route(/^\/sinav$/, (v) => viewExamSetup(v), { nav: 'exam' });
route(/^\/sinav\/ders\/(.+)$/, (v, k) => viewExamSetup(v, k), { nav: 'exam' });
route(/^\/sinav\/canli$/, viewExamLive, { immersive: true });
route(/^\/sonuc\/(.+)$/, viewResult, { nav: 'exam' });
route(/^\/ayarlar(?:\/baglanti)?$/, viewSettings, { nav: 'settings' });
route(/^\/ara$/, viewSearch, { nav: '' });

function init() {
  applyTheme(localStorage.getItem(LS.theme) || 'dark');
  try { loadAll(); } catch (e) { console.error(e); dataLoadFailed = true; }
  if (matchMedia) matchMedia('(prefers-color-scheme: light)').addEventListener && matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if ((localStorage.getItem(LS.theme) || 'dark') === 'system') applyTheme('system'); });
  window.addEventListener('hashchange', render);
  window.addEventListener('pagehide', () => saveAll());
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveAll(); });
  render();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const w = reg.installing; if (!w) return;
        w.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) toast('Yeni sürüm hazır — sayfayı yenileyince açılır.', 'ok', 5000);
        });
      });
    }).catch(() => {});
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
