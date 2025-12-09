const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

// ==============================
// CONFIG & ENV
// ==============================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const TWELVEDATA_API_KEY = process.env.TWELVEDATA_API_KEY;

const supabase = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

const PAIRS = [
  { id: "USDCPLN", forex: "USD/PLN", binance: "USDCPLN" },
  { id: "USDCRON", forex: "USD/RON", binance: "USDCRON" },
  { id: "USDCCZK", forex: "USD/CZK", binance: "USDCCZK" },
  { id: "USDCEUR", forex: "USD/EUR", binance: "EURUSDC", inverted: true }
];

const PROXY_BINANCE = "https://api.codetabs.com/v1/proxy?quest="; 
const FOREX_URL = "https://api.twelvedata.com/price";
const BINANCE_URL = "https://api.binance.com/api/v3/depth";

// ==============================
// HELPERS
// ==============================
async function getForexSmartly() {
  if (!supabase) return { prices: null, ts: 0 };

  // Lecture Cache
  const { data: last } = await supabase
    .from("arb_history")
    .select("data")
    .order("created_at", { ascending: false })
    .limit(1);

  const now = Date.now();
  let cachedTs = 0;

  if (last && last.length > 0 && last[0].data.meta) {
    cachedTs = last[0].data.meta.fxTimestamp || 0;
    if ((now - cachedTs) < 10 * 60 * 1000) {
      // Cache valide (< 10 min)
      return { prices: last[0].data.prices, ts: cachedTs };
    }
  }

  // Appel API (Si cache vide/vieux)
  try {
    const symbols = PAIRS.map(p => p.forex).join(",");
    const url = `${FOREX_URL}?symbol=${symbols}&apikey=${TWELVEDATA_API_KEY}`;
    const res = await axios.get(url, { timeout: 5000 });
    
    if (!res.data || res.data.code) return { prices: null, ts: 0 };
    
    const prices = {};
    for (const [key, val] of Object.entries(res.data)) {
        if(val.price) prices[key] = parseFloat(val.price);
    }
    return { prices: prices, ts: now };
  } catch (e) {
    if (last && last.length > 0 && last[0].data.prices) {
        return { prices: last[0].data.prices, ts: cachedTs };
    }
    return { prices: null, ts: 0 };
  }
}

async function getBinanceDepth(symbol) {
  try {
    const target = PROXY_BINANCE + encodeURIComponent(`${BINANCE_URL}?symbol=${symbol}&limit=10`);
    const res = await axios.get(target, { timeout: 8000, headers: { "User-Agent": "Mozilla/5.0" } });
    return res.data;
  } catch (e) { return null; }
}

function mapLines(levels, inverted = false) {
  if (!levels) return [];
  return levels.slice(0,4).map(x => ({ 
    price: inverted ? 1/parseFloat(x[0]) : parseFloat(x[0]), 
    volume: parseFloat(x[1]) 
  }));
}

function computeMode(fx, bids, asks) {
  return (bids[0]?.price) || (asks[0]?.price) || null; 
}

async function saveToSupabase(payload, { force } = {}) {
  if (!supabase) return { ok: false, error: 'No Supabase client (missing env vars?)' };

  try {
    // Check anti-doublon (50s)
    const { data: last, error: errLast } = await supabase
      .from("arb_history")
      .select("created_at")
      .order("created_at", { ascending: false })
      .limit(1);

    if (errLast) console.error('❌ Erreur Lecture Supabase (save check):', errLast.message);

    const now = Date.now();
    if (!force) {
      if (last && last.length > 0) {
        const lastTs = new Date(last[0].created_at).getTime();
        if (now - lastTs < 50 * 1000) return { ok: false, skipped: true, reason: 'Debounce: recent entry' };
      }
    }

    const { data, error } = await supabase.from("arb_history").insert({ data: payload });
    if (error) {
      console.error('❌ Supabase insert error:', error.message || error);
      return { ok: false, error };
    }
    return { ok: true, data };
  } catch (e) {
    console.error('❌ Exception in saveToSupabase:', e && e.message ? e.message : e);
    return { ok: false, error: e };
  }
}

// ==============================
// MAIN HANDLER (Avec Mode Silencieux)
// ==============================
const handler = async (event, context) => {
  
  // 1. DÉTECTION DU ROBOT (C'est ce qui manquait !)
  // On regarde si l'URL contient "?cron=true"
  const params = event.queryStringParameters || {};
  const isCron = (params.cron === "true");

  // 2. Exécution Logique
  const { prices: forexMap, ts: forexTs } = await getForexSmartly();

  const cryptoTasks = PAIRS.map(async (pair) => {
    let fx = forexMap ? forexMap[pair.forex] : null;
    const depthData = await getBinanceDepth(pair.binance);
    
    let bids = [], asks = [];
    if (depthData && (depthData.bids || depthData.asks)) {
      if (pair.inverted) {
        bids = mapLines(depthData.asks, true);
        asks = mapLines(depthData.bids, true);
      } else {
        bids = mapLines(depthData.bids, false);
        asks = mapLines(depthData.asks, false);
      }
    }
    const cryptoRef = computeMode(fx, bids, asks);
    return { id: pair.id, data: { forex: fx, bids, asks, cryptoRef } };
  });

  const results = await Promise.all(cryptoTasks);
  
  const fullPayload = { 
    meta: { fxTimestamp: forexTs },
    prices: forexMap
  };

  results.forEach(item => {
    fullPayload[item.id] = item.data;
  });

  // 3. Sauvegarde
  let savedResult = { ok: false };
  if (Object.keys(fullPayload).length > 2) {
    const forceSave = params.force === 'true';
    savedResult = await saveToSupabase(fullPayload, { force: forceSave }).catch(err => {
      console.error('❌ saveToSupabase rejected:', err);
      return { ok: false, error: err };
    });
  }

  // 4. RÉPONSE INTELLIGENTE (C'est le FIX pour Cron-Job)
  if (isCron) {
    // Si c'est le robot, on renvoie juste un petit JSON indiquant si la sauvegarde a marché
    return {
      statusCode: 200,
      body: JSON.stringify({ status: "Cron executed", saved: !!savedResult.ok, savedResult })
    };
  }

  // Si c'est le Site Web, on envoie tout (fetch avec pagination si besoin)
  let history = [];
  if (supabase) {
    try {
      // Supabase limite à ~1000 par query. On pagine pour récupérer la période demandée.

      const sinceParam = params.since ? parseInt(params.since, 10) : null;
      const sinceISO = sinceParam ? new Date(sinceParam).toISOString() : null;

      // Pagination fetch: supabase REST tends to limit to ~1000 per page, donc on pagine
      let allHistory = [];
      
      // For filtered queries (with sinceISO), we need to fetch without range limit
      // because .gte() with .range() applies filter AFTER pagination (broken).
      // Instead, we fetch all matching rows in one shot by removing range constraint.
      
      if (sinceISO) {
        // Fetch all rows matching the time filter in one query (no range)
        let query = supabase
          .from("arb_history")
          .select("*", { count: 'exact' })
          .gte('created_at', sinceISO)
          .order("created_at", { ascending: false });
        
        const { data: hist, error, count } = await query;
        
        if (error) {
          console.error('⚠️ History fetch error (filtered):', error.message);
        } else if (hist && hist.length > 0) {
          allHistory = hist;
          console.log(`✓ Fetched ${hist.length} rows since ${sinceISO} (total matching: ${count})`);
        }
      } else {
        // No filter: paginate to avoid huge responses
        let page = 0;
        const pageSize = 1000;
        let hasMore = true;

        while (hasMore) {
          const start = page * pageSize;
          const { data: hist, error } = await supabase
            .from("arb_history")
            .select("*")
            .order("created_at", { ascending: false })
            .range(start, start + pageSize - 1);

          if (error) {
            console.error('⚠️ History pagination error (page', page + '):', error.message);
            break;
          }

          if (!hist || hist.length === 0) {
            hasMore = false;
          } else {
            allHistory = allHistory.concat(hist);
            if (hist.length < pageSize) {
              hasMore = false;
            }
          }
          page++;

          // Safety: stop after 50 pages (~50k rows) to avoid timeout
          if (page > 50) {
            console.warn('⚠️ Pagination stopped at 50 pages');
            hasMore = false;
          }
        }
      }

      // Downsample on server to reduce payload if necessary
      const maxPoints = 5000; // target maximum points to return (user requested ~5k)
      let sampledHistory;
      if (allHistory.length > maxPoints) {
        const step = Math.ceil(allHistory.length / maxPoints);
        sampledHistory = allHistory.filter((_, i) => i % step === 0);
      } else {
        sampledHistory = allHistory;
      }

      // Reduce payload: keep only minimal fields for history to reduce JSON size
      // For each row keep: id, created_at, meta.fxTimestamp (if any), and per-pair { forex, cryptoRef }
      const minimal = sampledHistory.map(r => {
        const out = { id: r.id, created_at: r.created_at };
        const ts = r.data && r.data.meta && r.data.meta.fxTimestamp ? Number(r.data.meta.fxTimestamp) : null;
        if (ts) out.fxTimestamp = ts;
        out.pairs = {};
        try {
          for (const p of PAIRS) {
            if (r.data && r.data[p.id]) {
              out.pairs[p.id] = {
                forex: r.data[p.id].forex ?? null,
                cryptoRef: r.data[p.id].cryptoRef ?? r.data[p.id].crypto ?? null
              };
            }
          }
        } catch (e) { /* defensive */ }
        return out;
      });

      history = minimal;

      // Return history in descending order (most recent first) as before
    } catch (e) { console.log('Exception history fetch:', e); }
  }

  return {
    statusCode: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ live: fullPayload, history: history })
  };
};

module.exports = { handler };