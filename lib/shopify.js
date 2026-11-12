/**
 * Shopify helpers:
 *  - App Proxy signature check (storefront requests to /apps/track)
 *  - Session token (JWT) check for the embedded admin dashboard
 *  - Token exchange (session token -> offline Admin API access token, cached in memory)
 *  - Admin GraphQL requests
 *
 * Environment variables:
 *   SHOPIFY_APP_SECRET   (required) the app's Client secret
 *   SHOPIFY_CLIENT_ID    (required for the dashboard) the app's Client ID
 *   SHOPIFY_SHOP_DOMAIN  (optional) the store's permanent myshopify domain, e.g. u6ijzd-7m.myshopify.com
 */
import crypto from 'node:crypto';
import { kvDelete, kvGetJSON, kvSetJSON } from './kv.js';

export const ADMIN_API_VERSION = '2026-10';
const SIGNATURE_MAX_AGE_SEC = 300;
const CLOCK_SKEW_SEC = 10;
export const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export class AdminError extends Error {
  constructor(code, detail, status = 500) {
    super(detail || code);
    this.code = code;
    this.status = status;
  }
}

function expectedShop() {
  return (process.env.SHOPIFY_SHOP_DOMAIN || '').trim().toLowerCase();
}

// ───────────────────────── Shopify App Proxy signature ─────────────────────────
/**
 * Shopify signs App Proxy requests with a `signature` query param:
 *   1. remove `signature`
 *   2. for each key: "key=value" (repeated keys: values joined with ",")
 *   3. sort those strings, concatenate with no separator
 *   4. HMAC-SHA256 hex digest with the app's Client secret
 */
export function verifyAppProxySignature(params, secret) {
  const signature = params.get('signature') || '';
  if (!/^[a-f0-9]{64}$/i.test(signature)) return { ok: false, reason: 'missing or malformed signature' };

  const grouped = new Map();
  for (const [key, value] of params) {
    if (key === 'signature') continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(value);
  }
  const message = [...grouped.entries()]
    .map(([key, values]) => `${key}=${values.join(',')}`)
    .sort()
    .join('');

  const expected = crypto.createHmac('sha256', secret).update(message, 'utf8').digest();
  const received = Buffer.from(signature, 'hex');
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    return { ok: false, reason: 'signature mismatch' };
  }

  const timestamp = Number(params.get('timestamp'));
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > SIGNATURE_MAX_AGE_SEC) {
    return { ok: false, reason: 'timestamp outside allowed window' };
  }

  const shopDomain = expectedShop();
  if (shopDomain && (params.get('shop') || '').toLowerCase() !== shopDomain) {
    return { ok: false, reason: 'unexpected shop' };
  }
  return { ok: true };
}


// ───────────────────────── Session token (embedded admin) ─────────────────────────
function base64UrlDecode(input) {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Verifies the HS256 session token App Bridge sends in the Authorization header. */
export function verifySessionToken(token, { secret, clientId }) {
  if (!token) return { ok: false, reason: 'missing session token' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed session token' };
  const [headerB64, payloadB64, signatureB64] = parts;

  let header;
  let payload;
  try {
    header = JSON.parse(base64UrlDecode(headerB64).toString('utf8'));
    payload = JSON.parse(base64UrlDecode(payloadB64).toString('utf8'));
  } catch {
    return { ok: false, reason: 'unreadable session token' };
  }
  if (header.alg !== 'HS256') return { ok: false, reason: 'unexpected algorithm' };

  const expected = crypto.createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest();
  const received = base64UrlDecode(signatureB64);
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    return { ok: false, reason: 'session token signature mismatch' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now - CLOCK_SKEW_SEC) return { ok: false, reason: 'session token expired' };
  if (typeof payload.nbf === 'number' && payload.nbf > now + CLOCK_SKEW_SEC) return { ok: false, reason: 'session token not active yet' };
  if (clientId && payload.aud !== clientId) return { ok: false, reason: 'session token audience mismatch' };

  let shop = '';
  try {
    shop = new URL(payload.dest).hostname.toLowerCase();
  } catch {
    return { ok: false, reason: 'session token has no shop' };
  }
  if (!SHOP_RE.test(shop)) return { ok: false, reason: 'invalid shop in session token' };
  const shopDomain = expectedShop();
  if (shopDomain && shop !== shopDomain) return { ok: false, reason: 'unexpected shop' };

  return { ok: true, shop, payload };
}

/** Reads and verifies the Bearer session token on an admin API request. Throws AdminError. */
export function authenticateAdmin(req) {
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const secret = process.env.SHOPIFY_APP_SECRET;
  if (!clientId || !secret) {
    throw new AdminError('SERVER_MISCONFIGURED', 'SHOPIFY_CLIENT_ID or SHOPIFY_APP_SECRET is not set', 500);
  }
  const header = req.headers?.authorization || '';
  const idToken = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const result = verifySessionToken(idToken, { secret, clientId });
  if (!result.ok) throw new AdminError('UNAUTHORIZED', result.reason, 401);
  return { shop: result.shop, idToken, clientId, secret };
}

// ───────────────────────── Token exchange + Admin GraphQL ─────────────────────────
// Offline tokens are cached locally (instant, survives nothing) and in KV (shared across every
// instance/region, survives cold starts). Without KV configured this is just the in-memory Map
// it always was, so every cold start pays for a fresh token exchange — fine for one store, but
// as the app is installed on more shops this is what keeps token-exchange calls (and Shopify's
// rate limit on them) from scaling linearly with request volume and instance count.
const tokenCache = new Map(); // shop -> { token, expiresAt }

function tokenKey(shop) {
  return `shopify:token:${shop}`;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    return { res, text };
  } catch (err) {
    throw new AdminError(err.name === 'AbortError' ? 'SHOPIFY_TIMEOUT' : 'SHOPIFY_UNREACHABLE', err.message, 504);
  } finally {
    clearTimeout(timer);
  }
}

export async function getAdminAccessToken({ shop, idToken, clientId, secret }) {
  const cached = tokenCache.get(shop);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const shared = await kvGetJSON(tokenKey(shop));
  if (shared && shared.expiresAt > Date.now() + 60_000) {
    tokenCache.set(shop, shared);
    return shared.token;
  }

  const { res, text } = await fetchWithTimeout(
    `https://${shop}/admin/oauth/access_token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: secret,
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: idToken,
        subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
        requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
      }),
    },
    10_000
  );

  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* handled below */
  }
  if (!res.ok || !data?.access_token) {
    throw new AdminError('TOKEN_EXCHANGE_FAILED', `HTTP ${res.status}: ${text.slice(0, 300)}`, 502);
  }

  const ttlMs = Number(data.expires_in) > 0 ? Number(data.expires_in) * 1000 : 12 * 60 * 60 * 1000;
  const entry = { token: data.access_token, expiresAt: Date.now() + ttlMs };
  tokenCache.set(shop, entry);
  await kvSetJSON(tokenKey(shop), entry, Math.round(ttlMs / 1000));
  return data.access_token;
}

export function forgetAdminAccessToken(shop) {
  tokenCache.delete(shop);
  // Fire-and-forget: callers throw right after this, so don't make them wait on KV.
  kvDelete(tokenKey(shop)).catch((err) => console.error(`[shopify] forget token ${shop}: ${err.message}`));
}

export async function adminGraphQL({ shop, accessToken }, query, variables = {}) {
  const { res, text } = await fetchWithTimeout(
    `https://${shop}/admin/api/${ADMIN_API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({ query, variables }),
    },
    15_000
  );

  if (res.status === 401 || res.status === 403) {
    forgetAdminAccessToken(shop);
    throw new AdminError('ACCESS_DENIED', `HTTP ${res.status}: ${text.slice(0, 300)}`, 403);
  }
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    throw new AdminError('SHOPIFY_BAD_RESPONSE', `HTTP ${res.status}: ${text.slice(0, 200)}`, 502);
  }
  if (Array.isArray(data.errors) && data.errors.length) {
    const denied = data.errors.some((e) => e?.extensions?.code === 'ACCESS_DENIED');
    if (denied) forgetAdminAccessToken(shop);
    const message = data.errors.map((e) => e?.message).filter(Boolean).join('; ');
    throw new AdminError(denied ? 'ACCESS_DENIED' : 'GRAPHQL_ERROR', message.slice(0, 500), denied ? 403 : 502);
  }
  if (!res.ok) throw new AdminError('SHOPIFY_ERROR', `HTTP ${res.status}: ${text.slice(0, 200)}`, 502);
  return data.data;
}
