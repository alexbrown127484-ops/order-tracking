/**
 * Mandatory Shopify compliance webhook: customers/data_request.
 * Fired when a customer (via the merchant) asks for a copy of their data.
 *
 * This app stores no customer-identifying data of its own — it only ever reads order and
 * fulfillment data live from the Admin API and caches tracking lookups by tracking number
 * (never by customer). There is nothing here to export, so the correct response is still a
 * prompt 200 acknowledging the request; Shopify requires this endpoint to exist and verify
 * HMAC even when there is no payload of your own to return.
 *
 * Register this URL (and customers/redact, shop/redact) as the app's compliance webhooks in
 * the Partner Dashboard / shopify.app.toml.
 */
import { readVerifiedWebhook } from '../../lib/webhooks.js';

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.statusCode = 405;
    return res.end();
  }
  try {
    const { shop, payload } = await readVerifiedWebhook(req);
    console.log(`[webhook] customers/data_request shop=${shop} customer=${payload?.customer?.id ?? 'unknown'}`);
    res.statusCode = 200;
    return res.end();
  } catch (err) {
    console.warn(`[webhook] customers/data_request rejected: ${err.message}`);
    res.statusCode = 401;
    return res.end();
  }
}
