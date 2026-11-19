// Ripple Sync: a small match-3 game for waiting while a sync runs (the hidden link under the
// progress bar). A timeline of audio clips: swap two neighbouring clips so that 3 or more with the
// same sound (same colour and waveform) line up along a track or across tracks. They're synced and
// ripple-deleted: the rest of the track slides left and new clips arrive from the right.
// Plain DOM (no canvas), click to select and click a neighbour to swap: works in UXP panels.
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
      cell.addEventListener("click", () => onClick(r, c));
      return cell;
    }
    function draw(board, flash) {
      const g = levelGoal(level);
      stats.textContent = `Level ${level} · synced ${Math.min(synced, g.goal)}/${g.goal} · ${moves} moves`;
      tl.innerHTML = "";
      for (let r = 0; r < board.length; r++) {
        const row = el("div", "rs-track");
        row.appendChild(el("div", "rs-label", "A" + (r + 1)));
        for (let c = 0; c < board[r].length; c++) row.appendChild(cellView(board[r][c], r, c, flash && flash.has(r + "," + c)));
        tl.appendChild(row);
      }
    }
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    async function onClick(r, c) {
      if (locked || over) return;
      if (!sel) { sel = [r, c]; draw(b); return; }
      if (sel[0] === r && sel[1] === c) { sel = null; draw(b); return; }
      if (!neighbours(sel, [r, c])) { sel = [r, c]; draw(b); return; }
      const a = sel; sel = null;
      const res = play(b, a, [r, c], rnd);
      if (!res) { msg.textContent = "Out of sync: those don't line up 3 of a kind."; draw(b); return; }
      locked = true; moves--;
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
