/**
 * Admin dashboard: recent orders with fulfillment + tracking info.
 * GET /api/admin/orders?after=<cursor>
 * Auth: App Bridge session token in "Authorization: Bearer <token>".
 * Requires the read_orders scope.
 */
import { AdminError, adminGraphQL, authenticateAdmin, getAdminAccessToken } from '../../lib/shopify.js';
import { sendJson } from '../../lib/http.js';

const PAGE_SIZE = 50;

const ORDERS_QUERY = `
  query DashboardOrders($first: Int!, $after: String) {
    shop { name primaryDomain { url } }
    orders(first: $first, after: $after, sortKey: CREATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        createdAt
        cancelledAt
        displayFinancialStatus
        displayFulfillmentStatus
        currentSubtotalLineItemsQuantity
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        fulfillments(first: 10) {
          createdAt
          displayStatus
          trackingInfo(first: 5) { number company url }
        }
      }
    }
  }
`;

function mapOrder(order) {
  const shipments = [];
  for (const fulfillment of order.fulfillments || []) {
    for (const info of fulfillment.trackingInfo || []) {
      if (!info?.number) continue;
      shipments.push({
        trackingNumber: String(info.number).replace(/\s+/g, '').toUpperCase(),
        company: info.company || null,
        url: info.url || null,
        shippedAt: fulfillment.createdAt,
        fulfillmentStatus: fulfillment.displayStatus || null,
      });
    }
  }
  shipments.sort((a, b) => Date.parse(b.shippedAt) - Date.parse(a.shippedAt));

  return {
    id: order.id,
    legacyId: String(order.id).split('/').pop(),
    name: order.name,
    createdAt: order.createdAt,
    cancelled: Boolean(order.cancelledAt),
    financialStatus: order.displayFinancialStatus || null,
    fulfillmentStatus: order.displayFulfillmentStatus || null,
    items: order.currentSubtotalLineItemsQuantity ?? null,
    total: order.currentTotalPriceSet?.shopMoney || null,
    shipments,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET.' } });
  }

  try {
    const auth = authenticateAdmin(req);
    const accessToken = await getAdminAccessToken(auth);
    const params = new URL(req.url, 'http://localhost').searchParams;
    const after = params.get('after') || null;

    const data = await adminGraphQL({ shop: auth.shop, accessToken }, ORDERS_QUERY, { first: PAGE_SIZE, after });
    return sendJson(res, 200, {
      ok: true,
      shop: auth.shop,
      shopName: data.shop?.name || null,
      storefrontUrl: data.shop?.primaryDomain?.url || null,
      orders: (data.orders?.nodes || []).map(mapOrder),
      pageInfo: data.orders?.pageInfo || { hasNextPage: false, endCursor: null },
    });
  } catch (err) {
    const code = err instanceof AdminError ? err.code : 'SERVER_ERROR';
    const status = err instanceof AdminError ? err.status : 500;
    console.error(`[admin/orders] ${code}: ${err.message}`);
    return sendJson(res, status, { ok: false, error: { code, message: adminMessage(code) } });
  }
}

export function adminMessage(code) {
  switch (code) {
    case 'UNAUTHORIZED':
      return 'Your session expired. Reload the app from Shopify admin.';
    case 'ACCESS_DENIED':
    case 'TOKEN_EXCHANGE_FAILED':
      return 'The app can’t read orders yet. Add the read_orders scope to the app, release a new version, and approve the update in Shopify admin.';
    case 'SERVER_MISCONFIGURED':
      return 'SHOPIFY_CLIENT_ID or SHOPIFY_APP_SECRET is missing in Vercel. Add it and redeploy.';
    case 'SHOPIFY_TIMEOUT':
    case 'SHOPIFY_UNREACHABLE':
      return 'Shopify took too long to respond. Try again.';
    default:
      return 'Orders couldn’t be loaded. Try again, and check Vercel logs if it keeps happening.';
  }
}
