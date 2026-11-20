/** Pure affiliation-filter matching, shared by the observer and its regression checks. */

/**
 * Does an account's affiliation label match the blocked set? X exposes the parent
 * organisation on affiliated accounts as a badge next to the display name, which
 * we already read from the API and now also share via the community cache.
 *
 * Matching is a case-insensitive substring of the account's label: typing part of an
 * organisation name catches it without knowing the exact label. It is deliberately ONE
 * direction. Matching the other way round (the typed text containing the label) lets a
 * short label such as "X" match any blocked name that merely contains that letter.
 * @param {{affiliate?: {name?: string}|null, affiliateUsername?: string|null}|null|undefined} meta
 * @param {Set<string>} blockedAffiliations - lowercase blocked affiliation names
 * @returns {boolean}
 */
export function hasBlockedAffiliation(meta, blockedAffiliations) {
    if (!meta || !blockedAffiliations || blockedAffiliations.size === 0) return false;

    const candidates = [];
    if (meta.affiliate && meta.affiliate.name) candidates.push(String(meta.affiliate.name).toLowerCase());
    if (meta.affiliateUsername) candidates.push(String(meta.affiliateUsername).toLowerCase());
    if (candidates.length === 0) return false;

    for (const blocked of blockedAffiliations) {
        const needle = blocked.toLowerCase().trim();
        if (!needle) continue;
        for (const candidate of candidates) {
            if (candidate.includes(needle)) return true;
        }
    }
    return false;
}
