// Update-check regression checks. No live requests: fetch, storage and alarms are stubbed.
import assert from 'node:assert/strict';

const store = {};
const alarms = { listeners: 0, created: [], handlers: [] };
globalThis.browser = {
    storage: { local: {
        async get(key) { return key in store ? { [key]: structuredClone(store[key]) } : {}; },
        async set(values) { Object.assign(store, structuredClone(values)); }
    } },
    alarms: {
        create: (name, info) => { alarms.created = alarms.created.filter(([existing]) => existing !== name); alarms.created.push([name, info]); },
        get: async name => alarms.created.find(([existing]) => existing === name)?.[1],
        onAlarm: { addListener: handler => { alarms.listeners++; alarms.handlers.push(handler); } }
    }
};

let fetches = 0;
let reply = () => ({ ok: true, status: 200, body: { tag_name: 'v99.0.0', html_url: 'https://github.com/o/r/releases/tag/v99.0.0' } });
globalThis.fetch = async () => {
    fetches++;
    const { ok, status, body } = reply();
    return { ok, status, json: async () => body };
};

const { default: updateCheck, isNewer, safeReleaseUrl } = await import('../src/background/update-check.js');
const { STORAGE_KEYS, UPDATE_CHECK_CONFIG, VERSION } = await import('../src/shared/constants.js');
const KEY = STORAGE_KEYS.UPDATE_INFO;
const reset = () => { delete store[KEY]; fetches = 0; };
let checks = 0;
async function check(name, run) { reset(); await run(); checks++; console.log(`PASS ${name}`); }

await check('worker restarts reuse the stored result instead of asking GitHub again', async () => {
    for (let wake = 0; wake < 5; wake++) await updateCheck.checkNow();
    assert.equal(fetches, 1);
    assert.equal((await updateCheck.getStatus()).updateAvailable, true);
});

await check('concurrent checks share one request', async () => {
    await Promise.all([updateCheck.checkNow(), updateCheck.checkNow(), updateCheck.checkNow()]);
    assert.equal(fetches, 1);
});

await check('a user-requested check always asks, and an old result is refreshed', async () => {
    await updateCheck.checkNow();
    await updateCheck.checkNow({ force: true });
    assert.equal(fetches, 2);
    store[KEY].checkedAt = Date.now() - (UPDATE_CHECK_CONFIG.CHECK_INTERVAL_MINUTES * 60_000 + 1000);
    await updateCheck.checkNow();
    assert.equal(fetches, 3);
});

await check('a failed re-check keeps the update that an earlier check found', async () => {
    await updateCheck.checkNow();
    reply = () => ({ ok: false, status: 403, body: {} });
    const failed = await updateCheck.checkNow({ force: true });
    assert.equal(failed.error, 'GitHub API responded with 403');
    assert.equal(failed.updateAvailable, true);
    assert.equal(failed.latestVersion, '99.0.0');
    assert.match(failed.releaseUrl, /releases\/tag\/v99\.0\.0$/);
    const status = await updateCheck.getStatus();
    assert.equal(status.updateAvailable, true);
    assert.equal(status.latestVersion, '99.0.0');
    reply = () => ({ ok: true, status: 200, body: { tag_name: 'v99.0.0', html_url: 'https://github.com/o/r/releases/tag/v99.0.0' } });
});

await check('after a failure the next automatic attempt waits, then retries', async () => {
    reply = () => ({ ok: false, status: 403, body: {} });
    await updateCheck.checkNow();
    await updateCheck.checkNow();
    assert.equal(fetches, 1, 'no hammering a rate-limited API on every worker start');
    store[KEY].checkedAt = Date.now() - 16 * 60_000;
    await updateCheck.checkNow();
    assert.equal(fetches, 2);
    reply = () => ({ ok: true, status: 200, body: { tag_name: 'v99.0.0', html_url: 'https://github.com/o/r/releases/tag/v99.0.0' } });
});

await check('availability follows the running version, not the moment of the check', async () => {
    store[KEY] = { checkedAt: Date.now(), latestVersion: VERSION, releaseUrl: 'https://github.com/o/r', updateAvailable: true, error: null };
    assert.equal((await updateCheck.getStatus()).updateAvailable, false, 'a stored flag cannot outlive an update');
    assert.equal(isNewer('4.6.0', '4.5.0'), true);
    assert.equal(isNewer('4.5.0', '4.5.0'), false);
    assert.equal(isNewer('4.10.0', '4.9.0'), true);
});

await check('release links only ever point at the project on GitHub', async () => {
    reply = () => ({ ok: true, status: 200, body: { tag_name: 'v99.0.0', html_url: 'javascript:alert(1)' } });
    assert.equal((await updateCheck.checkNow()).releaseUrl, UPDATE_CHECK_CONFIG.RELEASES_PAGE_URL);
    store[KEY].releaseUrl = 'https://evil.example/x';
    assert.equal((await updateCheck.getStatus()).releaseUrl, UPDATE_CHECK_CONFIG.RELEASES_PAGE_URL);
    assert.equal(safeReleaseUrl('https://github.com/o/r/releases/tag/v1'), 'https://github.com/o/r/releases/tag/v1');
    assert.equal(safeReleaseUrl(undefined), UPDATE_CHECK_CONFIG.RELEASES_PAGE_URL);
    reply = () => ({ ok: true, status: 200, body: { tag_name: 'v99.0.0', html_url: 'https://github.com/o/r/releases/tag/v99.0.0' } });
});

await check('the alarm listener exists from load, and a restarted worker never re-arms the alarm', async () => {
    assert.equal(alarms.listeners, 1, 'registered synchronously at import, before any storage read');
    await updateCheck.init();
    await updateCheck.init();
    assert.equal(alarms.created.length, 1);
    const [name, info] = alarms.created[0];
    assert.equal(info.periodInMinutes, UPDATE_CHECK_CONFIG.CHECK_INTERVAL_MINUTES);
    assert.ok(info.delayInMinutes >= 60, 'the first firing is not a minute after every worker start');
    const before = JSON.stringify(alarms.created);
    for (let restart = 0; restart < 5; restart++) {
        const worker = await import(`../src/background/update-check.js?restart=${restart}`);
        await worker.default.init();
    }
    assert.equal(JSON.stringify(alarms.created), before, 'create() replaces an alarm, so it must not be called again');
    // The alarm itself is a normal, throttled check.
    reset();
    await updateCheck.checkNow();
    alarms.handlers[0]({ name });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(fetches, 1);
});

console.log(`${checks} update-check checks passed. No live requests were used.`);
