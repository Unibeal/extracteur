// Navigateur headless : ouvre l'embed, laisse le JavaScript s'exécuter et relève les flux vidéo qui passent sur le réseau.
// Entrées (variables d'environnement) : URL_IN = lien embed, RID = identifiant de la demande, SITE_ORIGIN = adresse de votre site (facultatif)
// Sortie : results/<RID>.txt  →  une adresse par ligne, ou « ERROR … » si rien n'est trouvé
const fs = require('fs');
const { chromium } = require('playwright');

const URL_IN = (process.env.URL_IN || '').trim();
const RID = (process.env.RID || '').trim().replace(/[^a-z0-9_\-]/gi, '');
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
  if (!URL_IN || !RID) { console.error('URL_IN et RID obligatoires'); process.exit(1); }
  const found = [];
  let browser;
  try {
    browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
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
