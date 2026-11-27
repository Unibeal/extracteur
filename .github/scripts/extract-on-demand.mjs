// Extraction à la demande — MÊME LOGIQUE que extracteur-complet.html :
//   1) méthode statique : lecture de la page (proxy Cloudflare, direct, puis proxys publics) + décompression du JS « packé »
//   2) sinon : navigateur headless = workflow GitHub « extract.yml » (inputs url + rid) → lecture de results/<rid>.txt
//   3) choix du bon flux (jamais un leurre), contrôle « faux lien », enregistrement dans le catalogue (cachedM3u8 / cachedFilmM3u8)
import admin from 'firebase-admin';
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const P = JSON.parse(process.env.PAYLOAD);
const ref = db.collection('extract_requests').doc(P.reqId);

const env = (k, d) => (process.env[k] || '').trim() || d;
const REPO = env('GITHUB_REPOSITORY', 'Unibeal/extracteur');
const GH_TOKEN = env('GH_TOKEN', '');
const GH = {   // mêmes réglages par défaut que la page extracteur-complet.html
  wf: env('GH_WF', 'extract.yml'), ref: env('GH_REF', 'main'), dir: env('GH_DIR', 'results'),
  inUrl: env('GH_IN_URL', 'url'), inRid: env('GH_IN_RID', 'rid'),
  tpl: env('GH_TPL', 'https://hlsproxy.faroukmigan.workers.dev/?url={url}')
};
const POLL_MS = +env('GH_POLL_MS', '7000'), HEADLESS_MAX_MS = 6 * 60 * 1000;
const SITE = env('SITE_ORIGIN', 'https://marxist-beige-tlqaymgn.edgeone.dev').replace(/\/+$/, '');
// Âge du lien d'après la date de son token (s / start / ts… = époque Unix) — information, jamais bloquant
function linkAge(u) { try { const q = new URL(u).searchParams; for (const k of ['s', 'st', 'start', 'ts', 'time', 'issued']) { const v = +q.get(k); const sec = v > 1e12 ? v / 1000 : v; if (sec > 1e9) return Math.round(Date.now() / 1000 - sec); } } catch {} return null; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// ───────────── Page : proxys (même ordre que l'extracteur) ─────────────
const proxies = () => [
  u => GH.tpl.replace('{url}', encodeURIComponent(u)) + (GH.tpl.includes('?') ? '&' : '?') + '_cb=' + Date.now() + Math.floor(Math.random() * 1e6),   // anti-cache du proxy
  u => u,
  u => 'https://corsproxy.io/?' + encodeURIComponent(u),
  u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
  u => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u)
];
async function fetchHtml(url) {
  let last = '';
  for (const wrap of proxies()) {
    try {
      const r = await fetch(wrap(url), { headers: { Origin: SITE, Referer: SITE + '/', 'Cache-Control': 'no-cache', Pragma: 'no-cache' }, cache: 'no-store', redirect: 'follow', signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const t = await r.text();
      if (t && t.length > 200) return t;
    } catch (e) { last = e.message; }
  }
  throw new Error('Page inaccessible (' + last + ')');
}

// JS packé (Dean Edwards) : eval(function(p,a,c,k,e,d){...}('...',a,c,'...'.split('|')))
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
// Empreinte d'un flux = dossier du m3u8 : sert à repérer les faux liens (leurres) renvoyés à plusieurs embeds
function streamKey(u) { try { return new URL(u).pathname.replace(/\/[^\/]*$/, ''); } catch (e) { return u; } }
// Leurres : UNIQUEMENT les flux promo de l'hébergeur (ex. strm2.uqload.vc/taunt/promo/master.m3u8 et …/index.m3u8) + vidéo de démo. Tout le reste est lu.
const isDecoy = u => /\/(taunt|promo)\//i.test(u) || /test-videos\.co\.uk|big_?buck_?bunny/i.test(u);
function embedVideoId(embed) { const m = (embed || '').match(/(?:embed-|\/embed\/|\/e\/|\/w\/|\/v\/)([a-z0-9]{8,16})/i); return m ? m[1] : null; }
// Choisit le BON flux : jamais un leurre ; priorité à celui qui contient l'id de la vidéo, puis master.m3u8 / urlset
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
  for (const re of pats) { let m; while ((m = re.exec(text))) { if (m[1]) all.push(m[1].replace(/\\/g, '').replace(/&amp;/g, '&')); } }
  const best = pickBest(all, id);
  if (best) return best;
  // Repli large (repris de l'extracteur « Ansembed natif ») : toute adresse qui contient « m3u8 », même sans le point devant
  const wide = (text.match(/https?:\/\/[^\s"'<>]+?m3u8[^\s"'<>]*/gi) || []).map(u => u.replace(/\\/g, '').replace(/&amp;/g, '&'));
  return pickBest(wide, id);
}
const VM_RE = /vidmol[yi]|moly|ansembed/i;   // ansembed.net = miroir de VidMoly : même identifiant essayé sur les vrais domaines vidmoly
const VM_DOMAINS = ['vidmoly.net', 'vidmoly.to', 'vidmoly.biz', 'vidmoly.me'];
function vidmolyId(u) {
  const m = u.match(/(?:embed-|\/embed\/|\/w\/|\/v\/)([a-z0-9]{8,16})/i) || u.match(/vidmol[yi]\.[a-z]+\/([a-z0-9]{8,16})(?:\.html)?(?:[/?#]|$)/i);
  return m ? m[1] : null;
}
function candidates(embed) {
  const list = [embed];
  if (VM_RE.test(embed)) {
    const id = vidmolyId(embed);
    if (id) VM_DOMAINS.forEach(d => { const u = `https://${d}/embed-${id}.html`; if (!list.includes(u)) list.push(u); });
  }
  return list;
}

// ───────────── Navigateur headless : workflow « extract.yml » puis lecture de results/<rid>.txt ─────────────
const ghApi = (path, opt = {}) => fetch('https://api.github.com/repos/' + REPO + path, {
  ...opt,
  headers: { Accept: 'application/vnd.github.raw+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: 'Bearer ' + GH_TOKEN, 'User-Agent': 'sc-extract', ...(opt.headers || {}) }
});

// Pourquoi le run a échoué ? étape en erreur + dernières lignes de son journal
async function failureDetails(runId) {
  try {
    const jr = await ghApi('/actions/runs/' + runId + '/jobs?per_page=10');
    if (!jr.ok) return 'détails indisponibles (HTTP ' + jr.status + ')';
    const jobs = (await jr.json()).jobs || [];
    const job = jobs.find(j => j.conclusion === 'failure') || jobs[0];
    if (!job) return 'aucun job';
    const step = (job.steps || []).find(x => x.conclusion === 'failure');
    let tail = '';
    try {
      const lr = await ghApi('/actions/jobs/' + job.id + '/logs', { redirect: 'follow' });
      if (lr.ok) {
        const lines = (await lr.text()).split('\n').map(l => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, '').trim())
          .filter(l => l && !/^##\[(group|endgroup|warning)\]/.test(l) && !/^Warning: Node\.js \d+ is deprecated/i.test(l));
        const ei = lines.map(l => l.startsWith('##[error]')).lastIndexOf(true);   // dernière erreur marquée par GitHub
        const slice = ei >= 0 ? lines.slice(Math.max(0, ei - 12), ei + 1) : lines.slice(-14);
        tail = slice.join(' ⏎ ').replace(/##\[error\]/g, '✖ ').slice(-1100);
      }
    } catch (e) { tail = '(journal illisible : ' + e.message + ')'; }
    return `étape en échec : « ${step ? step.name : '?'} » | fin du journal : ${tail || 'indisponible'}`;
  } catch (e) { return 'détails indisponibles : ' + e.message; }
}
async function githubExtract(embed, prev) {
  if (!GH_TOKEN) throw new Error('GH_TOKEN absent dans le workflow (permissions: actions: write)');
  const rid = [...Array(8)].map(() => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('');
  const r = await ghApi('/actions/workflows/' + encodeURIComponent(GH.wf) + '/dispatches', {
    method: 'POST', body: JSON.stringify({ ref: GH.ref, inputs: { [GH.inUrl]: embed, [GH.inRid]: rid } })
  });
  if (!r.ok) throw new Error('GitHub dispatch HTTP ' + r.status + ' ' + (await r.text()).slice(0, 120) + ' (workflow ' + GH.wf + ', ref ' + GH.ref + ', inputs ' + GH.inUrl + '/' + GH.inRid + ')');
  log('headless lancé, rid=' + rid);
  const path = '/contents/' + GH.dir + '/' + rid + '.txt?ref=' + encodeURIComponent(GH.ref);
  const t0 = Date.now(); let runInfo = null, finishedAt = 0, lastLog = 0, apiErr = '';
  while (Date.now() - t0 < HEADLESS_MAX_MS) {
    await sleep(POLL_MS);
    // 1) le fichier de résultat est-il publié ?
    try {
      const res = await ghApi(path + '&_=' + Date.now(), { cache: 'no-store' });
      if (res.ok) {
        const txt = (await res.text()).trim();
        if (txt.startsWith('ERROR')) throw new Error(txt.slice(0, 160));
        if (!/^https?:\/\//i.test(txt)) throw new Error('Résultat inattendu : ' + txt.slice(0, 80));
        const urls = txt.split(/\s+/).filter(x => /^https?:\/\//i.test(x));
        const fresh = urls.filter(u => u !== prev);
        if (urls.length && !fresh.length) throw new Error('LIEN IDENTIQUE À L\'ANCIEN : le navigateur a renvoyé le même lien que celui déjà enregistré (pas de nouvelle extraction)');
        const best = pickBest(fresh, embedVideoId(embed));
        if (!best) throw new Error('FAUX LIEN : seul un flux promo/leurre a été capturé (' + (urls[0] || '').slice(0, 70) + ')');
        return best;
      }
      if (res.status !== 404) apiErr = 'lecture du résultat : HTTP ' + res.status;
    } catch (e) { if (/^(ERROR|FAUX|Résultat)/.test(e.message)) throw e; apiErr = e.message; }
    // 2) que devient le run extract.yml ? (échec → on le dit tout de suite au lieu d'attendre 6 min)
    try {
      const rr = await ghApi('/actions/workflows/' + encodeURIComponent(GH.wf) + '/runs?event=workflow_dispatch&per_page=15&_=' + Date.now(), { cache: 'no-store' });
      if (rr.ok) {
        const runs = (await rr.json()).workflow_runs || [];
        runInfo = runs.find(r => (r.display_title || '').includes(rid) || (r.name || '').includes(rid)) || runInfo;
      }
    } catch (e) { apiErr = e.message; }
    if (runInfo && runInfo.status === 'completed') {
      finishedAt = finishedAt || Date.now();
      if (runInfo.conclusion !== 'success') throw new Error(`le run ${GH.wf} a échoué (${runInfo.conclusion}) — voir ${runInfo.html_url} || ${await failureDetails(runInfo.id)}`);
      if (Date.now() - finishedAt > 90000) throw new Error(`le run ${GH.wf} est terminé mais ${GH.dir}/${rid}.txt est introuvable sur ${GH.ref} (étape « Publier » ?) — ${runInfo.html_url}`);
    }
    if (Date.now() - lastLog > 30000) { lastLog = Date.now(); log(`attente… ${Math.round((Date.now() - t0) / 1000)}s run=${runInfo ? runInfo.status + '/' + (runInfo.conclusion || '-') : 'introuvable'}${apiErr ? ' | ' + apiErr : ''}`); }
  }
  throw new Error(`GitHub : délai dépassé (6 min) — run ${GH.wf} : ${runInfo ? runInfo.status + ' ' + (runInfo.html_url || '') : 'introuvable (le workflow ' + GH.wf + ' est-il bien lancé ?)'}${apiErr ? ' | ' + apiErr : ''}`);
}
// ───────────── Méthode statique = celle du player (extractVidmolyLive) ─────────────
// Pour chaque page candidate : TOUTES les façons de la lire sont lancées en parallèle (proxy, direct, proxys publics).
// Une façon « réussit » seulement si elle trouve un vrai M3U8 : une page sans lien (ou le même lien qu'avant) n'arrête pas les autres.
const UQ_RE = /uqload/i;   // Uqload : on passe uniquement par votre proxy (token lié à l'IP, comme dans le player)
const wrappersFor = page => UQ_RE.test(page || '') ? [proxies()[0]] : proxies();
const wrapName = i => ['proxy', 'direct', 'corsproxy', 'allorigins', 'codetabs'][i] || '?';
async function tryWrapped(page, wrap, id, prev, name) {
  let r; try { r = await fetch(wrap(page), { headers: { Origin: SITE, Referer: SITE + '/' }, redirect: 'follow', signal: AbortSignal.timeout(15000) }); }
  catch (e) { throw new Error(name + ': ' + (e.name === 'TimeoutError' ? 'délai 15 s' : e.message)); }
  if (!r.ok) throw new Error(name + ': HTTP ' + r.status);
  const t = await r.text();
  const m = findM3u8(t, id) || findM3u8(unpackAll(t), id);
  if (!m) throw new Error(name + ': aucun m3u8 (' + t.length + ' o' + (/taunt\/promo/i.test(t) ? ', promo seulement' : '') + ')');
  if (prev && m === prev) throw new Error(name + ': lien identique à l\'ancien');
  return m;
}
async function extractStatic(embed, prev) {
  const id = embedVideoId(embed), notes = [];
  for (const page of candidates(embed)) {
    const ws = wrappersFor(page);
    try {
      const m3u8 = await Promise.any(ws.map((w, i) => tryWrapped(page, w, id, prev, wrapName(i))));
      return { m3u8, page };
    } catch (e) { notes.push(new URL(page).hostname + ' → ' + (e.errors || [e]).map(x => x.message).join(' ; ')); }
  }
  throw new Error('Aucun lien M3U8 | ' + notes.join(' | ').slice(0, 1400));
}
async function extractM3u8(embed, prev) {
  let lastErr = 'Aucun lien M3U8 trouvé';
  try { return await extractStatic(embed, prev); } catch (e) { lastErr = e.message; log('statique KO :', lastErr); }
  await ref.update({ note: 'navigateur headless (extract.yml)…' });
  try { return { m3u8: await githubExtract(embed, prev), page: embed }; }
  catch (e) { throw new Error(e.message + ' | statique : ' + lastErr); }
}

// ───────────── Demande : on la « prend » (évite un double traitement) ─────────────
const claimed = await db.runTransaction(async tx => {
  const s = await tx.get(ref); if (!s.exists || s.data().status !== 'pending') return false;
  tx.update(ref, { status: 'running', startedAt: Date.now(), by: 'github' }); return true;
});
if (!claimed) { log('demande déjà prise en charge'); process.exit(0); }

try {
  const aRef = db.collection('animes').doc(P.animeId), extractedAt = new Date().toISOString();
  const a0 = (await aRef.get()).data() || {};
  const prev = (P.film ? (a0.cachedFilmM3u8 || {})[P.dst] : ((((a0.seasons || [])[P.season] || {}).episodes || [])[P.ei] || {}).cachedM3u8?.[P.dst]) || '';
  log('ancien lien :', prev ? prev.slice(0, 90) + ' (âge ' + (linkAge(prev) ?? '?') + ' s)' : '(aucun)');
  const { m3u8 } = await extractM3u8(P.embed, prev);
  const age = linkAge(m3u8);
  log('nouveau lien :', m3u8.slice(0, 90) + ' (âge ' + (age ?? '?') + ' s)');
  if (isDecoy(m3u8)) throw new Error('lien promo/leurre refusé : ' + m3u8);

  // Catalogue (animes/<id>) — en transaction, même format que l'extracteur complet
  const where = P.film ? `animes/${P.animeId} → cachedFilmM3u8.${P.dst}` : `animes/${P.animeId} → seasons[${P.season}].episodes[${P.ei}].cachedM3u8.${P.dst}`;
  await db.runTransaction(async tx => {
    const snap = await tx.get(aRef);
    if (!snap.exists) throw new Error(`document animes/${P.animeId} introuvable : catalogue non mis à jour`);
    const a = snap.data() || {};
    // Contrôle « faux lien » : même flux déjà utilisé par un AUTRE épisode de ce titre = leurre de l'hébergeur
    const k = streamKey(m3u8), others = [];
    if (P.film) { const c = a.cachedFilmM3u8 || {}; for (const d of Object.keys(c)) if (d !== P.dst && d !== 'extractedAt') others.push({ link: c[d], same: false }); }
    else (a.seasons || []).forEach((s, si) => (s.episodes || []).forEach((e, ei) => { if (si === P.season && ei === P.ei) return; const c = e.cachedM3u8 || {}; for (const d of Object.keys(c)) if (d !== 'extractedAt') others.push({ link: c[d] }); }));
    if (!P.film && others.some(o => typeof o.link === 'string' && o.link && streamKey(o.link) === k)) throw new Error('FAUX LIEN : ce flux (' + k.split('/').pop() + ") est déjà celui d'un autre épisode — leurre renvoyé par l'hébergeur, non enregistré");
    if (P.film) {
      tx.update(aRef, { cachedFilmM3u8: { ...(a.cachedFilmM3u8 || {}), [P.dst]: m3u8, extractedAt } });
    } else {
      const seasons = JSON.parse(JSON.stringify(a.seasons || [])), ep = ((seasons[P.season] || {}).episodes || [])[P.ei];
      if (!ep) throw new Error(`épisode introuvable (${where}) : catalogue non mis à jour`);
      ep.cachedM3u8 = { ...(ep.cachedM3u8 || {}), [P.dst]: m3u8, extractedAt };
      tx.update(aRef, { seasons });
    }
  });
  const back = (await aRef.get()).data() || {};
  const saved = P.film ? (back.cachedFilmM3u8 || {})[P.dst] : ((((back.seasons || [])[P.season] || {}).episodes || [])[P.ei] || {}).cachedM3u8?.[P.dst];
  if (saved !== m3u8) throw new Error('écriture non retrouvée dans le catalogue : ' + where);
  log('CATALOGUE MIS À JOUR :', where, '=', m3u8.slice(0, 90));
  await ref.update({ status: 'done', m3u8, prev, ageSec: age ?? null, wrote: where, finishedAt: Date.now() });
} catch (e) {
  await ref.update({ status: 'error', error: String(e.message || e).slice(0, 1500), finishedAt: Date.now() });
  console.error(e); process.exit(1);
}
