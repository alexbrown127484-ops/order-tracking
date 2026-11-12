// Simple landing/health route so the app URL (and Shopify's post-install redirect) shows something.
export default function handler(req, res) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end('Healtence tracking service is running.');
}
