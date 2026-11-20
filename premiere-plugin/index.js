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
  document.getElementById("syncBin").disabled = b;
  document.getElementById("syncTimeline").disabled = b;
  document.getElementById("compactFolder").disabled = b;
  document.getElementById("startSync").disabled = b;
  document.getElementById("cancel").hidden = !b;
  // the waiting game: a quiet link while something runs (game.js)
  document.getElementById("gameLink").hidden = !b || !document.getElementById("game").hidden;
}
document.getElementById("gameLink").addEventListener("click", (ev) => {
  ev.preventDefault();
  const box = document.getElementById("game");
  document.getElementById("gameLink").hidden = true;
  box.hidden = false;
  RippleSync.open(box, { onClose: () => { box.hidden = true; box.innerHTML = ""; document.getElementById("gameLink").hidden = !busy; } });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sequenceNames(project) {
  const seqs = await project.getSequences();
  const names = [];
  for (const s of seqs) {
    try { names.push(s.name); } catch (e) { names.push("(sequence)"); }
  }
  return names;
}

async function importXml(nativePath, prefix, organize) {
  prefix = prefix || "";
  // Fresh project handles every time: an older handle can stop working once a new one is
  // fetched (seen with Compact Timeline).
  const P = () => ppro.Project.getActiveProject();
  if (!(await P())) {
    say("Open or create a Premiere project first.", "err");
    return false;
  }
  const file = nativePath.split("/").pop();
  // Snapshot for sorting into bins afterwards; if it fails, import without bins.
  let beforeTop = null;
  if (organize) { try { beforeTop = await topLevelKeys(); } catch (e) { organize = null; } }
  const before = new Set((await (await P()).getSequences()).map((q) => String(q.guid)));
  // Don't wait on importFiles itself: it can take long (or never answer) while Premiere
  // reads the media. Watch for the new sequence instead, and show how long it's taking.
  let reported, failed = null, finishedAt = null;
  {
    const project = await P();
    const root = await project.getRootItem();
    project.importFiles([nativePath], true, root, false)
      .then((r) => { reported = r; finishedAt = Date.now(); })
      .catch((e) => { failed = e; finishedAt = Date.now(); });
  }
  const t0 = Date.now();
  cancelRequested = false;
  while (true) {
    await sleep(500);
    const added = (await (await P()).getSequences()).filter((q) => !before.has(String(q.guid)));
    if (added.length) {
      let binNote = "";
      if (organize) {
        // let Premiere finish adding the clips before tidying them into bins
        for (let k = 0; k < 40 && !finishedAt; k++) await sleep(250);
        await sleep(1000);
        try {
          say(prefix + "Imported. Sorting the clips into bins by device…");
          binNote = "\n" + await organizeImport(beforeTop, organize.shootName, organize.deviceOf);
        } catch (e) {
          binNote = "\n(Couldn't sort the clips into device bins: " + (e && e.message ? e.message : e) + ")";
        }
      }
      say(prefix + "Imported: " + added.map((q) => q.name).join(", ") + binNote + "\nOpen it from the Project panel.", "ok");
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

// ---- Bins: after an import, one bin per shoot with a bin per device inside ----
// Uses fresh project objects for every step and creates actions inside lockedAccess +
// executeTransaction (see edit() below). Items that were in the project before the import
// are never moved.
async function binInfo(item) {                // { bin: FolderItem|null, path: string|null, seq: bool }
  try {
    const f = ppro.FolderItem.cast(item);
    if (f) { await f.getItems(); return { bin: f, path: null, seq: false }; }
  } catch (e) { /* not a bin */ }
  try {
    const c = ppro.ClipProjectItem.cast(item);
    const seq = await c.isSequence();
    return { bin: null, path: seq ? null : await c.getMediaFilePath(), seq };
  } catch (e) { return { bin: null, path: null, seq: false }; }
}
async function describe(items) {
  const out = [];
  for (const it of items) { const b = await binInfo(it); out.push({ item: it, name: it.name, ...b, key: it.name + (b.bin ? "|bin" : "|item") }); }
  return out;
}
async function topLevelKeys() {
  const P = await activeProject();
  const counts = new Map();
  for (const x of await describe(await (await P.getRootItem()).getItems())) counts.set(x.key, (counts.get(x.key) || 0) + 1);
  return counts;
}
// top-level items that weren't there before (by name, counting duplicates)
function newOnes(list, beforeKeys) {
  const left = new Map(beforeKeys);
  return list.filter((x) => { const n = left.get(x.key) || 0; if (n > 0) { left.set(x.key, n - 1); return false; } return true; });
}
async function findBin(P, names) {          // names: path of bin names from the root
  let folder = await P.getRootItem();
  for (const n of names) {
    const hit = (await describe(await folder.getItems())).find((x) => x.bin && x.name === n);
    if (!hit) return null;
    folder = hit.bin;
  }
  return folder;
}
async function clipsUnder(folder, skipBins) {  // all media clips in a bin and its sub-bins
  const out = [];
  for (const x of await describe(await folder.getItems())) {
    if (x.bin) { if (!skipBins.has(x.name)) out.push(...await clipsUnder(x.bin, new Set())); }
    else if (x.path) out.push(x);
  }
  return out;
}
const normPath = (p) => String(p || "").normalize("NFC").toLowerCase();

async function organizeImport(beforeKeys, shootName, deviceOf) {
  let P = await activeProject();
  const added = newOnes(await describe(await (await P.getRootItem()).getItems()), beforeKeys);
  if (!added.length) return "";
  // 1. one bin for the shoot: Premiere's own import bin if it made one, otherwise a new one
  let shootBin;
  if (added.length === 1 && added[0].bin) {
    shootBin = added[0].name;
    // Premiere names its bin after the XML file: rename it to the shoot, if that name is free
    const taken = new Set((await describe(await (await P.getRootItem()).getItems())).filter((x) => x.bin).map((x) => x.name));
    if (shootBin !== shootName && !taken.has(shootName)) {
      try {
        await edit(async (Q) => findBin(Q, [shootBin]), (bin) => [bin.createSetNameAction(shootName)], "SlingSync: name shoot bin");
        if (await findBin(await activeProject(), [shootName])) shootBin = shootName;
      } catch (e) { /* keep Premiere's name */ }
    }
  } else {
    const existing = new Set((await describe(await (await P.getRootItem()).getItems())).filter((x) => x.bin).map((x) => x.name));
    shootBin = shootName;
    for (let k = 2; existing.has(shootBin); k++) shootBin = `${shootName} (${k})`;
    await edit(async (Q) => Q.getRootItem(), (root) => [root.createBinAction(shootBin, false)], "SlingSync: shoot bin");
    await edit(async (Q) => {
      const root = await Q.getRootItem();
      const now = newOnes(await describe(await root.getItems()), beforeKeys).filter((x) => !(x.bin && x.name === shootBin));
      return { root, bin: await findBin(Q, [shootBin]), now };
    }, ({ root, bin, now }) => now.map((x) => root.createMoveItemAction(x.item, bin)), "SlingSync: move into shoot bin");
  }
  // 2. a bin per device inside it, and each clip into its device's bin
  const byDev = new Map();
  P = await activeProject();
  const deviceNames = new Set(deviceOf.values());
  for (const x of await clipsUnder(await findBin(P, [shootBin]), deviceNames)) {
    const dev = deviceOf.get(normPath(x.path));
    if (dev) byDev.set(dev, (byDev.get(dev) || 0) + 1);
  }
  if (!byDev.size) return `Clips are in the “${shootBin}” bin.`;
  const have = new Set((await describe(await (await findBin(P, [shootBin])).getItems())).filter((x) => x.bin).map((x) => x.name));
  const make = [...byDev.keys()].filter((d) => !have.has(d)).sort();
  if (make.length) {
    await edit(async (Q) => findBin(Q, [shootBin]), (bin) => make.map((d) => bin.createBinAction(d, false)), "SlingSync: device bins");
  }
  let moved = 0;
  await edit(async (Q) => {
    const bin = await findBin(Q, [shootBin]);
    const targets = new Map();
    for (const d of byDev.keys()) targets.set(d, await findBin(Q, [shootBin, d]));
    const items = (await clipsUnder(bin, deviceNames)).filter((x) => deviceOf.has(normPath(x.path)));
    return { bin, targets, items };
  }, ({ bin, targets, items }) => items.map((x) => {
    moved++;
    return bin.createMoveItemAction(x.item, targets.get(deviceOf.get(normPath(x.path))));
  }), "SlingSync: sort clips by device");
  return `Clips sorted into ${byDev.size} device bins in “${shootBin}” (${moved} clips).`;
}

// file path -> device name, from a sync result or by scanning the folder
function deviceMapFromResult(res) {
  const m = new Map();
  for (const c of res.clips) m.set(normPath(c.path), res.devices[c.dev]);
  return m;
}
async function deviceMapFromFolder(folderPath) {
  const { P } = await getEngine();
  const m = new Map();
  for (const d of await SlingRun.scanDevices(P, folderPath)) for (const f of d.files) m.set(normPath(f), d.name);
  return m;
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

// job (optional, for Premiere bins): { devices, outDir } → devices come from the bin and the
// XML, report and saved analysis go to outDir (a SlingSync folder next to the project file)
async function syncFolder(folderPath, folderName, settings, job) {
  settings = settings || {};
  job = job || {};
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
      refChannels: settings.refChannels || {},
      fps: settings.fps || null,
      keepSilent: !!settings.keepSilent,
      skipSilentClips: !!settings.skipSilentClips,
      clearCache: !!settings.clearCache,
      stems: !!settings.stems,
      ...(job.devices ? {
        devices: job.devices, name: folderName,
        output: job.outDir + "/" + folderName + "_synced.xml",
        reportPath: job.outDir + "/" + folderName + "_SlingSync_report.txt",
        cacheDir: job.outDir + "/.slingsync_cache",
        stemsDir: job.outDir + "/" + folderName + "_audio",
      } : {}),
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
      (check ? `, ${check} to check (see ${res.report.split("/").pop()})` : "") + ` · ${mins} min.` +
      (res.stems && res.stems.length ? `\n${res.stems.length} audio files in “${res.stems_dir.split("/").pop()}”.` : "") + "\n";
    if (job.devices) {
      // Build the sequence from the project's own clips (no XML import, no duplicate clips);
      // if Premiere won't cooperate, fall back to importing the XML.
      try {
        say(summary + "Building the sequence from your clips…");
        const note = await buildFromBin(res, folderName, (l) => lines.push(l));
        detailBox.textContent = lines.join("\n");
        say(summary + note, "ok");
        return;
      } catch (e) {
        lines.push("Building from the bin's clips failed (" + (e && e.message ? e.message : e) + "): importing the XML instead");
        detailBox.textContent = lines.join("\n");
      }
    }
    await importXml(res.xml, summary, { shootName: job.devices ? folderName + " (synced)" : folderName, deviceOf: deviceMapFromResult(res) });
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
toggle("optionsToggle", "options", "Options", "Hide options");
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
  try {
    await fn();
  } catch (e) {                                 // never fail silently: show what went wrong
    showBar(null);
    say("Something went wrong:\n" + (e && e.message ? e.message : e), "err");
    detailBox.textContent = (detailBox.textContent ? detailBox.textContent + "\n\n" : "") + (e && e.stack ? e.stack : e);
    document.getElementById("detailsWrap").hidden = false;
  } finally {
    setBusy(false);
  }
}

// ---- Sync a Shoot: 1. pick folder → show devices and settings, 2. Sync ----
// Same choices as the desktop app (gui.FPS_CHOICES, AUTO_CH, the option checkboxes).
const FPS_CHOICES = [["Match first camera", null], ["23.976", 24000 / 1001], ["24", 24], ["25", 25],
  ["29.97", 30000 / 1001], ["30", 30], ["50", 50], ["59.94", 60000 / 1001], ["60", 60]];
const AUTO_CH = "All live channels (recommended)";
let pending = null;                           // { path, name, devs } waiting for Sync

// Menus: Premiere's plug-in system doesn't support <select> properly (blank, ignores the
// choice), so menus are Spectrum pickers. Each choice is remembered when it's made (change
// event); picker.selectedIndex is the fallback. Item 0 is preselected.
const choice = {};                            // picker id -> chosen item index
function makePicker(id, labels, title) {
  // Built as markup in one go, like Adobe's examples. The placeholder shows the default label
  // even if Premiere draws no selected item; selectedIndex is set again once it's on screen.
  const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const box = document.createElement("div");
  box.innerHTML = `<sp-picker size="s" id="${esc(id)}" placeholder="${esc(labels[0])}"` +
    (title ? ` title="${esc(title)}"` : "") + `><sp-menu slot="options">` +
    labels.map((l, i) => `<sp-menu-item${i === 0 ? " selected" : ""}>${esc(l)}</sp-menu-item>`).join("") +
    `</sp-menu></sp-picker>`;
  const picker = box.firstElementChild || box.firstChild;
  choice[id] = 0;
  picker.addEventListener("change", (ev) => {
    const i = (ev && ev.target && typeof ev.target.selectedIndex === "number") ? ev.target.selectedIndex : picker.selectedIndex;
    if (typeof i === "number" && i >= 0) choice[id] = i;
  });
  setTimeout(() => { try { if (!(picker.selectedIndex >= 0)) picker.selectedIndex = 0; } catch (e) { /* label stays */ } }, 0);
  return picker;
}
function chosen(id) {
  const picker = document.getElementById(id);
  const i = picker && typeof picker.selectedIndex === "number" && picker.selectedIndex >= 0 ? picker.selectedIndex : choice[id];
  return typeof i === "number" && i >= 0 ? i : 0;
}

document.getElementById("fpsBox").appendChild(makePicker("fps", FPS_CHOICES.map(([label]) => label)));

function showSetup(show) {
  document.getElementById("setup").hidden = !show;
  document.getElementById("syncFolder").hidden = show;
  document.getElementById("syncBin").hidden = show;
  document.getElementById("syncTimeline").hidden = show;
  document.getElementById("compactFolder").hidden = show;
}

function renderDevices(devs) {
  const list = document.getElementById("devList");
  list.textContent = "";
  devs.forEach((d, k) => {
    const row = document.createElement("div"); row.className = "dev";
    const name = document.createElement("div"); name.className = "name";
    name.textContent = d.name;
    const count = document.createElement("div"); count.className = "count";
    const n = d.files.length;
    count.textContent = `${n} ${d.camera ? (n === 1 ? "clip" : "clips") : (n === 1 ? "file" : "files")}` +
      (d.channels ? ` · ${d.channels} ch` : "") +
      (d.proxies_used ? ` · ${d.proxies_used} ${d.proxies_used === 1 ? "proxy" : "proxies"}` : "") +
      (d.skipped_proxies ? ` · ${d.skipped_proxies} ${d.skipped_proxies === 1 ? "proxy" : "proxies"} skipped` : "");
    name.appendChild(document.createElement("br")); name.appendChild(count);
    const labels = [d.channels ? AUTO_CH : "No audio"];
    for (let ch = 1; ch <= d.channels; ch++) labels.push(`Only channel ${ch}`);
    const sel = makePicker("ch" + k, labels, "Which audio to sync this device with. All live channels is usually the most reliable.");
    row.appendChild(name); row.appendChild(sel);
    list.appendChild(row);
  });
}

function readSettings(devs) {
  const refChannels = {};
  devs.forEach((d, k) => { const v = chosen("ch" + k); if (v > 0 && v <= d.channels) refChannels[d.name] = v; });
  const f = FPS_CHOICES[chosen("fps")] || FPS_CHOICES[0];
  return {
    refChannels,
    fps: f[1],
    keepSilent: !document.getElementById("dropDead").checked,
    skipSilentClips: document.getElementById("dropEach").checked,
    clearCache: document.getElementById("fresh").checked,
    stems: document.getElementById("stems").checked,
  };
}

document.getElementById("syncFolder").addEventListener("click", () => guarded(async () => {
  const project = await ppro.Project.getActiveProject();
  if (!project) { say("Open or create a Premiere project first.", "err"); return; }
  const folder = await fsys.getFolder();
  if (!folder) return;
  document.getElementById("detailsWrap").hidden = true;
  say("Looking at “" + folder.name + "”…");
  try {
    const { P, media } = await getEngine();
    const devs = await SlingRun.scanWithChannels(P, media, folder.nativePath);
    if (!devs.length) { say("No video or audio files found in “" + folder.name + "”.", "err"); return; }
    pending = { path: folder.nativePath, name: folder.name, devs };
    const total = devs.reduce((n, d) => n + d.files.length, 0);
    document.getElementById("setupTitle").textContent = `${folder.name}: ${total} files from ${devs.length} devices`;
    renderDevices(devs);
    say("");
    showSetup(true);
  } catch (e) {
    say("Couldn't read the folder:\n" + (e && e.message ? e.message : e), "err");
  }
}));

document.getElementById("startSync").addEventListener("click", () => guarded(async () => {
  if (!pending) return;
  const job = pending, settings = readSettings(job.devs);
  pending = null;
  showSetup(false);
  await syncFolder(job.path, job.name, settings, job.bin ? { devices: job.devs, outDir: job.outDir } : null);
}));

// ---- Sync Selected Bin: devices from Premiere bins instead of folders ----
// Select the shoot's bin in the Project panel: each sub-bin is a camera or recorder (clips in
// nested bins count for it). A bin with only clips: devices are guessed from file names, like
// loose files in a folder.
function commonDir(paths) {
  const parts = paths.map((p) => p.split("/").slice(0, -1));
  let n = parts.length ? parts[0].length : 0;
  for (const q of parts) { let i = 0; while (i < n && i < q.length && q[i] === parts[0][i]) i++; n = i; }
  return parts.length ? parts[0].slice(0, n).join("/") || "/" : "/";
}
async function devicesFromSelectedBin() {
  const P = await activeProject();
  if (!P) throw new Error("Open a Premiere project first.");
  if (!P.path) throw new Error("Save the Premiere project first: SlingSync keeps its files next to the project file.");
  const sel = await ppro.ProjectUtils.getSelection(P);
  const picked = (await describe(await sel.getItems())).filter((x) => x.bin);
  if (!picked.length) throw new Error("In the Project panel, select the shoot's bin first (one sub-bin per camera or recorder), then click Sync Selected Bin.");
  const shoot = picked[0];
  const isMedia = (p) => p && SlingCore.isMedia(p.split("/").pop());
  const inside = await describe(await shoot.bin.getItems());
  const devs = [];
  for (const sub of inside.filter((x) => x.bin).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const files = [...new Set((await clipsUnder(sub.bin, new Set())).map((c) => c.path).filter(isMedia))].sort();
    if (files.length) devs.push(SlingCore.deviceEntry(sub.name, files));
  }
  const loose = [...new Set(inside.filter((x) => !x.bin).map((x) => x.path).filter(isMedia))].sort();
  let note = "";
  if (!devs.length) {
    const groups = new Map();
    for (const f of loose) { const k = SlingCore.looseDevice(f); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(f); }
    for (const k of [...groups.keys()].sort()) devs.push(SlingCore.deviceEntry(k, groups.get(k)));
    if (devs.length) note = "No sub-bins, so devices were guessed from file names: check the list.";
  } else if (loose.length) {
    note = `${loose.length} clips lying directly in “${shoot.name}” (not in a device bin) are left out.`;
  }
  const originals = SlingCore.originalsOf(devs.flatMap((d) => d.files));   // proxies: original in any device bin counts
  const kept = devs.map((d) => SlingCore.deviceEntry(d.name, d.files, originals)).filter((d) => d.files.length);
  const all = kept.flatMap((d) => d.files);
  const projDir = P.path.split("/").slice(0, -1).join("/");
  return { name: shoot.name, devs: kept, root: commonDir(all), outDir: projDir + "/SlingSync", note };
}

document.getElementById("syncBin").addEventListener("click", () => guarded(async () => {
  document.getElementById("detailsWrap").hidden = true;
  say("Reading the selected bin…");
  let found;
  try { found = await devicesFromSelectedBin(); }
  catch (e) { say(e && e.message ? e.message : String(e), "err"); return; }
  if (!found.devs.length) { say("No video or audio clips in “" + found.name + "”.", "err"); return; }
  const { P, media } = await getEngine();
  if (!(await P.exists(found.outDir))) await P.mkdir(found.outDir);
  const devs = await SlingRun.scanWithChannels(P, media, found.root, found.devs);
  pending = { path: found.root, name: found.name, devs, bin: true, outDir: found.outDir };
  const total = devs.reduce((n, d) => n + d.files.length, 0);
  document.getElementById("setupTitle").textContent = `Bin “${found.name}”: ${total} clips from ${devs.length} devices`;
  renderDevices(devs);
  say(found.note || "");
  showSetup(true);
}));

document.getElementById("setupCancel").addEventListener("click", (ev) => {
  ev.preventDefault();
  pending = null;
  showSetup(false);
  say("");
});

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
        stopIfCancelled();
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

// ---- Arranging clips in a sequence (Sync Timeline, Sync Selected Bin) ----
// Every clip with its file, trim (in point) and a key that stays the same when clips move
// (track + file + in point). Fresh objects from project handle P.
async function timelineItems(P, guid) {
  const seq = await sequenceById(P, guid);
  if (!seq) throw new Error("the sequence disappeared");
  const CLIP = (ppro.Constants && ppro.Constants.TrackItemType && ppro.Constants.TrackItemType.CLIP) || 1;
  const out = [], seen = new Map();
  for (const [kind, count, get] of [["v", await seq.getVideoTrackCount(), (i) => seq.getVideoTrack(i)],
                                    ["a", await seq.getAudioTrackCount(), (i) => seq.getAudioTrack(i)]]) {
    for (let i = 0; i < count; i++) {
      for (const it of await (await get(i)).getTrackItems(CLIP, false)) {
        let path = null;
        try { path = await ppro.ClipProjectItem.cast(await it.getProjectItem()).getMediaFilePath(); } catch (e) { /* not a media clip */ }
        const inPt = ticksOf(await it.getInPoint());
        const base = `${kind}${i}|${path}|${inPt}`;
        const n = seen.get(base) || 0; seen.set(base, n + 1);
        out.push({ key: `${base}#${n}`, it, kind, track: i, path, inPt,
          start: ticksOf(await it.getStartTime()), end: ticksOf(await it.getEndTime()) });
      }
    }
  }
  return out;
}
async function frameTicks(guid) {
  try { const n = Number(await (await sequenceById(await activeProject(), guid)).getTimebase()); if (n > 0) return n; } catch (e) { /* fall back */ }
  return TICKS / 25;
}

// Move clips so each one starts at goal.get(key). Premiere moves linked clips together (a
// camera clip's video and audio), and which parts are linked can't be read. So each round moves
// one part per clip (same file and start) in one edit, then re-reads: linked parts have arrived
// with it, parts that aren't linked are still pending and go in the next round. Nothing is ever
// moved twice. Normally 1-2 rounds.
async function moveAllTo(guid, goal, order, log, label) {
  const read = async () => timelineItems(await activeProject(), guid);
  const pendingOf = (items) => items.filter((x) => goal.has(x.key) && x.start !== goal.get(x.key)).sort(order);
  const act = (x) => x.it.createMoveAction(ppro.TickTime.createWithTicks(String(goal.get(x.key) - x.start)));
  const groupOf = (x) => `${x.path}|${x.start}`;
  const onePerClip = (list) => { const seen = new Set(); return list.filter((x) => !seen.has(groupOf(x)) && seen.add(groupOf(x))); };
  let last = Infinity;
  for (let round = 1; round <= 50; round++) {
    stopIfCancelled();
    const pending = pendingOf(await read());
    if (!pending.length) return;
    if (pending.length >= last) {
      throw new Error(`Premiere didn't move ${pending.length} clips (${label}), so I stopped. Delete the “(synced)” copy; your original is unchanged.`);
    }
    last = pending.length;
    say(`${label}… ${pending.length} clip parts to go`);
    await edit(async (Q) => onePerClip(pendingOf(await timelineItems(Q, guid))), (list) => list.map(act), "SlingSync: " + label);
    log(`${label}: round ${round}, ${pending.length} parts pending before`);
  }
}

// Put every clip at targetOf(item) (ticks, or null = no sync position). Two steps so nothing
// ever lands on another clip: park everything after the end, then move each into place.
// Returns { moved, unplaced, overlaps }.
// Plan where every clip goes (ticks). only: optional Set of keys (selected clips): then only
// those move, every other clip stays where it is, and the selection is synced around its
// earliest clip, which keeps its place. Returns { target, overlaps, unplaced }.
async function planTimeline(guid, targetOf, only) {
  const frame = await frameTicks(guid);
  const snap = (t) => Math.round(t / frame) * frame;
  const items = await timelineItems(await activeProject(), guid);
  const movable = only ? items.filter((x) => only.has(x.key)) : items;
  const target = new Map(), unplaced = [], raw = new Map();
  for (const x of movable) { const t = targetOf(x); if (t === null || t === undefined) unplaced.push(x); else raw.set(x.key, t); }
  let shift = 0;
  if (only && raw.size) {                     // keep the earliest selected clip where it is
    const ref = movable.filter((x) => raw.has(x.key)).sort((p, q) => p.start - q.start)[0];
    shift = ref.start - raw.get(ref.key);
    const lowest = Math.min(...[...raw.values()].map((t) => t + shift));
    if (lowest < 0) shift -= lowest;
  }
  for (const [k, t] of raw) target.set(k, snap(Math.max(0, t + shift)));
  let syncedEnd = 0;
  for (const x of movable) if (target.has(x.key)) syncedEnd = Math.max(syncedEnd, target.get(x.key) + (x.end - x.start));
  if (unplaced.length && !only) {             // no sync position: keep their layout, after the synced part
    const from = Math.min(...unplaced.map((x) => x.start)), at = snap(syncedEnd + 10 * TICKS);
    for (const x of unplaced) target.set(x.key, snap(at + x.start - from));
  }
  const goalOf = (x) => (target.has(x.key) ? target.get(x.key) : x.start);   // others stay put
  const overlaps = [], byTrack = new Map();   // two clips on one track at once can't be placed
  for (const x of items) { const k = x.kind + x.track; if (!byTrack.has(k)) byTrack.set(k, []); byTrack.get(k).push(x); }
  for (const [k, list] of byTrack) {
    list.sort((p, q) => goalOf(p) - goalOf(q));
    for (let i = 0; i + 1 < list.length; i++) {
      const p = list[i], q = list[i + 1];
      if (goalOf(p) + (p.end - p.start) > goalOf(q)) overlaps.push(`${k.startsWith("v") ? "V" : "A"}${Number(k.slice(1)) + 1}: ${(p.path || "?").split("/").pop()} / ${(q.path || "?").split("/").pop()}`);
    }
  }
  return { target, overlaps, unplaced: unplaced.length, curEnd: Math.max(...items.map((x) => x.end)), syncedEnd };
}

// Carry out a plan in sequence `guid` (same clips as the planned one, e.g. its copy). Two steps
// so nothing ever lands on another clip: park the moving clips after the end, then move each
// into place.
async function applyPlan(guid, plan, log) {
  const { target } = plan;
  const frame = await frameTicks(guid);
  const items = await timelineItems(await activeProject(), guid);
  const D = Math.round((Math.max(plan.curEnd, ...[...target.values()]) + plan.syncedEnd + 60 * TICKS) / frame) * frame;
  const park = new Map(items.filter((x) => target.has(x.key)).map((x) => [x.key, x.start + D]));
  await moveAllTo(guid, park, (p, q) => q.start - p.start, log, "Making room");
  await moveAllTo(guid, target, (p, q) => target.get(p.key) - target.get(q.key), log, "Syncing clips");
  const wrong = (await timelineItems(await activeProject(), guid)).filter((x) => target.has(x.key) && x.start !== target.get(x.key));
  log(`check: ${wrong.length} clips not where planned`);
  if (wrong.length) throw new Error(`${wrong.length} clips didn't land where planned. Check the “(synced)” copy before using it.`);
}

// ---- Sync Selected Bin, built from the project's own clips ----
// 1. a new sequence from the first camera clip (so it gets the camera's settings), in a bin
//    "<bin> (synced)"; 2. every other clip added after the end, each camera/recorder (and each
//    lane of overlapping clips) on its own tracks; 3. everything moved into sync (planTimeline/
//    applyPlan, as Sync Timeline).
async function clipItemsByPath(P) {             // media path -> ClipProjectItem, whole project
  const map = new Map();
  const walk = async (folder) => {
    for (const x of await describe(await folder.getItems())) {
      if (x.bin) await walk(x.bin);
      else if (x.path && !map.has(normPath(x.path))) map.set(normPath(x.path), x.item);
    }
  };
  await walk(await P.getRootItem());
  return map;
}
// Where each media clip sits: path -> bin names from the root. Walked once; afterwards a clip is
// fetched fresh from just its own bin (much faster than walking the project for every clip).
async function clipLocations(P) {
  const map = new Map();
  const walk = async (folder, names) => {
    for (const x of await describe(await folder.getItems())) {
      if (x.bin) await walk(x.bin, names.concat([x.name]));
      else if (x.path && !map.has(normPath(x.path))) map.set(normPath(x.path), names);
    }
  };
  await walk(await P.getRootItem(), []);
  return map;
}
async function clipAt(P, names, path) {
  const folder = names.length ? await findBin(P, names) : await P.getRootItem();
  if (!folder) return null;
  const hit = (await describe(await folder.getItems())).find((x) => !x.bin && x.path && normPath(x.path) === normPath(path));
  return hit ? hit.item : null;
}
// Cancel: stop between steps of the timeline work too (the engine checks it during analysis)
function stopIfCancelled() { if (cancelRequested) throw new SlingCore.Cancelled(); }

async function buildFromBin(res, binName, log) {
  const clips = [...res.clips].sort((a, b) => a.start - b.start);
  // track plan: each device lane gets a video track (cameras) and its own audio tracks
  const laneKey = (c) => c.dev + "|" + (c.lane || 0);
  const lanes = [];
  for (const c of [...res.clips].sort((a, b) => (b.has_video - a.has_video) || (a.dev - b.dev) || ((a.lane || 0) - (b.lane || 0)))) {
    if (!lanes.find((l) => l.key === laneKey(c))) lanes.push({ key: laneKey(c), video: !!c.has_video, nch: 0 });
  }
  for (const c of res.clips) { const l = lanes.find((x) => x.key === laneKey(c)); l.nch = Math.max(l.nch, c.nch || 0, 1); }
  let v = 0, a = 0;
  for (const l of lanes) { l.v = l.video ? v++ : 0; l.a = a; a += l.nch; }
  const laneOf = (c) => lanes.find((l) => l.key === laneKey(c));
  const first = clips.find((c) => laneOf(c).v === 0 && laneOf(c).a === 0) || clips[0];
  log(`Building from the bin's clips: ${clips.length} clips, ${lanes.length} device lanes, ${v} video + ${a} audio tracks`);
  // 1. bin + sequence
  const seqName = binName + " (synced)";
  let P = await activeProject();
  const taken = new Set((await describe(await (await P.getRootItem()).getItems())).filter((x) => x.bin).map((x) => x.name));
  let outBin = seqName;
  for (let k = 2; taken.has(outBin); k++) outBin = `${seqName} ${k}`;
  await edit(async (Q) => Q.getRootItem(), (root) => [root.createBinAction(outBin, false)], "SlingSync: synced bin");
  try {
    return await buildInto(outBin, seqName, clips, first, laneOf, log);
  } catch (e) {                                 // clean up what was started, then let the caller fall back
    try { await edit(async (Q) => ({ root: await Q.getRootItem(), bin: await findBin(Q, [outBin]) }),
      ({ root, bin }) => (bin ? [root.createRemoveItemAction(bin)] : []), "SlingSync: clean up"); } catch (e2) { log("clean-up failed: " + e2); }
    throw e;
  }
}

async function buildInto(outBin, seqName, clips, first, laneOf, log) {
  let P = await activeProject();
  const items = await clipItemsByPath(P);
  const firstItem = items.get(normPath(first.path));
  if (!firstItem) throw new Error("couldn't find " + first.name + " in the project");
  const before = new Set((await P.getSequences()).map((q) => String(q.guid)));
  await P.createSequenceFromMedia(seqName, [ppro.ClipProjectItem.cast(firstItem)], await findBin(P, [outBin]));
  let guid = null;
  for (let k = 0; k < 20 && !guid; k++) {
    await sleep(150);
    const q = (await (await activeProject()).getSequences()).find((x) => !before.has(String(x.guid)));
    if (q) guid = String(q.guid);
  }
  if (!guid) throw new Error("Premiere didn't create the sequence");
  const res = { clips };
  // 2. add the other clips after the end, each on its lane's tracks. The end is tracked here
  //    (each clip goes 1 s after the previous one ends) instead of re-reading the timeline.
  const where = await clipLocations(await activeProject());
  const its0 = await timelineItems(await activeProject(), guid);
  let end = its0.length ? Math.max(...its0.map((x) => x.end)) : 0;
  let k = 0;
  const t0 = Date.now();
  for (const c of clips) {
    if (c === first) continue;
    stopIfCancelled();
    k++;
    say(`Building the sequence from your clips… ${k}/${clips.length - 1}`);
    showBar(0.85 + 0.05 * k / clips.length);
    const lane = laneOf(c);
    const at = end + TICKS;
    await edit(async (Q) => {
      const seq = await sequenceById(Q, guid);
      let item = await clipAt(Q, where.get(normPath(c.path)) || [], c.path);
      if (!item) item = (await clipItemsByPath(Q)).get(normPath(c.path));    // bins renamed or same names
      if (!item) throw new Error("couldn't find " + c.name + " in the project");
      return { editor: ppro.SequenceEditor.getEditor(seq), item };
    }, ({ editor, item }) => [editor.createInsertProjectItemAction(item, ppro.TickTime.createWithTicks(String(at)), lane.v, lane.a, true)],
    "SlingSync: add clip");
    end = at + Math.ceil(c.duration + 1) * TICKS;
  }
  log(`added ${k} clips in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  stopIfCancelled();
  const built = await timelineItems(await activeProject(), guid);
  const missing = clips.filter((c) => !built.some((x) => normPath(x.path) === normPath(c.path)));
  log(`built: ${built.length} clip parts on the timeline; missing files: ${missing.length}`);
  if (missing.length) throw new Error(`${missing.length} clips didn't make it onto the new sequence`);
  // 3. into sync
  const startOf = new Map(res.clips.map((c) => [normPath(c.path), c.start]));
  const plan = await planTimeline(guid, (x) => (startOf.has(normPath(x.path)) ? startOf.get(normPath(x.path)) * TICKS + x.inPt : null), null);
  if (plan.overlaps.length) throw new Error("clips would overlap on a track: " + plan.overlaps.slice(0, 3).join("; "));
  await applyPlan(guid, plan, log);
  try { const Q = await activeProject(); await Q.openSequence(await sequenceById(Q, guid)); } catch (e) { log("open failed: " + e); }
  return `Built “${seqName}” from your own clips (in the “${outBin}” bin): no duplicates.`;
}

// Devices of a set of media files, by the same rules as syncing a shoot folder (one folder per
// camera/recorder, split groups, names when there are no folders), using only these files:
// a folder scan run on a virtual folder tree built from the paths. Files the folder rules would
// skip (e.g. loose next to device folders) get a device from their file names.
async function devicesFromPaths(paths) {
  paths = [...new Set(paths)].sort();
  const root = commonDir(paths);
  const join = (a, b) => (a.endsWith("/") ? a + b : a + "/" + b);
  const vfs = {
    join,
    listDir: async (dir) => {
      const pre = join(dir, ""), seen = new Map();
      for (const p of paths) {
        if (!p.startsWith(pre)) continue;
        const rest = p.slice(pre.length).split("/");
        seen.set(rest[0], seen.get(rest[0]) || rest.length > 1);
      }
      return [...seen].map(([name, isDir]) => ({ name, isDir }));
    },
  };
  let devs = (await SlingRun.scanDevices(vfs, root)).map((d) => ({ name: d.name, files: d.files }));
  // all clips in one folder: name the device after the folder ("CamA", not "C")
  if (devs.length === 1 && paths.every((p) => p.lastIndexOf("/") === root.length) && root !== "/") devs[0].name = root.split("/").pop();
  // 'B-roll/Cam A' joins 'Cam A' when its files are named the same way (the folder scan does
  // this only when B-roll has several subfolders, which a few timeline clips may not show)
  const names = (fs_) => new Set(fs_.map(SlingCore.looseDevice));
  for (const d of [...devs]) {
    const subs = new Set(d.files.map((f) => f.slice(join(root, d.name + "/").length).split("/")[0]));
    if (subs.size !== 1 || !d.files.every((f) => f.startsWith(join(root, d.name + "/")))) continue;
    const sub = [...subs][0].toLowerCase();
    const into = devs.find((o) => o !== d && o.name.toLowerCase() === sub && [...names(d.files)].some((n) => names(o.files).has(n)));
    if (into) { into.files = into.files.concat(d.files).sort(); devs = devs.filter((o) => o !== d); }
  }
  const covered = new Set(devs.flatMap((d) => d.files));
  const extra = new Map();
  for (const p of paths) {
    if (covered.has(p)) continue;
    let k = SlingCore.looseDevice(p);
    while (devs.some((d) => d.name === k)) k += " (2)";
    if (!extra.has(k)) extra.set(k, []);
    extra.get(k).push(p);
  }
  for (const [k, fs_] of extra) devs.push({ name: k, files: fs_ });
  const originals = SlingCore.originalsOf(devs.flatMap((d) => d.files));   // proxies: original anywhere counts
  return devs.map((d) => SlingCore.deviceEntry(d.name, d.files, originals)).filter((d) => d.files.length);
}

// Sync Timeline's question when devices share a track. Resolves "sort", "keep", or null (Cancel).
function askTracks(text, canKeep) {
  const box = document.getElementById("choice");
  const sortBtn = document.getElementById("choiceSort"), keepBtn = document.getElementById("choiceKeep");
  say(text);
  keepBtn.hidden = !canKeep;
  document.getElementById("keepNote").hidden = !canKeep;
  box.hidden = false;
  return new Promise((resolve) => {
    let done = false;
    const onSort = () => finish("sort"), onKeep = () => finish("keep");
    const finish = (v) => {
      if (done) return;
      done = true; box.hidden = true; clearInterval(timer);
      sortBtn.removeEventListener("click", onSort); keepBtn.removeEventListener("click", onKeep);
      resolve(v);
    };
    sortBtn.addEventListener("click", onSort);
    keepBtn.addEventListener("click", onKeep);
    const timer = setInterval(() => { if (cancelRequested) finish(null); }, 200);
  });
}

// ---- Sync Timeline: sync the clips in the open sequence (in a copy) ----
// Devices come from the files (as a folder sync), not from the tracks. If every track holds one
// device, the clips are moved into sync in a copy (trims and cuts kept). If devices share a track,
// the user chooses: a new sequence with each camera/recorder on its own tracks (whole clips), or
// keep the tracks (only possible if no clips would land on top of each other).
async function syncTimeline() {
  const lines = [], log = (l) => lines.push(l);
  detailBox.textContent = "";
  cancelRequested = false;
  try {
    const P0 = await activeProject();
    if (!P0) { say("Open a Premiere project first.", "err"); return; }
    if (!P0.path) { say("Save the Premiere project first: SlingSync keeps its files next to the project file.", "err"); return; }
    const seq0 = await P0.getActiveSequence();
    if (!seq0) { say("Open the sequence you want to sync first.", "err"); return; }
    const name = seq0.name, srcGuid = String(seq0.guid);
    // 0. clips selected in the timeline? Then only those are synced.
    say("Reading the timeline…");
    let items0 = await timelineItems(P0, srcGuid);
    log(`Timeline: ${items0.length} clip parts`);
    let only = null;
    try {
      const picked = await (await seq0.getSelection()).getTrackItems();
      if (picked && picked.length) {
        only = new Set();
        for (const it of picked) {
          const kind = typeof it.createAddVideoTransitionAction === "function" ? "v" : "a";
          const track = await it.getTrackIndex();
          const start = ticksOf(await it.getStartTime());
          const hit = items0.find((x) => x.kind === kind && x.track === track && x.start === start);
          if (hit) only.add(hit.key);
        }
        log(`Selected clips: ${only.size}`);
        if (!only.size) only = null;
      }
    } catch (e) { log("couldn't read the timeline selection (" + e + "): syncing the whole timeline"); }
    // 1. devices from the files themselves (folders and names), as in a folder sync
    if (only) items0 = items0.filter((x) => only.has(x.key));
    const isMedia = (p) => p && SlingCore.isMedia(p.split("/").pop());
    const paths = [...new Set(items0.map((x) => x.path).filter(isMedia))];
    if (!paths.length) { say("The open sequence has no video or audio clips.", "err"); return; }
    const devices = await devicesFromPaths(paths);
    log("Devices from the files: " + devices.map((d) => `${d.name} (${d.files.length})`).join(", "));
    const devOf = new Map();
    for (const d of devices) for (const f of d.files) devOf.set(f, d.name);
    // tracks holding clips of more than one device: then the clips get sorted onto new tracks
    const perTrack = new Map();
    for (const x of items0) {
      if (!devOf.has(x.path)) continue;
      const k = (x.kind === "v" ? "V" : "A") + (x.track + 1);
      if (!perTrack.has(k)) perTrack.set(k, new Set());
      perTrack.get(k).add(devOf.get(x.path));
    }
    const mixed = [...perTrack].filter(([, s]) => s.size > 1).map(([k, s]) => `${k}: ${[...s].join(", ")}`);
    if (mixed.length) log("Tracks with more than one device: " + mixed.join("; "));
    // 2. sync
    const outDir = P0.path.split("/").slice(0, -1).join("/") + "/SlingSync";
    const { P, media } = await getEngine();
    if (!(await P.exists(outDir))) await P.mkdir(outDir);
    const all = devices.flatMap((d) => d.files);
    showBar(0);
    const res = await SlingRun.run(P, media, commonDir(all), {
      version: panelVersion(), devices, name: name + " (synced)",
      output: `${outDir}/${name}_synced.xml`, reportPath: `${outDir}/${name}_SlingSync_report.txt`, cacheDir: `${outDir}/.slingsync_cache`,
      isCancelled: () => cancelRequested,
      progress: (f, m) => { showBar(0.8 * f); say("Syncing “" + name + "”…\n" + m); },
      log,
    });
    const startOf = new Map(res.clips.map((c) => [c.path, c.start]));
    // 3. plan on the original first: if clips would collide, stop before changing anything
    stopIfCancelled();
    const plan = await planTimeline(srcGuid, (x) => (startOf.has(x.path) ? (startOf.get(x.path) * TICKS + x.inPt) : null), only);
    if (plan.overlaps.length) log("Clips would overlap on a track after syncing: " + plan.overlaps.slice(0, 10).join("; "));
    if (mixed.length || plan.overlaps.length) {
      // cameras or recorders share a track: ask whether to sort them onto their own tracks
      const canKeep = !plan.overlaps.length;
      showBar(null);
      const pick = await askTracks(
        (mixed.length ? "Cameras and recorders share tracks:\n" + mixed.slice(0, 5).join("\n") + (mixed.length > 5 ? `\n… ${mixed.length - 5} more` : "") + "\n" : "") +
        (canKeep ? "What should SlingSync do?"
                 : "Keeping your tracks isn't possible: after syncing, clips would sit on top of each other:\n" +
                   plan.overlaps.slice(0, 3).join("\n") + (plan.overlaps.length > 3 ? `\n… ${plan.overlaps.length - 3} more` : "")), canKeep);
      log("choice: " + (pick || "cancel"));
      if (!pick) throw new SlingCore.Cancelled();
      if (pick === "sort") {
        say("Building a new sequence with each camera and recorder on its own tracks…");
        showBar(0.85);
        const note = await buildFromBin(res, name, log);
        showBar(null);
        const synced = res.counts.synced || 0;
        say(`${note}\nEach camera and recorder is on its own tracks (${devices.length} devices), whole clips (trims and cuts in your timeline aren't carried over).\n` +
            `${only ? `${only.size} selected clips, ` : ""}${synced} of ${res.files} files synced by sound` +
            (res.files - synced ? `, ${res.files - synced} to check (see ${res.report.split("/").pop()})` : "") +
            ".\nYour original sequence is unchanged.", "ok");
        return;
      }
    }
    // 4. copy the sequence and move its clips into sync
    say("Moving the clips into sync in a copy of “" + name + "”…");
    showBar(0.85);
    const before = new Set((await (await activeProject()).getSequences()).map((q) => String(q.guid)));
    await edit((Q) => sequenceById(Q, srcGuid), (sq) => [sq.createCloneAction()], "SlingSync: copy sequence");
    let guid = null;
    for (let k = 0; k < 20 && !guid; k++) {
      await sleep(150);
      const q = (await (await activeProject()).getSequences()).find((x) => !before.has(String(x.guid)));
      if (q) guid = String(q.guid);
    }
    if (!guid) throw new Error("Premiere didn't make a copy of the sequence, so nothing was changed.");
    try { await edit(async (Q) => (await sequenceById(Q, guid)).getProjectItem(), (pi) => [pi.createSetNameAction(name + " (synced)")], "SlingSync: name copy"); } catch (e) { log("rename failed: " + e); }
    await applyPlan(guid, plan, log);
    showBar(null);
    try { const Q = await activeProject(); await Q.openSequence(await sequenceById(Q, guid)); } catch (e) { log("open failed: " + e); }
    const synced = res.counts.synced || 0;
    say(`“${name} (synced)”: ${only ? `${only.size} selected clips, ` : ""}${synced} of ${res.files} files synced by sound` +
        (res.files - synced ? `, ${res.files - synced} to check (see ${res.report.split("/").pop()})` : "") +
        (plan.unplaced ? `.\n${plan.unplaced} clips had no sync position and were ${only ? "left where they were" : "put after the end"}` : "") +
        ".\nYour original sequence is unchanged.", "ok");
  } catch (e) {
    if (!(e && e.name === "Cancelled")) throw e;
    log("cancelled");
    say("Sync Timeline stopped. Your original sequence is unchanged.\n" +
        "If a half-done “(synced)” sequence was left in the Project panel, delete it. Files already analysed are saved, so syncing again is faster.");
  } finally {
    detailBox.textContent = lines.join("\n");
    document.getElementById("detailsWrap").hidden = false;
    showBar(null);
  }
}

document.getElementById("syncTimeline").addEventListener("click", () => guarded(syncTimeline));

document.getElementById("compactFolder").addEventListener("click", () => guarded(async () => {
  const lines = [];
  const log = (l) => lines.push(l);
  cancelRequested = false;
  try { await compactActiveSequence(log); }
  catch (e) {
    showBar(null);
    if (e && e.name === "Cancelled") { say("Compact Timeline stopped. Your original sequence is unchanged; delete the half-done “(compact)” copy."); detailBox.textContent = lines.join("\n"); document.getElementById("detailsWrap").hidden = false; return; }
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
    let deviceOf = null;
    try { deviceOf = await deviceMapFromFolder(folder.nativePath); } catch (e) { /* import without bins */ }
    await importXml(xmls[0].nativePath, "", deviceOf ? { shootName: folder.name, deviceOf } : null);
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
