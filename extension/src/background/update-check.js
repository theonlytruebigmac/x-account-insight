/**
 * Update checking (GitHub Releases)
 *
 * A sideloaded/unpacked install is never auto-updated by the browser itself, so this
 * can only poll the repo's latest release tag and let the UI point people at the
 * download — it has no way to install anything on its own.
 */

import browserAPI from '../shared/browser-api.js';
import { VERSION, STORAGE_KEYS, UPDATE_CHECK_CONFIG } from '../shared/constants.js';

const ALARM_NAME = 'update-check';

function parseVersion(value) {
    return String(value ?? '')
        .trim()
        .replace(/^v/i, '')
        .split('.')
        .map(part => parseInt(part, 10) || 0);
}

function isNewer(remoteVersion, localVersion) {
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

async function checkNow() {
    let info;
    try {
        const response = await fetch(UPDATE_CHECK_CONFIG.API_URL, {
            headers: { Accept: 'application/vnd.github+json' }
        });
        if (!response.ok) throw new Error(`GitHub API responded with ${response.status}`);
        const release = await response.json();
        const latestVersion = parseVersion(release.tag_name).join('.');
        info = {
            checkedAt: Date.now(),
            latestVersion,
            releaseUrl: release.html_url || UPDATE_CHECK_CONFIG.RELEASES_PAGE_URL,
            updateAvailable: isNewer(release.tag_name, VERSION),
            error: null
        };
    } catch (error) {
        info = {
            checkedAt: Date.now(),
            latestVersion: null,
            releaseUrl: UPDATE_CHECK_CONFIG.RELEASES_PAGE_URL,
            updateAvailable: false,
            error: error.message
        };
    }
    await browserAPI.storage.local.set({ [STORAGE_KEYS.UPDATE_INFO]: info });
    return info;
}

async function getStatus() {
    const result = await browserAPI.storage.local.get(STORAGE_KEYS.UPDATE_INFO);
    return result[STORAGE_KEYS.UPDATE_INFO] || null;
}

function init() {
    if (!browserAPI.alarms) return;

    browserAPI.alarms.onAlarm.addListener(alarm => {
        if (alarm.name === ALARM_NAME) checkNow();
    });
    browserAPI.alarms.create(ALARM_NAME, {
        delayInMinutes: 1,
        periodInMinutes: UPDATE_CHECK_CONFIG.CHECK_INTERVAL_MINUTES
    });
}

export const updateCheck = { init, checkNow, getStatus };
export default updateCheck;
