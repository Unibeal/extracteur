// Ouvre la page embed, capture la requete .m3u8 reelle, ecrit results/<rid>.txt
const puppeteer = require('puppeteer');
const fs = require('fs');

const url = process.env.EMBED_URL;
const rid = process.env.RID;
if (!/^https:\/\//i.test(url || '') || !/^[\w-]{8,64}$/.test(rid || '')) { console.error('entree invalide'); process.exit(1); }
fs.mkdirSync('results', { recursive: true });
const out = (t) => fs.writeFileSync(`results/${rid}.txt`, t + '\n');

(async () => {
  let browser;
  try {
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36');
    let found = '';
    page.on('request', (r) => {
      const u = r.url();
      if (!found && /\.m3u8($|\?)/i.test(u) && !/\/troll\//i.test(u)) found = u;
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    // tente de declencher la lecture (clics sur le lecteur)
    for (let i = 0; i < 25 && !found; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      if (i % 3 === 1) {
        await page.mouse.click(400, 300).catch(() => {});
        await page.evaluate(() => { document.querySelectorAll('video').forEach((v) => v.play && v.play().catch(() => {})); }).catch(() => {});
      }
    }
    out(found || 'ERROR: aucun flux m3u8 trouve');
  } catch (e) {
    out('ERROR: ' + (e && e.message || e));
  } finally {
    if (browser) await browser.close();
  }
})();
