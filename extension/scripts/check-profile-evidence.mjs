// Profile evidence merging and persistence timing.
import assert from 'node:assert/strict';
import { mergeProjectedProfile } from '../src/shared/profile-data.js';
import { setProfile, getProfile, clearProfiles } from '../src/content/profile-cache.js';
import { CACHE_CONFIG } from '../src/shared/constants.js';

let checks = 0;
function check(name, run) { clearProfiles(); run(); checks++; console.log(`PASS ${name}`); }

check('X sends one user several ways: the merge does not depend on which arrives first', () => {
    const withId = { u: 'sam', i: '123', f: 10 };
    const withoutId = { u: 'sam', b: 'hello', g: 5 };
    const expected = { u: 'sam', i: '123', f: 10, b: 'hello', g: 5 };
    assert.deepEqual(mergeProjectedProfile(withId, withoutId), expected);
    assert.deepEqual(mergeProjectedProfile(withoutId, withId), expected);
});

check('a handle that moved to a different account never inherits the old text or counts', () => {
    const merged = mergeProjectedProfile({ u: 'sam', i: '123', b: 'old bio', f: 10 }, { u: 'sam', i: '456', f: 2 });
    assert.deepEqual(merged, { u: 'sam', i: '456', f: 2 });
});

check('the session cache keeps earlier evidence when an ID is first learned, and drops it for a different ID', () => {
    setProfile('sam', { bio: 'hello', followers: 10 });
    setProfile('sam', { userId: '123', following: 5 });
    assert.deepEqual({ bio: getProfile('sam').bio, followers: getProfile('sam').followers, userId: getProfile('sam').userId },
        { bio: 'hello', followers: 10, userId: '123' });
    setProfile('sam', { userId: '456', following: 1 });
    assert.equal(getProfile('sam').bio, undefined);
    assert.equal(getProfile('sam').followers, undefined);
    assert.equal(getProfile('sam').userId, '456');
});

check('the account cache is written before an idle Chromium worker is stopped', () => {
    // MV3 workers stop after ~30s idle and Chromium never calls runtime.onSuspend for them.
    assert.ok(CACHE_CONFIG.SAVE_INTERVAL_MS <= 20_000);
});

console.log(`${checks} profile-evidence checks passed.`);
