// Small robustness fixes: untrusted keys, header shapes, request de-duplication, quota recovery.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

let quotaFailures = 0;
globalThis.browser = { storage: { local: {
    get: async () => ({}),
    set: async () => { quotaFailures++; throw new Error('QUOTA_BYTES quota exceeded'); },
    remove: async () => {}
} } };
const { calculateStatistics } = await import('../src/shared/utils.js');
const { isGraphqlApiUrl, headersToObject } = await import('../src/shared/x-api-headers.js');
const { XAPIClient } = await import('../src/background/api-client.js');
const { UserCacheStorage } = await import('../src/shared/storage.js');

let checks = 0;
async function check(name, run) { await run(); checks++; console.log(`PASS ${name}`); }

await check('statistics treat "__proto__" and "constructor" as ordinary buckets', () => {
    const stats = calculateStatistics([
        { location: '__proto__', device: 'Web' }, { location: '__PROTO__' }, { location: 'constructor' },
        { location: 'toString' }, { location: 'Spain', device: 'Spain Android App' }, { location: 'spain' }
    ]);
    assert.equal(stats.countryCounts.spain, 2);
    assert.equal(Object.getOwnPropertyDescriptor(stats.countryCounts, '__proto__').value, 2);
    assert.equal(stats.countryCounts.constructor, 1);
    assert.equal(stats.countryCounts.tostring, 1);
    assert.equal(typeof stats.countryCounts.toString, 'function', 'inherited methods are not counters');
    assert.equal(Object.getPrototypeOf(stats.countryCounts), Object.prototype, 'the prototype is untouched');
    assert.equal(({}).polluted, undefined);
    assert.deepEqual(stats.topCountries.map(entry => entry.country).slice(0, 2), ['__proto__', 'spain']);
    assert.equal(stats.deviceCounts.Web, 1);
});

await check('X GraphQL URLs are recognized on both domains, and nothing else', () => {
    for (const url of ['https://x.com/i/api/graphql/abc/HomeTimeline?x=1', 'https://twitter.com/i/api/graphql/a/B',
        'https://api.x.com/i/api/graphql/a/B', new URL('https://x.com/i/api/graphql/a/B')]) {
        assert.equal(isGraphqlApiUrl(url), true, String(url));
    }
    for (const url of ['/i/api/graphql/a/AboutAccountQuery', 'https://evilx.com/i/api/graphql/a', 'https://x.com.evil.example/i/api/graphql/a',
        'https://example.com/?u=https://x.com/i/api/graphql/a', 'https://x.com/i/api/1.1/friendships/create.json', '', null, undefined]) {
        assert.equal(isGraphqlApiUrl(url), false, String(url));
    }
});

await check('request headers are understood as a Headers object, a plain object or name/value pairs', () => {
    const want = { authorization: 'Bearer t', 'x-csrf-token': 'c' };
    assert.deepEqual(headersToObject(new Headers(want)), want);
    assert.deepEqual(headersToObject(want), want);
    assert.deepEqual(headersToObject([['authorization', 'Bearer t'], ['x-csrf-token', 'c']]), want);
    assert.deepEqual(headersToObject([['a', 1], 'junk', [], [5, 'x']]), { a: '1' });
    assert.equal(headersToObject(null), null);
    assert.equal(headersToObject('text'), null);
});

await check('one in-flight request serves every spelling of a handle', async () => {
    const api = new XAPIClient({ get: async () => ({}), set: async () => {} });
    api.setHeaders({ authorization: 'Bearer x', 'x-csrf-token': 'y' });
    let calls = 0;
    globalThis.fetch = async () => {
        calls++;
        return { ok: true, status: 200, headers: new Headers(), json: async () => ({ data: { user_result_by_screen_name: { result: {
            __typename: 'User', core: { screen_name: 'Foo' }, about_profile: { account_based_in: 'Spain' } } } } }) };
    };
    const [a, b, c] = await Promise.all([api.fetchUserInfo('Foo'), api.fetchUserInfo('foo'), api.fetchUserInfo('FOO')]);
    assert.equal(calls, 1);
    assert.equal(a.location, 'Spain');
    assert.equal(b, a);
    assert.equal(c, a);
});

await check('an evicted request finishing cannot remove a newer one for the same key', async () => {
    const api = new XAPIClient({ get: async () => ({}), set: async () => {} });
    const dedupe = api.deduplicator;
    dedupe.maxSize = 1;
    const later = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
    const first = later();
    const second = later();
    const third = later();
    const p1 = dedupe.dedupe('k', () => first.promise);
    const p2 = dedupe.dedupe('other', () => second.promise);   // capacity: evicts 'k'
    const p3 = dedupe.dedupe('k', () => third.promise);        // the same key again, a new request
    first.resolve('one');
    await p1;
    assert.equal(dedupe.has('k'), true, 'the running request for the same key is still tracked');
    second.resolve('two'); third.resolve('three');
    await Promise.all([p2, p3]);
    assert.equal(dedupe.size, 0);
});

await check('quota recovery sheds a bounded part of the cache, never all of it', async () => {
    const cache = new UserCacheStorage();
    for (let i = 0; i < 100; i++) cache.set(`user${i}`, { location: 'Spain', device: 'Web', timestamp: Date.now() - 1000 });
    quotaFailures = 0;
    assert.equal(await cache.save(true), false);
    clearTimeout(cache.saveTimeoutId);
    assert.ok(quotaFailures <= 4, `write attempts: ${quotaFailures}`);
    assert.ok(cache.cache.size >= 40 && cache.cache.size < 100, `entries left: ${cache.cache.size}`);
});

await check('a cookie value containing "=" is read whole', () => {
    const source = fs.readFileSync(new URL('../src/content/content-script.js', import.meta.url), 'utf8');
    const getCsrfToken = new vm.Script(`(document => { ${source.match(/function getCsrfToken\(\)[\s\S]*?\n}\n/)[0]}; return getCsrfToken(); })`);
    const read = cookie => getCsrfToken.runInNewContext({})({ cookie });
    assert.equal(read('a=1; ct0=abc==; b=2'), 'abc==');
    assert.equal(read('ct0=plain'), 'plain');
    assert.equal(read('xct0=no; other=ct0=nope'), null);
    assert.equal(read(''), null);
});

console.log(`${checks} hardening checks passed.`);
process.exit(0);
