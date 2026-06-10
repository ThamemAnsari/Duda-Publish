/**
 * ============================================================
 * Duda Auto-Republish Server (Node.js)
 * ============================================================
 * Listens for Zoho Cliq Bot webhook
 * → opens Duda in Chrome → clicks Republish
 *
 * Run:
 *   node republish_server.js
 *
 * In another terminal:
 *   npx ngrok http 3000
 * ============================================================
 */

require('dotenv').config();

const http         = require('http');
const fs           = require('fs');
const path         = require('path');
const { chromium } = require('playwright');

// ─── CONFIG ──────────────────────────────────────────────────
const DUDA_EMAIL    = process.env.DUDA_EMAIL    || 'ansaransuu508@gmail.com';
const DUDA_PASSWORD = process.env.DUDA_PASSWORD || 'YSc2@#MdzyyQXYX';
const DUDA_SITE     = process.env.DUDA_SITE     || 'bc6015ea';
const DUDA_URL      = `https://my.duda.co/home/site/${DUDA_SITE}/home`;
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || 'teameverest2026';
const PORT          = process.env.PORT          || 3000;
const AUTH_FILE     = path.resolve('duda_auth.json');

let isRepublishing  = false;

// ─── LOGGING ─────────────────────────────────────────────────
function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync('republish.log', line + '\n');
}

// ─── LOGIN & SAVE SESSION ────────────────────────────────────
async function loginAndSave() {
  log('Opening browser for login...');
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page    = await context.newPage();

  await page.goto(DUDA_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Try password login if provided
  if (DUDA_PASSWORD) {
    try {
      await page.waitForSelector('input[type="email"]', { timeout: 5000 });
      await page.fill('input[type="email"]', DUDA_EMAIL);
      await page.fill('input[type="password"]', DUDA_PASSWORD);
      await page.locator('button[type="submit"]').filter({ hasNotText: 'Google' }).first().click();
    } catch (_) {}
  }

  // Wait for manual login (Google SSO) — up to 3 minutes
  log('Waiting for login... Please sign in manually if needed.');
  await page.waitForFunction(
    () => window.location.href.includes('/home/') && !window.location.href.includes('/login'),
    { timeout: 180000 }
  );

  log('Logged in! Saving session...');
  await context.storageState({ path: AUTH_FILE });
  await browser.close();
  log(`Session saved to ${AUTH_FILE}`);
}

// ─── REPUBLISH DUDA ──────────────────────────────────────────
async function republishDuda(siteUrl) {
  const targetUrl = siteUrl || DUDA_URL;
  log(`Starting republish: ${targetUrl}`);

  if (!fs.existsSync(AUTH_FILE)) {
    log('No saved session — logging in first...');
    await loginAndSave();
  }

  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    viewport:     { width: 1366, height: 768 },
    storageState: AUTH_FILE,
  });
  const page = await context.newPage();

  try {
    log('Navigating to Duda editor...');
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    // Re-login if session expired
    if (page.url().includes('/login')) {
      log('Session expired — re-logging in...');
      await browser.close();
      await loginAndSave();
      return await republishDuda(siteUrl); // retry
    }

    // Wait for Republish button
    log('Waiting for Republish button...');
    await page.waitForSelector(
      'button:has-text("Republish"), button:has-text("Publish")',
      { timeout: 30000 }
    );

    // Click Republish
    const btn = page.locator('button:has-text("Republish"), button:has-text("Publish")').first();
    await btn.click();
    log('✅ Republish button clicked!');

    await page.waitForTimeout(3000);
    await browser.close();
    log('✅ Republish complete!');
    return true;

  } catch (err) {
    log(`❌ Republish failed: ${err.message}`);
    await browser.close();
    return false;
  }
}

// ─── HTTP SERVER ─────────────────────────────────────────────
const server = http.createServer((req, res) => {

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const url = req.url.split('?')[0];

  // Health check
  if (req.method === 'GET' && url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({
      status: 'running',
      site: DUDA_SITE,
      session: fs.existsSync(AUTH_FILE),
      busy: isRepublishing,
    }));
    return;
  }

  // Manual trigger
  if (req.method === 'GET' && url === '/trigger') {
    if (!isRepublishing) {
      isRepublishing = true;
      republishDuda().finally(() => { isRepublishing = false; });
    }
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'triggered manually' }));
    return;
  }

  // Login trigger
  if (req.method === 'GET' && url === '/login') {
    loginAndSave().then(() => log('Login complete'));
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'login browser opened' }));
    return;
  }

  // Webhook endpoint
  if (req.method === 'POST' && url === '/webhook') {
    // Check token
    const token = req.headers['x-token'] || new URL('http://x' + req.url).searchParams.get('token');
    if (token !== WEBHOOK_TOKEN) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    // Parse body
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let data = {};
      try { data = JSON.parse(body); } catch (_) {}

      log(`Webhook received: ${JSON.stringify(data).slice(0, 200)}`);

      let siteUrl = data.duda_url || data.url || null;
      if (siteUrl && !siteUrl.startsWith('http')) {
        siteUrl = `https://my.duda.co/home/site/${siteUrl}/home`;
      }

      if (!isRepublishing) {
        isRepublishing = true;
        republishDuda(siteUrl).finally(() => { isRepublishing = false; });
      } else {
        log('Already republishing — skipping duplicate trigger');
      }

      res.writeHead(200);
      res.end(JSON.stringify({
        status: 'triggered',
        site_url: siteUrl || DUDA_URL,
      }));
    });
    return;
  }

  // 404
  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

// ─── START ───────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log('='.repeat(55));
  console.log('  Duda Auto-Republish Server (Node.js)');
  console.log('='.repeat(55));
  console.log(`  Site      : ${DUDA_SITE}`);
  console.log(`  Port      : ${PORT}`);
  console.log(`  Webhook   : http://localhost:${PORT}/webhook`);
  console.log(`  Health    : http://localhost:${PORT}/health`);
  console.log(`  Manual    : http://localhost:${PORT}/trigger`);
  console.log(`  Login     : http://localhost:${PORT}/login`);
  console.log('='.repeat(55));
  console.log();

  if (!fs.existsSync(AUTH_FILE)) {
    console.log('⚠️  No saved session found.');
    console.log(`   Visit http://localhost:${PORT}/login to login first.\n`);
  } else {
    console.log('✅  Saved session found. Ready to republish.\n');
  }

  console.log(`🚀  Now run in another terminal:`);
  console.log(`    npx ngrok http ${PORT}\n`);
});