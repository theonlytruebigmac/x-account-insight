// Community-cache client regression checks. No live requests: fetch and storage are stubbed.
import assert from 'node:assert/strict';

const store = {};
globalThis.browser = {
    storage: {
        local: {
            async get(keys) {
                const list = Array.isArray(keys) ? keys : [keys];
                return Object.fromEntries(list.filter(k => k in store).map(k => [k, structuredClone(store[k])]));
            },
            async set(values) { Object.assign(store, structuredClone(values)); },
            async remove(key) { delete store[key]; }
        }
    },
    runtime: {}
};

let requests = [];
let respond = () => ({ status: 200, body: { accepted: undefined } });
globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url: String(url), method: options.method || 'GET', body });
    const { status = 200, body: payload = {}, headers = {} } = respond(String(url), body) || {};
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(headers),
        json: async () => payload,
        text: async () => JSON.stringify(payload)
    };
};

const { default: singleton } = await import('../src/background/cloud-cache.js');
const { buildContributionEntry } = await import('../src/background/cloud-cache.js');
const { STORAGE_KEYS, affiliationWasChecked } = await import('../src/shared/constants.js');
const Client = singleton.constructor;

const nowSec = () => Math.floor(Date.now() / 1000);
const DAY = 24 * 60 * 60 * 1000;

async function freshClient() {
    for (const key of Object.keys(store)) delete store[key];
    store[STORAGE_KEYS.CLOUD_CACHE_ENABLED] = true;
    store[STORAGE_KEYS.CLOUD_CACHE_API_KEY] = 'xic_test';
    const client = new Client();
    await client.init();
    requests = [];
    respond = () => ({ status: 200, body: {} });
    return client;
}

function observed(extra = {}) {
    return { location: 'Germany', device: 'Android', locationAccurate: true, timestamp: Date.now() - 1000, fromCloud: false, ...extra };
}

function stopTimers(client) {
    clearTimeout(client.contributeTimeout);
    client.contributeTimeout = null;
}

const checks = [];
function check(name, fn) { checks.push([name, fn]); }

check('cloud record without `af` keeps affiliation unknown; with `af` it is checked', async () => {
    const client = await freshClient();
    respond = () => ({ body: { results: {
        lean: { l: 'Germany', d: 'iOS', a: true, t: nowSec(), id: '123' },
        rich: { l: 'France', d: 'iOS', a: true, t: nowSec(), af: 'Acme' },
        unaffiliated: { l: 'Italy', d: 'Web', a: true, t: nowSec(), af: '' }
    }, misses: [] } });
    const results = await client.fetchLookup(['lean', 'rich', 'unaffiliated']);
    assert.equal(results.get('lean').meta.restId, '123');
    assert.equal(affiliationWasChecked(results.get('lean').meta), false);
    assert.equal(affiliationWasChecked(results.get('rich').meta), true);
    assert.equal(results.get('rich').meta.affiliate.name, 'Acme');
    assert.equal(affiliationWasChecked(results.get('unaffiliated').meta), true);
    assert.equal(buildContributionEntry(observed({ meta: { affiliateUsername: null } })).af, '');
});

check('shared negative lookup is returned as not-found and avoids a cache miss', async () => {
    const client = await freshClient();
    respond = () => ({ body: { results: {}, notFound: { unavailable: { t: nowSec() } }, misses: [] } });
    const results = await client.fetchLookup(['unavailable']);
    assert.deepEqual(results.get('unavailable').notFound, true);
    assert.equal(client.getStats().notFoundHits, 1);
    assert.equal(client.recentMisses.has('unavailable'), false);
});

check('confirmed X not-found results use the durable contribution queue', async () => {
    const client = await freshClient();
    await client.contributeNotFound('unavailable');
    stopTimers(client);
    await client.forceSaveQueue();
    respond = () => ({ body: { accepted: 1 } });
    await client.flushContributions();
    stopTimers(client);
    const sent = requests[0].body.entries.unavailable;
    assert.equal(sent.nf, true);
    assert.ok(Math.abs(sent.t - nowSec()) <= 1);
    assert.equal(client.contributionQueue.size, 0);
});

check('contribution carries observation time and shared meta; accepted: 0 counts as 0', async () => {
    const client = await freshClient();
    const data = observed({ meta: { affiliate: { name: 'Acme' }, restId: '42', createdAt: '2010-01-01T00:00:00Z', usernameChanges: 2 } });
    await client.contribute('Alice', data);
    stopTimers(client);
    respond = () => ({ body: { accepted: 0 } });
    await client.flushContributions();
    stopTimers(client);
    assert.equal(requests.length, 1);
    const entry = requests[0].body.entries.alice;
    assert.deepEqual(entry, { a: true, t: Math.floor(data.timestamp / 1000), l: 'Germany', d: 'Android',
        af: 'Acme', c: 1262304000, id: '42', uc: 2 });
    assert.equal(client.getStats().contributions, 0);
    assert.equal(client.contributionQueue.size, 0);
});

check('disabling the cache drops queued uploads and their persisted copy', async () => {
    const client = await freshClient();
    await client.contribute('bob', observed());
    await client.forceSaveQueue();
    assert.ok(store[STORAGE_KEYS.CLOUD_PENDING_CONTRIBUTIONS]?.bob);
    await client.setEnabled(false);
    await client.flushContributions();
    assert.equal(requests.length, 0);
    assert.equal(client.contributionQueue.size, 0);
    assert.equal(STORAGE_KEYS.CLOUD_PENDING_CONTRIBUTIONS in store, false);
});

check('large queues are sent in server-sized chunks', async () => {
    const client = await freshClient();
    for (let i = 0; i < 450; i++) {
        client.contributionQueue.set(`user${i}`, { l: 'Germany', a: true, t: nowSec() });
    }
    for (let i = 0; i < 3; i++) {
        await client.flushContributions();
        stopTimers(client);
    }
    assert.deepEqual(requests.map(r => Object.keys(r.body.entries).length), [200, 200, 50]);
    assert.equal(client.contributionQueue.size, 0);
});

check('pending contributions survive a restart; expired ones are dropped', async () => {
    const client = await freshClient();
    await client.contribute('carol', observed());
    stopTimers(client);
    await client.forceSaveQueue();
    store[STORAGE_KEYS.CLOUD_PENDING_CONTRIBUTIONS].stale = { l: 'Spain', a: true, t: nowSec() - 90 * DAY / 1000 };

    const restarted = new Client();
    await restarted.init();
    stopTimers(restarted);
    assert.deepEqual([...restarted.contributionQueue.keys()], ['carol']);
});

check('a rejected key pauses uploads and lookups without dropping the queue', async () => {
    const client = await freshClient();
    await client.contribute('dave', observed());
    stopTimers(client);
    respond = () => ({ status: 401 });
    await client.flushContributions();
    stopTimers(client);
    assert.equal(client.getConnectionStatus().state, 'unauthorized');
    assert.equal(client.contributionQueue.size, 1);

    requests = [];
    await client.flushContributions();
    stopTimers(client);
    const lookup = await client.lookup(['dave']);
    assert.equal(requests.length, 0);
    assert.equal(lookup.size, 0);

    await client.setApiKey('xic_new');
    stopTimers(client);
    assert.equal(client.getConnectionStatus().state, 'unknown');
});

check('a 400 batch is dropped; a 5xx batch is kept for retry', async () => {
    const client = await freshClient();
    await client.contribute('erin', observed());
    stopTimers(client);
    respond = () => ({ status: 503 });
    await client.flushContributions();
    stopTimers(client);
    assert.equal(client.contributionQueue.size, 1);
    assert.equal(client.getConnectionStatus().state, 'unreachable');

    client.backoffUntil = 0;
    respond = () => ({ status: 400 });
    await client.flushContributions();
    stopTimers(client);
    assert.equal(client.contributionQueue.size, 0);
});

check('a server 429 blocks the bucket until Retry-After', async () => {
    const client = await freshClient();
    await client.contribute('frank', observed());
    stopTimers(client);
    respond = () => ({ status: 429, headers: { 'retry-after': '30' } });
    await client.flushContributions();
    stopTimers(client);
    assert.ok(client.contributeBucket.waitMs() > 25000);
    requests = [];
    await client.flushContributions();
    stopTimers(client);
    assert.equal(requests.length, 0);
    assert.equal(client.contributionQueue.size, 1);
});

check('dedup skips data the cloud already holds but always sends richer data', async () => {
    const client = await freshClient();
    respond = () => ({ body: { results: { gina: { l: 'Germany', d: 'Android', a: true, t: nowSec() } }, misses: [] } });
    await client.fetchLookup(['gina']);
    await client.contribute('gina', observed());
    assert.equal(client.contributionQueue.size, 0);
    await client.contribute('gina', observed({ meta: { affiliate: { name: 'Acme' } } }));
    stopTimers(client);
    assert.equal(client.contributionQueue.get('gina').af, 'Acme');
});

check('an exhausted lookup budget defers the batch instead of answering empty', async () => {
    const client = await freshClient();
    client.lookupBucket.tokens = 0.95; // ~60ms until the next token
    respond = () => ({ body: { results: { hank: { l: 'Japan', d: 'iOS', a: true, t: nowSec() } }, misses: [] } });
    const results = await client.lookup(['hank']);
    assert.equal(requests.length, 1);
    assert.equal(results.get('hank')?.location, 'Japan');
});

check('a recent cloud miss is not re-requested immediately', async () => {
    const client = await freshClient();
    respond = () => ({ body: { results: {}, misses: ['ivy'] } });
    await client.lookup(['ivy']);
    await client.lookup(['ivy']);
    assert.equal(requests.length, 1);
});

check('bulk sync sends meta and the original observation time in server-sized chunks', async () => {
    const client = await freshClient();
    const old = Date.now() - 10 * DAY;
    const entries = {};
    for (let i = 0; i < 250; i++) {
        entries[`bulk${i}`] = observed({ timestamp: old, meta: { affiliate: { name: 'Acme' }, restId: String(i + 1) } });
    }
    entries.fromcloud = observed({ fromCloud: true });
    const result = await client.bulkSync(entries);
    assert.deepEqual(requests.map(r => Object.keys(r.body.entries).length), [200, 50]);
    const sample = requests[0].body.entries.bulk0;
    assert.equal(sample.t, Math.floor(old / 1000));
    assert.equal(sample.af, 'Acme');
    assert.equal(sample.id, '1');
    assert.equal(result.synced, 250);
    assert.equal(result.skipped, 1);
});

let failed = 0;
for (const [name, fn] of checks) {
    try {
        await fn();
        console.log(`PASS ${name}`);
    } catch (error) {
        failed++;
        console.error(`FAIL ${name}\n`, error);
    }
}
if (failed) {
    console.error(`${failed} cloud-cache check(s) failed.`);
    process.exit(1);
}
console.log(`${checks.length} cloud-cache checks passed. No live requests were used.`);
// Debounced storage writes keep timers alive; nothing else is pending.
process.exit(0);
