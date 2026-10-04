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
const SCHED_COLOR = { round_robin: '#c9791a', random_sweep: '#a3adbb', random: '#c2cad5', thompson: '#8f9bb0',
  model_based: '#2d7fe0', gru_predictor: '#5fb89b', dqn: '#0b8f6e' };
const OURS = new Set(['model_based', 'gru_predictor', 'dqn']);
const PLAIN = { round_robin: ["Today's method", 'fixed sweep, band by band'], random_sweep: ['Random sweep', 'fixed, random order'],
  random: ['Random guessing', 'random band each time'], thompson: ['Simple learner', 'bandit'],
  model_based: ['Smart scan', 'rule-based'], gru_predictor: ['AI receiver', 'GRU predictor'], dqn: ['AI receiver', 'reinforcement learning'] };
const GRID = 'rgba(22, 35, 59, 0.08)';

Chart.defaults.color = css('--muted');
Chart.defaults.borderColor = GRID;
Chart.defaults.font.family = '"IBM Plex Sans", Segoe UI, system-ui, sans-serif';
Chart.defaults.maintainAspectRatio = false;
Chart.defaults.plugins.legend.labels.boxWidth = 12;
Chart.defaults.plugins.tooltip.backgroundColor = '#ffffff';
Chart.defaults.plugins.tooltip.borderColor = '#c3cedc';
Chart.defaults.plugins.tooltip.borderWidth = 1;
Chart.defaults.plugins.tooltip.titleColor = css('--ink');
Chart.defaults.plugins.tooltip.bodyColor = css('--ink2');

/* value labels at the end of bars */
Chart.register({
  id: 'valueLabels',
  afterDatasetsDraw(chart, _a, opts) {
    if (!opts || !opts.enabled) return;
    const { ctx } = chart;
    const horiz = chart.options.indexAxis === 'y';
    ctx.save();
    ctx.font = '600 11px "IBM Plex Sans", Segoe UI, sans-serif';
    ctx.fillStyle = css('--ink');
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
    ctx.strokeStyle = opts.color || '#0b8f6e'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = opts.color || '#0b8f6e'; ctx.font = '600 11px "IBM Plex Sans", Segoe UI, sans-serif';
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
function switchTab(tabName) {
  // Normalize legacy tab name
  if (tabName === 'theatre' || tabName === 'live-theatre') {
    tabName = 'live';
    setMode('detailed');
  }

  const tabBtn = $(`#tabs > button[data-tab="${tabName}"]`);
  $$('#tabs > button[data-tab]').forEach((x) => x.classList.toggle('active', x === tabBtn));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + tabName));

  const isLive = (tabName === 'live');
  const isProj = (tabName === 'projections');
  const isCharts = (tabName === 'charts');

  // Mode toggle is visible ONLY on Live scan tab
  const modeSeg = $('#modeSeg');
  if (modeSeg) modeSeg.style.display = isLive ? '' : 'none';

  // Move liveTop and truthCard to the active tab
  const liveTop = $('#liveTop');
  const truthCard = $('#truthCard');
  if (isLive) {
    const simpleView = $('#simpleView');
    if (simpleView) {
      if (liveTop) $('#tab-live').insertBefore(liveTop, simpleView);
      if (truthCard) $('#tab-live').insertBefore(truthCard, simpleView);
    }
    if (mode === 'detailed') {
      window.SmartScanState?.syncFromLive();
      if (typeof window.onTheatreTabActive === 'function') window.onTheatreTabActive();
      if (window.theatre?.renderAll) window.theatre.renderAll();
      window.dispatchEvent(new Event('resize'));
    } else {
      if (typeof window.onTheatreTabInactive === 'function') window.onTheatreTabInactive();
      drawAll();
    }
  } else if (isProj) {
    if (typeof window.onTheatreTabInactive === 'function') window.onTheatreTabInactive();
    const projHeader = $('#projHeader');
    if (projHeader) {
      if (liveTop) projHeader.after(liveTop);
      if (truthCard && liveTop) liveTop.after(truthCard);
    }
    window.SmartScanState?.syncFromTheatre();
    drawAll();
    window.dispatchEvent(new Event('resize'));
  } else if (isCharts) {
    if (typeof window.onTheatreTabInactive === 'function') window.onTheatreTabInactive();
    const sec = $('#tab-charts');
    if (liveTop) sec.insertBefore(liveTop, sec.firstChild);
    if (charts.cum) charts.cum.resize();
    if (charts.em) charts.em.resize();
    drawAll();
  } else {
    if (typeof window.onTheatreTabInactive === 'function') window.onTheatreTabInactive();
  }

  if (tabName === 'bench' && !BENCH) loadBench();
  if (tabName === 'theory' && !charts.th) { runTheory(); loadValidation(); }
  if (tabName === 'theory' && LAST_TH) drawTiming(LAST_TH);
  if (tabName === 'bench' && BENCH) drawBenchSimple();
  if (tabName === 'train') loadTraining();
}

$$('#tabs > button[data-tab]').forEach((b) => b.addEventListener('click', () => {
  switchTab(b.dataset.tab);
}));

const playTabActive = () => ($('#tab-live')?.classList.contains('active') && mode === 'simple') ||
                            $('#tab-projections')?.classList.contains('active') ||
                            $('#tab-charts')?.classList.contains('active');

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
  const nEm = $('#nEm');
  nEm.add(new Option('Random (3–13)', ''));
  for (let n = 1; n <= 25; n++) nEm.add(new Option(String(n), String(n)));
  const showRand = () => ['#randSeedWrap', '#nEmWrap'].forEach((id) => $(id).classList.toggle('hidden', sc.value !== '__random'));
  sc.addEventListener('change', showRand);
  $('#diceBtn').classList.remove('hidden');
  $('#diceBtn').addEventListener('click', () => {
    sc.value = '__random'; showRand();
    $('#randSeed').value = Math.floor(Math.random() * 100000);
    runSim();
  });

  // receiver A = conventional (non-smart) scans only, receiver B = smart scan models only
  for (const [sel, smart] of [[$('#schedA'), false], [$('#schedB'), true]]) {
    INFO.schedulers.filter((s) => OURS.has(s.name) === smart).forEach((s) => {
      const o = new Option(s.label + (s.available ? '' : ' (not trained)'), s.name);
      o.disabled = !s.available;
      sel.add(o);
    });
  }
  $('#schedA').value = 'round_robin';
  const best = ['dqn', 'gru_predictor', 'model_based'].find((n) => INFO.schedulers.find((s) => s.name === n && s.available));
  $('#schedB').value = best;

  if (typeof window.initTheatre === 'function') {
    window.initTheatre(INFO);
  }

  // Set up synchronization listeners between Live and Theatre selectors
  $('#scenarioSel')?.addEventListener('change', () => window.SmartScanState?.syncFromLive());
  $('#noiseSeed')?.addEventListener('input', () => window.SmartScanState?.syncFromLive());
  $('#schedA')?.addEventListener('change', () => window.SmartScanState?.syncFromLive());
  $('#schedB')?.addEventListener('change', () => window.SmartScanState?.syncFromLive());
  $('#theatre-scenario')?.addEventListener('change', () => window.SmartScanState?.syncFromTheatre());
  $('#theatre-seed')?.addEventListener('input', () => window.SmartScanState?.syncFromTheatre());
  $('#theatre-sched-a')?.addEventListener('change', () => window.SmartScanState?.syncFromTheatre());
  $('#theatre-sched-b')?.addEventListener('change', () => window.SmartScanState?.syncFromTheatre());

  await runSim();

  // Restore saved session mode (default to simple)
  const savedMode = sessionStorage.getItem('smart_scan_mode') || 'simple';
  setMode(savedMode);

  await applyDeepLink();
}

/* ------------------------------------------------------------------ live sim */
async function runSim() {
  const btn = $('#runBtn');
  const done = () => { btn.disabled = false; btn.textContent = '▶ Run simulation'; };
  btn.disabled = true; btn.textContent = 'Simulating…';
  const body = { seed: +$('#noiseSeed').value, schedulers: [$('#schedA').value, $('#schedB').value] };
  const v = $('#scenarioSel').value;
  if (v === '__random') {
    body.random_seed = +$('#randSeed').value;
    if ($('#nEm').value) body.n_emitters = +$('#nEm').value;
  }
  else body.preset = v;
  if (body.schedulers[0] === body.schedulers[1]) body.schedulers = [body.schedulers[0]];
  try {
    SIM = await api('/api/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) { alertMsg(e.message); done(); return; }
  done();
  prepareSim();
  playT = 0; playing = true; $('#playBtn').textContent = '⏸';
  $('#scrub').max = SIM.T;
  $('#scenarioDesc').textContent = SIM.scenario.description ? 'Scenario: ' + SIM.scenario.description : '';
  buildTruth();
  buildFomTable();
  buildSimple();
  buildExplain();
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
  // ground truth: band-slots on air (cumulative) and number of busy bands per slot
  const airCum = new Int32Array(T), busy = new Int32Array(T);
  for (let t = 0; t < T; t++) {
    let k = 0;
    for (let b = 0; b < N; b++) if (truth[b][t] >= 0) k++;
    busy[t] = k; airCum[t] = k + (t ? airCum[t - 1] : 0);
  }
  Object.assign(SIM, { ev, evEm, evCum, evStartByEm, airCum, busy });

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
    Object.assign(r, { cum, hitCum, faCum, cls, firstHit, caughtEv, caughtSet: caught, name });
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
      return p > 0.03 ? ['#0b8f6e', Math.min(1, p)] : null;
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
      <div class="num"><b>0</b><span class="of">of 0 enemy signals caught</span><span class="found"></span></div></div>`;
  }).join('');
}

const STRIP = 150;
function drawSimple() {
  const names = runNames();
  const t = Math.max(0, playT - 1);
  const E = SIM.emitters.length;
  const vals = names.map((n) => (playT ? SIM.runs[n].cum[t] : 0));
  const sent = playT ? SIM.evCum[t] : 0;
  const hit = css('--hit');
  names.forEach((n, i) => {
    const r = SIM.runs[n];
    const lane = document.getElementById('lane' + i);
    if (!lane) return;
    lane.querySelector('.num b').textContent = vals[i];
    lane.querySelector('.num .of').textContent = `of ${sent} enemy signals caught (${sent ? pct(vals[i] / sent) : '0%'})`;
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
      g.fillStyle = r.cls[s0] === 1 ? hit : css('--nothing');
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
    h.innerHTML = `After <b>${sec(playT).toFixed(1)} s</b> the enemy has sent <b>${sent}</b> signals. The <b style="color:var(--${lead[4]})">${lead[0]}</b> caught ` +
      `<b class="big" style="color:var(--${lead[4]})">${lead[1]}</b> of them vs <b>${lead[3]}</b> for ${lead[2].replace(/^Today/, 'today')}` +
      (more !== null && more > 0 ? `: <b class="good">${more}% more</b>.` : '.');
  } else if (playT) {
    h.innerHTML = `After <b>${sec(playT).toFixed(1)} s</b>: <b class="big">${vals[0]}</b> of <b>${sent}</b> enemy signals caught.`;
  } else h.textContent = 'Press play to start.';
}

function drawAll(force = true) {
  if (!SIM) return;
  updateTruth();
  drawSpectrum();
  const isProj = $('#tab-projections')?.classList.contains('active');
  if (mode === 'simple' && !isProj) {
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
    if (name) {
      if (box.classList.contains('is3d')) {
        draw3D(box.querySelector('canvas.wf3d'), WF3D[i], { r: SIM.runs[name], col: [css('--a'), css('--b')][i] });
        const [w0, w1] = viewWindow();
        box.querySelector('.wf-title').textContent = `${'AB'[i]}: ${SIM.runs[name].label}`;
        box.querySelector('.wf-sub').textContent = `3D, ${sec(w0).toFixed(1)}–${sec(w1).toFixed(1)} s`;
      } else drawWaterfall(box, SIM.runs[name], i);
    }
  });
  $('#tLabel').textContent = `${sec(playT).toFixed(2)} s`;
  $('#scrub').value = playT;
  updateScoreboard();
  updateEmTable();
  const now = performance.now();
  if (force || now - lastChart > 250 || playT >= SIM.T) { updateCharts(); lastChart = now; }
}

/* per-scheduler explanations (used by the annotated detailed view) */
const HOW = {
  round_robin: {
    pattern: ['Fixed order (round-robin)', 'Scans band 1 → 16, then repeats: the staircase'],
    title: '3. How the round-robin scan works',
    steps: ['Band 1', 'Band 2', 'Band 3', 'Band 4', '… one band every 10 ms …', 'Band 16'], nums: [1, 2, 3, 4, 0, 16],
    note: 'Then it <b>repeats, again and again</b>. The order is fixed in advance, whatever is happening.',
    ptitle: '4. The problem with this approach',
    pros: ['Visits the whole spectrum quickly, so it rarely misses long transmissions'],
    cons: ['Wastes looks on empty bands and harmless signals', 'Misses short radar flashes that happen while it is looking elsewhere',
      'Can lock out: keeps arriving between a radar\'s flashes and never sees it'],
    short: 'A fixed, open-loop scan: simple, but blind. It cannot learn from what it hears, so it misses short and new transmissions.',
  },
  random_sweep: {
    pattern: ['Random order each round', 'Every band once per round, order shuffled'],
    title: '3. How the randomised sweep works',
    steps: ['Shuffle the 16 bands', 'Visit each band once, 10 ms each', 'Shuffle again and repeat'],
    note: 'Still planned in advance: it does not use what it hears.',
    ptitle: '4. Strengths and weaknesses',
    pros: ['Covers every band regularly', 'Random order avoids lock-out with rotating radars'],
    cons: ['Still wastes looks on empty bands', 'Does not return when a radar flash is due'],
    short: 'A blind sweep in random order: good coverage, but it never learns where the signals are.',
  },
  random: {
    pattern: ['Random guessing', 'Picks any band at random every 10 ms'],
    title: '3. How random dwell works', steps: ['Pick one of the 16 bands at random', 'Listen for 10 ms', 'Repeat'],
    note: 'A baseline for comparison.', ptitle: '4. Strengths and weaknesses',
    pros: ['No lock-out'], cons: ['Some bands can go unchecked for a long time', 'Ignores everything it hears'],
    short: 'Pure chance: a reference point that any smart strategy must beat.',
  },
  thompson: {
    pattern: ['Simple learner (bandit)', 'Returns to bands that gave hits before'],
    title: '3. How the bandit learner works',
    steps: ['Keeps a score of how often each band gave a hit', 'Mostly listens to the best-scoring bands', 'Sometimes tries others'],
    note: 'Learns, but only "which band is busy", not <b>when</b> signals appear.', ptitle: '4. Strengths and weaknesses',
    pros: ['Very high hit rate on busy bands'], cons: ['Parks on busy radio links and ignores short radar flashes', 'Finds fewer emitters'],
    short: 'A naive learner: it chases busy bands, so it catches many repeat signals but misses the threats that matter.',
  },
  model_based: {
    pattern: ['Smart scan (rules)', 'Sweeps, then jumps back exactly when a flash is due'],
    title: '3. How the smart scan works',
    steps: ['Sweeps all bands to find emitters', 'After a short radar flash, watches that band to measure how often the radar rotates',
      'Comes back exactly when the next flash is due', 'Keeps sweeping the other bands for new emitters'],
    note: 'Uses what it hears, with hand-written rules.', ptitle: '4. Strengths and weaknesses',
    pros: ['Catches rotating radars at the right moment', 'Fully explainable rules'],
    cons: ['Rules are hand-tuned; they cannot adapt as well as a trained AI'],
    short: 'A closed-loop scan with hand-written rules: much better than a blind sweep, and a transparent fallback for the AI.',
  },
  gru_predictor: {
    pattern: ['AI predicts each look', 'Goes where a signal is most likely right now'],
    title: '3. How the AI (predictor) scans',
    steps: ['Listens to one band for 10 ms and notes: caught or missed', 'A neural network predicts which bands will be active next',
      'Goes to the band with the best chance of a signal it has not heard recently'],
    note: 'Every look is decided from what it has heard so far.', ptitle: '4. Strengths and weaknesses',
    pros: ['Predicts hop patterns and radar timing', 'Most accurate timing predictions'],
    cons: ['Greedy: can spend too long on known emitters'],
    short: 'A learned predictor that looks where signals are most likely: it catches far more than a fixed sweep.',
  },
  dqn: {
    pattern: ['AI decides each look', 'Jumps to the band where a signal is expected now'],
    title: '3. How the AI receiver scans',
    steps: ['Listens to one band for 10 ms and notes: caught or missed', 'Updates its memory of every emitter: when it last appeared and how often it repeats',
      'The AI scores all 16 bands: "how useful is listening here right now?"', 'Picks the best band, but never leaves any band unchecked for more than 0.32 s'],
    note: 'Nothing is planned in advance. It learned this behaviour by practising on hundreds of simulated battlefields.',
    ptitle: '4. Strengths and weaknesses',
    pros: ['At the right frequency at the right time: catches short radar flashes', 'Spends fewer looks on empty bands', 'Needs no prior intelligence about the enemy'],
    cons: ['Slightly slower to notice a brand-new emitter, because it also re-checks known threats'],
    short: 'An intelligent, closed-loop scan: it learns from its own hits and misses and goes where the signals are.',
  },
};
const STEP_COLORS = ['#2f7de1', '#1e9e5a', '#e0922f', '#8b5cf6', '#e0457b', '#0ea5a4'];

function buildExplain() {
  const names = runNames();
  const kc = KIND_COLOR();
  names.forEach((n, i) => {
    const box = $('#wf' + 'AB'[i]);
    if (!box) return;
    const r = SIM.runs[n], m = r.metrics, hw = HOW[n] || HOW.dqn;
    const T = SIM.T;
    const found = Object.keys(r.firstHit).length;
    const caughtPct = Math.round(100 * r.cum[T - 1] / Math.max(1, SIM.evCum[T - 1]));
    const legend = SIM.emitters.map((e) => `<span><i style="background:${kc[e.kind]}"></i>${e.name}<small>${KIND_NAME[e.kind]}</small></span>`).join('');
    let num = 0;
    const steps = hw.steps.map((t, k) => {
      if (t.startsWith('…')) return `<div class="stp"><span class="n" style="background:transparent;color:var(--muted)">⋮</span><span class="muted">${t}</span></div>`;
      num = (hw.nums && hw.nums[k]) || num + 1;
      return `<div class="stp"><span class="n" style="background:${STEP_COLORS[k % STEP_COLORS.length]}">${num}</span><span>${t}</span></div>`;
    }).join('');
    const pc = hw.pros.map((t) => `<div class="pc"><span class="ic ok">✓</span><span>${t}</span></div>`).join('') +
      hw.cons.map((t) => `<div class="pc"><span class="ic no">✗</span><span>${t}</span></div>`).join('');
    let cmp = '';
    if (names.length === 2 && i === 1) {
      const a = SIM.runs[names[0]];
      const aPct = Math.round(100 * a.cum[T - 1] / Math.max(1, SIM.evCum[T - 1]));
      cmp = ` In this run it caught <b>${caughtPct}%</b> of enemy transmissions, versus <b>${aPct}%</b> for receiver A.`;
    }
    box.querySelector('.explain').innerHTML = `<div class="xgrid">
      <div class="xcard"><div class="sec-h">2. What the colours mean</div>
        <div class="xsub">Enemy emitters (coloured blocks)</div><div class="xleg">${legend}</div>
        <div class="xsub">Receiver marks</div>
        <div class="xleg"><span><i style="background:var(--hit)"></i>caught a signal</span><span><i style="background:var(--miss)"></i>signal there, missed</span>
          <span><i style="background:var(--empty)"></i>listened, nothing there</span><span><i style="background:var(--fa)"></i>false alarm</span></div>
        <p>Brighter block = stronger signal. The line joining the marks is the receiver's path from band to band.</p></div>
      <div class="xcard"><div class="sec-h">${hw.title}</div>${steps}<p>${hw.note}</p></div>
      <div class="xcard"><div class="sec-h">${hw.ptitle}</div>${pc}
        <div class="xdata">In the full 10 s run: caught <b>${caughtPct}%</b> of enemy transmissions, found <b>${found} of ${SIM.emitters.length}</b> emitters,
          <b>${r.faCum[T - 1]}</b> false alarm${r.faCum[T - 1] === 1 ? '' : 's'}.</div></div>
    </div>
    <div class="inshort"><b>In short:</b> ${hw.short}${cmp}</div>`;
  });
}

/* rounded callout box with an arrow to a target point */
function callout(g, bx, by, bw, lines, color, tx, ty) {
  const lh = 15, bh = 10 + lines.length * lh;
  g.save();
  g.strokeStyle = color; g.lineWidth = 1.6;
  const ax = Math.max(bx + 8, Math.min(bx + bw - 8, tx));
  const ay = ty < by ? by : by + bh;
  g.beginPath(); g.moveTo(ax, ay); g.lineTo(tx, ty); g.stroke();
  const ang = Math.atan2(ty - ay, tx - ax);
  g.fillStyle = color;
  g.beginPath(); g.moveTo(tx, ty);
  g.lineTo(tx - 9 * Math.cos(ang - 0.4), ty - 9 * Math.sin(ang - 0.4));
  g.lineTo(tx - 9 * Math.cos(ang + 0.4), ty - 9 * Math.sin(ang + 0.4));
  g.closePath(); g.fill();
  g.fillStyle = '#ffffff'; g.strokeStyle = color; g.lineWidth = 1.5;
  g.beginPath();
  if (g.roundRect) g.roundRect(bx, by, bw, bh, 6); else g.rect(bx, by, bw, bh);
  g.fill(); g.stroke();
  g.textAlign = 'left'; g.textBaseline = 'top';
  lines.forEach((t, k) => {
    g.font = k === 0 ? '700 12px "IBM Plex Sans", Segoe UI, sans-serif' : '12px "IBM Plex Sans", Segoe UI, sans-serif';
    g.fillStyle = k === 0 ? color : css('--ink2');
    g.fillText(t, bx + 9, by + 6 + k * lh);
  });
  g.restore();
  return bh;
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
  const explain = $('#showExplain').checked;
  const padL = 104, padR = W > 700 ? 118 : 8, padT = explain ? 58 : 8, padB = explain ? 104 : 38;
  const w = W - padL - padR, h = H - padT - padB;
  const rowH = h / N, colW = w / span;
  const X = (t) => padL + (t - t0) * colW;
  const Y = (b) => padT + (N - 1 - b) * rowH;
  cv._geo = { padL, padT, w, h, rowH, colW, t0, t1, N, run, idx };
  g.clearRect(0, 0, W, H);
  g.imageSmoothingEnabled = false;

  for (let b = 0; b < N; b++) {
    g.fillStyle = b % 2 ? css('--row2') : css('--row1');
    g.fillRect(padL, Y(b), w, rowH);
  }
  const showPred = $('#showPred').checked && run.predLayer;
  g.globalAlpha = showPred ? 0.3 : 0.85;
  g.drawImage(SIM.truthLayer, t0, 0, span, N, padL, padT, w, h);
  if (showPred) { g.globalAlpha = 0.9; g.drawImage(run.predLayer, t0, 0, span, N, padL, padT, w, h); }
  g.globalAlpha = 1;

  const xp = X(Math.max(t0, Math.min(playT, t1)));
  g.fillStyle = css('--future');
  g.fillRect(xp, padT, padL + w - xp, h);

  const colors = [css('--empty'), css('--hit'), css('--miss'), css('--fa')];
  const end = Math.min(playT, t1);
  const zoomed = span <= 400;
  if (zoomed && end > t0) {
    g.strokeStyle = idx ? css('--b') : css('--a');
    g.globalAlpha = 0.5; g.lineWidth = 1.3;
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

  if (playT > t0 && playT <= t1) {
    const t = playT - 1;
    const cx = X(t) + colW / 2, cy = Y(run.actions[t]) + rowH / 2;
    g.strokeStyle = css('--ink'); g.lineWidth = 2;
    g.beginPath(); g.arc(cx, cy, Math.max(5, rowH * 0.45), 0, Math.PI * 2); g.stroke();
  }
  if (playT >= t0 && playT <= t1) {
    g.strokeStyle = css('--ink'); g.lineWidth = 1;
    g.beginPath(); g.moveTo(xp, padT); g.lineTo(xp, padT + h); g.stroke();
  }

  // axes: band number + frequency
  g.textBaseline = 'middle';
  const fc = SIM.receiver.band_centers_ghz;
  for (let b = 0; b < N; b++) {
    if (N > 20 && b % 2) continue;
    g.textAlign = 'left'; g.font = '12px "IBM Plex Sans", Segoe UI, sans-serif'; g.fillStyle = css('--ink2');
    g.fillText(`Band ${b + 1}`, 22, Y(b) + rowH / 2);
    g.textAlign = 'right'; g.font = '10px "IBM Plex Sans", Segoe UI, sans-serif'; g.fillStyle = css('--muted');
    g.fillText(`${fc[b].toFixed(1)}`, padL - 6, Y(b) + rowH / 2);
  }
  g.textAlign = 'center'; g.textBaseline = 'top'; g.font = '11px "IBM Plex Sans", Segoe UI, sans-serif'; g.fillStyle = css('--muted');
  const stepSlots = span > 400 ? 100 : 50;
  for (let t = Math.ceil(t0 / stepSlots) * stepSlots; t <= t1; t += stepSlots) {
    const x = X(t);
    g.strokeStyle = css('--gridline');
    g.beginPath(); g.moveTo(x, padT); g.lineTo(x, padT + h); g.stroke();
    g.fillText(`${sec(t).toFixed(1)}s`, x, padT + h + 5);
  }
  g.font = '11px "IBM Plex Sans", Segoe UI, sans-serif'; g.fillStyle = css('--muted');
  g.textAlign = 'right'; g.fillText('Time (seconds) →', padL + w, padT + h + 20);
  g.save(); g.translate(9, padT + h / 2); g.rotate(-Math.PI / 2); g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('Frequency band (GHz) →', 0, 0); g.restore();
  if (padR > 20) {
    g.textAlign = 'left'; g.textBaseline = 'middle'; g.font = '11px "IBM Plex Sans", Segoe UI, sans-serif';
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

  // ------------------------------------------------ callouts (explanations)
  if (explain && end - t0 > 8) {
    const hw = HOW[run.name] || HOW.dqn;
    const lo = t0 + Math.floor((end - t0) * 0.05);
    // example of a successful detection (most recent)
    let th = -1;
    for (let t = end - 2; t >= lo; t--) if (run.cls[t] === 1) { th = t; break; }
    // example of a missed transmission: prefer a short radar flash the receiver never caught
    let miss = null;
    const caught = run.caughtSet;
    for (const kinds of [['scanning_radar'], null]) {
      for (let t = end - 2; t >= lo && !miss; t--) {
        for (let b = 0; b < N; b++) {
          const o = SIM.truth[b][t];
          if (o < 0 || caught.has(SIM.ev[b][t]) || run.actions[t] === b) continue;
          if (kinds && !kinds.includes(SIM.emitters[o].kind)) continue;
          const id = SIM.ev[b][t];
          let a = t, z = t;
          while (a - 1 >= t0 && SIM.ev[b][a - 1] === id) a--;
          while (z + 1 < end && SIM.ev[b][z + 1] === id) z++;
          if (z - a > 40) continue;
          miss = { b, a, z, o };
          break;
        }
      }
      if (miss) break;
    }
    const by = padT + h + 36;
    const hitBox = { w: 262 }, missBox = { w: 262 };
    if (th >= 0) {
      const cx = X(th) + colW / 2, cy = Y(run.actions[th]) + rowH / 2;
      g.strokeStyle = css('--hit'); g.lineWidth = 2;
      g.strokeRect(X(th) - 4, Y(run.actions[th]) - 2, colW + 8, rowH + 4);
      hitBox.tx = cx; hitBox.ty = Y(run.actions[th]) + rowH + 2;
      hitBox.x = Math.max(padL, Math.min(padL + w - hitBox.w, cx - hitBox.w / 2));
    }
    if (miss) {
      const mx0 = X(miss.a) - 4, mx1 = X(miss.z + 1) + 4;
      g.strokeStyle = css('--miss'); g.lineWidth = 2; g.setLineDash([5, 3]);
      g.strokeRect(mx0, Y(miss.b) - 3, mx1 - mx0, rowH + 6);
      g.setLineDash([]);
      missBox.tx = (mx0 + mx1) / 2; missBox.ty = Y(miss.b) + rowH + 3;
      missBox.x = Math.max(padL, Math.min(padL + w - missBox.w, missBox.tx - missBox.w / 2));
    }
    if (th >= 0 && miss && Math.abs(hitBox.x - missBox.x) < 272) {
      const [left, right] = hitBox.x <= missBox.x ? [hitBox, missBox] : [missBox, hitBox];
      right.x = left.x + 272;
      if (right.x + right.w > padL + w) { right.x = padL + w - right.w; left.x = right.x - 272; }
    }
    if (th >= 0) {
      callout(g, hitBox.x, by, hitBox.w, ['✓ Successful detection', 'Receiver was on the right frequency', 'at the right time.'],
        css('--hit'), hitBox.tx, hitBox.ty);
    }
    if (miss) {
      const e = SIM.emitters[miss.o];
      callout(g, missBox.x, by, missBox.w, [`✗ Missed: ${e.name} (${KIND_NAME[e.kind].toLowerCase()})`,
        'Receiver was listening to another band', 'when this transmission happened.'], css('--miss'), missBox.tx, missBox.ty);
    }
    // the scan pattern
    const tp = t0 + Math.floor((end - t0) * 0.6);
    if (zoomed && tp < end) {
      const px = X(tp) + colW / 2, py = Y(run.actions[tp]) + rowH / 2;
      const bw = 330, bx = Math.max(padL, Math.min(padL + w - bw, px - bw / 2));
      callout(g, bx, 6, bw, [hw.pattern[0], hw.pattern[1]], idx ? css('--b') : css('--a'), px, py);
    }
  }

  box.querySelector('.wf-title').textContent = `${'AB'[idx]}: ${run.label}`;
  box.querySelector('.wf-sub').textContent = view === 'follow'
    ? `showing ${sec(t0).toFixed(1)}–${sec(t1).toFixed(1)} s · pause to study · hover for details`
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
$$('.wf canvas:not(.wf3d)').forEach((cv) => {
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
    ['events', 'Transmissions caught', `of ${playT ? SIM.evCum[t] : 0} sent`, (v) => pct(v), false],
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
  ds.push({ label: 'Transmitted by enemy', data: [], borderColor: css('--muted'), borderDash: [5, 4], pointRadius: 0, borderWidth: 1.4 });
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
      datasets: names.map((n, i) => ({ label: (PLAIN[n] ? PLAIN[n][0] + ' (' + PLAIN[n][1] + ')' : SIM.runs[n].label), data: [], backgroundColor: colors[i], borderRadius: 3, barPercentage: 0.9, categoryPercentage: 0.75 })) },
    options: {
      indexAxis: 'y', animation: false,
      layout: { padding: { right: 38 } },
      scales: {
        x: { min: 0, max: 100, title: { display: true, text: '% of that emitter\'s transmissions caught' }, ticks: { callback: (v) => v + '%' }, grid: { color: GRID } },
        y: { grid: { display: false }, ticks: { color: css('--ink2') } },
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
      if (playTabActive()) drawAll(false);
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
$('#showExplain').addEventListener('change', (e) => { document.body.classList.toggle('no-explain', !e.target.checked); drawAll(); });
window.SmartScanState = {
  get scenario() { return $('#scenarioSel')?.value || 'air_defence'; },
  set scenario(val) {
    if ($('#scenarioSel') && $('#scenarioSel').value !== val) {
      $('#scenarioSel').value = val;
      $('#scenarioSel').dispatchEvent(new Event('change'));
    }
    if ($('#theatre-scenario') && $('#theatre-scenario').value !== val) {
      $('#theatre-scenario').value = val;
    }
  },
  get seed() { return +($('#noiseSeed')?.value || 1); },
  set seed(val) {
    if ($('#noiseSeed') && +$('#noiseSeed').value !== +val) $('#noiseSeed').value = val;
    if ($('#theatre-seed') && +$('#theatre-seed').value !== +val) $('#theatre-seed').value = val;
  },
  get schedA() { return $('#schedA')?.value || 'round_robin'; },
  set schedA(val) {
    if ($('#schedA') && $('#schedA').value !== val) $('#schedA').value = val;
    if ($('#theatre-sched-a') && $('#theatre-sched-a').value !== val) $('#theatre-sched-a').value = val;
  },
  get schedB() { return $('#schedB')?.value || 'model_based'; },
  set schedB(val) {
    if ($('#schedB') && $('#schedB').value !== val) $('#schedB').value = val;
    if ($('#theatre-sched-b') && $('#theatre-sched-b').value !== val) $('#theatre-sched-b').value = val;
  },
  syncFromLive() {
    const sc = $('#scenarioSel')?.value;
    const sd = $('#noiseSeed')?.value;
    const a = $('#schedA')?.value;
    const b = $('#schedB')?.value;
    if ($('#theatre-scenario') && sc && sc !== '__random') $('#theatre-scenario').value = sc;
    if ($('#theatre-seed') && sd) $('#theatre-seed').value = sd;
    if ($('#theatre-sched-a') && a) $('#theatre-sched-a').value = a;
    if ($('#theatre-sched-b') && b) $('#theatre-sched-b').value = b;
  },
  syncFromTheatre() {
    const sc = $('#theatre-scenario')?.value;
    const sd = $('#theatre-seed')?.value;
    const a = $('#theatre-sched-a')?.value;
    const b = $('#theatre-sched-b')?.value;
    if ($('#scenarioSel') && sc && sc !== 'random') {
      $('#scenarioSel').value = sc;
      $('#scenarioSel').dispatchEvent(new Event('change'));
    }
    if ($('#noiseSeed') && sd) $('#noiseSeed').value = sd;
    if ($('#schedA') && a) $('#schedA').value = a;
    if ($('#schedB') && b) $('#schedB').value = b;
  }
};

function setMode(newMode) {
  mode = newMode;
  sessionStorage.setItem('smart_scan_mode', mode);
  $$('#modeSeg button').forEach((x) => x.classList.toggle('on', x.dataset.mode === mode));
  document.body.classList.toggle('mode-simple', mode === 'simple');
  document.body.classList.toggle('mode-detailed', mode === 'detailed');

  const isLiveTab = $('#tab-live')?.classList.contains('active');
  if (isLiveTab && mode === 'detailed') {
    window.SmartScanState?.syncFromLive();
    if (typeof window.onTheatreTabActive === 'function') window.onTheatreTabActive();
    if (window.theatre?.renderAll) window.theatre.renderAll();
    window.dispatchEvent(new Event('resize'));
  } else {
    if (typeof window.onTheatreTabInactive === 'function') window.onTheatreTabInactive();
    if (isLiveTab && mode === 'simple') {
      window.SmartScanState?.syncFromTheatre();
      drawAll();
    }
  }

  if (charts.cum) charts.cum.resize();
  if (BENCH) drawBenchSimple();
  if (LAST_TH) drawTiming(LAST_TH);
}

$$('#modeSeg button').forEach((b) => b.addEventListener('click', () => {
  setMode(b.dataset.mode);
}));
$$('#viewSeg button').forEach((b) => b.addEventListener('click', () => {
  view = b.dataset.view;
  $$('#viewSeg button').forEach((x) => x.classList.toggle('on', x === b));
  drawAll();
}));
window.addEventListener('resize', () => { drawAll(); if (LAST_TH) drawTiming(LAST_TH); });
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT' || !playTabActive()) return;
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
  const rows = [['round_robin', "Today's method", '#c9791a'], ['model_based', 'Smart scan (rules)', '#2d7fe0'], ['dqn', 'AI receiver', '#0b8f6e']]
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
    `On ${BENCH.n_random} battlefields it had never seen, the <b style="color:var(--b)">AI receiver</b> caught <b class="good">${Math.round((b / a - 1) * 100)}% more</b> enemy transmissions than today's method, and <b class="good">${Math.round((tb / ta - 1) * 100)}% more</b> of the dangerous ones.`;
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
        y: { grid: { display: false }, ticks: { color: (c) => (OURS.has(s[c.index].name) ? css('--ink') : css('--muted')),
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
        y: { title: { display: true, text: '% better than round-robin' }, ticks: { callback: (v) => v + '%' }, grid: { color: (c) => (c.tick.value === 0 ? css('--muted') : GRID) } },
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
  g.font = '13px "IBM Plex Sans", Segoe UI, sans-serif'; g.textBaseline = 'middle';
  rows.forEach(([label, Tr, y]) => {
    if (Tr === undefined) return;
    g.fillStyle = css('--ink2'); g.textAlign = 'left'; g.fillText(label, 8, y + 12);
    g.fillStyle = css('--row2'); g.fillRect(padL, y, w, 24);
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
        g.fillStyle = on ? green : css('--muted');
        g.fillRect(X(t) - 1, y + (on ? 0 : 4), on ? 4 : 2, on ? 24 : 16);
      }
    }
    g.textAlign = 'right'; g.font = '600 12px "IBM Plex Sans", Segoe UI, sans-serif';
    if (f === null) { g.fillStyle = css('--miss'); g.fillText('never caught ✗', W - padR - 4, y - 8); }
    else {
      g.fillStyle = green;
      g.fillText(`caught at ${(f * 0.01).toFixed(2)} s ✓`, Math.min(W - padR - 4, X(f) + 120), y - 8);
      g.strokeStyle = green; g.lineWidth = 1.5; g.beginPath(); g.moveTo(X(f) + 1, 44); g.lineTo(X(f) + 1, y); g.stroke();
    }
    g.font = '13px "IBM Plex Sans", Segoe UI, sans-serif';
  });
  g.fillStyle = css('--muted'); g.textAlign = 'center'; g.font = '11px "IBM Plex Sans", Segoe UI, sans-serif';
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
        { type: 'line', label: 'Mean intercept time', data: c.map((x) => x.mean), borderColor: '#2d7fe0', backgroundColor: '#2d7fe0', pointRadius: 2.5, borderWidth: 2, yAxisID: 'y' },
        { type: 'line', label: 'Worst-case intercept time', data: c.map((x) => x.worst), borderColor: '#c9791a', backgroundColor: '#c9791a', pointRadius: 2.5, borderWidth: 2, yAxisID: 'y', spanGaps: false },
        { type: 'bar', label: 'Chance of lock-out', data: c.map((x) => x.p_never), backgroundColor: 'rgba(217, 58, 50, 0.32)', yAxisID: 'y2', barPercentage: 0.9 },
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
        vmarker: { index: bestIdx, label: r.best ? `optimal Tr = ${r.best.T_r}` : '', color: '#0b8f6e' },
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
        { label: 'Train loss', data: p.map((x) => x.train_loss), borderColor: '#2d7fe0', yAxisID: 'y' },
        { label: 'Validation loss', data: p.map((x) => x.val_loss), borderColor: '#c9791a', yAxisID: 'y' },
        { label: 'Validation balanced accuracy', data: p.map((x) => x.balanced_acc_now), borderColor: '#0b8f6e', borderDash: [5, 4], yAxisID: 'y2' },
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
        { label: 'Validation avg reward', data: d.map((x) => x.val_reward), borderColor: '#c9791a', yAxisID: 'y' },
        { label: 'Validation interception ratio', data: d.map((x) => x.val_ir), borderColor: '#0b8f6e', borderDash: [5, 4], yAxisID: 'y2' },
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

/* deep links, e.g. /?mode=detailed&t=560  /?tab=theory  /?shot=%23wfA (render one panel only) */
async function applyDeepLink() {
  const q = new URLSearchParams(location.search);
  const hash = (location.hash || '').replace('#', '').replace('tab-', '');
  let tab = q.get('tab') || (hash ? hash : null);

  // Normalize legacy or alias tab names
  if (tab === 'theatre' || tab === 'live-theatre') {
    tab = 'live';
    setMode('detailed');
  } else if (tab === 'live-scan') {
    tab = 'live';
  } else if (tab === 'projections' || tab === '2d-3d-projections') {
    tab = 'projections';
  }

  const m = q.get('mode') || q.get('view');
  if (m === 'detailed' || m === 'simple') {
    setMode(m);
  }

  if (q.get('wf') === '3d') $$('.wfdim [data-dim="3d"]').forEach((b) => b.click());
  if (q.get('dim') === '2d') document.querySelector('#specDim [data-dim="2d"]')?.click();
  if (q.get('color') === 'power') document.querySelector('#specColor [data-c="power"]')?.click();
  if (q.has('t')) { playing = false; playT = Math.min(SIM.T, +q.get('t')); $('#playBtn').textContent = '▶'; drawAll(); }
  if (tab) {
    switchTab(tab);
    if (tab === 'theory') await runTheory();
    if (tab === 'bench') await loadBench();
  }
  const shot = q.get('shot');
  if (shot) {
    const el = document.querySelector(shot);
    if (!el) return;
    const holder = document.createElement('div');
    holder.style.cssText = `padding:14px;width:${+q.get('w') || 1400}px;background:var(--page)`;
    [...document.body.children].forEach((c) => { if (c.tagName !== 'SCRIPT') c.style.display = 'none'; });
    document.body.appendChild(holder);
    holder.appendChild(el);
    el.classList.remove('hidden');
    drawAll();
    if (LAST_TH) drawTiming(LAST_TH);
    document.body.dataset.ready = '1';
  }
}


/* ------------------------------------------------------------------ ground truth: what the enemy sent */
const KIND_ORDER = ['scanning_radar', 'agile_radar', 'tracking_radar', 'comms', 'beacon'];
function buildTruth() {
  const kc = KIND_COLOR();
  const kinds = KIND_ORDER.filter((k) => SIM.emitters.some((e) => e.kind === k));
  $('#truthKinds').innerHTML = kinds.map((k) => {
    const n = SIM.emitters.filter((e) => e.kind === k).length;
    return `<span class="tk"><i style="background:${kc[k]}"></i>${n} × ${KIND_NAME[k].toLowerCase()}<b id="tk-${k}">0 sent</b></span>`;
  }).join('');
}

function updateTruth() {
  const t = Math.max(0, playT - 1), E = SIM.emitters.length, N = SIM.n_bands;
  const on = playT ? SIM.evStartByEm.filter((ts) => ts.length && ts[0] < playT).length : 0;
  const sent = playT ? SIM.evCum[t] : 0, total = SIM.evEm.length;
  const air = playT ? SIM.airCum[t] : 0;
  const busy = playT ? SIM.busy[t] : 0;
  const names = runNames();
  const caught = names.map((n, i) => {
    const c = playT ? SIM.runs[n].cum[t] : 0;
    return `<div class="ts ${'ab'[i]}"><b>${c}</b><span><span class="dot ${'ab'[i]}"></span>${'AB'[i]}: ${(PLAIN[n] || [SIM.runs[n].label])[0]} ` +
      `caught ${sent ? pct(c / sent) : '0%'} of them</span></div>`;
  }).join('');
  $('#truthStats').innerHTML = `
    <div class="ts"><b>${E}</b><span>emitters in this battlefield (${on} on air so far)</span></div>
    <div class="ts big"><b>${sent}</b><span>signals sent so far, of ${total} in the whole ${sec(SIM.T).toFixed(0)} s run</span></div>
    <div class="ts"><b>${sec(air).toFixed(2)} s</b><span>total on-air time, all bands added up</span></div>
    <div class="ts"><b>${busy}<small>/${N}</small></b><span>bands busy right now</span></div>${caught}`;
  $('#truthClock').textContent = `at ${sec(playT).toFixed(2)} s`;
  const byKind = {};
  SIM.evStartByEm.forEach((ts, e) => {
    const k = SIM.emitters[e].kind;
    byKind[k] = (byKind[k] || 0) + ts.filter((x) => x < playT).length;
  });
  Object.entries(byKind).forEach(([k, v]) => { const el = document.getElementById('tk-' + k); if (el) el.textContent = `${v} sent`; });
}

/* ------------------------------------------------------------------ spectrum view: 3D and 2D projections */
const SPEC_HOME = { yaw: -0.55, pitch: 0.62, zoom: 1 };
const SPEC = { dim: '3d', color: 'kind', ...SPEC_HOME, drag: null };
const POWER_STOPS = [[0, [27, 42, 94]], [0.3, [36, 110, 196]], [0.55, [22, 170, 160]], [0.8, [176, 205, 60]], [1, [250, 206, 40]]];
function powerRGB(v) {
  v = Math.max(0, Math.min(1, v));
  for (let i = 1; i < POWER_STOPS.length; i++) {
    const [p1, c1] = POWER_STOPS[i];
    if (v <= p1) {
      const [p0, c0] = POWER_STOPS[i - 1], f = (v - p0) / (p1 - p0);
      return c0.map((c, j) => Math.round(c + (c1[j] - c) * f));
    }
  }
  return POWER_STOPS.at(-1)[1];
}
function specRange() {
  if (!SIM.pRange) {
    let mx = -Infinity;
    SIM.power.forEach((row) => row.forEach((p) => { if (p !== null && p > mx) mx = p; }));
    const lo = Math.floor(SIM.receiver.noise_floor_dbm);
    SIM.pRange = [lo, Math.max(lo + 10, Math.ceil(mx / 5) * 5)];
  }
  return SIM.pRange;
}
const pNorm = (p) => { const [lo, hi] = specRange(); return p === null ? 0 : Math.max(0.02, (p - lo) / (hi - lo)); };

function specCanvas(cv = $('#specCanvas')) {
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  return { g, W, H };
}

function drawSpectrum() {
  const isProj = $('#tab-projections')?.classList.contains('active');
  const isLiveDetailed = $('#tab-live')?.classList.contains('active') && mode === 'detailed';
  const cv = $('#specCanvas');
  if (!SIM || (!isProj && !isLiveDetailed) || !cv || !cv.clientWidth) return;
  if (SPEC.dim === '3d') draw3D(); else draw2D();
  updateSpecSide();
}

/* 3D: one wall per frequency band, height = received power, along time.
   Depth cues: perspective, striped floor, wall shading from base to top, floor shadows,
   and haze that fades walls further from the viewer. Labels are pushed outward from the box. */
const toRGB = (c) => (Array.isArray(c) ? c : [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)));
const mixRGB = (a, b, f) => a.map((v, i) => Math.round(v + (b[i] - v) * f));
const rgba = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

function draw3D(cv = $('#specCanvas'), st = SPEC, focus = null) {
  const { g, W, H } = specCanvas(cv);
  const { n_bands: N, truth, power } = SIM;
  const [t0, t1] = viewWindow();
  const tEnd = Math.min(t1, playT);
  const kc = KIND_COLOR();
  const [lo, hi] = specRange();
  const colorBy = focus ? 'kind' : SPEC.color;
  const PAGE = toRGB(css('--page')), INK = toRGB(css('--ink'));
  const cy = Math.cos(st.yaw), sy = Math.sin(st.yaw), cp = Math.cos(st.pitch), sp = Math.sin(st.pitch);
  const LX = 1.3, LY = 0.78, LZ = 0.72, CAM = 3.0;
  const S = Math.min(W / 3.4, H / 2.45) * st.zoom, cx = W * 0.49, cyS = H * 0.45;
  const rot = (x, y) => [x * cy - y * sy, x * sy + y * cy];
  const depth = (x, y, z = 0) => rot(x, y)[1] * cp - z * sp;
  const P = (x, y, z) => {
    const [x1, y1] = rot(x, y);
    const f = CAM / (CAM + y1 * cp - z * sp);
    return [cx + S * x1 * f, cyS - S * (z * cp + y1 * sp) * f];
  };
  const X = (t) => -LX + (2 * LX * (t - t0)) / Math.max(1, t1 - t0);
  const Yc = (b) => -LY + (2 * LY * (b + 0.5)) / N;
  const Z = (p) => LZ * pNorm(p);
  const path = (pts) => { g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); };
  const poly = (pts, fill, stroke, lw = 1) => {
    path(pts); g.closePath();
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw; g.stroke(); g.lineWidth = 1; }
  };
  const corners = [[-LX, -LY], [LX, -LY], [LX, LY], [-LX, LY]];
  const dVals = corners.map(([x, y]) => depth(x, y));
  const dMin = Math.min(...dVals), dMax = Math.max(...dVals);
  const haze = (d) => (d - dMin) / Math.max(1e-6, dMax - dMin);     // 0 = nearest, 1 = farthest
  const backY = depth(0, LY) > depth(0, -LY) ? LY : -LY, frontY = -backY;
  const backX = depth(LX, 0) > depth(-LX, 0) ? LX : -LX, sideX = -backX;
  const C0 = P(0, 0, 0);
  // text placed just outside the box, in the direction away from its centre
  const label = (x, y, z, text, { off = 10, font = '11.5px', color = css('--muted'), weight = 400 } = {}) => {
    const [px, py] = P(x, y, z);
    let vx = px - C0[0], vy = py - C0[1];
    const n = Math.hypot(vx, vy) || 1; vx /= n; vy /= n;
    g.font = `${weight} ${font} "IBM Plex Sans", sans-serif`;
    g.fillStyle = color;
    g.textAlign = vx > 0.35 ? 'left' : vx < -0.35 ? 'right' : 'center';
    g.textBaseline = 'middle';
    g.fillText(text, px + vx * off, py + vy * off);
    g.textBaseline = 'alphabetic';
  };

  // ---- floor: one stripe per band (alternating), darker towards the viewer
  for (let b = 0; b < N; b++) {
    const y0 = -LY + (2 * LY * b) / N, y1 = -LY + (2 * LY * (b + 1)) / N;
    const base = toRGB(b % 2 ? css('--row2') : css('--row1'));
    const shade = mixRGB(base, INK, 0.05 * (1 - haze(depth(0, (y0 + y1) / 2))));
    poly([P(-LX, y0, 0), P(LX, y0, 0), P(LX, y1, 0), P(-LX, y1, 0)], rgba(shade));
  }
  poly(corners.map(([x, y]) => P(x, y, 0)), null, css('--line'));
  // ---- the two back walls with the power grid
  poly([P(-LX, backY, 0), P(LX, backY, 0), P(LX, backY, LZ), P(-LX, backY, LZ)], 'rgba(31,59,110,0.04)', css('--line'));
  poly([P(backX, -LY, 0), P(backX, LY, 0), P(backX, LY, LZ), P(backX, -LY, LZ)], 'rgba(31,59,110,0.065)', css('--line'));
  const pTicks = [];
  for (let p = Math.ceil(lo / 10) * 10; p <= hi; p += 10) pTicks.push(p);
  g.strokeStyle = 'rgba(22,35,59,0.09)';
  for (const p of pTicks) {
    const z = Z(p);
    path([P(-LX, backY, z), P(LX, backY, z)]); g.stroke();
    path([P(backX, -LY, z), P(backX, LY, z)]); g.stroke();
  }
  // ---- time grid on the floor
  const span = t1 - t0, tStep = span > 600 ? 200 : span > 300 ? 100 : 50;
  g.strokeStyle = 'rgba(22,35,59,0.10)';
  for (let t = Math.ceil(t0 / tStep) * tStep; t <= t1; t += tStep) { path([P(X(t), -LY, 0), P(X(t), LY, 0)]); g.stroke(); }

  // ---- receiver path on the floor (focus mode)
  if (focus && tEnd > t0) {
    g.strokeStyle = rgba(toRGB(focus.col), 0.35); g.lineWidth = 1;
    path([...Array(tEnd - t0).keys()].map((k) => P(X(t0 + k + 0.5), Yc(focus.r.actions[t0 + k]), 0)));
    g.stroke(); g.lineWidth = 1;
  }

  // ---- walls, far to near (bands are parallel planes, so this ordering is exact)
  const order = [...Array(N).keys()].sort((a, b) => depth(0, Yc(b)) - depth(0, Yc(a)));
  const showLooks = !focus && $('#specLooks').checked;
  const looks = runNames().map((n, i) => ({ r: SIM.runs[n], col: [css('--a'), css('--b')][i], off: i ? 0.28 : -0.28 }));
  for (const b of order) {
    const yb = Yc(b), hz = haze(depth(0, yb));
    if (showLooks) {
      for (const { r, col, off } of looks) {
        for (let t = t0; t < tEnd; t++) {
          if (r.actions[t] !== b) continue;
          const [x, y] = P(X(t + 0.5), yb + (off * 2 * LY) / N, 0);
          const c = r.cls[t];
          g.beginPath(); g.arc(x, y, c === 1 ? 2.6 : 1.7, 0, 7);
          if (c === 1) { g.fillStyle = col; g.fill(); }
          else if (c === 2) { g.strokeStyle = css('--miss'); g.stroke(); }
          else { g.fillStyle = 'rgba(93,108,130,0.35)'; g.fill(); }
        }
      }
    }
    let t = t0;
    while (t < tEnd) {
      const o = truth[b][t];
      if (o < 0) { t++; continue; }
      let u = t, mx = -Infinity;
      while (u < tEnd && truth[b][u] === o) { mx = Math.max(mx, power[b][u]); u++; }
      // soft shadow on the floor, cast towards the back
      const sh = 0.5 * (2 * LY) / N * (backY > 0 ? 1 : -1);
      poly([P(X(t), yb, 0), P(X(u), yb, 0), P(X(u), yb + sh, 0), P(X(t), yb + sh, 0)], 'rgba(22,35,59,0.07)');
      const top = [];
      for (let k = t; k < u; k++) { const z = Z(power[b][k]); top.push(P(X(k), yb, z), P(X(k + 1), yb, z)); }
      let col = colorBy === 'kind' ? toRGB(kc[SIM.emitters[o].kind]) : powerRGB(pNorm(mx));
      col = mixRGB(col, PAGE, 0.45 * hz);                                  // haze: far walls fade
      const alpha = focus ? 0.32 : 0.92 - 0.25 * hz;
      const [bx, by] = P(X(t), yb, 0), [tx, ty] = P(X(t), yb, Z(mx));
      const grad = g.createLinearGradient(bx, by, tx, ty);
      grad.addColorStop(0, rgba(mixRGB(col, INK, 0.35), alpha));            // darker at the base
      grad.addColorStop(1, rgba(col, alpha));
      poly([P(X(t), yb, 0), ...top, P(X(u), yb, 0)], grad);
      g.strokeStyle = rgba(mixRGB(col, INK, 0.45), focus ? 0.35 : 0.9);
      path(top); g.stroke();
      t = u;
    }
    if (focus) {
      for (let k = t0; k < tEnd; k++) {
        if (focus.r.actions[k] !== b) continue;
        const c = focus.r.cls[k], [x, y] = P(X(k + 0.5), yb, 0);
        if (c === 1) {
          const [xt, yt] = P(X(k + 0.5), yb, Z(power[b][k]) + 0.05);
          g.strokeStyle = focus.col; g.lineWidth = 2; path([[x, y], [xt, yt]]); g.stroke(); g.lineWidth = 1;
          g.beginPath(); g.arc(xt, yt, 3.6, 0, 7); g.fillStyle = css('--hit'); g.fill(); g.strokeStyle = '#fff'; g.stroke();
        } else if (c === 2) {
          g.beginPath(); g.arc(x, y, 3.4, 0, 7); g.strokeStyle = css('--miss'); g.lineWidth = 1.8; g.stroke(); g.lineWidth = 1;
        } else if (c === 3) {
          g.beginPath(); g.arc(x, y, 3, 0, 7); g.fillStyle = css('--fa'); g.fill();
        } else {
          g.beginPath(); g.arc(x, y, 1.6, 0, 7); g.fillStyle = 'rgba(93,108,130,0.6)'; g.fill();
        }
      }
    }
  }

  // ---- "now" plane
  if (playT > t0 && playT <= t1) {
    const xn = X(playT);
    poly([P(xn, -LY, 0), P(xn, LY, 0), P(xn, LY, LZ), P(xn, -LY, LZ)], 'rgba(31,59,110,0.07)', 'rgba(31,59,110,0.55)', 1.2);
    const [px, py] = P(xn, frontY, LZ);
    const txt = `now ${sec(playT).toFixed(2)} s`;
    g.font = '600 11px "IBM Plex Sans", sans-serif';
    const tw = g.measureText(txt).width + 12;
    g.fillStyle = css('--navy'); g.beginPath(); g.roundRect(px - tw / 2, py - 24, tw, 18, 9); g.fill();
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.fillText(txt, px, py - 11);
  }

  // ---- axes: power (vertical edge nearest the viewer), time (front edge), frequency (side edge)
  g.strokeStyle = css('--ink2'); g.lineWidth = 1.2;
  path([P(backX, frontY, 0), P(backX, frontY, LZ)]); g.stroke();
  path([P(-LX, frontY, 0), P(LX, frontY, 0)]); g.stroke();
  path([P(sideX, -LY, 0), P(sideX, LY, 0)]); g.stroke();
  g.lineWidth = 1;
  for (const p of pTicks) label(backX, frontY, Z(p), String(p), { off: 8 });
  label(backX, frontY, LZ + 0.1, 'Power (dBm)', { off: 6, color: css('--ink2'), weight: 600, font: '12px' });
  for (let t = Math.ceil(t0 / tStep) * tStep; t < t1 - tStep * 0.3; t += tStep) label(X(t), frontY, 0, sec(t).toFixed(1), { off: 12 });
  label(0, frontY * 1.32, 0, 'Time (s)', { off: 14, color: css('--ink2'), weight: 600, font: '12px' });
  const fStep = N > 12 ? 3 : N > 6 ? 2 : 1;
  for (let b = 0; b < N; b += fStep) label(sideX, Yc(b), 0, String(SIM.receiver.band_centers_ghz[b]), { off: 12 });
  label(sideX * 1.18, 0, 0, 'Frequency (GHz)', { off: 18, color: css('--ink2'), weight: 600, font: '12px' });

  g.fillStyle = css('--muted'); g.font = '11px "IBM Plex Sans", sans-serif'; g.textAlign = 'left';
  g.fillText('Drag to rotate, scroll to zoom, double-click to reset', 10, H - 10);
}

/* 2D: top view (frequency vs time) + side view (frequency vs power) */
function powerLayer() {
  if (!SIM.powerLayer) {
    SIM.powerLayer = renderGrid((b, t) => {
      const p = SIM.power[b][t];
      return p === null ? null : [`rgb(${powerRGB(pNorm(p))})`, 1];
    });
  }
  return SIM.powerLayer;
}
function draw2D() {
  const { g, W, H } = specCanvas();
  const { n_bands: N, truth, power } = SIM;
  const [t0, t1] = viewWindow();
  const tEnd = Math.min(t1, playT);
  const [lo, hi] = specRange();
  const padL = 64, padT = 28, padB = 44, gap = 28, sideW = Math.min(230, W * 0.24);
  const w = W - padL - sideW - gap - 16, h = H - padT - padB;
  const rowH = h / N, span = t1 - t0;
  const xOf = (t) => padL + ((t - t0) / span) * w;
  const yOf = (b) => padT + (N - 1 - b) * rowH;
  g.fillStyle = css('--ink2'); g.font = '600 12px "IBM Plex Sans", sans-serif'; g.textAlign = 'left';
  g.fillText('Top view: frequency over time (looking down on the 3D plot)', padL, 16);
  g.fillText('Side view: power per frequency', padL + w + gap, 16);
  g.font = '11px "IBM Plex Sans", sans-serif';
  for (let b = 0; b < N; b++) {
    g.fillStyle = b % 2 ? css('--row2') : css('--row1');
    g.fillRect(padL, yOf(b), w, rowH);
    g.fillStyle = css('--muted'); g.textAlign = 'right';
    if (N <= 20 || b % 2 === 0) g.fillText(`${SIM.receiver.band_centers_ghz[b]} GHz`, padL - 6, yOf(b) + rowH / 2 + 4);
  }
  g.imageSmoothingEnabled = false;
  const layer = SPEC.color === 'kind' ? SIM.truthLayer : powerLayer();
  if (tEnd > t0) g.drawImage(layer, t0, 0, tEnd - t0, N, padL, padT, ((tEnd - t0) / span) * w, h);
  if ($('#specLooks').checked) {
    runNames().forEach((n, i) => {
      const r = SIM.runs[n], col = [css('--a'), css('--b')][i];
      const cw = Math.max(1.5, w / span);
      for (let t = t0; t < tEnd; t++) {
        const b = r.actions[t], c = r.cls[t];
        g.fillStyle = c === 1 ? col : c === 2 ? css('--miss') : 'rgba(93,108,130,0.45)';
        g.fillRect(xOf(t), yOf(b) + (i ? rowH * 0.62 : rowH * 0.12), cw, rowH * 0.26);
      }
    });
  }
  g.fillStyle = css('--muted'); g.textAlign = 'center'; g.strokeStyle = css('--gridline');
  const tStep = span > 400 ? 100 : 50;
  for (let t = Math.ceil(t0 / tStep) * tStep; t <= t1; t += tStep) {
    const x = xOf(t);
    g.beginPath(); g.moveTo(x, padT); g.lineTo(x, padT + h); g.stroke();
    g.fillText(`${sec(t).toFixed(1)} s`, x, padT + h + 15);
  }
  g.fillStyle = css('--ink2'); g.fillText('Time →', padL + w / 2, padT + h + 34);
  if (playT > t0 && playT <= t1) {
    g.strokeStyle = css('--navy'); g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(xOf(playT), padT - 4); g.lineTo(xOf(playT), padT + h); g.stroke(); g.lineWidth = 1;
  }
  // side view: strongest signal per band in the window (bar), power right now (black tick)
  const sx = padL + w + gap, pw = sideW;
  const px = (p) => sx + ((p - lo) / (hi - lo)) * pw;
  const kc = KIND_COLOR();
  const tn = Math.max(0, playT - 1);
  for (let b = 0; b < N; b++) {
    g.fillStyle = b % 2 ? css('--row2') : css('--row1');
    g.fillRect(sx, yOf(b), pw, rowH);
    let mx = null, who = -1;
    for (let t = t0; t < tEnd; t++) { const p = power[b][t]; if (p !== null && (mx === null || p > mx)) { mx = p; who = truth[b][t]; } }
    if (mx !== null) {
      g.fillStyle = SPEC.color === 'kind' ? kc[SIM.emitters[who].kind] : `rgb(${powerRGB(pNorm(mx))})`;
      g.globalAlpha = 0.6; g.fillRect(sx, yOf(b) + rowH * 0.2, px(mx) - sx, rowH * 0.6); g.globalAlpha = 1;
    }
    const now = playT ? power[b][tn] : null;
    if (now !== null && now !== undefined) { g.fillStyle = css('--ink'); g.fillRect(px(now) - 1.5, yOf(b) + 1, 3, rowH - 2); }
  }
  g.fillStyle = css('--muted'); g.textAlign = 'center';
  for (let p = Math.ceil(lo / 10) * 10; p <= hi; p += 10) g.fillText(`${p}`, px(p), padT + h + 15);
  const xs = px(SIM.receiver.sensitivity_dbm_pd90);
  g.strokeStyle = css('--miss'); g.setLineDash([4, 3]);
  g.beginPath(); g.moveTo(xs, padT); g.lineTo(xs, padT + h); g.stroke(); g.setLineDash([]);
  g.fillStyle = css('--miss'); g.textAlign = 'left'; g.fillText('← too weak to detect reliably', xs + 4, padT + h + 34);
  g.fillStyle = css('--ink2'); g.textAlign = 'right'; g.fillText('dBm', sx + pw, padT + h + 15);
}

function updateSpecSide() {
  const kc = KIND_COLOR();
  const [lo, hi] = specRange();
  const lookKey = $('#specLooks').checked
    ? `<div class="lk"><span class="dot a"></span><span class="dot b"></span>Where A and B listened: coloured = caught, <i class="mk miss"></i>red = signal there but missed, grey = empty band</div>`
    : '';
  if (SPEC.color === 'kind') {
    $('#specLegend').innerHTML = KIND_ORDER.filter((k) => SIM.emitters.some((e) => e.kind === k))
      .map((k) => `<div><i style="background:${kc[k]}"></i>${KIND_NAME[k]}</div>`).join('') + lookKey;
  } else {
    const grad = POWER_STOPS.map(([p, c]) => `rgb(${c}) ${p * 100}%`).join(',');
    $('#specLegend').innerHTML = `<div class="cbar" style="background:linear-gradient(90deg,${grad})"></div>
      <div class="cbar-l"><span>${lo} dBm<br>noise floor</span><span>${hi} dBm<br>strongest</span></div>` + lookKey;
  }
  const [t0, t1] = viewWindow();
  $('#specSub').textContent = `All ${SIM.emitters.length} emitters across ${SIM.n_bands} bands (${SIM.receiver.band_centers_ghz[0]}–${SIM.receiver.band_centers_ghz.at(-1)} GHz), ` +
    `${sec(t0).toFixed(1)}–${sec(t1).toFixed(1)} s. This is the truth: each receiver can only hear one band at a time.`;
  $('#specHow').innerHTML = SPEC.dim === '3d'
    ? 'Each row on the floor is one frequency band and time runs left to right. The <b>height</b> of a wall is how strong that signal is at our receiver. ' +
      'Tall thin spikes are radar beams sweeping past us, long low walls are radio links, and walls that jump between rows are frequency-hopping radars.'
    : 'The same 3D data flattened two ways. <b>Top view</b>: looking down from above, each coloured block is one transmission. ' +
      '<b>Side view</b>: looking along the time axis, each bar is the strongest signal in that band in this window, and the black tick is its power right now.';
  const t = Math.max(0, playT - 1), rows = [];
  for (let b = SIM.n_bands - 1; b >= 0; b--) {
    const o = SIM.truth[b][t];
    if (playT && o >= 0) {
      rows.push(`<div><i style="background:${kc[SIM.emitters[o].kind]}"></i><span class="f">${SIM.receiver.band_centers_ghz[b]} GHz</span>` +
        `<b>${SIM.emitters[o].name}</b><span class="p">${SIM.power[b][t]} dBm</span></div>`);
    }
  }
  $('#specBands').innerHTML = `<b>On air right now (${rows.length})</b>` + (rows.join('') || '<div class="muted">nothing transmitting</div>');
}

$$('#specDim button').forEach((b) => b.addEventListener('click', () => {
  SPEC.dim = b.dataset.dim;
  $$('#specDim button').forEach((x) => x.classList.toggle('on', x === b));
  $('#specReset').classList.toggle('hidden', SPEC.dim !== '3d');
  drawSpectrum();
}));
$$('#specColor button').forEach((b) => b.addEventListener('click', () => {
  SPEC.color = b.dataset.c;
  $$('#specColor button').forEach((x) => x.classList.toggle('on', x === b));
  drawSpectrum();
}));
$('#specLooks').addEventListener('change', drawSpectrum);
$('#specReset').addEventListener('click', () => { Object.assign(SPEC, SPEC_HOME); drawSpectrum(); });
(() => {
  const cv = $('#specCanvas');
  cv.addEventListener('pointerdown', (e) => {
    if (SPEC.dim !== '3d') return;
    SPEC.drag = [e.clientX, e.clientY]; cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener('pointermove', (e) => {
    if (!SPEC.drag) return;
    SPEC.yaw += (e.clientX - SPEC.drag[0]) * 0.008;
    SPEC.pitch = Math.max(0.08, Math.min(1.45, SPEC.pitch + (e.clientY - SPEC.drag[1]) * 0.006));
    SPEC.drag = [e.clientX, e.clientY];
    drawSpectrum();
  });
  cv.addEventListener('pointerup', () => { SPEC.drag = null; });
  cv.addEventListener('dblclick', () => { if (SPEC.dim === '3d') { Object.assign(SPEC, SPEC_HOME); drawSpectrum(); } });
  cv.addEventListener('wheel', (e) => {
    if (SPEC.dim !== '3d') return;
    e.preventDefault();
    SPEC.zoom = Math.max(0.5, Math.min(2.5, SPEC.zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
    drawSpectrum();
  }, { passive: false });
})();

/* 3D projection of each receiver's scan graph */
const WF3D = [{ ...SPEC_HOME }, { ...SPEC_HOME }];
['A', 'B'].forEach((id, i) => {
  const box = $('#wf' + id), cv = box.querySelector('canvas.wf3d'), st = WF3D[i];
  box.querySelectorAll('.wfdim button').forEach((b) => b.addEventListener('click', () => {
    box.querySelectorAll('.wfdim button').forEach((x) => x.classList.toggle('on', x === b));
    box.classList.toggle('is3d', b.dataset.dim === '3d');
    drawAll();
  }));
  cv.addEventListener('pointerdown', (e) => { st.drag = [e.clientX, e.clientY]; cv.setPointerCapture(e.pointerId); });
  cv.addEventListener('pointermove', (e) => {
    if (!st.drag) return;
    st.yaw += (e.clientX - st.drag[0]) * 0.008;
    st.pitch = Math.max(0.08, Math.min(1.45, st.pitch + (e.clientY - st.drag[1]) * 0.006));
    st.drag = [e.clientX, e.clientY];
    drawAll();
  });
  cv.addEventListener('pointerup', () => { st.drag = null; });
  cv.addEventListener('dblclick', () => { Object.assign(st, SPEC_HOME); drawAll(); });
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    st.zoom = Math.max(0.5, Math.min(2.5, st.zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
    drawAll();
  }, { passive: false });
});

requestAnimationFrame(tick);
init();
