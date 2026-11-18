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
  const project = await ppro.Project.getActiveProject();
  if (!project) {
    say("Open or create a Premiere project first.", "err");
    return false;
  }
  say((prefix || "") + "Importing " + nativePath.split("/").pop() + "…");
  const before = await sequenceNames(project);
  const root = await project.getRootItem();
  let reported;
  try {
    reported = await project.importFiles([nativePath], true, root, false);
  } catch (e) {
    say((prefix || "") + "Premiere refused the import:\n" + e, "err");
    return false;
  }
  // importFiles has been reported to return true before (or without) importing, so check.
  let added = [];
  for (let i = 0; i < 20 && added.length === 0; i++) {
    await sleep(250);
    added = (await sequenceNames(project)).slice(before.length);
  }
  if (added.length) {
    say((prefix || "") + "Imported: " + added.join(", ") + "\nOpen it from the Project panel.", "ok");
    return true;
  }
  say((prefix || "") + "Premiere " + (reported ? "reported success" : "reported failure") +
      " but no new sequence appeared.\nTry File → Import… with:\n" + nativePath, "err");
  return false;
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
