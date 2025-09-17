const $ = (id) => document.getElementById(id);
    function toNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
    function fmt(n, d) {
      const decimals = Number.isFinite(d) ? Math.max(0, Math.floor(d)) : 2;
      const f = Math.pow(10, decimals);
      return (Math.round(n * f) / f).toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    }

    let lastPair = null; // tracks last fetched pair "OLD->NEW"

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
      $("remainingOld").textContent = (original || reimbursed) ? (fmt(remainingOld, decimals) + " " + oldCcy) : "—";
      $("remainingNew").textContent = (remainingOld && fx) ? (fmt(remainingNew, decimals) + " " + newCcy) : "—";
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
        $("descText").textContent = parts.join(" ");
      } else {
        $("descText").textContent = "Enter the currencies, original submitted amount, reimbursed-to-date, and FX (or click Calculate to fetch) to generate a description of the adjustment.";
      }
    }

    function withTimeout(ms) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), ms);
      return { signal: ctrl.signal, clear: () => clearTimeout(t) };
    }

    async function fetchFXMulti(from, to) {
      const ts = Date.now();
      const sources = [
        async (signal) => { // exchangerate.host convert
          const url = `https://api.exchangerate.host/convert?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&amount=1&_ts=${ts}`;
          const res = await fetch(url, { method: "GET", signal });
          if (!res.ok) throw new Error("host/convert HTTP " + res.status);
          const data = await res.json();
          if (data && typeof data.result === "number") return data.result;
          if (data && data.info && typeof data.info.rate === "number") return data.info.rate;
          throw new Error("host/convert unexpected shape");
        },
        async (signal) => { // exchangerate.host latest
          const url = `https://api.exchangerate.host/latest?base=${encodeURIComponent(from)}&symbols=${encodeURIComponent(to)}&_ts=${ts}`;
          const res = await fetch(url, { method: "GET", signal });
          if (!res.ok) throw new Error("host/latest HTTP " + res.status);
          const data = await res.json();
          if (data && data.rates && typeof data.rates[to] === "number") return data.rates[to];
          throw new Error("host/latest unexpected shape");
        },
        async (signal) => { // open.er-api.com
          const url = `https://open.er-api.com/v6/latest/${encodeURIComponent(from)}?_ts=${ts}`;
          const res = await fetch(url, { method: "GET", signal });
          if (!res.ok) throw new Error("er-api HTTP " + res.status);
          const data = await res.json();
          if (data && data.result === "success" && data.rates && typeof data.rates[to] === "number") return data.rates[to];
          throw new Error("er-api unexpected shape");
        },
        async (signal) => { // jsdelivr static currency-api
          const url = `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${from.toLowerCase()}.json?_ts=${ts}`;
          const res = await fetch(url, { method: "GET", signal });
          if (!res.ok) throw new Error("jsdelivr HTTP " + res.status);
          const data = await res.json();
          if (data && data[from.toLowerCase()] && typeof data[from.toLowerCase()][to.toLowerCase()] === "number") {
            return data[from.toLowerCase()][to.toLowerCase()];
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
          if (typeof r === "number" && isFinite(r) && r > 0) return { rate: r };
        } catch (e) {
          clear();
          errors.push(e.message || String(e));
        }
      }
      return { rate: null, errors };
    }

    async function handleCalculate() {
      $("fxError").textContent = "";
      const btn = $("btnCalc");
      const btnText = $("calcBtnText");
      const from = $("oldCcy").value.trim().toUpperCase();
      const to = $("newCcy").value.trim().toUpperCase();

      // Determine if we need to fetch: only when pair changed and both codes present
      const needFetch = (from && to) && (`${from}->${to}` !== lastPair);

      if (needFetch) {
        btn.disabled = true;
        btnText.innerHTML = '<span class="spinner"></span> Fetching FX…';

        const { rate, errors } = await fetchFXMulti(from, to);
        if (rate === null) {
          $("fxError").textContent = "Live FX failed. Enter FX manually. Details: " + (errors || []).join(" | ");
        } else {
          $("fx").value = String(rate);
          lastPair = `${from}->${to}`;
        }
        btn.disabled = false;
        btnText.textContent = "Calculate";
      }

      calculate();
    }

    $("btnCalc").addEventListener("click", handleCalculate);

    $("btnReset").addEventListener("click", () => {
      $("oldCcy").value = "";
      $("newCcy").value = "";
      $("originalOld").value = "";
      $("reimbursedOld").value = "";
      $("fx").value = "";
      $("decimals").value = "";
      $("remainingOld").textContent = "—";
      $("remainingNew").textContent = "—";
      $("hybridTotal").textContent = "—";
      $("hybridTag").textContent = "";
      $("ccyNewText").textContent = "NEW";
      $("ccyOldText").textContent = "OLD";
      $("fxError").textContent = "";
      $("descText").textContent = "—";
      lastPair = null;
    });

    // If user changes currencies, mark as needing fetch
    ["oldCcy", "newCcy"].forEach(id => {
      $(id).addEventListener("input", () => { lastPair = null; });
    });
