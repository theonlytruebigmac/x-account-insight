// Regressions exercised against the real bundled background worker. Nothing leaves the process.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { rollup } from 'rollup';
import { ProfileStore } from '../src/background/profile-store.js';
import { MESSAGE_TYPES, STORAGE_KEYS } from '../src/shared/constants.js';
import { PROFILE_STORAGE_KEY, DEFAULT_PROFILE_ID } from '../src/shared/profiles.js';

let checks = 0;
async function check(name, run) { await run(); checks++; console.log(`PASS ${name}`); }

const bundle = await rollup({ input: fileURLToPath(new URL('../src/background/service-worker.js', import.meta.url)) });
const { output } = await bundle.generate({ format: 'iife', name: 'WorkerUnderTest' });
await bundle.close();

function harness(memory = {}) {
    let context;
    const fromJSON = value => vm.runInContext(`JSON.parse(${JSON.stringify(JSON.stringify(value))})`, context);
    const event = { addListener() {} };
    const browser = {
        storage: { local: {
            async get(keys) {
                const wanted = keys == null ? Object.keys(memory) : Array.isArray(keys) ? keys : [keys];
                return fromJSON(Object.fromEntries(wanted.filter(key => Object.hasOwn(memory, key)).map(key => [key, memory[key]])));
            },
            async set(values) { Object.assign(memory, structuredClone(values)); },
            async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete memory[key]; }
        }, onChanged: event },
        runtime: { onMessage: event, onInstalled: event, onStartup: event, onSuspend: event,
            getManifest: () => ({ version: '4.5.0' }), getURL: path => 'extension://' + path, async sendMessage() {} },
        tabs: { async query() { return []; }, async create() {}, async sendMessage() {} }
    };
    context = vm.createContext({ browser, URL, URLSearchParams, TextEncoder, crypto: webcrypto,
        console: { log() {}, warn() {}, error() {}, debug() {} }, setInterval: () => 1, clearInterval() {},
        setTimeout, clearTimeout, fetch: () => { throw new Error('Worker regression tests must never fetch.'); } });
    vm.runInContext(output[0].code, context);
    return { memory, send: message => context.WorkerUnderTest.handleMessage(fromJSON(message)) };
}

await check('importing a backup never lets a file claim live provenance or inject profile metadata', async () => {
    const h = harness();
    const stamp = Date.now() - 60_000;
    const reply = await h.send({ type: MESSAGE_TYPES.IMPORT_DATA, payload: { cache: [{
        screenName: 'someone', location: 'Spain', device: 'Spain Android App', locationAccurate: true,
        timestamp: stamp, fromCloud: false, metaTimestamp: 1, metaExpiresAt: 9e15,
        meta: { name: 'Injected', avatarUrl: 'https://evil.example/a.png', affiliate: { name: 'Acme', badgeUrl: 'https://evil.example/b.png', url: 'https://evil.example' },
            affiliateUsername: 'Acme', restId: '1', blueVerified: true }
    }, {
        screenName: 'plain', location: 'Italy', device: 'Web', timestamp: stamp, fromCloud: false
    }] } });
    assert.equal(reply.success, true);
    assert.equal(reply.importedCache, 2);
    const { data } = await h.send({ type: MESSAGE_TYPES.GET_CACHE, payload: {} });
    const byName = Object.fromEntries(data.map(entry => [entry.screenName, entry]));
    assert.equal(byName.someone.location, 'Spain');
    assert.equal(byName.someone.fromCloud, true, 'a file is secondhand: never re-uploaded as an observation');
    assert.deepEqual(Object.keys(byName.someone).sort(), ['device', 'fromCloud', 'location', 'locationAccurate', 'meta', 'screenName', 'timestamp']);
    assert.deepEqual(JSON.parse(JSON.stringify(byName.someone.meta)), { partial: true, affiliateUsername: null, affiliate: { name: 'Acme' } },
        'only the affiliation verdict survives, without artwork or links');
    assert.equal(byName.plain.meta, undefined, 'unchecked affiliation stays unknown');
    assert.equal(byName.plain.fromCloud, true);
});

await check('unreadable stored profiles no longer break every later request', async () => {
    const memory = { [PROFILE_STORAGE_KEY]: { version: 99, revision: 41, profiles: 'corrupt' } };
    const h = harness(memory);
    const reply = await h.send({ type: MESSAGE_TYPES.GET_SETTINGS, payload: {}, profileContext: { accountId: null, profileId: null } });
    assert.equal(reply.success, true);
    assert.equal(reply.profileId, DEFAULT_PROFILE_ID);
    assert.ok(reply.revision >= 42, 'open tabs must not discard the replacement as older than what they hold');
    assert.deepEqual(memory[`${PROFILE_STORAGE_KEY}_unreadable`], { version: 99, revision: 41, profiles: 'corrupt' }, 'the old bytes are kept for recovery');
    assert.equal(memory[PROFILE_STORAGE_KEY].version, 1);
});

await check('the profile store recovers on its own too, keeping the saved settings and lists', async () => {
    const log = console.error; console.error = () => {};
    const memory = new Map([[PROFILE_STORAGE_KEY, { oops: true }]]);
    const storage = {
        async get(key) { return memory.has(key) ? { [key]: structuredClone(memory.get(key)) } : {}; },
        async set(values) { for (const [key, value] of Object.entries(values)) memory.set(key, structuredClone(value)); }
    };
    const store = new ProfileStore(storage, {
        getSettings: () => ({ showFlags: false }),
        getFilters: () => ({ blockedCountries: ['japan'] }),
        createId: () => 'x'
    });
    try { await store.load(); } finally { console.error = log; }
    const snapshot = store.snapshot({ accountId: null, profileId: null });
    assert.deepEqual([...snapshot.filters.blockedCountries], ['japan']);
    assert.equal(memory.get(`${PROFILE_STORAGE_KEY}_unreadable`).oops, true);
});

await check('an unknown filter action neither reports success nor broadcasts a change', async () => {
    const h = harness();
    const reply = await h.send({ type: MESSAGE_TYPES.SET_BLOCKED_COUNTRIES, payload: { action: 'frobnicate', country: 'japan' } });
    assert.equal(reply.success, false);
    assert.match(reply.error, /Unknown filter action/);
    const read = await h.send({ type: MESSAGE_TYPES.GET_BLOCKED_COUNTRIES });
    assert.deepEqual([...read.data], []);
    const added = await h.send({ type: MESSAGE_TYPES.SET_BLOCKED_COUNTRIES, payload: { action: 'add', country: 'japan' } });
    assert.equal(added.success, true, 'real actions still work');
});

await check('a malformed handle is rejected before any lookup', async () => {
    const h = harness();
    for (const screenName of [undefined, null, '', 'a b', 'x'.repeat(16), 'bad,name', '../x', 42, {}]) {
        for (const type of [MESSAGE_TYPES.FETCH_USER_INFO, MESSAGE_TYPES.FETCH_HOVERCARD_INFO]) {
            const reply = await h.send({ type, payload: { screenName, csrfToken: 't' } });
            assert.equal(reply.success, false, `${type} ${JSON.stringify(screenName)}`);
            assert.equal(reply.code, 'NOT_FOUND');
        }
    }
});

console.log(`${checks} worker regression checks passed. The worker never fetched.`);
process.exit(0);
