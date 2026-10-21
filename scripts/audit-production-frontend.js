'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');
(async () => {
  const out = path.resolve('ui-evidence/production');
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const evidence = { url: 'https://pos-system-rouge-ten.vercel.app/', observations: [] };
    for (const width of [375,390,430,768,1024,1280,1440]) {
      await page.setViewportSize({ width, height: 1000 });
      const response = await page.goto(evidence.url, { waitUntil: 'networkidle' });
      await page.screenshot({ path: path.join(out, width + '.png'), fullPage: true });
      const state = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        viewport: innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        stylesheets: [...document.querySelectorAll('link[rel="stylesheet"]')].map(el => el.href),
        scripts: [...document.scripts].filter(el => el.src).map(el => el.src),
        inlineStyleCount: document.querySelectorAll('style').length,
        headings: [...document.querySelectorAll('h1,h2,h3')].map(el => el.textContent.trim()),
        bodyText: document.body.innerText.slice(0,16000),
        rootFont: getComputedStyle(document.body).fontFamily
      }));
      evidence.observations.push({ width, httpStatus: response.status(), ...state });
    }
    fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(evidence,null,2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
