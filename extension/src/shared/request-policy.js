/** Common handling for X lookup deadlines and server-directed cooldowns. */
export const LOOKUP_TIMEOUT_MS = 8000;
/**
 * X's rate-limit windows are 15 minutes. No server header, stored value or page relay can
 * hold lookups off for longer than this: a malformed or forged deadline would otherwise
 * disable the extension for as long as it claimed, across restarts.
 */
export const MAX_RATE_LIMIT_WAIT_MS = 60 * 60 * 1000;
export const RATE_LIMIT_STORAGE_KEY = 'x_api_rate_limit_reset';
export const RATE_LIMIT_BUDGET_STORAGE_KEY = 'x_api_rate_limit_budget';
/** Reserve this portion of the observed window for interactive account-card lookups. */
export const RATE_LIMIT_RESERVE_RATIO = 0.15;
/** Near the reset, an unspent reserve would be lost, so passive lookups may use it. */
export const RATE_LIMIT_RESERVE_RELEASE_MS = 60000;
/** Idle time may bank this many paced starts, so a freshly loaded screen resolves together. */
export const PAGE_LOOKUP_BURST = 3;

/** Reserve ratio applied to one lookup, given its priority and the window's remaining time. */
export function lookupReserveRatio(budget, now = Date.now(), priority = false) {
    if (priority || !budget || !Number.isFinite(budget.resetTime)) return 0;
    return budget.resetTime - now > RATE_LIMIT_RESERVE_RELEASE_MS ? RATE_LIMIT_RESERVE_RATIO : 0;
}

/** Bound a server- or page-supplied deadline; anything not a finite time stays unknown (NaN). */
export function clampRateLimitDeadline(deadline, now = Date.now()) {
    return Number.isFinite(deadline) ? Math.min(deadline, now + MAX_RATE_LIMIT_WAIT_MS) : NaN;
}

export class RequestTimeoutError extends Error {
    constructor() {
        super('Request timed out');
        this.name = 'RequestTimeoutError';
        this.code = 'TIMEOUT';
    }
}

export class LookupTimeoutError extends RequestTimeoutError {
    constructor() {
        super();
        this.message = 'Account lookup timed out';
        this.name = 'LookupTimeoutError';
    }
}

/** Honor the latest valid server deadline; malformed/past headers use a 60s fallback. */
export function readRateLimitReset(headers, now = Date.now()) {
    const deadlines = [];
    const reset = Number(headers?.get('x-rate-limit-reset')) * 1000;
    if (Number.isFinite(reset) && reset > now) deadlines.push(reset);

    const retry = headers?.get('retry-after');
    if (retry !== null && retry !== undefined && String(retry).trim() !== '') {
        const seconds = Number(retry);
        const deadline = Number.isFinite(seconds) && seconds >= 0
            ? now + seconds * 1000
            : Date.parse(retry);
        if (Number.isFinite(deadline) && deadline > now) deadlines.push(deadline);
    }
    return clampRateLimitDeadline(deadlines.length ? Math.max(...deadlines) : now + 60000, now);
}

/** Read the budget fields X exposes for an endpoint's current rate-limit window. */
export function readRateLimitBudget(headers, now = Date.now()) {
    // Number(null) is 0: an absent header must not read as an exhausted budget.
    const read = name => {
        const value = headers?.get(name);
        return value === null || value === undefined || String(value).trim() === '' ? NaN : Number(value);
    };
    const reset = read('x-rate-limit-reset') * 1000;
    const remaining = read('x-rate-limit-remaining');
    const limit = read('x-rate-limit-limit');
    if (!Number.isFinite(reset) || reset <= now ||
        !Number.isInteger(remaining) || remaining < 0 ||
        !Number.isInteger(limit) || limit < 1) return null;
    return { resetTime: clampRateLimitDeadline(reset, now), remaining, limit };
}

/** Merge concurrent observations conservatively; an older response must not refill quota. */
export function mergeRateLimitBudget(current, incoming, now = Date.now()) {
    if (incoming && Number.isFinite(incoming.resetTime) && incoming.resetTime > now + MAX_RATE_LIMIT_WAIT_MS) {
        incoming = { ...incoming, resetTime: clampRateLimitDeadline(incoming.resetTime, now) };
    }
    if (!incoming || !Number.isFinite(incoming.resetTime) || incoming.resetTime <= now ||
        !Number.isInteger(incoming.remaining) || incoming.remaining < 0 ||
        !Number.isInteger(incoming.limit) || incoming.limit < 1) return current || null;
    if (!current || !Number.isFinite(current.resetTime) || current.resetTime <= now ||
        incoming.resetTime > current.resetTime) return { ...incoming };
    if (incoming.resetTime < current.resetTime) return current;
    return {
        resetTime: current.resetTime,
        remaining: Math.min(current.remaining, incoming.remaining),
        limit: Math.min(current.limit, incoming.limit)
    };
}

/** Pace within the observed window while preserving the configured request reserve. */
export function rateLimitIntervalMs(budget, now = Date.now(), reserveRatio = RATE_LIMIT_RESERVE_RATIO) {
    if (!budget || !Number.isFinite(budget.resetTime) || budget.resetTime <= now ||
        !Number.isInteger(budget.remaining) || budget.remaining < 0 ||
        !Number.isInteger(budget.limit) || budget.limit < 1) return 0;
    const reserve = reserveRatio > 0 ? Math.max(1, Math.ceil(budget.limit * reserveRatio)) : 0;
    const usable = budget.remaining - reserve;
    if (usable <= 0) return budget.resetTime - now;
    return Math.ceil((budget.resetTime - now) / usable);
}

/** Bound the whole operation, including response decoding, and always clear its timer. */
export async function withRequestTimeout(operation, timeoutMs, createTimeoutError = () => new RequestTimeoutError()) {
    const controller = new AbortController();
    let timer;
    try {
        return await Promise.race([
            Promise.resolve().then(() => operation(controller.signal)),
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    reject(createTimeoutError());
                    controller.abort();
                }, timeoutMs);
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/** Preserve the lookup-specific error contract for X's background and page queues. */
export function withLookupTimeout(operation, timeoutMs = LOOKUP_TIMEOUT_MS) {
    return withRequestTimeout(operation, timeoutMs, () => new LookupTimeoutError());
}

/** Page-session fallback queue. Waiting time counts against the request deadline. */
export class PacedLookupQueue {
    constructor({ minIntervalMs = 1000, maxConcurrent = 2, timeoutMs = LOOKUP_TIMEOUT_MS } = {}) {
        this.minIntervalMs = minIntervalMs;
        this.maxConcurrent = maxConcurrent;
        this.timeoutMs = timeoutMs;
        this.pending = [];
        this.active = 0;
        this.lastStart = 0;
        this.resetTime = 0;
        this.timer = null;
    }

    rateLimitError() {
        return Object.assign(new Error('Rate limit exceeded'), {
            code: 'RATE_LIMITED', retryAfter: this.resetTime
        });
    }

    setRateLimit(resetTime) {
        if (!Number.isFinite(resetTime)) return;
        this.resetTime = Math.max(this.resetTime, clampRateLimitDeadline(resetTime));
        this.pump();
    }

    add(operation, { priority = false } = {}) {
        return withLookupTimeout(signal => new Promise((resolve, reject) => {
            if (this.resetTime > Date.now()) {
                reject(this.rateLimitError());
                return;
            }
            const item = { operation, signal, resolve, reject, priority, deadline: Date.now() + this.timeoutMs };
            const onAbort = () => {
                const index = this.pending.indexOf(item);
                if (index !== -1) this.pending.splice(index, 1);
                reject(new LookupTimeoutError());
                if (item.finish) item.finish();
                this.pump();
            };
            signal.addEventListener('abort', onAbort, { once: true });
            item.cleanup = () => signal.removeEventListener('abort', onAbort);
            const firstNormal = priority ? this.pending.findIndex(queued => !queued.priority) : -1;
            if (firstNormal === -1) this.pending.push(item);
            else this.pending.splice(firstNormal, 0, item);
            this.pump();
        }), this.timeoutMs);
    }

    pump() {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.resetTime > Date.now()) {
            for (const item of this.pending.splice(0)) {
                item.cleanup();
                item.reject(this.rateLimitError());
            }
            return;
        }
        if (!this.pending.length || this.active >= this.maxConcurrent) return;
        const delay = this.minIntervalMs - (Date.now() - this.lastStart);
        if (delay > 0) {
            this.timer = setTimeout(() => { this.timer = null; this.pump(); }, delay);
            return;
        }
        const item = this.pending.shift();
        if (item.signal.aborted || item.deadline <= Date.now()) {
            item.cleanup();
            item.reject(new LookupTimeoutError());
            this.pump();
            return;
        }
        this.active++;
        this.lastStart = Date.now();
        let finished = false;
        item.finish = () => {
            if (finished) return;
            finished = true;
            item.cleanup();
            this.active--;
            this.pump();
        };
        Promise.resolve().then(() => item.operation(item.signal))
            .then(item.resolve, item.reject)
            .finally(item.finish);
        this.pump();
    }
}
