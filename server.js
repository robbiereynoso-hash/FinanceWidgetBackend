require('dotenv').config();
const express = require('express');
const { PlaidApi, PlaidEnvironments, Configuration } = require('plaid');

const app = express();
app.use(express.json());

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

app.post('/api/create_link_token', async (req, res) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: 'finance-widget-user' },
      client_name: 'Finance Widget',
      products: ['transactions'],
      country_codes: ['US'],
      language: 'en',
    });
    res.json({ link_token: response.data.link_token });
  } catch (err) {
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

// Replaces /api/get_balance. Calls /transactions/sync (paginated until has_more=false),
// returns balance (sum of depository), full accounts array, recent transactions, next_cursor.
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

// Scaffold for future credit re-enable. Not currently called by client.
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
