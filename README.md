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
Swap files in `assets/img/` keeping the same names (`hero.jpg`, `hero.webp`, `rest.jpg`, `pull.jpg`, `layers.jpg`, `macro.jpg`, `front.jpg`, `rear.jpg`, `side.jpg`, `thumb.jpg`). The page picks them up with no code change. The current pictures are product renderings and are captioned as such.

## Deploy the API
`cd worker && npx wrangler deploy`. Set `ADMIN_PASSWORD` and `SESSION_SECRET` with `npx wrangler secret put`. Allowed website addresses are in `wrangler.toml` (`ALLOWED_ORIGINS`).
