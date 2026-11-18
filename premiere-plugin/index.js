// SlingSync plug-in for Premiere Pro 2027 (UXP).
// Sync a Shoot…: the plug-in's own engine (engine/*.js + wasm/ssdec, a JavaScript port of
// the desktop app's engine) syncs the folder inside Premiere, then imports the sequence.
// Import from Shoot Folder… / Import XML File…: import an existing SlingSync XML.
const ppro = require("premierepro");
const { storage, shell } = require("uxp");
const fsys = storage.localFileSystem;
const fs = require("fs");

const statusBox = document.getElementById("status");
const bar = document.getElementById("bar");
const barFill = document.getElementById("barFill");
let busy = false;

function say(text, kind) {
  statusBox.hidden = !text;
  statusBox.textContent = text;
  statusBox.className = kind || "";
}

function showBar(frac) {
  bar.hidden = frac === null;
  if (frac === null) return;
  barFill.style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + "%";
}

function setBusy(b) {
  busy = b;
  document.getElementById("syncFolder").disabled = b;
  document.getElementById("compactFolder").disabled = b;
  document.getElementById("cancel").hidden = !b;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sequenceNames(project) {
  const seqs = await project.getSequences();
  const names = [];
  for (const s of seqs) {
    try { names.push(s.name); } catch (e) { names.push("(sequence)"); }
  }
  return names;
}

async function importXml(nativePath, prefix) {
  prefix = prefix || "";
  const project = await ppro.Project.getActiveProject();
  if (!project) {
    say("Open or create a Premiere project first.", "err");
    return false;
  }
  const file = nativePath.split("/").pop();
  const ids = async () => (await project.getSequences()).map((q) => String(q.guid));
  const before = new Set(await ids());
  const root = await project.getRootItem();
  // Don't wait on importFiles itself: it can take long (or never answer) while Premiere
  // reads the media. Watch for the new sequence instead, and show how long it's taking.
  let reported, failed = null, finishedAt = null;
  project.importFiles([nativePath], true, root, false)
    .then((r) => { reported = r; finishedAt = Date.now(); })
    .catch((e) => { failed = e; finishedAt = Date.now(); });
  const t0 = Date.now();
  cancelRequested = false;
  while (true) {
    await sleep(500);

    const added = (await project.getSequences()).filter((q) => !before.has(String(q.guid)));
    if (added.length) {
      say(prefix + "Imported: " + added.map((q) => q.name).join(", ") + "\nOpen it from the Project panel.", "ok");
      return true;
    }
    if (failed) { say(prefix + "Premiere refused the import:\n" + failed, "err"); return false; }
    const secs = Math.round((Date.now() - t0) / 1000);
    if ((finishedAt && Date.now() - finishedAt > 10000) || cancelRequested || secs > 600) {
      say(prefix + (cancelRequested ? "Stopped waiting for the import." : "Premiere " +
          (reported ? "reported success" : "didn't finish the import") + " but no new sequence appeared.") +
          "\nTry File → Import… with:\n" + nativePath, "err");
      return false;
    }
    say(prefix + `Importing ${file} into Premiere… ${secs} s` + (secs >= 30
      ? "\nPremiere is still reading the media. If a Premiere window is asking something, answer it." : ""));

  }
}

// Copy text to the clipboard. UXP's own setContent takes {"text/plain": …}; writeText can
// report success without putting anything on the clipboard. Returns true or an error text.
async function copyText(text) {
  const cb = navigator.clipboard;
  let err = "no clipboard";
  for (const attempt of [() => cb.setContent({ "text/plain": text }), () => cb.writeText({ "text/plain": text }), () => cb.writeText(text)]) {
    try {
      await attempt();
      try {                                   // check it really arrived, when reading is allowed
        const got = await cb.getContent();
        if (got && got["text/plain"] !== undefined && got["text/plain"] !== text) { err = "clipboard stayed empty"; continue; }
      } catch (e) { /* can't verify: assume it worked */ }
      return true;
    } catch (e) { err = String(e && e.message ? e.message : e); }
  }
  return err;
}

// ---- the plug-in engine ----
let engine = null;
let cancelRequested = false;
const detailBox = document.getElementById("detailLog");

async function getEngine() {
  if (engine) return engine;
  const folder = await fsys.getPluginFolder();
  const wasmBytes = await fs.readFile(folder.nativePath + "/wasm/ssdec.wasm");
  const P = SlingUxpPlatform.create();
  const media = await SlingMedia.create({ factory: SSDec, wasmBytes, read: (h, size, pos) => P.readAt(h, size, pos) });
  engine = { P, media };
  return engine;
}

function panelVersion() {
  try { return "plug-in " + require("uxp").versions.plugin; } catch (e) { return "plug-in"; }
}

async function syncFolder(folderPath, folderName) {
  cancelRequested = false;
  detailBox.textContent = "";
  document.getElementById("detailsWrap").hidden = true;
  const lines = [];
  showBar(0);
  say("Starting…");
  const t0 = Date.now();
  try {
    const { P, media } = await getEngine();
    const res = await SlingRun.run(P, media, folderPath, {
      version: panelVersion(),
      stems: document.getElementById("stems").checked,
      isCancelled: () => cancelRequested,
      progress: (f, m) => { showBar(f); say("Syncing " + folderName + "…\n" + m); },
      log: (line) => lines.push(line),
    });
    detailBox.textContent = lines.join("\n");
    document.getElementById("detailsWrap").hidden = false;
    const synced = res.counts.synced || 0;
    const check = res.files - synced;
    const mins = ((Date.now() - t0) / 60000).toFixed(1);
    const summary = `${synced} of ${res.files} clips synced by sound` +
      (check ? `, ${check} to check (see SlingSync_report.txt)` : "") + ` · ${mins} min.` +
      (res.stems && res.stems.length ? `\n${res.stems.length} audio files in “${res.stems_dir.split("/").pop()}”.` : "") + "\n";
    await importXml(res.xml, summary);
  } catch (e) {
    detailBox.textContent = lines.join("\n");
    document.getElementById("detailsWrap").hidden = !lines.length && !(e && e.stack);
    if (e && e.name === "Cancelled") say("Sync cancelled. Files already analysed are saved, so syncing again is faster.");
    else say("Sync failed:\n" + (e && e.message ? e.message : e), "err");
    if (!(e && e.name === "Cancelled")) detailBox.textContent += "\n\n" + (e && e.stack ? e.stack : e);
  } finally {
    showBar(null);
  }
}

function toggle(linkId, boxId, showText, hideText) {
  const link = document.getElementById(linkId), box = document.getElementById(boxId);
  link.addEventListener("click", (ev) => {
    ev.preventDefault();
    box.hidden = !box.hidden;
    if (showText) link.textContent = box.hidden ? showText : hideText;
  });
}
toggle("detailsToggle", "detailsBox", "Show details", "Hide details");
toggle("aboutToggle", "about");

document.getElementById("copyDetails").addEventListener("click", async (ev) => {
  ev.preventDefault();
  const r = await copyText(detailBox.textContent.trim());
  document.getElementById("copyDetails").textContent = r === true ? "Copied ✓ (paste with ⌘V)" : "Couldn't copy: select the text and press ⌘C";
  setTimeout(() => { document.getElementById("copyDetails").textContent = "Copy details"; }, 4000);
});

document.getElementById("cancel").addEventListener("click", () => {
  cancelRequested = true;
  say("Stopping…");
});

async function guarded(fn) {
  if (busy) return;
  setBusy(true);
  try { await fn(); } finally { setBusy(false); }
}

document.getElementById("syncFolder").addEventListener("click", () => guarded(async () => {
  const project = await ppro.Project.getActiveProject();
  if (!project) { say("Open or create a Premiere project first.", "err"); return; }
  const folder = await fsys.getFolder();
  if (folder) await syncFolder(folder.nativePath, folder.name);
}));

// ---- Compact Timeline: close every gap where no track has a clip, in a copy of the open sequence ----
// Premiere's script objects stop working after any edit, and actions only work when created
// inside project.lockedAccess + executeTransaction. So every step gets a fresh project handle,
// looks up what it needs from it, and creates its actions inside the lock and transaction.
const TICKS = 254016000000;                    // Premiere ticks per second
const ticksOf = (t) => Number(t.ticksNumber !== undefined ? t.ticksNumber : t.ticks);
const activeProject = () => ppro.Project.getActiveProject();

// One edit: lookup(P) gathers objects from project handle P (async); make(objects) returns
// the actions, created inside the transaction from those objects.
async function edit(lookup, make, undoName) {
  const P = await activeProject();
  const objs = await lookup(P);
  // Since Premiere 26.3, actions must be created inside lockedAccess + executeTransaction,
  // or Premiere says "The script object is no longer valid".
  let ok = false, err = null;
  const run = () => {
    P.executeTransaction((ca) => {
      try { for (const a of make(objs)) ca.addAction(a); ok = true; } catch (e) { err = e; }
    }, undoName);
  };
  if (typeof P.lockedAccess === "function") P.lockedAccess(run); else run();
  if (err) throw err;
  return ok;
}
async function sequenceById(P, guid) {
  return (await P.getSequences()).find((q) => String(q.guid) === guid) || null;
}
// All clips of a sequence: [{ key, it, start, end }], key = "v2:5" (video track 2, 5th clip)
async function clipsOf(P, guid) {
  const seq = await sequenceById(P, guid);
  if (!seq) throw new Error("the copied sequence disappeared");
  const CLIP = (ppro.Constants && ppro.Constants.TrackItemType && ppro.Constants.TrackItemType.CLIP) || 1;
  const out = [];
  for (const [kind, count, get] of [["v", await seq.getVideoTrackCount(), (i) => seq.getVideoTrack(i)],
                                    ["a", await seq.getAudioTrackCount(), (i) => seq.getAudioTrack(i)]]) {
    for (let i = 0; i < count; i++) {
      const items = await (await get(i)).getTrackItems(CLIP, false);
      for (let k = 0; k < items.length; k++) {
        out.push({ key: `${kind}${i}:${k}`, it: items[k],
          start: ticksOf(await items[k].getStartTime()), end: ticksOf(await items[k].getEndTime()) });
      }
    }
  }
  return out;
}
const readClips = async (guid) => clipsOf(await activeProject(), guid);

async function compactActiveSequence(log) {
  const P0 = await activeProject();
  if (!P0) { say("Open a Premiere project first.", "err"); return; }
  const seq0 = await P0.getActiveSequence();
  if (!seq0) { say("Open the sequence you want to compact first.", "err"); return; }
  const name = seq0.name, srcGuid = String(seq0.guid);
  const before = new Set((await P0.getSequences()).map((q) => String(q.guid)));
  say("Copying “" + name + "”…");
  showBar(0);
  // 1. copy the sequence, so the original stays as it is
  log("copy: cloning " + name);
  await edit((P) => sequenceById(P, srcGuid), (sq) => [sq.createCloneAction()], "SlingSync: copy sequence");
  let guid = null;
  for (let k = 0; k < 20 && !guid; k++) {
    await sleep(150);
    const q = (await (await activeProject()).getSequences()).find((x) => !before.has(String(x.guid)));
    if (q) guid = String(q.guid);
  }
  if (!guid) { showBar(null); say("Premiere didn't make a copy of the sequence, so nothing was changed.", "err"); return; }
  log("copy: made " + guid);
  try {
    await edit(async (P) => (await sequenceById(P, guid)).getProjectItem(),
      (pi) => [pi.createSetNameAction(name + " (compact)")], "SlingSync: name copy");
    log("copy: renamed");
  } catch (e) { log("copy: rename failed (" + e + "), keeping Premiere's name"); }

  // 2. plan: blocks = stretches where at least one clip plays; each block moves left
  let clips = await readClips(guid);
  log(`plan: ${clips.length} clips`);
  if (!clips.length) { showBar(null); say("The sequence is empty.", "err"); return; }
  const order = [...clips].sort((x, y) => x.start - y.start);
  const target = new Map();
  let cursor = 0, shift = 0, blockEnd = null, blocks = 0;
  for (const x of order) {
    if (blockEnd === null || x.start > blockEnd) { shift = x.start - cursor; blockEnd = x.start; blocks++; }
    blockEnd = Math.max(blockEnd, x.end);
    cursor = blockEnd - shift;
    target.set(x.key, x.start - shift);
  }
  const fullLen = Math.max(...clips.map((x) => x.end)) / TICKS, newLen = cursor / TICKS;
  log(`plan: ${blocks} blocks, ${(fullLen / 60).toFixed(1)} min -> ${(newLen / 60).toFixed(1)} min`);
  const pendingOf = (cs) => cs.filter((x) => x.start !== target.get(x.key)).sort((x, y) => x.start - y.start);
  const moveAction = (x) => x.it.createMoveAction(ppro.TickTime.createWithTicks(String(target.get(x.key) - x.start)));
  // move the first `n` pending clips (all if n is Infinity) in one edit
  const movePending = (n) => edit((P) => clipsOf(P, guid), (cs) => pendingOf(cs).slice(0, n).map(moveAction), "SlingSync: compact");

  // 3. probe: move one clip, see whether its linked clips moved with it
  let pending = pendingOf(clips);
  if (pending.length) {
    const first = pending[0];
    await movePending(1);
    clips = await readClips(guid);
    const was = new Map(order.map((x) => [x.key, x.start]));
    const changed = clips.filter((x) => x.start !== was.get(x.key)).map((x) => x.key);
    const landed = clips.find((x) => x.key === first.key);
    log(`probe: moved ${first.key} by ${((target.get(first.key) - first.start) / TICKS).toFixed(3)} s; ` +
        `now at ${(landed.start / TICKS).toFixed(3)} (wanted ${(target.get(first.key) / TICKS).toFixed(3)}); clips that moved: ${changed.join(", ")}`);
    if (landed.start !== target.get(first.key)) {
      showBar(null);
      say("Premiere moved the clip differently than expected, so I stopped.\n“" + name +
          " (compact)” may be half done: delete it. Your original is unchanged.\nOpen Show details and send it to the developer.", "err");
      return;
    }
    pending = pendingOf(clips);
    if (changed.length === 1) {
      // 4a. clips move on their own: everything else in one edit
      log(`moving ${pending.length} clips in one edit`);
      await movePending(Infinity);
    } else {
      // 4b. linked clips move together: one clip at a time, checking positions after each
      log("linked clips move together: moving one clip at a time");
      let n = 0;
      while (pending.length && n < 5000) {
        n++;
        if (n % 5 === 0) { showBar(1 - pending.length / clips.length); say(`Compacting “${name}”… ${pending.length} clips to go`); }
        await movePending(1);
        clips = await readClips(guid);
        pending = pendingOf(clips);
      }
    }
  }
  // 5. check
  clips = await readClips(guid);
  const wrong = pendingOf(clips);
  log(`check: ${wrong.length} clips not where planned` + (wrong.length ? ": " + wrong.slice(0, 10).map((x) => x.key).join(", ") : ""));
  showBar(null);
  try { const P = await activeProject(); await P.openSequence(await sequenceById(P, guid)); } catch (e) { log("open failed: " + e); }
  const hms = (s) => { s = Math.round(s); return `${Math.floor(s / 3600)}:${String(Math.floor(s % 3600 / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
  if (wrong.length) {
    say(`Compacted copy made, but ${wrong.length} of ${clips.length} clips didn't land where planned.\n` +
        `Check “${name} (compact)” before using it (Show details has the list).`, "err");
  } else {
    say(`“${name} (compact)”: ${hms(fullLen)} → ${hms(newLen)}, ${blocks} recording blocks, no gaps.\n` +
        `Your original sequence is unchanged.`, "ok");
  }
}

document.getElementById("compactFolder").addEventListener("click", () => guarded(async () => {
  const lines = [];
  const log = (l) => lines.push(l);
  try { await compactActiveSequence(log); }
  catch (e) {
    showBar(null);
    say("Compact Timeline failed:\n" + (e && e.message ? e.message : e), "err");
    lines.push("ERROR: " + (e && e.stack ? e.stack : e));
  }
  detailBox.textContent = lines.join("\n");
  document.getElementById("detailsWrap").hidden = false;
}));

document.getElementById("fromFolder").addEventListener("click", (ev) => { ev.preventDefault(); guarded(async () => {
  try {
    const folder = await fsys.getFolder();
    if (!folder) return;
    const entries = await folder.getEntries();
    const xmls = entries.filter((e) => e.isFile && e.name.endsWith("_synced.xml"));
    if (!xmls.length) {
      say("“" + folder.name + "” hasn't been synced yet.\nUse Sync a Shoot… instead.", "err");
      return;
    }
    await importXml(xmls[0].nativePath);
  } catch (e) {
    say("Couldn't read the folder:\n" + e, "err");
  }
}); });

// ---- About ----
// Donation page: set this once the page exists (e.g. "https://ko-fi.com/<name>"); the line
// stays hidden while it's empty. Keep in sync with SUPPORT_URL in slingsync/gui.py.
const SUPPORT_URL = "https://ko-fi.com/pisdronio";
try {
  document.getElementById("aboutVersion").textContent = "version " + require("uxp").versions.plugin;
} catch (e) { /* version unknown */ }
if (SUPPORT_URL) {
  document.getElementById("supportLink").setAttribute("href", SUPPORT_URL);
  document.getElementById("supportLine").hidden = false;
}
// Links open in the user's web browser (plug-ins have no browser of their own).
for (const a of document.querySelectorAll("a.ext")) {
  a.addEventListener("click", (ev) => {
    ev.preventDefault();
    shell.openExternal(a.getAttribute("href"), "Open the SlingSync web page in your browser");
  });
}

showBar(null);
say("");
