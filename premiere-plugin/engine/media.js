// SlingSync plug-in engine: media access through the FFmpeg WebAssembly decoder (wasm/ssdec).
// Works in Premiere (UXP) and in Node (tests). The caller supplies the decoder factory, the
// .wasm bytes and an async ranged-read function, so this file has no platform code.
//
//   const media = await SlingMedia.create({ factory: SSDec, wasmBytes, read });
//     read(handle, size, pos) -> Promise<Uint8Array>   (bytes of file `handle` at `pos`)
//   const info = await media.open(handle, fileSize)     // null if FFmpeg can't open it
//   const nch = media.start(8000)                        // all audio streams, resampled
//   for (let b; (b = await media.read(4096)); ) { b.frames, b.channels, b.data (interleaved) }
//   media.close()
//
// One file at a time; calls must not overlap (the plug-in analyses files one by one).
(function (root) {
  "use strict";

  async function create({ factory, wasmBytes, read }) {
    let M = null;
    const cfg = {
      // Premiere's UXP hangs on asynchronous WebAssembly.instantiate; synchronous works.
      instantiateWasm(imports, done) {
        const mod = new WebAssembly.Module(wasmBytes);
        const inst = new WebAssembly.Instance(mod, imports);
        done(inst, mod);
        return inst.exports;
      },
      slingRead: async (handle, ptr, size, pos) => {
        const b = await read(handle, size, pos);
        M.HEAPU8.set(b, ptr);
        return b.length;
      },
      print() {},
      printErr() {},
    };
    M = await factory(cfg);
    let channels = 0;

    return {
      async open(handle, size) {
        const r = await M.ccall("ss_open", "number", ["number", "number"], [handle, size], { async: true });
        if (r < 0) return null;
        return JSON.parse(M.UTF8ToString(M._ss_info()));
      },
      start(rate) {
        channels = M._ss_start(rate);
        return channels;
      },
      async read(maxFrames) {
        const n = await M.ccall("ss_read", "number", ["number"], [maxFrames], { async: true });
        if (n <= 0) return null;
        const p = M._ss_buf() >> 2;
        return { frames: n, channels, data: M.HEAPF32.slice(p, p + n * channels) };
      },
      close() {
        M._ss_close();
      },
    };
  }

  const api = { create };
  root.SlingMedia = api;                                   // plug-in: <script> global
  if (typeof module !== "undefined" && module.exports) module.exports = api;   // Node tests
})(typeof globalThis !== "undefined" ? globalThis : this);
