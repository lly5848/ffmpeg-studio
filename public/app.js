'use strict';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const api = (path, opts) => fetch(path, opts);
const postJSON = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function toast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + type;
  t.hidden = false;
  clearTimeout(t._t);
  t._t = setTimeout(() => (t.hidden = true), 2600);
}

function fmtSize(b) {
  if (!b) return '';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}
function fmtTime(sec) {
  if (!sec) return '0:00';
  sec = Math.round(sec);
  const s = sec % 60, m = Math.floor(sec / 60) % 60, h = Math.floor(sec / 3600);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let FILES = { uploads: [], outputs: [] };

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
  checkStatus();
  loadFiles();
  loadConfig();
  wireTabs();
  wireDropzone();
  wireTranscode();
  wireConcat();
  wireFilter();
  wireInfo();
  wireSettings();
  loadEncoders();
  tickClock();
});

async function checkStatus() {
  try {
    const r = await api('/api/status');
    const d = await r.json();
    const el = $('#ffStatus');
    if (d.ok && d.ffmpeg) {
      el.textContent = '● ffmpeg 已就绪';
      el.className = 'status-pill ok';
    } else {
      el.textContent = '● ffmpeg 未找到';
      el.className = 'status-pill bad';
    }
  } catch {
    $('#ffStatus').textContent = '● 服务未连接';
    $('#ffStatus').className = 'status-pill bad';
  }
}

function tickClock() {
  const c = $('#clock');
  const upd = () => (c.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false }));
  upd();
  setInterval(upd, 1000);
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------
async function loadFiles() {
  try {
    const r = await api('/api/files');
    FILES = await r.json();
  } catch {
    FILES = { uploads: [], outputs: [] };
  }
  renderTray();
  renderConcatList();
  populateSelects();
}

function renderTray() {
  const tray = $('#tray');
  tray.innerHTML = '';
  if (!FILES.uploads.length) {
    tray.innerHTML = '<li class="muted" style="cursor:default">暂无文件，拖放视频到此处</li>';
  }
  FILES.uploads.forEach((name) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="nm" title="${name}">🎞 ${name}</span>`;
    li.onclick = () => useFile(name);
    const del = document.createElement('span');
    del.className = 'del';
    del.textContent = '删除';
    del.onclick = async (e) => {
      e.stopPropagation();
      await postJSON('/api/delete', { area: 'uploads', name });
      loadFiles();
    };
    li.appendChild(del);
    tray.appendChild(li);
  });

  const out = $('#outTray');
  out.innerHTML = '';
  if (!FILES.outputs.length) out.innerHTML = '<li class="muted" style="cursor:default">暂无输出</li>';
  FILES.outputs.forEach((name) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="nm" title="${name}">✅ ${name}</span>
      <span class="meta"><a href="/api/download/${encodeURIComponent(name)}" target="_blank">下载</a> · <span class="del" data-n="${name}">删除</span></span>`;
    li.querySelector('.del').onclick = async (e) => {
      e.stopPropagation();
      await postJSON('/api/delete', { area: 'outputs', name });
      loadFiles();
    };
    out.appendChild(li);
  });
}

function populateSelects() {
  const upOpts = FILES.uploads.map((n) => `<option value="${n}">${n}</option>`).join('');
  const inOpts = (window._INPUTFILES && window._INPUTFILES.length)
    ? `<optgroup label="输入目录">${window._INPUTFILES.map((f) => `<option value="${f.path}">📂 ${f.name}</option>`).join('')}</optgroup>`
    : '';
  const opts = upOpts + inOpts || '<option value="">（无文件）</option>';
  ['#tcSrc', '#fxSrc', '#infoSrc'].forEach((s) => {
    const el = $(s);
    const cur = el.value;
    el.innerHTML = opts;
    const inPaths = (window._INPUTFILES || []).map((f) => f.path);
    if (cur && (FILES.uploads.includes(cur) || inPaths.includes(cur))) el.value = cur;
  });
  updateCmdPreviews();
}

// A source select value may be either an uploaded file name or an absolute
// path from the input directory. Convert to the right request field.
function srcField(val) { return /[\\/]/.test(val) ? { source: val } : { file: val }; }
function baseName(val) { return String(val).split(/[\\/]/).pop(); }

function useFile(name) {
  // default: load into transcode + filter + info source
  ['#tcSrc', '#fxSrc', '#infoSrc'].forEach((s) => { const el = $(s); if (FILES.uploads.includes(name)) el.value = name; });
  toast('已选择：' + name);
  updateCmdPreviews();
}

// ---------------------------------------------------------------------------
// Dropzone / upload
// ---------------------------------------------------------------------------
function wireDropzone() {
  const dz = $('#globalDrop');
  const input = $('#fileInput');
  dz.onclick = () => input.click();
  input.onchange = () => { if (input.files.length) uploadFiles(input.files); input.value = ''; };
  ;['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ;['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', (e) => {
    if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
  });
  // allow dropping anywhere
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.target.closest('#globalDrop')) return;
    if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
  });
  $('#refreshFiles').onclick = () => loadFiles();
}

async function uploadFiles(fileList) {
  const files = Array.from(fileList);
  toast(`上传中… (${files.length} 个)`);
  for (const f of files) {
    try {
      await fetch('/api/upload?name=' + encodeURIComponent(f.name), { method: 'POST', body: f });
    } catch (e) {
      toast('上传失败: ' + f.name, 'err');
    }
  }
  await loadFiles();
  toast('上传完成', 'ok');
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function wireTabs() {
  $$('.tab').forEach((t) => {
    t.onclick = () => {
      $$('.tab').forEach((x) => x.classList.remove('active'));
      $$('.panel').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      $(`.panel[data-panel="${t.dataset.tab}"]`).classList.add('active');
    };
  });
}

// ---------------------------------------------------------------------------
// Command preview helpers
// ---------------------------------------------------------------------------
function esc(s) { return s; }
function highlightCmd(str) {
  // crude highlighting: flags in warn color
  return str.replace(/(^|\s)(-[\w]+)/g, '$1<span class="tk">$2</span>');
}

// ---------------------------------------------------------------------------
// TRANSCODE
// ---------------------------------------------------------------------------
function wireTranscode() {
  ['#tcVcodec', '#tcCrf', '#tcPreset', '#tcRes', '#tcFps', '#tcFormat', '#tcAcodec', '#tcAbr', '#tcFaststart', '#tcSrc'].forEach((s) => {
    $(s).addEventListener('input', () => { $('#tcCrfVal').textContent = $('#tcCrf').value; updateCmdPreviews(); });
    $(s).addEventListener('change', updateCmdPreviews);
  });
  $('#tcVcodec').addEventListener('change', onVcodecChange);
  $('#tcCrf').addEventListener('input', () => ($('#tcCrfVal').textContent = $('#tcCrf').value));
  $('#tcRun').onclick = runTranscode;
  $('#tcReset').onclick = () => location.reload();
}

// ---------------------------------------------------------------------------
// Encoder detection (fills transcode codec dropdown, incl. hardware)
// ---------------------------------------------------------------------------
const SPEED_MAP = {
  libx264: { type: 'preset', def: 'veryfast', opts: ['ultrafast', 'superfast', 'veryfast', 'fast', 'medium', 'slow', 'slower', 'veryslow'] },
  libx265: { type: 'preset', def: 'fast', opts: ['ultrafast', 'superfast', 'veryfast', 'fast', 'medium', 'slow', 'slower', 'veryslow'] },
  libsvtav1: { type: 'preset', def: '6', opts: [['12', '极速'], ['10', '很快'], ['8', '快'], ['6', '均衡(推荐)'], ['4', '较慢'], ['2', '最慢']] },
  'libvpx-vp9': { type: 'cpu', def: '8', opts: [['8', '极速'], ['6', '快'], ['4', '均衡'], ['2', '慢'], ['0', '最慢']] },
  'libaom-av1': { type: 'cpu', def: '4', opts: [['8', '极速'], ['6', '快'], ['4', '均衡(推荐)'], ['2', '慢'], ['0', '最慢']] }
};

async function loadEncoders() {
  try {
    const r = await api('/api/encoders');
    const d = await r.json();
    if (d.encoders && d.encoders.length) window._ENCODERS = d.encoders;
  } catch (_) { /* 用静态兜底 */ }
  populateVcodecs();
}

function populateVcodecs() {
  const el = $('#tcVcodec');
  const cur = el.value;
  const encs = window._ENCODERS || [
    { name: 'libx264', label: 'H.264 (libx264)' },
    { name: 'libx265', label: 'H.265 / HEVC' },
    { name: 'libvpx-vp9', label: 'VP9' },
    { name: 'libaom-av1', label: 'AV1' },
    { name: 'mpeg4', label: 'MPEG-4' }
  ];
  const sw = encs.filter((e) => !e.hw);
  let html = sw.map((e) => `<option value="${e.name}">${e.label}</option>`).join('');
  const hw = encs.filter((e) => e.hw);
  if (hw.length) html += '<optgroup label="硬件加速">' + hw.map((e) => `<option value="${e.name}">${e.label}</option>`).join('') + '</optgroup>';
  html += '<option value="copy">直接复制 (不重编码)</option>';
  el.innerHTML = html;
  if (cur && encs.find((e) => e.name === cur)) el.value = cur;
  onVcodecChange();
}

function isHardware(codec) {
  return codec.endsWith('_nvenc') || codec.endsWith('_amf') || codec.endsWith('_qsv');
}

// Rebuild the "speed" selector to match the chosen codec.
function onVcodecChange() {
  const codec = $('#tcVcodec').value;
  const presetSel = $('#tcPreset');
  const row = presetSel.closest('.row');
  const cfg = SPEED_MAP[codec];
  if (!cfg || codec === 'copy' || isHardware(codec)) {
    row.style.display = 'none';
    presetSel.innerHTML = '';
  } else {
    row.style.display = '';
    presetSel.innerHTML = cfg.opts.map((o) => {
      const [val, lab] = Array.isArray(o) ? o : [o, o];
      return `<option value="${val}"${val === cfg.def ? ' selected' : ''}>${lab}</option>`;
    }).join('');
    const lbl = $('#tcPresetLabel');
    if (lbl) lbl.textContent = cfg.type === 'cpu' ? '速度档 (cpu-used)' : '预设速度';
  }
  updateCmdPreviews();
}

function buildTranscodeCmd() {
  const src = $('#tcSrc').value;
  if (!src) return '（请先选择源文件）';
  const disp = baseName(src);
  const fmt = $('#tcFormat').value;
  const vcodec = $('#tcVcodec').value;
  const crf = $('#tcCrf').value;
  const preset = $('#tcPreset').value;
  const res = $('#tcRes').value;
  const fps = $('#tcFps').value;
  const acodec = $('#tcAcodec').value;
  const abr = $('#tcAbr').value;
  const fast = $('#tcFaststart').checked;
  const out = sanitize(disp) + '_out.' + fmt;

  const args = ['-y', '-i', `"${src}"`];
  if (vcodec !== 'copy') args.push('-c:v', vcodec);

  if (vcodec === 'libx264') {
    args.push('-crf', crf, '-preset', preset || 'veryfast', '-threads', '0');
  } else if (vcodec === 'libx265') {
    args.push('-crf', crf, '-preset', preset || 'fast', '-tag:v', 'hvc1', '-threads', '0');
  } else if (vcodec === 'libsvtav1') {
    args.push('-preset', preset || '6', '-svtav1-params', 'fast-decode=1');
    if (crf) args.push('-crf', crf);
  } else if (vcodec === 'libvpx-vp9') {
    args.push('-deadline', 'realtime', '-cpu-used', preset || '8', '-row-mt', '1', '-b:v', '0');
    if (crf) args.push('-crf', crf);
  } else if (vcodec === 'libaom-av1') {
    args.push('-cpu-used', preset || '4', '-row-mt', '1', '-b:v', '0');
    if (crf) args.push('-crf', crf);
  } else if (vcodec.endsWith('_nvenc')) {
    args.push('-rc', 'vbr', '-cq', crf || '23', '-b:v', '0');
  } else if (vcodec.endsWith('_amf')) {
    args.push('-rc', 'cqp', '-qp', crf || '23');
  } else if (vcodec.endsWith('_qsv')) {
    args.push('-global_quality', crf || '23');
  } else if (vcodec === 'libvpx') {
    args.push('-deadline', 'realtime', '-cpu-used', preset || '8', '-b:v', '1M');
  } else if (vcodec === 'mpeg4' || vcodec === 'libxvid') {
    args.push('-b:v', '2000k');
  }

  if (res !== 'original') args.push('-vf', `scale=${res.replace('x', ':')}`);
  if (fps) args.push('-r', fps);
  if (acodec === 'none') args.push('-an');
  else { args.push('-c:a', acodec === 'copy' ? 'copy' : acodec); if (acodec !== 'copy' && abr) args.push('-b:a', abr + 'k'); }
  if (fast && fmt === 'mp4') args.push('-movflags', '+faststart');
  args.push(`"${out}"`);
  return `ffmpeg ${args.join(' ')}`;
}

function sanitize(name) { return (name || 'output').replace(/\.[^.]+$/, '').replace(/[^\w一-龥\-]/g, '_'); }

// ---------------------------------------------------------------------------
// CONCAT
// ---------------------------------------------------------------------------
let ccOrder = []; // filenames in display order
function renderConcatList() {
  const wrap = $('#ccList');
  // keep existing order, append new files
  const known = new Set(ccOrder);
  FILES.uploads.forEach((n) => { if (!known.has(n)) ccOrder.push(n); });
  ccOrder = ccOrder.filter((n) => FILES.uploads.includes(n));

  wrap.innerHTML = '';
  if (!ccOrder.length) { wrap.innerHTML = '<p class="muted">媒体库暂无文件</p>'; return; }
  ccOrder.forEach((name, idx) => {
    const item = document.createElement('div');
    item.className = 'cc-item';
    item.innerHTML = `
      <span class="ord">${idx + 1}</span>
      <input type="checkbox" ${FILES._ccChecked && FILES._ccChecked.has(name) ? 'checked' : ''} data-n="${name}" />
      <span class="nm" title="${name}">${name}</span>
      <button class="mv" data-dir="up" title="上移">▲</button>
      <button class="mv" data-dir="down" title="下移">▼</button>`;
    item.querySelector('input').addEventListener('change', () => { updateCmdPreviews(); });
    item.querySelector('[data-dir="up"]').onclick = () => moveItem(idx, -1);
    item.querySelector('[data-dir="down"]').onclick = () => moveItem(idx, 1);
    wrap.appendChild(item);
  });
}

function moveItem(idx, dir) {
  const j = idx + dir;
  if (j < 0 || j >= ccOrder.length) return;
  [ccOrder[idx], ccOrder[j]] = [ccOrder[j], ccOrder[idx]];
  renderConcatList();
  updateCmdPreviews();
}

function getCheckedConcat() {
  const set = new Set();
  $$('#ccList input[type="checkbox"]').forEach((c) => { if (c.checked) set.add(c.dataset.n); });
  FILES._ccChecked = set;
  return ccOrder.filter((n) => set.has(n));
}

function buildConcatCmd() {
  const sel = getCheckedConcat();
  const method = $('#ccMethod').value;
  const fmt = $('#ccFormat').value;
  const out = ($('#ccName').value || 'merged') + '.' + fmt;
  if (!sel.length) return '（请在媒体库勾选至少 2 个文件）';
  if (method === 'demuxer') {
    const list = sel.map((n) => `file '${n}'`).join('\n');
    return `# concat list.txt\n${list}\n\nffmpeg -y -f concat -safe 0 -i list.txt -c copy "${out}"`;
  }
  const inputs = sel.map((n) => `-i "${n}"`).join(' ');
  const maps = sel.map((_, i) => `[${i}:v][${i}:a]`).join('');
  return `ffmpeg -y ${inputs} -filter_complex "${maps}concat=n=${sel.length}:v=1:a=1[outv][outa]" -map "[outv]" -map "[outa]" -c:v libx264 -c:a aac "${out}"`;
}

function wireConcat() {
  ['#ccMethod', '#ccFormat', '#ccName'].forEach((s) => $(s).addEventListener('input', updateCmdPreviews));
  $('#ccRun').onclick = runConcat;
}

// ---------------------------------------------------------------------------
// FILTER
// ---------------------------------------------------------------------------
function wireFilter() {
  const ids = ['#fxScale', '#fxRotate', '#fxFlip', '#fxCropW', '#fxCropH', '#fxCropX', '#fxCropY', '#fxDenoise',
    '#fxBright', '#fxContrast', '#fxSpeed', '#fxFadeIn', '#fxFadeOut', '#fxWmText', '#fxFormat', '#fxVcodec', '#fxAudio', '#fxSrc'];
  ids.forEach((s) => {
    $(s).addEventListener('input', () => {
      $('#fxBrightVal').textContent = $('#fxBright').value;
      $('#fxContrastVal').textContent = $('#fxContrast').value;
      $('#fxSpeedVal').textContent = $('#fxSpeed').value;
      updateCmdPreviews();
    });
    $(s).addEventListener('change', updateCmdPreviews);
  });
  $('#fxRun').onclick = runFilter;
  $('#fxExtract').onclick = runExtract;
}

function buildFilterCmd() {
  const src = $('#fxSrc').value;
  if (!src) return '（请先选择源文件）';
  const disp = baseName(src);
  const filters = [];
  const scale = $('#fxScale').value;
  if (scale !== 'original') filters.push(`scale=${scale.replace('x', ':')}`);
  const rot = $('#fxRotate').value;
  if (rot === '90') filters.push('transpose=1');
  else if (rot === '180') filters.push('transpose=1,transpose=1');
  else if (rot === '270') filters.push('transpose=2');
  const flip = $('#fxFlip').value;
  if (flip === 'h') filters.push('hflip');
  else if (flip === 'v') filters.push('vflip');
  const cw = $('#fxCropW').value, ch = $('#fxCropH').value;
  if (cw && ch) filters.push(`crop=${cw}:${ch}:${$('#fxCropX').value || 0}:${$('#fxCropY').value || 0}`);
  if ($('#fxDenoise').checked) filters.push('hqdn3d');
  const bright = parseFloat($('#fxBright').value);
  const contrast = parseFloat($('#fxContrast').value);
  if (bright !== 0 || contrast !== 1) filters.push(`eq=brightness=${bright.toFixed(2)}:contrast=${contrast.toFixed(2)}`);
  const speed = parseFloat($('#fxSpeed').value);
  if (speed !== 1) filters.push(`setpts=${(1 / speed).toFixed(3)}*PTS`);
  const fi = parseFloat($('#fxFadeIn').value) || 0;
  const fo = parseFloat($('#fxFadeOut').value) || 0;
  if (fi) filters.push(`fade=t=in:st=0:d=${fi}`);
  if (fo) filters.push(`fade=t=out:st=...:d=${fo}  (需视频时长)`);
  const wm = $('#fxWmText').value.trim();
  if (wm) filters.push(`drawtext=text='${wm}':fontcolor=white:fontsize=28:x=w-tw-20:y=h-th-20`);
  const fmt = $('#fxFormat').value;
  const vcodec = $('#fxVcodec').value;
  const audio = $('#fxAudio').value;
  const out = sanitize(disp) + '_fx.' + fmt;

  const args = ['-y', '-i', `"${src}"`];
  if (filters.length) args.push('-vf', `"${filters.join(',')}"`);
  if (audio === 'none') args.push('-an');
  else if (audio === 'copy') args.push('-c:a', 'copy');
  else args.push('-c:a', audio);
  if (vcodec !== 'copy') args.push('-c:v', vcodec);
  args.push(`"${out}"`);
  return `ffmpeg ${args.join(' ')}`;
}

// ---------------------------------------------------------------------------
// INFO
// ---------------------------------------------------------------------------
function wireInfo() {
  $('#infoBtn').onclick = showInfo;
}
async function showInfo() {
  const f = $('#infoSrc').value;
  const out = $('#infoOut');
  if (!f) { out.textContent = '请选择文件'; return; }
  out.innerHTML = '查询中…';
  try {
    const r = await postJSON('/api/info', srcField(f));
    const d = await r.json();
    if (!d.ok) { out.textContent = '失败: ' + d.error; return; }
    const rows = [];
    rows.push(['文件名', f]);
    rows.push(['时长', d.durationStr + ` (${d.duration.toFixed(2)}s)`]);
    if (d.format) {
      rows.push(['封装格式', d.format.format]);
      rows.push(['文件大小', fmtSize(d.format.size)]);
      rows.push(['总码率', d.format.bitrate ? (d.format.bitrate / 1000).toFixed(0) + ' kbps' : '—']);
    }
    if (d.video) {
      rows.push(['视频编码', d.video.codec]);
      rows.push(['分辨率', d.video.w + '×' + d.video.h]);
      rows.push(['帧率', d.video.fps || '—']);
      rows.push(['像素格式', d.video.pixfmt || '—']);
    }
    if (d.audio) {
      rows.push(['音频编码', d.audio.codec]);
      rows.push(['采样率', d.audio.rate + ' Hz']);
      rows.push(['声道', d.audio.channels]);
    }
    out.innerHTML = `<div class="kv">${rows.map(([k, v]) => `<div class="k">${k}</div><div>${v}</div>`).join('')}</div>
      <details><summary style="cursor:pointer;color:var(--accent)">查看完整 ffprobe JSON</summary><pre>${escapeHtml(JSON.stringify(d.raw, null, 2))}</pre></details>`;
  } catch (e) {
    out.textContent = '错误: ' + e.message;
  }
}
function escapeHtml(s) { return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

// ---------------------------------------------------------------------------
// Command preview dispatcher
// ---------------------------------------------------------------------------
function updateCmdPreviews() {
  $('#tcCmd').innerHTML = highlightCmd(buildTranscodeCmd());
  $('#ccCmd').innerHTML = highlightCmd(buildConcatCmd());
  $('#fxCmd').innerHTML = highlightCmd(buildFilterCmd());
}

// ---------------------------------------------------------------------------
// Job runner
// ---------------------------------------------------------------------------
function runJob(endpoint, payload, ui) {
  const { runBtn, progressWrap, fill, pct, log } = ui;
  runBtn.disabled = true;
  log.innerHTML = '';
  progressWrap.hidden = false;
  fill.style.width = '0%';
  pct.textContent = '0%';

  function append(text, cls) {
    const div = document.createElement('div');
    if (cls) div.className = cls;
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  postJSON(endpoint, payload).then(async (r) => {
    const d = await r.json();
    if (!d.ok) { append('❌ ' + (d.error || '启动失败'), 'err'); runBtn.disabled = false; return; }
    append('▶ 任务 ' + d.jobId + ' 开始');
    const es = new EventSource('/api/progress/' + d.jobId);
    let lastPct = 0;
    es.addEventListener('progress', (e) => {
      const p = JSON.parse(e.data).pct;
      if (p != null) { fill.style.width = p + '%'; pct.textContent = p + '%'; }
    });
    es.addEventListener('log', (e) => {
      const line = JSON.parse(e.data).line;
      const cls = /error|invalid|could not/i.test(line) ? 'err' : '';
      append(line.trim(), cls);
    });
    es.addEventListener('done', () => {
      es.close();
      fill.style.width = '100%';
      pct.textContent = '100%';
      append('✅ 完成，输出：' + d.output, 'ok');
      append(`下载：<a href="/api/download/${encodeURIComponent(d.output)}" target="_blank" style="color:var(--accent)">${d.output}</a>`);
      runBtn.disabled = false;
      loadFiles();
      toast('处理完成：' + d.output, 'ok');
    });
    es.addEventListener('error', (e) => {
      es.close();
      try {
        const data = JSON.parse(e.data);
        append('❌ ' + (data.message || '失败'), 'err');
        if (data.log) append(data.log, 'err');
      } catch (_) { append('❌ 连接中断', 'err'); }
      runBtn.disabled = false;
    });
    es.onerror = () => { /* handled by event */ };
  }).catch((e) => { append('❌ ' + e.message, 'err'); runBtn.disabled = false; });
}

// ---------------------------------------------------------------------------
// Run handlers
// ---------------------------------------------------------------------------
function runTranscode() {
  const src = $('#tcSrc').value;
  if (!src) return toast('请先选择源文件', 'err');
  const base = baseName(src);
  runJob('/api/transcode', {
    ...srcField(src),
    format: $('#tcFormat').value,
    outName: sanitize(base) + '_out',
    params: {
      video: {
        codec: $('#tcVcodec').value,
        crf: $('#tcCrf').value,
        preset: $('#tcPreset').value,
        resolution: $('#tcRes').value,
        fps: $('#tcFps').value || undefined
      },
      audio: {
        codec: $('#tcAcodec').value === 'none' ? 'copy' : $('#tcAcodec').value,
        bitrate: $('#tcAcodec').value === 'none' ? undefined : $('#tcAbr').value,
        mute: $('#tcAcodec').value === 'none'
      },
      faststart: $('#tcFaststart').checked
    }
  }, { runBtn: $('#tcRun'), progressWrap: $('#tcProgress'), fill: $('#tcFill'), pct: $('#tcPct'), log: $('#tcLog') });
}

function runConcat() {
  const sel = getCheckedConcat();
  if (sel.length < 2) return toast('请勾选至少 2 个文件', 'err');
  runJob('/api/concat', {
    files: sel,
    format: $('#ccFormat').value,
    outName: $('#ccName').value || 'merged',
    params: { method: $('#ccMethod').value }
  }, { runBtn: $('#ccRun'), progressWrap: $('#ccProgress'), fill: $('#ccFill'), pct: $('#ccPct'), log: $('#ccLog') });
}

function runFilter() {
  const src = $('#fxSrc').value;
  if (!src) return toast('请先选择源文件', 'err');
  const base = baseName(src);
  const params = {
    scale: $('#fxScale').value,
    rotate: $('#fxRotate').value,
    fliph: $('#fxFlip').value === 'h',
    flipv: $('#fxFlip').value === 'v',
    crop: ($('#fxCropW').value && $('#fxCropH').value) ? { w: $('#fxCropW').value, h: $('#fxCropH').value, x: $('#fxCropX').value || 0, y: $('#fxCropY').value || 0 } : undefined,
    denoise: $('#fxDenoise').checked,
    brightness: parseFloat($('#fxBright').value),
    contrast: parseFloat($('#fxContrast').value),
    speed: parseFloat($('#fxSpeed').value),
    fadein: parseFloat($('#fxFadeIn').value) || 0,
    fadeout: parseFloat($('#fxFadeOut').value) || 0,
    watermarkText: $('#fxWmText').value.trim(),
    videoCodec: $('#fxVcodec').value,
    audioCodec: $('#fxAudio').value === 'copy' ? 'copy' : $('#fxAudio').value,
    mute: $('#fxAudio').value === 'none'
  };
  runJob('/api/filter', { ...srcField(src), format: $('#fxFormat').value, outName: sanitize(base) + '_fx', params },
    { runBtn: $('#fxRun'), progressWrap: $('#fxProgress'), fill: $('#fxFill'), pct: $('#fxPct'), log: $('#fxLog') });
}

function runExtract() {
  const src = $('#fxSrc').value;
  if (!src) return toast('请先选择源文件', 'err');
  runJob('/api/extract-audio', { file: src, codec: 'aac' },
    { runBtn: $('#fxExtract'), progressWrap: $('#fxProgress'), fill: $('#fxFill'), pct: $('#fxPct'), log: $('#fxLog') });
}

// ---------------------------------------------------------------------------
// SETTINGS (custom input/output dirs + cleanup)
// ---------------------------------------------------------------------------
function wireSettings() {
  $('#setSaveOutput').onclick = () => saveConfigField('outputDir', $('#setOutput').value);
  $('#setSaveInput').onclick = () => saveConfigField('inputDir', $('#setInput').value);
  $('#setSaveAll').onclick = async () => {
    const r = await postJSON('/api/config', {
      outputDir: $('#setOutput').value,
      inputDir: $('#setInput').value,
      deleteSourceAfter: $('#setDelSrc').checked
    });
    const d = await r.json();
    if (d.ok) { toast('设置已保存', 'ok'); window._CFG = d; renderCfgInfo(); loadInputFiles(); }
    else toast('保存失败: ' + (d.error || ''), 'err');
  };
  $('#setClearUploads').onclick = async () => {
    if (!confirm('确定清空上传文件夹里的所有原视频？此操作不可恢复。')) return;
    const r = await postJSON('/api/clear-uploads', {});
    const d = await r.json();
    if (d.ok) { toast('已清空 ' + d.cleared + ' 个文件', 'ok'); loadFiles(); }
  };
  $('#setOutputPreset').onchange = () => { if ($('#setOutputPreset').value) $('#setOutput').value = $('#setOutputPreset').value; };
  $('#setInputPreset').onchange = () => { if ($('#setInputPreset').value) $('#setInput').value = $('#setInputPreset').value; };
}

function saveConfigField(field, val) {
  postJSON('/api/config', { [field]: val, deleteSourceAfter: $('#setDelSrc').checked }).then(async (r) => {
    const d = await r.json();
    if (d.ok) { toast('已保存' + (field === 'outputDir' ? '输出' : '输入') + '目录', 'ok'); window._CFG = d; renderCfgInfo(); loadInputFiles(); }
    else toast('保存失败: ' + (d.error || ''), 'err');
  });
}

function renderCfgInfo() {
  const c = window._CFG || {};
  $('#setInfo').innerHTML = `当前输出目录：<code>${c.effectiveOutput || '默认'}</code>` +
    (c.inputDir ? `<br>当前输入目录：<code>${c.inputDir}</code>` : '<br>未设置输入目录（使用上传）') +
    (c.deleteSourceAfter ? '<br>✅ 转码后自动删除上传原文件' : '');
}

async function loadConfig() {
  try {
    const r = await api('/api/config');
    window._CFG = await r.json();
  } catch { window._CFG = { presets: {} }; }
  const presets = (window._CFG && window._CFG.presets) || {};
  const labels = { desktop: '桌面', documents: '文档', videos: '视频', downloads: '下载', music: '音乐', home: '用户主目录' };
  const optHtml = Object.entries(presets).map(([k, v]) => `<option value="${v}">${labels[k] || k} (${v})</option>`).join('');
  const base = '<option value="">— 预设位置 —</option>';
  $('#setOutputPreset').innerHTML = base + optHtml;
  $('#setInputPreset').innerHTML = base + optHtml;
  if (window._CFG.outputDir) $('#setOutput').value = window._CFG.outputDir;
  if (window._CFG.inputDir) $('#setInput').value = window._CFG.inputDir;
  $('#setDelSrc').checked = !!window._CFG.deleteSourceAfter;
  renderCfgInfo();
  loadInputFiles();
}

async function loadInputFiles() {
  const c = window._CFG || {};
  if (!c.inputDir) { window._INPUTFILES = []; populateSelects(); return; }
  try {
    const r = await api('/api/input-files');
    const d = await r.json();
    window._INPUTFILES = d.files || [];
  } catch { window._INPUTFILES = []; }
  populateSelects();
}
