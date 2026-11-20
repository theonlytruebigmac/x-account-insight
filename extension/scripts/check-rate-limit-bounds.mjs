// A malformed, stored or forged rate-limit deadline must never disable lookups for long.
import assert from 'node:assert/strict';

globalThis.browser = { storage: { local: { get: async () => ({}), set: async () => {} } } };
const policy = await import('../src/shared/request-policy.js');
const { XAPIClient, API_ERROR_CODES } = await import('../src/background/api-client.js');
delete globalThis.browser;

const {
    MAX_RATE_LIMIT_WAIT_MS, clampRateLimitDeadline, mergeRateLimitBudget, PacedLookupQueue,
    readRateLimitBudget, readRateLimitReset, RATE_LIMIT_STORAGE_KEY, RATE_LIMIT_BUDGET_STORAGE_KEY
} = policy;
const headers = values => ({ get: name => values[name.toLowerCase()] ?? null });
const now = 1_800_000_000_000;
const LIMIT = now + MAX_RATE_LIMIT_WAIT_MS;
let checks = 0;
async function check(name, run) { await run(); checks++; console.log(`PASS ${name}`); }

await check('server-directed deadlines are bounded', () => {
    assert.equal(readRateLimitReset(headers({ 'retry-after': '99999999999' }), now), LIMIT);
    assert.equal(readRateLimitReset(headers({ 'x-rate-limit-reset': String((now + 1e13) / 1000) }), now), LIMIT);
    assert.equal(readRateLimitReset(headers({ 'retry-after': 'Fri, 31 Dec 9999 23:59:59 GMT' }), now), LIMIT);
    assert.equal(readRateLimitReset(headers({ 'x-rate-limit-reset': String((now + 900_000) / 1000) }), now), now + 900_000,
        'a normal 15-minute window is untouched');
    assert.equal(readRateLimitReset(headers({}), now), now + 60_000);
    assert.equal(readRateLimitBudget(headers({
        'x-rate-limit-reset': String((now + 1e13) / 1000), 'x-rate-limit-remaining': '5', 'x-rate-limit-limit': '10'
    }), now).resetTime, LIMIT);
});

await check('relayed budgets and queues are bounded', () => {
    assert.equal(clampRateLimitDeadline(NaN, now) !== clampRateLimitDeadline(NaN, now), true, 'unknown stays unknown');
    assert.equal(mergeRateLimitBudget(null, { resetTime: now + 1e13, remaining: 1, limit: 10 }, now).resetTime, LIMIT);
    const queue = new PacedLookupQueue();
    queue.setRateLimit(Date.now() + 1e13);
    assert.ok(queue.resetTime <= Date.now() + MAX_RATE_LIMIT_WAIT_MS);
    assert.ok(queue.resetTime > Date.now(), 'a real cooldown is still honored');
});

function client(stored) {
    const memory = { ...stored };
    const storage = {
        async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in memory).map(k => [k, memory[k]])); },
        async set(values) { Object.assign(memory, values); },
        async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete memory[key]; }
    };
    return { memory, api: new XAPIClient(storage) };
}

await check('a forged state message cannot hold the client off, in memory or in storage', async () => {
    const { memory, api } = client({});
    await api.recordRateLimitState({ resetTime: Date.now() + 1e13 });
    const status = api.getRateLimitStatus();
    assert.equal(status.isRateLimited, true);
    assert.ok(status.resetTime <= Date.now() + MAX_RATE_LIMIT_WAIT_MS);
    assert.ok(memory[RATE_LIMIT_STORAGE_KEY] <= Date.now() + MAX_RATE_LIMIT_WAIT_MS);
    await api.recordRateLimitState({ budget: { resetTime: Date.now() + 1e13, remaining: 3, limit: 10 } });
    assert.ok(memory[RATE_LIMIT_BUDGET_STORAGE_KEY].resetTime <= Date.now() + MAX_RATE_LIMIT_WAIT_MS);
});

await check('an already-poisoned stored value is discarded on startup, not re-armed on every restart', async () => {
    const { memory, api } = client({
        [RATE_LIMIT_STORAGE_KEY]: Date.now() + 1e13,
        [RATE_LIMIT_BUDGET_STORAGE_KEY]: { resetTime: Date.now() + 1e13, remaining: 0, limit: 10 }
    });
    await api.rateLimitReady;
    assert.equal(api.getRateLimitStatus().isRateLimited, false);
    assert.equal(api.rateLimitBudget, null);
    assert.equal(RATE_LIMIT_STORAGE_KEY in memory, false);
    assert.equal(RATE_LIMIT_BUDGET_STORAGE_KEY in memory, false);
    assert.deepEqual(await api.reservePageLookupSlot(), { waitMs: 0 });
});

await check('a genuine stored cooldown still survives a restart', async () => {
    const reset = Date.now() + 10 * 60_000;
    const { memory, api } = client({ [RATE_LIMIT_STORAGE_KEY]: reset });
    await api.rateLimitReady;
    assert.equal(api.getRateLimitStatus().resetTime, reset);
    assert.equal(memory[RATE_LIMIT_STORAGE_KEY], reset);
    await assert.rejects(api.reservePageLookupSlot(), error => error.code === API_ERROR_CODES.RATE_LIMITED);
});

console.log(`${checks} rate-limit bound checks passed.`);
