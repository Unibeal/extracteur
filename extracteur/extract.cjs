// Navigateur headless : ouvre l'embed, laisse le JavaScript s'exécuter et relève les flux vidéo qui passent sur le réseau.
// Entrées (variables d'environnement) : URL_IN = lien embed, RID = identifiant de la demande, SITE_ORIGIN = adresse de votre site (facultatif)
// Sortie : results/<RID>.txt  →  une adresse par ligne, ou « ERROR … » si rien n'est trouvé
const fs = require('fs');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { /* géré plus bas : on écrit « ERROR » dans le résultat */ var PW_ERR = e; }

// Entrées : variables d'environnement, arguments, OU directement le fichier d'événement GitHub (inputs.url / inputs.rid)
// → fonctionne quel que soit le câblage de extract.yml
function readInputs() {
  const E = process.env, first = (...k) => k.map(n => (E[n] || '').trim()).find(Boolean) || '';
  let url = first('URL_IN', 'EXTRACT_URL', 'TARGET_URL', 'INPUT_URL', 'EMBED_URL', 'URL') || (process.argv[2] || '').trim();
  let rid = first('RID', 'INPUT_RID', 'REQUEST_ID', 'REQ_ID') || (process.argv[3] || '').trim();
  try {
    const ev = JSON.parse(fs.readFileSync(E.GITHUB_EVENT_PATH, 'utf8')), i = ev.inputs || {};
    url = url || String(i.url || i.URL || i.embed || '').trim();
    rid = rid || String(i.rid || i.RID || i.id || '').trim();
  } catch (e) { /* pas lancé par GitHub : on garde ce qu'on a */ }
  return { url, rid: rid.replace(/[^a-z0-9_\-]/gi, '') };
}
const { url: URL_IN, rid: RID } = readInputs();
const SITE = (process.env.SITE_ORIGIN || 'https://marxist-beige-tlqaymgn.edgeone.dev').trim().replace(/\/+$/, '');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const AD = /(doubleclick|googlesyndication|adservice|google-analytics|googletagmanager|\/ads?\/|preroll|\bvast\b|popads|adsterra)/i;
const DECOY = /\/(promo|taunt|trailer)\//i;

function out(text) {
  fs.mkdirSync('results', { recursive: true });
  fs.writeFileSync(`results/${RID}.txt`, text.trim() + '\n');
  console.log('écrit results/' + RID + '.txt :', text.trim().slice(0, 300));
}

(async () => {
  if (!URL_IN || !RID) { console.error('Entrées manquantes — url:', URL_IN || '(vide)', 'rid:', RID || '(vide)', '— variables vues:', Object.keys(process.env).filter(k => /url|rid|input|extract|target/i.test(k)).join(',')); process.exit(1); }
  if (!chromium) { out('ERROR module playwright introuvable : ' + String(PW_ERR && PW_ERR.message).slice(0, 150)); return; }
  const found = [];
  let browser;
  try {
    const ARGS = { args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] };
    try { browser = await chromium.launch({ ...ARGS, channel: 'chrome' }); console.log('navigateur : Google Chrome du runner'); }   // déjà installé sur ubuntu-latest : rien à télécharger
    catch (e) { console.log('Chrome indisponible (' + String(e.message).split('\n')[0].slice(0, 80) + ') → Chromium de Playwright'); browser = await chromium.launch(ARGS); }
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    ctx.on('page', p => { if (p !== page) p.close().catch(() => {}); });   // fenêtres publicitaires : fermées

    const note = u => {
      if (/\.(m3u8)(\?|#|$)/i.test(u) && !AD.test(u) && !found.includes(u)) { found.push(u); console.log('flux →', u.slice(0, 160)); }
    };
    page.on('request', r => note(r.url()));
    page.on('response', async r => {
      try {
        note(r.url());
        const ct = r.headers()['content-type'] || '';
        if (/mpegurl/i.test(ct)) note(r.url());
        else if (/json|javascript|text\/plain/i.test(ct)) {   // API qui renvoie le lien dans sa réponse
          const t = await r.text();
          if (t && t.length < 600000) for (const m of t.replace(/\\u002[Ff]/g, '/').replace(/\\\//g, '/').matchAll(/https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*/gi)) note(m[0]);
        }
      } catch (e) { /* réponse illisible : on ignore */ }
    });

    await page.goto(URL_IN, { referer: SITE + '/', waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => console.log('goto :', e.message));

    const t0 = Date.now(); let firstGood = 0, tick = 0;
    while (Date.now() - t0 < 35000) {
      await page.waitForTimeout(1000);
      if (found.some(u => !DECOY.test(u))) { firstGood = firstGood || Date.now(); if (Date.now() - firstGood > 2000) break; }
      if (++tick % 4 === 0) {   // simule un clic sur « lecture »
        try { await page.mouse.click(640, 360); } catch (e) {}
        for (const fr of page.frames()) for (const sel of ['.jw-icon-display', '.vjs-big-play-button', '.plyr__control--overlaid', '.play-button', 'video', '#player']) { try { await fr.click(sel, { timeout: 300 }); } catch (e) {} }
      }
    }
    const info = `page finale ${page.url().slice(0, 100)} — titre « ${(await page.title().catch(() => '')).slice(0, 60)} »`;
    if (!found.length) { out('ERROR aucun flux m3u8 capturé (' + info + ')'); return; }
    // bons flux d'abord, leurres à la fin (le consommateur écarte de toute façon les leurres)
    const good = found.filter(u => !DECOY.test(u)), bad = found.filter(u => DECOY.test(u));
    out([...good, ...bad].join('\n'));
  } catch (e) {
    out('ERROR ' + String(e.message || e).slice(0, 200));
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
})();
