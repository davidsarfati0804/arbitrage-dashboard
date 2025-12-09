// cron_runner.js
// Usage:
//  node cron_runner.js --once --force
//  node cron_runner.js --loop --interval=61

const path = require('path');
const argv = require('minimist')(process.argv.slice(2));

// Load env BEFORE importing the function (important)
require('dotenv').config({ path: path.join(__dirname, '.env') });

const api = require('./netlify/functions/api.js');

const intervalSec = parseInt(argv.interval || argv.i || 61, 10);
const once = !!argv.once;
const force = !!argv.force;
const loop = !!argv.loop;

async function callOnce() {
  try {
    const qs = { cron: 'true' };
    if (force) qs.force = 'true';
    console.log(new Date().toISOString(), '➡ Calling handler with', qs);
    const res = await api.handler({ queryStringParameters: qs }, {});
    console.log(new Date().toISOString(), '← Response:', res);
    return res;
  } catch (e) {
    console.error('Handler error:', e);
    return null;
  }
}

(async function main(){
  if (once) {
    await callOnce();
    process.exit(0);
  }

  if (loop) {
    console.log('Starting loop every', intervalSec, 'sec');
    await callOnce();
    setInterval(callOnce, intervalSec * 1000);
  } else {
    // default: one call
    await callOnce();
    process.exit(0);
  }
})();
