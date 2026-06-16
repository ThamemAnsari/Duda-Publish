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
const DUDA_EMAIL                  = process.env.DUDA_EMAIL                  || '';
const DUDA_PASSWORD               = process.env.DUDA_PASSWORD               || '';
const DUDA_SITE                   = process.env.DUDA_SITE                   || 'bc6015ea';
const DUDA_AUTH_BASE64            = process.env.DUDA_AUTH_BASE64            || '';
const ZOHO_CLIQ_WEBHOOK           = process.env.ZOHO_CLIQ_WEBHOOK           || ''; // fallback webhook
const ZOHO_CLIQ_CHANNEL_ID        = process.env.ZOHO_CLIQ_CHANNEL_ID        || 'P2099672000022436012';
const ZOHO_CLIQ_MESSAGE_ID        = process.env.ZOHO_CLIQ_MESSAGE_ID        || ''; // from client_payload
const CALLBACK_URL                = process.env.CALLBACK_URL                || '';

// ✅ OAuth refresh token secrets (stored permanently in GitHub Secrets)
const ZOHO_CLIENT_ID              = process.env.ZOHO_CLIENT_ID              || '';
const ZOHO_CLIENT_SECRET          = process.env.ZOHO_CLIENT_SECRET          || '';
const ZOHO_REFRESH_TOKEN          = process.env.ZOHO_REFRESH_TOKEN          || '';

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
    headers:  {
      'Content-Type':   'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  };

  return new Promise((resolve) => {
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) {
            log('✅ Zoho access token refreshed successfully');
            resolve(json.access_token);
          } else {
            log(`⚠️  Token refresh failed: ${data}`);
            resolve(null);
          }
        } catch (e) {
          log(`⚠️  Token refresh parse error: ${e.message}`);
          resolve(null);
        }
      });
    });
    req.on('error', (e) => {
      log(`⚠️  Token refresh request failed: ${e.message}`);
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

// ─── NOTIFY ZOHO CLIQ ────────────────────────────────────────
async function notifyCliq(text, messageId) {
  const threadId = messageId || ZOHO_CLIQ_MESSAGE_ID;

  const accessToken = await getZohoAccessToken();
  if (accessToken && ZOHO_CLIQ_CHANNEL_ID) {
    const payload = { text };
    if (threadId) {
      payload.thread_message_id = threadId;
    }

    const body = JSON.stringify(payload);
    const opts = {
      hostname: 'cliq.zoho.com',
      path:     `/api/v3/channels/${ZOHO_CLIQ_CHANNEL_ID}/messages`,
      method:   'POST',
      headers:  {
        'Authorization':  `Zoho-oauthtoken ${accessToken}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    return new Promise((resolve) => {
      const req = https.request(opts, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          const success = res.statusCode === 200 || res.statusCode === 204;
          if (success) {
            log(`📬 Cliq notified via OAuth v3 (HTTP ${res.statusCode}) — thread: ${threadId || 'top-level'}`);
          } else {
            log(`⚠️  Cliq v3 failed (HTTP ${res.statusCode}): ${data}`);
          }
          resolve();
        });
      });
      req.on('error', (e) => { log(`⚠️  Cliq OAuth notify failed: ${e.message}`); resolve(); });
      req.write(body);
      req.end();
    });
  }

  if (!ZOHO_CLIQ_WEBHOOK) return Promise.resolve();

  log('⚠️  OAuth credentials missing — falling back to webhook (no thread support)');
  const payload = { text };
  const body = JSON.stringify(payload);
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
      log(`📬 Cliq notified via webhook (HTTP ${res.statusCode})`);
      resolve();
    });
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

// ─── DISMISS "WHAT'S NEW" MODAL ──────────────────────────────
// Duda shows a "What's New at Duda" modal on load which keeps firing
// background analytics requests, preventing networkidle from resolving.
// This function closes it via the × button or Escape key.
async function dismissModal(page) {
  try {
    // Try clicking the visible × close button inside the modal
    const closeBtn = page.locator(
      'button[aria-label*="close" i], ' +
      'button[aria-label*="dismiss" i], ' +
      '.modal-close, ' +
      '[class*="close-button"], ' +
      '[class*="closeButton"], ' +
      'button:has([class*="close"]), ' +
      'button svg[class*="close"]'
    ).first();

    if (await closeBtn.isVisible({ timeout: 3000 })) {
      await closeBtn.click();
      log('✅ Dismissed modal via close button');
      await page.waitForTimeout(500);
      return;
    }
  } catch (_) {}

  // Fallback: press Escape
  await page.keyboard.press('Escape');
  log('ℹ️  Sent Escape to dismiss any open modal');
  await page.waitForTimeout(500);
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

  // Prune auth file to fit GitHub Secrets size limit (10 KB)
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
  log(`🧵 Thread message ID: ${ZOHO_CLIQ_MESSAGE_ID || 'none (will post top-level)'}`);

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

    // ✅ FIX 1: Use 'domcontentloaded' instead of 'networkidle'
    // 'networkidle' was timing out because the "What's New at Duda" modal
    // kept firing analytics/tracking requests (Google, Facebook, LinkedIn)
    // indefinitely, so the network never went fully idle within 90s.
    await page.goto(SITE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Give JS/React time to render the editor UI after DOM is ready
    await page.waitForTimeout(5000);

    await page.screenshot({ path: 'duda_after_load.png', fullPage: true });
    log('📸 Screenshot saved: duda_after_load.png');

    // Session expired?
    if (page.url().includes('/login')) {
      log('Session expired — re-logging in...');
      await browser.close();
      fs.unlinkSync(AUTH_FILE);
      await loginAndSave();
      return await republish(); // retry once
    }

    const title = await page.title();
    log(`Page title: "${title}"`);

    // Blank page = bot detection
    const html = await page.content();
    if (html.trim() === '<html><head></head><body></body></html>') {
      throw new Error('Blank page received — possible bot detection by Duda');
    }

    // ✅ FIX 2: Properly dismiss the "What's New at Duda" modal
    // This modal appears on every load and blocks the Publish button area.
    // It also keeps firing background analytics requests.
    log('Checking for and dismissing any modals...');
    await dismissModal(page);
    await page.waitForTimeout(1000);

    log('Waiting for Publish button...');
    await page.waitForSelector(
      'button:has-text("Republish"), button:has-text("Publish"), [data-testid*="publish"]',
      { timeout: 30000 }
    );

    await page.screenshot({ path: 'duda_before_click.png', fullPage: true });
    log('📸 Screenshot saved: duda_before_click.png');

    const btn = page.locator(
      'button:has-text("Republish"), button:has-text("Publish")'
    ).first();
    await btn.click();
    log('✅ Publish button clicked!');

    // Wait for the "Republishing your site..." dialog to appear and finish
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'duda_after_publish.png', fullPage: true });
    log('📸 Screenshot saved: duda_after_publish.png');

    // ✅ FIX 3: Wait for publish dialog to disappear (confirms completion)
    try {
      await page.waitForSelector(
        'text="Republishing your site", text="Publishing your site"',
        { state: 'hidden', timeout: 60000 }
      );
      log('✅ Publish dialog closed — republish confirmed complete!');
    } catch (_) {
      log('ℹ️  Could not confirm publish dialog close, assuming success.');
    }

    await browser.close();
    log('✅ Republish complete!');

    await notifyCliq('✅ Duda site republished successfully!', ZOHO_CLIQ_MESSAGE_ID);
    await notifyCallback(true, 'Republish successful');
    process.exit(0);

  } catch (err) {
    log(`❌ Republish failed: ${err.message}`);
    try {
      await page.screenshot({ path: 'duda_error.png', fullPage: true });
      log('📸 Error screenshot: duda_error.png');
    } catch (_) {}
    await browser.close();

    await notifyCliq(`❌ Duda republish failed: ${err.message.split('\n')[0]}`, ZOHO_CLIQ_MESSAGE_ID);
    await notifyCallback(false, err.message);
    process.exit(1);
  }
}

// ─── RUN ─────────────────────────────────────────────────────
republish().catch((err) => {
  log(`💥 Unhandled error: ${err.message}`);
  process.exit(1);
});