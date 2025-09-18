// === config ===
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CACHE_NS = "fxCache_v1";       // localStorage namespace

// === helpers ===
const $ = (id) => document.getElementById(id);
function toNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function fmt(n, d) {
  const decimals = Number.isFinite(d) ? Math.max(0, Math.floor(d)) : 2;
  const f = Math.pow(10, decimals);
  return (Math.round(n * f) / f).toLocaleString(undefined, {
    minimumFractionDigits: decimals, maximumFractionDigits: decimals
  });
}

// === tiny cache ===
function loadCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_NS) || "{}"); }
  catch { return {}; }
}
function saveCache(cache) {
  try { localStorage.setItem(CACHE_NS, JSON.stringify(cache)); } catch {}
}
function cacheKey(from, to) { return `${from}->${to}`; }
function getCachedFX(from, to) {
  const cache = loadCache();
  const key = cacheKey(from, to);
  const entry = cache[key];
  if (!entry) return null;
  const fresh = (Date.now() - entry.cachedAt) <= CACHE_TTL_MS;
  return fresh ? entry : null;
}
function setCachedFX(from, to, payload) {
  const cache = loadCache();
  cache[cacheKey(from, to)] = { ...payload, cachedAt: Date.now() };
  saveCache(cache);
}

let lastPair = null; // tracks last fetched pair "OLD->NEW"

// === main calculate ===
function calculate() {
  const oldCcyRaw = $("oldCcy").value.trim();
  const newCcyRaw = $("newCcy").value.trim();
  const oldCcy = oldCcyRaw.toUpperCase() || "OLD";
  const newCcy = newCcyRaw.toUpperCase() || "NEW";
  const original = toNum($("originalOld").value);
  const reimbursed = toNum($("reimbursedOld").value);
  const fx = toNum($("fx").value);
  const decimals = toNum($("decimals").value);

  const remainingOld = Math.max(0, original - reimbursed);
  const remainingNew = remainingOld * fx;
  const hybrid = reimbursed + remainingNew;

  // Top stats
  $("remainingOld").textContent = (original || reimbursed)
    ? (fmt(remainingOld, decimals) + " " + oldCcy) : "—";
  $("remainingNew").textContent = (remainingOld && fx)
    ? (fmt(remainingNew, decimals) + " " + newCcy) : "—";
  $("hybridTotal").textContent = (fx || reimbursed) ? fmt(hybrid, decimals) : "—";
  $("hybridTag").textContent = `[${oldCcy} + ${newCcy}]`;
  $("ccyNewText").textContent = newCcy;
  $("ccyOldText").textContent = oldCcy;

  // Description
  if (original > 0 && fx > 0 && oldCcyRaw && newCcyRaw) {
    const parts = [];
    parts.push(`This reimbursement plan was originally submitted for ${fmt(original, decimals)} ${oldCcy}.`);
    parts.push(`${fmt(reimbursed, decimals)} ${oldCcy} has been reimbursed to date, leaving ${fmt(remainingOld, decimals)} ${oldCcy} outstanding.`);
    parts.push(`After changing from ${oldCcy} to ${newCcy}, the remaining balance will be reimbursed as ${fmt(remainingNew, decimals)} ${newCcy}.`);
    parts.push(`Therefore, the updated submitted amount becomes ${fmt(hybrid, decimals)}.`);

    // FX source + timestamp
    const fxSource = $("fx").dataset.source || "manual entry";
    const fxISO = $("fx").dataset.timestamp || null;
    const fxTime = fxISO ? new Date(fxISO).toLocaleString() : null;
    let fxNote = `FX rate powered by ${fxSource}`;
    if (fxTime) fxNote += ` (retrieved at ${fxTime})`;
    parts.push(fxNote + ".");

    $("descText").textContent = parts.join(" ");
  } else {
    $("descText").textContent =
      "Enter the currencies, original submitted amount, reimbursed-to-date, and FX (or click Calculate to fetch) to generate a description of the adjustment.";
  }
}

// === fetch with timeout helper ===
function withTimeout(ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(t) };
}

// === multi-source FX fetch now returns {rate, source, timestamp} ===
async function fetchFXMulti(from, to) {
  const ts = Date.now();
  const sources = [
    async (signal) => { // exchangerate.host/convert
      const url = `https://api.exchangerate.host/convert?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&amount=1&_ts=${ts}`;
      const res = await fetch(url, { method: "GET", signal });
      if (!res.ok) throw new Error("host/convert HTTP " + res.status);
      const data = await res.json();
      if (data && typeof data.result === "number") {
        return { rate: data.result, source: "exchangerate.host (convert)", timestamp: new Date().toISOString() };
      }
      if (data && data.info && typeof data.info.rate === "number") {
        return { rate: data.info.rate, source: "exchangerate.host (convert)", timestamp: new Date().toISOString() };
      }
      throw new Error("host/convert unexpected shape");
    },
    async (signal) => { // exchangerate.host/latest
      const url = `https://api.exchangerate.host/latest?base=${encodeURIComponent(from)}&symbols=${encodeURIComponent(to)}&_ts=${ts}`;
      const res = await fetch(url, { method: "GET", signal });
      if (!res.ok) throw new Error("host/latest HTTP " + res.status);
      const data = await res.json();
      if (data && data.rates && typeof data.rates[to] === "number") {
        return { rate: data.rates[to], source: "exchangerate.host (latest)", timestamp: new Date().toISOString() };
      }
      throw new Error("host/latest unexpected shape");
    },
    async (signal) => { // open.er-api.com
      const url = `https://open.er-api.com/v6/latest/${encodeURIComponent(from)}?_ts=${ts}`;
      const res = await fetch(url, { method: "GET", signal });
      if (!res.ok) throw new Error("er-api HTTP " + res.status);
      const data = await res.json();
      if (data && data.result === "success" && data.rates && typeof data.rates[to] === "number") {
        return { rate: data.rates[to], source: "open.er-api.com", timestamp: new Date().toISOString() };
      }
      throw new Error("er-api unexpected shape");
    },
    async (signal) => { // jsdelivr currency-api (static JSON)
      const url = `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${from.toLowerCase()}.json?_ts=${ts}`;
      const res = await fetch(url, { method: "GET", signal });
      if (!res.ok) throw new Error("jsdelivr HTTP " + res.status);
      const data = await res.json();
      if (data && data[from.toLowerCase()] && typeof data[from.toLowerCase()][to.toLowerCase()] === "number") {
        return {
          rate: data[from.toLowerCase()][to.toLowerCase()],
          source: "jsdelivr currency-api",
          timestamp: new Date().toISOString()
        };
      }
      throw new Error("jsdelivr unexpected shape");
    }
  ];

  const errors = [];
  for (const src of sources) {
    const { signal, clear } = withTimeout(5000);
    try {
      const r = await src(signal);
      clear();
      if (r && typeof r.rate === "number" && isFinite(r.rate) && r.rate > 0) return r;
    } catch (e) {
      clear();
      errors.push(e.message || String(e));
    }
  }
  return { rate: null, source: null, timestamp: null, errors };
}

// === Calculate button handler with cache ===
async function handleCalculate() {
  $("fxError").textContent = "";
  const btn = $("btnCalc");
  const btnText = $("calcBtnText");
  const from = $("oldCcy").value.trim().toUpperCase();
  const to = $("newCcy").value.trim().toUpperCase();

  // Only fetch when pair changed and both codes present
  const needFetch = (from && to) && (`${from}->${to}` !== lastPair);

  if (needFetch) {
    // 1) Try cache first
    const cached = getCachedFX(from, to);
    if (cached && typeof cached.rate === "number") {
      $("fx").value = String(cached.rate);
      $("fx").dataset.source = (cached.source || "cached");
      $("fx").dataset.timestamp = cached.timestamp || new Date(cached.cachedAt).toISOString();
      lastPair = `${from}->${to}`;
      // Optional: Show a subtle hint
      $("fxError").textContent = "(Using cached rate)";
    } else {
      // 2) Fall back to live fetch
      btn.disabled = true;
      btnText.innerHTML = '<span class="spinner"></span> Fetching FX…';

      const { rate, source, timestamp, errors } = await fetchFXMulti(from, to);
      if (rate === null) {
        $("fxError").textContent = "Live FX failed. Enter FX manually. Details: " + (errors || []).join(" | ");
        $("fx").dataset.source = "manual entry";
        $("fx").dataset.timestamp = "";
      } else {
        $("fx").value = String(rate);
        $("fx").dataset.source = source || "live";
        $("fx").dataset.timestamp = timestamp || new Date().toISOString();
        setCachedFX(from, to, { rate, source, timestamp });
        lastPair = `${from}->${to}`;
      }
      btn.disabled = false;
      btnText.textContent = "Calculate";
    }
  } else {
    // If user changes FX manually, mark as manual (and don't cache)
    if ($("fx").value.trim()) {
      $("fx").dataset.source = "manual entry";
      $("fx").dataset.timestamp = "";
    }
  }

  calculate();
}

// === reset & listeners ===
$("btnCalc").addEventListener("click", handleCalculate);

$("btnReset").addEventListener("click", () => {
  $("oldCcy").value = "";
  $("newCcy").value = "";
  $("originalOld").value = "";
  $("reimbursedOld").value = "";
  $("fx").value = "";
  $("decimals").value = "2";
  $("remainingOld").textContent = "—";
  $("remainingNew").textContent = "—";
  $("hybridTotal").textContent = "—";
  $("hybridTag").textContent = "";
  $("ccyNewText").textContent = "NEW";
  $("ccyOldText").textContent = "OLD";
  $("fxError").textContent = "";
  $("descText").textContent = "—";
  $("fx").dataset.source = "";
  $("fx").dataset.timestamp = "";
  lastPair = null;
});

// If user changes currencies, mark as needing fetch
["oldCcy", "newCcy"].forEach(id => {
  $(id).addEventListener("input", () => { lastPair = null; });
});

// If user types FX manually, tag it as manual
$("fx").addEventListener("input", () => {
  $("fx").dataset.source = "manual entry";
  $("fx").dataset.timestamp = "";
});


// ===== Global counter backend =====
const USAGE_ENDPOINT = 'https://script.google.com/a/macros/joinforma.com/s/AKfycbwSWD0tEwc0Qma7GxFSMn-bOpk6fM5wVvu8cAcx5fug3r_fkfKSDb2PeaWc05jaakik/exec'; // GAS web app URL
const USAGE_SECRET  = 'optional-secret'; // must match SECRET above, or '' if disabled

async function fetchGlobalCount() {
  try {
    const r = await fetch(USAGE_ENDPOINT, { method: 'GET' });
    const j = await r.json();
    if (j && typeof j.count === 'number') {
      const el = document.getElementById('usageCountGlobal');
      if (el) el.textContent = j.count.toLocaleString();
    }
  } catch {}
}

async function bumpGlobalCount() {
  try {
    const r = await fetch(USAGE_ENDPOINT + (USAGE_SECRET ? `?secret=${encodeURIComponent(USAGE_SECRET)}` : ''), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: USAGE_SECRET ? JSON.stringify({ secret: USAGE_SECRET }) : '{}'
    });
    const j = await r.json();
    if (j && typeof j.count === 'number') {
      const el = document.getElementById('usageCountGlobal');
      if (el) el.textContent = j.count.toLocaleString();
    }
  } catch {}
}


