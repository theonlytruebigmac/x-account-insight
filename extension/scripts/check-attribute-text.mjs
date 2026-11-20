// Plain-text attributes (tooltips, labels) must show the real name, never HTML entities.
import assert from 'node:assert/strict';
import fs from 'node:fs';

globalThis.chrome = { storage: { local: {} }, runtime: new Proxy({}, { get: (_, key) => key === 'lastError' ? undefined : () => {} }) };
const { plainAttributeText } = await import('../src/shared/utils.js');
const { COUNTRY_FLAGS, REGION_FLAGS } = await import('../src/shared/constants.js');

let checks = 0;
function check(name, run) { run(); checks++; console.log(`PASS ${name}`); }

check('names X really reports keep their apostrophes and ampersands', () => {
    for (const name of ["Lao People's Democratic Republic", "Democratic People's Republic of Korea", "Cote d'Ivoire",
        'East Asia & Pacific', 'Lao People\'s Democratic Republic Android App']) {
        assert.equal(plainAttributeText(name), name);
    }
    // Every country and region we can show must round-trip unchanged.
    for (const name of [...Object.keys(COUNTRY_FLAGS), ...Object.keys(REGION_FLAGS)]) {
        assert.equal(plainAttributeText(name, 200), name, name);
    }
});

check('control characters are removed and the length is bounded', () => {
    assert.equal(plainAttributeText('a\u0000b\nc\u007F'), 'abc');
    assert.equal(plainAttributeText('x'.repeat(500)).length, 100);
    assert.equal(plainAttributeText('x'.repeat(500), 15).length, 15);
    assert.equal(plainAttributeText(undefined), '');
    assert.equal(plainAttributeText({}), '');
});

check('the badge never HTML-escapes text it assigns to a title or label', () => {
    const source = fs.readFileSync(new URL('../src/content/ui.js', import.meta.url), 'utf8');
    for (const line of source.split('\n')) {
        if (/\.title\s*=|setAttribute\('aria-label'/.test(line)) {
            assert.ok(!/sanitizeText\(/.test(line), `escaped text in a plain-text attribute: ${line.trim()}`);
        }
    }
});

console.log(`${checks} attribute-text checks passed.`);
