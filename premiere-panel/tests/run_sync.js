// Run the panel engine on a shoot folder in Node.
// usage: node run_sync.js <project> <outdir>   -> <outdir>/js.xml, js_report.txt, js_log.txt, js_cache/
const fs = require("fs");
const path = require("path");
const SSDec = require("../wasm/ssdec.js");
const SlingMedia = require("../engine/media.js");
const SlingRun = require("../engine/run.js");
const P = require("./node_platform.js");

(async () => {
  const [project, outdir] = process.argv.slice(2);
  fs.mkdirSync(outdir, { recursive: true });
  const wasmBytes = fs.readFileSync(path.join(__dirname, "../wasm/ssdec.wasm"));
  const media = await SlingMedia.create({ factory: SSDec, wasmBytes, read: (h, size, pos) => P.readAt(h, size, pos) });
  const logLines = [];
  const t0 = Date.now();
  let lastMsg = "";
  const res = await SlingRun.run(P, media, path.resolve(project), {
    output: path.join(outdir, "js.xml"), reportPath: path.join(outdir, "js_report.txt"),
    cacheDir: path.join(outdir, "js_cache"), version: "panel-test", compact: true,
    stems: !!process.env.STEMS, stemsDir: path.join(outdir, "js_audio"), stemsRate: process.env.STEMS_RATE ? Number(process.env.STEMS_RATE) : null,
    log: (s) => logLines.push(s),
    progress: (f, m) => { const msg = m.replace(/\(\d+\/\d+\)/, ""); if (msg !== lastMsg) { lastMsg = msg; process.stderr.write(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}\n`); } },
  });
  fs.writeFileSync(path.join(outdir, "js_log.txt"), logLines.join("\n") + "\n");
  console.log(JSON.stringify({ seconds: (Date.now() - t0) / 1000, counts: res.counts, files: res.files }));
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
