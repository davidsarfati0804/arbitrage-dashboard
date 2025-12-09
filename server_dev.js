// server_dev.js — simple dev server that serves static files and proxies
// /.netlify/functions/api to the local function handler
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const compression = require('compression');
const api = require('./netlify/functions/api.js');

const app = express();
const PORT = process.env.DEV_PORT || 3000;

app.use(compression());
app.use(express.static(path.join(__dirname)));

app.get('/.netlify/functions/api', async (req, res) => {
  try {
    const event = { queryStringParameters: req.query || {} };
    const result = await api.handler(event, {});
    res.status(result.statusCode || 200);
    if (result.headers) Object.entries(result.headers).forEach(([k,v])=>res.set(k,v));
    res.send(result.body);
  } catch (e) {
    console.error('Server proxy error:', e);
    res.status(500).json({ error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`Dev server: http://localhost:${PORT}`);
});
