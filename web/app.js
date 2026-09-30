/* Smart Scan dashboard */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const KIND_COLOR = () => ({
  scanning_radar: css('--k-scan'), tracking_radar: css('--k-track'), agile_radar: css('--k-agile'),
  comms: css('--k-comms'), beacon: css('--k-beacon'),
});
const KIND_NAME = { scanning_radar: 'Search radar', tracking_radar: 'Fire-control radar', agile_radar: 'Hopping radar',
  comms: 'Radio link', beacon: 'Beacon' };
const LOWER_BETTER = new Set(['pfa', 'mean_intercept_time_slots', 'mean_intercept_time_ms', 'mean_info_age_slots',
  'intercept_time_error_slots']);
const FOM = [
  ['pd', 'Probability of detection Pd', 3], ['pfa', 'Probability of false alarm Pfa', 4],
  ['sensitivity_dbm', 'Sensitivity (dBm, Pd = 0.9)', 1],
  ['intercept_ratio', 'Interception ratio', 3], ['threat_weighted_ir', 'Threat-weighted interception ratio', 3],
  ['emitters_found', 'Emitters found (detectable)', 3], ['mean_intercept_time_ms', 'Mean time to first intercept (ms)', 0],
  ['mean_info_age_slots', 'Mean information age (slots)', 1], ['intercept_rate_per_s', 'Avg intercept rate (/s)', 2],
  ['hit_rate', 'Hit rate (per dwell)', 3], ['avg_reward', 'Avg reward / cost function', 4],
  ['prediction_accuracy', '% correct predictions (dwelt band)', 3],
  ['all_band_accuracy', '% correct predictions (all bands)', 3],
  ['intercept_time_error_slots', 'Avg intercept-time error (slots)', 2],
];
const SCHED_COLOR = { round_robin: '#7c8a9c', random_sweep: '#8e9aab', random: '#a5afbd', thompson: '#d4a24c',
  model_based: '#5aa2ff', gru_predictor: '#35d0a5', dqn: '#f2a541' };
const OURS = new Set(['model_based', 'gru_predictor', 'dqn']);
const PLAIN = { round_robin: ["Today's method", 'fixed sweep, band by band'], random_sweep: ['Random sweep', 'fixed, random order'],
  random: ['Random guessing', 'random band each time'], thompson: ['Simple learner', 'bandit'],
  model_based: ['Smart scan', 'rule-based'], gru_predictor: ['AI receiver', 'GRU predictor'], dqn: ['AI receiver', 'reinforcement learning'] };
const GRID = '#1e2a3a';

Chart.defaults.color = '#8797ab';
Chart.defaults.borderColor = GRID;
Chart.defaults.font.family = 'Segoe UI, system-ui, sans-serif';
Chart.defaults.maintainAspectRatio = false;
Chart.defaults.plugins.legend.labels.boxWidth = 12;
Chart.defaults.plugins.tooltip.backgroundColor = '#0b121a';
Chart.defaults.plugins.tooltip.borderColor = '#34465e';
Chart.defaults.plugins.tooltip.borderWidth = 1;

/* value labels at the end of bars */
Chart.register({
  id: 'valueLabels',
  afterDatasetsDraw(chart, _a, opts) {
    if (!opts || !opts.enabled) return;
    const { ctx } = chart;
    const horiz = chart.options.indexAxis === 'y';
    ctx.save();
    ctx.font = '600 11px Segoe UI, sans-serif';
    ctx.fillStyle = '#dde6f0';
    chart.data.datasets.forEach((ds, i) => {
      const meta = chart.getDatasetMeta(i);
      if (meta.hidden || meta.type !== 'bar') return;
      meta.data.forEach((bar, j) => {
        const v = ds.data[j];
        if (v === null || v === undefined || Number.isNaN(v)) return;
        const txt = opts.format ? opts.format(v) : String(v);
        if (horiz) {
          ctx.textAlign = v >= 0 ? 'left' : 'right'; ctx.textBaseline = 'middle';
          ctx.fillText(txt, bar.x + (v >= 0 ? 5 : -5), bar.y);
        } else {
          ctx.textAlign = 'center'; ctx.textBaseline = v >= 0 ? 'bottom' : 'top';
          ctx.fillText(txt, bar.x, bar.y + (v >= 0 ? -4 : 4));
        }
      });
    });
    ctx.restore();
  },
});
/* vertical marker line at a category index */
Chart.register({
  id: 'vmarker',
  afterDatasetsDraw(chart, _a, opts) {
    if (!opts || opts.index === undefined || opts.index === null) return;
    const x = chart.scales.x.getPixelForValue(opts.index);
    const { top, bottom } = chart.chartArea;
    const { ctx } = chart;
    ctx.save();
    ctx.strokeStyle = opts.color || '#35d0a5'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = opts.color || '#35d0a5'; ctx.font = '600 11px Segoe UI, sans-serif';
    ctx.textAlign = 'left'; ctx.fillText(opts.label || '', x + 5, top + 12);
    ctx.restore();
  },
});

let INFO = null, SIM = null, BENCH = null;
let playT = 0, playing = false, lastFrame = 0, lastChart = 0, view = 'follow', mode = 'simple';
const charts = {};
const WINDOW = 250;

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch (e) { /* ignore */ }
    throw new Error(msg);
  }
  return r.json();
}
const sec = (t) => (t * (SIM ? SIM.receiver.dwell_ms : 10) / 1000);
const fmt = (v, d) => (v === null || v === undefined ? '—' : (+v).toFixed(d));
const pct = (x) => `${Math.round(x * 100)}%`;

/* ------------------------------------------------------------------ tabs */
$$('#tabs > button[data-tab]').forEach((b) => b.addEventListener('click', () => {
  $$('#tabs > button[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
  const tab = b.dataset.tab;
  if (tab === 'bench' && !BENCH) loadBench();
  if (tab === 'theory' && !charts.th) { runTheory(); loadValidation(); }
  if (tab === 'theory' && LAST_TH) drawTiming(LAST_TH);
  if (tab === 'bench' && BENCH) drawBenchSimple();
  if (tab === 'train') loadTraining();
  if (tab === 'live') drawAll();
}));

/* ------------------------------------------------------------------ init */
async function init() {
  INFO = await api('/api/info');
  const rx = INFO.receiver;
  $('#rxchips').innerHTML = [
    ['Coverage', `${rx.band_centers_ghz[0] - rx.band_bw_mhz / 2000}–${rx.band_centers_ghz.at(-1) + rx.band_bw_mhz / 2000} GHz`],
    ['Bands', rx.n_bands], ['Listens to', `1 band / ${rx.dwell_ms} ms`], ['Noise floor', `${rx.noise_floor_dbm} dBm`],
    ['Sensitivity', `${rx.sensitivity_dbm_pd90} dBm`], ['False-alarm rate', rx.design_pfa],
  ].map(([k, v]) => `<span class="chip">${k} <b>${v}</b></span>`).join('');

  const sc = $('#scenarioSel');
  Object.keys(INFO.presets).forEach((p) => sc.add(new Option(p.replace('_', ' '), p)));
  sc.add(new Option('random laydown', '__random'));
  sc.add(new Option('custom (from editor)', '__custom'));
  sc.addEventListener('change', () => $('#randSeedWrap').classList.toggle('hidden', sc.value !== '__random'));

  for (const sel of [$('#schedA'), $('#schedB')]) {
    INFO.schedulers.forEach((s) => {
      const o = new Option(s.label + (s.available ? '' : ' (not trained)'), s.name);
      o.disabled = !s.available;
      sel.add(o);
    });
  }
  $('#schedA').value = 'round_robin';
  const best = ['dqn', 'gru_predictor', 'model_based'].find((n) => INFO.schedulers.find((s) => s.name === n && s.available));
  $('#schedB').value = best;

  const ed = $('#edPreset');
  Object.keys(INFO.presets).forEach((p) => ed.add(new Option(p, p)));
  ed.addEventListener('change', () => setEditor(INFO.presets[ed.value].scenario));
  setEditor(INFO.presets[ed.value].scenario);

  runSim();
}

/* ------------------------------------------------------------------ live sim */
async function runSim() {
  const btn = $('#runBtn');
  const done = () => { btn.disabled = false; btn.textContent = '▶ Run simulation'; };
  btn.disabled = true; btn.textContent = 'Simulating…';
  const body = { seed: +$('#noiseSeed').value, schedulers: [$('#schedA').value, $('#schedB').value] };
  const v = $('#scenarioSel').value;
  if (v === '__random') body.random_seed = +$('#randSeed').value;
  else if (v === '__custom') {
    try { body.scenario = JSON.parse($('#edText').value); } catch (e) { alertMsg('Scenario JSON invalid: ' + e.message); done(); return; }
  } else body.preset = v;
  if (body.schedulers[0] === body.schedulers[1]) body.schedulers = [body.schedulers[0]];
  try {
    SIM = await api('/api/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) { alertMsg(e.message); done(); return; }
  done();
  prepareSim();
  playT = 0; playing = true; $('#playBtn').textContent = '⏸';
  $('#scrub').max = SIM.T;
  $('#scenarioDesc').textContent = SIM.scenario.description ? 'Scenario: ' + SIM.scenario.description : '';
  buildFomTable();
  buildSimple();
  buildCharts();
  drawAll();
}

function alertMsg(m) { $('#scenarioDesc').innerHTML = `<span class="bad">${m}</span>`; }
const runNames = () => Object.keys(SIM.runs);

function prepareSim() {
  const { truth, n_bands: N, T } = SIM;
  const E = SIM.emitters.length;
  // transmission events: contiguous runs of the same emitter in a band
  const ev = truth.map(() => new Int32Array(T).fill(-1));
  const evEm = [];
  const evStartByEm = Array.from({ length: E }, () => []);
  for (let b = 0; b < N; b++) {
    for (let t = 0; t < T; t++) {
      const o = truth[b][t];
      if (o < 0) continue;
      if (t > 0 && truth[b][t - 1] === o) ev[b][t] = ev[b][t - 1];
      else { ev[b][t] = evEm.length; evEm.push(o); evStartByEm[o].push(t); }
    }
  }
  const evCum = new Int32Array(T);
  evStartByEm.flat().forEach((t) => evCum[t]++);
  for (let t = 1; t < T; t++) evCum[t] += evCum[t - 1];
  Object.assign(SIM, { ev, evEm, evCum, evStartByEm });

  for (const name of runNames()) {
    const r = SIM.runs[name];
    const caught = new Set();
    const cum = new Int32Array(T), hitCum = new Int32Array(T), faCum = new Int32Array(T);
    const cls = new Int8Array(T);   // 0 empty, 1 hit, 2 miss, 3 false alarm
    const firstHit = {}, caughtEv = [];
    let rew = 0, hits = 0, fa = 0;
    r.rewCum = new Float32Array(T);
    for (let t = 0; t < T; t++) {
      const a = r.actions[t], d = r.detections[t], o = truth[a][t];
      if (o >= 0 && d) {
        cls[t] = 1; hits++;
        if (!caught.has(ev[a][t])) { caught.add(ev[a][t]); caughtEv.push([t, o]); }
        if (!(o in firstHit)) firstHit[o] = t;
      } else if (o >= 0) cls[t] = 2;
      else if (d) { cls[t] = 3; fa++; }
      cum[t] = caught.size; hitCum[t] = hits; faCum[t] = fa;
      rew += r.rewards[t]; r.rewCum[t] = rew;
    }
    Object.assign(r, { cum, hitCum, faCum, cls, firstHit, caughtEv });
  }
  // emitter names per band, shown at the right edge of each waterfall
  SIM.bandNames = Array.from({ length: N }, () => []);
  SIM.emitters.forEach((e) => {
    (e.bands || [e.band]).forEach((b) => { if (b < N) SIM.bandNames[b].push(e.name); });
  });
  SIM.truthLayer = renderGrid((b, t) => {
    const o = truth[b][t];
    if (o < 0) return null;
    return [KIND_COLOR()[SIM.emitters[o].kind], 0.4 + 0.6 * SIM.pd[b][t]];
  });
  for (const name of runNames()) {
    const r = SIM.runs[name];
    r.predLayer = r.pred ? renderGrid((b, t) => {
      const p = r.pred[b][t];
      return p > 0.03 ? ['#35d0a5', Math.min(1, p)] : null;
    }) : null;
  }
  buildEmTable();
}

function renderGrid(fn) {
  const { n_bands: N, T } = SIM;
  const c = document.createElement('canvas');
  c.width = T; c.height = N;
  const g = c.getContext('2d');
  for (let b = 0; b < N; b++) {
    for (let t = 0; t < T; t++) {
      const v = fn(b, t);
      if (!v) continue;
      g.globalAlpha = v[1]; g.fillStyle = v[0];
      g.fillRect(t, N - 1 - b, 1, 1);
    }
  }
  return c;
}

function viewWindow() {
  if (view === 'full' || !SIM) return [0, SIM ? SIM.T : 1000];
  const W = Math.min(WINDOW, SIM.T);
  const t0 = Math.max(0, Math.min(SIM.T - W, playT - Math.round(W * 0.8)));
  return [t0, t0 + W];
}

function buildSimple() {
  const names = runNames();
  $('#lanes').innerHTML = names.map((n, i) => {
    const [title, sub] = PLAIN[n] || [SIM.runs[n].label, ''];
    return `<div class="lane" id="lane${i}">
      <div class="who"><span class="dot ${'ab'[i]}"></span><div>${title}<small>${sub}</small></div></div>
      <div><canvas></canvas><div class="strip-axis"><span>1.5 s ago</span><span>now →</span></div></div>
      <div class="num"><b>0</b><span>enemy signals caught</span><span class="found"></span></div></div>`;
  }).join('');
}

const STRIP = 150;
function drawSimple() {
  const names = runNames();
  const t = Math.max(0, playT - 1);
  const E = SIM.emitters.length;
  const vals = names.map((n) => (playT ? SIM.runs[n].hitCum[t] : 0));
  const hit = css('--hit');
  names.forEach((n, i) => {
    const r = SIM.runs[n];
    const lane = document.getElementById('lane' + i);
    if (!lane) return;
    lane.querySelector('.num b').textContent = vals[i];
    const found = playT ? Object.values(r.firstHit).filter((x) => x < playT).length : 0;
    lane.querySelector('.found').textContent = `${found} of ${E} enemy emitters found`;
    lane.classList.toggle('win', vals.length === 2 && vals[i] > vals[1 - i]);
    const cv = lane.querySelector('canvas');
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth, H = cv.clientHeight;
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const cw = W / STRIP, gap = cw > 4 ? 1.5 : 0.5;
    for (let k = 0; k < STRIP; k++) {
      const s0 = playT - STRIP + k;
      if (s0 < 0) continue;
      g.fillStyle = r.cls[s0] === 1 ? hit : '#2c3949';
      g.fillRect(k * cw + gap / 2, 4, cw - gap, H - 8);
    }
  });
  const h = $('#simpleHeadline');
  if (names.length === 2 && playT) {
    const [a, b] = vals;
    const nameA = (PLAIN[names[0]] || [SIM.runs[names[0]].label])[0];
    const nameB = (PLAIN[names[1]] || [SIM.runs[names[1]].label])[0];
    const lead = b >= a ? [nameB, b, nameA, a, 'b'] : [nameA, a, nameB, b, 'a'];
    const more = lead[3] > 0 ? Math.round((lead[1] / lead[3] - 1) * 100) : null;
    h.innerHTML = `After <b>${sec(playT).toFixed(1)} s</b>, the <b style="color:var(--${lead[4]})">${lead[0]}</b> has caught ` +
      `<b class="big" style="color:var(--${lead[4]})">${lead[1]}</b> enemy signals vs <b>${lead[3]}</b> for ${lead[2]}` +
      (more !== null && more > 0 ? `: <b class="good">${more}% more</b>.` : '.');
  } else if (playT) {
    h.innerHTML = `After <b>${sec(playT).toFixed(1)} s</b>: <b class="big">${vals[0]}</b> enemy signals caught.`;
  } else h.textContent = 'Press play to start.';
}

function drawAll(force = true) {
  if (!SIM) return;
  if (mode === 'simple') {
    drawSimple();
    $('#tLabel').textContent = `${sec(playT).toFixed(2)} s`;
    $('#scrub').value = playT;
    const now0 = performance.now();
    if (force || now0 - lastChart > 250 || playT >= SIM.T) { updateCharts(); lastChart = now0; }
    return;
  }
  const names = runNames();
  ['A', 'B'].forEach((id, i) => {
    const box = $('#wf' + id);
    const name = names[i];
    box.classList.toggle('hidden', !name);
    if (name) drawWaterfall(box, SIM.runs[name], i);
  });
  $('#tLabel').textContent = `${sec(playT).toFixed(2)} s`;
  $('#scrub').value = playT;
  updateScoreboard();
  updateEmTable();
  const now = performance.now();
  if (force || now - lastChart > 250 || playT >= SIM.T) { updateCharts(); lastChart = now; }
}

function drawWaterfall(box, run, idx) {
  const cv = box.querySelector('canvas');
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const { n_bands: N } = SIM;
  const [t0, t1] = viewWindow();
  const span = t1 - t0;
  const padL = 58, padR = W > 700 ? 118 : 8, padT = 8, padB = 36;
  const w = W - padL - padR, h = H - padT - padB;
  const rowH = h / N, colW = w / span;
  const X = (t) => padL + (t - t0) * colW;
  const Y = (b) => padT + (N - 1 - b) * rowH;
  cv._geo = { padL, padT, w, h, rowH, colW, t0, t1, N, run, idx };
  g.clearRect(0, 0, W, H);
  g.imageSmoothingEnabled = false;

  // band rows (alternating) and truth layer
  for (let b = 0; b < N; b++) {
    g.fillStyle = b % 2 ? '#0b1118' : '#0d141d';
    g.fillRect(padL, Y(b), w, rowH);
  }
  const showPred = $('#showPred').checked && run.predLayer;
  g.globalAlpha = showPred ? 0.3 : 0.85;
  g.drawImage(SIM.truthLayer, t0, 0, span, N, padL, padT, w, h);
  if (showPred) { g.globalAlpha = 0.9; g.drawImage(run.predLayer, t0, 0, span, N, padL, padT, w, h); }
  g.globalAlpha = 1;

  // not-yet-played region is dimmed so "now" is obvious
  const xp = X(Math.max(t0, Math.min(playT, t1)));
  g.fillStyle = 'rgba(7,10,14,0.55)';
  g.fillRect(xp, padT, padL + w - xp, h);

  // receiver path
  const colors = [css('--empty'), css('--hit'), css('--miss'), css('--fa')];
  const end = Math.min(playT, t1);
  const zoomed = span <= 400;
  if (zoomed && end > t0) {
    g.strokeStyle = idx ? css('--b') : css('--a');
    g.globalAlpha = 0.45; g.lineWidth = 1.2;
    g.beginPath();
    for (let t = t0; t < end; t++) {
      const x = X(t) + colW / 2, y = Y(run.actions[t]) + rowH / 2;
      if (t === t0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke(); g.globalAlpha = 1;
  }
  const mw = Math.max(1.5, colW * (zoomed ? 0.8 : 1));
  for (let t = t0; t < end; t++) {
    const c = run.cls[t];
    const y = Y(run.actions[t]);
    g.fillStyle = colors[c];
    g.globalAlpha = c === 0 ? 0.6 : 1;
    const hh = c === 2 ? rowH * 0.36 : rowH * 0.62;
    g.fillRect(X(t) + (colW - mw) / 2, y + (rowH - hh) / 2, mw, hh);
  }
  g.globalAlpha = 1;

  // current receiver position
  if (playT > t0 && playT <= t1) {
    const t = playT - 1;
    const cx = X(t) + colW / 2, cy = Y(run.actions[t]) + rowH / 2;
    g.strokeStyle = '#ffffff'; g.lineWidth = 2;
    g.beginPath(); g.arc(cx, cy, Math.max(5, rowH * 0.45), 0, Math.PI * 2); g.stroke();
  }
  // playhead
  if (playT >= t0 && playT <= t1) {
    g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(xp, padT); g.lineTo(xp, padT + h); g.stroke();
  }

  // axes
  g.fillStyle = '#8797ab'; g.font = '11px Consolas, monospace'; g.textAlign = 'right'; g.textBaseline = 'middle';
  const fc = SIM.receiver.band_centers_ghz;
  for (let b = 0; b < N; b++) {
    if (N <= 20 || b % 2 === 0) g.fillText(fc[b].toFixed(1), padL - 6, Y(b) + rowH / 2);
  }
  g.textAlign = 'center'; g.textBaseline = 'top';
  const stepSlots = span > 400 ? 100 : 50;
  for (let t = Math.ceil(t0 / stepSlots) * stepSlots; t <= t1; t += stepSlots) {
    const x = X(t);
    g.strokeStyle = 'rgba(255,255,255,0.06)';
    g.beginPath(); g.moveTo(x, padT); g.lineTo(x, padT + h); g.stroke();
    g.fillText(`${sec(t).toFixed(1)}s`, x, padT + h + 5);
  }
  g.font = '11px Segoe UI, sans-serif'; g.fillStyle = '#6f8096';
  g.fillText('Time (seconds)', padL + w / 2, padT + h + 20);
  g.save(); g.translate(13, padT + h / 2); g.rotate(-Math.PI / 2); g.textBaseline = 'middle';
  g.fillText('Frequency (GHz)', 0, 0); g.restore();
  // emitter names per band
  if (padR > 20) {
    g.textAlign = 'left'; g.textBaseline = 'middle'; g.font = '11px Segoe UI, sans-serif';
    const kc = KIND_COLOR();
    for (let b = 0; b < N; b++) {
      const names = SIM.bandNames[b];
      if (!names.length) continue;
      const e = SIM.emitters.find((x) => x.name === names[0]);
      g.fillStyle = kc[e.kind];
      let label = names.join(', ');
      if (label.length > 16) label = label.slice(0, 15) + '…';
      g.fillText(label, padL + w + 8, Y(b) + rowH / 2);
    }
  }
  box.querySelector('.wf-title').textContent = run.label;
  box.querySelector('.wf-sub').textContent = view === 'follow'
    ? `showing ${sec(t0).toFixed(1)}–${sec(t1).toFixed(1)} s · hover for details`
    : 'full 10 s run · hover for details';
}

/* hover tooltip */
function onHover(ev) {
  const cv = ev.currentTarget, geo = cv._geo, tip = $('#tip');
  if (!geo || !SIM) return;
  const rect = cv.getBoundingClientRect();
  const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
  const t = Math.floor(geo.t0 + (x - geo.padL) / geo.colW);
  const b = geo.N - 1 - Math.floor((y - geo.padT) / geo.rowH);
  if (t < geo.t0 || t >= geo.t1 || b < 0 || b >= geo.N) { tip.classList.add('hidden'); return; }
  const kc = KIND_COLOR();
  const o = SIM.truth[b][t];
  const f = SIM.receiver.band_centers_ghz[b];
  let html = `<b>${sec(t).toFixed(2)} s · ${f.toFixed(1)} GHz</b> <span class="muted">(slot ${t}, band ${b + 1})</span><br>`;
  if (o >= 0) {
    const e = SIM.emitters[o];
    html += `<div class="row"><i style="background:${kc[e.kind]}"></i>${e.name}: ${KIND_NAME[e.kind]} transmitting · Pd ${Math.round(SIM.pd[b][t] * 100)}%</div>`;
  } else html += '<div class="muted">Nothing transmitting here</div>';
  const r = geo.run;
  if (t < playT) {
    const a = r.actions[t];
    const res = ['empty band', '<span style="color:var(--hit)">caught it</span>', '<span style="color:var(--miss)">missed it</span>',
      '<span style="color:var(--fa)">false alarm</span>'][r.cls[t]];
    html += a === b
      ? `<div>Receiver listened <b>here</b>: ${res}</div>`
      : `<div class="muted">Receiver was listening at ${SIM.receiver.band_centers_ghz[a].toFixed(1)} GHz (${res})</div>`;
  } else html += '<div class="muted">Not played yet</div>';
  if (r.pred && t < playT) html += `<div class="muted">AI predicted ${Math.round(r.pred[b][t] * 100)}% chance of a signal here</div>`;
  tip.innerHTML = html;
  tip.classList.remove('hidden');
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let left = ev.clientX + 14, top = ev.clientY + 14;
  if (left + tw > window.innerWidth - 8) left = ev.clientX - tw - 14;
  if (top + th > window.innerHeight - 8) top = ev.clientY - th - 14;
  tip.style.left = left + 'px'; tip.style.top = top + 'px';
}
$$('.wf canvas').forEach((cv) => {
  cv.addEventListener('mousemove', onHover);
  cv.addEventListener('mouseleave', () => $('#tip').classList.add('hidden'));
});

/* scoreboard: live A vs B race */
function updateScoreboard() {
  const names = runNames();
  const t = Math.max(0, playT - 1);
  const E = SIM.emitters.length;
  const val = (r, k) => {
    if (!playT) return 0;
    if (k === 'hits') return r.hitCum[t];
    if (k === 'events') return r.cum[t] / Math.max(1, SIM.evCum[t]);
    if (k === 'found') return Object.values(r.firstHit).filter((x) => x < playT).length;
    if (k === 'fa') return r.faCum[t];
    return 0;
  };
  const metrics = [
    ['hits', 'Signals caught', 'intercepts so far', (v) => v, false],
    ['events', 'Transmissions caught', 'share of all transmissions', (v) => pct(v), false],
    ['found', 'Emitters found', `out of ${E}`, (v) => `${v}/${E}`, false],
    ['fa', 'False alarms', 'lower is better', (v) => v, true],
  ];
  $('#scoreboard').innerHTML = metrics.map(([k, title, hint, f, lower]) => {
    const vs = names.map((n) => val(SIM.runs[n], k));
    const max = Math.max(k === 'found' ? E : 0, k === 'events' ? 1 : 0, ...vs, 1e-9);
    let winner = -1;
    if (vs.length === 2 && vs[0] !== vs[1]) winner = (lower ? vs[0] < vs[1] : vs[0] > vs[1]) ? 0 : 1;
    const rows = vs.map((v, i) => `<div class="race"><span class="dot ${'ab'[i]}"></span>
      <div class="track"><div class="fill ${'ab'[i]}" style="width:${(v / max) * 100}%"></div></div>
      <span class="v ${i === winner ? 'win' : ''}">${f(v)}</span></div>`).join('');
    let delta = '';
    if (vs.length === 2 && !lower && vs[0] > 0 && k !== 'found') {
      const d = (vs[1] / vs[0] - 1) * 100;
      delta = `<div class="delta">B vs A: <b class="${d >= 0 ? 'pos' : 'neg'}">${d >= 0 ? '+' : ''}${d.toFixed(0)}%</b></div>`;
    }
    return `<div class="score"><div class="t"><span>${title}</span><span class="hint">${hint}</span></div>${rows}${delta}</div>`;
  }).join('');
}

function buildEmTable() {
  const names = runNames();
  const kc = KIND_COLOR();
  const head = `<tr><th>Emitter</th><th title="Threat weight: how dangerous this emitter type is">Threat</th>
    ${names.map((n, i) => `<th title="Caught: transmissions intercepted / transmitted so far. First: when receiver ${'AB'[i]} first detected it."><span class="dot ${'ab'[i]}"></span> ${'AB'[i]}</th>`).join('')}</tr>`;
  const rows = SIM.emitters.map((e) => {
    const where = e.bands ? `hops ${e.bands.length} bands` : `${SIM.receiver.band_centers_ghz[e.band]} GHz`;
    return `<tr><td><span class="kind" style="background:${kc[e.kind]}"></span>${e.name}<br><span class="sub">${KIND_NAME[e.kind]} · ${where}</span></td>
      <td>${e.threat}</td>` +
      names.map((n, i) => `<td class="c${'ab'[i]}"><span id="cg-${i}-${e.id}">—</span><br><span class="sub" id="fh-${i}-${e.id}">—</span></td>`).join('') + '</tr>';
  }).join('');
  $('#emTable').innerHTML = head + rows;
}

function emitterCounts(r) {
  const E = SIM.emitters.length;
  const caught = new Array(E).fill(0), sent = new Array(E).fill(0);
  for (const [t, e] of r.caughtEv) { if (t < playT) caught[e]++; else break; }
  SIM.evStartByEm.forEach((ts, e) => { sent[e] = ts.filter((t) => t < playT).length; });
  return { caught, sent };
}

function updateEmTable() {
  runNames().forEach((n, i) => {
    const r = SIM.runs[n];
    const { caught, sent } = emitterCounts(r);
    SIM.emitters.forEach((e) => {
      const fh = r.firstHit[e.id];
      const a = document.getElementById(`fh-${i}-${e.id}`);
      const c = document.getElementById(`cg-${i}-${e.id}`);
      if (a) a.textContent = fh !== undefined && fh < playT ? `first ${sec(fh).toFixed(2)} s` : 'not found yet';
      if (c) c.textContent = sent[e.id] ? `${caught[e.id]}/${sent[e.id]} caught` : 'silent so far';
    });
  });
}

function buildCharts() {
  const names = runNames();
  const colors = [css('--a'), css('--b')];
  if (charts.cum) charts.cum.destroy();
  const ds = names.map((n, i) => ({
    label: (PLAIN[n] ? PLAIN[n][0] + ' (' + PLAIN[n][1] + ')' : SIM.runs[n].label), data: [], borderColor: colors[i], backgroundColor: colors[i] + '22',
    pointRadius: 0, borderWidth: 2.2, fill: false, tension: 0,
  }));
  ds.push({ label: 'Transmitted by enemy', data: [], borderColor: '#56657a', borderDash: [5, 4], pointRadius: 0, borderWidth: 1.4 });
  charts.cum = new Chart($('#cumChart'), {
    type: 'line', data: { datasets: ds },
    options: {
      animation: false, parsing: false, normalized: true,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { type: 'linear', min: 0, max: sec(SIM.T), title: { display: true, text: 'Time (seconds)' }, ticks: { stepSize: 1 }, grid: { color: GRID } },
        y: { beginAtZero: true, title: { display: true, text: 'Transmission events' }, grid: { color: GRID } },
      },
      plugins: { tooltip: { callbacks: { title: (it) => `${(+it[0].parsed.x).toFixed(2)} s` } } },
    },
  });

  if (charts.em) charts.em.destroy();
  charts.em = new Chart($('#emChart'), {
    type: 'bar',
    data: { labels: SIM.emitters.map((e) => e.name),
      datasets: names.map((n, i) => ({ label: `${'AB'[i]}: ${SIM.runs[n].label}`, data: [], backgroundColor: colors[i], borderRadius: 3, barPercentage: 0.9, categoryPercentage: 0.75 })) },
    options: {
      indexAxis: 'y', animation: false,
      layout: { padding: { right: 38 } },
      scales: {
        x: { min: 0, max: 100, title: { display: true, text: '% of that emitter\'s transmissions caught' }, ticks: { callback: (v) => v + '%' }, grid: { color: GRID } },
        y: { grid: { display: false }, ticks: { color: '#c3cedb' } },
      },
      plugins: {
        valueLabels: { enabled: true, format: (v) => `${Math.round(v)}%` },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${Math.round(c.raw)}%` } },
      },
    },
  });
}

function updateCharts() {
  if (!charts.cum || !SIM) return;
  const names = runNames();
  const step = 2;
  names.forEach((n, i) => {
    const r = SIM.runs[n], pts = [];
    for (let t = 0; t < playT; t += step) pts.push({ x: sec(t), y: r.cum[t] });
    charts.cum.data.datasets[i].data = pts;
  });
  const pts = [];
  for (let t = 0; t < playT; t += step) pts.push({ x: sec(t), y: SIM.evCum[t] });
  charts.cum.data.datasets[names.length].data = pts;
  charts.cum.update('none');

  names.forEach((n, i) => {
    const { caught, sent } = emitterCounts(SIM.runs[n]);
    charts.em.data.datasets[i].data = caught.map((c, e) => (sent[e] ? (100 * c) / sent[e] : 0));
  });
  charts.em.update('none');
}

function buildFomTable() {
  const names = runNames();
  let html = `<tr><th>Figure of merit</th>${names.map((n, i) => `<th><span class="dot ${'ab'[i]}"></span> ${'AB'[i]}: ${SIM.runs[n].label}</th>`).join('')}</tr>`;
  for (const [k, lab, d] of FOM) {
    const vals = names.map((n) => SIM.runs[n].metrics[k]);
    const valid = vals.filter((v) => v !== null && v !== undefined);
    let best = null;
    if (valid.length === 2 && k !== 'sensitivity_dbm' && valid[0] !== valid[1]) {
      best = LOWER_BETTER.has(k) ? Math.min(...valid) : Math.max(...valid);
    }
    html += `<tr><td>${lab}</td>${vals.map((v) => `<td class="${v === best ? 'best' : ''}">${fmt(v, d)}</td>`).join('')}</tr>`;
  }
  $('#fomTable').innerHTML = html;
}

function tick(ts) {
  if (playing && SIM) {
    const sp = +$('#speed').value;
    if (ts - lastFrame > 33) {
      playT = Math.min(SIM.T, playT + sp);
      lastFrame = ts;
      if (playT >= SIM.T) { playing = false; $('#playBtn').textContent = '▶'; }
      if ($('#tab-live').classList.contains('active')) drawAll(false);
    }
  }
  requestAnimationFrame(tick);
}

$('#runBtn').addEventListener('click', runSim);
$('#playBtn').addEventListener('click', () => {
  if (!SIM) return;
  if (playT >= SIM.T) playT = 0;
  playing = !playing; $('#playBtn').textContent = playing ? '⏸' : '▶';
});
$('#restartBtn').addEventListener('click', () => {
  if (!SIM) return;
  playT = 0; playing = true; $('#playBtn').textContent = '⏸'; drawAll();
});
$('#scrub').addEventListener('input', (e) => { playT = +e.target.value; playing = false; $('#playBtn').textContent = '▶'; drawAll(); });
$('#showPred').addEventListener('change', () => drawAll());
$$('#modeSeg button').forEach((b) => b.addEventListener('click', () => {
  mode = b.dataset.mode;
  $$('#modeSeg button').forEach((x) => x.classList.toggle('on', x === b));
  document.body.classList.toggle('mode-simple', mode === 'simple');
  document.body.classList.toggle('mode-detailed', mode === 'detailed');
  if (charts.cum) charts.cum.resize();
  drawAll();
  if (BENCH) drawBenchSimple();
  if (LAST_TH) drawTiming(LAST_TH);
}));
$$('#viewSeg button').forEach((b) => b.addEventListener('click', () => {
  view = b.dataset.view;
  $$('#viewSeg button').forEach((x) => x.classList.toggle('on', x === b));
  drawAll();
}));
window.addEventListener('resize', () => { drawAll(); if (LAST_TH) drawTiming(LAST_TH); });
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT' || !$('#tab-live').classList.contains('active')) return;
  if (e.code === 'Space') { e.preventDefault(); $('#playBtn').click(); }
});

/* ------------------------------------------------------------------ benchmark */
async function loadBench() {
  try { BENCH = await api('/api/benchmark'); } catch (e) { $('#benchInfo').textContent = e.message; return; }
  const set = $('#benchSet');
  set.innerHTML = '';
  set.add(new Option(`Unseen random scenarios (n=${BENCH.n_random})`, 'random'));
  Object.keys(BENCH.presets).forEach((p) => set.add(new Option(`Preset: ${p}`, p)));
  const met = $('#benchMetric');
  met.innerHTML = '';
  Object.entries(BENCH.metric_names).forEach(([k, v]) => met.add(new Option(v, k)));
  met.value = 'intercept_ratio';
  set.onchange = () => { drawBench(); drawGain(); };
  met.onchange = drawBench;
  $('#benchInfo').textContent = `generated ${BENCH.generated}`;
  drawBench(); drawGain(); drawBenchSimple();
}

function drawBenchSimple() {
  const d = BENCH.random;
  const rows = [['round_robin', "Today's method", '#7c8a9c'], ['model_based', 'Smart scan (rules)', '#5aa2ff'], ['dqn', 'AI receiver', '#f2a541']]
    .filter(([n]) => d[n]);
  const slot = 0.01;
  const metrics = [
    ['intercept_ratio', 'Enemy transmissions caught', 'Out of every enemy transmission (a radar flash, a radio burst), how many did we catch?', (v) => pct(v), false],
    ['threat_weighted_ir', 'Dangerous transmissions caught', 'Same, but counting dangerous radars (fire-control, hopping) more.', (v) => pct(v), false],
    ['emitters_found', 'Enemy emitters found at least once', 'Out of all enemy radars and radios, how many did we notice at all?', (v) => pct(v), false],
    ['mean_info_age_slots', 'How old our information is (lower is better)', 'On average, how long since we last heard each enemy emitter.', (v) => `${(v * slot).toFixed(2)} s`, true],
    ['mean_intercept_time_slots', 'Time to notice a new emitter (lower is better)', 'How long a newly switched-on emitter goes unnoticed. Here the AI is slower: it spends time re-checking known threats.', (v) => `${(v * slot).toFixed(2)} s`, true],
  ];
  $('#benchSimple').innerHTML = metrics.map(([k, title, expl, f]) => {
    const vals = rows.map(([n]) => d[n][k].mean);
    const max = Math.max(...vals) * 1.05;
    return `<div class="pmetric"><h4>${title}</h4><p>${expl}</p>` + rows.map(([n, label, col], i) =>
      `<div class="pbar"><span class="nm">${label}</span><div class="track"><div class="fill" style="width:${(vals[i] / max) * 100}%;background:${col}"></div></div><span class="v">${f(vals[i])}</span></div>`).join('') + '</div>';
  }).join('');
  const a = d.round_robin.intercept_ratio.mean, b = d.dqn ? d.dqn.intercept_ratio.mean : null;
  const ta = d.round_robin.threat_weighted_ir.mean, tb = d.dqn ? d.dqn.threat_weighted_ir.mean : null;
  $('#benchHeadline').innerHTML = b === null ? 'Benchmark results' :
    `On ${BENCH.n_random} battlefields it had never seen, the <b style="color:#f2a541">AI receiver</b> caught <b class="good">${Math.round((b / a - 1) * 100)}% more</b> enemy transmissions than today's method, and <b class="good">${Math.round((tb / ta - 1) * 100)}% more</b> of the dangerous ones.`;
}

function benchData() { return $('#benchSet').value === 'random' ? BENCH.random : BENCH.presets[$('#benchSet').value]; }

function drawBench() {
  const d = benchData(), k = $('#benchMetric').value;
  const s = BENCH.schedulers.filter((x) => d[x.name] && d[x.name][k]);
  const lower = LOWER_BETTER.has(k);
  $('#benchTitle').textContent = `${BENCH.metric_names[k]} (${lower ? 'lower' : 'higher'} is better)`;
  const digits = Math.max(...s.map((x) => Math.abs(d[x.name][k].mean))) >= 10 ? 1 : 3;
  if (charts.bench) charts.bench.destroy();
  charts.bench = new Chart($('#benchChart'), {
    type: 'bar',
    data: { labels: s.map((x) => x.label), datasets: [{ data: s.map((x) => d[x.name][k].mean),
      backgroundColor: s.map((x) => SCHED_COLOR[x.name]), borderRadius: 4, barPercentage: 0.75 }] },
    options: {
      indexAxis: 'y', animation: false,
      layout: { padding: { right: 50 } },
      plugins: {
        legend: { display: false },
        valueLabels: { enabled: true, format: (v) => v.toFixed(digits) },
        tooltip: { callbacks: { label: (c) => `${c.raw.toFixed(4)} ± ${d[s[c.dataIndex].name][k].std.toFixed(4)} (std)` } },
      },
      scales: {
        x: { beginAtZero: true, grid: { color: GRID } },
        y: { grid: { display: false }, ticks: { color: (c) => (OURS.has(s[c.index].name) ? '#dde6f0' : '#8797ab'),
          font: (c) => ({ weight: OURS.has(s[c.index].name) ? '600' : '400' }) } },
      },
    },
  });
  const keys = Object.keys(BENCH.metric_names);
  let html = `<tr><th>Scheduler</th>${keys.map((k2) => `<th>${BENCH.metric_names[k2]}</th>`).join('')}</tr>`;
  const best = {};
  keys.forEach((k2) => {
    const v = BENCH.schedulers.map((x) => (d[x.name] && d[x.name][k2] ? d[x.name][k2].mean : null)).filter((x) => x !== null);
    if (v.length) best[k2] = LOWER_BETTER.has(k2) ? Math.min(...v) : Math.max(...v);
  });
  BENCH.schedulers.forEach((x) => {
    html += `<tr class="${OURS.has(x.name) ? 'ours' : ''}"><td>${x.label}</td>${keys.map((k2) => {
      const m = d[x.name] && d[x.name][k2];
      if (!m) return '<td>—</td>';
      const dd = Math.abs(m.mean) >= 10 ? 1 : 3;
      return `<td class="${m.mean === best[k2] && k2 !== 'pd' ? 'best' : ''}">${m.mean.toFixed(dd)}</td>`;
    }).join('')}</tr>`;
  });
  $('#benchTable').innerHTML = html;
}

function drawGain() {
  const d = benchData();
  const base = d.round_robin;
  if (!base) return;
  const metrics = [
    ['intercept_ratio', 'Interception ratio'], ['threat_weighted_ir', 'Threat-weighted'],
    ['emitters_found', 'Emitters found'], ['mean_info_age_slots', 'Info freshness'],
    ['mean_intercept_time_slots', 'First-intercept time'], ['avg_reward', 'Reward'],
  ];
  const scheds = BENCH.schedulers.filter((x) => x.name !== 'round_robin' && d[x.name]);
  const shown = scheds.filter((x) => OURS.has(x.name) || x.name === 'random_sweep');
  if (charts.gain) charts.gain.destroy();
  charts.gain = new Chart($('#gainChart'), {
    type: 'bar',
    data: {
      labels: metrics.map((m) => m[1]),
      datasets: shown.map((x) => ({
        label: x.label, backgroundColor: SCHED_COLOR[x.name], borderRadius: 3,
        data: metrics.map(([k]) => {
          if (!d[x.name][k] || !base[k] || !base[k].mean) return null;
          const r = d[x.name][k].mean / base[k].mean - 1;
          return Math.round((LOWER_BETTER.has(k) ? -r : r) * 1000) / 10;
        }),
      })),
    },
    options: {
      animation: false,
      scales: {
        y: { title: { display: true, text: '% better than round-robin' }, ticks: { callback: (v) => v + '%' }, grid: { color: (c) => (c.tick.value === 0 ? '#6f8096' : GRID) } },
        x: { grid: { display: false } },
      },
      plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.raw > 0 ? '+' : ''}${c.raw}%` } } },
    },
  });
}

/* ------------------------------------------------------------------ theory */
let LAST_TH = null;
function firstHit(Tr, taur, Ts, taus, ph, H) {
  for (let t = 0; t < H; t++) {
    if (t % Tr < taur && ((t - ph) % Ts + Ts) % Ts < taus) return t;
  }
  return null;
}
function drawTiming(p) {
  LAST_TH = p;
  const { Ts, taus, taur, TrA, TrB } = p;
  const cv = $('#timingCanvas');
  if (!cv || !cv.clientWidth) return;
  // pick the radar timing that is worst for the naive rhythm (lock-out if possible)
  const Hs = 2400;
  let ph = 0, worst = -1;
  for (let k = 0; k < Ts; k++) {
    const f = firstHit(TrA, taur, Ts, taus, k, Hs);
    const score = f === null ? 1e9 : f;
    if (score > worst) { worst = score; ph = k; }
  }
  const fA = firstHit(TrA, taur, Ts, taus, ph, Hs);
  const fB = TrB ? firstHit(TrB, taur, Ts, taus, ph, Hs) : null;
  const H = Math.min(Hs, Math.max(4 * Ts, (fB || 0) + 2 * Ts, (fA || 0) + 2 * Ts));
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, Hh = cv.clientHeight;
  cv.width = Math.round(W * dpr); cv.height = Math.round(Hh * dpr);
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, Hh);
  const padL = 190, padR = 16, w = W - padL - padR;
  const X = (t) => padL + (t / H) * w;
  const rows = [
    ['Enemy radar beam on us', null, 20],
    [`Visits every ${TrA} slots (today)`, TrA, 78],
    [`Visits every ${TrB} slots (optimal)`, TrB, 136],
  ];
  g.font = '13px Segoe UI, sans-serif'; g.textBaseline = 'middle';
  rows.forEach(([label, Tr, y]) => {
    if (Tr === undefined) return;
    g.fillStyle = '#c3cedb'; g.textAlign = 'left'; g.fillText(label, 8, y + 12);
    g.fillStyle = '#141d28'; g.fillRect(padL, y, w, 24);
  });
  const red = css('--k-scan'), green = css('--hit');
  for (let t = 0; t < H; t++) {
    if (((t - ph) % Ts + Ts) % Ts < taus) { g.fillStyle = red; g.fillRect(X(t), 20, Math.max(2, w / H), 24); }
  }
  [[TrA, 78, fA], [TrB, 136, fB]].forEach(([Tr, y, f]) => {
    if (!Tr) return;
    for (let t = 0; t < H; t++) {
      if (t % Tr < taur) {
        const on = ((t - ph) % Ts + Ts) % Ts < taus;
        g.fillStyle = on ? green : '#6f7f94';
        g.fillRect(X(t) - 1, y + (on ? 0 : 4), on ? 4 : 2, on ? 24 : 16);
      }
    }
    g.textAlign = 'right'; g.font = '600 12px Segoe UI, sans-serif';
    if (f === null) { g.fillStyle = css('--miss'); g.fillText('never caught ✗', W - padR - 4, y - 8); }
    else {
      g.fillStyle = green;
      g.fillText(`caught at ${(f * 0.01).toFixed(2)} s ✓`, Math.min(W - padR - 4, X(f) + 120), y - 8);
      g.strokeStyle = green; g.lineWidth = 1.5; g.beginPath(); g.moveTo(X(f) + 1, 44); g.lineTo(X(f) + 1, y); g.stroke();
    }
    g.font = '13px Segoe UI, sans-serif';
  });
  g.fillStyle = '#6f8096'; g.textAlign = 'center'; g.font = '11px Segoe UI, sans-serif';
  const step = H > 1200 ? 500 : H > 500 ? 200 : 100;
  for (let t = 0; t <= H; t += step) g.fillText(`${(t * 0.01).toFixed(1)} s`, X(t), 176);
  const hl = $('#thHeadline');
  hl.innerHTML = fA === null
    ? `Visiting this radar's frequency every <b>${TrA}</b> slots, the receiver can <b class="bad">never catch it</b> (in ${p.lockPct}% of cases). Visiting every <b class="good">${TrB}</b> slots, it is <b class="good">always caught</b>, within ${p.worstB} at worst.`
    : `Visiting every <b>${TrA}</b> slots the radar is first caught at ${(fA * 0.01).toFixed(2)} s; the optimal rhythm of <b class="good">${TrB}</b> slots guarantees a catch within ${p.worstB}.`;
}

async function runTheory() {
  const q = `T_s=${$('#thTs').value}&tau_s=${$('#thTaus').value}&tau_r=${$('#thTaur').value}&T_min=${$('#thTmin').value}`;
  let r;
  try { r = await api('/api/theory/optimal?' + q); } catch (e) { $('#thResult').innerHTML = `<p class="bad">${e.message}</p>`; return; }
  const c = r.curve;
  const bestIdx = r.best ? c.findIndex((x) => x.T_r === r.best.T_r) : null;
  if (charts.th) charts.th.destroy();
  charts.th = new Chart($('#thChart'), {
    data: {
      labels: c.map((x) => x.T_r),
      datasets: [
        { type: 'line', label: 'Mean intercept time', data: c.map((x) => x.mean), borderColor: '#5aa2ff', backgroundColor: '#5aa2ff', pointRadius: 2.5, borderWidth: 2, yAxisID: 'y' },
        { type: 'line', label: 'Worst-case intercept time', data: c.map((x) => x.worst), borderColor: '#f2a541', backgroundColor: '#f2a541', pointRadius: 2.5, borderWidth: 2, yAxisID: 'y', spanGaps: false },
        { type: 'bar', label: 'Chance of lock-out', data: c.map((x) => x.p_never), backgroundColor: 'rgba(255,77,77,0.45)', yAxisID: 'y2', barPercentage: 0.9 },
      ],
    },
    options: {
      animation: false, interaction: { mode: 'index', intersect: false },
      scales: {
        x: { title: { display: true, text: 'Receiver revisit period Tr (slots)' }, grid: { display: false } },
        y: { title: { display: true, text: 'Intercept time (slots)' }, grid: { color: GRID } },
        y2: { position: 'right', min: 0, max: 1, grid: { display: false }, ticks: { callback: (v) => Math.round(v * 100) + '%' }, title: { display: true, text: 'Chance of lock-out' } },
      },
      plugins: {
        vmarker: { index: bestIdx, label: r.best ? `optimal Tr = ${r.best.T_r}` : '', color: '#35d0a5' },
        tooltip: { callbacks: { label: (it) => (it.dataset.yAxisID === 'y2' ? `${it.dataset.label}: ${Math.round(it.raw * 100)}%`
          : `${it.dataset.label}: ${it.raw === null ? 'never (lock-out)' : Math.round(it.raw) + ' slots'}`) } },
      },
    },
  });
  const rr = r.round_robin, b = r.best;
  const w = (x) => (x === null ? '∞' : x.toFixed(0));
  drawTiming({ Ts: +$('#thTs').value, taus: +$('#thTaus').value, taur: +$('#thTaur').value, TrA: rr.T_r,
    TrB: b ? b.T_r : null, lockPct: Math.round(rr.p_never * 100), worstB: b ? `${(b.worst * 0.01).toFixed(1)} s` : '—' });
  $('#thResult').innerHTML = `<h3>Design result</h3>
    <div class="kpi">
      <div><span>Naive revisit Tr = ${rr.T_r} (round-robin)</span><b class="${rr.guaranteed ? '' : 'bad'}">${rr.guaranteed ? 'guaranteed' : (rr.p_never * 100).toFixed(0) + '% lock-out'}</b></div>
      <div><span>Optimal revisit Tr</span><b class="good">${b ? b.T_r : '—'}</b></div>
      <div><span>Worst-case intercept time (naive → optimal)</span><b>${w(rr.worst)} → ${b ? w(b.worst) : '—'}</b></div>
      <div><span>Mean intercept time (naive → optimal)</span><b>${w(rr.mean)} → ${b ? w(b.mean) : '—'}</b></div>
      <div><span>gcd(Tr, Ts) naive / optimal</span><b>${rr.gcd} / ${b ? b.gcd : '—'}</b></div>
      <div><span>Coincidence window τr+τs−1</span><b>${+$('#thTaur').value + +$('#thTaus').value - 1}</b></div>
    </div>
    <p class="muted small">Rule: intercept is guaranteed for every phase iff gcd(Tr, Ts) ≤ τr+τs−1. The optimum picks a Tr whose phase slip per look (Tr mod Ts) steps across the scan in increments close to the coincidence window (vernier). For an emitter whose period is unknown, the smart scan first measures Ts (acquisition), then revisits exactly at predicted illuminations (tracking).</p>`;
}
$('#thBtn').addEventListener('click', runTheory);

async function loadValidation() {
  let v;
  try { v = await api('/api/theory/validation'); } catch (e) { $('#valSummary').textContent = e.message; return; }
  let html = '<tr><th>Case</th><th>Model</th><th>Pred. time</th><th>Sim. time</th><th>Classical approx.</th><th>Pred. IR</th><th>Sim. IR</th><th>Pred. lock-out</th><th>Sim. lock-out</th></tr>';
  v.rows.forEach((r) => {
    html += `<tr><td>${r.case}</td><td>${r.model}</td><td>${fmt(r.pred_time, 1)}</td><td>${fmt(r.sim_time, 1)}</td><td>${fmt(r.classical_time, 1)}</td>` +
      `<td>${fmt(r.pred_ir, 3)}</td><td>${fmt(r.sim_ir, 3)}</td><td>${fmt(r.pred_lockout, 2)}</td><td>${fmt(r.sim_lockout, 2)}</td></tr>`;
  });
  $('#valTable').innerHTML = html;
  $('#valSummary').textContent = `Average intercept-time error: ${v.mean_abs_time_error_slots.toFixed(1)} slots (${v.mean_abs_time_error_pct.toFixed(1)}%), ` +
    `average interception-ratio error: ${v.mean_abs_ir_error.toFixed(3)} (${v.n_trials} Monte-Carlo trials per case, times from the emitter's first illumination).`;
}

/* ------------------------------------------------------------------ training */
async function loadTraining() {
  const h = await api('/api/training');
  if (h.predictor && h.predictor.length) {
    const p = h.predictor;
    if (charts.trP) charts.trP.destroy();
    charts.trP = new Chart($('#trPred'), {
      type: 'line',
      data: { labels: p.map((x) => x.epoch), datasets: [
        { label: 'Train loss', data: p.map((x) => x.train_loss), borderColor: '#5aa2ff', yAxisID: 'y' },
        { label: 'Validation loss', data: p.map((x) => x.val_loss), borderColor: '#f2a541', yAxisID: 'y' },
        { label: 'Validation balanced accuracy', data: p.map((x) => x.balanced_acc_now), borderColor: '#35d0a5', borderDash: [5, 4], yAxisID: 'y2' },
      ] },
      options: { animation: false, scales: {
        x: { title: { display: true, text: 'Epoch' }, grid: { color: GRID } },
        y: { title: { display: true, text: 'Loss (lower is better)' }, grid: { color: GRID } },
        y2: { position: 'right', grid: { display: false }, title: { display: true, text: 'Balanced accuracy' } } } },
    });
    const l = p.at(-1);
    $('#trPredTxt').textContent = `Final: accuracy ${(l.acc_now * 100).toFixed(1)}%, balanced accuracy ${(l.balanced_acc_now * 100).toFixed(1)}%.`;
  } else $('#trPredTxt').textContent = 'Not trained yet: python train.py predictor';
  if (h.dqn && h.dqn.length) {
    const d = h.dqn;
    if (charts.trD) charts.trD.destroy();
    charts.trD = new Chart($('#trDqn'), {
      type: 'line',
      data: { labels: d.map((x) => (x.step / 1000) + 'k'), datasets: [
        { label: 'Validation avg reward', data: d.map((x) => x.val_reward), borderColor: '#f2a541', yAxisID: 'y' },
        { label: 'Validation interception ratio', data: d.map((x) => x.val_ir), borderColor: '#35d0a5', borderDash: [5, 4], yAxisID: 'y2' },
      ] },
      options: { animation: false, scales: {
        x: { title: { display: true, text: 'Training steps (dwells)' }, grid: { color: GRID } },
        y: { title: { display: true, text: 'Avg reward' }, grid: { color: GRID } },
        y2: { position: 'right', grid: { display: false }, title: { display: true, text: 'Interception ratio' } } } },
    });
    const best = d.reduce((a, b) => (b.val_reward > a.val_reward ? b : a));
    $('#trDqnTxt').textContent = `Best validation reward ${best.val_reward.toFixed(4)} at step ${best.step} (interception ratio ${best.val_ir.toFixed(3)}); this checkpoint is the one used.`;
  } else $('#trDqnTxt').textContent = 'Not trained yet: python train.py rl';
}

/* ------------------------------------------------------------------ editor */
const TEMPLATES = {
  scanning_radar: { kind: 'scanning_radar', name: 'New-SR', band: 5, scan_period: 60, beam_width: 3, erp_dbm: 94, range_km: 100, start: 0 },
  tracking_radar: { kind: 'tracking_radar', name: 'New-TR', band: 8, erp_dbm: 88, range_km: 40, start: 300 },
  agile_radar: { kind: 'agile_radar', name: 'New-AG', bands: [1, 4, 7, 10], hop_dwell: 2, pattern: 'cyclic', erp_dbm: 92, range_km: 80, start: 0 },
  comms: { kind: 'comms', name: 'New-CM', band: 3, mean_on: 10, mean_off: 30, erp_dbm: 70, range_km: 20, start: 0 },
  beacon: { kind: 'beacon', name: 'New-BC', band: 15, period: 25, duty: 2, erp_dbm: 70, range_km: 10, start: 0 },
};
function setEditor(obj) { $('#edText').value = JSON.stringify(obj, null, 2); }
$$('[data-add]').forEach((b) => b.addEventListener('click', () => {
  try {
    const s = JSON.parse($('#edText').value);
    s.emitters.push({ ...TEMPLATES[b.dataset.add] });
    setEditor(s);
    $('#edMsg').textContent = 'Emitter added. Edit its parameters, then run.';
  } catch (e) { $('#edMsg').textContent = 'JSON error: ' + e.message; }
}));
$('#edRun').addEventListener('click', () => {
  try { JSON.parse($('#edText').value); } catch (e) { $('#edMsg').textContent = 'JSON error: ' + e.message; return; }
  $('#scenarioSel').value = '__custom';
  $('#randSeedWrap').classList.add('hidden');
  $$('#tabs button').find((b) => b.dataset.tab === 'live').click();
  runSim();
});

requestAnimationFrame(tick);
init();
