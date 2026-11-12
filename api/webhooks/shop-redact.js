/**
 * Mandatory Shopify compliance webhook: shop/redact.
 * Fired 48 hours after a shop uninstalls the app. Unlike the customer webhooks, this app *does*
 * hold shop-specific state worth clearing: the cached offline Admin API access token (see
 * lib/shopify.js). It's already discarded reactively whenever Shopify answers a 401/403 with
 * it, but a shop that uninstalled and never issues another authenticated request would
 * otherwise leave a stale token sitting in the shared store until its TTL expires on its own.
 */
import { forgetAdminAccessToken } from '../../lib/shopify.js';
import { readVerifiedWebhook } from '../../lib/webhooks.js';

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.statusCode = 405;
    return res.end();
  }
  try {
    const { payload } = await readVerifiedWebhook(req);
    const shop = (payload?.shop_domain || '').toLowerCase();
    if (shop) forgetAdminAccessToken(shop);
    console.log(`[webhook] shop/redact shop=${shop || 'unknown'}`);
    res.statusCode = 200;
    return res.end();
  } catch (err) {
    console.warn(`[webhook] shop/redact rejected: ${err.message}`);
    res.statusCode = 401;
    return res.end();
  }
}
