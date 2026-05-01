require('dotenv').config();
const express = require('express');
const { PlaidApi, PlaidEnvironments, Configuration } = require('plaid');

const app = express();
app.use(express.json());

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

const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SANDBOX_SECRET,
    },
  },
});

const plaidClient = new PlaidApi(plaidConfig);

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
    // OAuth redirect URI — required for production OAuth banks (Chase, BoA, Wells, etc.).
    // Gated on BOTH PLAID_REDIRECT_URI being set AND PLAID_ENV being non-sandbox.
    // Sandbox doesn't validate redirect URIs the same way and rejects link_token_create
    // with HTTP 400 when redirect_uri is supplied unless the URI is registered for the
    // sandbox env in Plaid Dashboard. The cleanest stance: only attach redirect_uri
    // when we're actually in production (where OAuth banks need it). Sandbox stays
    // OAuth-less, which is fine — sandbox's First Platypus Bank doesn't OAuth-redirect.
    const env = process.env.PLAID_ENV || 'sandbox';
    const linkParams = {
      user: { client_user_id: 'finance-widget-user' },
      client_name: 'Finance Widget',
      products,
      country_codes: ['US'],
      language: 'en',
      // Surface Plaid's account-selection screen during Link.
      account_filters: flow === 'investments'
        ? { investment: { account_subtypes: ['all'] } }
        : { depository: { account_subtypes: ['all'] } },
    };
    if (process.env.PLAID_REDIRECT_URI && env !== 'sandbox') {
      linkParams.redirect_uri = process.env.PLAID_REDIRECT_URI;
    }
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
    res.json({ access_token: response.data.access_token });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
