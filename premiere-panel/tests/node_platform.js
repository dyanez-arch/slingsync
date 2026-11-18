// Node implementation of the panel engine's `platform` (file access), for tests.
const fs = require("fs");
const path = require("path");

const handles = new Map();
let next = 1;
module.exports = {
  join: (a, b) => path.join(a, b),
  relPath: (p, from) => path.relative(from, p),
  async listDir(p) {
    return fs.readdirSync(p, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  },
  async stat(p) {
    const s = fs.statSync(p);
    return { size: s.size, mtime: s.mtimeMs / 1000, birthtime: s.birthtimeMs / 1000 };
  },
  async exists(p) { return fs.existsSync(p); },
  async mkdir(p) { fs.mkdirSync(p, { recursive: true }); },
  async open(p) { const h = next++; handles.set(h, fs.openSync(p, "r")); return h; },
  async readAt(h, size, pos) {
    const b = Buffer.alloc(size);
    const n = fs.readSync(handles.get(h), b, 0, size, pos);
    return new Uint8Array(b.buffer, b.byteOffset, n);
  },
  async close(h) { fs.closeSync(handles.get(h)); handles.delete(h); },
  async readFile(p) { const b = fs.readFileSync(p); return new Uint8Array(b.buffer, b.byteOffset, b.length); },
  async writeFile(p, data) { fs.writeFileSync(p, typeof data === "string" ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength)); },
};
