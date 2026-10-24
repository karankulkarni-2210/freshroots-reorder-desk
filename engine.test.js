// Run: node engine.test.js
const assert = require('node:assert/strict');
const E = require('./engine.js');

const sku = { sku: 'T1', standardQty: 100, perishable: false };
const flat = n => Array(12).fill(n);

// Raghav's rules, one at a time (September: no festival uplift).
let r = E.applyRules(sku, flat(10), 50, '2026-09-07');
assert.equal(r.action, 'reorder_now', 'cover 5 < 6 weeks is a stockout risk');
assert.equal(r.qty, 100);

r = E.applyRules(sku, flat(10), 150, '2026-09-07');
assert.equal(r.action, 'pause', 'cover 15 > 14 weeks is overstock');

r = E.applyRules(sku, [...Array(8).fill(10), ...Array(4).fill(16)], 100, '2026-09-07');
assert.ok(r.highDemand, 'avg4 16 vs avg12 12 is >20% above');
assert.equal(r.action, 'reorder');
assert.equal(r.qty, 150, 'high demand reorders 1.5x standard');

r = E.applyRules(sku, [...Array(8).fill(10), ...Array(4).fill(16)], 200, '2026-09-07');
assert.equal(r.action, 'pause', 'A1: overstock pause beats high demand');

r = E.applyRules(sku, flat(10), 70, '2026-10-05');
assert.ok(r.festival);
assert.equal(r.cover, 70 / 12.5, 'festival month lifts demand 25% before cover checks');
assert.equal(r.action, 'reorder_now', 'cover 5.6 after uplift; it would be 7 without');

r = E.applyRules({ ...sku, perishable: true }, flat(10), 50, '2026-09-07');
assert.equal(r.action, 'pause', 'perishable max is 4 weeks');

r = E.applyRules(sku, flat(0), 0, '2026-09-07');
assert.equal(r.action, 'standard', 'no demand: no cover, no rule fires');

// Judgment routing and tiers on a hand-built case.
const weeks = Array.from({ length: 14 }, (_, i) => E.addWeeks('2026-06-22', i));
const mk = (s, dist, unitsFn) => weeks.map((week, i) => ({ sku: s, distributor: dist, week, units: unitsFn(i) }));
const out = E.evaluate({
  skus: [
    { sku: 'OLD', name: 'a', standardQty: 100, perishable: false, unitCost: 10 },
    { sku: 'NEW', name: 'b', standardQty: 100, perishable: false, unitCost: 10 },
    { sku: 'SHIFT', name: 'c', standardQty: 100, perishable: false, unitCost: 10 },
    { sku: 'GAP', name: 'd', standardQty: 100, perishable: false, unitCost: 10 },
  ],
  sales: [
    ...mk('OLD', 'X', () => 10),
    ...mk('NEW', 'X', i => (i >= 10 ? 10 : 0)),
    ...mk('SHIFT', 'Big', i => (i >= 9 ? 3 : 10)), ...mk('SHIFT', 'Other', () => 10),
    ...mk('GAP', 'X', () => 10),
  ],
  stock: ['OLD', 'NEW', 'SHIFT'].map(s => ({ sku: s, week: weeks[13], onHand: 100 })),
});
const by = Object.fromEntries(out.rows.map(x => [x.sku, x]));
assert.equal(out.asOf, weeks[13]);
assert.deepEqual(by.OLD.reasons, []);
assert.ok(by.NEW.reasons.includes('new_sku'));
assert.ok(by.SHIFT.reasons.includes('distributor_shift'));
assert.ok(by.SHIFT.shifts.some(s => s.distributor === 'Big' && s.change < -0.4));
assert.ok(by.GAP.reasons.includes('data_gap'));
assert.equal(by.NEW.tier, 'judgment');
assert.notEqual(by.OLD.tier, 'judgment');

// A mid-week export: the stock week has barely started, so it must not count as a week of sales.
const w15 = Array.from({ length: 15 }, (_, i) => E.addWeeks('2026-06-15', i));
const flatSku = id => ({ sku: id, name: id, standardQty: 100, perishable: false, unitCost: 1 });
const partial = E.evaluate({
  skus: [flatSku('P')],
  sales: w15.map((week, i) => ({ sku: 'P', distributor: 'X', week, units: i === 14 ? 1 : 10 })),
  stock: [{ sku: 'P', week: w15[14], onHand: 80 }],
}).rows[0];
assert.equal(partial.avg4, 10, 'the running week is left out of the 4-week average');
assert.equal(partial.avg12, 10, 'and out of the 12-week average');

// Stock already on order counts, so Thursday does not re-order what Monday approved.
const withOrder = onOrder => E.evaluate({
  skus: [flatSku('O')],
  sales: w15.map(week => ({ sku: 'O', distributor: 'X', week, units: 10 })),
  stock: [{ sku: 'O', week: w15[14], onHand: 30, onOrder }],
}).rows[0];
assert.equal(withOrder(0).action, 'reorder_now', '3 weeks on hand and nothing coming is a stockout risk');
assert.equal(withOrder(50).action, 'standard', '3 weeks on hand plus 5 on order is 8 weeks: no second order');
assert.equal(withOrder(50).onOrder, 50);
assert.equal(withOrder(50).cover, 8);

// The high-demand path must not repeat either: Monday's 1.5x order, once on order, tips Thursday into a pause.
const rising = onOrder => E.evaluate({
  skus: [flatSku('H')],
  sales: w15.map((week, i) => ({ sku: 'H', distributor: 'X', week, units: i >= 10 && i < 14 ? 14 : 10 })),
  stock: [{ sku: 'H', week: w15[14], onHand: 90, onOrder }],
}).rows[0];
assert.equal(rising(0).action, 'reorder', 'Monday: the last 4 weeks run 24% above the 12-week average, so reorder 1.5x');
assert.equal(rising(0).qty, 150);
assert.notEqual(rising(150).action, 'reorder', 'Thursday: that 150 is on order, so no second 1.5x order');

// Daily stock rows in one week: the latest day wins even when the file lists newest first.
const daily = E.evaluate({
  skus: [flatSku('D')],
  sales: w15.map(week => ({ sku: 'D', distributor: 'X', week, units: 10 })),
  stock: [
    { sku: 'D', week: w15[14], date: E.addWeeks(w15[14], 0).replace(/..$/, '24'), onHand: 20 },   // Thursday
    { sku: 'D', week: w15[14], date: w15[14], onHand: 90 },                                         // Monday
  ],
}).rows[0];
assert.equal(daily.onHand, 20, "Thursday's stock beats Monday's, whatever the row order");

// Upload helpers: what comes in from SAP, Excel and the AI.
assert.equal(E.parseDate('22.10.2026'), '2026-10-22', 'DD.MM.YYYY as SAP writes it');
assert.equal(E.parseDate('2026-10-22'), '2026-10-22');
assert.equal(E.parseDate('10/22/2026'), null, 'a US-style date is refused, not read as the 10th of month 22');
assert.equal(E.parseDate('2026-02-30'), null, 'an impossible date is refused');
assert.equal(E.num('1,23,456'), 123456, 'Indian digit grouping');
assert.equal(E.num(''), null);
assert.equal(E.num('n/a'), null);
assert.equal(E.csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"', 'a formula in a name is neutralised and quoted');
assert.equal(E.csvCell('Masala, 200g'), '"Masala, 200g"');
assert.equal(E.csvCell(1500), '1500');
const bigAsk = E.cleanBrief({ suggestion: 'increase_qty', suggested_qty: 999999, summary: 'x', hypotheses: 'not a list' }, { standardQty: 100 });
assert.equal(bigAsk.qty, null, 'an AI quantity over 3x standard is dropped');
assert.ok(bigAsk.note);
assert.deepEqual(bigAsk.hypotheses, []);
assert.equal(E.cleanBrief({ suggestion: 'buy_everything' }, { standardQty: 100 }).suggestion, 'ask_sales', 'an unknown suggestion falls back to asking');
assert.equal(E.cleanBrief({ suggestion: 'hold', suggested_qty: 50 }, { standardQty: 100 }).qty, null, 'only reduce or increase carry a quantity');

// Records read back from the shared database.
assert.ok(E.validDecision({ status: 'approved', action: 'reorder', qty: 150 }));
assert.ok(!E.validDecision({ status: 'approved', action: 'delete_all', qty: 1 }), 'unknown action');
assert.ok(!E.validDecision({ status: 'approved', action: 'reorder', qty: 1.5 }), 'fractional quantity');
assert.ok(!E.validDecision({ status: 'maybe', action: 'reorder', qty: 1 }), 'unknown status');
assert.ok(E.validBrief({ missing: true }));
assert.ok(E.validBrief({ summary: 's', hypotheses: [], checkFirst: [], suggestion: 'hold', qty: null }));
assert.ok(!E.validBrief({ summary: 's', hypotheses: 'x', checkFirst: [], suggestion: 'hold' }), 'a non-list would crash the brief card');

// Upload dates that don't line up.
assert.deepEqual(E.checkDates(['2026-10-18'], ['2026-10-22'], '2026-10-24'), [], 'sales through last week, stock this week: fine');
assert.match(E.checkDates(['2026-10-18'], ['2027-10-19'], '2026-10-24')[0], /after today/, 'a mistyped year is caught');
assert.match(E.checkDates(['2026-10-04'], ['2026-10-22'], '2026-10-24').join(' '), /stops in the week of 2026-09-28/, 'sales two weeks short of the stock week is caught');
assert.match(E.checkDates(['2026-10-22'], ['2026-10-08'], '2026-10-24').join(' '), /older than sales/);

// Backtest, by hand: steady sales of 10 a week, stock falling to zero in week 28, lead time 2.
// Weekly runs see 4 weeks of cover on week 25's data and ask in time; the monthly run on 6 July reads
// week 23's data (exactly 6 weeks of cover, not below the line) and misses it.
const bw = Array.from({ length: 30 }, (_, i) => E.addWeeks('2026-01-05', i));
const path = i => (i <= 22 ? 200 : [60, 50, 40, 30, 10, 0, 0, 0][i - 23]);
const bt1 = E.backtest({
  skus: [{ ...flatSku('B'), leadTimeWeeks: 2 }],
  sales: bw.map(week => ({ sku: 'B', distributor: 'X', week, units: 10 })),
  stock: bw.map((week, i) => ({ sku: 'B', week, onHand: path(i), onOrder: 0 })),
});
assert.equal(bt1.events, 1, 'one stockout, in week 28');
assert.equal(bt1.weeklyRate, 1, 'weekly runs caught it');
assert.equal(bt1.monthlyRate, 0, 'the monthly run on stale data missed it');

assert.equal(E.lastMonthlyRun('2026-10-19'), '2026-10-05');
assert.equal(E.lastMonthlyRun('2026-10-02'), '2026-09-07');
assert.equal(E.monday('2026-10-22'), '2026-10-19');

// Demo data: deterministic, judgment share near Raghav's 15-20%, and a backtest with events.
const demo = E.demoData();
const ev = E.evaluate(demo);
const bt = E.backtest(demo);
assert.equal(ev.asOf, '2026-10-19');
assert.equal(E.monday(demo.through), ev.asOf, 'the run date falls in the stock week');
assert.ok(ev.rows.some(r => r.onOrder > 0 && r.action === 'standard' && r.onHand / r.demand < r.band.min), 'demo shows a SKU low on hand but covered by an order on its way');
assert.equal(JSON.stringify(E.evaluate(E.demoData()).summary), JSON.stringify(ev.summary), 'deterministic');
assert.ok(ev.summary.judgmentShare >= 0.10 && ev.summary.judgmentShare <= 0.25, `judgment share ${ev.summary.judgmentShare}`);
assert.ok(bt.events >= 20, `backtest events ${bt.events}`);
const story = id => ev.rows.find(x => x.sku === id);
demo.stories.scheme.forEach(id => assert.ok(story(id).reasons.includes('distributor_shift'), `scheme story ${id} is flagged`));
demo.stories.spike.forEach(id => assert.ok(story(id).reasons.includes('demand_spike'), `bulk-spike story ${id} is flagged`));
demo.stories.launches.forEach(id => assert.ok(story(id).reasons.includes('new_sku')));
assert.ok(ev.summary.pause > 0 && ev.summary.reorderNow > 0, 'demo shows both stockout and overstock cases');
assert.equal(ev.summary.skus, 400, 'the case has 400 active SKUs');
assert.ok(demo.distributorCount > 900, `distributors in the demo: ${demo.distributorCount}`);

// The CSV export round-trips: same SKUs, rows and totals as the in-page demo.
const files = E.demoCsv(demo);
const lines = f => files[f].trim().split('\n');
assert.equal(lines('sku_master.csv').length - 1, demo.skus.length);
assert.equal(lines('sales.csv').length - 1, demo.sales.length);
assert.equal(lines('stock.csv').length - 1, demo.stock.length);
const csvUnits = lines('sales.csv').slice(1).reduce((s, l) => s + Number(l.split(',').pop()), 0);
assert.equal(csvUnits, demo.sales.reduce((s, r) => s + r.units, 0), 'sales units total matches');

console.log('summary', ev.summary);
console.log('backtest', { events: bt.events, weekly: bt.weeklyRate, monthly: bt.monthlyRate });
console.log('reasons', ev.rows.filter(x => x.reasons.length).map(x => `${x.sku}:${x.reasons.join('+')}`).join(' '));
console.log('all tests passed');
