# AARVE MAG/01

One-page store for the AARVE MAG/01 magnetic pull-lift wallet, with an order admin.

- `index.html`, `styles.css`, `app.js`: the storefront (no build step, no framework)
- `admin/`: the order console (sign in, confirm, pack, ship, deliver, stock and price, messages, CSV export)
- `worker/`: the API (Cloudflare Worker + D1 database). `schema.sql` creates the tables
- `test/api.test.mjs`: API checks. `test/e2e.mjs`: browser checks (phone and desktop, offline, flaky network)
- `sw.js`: offline shell. `config.js`: API address and optional Meta / TikTok pixel IDs

## Run it on your computer
```
cd worker && npx wrangler d1 execute aarve --local --file schema.sql && npx wrangler dev --local --port 8787
python3 -m http.server 8801          # in the project folder
node test/api.test.mjs && node test/e2e.mjs
```
Local admin password is in `worker/.dev.vars` (not committed).

## Change the pictures
The storefront uses `hero.jpg` / `hero.webp`, `pull-story-v2.jpg`, `construction-v2.jpg`, `macro.jpg`, `front.jpg`, `rear.jpg`, `side.jpg` and `thumb.jpg`. Keep their current aspect ratios when replacing them. Campaign imagery is disclosed once in the specifications section rather than repeatedly labelled over every photograph.

## Deploy the API
`cd worker && npx wrangler deploy`. Set `ADMIN_PASSWORD` and `SESSION_SECRET` with `npx wrangler secret put`. Allowed website addresses are in `wrangler.toml` (`ALLOWED_ORIGINS`).
