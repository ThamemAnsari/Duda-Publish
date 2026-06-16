/**
 * login.js — Refresh Duda Session
 * ================================
 * Run this locally on your Mac whenever GitHub Actions
 * starts failing with 403/500 (session expired).
 *
 * Usage:
 *   DUDA_EMAIL=you@email.com DUDA_PASSWORD=yourpass node login.js
 *
 * It will:
 *   1. Open a real browser window
 *   2. Log in to Duda
 *   3. Save session to duda_auth.json
 *   4. Print the new DUDA_AUTH_BASE64 to copy into GitHub Secrets
 */

const fs   = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DUDA_EMAIL    = process.env.DUDA_EMAIL    || '';
const DUDA_PASSWORD = process.env.DUDA_PASSWORD || '';
const DUDA_SITE     = process.env.DUDA_SITE     || '3f4c882c';
const SITE_URL      = process.argv[2]
  || process.env.DUDA_SITE_URL
  || `https://infocc3969fa.dudasitebuilder.com/home/site/${DUDA_SITE}/home`;
const AUTH_FILE     = path.resolve(__dirname, 'duda_auth.json');
const CHROME_UA     = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function login() {
  console.log('🔐 Opening browser for Duda login...');
  console.log(`   Site: ${SITE_URL}`);

  // headless: false so you can see the browser and handle 2FA if needed
  const browser = await chromium.launch({
    headless: false,
    args: ['--window-size=1366,768'],
  });

  const context = await browser.newContext({
    viewport:  { width: 1366, height: 768 },
    userAgent: CHROME_UA,
  });

  const page = await context.newPage();

  // Stealth
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  let loginUrl = 'https://my.duda.co/login';
  try {
    const urlObj = new URL(SITE_URL);
    loginUrl = `${urlObj.origin}/login`;
  } catch (err) {
    console.log(`⚠️ Failed to parse SITE_URL: ${err.message}, defaulting to ${loginUrl}`);
  }

  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Auto-fill credentials if provided
  if (DUDA_EMAIL && DUDA_PASSWORD) {
    try {
      await page.waitForSelector('input[type="email"]', { timeout: 5000 });
      await page.fill('input[type="email"]', DUDA_EMAIL);
      await page.fill('input[type="password"]', DUDA_PASSWORD);
      await page.locator('button[type="submit"]')
        .filter({ hasNotText: 'Google' })
        .first()
        .click();
      console.log('✅ Credentials filled — waiting for login...');
    } catch (_) {
      console.log('⚠️  Could not auto-fill — please login manually in the browser');
    }
  } else {
    console.log('⚠️  No credentials set — please login manually in the browser');
  }

  console.log('⏳ Waiting for you to complete login (up to 3 minutes)...');
  console.log('   (Complete any 2FA or CAPTCHA in the browser window)');

  // Wait until logged in
  await page.waitForFunction(
    () => window.location.href.includes('/home') && !window.location.href.includes('/login'),
    { timeout: 180000 }
  );

  console.log('✅ Login successful!');
  console.log('💾 Saving session...');

  try {
    console.log(`🔗 Navigating to site URL: ${SITE_URL}`);
    await page.goto(SITE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
  } catch (err) {
    console.log(`⚠️ Warning: Navigation to site URL failed: ${err.message}`);
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
    console.log('🧹 Session file pruned successfully (removed tracking cookies & localStorage).');
  } catch (err) {
    console.log(`⚠️ Warning: Failed to prune session file: ${err.message}`);
  }

  // Print new base64
  const b64 = Buffer.from(fs.readFileSync(AUTH_FILE, 'utf8')).toString('base64');

  // Save base64 version to file
  try {
    fs.writeFileSync(path.resolve(__dirname, 'duda_auth_b64.txt'), b64);
    console.log('💾 base64 session version saved to duda_auth_b64.txt');
  } catch (err) {
    console.log(`⚠️ Warning: Failed to save base64 version to file: ${err.message}`);
  }

  console.log('\n' + '─'.repeat(60));
  console.log('✅ Session saved! Copy this into GitHub Secrets:');
  console.log('   Secret name: DUDA_AUTH_BASE64');
  console.log('─'.repeat(60));
  console.log('\n' + b64 + '\n');
  console.log('─'.repeat(60));
  console.log('\nSteps:');
  console.log('1. Copy the base64 string above');
  console.log('2. Go to: github.com/ThamemAnsari/Duda-Publish/settings/secrets/actions');
  console.log('3. Click DUDA_AUTH_BASE64 → Update secret → Paste → Save');
  console.log('4. Re-run the failed GitHub Actions workflow');
  console.log('─'.repeat(60) + '\n');
}

login().catch(err => {
  console.error('❌ Login failed:', err.message);
  process.exit(1);
});