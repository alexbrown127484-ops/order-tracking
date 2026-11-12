/**
 * Mandatory Shopify compliance webhook: customers/redact.
 * Fired 10 days after a customer requests erasure (or 6 months after the shop's last order
 * with no request, whichever applies) so apps can erase any customer data they hold.
 *
 * This app never stores data keyed by customer (see customers-data-request.js for why) — the
 * tracking cache is keyed only by tracking number and holds no name/address/email — so there is
 * nothing customer-specific to redact here. Kept as its own endpoint (rather than merged with
 * shop/redact) because Shopify sends these as distinct topics with distinct payload shapes.
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
    console.log(`[webhook] customers/redact shop=${shop} customer=${payload?.customer?.id ?? 'unknown'}`);
    res.statusCode = 200;
    return res.end();
  } catch (err) {
    console.warn(`[webhook] customers/redact rejected: ${err.message}`);
    res.statusCode = 401;
    return res.end();
  }
}
