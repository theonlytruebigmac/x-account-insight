/**
 * Update checking (GitHub Releases)
 *
 * A sideloaded/unpacked install is never auto-updated by the browser itself, so this
 * can only poll the repo's latest release tag and let the UI point people at the
 * download — it has no way to install anything on its own.
 *
 * The worker is torn down and restarted constantly (MV3), and every start asks for a
 * check, so checks are throttled by the stored result: GitHub's unauthenticated limit
 * is small, and a failed check must never erase what a previous check learned.
 */

import browserAPI from '../shared/browser-api.js';
import { VERSION, STORAGE_KEYS, UPDATE_CHECK_CONFIG } from '../shared/constants.js';

const ALARM_NAME = 'update-check';
/** After a failed check (offline, GitHub rate limit) wait this long before asking again. */
const ERROR_RETRY_MS = 15 * 60 * 1000;

function parseVersion(value) {
    return String(value ?? '')
        .trim()
        .replace(/^v/i, '')
        .split('.')
        .map(part => parseInt(part, 10) || 0);
}

export function isNewer(remoteVersion, localVersion) {
    const remote = parseVersion(remoteVersion);
    const local = parseVersion(localVersion);
    const length = Math.max(remote.length, local.length);
    for (let i = 0; i < length; i++) {
        const r = remote[i] || 0;
        const l = local[i] || 0;
        if (r > l) return true;
        if (r < l) return false;
    }
    return false;
}

/** Only ever link to the project's own GitHub pages, whatever the API returned. */
export function safeReleaseUrl(value) {
    return typeof value === 'string' && value.startsWith('https://github.com/')
        ? value : UPDATE_CHECK_CONFIG.RELEASES_PAGE_URL;
}

/**
 * Normalize a stored result for display. Availability is recomputed against the running
 * version, so the banner clears as soon as the user updates rather than at the next check.
 */
function present(info) {
    if (!info || typeof info !== 'object') return null;
    const latestVersion = typeof info.latestVersion === 'string' ? info.latestVersion : null;
    return {
        checkedAt: Number.isFinite(info.checkedAt) ? info.checkedAt : 0,
        latestVersion,
        releaseUrl: safeReleaseUrl(info.releaseUrl),
        updateAvailable: latestVersion !== null && isNewer(latestVersion, VERSION),
        error: typeof info.error === 'string' ? info.error : null
    };
}

async function readStored() {
    try {
        const result = await browserAPI.storage.local.get(STORAGE_KEYS.UPDATE_INFO);
        return present(result[STORAGE_KEYS.UPDATE_INFO]);
    } catch {
        return null;
    }
}

function isFresh(info, now) {
    if (!info || !info.checkedAt || info.checkedAt > now) return false;
    const maxAge = info.error ? ERROR_RETRY_MS : UPDATE_CHECK_CONFIG.CHECK_INTERVAL_MINUTES * 60 * 1000;
    return now - info.checkedAt < maxAge;
}

let inFlight = null;

/**
 * @param {{force?: boolean}} [options] force: the user asked (skip the throttle).
 */
async function checkNow({ force = false } = {}) {
    if (inFlight) return inFlight;
    inFlight = (async () => {
        const previous = await readStored();
        if (!force && isFresh(previous, Date.now())) return previous;

        let info;
        try {
            const response = await fetch(UPDATE_CHECK_CONFIG.API_URL, {
                headers: { Accept: 'application/vnd.github+json' }
            });
            if (!response.ok) throw new Error(`GitHub API responded with ${response.status}`);
            const release = await response.json();
            const latestVersion = parseVersion(release.tag_name).join('.');
            info = present({
                checkedAt: Date.now(),
                latestVersion,
                releaseUrl: release.html_url,
                error: null
            });
        } catch (error) {
            // Keep what an earlier successful check learned; only record that this one failed.
            info = present({
                checkedAt: Date.now(),
                latestVersion: previous?.latestVersion ?? null,
                releaseUrl: previous?.releaseUrl,
                error: error.message
            });
        }
        await browserAPI.storage.local.set({ [STORAGE_KEYS.UPDATE_INFO]: info });
        return info;
    })();
    try {
        return await inFlight;
    } finally {
        inFlight = null;
    }
}

async function getStatus() {
    return readStored();
}

/**
 * The alarm listener is registered while the module loads. MV3 drops an event that arrives
 * before a listener exists at the end of the worker's first turn, and init() below only
 * runs after storage has loaded.
 */
if (browserAPI.alarms?.onAlarm) {
    browserAPI.alarms.onAlarm.addListener(alarm => {
        // Not forced: the stored result already knows whether a check is due.
        if (alarm.name === ALARM_NAME) checkNow().catch(() => {});
    });
}

/**
 * Create the periodic alarm once. create() with an existing name REPLACES that alarm, so
 * calling it on every worker start re-armed the first firing for a minute later, which woke
 * the worker, which re-armed it: a wake-up (and a GitHub request) every minute.
 */
async function init() {
    if (!browserAPI.alarms) return;
    try {
        const existing = await browserAPI.alarms.get?.(ALARM_NAME);
        if (existing) return;
    } catch { /* Fall through and create it. */ }
    browserAPI.alarms.create(ALARM_NAME, {
        delayInMinutes: UPDATE_CHECK_CONFIG.CHECK_INTERVAL_MINUTES,
        periodInMinutes: UPDATE_CHECK_CONFIG.CHECK_INTERVAL_MINUTES
    });
}

export const updateCheck = { init, checkNow, getStatus };
export default updateCheck;
