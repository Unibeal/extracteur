// Extrait le M3U8 d'UN film / épisode, l'enregistre dans le catalogue et répond dans extract_requests.
import admin from 'firebase-admin';
import fs from 'fs';
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const P = JSON.parse(process.env.PAYLOAD);
const ref = db.collection('extract_requests').doc(P.reqId);

const PROXY = (process.env.HLS_PROXY || 'https://hlsproxy.faroukmigan.workers.dev/').replace(/\/?$/, '/');   // même proxy que le player
const isDecoy = u => { u = String(u || ''); try { u = decodeURIComponent(u); } catch {} return /\/(taunt|promo)\//i.test(u) || /test-videos\.co\.uk|big_?buck_?bunny/i.test(u); };   // flux promo renvoyé aux IP de data-center
// Uqload & co n'affichent l'embed que pour un site autorisé : on se présente comme votre site (comme le fait le navigateur du player)
const SITE = (process.env.SITE_ORIGIN || 'https://marxist-beige-tlqaymgn.edgeone.dev').trim().replace(/\/+$/, '');
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36' };
const UQ_DOMAINS = ['uqload.is', 'uqload.io', 'uqload.ws', 'uqload.co', 'uqload.vc'];
const DOMAINS = ['vidmoly.net', 'vidmoly.to', 'vidmoly.biz', 'vidmoly.me'];
const idOf = u => (u.match(/(?:embed-|\/embed\/|\/w\/|\/v\/)([a-z0-9]{8,16})/i) || u.match(/vidmol[yi]\.[a-z]+\/([a-z0-9]{8,16})(?:\.html)?(?:[/?#]|$)/i) || [])[1];
const candidates = e => { const l = [e], id = idOf(e); if (id && /uqload/i.test(e)) UQ_DOMAINS.forEach(d => { const u = `https://${d}/embed-${id}.html`; if (!l.includes(u)) l.push(u); }); if (id && /vidmol[yi]|moly|ansembed/i.test(e)) DOMAINS.forEach(d => { const u = `https://${d}/embed-${id}.html`; if (!l.includes(u)) l.push(u); }); return l; };
function unpackOnce(html) {   // décompresse le JS « p,a,c,k,e,d » (guillemets simples ou doubles)
  const out = [], re = /\}\((['"])((?:\\.|(?!\1)[^\\])*)\1\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(['"])((?:\\.|(?!\5)[^\\])*)\5\.split\((['"])\|\7\)/g; let m;
  while ((m = re.exec(html))) {
    let p = m[2], a = +m[3], c = +m[4]; const k = m[6].split('|');
    const base = n => (n < a ? '' : base(parseInt(n / a))) + ((n = n % a) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
    const d = {}; while (c--) d[base(c)] = k[c] || base(c);
    out.push(p.replace(/\b\w+\b/g, w => d[w] || w).replace(/\\(['"\\])/g, '$1'));
  }
  return out.join('\n');
}
function unpack(html) { let cur = html; const all = []; for (let i = 0; i < 3; i++) { const u = unpackOnce(cur); if (!u) break; all.push(u); cur = u; } return all.join('\n'); }
function find(text, id, base) {
  if (!text) return null;
  text = text.replace(/\\u002[Ff]/g, '/').replace(/\\x2[Ff]/g, '/');   // « https:\u002F\u002Fhôte\u002F… » → « https://hôte/… »
  const clean = u => u.replace(/\\u002[Ff]/g, '/').replace(/\\x2[Ff]/g, '/').replace(/\\\//g, '/').replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
  const abs = u => { if (/^https?:\/\//i.test(u)) return u; if (!base) return null; try { return new URL(u, base).href; } catch { return null; } };
  const collect = (pats) => { const out = []; for (const re of pats) { let m; while ((m = re.exec(text))) { const u = abs(clean(m[1])); if (u && /^https?:\/\//.test(u) && !isDecoy(u)) out.push(u); } } return [...new Set(out)]; };
  const score = u => (id && u.includes(id) ? 100 : 0) + (/master\.m3u8/i.test(u) ? 20 : 0) + (/urlset/i.test(u) ? 10 : 0) + (/[?&]t=/.test(u) ? 5 : 0) + (/[?&]e=\d+/.test(u) ? 3 : 0);
  const best = l => l.map((u, i) => ({ u, i, s: score(u) })).sort((x, y) => y.s - x.s || x.i - y.i)[0]?.u || null;
  const hls = collect([
    /(?:file|src|source|hls\d*|stream|url|video)["']?\s*[:=]\s*["'](https?:\\?\/\\?\/[^"']+?\.m3u8[^"']*)["']/gi,
    /["']hls\d*["']\s*:\s*["']([^"']+)["']/gi,
    /<source[^>]+src=["']([^"']+\.m3u8[^"']*)["']/gi,
    /(https?:\\?\/\\?\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*)/gi,
    /["'`]((?:\\?\/){1,2}[^"'`\s<>]+\.m3u8[^"'`\s<>]*)["'`]/gi          // liens relatifs : "/stream/x/master.m3u8", "//cdn.site/x.m3u8"
  ]);
  if (hls.length) return best(hls);
  const mp4 = collect([                                   // hébergeurs en MP4 (ex. Uqload) : à défaut de M3U8
    /(?:file|src|source|video)["']?\s*[:=]\s*["'](https?:\\?\/\\?\/[^"']+?\.mp4[^"']*)["']/gi,
    /sources?\s*[:=]\s*\[\s*["'](https?:[^"']+\.mp4[^"']*)["']/gi,
    /<source[^>]+src=["']([^"']+\.mp4[^"']*)["']/gi,
    /(https?:\\?\/\\?\/[^\s"'<>\\]+\.mp4[^\s"'<>\\]*)/gi,
    /["'`]((?:\\?\/){1,2}[^"'`\s<>]+\.mp4[^"'`\s<>]*)["'`]/gi
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
const scan = (t, id, base) => find(t, id, base) || find(unpack(t), id, base) || find(decoded(t), id, base);
// Redirections « côté page » : <meta refresh>, window.location = "...", location.replace("..."), iframes, lien « cliquez ici »
const hops = (text, base) => {
  const out = [], add = u => { try { const a = new URL(String(u).replace(/&amp;/g, '&').replace(/\\\//g, '/'), base).href; if (/^https?:/i.test(a)) out.push(a); } catch {} };
  for (const m of text.matchAll(/<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["'][^"']*?url\s*=\s*([^"'>\s]+)/gi)) add(m[1]);
  for (const m of text.matchAll(/(?:window\.|document\.|top\.|self\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
  for (const m of text.matchAll(/location\.(?:replace|assign)\(\s*["']([^"']+)["']/gi)) add(m[1]);
  for (const m of text.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)) add(m[1]);
  if (text.length < 2500) for (const m of text.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)) add(m[1]);
  return [...new Set(out)];
};
async function crawl(url, viaProxy, bustCache, depth, seen, notes, id) {
  if (depth > 4 || seen.has(url) || seen.size > 16) return null;
  seen.add(url);
  const tag = `${'· '.repeat(depth)}${new URL(url).host}${viaProxy ? ' (proxy)' : ' (direct)'}${bustCache ? '+bust' : ''}`;
  let r; try { r = await get(url, null, viaProxy, bustCache); } catch (e) { notes.push(`${tag} → ${e.message}`); return null; }
  const next = hops(r.text, r.url);
  const title = (r.text.match(/<title>([^<]{0,60})/i) || [])[1] || '';
  notes.push(`${tag} → HTTP ${r.status}, ${r.text.length} o${title ? ', « ' + title.trim() + ' »' : ''}${/\/(taunt|promo)\//i.test(r.text) ? ', LEURRE PROMO' : ''}${r.text.length < 1200 ? ', corps=« ' + r.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) + ' »' : ''}${next.length ? ', redirige vers ' + next.slice(0, 2).map(x => new URL(x).host + new URL(x).pathname.slice(0, 30)).join(' | ') : ''}`);
  if (r.status >= 400) return null;
  const m = scan(r.text, id, r.url); if (m) return m;
  if (r.text.length >= 1200) {   // page « normale » sans lien : on décrit ce qu'elle contient pour savoir quoi lire ensuite
    const T = r.text, cnt = re => (T.match(re) || []).length;
    const apis = [...new Set([...T.matchAll(/["'`]((?:https?:)?\/\/[^"'`\s]{0,80}|\/[a-z0-9_\-\/]{0,40}(?:api|ajax|source|sources|playback|stream|player|dl|get)[a-z0-9_\-\/\.]{0,40})["'`]/gi)].map(x => x[1]).filter(x => !/\.(js|css|png|jpg|svg|ico|woff2?)(\?|$)/i.test(x)))].slice(0, 5);
    notes.push(`  ↳ analyse : packed=${/eval\(function\(p,a,c,k,e/.test(T) ? 'oui' : 'non'} m3u8=${cnt(/m3u8/gi)} mp4=${cnt(/\.mp4/gi)} atob=${cnt(/atob\(/g)} jwplayer=${cnt(/jwplayer/gi)} sources=${cnt(/sources/gi)} iframe=${cnt(/<iframe/gi)} fetch/ajax=${cnt(/fetch\(|\$\.(?:ajax|get|post)|XMLHttpRequest/g)} urls=[${apis.join(' ; ').slice(0, 260)}]`);
  }
  for (const n of next.slice(0, 4)) { const f = await crawl(n, viaProxy, bustCache, depth + 1, seen, notes, id); if (f) return f; }
  return null;
}
async function extract(embed) {
  const notes = [], id = idOf(embed);
  for (const page of candidates(embed)) {
    for (const [viaProxy, bustCache] of [[true, false], [false, false], [true, true]]) {   // proxy, direct, puis proxy + anti-cache
      const m = await crawl(page, viaProxy, bustCache, 0, new Set(), notes, id);
      if (m) return m;
    }
  }
  throw new Error('aucun lien vidéo trouvé | ' + notes.join(' | ').slice(0, 2500));
}

const MODE = process.env.MODE === 'browser' ? 'browser' : 'static';

// ───────── Navigateur sans écran (Playwright) : exécute le JavaScript de la page et relève l'adresse vidéo qui passe sur le réseau ─────────
const AD = /(doubleclick|googlesyndication|adservice|google-analytics|googletagmanager|\/ads?\/|preroll|\bvast\b|adsterra|popads)/i;
async function extractBrowser(embed) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const found = [], id = idOf(embed);
  try {
    const ctx = await browser.newContext({ userAgent: UA['User-Agent'], viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    ctx.on('page', p => { if (p !== page) p.close().catch(() => {}); });   // fenêtres publicitaires : fermées
    const note = u => { if (/\.(m3u8|mp4)(\?|#|$)/i.test(u) && !isDecoy(u) && !AD.test(u) && !found.includes(u)) { found.push(u); console.log('réseau →', u.slice(0, 140)); } };
    page.on('request', r => note(r.url()));
    page.on('response', async r => {
      try {
        note(r.url());
        const ct = r.headers()['content-type'] || '';
        if (/mpegurl/i.test(ct)) note(r.url());
        else if (/json|javascript|text\/plain/i.test(ct)) { const t = await r.text(); if (t && t.length < 600000) { const m = find(t, id, r.url()); if (m) note(m); } }   // API qui renvoie le lien
      } catch {}
    });
    await page.goto(embed, { referer: SITE + '/', waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => console.log('goto :', e.message));
    const t0 = Date.now(); let doneAt = 0;
    while (Date.now() - t0 < 30000) {
      await page.waitForTimeout(1000);
      if (found.some(u => /\.m3u8/i.test(u))) { doneAt = doneAt || Date.now(); if (Date.now() - doneAt > 1500) break; }
      if ((Date.now() - t0) % 4000 < 1000) {   // « lecture » : clic au centre et sur les boutons de lecture usuels
        try { await page.mouse.click(640, 360); } catch {}
        for (const fr of page.frames()) for (const sel of ['.jw-icon-display', '.vjs-big-play-button', '.plyr__control--overlaid', '.play-button', 'video', '#player']) { try { await fr.click(sel, { timeout: 300 }); } catch {} }
      }
    }
    const info = `page finale ${page.url().slice(0, 100)}, titre « ${(await page.title().catch(() => '')).slice(0, 60)} »`;
    const hls = found.filter(u => /\.m3u8/i.test(u)), pool = hls.length ? hls : found;
    const score = u => (id && u.includes(id) ? 100 : 0) + (/master\.m3u8/i.test(u) ? 20 : 0) + (/urlset/i.test(u) ? 10 : 0) + (/[?&]t=/.test(u) ? 5 : 0);
    const best = pool.map((u, i) => ({ u, i, s: score(u) })).sort((x, y) => y.s - x.s || x.i - y.i)[0]?.u;
    if (!best) throw new Error(`navigateur : aucun lien vidéo détecté (${info})`);
    return best;
  } finally { await browser.close().catch(() => {}); }
}

// On « prend » la demande (évite un double traitement avec l'ancienne page d'extraction) — seulement à la 1re étape
if (MODE === 'static') {
  const claimed = await db.runTransaction(async tx => {
    const s = await tx.get(ref); if (!s.exists || s.data().status !== 'pending') return false;
    tx.update(ref, { status: 'running', startedAt: Date.now(), by: 'github' }); return true;
  });
  if (!claimed) { console.log('demande déjà prise en charge'); process.exit(0); }
}

try {
  let m3u8;
  if (MODE === 'browser') {
    try { m3u8 = await extractBrowser(P.embed); }
    catch (e) { const prev = ((await ref.get()).data() || {}).staticError || ''; throw new Error(String(e.message || e) + (prev ? ' || méthode simple : ' + prev : '')); }
  } else {
    try { m3u8 = await extract(P.embed); }
    catch (e) {   // méthode simple impossible : on passe la main au navigateur sans écran (étape suivante du workflow)
      console.log('Méthode simple KO → navigateur sans écran :', String(e.message || e).slice(0, 400));
      await ref.update({ status: 'running', note: 'navigateur sans écran…', staticError: String(e.message || e).slice(0, 1500) });
      if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'needs_browser=true\n');
      process.exit(0);
    }
  }
  if (isDecoy(m3u8)) throw new Error('lien promo refusé : ' + m3u8);
  // Enregistrement dans le catalogue (animes/<id>) — en transaction : on relit le document au dernier moment pour ne pas écraser une modification faite entre-temps
  const aRef = db.collection('animes').doc(P.animeId), extractedAt = new Date().toISOString();
  const where = P.film ? `animes/${P.animeId} → cachedFilmM3u8.${P.dst}` : `animes/${P.animeId} → seasons[${P.season}].episodes[${P.ei}].cachedM3u8.${P.dst}`;
  await db.runTransaction(async tx => {
    const snap = await tx.get(aRef);
    if (!snap.exists) throw new Error(`document animes/${P.animeId} introuvable : catalogue non mis à jour`);
    const a = snap.data() || {};
    if (P.film) {
      tx.update(aRef, { cachedFilmM3u8: { ...(a.cachedFilmM3u8 || {}), [P.dst]: m3u8, extractedAt } });
    } else {
      const seasons = a.seasons || [], ep = ((seasons[P.season] || {}).episodes || [])[P.ei];
      if (!ep) throw new Error(`épisode introuvable (${where}) : catalogue non mis à jour`);
      ep.cachedM3u8 = { ...(ep.cachedM3u8 || {}), [P.dst]: m3u8, extractedAt };
      tx.update(aRef, { seasons });
    }
  });
  // Vérification : on relit et on contrôle que le nouveau lien est bien dans le catalogue
  const back = (await aRef.get()).data() || {};
  const saved = P.film ? (back.cachedFilmM3u8 || {})[P.dst] : ((((back.seasons || [])[P.season] || {}).episodes || [])[P.ei] || {}).cachedM3u8?.[P.dst];
  if (saved !== m3u8) throw new Error('écriture non retrouvée dans le catalogue : ' + where);
  console.log('CATALOGUE MIS À JOUR :', where, '=', m3u8.slice(0, 90));
  await ref.update({ status: 'done', m3u8, wrote: where, finishedAt: Date.now() });
  console.log('OK', m3u8.slice(0, 80));
} catch (e) {
  await ref.update({ status: 'error', error: String(e.message || e), finishedAt: Date.now() });
  console.error(e); process.exit(1);
}
