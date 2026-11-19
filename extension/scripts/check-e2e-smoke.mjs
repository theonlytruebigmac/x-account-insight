/**
 * Loads the actual built Chrome extension in a real (headless) browser and checks
 * that the popup and options pages render without errors. Catches the class of bug
 * the other check:*.mjs scripts can't: a real runtime/DOM/manifest mistake that only
 * shows up once the bundle is actually loaded by a browser.
 *
 * Requires `npm run build:chrome` first, and a Chromium build Playwright can launch
 * (CI installs one via `npx playwright install --with-deps chromium`).
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const extPath = join(import.meta.dirname, '..', 'dist', 'chrome');
if (!existsSync(extPath)) {
    console.error(`Error: ${extPath} not found. Run "npm run build:chrome" first.`);
    process.exit(1);
}

const userDataDir = await mkdtemp(join(tmpdir(), 'xai-e2e-'));
const consoleErrors = [];
let context;

try {
    context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        args: [
            `--disable-extensions-except=${extPath}`,
            `--load-extension=${extPath}`,
            '--headless=new',
            '--no-sandbox'
        ]
    });

    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 10000 });
    const extensionId = new URL(sw.url()).host;

    const onConsole = msg => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
    };

    const popup = await context.newPage();
    popup.on('console', onConsole);
    popup.on('pageerror', error => consoleErrors.push(error.message));
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await popup.waitForSelector('#extension-state[data-state]:not([data-state="loading"])', { timeout: 5000 });
    assert.equal(await popup.title(), 'X Account Insight', 'Popup title');
    assert.equal(await popup.locator('h1').textContent(), 'X Account Insight', 'Popup heading');
    assert.ok(await popup.locator('#update-banner').isHidden(), 'Update banner hidden with no known update');
    console.log('PASS popup renders with the expected title, heading and no update banner');

    const options = await context.newPage();
    options.on('console', onConsole);
    options.on('pageerror', error => consoleErrors.push(error.message));
    await options.goto(`chrome-extension://${extensionId}/options/options.html`);
    await options.waitForSelector('[data-target="panel-about"]', { timeout: 5000 });
    await options.click('[data-target="panel-about"]');
    assert.equal(await options.title(), 'X Account Insight Settings', 'Options title');
    await assert.doesNotReject(options.locator('#btn-check-update').waitFor({ timeout: 2000 }),
        'Check-for-updates button renders in the About panel');
    console.log('PASS options page renders with the expected title and About panel controls');

    await popup.close();
    await options.close();
} finally {
    await context?.close();
    await rm(userDataDir, { recursive: true, force: true });
}

assert.deepEqual(consoleErrors, [], `No console errors while loading the popup/options pages, got: ${JSON.stringify(consoleErrors)}`);
console.log('2 e2e smoke checks passed. No console errors.');
