#!/usr/bin/env python3
"""
Snapshot 17lands card ratings into static JSON files the PWA reads.

    python scripts/fetch_17lands.py                # refresh live sets + any missing sets
    python scripts/fetch_17lands.py --sets FRA BLB # just these
    python scripts/fetch_17lands.py --all          # refetch everything (slow, be polite)

Writes:
    data/<SET>.json     slimmed card list + stats for one set
    data/manifest.json  list of sets the app can offer

Standard library only, so it runs on a bare GitHub Actions runner.
17lands is a free community resource: requests are sequential with a delay,
and finished sets are only fetched once (their numbers stop changing).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import pathlib
import sys
import time
import urllib.parse
import urllib.request

BASE = "https://www.17lands.com"
FORMAT = "PremierDraft"
DELAY_S = 3.0
UA = "draft-pick-trainer/1.0 (personal training tool; static snapshot, weekly)"

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

# Expansions in the filters list that aren't normal retail draft sets.
SKIP_PREFIXES = ("Y2",)  # Arena "Alchemy" rebalanced versions (Y24LCI, Y26FRA, ...)
SKIP_EXACT = {"Cube", "Cube - Planar", "Cube - Powered", "Chaos", "Ravnica",
              "Remix - Artifacts", "CORE"}

KEEP_FIELDS = {
    "name": "name",
    "color": "color",
    "rarity": "rarity",
    "url": "img",
    "url_back": "img_back",
    "types": "types",
    "avg_seen": "alsa",                    # average last seen at
    "avg_pick": "ata",                     # average taken at
    "ever_drawn_win_rate": "gih",          # games-in-hand win rate
    "ever_drawn_game_count": "gih_n",
    "drawn_improvement_win_rate": "iwd",   # improvement when drawn
    "opening_hand_win_rate": "oh",
    "win_rate": "gp",                      # game-played win rate
    "game_count": "gp_n",
}


def get_json(path: str, params: dict | None = None):
    url = BASE + path + ("?" + urllib.parse.urlencode(params) if params else "")
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def slim(card: dict) -> dict:
    out = {}
    for src, dst in KEEP_FIELDS.items():
        v = card.get(src)
        if isinstance(v, float):
            v = round(v, 4)
        if v in ("", None, []):
            continue
        out[dst] = v
    # Smaller image size: plenty for a 7-wide grid, ~1/3 the bytes of "large".
    for k in ("img", "img_back"):
        if k in out:
            out[k] = out[k].replace("/large/", "/normal/")
    return out


def scryfall_set_names() -> dict:
    """code -> full set name, for the picker. Optional; failures are fine."""
    try:
        req = urllib.request.Request("https://api.scryfall.com/sets",
                                     headers={"User-Agent": UA, "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=60) as r:
            return {s["code"].upper(): s["name"] for s in json.load(r).get("data", [])}
    except Exception as e:  # noqa: BLE001
        print(f"scryfall set names unavailable ({e})", file=sys.stderr)
        return {}


def is_basic(card: dict) -> bool:
    return any("Basic" in t and "Land" in t for t in card.get("types", []))


def rated(cards: list[dict]) -> int:
    return sum(1 for c in cards if c.get("ever_drawn_win_rate") is not None)


def fetch_set(code: str, start: str | None) -> list[dict]:
    """Try the full-history window first, fall back to 17lands' default window,
    and keep whichever returns more rated cards."""
    attempts = []
    today = dt.date.today().isoformat()
    if start:
        attempts.append({"expansion": code, "format": FORMAT,
                         "start_date": start[:10], "end_date": today})
    attempts.append({"expansion": code, "format": FORMAT})
    best: list[dict] = []
    for params in attempts:
        try:
            cards = get_json("/card_ratings/data", params)
        except Exception as e:  # noqa: BLE001
            print(f"  {code}: request failed ({e})", file=sys.stderr)
            cards = []
        time.sleep(DELAY_S)
        print(f"  {code}: {len(cards)} cards, {rated(cards)} rated "
              f"({'dated' if 'start_date' in params else 'default'} window)")
        if rated(cards) > rated(best):
            best = cards
        if best and rated(best) >= 0.6 * len(best):
            break
    return best


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sets", nargs="*", help="set codes to fetch (default: live + missing)")
    ap.add_argument("--all", action="store_true", help="refetch every set")
    args = ap.parse_args()

    DATA.mkdir(exist_ok=True)
    filters = get_json("/data/filters")
    time.sleep(DELAY_S)

    starts: dict = filters.get("start_dates", {})
    fmts: dict = filters.get("formats_by_expansion", {})
    live = set(filters.get("live_formats_by_expansion", {}).keys())
    candidates = [e for e in filters.get("expansions", [])
                  if FORMAT in fmts.get(e, [])
                  and e not in SKIP_EXACT
                  and not e.startswith(SKIP_PREFIXES)]

    if args.sets:
        targets = [s.upper() for s in args.sets]
    elif args.all:
        targets = candidates
    else:
        targets = [e for e in candidates if e in live or not (DATA / f"{e}.json").exists()]

    print(f"{len(candidates)} draftable sets; fetching {len(targets)}: {', '.join(targets)}")
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")

    for code in targets:
        raw = fetch_set(code, starts.get(code))
        cards = [slim(c) for c in raw if not is_basic(c)]
        path = DATA / f"{code}.json"
        if not cards:
            print(f"  {code}: nothing returned, skipping")
            continue
        new_rated = sum(1 for c in cards if "gih" in c)
        if path.exists():
            old = json.loads(path.read_text())
            old_rated = sum(1 for c in old.get("cards", []) if "gih" in c)
            if new_rated < old_rated and code not in live:
                print(f"  {code}: new snapshot has fewer rated cards ({new_rated} < {old_rated}); keeping old")
                continue
        path.write_text(json.dumps({
            "set": code,
            "format": FORMAT,
            "start": starts.get(code),
            "fetched": now,
            "cards": cards,
        }, separators=(",", ":"), ensure_ascii=False))
        print(f"  {code}: wrote {len(cards)} cards ({new_rated} rated)")

    # Manifest = every snapshot on disk, newest set first.
    names = scryfall_set_names()
    sets = []
    for p in DATA.glob("*.json"):
        if p.name == "manifest.json":
            continue
        d = json.loads(p.read_text())
        n = len(d.get("cards", []))
        r = sum(1 for c in d.get("cards", []) if "gih" in c)
        if r == 0:
            continue
        sets.append({"code": d["set"], "name": names.get(d["set"], d["set"]), "start": d.get("start"), "fetched": d.get("fetched"),
                     "cards": n, "rated": r, "live": d["set"] in live})
    sets.sort(key=lambda s: s.get("start") or "", reverse=True)
    (DATA / "manifest.json").write_text(json.dumps({"updated": now, "sets": sets}, indent=1))
    print(f"manifest: {len(sets)} sets")
    return 0


if __name__ == "__main__":
    sys.exit(main())
