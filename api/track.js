/**
 * Healtence order tracking — Shopify App Proxy endpoint (storefront)
 *
 * Storefront request:  https://healtence.com/apps/track?tracking_number=LP00123456789
 * Shopify proxies to:  https://<your-app>.vercel.app/api/track?tracking_number=...&shop=...&timestamp=...&signature=...
 *
 * Business errors (bad number, not found, carrier down) are returned with HTTP 200 and ok:false so
 * Shopify's proxy always passes the JSON body through. Only a failed signature returns 401.
 */
import { failure, getTracking, normalizeTrackingNumber } from '../lib/tracking.js';
import { verifyAppProxySignature } from '../lib/shopify.js';
import { sendJson } from '../lib/http.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return sendJson(res, 405, failure('METHOD_NOT_ALLOWED'));
  }

  const secret = process.env.SHOPIFY_APP_SECRET;
  if (!secret) {
    console.error('[track] SHOPIFY_APP_SECRET is not set');
    return sendJson(res, 500, failure('SERVER_MISCONFIGURED'));
  }

  const params = new URL(req.url, 'http://localhost').searchParams;
  const verification = verifyAppProxySignature(params, secret);
  if (!verification.ok) {
    console.warn(`[track] rejected request: ${verification.reason}`);
    return sendJson(res, 401, failure('UNAUTHORIZED'));
  }

  const trackingNumber = normalizeTrackingNumber(params.get('tracking_number'));
  if (!trackingNumber) return sendJson(res, 200, failure('INVALID_TRACKING_NUMBER'));

  return sendJson(res, 200, await getTracking(trackingNumber));
}
