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
        products: ['transactions', 'liabilities'],
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

  app.post('/api/get_balance', async (req, res) => {
    try {
      const { access_token } = req.body;
      const response = await plaidClient.accountsBalanceGet({ access_token });
      const accounts = response.data.accounts;
      const checking = accounts.filter(a => a.type === 'depository');
      const total = checking.reduce((sum, a) => sum + (a.balances.current || 0), 0);
      res.json({ balance: total, accounts });
    } catch (err) {
      console.error(err.response?.data || err.message);
      res.status(500).json({ error: err.message });
    }
  });

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
