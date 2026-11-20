/** Public X web-client defaults; the CSRF token must come from the requesting session. */
import { BEARER_TOKEN } from './constants.js';

export function generateFallbackHeaders(csrfToken) {
    if (!csrfToken) return null;

    return {
        'authorization': BEARER_TOKEN,
        'x-csrf-token': csrfToken,
        'x-twitter-active-user': 'yes',
        'x-twitter-auth-type': 'OAuth2Session',
        'content-type': 'application/json'
    };
}

/**
 * Is this X's own GraphQL endpoint? Anchored to the whole origin, on either of X's two
 * domains, so a look-alike host or an unrelated page that merely mentions the path never
 * matches. Relative URLs are deliberately not matched: they include the extension's own
 * lookups, which must not be mistaken for X's traffic.
 * @param {any} url
 * @returns {boolean}
 */
export function isGraphqlApiUrl(url) {
    return /^https?:\/\/(?:[a-z0-9-]+\.)*(?:x|twitter)\.com\/i\/api\/graphql(?:\/|$)/i.test(String(url));
}

/**
 * Request headers arrive in three shapes: a Headers object, a plain object, or a list of
 * [name, value] pairs. Return a plain object for any of them, or null for anything else.
 * @param {any} headers
 * @returns {Record<string, string>|null}
 */
export function headersToObject(headers) {
    if (!headers) return null;
    if (typeof Headers !== 'undefined' && headers instanceof Headers) return Object.fromEntries(headers.entries());
    if (Array.isArray(headers)) {
        return Object.fromEntries(headers.filter(pair => Array.isArray(pair) && pair.length >= 2 && typeof pair[0] === 'string')
            .map(([name, value]) => [name, String(value)]));
    }
    return typeof headers === 'object' ? { ...headers } : null;
}
