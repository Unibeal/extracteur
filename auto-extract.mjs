// Extraction automatique des M3U8 — tourne sur GitHub Actions, sans navigateur ouvert chez toi.
// Même base Firestore et même format d'écriture que extracteur-complet.html.
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc, getDocs, updateDoc, collection, query, where } from 'firebase/firestore';
import { chromium } from 'playwright';

const app = initializeApp({
  apiKey: 'AIzaSyCiOOJKmyXAih0E4Nx1Z4cGg2kcgRH-u0E', authDomain: 'see-cat-anime.firebaseapp.com', projectId: 'see-cat-anime',
  storageBucket: 'see-cat-anime.firebasestorage.app', messagingSenderId: '787391287965', appId: '1:787391287965:web:bc0d66a306a93b00823a74'
});
const db = getFirestore(app);

const LOOKAHEAD = (+process.env.LOOKAHEAD_MIN || 200) * 60;      // secondes
const ONLY_MISSING = process.env.ONLY_MISSING === 'true';
const CONC = +process.env.CONCURRENCY || 4;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ───── Outils repris de l'extracteur ─────
const isDirect = u => /\.m3u8($|\?|#)/i.test(u) && !/embed|vidmol|moly/i.test(u);
const isExtractable = u => /^https?:\/\//i.test(u || '') && !isDirect(u);
const isDecoy = u => /\/(promo|taunt|ads?|pub|trailer)\//i.test(u);
const streamKey = u => { try { return new URL(u).pathname.replace(/\/[^\/]*$/, ''); } catch { return u; } };
const embedVideoId = e => { const m = (e || '').match(/(?:embed-|\/embed\/|\/e\/|\/w\/|\/v\/)([a-z0-9]{8,16})/i); return m ? m[1] : null; };
function pickBest(urls, id) {
  const list = [...new Set(urls.filter(Boolean))].filter(u => !isDecoy(u));
  if (!list.length) return null;
  const score = u => (id && u.includes(id) ? 100 : 0) + (/master\.m3u8/i.test(u) ? 20 : 0) + (/urlset/i.test(u) ? 10 : 0) + (/[?&]t=/.test(u) ? 5 : 0);
  return list.map((u, i) => ({ u, i, s: score(u) })).sort((a, b) => b.s - a.s || a.i - b.i)[0].u;
}
function findM3u8(text, id) {
  if (!text) return null;
  const pats = [
    /(?:file|src|source)\s*[:=]\s*["'](https?:\\?\/\\?\/[^"']+\.m3u8[^"']*)["']/gi,
    /<source[^>]+src=["']([^"']+\.m3u8[^"']*)["']/gi,
    /(https?:\\?\/\\?\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/gi
  ];
  const all = [];
  for (const re of pats) { let m; while ((m = re.exec(text))) if (m[1]) all.push(m[1].replace(/\\/g, '').replace(/&amp;/g, '&')); }
  return pickBest(all, id);
}
function unpackAll(html) {
  const out = [];
  const re = /\}\('((?:[^'\\]|\\.)*)',\s*(\d+),\s*(\d+),\s*'((?:[^'\\]|\\.)*)'\.split\('\|'\)/g;
  let m;
  while ((m = re.exec(html))) {
    let p = m[1], a = +m[2], c = +m[3]; const k = m[4].split('|');
    const base = n => (n < a ? '' : base(parseInt(n / a))) + ((n = n % a) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
    const d = {}; while (c--) d[base(c)] = k[c] || base(c);
    out.push(p.replace(/\b\w+\b/g, w => d[w] || w).replace(/\\'/g, "'"));
  }
  return out.join('\n');
}
const VM_RE = /vidmol[yi]|moly/i, VM_DOMAINS = ['vidmoly.net', 'vidmoly.to', 'vidmoly.biz', 'vidmoly.me'];
function candidates(embed) {
  const list = [embed];
  if (VM_RE.test(embed)) {
    const m = embed.match(/(?:embed-|\/embed\/|\/w\/|\/v\/)([a-z0-9]{8,16})/i) || embed.match(/vidmol[yi]\.[a-z]+\/([a-z0-9]{8,16})/i);
    if (m) VM_DOMAINS.forEach(d => { const u = `https://${d}/embed-${m[1]}.html`; if (!list.includes(u)) list.push(u); });
  }
  return list;
}

// Expiration lue dans le token (s + e, ou exp absolu) — null si inconnue
function tokenExpiry(raw, extractedAtIso) {
  let u; try { u = new URL(String(raw).trim()); } catch { return null; }
  const P = {}; u.searchParams.forEach((v, k) => { P[k.toLowerCase()] = v; });
  const num = k => (P[k] != null && /^\d+(\.\d+)?$/.test(P[k])) ? +P[k] : null;
  const toSec = v => v > 1e12 ? v / 1000 : v, isEpoch = v => v != null && toSec(v) > 1e9;
  const absKey = ['exp', 'expires', 'expire', 'validto', 'valid_until', 'end', 'e'].find(k => isEpoch(num(k)));
  const startKey = ['s', 'st', 'start', 'ts', 'time', 'issued'].find(k => isEpoch(num(k)));
  if (absKey) return toSec(num(absKey));
  if (startKey && num('e') != null) return toSec(num(startKey)) + num('e');
  const at = Date.parse(extractedAtIso);
  if (num('e') != null && at) return at / 1000 + num('e');
  return null;
}
const needsRefresh = t => {
  if (!t.cached) return true;
  if (ONLY_MISSING) { const e = tokenExpiry(t.cached, t.at); return e != null && e - Date.now() / 1000 <= 0; }
  const e = tokenExpiry(t.cached, t.at);
  if (e == null) { const at = Date.parse(t.at); return !at || Date.now() - at > 3 * 3600e3; }
  return e - Date.now() / 1000 < LOOKAHEAD;
};

// Cibles d'un titre (identique à targetsOf de l'extracteur)
function targetsOf(a) {
  const out = [];
  if (a.type === 'film') {
    const c = a.cachedFilmM3u8 || {};
    [['filmVideoUrlVf', 'filmVideoUrlVf'], ['filmVideoUrlVostfr', 'filmVideoUrlVostfr'], ['filmVideoUrl', 'filmVideoUrl'], ['filmEmbedUrl', 'filmVideoUrl']].forEach(([src, dst]) => {
      const u = (a[src] || '').trim(); if (!u) return;
      if (dst === 'filmVideoUrl' && out.some(t => t.dst === 'filmVideoUrl')) return;
      out.push({ film: true, animeId: a.id, dst, embed: u, cached: c[dst] || '', at: c.extractedAt || '', name: (a.title || a.id) + ' · film ' + dst });
    });
  } else {
    (a.seasons || []).forEach((s, si) => (s.episodes || []).forEach((e, ei) => {
      const c = e.cachedM3u8 || {}, num = e.number || ei + 1;
      [['videoUrlVf', 'videoUrlVf'], ['videoUrlVostfr', 'videoUrlVostfr'], ['videoUrl', 'videoUrl'], ['embedUrl', 'videoUrl']].forEach(([src, dst]) => {
        const u = (e[src] || '').trim(); if (!u) return;
        if (dst === 'videoUrl' && out.some(t => t.dst === 'videoUrl' && t.season === si && t.ei === ei)) return;
        out.push({ film: false, animeId: a.id, season: si, ei, dst, embed: u, cached: c[dst] || '', at: c.extractedAt || '', name: `${a.title || a.id} · S${si + 1}E${num} ${dst}` });
      });
    }));
  }
  return out;
}

// ───── Extraction ─────
let browser;
async function extractStatic(embed) {
  const vid = embedVideoId(embed);
  for (const url of candidates(embed)) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: new URL(url).origin + '/' }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) continue;
      const html = await r.text();
      const f = findM3u8(html, vid) || findM3u8(unpackAll(html), vid);
      if (f) return f;
    } catch { }
  }
  return null;
}
async function extractHeadless(embed) {
  browser ||= await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 720 } });
  const found = [];
  try {
    const page = await ctx.newPage();
    page.on('request', rq => { if (/\.m3u8(\?|$)/i.test(rq.url())) found.push(rq.url()); });
    await page.route('**/*', rt => ['image', 'font'].includes(rt.request().resourceType()) ? rt.abort() : rt.continue());
    await page.goto(embed, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { });
    for (let i = 0; i < 14 && !pickBest(found, embedVideoId(embed)); i++) {
      await sleep(2000);
      if (i === 2 || i === 6) for (const sel of ['video', '.jw-display-icon-display', '.vjs-big-play-button', 'button', 'body']) { await page.click(sel, { timeout: 800 }).catch(() => { }); }
    }
    const html = await page.content().catch(() => '');
    return pickBest(found, embedVideoId(embed)) || findM3u8(html, embedVideoId(embed)) || findM3u8(unpackAll(html), embedVideoId(embed));
  } finally { await ctx.close().catch(() => { }); }
}
const seenStreams = new Map();   // streamKey → embed : repère les leurres renvoyés à plusieurs embeds
async function extractOne(t) {
  let m3u8 = await extractStatic(t.embed);
  if (!m3u8) m3u8 = await extractHeadless(t.embed);
  if (!m3u8) throw new Error('aucun M3U8 trouvé');
  if (isDecoy(m3u8)) throw new Error('flux promo/leurre');
  const k = streamKey(m3u8), other = seenStreams.get(k);
  if (other && other !== t.embed) throw new Error('FAUX LIEN : flux déjà utilisé par un autre épisode');
  seenStreams.set(k, t.embed);
  return m3u8;
}

// Écrit les résultats d'un titre en UNE écriture (relit juste avant pour ne pas écraser une modif récente)
async function saveResults(animeId, results) {
  if (!results.length) return;
  const ref = doc(db, 'animes', animeId), snap = await getDoc(ref);
  if (!snap.exists()) return;
  const data = snap.data(), now = new Date().toISOString(), upd = {};
  const seasons = JSON.parse(JSON.stringify(data.seasons || []));
  let film = { ...(data.cachedFilmM3u8 || {}) }, sChanged = false, fChanged = false;
  for (const { t, m3u8 } of results) {
    if (t.film) { film[t.dst] = m3u8; film.extractedAt = now; fChanged = true; }
    else {
      const ep = seasons[t.season] && seasons[t.season].episodes && seasons[t.season].episodes[t.ei];
      if (!ep) continue;
      ep.cachedM3u8 = { ...(ep.cachedM3u8 || {}), [t.dst]: m3u8, extractedAt: now }; sChanged = true;
    }
  }
  if (fChanged) upd.cachedFilmM3u8 = film;
  if (sChanged) upd.seasons = seasons;
  if (Object.keys(upd).length) await updateDoc(ref, upd);
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const x = items[i++]; await fn(x); } }));
}

// ───── 1. Demandes du Player (bouton lecture) ─────
async function handleRequests() {
  let snap; try { snap = await getDocs(query(collection(db, 'extract_requests'), where('status', '==', 'pending'))); } catch (e) { log('demandes Player illisibles :', e.message); return; }
  for (const d of snap.docs) {
    const r = d.data(), reply = o => updateDoc(d.ref, o).catch(() => { });
    try {
      if (Date.now() - (r.requestedAt || 0) > 10 * 60 * 1000) { await reply({ status: 'error', error: 'demande périmée' }); continue; }
      await reply({ status: 'running', pickedAt: Date.now() });
      const s = await getDoc(doc(db, 'animes', r.animeId)); if (!s.exists()) throw new Error('Titre introuvable');
      const a = { id: s.id, ...s.data() };
      const t = targetsOf(a).find(x => r.film ? (x.film && x.dst === r.dst) : (!x.film && x.season === r.season && x.ei === r.ei && x.dst === r.dst));
      if (!t) throw new Error('Version introuvable');
      const m3u8 = await extractOne(t);
      await saveResults(a.id, [{ t, m3u8 }]);
      await reply({ status: 'done', m3u8, doneAt: Date.now() });
      log('✓ demande Player :', t.name);
    } catch (e) { await reply({ status: 'error', error: String(e.message || e).slice(0, 200) }); log('✗ demande Player :', e.message); }
  }
}

// ───── 2. Tout le catalogue ─────
async function main() {
  await handleRequests();
  const snap = await getDocs(collection(db, 'animes'));
  const animes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  let ok = 0, ko = 0, skip = 0;
  for (const a of animes) {
    const all = targetsOf(a).filter(t => isExtractable(t.embed));
    const todo = all.filter(needsRefresh); skip += all.length - todo.length;
    if (!todo.length) continue;
    log(`▶ ${a.title || a.id} : ${todo.length} lien(s)`);
    const results = [];
    await pool(todo, CONC, async t => {
      try { results.push({ t, m3u8: await extractOne(t) }); ok++; }
      catch (e) { ko++; log('  ✗', t.name, '—', e.message); }
    });
    try { await saveResults(a.id, results); } catch (e) { log('  ✗ écriture', a.title || a.id, e.message); }
  }
  log(`Terminé : ${ok} extrait(s), ${ko} échec(s), ${skip} déjà valide(s)`);
  if (browser) await browser.close();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
