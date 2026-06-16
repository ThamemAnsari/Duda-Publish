/**
 * ============================================================
 * republish.js — Standalone Duda Republish Script
 * ============================================================
 * Runs inside GitHub Actions Ubuntu VM (Duda-Publish repo)
 * Triggered by IATC-App EC2 via GitHub API dispatch
 *
 * Usage: node republish.js [optional-site-url]
 * ============================================================
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');
const { chromium } = require('playwright');

// ─── CONFIG FROM ENV (set as GitHub Secrets) ─────────────────
const DUDA_EMAIL        = process.env.DUDA_EMAIL        || '';
const DUDA_PASSWORD     = process.env.DUDA_PASSWORD     || '';
const DUDA_SITE         = process.env.DUDA_SITE         || 'bc6015ea';
const DUDA_AUTH_BASE64  = process.env.DUDA_AUTH_BASE64  || '';
const ZOHO_CLIQ_WEBHOOK = process.env.ZOHO_CLIQ_WEBHOOK || '';
const ZOHO_CLIQ_MESSAGE_ID = process.env.ZOHO_CLIQ_MESSAGE_ID || '';
const CALLBACK_URL      = process.env.CALLBACK_URL      || '';

// Site URL: CLI arg → env var → default
const SITE_URL = process.argv[2]
  || process.env.DUDA_SITE_URL
  || `https://my.duda.co/home/site/${DUDA_SITE}/home`;

const AUTH_FILE = path.resolve(__dirname, 'duda_auth.json');
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─── LOGGING ─────────────────────────────────────────────────
function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[DUDA] [${ts}] ${msg}`);
}

// ─── NOTIFY ZOHO CLIQ ────────────────────────────────────────
function notifyCliq(text) {
  if (!ZOHO_CLIQ_WEBHOOK) return Promise.resolve();
  const body = JSON.stringify({ text });
  const url  = new URL(ZOHO_CLIQ_WEBHOOK);
  const opts = {
    hostname: url.hostname,
    path:     url.pathname + url.search,
    method:   'POST',
    headers:  {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  };
  return new Promise((resolve) => {
    const req = https.request(opts, (res) => {
      log(`📬 Cliq notified (HTTP ${res.statusCode})`);
      resolve();
    });
    req.on('error', (e) => { log(`⚠️  Cliq notify failed: ${e.message}`); resolve(); });
    req.write(body);
    req.end();
  });
}

// ─── NOTIFY EC2 CALLBACK (optional) ──────────────────────────
function notifyCallback(success, message) {
  if (!CALLBACK_URL) return Promise.resolve();
  const body = JSON.stringify({ success, message });
  const url  = new URL(CALLBACK_URL);
  const opts = {
    hostname: url.hostname,
    path:     url.pathname + url.search,
    method:   'POST',
    headers:  {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  };
  return new Promise((resolve) => {
    const req = https.request(opts, (res) => {
      log(`📬 EC2 callback notified (HTTP ${res.statusCode})`);
      resolve();
    });
    req.on('error', (e) => { log(`⚠️  EC2 callback failed: ${e.message}`); resolve(); });
    req.write(body);
    req.end();
  });
}

// ─── LOAD SESSION FROM ENV ────────────────────────────────────
function loadSession() {
  if (DUDA_AUTH_BASE64) {
    try {
      fs.writeFileSync(AUTH_FILE, Buffer.from(DUDA_AUTH_BASE64, 'base64').toString('utf8'));
      log('✅ Session loaded from DUDA_AUTH_BASE64');
      return true;
    } catch (err) {
      log(`⚠️  Failed to decode DUDA_AUTH_BASE64: ${err.message}`);
      return false;
    }
  }
  return fs.existsSync(AUTH_FILE);
}

// ─── BROWSER OPTIONS ─────────────────────────────────────────
// headless: false + Xvfb = looks like real Chrome to Duda
function getBrowserOptions() {
  return {
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1366,768',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-extensions',
    ],
  };
}

// ─── STEALTH ─────────────────────────────────────────────────
async function stealthify(page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver',  { get: () => undefined });
    Object.defineProperty(navigator, 'plugins',    { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages',  { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {} };
  });
}

// ─── LOGIN & SAVE SESSION ─────────────────────────────────────
async function loginAndSave() {
  log('No valid session — logging in fresh...');
  const browser = await chromium.launch(getBrowserOptions());
  const context = await browser.newContext({
    viewport:  { width: 1366, height: 768 },
    userAgent: CHROME_UA,
  });
  const page = await context.newPage();
  await stealthify(page);

  await page.goto('https://my.duda.co/login', { waitUntil: 'domcontentloaded', timeout: 30000 });

  if (DUDA_PASSWORD) {
    try {
      await page.waitForSelector('input[type="email"]', { timeout: 8000 });
      await page.fill('input[type="email"]', DUDA_EMAIL);
      await page.fill('input[type="password"]', DUDA_PASSWORD);
      await page.locator('button[type="submit"]')
        .filter({ hasNotText: 'Google' })
        .first()
        .click();
    } catch (_) {}
  }

  log('Waiting for login redirect...');
  await page.waitForFunction(
    () => window.location.href.includes('/home') && !window.location.href.includes('/login'),
    { timeout: 180000 }
  );

  try {
    log(`🔗 Navigating to site URL: ${SITE_URL}`);
    await page.goto(SITE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
  } catch (err) {
    log(`⚠️ Warning: Navigation to site URL failed: ${err.message}`);
  }

  await context.storageState({ path: AUTH_FILE });
  await browser.close();

  // Prune the auth file to fit inside GitHub Secrets size limit (10 KB)
  try {
    const rawState = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    const essentialNames = ['JSESSIONID', 'AWSALB', 'AWSALBCORS'];
    const cleanCookies = rawState.cookies.filter(
      c => c.name.startsWith('_dm_') || essentialNames.includes(c.name)
    );
    const prunedState = { cookies: cleanCookies, origins: [] };
    fs.writeFileSync(AUTH_FILE, JSON.stringify(prunedState, null, 2));
    log('🧹 Session file pruned successfully.');
  } catch (err) {
    log(`⚠️ Warning: Failed to prune session file: ${err.message}`);
  }

  log('✅ Session saved');
}

// ─── MAIN REPUBLISH ───────────────────────────────────────────
async function republish() {
  log(`🚀 Starting republish for: ${SITE_URL}`);

  // Load session from DUDA_AUTH_BASE64 secret or login fresh
  const hasSession = loadSession();
  if (!hasSession) {
    await loginAndSave();
  }

  const browser = await chromium.launch(getBrowserOptions());
  const context = await browser.newContext({
    viewport:     { width: 1366, height: 768 },
    storageState: AUTH_FILE,
    userAgent:    CHROME_UA,
    locale:       'en-US',
  });
  const page = await context.newPage();
  await stealthify(page);

  page.on('console',       msg => log(`[Browser] ${msg.type()}: ${msg.text()}`));
  page.on('pageerror',     err => log(`[PageError] ${err.message}`));
  page.on('requestfailed', req => log(`[ReqFailed] ${req.url()}`));

  try {
    log('Navigating to Duda dashboard...');
    await page.goto(SITE_URL, { waitUntil: 'networkidle', timeout: 90000 });
    await page.waitForTimeout(5000);

    // Screenshot after load — visible in GitHub Actions artifacts tab
    await page.screenshot({ path: 'duda_after_load.png', fullPage: true });
    log('📸 Screenshot saved: duda_after_load.png');

    // Session expired?
    if (page.url().includes('/login')) {
      log('Session expired — re-logging in...');
      await browser.close();
      fs.unlinkSync(AUTH_FILE); // remove stale session
      await loginAndSave();
      return await republish(); // retry once
    }

    const title = await page.title();
    log(`Page title: "${title}"`);

    // Sanity check — blank page = bot detection
    const html = await page.content();
    if (html.trim() === '<html><head></head><body></body></html>') {
      throw new Error('Blank page received — possible bot detection by Duda');
    }

    // Dismiss any modals
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);
    try {
      const closeBtn = page.locator(
        'button[aria-label*="close" i], button[aria-label*="dismiss" i], .modal-close'
      ).first();
      if (await closeBtn.isVisible({ timeout: 2000 })) {
        await closeBtn.click();
        await page.waitForTimeout(500);
      }
    } catch (_) {}

    log('Waiting for Publish button...');
    await page.waitForSelector(
      'button:has-text("Republish"), button:has-text("Publish"), [data-testid*="publish"]',
      { timeout: 90000 }
    );

    // Screenshot just before clicking
    await page.screenshot({ path: 'duda_before_click.png', fullPage: true });
    log('📸 Screenshot saved: duda_before_click.png');

    const btn = page.locator(
      'button:has-text("Republish"), button:has-text("Publish")'
    ).first();
    await btn.click();
    log('✅ Publish button clicked!');

    await page.waitForTimeout(4000);

    // Final screenshot
    await page.screenshot({ path: 'duda_after_publish.png', fullPage: true });
    log('📸 Screenshot saved: duda_after_publish.png');

    await browser.close();
    log('✅ Republish complete!');

    await notifyCliq('✅ Duda site republished successfully!');
    await notifyCallback(true, 'Republish successful');
    process.exit(0);

  } catch (err) {
    log(`❌ Republish failed: ${err.message}`);
    try {
      await page.screenshot({ path: 'duda_error.png', fullPage: true });
      log('📸 Error screenshot: duda_error.png');
    } catch (_) {}
    await browser.close();

    await notifyCliq(`❌ Duda republish failed: ${err.message.split('\n')[0]}`);
    await notifyCallback(false, err.message);
    process.exit(1);
  }
}

// ─── RUN ─────────────────────────────────────────────────────
republish().catch((err) => {
  log(`💥 Unhandled error: ${err.message}`);
  process.exit(1);
});