const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
  const targetUrl = process.env.TARGET_URL;
  if (!targetUrl) {
    console.error('Pas d\'URL fournie');
    process.exit(1);
  }

  console.log('🔍 Extraction de:', targetUrl);
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();

  let m3u8Url = null;

  // Intercepte les requêtes réseau
  page.on('response', (response) => {
    const url = response.url();
    if (url.includes('.m3u8') && !m3u8Url) {
      console.log('✅ Flux trouvé:', url);
      m3u8Url = url;
    }
  });

  try {
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    // Attend 5 secondes que le lecteur charge
    await new Promise(r => setTimeout(r, 5000));
  } catch (e) {
    console.error('Erreur de navigation:', e.message);
  }

  await browser.close();

  if (m3u8Url) {
    fs.writeFileSync('result.txt', m3u8Url);
    console.log('Résultat écrit dans result.txt');
  } else {
    console.log('Aucun flux .m3u8 trouvé');
    fs.writeFileSync('result.txt', '');
  }
})();