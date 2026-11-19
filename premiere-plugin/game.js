// Ripple Sync: a small match-3 game for waiting while a sync runs (the hidden link under the
// progress bar). A timeline of audio clips: swap two neighbouring clips so that 3 or more with the
// same sound (same colour and waveform) line up along a track or across tracks. They're synced and
// ripple-deleted: the rest of the track slides left and new clips arrive from the right.
// Plain DOM (no canvas). Click a clip then a neighbour, or drag a clip onto a neighbour: the clip
// follows the pointer and the neighbour slides the other way. Animations move the clips with
// relative left/top in small timer steps (no CSS transforms or transitions, which UXP may not draw).
(function (root) {
  "use strict";
  const ROWS = 6, COLS = 7;
  const KINDS = [                               // colour + waveform (bar heights 1-9)
    { name: "Dialogue",  color: "#8f6fd8", wave: [2, 6, 9, 4, 8, 3, 6] },
    { name: "Room tone", color: "#3fb7a6", wave: [5, 6, 5, 6, 5, 6, 5] },
    { name: "Clap",      color: "#e0a03a", wave: [1, 9, 2, 1, 1, 9, 2] },
    { name: "Music",     color: "#d65b7a", wave: [3, 5, 7, 9, 7, 5, 3] },
    { name: "Footsteps", color: "#4a8fe0", wave: [8, 1, 1, 8, 1, 1, 8] },
    { name: "Birdsong",  color: "#7fbf4a", wave: [2, 8, 3, 9, 2, 7, 3] },
  ];

  // ---- rules (pure, tested in Node) ----
  function makeRng(seed) { let s = (seed >>> 0) || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
  const pick = (rnd) => Math.floor(rnd() * KINDS.length);
  function findMatches(b) {                     // Set of "r,c" in a run of 3+ along a track or across tracks
    const hit = new Set();
    for (let r = 0; r < b.length; r++) {
      for (let c = 0; c < b[r].length;) {
        let e = c; while (e + 1 < b[r].length && b[r][e + 1] === b[r][c]) e++;
        if (e - c >= 2) for (let k = c; k <= e; k++) hit.add(r + "," + k);
        c = e + 1;
      }
    }
    for (let c = 0; c < b[0].length; c++) {
      for (let r = 0; r < b.length;) {
        let e = r; while (e + 1 < b.length && b[e + 1][c] === b[r][c]) e++;
        if (e - r >= 2) for (let k = r; k <= e; k++) hit.add(k + "," + c);
        r = e + 1;
      }
    }
    return hit;
  }
  function swap(b, a, z) { const t = b[a[0]][a[1]]; b[a[0]][a[1]] = b[z[0]][z[1]]; b[z[0]][z[1]] = t; }
  const neighbours = (a, z) => Math.abs(a[0] - z[0]) + Math.abs(a[1] - z[1]) === 1;
  function ripple(b, hit, rnd) {                // ripple delete: each track closes up to the left
    for (let r = 0; r < b.length; r++) {
      const keep = b[r].filter((_, c) => !hit.has(r + "," + c));
      while (keep.length < b[r].length) keep.push(pick(rnd));
      b[r] = keep;
    }
  }
  function hasMove(b) {
    for (let r = 0; r < b.length; r++) {
      for (let c = 0; c < b[r].length; c++) {
        for (const [dr, dc] of [[0, 1], [1, 0]]) {
          const z = [r + dr, c + dc];
          if (z[0] >= b.length || z[1] >= b[r].length) continue;
          swap(b, [r, c], z);
          const ok = findMatches(b).size > 0;
          swap(b, [r, c], z);
          if (ok) return true;
        }
      }
    }
    return false;
  }
  function newBoard(rnd, rows = ROWS, cols = COLS) {   // no matches at the start, at least one move
    for (;;) {
      const b = [];
      for (let r = 0; r < rows; r++) {
        b.push([]);
        for (let c = 0; c < cols; c++) {
          let k;
          do { k = pick(rnd); } while ((c >= 2 && b[r][c - 1] === k && b[r][c - 2] === k) || (r >= 2 && b[r - 1][c] === k && b[r - 2][c] === k));
          b[r].push(k);
        }
      }
      if (hasMove(b)) return b;
    }
  }
  // One move: swap, then sync + ripple until nothing matches. Returns null if the swap matches
  // nothing (it's undone), else { synced, steps: [boards after each ripple], combos }.
  function play(b, a, z, rnd) {
    if (!neighbours(a, z)) return null;
    swap(b, a, z);
    let hit = findMatches(b);
    if (!hit.size) { swap(b, a, z); return null; }
    let synced = 0, combos = 0;
    const steps = [];
    while (hit.size) {
      steps.push({ hit: new Set(hit), before: b.map((row) => row.slice()) });
      synced += hit.size; combos++;
      ripple(b, hit, rnd);
      hit = findMatches(b);
    }
    let shuffled = false;
    if (!hasMove(b)) { const nb = newBoard(rnd, b.length, b[0].length); for (let r = 0; r < b.length; r++) b[r] = nb[r]; shuffled = true; }
    return { synced, combos, steps, shuffled };
  }
  // level 1: 50 clips in 12 moves (a careful player wins about 3 times in 4), then 10 more per level
  const levelGoal = (n) => ({ goal: 40 + 10 * n, moves: 12 });

  // ---- the panel view ----
  function open(box, opts) {
    opts = opts || {};
    const rnd = makeRng(Date.now());
    let level = 1, b = newBoard(rnd), sel = null, synced = 0, moves = levelGoal(1).moves, locked = false, over = false;
    box.innerHTML = "";
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
    const head = el("div", "rs-head");
    const title = el("div", "rs-title", "Ripple Sync");
    const stats = el("div", "rs-stats");
    head.appendChild(title); head.appendChild(stats);
    const tl = el("div", "rs-timeline");
    const msg = el("div", "rs-msg", "Swap two neighbouring clips. Line up 3 with the same sound, along a track or across tracks, and they sync.");
    const foot = el("div", "rs-foot");
    const again = el("a", "small", "New game"); again.href = "#";
    const back = el("a", "small", "Back to SlingSync"); back.href = "#";
    foot.appendChild(again); foot.appendChild(back);
    box.appendChild(head); box.appendChild(tl); box.appendChild(msg); box.appendChild(foot);

    function cellView(k, r, c, flash) {
      const cell = el("div", "rs-clip" + (flash ? " rs-flash" : "") + (sel && sel[0] === r && sel[1] === c ? " rs-sel" : ""));
      cell.style.backgroundColor = KINDS[k].color;
      for (const h of KINDS[k].wave) { const bar = el("div", "rs-bar"); bar.style.height = (h * 2) + "px"; cell.appendChild(bar); }
      cell.addEventListener("click", () => { if (justDragged) { justDragged = false; return; } onClick(r, c); });
      // drag: press on a clip and move toward a neighbour (mouse and pointer events, whichever UXP sends)
      const down = (ev) => { if (locked || over || drag) return; drag = { r, c, x: ev.clientX, y: ev.clientY, moving: false, to: null, f: 0 }; };
      cell.addEventListener("pointerdown", down);
      cell.addEventListener("mousedown", down);
      return cell;
    }
    function draw(board, flash) {
      const g = levelGoal(level);
      stats.textContent = `Level ${level} · synced ${Math.min(synced, g.goal)}/${g.goal} · ${moves} moves`;
      tl.innerHTML = "";
      cells = []; grid = null;
      for (let r = 0; r < board.length; r++) {
        const row = el("div", "rs-track");
        row.appendChild(el("div", "rs-label", "A" + (r + 1)));
        cells.push([]);
        for (let c = 0; c < board[r].length; c++) {
          const cell = cellView(board[r][c], r, c, flash && flash.has(r + "," + c));
          cells[r].push(cell); row.appendChild(cell);
        }
        tl.appendChild(row);
      }
    }
    // ---- clip movement ----
    let cells = [], grid = null;
    function measure() {                        // distance between neighbouring clips, measured while nothing is offset
      if (!grid) {
        let x = 0, y = 0;
        try {
          const a = cells[0][0].getBoundingClientRect(), bx = cells[0][1].getBoundingClientRect(), by = cells[1][0].getBoundingClientRect();
          x = bx.left - a.left; y = by.top - a.top;
        } catch (e) { /* use the fallback below */ }
        grid = { x: x > 4 ? x : 36, y: y > 4 ? y : 35 };
      }
      return grid;
    }
    const setOff = (e, x, y) => { e.style.left = Math.round(x) + "px"; e.style.top = Math.round(y) + "px"; };
    const step = (a, z) => { const g = measure(); return [(z[1] - a[1]) * g.x, (z[0] - a[0]) * g.y]; };
    function place(a, z, f) {                   // f = 0: in place, 1: fully swapped
      const [px, py] = step(a, z), ea = cells[a[0]][a[1]], ez = cells[z[0]][z[1]];
      ea.style.zIndex = "2"; setOff(ea, px * f, py * f); setOff(ez, -px * f, -py * f);
    }
    function tween(ms, fn) {                    // eased 0..1 in ~60 fps timer steps
      return new Promise((res) => {
        const t0 = Date.now();
        const tick = () => { const t = Math.min(1, (Date.now() - t0) / ms); fn(1 - (1 - t) * (1 - t)); if (t < 1) setTimeout(tick, 16); else res(); };
        tick();
      });
    }
    const slide = (a, z, from, to, ms) => tween(ms, (k) => place(a, z, from + (to - from) * k));
    const wouldMatch = (a, z) => { const t = b.map((row) => row.slice()); swap(t, a, z); return findMatches(t).size > 0; };
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    let drag = null, justDragged = false;
    const move = (ev) => {                      // the clip follows the pointer, the neighbour slides the other way
      if (!drag || locked || over) return;
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (!drag.moving && Math.max(Math.abs(dx), Math.abs(dy)) < 6) return;   // still a click
      if (!drag.moving) { drag.moving = true; measure(); if (sel) { sel = null; } }
      const horiz = Math.abs(dx) >= Math.abs(dy), d = horiz ? dx : dy, dir = d < 0 ? -1 : 1;
      const from = [drag.r, drag.c], to = horiz ? [drag.r, drag.c + dir] : [drag.r + dir, drag.c];
      if (drag.to && (drag.to[0] !== to[0] || drag.to[1] !== to[1])) setOff(cells[drag.to[0]][drag.to[1]], 0, 0);
      const g = measure(), p = horiz ? g.x : g.y;
      if (to[0] < 0 || to[0] >= b.length || to[1] < 0 || to[1] >= b[0].length) {   // edge of the timeline: a little give, no swap
        const o = Math.max(-0.2, Math.min(0.2, d / p)) * p;
        drag.to = null; drag.f = 0; setOff(cells[from[0]][from[1]], horiz ? o : 0, horiz ? 0 : o);
        return;
      }
      drag.to = to; drag.f = Math.min(1, Math.abs(d) / p);
      place(from, to, drag.f);
    };
    const up = async () => {                    // let go: past a third of the way swaps, otherwise it slides back
      if (!drag) return;
      const d = drag; drag = null;
      if (!d.moving) return;
      justDragged = true; setTimeout(() => { justDragged = false; }, 400);
      const from = [d.r, d.c];
      if (d.to && d.f >= 0.33) { await doMove(from, d.to, d.f); return; }
      locked = true;
      if (d.to) await slide(from, d.to, d.f, 0, 120);
      locked = false;
      draw(b);
    };
    for (const t of ["pointermove", "mousemove"]) tl.addEventListener(t, move);
    for (const t of ["pointerup", "mouseup", "mouseleave", "pointerleave"]) tl.addEventListener(t, up);
    async function onClick(r, c) {
      if (locked || over) return;
      if (!sel) { sel = [r, c]; draw(b); return; }
      if (sel[0] === r && sel[1] === c) { sel = null; draw(b); return; }
      if (!neighbours(sel, [r, c])) { sel = [r, c]; draw(b); return; }
      const a = sel; sel = null;
      draw(b);                                  // clear the highlight before the clips move
      await doMove(a, [r, c]);
    }
    async function doMove(a, z, f0 = 0) {       // f0: how far a drag already moved the clips (0..1)
      locked = true;
      if (!wouldMatch(a, z)) {                  // slide over, then back: they don't match
        await slide(a, z, f0, 1, Math.round(150 * (1 - f0)) + 30);
        await slide(a, z, 1, 0, 180);
        msg.textContent = "Out of sync: those don't line up 3 of a kind.";
        locked = false; draw(b); return;
      }
      await slide(a, z, f0, 1, Math.round(150 * (1 - f0)) + 30);
      const res = play(b, a, z, rnd);
      moves--;
      for (const st of res.steps) { draw(st.before, st.hit); await wait(260); }
      synced += res.synced;
      msg.textContent = res.combos > 1 ? `Ripple combo ×${res.combos}! ${res.synced} clips synced.` : `${res.synced} clips synced.`;
      if (res.shuffled) msg.textContent += " No moves left, so the timeline was reshuffled.";
      draw(b);
      locked = false;
      const g = levelGoal(level);
      if (synced >= g.goal) {
        over = true;
        msg.textContent = `Level ${level} locked! ${synced} clips synced with ${moves} moves to spare.`;
        if (opts.onWin) opts.onWin(level);
        const next = el("a", "small", ` Next level →`); next.href = "#";
        next.addEventListener("click", (ev) => { ev.preventDefault(); level++; synced = 0; moves = levelGoal(level).moves; over = false; b = newBoard(rnd); msg.textContent = `Level ${level}: sync ${levelGoal(level).goal} clips in ${moves} moves.`; draw(b); });
        msg.appendChild(next);
      } else if (moves <= 0) {
        over = true;
        msg.textContent = `Out of moves: ${synced}/${g.goal} synced. Click New game to try again.`;
      }
    }
    again.addEventListener("click", (ev) => { ev.preventDefault(); level = 1; synced = 0; moves = levelGoal(1).moves; over = false; sel = null; b = newBoard(rnd); msg.textContent = "New timeline. Line up 3 clips with the same sound."; draw(b); });
    back.addEventListener("click", (ev) => { ev.preventDefault(); if (opts.onClose) opts.onClose(); });
    draw(b);
  }

  const api = { KINDS, ROWS, COLS, makeRng, findMatches, swap, ripple, hasMove, newBoard, play, levelGoal, open };
  root.RippleSync = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
