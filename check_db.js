require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

(async () => {
  try {
    const { data, error } = await supabase.from('arb_history').select('*').order('created_at', { ascending: false }).limit(5);
    if (error) {
      console.error('Select error:', error);
      process.exit(1);
    }
    console.log('Latest rows (count):', data ? data.length : 0);
    console.log(JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Exception querying Supabase:', e);
  }
})();
