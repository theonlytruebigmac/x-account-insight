/**
 * Cloud Community Cache Client
 * Talks to the x-insight-cache server: batched lookups before any X API call,
 * and batched contributions of what we observe so other users can skip theirs.
 *
 * Reliability notes:
 * - Lookups and contributions each have their own token bucket, sized just under the
 *   server's per-IP limits, so we spend the budget instead of earning 429s.
 * - When the lookup budget is briefly spent the batch is held (and keeps growing)
 *   rather than answered empty — an empty answer means "go ask X", which is exactly
 *   the rate limit the cache exists to protect.
 * - Pending contributions are persisted, chunked to the server's batch limit, and
 *   only removed from the queue once the server has answered for them.
 * - Each contribution carries its observation time (`t`) so a late upload (bulk sync,
 *   queue restored after a restart) can't masquerade as fresh data on the server.
 * - Dedup is by content, not by name: an entry is skipped only when the server is
 *   already known to hold at least the same fields, so a richer record (e.g. an
 *   affiliation learned from a hovercard) is always sent.
 */

import { STORAGE_KEYS, CLOUD_CACHE_CONFIG } from '../shared/constants.js';
import browserAPI from '../shared/browser-api.js';
import { debounce } from '../shared/utils.js';
import { UserCacheStorage } from '../shared/storage.js';
import { withRequestTimeout, readRateLimitReset } from '../shared/request-policy.js';

// Twitter launched in 2006; anything earlier is bad data, not an old account.
const MIN_CREATED_AT_SECONDS = 1136073600;
const USERNAME_RE = /^[a-z0-9_]{1,15}$/;
// After the server rejects our key, re-probe this often in case it is re-enabled.
const AUTH_RETRY_MS = 10 * 60 * 1000;
const CONTRIBUTION_FIELDS = ['l', 'd', 'a', 'af', 'c', 'id', 'uc', 'nf'];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * X's created_at ("Tue Jun 02 20:12:29 +0000 2009") to unix SECONDS, which is the unit
 * the server stores. Returns 0 for anything unparseable or outside a sane range, so a
 * bad value is simply never contributed.
 * @param {string|number|null|undefined} value
 * @returns {number} unix seconds, or 0
 */
function toUnixSeconds(value) {
    if (value === null || value === undefined) return 0;
    const ms = typeof value === 'number' ? value : Date.parse(value);
    if (!Number.isFinite(ms)) return 0;
    const seconds = Math.floor(ms / 1000);
    if (seconds < MIN_CREATED_AT_SECONDS || seconds > Math.floor(Date.now() / 1000)) return 0;
    return seconds;
}

/**
 * Build the wire entry for /contribute from a cache record. Optional fields are only
 * included when known, so an upload can never overwrite richer server data with blanks.
 * @returns {object|null} null when there is nothing worth sending
 */
export function buildContributionEntry(data) {
    if (!data || typeof data !== 'object') return null;
    const location = typeof data.location === 'string' ? data.location.trim() : '';
    const device = typeof data.device === 'string' ? data.device.trim() : '';
    if (!location && !device) return null;

    const observedAt = UserCacheStorage.observationTimestamp(data);
    if (observedAt === null) return null;

    const entry = { a: data.locationAccurate !== false, t: Math.floor(observedAt / 1000) };
    if (location) entry.l = location;
    if (device) entry.d = device;

    const meta = data.meta;
    if (meta) {
        const affiliation = meta.affiliate?.name || meta.affiliateUsername;
        if (affiliation) entry.af = String(affiliation);
        else if (meta.affiliateUsername !== undefined) entry.af = '';

        const createdSeconds = toUnixSeconds(meta.createdAt);
        if (createdSeconds) entry.c = createdSeconds;

        if (meta.restId && /^[0-9]{1,20}$/.test(String(meta.restId))) entry.id = String(meta.restId);
        if (Number.isInteger(meta.usernameChanges) && meta.usernameChanges >= 0) {
            entry.uc = meta.usernameChanges;
        }
    }
    return entry;
}

/** Content of an entry without its observation time, for dedup comparisons. */
function contentOf(entry) {
    const content = {};
    for (const key of CONTRIBUTION_FIELDS) {
        if (entry[key] !== undefined) content[key] = entry[key];
    }
    return content;
}

/** Simple token bucket with an optional hard block (server-directed Retry-After). */
class TokenBucket {
    constructor(perMinute, burst) {
        this.ratePerMs = perMinute / 60000;
        this.capacity = burst;
        this.tokens = burst;
        this.updatedAt = Date.now();
        this.blockedUntil = 0;
    }

    _refill(now) {
        const elapsed = Math.max(0, now - this.updatedAt);
        this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.ratePerMs);
        this.updatedAt = now;
    }

    /** Milliseconds until a request may be sent (0 = now). */
    waitMs(now = Date.now()) {
        this._refill(now);
        const blocked = Math.max(0, this.blockedUntil - now);
        const refill = this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) / this.ratePerMs);
        return Math.max(blocked, refill);
    }

    tryTake(now = Date.now()) {
        if (this.waitMs(now) > 0) return false;
        this.tokens -= 1;
        return true;
    }

    blockUntil(deadline) {
        if (Number.isFinite(deadline)) this.blockedUntil = Math.max(this.blockedUntil, deadline);
    }
}

class CloudCacheClient {
    constructor() {
        this.enabled = false;
        this.apiUrl = CLOUD_CACHE_CONFIG.API_URL;
        this.apiKey = null;
        this.lookupBatch = new Set();
        this.lookupBatchTimeout = null;
        this.lookupBatchFirstAt = 0; // When the current un-flushed batch started (for the max-wait cap)
        this.lookupBatchResolvers = []; // Array of resolve functions waiting for batch
        this.contributionQueue = new Map(); // username -> wire entry (insertion order = age)
        this.contributeTimeout = null;
        this.contributeFlushing = false;
        this.lookupBucket = new TokenBucket(
            CLOUD_CACHE_CONFIG.LOOKUP_REQUESTS_PER_MINUTE, CLOUD_CACHE_CONFIG.LOOKUP_BURST);
        this.contributeBucket = new TokenBucket(
            CLOUD_CACHE_CONFIG.CONTRIBUTE_REQUESTS_PER_MINUTE, CLOUD_CACHE_CONFIG.CONTRIBUTE_BURST);
        this.consecutiveFailures = 0; // Track failures for exponential backoff
        this.backoffUntil = 0; // Timestamp until which we should back off
        // What the server last told us: ok | unauthorized | unreachable | unknown
        this.connection = { state: 'unknown', status: null, at: 0 };
        this.stats = {
            lookups: 0,
            hits: 0,
            notFoundHits: 0,
            misses: 0,
            contributions: 0,
            errors: 0
        };

        // What the server is known to hold per user: username -> { entry, at }.
        // Filled by our own successful uploads and by cloud hits.
        this.recentContributions = new Map();
        this.CONTRIBUTION_DEDUP_MS = 24 * 60 * 60 * 1000; // Don't re-send identical data within 24 hours
        this.recentMisses = new Map(); // username -> when the cloud last said "unknown"

        // Cached server stats (stale-while-revalidate for fast UI)
        this.serverStats = null;
        this.serverStatsFetchedAt = 0;

        // Debounced stats saving to prevent excessive storage writes
        this._debouncedSaveStats = debounce(() => this._saveStatsImmediate(), 5000);
        this._debouncedSaveQueue = debounce(() => this._saveQueueImmediate(), 3000);
    }

    /**
     * Initialize the cloud cache client
     */
    async init() {
        // Load enabled state + persisted stats from storage
        const result = await browserAPI.storage.local.get([
            STORAGE_KEYS.CLOUD_CACHE_ENABLED,
            STORAGE_KEYS.CLOUD_CACHE_API_KEY,
            STORAGE_KEYS.CLOUD_STATS,
            STORAGE_KEYS.CLOUD_SERVER_STATS,
            STORAGE_KEYS.CLOUD_PENDING_CONTRIBUTIONS
        ]);

        this.enabled = result[STORAGE_KEYS.CLOUD_CACHE_ENABLED] === true;
        this.apiKey = typeof result[STORAGE_KEYS.CLOUD_CACHE_API_KEY] === 'string'
            ? result[STORAGE_KEYS.CLOUD_CACHE_API_KEY]
            : null;

        if (result[STORAGE_KEYS.CLOUD_STATS]) {
            this.stats = { ...this.stats, ...result[STORAGE_KEYS.CLOUD_STATS] };
        }

        // Load cached server stats (for instant display in Options)
        const storedServerStats = result[STORAGE_KEYS.CLOUD_SERVER_STATS];
        if (storedServerStats && typeof storedServerStats === 'object') {
            const { data, fetchedAt } = storedServerStats;
            if (data && typeof data === 'object') {
                this.serverStats = data;
                this.serverStatsFetchedAt = typeof fetchedAt === 'number' ? fetchedAt : 0;
            }
        }

        this._restoreQueue(result[STORAGE_KEYS.CLOUD_PENDING_CONTRIBUTIONS]);

        console.log(`☁️ Cloud Cache: ${this.enabled ? 'enabled' : 'disabled'}`);

        // Server stats are loaded from storage above and refreshed lazily by the Options
        // page (stale-while-revalidate), so no eager network fetch on every worker start.
        return this.enabled;
    }

    /**
     * Reload contributions that were queued when the worker last stopped. Entries
     * whose observation has since expired are dropped rather than uploaded.
     */
    _restoreQueue(stored) {
        if (!this.enabled) {
            if (stored) this._saveQueueImmediate();
            return;
        }
        if (!stored || typeof stored !== 'object') return;

        let dropped = 0;
        for (const [username, entry] of Object.entries(stored)) {
            const timestamp = Number.isInteger(entry?.t) ? entry.t * 1000 : null;
            const fresh = timestamp !== null && (entry.nf === true
                ? timestamp <= Date.now() && Date.now() - timestamp < CLOUD_CACHE_CONFIG.NOT_FOUND_TTL_MS
                : UserCacheStorage.isFreshObservation({ timestamp }));
            if (!USERNAME_RE.test(username) || !fresh || this.contributionQueue.has(username)) {
                dropped++;
                continue;
            }
            this.contributionQueue.set(username, entry);
        }
        this._trimQueue();
        if (dropped) this._debouncedSaveQueue();
        if (this.contributionQueue.size > 0) {
            console.log(`☁️ Restored ${this.contributionQueue.size} pending contributions`);
            this._scheduleFlush(2000);
        }
    }

    /**
     * Set cloud cache enabled state
     */
    async setEnabled(enabled) {
        if (typeof enabled !== 'boolean') throw new TypeError('Cloud cache preference must be a boolean');
        await browserAPI.storage.local.set({
            [STORAGE_KEYS.CLOUD_CACHE_ENABLED]: enabled
        });
        this.enabled = enabled;
        console.log(`☁️ Cloud Cache: ${enabled ? 'enabled' : 'disabled'}`);

        if (!enabled) {
            // Turning sharing off must stop anything already queued from leaving.
            this._clearPendingWork();
            await this._saveQueueImmediate();
        }

        // Warm the server-stats cache so Options can display instantly.
        if (enabled && this.isConfigured()) {
            this.refreshServerStats({ timeoutMs: 15000 }).catch(() => {});
        }

        return enabled;
    }

    _clearPendingWork() {
        if (this.contributeTimeout) clearTimeout(this.contributeTimeout);
        this.contributeTimeout = null;
        this.contributionQueue.clear();
        this._debouncedSaveQueue.cancel();

        if (this.lookupBatchTimeout) clearTimeout(this.lookupBatchTimeout);
        this.lookupBatchTimeout = null;
        const resolvers = this.lookupBatchResolvers;
        this.lookupBatch.clear();
        this.lookupBatchResolvers = [];
        this.lookupBatchFirstAt = 0;
        for (const resolve of resolvers) resolve(new Map());
    }

    /**
     * Set the community cache API key. An empty string clears it (treated
     * the same as never having one — isConfigured() requires it truthy).
     */
    async setApiKey(key) {
        if (typeof key !== 'string') throw new TypeError('API key must be a string');
        const trimmed = key.trim();
        await browserAPI.storage.local.set({
            [STORAGE_KEYS.CLOUD_CACHE_API_KEY]: trimmed
        });
        const changed = (trimmed || null) !== this.apiKey;
        this.apiKey = trimmed || null;

        if (changed) {
            this.connection = { state: 'unknown', status: null, at: 0 };
            this.recentMisses.clear();
            this.recentContributions.clear();
        }

        if (this.enabled && this.isConfigured()) {
            this.refreshServerStats({ timeoutMs: 15000 }).catch(() => {});
            if (this.contributionQueue.size > 0) this._scheduleFlush(1000);
        }

        return this.apiKey;
    }

    authHeader() {
        return this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
    }

    /**
     * Get current enabled state
     */
    isEnabled() {
        return this.enabled;
    }

    /**
     * Get statistics
     */
    getStats() {
        return { ...this.stats, pendingContributions: this.contributionQueue.size };
    }

    /**
     * What the server last said about our key: ok | unauthorized | unreachable | unknown
     */
    getConnectionStatus() {
        return { ...this.connection };
    }

    _setConnection(state, status = null) {
        this.connection = { state, status, at: Date.now() };
    }

    /** The server rejected our key recently; don't keep knocking until it changes. */
    isAuthPaused() {
        return this.connection.state === 'unauthorized' && Date.now() - this.connection.at < AUTH_RETRY_MS;
    }

    /**
     * Get last known server stats (may be stale)
     */
    getCachedServerStats() {
        return this.serverStats ? { ...this.serverStats } : null;
    }

    /**
     * Whether cached server stats are still "fresh".
     * COST OPTIMIZATION: Increased cache time from 5min to 1 hour
     */
    isServerStatsFresh(maxAgeMs = 60 * 60 * 1000) {
        if (!this.serverStats || !this.serverStatsFetchedAt) return false;
        return Date.now() - this.serverStatsFetchedAt < maxAgeMs;
    }

    async _saveServerStats(data) {
        try {
            this.serverStats = data;
            this.serverStatsFetchedAt = Date.now();
            await browserAPI.storage.local.set({
                [STORAGE_KEYS.CLOUD_SERVER_STATS]: {
                    data: this.serverStats,
                    fetchedAt: this.serverStatsFetchedAt
                }
            });
        } catch (error) {
            console.warn('☁️ Failed to save cloud server stats:', error.message);
        }
    }

    /**
     * Save statistics to storage (debounced)
     */
    saveStats() {
        this._debouncedSaveStats();
    }
    
    /**
     * Save statistics immediately (internal use)
     */
    async _saveStatsImmediate() {
        try {
            await browserAPI.storage.local.set({
                [STORAGE_KEYS.CLOUD_STATS]: this.stats
            });
        } catch (error) {
            console.warn('☁️ Failed to save cloud stats:', error.message);
        }
    }
    
    /**
     * Force save stats immediately (for shutdown scenarios)
     */
    async forceSaveStats() {
        await this._saveStatsImmediate();
    }

    async _saveQueueImmediate() {
        this._debouncedSaveQueue.cancel();
        try {
            if (this.contributionQueue.size === 0) {
                await browserAPI.storage.local.remove(STORAGE_KEYS.CLOUD_PENDING_CONTRIBUTIONS);
            } else {
                await browserAPI.storage.local.set({
                    [STORAGE_KEYS.CLOUD_PENDING_CONTRIBUTIONS]: Object.fromEntries(this.contributionQueue)
                });
            }
        } catch (error) {
            console.warn('☁️ Failed to persist pending contributions:', error.message);
        }
    }

    /**
     * Persist pending contributions now (for shutdown scenarios)
     */
    async forceSaveQueue() {
        await this._saveQueueImmediate();
    }

    /**
     * Wait (up to a deadline) for a request token. Returns false if none in time.
     */
    async _acquireToken(bucket, deadline) {
        for (;;) {
            const wait = bucket.waitMs();
            if (wait === 0 && bucket.tryTake()) return true;
            if (Date.now() + wait > deadline) return false;
            await sleep(Math.max(wait, 10));
        }
    }

    /**
     * Lookup users in cloud cache
     * Returns map of username -> data (users the cloud doesn't know are absent)
     */
    async lookup(usernames) {
        if (!this.enabled || !this.isConfigured() || !usernames || usernames.length === 0) {
            return new Map();
        }
        // Known-bad key or a failing server: answer at once rather than holding callers.
        if (this.isAuthPaused() || this.shouldBackoff()) {
            return new Map();
        }

        const now = Date.now();
        const wanted = [];
        for (const username of usernames) {
            const name = String(username).toLowerCase();
            const missedAt = this.recentMisses.get(name);
            if (missedAt && now - missedAt < CLOUD_CACHE_CONFIG.MISS_TTL_MS) continue;
            wanted.push(name);
        }
        if (wanted.length === 0) return new Map();

        // Add to batch (record when this un-flushed batch started, for the max-wait cap)
        if (this.lookupBatch.size === 0) {
            this.lookupBatchFirstAt = now;
        }
        for (const name of wanted) {
            this.lookupBatch.add(name);
        }

        // Return batched promise - all callers share the same batch result
        return new Promise(resolve => {
            // Add this resolver to the list of waiting callers
            this.lookupBatchResolvers.push(resolve);

            // Flush at once when the batch is full instead of waiting on the debounce.
            if (this.lookupBatch.size >= CLOUD_CACHE_CONFIG.BATCH_SIZE) {
                if (this.lookupBatchTimeout) {
                    clearTimeout(this.lookupBatchTimeout);
                    this.lookupBatchTimeout = null;
                }
                this.executeBatchedLookup();
                return;
            }

            // Trailing debounce, but capped by a max wait: a steady stream of single-user
            // lookups (continuous scroll) keeps resetting the 200ms timer, which would
            // otherwise starve the batch from ever flushing. The cap forces it through.
            if (this.lookupBatchTimeout) {
                clearTimeout(this.lookupBatchTimeout);
            }
            const elapsed = Date.now() - this.lookupBatchFirstAt;
            const delay = Math.max(0, Math.min(
                CLOUD_CACHE_CONFIG.BATCH_DELAY_MS,
                CLOUD_CACHE_CONFIG.LOOKUP_MAX_WAIT_MS - elapsed
            ));
            this.lookupBatchTimeout = setTimeout(() => {
                this.executeBatchedLookup();
            }, delay);
        });
    }

    /**
     * Execute batched lookup and resolve all waiting callers
     */
    async executeBatchedLookup() {
        // Out of lookup budget: hold the batch (it keeps absorbing new names) until a
        // token frees up, rather than answering empty and pushing callers onto X.
        const wait = this.lookupBucket.waitMs();
        const deferDeadline = this.lookupBatchFirstAt + CLOUD_CACHE_CONFIG.LOOKUP_MAX_DEFER_MS;
        if (wait > 0 && this.lookupBatch.size > 0 && Date.now() + wait <= deferDeadline) {
            if (this.lookupBatchTimeout) clearTimeout(this.lookupBatchTimeout);
            this.lookupBatchTimeout = setTimeout(() => this.executeBatchedLookup(), wait);
            return;
        }

        const batch = Array.from(this.lookupBatch);
        const resolvers = [...this.lookupBatchResolvers];
        
        // Clear batch state
        this.lookupBatch.clear();
        this.lookupBatchResolvers = [];
        if (this.lookupBatchTimeout) clearTimeout(this.lookupBatchTimeout);
        this.lookupBatchTimeout = null;
        this.lookupBatchFirstAt = 0;

        if (batch.length === 0) {
            // Resolve all callers with empty result
            for (const resolve of resolvers) {
                resolve(new Map());
            }
            return;
        }

        try {
            const results = await this.fetchLookup(batch, deferDeadline);
            // Resolve ALL waiting callers with the same results
            for (const resolve of resolvers) {
                resolve(results);
            }
        } catch (error) {
            console.error('☁️ Cloud lookup error:', error);
            this.stats.errors++;
            // Resolve all callers with empty result on error
            for (const resolve of resolvers) {
                resolve(new Map());
            }
        }
    }

    /**
     * Check if we should back off due to consecutive failures
     */
    shouldBackoff() {
        return Date.now() < this.backoffUntil;
    }
    
    /**
     * Calculate backoff delay based on consecutive failures
     */
    getBackoffDelay() {
        // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
        const delay = Math.min(1000 * Math.pow(2, this.consecutiveFailures), 30000);
        return delay;
    }
    
    /**
     * Record a successful request (reset backoff)
     */
    recordSuccess() {
        this.consecutiveFailures = 0;
        this.backoffUntil = 0;
        this._setConnection('ok');
    }
    
    /**
     * Record a failed request (increase backoff)
     */
    recordFailure(status = null) {
        this.consecutiveFailures++;
        this.backoffUntil = Date.now() + this.getBackoffDelay();
        this._setConnection('unreachable', status);
        console.warn(`☁️ Cloud cache backing off for ${this.getBackoffDelay()}ms (${this.consecutiveFailures} failures)`);
    }

    /**
     * Shared handling for non-OK responses from any endpoint.
     * @returns {'unauthorized'|'rate_limited'|'rejected'|'server'}
     */
    _handleErrorStatus(response, bucket) {
        const status = response.status;
        if (status === 401 || status === 403) {
            this._setConnection('unauthorized', status);
            console.warn(`☁️ Community cache rejected the API key (HTTP ${status})`);
            return 'unauthorized';
        }
        if (status === 429) {
            bucket?.blockUntil(readRateLimitReset(response.headers));
            console.warn('☁️ Community cache rate limited us; holding requests until it resets');
            return 'rate_limited';
        }
        if (status >= 400 && status < 500) {
            // Auth passed (it runs before validation), so the server is fine; the
            // request itself is bad and retrying it unchanged would never succeed.
            this._setConnection('ok', status);
            return 'rejected';
        }
        this.recordFailure(status);
        return 'server';
    }

    _rememberMiss(name, now) {
        this.recentMisses.set(name, now);
        if (this.recentMisses.size > 5000) {
            for (const [user, at] of this.recentMisses) {
                if (now - at >= CLOUD_CACHE_CONFIG.MISS_TTL_MS) this.recentMisses.delete(user);
            }
        }
    }
    
    /**
     * Fetch lookup from cloud API
     */
    async fetchLookup(usernames, deadline = Date.now() + CLOUD_CACHE_CONFIG.LOOKUP_MAX_DEFER_MS) {
        // Check backoff first
        if (this.shouldBackoff() || this.isAuthPaused()) {
            console.warn('☁️ Cloud cache paused, skipping lookup');
            return new Map();
        }

        this.stats.lookups++;
        const results = new Map();

        // Split into batches if needed
        const batches = [];
        for (let i = 0; i < usernames.length; i += CLOUD_CACHE_CONFIG.BATCH_SIZE) {
            batches.push(usernames.slice(i, i + CLOUD_CACHE_CONFIG.BATCH_SIZE));
        }

        for (const batch of batches) {
            if (!await this._acquireToken(this.lookupBucket, deadline)) {
                console.warn('☁️ Cloud lookup budget exhausted, skipping remainder of batch');
                break;
            }
            try {
                const { response, data } = await withRequestTimeout(async signal => {
                    const response = await fetch(
                        `${this.apiUrl}/lookup?users=${batch.join(',')}`,
                        {
                            method: 'GET',
                            signal,
                            headers: {
                                'Accept': 'application/json',
                                ...this.authHeader()
                            }
                        }
                    );
                    return { response, data: response.ok ? await response.json() : null };
                }, CLOUD_CACHE_CONFIG.LOOKUP_TIMEOUT_MS);

                if (!response.ok) {
                    this.stats.errors++;
                    const kind = this._handleErrorStatus(response, this.lookupBucket);
                    console.warn(`☁️ Cloud lookup failed with HTTP ${response.status}`);
                    if (kind === 'unauthorized' || kind === 'server') break;
                    continue;
                }
                this.recordSuccess();

                // Process results with input validation
                const now = Date.now();
                const returned = new Set();
                if (data?.results) {
                    for (const [username, info] of Object.entries(data.results)) {
                        const normalizedUsername = username.toLowerCase();
                        returned.add(normalizedUsername);
                        // Retain the source cache timestamp across this download.
                        // Invalid/expired dates cannot become new hits.
                        const timestamp = Number.isFinite(info?.t) ? info.t * 1000 : null;
                        if (!UserCacheStorage.isFreshObservation({ timestamp }, now)) {
                            this.stats.misses++;
                            continue;
                        }
                        // Validate and sanitize cloud data
                        const sanitizedLocation = this.sanitizeInput(info.l);
                        const sanitizedDevice = this.sanitizeInput(info.d);

                        // Skip entries with suspiciously long or invalid data
                        if (!sanitizedLocation && !sanitizedDevice) {
                            continue;
                        }

                        this.stats.hits++;

                        const cloudEntry = {
                            location: sanitizedLocation,
                            device: sanitizedDevice,
                            locationAccurate: info.a !== false,
                            fromCloud: true,
                            timestamp
                        };

                        // Optional shared profile signals. Mapped into the same `meta`
                        // shape the X API path produces, so every consumer downstream
                        // reads one format regardless of where the data came from.
                        const affiliation = this.sanitizeInput(info.af);
                        const affiliationWasIncluded = Object.hasOwn(info, 'af') && typeof info.af === 'string';
                        const restId = typeof info.id === 'string' && /^[0-9]{1,20}$/.test(info.id)
                            ? info.id
                            : null;
                        const createdAtMs = Number.isInteger(info.c) && info.c > 0 ? info.c * 1000 : null;
                        const usernameChanges = Number.isInteger(info.uc) && info.uc >= 0 ? info.uc : null;

                        if (affiliationWasIncluded || restId || createdAtMs || usernameChanges !== null) {
                            cloudEntry.meta = {
                                // The community cache carries only the shared subset, not
                                // the display name, avatar or verification state. Flagged
                                // so the hovercard still does a live fetch instead of
                                // rendering a card with half its fields blank.
                                partial: true,
                                // An explicit empty `af` is "checked, none"; a missing
                                // field from older servers remains unknown.
                                affiliate: affiliation ? { name: affiliation } : null,
                                ...(affiliationWasIncluded ? { affiliateUsername: affiliation } : {}),
                                restId,
                                createdAt: createdAtMs ? new Date(createdAtMs).toISOString() : null,
                                usernameChanges
                            };
                        }

                        results.set(normalizedUsername, cloudEntry);

                        // Record what the server already holds, so we don't re-upload the
                        // same fields. Anything richer we learn later still goes up.
                        const held = buildContributionEntry(cloudEntry);
                        if (held) {
                            this.recentContributions.set(normalizedUsername, { entry: contentOf(held), at: timestamp });
                        }
                    }
                }

                if (data?.notFound && typeof data.notFound === 'object') {
                    for (const [username, info] of Object.entries(data.notFound)) {
                        const normalizedUsername = username.toLowerCase();
                        const timestamp = Number.isInteger(info?.t) ? info.t * 1000 : null;
                        if (!batch.includes(normalizedUsername) || results.has(normalizedUsername) ||
                            timestamp === null || timestamp > Date.now() ||
                            Date.now() - timestamp >= CLOUD_CACHE_CONFIG.NOT_FOUND_TTL_MS) continue;

                        returned.add(normalizedUsername);
                        this.stats.hits++;
                        this.stats.notFoundHits++;
                        results.set(normalizedUsername, { notFound: true, timestamp });
                        this.recentContributions.set(normalizedUsername, {
                            entry: { nf: true },
                            at: timestamp
                        });
                    }
                }

                for (const name of batch) {
                    if (!returned.has(name)) this._rememberMiss(name, now);
                }

                // Track misses
                if (data?.misses) {
                    this.stats.misses += data.misses.length;
                }

            } catch (error) {
                if (error.name === 'AbortError' || error.code === 'TIMEOUT') {
                    console.warn('☁️ Cloud lookup timed out');
                } else {
                    console.error('☁️ Cloud lookup failed:', error.message);
                }
                this.stats.errors++;
                this.recordFailure();
                break;
            }
        }

        // Diagnostic (issue #23 "flag/pop-up mismatch"): a returned username we never asked
        // for is a strong signal of a server-side username→data misalignment (the leading
        // root-cause hypothesis). This is rare by design, so log unconditionally — it is the
        // smoking gun that would confirm the mismatch originates in the server.
        const requestedSet = new Set(usernames);
        for (const returnedUser of results.keys()) {
            if (!requestedSet.has(returnedUser)) {
                console.warn(`☁️ X Account Insight: cloud /lookup returned an UNREQUESTED user "${returnedUser}". Possible server-side mapping bug (issue #23).`);
            }
        }

        // Save stats (debounced)
        this.saveStats();

        return results;
    }

    /** True when the server is already known to hold at least this entry's fields. */
    _alreadyShared(username, entry) {
        const known = this.recentContributions.get(username);
        if (!known || Date.now() - known.at >= this.CONTRIBUTION_DEDUP_MS) return false;
        for (const key of CONTRIBUTION_FIELDS) {
            if (entry[key] !== undefined && known.entry[key] !== entry[key]) return false;
        }
        return true;
    }

    _markShared(username, entry) {
        const now = entry.nf === true && Number.isInteger(entry.t) ? entry.t * 1000 : Date.now();
        this.recentContributions.set(username, { entry: contentOf(entry), at: now });
        // Clean up old dedup entries periodically (keep map from growing)
        if (this.recentContributions.size > 10000) {
            const cutoff = now - this.CONTRIBUTION_DEDUP_MS;
            for (const [user, known] of this.recentContributions.entries()) {
                if (known.at < cutoff) this.recentContributions.delete(user);
            }
        }
    }

    _trimQueue() {
        while (this.contributionQueue.size > CLOUD_CACHE_CONFIG.MAX_PENDING_CONTRIBUTIONS) {
            this.contributionQueue.delete(this.contributionQueue.keys().next().value);
        }
    }

    _scheduleFlush(delay) {
        if (this.contributeTimeout) clearTimeout(this.contributeTimeout);
        this.contributeTimeout = setTimeout(() => {
            this.contributeTimeout = null;
            this.flushContributions();
        }, Math.max(0, delay));
    }

    /**
     * Queue a fresh observation for the community cache.
     * Skipped when the server is already known to hold the same (or richer) data.
     */
    async contribute(username, data) {
        if (!this.enabled || !username || !data) {
            return;
        }
        // Do not circulate old cloud data as a newly observed account, or upload
        // legacy local records whose original observation time was lost.
        if (data.fromCloud === true || !UserCacheStorage.isFreshObservation(data)) return;

        const normalizedUsername = String(username).toLowerCase();
        if (!USERNAME_RE.test(normalizedUsername)) return;

        const entry = buildContributionEntry(data);
        if (!entry || this._alreadyShared(normalizedUsername, entry)) return;

        this._queueContribution(normalizedUsername, entry);
    }

    async contributeNotFound(username, observedAt = Date.now()) {
        if (!this.enabled || !this.isConfigured() || !username || !Number.isFinite(observedAt) ||
            observedAt > Date.now()) return;
        const normalizedUsername = String(username).toLowerCase();
        if (!USERNAME_RE.test(normalizedUsername)) return;

        const entry = { nf: true, t: Math.floor(observedAt / 1000) };
        if (Date.now() - entry.t * 1000 >= CLOUD_CACHE_CONFIG.NOT_FOUND_TTL_MS ||
            this._alreadyShared(normalizedUsername, entry)) return;
        this._queueContribution(normalizedUsername, entry);
    }

    _queueContribution(normalizedUsername, entry) {
        // Re-insert so the queue stays ordered oldest → newest for trimming.
        this.contributionQueue.delete(normalizedUsername);
        this.contributionQueue.set(normalizedUsername, entry);
        this._trimQueue();
        this._debouncedSaveQueue();

        // Flush if batch is full; otherwise a fixed (not sliding) delay from the first
        // queued entry, so continuous scrolling can't postpone the upload forever.
        if (this.contributionQueue.size >= CLOUD_CACHE_CONFIG.CONTRIBUTE_BATCH_SIZE) {
            this.flushContributions();
        } else if (!this.contributeTimeout) {
            this._scheduleFlush(CLOUD_CACHE_CONFIG.CONTRIBUTE_DELAY_MS);
        }
    }

    /**
     * POST one chunk (≤ CONTRIBUTE_BATCH_SIZE) to /contribute.
     * @returns {Promise<{kind: 'ok'|'unauthorized'|'rate_limited'|'rejected'|'server'|'network', accepted: number}>}
     */
    async _postContributions(entries, timeoutMs = CLOUD_CACHE_CONFIG.CONTRIBUTE_TIMEOUT_MS) {
        const count = Object.keys(entries).length;
        try {
            const { response, data } = await withRequestTimeout(async signal => {
                const response = await fetch(`${this.apiUrl}/contribute`, {
                    method: 'POST',
                    signal,
                    headers: {
                        'Content-Type': 'application/json',
                        ...this.authHeader()
                    },
                    body: JSON.stringify({ entries })
                });
                return { response, data: response.ok ? await response.json().catch(() => null) : null };
            }, timeoutMs);

            if (response.ok) {
                this.recordSuccess();
                const accepted = Number.isInteger(data?.accepted) ? data.accepted : count;
                return { kind: 'ok', accepted };
            }
            this.stats.errors++;
            const kind = this._handleErrorStatus(response, this.contributeBucket);
            console.warn(`☁️ Contribution of ${count} entries failed with HTTP ${response.status} (${kind})`);
            return { kind, accepted: 0 };
        } catch (error) {
            if (error.name === 'AbortError' || error.code === 'TIMEOUT') {
                console.warn('☁️ Contribution timed out, will retry');
            } else {
                console.error('☁️ Contribution failed:', error.message);
            }
            this.stats.errors++;
            this.recordFailure();
            return { kind: 'network', accepted: 0 };
        }
    }

    /**
     * Flush pending contributions to cloud, one server-sized chunk at a time.
     * Entries leave the queue only once the server has answered for them.
     */
    async flushContributions() {
        if (this.contributeTimeout) {
            clearTimeout(this.contributeTimeout);
            this.contributeTimeout = null;
        }
        if (this.contributeFlushing || this.contributionQueue.size === 0) return;
        if (!this.enabled || !this.isConfigured()) return;

        if (this.isAuthPaused()) {
            this._scheduleFlush(this.connection.at + AUTH_RETRY_MS - Date.now());
            return;
        }

        const wait = Math.max(this.contributeBucket.waitMs(), this.backoffUntil - Date.now());
        if (wait > 0 || !this.contributeBucket.tryTake()) {
            this._scheduleFlush(Math.max(wait, 1000));
            return;
        }

        const chunk = Array.from(this.contributionQueue).slice(0, CLOUD_CACHE_CONFIG.CONTRIBUTE_BATCH_SIZE);
        this.contributeFlushing = true;
        let result;
        try {
            result = await this._postContributions(Object.fromEntries(chunk));
        } finally {
            this.contributeFlushing = false;
        }

        // Turned off while the request was in flight: setEnabled already cleared everything.
        if (!this.enabled) return;

        if (result.kind === 'ok' || result.kind === 'rejected') {
            // A rejected (4xx) batch would be rejected forever; drop it so it can't wedge
            // the queue. Entries re-queued with newer data mid-flight are kept.
            for (const [username, entry] of chunk) {
                if (this.contributionQueue.get(username) === entry) this.contributionQueue.delete(username);
                if (result.kind === 'ok') this._markShared(username, entry);
            }
            if (result.kind === 'ok') {
                this.stats.contributions += result.accepted;
                console.log(`☁️ Contributed ${result.accepted}/${chunk.length} entries to cloud`);
            }
        }

        this._debouncedSaveQueue();
        this.saveStats();

        if (this.contributionQueue.size === 0) return;
        if (result.kind === 'unauthorized') {
            this._scheduleFlush(AUTH_RETRY_MS);
        } else if (result.kind === 'server' || result.kind === 'network') {
            this._scheduleFlush(this.backoffUntil - Date.now() + 1000);
        } else if (result.kind === 'rate_limited') {
            this._scheduleFlush(this.contributeBucket.waitMs() + 1000);
        } else if (this.contributionQueue.size >= CLOUD_CACHE_CONFIG.CONTRIBUTE_BATCH_SIZE) {
            this._scheduleFlush(this.contributeBucket.waitMs());
        } else {
            this._scheduleFlush(CLOUD_CACHE_CONFIG.CONTRIBUTE_DELAY_MS);
        }
    }

    /**
     * Sanitize input from cloud cache to prevent XSS/injection
     * @param {any} input - Input to sanitize
     * @returns {string|null} - Sanitized string or null
     */
    sanitizeInput(input) {
        if (!input || typeof input !== 'string') return null;
        
        // Remove any HTML/script tags
        let sanitized = input.replace(/<[^>]*>/g, '');
        
        // Remove potential script injection patterns
        sanitized = sanitized.replace(/javascript:/gi, '');
        sanitized = sanitized.replace(/on\w+=/gi, '');
        
        // Limit length to prevent overflow attacks
        sanitized = sanitized.substring(0, 100);
        
        // Trim whitespace
        sanitized = sanitized.trim();
        
        return sanitized || null;
    }

    /**
     * Check if API URL is configured
     */
    isConfigured() {
        return !!(this.apiUrl && !this.apiUrl.includes('YOUR_SUBDOMAIN') && this.apiKey);
    }

    /**
     * Bulk sync local cache entries to cloud. Uses the same entry format (with meta and
     * original observation time) and request budget as normal contributions.
     * @param {Object} cacheEntries - Map of username -> data
     * @returns {Object} - { synced, skipped, errors, message }
     */
    async bulkSync(cacheEntries) {
        if (!this.enabled || !this.isConfigured()) {
            return { synced: 0, skipped: 0, errors: 0, message: 'Cloud cache not enabled' };
        }

        const all = Object.entries(cacheEntries || {});
        if (all.length === 0) {
            return { synced: 0, skipped: 0, errors: 0, message: 'No entries to sync' };
        }

        let synced = 0;
        let skipped = 0;
        let errors = 0;
        let message = null;

        const pending = [];
        for (const [username, data] of all) {
            const name = String(username).toLowerCase();
            // Keep the same observation/provenance checks as normal contributions.
            const entry = USERNAME_RE.test(name) && data && data.fromCloud !== true &&
                UserCacheStorage.isFreshObservation(data) ? buildContributionEntry(data) : null;
            if (!entry || this._alreadyShared(name, entry)) {
                skipped++;
                continue;
            }
            pending.push([name, entry]);
        }

        const chunkSize = CLOUD_CACHE_CONFIG.CONTRIBUTE_BATCH_SIZE;
        console.log(`☁️ Bulk sync: ${pending.length} entries in ${Math.ceil(pending.length / chunkSize)} batches`);

        for (let i = 0; i < pending.length; i += chunkSize) {
            const chunk = pending.slice(i, i + chunkSize);
            let result = { kind: 'network', accepted: 0 };

            for (let attempt = 0; attempt < 3; attempt++) {
                if (!this.enabled) break;
                if (!await this._acquireToken(this.contributeBucket, Date.now() + 2 * 60 * 1000)) {
                    result = { kind: 'rate_limited', accepted: 0 };
                    break;
                }
                result = await this._postContributions(Object.fromEntries(chunk), 15000);
                if (result.kind === 'server' || result.kind === 'network') {
                    await sleep(this.getBackoffDelay());
                } else if (result.kind !== 'rate_limited') {
                    break;
                }
            }

            if (result.kind === 'ok') {
                synced += result.accepted;
                skipped += chunk.length - result.accepted;
                this.stats.contributions += result.accepted;
                for (const [name, entry] of chunk) this._markShared(name, entry);
            } else if (result.kind === 'rejected') {
                skipped += chunk.length;
            } else {
                errors += pending.length - i;
                if (result.kind === 'unauthorized') message = 'API key rejected by the community cache';
                if (!this.enabled) message = 'Cloud cache was disabled during sync';
                break;
            }
        }

        this.saveStats();
        console.log(`☁️ Bulk sync complete: ${synced} synced, ${skipped} skipped, ${errors} errors`);

        return {
            synced,
            skipped,
            errors,
            message: message || `Synced ${synced} entries to cloud`
        };
    }

    /**
     * Fetch server statistics (total entries in cloud cache)
     *
     * Stale-while-revalidate behavior:
     * - returns cached stats immediately if available (even if stale) when allowStale is true
     * - refreshes from network when force is true or cache is stale
     */
    async fetchServerStats({ timeoutMs = 8000, maxAgeMs = 5 * 60 * 1000, allowStale = true, force = false } = {}) {
        if (!this.isConfigured()) {
            return null;
        }

        const cached = this.getCachedServerStats();

        // Fast path: cache is fresh
        if (!force && this.isServerStatsFresh(maxAgeMs)) {
            return cached;
        }

        // If we want instant UI and have something cached, return it while we revalidate
        if (allowStale && cached && !force) {
            // Fire-and-forget refresh
            this.refreshServerStats({ timeoutMs }).catch(() => {});
            return cached;
        }

        // Otherwise, attempt a network fetch and fall back to cache on failure
        const fresh = await this._fetchServerStatsFromNetwork(timeoutMs);
        if (fresh) {
            await this._saveServerStats(fresh);
            return fresh;
        }

        return cached;
    }

    /**
     * Force-refresh server stats from network.
     */
    async refreshServerStats({ timeoutMs = 8000 } = {}) {
        const fresh = await this._fetchServerStatsFromNetwork(timeoutMs);
        if (fresh) {
            await this._saveServerStats(fresh);
        }
        return this.getCachedServerStats();
    }

    async _fetchServerStatsFromNetwork(timeoutMs) {
        try {
            const data = await withRequestTimeout(async signal => {
                const response = await fetch(`${this.apiUrl}/stats`, {
                    method: 'GET',
                    signal,
                    headers: {
                        'Accept': 'application/json',
                        ...this.authHeader()
                    }
                });

                if (!response.ok) {
                    throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
                }

                return response.json();
            }, timeoutMs);
            this._setConnection('ok');
            return {
                totalEntries: data.totalEntries || 0,
                totalContributions: data.totalContributions || 0,
                lastUpdated: data.lastUpdated || null
            };
        } catch (error) {
            console.warn('☁️ Failed to fetch server stats:', error.message);
            if (error.status === 401 || error.status === 403) {
                this._setConnection('unauthorized', error.status);
            } else if (error.status !== 429) {
                this._setConnection('unreachable', error.status || null);
            }
            return null;
        }
    }
}

// Singleton instance
const cloudCache = new CloudCacheClient();
export default cloudCache;
