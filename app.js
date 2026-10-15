/* P1P1 Trainer — open a pack, pick or rank, compare with 17lands. */
(() => {
  "use strict";

  // ---------- config ----------
  const METRICS = {
    gih:  { label: "GIH WR", better: "high", fmt: v => (v * 100).toFixed(1) + "%" },
    iwd:  { label: "IWD",    better: "high", fmt: v => (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "pp" },
    ata:  { label: "ATA",    better: "low",  fmt: v => v.toFixed(2) },
    alsa: { label: "ALSA",   better: "low",  fmt: v => v.toFixed(2) },
  };
  const RARITY_ORDER = { mythic: 0, rare: 1, uncommon: 2, common: 3 };
  const COLOR_ORDER = "WUBRG";
  const PACK = { uncommons: 3, commons: 10 }; // + 1 rare/mythic = 14, Arena-style
  const HISTORY_KEY = "p1p1.history.v1";
  const PREFS_KEY = "p1p1.prefs.v1";
  const HISTORY_CAP = 5000;
  const MIN_SEEN_FOR_LIST = 2;

  // ---------- state ----------
  const S = {
    manifest: null,
    sets: new Map(),       // code -> { cards, gihMean, gihSd }
    set: null,
    metric: "gih",
    mode: "pick",
    pack: [],              // card objects (with .id)
    order: [],             // ids in display / user-ranking order
    tapped: new Set(),     // rank mode: ids the user has explicitly placed
    picked: null,          // pick mode: id
    revealed: false,
    els: new Map(),        // id -> element
    sortable: null,
    packNo: 0,
  };

  // ---------- dom ----------
  const $ = s => document.querySelector(s);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const D = {
    set: $("#set"), metric: $("#metric"), seg: document.querySelectorAll(".seg button"),
    pack: $("#pack"), hint: $("#hint"), meta: $("#meta"), summary: $("#summary"),
    reveal: $("#reveal"), next: $("#next"), resetRank: $("#resetRank"), empty: $("#empty"),
    zoom: $("#zoom"), zoomBody: $("#zoomBody"), stats: $("#stats"), statsBody: $("#statsBody"),
    statsBtn: $("#statsBtn"),
  };

  // ---------- storage ----------
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
      catch { return fallback; }
    },
    set(key, val) {
      try { localStorage.setItem(key, JSON.stringify(val)); return true; }
      catch { return false; }
    },
  };
  const savePrefs = () => store.set(PREFS_KEY, { set: S.set, metric: S.metric, mode: S.mode });

  // ---------- helpers ----------
  const rand = n => Math.floor(Math.random() * n);
  function sample(arr, n) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = rand(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
    return a.slice(0, Math.min(n, a.length));
  }
  const val = (card, m = S.metric) => (typeof card[m] === "number" ? card[m] : null);
  const cmp = m => METRICS[m].better === "high" ? (a, b) => val(b, m) - val(a, m) : (a, b) => val(a, m) - val(b, m);

  function grade(card, setData) {
    const v = card.gih;
    if (typeof v !== "number" || !setData.gihSd) return null;
    const z = (v - setData.gihMean) / setData.gihSd;
    const steps = [
      [2.0, "A+"], [1.67, "A"], [1.33, "A-"], [1.0, "B+"], [0.67, "B"], [0.33, "B-"],
      [0, "C+"], [-0.33, "C"], [-0.67, "C-"], [-1.0, "D+"], [-1.33, "D"], [-1.67, "D-"],
    ];
    for (const [t, g] of steps) if (z >= t) return g;
    return "F";
  }
  const gradeClass = g => "g-" + g[0].toLowerCase();

  function colorKey(c) {
    const col = c.color || "";
    if (col.length === 0) return 7;
    if (col.length > 1) return 6;
    return COLOR_ORDER.indexOf(col);
  }
  const arenaSort = (a, b) =>
    (RARITY_ORDER[a.rarity] ?? 4) - (RARITY_ORDER[b.rarity] ?? 4) ||
    colorKey(a) - colorKey(b) || a.name.localeCompare(b.name);

  const FALLBACK_COLORS = {
    W: ["#efe7c8", "#a99c73"], U: ["#4d86c2", "#1d3a5c"], B: ["#5a5160", "#1c181f"],
    R: ["#c4513f", "#5c1d16"], G: ["#4b9459", "#183d22"], M: ["#d1b25a", "#6b5520"], C: ["#9aa1a4", "#41474a"],
  };

  // ---------- data ----------
  async function loadManifest() {
    const r = await fetch("data/manifest.json", { cache: "no-cache" });
    if (!r.ok) throw new Error("manifest " + r.status);
    return r.json();
  }

  async function loadSet(code) {
    if (S.sets.has(code)) return S.sets.get(code);
    const r = await fetch(`data/${encodeURIComponent(code)}.json`);
    if (!r.ok) throw new Error(`${code} ${r.status}`);
    const d = await r.json();
    const cards = d.cards.map((c, i) => ({ ...c, id: i }));
    const g = cards.map(c => c.gih).filter(v => typeof v === "number");
    const mean = g.reduce((a, b) => a + b, 0) / (g.length || 1);
    const sd = Math.sqrt(g.reduce((a, b) => a + (b - mean) ** 2, 0) / (g.length || 1));
    const out = { code, cards, gihMean: mean, gihSd: sd, fetched: d.fetched, start: d.start };
    S.sets.set(code, out);
    return out;
  }

  function makePack(cards) {
    const pool = r => cards.filter(c => c.rarity === r);
    const C = pool("common"), U = pool("uncommon"), R = pool("rare"), M = pool("mythic");
    const out = [];
    // Rares are printed at twice the rate of mythics: P(mythic) = M / (2R + M).
    if (R.length || M.length) {
      const pM = M.length / (2 * R.length + M.length);
      out.push(...sample(Math.random() < pM ? M : R, 1));
    }
    out.push(...sample(U, PACK.uncommons));
    out.push(...sample(C, PACK.commons));
    if (out.length < 10) out.push(...sample(cards.filter(c => !out.includes(c)), 14 - out.length));
    return out.sort(arenaSort);
  }

  // ---------- scoring ----------
  /** true rank (1 = best) for rated cards in the pack under metric m */
  function trueRanks(pack, m) {
    const rated = pack.filter(c => val(c, m) != null).sort(cmp(m));
    const ranks = new Map();
    rated.forEach((c, i) => ranks.set(c.id, i + 1));
    return { ranks, k: rated.length, best: rated[0] || null };
  }

  function evaluate() {
    const m = S.metric;
    const { ranks, k, best } = trueRanks(S.pack, m);
    const byId = new Map(S.pack.map(c => [c.id, c]));
    if (S.mode === "pick") {
      const pick = byId.get(S.picked) || null;
      const r = pick ? ranks.get(S.picked) ?? null : null;
      const deltas = [];
      if (pick && r != null) {
        deltas.push([pick.name, r - 1]);                         // >0: overrated the pick
        if (best && best.id !== pick.id) deltas.push([best.name, -(r - 1)]); // passed the best
      }
      return { m, k, ranks, best, pick, pickRank: r, deltas };
    }
    // rank mode: user's order restricted to rated cards
    const userRated = S.order.map(id => byId.get(id)).filter(c => ranks.has(c.id));
    const userRank = new Map(userRated.map((c, i) => [c.id, i + 1]));
    let d2 = 0;
    const deltas = [];
    for (const c of userRated) {
      const d = ranks.get(c.id) - userRank.get(c.id); // >0: you ranked it higher than data
      d2 += d * d;
      deltas.push([c.name, d]);
    }
    const rho = k >= 2 ? 1 - (6 * d2) / (k * (k * k - 1)) : null;
    const mae = k ? deltas.reduce((a, [, d]) => a + Math.abs(d), 0) / k : null;
    const top = S.order.map(id => byId.get(id)).find(c => ranks.has(c.id));
    return { m, k, ranks, best, userRank, rho, mae, topRight: top && best && top.id === best.id, deltas };
  }

  function record(ev) {
    const h = store.get(HISTORY_KEY, []);
    h.push({
      t: Date.now(), set: S.set, mode: S.mode, metric: ev.m, k: ev.k,
      pickRank: ev.pickRank ?? undefined,
      rho: ev.rho != null ? +ev.rho.toFixed(3) : undefined,
      mae: ev.mae != null ? +ev.mae.toFixed(2) : undefined,
      d: ev.deltas,
    });
    while (h.length > HISTORY_CAP) h.shift();
    store.set(HISTORY_KEY, h);
  }

  // ---------- rendering ----------
  function cardEl(c) {
    const n = el("div", "card");
    n.dataset.id = c.id;
    n.tabIndex = 0;
    n.setAttribute("role", "button");
    n.setAttribute("aria-label", c.name);
    const fbc = FALLBACK_COLORS[(c.color || "").length > 1 ? "M" : (c.color || "C")] || FALLBACK_COLORS.C;
    const fb = el("div", "fallback");
    fb.style.setProperty("--c1", fbc[0]);
    fb.style.setProperty("--c2", fbc[1]);
    if (c.color === "W") fb.style.color = "#2a2416";
    fb.append(el("div", "fb-name", c.name), el("div", "fb-type", (c.types || []).join(" · ")), el("div", "fb-rar", c.rarity));
    n.append(fb);
    if (c.img) {
      const img = new Image();
      img.alt = c.name;
      img.loading = "eager";
      img.decoding = "async";
      img.draggable = false;
      img.onload = () => { fb.hidden = true; };
      img.onerror = () => img.remove();
      img.src = c.img;
      n.append(img);
    }
    const z = el("button", "zoom-btn", "⤢");
    z.type = "button";
    z.title = "Enlarge";
    z.setAttribute("aria-label", "Enlarge " + c.name);
    z.addEventListener("click", e => { e.stopPropagation(); openZoom(c); });
    n.append(z);
    n.addEventListener("click", () => onCardClick(c.id));
    n.addEventListener("keydown", e => { if (e.key === " " && !e.repeat) { e.preventDefault(); onCardClick(c.id); } });
    n.addEventListener("contextmenu", e => { e.preventDefault(); openZoom(c); });
    return n;
  }

  function layout() {
    // move existing nodes into the current order (appendChild moves, no image reload)
    for (const id of S.order) D.pack.append(S.els.get(id));
    paintBadges();
  }

  function paintBadges() {
    S.order.forEach((id, i) => {
      const n = S.els.get(id);
      n.querySelector(".pos")?.remove();
      n.classList.toggle("tapped", S.mode === "rank" && S.tapped.has(id));
      if (S.mode === "rank") {
        const b = el("div", "pos", String(i + 1));
        n.prepend(b);
      }
    });
  }

  function clearOverlays() {
    for (const n of S.els.values()) {
      n.querySelectorAll(".score,.truerank").forEach(x => x.remove());
      n.classList.remove("picked", "best");
    }
  }

  function paintReveal(ev) {
    clearOverlays();
    const setData = S.sets.get(S.set);
    const M = METRICS[ev.m];
    for (const c of S.pack) {
      const n = S.els.get(c.id);
      const v = val(c, ev.m);
      const g = grade(c, setData);
      const box = el("div", "score" + (v == null ? " na" : ""));
      box.append(el("div", "val", v == null ? "no data" : M.fmt(v)));
      if (g) { const gb = el("div", "grade " + gradeClass(g), g); gb.title = "Grade by GIH WR vs set average"; box.append(gb); }
      const bits = [];
      if (ev.m !== "gih" && typeof c.gih === "number") bits.push("GIH " + METRICS.gih.fmt(c.gih));
      if (ev.m !== "ata" && typeof c.ata === "number") bits.push("ATA " + c.ata.toFixed(1));
      if (ev.m === "gih" && typeof c.gih_n === "number") bits.push(c.gih_n.toLocaleString() + " games");
      const sub = el("div", "sub");
      if (ev.mode !== "pick" && S.mode === "rank" && ev.userRank?.has(c.id)) {
        const d = ev.ranks.get(c.id) - ev.userRank.get(c.id);
        const s = el("span", "delta " + (d > 0 ? "up" : d < 0 ? "down" : "ok"),
          d === 0 ? "✓ exact" : d > 0 ? `over by ${d}` : `under by ${-d}`);
        sub.append(s, document.createTextNode(bits.length ? " · " + bits[0] : ""));
      } else {
        sub.textContent = bits.join(" · ");
      }
      box.append(sub);
      n.append(box);
      const r = ev.ranks.get(c.id);
      if (r != null) {
        const t = el("div", "truerank", "#" + r);
        t.title = `17lands rank in this pack by ${M.label}`;
        n.append(t);
      }
      if (ev.best && ev.best.id === c.id) n.classList.add("best");
      if (S.mode === "pick" && S.picked === c.id) n.classList.add("picked");
    }
    D.summary.innerHTML = summaryHtml(ev);
  }

  const esc = s => String(s).replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

  function summaryHtml(ev) {
    const M = METRICS[ev.m];
    if (!ev.k) return `No ${M.label} data for any card in this pack.`;
    const best = ev.best ? `<strong>${esc(ev.best.name)}</strong> (${M.fmt(val(ev.best, ev.m))})` : "";
    if (S.mode === "pick") {
      if (!ev.pick) return `No pick made, so this pack isn't counted. Top card: ${best}.`;
      if (ev.pickRank == null) return `17Lands has no ${M.label} for ${esc(ev.pick.name)}. Top card: ${best}.`;
      if (ev.pickRank === 1) return `Correct — ${best} is the top card by ${M.label}.`;
      const gap = Math.abs(val(ev.best, ev.m) - val(ev.pick, ev.m));
      const gapTxt = ev.m === "gih" || ev.m === "iwd" ? (gap * 100).toFixed(1) + "pp" : gap.toFixed(2);
      return `Your pick was <b>#${ev.pickRank}</b> of ${ev.k}. Top: ${best}, ${gapTxt} better.`;
    }
    return `Rank correlation <b>${ev.rho != null ? ev.rho.toFixed(2) : "–"}</b> · avg miss <b>${ev.mae.toFixed(1)}</b> spots · ` +
      (ev.topRight ? `you had the top card right (${best}).` : `top card: ${best}.`);
  }

  function setHint() {
    if (!S.pack.length) { D.hint.textContent = ""; return; }
    if (S.revealed) {
      D.hint.textContent = `Pack ${S.packNo} — revealed. Gold = best by ${METRICS[S.metric].label}.`;
    } else if (S.mode === "pick") {
      D.hint.textContent = S.picked == null
        ? `Pack ${S.packNo} — click the card you'd take first (⤢ to enlarge). You can change your mind until you reveal.`
        : `Pack ${S.packNo} — pick locked in? Reveal the 17Lands scores.`;
    } else {
      D.hint.textContent = `Pack ${S.packNo} — tap cards best-to-worst, or drag to reorder. Then reveal.`;
    }
    D.reveal.hidden = S.revealed;
    D.next.classList.toggle("primary", S.revealed);
    D.next.classList.toggle("ghost", !S.revealed);
    D.resetRank.hidden = S.mode !== "rank" || S.revealed;
    D.resetRank.disabled = S.tapped.size === 0;
  }

  function setMeta() {
    const d = S.sets.get(S.set);
    if (!d) { D.meta.textContent = ""; return; }
    const when = d.fetched ? new Date(d.fetched).toLocaleDateString() : "unknown";
    const rated = d.cards.filter(c => typeof c.gih === "number").length;
    D.meta.textContent = `${S.set} · ${rated}/${d.cards.length} cards with 17Lands data · snapshot ${when}`;
  }

  // ---------- interactions ----------
  function onCardClick(id) {
    if (S.revealed) { openZoom(S.pack.find(c => c.id === id)); return; }
    if (S.mode === "pick") {
      // select (or switch) the pick; clicking the selected card again clears it
      S.picked = S.picked === id ? null : id;
      for (const [cid, n] of S.els) n.classList.toggle("picked", cid === S.picked);
      setHint();
      return;
    }
    // rank mode: tap moves a card to just after the last placed card;
    // tapping a placed card un-places it (it drops to just after the placed block).
    const wasPlaced = S.tapped.has(id);
    S.order.splice(S.order.indexOf(id), 1);
    if (wasPlaced) S.tapped.delete(id);
    S.order.splice(placedEnd(), 0, id);
    if (!wasPlaced) S.tapped.add(id);
    layout();
    setHint();
  }

  function placedEnd() {
    let last = -1;
    S.order.forEach((x, i) => { if (S.tapped.has(x)) last = i; });
    return last + 1;
  }

  function reveal() {
    if (S.revealed || !S.pack.length) return;
    S.revealed = true;
    if (S.sortable) S.sortable.option("disabled", true);
    const ev = evaluate();
    ev.mode = S.mode;
    if (S.mode === "rank" || ev.pick) record(ev);
    paintReveal(ev);
    setHint();
    D.next.focus({ preventScroll: true });
  }

  function repaintRevealForMetric() {
    // metric changed after reveal: re-score this pack visually, don't re-record
    if (!S.revealed) return;
    const ev = evaluate();
    ev.mode = S.mode;
    paintReveal(ev);
    setHint();
  }

  async function newPack() {
    if (!S.set) return;
    let d;
    try { d = await loadSet(S.set); }
    catch (e) { showEmpty(`Couldn't load data for ${esc(S.set)} (${esc(e.message)}).`); return; }
    D.empty.hidden = true;
    S.pack = makePack(d.cards);
    S.order = S.pack.map(c => c.id);
    S.tapped = new Set();
    S.picked = null;
    S.revealed = false;
    S.packNo++;
    S.els = new Map(S.pack.map(c => [c.id, cardEl(c)]));
    D.pack.replaceChildren();
    layout();
    setupSortable();
    D.summary.textContent = "";
    setHint();
    setMeta();
    prefetchNext(d);
  }

  // Warm the image cache with a few likely-next cards so the next pack pops in fast.
  let prefetched = 0;
  function prefetchNext(d) {
    if (prefetched > 400) return;
    const rated = d.cards.filter(c => c.img);
    for (const c of sample(rated, 14)) { const i = new Image(); i.src = c.img; prefetched++; }
  }

  function setupSortable() {
    if (S.sortable) { S.sortable.destroy(); S.sortable = null; }
    if (S.mode !== "rank" || typeof Sortable === "undefined") return;
    S.sortable = Sortable.create(D.pack, {
      animation: 150,
      delay: 140,
      delayOnTouchOnly: true,
      filter: ".zoom-btn",
      preventOnFilter: false,
      onEnd: evt => {
        S.order = [...D.pack.children].map(n => +n.dataset.id);
        // dropping a card into (or before) the placed block counts as placing it
        const id = +evt.item.dataset.id;
        if (!S.tapped.has(id) && evt.newIndex < placedEnd()) S.tapped.add(id);
        paintBadges();
        setHint();
      },
    });
  }

  function setMode(mode) {
    S.mode = mode;
    D.seg.forEach(b => b.setAttribute("aria-checked", String(b.dataset.mode === mode)));
    savePrefs();
    if (S.pack.length && !S.revealed) {
      S.tapped = new Set();
      S.picked = null;
      for (const n of S.els.values()) n.classList.remove("picked");
      setupSortable();
      layout();
      setHint();
    } else if (S.pack.length) {
      newPack();
    }
  }

  function openZoom(c) {
    D.zoomBody.replaceChildren();
    for (const src of [c.img, c.img_back].filter(Boolean)) {
      const i = new Image();
      i.alt = c.name;
      i.src = src.replace("/normal/", "/large/");
      i.onerror = () => { i.onerror = null; i.src = src; };
      D.zoomBody.append(i);
    }
    if (!D.zoomBody.children.length) D.zoomBody.append(el("p", null, c.name));
    D.zoom.showModal();
  }
  D.zoom.addEventListener("click", e => { if (e.target === D.zoom || e.target.tagName === "IMG") D.zoom.close(); });

  // ---------- progress view ----------
  function renderStats() {
    const h = store.get(HISTORY_KEY, []);
    const scope = h.filter(e => e.set === S.set && e.metric === S.metric);
    const picks = scope.filter(e => e.mode === "pick" && e.pickRank != null);
    const ranks = scope.filter(e => e.mode === "rank" && e.rho != null);
    const recent = arr => arr.slice(-25);
    const avg = (arr, f) => arr.length ? arr.reduce((a, e) => a + f(e), 0) / arr.length : null;
    const fmt = (v, d = 2) => v == null ? "–" : v.toFixed(d);

    const agg = new Map();
    for (const e of scope) for (const [name, d] of e.d || []) {
      const a = agg.get(name) || { n: 0, sum: 0 };
      a.n++; a.sum += d; agg.set(name, a);
    }
    const rows = [...agg].filter(([, a]) => a.n >= MIN_SEEN_FOR_LIST).map(([name, a]) => ({ name, n: a.n, mean: a.sum / a.n }));
    const over = rows.filter(r => r.mean > 0).sort((a, b) => b.mean - a.mean || b.n - a.n).slice(0, 12);
    const under = rows.filter(r => r.mean < 0).sort((a, b) => a.mean - b.mean || b.n - a.n).slice(0, 12);
    const table = (list, label) => list.length
      ? `<table><thead><tr><th>Card</th><th class="num">Seen</th><th class="num">${label}</th></tr></thead><tbody>${
          list.map(r => `<tr><td>${esc(r.name)}</td><td class="num">${r.n}</td><td class="num">${Math.abs(r.mean).toFixed(1)}</td></tr>`).join("")
        }</tbody></table>`
      : `<p class="note">Not enough data yet — a card needs to come up ${MIN_SEEN_FOR_LIST}+ times.</p>`;

    D.statsBody.innerHTML = `
      <p class="muted" style="margin-top:0">${esc(S.set)} · scored by ${METRICS[S.metric].label}. Switch set or metric to see other slices.</p>
      <div class="tiles">
        <div class="tile"><b>${scope.length}</b><span>packs graded</span></div>
        <div class="tile"><b>${picks.length ? Math.round(100 * picks.filter(e => e.pickRank === 1).length / picks.length) + "%" : "–"}</b><span>top pick correct</span></div>
        <div class="tile"><b>${fmt(avg(recent(picks), e => e.pickRank), 1)}</b><span>avg pick rank (last 25)</span></div>
        <div class="tile"><b>${fmt(avg(recent(ranks), e => e.rho))}</b><span>avg rank correlation (last 25)</span></div>
      </div>
      <div class="cols">
        <div><h3>You overrate</h3>${table(over, "Spots high")}</div>
        <div><h3>You underrate</h3>${table(under, "Spots low")}</div>
      </div>
      <p class="note">"Spots high" = on average you placed the card that many positions above where 17lands has it within the same pack. Pick mode counts the card you took and the best card you passed.</p>
      <div class="stats-foot">
        <span class="muted">${h.length} packs recorded on this device across all sets.</span>
        <span>
          <button type="button" class="ghost" id="exportHist">Export JSON</button>
          <button type="button" class="ghost" id="clearHist">Clear history</button>
        </span>
      </div>`;
    $("#clearHist").onclick = () => {
      if (confirm("Delete all recorded packs on this device?")) { store.set(HISTORY_KEY, []); renderStats(); }
    };
    $("#exportHist").onclick = () => {
      const blob = new Blob([JSON.stringify(h)], { type: "application/json" });
      const a = el("a");
      a.href = URL.createObjectURL(blob);
      a.download = `p1p1-history-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
  }
  D.statsBtn.addEventListener("click", () => { renderStats(); D.stats.showModal(); });

  function showEmpty(html) {
    D.pack.replaceChildren();
    D.empty.innerHTML = html;
    D.empty.hidden = false;
    D.hint.textContent = "";
  }

  // ---------- wiring ----------
  D.next.addEventListener("click", newPack);
  D.reveal.addEventListener("click", reveal);
  D.resetRank.addEventListener("click", () => { S.tapped = new Set(); paintBadges(); setHint(); });
  D.seg.forEach(b => b.addEventListener("click", () => setMode(b.dataset.mode)));
  D.metric.addEventListener("change", () => { S.metric = D.metric.value; savePrefs(); repaintRevealForMetric(); });
  D.set.addEventListener("change", () => { S.set = D.set.value; savePrefs(); S.packNo = 0; newPack(); });

  document.addEventListener("keydown", e => {
    if (e.target.closest("select, input, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector("dialog[open]")) return;
    if (e.key === "n" || e.key === "N") { e.preventDefault(); newPack(); }
    else if (e.key === "Enter" && !S.revealed) { e.preventDefault(); reveal(); }
    else if (e.key === "Enter" && S.revealed) { e.preventDefault(); newPack(); }
    else if (e.key === "s" || e.key === "S") { renderStats(); D.stats.showModal(); }
  });

  async function init() {
    const prefs = store.get(PREFS_KEY, {});
    S.metric = METRICS[prefs.metric] ? prefs.metric : "gih";
    D.metric.value = S.metric;
    D.seg.forEach(b => b.setAttribute("aria-checked", String(b.dataset.mode === (prefs.mode || "pick"))));
    S.mode = prefs.mode === "rank" ? "rank" : "pick";

    try { S.manifest = await loadManifest(); }
    catch {
      showEmpty(`<h2>No card data yet</h2>
        <p>This app reads snapshots from <code>data/</code>. Run <code>python scripts/fetch_17lands.py</code>
        locally, or trigger the <b>Refresh 17lands data</b> GitHub Action, then redeploy.</p>`);
      return;
    }
    const sets = S.manifest.sets || [];
    if (!sets.length) { showEmpty("<p>The data manifest lists no sets.</p>"); return; }
    for (const s of sets) {
      const o = el("option", null, `${s.name && s.name !== s.code ? s.name + " (" + s.code + ")" : s.code}${s.live ? " · live" : ""}`);
      o.value = s.code;
      D.set.append(o);
    }
    S.set = sets.some(s => s.code === prefs.set) ? prefs.set : sets[0].code;
    D.set.value = S.set;
    await newPack();
  }

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
  init();
})();
