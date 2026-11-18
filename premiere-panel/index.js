// SlingSync panel for Premiere Pro 2027 (UXP).
// Step 2: pick a shoot folder → the SlingSync app syncs it → the panel imports the result.
// Step 1 (still available): import an existing SlingSync XML.
//
// UXP panels can't run programs, so the panel opens a slingsync:// link (the SlingSync app
// registers it, macOS asks the user once), and the app reports progress in
// <folder>/.slingsync_status.json, which the panel reads.
const ppro = require("premierepro");
const { storage, shell } = require("uxp");
const fsys = storage.localFileSystem;
const fs = require("fs");

const STATUS_FILE = ".slingsync_status.json";
const statusBox = document.getElementById("status");
const bar = document.getElementById("bar");
const barFill = document.getElementById("barFill");
let busy = false;

function say(text, kind) {
  statusBox.textContent = text;
  statusBox.className = kind || "";
}

function showBar(frac) {
  if (frac === null) { bar.style.display = "none"; return; }
  bar.style.display = "block";
  barFill.style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + "%";
}

function setBusy(b) {
  busy = b;
  for (const id of ["syncFolder", "fromFolder", "fromFile"]) {
    document.getElementById(id).disabled = b;
  }
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

async function readStatus(folderPath) {
  try {
    return JSON.parse(await fs.readFile(folderPath + "/" + STATUS_FILE, "utf8"));
  } catch (e) {
    return null;                       // not written yet (or mid-write)
  }
}

async function syncFolder(folderPath, folderName) {
  const id = String(Date.now());
  const audio = document.getElementById("audio").checked ? "1" : "0";
  const url = "slingsync://sync?folder=" + encodeURIComponent(folderPath) +
              "&id=" + id + "&audio=" + audio;
  say("Opening the SlingSync app…\n(If macOS asks, allow Premiere to open SlingSync.)");
  showBar(0);
  const err = await shell.openExternal(url, "Open SlingSync to sync “" + folderName + "”");
  if (err) {
    showBar(null);
    say("Couldn't open the SlingSync app:\n" + err +
        "\n\nIs SlingSync 1.2.0b2 or later installed in Applications?", "err");
    return;
  }
  const started = Date.now();
  let seen = false;
  while (true) {
    await sleep(700);
    const st = await readStatus(folderPath);
    if (st && st.id === id) {
      seen = true;
      if (st.state === "scanning" || st.state === "syncing") {
        showBar(st.progress || 0);
        say("Syncing " + folderName + "…\n" + (st.message || ""));
      } else if (st.state === "done") {
        showBar(1);
        const summary = st.synced + " of " + st.files + " clips synced by sound" +
          (st.check ? ", " + st.check + " to check (see the report)" : "") +
          (st.stems && st.stems.length ? ", " + st.stems.length + " audio files written" : "") + ".\n";
        await importXml(st.xml, summary);
        showBar(null);
        return;
      } else {
        showBar(null);
        say((st.state === "cancelled" ? "Sync cancelled." : "Sync failed:") + "\n" + (st.message || ""),
            st.state === "cancelled" ? "" : "err");
        return;
      }
    } else if (!seen && Date.now() - started > 60000) {
      showBar(null);
      say("SlingSync didn't respond.\nMake sure SlingSync 1.2.0b2 or later is installed in " +
          "Applications and that it isn't busy with another sync.", "err");
      return;
    }
  }
}

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

document.getElementById("fromFile").addEventListener("click", () => guarded(async () => {
  try {
    const file = await fsys.getFileForOpening({ types: ["xml"] });
    if (file) await importXml(file.nativePath);
  } catch (e) {
    say("Couldn't open the file:\n" + e, "err");
  }
}));

document.getElementById("fromFolder").addEventListener("click", () => guarded(async () => {
  try {
    const folder = await fsys.getFolder();
    if (!folder) return;
    const entries = await folder.getEntries();
    const xmls = entries.filter((e) => e.isFile && e.name.endsWith("_synced.xml"));
    if (!xmls.length) {
      say("No SlingSync XML in " + folder.name + ".\nUse Sync Shoot Folder… to sync it first.", "err");
      return;
    }
    await importXml(xmls[0].nativePath);
  } catch (e) {
    say("Couldn't read the folder:\n" + e, "err");
  }
}));

showBar(null);
say("Ready.");
