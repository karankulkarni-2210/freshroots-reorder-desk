# Freshroots Reorder Desk

Live: https://freshroots-reorder-desk-sand.vercel.app · Database: Supabase project `freshroots-reorder-desk` (Mumbai)

Twice-weekly reorder review for Freshroots' demand planning (MESA case 01). Raghav's documented rules run on the SAP export; what they can't settle goes to a judgment queue with an AI brief; every order line needs a person's approval; approved lines export as a CSV for Zoho Inventory. The desk never places an order itself.

## How it runs

- `index.html`, `engine.js`, `charts.js`, `moss.jpg` are the page. In claude.ai they are published as an artifact.
- On Vercel, `build.mjs` wraps the same page and adds `platform.js`, which answers the page's `window.claude.use()` calls from Supabase (sign-in, the shared decision store, live updates), `api/brief.mjs` (AI briefs) and browser downloads.
- `supabase/migrations/` holds the database: `members` (who is on the desk and whether they are an Editor) and `runs` (one record per export, with its decisions and AI briefs). Signed-in team members read; only Editors write; a saved run is only ever merged into, never replaced.

## Setup the owner does once

1. **Accounts.** Supabase dashboard → Authentication → Users → Add user, with "Auto confirm" ticked. Every account starts as a viewer.
2. **Editors.** Supabase dashboard → Table Editor → `members` → set `role` to `editor` for the people who approve orders (Raghav, Deepa).
3. **AI briefs.** Vercel → this project → Settings → Environment Variables → add `ANTHROPIC_API_KEY`, then redeploy. Without it the desk works and simply hides the AI briefs.

## Data

IT exports three CSV files twice a week, covering the last 60 weeks:

| File | Columns |
| --- | --- |
| `sku_master.csv` | sku, name, category, perishable (Y/N), standard_qty, lead_time_weeks, unit_cost |
| `sales.csv` | sku, distributor, week, units |
| `stock.csv` | sku, week, on_hand, on_order (open Zoho purchase orders; blank = 0) |

The latest stock rows carry the snapshot's own date, which names the run. Files are read in the browser; only decisions and AI briefs are stored.

## Develop

```bash
npm install
npm test             # rules engine, upload helpers, backtest, API guard
npm run build        # writes public/ for Vercel
npm run sample-data  # writes sample-data/*.csv from the synthetic demo
```
