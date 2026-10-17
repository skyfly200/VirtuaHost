// Receiving finished audio from another system (the Netlify generator): pushed bytes or a link to fetch.
const audio = require('./audio');
const fxLib = require('./fx');

class IngestError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// Only real audio is accepted, decided from the file's first bytes, not from what the sender claims.
function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WAVE') return 'wav';
  if (buf.toString('latin1', 0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return 'mp3';
  if (buf.toString('latin1', 0, 4) === 'OggS') return 'ogg';
  return null;
}

async function readLimited(res, maxBytes) {
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new IngestError('audio is too large', 413);
  const chunks = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) { await reader.cancel(); throw new IngestError('audio is too large', 413); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function createIngest({ clips, maxBytes = 25e6, allowedHosts = [], allowHttp = false, transcode = true, fetchImpl = fetch, toMp3 = audio.toMp3, canTranscode = audio.ffmpegAvailable, fx = fxLib }) {
  const hosts = allowedHosts.map((h) => h.toLowerCase());
  const shrink = transcode && canTranscode();

  async function importBuffer(buffer, meta = {}) {
    if (!buffer || !buffer.length) throw new IngestError('no audio received');
    if (buffer.length > maxBytes) throw new IngestError('audio is too large', 413);
    let ext = sniff(buffer);
    if (!ext) throw new IngestError('unsupported audio (send WAV, MP3 or Ogg)', 415);
    let data = buffer;
    if (meta.fx) {
      // An effect or voice change was asked for; the result is MP3 at the stream bitrate.
      data = await fx.apply(buffer, meta.fx);
      ext = 'mp3';
    } else if (shrink && ext !== 'mp3') {
      // WAV from Gemini is about 3 MB a minute; MP3 at the stream bitrate is about 1 MB.
      data = await toMp3(buffer);
      ext = 'mp3';
    }
    return clips.addExternal({ buffer: data, ext, title: meta.title, text: meta.text, source: meta.source, tags: meta.tags });
  }

  async function fetchAudio(rawUrl) {
    let url;
    try { url = new URL(rawUrl); } catch (e) { throw new IngestError('url is not valid'); }
    if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) throw new IngestError('only https links are accepted');
    if (!hosts.includes(url.host.toLowerCase())) throw new IngestError(`host "${url.host}" is not allowed (INGEST_ALLOWED_HOSTS)`, 403);
    let res;
    try {
      res = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Accept: 'audio/*' } });
    } catch (err) {
      throw new IngestError(`could not fetch the link: ${err.message}`, 502);
    }
    if (!res.ok) throw new IngestError(`the link returned ${res.status}`, 502);
    return readLimited(res, maxBytes);
  }

  return { importBuffer, fetchAudio, sniff, enabledHosts: hosts, shrinks: shrink };
}

module.exports = { createIngest, IngestError, sniff };
