// Generates a URL signed exactly the way Shopify's App Proxy signs it, so you can test the
// deployed function directly (without the storefront).
//
// Usage:
//   SHOPIFY_APP_SECRET=xxxx node scripts/sign-url.mjs https://your-app.vercel.app/api/track LP00123456789012
import crypto from 'node:crypto';

const [, , base, trackingNumber] = process.argv;
const secret = process.env.SHOPIFY_APP_SECRET;

if (!secret || !base || !trackingNumber) {
  console.error(
    'Usage: SHOPIFY_APP_SECRET=xxxx node scripts/sign-url.mjs https://your-app.vercel.app/api/track <tracking_number>'
  );
  process.exit(1);
}

const params = {
  shop: process.env.SHOPIFY_SHOP_DOMAIN || 'healtence.myshopify.com',
  logged_in_customer_id: '',
  path_prefix: '/apps/track',
  timestamp: String(Math.floor(Date.now() / 1000)),
  tracking_number: trackingNumber,
};

const message = Object.entries(params)
  .map(([k, v]) => `${k}=${v}`)
  .sort()
  .join('');
const signature = crypto.createHmac('sha256', secret).update(message).digest('hex');

const url = new URL(base);
for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
url.searchParams.set('signature', signature);
console.log(url.toString());
