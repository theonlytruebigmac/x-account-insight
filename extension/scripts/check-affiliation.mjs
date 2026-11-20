// Affiliation filter matching.
import assert from 'node:assert/strict';
import { hasBlockedAffiliation } from '../src/shared/affiliation-match.js';

let checks = 0;
function check(name, run) { run(); checks++; console.log(`PASS ${name}`); }
const match = (affiliate, blocked, extra = {}) => hasBlockedAffiliation({ affiliate: affiliate ? { name: affiliate } : null, ...extra }, new Set(blocked));

check('part of an organisation name is enough, in any case', () => {
    assert.equal(match('Tesla', ['tesla']), true);
    assert.equal(match('Fox News Media', ['fox']), true);
    assert.equal(match('FOX NEWS', ['fox news']), true);
    assert.equal(match('OpenAI', ['  openai  ']), true);
    assert.equal(hasBlockedAffiliation({ affiliate: null, affiliateUsername: 'xAI' }, new Set(['xai'])), true);
});

check('a short label does not match every blocked name that merely contains it', () => {
    assert.equal(match('X', ['fox news']), false);
    assert.equal(match('X', ['axios']), false);
    assert.equal(match('X', ['netflix']), false);
    assert.equal(match('AP', ['snap inc']), false);
    assert.equal(match('Meta', ['metamask']), false);
    assert.equal(match('OpenAI', ['openai inc']), false, 'type the part you want to match');
});

check('empty and unchecked records never match', () => {
    assert.equal(match('Tesla', []), false);
    assert.equal(match('Tesla', ['', '   ']), false);
    assert.equal(match(null, ['tesla']), false);
    assert.equal(hasBlockedAffiliation(null, new Set(['tesla'])), false);
    assert.equal(hasBlockedAffiliation({ affiliate: { name: 'Tesla' } }, null), false);
});

console.log(`${checks} affiliation checks passed.`);
