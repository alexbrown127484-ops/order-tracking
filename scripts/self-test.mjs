// Offline self-test. Runs the real handler against a mocked Cainiao response — no network needed.
//   npm test
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

process.env.SHOPIFY_APP_SECRET = 'test_secret';
process.env.SHOPIFY_SHOP_DOMAIN = 'healtence.myshopify.com';

const { default: handler } = await import('../api/track.js');
const { classify, parseCainiao } = await import('../lib/tracking.js');
const { verifySessionToken } = await import('../lib/shopify.js');

const SAMPLE = {
  success: true,
  module: [
    {
      mailNo: 'LP00123456789012',
      originCountry: 'China',
      destCountry: 'United States',
      status: 'DELIVERING',
      statusDesc: 'Out for delivery',
      globalEtaInfo: { etaDesc: 'Estimated delivery: Nov 12 - Nov 14', deliveryMinTime: 1762905600000, deliveryMaxTime: 1763078400000 },
      destCpInfo: { cpName: 'USPS', url: 'https://www.usps.com', mailNo: '9400111899223344556677' },
      detailList: [
        { time: 1762850000000, timeStr: '2025-11-11 08:33:20', timeZone: 'GMT-5', desc: '[New York, NY] Out for delivery', standerdDesc: 'Out for delivery' },
        { time: 1762700000000, timeStr: '2025-11-09 14:53:20', desc: 'Arrived at destination country', standerdDesc: 'Arrived at destination' },
        { time: 1762500000000, timeStr: '2025-11-07 07:20:00', desc: 'Customs clearance completed' },
        { time: 1762300000000, timeStr: '2025-11-05 00:46:40', desc: 'Departed from sorting center', group: { cpName: 'Cainiao' } },
        { time: 1762100000000, timeStr: '2025-11-02 18:13:20', desc: 'Order received by logistics provider' },
      ],
      // duplicate event in another nested array, should be de-duplicated
      latestTraceList: [{ time: 1762850000000, desc: '[New York, NY] Out for delivery' }],
    },
  ],
};

let fetchCalls = 0;
globalThis.fetch = async () => {
  fetchCalls += 1;
  return new Response(JSON.stringify(SAMPLE), { status: 200, headers: { 'content-type': 'application/json' } });
};

function signedUrl(params, secret = 'test_secret') {
  const message = Object.entries(params).map(([k, v]) => `${k}=${v}`).sort().join('');
  const signature = crypto.createHmac('sha256', secret).update(message).digest('hex');
  const qs = new URLSearchParams({ ...params, signature });
  return `/api/track?${qs}`;
}

async function call(url) {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(b) { this.body = b; },
  };
  await handler({ method: 'GET', url }, res);
  return { status: res.statusCode, json: JSON.parse(res.body) };
}

const base = {
  shop: 'healtence.myshopify.com',
  logged_in_customer_id: '',
  path_prefix: '/apps/track',
  timestamp: String(Math.floor(Date.now() / 1000)),
};

// 1. Valid request
let r = await call(signedUrl({ ...base, tracking_number: 'lp0012 3456 789012' }));
assert.equal(r.status, 200);
assert.equal(r.json.ok, true);
assert.equal(r.json.trackingNumber, 'LP00123456789012');
assert.equal(r.json.status.category, 'out_for_delivery');
assert.equal(r.json.events.length, 5, 'duplicates removed');
assert.equal(r.json.events[0].location, 'New York, NY');
assert.equal(r.json.events[0].description, 'Out for delivery');
assert.equal(r.json.events[0].date, '2025-11-11');
assert.equal(r.json.events.at(-1).category, 'info_received');
assert.equal(r.json.carriers.lastMile.name, 'USPS');
assert.ok(r.json.estimatedDelivery.from);
assert.equal(r.json.cached, false);

// 2. Second call served from cache
r = await call(signedUrl({ ...base, tracking_number: 'LP00123456789012' }));
assert.equal(r.json.cached, true);
assert.equal(fetchCalls, 1);

// 3. Bad signature
r = await call(signedUrl({ ...base, tracking_number: 'LP00123456789012' }, 'wrong_secret'));
assert.equal(r.status, 401);

// 4. Expired timestamp
r = await call(signedUrl({ ...base, timestamp: String(Math.floor(Date.now() / 1000) - 3600), tracking_number: 'LP00123456789012' }));
assert.equal(r.status, 401);

// 5. Wrong shop
r = await call(signedUrl({ ...base, shop: 'other.myshopify.com', tracking_number: 'LP00123456789012' }));
assert.equal(r.status, 401);

// 6. Invalid tracking number
r = await call(signedUrl({ ...base, tracking_number: 'abc' }));
assert.equal(r.json.ok, false);
assert.equal(r.json.error.code, 'INVALID_TRACKING_NUMBER');

// 7. Not found
globalThis.fetch = async () => new Response(JSON.stringify({ success: true, module: [{ mailNo: 'XX123456789', status: 'ORDER_NOT_EXISTS', detailList: [] }] }), { status: 200 });
r = await call(signedUrl({ ...base, tracking_number: 'XX123456789' }));
assert.equal(r.json.error.code, 'NOT_FOUND');

// 8. Anti-bot page
globalThis.fetch = async () => new Response('<html>punish captcha</html>', { status: 200 });
r = await call(signedUrl({ ...base, tracking_number: 'YY123456789' }));
assert.equal(r.json.error.code, 'UPSTREAM_BLOCKED');

// 9. Timeout
globalThis.fetch = async (_u, { signal }) =>
  new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
const t0 = Date.now();
r = await call(signedUrl({ ...base, tracking_number: 'ZZ123456789' }));
assert.equal(r.json.error.code, 'UPSTREAM_TIMEOUT');
assert.ok(Date.now() - t0 < 10_000);

// 10. Classifier spot checks
assert.equal(classify('SIGNIN'), 'delivered');
assert.equal(classify('WAIT4SIGNIN'), 'pickup');
assert.equal(classify('Delivered to airline'), 'in_transit');
assert.equal(classify('Delivered, In/At Mailbox'), 'delivered');
assert.equal(classify('Returned to sender'), 'exception');


// 11. Real response shape from global.cainiao.com/global/detail.json (Nov 2026)
const REAL = {"module":[{"mailNo":"420374159212290424563600001145","originCountry":"Mainland China","destCountry":"USA","status":"CLEAR_CUSTOMS","statusDesc":"In customs ","mailNoSource":"AE",
 "processInfo":{"progressStatus":"NORMAL","progressPointList":[{"pointName":"Mainland China","light":true},{"pointName":"USA"},{"pointName":"Delivered"}]},
 "latestTrace":{"time":1794352023000,"timeStr":"2026-11-11 07:07:03","desc":"Export clearance success","standerdDesc":"Export customs clearance complete","descTitle":"Carrier note:","timeZone":"GMT+8","actionCode":"CC_EX_SUCCESS"},
 "detailList":[
  {"time":1794352023000,"timeStr":"2026-11-11 07:07:03","desc":"Export clearance success","standerdDesc":"Export customs clearance complete","descTitle":"Carrier note:","timeZone":"GMT+8","actionCode":"CC_EX_SUCCESS","group":{"nodeDesc":"At customs"}},
  {"time":1794351120000,"timeStr":"2026-11-11 06:52:00","desc":"Export customs clearance started","standerdDesc":"Export customs clearance started","descTitle":"Carrier note:","timeZone":"GMT+8","actionCode":"CC_EX_START"},
  {"time":1794308569000,"timeStr":"2026-11-10 19:02:49","desc":"Outbound in sorting center","standerdDesc":"[Mayong Town] Departed from sorting center","descTitle":"Carrier note:","timeZone":"GMT+8","actionCode":"SC_OUTBOUND_SUCCESS"},
  {"time":1794270110734,"timeStr":"2026-11-10 08:21:50","desc":"Package finished","standerdDesc":"Package ready for shipping from warehouse","descTitle":"Carrier note:","timeZone":"GMT+0800","actionCode":"GWMS_PACKAGE"},
  {"time":1794259411447,"timeStr":"2026-11-10 05:23:31","desc":"Order received successfully","standerdDesc":"Shipment information received by warehouse electronically","descTitle":"Carrier note:","timeZone":"GMT+0800","actionCode":"GWMS_ACCEPT"}],
 "daysNumber":"2\tday(s)"}],"success":true};
const real = parseCainiao(REAL, '420374159212290424563600001145');
assert.equal(real.ok, true);
assert.equal(real.status.category, 'in_transit');
assert.equal(real.events.length, 5);
assert.equal(real.events[0].description, 'Export customs clearance complete');
assert.equal(real.events[2].location, 'Mayong Town');
assert.equal(real.events[2].description, 'Departed from sorting center');
assert.equal(real.events[3].category, 'info_received');
assert.equal(real.events[4].category, 'info_received');
assert.equal(real.destination.country, 'USA');


// 12. Admin session token
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(payload, secret = 'test_secret') {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(payload);
  const sig = crypto.createHmac('sha256', secret).update(head + '.' + body).digest('base64url');
  return head + '.' + body + '.' + sig;
}
const now = Math.floor(Date.now() / 1000);
const goodPayload = { iss: 'https://healtence.myshopify.com/admin', dest: 'https://healtence.myshopify.com', aud: 'client123', exp: now + 60, nbf: now - 5 };
assert.equal(verifySessionToken(jwt(goodPayload), { secret: 'test_secret', clientId: 'client123' }).ok, true);
assert.equal(verifySessionToken(jwt(goodPayload, 'nope'), { secret: 'test_secret', clientId: 'client123' }).ok, false);
assert.equal(verifySessionToken(jwt({ ...goodPayload, exp: now - 120 }), { secret: 'test_secret', clientId: 'client123' }).ok, false);
assert.equal(verifySessionToken(jwt({ ...goodPayload, aud: 'other' }), { secret: 'test_secret', clientId: 'client123' }).ok, false);
assert.equal(verifySessionToken(jwt({ ...goodPayload, dest: 'https://other.myshopify.com' }), { secret: 'test_secret', clientId: 'client123' }).ok, false);

// 13. Webhook HMAC verification
const { verifyWebhookHmac } = await import('../lib/webhooks.js');
const whBody = Buffer.from(JSON.stringify({ shop_domain: 'healtence.myshopify.com' }));
const whSig = crypto.createHmac('sha256', 'test_secret').update(whBody).digest('base64');
assert.equal(verifyWebhookHmac(whBody, whSig, 'test_secret'), true);
assert.equal(verifyWebhookHmac(whBody, whSig, 'wrong_secret'), false);
assert.equal(verifyWebhookHmac(whBody, 'not-base64-but-decodable==', 'test_secret'), false);
assert.equal(verifyWebhookHmac(whBody, '', 'test_secret'), false);
assert.equal(verifyWebhookHmac(Buffer.from('{"tampered":true}'), whSig, 'test_secret'), false);

// 14. Shared KV layer falls back to in-memory cleanly when unconfigured (no UPSTASH_* env vars here)
const { kvGetJSON, kvSetJSON, kvIncrWindow, KV_ENABLED } = await import('../lib/kv.js');
assert.equal(KV_ENABLED, false);
assert.equal(await kvGetJSON('self-test:missing'), null);
await kvSetJSON('self-test:key', { hello: 'world' }, 60);
assert.deepEqual(await kvGetJSON('self-test:key'), { hello: 'world' });
assert.equal(await kvIncrWindow('self-test:window', 60), 1);
assert.equal(await kvIncrWindow('self-test:window', 60), 2);

console.log('All self-tests passed.');
