// Extrait le M3U8 d'UN film / épisode, l'enregistre dans le catalogue et répond dans extract_requests.
import admin from 'firebase-admin';
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const P = JSON.parse(process.env.PAYLOAD);
const ref = db.collection('extract_requests').doc(P.reqId);

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36' };
const DOMAINS = ['vidmoly.net', 'vidmoly.to', 'vidmoly.biz', 'vidmoly.me'];
const idOf = u => (u.match(/(?:embed-|\/embed\/|\/w\/|\/v\/)([a-z0-9]{8,16})/i) || u.match(/vidmol[yi]\.[a-z]+\/([a-z0-9]{8,16})(?:\.html)?(?:[/?#]|$)/i) || [])[1];
const candidates = e => { const l = [e], id = idOf(e); if (id && /vidmol[yi]|moly/i.test(e)) DOMAINS.forEach(d => { const u = `https://${d}/embed-${id}.html`; if (!l.includes(u)) l.push(u); }); return l; };
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
  const pats = [/(?:file|src|source)\s*[:=]\s*["'](https?:\\?\/\\?\/[^"']+\.m3u8[^"']*)["']/gi, /<source[^>]+src=["']([^"']+\.m3u8[^"']*)["']/gi, /(https?:\\?\/\\?\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/gi];
  const found = []; for (const re of pats) { let m; while ((m = re.exec(text))) found.push(m[1].replace(/\\\//g, '/')); }
  const score = u => (id && u.includes(id) ? 100 : 0) + (/master\.m3u8/i.test(u) ? 20 : 0) + (/urlset/i.test(u) ? 10 : 0) + (/[?&]t=/.test(u) ? 5 : 0);
  return found.sort((x, y) => score(y) - score(x))[0] || null;
}
async function extract(embed) {
  for (const page of candidates(embed)) {
    try {
      const r = await fetch(page, { headers: { ...UA, Referer: new URL(page).origin + '/' }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) continue;
      const t = await r.text(), m = find(t, idOf(embed)) || find(unpack(t), idOf(embed));
      if (m) return m;
    } catch {}
  }
  throw new Error('aucun M3U8 trouvé');
}

// On « prend » la demande (évite un double traitement avec l'ancienne page d'extraction)
const claimed = await db.runTransaction(async tx => {
  const s = await tx.get(ref); if (!s.exists || s.data().status !== 'pending') return false;
  tx.update(ref, { status: 'running', startedAt: Date.now(), by: 'github' }); return true;
});
if (!claimed) { console.log('demande déjà prise en charge'); process.exit(0); }

try {
  const m3u8 = await extract(P.embed);
  // Enregistrement dans le catalogue (animes/<id>) : même emplacement que l'extracteur habituel — À ADAPTER si ta structure diffère
  const aRef = db.collection('animes').doc(P.animeId), snap = await aRef.get(), a = snap.data() || {}, extractedAt = new Date().toISOString();
  if (P.film) {
    await aRef.update({ cachedFilmM3u8: { ...(a.cachedFilmM3u8 || {}), [P.dst]: m3u8, extractedAt } });
  } else {
    const seasons = a.seasons || [], ep = (seasons[P.season] || {}).episodes?.[P.ei];
    if (ep) { ep.cachedM3u8 = { ...(ep.cachedM3u8 || {}), [P.dst]: m3u8, extractedAt }; await aRef.update({ seasons }); }
  }
  await ref.update({ status: 'done', m3u8, finishedAt: Date.now() });
  console.log('OK', m3u8.slice(0, 80));
} catch (e) {
  await ref.update({ status: 'error', error: String(e.message || e), finishedAt: Date.now() });
  console.error(e); process.exit(1);
}
