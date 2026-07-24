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

// User-configurable directories (settings), persisted to config.json under DATA_ROOT.
let CONFIG = {};
let CONFIG_FILE = '';

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

// Detect which video encoders are actually available in this ffmpeg build.
// Used by the UI to populate the codec dropdown (exposes hardware encoders too).
function getEncoders() {
  return new Promise((resolve) => {
    const p = spawn(FF, ['-hide_banner', '-encoders'], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => {
      const known = [
        ['libx264', 'H.264 (libx264)', false],
        ['libx265', 'H.265 / HEVC (libx265)', false],
        ['libvpx-vp9', 'VP9 (libvpx-vp9)', false],
        ['libaom-av1', 'AV1 (libaom-av1)', false],
        ['libsvtav1', 'AV1 (SVT-AV1 · 极快)', false],
        ['libvpx', 'VP8 (libvpx)', false],
        ['mpeg4', 'MPEG-4', false],
        ['h264_nvenc', 'H.264 (NVIDIA NVENC 硬件)', true],
        ['hevc_nvenc', 'H.265 (NVIDIA NVENC 硬件)', true],
        ['av1_nvenc', 'AV1 (NVIDIA NVENC 硬件)', true],
        ['h264_amf', 'H.264 (AMD AMF 硬件)', true],
        ['hevc_amf', 'H.265 (AMD AMF 硬件)', true],
        ['av1_amf', 'AV1 (AMD AMF 硬件)', true],
        ['h264_qsv', 'H.264 (Intel QSV 硬件)', true],
        ['hevc_qsv', 'H.265 (Intel QSV 硬件)', true],
        ['av1_qsv', 'AV1 (Intel QSV 硬件)', true]
      ];
      const list = known
        .filter(([name]) => out.includes(name))
        .map(([name, label, hw]) => ({ name, label, hw, crf: true }));
      resolve(list);
    });
  });
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

  const crf = v.crf != null && v.crf !== '' && v.crf !== undefined ? String(v.crf) : null;
  const speed = v.preset || ''; // 前端传来的「速度档」：x264/x265 是预设名；SVT-AV1/VP9/AV1 是 cpu-used 数字

  // ---- 按编码器的「速度档」提速（核心优化）----
  if (codec === 'libx264') {
    if (crf) args.push('-crf', crf);
    args.push('-preset', speed || 'veryfast', '-threads', '0');
  } else if (codec === 'libx265') {
    if (crf) args.push('-crf', crf);
    args.push('-preset', speed || 'fast', '-tag:v', 'hvc1', '-threads', '0');
  } else if (codec === 'libsvtav1') {
    // SVT-AV1：比 libaom-av1 快 50~100 倍
    args.push('-preset', speed || '6', '-svtav1-params', 'fast-decode=1');
    if (crf) args.push('-crf', crf);
  } else if (codec === 'libvpx-vp9') {
    // VP9 默认极慢 → 实时模式 + cpu-used 提速数十倍
    args.push('-deadline', 'realtime', '-cpu-used', speed || '8', '-row-mt', '1', '-b:v', '0');
    if (crf) args.push('-crf', crf);
  } else if (codec === 'libaom-av1') {
    args.push('-cpu-used', speed || '4', '-row-mt', '1', '-b:v', '0');
    if (crf) args.push('-crf', crf);
  } else if (codec.endsWith('_nvenc')) {
    // NVIDIA 硬件编码：把 CRF 近似成恒定质量 cq
    args.push('-rc', 'vbr', '-cq', crf || '23', '-b:v', '0');
  } else if (codec.endsWith('_amf')) {
    // AMD 硬件编码
    args.push('-rc', 'cqp', '-qp', crf || '23');
  } else if (codec.endsWith('_qsv')) {
    // Intel 硬件编码
    args.push('-global_quality', crf || '23');
  } else if (codec === 'libvpx') {
    args.push('-deadline', 'realtime', '-cpu-used', speed || '8', '-b:v', '1M');
  } else if (codec === 'mpeg4' || codec === 'libxvid') {
    args.push('-b:v', (v.bitrate || 2000) + 'k');
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

    // available video encoders (incl. hardware)
    if (p === '/api/encoders' && req.method === 'GET') {
      return getEncoders().then((list) => sendJSON(res, 200, { encoders: list }));
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
      return sendJSON(res, 200, { uploads: listDir(UPLOADS), outputs: listDir(getOutputDir()), outputDir: getOutputDir() });
    }

    // settings: read current config + preset dirs
    if (p === '/api/config' && req.method === 'GET') {
      return sendJSON(res, 200, {
        outputDir: CONFIG.outputDir || '',
        inputDir: CONFIG.inputDir || '',
        deleteSourceAfter: !!CONFIG.deleteSourceAfter,
        effectiveOutput: getOutputDir(),
        presets: commonDirs()
      });
    }
    if (p === '/api/config' && req.method === 'POST') {
      const body = await readBodyJSON(req);
      const cfg = {};
      if (typeof body.outputDir === 'string' && body.outputDir.trim()) {
        const d = body.outputDir.trim();
        if (!fs.existsSync(d)) {
          try { fs.mkdirSync(d, { recursive: true }); } catch (_) { return sendJSON(res, 400, { ok: false, error: '输出目录无效或无法创建: ' + d }); }
        }
        cfg.outputDir = d;
      }
      if (typeof body.inputDir === 'string' && body.inputDir.trim()) {
        const d = body.inputDir.trim();
        if (!fs.existsSync(d)) return sendJSON(res, 400, { ok: false, error: '输入目录不存在: ' + d });
        cfg.inputDir = d;
      }
      cfg.deleteSourceAfter = !!body.deleteSourceAfter;
      saveConfig(cfg);
      return sendJSON(res, 200, {
        ok: true,
        outputDir: CONFIG.outputDir || '',
        inputDir: CONFIG.inputDir || '',
        deleteSourceAfter: !!CONFIG.deleteSourceAfter,
        effectiveOutput: getOutputDir()
      });
    }
    // list media files directly from the configured input directory (no copy)
    if (p === '/api/input-files' && req.method === 'GET') {
      if (!CONFIG.inputDir || !fs.existsSync(CONFIG.inputDir)) return sendJSON(res, 200, { files: [] });
      const exts = ['.mp4', '.mkv', '.mov', '.avi', '.m4v', '.webm', '.flv', '.ts', '.mpg', '.mpeg', '.wmv', '.3gp', '.m2ts'];
      const files = fs.readdirSync(CONFIG.inputDir)
        .filter((f) => exts.includes(path.extname(f).toLowerCase()))
        .map((f) => ({ name: f, path: path.join(CONFIG.inputDir, f), size: fs.statSync(path.join(CONFIG.inputDir, f)).size }));
      return sendJSON(res, 200, { files });
    }
    // wipe all uploaded source files
    if (p === '/api/clear-uploads' && req.method === 'POST') {
      let n = 0;
      for (const f of fs.readdirSync(UPLOADS)) { try { fs.unlinkSync(path.join(UPLOADS, f)); n++; } catch (_) {} }
      return sendJSON(res, 200, { ok: true, cleared: n });
    }

    // media info
    if (p === '/api/info' && req.method === 'POST') {
      const body = await readBodyJSON(req);
      const fp = resolveSource(body);
      if (!fp || !fs.existsSync(fp)) return sendJSON(res, 404, { ok: false, error: 'file not found' });
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
      const src = resolveSource(body);
      if (!src || !fs.existsSync(src)) return sendJSON(res, 404, { ok: false, error: 'source file not found' });
      const isUploaded = isInside(src, UPLOADS);
      const ext = (body.format || 'mp4').replace(/[^a-z0-9]/gi, '');
      const outName = sanitizeName((body.outName || path.parse(src).name + '_out')) + '.' + ext;
      const outPath = path.join(getOutputDir(), outName);
      const args = buildTranscode(src, body.params || {}, outPath);
      const jobId = createJob();
      sendJSON(res, 200, { ok: true, jobId, output: outName });
      let dur = 0;
      try { dur = durationOf(await getInfo(src)); } catch (_) {}
      runFFmpeg(jobId, args, dur).catch(() => {}).finally(() => {
        if (CONFIG.deleteSourceAfter && isUploaded) { try { fs.unlinkSync(src); } catch (_) {} }
      });
      return;
    }

    // CONCAT
    if (p === '/api/concat' && req.method === 'POST') {
      const body = await readBodyJSON(req);
      if (!body.files || !body.files.length) return sendJSON(res, 400, { ok: false, error: 'no files' });
      const paths = body.files.map((f) => resolveSource(typeof f === 'string' ? { file: f } : f));
      for (const fp of paths) if (!fp || !fs.existsSync(fp)) return sendJSON(res, 404, { ok: false, error: 'missing file' });
      const uploaded = paths.filter((fp) => isInside(fp, UPLOADS));
      const ext = (body.format || 'mp4').replace(/[^a-z0-9]/gi, '');
      const outName = sanitizeName(body.outName || 'concat') + '.' + ext;
      const outPath = path.join(getOutputDir(), outName);
      const jobId = createJob();
      const built = buildConcat(paths, body.params || {}, outPath, jobId);
      sendJSON(res, 200, { ok: true, jobId, output: outName });
      let dur = 0;
      try {
        for (const fp of paths) dur += durationOf(await getInfo(fp));
      } catch (_) {}
      runFFmpeg(jobId, built.args, dur).catch(() => {}).finally(() => {
        if (built.cleanup) try { fs.unlinkSync(built.cleanup); } catch (_) {}
        if (CONFIG.deleteSourceAfter) for (const fp of uploaded) { try { fs.unlinkSync(fp); } catch (_) {} }
      });
      return;
    }

    // FILTER
    if (p === '/api/filter' && req.method === 'POST') {
      const body = await readBodyJSON(req);
      const src = resolveSource(body);
      if (!src || !fs.existsSync(src)) return sendJSON(res, 404, { ok: false, error: 'source file not found' });
      const isUploaded = isInside(src, UPLOADS);
      const ext = (body.format || 'mp4').replace(/[^a-z0-9]/gi, '');
      const outName = sanitizeName(body.outName || (path.parse(src).name + '_fx')) + '.' + ext;
      const outPath = path.join(getOutputDir(), outName);
      const args = buildFilter(src, body.params || {}, outPath);
      const jobId = createJob();
      sendJSON(res, 200, { ok: true, jobId, output: outName });
      let dur = 0;
      try { dur = durationOf(await getInfo(src)); } catch (_) {}
      runFFmpeg(jobId, args, dur).catch(() => {}).finally(() => {
        if (CONFIG.deleteSourceAfter && isUploaded) { try { fs.unlinkSync(src); } catch (_) {} }
      });
      return;
    }

    // extract audio only
    if (p === '/api/extract-audio' && req.method === 'POST') {
      const body = await readBodyJSON(req);
      const src = resolveSource(body);
      if (!src || !fs.existsSync(src)) return sendJSON(res, 404, { ok: false, error: 'source file not found' });
      const isUploaded = isInside(src, UPLOADS);
      const codec = body.codec || 'aac';
      const ext = codec === 'mp3' ? 'mp3' : codec === 'opus' ? 'opus' : codec === 'flac' ? 'flac' : 'm4a';
      const outName = sanitizeName(path.parse(src).name + '_audio') + '.' + ext;
      const outPath = path.join(getOutputDir(), outName);
      const args = ['-y', '-i', src, '-vn', '-c:a', codec, outPath];
      const jobId = createJob();
      sendJSON(res, 200, { ok: true, jobId, output: outName });
      let dur = 0;
      try { dur = durationOf(await getInfo(src)); } catch (_) {}
      runFFmpeg(jobId, args, dur).catch(() => {}).finally(() => {
        if (CONFIG.deleteSourceAfter && isUploaded) { try { fs.unlinkSync(src); } catch (_) {} }
      });
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
      const name = path.basename(decodeURIComponent(dl[1]));
      let fp = path.join(getOutputDir(), name);
      if (!fs.existsSync(fp)) fp = path.join(OUTPUTS, name);
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
      const where = body.area === 'outputs' ? getOutputDir() : UPLOADS;
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
// User-configurable directories (settings)
// ---------------------------------------------------------------------------
function isInside(child, parent) {
  const a = path.resolve(child).toLowerCase();
  const b = path.resolve(parent).toLowerCase();
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch (_) { return {}; }
}
function saveConfig(cfg) {
  CONFIG = Object.assign({}, CONFIG, cfg);
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(CONFIG, null, 2)); } catch (_) {}
}
function getOutputDir() {
  if (CONFIG.outputDir && fs.existsSync(CONFIG.outputDir)) return CONFIG.outputDir;
  return OUTPUTS;
}
// Resolve a source from request body: either an uploaded file (by name) or an
// absolute path inside the configured input dir. Rejects traversal attempts.
function resolveSource(body) {
  if (body && body.source && (path.isAbsolute(body.source) || body.source.includes(path.sep))) {
    const sp = path.resolve(body.source);
    const base = (CONFIG.inputDir && fs.existsSync(CONFIG.inputDir)) ? path.resolve(CONFIG.inputDir) : null;
    const up = path.resolve(UPLOADS);
    if ((base && isInside(sp, base)) || isInside(sp, up)) return sp;
    return null;
  }
  return path.join(UPLOADS, path.basename((body && body.file) || ''));
}
// Common user folders offered as presets in the settings UI.
function commonDirs() {
  const h = os.homedir();
  const candidates = {
    desktop: path.join(h, 'Desktop'),
    documents: path.join(h, 'Documents'),
    videos: path.join(h, 'Videos'),
    downloads: path.join(h, 'Downloads'),
    music: path.join(h, 'Music'),
    home: h
  };
  const out = {};
  for (const [k, v] of Object.entries(candidates)) if (fs.existsSync(v)) out[k] = v;
  return out;
}

// ---------------------------------------------------------------------------
function startServer() {
  const DATA_ROOT = process.env.FFMPEG_STUDIO_DATA || path.join(os.homedir(), '.ffmpeg-studio');
  UPLOADS = path.join(DATA_ROOT, 'uploads');
  OUTPUTS = path.join(DATA_ROOT, 'outputs');
  fs.mkdirSync(UPLOADS, { recursive: true });
  fs.mkdirSync(OUTPUTS, { recursive: true });
  CONFIG_FILE = path.join(DATA_ROOT, 'config.json');
  CONFIG = loadConfig();
  return resolveTools().then(() => new Promise((resolve, reject) => {
    let attemptPort = PORT;
    const MAX_PORT = PORT + 100; // 端口被占用时最多顺延 100 个，避免启动失败
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && attemptPort < MAX_PORT) {
        console.warn(`[ffmpeg-studio] 端口 ${attemptPort} 被占用，自动尝试 ${attemptPort + 1}`);
        attemptPort++;
        server.listen(attemptPort);
      } else {
        reject(err);
      }
    });
    server.listen(attemptPort, () => {
      if (attemptPort !== PORT) {
        console.warn(`[ffmpeg-studio] 已在端口 ${attemptPort} 启动（默认 ${PORT} 不可用）`);
      }
      console.log(`[ffmpeg-studio] running at http://localhost:${attemptPort}`);
      console.log(`[ffmpeg-studio] uploads : ${UPLOADS}`);
      console.log(`[ffmpeg-studio] outputs : ${OUTPUTS}`);
      resolve({ server, port: attemptPort });
    });
  }));
}

// When run directly (node server.js) start immediately; when required by
// Electron's main.js, expose startServer() so the window can wait for it.
if (require.main === module) startServer();
module.exports = { startServer, PORT };
