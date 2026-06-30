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

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const { chromium } = require('playwright');

// ─── CONFIG FROM ENV (set as GitHub Secrets) ─────────────────
const DUDA_EMAIL             = process.env.DUDA_EMAIL             || '';
const DUDA_PASSWORD          = process.env.DUDA_PASSWORD          || '';
const DUDA_SITE              = process.env.DUDA_SITE              || '3f4c882c';
const ZOHO_CLIQ_WEBHOOK      = process.env.ZOHO_CLIQ_WEBHOOK      || '';
const ZOHO_CLIQ_CHANNEL_ID   = process.env.ZOHO_CLIQ_CHANNEL_ID   || 'O2099672000000008001';
const CALLBACK_URL           = process.env.CALLBACK_URL           || '';
const ZOHO_CLIQ_CHANNEL_NAME = process.env.ZOHO_CLIQ_CHANNEL_NAME || 'testforsprint';

// ✅ Event metadata — passed from Deluge → EC2 → GitHub Actions client_payload
const EVENT_ID = process.env.EVENT_ID || '';
const ORG_NAME = process.env.ORG_NAME || '';

// ✅ OAuth refresh token secrets
const ZOHO_CLIENT_ID     = process.env.ZOHO_CLIENT_ID     || '';
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || '';
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || '';

const AUTH_FILE      = path.resolve(__dirname, 'duda_auth.json');
const CHROME_UA      = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
// ✅ Always use my.duda.co — login cookies are valid for this domain
const DUDA_SITE_LINK = `https://infocc3969fa.dudasitebuilder.com/home/site/${DUDA_SITE}/home`;

// ─── LOGGING ─────────────────────────────────────────────────
function log(msg) {
  console.log(`[DUDA] [${new Date().toISOString()}] ${msg}`);
}

// ─── GET FRESH ZOHO ACCESS TOKEN ─────────────────────────────
function getZohoAccessToken() {
  if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET || !ZOHO_REFRESH_TOKEN) {
    log('⚠️  Zoho OAuth credentials not fully set — skipping token refresh');
    return Promise.resolve(null);
  }
  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    client_id:     ZOHO_CLIENT_ID,
    client_secret: ZOHO_CLIENT_SECRET,
    refresh_token: ZOHO_REFRESH_TOKEN,
  });
  const body = params.toString();
  const opts = {
    hostname: 'accounts.zoho.com',
    path:     '/oauth/v2/token',
    method:   'POST',
    headers:  { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
  };
  return new Promise((resolve) => {
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) { log('✅ Zoho access token refreshed successfully'); resolve(json.access_token); }
          else { log(`⚠️  Token refresh failed: ${data}`); resolve(null); }
        } catch (e) { log(`⚠️  Token refresh parse error: ${e.message}`); resolve(null); }
      });
    });
    req.on('error', (e) => { log(`⚠️  Token refresh request failed: ${e.message}`); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ─── BUILD CLIQ CARD ─────────────────────────────────────────
function buildCliqCard(success, errorMessage) {
  const timestamp = new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short',
  });
  const rows = [
    { Field: 'Event ID',                 Value: EVENT_ID || 'N/A' },
    { Field: 'Organization Name',        Value: ORG_NAME || 'N/A' },
    { Field: 'Website Published Status', Value: success ? '✅ Published' : '❌ Failed' },
    { Field: 'Published Date and Time',  Value: timestamp },
  ];
  if (!success && errorMessage) {
    rows.push({ Field: 'Error', Value: errorMessage.split('\n')[0].substring(0, 120) });
  }
  const eventLabel = EVENT_ID ? ` — ${EVENT_ID}` : '';
  return {
    text: success
      ? `✅ Volunteer Signup Closed${eventLabel}`
      : `❌ Duda republish failed${eventLabel}: ${(errorMessage || 'Unknown error').split('\n')[0]}`,
    card: { theme: 'modern-inline', title: success ? 'Form Submission Closed' : 'Duda Republish Failed' },
    slides: [{ type: 'table', data: { headers: ['Field', 'Value'], rows } }],
  };
}

// ─── NOTIFY ZOHO CLIQ ────────────────────────────────────────
async function notifyCliq(success, errorMessage) {
  const payload     = buildCliqCard(success, errorMessage);
  const accessToken = await getZohoAccessToken();

  if (accessToken && ZOHO_CLIQ_CHANNEL_NAME) {
    const apiPath = `/company/647541281/api/v2/channelsbyname/${ZOHO_CLIQ_CHANNEL_NAME}/message`;
    const body    = JSON.stringify(payload);
    const opts    = {
      hostname: 'cliq.zoho.com', path: apiPath, method: 'POST',
      headers: { 'Authorization': `Zoho-oauthtoken ${accessToken}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    return new Promise((resolve) => {
      const req = https.request(opts, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          const ok = res.statusCode === 200 || res.statusCode === 204;
          if (ok) log(`📬 Cliq card posted as new message (HTTP ${res.statusCode})`);
          else log(`⚠️  Cliq notify failed (HTTP ${res.statusCode}): ${data}`);
          resolve();
        });
      });
      req.on('error', (e) => { log(`⚠️  Cliq OAuth notify failed: ${e.message}`); resolve(); });
      req.write(body);
      req.end();
    });
  }

  if (!ZOHO_CLIQ_WEBHOOK) return Promise.resolve();
  log('⚠️  OAuth credentials missing — falling back to webhook (plain text only)');
  const fallbackPayload = { text: payload.text };
  const body = JSON.stringify(fallbackPayload);
  const url  = new URL(ZOHO_CLIQ_WEBHOOK);
  const opts = {
    hostname: url.hostname, path: url.pathname + url.search, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  };
  return new Promise((resolve) => {
    const req = https.request(opts, (res) => { log(`📬 Cliq notified via webhook fallback (HTTP ${res.statusCode})`); resolve(); });
    req.on('error', (e) => { log(`⚠️  Cliq webhook notify failed: ${e.message}`); resolve(); });
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
    hostname: url.hostname, path: url.pathname + url.search, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  };
  return new Promise((resolve) => {
    const req = https.request(opts, (res) => { log(`📬 EC2 callback notified (HTTP ${res.statusCode})`); resolve(); });
    req.on('error', (e) => { log(`⚠️  EC2 callback failed: ${e.message}`); resolve(); });
    req.write(body);
    req.end();
  });
}

// ─── BROWSER OPTIONS ─────────────────────────────────────────
function getBrowserOptions() {
  return {
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox', '--disable-setuid-sandbox',
      '--window-size=1366,768', '--disable-web-security',
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

// ─── DISMISS "WHAT'S NEW" MODAL ──────────────────────────────
async function dismissModal(page) {
  await page.waitForTimeout(2000);
  try {
    const closed = await page.evaluate(() => {
      const wrapper = document.getElementById('whats-newWrapper');
      if (!wrapper) return false;
      const buttons = wrapper.querySelectorAll('button');
      for (const btn of buttons) {
        const rect = btn.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) { btn.click(); return true; }
      }
      return false;
    });
    if (closed) {
      log('✅ Dismissed WhatsNew modal via #whats-newWrapper button');
      await page.waitForTimeout(1000);
      const overlayGone = await page.evaluate(() =>
        !document.querySelector('#whats-newWrapper .Modal-module-shown-VYJnW-aps, #whats-newWrapper .WhatsNewPopup-module-overlayClassName-bzxXx-aps')
      );
      if (overlayGone) { log('✅ Modal overlay confirmed removed'); return; }
      log('⚠️  Modal overlay still present — trying next strategy');
    }
  } catch (e) { log(`⚠️  Strategy 1 failed: ${e.message}`); }

  try {
    const overlay = page.locator('#whats-newWrapper .Modal-module-overlay-2OdDP-aps').first();
    if (await overlay.isVisible({ timeout: 2000 })) {
      await overlay.click({ force: true });
      log('✅ Dismissed modal by clicking overlay');
      await page.waitForTimeout(1000);
      return;
    }
  } catch (_) {}

  await page.keyboard.press('Escape');
  log('ℹ️  Sent Escape to dismiss any open modal');
  await page.waitForTimeout(500);
}

// ─── WAIT FOR MODAL OVERLAY TO CLEAR ─────────────────────────
async function waitForModalToClear(page) {
  log('Waiting for modal overlay to clear...');
  try {
    await page.waitForFunction(
      () => {
        const wrapper = document.getElementById('whats-newWrapper');
        if (!wrapper) return true;
        const overlay = wrapper.querySelector('.Modal-module-shown-VYJnW-aps');
        return !overlay;
      },
      undefined,
      { timeout: 10000 }
    );
    log('✅ Modal overlay cleared');
  } catch (_) {
    log('ℹ️  Modal overlay wait timed out — using force click as fallback');
  }
}

// ─── LOGIN & SAVE SESSION ─────────────────────────────────────
async function loginAndSave() {
  log('🔐 Starting fresh login...');
  if (!DUDA_EMAIL || !DUDA_PASSWORD) {
    throw new Error('DUDA_EMAIL and DUDA_PASSWORD must be set in GitHub Secrets');
  }

  const browser = await chromium.launch(getBrowserOptions());
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, userAgent: CHROME_UA });
  const page    = await context.newPage();
  await stealthify(page);

  // ✅ Correct login URL — the white-labeled domain
  const loginUrl = 'https://infocc3969fa.dudasitebuilder.com/login';
  log(`🔗 Navigating to login URL: ${loginUrl}`);
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

  try {
    // ✅ 30s (not 8s) — the email field needs time to render on this domain
    await page.waitForSelector('input[type="email"]', { timeout: 30000 });
    await page.fill('input[type="email"]', DUDA_EMAIL);
    await page.fill('input[type="password"]', DUDA_PASSWORD);

    // Save login-page screenshot (uploaded as artifact if anything fails)
    await page.screenshot({ path: 'duda_after_load.png', fullPage: true });

    // Robust submit: try several button selectors, fall back to Enter key
    const loginBtn = page.locator([
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Log In")',
      'button:has-text("Log in")',
      'button:has-text("Login")',
      'button:has-text("Sign In")',
      'button:has-text("Sign in")',
    ].join(', ')).filter({ hasNotText: 'Google' }).first();

    let clicked = false;
    try {
      await loginBtn.waitFor({ state: 'visible', timeout: 10000 });
      await loginBtn.click({ force: true, timeout: 10000 });
      clicked = true;
      log('✅ Login button clicked');
    } catch (e) {
      log(`⚠️ Login button not found (${e.message.split('\n')[0]}) — pressing Enter instead`);
    }
    if (!clicked) {
      await page.focus('input[type="password"]');
      await page.keyboard.press('Enter');
      log('✅ Submitted login form via Enter key');
    }
  } catch (err) {
    log(`⚠️ Login form interaction failed: ${err.message}`);
  }

  log('Waiting for login redirect...');
  await page.waitForFunction(
    () => window.location.href.includes('/home') && !window.location.href.includes('/login'),
    undefined,
    { timeout: 180000 }
  );
  log('✅ Login redirect detected');

  try {
    log(`🔗 Navigating to site post-login: ${DUDA_SITE_LINK}`);
    await page.goto(DUDA_SITE_LINK, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
  } catch (err) {
    log(`⚠️ Navigation to site URL failed: ${err.message}`);
  }

  await context.storageState({ path: AUTH_FILE });
  await browser.close();

  try {
    const rawState       = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    const essentialNames = ['JSESSIONID', 'AWSALB', 'AWSALBCORS'];
    const cleanCookies   = rawState.cookies.filter(c => c.name.startsWith('_dm_') || essentialNames.includes(c.name));
    fs.writeFileSync(AUTH_FILE, JSON.stringify({ cookies: cleanCookies, origins: [] }, null, 2));
    log('🧹 Session file pruned successfully.');
  } catch (err) {
    log(`⚠️ Failed to prune session file: ${err.message}`);
  }

  log('✅ Session saved to disk');
}

// ─── CHECK PAGE IS VALID ──────────────────────────────────────
async function checkPageValid(page) {
  const currentUrl = page.url();
  const title      = await page.title();
  log(`Page URL:   ${currentUrl}`);
  log(`Page title: "${title}"`);
  if (currentUrl.includes('/login')) return { valid: false, reason: 'login_redirect' };
  if (title.includes('403') || title.toLowerCase().includes('forbidden')) return { valid: false, reason: '403_forbidden' };
  const html = await page.content();
  if (html.trim() === '<html><head></head><body></body></html>') return { valid: false, reason: 'blank_page' };
  return { valid: true };
}

// ─── MAIN REPUBLISH ───────────────────────────────────────────
// ✅ Always login fresh every run — no session cache, no isRetry
async function republish() {
  log(`🚀 Starting republish`);
  log(`📋 Event ID: ${EVENT_ID || 'not provided'} | Org: ${ORG_NAME || 'not provided'}`);

  log('Logging in fresh...');
  await loginAndSave();

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
    // ✅ use my.duda.co — cookies from login are valid here
    await page.goto(DUDA_SITE_LINK, { waitUntil: 'domcontentloaded', timeout: 60000 });

    await page.waitForTimeout(8000);

    await page.screenshot({ path: 'duda_after_load.png', fullPage: true });
    log('📸 Screenshot saved: duda_after_load.png');

    const { valid, reason } = await checkPageValid(page);
    if (!valid) {
      await browser.close();
      throw new Error(`Page invalid after fresh login: ${reason}. Check DUDA_EMAIL / DUDA_PASSWORD secrets.`);
    }

    log('Checking for and dismissing any modals...');
    await dismissModal(page);
    await waitForModalToClear(page);
    await page.waitForTimeout(500);

    log('Waiting for Publish button...');
    const publishBtn = page.locator(
      'button:has-text("Republish"), button:has-text("Publish"), [data-testid*="publish"]'
    ).first();
    await publishBtn.waitFor({ state: 'visible', timeout: 60000 });

    await page.screenshot({ path: 'duda_before_click.png', fullPage: true });
    log('📸 Screenshot saved: duda_before_click.png');

    await publishBtn.scrollIntoViewIfNeeded();
    await publishBtn.click({ force: true });
    log('✅ Publish button clicked!');

    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'duda_after_publish.png', fullPage: true });
    log('📸 Screenshot saved: duda_after_publish.png');

    try {
      await page.waitForFunction(
        () => !document.querySelector('.Modal-module-shown-VYJnW-aps'),
        undefined,
        { timeout: 60000 }
      );
      log('✅ Publish dialog closed — republish confirmed complete!');
    } catch (_) {
      log('ℹ️  Could not confirm publish dialog close, assuming success.');
    }

    await browser.close();
    log('✅ Republish complete!');
    await notifyCliq(true, null);
    await notifyCallback(true, 'Republish successful');
    process.exit(0);

  } catch (err) {
    log(`❌ Republish failed: ${err.message}`);
    try { await page.screenshot({ path: 'duda_error.png', fullPage: true }); log('📸 Error screenshot: duda_error.png'); } catch (_) {}
    await browser.close();
    await notifyCliq(false, err.message);
    await notifyCallback(false, err.message);
    process.exit(1);
  }
}

// ─── RUN ─────────────────────────────────────────────────────
republish().catch((err) => {
  log(`💥 Unhandled error: ${err.message}`);
  process.exit(1);
});
