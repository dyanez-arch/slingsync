#!/bin/bash
# Build the plug-in's audio decoder: FFmpeg 7.1.1 (same version as the app's PyAV), audio
# only, compiled to WebAssembly with Emscripten (brew install emscripten).
# Output: premiere-plugin/wasm/ssdec.js + ssdec.wasm
#
# FFmpeg is built with LGPL components only (no --enable-gpl), like PyAV's wheels.
set -euo pipefail
FFV=7.1.1
HERE="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${SLINGSYNC_WASM_WORK:-$HOME/Library/Caches/slingsync-wasm}"
OUT="$HERE/premiere-plugin/wasm"
mkdir -p "$WORK"
cd "$WORK"
[ -f ffmpeg-$FFV.tar.xz ] || curl -sSLO "https://ffmpeg.org/releases/ffmpeg-$FFV.tar.xz"
[ -d ffmpeg-$FFV ] || tar xf ffmpeg-$FFV.tar.xz

DEMUXERS="mov,mxf,wav,w64,aiff,caf,mp3,aac,ac3,eac3,flac,ogg,matroska,mpegts,mpegps,avi,dv,asf"
DECODERS="aac,aac_latm,aac_fixed,mp1,mp2,mp3,mp1float,mp2float,mp3float,ac3,eac3,flac,alac,opus,vorbis"
DECODERS="$DECODERS,wmav1,wmav2,s302m,dvaudio,adpcm_ima_qt,adpcm_ima_wav,adpcm_ms"
DECODERS="$DECODERS,pcm_s8,pcm_u8,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_s32be"
DECODERS="$DECODERS,pcm_f32le,pcm_f32be,pcm_f64le,pcm_f64be,pcm_alaw,pcm_mulaw,pcm_s24daud"
DECODERS="$DECODERS,pcm_dvd,pcm_bluray,pcm_s16le_planar,pcm_s24le_planar,pcm_s32le_planar"
PARSERS="aac,aac_latm,mpegaudio,ac3,flac,opus,vorbis,dvaudio"

PREFIX="$WORK/install"
if [ ! -f "$PREFIX/lib/libavformat.a" ]; then
  cd ffmpeg-$FFV
  emconfigure ./configure --prefix="$PREFIX" \
    --cc=emcc --cxx=em++ --ar=emar --ranlib=emranlib --nm=emnm \
    --target-os=none --arch=x86_32 --enable-cross-compile \
    --disable-everything --disable-programs --disable-doc --disable-debug \
    --disable-asm --disable-inline-asm --disable-x86asm --disable-pthreads --disable-w32threads \
    --disable-network --disable-autodetect --disable-runtime-cpudetect \
    --disable-avdevice --disable-swscale --disable-avfilter \
    --enable-avformat --enable-avcodec --enable-swresample \
    --enable-demuxer="$DEMUXERS" --enable-decoder="$DECODERS" --enable-parser="$PARSERS" \
    --extra-cflags="-O3" --extra-ldflags="-O3"
  emmake make -j"$(sysctl -n hw.ncpu)"
  emmake make install
  cd ..
fi

emcc -O3 "$OUT/ssdec.c" -I"$PREFIX/include" \
  "$PREFIX/lib/libavformat.a" "$PREFIX/lib/libavcodec.a" \
  "$PREFIX/lib/libswresample.a" "$PREFIX/lib/libavutil.a" \
  -sASYNCIFY -sASYNCIFY_IMPORTS='["js_read"]' \
  -sMODULARIZE -sEXPORT_NAME=SSDec -sENVIRONMENT=web,node,shell \
  -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=64MB \
  -sEXPORTED_RUNTIME_METHODS='["UTF8ToString","HEAPU8","HEAPF32","ccall"]' \
  -sEXPORTED_FUNCTIONS='["_ss_open","_ss_info","_ss_start","_ss_read","_ss_buf","_ss_channels","_ss_close","_malloc","_free"]' \
  -sSINGLE_FILE=0 -sFILESYSTEM=0 \
  -o "$OUT/ssdec.js"
ls -l "$OUT"/ssdec.*
