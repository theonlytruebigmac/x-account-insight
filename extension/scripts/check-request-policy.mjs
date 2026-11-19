import assert from 'node:assert/strict';
import {
    mergeRateLimitBudget, PacedLookupQueue, rateLimitIntervalMs, readRateLimitBudget
} from '../src/shared/request-policy.js';

const now = 1_800_000_000_000;
const headers = values => ({ get: name => values[name.toLowerCase()] ?? null });

assert.deepEqual(readRateLimitBudget(headers({
    'x-rate-limit-reset': String((now + 900_000) / 1000),
    'x-rate-limit-remaining': '80',
    'x-rate-limit-limit': '100'
}), now), {
    resetTime: now + 900_000,
    remaining: 80,
    limit: 100
});
assert.equal(readRateLimitBudget(headers({ 'x-rate-limit-remaining': '80' }), now), null);

const first = { resetTime: now + 900_000, remaining: 80, limit: 100 };
assert.deepEqual(mergeRateLimitBudget(first, {
    resetTime: first.resetTime, remaining: 75, limit: 100
}, now), { ...first, remaining: 75 });
assert.deepEqual(mergeRateLimitBudget(first, {
    resetTime: first.resetTime - 1000, remaining: 99, limit: 100
}, now), first);
assert.equal(rateLimitIntervalMs(first, now), Math.ceil(900_000 / 65));
assert.equal(rateLimitIntervalMs({
    resetTime: now + 900_000, remaining: 15, limit: 100
}, now), 900_000);
assert.equal(rateLimitIntervalMs(first, now, 0), Math.ceil(900_000 / 80));

globalThis.browser = { storage: { local: { get: async () => ({}), set: async () => {} } } };
const { API_ERROR_CODES, XAPIClient } = await import('../src/background/api-client.js');
delete globalThis.browser;
const apiClient = new XAPIClient({ get: async () => ({}), set: async () => {} });
const resetTime = Date.now() + 60_000;
await apiClient.recordRateLimitState({
    budget: { resetTime, remaining: 2, limit: 10 }
});
assert.equal(apiClient.getRateLimitStatus().isRateLimited, false);
await assert.rejects(apiClient.reservePageLookupSlot(), error =>
    error.code === API_ERROR_CODES.RATE_LIMITED && error.deferred && error.retryAfter === resetTime);
assert.deepEqual(await apiClient.reservePageLookupSlot({ priority: true }), { waitMs: 0 });
await assert.rejects(apiClient.reservePageLookupSlot({ priority: true }), error =>
    error.code === API_ERROR_CODES.RATE_LIMITED && error.deferred && error.retryAfter > Date.now());

const queue = new PacedLookupQueue({ minIntervalMs: 0, maxConcurrent: 1 });
const started = [];
let releaseFirst;
const firstRequest = queue.add(async () => {
    started.push('first');
    await new Promise(resolve => { releaseFirst = resolve; });
});
await new Promise(resolve => setTimeout(resolve, 0));
const normalRequest = queue.add(() => { started.push('normal'); });
const priorityRequest = queue.add(() => { started.push('priority'); }, { priority: true });
releaseFirst();
await Promise.all([firstRequest, normalRequest, priorityRequest]);
assert.deepEqual(started, ['first', 'priority', 'normal']);

console.log('PASS request-policy budget parsing, conservative merging, and pacing');
