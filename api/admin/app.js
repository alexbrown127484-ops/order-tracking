/**
 * Serves the embedded admin dashboard (the app's home page inside Shopify admin).
 * vercel.json rewrites "/" to this function.
 */
import DASHBOARD_HTML from '../../lib/dashboard-html.js';
import { SHOP_RE } from '../../lib/shopify.js';

export default function handler(req, res) {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const shop = (params.get('shop') || '').toLowerCase();
  const frameAncestors = SHOP_RE.test(shop)
    ? `https://${shop} https://admin.shopify.com`
    : 'https://*.myshopify.com https://admin.shopify.com';

  const clientId = (process.env.SHOPIFY_CLIENT_ID || '').replace(/[^A-Za-z0-9_-]/g, '');
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', `frame-ancestors ${frameAncestors};`);
  res.end(DASHBOARD_HTML.replace('__SHOPIFY_CLIENT_ID__', clientId));
}
