// SlingSync panel for Premiere Pro 2027 (UXP). Prototype step 1: import a SlingSync XML
// into the open project and check that the synced sequence really appeared.
const ppro = require("premierepro");
const { storage } = require("uxp");
const fs = storage.localFileSystem;

const statusBox = document.getElementById("status");

function say(text, kind) {
  statusBox.textContent = text;
  statusBox.className = kind || "";
}

async function sequenceNames(project) {
  const seqs = await project.getSequences();
  const names = [];
  for (const s of seqs) {
    try { names.push(s.name); } catch (e) { names.push("(sequence)"); }
  }
  return names;
}

async function importXml(nativePath) {
  const project = await ppro.Project.getActiveProject();
  if (!project) {
    say("Open or create a Premiere project first.", "err");
    return;
  }
  say("Importing " + nativePath.split("/").pop() + "…");
  const before = await sequenceNames(project);
  const root = await project.getRootItem();
  let reported;
  try {
    reported = await project.importFiles([nativePath], true, root, false);
  } catch (e) {
    say("Premiere refused the import:\n" + e, "err");
    return;
  }
  // importFiles has been reported to return true before (or without) importing, so check.
  let added = [];
  for (let i = 0; i < 20 && added.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const after = await sequenceNames(project);
    added = after.slice(before.length);
  }
  if (added.length) {
    say("Imported: " + added.join(", ") + "\nOpen it from the Project panel.", "ok");
  } else {
    say("Premiere " + (reported ? "reported success" : "reported failure") +
        " but no new sequence appeared.\nTry File → Import… with the same XML and tell us what happens.", "err");
  }
}

document.getElementById("fromFile").addEventListener("click", async () => {
  try {
    const file = await fs.getFileForOpening({ types: ["xml"] });
    if (file) await importXml(file.nativePath);
  } catch (e) {
    say("Couldn't open the file:\n" + e, "err");
  }
});

document.getElementById("fromFolder").addEventListener("click", async () => {
  try {
    const folder = await fs.getFolder();
    if (!folder) return;
    const entries = await folder.getEntries();
    const xmls = entries.filter((e) => e.isFile && e.name.endsWith("_synced.xml"));
    if (!xmls.length) {
      say("No SlingSync XML in " + folder.name + ".\nSync this folder with the SlingSync app first.", "err");
      return;
    }
    await importXml(xmls[0].nativePath);
  } catch (e) {
    say("Couldn't read the folder:\n" + e, "err");
  }
});

say("Ready.");
