/**
 * Admin dashboard: live delivery status for up to 10 tracking numbers at a time.
 * POST /api/admin/status   body: { "numbers": ["LP...", "..."] }
 * Auth: App Bridge session token in "Authorization: Bearer <token>".
 */
import { AdminError, authenticateAdmin } from '../../lib/shopify.js';
import { getTracking, normalizeTrackingNumber } from '../../lib/tracking.js';
import { readJsonBody, sendJson } from '../../lib/http.js';

const MAX_NUMBERS = 10;
const CONCURRENCY = 3;

function compact(result) {
  if (!result.ok) return { ok: false, code: result.error?.code || 'UPSTREAM_ERROR' };
  const events = Array.isArray(result.events) ? result.events : [];
  const latest = events[0] || null;
  const deliveredEvent =
    result.status.category === 'delivered' ? events.find((e) => e.category === 'delivered') || latest : null;
  return {
    ok: true,
    category: result.status.category,
    label: result.status.label,
    lastEvent: latest
      ? { description: latest.description, location: latest.location, date: latest.date, time: latest.time, timestamp: latest.timestamp }
      : null,
    firstEventAt: events.length ? events[events.length - 1].timestamp : null,
    deliveredAt: deliveredEvent?.timestamp || null,
    lastMile: result.carriers?.lastMile?.name || null,
    lastMileUrl: result.carriers?.lastMile?.url || null,
    destination: result.destination?.country || null,
    stale: Boolean(result.stale),
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' } });
  }

  try {
    authenticateAdmin(req);
  } catch (err) {
    const status = err instanceof AdminError ? err.status : 500;
    const code = err instanceof AdminError ? err.code : 'SERVER_ERROR';
    console.warn(`[admin/status] ${code}: ${err.message}`);
    return sendJson(res, status, { ok: false, error: { code, message: 'Reload the app from Shopify admin.' } });
  }

  const body = await readJsonBody(req);
  const numbers = [
    ...new Set((Array.isArray(body?.numbers) ? body.numbers : []).map(normalizeTrackingNumber).filter(Boolean)),
  ].slice(0, MAX_NUMBERS);

  const results = {};
  let index = 0;
  async function worker() {
    while (index < numbers.length) {
      const number = numbers[index++];
      results[number] = compact(await getTracking(number));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, numbers.length) }, worker));

  return sendJson(res, 200, { ok: true, results });
}
