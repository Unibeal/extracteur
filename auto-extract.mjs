// auto-extract.mjs — à placer dans le dossier extracteur/, à côté de extract.js
// Parcourt le catalogue Firestore, extrait les M3U8 manquants / expirés avec extract.js
// et enregistre directement dans Firestore (comme le fait la page extracteur).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, rm } from 'node:fs/promises';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, getDoc, doc, updateDoc } from 'firebase/firestore';

const run = promisify(execFile);

const ONLY_MISSING = String(process.env.ONLY_MISSING || 'false') === 'true';
const LOOKAHEAD_MIN = +process.env.LOOKAHEAD_MIN || 200;   // renouvelle un token qui expire dans moins de X min
const MAX_MIN = +process.env.MAX_MIN || 100;                // on n'attaque plus de nouveau lien après X min
const PER_LINK_TIMEOUT = 120 * 1000;
const START = Date.now();

const app = initializeApp({
  apiKey: 'AIzaSyCiOOJKmyXAih0E4Nx1Z4cGg2kcgRH-u0E', authDomain: 'see-cat-anime.firebaseapp.com', projectId: 'see-cat-anime',
  storageBucket: 'see-cat-anime.firebasestorage.app', messagingSenderId: '787391287965', appId: '1:787391287965:web:bc0d66a306a93b00823a74'
});
const db = getFirestore(app);

// ───────── outils repris de la page ─────────
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

// Date d'expiration (en secondes epoch) du token d'un lien, ou null si inconnue
function expiryOf(raw, extractedAt) {
  let u; try { u = new URL(String(raw).trim()); } catch { return null; }
  const inner = u.searchParams.get('url');
  if (inner && /^https?:\/\//i.test(inner)) return expiryOf(inner, extractedAt);
  const P = {}; u.searchParams.forEach((v, k) => { P[k.toLowerCase()] = v; });
  const num = k => (P[k] != null && /^\d+(\.\d+)?$/.test(P[k])) ? +P[k] : null;
  const toSec = v => v > 1e12 ? v / 1000 : v;
  const isEpoch = v => v != null && toSec(v) > 1e9;
  const absKey = ['exp', 'expires', 'expire', 'validto', 'valid_until', 'end', 'e'].find(k => isEpoch(num(k)));
  const startKey = ['s', 'st', 'start', 'ts', 'time', 'issued'].find(k => isEpoch(num(k)));
  if (absKey) return toSec(num(absKey));
  if (startKey && num('e') != null) return toSec(num(startKey)) + num('e');
  if (num('e') != null && extractedAt && isFinite(Date.parse(extractedAt))) return Date.parse(extractedAt) / 1000 + num('e');
  return null;
}

// Cibles d'extraction d'un titre (même logique que la page)
function targetsOf(a) {
  const out = [];
  if (a.type === 'film') {
    const c = a.cachedFilmM3u8 || {};
    [['filmVideoUrlVf', 'filmVideoUrlVf', 'VF'], ['filmVideoUrlVostfr', 'filmVideoUrlVostfr', 'VOSTFR'], ['filmVideoUrl', 'filmVideoUrl', 'Principal'], ['filmEmbedUrl', 'filmVideoUrl', 'Embed']]
      .forEach(([src, dst, label]) => {
        const u = (a[src] || '').trim(); if (!u) return;
        if (dst === 'filmVideoUrl' && out.some(t => t.dst === 'filmVideoUrl')) return;
        out.push({ film: true, animeId: a.id, dst, label: 'Film · ' + label, embed: u, cached: c[dst] || '', at: c.extractedAt || '', title: a.title });
      });
  } else {
    (a.seasons || []).forEach((s, si) => (s.episodes || []).forEach((e, ei) => {
      const c = e.cachedM3u8 || {}, num = e.number || ei + 1;
      [['videoUrlVf', 'videoUrlVf', 'VF'], ['videoUrlVostfr', 'videoUrlVostfr', 'VOSTFR'], ['videoUrl', 'videoUrl', 'Principal'], ['embedUrl', 'videoUrl', 'Embed']]
        .forEach(([src, dst, label]) => {
          const u = (e[src] || '').trim(); if (!u) return;
          if (dst === 'videoUrl' && out.some(t => t.dst === 'videoUrl' && t.season === si && t.ei === ei)) return;
          out.push({ film: false, animeId: a.id, season: si, ei, num, dst, label, embed: u, cached: c[dst] || '', at: c.extractedAt || '', title: a.title });
        });
    }));
  }
  return out;
}
const nameOf = t => `${t.title || '?'}${t.film ? '' : ` S${t.season + 1}É${t.num}`} ${t.label}`;

// Doit-on (ré)extraire ce lien ?
function needsExtraction(t) {
  if (!t.cached) return true;
  const exp = expiryOf(t.cached, t.at);
  if (exp == null) return false;                       // validité inconnue → on ne touche pas
  const left = exp - Date.now() / 1000;
  return ONLY_MISSING ? left <= 0 : left < LOOKAHEAD_MIN * 60;
}

// Extraction d'un embed avec ton extract.js (écrit result.txt)
async function extractOne(embed) {
  await rm('result.txt', { force: true });
  try { await run('node', ['extract.js', embed], { timeout: PER_LINK_TIMEOUT, maxBuffer: 20 * 1024 * 1024 }); } catch (e) { /* on lit quand même result.txt */ }
  let txt = ''; try { txt = (await readFile('result.txt', 'utf8')).trim(); } catch { /* absent */ }
  if (!txt) throw new Error('aucun résultat produit par extract.js');
  if (txt.startsWith('ERROR')) throw new Error(txt.slice(0, 160));
  const urls = txt.split(/\s+/).filter(x => /^https?:\/\//i.test(x));
  const best = pickBest(urls, embedVideoId(embed));
  if (!best) throw new Error('FAUX LIEN : seul un flux promo/leurre a été capturé');
  return best;
}

// Enregistrement dans Firestore (relit le document juste avant d'écrire)
async function save(t, m3u8) {
  const ref = doc(db, 'animes', t.animeId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('Titre introuvable');
  const data = snap.data(), now = new Date().toISOString();
  if (t.film) {
    await updateDoc(ref, { cachedFilmM3u8: { ...(data.cachedFilmM3u8 || {}), [t.dst]: m3u8, extractedAt: now } });
  } else {
    const seasons = JSON.parse(JSON.stringify(data.seasons || []));
    const ep = seasons[t.season] && seasons[t.season].episodes && seasons[t.season].episodes[t.ei];
    if (!ep) throw new Error('Épisode introuvable (catalogue modifié ?)');
    ep.cachedM3u8 = { ...(ep.cachedM3u8 || {}), [t.dst]: m3u8, extractedAt: now };
    await updateDoc(ref, { seasons });
  }
}

// ───────── programme principal ─────────
const snap = await getDocs(collection(db, 'animes'));
const animes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
const all = animes.flatMap(targetsOf).filter(t => isExtractable(t.embed));
const jobs = all.filter(needsExtraction);
console.log(`Catalogue : ${animes.length} titres, ${all.length} liens extractibles, ${jobs.length} à traiter (only_missing=${ONLY_MISSING}).`);

// flux déjà utilisés par d'autres épisodes (détection des faux liens)
const seen = new Map();
all.filter(t => t.cached).forEach(t => seen.set(streamKey(t.cached), t.embed));

let ok = 0, ko = 0;
for (const t of jobs) {
  if ((Date.now() - START) / 60000 > MAX_MIN) { console.log('⏹ Temps maximum atteint, le reste sera fait au prochain passage.'); break; }
  try {
    const m3u8 = await extractOne(t.embed);
    const k = streamKey(m3u8);
    if (seen.has(k) && seen.get(k) !== t.embed) throw new Error('FAUX LIEN : flux déjà utilisé par un autre épisode');
    seen.set(k, t.embed);
    await save(t, m3u8);
    ok++; console.log('✓ ' + nameOf(t));
  } catch (e) { ko++; console.log('✗ ' + nameOf(t) + ' — ' + e.message); }
}
console.log(`Terminé : ${ok} réussi(s), ${ko} échec(s).`);
process.exit(0);   // Firestore garde la connexion ouverte, on force la sortie
