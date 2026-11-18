// SlingSync plug-in decoder: FFmpeg (audio-only build) compiled to WebAssembly.
//
// Mirrors what the Python engine gets from PyAV:
//   ss_open(handle, size)      open a file; bytes come from JavaScript (js_read), so the
//                              plug-in's own file access is used and only needed parts are read
//   ss_info()                  JSON: duration, audio streams/channels, rate, fps, size, tags
//   ss_start(rate)             start decoding every audio stream, resampled to `rate` Hz
//   ss_read(max_frames)        decode up to max_frames frames; returns frames written to
//                              ss_buf() as interleaved float32, all streams' channels side by
//                              side (like engine._blocks). 0 = end of file.
//   ss_close()
// One file at a time (the plug-in analyses files one after another).
#include <emscripten.h>
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/opt.h>
#include <libavutil/channel_layout.h>
#include <libswresample/swresample.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// Reads `size` bytes at `pos` from file `handle` into wasm memory at `buf`. Async on the
// JavaScript side (UXP file reads return promises); Asyncify pauses the C code meanwhile.
EM_ASYNC_JS(int, js_read, (int handle, uint8_t *buf, int size, double pos), {
  return await Module.slingRead(handle, buf, size, pos);
});

#define MAXS 16
#define IOBUF (256 * 1024)

static AVFormatContext *fmt;
static AVIOContext *io;
static int h_handle;
static int64_t h_size, h_pos;
static int ns, sidx[MAXS], sch[MAXS], tot_ch;
static AVCodecContext *dec[MAXS];
static SwrContext *swr[MAXS];
static float *q[MAXS];          // per-stream queue of resampled interleaved frames
static int qn[MAXS], qcap[MAXS];
static float *outbuf;
static int outcap, out_rate, eof;
static AVPacket *pkt;
static AVFrame *frm;
static char *info;

static int io_read(void *op, uint8_t *b, int n) {
  if (h_pos >= h_size) return AVERROR_EOF;
  if (h_pos + n > h_size) n = (int)(h_size - h_pos);
  int got = js_read(h_handle, b, n, (double)h_pos);
  if (got <= 0) return AVERROR_EOF;
  h_pos += got;
  return got;
}

static int64_t io_seek(void *op, int64_t off, int whence) {
  whence &= ~AVSEEK_FORCE;
  if (whence == AVSEEK_SIZE) return h_size;
  if (whence == SEEK_SET) h_pos = off;
  else if (whence == SEEK_CUR) h_pos += off;
  else if (whence == SEEK_END) h_pos = h_size + off;
  else return -1;
  return h_pos;
}

EMSCRIPTEN_KEEPALIVE void ss_close(void) {
  for (int k = 0; k < ns; k++) {
    avcodec_free_context(&dec[k]);
    swr_free(&swr[k]);
    free(q[k]); q[k] = NULL; qn[k] = qcap[k] = 0;
  }
  ns = tot_ch = 0;
  if (fmt) avformat_close_input(&fmt);
  if (io) { av_freep(&io->buffer); avio_context_free(&io); }
  free(info); info = NULL;
  eof = 0;
}

// Returns 0 if opened, negative FFmpeg error otherwise.
EMSCRIPTEN_KEEPALIVE int ss_open(int handle, double size) {
  ss_close();
  av_log_set_level(AV_LOG_PANIC);
  h_handle = handle; h_size = (int64_t)size; h_pos = 0;
  uint8_t *b = av_malloc(IOBUF);
  io = avio_alloc_context(b, IOBUF, 0, NULL, io_read, NULL, io_seek);
  fmt = avformat_alloc_context();
  fmt->pb = io;
  int r = avformat_open_input(&fmt, NULL, NULL, NULL);
  if (r < 0) { fmt = NULL; ss_close(); return r; }
  r = avformat_find_stream_info(fmt, NULL);
  if (r < 0) { ss_close(); return r; }
  for (unsigned i = 0; i < fmt->nb_streams && ns < MAXS; i++) {
    AVStream *s = fmt->streams[i];
    if (s->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
      sidx[ns] = i;
      sch[ns] = s->codecpar->ch_layout.nb_channels > 0 ? s->codecpar->ch_layout.nb_channels : 1;
      tot_ch += sch[ns];
      ns++;
    }
  }
  return 0;
}

// --- tiny JSON writer ---
static char *jb; static size_t jlen, jcap;
static void jput(const char *s) {
  size_t l = strlen(s);
  if (jlen + l + 1 > jcap) { jcap = (jlen + l + 1) * 2; jb = realloc(jb, jcap); }
  memcpy(jb + jlen, s, l + 1); jlen += l;
}
static void jstr(const char *s) {
  char t[8];
  jput("\"");
  for (; *s; s++) {
    unsigned char c = (unsigned char)*s;
    if (c == '"' || c == '\\') { t[0] = '\\'; t[1] = c; t[2] = 0; jput(t); }
    else if (c < 0x20) { snprintf(t, sizeof t, "\\u%04x", c); jput(t); }
    else { t[0] = c; t[1] = 0; jput(t); }
  }
  jput("\"");
}
static void jnum(double v) { char t[64]; snprintf(t, sizeof t, "%.17g", v); jput(t); }
static void jtags(AVDictionary *d, int *first) {
  const AVDictionaryEntry *e = NULL;
  while ((e = av_dict_iterate(d, e))) {
    if (!*first) jput(","); *first = 0;
    jstr(e->key); jput(":"); jstr(e->value);
  }
}

EMSCRIPTEN_KEEPALIVE const char *ss_info(void) {
  if (!fmt) return "null";
  jb = NULL; jlen = jcap = 0;
  jput("{\"format\":"); jstr(fmt->iformat->name);
  jput(",\"duration\":"); jnum(fmt->duration > 0 ? fmt->duration / 1e6 : 0);
  jput(",\"streams\":[");
  for (unsigned i = 0; i < fmt->nb_streams; i++) {
    AVStream *s = fmt->streams[i];
    AVCodecParameters *p = s->codecpar;
    if (i) jput(",");
    jput("{\"type\":");
    jstr(p->codec_type == AVMEDIA_TYPE_AUDIO ? "audio" : p->codec_type == AVMEDIA_TYPE_VIDEO ? "video" : "other");
    jput(",\"codec\":"); jstr(avcodec_get_name(p->codec_id));
    jput(",\"duration\":");
    jnum(s->duration > 0 && s->time_base.den ? s->duration * av_q2d(s->time_base) : 0);
    if (p->codec_type == AVMEDIA_TYPE_AUDIO) {
      jput(",\"channels\":"); jnum(p->ch_layout.nb_channels);
      jput(",\"rate\":"); jnum(p->sample_rate);
      jput(",\"decodable\":"); jput(avcodec_find_decoder(p->codec_id) ? "true" : "false");
    }
    if (p->codec_type == AVMEDIA_TYPE_VIDEO) {
      AVRational a = s->avg_frame_rate.den ? s->avg_frame_rate : s->r_frame_rate;
      jput(",\"fps\":"); jnum(a.den ? av_q2d(a) : 0);
      jput(",\"width\":"); jnum(p->width);
      jput(",\"height\":"); jnum(p->height);
    }
    jput(",\"tags\":{"); int f = 1; jtags(s->metadata, &f); jput("}}");
  }
  jput("],\"tags\":{"); int f = 1; jtags(fmt->metadata, &f); jput("}}");
  free(info); info = jb;
  return info;
}

static void qpush(int k, const float *d, int n) {
  int c = sch[k];
  if (qn[k] + n > qcap[k]) {
    qcap[k] = (qn[k] + n) * 2;
    q[k] = realloc(q[k], (size_t)qcap[k] * c * sizeof(float));
  }
  memcpy(q[k] + (size_t)qn[k] * c, d, (size_t)n * c * sizeof(float));
  qn[k] += n;
}

static float *tmp; static int tmpcap;
static void resample_into(int k, AVFrame *f) {
  int max = swr_get_out_samples(swr[k], f ? f->nb_samples : 0);
  if (max <= 0) return;
  if (max > tmpcap) { tmpcap = max * 2; tmp = realloc(tmp, (size_t)tmpcap * MAXS * 8 * sizeof(float)); }
  uint8_t *o[1] = {(uint8_t *)tmp};
  int n = swr_convert(swr[k], o, max, f ? (const uint8_t **)f->extended_data : NULL, f ? f->nb_samples : 0);
  if (n > 0) qpush(k, tmp, n);
}

// Returns number of audio channels in total (all streams), or negative on error.
EMSCRIPTEN_KEEPALIVE int ss_start(int rate) {
  if (!fmt) return -1;
  out_rate = rate;
  for (unsigned i = 0; i < fmt->nb_streams; i++) fmt->streams[i]->discard = AVDISCARD_ALL;
  for (int k = 0; k < ns; k++) {
    AVStream *s = fmt->streams[sidx[k]];
    s->discard = AVDISCARD_DEFAULT;
    const AVCodec *c = avcodec_find_decoder(s->codecpar->codec_id);
    if (!c) return -2;
    dec[k] = avcodec_alloc_context3(c);
    avcodec_parameters_to_context(dec[k], s->codecpar);
    dec[k]->pkt_timebase = s->time_base;
    if (avcodec_open2(dec[k], c, NULL) < 0) return -3;
    AVChannelLayout in = dec[k]->ch_layout;
    if (in.nb_channels <= 0) av_channel_layout_default(&in, sch[k]);
    AVChannelLayout outl;
    av_channel_layout_copy(&outl, &in);
    if (swr_alloc_set_opts2(&swr[k], &outl, AV_SAMPLE_FMT_FLT, rate, &in,
                            dec[k]->sample_fmt, dec[k]->sample_rate, 0, NULL) < 0) return -4;
    if (swr_init(swr[k]) < 0) return -5;
  }
  if (!pkt) pkt = av_packet_alloc();
  if (!frm) frm = av_frame_alloc();
  // the decoder may report a different count than the container: trust the decoder
  tot_ch = 0;
  for (int k = 0; k < ns; k++) {
    int c = dec[k]->ch_layout.nb_channels;
    if (c > 0) sch[k] = c;
    tot_ch += sch[k];
  }
  return tot_ch;
}

static void drain(int k) {
  while (avcodec_receive_frame(dec[k], frm) == 0) {
    resample_into(k, frm);
    av_frame_unref(frm);
  }
}

static int qmin(void) {
  int m = qn[0];
  for (int k = 1; k < ns; k++) if (qn[k] < m) m = qn[k];
  return m;
}

EMSCRIPTEN_KEEPALIVE float *ss_buf(void) { return outbuf; }
EMSCRIPTEN_KEEPALIVE int ss_channels(void) { return tot_ch; }

EMSCRIPTEN_KEEPALIVE int ss_read(int maxn) {
  if (!ns) return 0;
  while (!eof && qmin() < maxn) {
    int r = av_read_frame(fmt, pkt);
    if (r < 0) {
      eof = 1;
      for (int k = 0; k < ns; k++) {
        avcodec_send_packet(dec[k], NULL);
        drain(k);
        resample_into(k, NULL);
      }
      break;
    }
    for (int k = 0; k < ns; k++) {
      if (pkt->stream_index == sidx[k]) {
        if (avcodec_send_packet(dec[k], pkt) == 0) drain(k);   // bad packets are skipped
        break;
      }
    }
    av_packet_unref(pkt);
  }
  int n = qmin();
  if (n > maxn) n = maxn;
  if (n <= 0) return 0;
  if (n * tot_ch > outcap) { outcap = n * tot_ch; outbuf = realloc(outbuf, (size_t)outcap * sizeof(float)); }
  int col = 0;
  for (int k = 0; k < ns; k++) {
    int c = sch[k];
    for (int i = 0; i < n; i++)
      for (int j = 0; j < c; j++) outbuf[(size_t)i * tot_ch + col + j] = q[k][(size_t)i * c + j];
    col += c;
    memmove(q[k], q[k] + (size_t)n * c, (size_t)(qn[k] - n) * c * sizeof(float));
    qn[k] -= n;
  }
  return n;
}
