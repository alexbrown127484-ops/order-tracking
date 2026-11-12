/**
 * Shared state for serverless functions.
 *
 * Vercel runs many instances of each function, in multiple regions, each with its own process
 * memory. Anything kept in a module-level Map (the tracking cache, the upstream rate limiter,
 * the Shopify offline-token cache) is therefore only correct for a *single* warm instance: two
 * instances can both miss the cache for the same tracking number at once, and the "per minute"
 * upstream budget really means "per minute, per instance" — with N warm instances the real
 * ceiling is N times higher than configured.
 *
 * This module gives those features a shared backend (Upstash Redis's REST API, which works over
 * plain fetch with no TCP connection pool to manage — a good fit for serverless) while staying
 * fully optional: with no UPSTASH_* env vars set, everything degrades to the same in-memory Map
 * behavior as before, so local dev and the offline self-test need no setup. In production with
 * more than one function instance, configuring Upstash (or any Redis with a compatible REST API)
 * is what makes the cache and rate limiter actually correct.
 */

const KV_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
export const KV_ENABLED = Boolean(KV_URL && KV_TOKEN);

const memory = new Map(); // key -> { value, expiresAt } — fallback, and local fast-path cache

function memGet(key) {
  const entry = memory.get(key);
  if (!entry) return null;
  if (entry.expiresAt && Date.now() > entry.expiresAt) {
    memory.delete(key);
    return null;
  }
  return entry.value;
}

function memSet(key, value, ttlSec) {
  memory.set(key, { value, expiresAt: ttlSec ? Date.now() + ttlSec * 1000 : null });
}

async function restCommand(command, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${KV_URL}/${command.map(encodeURIComponent).join('/')}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`KV HTTP ${res.status}`);
    const data = await res.json();
    if (data?.error) throw new Error(data.error);
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

/** Reads a JSON value. Returns null on a miss, and degrades to the in-memory map on a KV error. */
export async function kvGetJSON(key) {
  if (!KV_ENABLED) return memGet(key);
  try {
    const raw = await restCommand(['GET', key]);
    return raw == null ? null : JSON.parse(raw);
  } catch (err) {
    console.error(`[kv] get ${key} failed: ${err.message}`);
    return memGet(key);
  }
}

/** Writes a JSON value with an optional TTL (seconds). Always mirrors into memory as a fallback. */
export async function kvSetJSON(key, value, ttlSec) {
  memSet(key, value, ttlSec);
  if (!KV_ENABLED) return;
  try {
    const cmd = ttlSec
      ? ['SET', key, JSON.stringify(value), 'EX', String(Math.max(1, Math.round(ttlSec)))]
      : ['SET', key, JSON.stringify(value)];
    await restCommand(cmd);
  } catch (err) {
    console.error(`[kv] set ${key} failed: ${err.message}`);
  }
}

export async function kvDelete(key) {
  memory.delete(key);
  if (!KV_ENABLED) return;
  try {
    await restCommand(['DEL', key]);
  } catch (err) {
    console.error(`[kv] del ${key} failed: ${err.message}`);
  }
}

/**
 * Atomically increments a counter that expires `windowSec` after its first increment, i.e. a
 * fixed-window rate-limit counter shared by every instance. Returns the count *after* this
 * increment. On a KV error, returns 0 (fail open) — callers should keep a cheap local budget of
 * their own as a first line of defense so a KV outage never removes rate limiting entirely.
 */
export async function kvIncrWindow(key, windowSec) {
  if (!KV_ENABLED) {
    const now = Date.now();
    const entry = memory.get(key);
    if (!entry || now > entry.expiresAt) {
      memory.set(key, { value: 1, expiresAt: now + windowSec * 1000 });
      return 1;
    }
    entry.value += 1;
    return entry.value;
  }
  try {
    const res = await fetch(`${KV_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([
        ['INCR', key],
        ['EXPIRE', key, String(windowSec), 'NX'], // NX: only set a TTL if the key has none yet
      ]),
    });
    const data = await res.json();
    const count = Number(data?.[0]?.result);
    return Number.isFinite(count) ? count : 0;
  } catch (err) {
    console.error(`[kv] incr ${key} failed: ${err.message}`);
    return 0;
  }
}
