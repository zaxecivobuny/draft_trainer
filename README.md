# P1P1 Trainer

Open a virtual Arena-style draft pack, make your pick (or rank the whole pack), then reveal each card's 17lands numbers. Static PWA, no build step, no backend.

## How it works

- **Data:** `scripts/fetch_17lands.py` snapshots 17lands' card ratings (Premier Draft) into `data/<SET>.json` plus `data/manifest.json`. The app never calls 17lands from the browser (no CORS, and it keeps load on 17lands to one polite weekly job).
- **Images:** card art comes from Scryfall's CDN (`cards.scryfall.io`, URLs are included in the 17lands payload). The service worker caches them, so repeat packs load instantly and work offline.
- **Packs:** 1 rare/mythic (mythic odds = M / (2R + M)), 3 uncommons, 10 commons, basics excluded, displayed in Arena order (rarity, then WUBRG).
- **Modes**
  - *Pick* — click the card you'd take. Instantly reveals; your pick is outlined teal, the best card gold, and each card shows its rank in the pack.
  - *Rank* — tap cards best→worst (each tap moves the card to the next slot; tap again to un-place) and/or drag to reorder, then **Reveal**. Each card shows how many spots you had it over/under, plus the pack's Spearman correlation.
- **Score by:** GIH WR (default), IWD, ATA, or ALSA. Switching after a reveal re-scores the pack on screen. The letter grade is always GIH WR z-score vs. the set average.
- **Progress (S):** per set + metric — packs graded, top-pick hit rate, average pick rank, average rank correlation, and the cards you consistently over/underrate (≥2 sightings). Stored in `localStorage` on that device; export as JSON from the dialog.
- **Keys:** `N` new pack · `Enter` reveal (rank) / next pack (after reveal) · `S` progress · right-click a card to enlarge.

Cards that 17lands hasn't rated (too few games) show "no data" and are left out of scoring.

## Deploy

Same as your other static PWAs — the repo root is the site.

1. Push this folder to a new GitHub repo.
2. **Seed data:** Actions → *Refresh 17lands data* → *Run workflow* (tick **all** the first time). It commits `data/`, which triggers a deploy. Or locally: `python scripts/fetch_17lands.py --all` and commit.
3. Connect the repo:
   - **Cloudflare Pages:** framework preset *None*, build command empty, output directory `/`.
   - **Netlify:** `netlify.toml` already sets publish = `.` with no build command.
4. Custom domain as usual. `_headers` (read by both hosts) keeps `sw.js` and `data/` uncached.

The workflow runs every Monday, refetching only live sets plus any set not yet on disk; finished sets never change. It won't overwrite an older snapshot with one that has fewer rated cards.

When you change `app.js`/`styles.css`, bump `VERSION` in `sw.js` so installed copies pick up the new shell.

## Known limits (v1)

- Bonus-sheet / special-guest cards that 17lands lists under a set get mixed into the normal rarity slots.
- Every pack is a full 14-card P1-style pack; no later-pick (smaller pack) simulation or color-commitment context yet.
- GIH WR is a deck-agnostic signal; it's not "what a pro would take" in a given draft.
- Alchemy (Y-prefixed), cube and chaos formats are skipped by the fetcher (edit `SKIP_*` to include them).

Data: [17lands](https://www.17lands.com) (please respect their terms) · images: [Scryfall](https://scryfall.com). Not affiliated with Wizards of the Coast.
