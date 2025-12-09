import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require('dotenv').config();

const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

// ==============================
// ENV VARIABLES & INITIALIZATION
// ==============================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const TWELVEDATA_API_KEY = process.env.TWELVEDATA_API_KEY;

const supabase = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

// ==============================
// CONFIG
// ==============================
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
// 1. FOREX INTELLIGENT (SMART CACHE)
// ==============================
async function getForexSmartly() {
  if (!supabase) return null;

  // A. Check Cache
  const { data: last, error: errLast } = await supabase
    .from("arb_history")
    .select("created_at, data")
    .order("created_at", { ascending: false })
    .limit(1);

  if (errLast) console.error("❌ Erreur Lecture Supabase:", errLast.message);

  if (last && last.length > 0) {
    const lastTs = new Date(last[0].created_at).getTime();
    const now = Date.now();
    const diffMs = now - lastTs;
    const diffMin = Math.round(diffMs / 60000); 

    console.log(`⏱️ DB CHECK: Dernière entrée il y a ${diffMin} minutes.`);
    
    // Si moins de 10 minutes (600 000 ms)
    if (diffMs < 10 * 60 * 1000) { 
        console.log("🟢 CACHE UTILISÉ (Donnée fraîche. API SKIPPÉ)");
        const cachedForex = {};
        const savedData = last[0].data;

        // Reconstruction de l'objet cache
        PAIRS.forEach(p => {
          if (savedData[p.id] && savedData[p.id].forex) {
            cachedForex[p.forex] = savedData[p.id].forex;
          }
        });
        return cachedForex; // Retourne le cache
    } else {
        console.log(`🟡 CACHE PÉRIMÉ (${diffMin} min). Appel API nécessaire.`);
    }
  } else {
    console.log("⚪ DB VIDE : Nécessite un appel API pour amorçage.");
  }

  // B. Call API (si cache périmé ou manquant)
  try {
    const symbols = PAIRS.map(p => p.forex).join(",");
    const url = `${FOREX_URL}?symbol=${symbols}&apikey=${TWELVEDATA_API_KEY}`;
    
    console.log("🌍 Appel API TwelveData en cours...");

    const res = await axios.get(url, { timeout: 5000 });
    
    if (res.data.code && res.data.code !== 200) {
      console.error("❌ ERREUR CONTENU API:", JSON.stringify(res.data));
      return null;
    }
    
    const formatted = {};
    for (const [key, val] of Object.entries(res.data)) {
        if(val.price) formatted[key] = parseFloat(val.price);
    }
    return formatted;

  } catch (e) {
    console.error("❌ CRASH Appel Forex:", e.message);
    return null;
  }
}
// ... LE RESTE DU CODE DOIT ÊTRE COLLÉ ICI ...
// ... (saveToSupabase, computeMode, exports.handler, etc.) ...
// ... J'ai coupé le reste pour ne pas alourdir, mais tout doit être dans le fichier.