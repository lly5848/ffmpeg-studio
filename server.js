'use strict';

/**
 * FFmpeg Studio - local web UI that drives ffmpeg.
 * Dependency-free Node http server (no npm install needed).
 *
 * Features:
 *   - Raw-binary file upload (drag & drop)
 *   - ffprobe media info
 *   - Transcode / Concat / Filter jobs with live progress (SSE)
 *   - Output download + listings
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
// Directories for uploaded/processed files. Resolved inside startServer() so
// that when packaged as asar (read-only) we fall back to a writable location.
let UPLOADS = path.join(ROOT, 'uploads');
let OUTPUTS = path.join(ROOT, 'outputs');

const PORT = process.env.PORT || 5180;

// ---------------------------------------------------------------------------
// Tool resolution (ffmpeg / ffprobe)
// ---------------------------------------------------------------------------
let FF = 'ffmpeg';
let FFPROBE = 'ffprobe';
let FONT = ''; // escaped path for drawtext (avoids fontconfig dependency on Windows)

function probeBinary(cmd) {
  return new Promise((resolve) => {
    const p = spawn(cmd, ['-version'], { windowsHide: true });
    p.on('error', () => resolve(false));
    p.on('close', (c) => resolve(c === 0));
  });
}

async function resolveTools() {
  if (await probeBinary('ffmpeg')) FF = 'ffmpeg';
  else {
    for (const g of ['C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe', 'C:/Program Files/ffmpeg/bin/ffmpeg.exe', '/c/Program Files/ffmpeg/bin/ffmpeg.exe']) {
      if (fs.existsSync(g)) { FF = g; break; }
    }
  }
  if (await probeBinary('ffprobe')) FFPROBE = 'ffprobe';
  else {
    for (const g of ['C:\\Program Files\\ffmpeg\\bin\\ffprobe.exe', 'C:/Program Files/ffmpeg/bin/ffprobe.exe', '/c/Program Files/ffmpeg/bin/ffprobe.exe']) {
      if (fs.existsSync(g)) { FFPROBE = g; break; }
    }
  }
  console.log('[ffmpeg-studio] ffmpeg :', FF);
  console.log('[ffmpeg-studio] ffprobe:', FFPROBE);

  // Find a usable font for drawtext (fontconfig is often missing on Windows).
  const fontCandidates = [
    'C:\\Windows\\Fonts\\arial.ttf',
    'C:\\Windows\\Fonts\\msyh.ttc',
    'C:\\Windows\\Fonts\\calibri.ttf',
    'C:\\Windows\\Fonts\\segoeui.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/System/Library/Fonts/Supplemental/Arial.ttf'
  ];
  for (const g of fontCandidates) {
    if (fs.existsSync(g)) { FONT = g.replace(/\\/g, '\\\\'); break; }
  }
  if (FONT) console.log('[ffmpeg-studio] font  :', FONT);

  // Bundled ffmpeg (electron extraResources) takes priority if present.
  const resBase = process.resourcesPath || ROOT;
  const bundled = [path.join(resBase, 'ffmpeg', 'ffmpeg.exe'), path.join(resBase, 'ffmpeg', 'bin', 'ffmpeg.exe')];
  for (const g of bundled) if (fs.existsSync(g)) { FF = g; FFPROBE = path.join(path.dirname(g), 'ffprobe.exe'); break; }
}

// Escape a string for use inside an ffmpeg filter single-quoted value.
function filterEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:');
}

// ---------------------------------------------------------------------------
// Job registry + SSE progress
// ---------------------------------------------------------------------------
const jobs = new Map(); // jobId -> { clients:Set, proc, status, killOnDisconnect }

function createJob() {
  const jobId = crypto.randomBytes(6).toString('hex');
  const job = { clients: new Set(), proc: null, status: 'pending', killOnDisconnect: false };
  jobs.set(jobId, job);
  return jobId;
}

function emit(jobId, event, data) {
  const job = jobs.get(jobId);
  if (!job) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of job.clients) {
    try { c.write(payload); } catch (_) {}
  }
}

function handleProgress(req, res, jobId) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 1000\n\n');
  const job = jobs.get(jobId);
  if (!job) {
    res.write(`event: error\ndata: ${JSON.stringify({ message: 'job not found' })}\n\n`);
    res.end();
    return;
  }
  job.clients.add(res);
  req.on('close', () => {
    job.clients.delete(res);
    if (job.clients.size === 0 && job.killOnDisconnect && job.proc) {
      try { job.proc.kill('SIGKILL'); } catch (_) {}
    }
  });
}

// Run ffmpeg, stream progress. Returns promise resolved on exit 0.
function runFFmpeg(jobId, args, durationSec) {
  return new Promise((resolve, reject) => {
    const job = jobs.get(jobId);
    emit(jobId, 'start', { args: [FF, ...args] });
    const proc = spawn(FF, args, { windowsHide: true });
    job.proc = proc;
    job.status = 'running';

    let outTimeMs = 0;
    let lastPct = -1;
    let stderrTail = '';

    proc.stdout.on('data', (buf) => {
      const text = buf.toString();
      for (const line of text.split('\n')) {
        const m = line.match(/^out_time_ms=(\d+)/);
        if (m) {
          outTimeMs = parseInt(m[1], 10);
          if (durationSec && durationSec > 0) {
            const pct = Math.min(100, Math.round((outTimeMs / 1e6 / durationSec) * 100));
            if (pct !== lastPct) {
              lastPct = pct;
              emit(jobId, 'progress', { pct, outTimeMs, durationMs: Math.round(durationSec * 1000) });
            }
          }
        }
        if (line.startsWith('progress=')) {
          if (line.split('=')[1].trim() === 'end') emit(jobId, 'progress', { pct: 100 });
        }
      }
    });

    proc.stderr.on('data', (buf) => {
      const s = buf.toString();
      stderrTail = (stderrTail + s).slice(-3000);
      emit(jobId, 'log', { line: s });
    });

    proc.on('error', (err) => {
      emit(jobId, 'error', { message: err.message });
      reject(err);
    });

    proc.on('close', (code) => {
      if (code === 0) {
        emit(jobId, 'progress', { pct: 100 });
        emit(jobId, 'done', {});
        job.status = 'done';
        resolve();
      } else {
        emit(jobId, 'error', { message: `ffmpeg exited with code ${code}`, log: stderrTail });
        job.status = 'error';
        reject(new Error('ffmpeg exit ' + code));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// ffprobe media info
// ---------------------------------------------------------------------------
function getInfo(filePath) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (c) => {
      if (c !== 0) return reject(new Error('ffprobe failed'));
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
  });
}

function durationOf(info) {
  if (info && info.format && info.format.duration) return parseFloat(info.format.duration);
  return 0;
}

// ---------------------------------------------------------------------------
// Command builders
// ---------------------------------------------------------------------------
function sanitizeName(name) {
  return (name || 'output').replace(/[^\w.\-一-龥 ]/g, '_').replace(/\s+/g, '_');
}

function buildTranscode(inputPath, params, outputPath) {
  const args = ['-y', '-i', inputPath];
  const v = params.video || {};
  const a = params.audio || {};
  const codec = v.codec || 'libx264';

  if (codec !== 'copy') args.push('-c:v', codec);

  if (codec === 'libx264' || codec === 'libx265') {
    if (v.crf != null && v.crf !== '' && v.crf != undefined) args.push('-crf', String(v.crf));
    if (v.preset) args.push('-preset', v.preset);
    if (v.tune) args.push('-tune', v.tune);
  } else if (codec === 'libvpx-vp9') {
    if (v.bitrate) args.push('-b:v', v.bitrate + 'k');
    args.push('-row-mt', '1');
  } else if (codec === 'libxvid' || codec === 'mpeg4' || codec === 'libaom-av1') {
    if (v.bitrate) args.push('-b:v', v.bitrate + 'k');
  }

  if (v.resolution && v.resolution !== 'original') {
    const parts = String(v.resolution).split('x');
    if (parts.length === 2) args.push('-vf', `scale=${parts[0]}:${parts[1]}`);
  }
  if (v.fps) args.push('-r', String(v.fps));

  if (a.codec && a.codec !== 'copy') args.push('-c:a', a.codec);
  if (a.bitrate) args.push('-b:a', a.bitrate + 'k');
  if (a.mute) args.push('-an');

  if (params.pixfmt) args.push('-pix_fmt', params.pixfmt);
  if (params.faststart) args.push('-movflags', '+faststart');

  args.push(outputPath);
  return args;
}

function buildConcat(filePaths, params, outputPath, jobId) {
  if (params.method === 'demuxer') {
    const listPath = path.join(OUTPUTS, `concat_${jobId}.txt`);
    const content = filePaths
      .map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
      .join('\n');
    fs.writeFileSync(listPath, content);
    return { args: ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outputPath], cleanup: listPath };
  }
  // filter_complex (re-encode, robust for mixed sources)
  const inputs = [];
  filePaths.forEach((f) => inputs.push('-i', f));
  const n = filePaths.length;
  const map = Array.from({ length: n }, (_, i) => `[${i}:v][${i}:a]`).join('');
  const filter = `${map}concat=n=${n}:v=1:a=1[outv][outa]`;
  return {
    args: ['-y', ...inputs, '-filter_complex', filter, '-map', '[outv]', '-map', '[outa]', '-c:v', 'libx264', '-c:a', 'aac', outputPath]
  };
}

function buildFilter(inputPath, params, outputPath) {
  const filters = [];
  const v = params || {};

  if (v.scale && v.scale !== 'original') {
    const [w, h] = String(v.scale).split('x');
    filters.push(`scale=${w}:${h}`);
  }
  if (v.crop) {
    const c = v.crop; // {w,h,x,y}
    if (c.w && c.h) filters.push(`crop=${c.w}:${c.h}:${c.x || 0}:${c.y || 0}`);
  }
  if (v.rotate) {
    if (v.rotate === '90') filters.push('transpose=1');
    else if (v.rotate === '270') filters.push('transpose=2');
    else if (v.rotate === '180') filters.push('transpose=1,transpose=1');
  }
  if (v.fliph) filters.push('hflip');
  if (v.flipv) filters.push('vflip');
  if (v.denoise) filters.push('hqdn3d');
  if (v.brightness != null && v.brightness !== 0) {
    filters.push(`eq=brightness=${Number(v.brightness).toFixed(2)}:contrast=${Number(v.contrast != null ? v.contrast : 1).toFixed(2)}`);
  }
  if (v.speed && v.speed !== 1) {
    filters.push(`setpts=${1 / Number(v.speed)}*PTS`);
  }
  if (v.fadein) filters.push(`fade=t=in:st=0:d=${Number(v.fadein)}`);
  if (v.fadeout && v.duration) {
    const start = Math.max(0, Number(v.duration) - Number(v.fadeout));
    filters.push(`fade=t=out:st=${start}:d=${Number(v.fadeout)}`);
  }
  if (v.watermarkText) {
    const tw = filterEscape(v.watermarkText);
    const x = v.wmX || 'w-tw-20';
    const y = v.wmY || 'h-th-20';
    const fontOpt = FONT ? `fontfile='${FONT}':` : '';
    filters.push(`drawtext=${fontOpt}text='${tw}':fontcolor=white:fontsize=${v.wmSize || 28}:x=${x}:y=${y}:box=1:boxcolor=black@0.4`);
  }

  const args = ['-y', '-i', inputPath];
  if (filters.length) args.push('-vf', filters.join(','));
  if (v.audioCodec && v.audioCodec !== 'copy') args.push('-c:a', v.audioCodec);
  if (v.mute) args.push('-an');
  args.push('-c:v', v.videoCodec || 'libx264', outputPath);
  return args;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBodyJSON(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 5e6) reject(new Error('payload too large'));
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(buf);
  });
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => {
      try { return fs.statSync(path.join(dir, f)).isFile(); } catch { return false; }
    });
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Main request handler
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    // static
    if (p === '/' || p === '/index.html') return serveStatic(req, res, path.join(PUBLIC, 'index.html'));
    if (p === '/app.js') return serveStatic(req, res, path.join(PUBLIC, 'app.js'));
    if (p === '/style.css') return serveStatic(req, res, path.join(PUBLIC, 'style.css'));

    // status
    if (p === '/api/status' && req.method === 'GET') {
      return sendJSON(res, 200, { ffmpeg: FF, ffprobe: FFPROBE, ok: true });
    }

    // upload (raw binary). ?name=filename
    if (p === '/api/upload' && req.method === 'POST') {
      const name = sanitizeName(url.searchParams.get('name') || 'upload.bin');
      const dest = path.join(UPLOADS, name);
      const ws = fs.createWriteStream(dest);
      req.pipe(ws);
      ws.on('finish', () => {
        const stat = fs.statSync(dest);
        sendJSON(res, 200, { ok: true, name, size: stat.size });
      });
      ws.on('error', (e) => sendJSON(res, 500, { ok: false, error: e.message }));
      return;
    }

    // list uploads + outputs
    if (p === '/api/files' && req.method === 'GET') {
      return sendJSON(res, 200, { uploads: listDir(UPLOADS), outputs: listDir(OUTPUTS) });
    }

    // media info
    if (p === '/api/info' && req.method === 'POST') {
      const body = await readBodyJSON(req);
      const fp = path.join(UPLOADS, path.basename(body.file || ''));
      if (!fs.existsSync(fp)) return sendJSON(res, 404, { ok: false, error: 'file not found' });
      const info = await getInfo(fp);
      const dur = durationOf(info);
      const vstream = (info.streams || []).find((s) => s.codec_type === 'video');
      const astream = (info.streams || []).find((s) => s.codec_type === 'audio');
      return sendJSON(res, 200, {
        ok: true,
        duration: dur,
        durationStr: fmtTime(dur),
        video: vstream ? { codec: vstream.codec_name, w: vstream.width, h: vstream.height, fps: fpsOf(vstream), pixfmt: vstream.pix_fmt } : null,
        audio: astream ? { codec: astream.codec_name, rate: astream.sample_rate, channels: astream.channels } : null,
        format: info.format ? { format: info.format.format_name, size: Number(info.format.size), bitrate: info.format.bit_rate } : null,
        raw: info
      });
    }

    // TRANSCODE
    if (p === '/api/transcode' && req.method === 'POST') {
      const body = await readBodyJSON(req);
      const src = path.join(UPLOADS, path.basename(body.file || ''));
      if (!fs.existsSync(src)) return sendJSON(res, 404, { ok: false, error: 'source file not found' });
      const ext = (body.format || 'mp4').replace(/[^a-z0-9]/gi, '');
      const outName = sanitizeName((body.outName || path.parse(body.file).name + '_out')) + '.' + ext;
      const outPath = path.join(OUTPUTS, outName);
      const args = buildTranscode(src, body.params || {}, outPath);
      const jobId = createJob();
      sendJSON(res, 200, { ok: true, jobId, output: outName });
      let dur = 0;
      try { dur = durationOf(await getInfo(src)); } catch (_) {}
      runFFmpeg(jobId, args, dur).catch(() => {});
      return;
    }

    // CONCAT
    if (p === '/api/concat' && req.method === 'POST') {
      const body = await readBodyJSON(req);
      if (!body.files || !body.files.length) return sendJSON(res, 400, { ok: false, error: 'no files' });
      const paths = body.files.map((f) => path.join(UPLOADS, path.basename(f)));
      for (const fp of paths) if (!fs.existsSync(fp)) return sendJSON(res, 404, { ok: false, error: 'missing ' + path.basename(fp) });
      const ext = (body.format || 'mp4').replace(/[^a-z0-9]/gi, '');
      const outName = sanitizeName(body.outName || 'concat') + '.' + ext;
      const outPath = path.join(OUTPUTS, outName);
      const jobId = createJob();
      const built = buildConcat(paths, body.params || {}, outPath, jobId);
      sendJSON(res, 200, { ok: true, jobId, output: outName });
      let dur = 0;
      try {
        for (const fp of paths) dur += durationOf(await getInfo(fp));
      } catch (_) {}
      runFFmpeg(jobId, built.args, dur).catch(() => {}).finally(() => { if (built.cleanup) try { fs.unlinkSync(built.cleanup); } catch (_) {} });
      return;
    }

    // FILTER
    if (p === '/api/filter' && req.method === 'POST') {
      const body = await readBodyJSON(req);
      const src = path.join(UPLOADS, path.basename(body.file || ''));
      if (!fs.existsSync(src)) return sendJSON(res, 404, { ok: false, error: 'source file not found' });
      const ext = (body.format || 'mp4').replace(/[^a-z0-9]/gi, '');
      const outName = sanitizeName(body.outName || (path.parse(body.file).name + '_fx')) + '.' + ext;
      const outPath = path.join(OUTPUTS, outName);
      const args = buildFilter(src, body.params || {}, outPath);
      const jobId = createJob();
      sendJSON(res, 200, { ok: true, jobId, output: outName });
      let dur = 0;
      try { dur = durationOf(await getInfo(src)); } catch (_) {}
      runFFmpeg(jobId, args, dur).catch(() => {});
      return;
    }

    // extract audio only
    if (p === '/api/extract-audio' && req.method === 'POST') {
      const body = await readBodyJSON(req);
      const src = path.join(UPLOADS, path.basename(body.file || ''));
      if (!fs.existsSync(src)) return sendJSON(res, 404, { ok: false, error: 'source file not found' });
      const codec = body.codec || 'aac';
      const ext = codec === 'mp3' ? 'mp3' : codec === 'opus' ? 'opus' : codec === 'flac' ? 'flac' : 'm4a';
      const outName = sanitizeName(path.parse(body.file).name + '_audio') + '.' + ext;
      const outPath = path.join(OUTPUTS, outName);
      const args = ['-y', '-i', src, '-vn', '-c:a', codec, outPath];
      const jobId = createJob();
      sendJSON(res, 200, { ok: true, jobId, output: outName });
      let dur = 0;
      try { dur = durationOf(await getInfo(src)); } catch (_) {}
      runFFmpeg(jobId, args, dur).catch(() => {});
      return;
    }

    // SSE progress
    const prog = p.match(/^\/api\/progress\/([\w]+)$/);
    if (prog && req.method === 'GET') {
      return handleProgress(req, res, prog[1]);
    }

    // download
    const dl = p.match(/^\/api\/download\/([\w.\-一-龥 ]+)$/);
    if (dl && req.method === 'GET') {
      const fp = path.join(OUTPUTS, path.basename(decodeURIComponent(dl[1])));
      if (!fs.existsSync(fp)) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${path.basename(fp)}"`,
        'Content-Length': fs.statSync(fp).size
      });
      fs.createReadStream(fp).pipe(res);
      return;
    }

    // delete
    if (p === '/api/delete' && req.method === 'POST') {
      const body = await readBodyJSON(req);
      const where = body.area === 'outputs' ? OUTPUTS : UPLOADS;
      const fp = path.join(where, path.basename(body.name || ''));
      if (fs.existsSync(fp)) { fs.unlinkSync(fp); return sendJSON(res, 200, { ok: true }); }
      return sendJSON(res, 404, { ok: false });
    }

    res.writeHead(404); res.end('not found');
  } catch (e) {
    sendJSON(res, 500, { ok: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// utils
// ---------------------------------------------------------------------------
function fmtTime(sec) {
  if (!sec) return '0:00';
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}
function fpsOf(stream) {
  if (!stream) return null;
  if (stream.avg_frame_rate && stream.avg_frame_rate !== '0/0') {
    const [a, b] = stream.avg_frame_rate.split('/').map(Number);
    if (b) return +(a / b).toFixed(2);
  }
  return null;
}

// ---------------------------------------------------------------------------
function startServer() {
  const DATA_ROOT = process.env.FFMPEG_STUDIO_DATA || path.join(os.homedir(), '.ffmpeg-studio');
  UPLOADS = path.join(DATA_ROOT, 'uploads');
  OUTPUTS = path.join(DATA_ROOT, 'outputs');
  fs.mkdirSync(UPLOADS, { recursive: true });
  fs.mkdirSync(OUTPUTS, { recursive: true });
  return resolveTools().then(() => new Promise((resolve) => {
    server.listen(PORT, () => {
      console.log(`[ffmpeg-studio] running at http://localhost:${PORT}`);
      console.log(`[ffmpeg-studio] uploads : ${UPLOADS}`);
      console.log(`[ffmpeg-studio] outputs : ${OUTPUTS}`);
      resolve(server);
    });
  }));
}

// When run directly (node server.js) start immediately; when required by
// Electron's main.js, expose startServer() so the window can wait for it.
if (require.main === module) startServer();
module.exports = { startServer, PORT };
