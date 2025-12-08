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

async function saveToSupabase(payload) {
  if (!supabase) return;
  
  // Check anti-doublon (50s)
  const { data: last } = await supabase
    .from("arb_history")
    .select("created_at")
    .order("created_at", { ascending: false })
    .limit(1);

  const now = Date.now();
  if (last && last.length > 0) {
    const lastTs = new Date(last[0].created_at).getTime();
    if (now - lastTs < 50 * 1000) return; 
  }

  await supabase.from("arb_history").insert({ data: payload });
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
  if (Object.keys(fullPayload).length > 2) {
    await saveToSupabase(fullPayload).catch(console.error);
  }

  // 4. RÉPONSE INTELLIGENTE (C'est le FIX pour Cron-Job)
  if (isCron) {
    // Si c'est le robot, on renvoie juste un petit JSON
    return {
      statusCode: 200,
      body: JSON.stringify({ status: "Cron executed", saved: true })
    };
  }

  // Si c'est le Site Web, on envoie tout
  let history = [];
  if (supabase) {
    try {
      const { data: hist } = await supabase.from("arb_history").select("*").order("created_at", { ascending: false }).limit(5000);
      if (hist) history = hist;
    } catch (e) { console.log(e); }
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