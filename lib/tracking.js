/**
 * Healtence tracking core: Cainiao request, parser, status classifier, cache and rate limiting.
 * Used by the storefront endpoint (api/track.js) and the admin dashboard (api/admin/status.js).
 */
// ───────────────────────── Config ─────────────────────────
// Cainiao moved its data endpoint from /detail.json (now 404) to /global/detail.json (Nov 2026).
const CAINIAO_ENDPOINT = 'https://global.cainiao.com/global/detail.json';
const UPSTREAM_TIMEOUT_MS = 8000;
const SIGNATURE_MAX_AGE_SEC = 300; // reject signed URLs older than 5 minutes (replay protection)
const UPSTREAM_MAX_PER_MINUTE = 60; // per warm instance; protects Cainiao from bursts
const CACHE_MAX_ENTRIES = 500;
const CACHE_TTL_MS = {
  delivered: 6 * 60 * 60 * 1000, // finished shipments rarely change
  active: 20 * 60 * 1000,
  notFound: 5 * 60 * 1000,
};
const STALE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // serve last known data if Cainiao is down
const MAX_EVENTS = 150;
const TRACKING_RE = /^[A-Z0-9]{8,40}$/;

const HIDE_ORIGIN = /^(1|true|yes)$/i.test(process.env.HIDE_ORIGIN_COUNTRY || '');

import { kvGetJSON, kvIncrWindow, kvSetJSON } from './kv.js';
const KV_PREFIX = 'track:'; // namespaces this app's keys if the KV store is shared

export const STATUS_LABELS = {
  info_received: 'Order processed',
  in_transit: 'In transit',
  out_for_delivery: 'Out for delivery',
  pickup: 'Ready for pickup',
  delivered: 'Delivered',
  exception: 'Delivery issue',
  unknown: 'Status pending',
};

const ERROR_MESSAGES = {
  METHOD_NOT_ALLOWED: 'Method not allowed.',
  SERVER_MISCONFIGURED: 'Tracking is temporarily unavailable. Please try again later.',
  UNAUTHORIZED: 'This request could not be verified.',
  INVALID_TRACKING_NUMBER: 'Enter a valid tracking number: 8 to 40 letters and numbers, no spaces.',
  NOT_FOUND:
    'There are no updates for this tracking number yet. New shipments usually appear within 2–5 business days of dispatch.',
  RATE_LIMITED: 'Tracking is busy right now. Try again in a minute.',
  UPSTREAM_TIMEOUT: 'The carrier took too long to respond. Try again in a moment.',
  UPSTREAM_RATE_LIMITED: 'Tracking is temporarily unavailable. Try again in a few minutes.',
  UPSTREAM_BLOCKED: 'Tracking is temporarily unavailable. Try again in a few minutes.',
  UPSTREAM_BAD_RESPONSE: 'Tracking is temporarily unavailable. Try again in a few minutes.',
  UPSTREAM_ERROR: 'Tracking is temporarily unavailable. Try again in a few minutes.',
};

// Field-name candidates for Cainiao's undocumented JSON. If Cainiao renames a field,
// add the new name here — the rest of the parser does not need to change.
const FIELDS = {
  eventTime: ['time', 'eventTime', 'timestamp', 'gmtCreate', 'opTime'],
  eventTimeLocal: ['timeStr', 'eventTimeStr', 'localTime'],
  // standerdDesc is Cainiao's fuller English text, e.g. "[Mayong Town] Departed from sorting center"
  eventDesc: ['standerdDesc', 'standardDesc', 'eventDesc', 'description', 'message', 'context', 'desc', 'statusDesc'],
  eventAltDesc: ['desc', 'eventDesc'], // shorter carrier text, used as a fallback and for classification
  eventLocation: ['location', 'eventLocation', 'city', 'address', 'position', 'site', 'facility'],
  eventCarrier: ['cpName', 'carrierName', 'carrier', 'logisticsName', 'providerName'],
  eventCode: ['actionCode', 'status', 'eventCode'],
  statusCode: ['status', 'statusCode', 'mailNoStatus'],
  statusText: ['statusDesc', 'statusDescription', 'statusText'],
  originCountry: ['originCountry', 'originCountryName', 'orgCountry', 'sourceCountry', 'shipFromCountry', 'originCountryCode'],
  destCountry: ['destCountry', 'destCountryName', 'destinationCountry', 'shipToCountry', 'destCountryCode'],
  etaObject: ['globalEtaInfo', 'etaInfo', 'eta', 'deliveryEtaInfo'],
  etaText: ['etaDesc', 'deliveryDesc', 'desc', 'etaText'],
  etaMin: ['deliveryMinTime', 'minDeliveryTime', 'etaMinTime', 'startTime'],
  etaMax: ['deliveryMaxTime', 'maxDeliveryTime', 'etaMaxTime', 'endTime'],
};

// ───────────── Module state (lives while this function instance is warm) ─────────────
const cache = new Map(); // trackingNumber -> { value, storedAt, expiresAt }
const inFlight = new Map(); // trackingNumber -> Promise (dedupes concurrent lookups)
const upstreamWindow = { start: 0, count: 0 };

class TrackingError extends Error {
  constructor(code, detail) {
    super(detail || code);
    this.code = code;
  }
}


// ───────────────────────── Public entry point ─────────────────────────
/**
 * Returns normalized tracking data for one number, using the cache, request de-duplication,
 * the upstream rate limit and the stale fallback. Never throws.
 */
export async function getTracking(trackingNumber) {
  const fresh = await cacheGet(trackingNumber);
  if (fresh) return { ...fresh, cached: true };

  try {
    const result = await lookupDeduped(trackingNumber);
    return { ...result, cached: false };
  } catch (err) {
    const code = err instanceof TrackingError ? err.code : 'UPSTREAM_ERROR';
    console.error(`[track] ${trackingNumber} ${code}: ${err.message}`);
    const stale = await cacheGet(trackingNumber, { allowStale: true });
    if (stale && stale.ok) return { ...stale, cached: true, stale: true };
    return failure(code, { trackingNumber });
  }
}

// ───────────────────────── Lookup, dedupe, rate limit ─────────────────────────
function lookupDeduped(trackingNumber) {
  const pending = inFlight.get(trackingNumber);
  if (pending) return pending;

  const promise = (async () => {
    if (!(await takeUpstreamSlot())) {
      throw new TrackingError('RATE_LIMITED', 'upstream budget exhausted');
    }
    const json = await fetchCainiao(trackingNumber);
    const result = parseCainiao(json, trackingNumber);
    await cacheSet(trackingNumber, result);
    return result;
  })().finally(() => inFlight.delete(trackingNumber));

  inFlight.set(trackingNumber, promise);
  return promise;
}

// Two layers: a cheap per-instance counter that always applies (so a KV outage never removes
// rate limiting entirely), plus a shared counter in KV so the "per minute" budget is enforced
// across every warm instance and region instead of being multiplied by instance count.
function takeLocalSlot() {
  const now = Date.now();
  if (now - upstreamWindow.start >= 60_000) {
    upstreamWindow.start = now;
    upstreamWindow.count = 0;
  }
  if (upstreamWindow.count >= UPSTREAM_MAX_PER_MINUTE) return false;
  upstreamWindow.count += 1;
  return true;
}

async function takeUpstreamSlot() {
  if (!takeLocalSlot()) return false;
  const sharedCount = await kvIncrWindow(`${KV_PREFIX}upstream:window`, 60);
  return sharedCount <= UPSTREAM_MAX_PER_MINUTE;
}

// ───────────────────────── Cache ─────────────────────────
// `cache` is the fast, instance-local layer: it owns eviction (LRU-ish) and the stale-while-down
// fallback (STALE_MAX_AGE_MS), exactly as before. The KV store behind it is a *shared* layer that
// only ever holds fresh (non-stale) entries, so that a cold-started or different-region instance
// can reuse a lookup another instance just made instead of calling Cainiao again.
async function cacheSet(key, value) {
  const ttlMs = !value.ok
    ? CACHE_TTL_MS.notFound
    : value.status?.category === 'delivered'
      ? CACHE_TTL_MS.delivered
      : CACHE_TTL_MS.active;
  const now = Date.now();
  cache.delete(key); // re-insert so Map order works as LRU
  cache.set(key, { value, storedAt: now, expiresAt: now + ttlMs });
  while (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);

  await kvSetJSON(`${KV_PREFIX}cache:${key}`, value, Math.round(ttlMs / 1000));
}

async function cacheGet(key, { allowStale = false } = {}) {
  const entry = cache.get(key);
  if (entry) {
    const now = Date.now();
    if (now < entry.expiresAt) return entry.value;
    if (now - entry.storedAt >= STALE_MAX_AGE_MS) {
      cache.delete(key);
    } else if (allowStale) {
      return entry.value;
    }
  }
  if (allowStale) return null; // the stale fallback is instance-local data only, by design

  const shared = await kvGetJSON(`${KV_PREFIX}cache:${key}`);
  if (shared) cache.set(key, { value: shared, storedAt: Date.now(), expiresAt: Date.now() + CACHE_TTL_MS.active });
  return shared;
}

// ───────────────────────── Cainiao request ─────────────────────────
async function fetchCainiao(trackingNumber) {
  const url = new URL(CAINIAO_ENDPOINT);
  url.searchParams.set('mailNos', trackingNumber);
  url.searchParams.set('lang', 'en-US');
  url.searchParams.set('language', 'en-US');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let response;
  let body;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Referer: `https://global.cainiao.com/newDetail.htm?mailNoList=${encodeURIComponent(trackingNumber)}`,
      },
      signal: controller.signal,
    });
    body = await response.text(); // read inside the timeout so a slow body also aborts
  } catch (err) {
    throw new TrackingError(err.name === 'AbortError' ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_ERROR', err.message);
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 429) throw new TrackingError('UPSTREAM_RATE_LIMITED', 'HTTP 429');
  if (!response.ok) throw new TrackingError('UPSTREAM_ERROR', `HTTP ${response.status}`);

  let json;
  try {
    json = JSON.parse(body);
  } catch {
    const code = looksBlocked(body) ? 'UPSTREAM_BLOCKED' : 'UPSTREAM_BAD_RESPONSE';
    throw new TrackingError(code, `non-JSON body: ${body.slice(0, 160)}`);
  }
  if (!isObject(json)) throw new TrackingError('UPSTREAM_BAD_RESPONSE', 'JSON root is not an object');

  const hasModule = json.module != null || json.data != null;
  if (!hasModule && looksBlocked(JSON.stringify(json).slice(0, 4000))) {
    throw new TrackingError('UPSTREAM_BLOCKED', 'anti-bot challenge returned');
  }
  return json;
}

function looksBlocked(text) {
  return /rgv587_flag|x5secdata|punish|captcha|slide to verify|_____tmd_____/i.test(text || '');
}

// ───────────────────────── Parser ─────────────────────────
export function parseCainiao(json, trackingNumber) {
  const modules = toArray(json.module ?? json.data?.module ?? json.data).filter(isObject);
  const mod = modules.find((m) => normalizeTrackingNumber(m.mailNo) === trackingNumber) || modules[0];
  if (!mod) return failure('NOT_FOUND', { trackingNumber });

  const events = extractEvents(mod);
  const latestTrace = isObject(mod.latestTrace) ? mod.latestTrace : null;

  const statusCode = pick(mod, FIELDS.statusCode) || (latestTrace && pick(latestTrace, FIELDS.eventCode));
  const statusText = cleanText(
    pick(mod, FIELDS.statusText) || (latestTrace && pick(latestTrace, FIELDS.eventDesc))
  );

  const codeCategory = classify(statusCode);
  const textCategory = classify(statusText);
  if (!events.length && (!statusText || codeCategory === 'not_found' || textCategory === 'not_found')) {
    return failure('NOT_FOUND', { trackingNumber });
  }

  let category = [textCategory, codeCategory, events[0]?.category].find(
    (c) => c && c !== 'unknown' && c !== 'not_found'
  );
  category = category || 'unknown';

  const originCountry = HIDE_ORIGIN ? null : cleanText(pick(mod, FIELDS.originCountry));
  const destCountry = cleanText(pick(mod, FIELDS.destCountry));

  return {
    ok: true,
    trackingNumber,
    status: {
      category,
      label: STATUS_LABELS[category],
      code: statusCode || null,
      description: statusText || events[0]?.description || STATUS_LABELS[category],
    },
    estimatedDelivery: category === 'delivered' ? null : extractEta(mod),
    origin: originCountry ? { country: originCountry } : null,
    destination: destCountry ? { country: destCountry } : null,
    carriers: {
      origin: carrierFrom(mod.originCpInfo, { name: mod.originCpName }),
      lastMile: carrierFrom(mod.destCpInfo ?? mod.lastMileCpInfo, {
        name: mod.destCpName,
        trackingNumber: mod.lastMileMailNo ?? mod.destMailNo ?? mod.secondMailNo,
      }),
    },
    events,
    fetchedAt: new Date().toISOString(),
  };
}

function extractEvents(mod) {
  const raw = [];
  collectEventArrays(mod, raw, 0, new WeakSet());

  const seen = new Set();
  const events = [];
  for (const item of raw) {
    const event = normalizeEvent(item);
    if (!event) continue;
    const key = `${event.timestamp ?? `${event.date} ${event.time}`}|${event.description.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }

  events.sort((a, b) => b.sortKey - a.sortKey); // newest first
  return events.slice(0, MAX_EVENTS).map(({ sortKey, ...event }) => event);
}

/** Walks the module and collects every array whose items look like tracking events. */
function collectEventArrays(node, out, depth, visited) {
  if (depth > 6 || !node || typeof node !== 'object' || visited.has(node)) return;
  visited.add(node);

  if (Array.isArray(node)) {
    const events = node.filter((item) => isObject(item) && looksLikeEvent(item));
    if (events.length) {
      out.push(...events);
      return;
    }
    for (const child of node) collectEventArrays(child, out, depth + 1, visited);
    return;
  }
  for (const value of Object.values(node)) collectEventArrays(value, out, depth + 1, visited);
}

function looksLikeEvent(obj) {
  const hasTime = [...FIELDS.eventTime, ...FIELDS.eventTimeLocal].some((k) => obj[k] != null && obj[k] !== '');
  const hasDesc = FIELDS.eventDesc.some((k) => typeof obj[k] === 'string' && obj[k].trim());
  return hasTime && hasDesc;
}

function normalizeEvent(e) {
  const primary = splitLocation(cleanText(pick(e, FIELDS.eventDesc)));
  const alt = splitLocation(cleanText(pick(e, FIELDS.eventAltDesc)));
  const description = primary.text || alt.text;
  if (!description) return null;

  const location = cleanText(pick(e, FIELDS.eventLocation)) || primary.location || alt.location;
  const title = alt.text && alt.text.toLowerCase() !== description.toLowerCase() ? alt.text : null;
  const localSource = pick(e, FIELDS.eventTimeLocal) || (typeof e.time === 'string' ? e.time : null);
  const local = parseLocalDateTime(localSource);
  const ms = toMs(pick(e, FIELDS.eventTime, { allowNumbers: true }));
  const sortKey =
    ms ?? (local ? Date.parse(`${local.date}T${local.time || '00:00'}:00Z`) || 0 : 0);

  let category = classify(`${title || ''} ${description}`);
  if (category === 'unknown' || category === 'not_found') category = classify(pick(e, FIELDS.eventCode));
  if (category === 'unknown' || category === 'not_found') category = 'in_transit';

  return {
    timestamp: ms != null ? new Date(ms).toISOString() : null,
    date: local?.date ?? null, // date in the event's local time zone, YYYY-MM-DD
    time: local?.time ?? null, // HH:mm in the event's local time zone
    timeZone: cleanText(pick(e, ['timeZone', 'timezone'])) || null,
    location: location || null,
    description,
    title: title && title.toLowerCase() !== description.toLowerCase() ? title : null,
    carrier: cleanText(pick(e, FIELDS.eventCarrier) || (isObject(e.group) ? e.group.cpName : null)) || null,
    category,
    sortKey,
  };
}

// Many carriers prefix the location: "[Los Angeles, CA] Arrived at facility" or "【深圳】..."
function splitLocation(text) {
  if (!text) return { text: '', location: '' };
  const m = text.match(/^\s*[[【]([^\]】]{2,80})[\]】]\s*(.+)$/s);
  return m ? { text: m[2].trim(), location: m[1].trim() } : { text, location: '' };
}

function extractEta(mod) {
  const info = FIELDS.etaObject.map((k) => mod[k]).find(isObject) || {};
  const text = cleanText(pick(info, FIELDS.etaText) || mod.etaDesc);
  const from = toIso(pick(info, FIELDS.etaMin, { allowNumbers: true }));
  const to = toIso(pick(info, FIELDS.etaMax, { allowNumbers: true }) ?? mod.estimatedDeliveryTime);
  if (!text && !from && !to) return null;
  return { text: text || null, from, to };
}

function carrierFrom(info, extra = {}) {
  const o = isObject(info) ? info : {};
  const name = cleanText(pick(o, ['cpName', 'name', 'carrierName', 'providerName']) || extra.name);
  const trackingNumber = cleanText(pick(o, ['mailNo', 'trackingNumber'], { allowNumbers: true }) || extra.trackingNumber);
  if (!name && !trackingNumber) return null;
  return {
    name: name || null,
    trackingNumber: trackingNumber || null,
    url: safeUrl(pick(o, ['url', 'cpUrl', 'website', 'trackingUrl'])),
    phone: cleanText(pick(o, ['phone', 'contactPhone', 'cpPhone'], { allowNumbers: true })) || null,
  };
}

/**
 * Maps carrier text or status codes to one of:
 * info_received | in_transit | out_for_delivery | pickup | delivered | exception | not_found | unknown
 * Order matters: more specific states are checked before generic ones.
 */
export function classify(input) {
  if (!input) return 'unknown';
  const s = String(input).toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return 'unknown';

  if (/\bnot (found|exists?)\b|no (tracking )?(info|information|data|record)|order not exist/.test(s)) return 'not_found';
  if (
    /return(ed|ing)? to (sender|seller|origin)|undeliver|delivery (failed|failure|unsuccessful)|failed (delivery|attempt)|attempted delivery|\bexc\b|exception|\blost\b|damaged|refused|address (issue|problem|incorrect|incomplete)|held by customs|customs (hold|issue|exception)/.test(s)
  ) return 'exception';
  if (
    /order (received|placed|created)|gwms (accept|package)|package finished|ready for (shipping|dispatch)|store processing|shipment information received|label created|shipping (label|information) (created|received)|electronic (notification|information)|pre-?advice|awaiting (the )?(carrier|seller|courier)|waiting for (the )?(carrier|courier|seller|logistics)/.test(s)
  ) return 'info_received';
  if (
    /wait4sign|available for (pick ?up|collection)|ready for (pick ?up|collection)|awaiting (pick ?up|collection) (at|by (the )?(recipient|customer|addressee))|pick ?up point|collection point|parcel (locker|shop)|post office for pick/.test(s)
  ) return 'pickup';
  if (/out for delivery|\bdelivering\b|with (the )?(courier|driver) for delivery|on (its|the) way to (you|the recipient)/.test(s)) return 'out_for_delivery';
  if (
    /\bsign(ed|in)?\b|signed for|\bdelivered\b(?! to (the )?(airline|carrier|courier|logistics|post|sorting|hub|warehouse|facility|local|station|line ?haul|transport))/.test(s)
  ) return 'delivered';
  if (
    /transit|transport|customs|clearance|depart|arriv|shipped|dispatch|\bhub\b|sorting|sorted|facility|airline|flight|accepted|received by|handed over|picked ?up|collected|processing|left|leaving|outbound|inbound|warehouse|delivered to/.test(s)
  ) return 'in_transit';
  return 'unknown';
}

// ───────────────────────── Small helpers ─────────────────────────
function pick(obj, keys, { allowNumbers = false } = {}) {
  if (!isObject(obj)) return null;
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (allowNumbers && typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

function toMs(value) {
  if (value == null || value === '') return null;
  const str = String(value).trim();
  if (typeof value === 'number' || /^\d{9,13}$/.test(str)) {
    let n = Number(str);
    if (!Number.isFinite(n) || n <= 0) return null;
    if (n < 1e11) n *= 1000; // seconds -> ms
    return n > 1.4e12 && n < 4.1e12 ? n : null; // sanity range: 2014–2099
  }
  // Only trust strings that carry an explicit time zone (ISO with Z or offset)
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(str)) {
    const parsed = Date.parse(str);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function toIso(value) {
  const ms = toMs(value);
  return ms != null ? new Date(ms).toISOString() : null;
}

function parseLocalDateTime(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return {
    date: `${m[1]}-${pad(m[2])}-${pad(m[3])}`,
    time: m[4] != null ? `${pad(m[4])}:${m[5]}` : null,
  };
}

function cleanText(value) {
  if (value == null) return '';
  return String(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function safeUrl(value) {
  if (!value) return null;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

export function normalizeTrackingNumber(value) {
  if (value == null) return null;
  const s = String(value).replace(/[\s-]/g, '').toUpperCase();
  return TRACKING_RE.test(s) ? s : null;
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function failure(code, extra = {}) {
  return { ok: false, error: { code, message: ERROR_MESSAGES[code] || ERROR_MESSAGES.UPSTREAM_ERROR }, ...extra };
}
