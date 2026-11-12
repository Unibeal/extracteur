// Ouvre la page embed, collecte TOUS les .m3u8, VALIDE chacun (segments, duree, 1er segment lisible), ecrit le meilleur
const puppeteer = require('puppeteer');
const fs = require('fs');

const url = process.env.EMBED_URL;
const rid = process.env.RID;
if (!/^https:\/\//i.test(url || '') || !/^[\w-]{8,64}$/.test(rid || '')) { console.error('entree invalide'); process.exit(1); }
fs.mkdirSync('results', { recursive: true });
const out = (t) => fs.writeFileSync(`results/${rid}.txt`, t + '\n');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function score(u) {
  if (/\/troll\//i.test(u)) return -1;
  let s = 1;
  if (/master/i.test(u)) s += 2;
  if (/[?&]t=/.test(u)) s += 2;
  return s;
}

async function get(u, extra) {
  return fetch(u, { headers: { 'User-Agent': UA, Referer: url, Origin: new URL(url).origin, ...(extra || {}) }, redirect: 'follow' });
}

// Verifie qu'un flux est reel : plusieurs segments, duree plausible, premier segment telechargeable
async function check(u) {
  try {
    let r = await get(u);
    if (!r.ok) return { ok: false, why: 'playlist HTTP ' + r.status };
    let txt = await r.text(), base = r.url || u;
    if (txt.includes('#EXT-X-STREAM-INF')) {
      const lines = txt.split(/\r?\n/).map((l) => l.trim());
      const i = lines.findIndex((l) => l.startsWith('#EXT-X-STREAM-INF'));
      const child = lines.slice(i + 1).find((l) => l && l[0] !== '#');
      if (!child) return { ok: false, why: 'master sans variante' };
      base = new URL(child, base).href;
      r = await get(base);
      if (!r.ok) return { ok: false, why: 'variante HTTP ' + r.status };
      txt = await r.text();
    }
    const lines = txt.split(/\r?\n/).map((l) => l.trim());
    const segs = lines.filter((l) => l && l[0] !== '#');
    const dur = lines.reduce((a, l) => a + (l.startsWith('#EXTINF:') ? parseFloat(l.slice(8)) || 0 : 0), 0);
    if (segs.length < 2 || dur < 15) return { ok: false, why: segs.length + ' segment(s), ' + Math.round(dur) + ' s (flux factice ?)' };
    const sr = await get(new URL(segs[0], base).href, { Range: 'bytes=0-2047' });
    const buf = Buffer.from(await sr.arrayBuffer());
    if (!sr.ok || buf.length < 100) return { ok: false, why: '1er segment HTTP ' + sr.status + ' (' + buf.length + ' o)' };
    return { ok: true, why: segs.length + ' segments, ' + Math.round(dur) + ' s' };
  } catch (e) { return { ok: false, why: 'erreur ' + e.message }; }
}

(async () => {
  let browser;
  try {
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    const cands = [];
    page.on('request', (r) => { const u = r.url(); if (/\.m3u8($|\?)/i.test(u) && !cands.includes(u)) cands.push(u); });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    let extra = 0;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      if (cands.length && ++extra > 4) break; // laisse le temps aux autres playlists d'apparaitre
      if (!cands.length && i % 3 === 1) {
        await page.mouse.click(400, 300).catch(() => {});
        await page.evaluate(() => { document.querySelectorAll('video').forEach((v) => v.play && v.play().catch(() => {})); }).catch(() => {});
      }
    }
    const ranked = cands.filter((u) => score(u) > 0).sort((a, b) => score(b) - score(a));
    if (!ranked.length) { out('ERROR: aucun flux m3u8 trouve' + (cands.length ? ' (que des leurres /troll/)' : '')); return; }
    const reasons = [];
    for (const u of ranked) {
      const c = await check(u);
      console.log(c.ok ? 'OK ' : 'KO ', c.why, u);
      if (c.ok) { out(u); return; }
      reasons.push(c.why);
    }
    out('ERROR: flux trouve mais invalide (' + reasons.join(' | ') + ')');
  } catch (e) {
    out('ERROR: ' + (e && e.message || e));
  } finally {
    if (browser) await browser.close();
  }
})();
