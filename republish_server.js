/**
 * ============================================================
 * Duda Auto-Republish Server (Node.js)
 * ============================================================
 * Listens for Zoho Cliq Bot webhook
 * → opens headless Chromium → clicks Republish
 *
 * Run locally:
 *   node republish_server.js
 *
 * Deploy on Render:
 *   Set env vars: DUDA_EMAIL, DUDA_PASSWORD, DUDA_SITE,
 *                 WEBHOOK_TOKEN, DUDA_AUTH_BASE64
 * ============================================================
 */

require('dotenv').config();

const http         = require('http');
const fs           = require('fs');
const path         = require('path');
const { chromium } = require('playwright');

// ─── CRASH GUARD ─────────────────────────────────────────────
// Keep server alive even if a republish attempt throws
process.on('unhandledRejection', (reason) => {
  console.error(`[UNHANDLED REJECTION] ${reason}`);
  isRepublishing = false;
});
process.on('uncaughtException', (err) => {
  console.error(`[UNCAUGHT EXCEPTION] ${err.message}`);
  isRepublishing = false;
});

// ─── CONFIG ─────────────────────────────────────────────
const DUDA_EMAIL          = process.env.DUDA_EMAIL          || 'ansaransuu508@gmail.com';
const DUDA_PASSWORD       = process.env.DUDA_PASSWORD       || '';
const DUDA_SITE           = process.env.DUDA_SITE           || 'bc6015ea';
const DUDA_URL            = `https://my.duda.co/home/site/${DUDA_SITE}/home`;
const WEBHOOK_TOKEN       = process.env.WEBHOOK_TOKEN       || 'teameverest2026';
const PORT                = process.env.PORT                || 3000;
const AUTH_FILE           = path.resolve('duda_auth.json');
// Zoho Cliq Incoming Webhook URL — set this in your .env or Render env vars
// Create one at: Cliq → Integrations → Incoming Webhooks → New Webhook
const ZOHO_CLIQ_WEBHOOK   = process.env.ZOHO_CLIQ_WEBHOOK  || '';

let isRepublishing  = false;

// ─── LOGGING ────────────────────────────────────────────
function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync('republish.log', line + '\n'); } catch (_) {}
}

// ─── NOTIFY ZOHO CLIQ ──────────────────────────────────────
function notifyCliq(text) {
  if (!ZOHO_CLIQ_WEBHOOK) return; // skip if not configured
  const body = JSON.stringify({ text });
  const url  = new URL(ZOHO_CLIQ_WEBHOOK);
  const opts = {
    hostname: url.hostname,
    path:     url.pathname + url.search,
    method:   'POST',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  };
  const req = require('https').request(opts, (res) => {
    log(`📬 Cliq notified (HTTP ${res.statusCode})`);
  });
  req.on('error', (e) => log(`⚠️  Cliq notify failed: ${e.message}`));
  req.write(body);
  req.end();
}

// ─── BOOTSTRAP SESSION FROM ENV VAR ──────────────────────────
// On Render, the filesystem is ephemeral. We encode duda_auth.json
// as base64 and store it in DUDA_AUTH_BASE64 env var.
// On every startup, we decode it back to disk.
function bootstrapSession() {
  const b64 = process.env.DUDA_AUTH_BASE64;
  if (b64 && !fs.existsSync(AUTH_FILE)) {
    try {
      const json = Buffer.from(b64, 'base64').toString('utf8');
      fs.writeFileSync(AUTH_FILE, json);
      log('✅ Session loaded from DUDA_AUTH_BASE64 env var.');
    } catch (err) {
      log(`⚠️  Failed to decode DUDA_AUTH_BASE64: ${err.message}`);
    }
  }
}

// ─── BROWSER LAUNCH OPTIONS ──────────────────────────────────
// headless: true  — works on Render (no display needed)
// No channel     — uses Playwright's bundled Chromium (no Chrome install needed)
function getBrowserOptions() {
  return {
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1366,768',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  };
}

// Real Chrome 124 user agent — avoids headless bot detection
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Inject JS to hide all common headless fingerprints
async function stealthify(page) {
  await page.addInitScript(() => {
    // Remove webdriver flag
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // Fake plugins
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    // Fake languages
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    // Fake chrome object
    window.chrome = { runtime: {} };
    // Override permissions
    const originalQuery = window.navigator.permissions?.query;
    if (originalQuery) {
      window.navigator.permissions.query = (parameters) =>
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters);
    }
  });
}

// ─── LOGIN & SAVE SESSION ────────────────────────────────────
async function loginAndSave() {
  log('Opening browser for login...');
  const browser = await chromium.launch(getBrowserOptions());
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

  // Wait for login to complete — up to 3 minutes
  log('Waiting for login...');
  await page.waitForFunction(
    () => window.location.href.includes('/home/') && !window.location.href.includes('/login'),
    { timeout: 180000 }
  );

  log('Logged in! Saving session...');
  await context.storageState({ path: AUTH_FILE });
  await browser.close();
  log(`Session saved to ${AUTH_FILE}`);

  // Print base64 so you can copy it into the Render env var
  const b64 = Buffer.from(fs.readFileSync(AUTH_FILE, 'utf8')).toString('base64');
  log('─'.repeat(60));
  log('Copy the value below into Render → Environment → DUDA_AUTH_BASE64:');
  console.log('\n' + b64 + '\n');
  log('─'.repeat(60));
}

// ─── REPUBLISH DUDA ──────────────────────────────────────────
async function republishDuda(siteUrl) {
  const targetUrl = siteUrl || DUDA_URL;
  log(`Starting republish: ${targetUrl}`);

  if (!fs.existsSync(AUTH_FILE)) {
    log('No saved session — logging in first...');
    await loginAndSave();
  }

  const browser = await chromium.launch(getBrowserOptions());

  const context = await browser.newContext({
    viewport:     { width: 1366, height: 768 },
    storageState: AUTH_FILE,
    userAgent:    CHROME_UA,
    locale:       'en-US',
    timezoneId:   'America/New_York',
  });
  const page = await context.newPage();
  await stealthify(page);

  try {
    log('Navigating to Duda editor...');
    // 'load' fires after all resources — reliable for SPAs without hanging forever
    await page.goto(targetUrl, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(5000); // extra buffer for React to render

    // Re-login if session expired
    if (page.url().includes('/login')) {
      log('Session expired — re-logging in...');
      await browser.close();
      await loginAndSave();
      return await republishDuda(siteUrl); // retry
    }

    log(`Page loaded: ${page.url()}`);

    // Dismiss any modal/popup (e.g. "What's New at Duda")
    log('Dismissing any modals...');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);
    // Also try clicking a close button if Escape didn't work
    try {
      const closeBtn = page.locator('button[aria-label*="close" i], button[aria-label*="dismiss" i], .modal-close, [class*="close"]').first();
      if (await closeBtn.isVisible({ timeout: 2000 })) {
        await closeBtn.click();
        await page.waitForTimeout(500);
      }
    } catch (_) {}

    // Wait for Republish button (broader selector, longer timeout)
    log('Waiting for Republish button...');
    await page.waitForSelector(
      'button:has-text("Republish"), button:has-text("Publish"), [data-testid*="publish"]',
      { timeout: 45000 }
    );


    // Click Republish
    const btn = page.locator('button:has-text("Republish"), button:has-text("Publish")').first();
    await btn.click();
    log('✅ Republish button clicked!');

    await page.waitForTimeout(3000);
    await browser.close();
    log('✅ Republish complete!');
    notifyCliq('✅ Duda site republished successfully!');
    return true;


  } catch (err) {
    log(`❌ Republish failed: ${err.message}`);
    notifyCliq(`❌ Duda republish failed: ${err.message.split('\n')[0]}`);
    // Save a screenshot so we can see what the page looked like
    try {
      const shot = path.resolve('debug_screenshot.png');
      await page.screenshot({ path: shot, fullPage: true });
      log(`📸 Screenshot saved: ${shot}`);
    } catch (_) {}
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

  // Login trigger (local use only — headless login won't work for Google SSO)
  if (req.method === 'GET' && url === '/login') {
    loginAndSave().then(() => log('Login complete'));
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'login started — check server logs for DUDA_AUTH_BASE64' }));
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
bootstrapSession(); // Load session from env var if running on Render

server.listen(PORT, () => {
  console.log('='.repeat(55));
  console.log('  Duda Auto-Republish Server (Node.js)');
  console.log('='.repeat(55));
  console.log(`  Site      : ${DUDA_SITE}`);
  console.log(`  Port      : ${PORT}`);
  console.log(`  Webhook   : http://localhost:${PORT}/webhook`);
  console.log(`  Health    : http://localhost:${PORT}/health`);
  console.log(`  Manual    : http://localhost:${PORT}/trigger`);
  console.log('='.repeat(55));
  console.log();

  if (!fs.existsSync(AUTH_FILE)) {
    console.log('⚠️  No saved session found.');
    console.log(`   Run: node republish_server.js then visit /login\n`);
  } else {
    console.log('✅  Session ready. Ready to republish.\n');
  }
});