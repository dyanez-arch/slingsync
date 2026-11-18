// The panel engine's `platform` (file access) inside Premiere, using UXP's Node-style "fs"
// (needs "localFileSystem": "fullAccess" in manifest.json). See run.js for the interface.
(function (root) {
  "use strict";

  function create() {
    const fs = require("fs");
    const toSec = (v) => {
      if (v instanceof Date) return v.getTime() / 1000;
      if (typeof v === "number") return v > 1e11 ? v / 1000 : v;     // ms or s
      return undefined;
    };
    const isDir = (st) => (typeof st.isDirectory === "function" ? st.isDirectory() : !!st.isDirectory);
    const toBuffer = (data) => typeof data === "string" ? data
      : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    return {
      join: (a, b) => a.replace(/\/+$/, "") + "/" + b,
      relPath: (p, from) => {
        const f = from.replace(/\/+$/, "") + "/";
        return p.startsWith(f) ? p.slice(f.length) : p;
      },
      async listDir(p) {
        const names = await fs.readdir(p);
        const out = [];
        for (const name of names) {
          try { out.push({ name, isDir: isDir(await fs.lstat(p + "/" + name)) }); }
          catch (e) { /* unreadable entry: skip */ }
        }
        return out;
      },
      async stat(p) {
        const st = await fs.lstat(p);
        return { size: st.size, mtime: toSec(st.mtime !== undefined ? st.mtime : st.mtimeMs),
          birthtime: toSec(st.birthtime !== undefined ? st.birthtime : st.birthtimeMs) };
      },
      async exists(p) { try { await fs.lstat(p); return true; } catch (e) { return false; } },
      async mkdir(p) { try { await fs.mkdir(p, { recursive: true }); } catch (e) { if (!(await this.exists(p))) throw e; } },
      async open(p) { return await fs.open(p, "r"); },
      async readAt(h, size, pos) {
        const ab = new ArrayBuffer(size);
        const r = await fs.read(h, ab, 0, size, pos);
        const n = typeof r === "number" ? r : (r && typeof r.bytesRead === "number" ? r.bytesRead : size);
        return new Uint8Array(ab, 0, n);
      },
      async close(h) { if (fs.close) await fs.close(h); },
      // writing big files (audio export) piece by piece
      async openWrite(p) {
        if (typeof fs.write !== "function") throw new Error("This version of Premiere can't write files piece by piece (fs.write is missing)");
        return await fs.open(p, "w");
      },
      async writeAt(h, bytes, pos) {
        const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        await fs.write(h, ab, 0, bytes.byteLength, pos);
      },
      async readFile(p) { return new Uint8Array(await fs.readFile(p)); },
      async writeFile(p, data) { await fs.writeFile(p, toBuffer(data)); },
    };
  }

  root.SlingUxpPlatform = { create };
})(typeof globalThis !== "undefined" ? globalThis : this);
