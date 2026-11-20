// How a failed or empty AboutAccount answer is classified. No live requests.
import assert from 'node:assert/strict';

globalThis.browser = { storage: { local: { get: async () => ({}), set: async () => {} } } };
const { XAPIClient, API_ERROR_CODES, APIError } = await import('../src/background/api-client.js');
delete globalThis.browser;
const { parseAccountResponse, AccountResponseUnusableError } = await import('../src/shared/account-response.js');

let checks = 0;
async function check(name, run) { await run(); checks++; console.log(`PASS ${name}`); }
const user = (result, extra = {}) => ({ data: { user_result_by_screen_name: { result } }, ...extra });
const codeOf = fn => { try { fn(); } catch (error) { return error.code; } return null; };

await check('an errors envelope without an account is a transient failure, not an empty account', () => {
    assert.equal(codeOf(() => parseAccountResponse({ errors: [{ message: 'Timeout: Unspecified' }], data: {} }, 'a')), 'NETWORK_ERROR');
    assert.equal(codeOf(() => parseAccountResponse({ errors: [{ message: 'x' }] }, 'a')), 'NETWORK_ERROR');
});

await check('suspended, restricted or empty results are unavailable, never a blank cached record', () => {
    assert.equal(codeOf(() => parseAccountResponse(user({ __typename: 'UserUnavailable', reason: 'Suspended' }), 'a')), 'UNAVAILABLE');
    assert.equal(codeOf(() => parseAccountResponse(user(undefined), 'a')), 'UNAVAILABLE');
    assert.equal(codeOf(() => parseAccountResponse({ data: { user_result_by_screen_name: {} } }, 'a')), 'UNAVAILABLE');
    assert.equal(codeOf(() => parseAccountResponse(null, 'a')), 'UNAVAILABLE');
    assert.throws(() => parseAccountResponse({}, 'a'), AccountResponseUnusableError);
});

await check('a real account still parses, even if X also attached partial errors', () => {
    const body = user({ __typename: 'User', core: { screen_name: 'Sample' }, about_profile: { account_based_in: 'Spain', source: 'Spain Web App' } },
        { errors: [{ message: 'partial' }] });
    assert.equal(parseAccountResponse(body, 'sample').location, 'Spain');
});

await check('a non-text screen name cannot crash the handle comparison', () => {
    const body = user({ __typename: 'User', core: { screen_name: { bad: true } }, about_profile: { account_based_in: 'Spain' } });
    assert.equal(parseAccountResponse(body, 'sample').location, 'Spain');
});

const api = new XAPIClient({ get: async () => ({}), set: async () => {} });

await check('the client maps unusable answers to their lookup codes', () => {
    for (const [body, code] of [
        [{ errors: [{ message: 'x' }] }, API_ERROR_CODES.NETWORK_ERROR],
        [user({ __typename: 'UserUnavailable' }), API_ERROR_CODES.UNAVAILABLE]
    ]) {
        assert.throws(() => api.parseResponse(body, 'a'), error => error instanceof APIError && error.code === code);
    }
});

await check('server failures are transient; other HTTP errors stay permanent', async () => {
    const reject = status => api.handleErrorResponse({ status, headers: new Headers() }).then(() => null, error => error.code);
    for (const status of [500, 502, 503, 504, 408]) assert.equal(await reject(status), API_ERROR_CODES.NETWORK_ERROR, String(status));
    assert.equal(await reject(404), API_ERROR_CODES.NOT_FOUND);
    assert.equal(await reject(401), API_ERROR_CODES.UNAUTHORIZED);
    assert.equal(await reject(403), API_ERROR_CODES.UNAUTHORIZED);
    assert.equal(await reject(400), API_ERROR_CODES.UNKNOWN);
});

await check('an unavailable account is asked about once; a transient failure is retried', async () => {
    api.setHeaders({ authorization: 'Bearer x', 'x-csrf-token': 'y' });
    let calls = 0;
    let body = user({ __typename: 'UserUnavailable' });
    globalThis.fetch = async () => { calls++; return { ok: true, status: 200, headers: new Headers(), json: async () => body }; };
    await assert.rejects(api.executeRequest('someone'), error => error.code === API_ERROR_CODES.UNAVAILABLE);
    assert.equal(calls, 1, 'retrying cannot change a verdict');
    calls = 0;
    body = { errors: [{ message: 'Timeout' }], data: {} };
    await assert.rejects(api.executeRequest('someone'), error => error.code === API_ERROR_CODES.NETWORK_ERROR);
    assert.ok(calls > 1, 'a passing X failure gets another attempt');
});

console.log(`${checks} account-error checks passed. No live requests were used.`);
process.exit(0);
