// Extrait le M3U8 d'UN film / épisode, l'enregistre dans le catalogue et répond dans extract_requests.
import admin from 'firebase-admin';
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const P = JSON.parse(process.env.PAYLOAD);
const ref = db.collection('extract_requests').doc(P.reqId);

const PROXY = (process.env.HLS_PROXY || 'https://hlsproxy.faroukmigan.workers.dev/').replace(/\/?$/, '/');   // même proxy que le player
// Même calcul que __tokenExpiry() du player : on ne conclut QUE si une vraie date (époque Unix) est présente dans le lien
const tokenExpiry = raw => {
  let u; try { u = new URL(String(raw).trim()); } catch { return null; }
  const inner = u.searchParams.get('url'); if (inner && /^https?:\/\//i.test(inner)) return tokenExpiry(inner);
  const P = {}; u.searchParams.forEach((v, k) => { P[k.toLowerCase()] = v; });
  const num = k => (P[k] != null && /^\d+(\.\d+)?$/.test(P[k])) ? +P[k] : null;
  const toSec = v => v > 1e12 ? v / 1000 : v, isEpoch = v => v != null && toSec(v) > 1e9;
  const absKey = ['exp', 'expires', 'expire', 'validto', 'valid_until', 'end', 'e'].find(k => isEpoch(num(k)));
  const startKey = ['s', 'st', 'start', 'ts', 'time', 'issued'].find(k => isEpoch(num(k)));
  if (absKey) return toSec(num(absKey));                                       // expiration absolue
  if (startKey && num('e') != null) return toSec(num(startKey)) + num('e');    // début + validité
  return null;                                                                 // incertain : on ne rejette jamais
};
const isDecoy = u => { u = String(u || ''); try { u = decodeURIComponent(u); } catch {} return /\/(taunt|promo)\//i.test(u); };   // flux promo renvoyé aux IP de data-center
// Uqload & co n'affichent l'embed que pour un site autorisé : on se présente comme votre site (comme le fait le navigateur du player)
const SITE = (process.env.SITE_ORIGIN || 'https://marxist-beige-tlqaymgn.edgeone.dev').trim().replace(/\/+$/, '');
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36' };
const UQ_DOMAINS = ['uqload.is', 'uqload.io', 'uqload.ws', 'uqload.co', 'uqload.vc'];
const DOMAINS = ['vidmoly.net', 'vidmoly.to', 'vidmoly.biz', 'vidmoly.me'];
const idOf = u => (u.match(/(?:embed-|\/embed\/|\/w\/|\/v\/)([a-z0-9]{8,16})/i) || u.match(/vidmol[yi]\.[a-z]+\/([a-z0-9]{8,16})(?:\.html)?(?:[/?#]|$)/i) || [])[1];
const candidates = e => { const l = [e], id = idOf(e); if (id && /uqload/i.test(e)) UQ_DOMAINS.forEach(d => { const u = `https://${d}/embed-${id}.html`; if (!l.includes(u)) l.push(u); }); if (id && /vidmol[yi]|moly|ansembed/i.test(e)) DOMAINS.forEach(d => { const u = `https://${d}/embed-${id}.html`; if (!l.includes(u)) l.push(u); }); return l; };
function unpack(html) {   // décompresse le JS « p,a,c,k,e,d »
  const out = [], re = /\}\('((?:[^'\\]|\\.)*)',\s*(\d+),\s*(\d+),\s*'((?:[^'\\]|\\.)*)'\.split\('\|'\)/g; let m;
  while ((m = re.exec(html))) {
    let p = m[1], a = +m[2], c = +m[3]; const k = m[4].split('|');
    const base = n => (n < a ? '' : base(parseInt(n / a))) + ((n = n % a) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
    const d = {}; while (c--) d[base(c)] = k[c] || base(c);
    out.push(p.replace(/\b\w+\b/g, w => d[w] || w).replace(/\\'/g, "'"));
  }
  return out.join('\n');
}
function find(text, id) {
  if (!text) return null;
  const clean = u => u.replace(/\\\//g, '/').replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
  const collect = (pats) => { const out = []; for (const re of pats) { let m; while ((m = re.exec(text))) { const u = clean(m[1]); if (/^https?:\/\//.test(u) && !isDecoy(u)) out.push(u); } } return [...new Set(out)]; };
  const score = u => (id && u.includes(id) ? 100 : 0) + (/master\.m3u8/i.test(u) ? 20 : 0) + (/urlset/i.test(u) ? 10 : 0) + (/[?&]t=/.test(u) ? 5 : 0) + (/[?&]e=\d+/.test(u) ? 3 : 0);
  const best = l => l.map((u, i) => ({ u, i, s: score(u) })).sort((x, y) => y.s - x.s || x.i - y.i)[0]?.u || null;
  const hls = collect([
    /(?:file|src|source|hls\d*|stream|url|video)["']?\s*[:=]\s*["'](https?:\\?\/\\?\/[^"']+?\.m3u8[^"']*)["']/gi,
    /["']hls\d*["']\s*:\s*["']([^"']+)["']/gi,
    /<source[^>]+src=["']([^"']+\.m3u8[^"']*)["']/gi,
    /(https?:\\?\/\\?\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*)/gi
  ]);
  if (hls.length) return best(hls);
  const mp4 = collect([                                   // hébergeurs en MP4 (ex. Uqload) : à défaut de M3U8
    /(?:file|src|source|video)["']?\s*[:=]\s*["'](https?:\\?\/\\?\/[^"']+?\.mp4[^"']*)["']/gi,
    /sources?\s*[:=]\s*\[\s*["'](https?:[^"']+\.mp4[^"']*)["']/gi,
    /<source[^>]+src=["']([^"']+\.mp4[^"']*)["']/gi,
    /(https?:\\?\/\\?\/[^\s"'<>\\]+\.mp4[^\s"'<>\\]*)/gi
  ]);
  return best(mp4);
}
const decoded = t => { // décode aussi les blocs atob("...") éventuels
  const out = []; for (const m of t.matchAll(/atob\(["']([A-Za-z0-9+\/=]{20,})["']\)/g)) { try { out.push(Buffer.from(m[1], 'base64').toString('utf8')); } catch {} } return out.join('\n');
};
async function get(url, referer, viaProxy, bustCache) {
  const bust = bustCache ? (url.includes('?') ? '&' : '?') + '_=' + Date.now() : '';   // anti-cache : en DERNIER recours seulement (certains hébergeurs refusent l'URL modifiée)
  const target = viaProxy ? PROXY + '?url=' + encodeURIComponent(url + bust) : url + bust;
  const r = await fetch(target, { headers: { ...(viaProxy ? {} : UA), 'Cache-Control': 'no-cache', Origin: SITE, Referer: SITE + '/' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  return { status: r.status, text: await r.text(), url };
}
const scan = (t, id) => find(t, id) || find(unpack(t), id) || find(decoded(t), id);
async function extract(embed) {
  const notes = [], id = idOf(embed);
  for (const page of candidates(embed)) {
    for (const [viaProxy, bustCache] of [[true, false], [false, false], [true, true]]) {   // proxy, direct, puis proxy + anti-cache
      const tag = `${new URL(page).host}${viaProxy ? ' (proxy)' : ' (direct)'}${bustCache ? '+bust' : ''}`;
      try {
        const { status, text, url } = await get(page, null, viaProxy, bustCache);
        const title = (text.match(/<title>([^<]{0,60})/i) || [])[1] || '';
        const promo = /\/(taunt|promo)\//i.test(text);
        notes.push(`${tag} → HTTP ${status}, ${text.length} o${title ? ', « ' + title.trim() + ' »' : ''}${promo ? ', LEURRE PROMO' : ''}${text.length < 300 ? ', corps=« ' + text.replace(/\s+/g, ' ').trim().slice(0, 120) + ' »' : ''}`);
        if (status >= 400) continue;
        let m = scan(text, id);
        if (m) return m;
        for (const f of [...text.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)].map(x => x[1]).slice(0, 3)) {
          try {
            const abs = new URL(f, url).href, r2 = await get(abs, url, viaProxy);
            m = scan(r2.text, id);
            if (m) return m;
            notes.push(`iframe ${new URL(abs).host} → HTTP ${r2.status}, aucun m3u8`);
          } catch (e) { notes.push('iframe KO : ' + e.message); }
        }
      } catch (e) { notes.push(`${tag} → ${e.message}`); }
    }
  }
  throw new Error('aucun lien vidéo trouvé | ' + notes.join(' | ').slice(0, 700));
}

// On « prend » la demande (évite un double traitement avec l'ancienne page d'extraction)
const claimed = await db.runTransaction(async tx => {
  const s = await tx.get(ref); if (!s.exists || s.data().status !== 'pending') return false;
  tx.update(ref, { status: 'running', startedAt: Date.now(), by: 'github' }); return true;
});
if (!claimed) { console.log('demande déjà prise en charge'); process.exit(0); }

try {
  const m3u8 = await extract(P.embed);
  if (isDecoy(m3u8)) throw new Error('lien promo refusé : ' + m3u8);
  const exp = tokenExpiry(m3u8), left = exp == null ? null : exp - Date.now() / 1000;
  console.log('token :', exp == null ? 'pas de date d\'expiration lisible (lien accepté)' : `expire ${new Date(exp * 1000).toISOString()}, reste ${Math.round(left)}s`);
  if (left != null && left < -60) throw new Error(`lien déjà expiré (${new Date(exp * 1000).toISOString()}) : ${m3u8.slice(0, 120)}`);   // seulement si CERTAIN
  // Enregistrement dans le catalogue (animes/<id>) : même emplacement que l'extracteur habituel — À ADAPTER si ta structure diffère
  const aRef = db.collection('animes').doc(P.animeId), snap = await aRef.get(), a = snap.data() || {}, extractedAt = new Date().toISOString();
  if (P.film) {
    await aRef.update({ cachedFilmM3u8: { ...(a.cachedFilmM3u8 || {}), [P.dst]: m3u8, extractedAt } });
  } else {
    const seasons = a.seasons || [], eps = (seasons[P.season] || {}).episodes || [];
    const ep = eps[P.ei];
    if (!ep) throw new Error(`épisode introuvable dans animes/${P.animeId} (saison ${P.season}, index ${P.ei}) : catalogue non mis à jour`);
    ep.cachedM3u8 = { ...(ep.cachedM3u8 || {}), [P.dst]: m3u8, extractedAt }; await aRef.update({ seasons });
  }
  await ref.update({ status: 'done', m3u8, finishedAt: Date.now() });
  console.log('OK', m3u8.slice(0, 80));
} catch (e) {
  await ref.update({ status: 'error', error: String(e.message || e), finishedAt: Date.now() });
  console.error(e); process.exit(1);
}
