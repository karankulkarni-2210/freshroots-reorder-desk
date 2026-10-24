/* Freshroots reorder engine: Raghav's documented rules, the triggers that send a SKU to his
   judgment queue, a backtest, and a synthetic demo dataset. Pure functions, no I/O. */
(function (root) {
  'use strict';

  // Raghav's rules, as he wrote them down.
  const RULES = {
    highDemandRatio: 1.2,           // last-4-week avg more than 20% above the 12-week avg
    highDemandQtyMultiplier: 1.5,
    festivalMonths: [10, 11, 3],    // Oct, Nov, Mar
    festivalUplift: 1.25,
    cover: { standard: { min: 6, max: 14 }, perishable: { min: 3, max: 4 } },
  };

  // Ours, not Raghav's: what routes a SKU to the 15-20% he decides on judgment.
  const JUDGMENT = {
    minHistoryWeeks: 12,
    spikeRatio: 1.6,                // avg4 > 1.6x avg12 means the last 4 weeks ran at >2.3x the 8 before
    distributorMinShare: 0.10,
    distributorShift: 0.40,         // a big distributor's share moved >40% vs its prior 8 weeks
    topByValue: 20,
    spotCheckEvery: 10,
  };

  const REASONS = {
    data_gap: 'No stock figure for this week',
    new_sku: 'New SKU, short sales history',
    no_recent_sales: 'No sales in 12 weeks',
    demand_spike: 'Demand spike, possibly one-off',
    distributor_shift: 'Large distributor changed behaviour',
    perishable_action: 'Perishable SKU with an order change',
  };

  const DAY = 86400000;
  const toT = s => Date.parse(s + 'T00:00:00Z');
  const iso = t => new Date(t).toISOString().slice(0, 10);
  const monday = s => { const t = toT(s); return iso(t - ((new Date(t).getUTCDay() + 6) % 7) * DAY); };
  const addWeeks = (s, n) => iso(toT(s) + n * 7 * DAY);
  const weeksBetween = (a, b) => Math.round((toT(b) - toT(a)) / (7 * DAY));
  const monthOf = s => Number(s.slice(5, 7));
  const sum = a => a.reduce((s, x) => s + x, 0);
  const mean = a => (a.length ? sum(a) / a.length : 0);

  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  // The 12 (or n) weekly values ending at asOf, oldest first; missing weeks are 0.
  function lastN(weekMap, asOf, n) {
    const out = [];
    for (let i = n - 1; i >= 0; i--) out.push((weekMap && weekMap.get(addWeeks(asOf, -i))) || 0);
    return out;
  }

  function indexSales(rows) {
    const bySku = new Map(), byDist = new Map(), firstWeek = new Map();
    for (const r of rows) {
      if (!bySku.has(r.sku)) { bySku.set(r.sku, new Map()); byDist.set(r.sku, new Map()); }
      const w = bySku.get(r.sku);
      w.set(r.week, (w.get(r.week) || 0) + r.units);
      const d = byDist.get(r.sku);
      if (!d.has(r.distributor)) d.set(r.distributor, new Map());
      const dw = d.get(r.distributor);
      dw.set(r.week, (dw.get(r.week) || 0) + r.units);
      if (r.units > 0 && (!firstWeek.has(r.sku) || r.week < firstWeek.get(r.sku))) firstWeek.set(r.sku, r.week);
    }
    return { bySku, byDist, firstWeek };
  }

  function indexStock(rows) {
    const m = new Map();
    for (const r of rows) {
      if (!m.has(r.sku)) m.set(r.sku, new Map());
      const weeks = m.get(r.sku), prev = weeks.get(r.week);
      // Daily rows fold into one week: the latest day wins, whatever order the file is in.
      if (prev && (prev.date || '') > (r.date || '')) continue;
      weeks.set(r.week, { onHand: r.onHand, onOrder: r.onOrder || 0, date: r.date });
    }
    return m;
  }

  // `stock` is on hand plus already on order: an order placed on Monday must not be placed again on Thursday.
  function applyRules(sku, units12, stock, asOf) {
    const avg12 = mean(units12), avg4 = mean(units12.slice(-4));
    const festival = RULES.festivalMonths.includes(monthOf(asOf));
    // The uplift raises expected demand before the cover checks. On the high-demand check it
    // would scale both sides and cancel out, so that check compares raw actuals.
    const demand = avg12 * (festival ? RULES.festivalUplift : 1);
    const cover = demand > 0 ? stock / demand : null;
    const band = sku.perishable ? RULES.cover.perishable : RULES.cover.standard;
    const highDemand = avg12 > 0 && avg4 > avg12 * RULES.highDemandRatio;
    const stockoutRisk = cover !== null && cover < band.min;
    const overstock = cover !== null && cover > band.max;
    let action = 'standard', qty = 0;
    if (overstock) action = 'pause';                       // assumption A1: pause beats high demand
    else if (stockoutRisk) { action = 'reorder_now'; qty = sku.standardQty * (highDemand ? RULES.highDemandQtyMultiplier : 1); }
    else if (highDemand) { action = 'reorder'; qty = sku.standardQty * RULES.highDemandQtyMultiplier; }
    return { avg12, avg4, festival, demand, cover, band, highDemand, stockoutRisk, overstock, action, qty: Math.round(qty) };
  }

  // A big distributor whose share of this SKU moved sharply: last 4 weeks vs the 8 before.
  function distributorShifts(distMap, units12) {
    const total12 = sum(units12), sku4 = sum(units12.slice(-4)), sku8 = sum(units12.slice(0, 8));
    if (!distMap || !total12 || !sku4 || !sku8) return [];
    const out = [];
    for (const [distributor, u] of distMap) {
      const share = sum(u) / total12;
      if (share < JUDGMENT.distributorMinShare) continue;
      const share8 = sum(u.slice(0, 8)) / sku8, share4 = sum(u.slice(-4)) / sku4;
      if (!share8) continue;
      const change = share4 / share8 - 1;
      if (Math.abs(change) > JUDGMENT.distributorShift) out.push({ distributor, share, change });
    }
    return out.sort((a, b) => b.share - a.share);
  }

  function valueAtStake(sku, r, stock) {
    if (r.action === 'pause') return Math.max(0, stock - r.band.max * r.demand) * sku.unitCost;
    return r.qty * sku.unitCost;
  }

  function evaluate({ skus, sales, stock }) {
    const S = indexSales(sales), K = indexStock(stock);
    let asOf = '';
    for (const r of stock) if (r.week > asOf) asOf = r.week;

    // The stock week is still running when IT exports mid-week, so averages use the 12 complete weeks before it.
    const end = addWeeks(asOf, -1);

    const rows = skus.map(sku => {
      const units12 = lastN(S.bySku.get(sku.sku), end, 12);
      const snap = K.has(sku.sku) ? K.get(sku.sku).get(asOf) : undefined;
      const onHand = snap ? snap.onHand : 0, onOrder = snap ? snap.onOrder : 0;
      const r = applyRules(sku, units12, onHand + onOrder, asOf);
      const first = S.firstWeek.get(sku.sku);
      const history = first ? Math.max(0, weeksBetween(first, end) + 1) : 0;
      const dist = new Map();
      for (const [d, w] of (S.byDist.get(sku.sku) || [])) dist.set(d, lastN(w, end, 12));
      const shifts = distributorShifts(dist, units12);

      const reasons = [];
      if (!snap) reasons.push('data_gap');
      if (history < JUDGMENT.minHistoryWeeks) reasons.push('new_sku');
      else if (r.avg12 === 0) reasons.push('no_recent_sales');
      if (r.avg12 > 0 && r.avg4 > r.avg12 * JUDGMENT.spikeRatio) reasons.push('demand_spike');
      if (shifts.length) reasons.push('distributor_shift');
      if (sku.perishable && r.action !== 'standard') reasons.push('perishable_action');

      return {
        sku: sku.sku, name: sku.name, category: sku.category, perishable: !!sku.perishable,
        standardQty: sku.standardQty, leadTimeWeeks: sku.leadTimeWeeks, unitCost: sku.unitCost,
        units12, onHand, onOrder, history, shifts, reasons, ...r,
        value: Math.round(valueAtStake(sku, r, onHand + onOrder)),
        tier: null,
      };
    });

    // Every row needs a human decision; only 'bulk' rows may be approved together.
    for (const row of rows) if (row.reasons.length) row.tier = 'judgment';
    const rest = rows.filter(r => !r.tier).sort((a, b) => b.value - a.value);
    rest.slice(0, JUDGMENT.topByValue).forEach(r => { if (r.value > 0) r.tier = 'top_value'; });
    for (const row of rest) {
      if (row.tier) continue;
      row.tier = row.action === 'standard' && hash(row.sku + asOf) % JUDGMENT.spotCheckEvery === 0 ? 'spot_check' : 'bulk';
    }

    const count = f => rows.filter(f).length;
    const summary = {
      skus: rows.length,
      judgment: count(r => r.tier === 'judgment'),
      reorderNow: count(r => r.action === 'reorder_now'),
      pause: count(r => r.action === 'pause'),
      overCover: count(r => r.overstock),
    };
    summary.judgmentShare = rows.length ? summary.judgment / rows.length : 0;
    return { asOf, festival: RULES.festivalMonths.includes(monthOf(asOf)), rows, summary };
  }

  // First Monday of the month on or before `s`: when the old monthly process ran.
  function lastMonthlyRun(s) {
    const firstMonday = ym => { let d = ym + '-01'; while (new Date(toT(d)).getUTCDay() !== 1) d = iso(toT(d) + DAY); return d; };
    const m = firstMonday(s.slice(0, 7));
    if (m <= s) return m;
    const prev = new Date(toT(s.slice(0, 7) + '-01') - DAY);
    return firstMonday(iso(prev).slice(0, 7));
  }

  // For every past stockout: would the rules have asked for a reorder early enough for stock
  // to land in time? Weekly cadence on fresh data vs the monthly cycle on data 3 weeks old.
  // shortcut: weekly data can only simulate a weekly cadence on last week's data; twice-weekly runs can only do better.
  function backtest({ skus, sales, stock }) {
    const S = indexSales(sales), K = indexStock(stock);
    const STALE_WEEKS = 3;
    const events = [];
    for (const sku of skus) {
      const st = K.get(sku.sku);
      if (!st) continue;
      const weeks = [...st.keys()].sort();
      const lead = sku.leadTimeWeeks || 2;
      const asks = dataWeek => {
        if (weeksBetween(weeks[0], dataWeek) < 12) return null;
        const s = st.get(dataWeek);
        const r = applyRules(sku, lastN(S.bySku.get(sku.sku), dataWeek, 12), s ? s.onHand + s.onOrder : 0, dataWeek);
        return r.action === 'reorder_now' || r.action === 'reorder';
      };
      for (let i = 1; i < weeks.length; i++) {
        const w = weeks[i];
        if (!(st.get(w).onHand === 0 && st.get(weeks[i - 1]).onHand > 0)) continue;
        const deadline = addWeeks(w, -lead);      // the last week an order could still arrive in time
        const monthlyRun = lastMonthlyRun(deadline);
        const monthly = asks(addWeeks(monthlyRun, -STALE_WEEKS));
        // A twice-weekly run sees data at most 4 days old; in weekly buckets that is last week's.
        const weeklyRuns = [0, 1, 2, 3].map(k => asks(addWeeks(deadline, -k - 1)));
        if (monthly === null || weeklyRuns.some(x => x === null)) continue;   // not enough history
        events.push({ sku: sku.sku, week: w, weekly: weeklyRuns.some(Boolean), monthly });
      }
    }
    const n = events.length;
    return {
      events: n,
      weeklyRate: n ? events.filter(e => e.weekly).length / n : null,
      monthlyRate: n ? events.filter(e => e.monthly).length / n : null,
    };
  }

  // ---- Synthetic demo data (clearly labelled in the UI; never real Freshroots figures) ----

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // [code, category, perishable, cost per kg (₹), products, pack sizes in grams]
  const CATALOG = [
    ['NM', 'Namkeen', false, 220, ['Bhujia Sev', 'Aloo Bhujia', 'Masala Peanuts', 'Moong Dal', 'Navratan Mix', 'Khatta Meetha', 'Ratlami Sev', 'Chakli', 'Shev Murmura', 'Cornflakes Chivda', 'Kolhapuri Mix', 'Garlic Sev', 'Nylon Sev', 'Masala Chana Dal'], [40, 200, 400]],
    ['CH', 'Chips', false, 300, ['Salted Banana Chips', 'Masala Banana Chips', 'Salted Potato Wafers', 'Peri Peri Wafers', 'Cream & Onion Wafers', 'Tapioca Chips', 'Jackfruit Chips', 'Masala Potato Sticks'], [35, 90, 150]],
    ['BK', 'Biscuits', false, 160, ['Nankhatai', 'Jeera Biscuits', 'Coconut Cookies', 'Glucose Biscuits', 'Atta Cookies', 'Butter Cookies', 'Cashew Cookies', 'Marie Biscuits'], [100, 300, 800]],
    ['FR', 'Fresh farsan', true, 260, ['Fresh Chivda', 'Bhakarwadi', 'Farsan Mix', 'Shankarpali', 'Fresh Chakli', 'Mini Kachori'], [250, 500]],
    ['BY', 'Bakery', true, 180, ['Butter Khari', 'Jeera Khari', 'Toast Rusk', 'Milk Rusk', 'Elaichi Rusk', 'Fruit Cake'], [200, 400]],
    ['ST', 'Staples', false, 90, ['Thick Poha', 'Thin Poha', 'Besan', 'Toor Dal', 'Moong Dal Split', 'Masoor Dal', 'Chana Dal', 'Chakki Atta', 'Sooji', 'Sabudana', 'Jaggery Powder', 'Red Poha', 'Kokum', 'Groundnut', 'Rajgira Flour'], [500, 1000]],
    ['MS', 'Masala', false, 420, ['Kanda Lasun Masala', 'Goda Masala', 'Malvani Masala', 'Misal Masala', 'Pav Bhaji Masala', 'Garam Masala', 'Chilli Powder', 'Turmeric Powder', 'Coriander Powder', 'Sambhar Masala'], [50, 100, 200]],
  ];
  const TOWNS = ['Pune', 'Mumbai', 'Thane', 'Nashik', 'Nagpur', 'Kolhapur', 'Aurangabad', 'Solapur', 'Satara', 'Sangli', 'Ahmednagar', 'Navi Mumbai', 'Kalyan', 'Vasai', 'Panvel', 'Jalgaon', 'Latur', 'Amravati', 'Akola', 'Nanded', 'Dhule', 'Ratnagiri', 'Chiplun', 'Sindhudurg', 'Karad', 'Baramati', 'Pimpri', 'Ichalkaranji', 'Wardha', 'Chandrapur', 'Beed', 'Osmanabad', 'Parbhani', 'Yavatmal', 'Panaji', 'Margao', 'Mapusa', 'Vasco', 'Ponda', 'Bicholim'];
  const packLabel = g => (g >= 1000 ? g / 1000 + 'kg' : g + 'g');

  // shortcut: each SKU carries its 12 biggest distributors at distributor level (the case has 1,200 in all);
  // a full SKU x distributor export is millions of rows and needs aggregation before it reaches a browser.
  function demoData(seed, opts) {
    const o = Object.assign({ skus: 400, distributors: 1200, perSku: 12, weeks: 60 }, opts);
    const rnd = mulberry32(seed == null ? 22 : seed);
    const asOf = '2026-10-19';                          // the Monday this demo pretends is "this week"
    const W = o.weeks;
    const start = addWeeks(asOf, -(W - 1));
    const distributors = Array.from({ length: o.distributors }, (_, i) => `${TOWNS[(i * 7) % TOWNS.length]} D-${String(i + 1).padStart(4, '0')}`);
    const skus = [], sales = [], stock = [];
    const gauss = () => (rnd() + rnd() + rnd() - 1.5) / 1.5;

    // Every product in every pack size, then regional packs, until there are o.skus SKUs.
    const PACKS = ['', ' · Goa pack', ' · Vidarbha pack', ' · Konkan pack'];
    for (let pass = 0; skus.length < o.skus; pass++) {
      for (const [code, category, perishable, perKg, products, sizes] of CATALOG) {
        for (const product of products) {
          for (const [k, g] of sizes.entries()) {
            if (skus.length >= o.skus) break;
            const packFactor = [2, 1, 0.45][k] || 0.45;   // small packs sell more units
            const base = Math.round((120 + rnd() * rnd() * 2200) * packFactor);
            skus.push({
              sku: `FR-${code}-${String(skus.length + 1).padStart(4, '0')}`, name: `${product} ${packLabel(g)}${PACKS[pass]}`, category, perishable,
              standardQty: Math.max(50, Math.round(base * (perishable ? 3 : 10) / 50) * 50),
              leadTimeWeeks: perishable ? 1 : 2 + Math.floor(rnd() * 2),
              unitCost: Math.max(4, Math.round(perKg * g / 1000 * (0.85 + rnd() * 0.3))),
              _base: base,
              _trend: rnd() < 0.12 ? 0.975 : 1,     // ~12% of SKUs are slowly losing demand
              _cover: perishable ? 5 + rnd() * 1.2 : rnd() < 0.3 ? 6 + rnd() * 4 : 12 + rnd() * 8,   // weeks the old process tops up to; planners differ
            });
          }
        }
      }
    }

    // Story SKUs so the judgment queue shows each kind of case.
    const np = skus.filter(s => !s.perishable);
    const at = f => np[Math.floor(np.length * f)];
    const launches = [0.02, 0.12, 0.22, 0.32, 0.42, 0.52, 0.62, 0.72, 0.82, 0.92].map(at);
    launches.forEach((s, i) => { s._launch = W - (2 + i); s._trend = 1; s.name = s.name.replace(/ · .*$/, '') + ' · new launch'; });
    const schemeHits = [0.06, 0.26, 0.46, 0.66, 0.86].map(at);  // two big distributors cut orders: a competitor scheme, as in the Ops brief
    const bulkSpikes = [0.09, 0.29, 0.49, 0.69, 0.89].map(at);  // one distributor's one-off bulk order
    const delisted = [0.16, 0.56, 0.96].map(at);                // stopped selling three months ago, stock left over
    const stories = [...launches, ...schemeHits, ...bulkSpikes, ...delisted];
    for (const s of stories) s._trend = 1;

    for (const s of skus) {
      const pick = [];
      while (pick.length < o.perSku) {             // biased toward the big distributors at the top of the list
        const d = distributors[Math.floor(o.distributors * Math.pow(rnd(), 2.2))];
        if (!pick.includes(d)) pick.push(d);
      }
      const raw = pick.map((_, i) => 1 / Math.pow(i + 1.2, 1.1));
      const shares = raw.map(x => x / sum(raw));
      let onHand = Math.round(s._base * (s.perishable ? 3.5 : 9) * (0.6 + rnd() * 0.8));
      const pipeline = [];
      const hist = new Map(), stockHist = new Map();

      for (let t = 0; t < W; t++) {
        const week = addWeeks(start, t);
        for (const p of pipeline) if (p.arrive === t) onHand += p.qty;
        if (s._launch != null && t < s._launch) { stock.push({ sku: s.sku, week, onHand: 0, onOrder: 0 }); stockHist.set(week, 0); continue; }
        if (s._launch === t) onHand = s.standardQty;
        if (bulkSpikes.includes(s) && t === W - 4) onHand += Math.round(s._base * 14);   // enough stock that the spike shows in sales

        // Stories land in the last 4 complete weeks (W-5..W-2); week W-1 is the run's own, still-running week.
        const fest = RULES.festivalMonths.includes(monthOf(week)) ? 1.3 : 1;
        const perDist = shares.map((sh, i) => {
          let d = s._base * Math.pow(s._trend, t) * sh * fest * (1 + 0.22 * gauss());
          if (schemeHits.includes(s) && t >= W - 5 && i < 2) d *= 0.35;
          if (bulkSpikes.includes(s) && t >= W - 4 && i === 0) d *= 8;
          if (delisted.includes(s) && t >= W - 14) d = 0;
          return Math.max(0, d);
        });
        const demand = sum(perDist);
        const sold = Math.min(onHand, Math.round(demand));
        onHand -= sold;
        const ratio = demand ? sold / demand : 0;
        perDist.forEach((d, i) => {
          const u = Math.round(d * ratio);
          if (u > 0) sales.push({ sku: s.sku, distributor: pick[i], week, units: u });
        });
        hist.set(week, sold);
        stockHist.set(week, onHand);

        // The old process: one run a month on data 3 weeks old, topping stock up to a few weeks of
        // (festival-lifted) demand. Stale data plus the long gap between runs makes the misses.
        if (week === lastMonthlyRun(week) && t >= 8) {
          const dataWeek = addWeeks(week, -3);
          const staleStock = stockHist.get(dataWeek) || 0;
          const r = applyRules(s, lastN(hist, dataWeek, 12), staleStock, dataWeek);
          const onOrder = sum(pipeline.filter(p => p.arrive > t).map(p => p.qty));
          const target = (r.demand || s._base) * s._cover;
          const qty = r.action === 'pause' ? 0 : Math.max(0, Math.round((target - staleStock - onOrder) / 50) * 50);
          if (qty > 0) pipeline.push({ arrive: t + s.leadTimeWeeks, qty });
        }
        stock.push({ sku: s.sku, week, onHand, onOrder: sum(pipeline.filter(p => p.arrive > t).map(p => p.qty)) });
      }

      // This week's stock position is drawn rather than simulated, so the demo opens on a realistic
      // run: about 70% of SKUs in band and the rest either side (perishables swing more). Open orders
      // stay as simulated, so some SKUs sit low on hand but covered by stock already on its way.
      const r = applyRules(s, lastN(hist, addWeeks(asOf, -1), 12), 0, asOf);
      const last = stock[stock.length - 1];
      if (!stories.includes(s) && r.demand > 0) {
        const u = rnd(), lowP = s.perishable ? 0.42 : 0.18, highP = s.perishable ? 0.26 : 0.06, b = r.band;
        const cover = u < lowP ? b.min * (0.25 + rnd() * 0.7) : u < lowP + highP ? b.max * (1.05 + rnd() * 0.6) : b.min + rnd() * (b.max - b.min);
        last.onHand = Math.max(0, Math.round(cover * r.demand - last.onOrder));
      }
      if (delisted.includes(s)) Object.assign(last, { onHand: Math.round(s._base * 3), onOrder: 0 });
      delete s._base; delete s._launch; delete s._trend; delete s._cover;
    }
    const ids = list => list.map(s => s.sku);
    // `through` is the raw date of the stock snapshot (a Thursday export); it names the run.
    return { skus, sales, stock, asOf, through: '2026-10-22', source: 'demo', stories: { scheme: ids(schemeHits), spike: ids(bulkSpikes), launches: ids(launches), delisted: ids(delisted) },
      distributorCount: new Set(sales.map(r => r.distributor)).size };
  }

  // ---- What comes in from outside: uploads, the AI, the shared database. Kept here so it is tested. ----

  // A date as SAP or Excel writes it: YYYY-MM-DD or DD.MM.YYYY (/ and - also work). YYYY-MM-DD, or null.
  function parseDate(v) {
    const s = String(v == null ? '' : v).trim();
    let y, m, d, x;
    if ((x = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) [y, m, d] = [x[1], x[2], x[3]];
    else if ((x = s.match(/^(\d{2})[./-](\d{2})[./-](\d{4})$/))) [y, m, d] = [x[3], x[2], x[1]];
    else return null;
    const s2 = `${y}-${m}-${d}`, t = toT(s2);
    return isNaN(t) || iso(t) !== s2 ? null : s2;
  }

  // A number as exported, Indian grouping allowed ("1,23,456"). Blank or junk is null.
  function num(v) {
    const s = String(v == null ? '' : v).replace(/,/g, '').trim();
    const n = Number(s);
    return s !== '' && isFinite(n) ? n : null;
  }

  // One CSV cell: quoted when needed, and a leading = + - @ neutralised so a name can't run as a spreadsheet formula.
  function csvCell(v) {
    let s = String(v == null ? '' : v);
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  const ACTION_KEYS = ['reorder_now', 'reorder', 'pause', 'standard'];
  const SUGGESTION_KEYS = ['follow_rule', 'reduce_qty', 'increase_qty', 'hold', 'ask_sales'];

  // The AI's reply for one SKU, cut down to what the page shows. A quantity over 3x standard is dropped.
  function cleanBrief(b, row) {
    const str = (x, n) => (typeof x === 'string' ? x.slice(0, n) : '');
    const list = x => (Array.isArray(x) ? x.filter(s => typeof s === 'string').slice(0, 3).map(s => s.slice(0, 220)) : []);
    const suggestion = SUGGESTION_KEYS.includes(b.suggestion) ? b.suggestion : 'ask_sales';
    let qty = typeof b.suggested_qty === 'number' && isFinite(b.suggested_qty) && b.suggested_qty >= 0 ? Math.round(b.suggested_qty) : null;
    let note = '';
    if (qty != null && qty > row.standardQty * 3) { qty = null; note = 'The AI quantity was more than 3× the standard quantity, so it was dropped.'; }
    if (suggestion !== 'reduce_qty' && suggestion !== 'increase_qty') qty = null;
    return { summary: str(b.summary, 420), hypotheses: list(b.hypotheses), suggestion, qty, checkFirst: list(b.check_first),
      confidence: ['low', 'medium', 'high'].includes(b.confidence) ? b.confidence : 'low', note };
  }

  // Records read back from the shared database: keep only ones the page can draw, so one bad record can't freeze the desk.
  const validDecision = d => !!d && (d.status === 'approved' || d.status === 'overridden') && ACTION_KEYS.includes(d.action) && Number.isInteger(d.qty) && d.qty >= 0;
  const validBrief = b => !!b && (b.missing === true || (typeof b.summary === 'string' && Array.isArray(b.hypotheses) && Array.isArray(b.checkFirst)
    && SUGGESTION_KEYS.includes(b.suggestion) && (b.qty == null || (Number.isInteger(b.qty) && b.qty >= 0))));

  // Upload dates that would silently skew a run: anything after today, and sales that stop short of the stock week.
  function checkDates(salesDays, stockDays, today) {
    const issues = [], late = [...salesDays, ...stockDays].filter(d => d > today);
    if (late.length) issues.push(`${late.length} row${late.length > 1 ? 's are' : ' is'} dated after today (latest ${late.sort().pop()}). Check the export for a mistyped date.`);
    const lastSales = salesDays.reduce((a, d) => (d > a ? d : a), ''), lastStock = stockDays.reduce((a, d) => (d > a ? d : a), '');
    if (lastSales && lastStock) {
      const salesWeek = monday(lastSales), stockWeek = monday(lastStock);
      if (salesWeek < addWeeks(stockWeek, -1)) issues.push(`sales.csv stops in the week of ${salesWeek}, but the stock snapshot is from the week of ${stockWeek}. Export sales up to the snapshot, or the missing weeks count as zero sales.`);
      if (salesWeek > stockWeek) issues.push(`stock.csv (week of ${stockWeek}) is older than sales.csv (week of ${salesWeek}). Export stock from the same day as sales.`);
    }
    return issues;
  }

  // The demo as the three CSV files IT would export from SAP.
  function demoCsv(data) {
    const csv = (head, rows) => [head.join(','), ...rows.map(r => r.map(csvCell).join(','))].join('\n') + '\n';
    return {
      'sku_master.csv': csv(['sku', 'name', 'category', 'perishable', 'standard_qty', 'lead_time_weeks', 'unit_cost'],
        data.skus.map(s => [s.sku, s.name, s.category, s.perishable ? 'Y' : 'N', s.standardQty, s.leadTimeWeeks, s.unitCost])),
      'sales.csv': csv(['sku', 'distributor', 'week', 'units'], data.sales.map(r => [r.sku, r.distributor, r.week, r.units])),
      // The snapshot week's rows carry the snapshot's own date, which names the run on upload.
      'stock.csv': csv(['sku', 'week', 'on_hand', 'on_order'], data.stock.map(r => [r.sku, r.week === data.asOf ? data.through : r.week, r.onHand, r.onOrder])),
    };
  }

  const api = { RULES, JUDGMENT, REASONS, evaluate, backtest, applyRules, demoData, demoCsv, monday, addWeeks, lastMonthlyRun,
    parseDate, num, csvCell, cleanBrief, validDecision, validBrief, checkDates };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FREngine = api;
})(this);
