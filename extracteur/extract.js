// Usage : node extract.js "<url de la page embed>"
// Ecrit result.txt : soit l'URL .m3u8, soit "ERROR: <raison>"
const { chromium } = require('playwright-core');
const fs = require('fs');

const target = process.argv[2];
const M3U8_RE = /https?:\/\/[^\s"'<>\\]+?\.m3u8[^\s"'<>\\]*/gi;
const IS_M3U8 = /\.m3u8(\?|#|$)/i;
const DECOY = /\/troll\//i; // flux leurre servi aux bots par certains hebergeurs
const CLICK_SELECTORS = [
  'video', '.jw-icon-display', '.jw-display-icon-container', '.vjs-big-play-button',
  '.plyr__control--overlaid', 'button[aria-label*="play" i]', '.play-button', '.play', '#play', '#player'
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (u) => u.replace(/&amp;/g, '&').replace(/\\\//g, '/').trim();
const out = (text) => fs.writeFileSync('result.txt', String(text).trim() + '\n');

(async () => {
  if (!target || !/^https?:\/\//i.test(target)) { out('ERROR: url invalide'); return; }

  let browser;
  try {
    const launchOpts = {
      args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-blink-features=AutomationControlled']
    };
    try {
      // Chrome deja installe sur les runners GitHub : aucun telechargement
      browser = await chromium.launch({ ...launchOpts, channel: 'chrome' });
    } catch (e) {
      console.log('Chrome indisponible, fallback chromium :', String(e.message).split('\n')[0]);
      browser = await chromium.launch(launchOpts);
    }
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 },
      locale: 'fr-FR'
    });
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    const page = await ctx.newPage();

    // Ferme les popups publicitaires
    ctx.on('page', (p) => { if (p !== page) p.close().catch(() => {}); });

    const seen = [];
    let resolveFound;
    const found = new Promise((r) => { resolveFound = r; });
    const decoys = [];
    const add = (u) => {
      u = clean(u);
      if (DECOY.test(u)) { if (!decoys.includes(u)) decoys.push(u); return; }
      if (!seen.includes(u)) seen.push(u);
      resolveFound(u);
    };

    // 1) Requetes reseau vers un .m3u8
    ctx.on('request', (req) => { if (IS_M3U8.test(req.url())) add(req.url()); });

    // 2) Reponses JSON/JS/texte qui contiennent une URL .m3u8
    ctx.on('response', async (res) => {
      try {
        const ct = (res.headers()['content-type'] || '').toLowerCase();
        if (!/json|javascript|text/.test(ct)) return;
        const len = parseInt(res.headers()['content-length'] || '0', 10);
        if (len > 2_000_000) return;
        const body = (await res.text()).replace(/\\\//g, '/');
        const m = body.match(M3U8_RE);
        if (m) add(m[0]);
      } catch (e) {}
    });

    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

    // Clique regulierement pour declencher la lecture
    let stop = false;
    const clicker = (async () => {
      while (!stop) {
        await page.mouse.click(640, 360).catch(() => {});
        for (const f of page.frames()) {
          for (const s of CLICK_SELECTORS) await f.click(s, { timeout: 400, force: true }).catch(() => {});
        }
        await sleep(3000);
      }
    })();

    const first = await Promise.race([found, sleep(45000).then(() => null)]);
    if (first) await sleep(2000); // laisse arriver un eventuel master playlist
    stop = true;
    await clicker;

    // 3) Dernier recours : chercher l'URL dans le code des frames
    if (!seen.length) {
      for (const f of page.frames()) {
        try {
          const html = (await f.content()).replace(/\\\//g, '/');
          const m = html.match(M3U8_RE);
          if (m) { add(m[0]); break; }
        } catch (e) {}
      }
    }

    if (!seen.length) {
      if (decoys.length) { out('ERROR: flux leurre recu (' + decoys[0] + ') : l hebergeur detecte le bot'); return; }
      out('ERROR: aucun .m3u8 trouve (page bloquee ou lecteur non declenche)'); return;
    }

    const best = seen.find((u) => /master/i.test(u)) || seen[0];
    out(best);
    console.log('OK:', best);
  } catch (e) {
    console.error(e);
    out('ERROR: ' + (e && e.message ? e.message : e));
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
})();
