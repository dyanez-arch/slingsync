// Node test helper: decode a file with the plug-in decoder and dump audio at 8 kHz.
// usage: node decode_dump.js <file> <seconds> <out.f32>   (prints probe info as JSON)
const fs = require("fs");
const path = require("path");
const SSDec = require("../wasm/ssdec.js");
const SlingMedia = require("../engine/media.js");

(async () => {
  const [file, seconds, out] = process.argv.slice(2);
  const fds = {};
  const read = async (h, size, pos) => {
    const b = Buffer.alloc(size);
    const { bytesRead } = await fds[h].read(b, 0, size, pos);
    return new Uint8Array(b.buffer, b.byteOffset, bytesRead);
  };
  const wasmBytes = fs.readFileSync(path.join(__dirname, "../wasm/ssdec.wasm"));
  const media = await SlingMedia.create({ factory: SSDec, wasmBytes, read });
  fds[1] = await fs.promises.open(file, "r");
  const t0 = Date.now();
  const info = await media.open(1, (await fds[1].stat()).size);
  if (!info) { console.log(JSON.stringify({ error: "could not open" })); return; }
  const ch = media.start(8000);
  const want = Math.round(Number(seconds) * 8000);
  const parts = [];
  let got = 0;
  while (got < want) {
    const b = await media.read(Math.min(4000, want - got));
    if (!b) break;
    parts.push(b.data);
    got += b.frames;
  }
  media.close();
  const all = new Float32Array(got * ch);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  fs.writeFileSync(out, Buffer.from(all.buffer));
  console.log(JSON.stringify({ info, channels: ch, frames: got, ms: Date.now() - t0 }));
})().catch((e) => { console.log(JSON.stringify({ error: String(e && e.stack || e) })); process.exit(1); });
