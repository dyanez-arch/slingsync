// SlingSync panel for Premiere Pro 2027 (UXP).
// Sync a Shoot…: the panel's own engine (engine/*.js + wasm/ssdec, a JavaScript port of
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

// ---- the panel engine ----
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
  try { return "panel " + require("uxp").versions.plugin; } catch (e) { return "panel"; }
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
      (check ? `, ${check} to check (see SlingSync_report.txt)` : "") + ` · ${mins} min.\n`;
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
toggle("labToggle", "lab");

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
const TICKS = 254016000000;                    // Premiere ticks per second

async function trackItemsOf(seq) {
  const CLIP = (ppro.Constants && ppro.Constants.TrackItemType && ppro.Constants.TrackItemType.CLIP) || 1;
  const items = [];
  const nv = await seq.getVideoTrackCount(), na = await seq.getAudioTrackCount();
  for (let i = 0; i < nv; i++) for (const it of await (await seq.getVideoTrack(i)).getTrackItems(CLIP, false)) items.push(it);
  for (let i = 0; i < na; i++) for (const it of await (await seq.getAudioTrack(i)).getTrackItems(CLIP, false)) items.push(it);
  return items;
}
const ticksOf = async (t) => Number((await t).ticksNumber !== undefined ? (await t).ticksNumber : (await t).ticks);

async function compactActiveSequence() {
  const project = await ppro.Project.getActiveProject();
  if (!project) { say("Open a Premiere project first.", "err"); return; }
  const seq = await project.getActiveSequence();
  if (!seq) { say("Open the sequence you want to compact first.", "err"); return; }
  const name = seq.name;
  say("Copying “" + name + "”…");
  showBar(0);
  // 1. copy the sequence, so the original stays as it is
  const before = new Set((await project.getSequences()).map((q) => String(q.guid)));
  project.executeTransaction((ca) => { ca.addAction(seq.createCloneAction()); }, "SlingSync: copy sequence");
  let copy = null;
  for (let k = 0; k < 20 && !copy; k++) {
    await sleep(150);
    copy = (await project.getSequences()).find((q) => !before.has(String(q.guid))) || null;
  }
  if (!copy) { showBar(null); say("Premiere didn't make a copy of the sequence, so nothing was changed.", "err"); return; }
  try {
    const pi = await copy.getProjectItem();
    project.executeTransaction((ca) => { ca.addAction(pi.createSetNameAction(name + " (compact)")); }, "SlingSync: name copy");
  } catch (e) { /* keep Premiere's name for the copy */ }

  // 2. where is everything? blocks = stretches where at least one clip plays
  const items = await trackItemsOf(copy);
  if (!items.length) { showBar(null); say("The sequence is empty.", "err"); return; }
  const info = [];
  for (const it of items) info.push({ it, start: await ticksOf(it.getStartTime()), end: await ticksOf(it.getEndTime()) });
  info.sort((a, b) => a.start - b.start);
  let cursor = 0, shift = 0, blockEnd = null, blocks = 0;
  for (const x of info) {
    if (blockEnd === null || x.start > blockEnd) { shift = x.start - cursor; blockEnd = x.start; blocks++; }
    blockEnd = Math.max(blockEnd, x.end);
    cursor = blockEnd - shift;
    x.target = x.start - shift;
  }
  const fullLen = Math.max(...info.map((x) => x.end)) / TICKS, newLen = cursor / TICKS;

  // 3. move clips earlier, earliest first. Linked clips may move together with their
  // partner, so each clip is checked before it's moved.
  let moved = 0, k = 0;
  for (const x of info) {
    k++;
    if (k % 10 === 0) { showBar(k / info.length); say(`Compacting “${name}”… (${k}/${info.length} clips)`); await sleep(0); }
    const now = await ticksOf(x.it.getStartTime());
    if (now === x.target) continue;
    const by = ppro.TickTime.createWithTicks(String(x.target - now));
    project.executeTransaction((ca) => { ca.addAction(x.it.createMoveAction(by)); }, "SlingSync: compact");
    moved++;
  }
  // 4. check the result
  let wrong = 0;
  for (const x of info) if (await ticksOf(x.it.getStartTime()) !== x.target) wrong++;
  showBar(null);
  try { await project.openSequence(copy); } catch (e) { /* user can open it from the Project panel */ }
  const hms = (s) => { s = Math.round(s); return `${Math.floor(s / 3600)}:${String(Math.floor(s % 3600 / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
  if (wrong) {
    say(`Compacted copy made, but ${wrong} of ${info.length} clips didn't land where expected.\nCheck “${name} (compact)” before using it.`, "err");
  } else {
    say(`“${name} (compact)”: ${hms(fullLen)} → ${hms(newLen)}, ${blocks} recording blocks, no gaps.\n` +
        `Your original sequence is unchanged.`, "ok");
  }
}

document.getElementById("compactFolder").addEventListener("click", () => guarded(async () => {
  try { await compactActiveSequence(); }
  catch (e) { showBar(null); say("Compact Timeline failed:\n" + (e && e.message ? e.message : e), "err"); }
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
// Links open in the user's web browser (panels have no browser of their own).
for (const a of document.querySelectorAll("a.ext")) {
  a.addEventListener("click", (ev) => {
    ev.preventDefault();
    shell.openExternal(a.getAttribute("href"), "Open the SlingSync web page in your browser");
  });
}

showBar(null);
say("");
