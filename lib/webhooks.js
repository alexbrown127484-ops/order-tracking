/**
 * Shopify webhook verification.
 *
 * Shopify signs every webhook body with HMAC-SHA256 (base64, in the X-Shopify-Hmac-Sha256
 * header), computed over the *exact raw bytes* of the request body. That means these routes
 * must disable Vercel's automatic JSON body parsing (see `config` in each webhook handler) —
 * parsing and re-serializing the body first would not reliably reproduce the original bytes
 * (key order, whitespace, unicode escaping), and the signature would fail to verify.
 */
import crypto from 'node:crypto';

export async function readRawBody(req, maxBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function verifyWebhookHmac(rawBody, header, secret) {
  if (!header) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  let received;
  try {
    received = Buffer.from(header, 'base64');
  } catch {
    return false;
  }
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

/**
 * Reads, verifies and JSON-parses a webhook request. Throws with a short reason on any failure
 * so the handler can log it and reply 401 — Shopify retries on non-2xx, so these errors are
 * expected to be transient (e.g. a redeployed, momentarily-unconfigured secret) rather than silent.
 */
export async function readVerifiedWebhook(req) {
  const secret = process.env.SHOPIFY_APP_SECRET;
  if (!secret) throw new Error('SHOPIFY_APP_SECRET is not set');

  const raw = await readRawBody(req);
  const header = req.headers?.['x-shopify-hmac-sha256'];
  if (!verifyWebhookHmac(raw, header, secret)) throw new Error('HMAC verification failed');

  let payload = null;
  try {
    payload = JSON.parse(raw.toString('utf8') || '{}');
  } catch {
    throw new Error('body is not valid JSON');
  }
  return {
    payload,
    shop: req.headers?.['x-shopify-shop-domain'] || null,
    topic: req.headers?.['x-shopify-topic'] || null,
  };
}
