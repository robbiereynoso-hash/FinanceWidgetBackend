require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const http2 = require('http2');
const { PlaidApi, PlaidEnvironments, Configuration } = require('plaid');

const app = express();
app.use(express.json());

// Public base URL of this backend. Used to stamp webhook URLs onto Plaid Items
// so Plaid knows where to ping us on new transaction / holding data. Fallback
// is the Railway hostname so the backend keeps working without explicit env.
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://financewidgetbackend-production.up.railway.app';
const WEBHOOK_URL = PUBLIC_BASE_URL + '/api/plaid_webhook';

// iOS bundle ID — APNs uses this as the "topic" for routing pushes.
const APNS_BUNDLE_ID = 'com.Victorian.FinanceWidget';

// APNs endpoint switches between sandbox (Xcode dev builds) and production
// (TestFlight + App Store builds). The same .p8 key signs JWTs for both
// endpoints because it was created with "Sandbox & Production" environment
// in the Apple Dev portal. APNS_PRODUCTION env var flips us between them —
// default false for development, set true on Railway when shipping.
const APNS_HOST = (process.env.APNS_PRODUCTION === 'true')
  ? 'api.push.apple.com'
  : 'api.sandbox.push.apple.com';

// In-memory map: Plaid item_id → APNs device token. Populated by
// /api/register_device on every iOS cold launch. Ephemeral by design —
// Railway containers don't persist disk across deploys, but the app
// re-registers on every launch so the map rebuilds within seconds. A
// webhook arriving DURING the few-second redeploy window is lost; Plaid
// retries webhooks for ~72h so subsequent ones land fine.
const deviceTokensByItemId = new Map();

// APNs provider JWT. Apple requires this be re-signed at least every 60
// minutes; we cache for 50 minutes with a 10-minute safety margin. The
// JWT is ES256-signed with the .p8 EC private key from the Apple Dev
// portal. Using Node built-ins (crypto + http2) instead of the `apn`
// library because `apn` carries 19+ CVEs via outdated transitive deps
// (jsonwebtoken, node-forge — both have signature-bypass advisories).
let apnsJwtCache = { token: null, mintedAt: 0 };
function getApnsJwt() {
  if (!process.env.APNS_KEY_ID || !process.env.APNS_TEAM_ID || !process.env.APNS_PRIVATE_KEY) {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (apnsJwtCache.token && (now - apnsJwtCache.mintedAt) < 50 * 60) {
    return apnsJwtCache.token;
  }
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: process.env.APNS_KEY_ID })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: process.env.APNS_TEAM_ID, iat: now })).toString('base64url');
  const message = header + '.' + payload;
  // dsaEncoding 'ieee-p1363' gives the raw r||s 64-byte signature JWT
  // expects (default DER format is not accepted by APNs).
  const signature = crypto
    .createSign('SHA256')
    .update(message)
    .sign({ key: process.env.APNS_PRIVATE_KEY, dsaEncoding: 'ieee-p1363' })
    .toString('base64url');
  apnsJwtCache = { token: message + '.' + signature, mintedAt: now };
  return apnsJwtCache.token;
}

function sendSilentPush(deviceToken) {
  const jwt = getApnsJwt();
  if (!jwt) {
    console.warn('[APNs] Not configured — skipping push');
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const client = http2.connect('https://' + APNS_HOST);
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      try { client.close(); } catch (e) {}
      resolve();
    };
    client.on('error', (err) => {
      console.error('[APNs] connect error:', err.message);
      done();
    });
    const req = client.request({
      ':method': 'POST',
      ':path': '/3/device/' + deviceToken,
      'authorization': 'bearer ' + jwt,
      'apns-topic': APNS_BUNDLE_ID,
      'apns-push-type': 'background',
      'apns-priority': '5',
      'apns-expiration': '0',
      'content-type': 'application/json',
    });
    let status = 0;
    let body = '';
    req.on('response', (headers) => { status = headers[':status']; });
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (status === 200) {
        console.log('[APNs] Push sent to', deviceToken.slice(0, 8) + '…');
      } else {
        console.warn('[APNs] Push failed (' + status + '):', body);
      }
      done();
    });
    req.on('error', (err) => {
      console.error('[APNs] send error:', err.message);
      done();
    });
    req.write(JSON.stringify({ aps: { 'content-available': 1 }, type: 'sync' }));
    req.end();
  });
}

// Apple App Site Association — served at /.well-known/apple-app-site-association
// for Universal Links. Plaid OAuth bounces the user to PLAID_REDIRECT_URI after the
// bank login; iOS reads this file to deep-link the redirect back into the app.
// appID embeds the real Apple Team ID (Y9SL7H6THQ).
// Apple requires Content-Type application/json and no file extension.
// Inlined as an object (instead of sendFile from .well-known/) because Railway's
// Nixpacks builder excludes hidden directories from the deploy bundle.
const APPLE_APP_SITE_ASSOCIATION = {
  applinks: {
    apps: [],
    details: [
      {
        appID: 'Y9SL7H6THQ.com.Victorian.FinanceWidget',
        paths: ['/oauth-redirect', '/oauth-redirect/*'],
      },
    ],
  },
};
app.get('/.well-known/apple-app-site-association', (req, res) => {
  res.type('application/json').send(APPLE_APP_SITE_ASSOCIATION);
});

// Pick the right Plaid secret based on PLAID_ENV. Production access requires a
// separate secret from the sandbox one — both live as Railway env vars and we
// switch by environment so the flip is a single env change rather than a code
// change. Falls back to the sandbox secret if production isn't set yet, so the
// backend stays bootable on first prod deploy if env vars haven't all landed.
const plaidEnv = process.env.PLAID_ENV || 'sandbox';
const plaidSecret = plaidEnv === 'production'
  ? (process.env.PLAID_PRODUCTION_SECRET || process.env.PLAID_SANDBOX_SECRET)
  : process.env.PLAID_SANDBOX_SECRET;

const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[plaidEnv],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': plaidSecret,
    },
  },
});

const plaidClient = new PlaidApi(plaidConfig);

// Plaid error codes that mean "this Item is dead — re-Link required to recover."
// We surface these to iOS as `{ requiresRelink: true }` with a 200 so the app can
// distinguish "the bank Item needs to be reconnected" from a generic network/500
// failure. Without this, iOS sees a 500, swallows the error, and keeps showing
// stale data forever (the exact bug we saw on 2026-05-26).
//   ITEM_NOT_FOUND       — Item was removed via /item/remove or by user from bank app
//   INVALID_ACCESS_TOKEN — token was rotated or never valid
//   ITEM_LOGIN_REQUIRED  — bank password changed; user must re-authenticate
//   ITEM_NO_VERIFICATION — bank revoked Plaid's auth post-link
const RELINK_ERROR_CODES = new Set([
  'ITEM_NOT_FOUND',
  'INVALID_ACCESS_TOKEN',
  'ITEM_LOGIN_REQUIRED',
  'ITEM_NO_VERIFICATION',
]);

function isRelinkError(err) {
  const code = err && err.response && err.response.data && err.response.data.error_code;
  return code && RELINK_ERROR_CODES.has(code);
}

function relinkErrorCode(err) {
  return err.response.data.error_code;
}

// `flow` is "bank" (default) or "investments". Two flows because most banks don't
// support investments and most brokerages don't support transactions, so a single
// link_token covering both wouldn't surface either.
//
// account_filters with account_selection_enabled lets the user pick WHICH sub-accounts
// to share at Link time — a bank returning 7 accounts won't auto-bill us for all 7.
// User self-selects what they actually want to track.
app.post('/api/create_link_token', async (req, res) => {
  try {
    const flow = (req.body && req.body.flow) || 'bank';
    const products = flow === 'investments' ? ['investments'] : ['transactions'];
    // Per-install Plaid identity. The iOS app sends a stable per-install UUID so
    // each install is a DISTINCT Plaid user. A shared client_user_id made Plaid
    // treat every Link as the same returning user and funnel people back to their
    // first-linked institution instead of the bank they picked (Bug #12), and was
    // a privacy bug (all users sharing one Plaid identity). Legacy fallback kept
    // for any old client that doesn't send the field.
    const clientUserId = (req.body && req.body.client_user_id) || 'finance-widget-user';
    // OAuth redirect URI — required for production OAuth banks (Chase, BoA, Wells, etc.).
    // Gated on BOTH PLAID_REDIRECT_URI being set AND PLAID_ENV being non-sandbox.
    // Sandbox doesn't validate redirect URIs the same way and rejects link_token_create
    // with HTTP 400 when redirect_uri is supplied unless the URI is registered for the
    // sandbox env in Plaid Dashboard. The cleanest stance: only attach redirect_uri
    // when we're actually in production (where OAuth banks need it). Sandbox stays
    // OAuth-less, which is fine — sandbox's First Platypus Bank doesn't OAuth-redirect.
    const env = process.env.PLAID_ENV || 'sandbox';
    const linkParams = {
      user: { client_user_id: clientUserId },
      client_name: 'Finance Widget',
      products,
      country_codes: ['US'],
      language: 'en',
      // Surface Plaid's account-selection screen during Link.
      account_filters: flow === 'investments'
        ? { investment: { account_subtypes: ['all'] } }
        : {
            depository: { account_subtypes: ['all'] },
            credit: { account_subtypes: ['all'] },
          },
    };
    if (process.env.PLAID_REDIRECT_URI && env !== 'sandbox') {
      linkParams.redirect_uri = process.env.PLAID_REDIRECT_URI;
    }
    // Stamp the webhook URL onto every new Item. Plaid pings this URL on
    // SYNC_UPDATES_AVAILABLE / HOLDINGS DEFAULT_UPDATE so the backend can
    // forward a silent push and the app/widget refresh within minutes.
    linkParams.webhook = WEBHOOK_URL;
    const response = await plaidClient.linkTokenCreate(linkParams);
    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// Disconnect a Plaid Item. Calls /item/remove which halts billing for that Item's
// accounts. Idempotent: returns success even if the item was already removed.
app.post('/api/disconnect_item', async (req, res) => {
  try {
    const { access_token } = req.body;
    await plaidClient.itemRemove({ access_token });
    res.json({ removed: true });
  } catch (err) {
    // ITEM_NOT_FOUND / INVALID_ACCESS_TOKEN are fine — already gone or already invalid.
    const code = err.response?.data?.error_code;
    if (code === 'ITEM_NOT_FOUND' || code === 'INVALID_ACCESS_TOKEN') {
      return res.json({ removed: true, note: code });
    }
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/exchange_token', async (req, res) => {
  try {
    const { public_token } = req.body;
    const response = await plaidClient.itemPublicTokenExchange({ public_token });
    res.json({
      access_token: response.data.access_token,
      item_id: response.data.item_id,
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// Fetch an institution's optional metadata (logo + brand color) by id. Plaid
// Link's client-side success metadata only carries institution id + name, so
// the app calls this once per connection to enrich the stored credential.
// /institutions/get_by_id is NOT billed. `logo` is a base64-encoded PNG string
// (or null); `primary_color` is a hex string (or null). We return nulls rather
// than erroring when an institution has no optional metadata, so the app cleanly
// falls back to its initials avatar.
app.post('/api/institution_logo', async (req, res) => {
  try {
    let { institution_id, access_token } = req.body;
    // Prefer deriving institution_id from the Item via the access_token, which is
    // always available. Plaid Link's client metadata omits institution_id on many
    // OAuth flows (e.g. Robinhood), so relying on a client-supplied id is fragile.
    if (!institution_id && access_token) {
      const itemRes = await plaidClient.itemGet({ access_token });
      institution_id = itemRes.data.item.institution_id;
    }
    if (!institution_id) {
      return res.status(400).json({ error: 'institution_id or access_token required' });
    }
    const response = await plaidClient.institutionsGetById({
      institution_id,
      country_codes: ['US'],
      options: { include_optional_metadata: true },
    });
    const inst = response.data.institution;
    res.json({
      logo: inst.logo || null,
      primary_color: inst.primary_color || null,
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// Bank flow — paginated /transactions/sync, returns balance + accounts + recent transactions.
app.post('/api/sync_account', async (req, res) => {
  try {
    const { access_token, cursor } = req.body;
    let nextCursor = cursor || null;
    let added = [];
    let hasMore = true;
    let accounts = [];

    while (hasMore) {
      const reqBody = { access_token };
      if (nextCursor) reqBody.cursor = nextCursor;
      const response = await plaidClient.transactionsSync(reqBody);
      added = added.concat(response.data.added || []);
      hasMore = response.data.has_more;
      nextCursor = response.data.next_cursor;
      if (response.data.accounts) accounts = response.data.accounts;
    }

    const depository = accounts.filter(a => a.type === 'depository');
    const balance = depository.reduce((sum, a) => sum + (a.balances.current || 0), 0);

    added.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const transactions = added.slice(0, 100);

    res.json({ balance, accounts, transactions, next_cursor: nextCursor });
  } catch (err) {
    if (isRelinkError(err)) {
      console.warn('[sync_account] relink required:', relinkErrorCode(err));
      return res.json({ requiresRelink: true, errorCode: relinkErrorCode(err) });
    }
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// Investments flow — /investments/holdings/get returns accounts, holdings, and securities.
// Joins them client-side: each holding gets ticker/name/type from its security_id.
// Returns: { totalValue, accounts: [{ accountId, name, mask, type, subtype, value, holdings: [...] }] }
app.post('/api/sync_investments', async (req, res) => {
  try {
    const { access_token } = req.body;
    const response = await plaidClient.investmentsHoldingsGet({ access_token });
    const { accounts: rawAccounts, holdings: rawHoldings, securities } = response.data;

    // Index securities by id for O(1) lookup.
    const securityById = {};
    for (const s of securities || []) securityById[s.security_id] = s;

    // Group holdings by account_id, attaching security metadata.
    const holdingsByAccount = {};
    for (const h of rawHoldings || []) {
      const sec = securityById[h.security_id] || {};
      const enriched = {
        account_id: h.account_id,
        security_id: h.security_id,
        ticker: sec.ticker_symbol || null,
        name: sec.name || sec.ticker_symbol || 'Unknown',
        type: sec.type || 'unknown',                       // equity, etf, mutual_fund, fixed_income, cryptocurrency, ...
        quantity: h.quantity ?? 0,
        currentPrice: h.institution_price ?? sec.close_price ?? 0,
        value: h.institution_value ?? ((h.quantity ?? 0) * (h.institution_price ?? 0)),
        costBasis: h.cost_basis ?? null,
        currency: h.iso_currency_code || sec.iso_currency_code || 'USD',
      };
      if (!holdingsByAccount[h.account_id]) holdingsByAccount[h.account_id] = [];
      holdingsByAccount[h.account_id].push(enriched);
    }

    // Filter to investment-type accounts only — Plaid returns ALL accounts on the
    // Item (depository, credit, loan, etc.) but those belong on the Bank tab via
    // /api/sync_account. Investments tab should only show actual brokerage / IRA /
    // 401k / Roth / 529 / HSA-investment accounts.
    const investmentAccounts = (rawAccounts || []).filter(a => a.type === 'investment');
    const accounts = investmentAccounts.map(a => {
      const holdings = holdingsByAccount[a.account_id] || [];
      // Prefer Plaid's reported balance; fall back to summed holdings.
      const value = a.balances.current ?? holdings.reduce((sum, h) => sum + h.value, 0);
      return {
        account_id: a.account_id,
        name: a.name,
        mask: a.mask,
        type: a.type,
        subtype: a.subtype,
        value,
        holdings,
      };
    });

    const totalValue = accounts.reduce((sum, a) => sum + (a.value || 0), 0);
    res.json({ totalValue, accounts });
  } catch (err) {
    if (isRelinkError(err)) {
      console.warn('[sync_investments] relink required:', relinkErrorCode(err));
      return res.json({ requiresRelink: true, errorCode: relinkErrorCode(err) });
    }
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// Scaffold for future credit re-enable. Not currently called.
app.post('/api/get_credit', async (req, res) => {
  try {
    const { access_token } = req.body;
    const response = await plaidClient.liabilitiesGet({ access_token });
    const credit = response.data.liabilities.credit || [];
    const totalBalance = credit.reduce((sum, c) => sum + (c.last_statement_balance || 0), 0);
    const totalLimit = credit.reduce((sum, c) => sum + (c.credit_limit || 0), 0);
    res.json({ totalBalance, totalLimit, accounts: credit });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// Called by iOS app on every cold launch and after every Plaid Link success.
// Body: { device_token: string, access_tokens: [string] }
// For each access_token, resolves item_id via /item/get and stores
// item_id → device_token. Also calls /item/webhook/update to retro-fit the
// webhook URL onto Items that were created before webhooks were wired —
// without this, existing Plaid Items would never ping us.
//
// One device per item_id, last-write-wins. Idempotent: re-registering the
// same (item, device) pair is a no-op overwrite.
app.post('/api/register_device', async (req, res) => {
  try {
    const { device_token, access_tokens } = req.body;
    if (!device_token || !Array.isArray(access_tokens)) {
      return res.status(400).json({ error: 'device_token and access_tokens[] required' });
    }
    const results = [];
    for (const access_token of access_tokens) {
      try {
        const itemRes = await plaidClient.itemGet({ access_token });
        const itemId = itemRes.data.item.item_id;
        deviceTokensByItemId.set(itemId, device_token);
        // Retro-fit webhook URL on Items created before webhook support.
        // Idempotent — Plaid no-ops if URL is already the same.
        try {
          await plaidClient.itemWebhookUpdate({ access_token, webhook: WEBHOOK_URL });
        } catch (whErr) {
          console.warn('[Register] webhook update failed for', itemId, ':', whErr.response?.data?.error_code || whErr.message);
        }
        results.push({ item_id: itemId, registered: true });
      } catch (err) {
        const code = err.response?.data?.error_code;
        results.push({ access_token_prefix: access_token.slice(0, 12), error: code || err.message });
      }
    }
    console.log('[Register] device', device_token.slice(0, 8) + '… mapped to', results.filter(r => r.registered).length, 'items');
    res.json({ registered: results });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// Plaid webhook receiver. Plaid pings this for transaction / holdings updates
// on any Item that was created with our WEBHOOK_URL. We just dispatch a silent
// APNs push to the device mapped to that item_id — the iOS app handles the
// re-sync via its normal authenticated /api/sync_account or /api/sync_investments
// path. So the webhook body itself never carries financial data.
//
// Signature verification is SKIPPED for V1 (logged as a follow-up). The worst
// an unverified-but-malicious caller can do is trigger a silent push, which
// iOS throttles and which produces no data leak (the app re-syncs through its
// own access_tokens, not through anything in the webhook body).
app.post('/api/plaid_webhook', async (req, res) => {
  // Ack within 10s or Plaid retries — push the dispatch into a background task.
  res.json({ acknowledged: true });
  try {
    const { webhook_type, webhook_code, item_id } = req.body || {};
    console.log('[Webhook]', webhook_type, webhook_code, 'item:', item_id);
    if (!item_id) return;
    const deviceToken = deviceTokensByItemId.get(item_id);
    if (!deviceToken) {
      console.warn('[Webhook] No device token for item_id', item_id, '— app may not have registered yet');
      return;
    }
    // Only push on codes that mean "fresh data is available." Plaid sends
    // other admin codes (ERROR, WEBHOOK_UPDATE_ACKNOWLEDGED, etc.) we don't
    // care to wake the app for. Whitelist these:
    const wakeCodes = new Set([
      'SYNC_UPDATES_AVAILABLE',   // TRANSACTIONS — primary signal
      'DEFAULT_UPDATE',           // TRANSACTIONS or HOLDINGS
      'INITIAL_UPDATE',           // first historical pull complete
      'HISTORICAL_UPDATE',        // backfill done
      'TRANSACTIONS_REMOVED',     // pending → posted state change
    ]);
    if (wakeCodes.has(webhook_code)) {
      await sendSilentPush(deviceToken);
    }
  } catch (err) {
    console.error('[Webhook] processing error:', err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
