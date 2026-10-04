/* Live Intercept Theatre - Animated Scene Engine (Phase 2) */

(function () {
  'use strict';

  // Fixed visual palette matching explanation.png
  const PALETTE = {
    nav_beacon: '#3fa34d',   // NavBeacon: Grass Green
    agile_acq:  '#8455e6',   // Agile-Acq: Royal Purple
    search_c:   '#e0523f',   // Search-C: Coral Red
    fire_ctl:   '#f39c12',   // FireCtl: Amber / Gold
    search_b:   '#2980b9',   // Search-B: Deep Blue
    search_a:   '#16a085',   // Search-A: Teal / Cyan
    voice:      '#cf2f78',   // Voice: Magenta / Pink
    datalink:   '#5dade2',   // Datalink: Sky Blue
  };

  const STATUS_COLOR = {
    hit:   '#10b981', // Green
    miss:  '#ef4444', // Red
    fa:    '#f59e0b', // Amber
    dwell: '#38bdf8', // Cyan
  };

  // State
  let INFO = null;
  let traceA = null;
  let traceB = null;
  let isCompare = false;
  let currentSlot = 0;
  let isPlaying = false;
  let speed = 1.0;
  let revealFuture = true;
  let lastTime = 0;
  let animId = null;
  let tabActive = false;

  // Smoothing angle state for antenna beam
  let beamAngleA = -Math.PI / 2;
  let beamAngleB = -Math.PI / 2;
  let lastPhaseA = null;
  let lastPhaseB = null;

  // Band node flash highlight state (from chip click)
  let flashBandNode = null;
  let flashBandUntil = 0;

  // Pre-indexed lookup caches for fast O(1) rendering
  let msgIndexA = null;
  let msgIndexB = null;

  function $(id) {
    return document.getElementById(id);
  }

  function fitCanvas(canvas) {
    if (!canvas) return null;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // Guarantee CSS layout dimensions are constrained so canvas width/height cannot cause layout blowout
    if (!canvas.style.width && !canvas.classList.contains('theatre-heat-canvas')) {
      canvas.style.width = '100%';
    }
    if (!canvas.style.height && !canvas.classList.contains('theatre-heat-canvas')) {
      canvas.style.height = '100%';
    }
    const rect = canvas.getBoundingClientRect();
    const cssW = canvas.clientWidth || rect.width;
    const cssH = canvas.clientHeight || rect.height;
    if (cssW <= 0 || cssH <= 0) return null;

    // Hard ceiling of 4096px to prevent GPU context loss / texture allocation crashes
    const safeW = Math.min(Math.round(cssW * dpr), 4096);
    const safeH = Math.min(Math.round(cssH * dpr), 4096);

    if (canvas.width !== safeW || canvas.height !== safeH) {
      canvas.width = safeW;
      canvas.height = safeH;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.resetTransform?.();
    ctx.scale(safeW / cssW, safeH / cssH);
    return { ctx, w: cssW, h: cssH, dpr };
  }

  function smoothAngle(current, target, dt, speedFactor = 22.0) {
    let diff = (target - current + Math.PI * 3) % (Math.PI * 2) - Math.PI;
    return current + diff * Math.min(1.0, speedFactor * dt);
  }

  function buildMessageIndex(trace) {
    if (!trace || !trace.messages) return null;
    const byBand = Array.from({ length: trace.bands.length }, () => []);
    const messages = trace.messages.map((m, idx) => {
      const outcome = (trace.outcomes && trace.outcomes[idx]) || {
        status: 'MISSED_NOT_LISTENING',
        message_id: m.id,
        n_hit_slots: 0,
        n_listen_slots: 0,
      };
      const enriched = { ...m, outcome };
      if (byBand[m.band]) {
        byBand[m.band].push(enriched);
      }
      return enriched;
    });
    return { byBand, messages, outcomes: trace.outcomes };
  }

  // ---------------------------------------------------------------- API & Load
  async function apiCall(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      let msg = r.statusText;
      try {
        const j = await r.json();
        msg = j.detail || msg;
      } catch (e) { /* ignore */ }
      throw new Error(msg);
    }
    return r.json();
  }

  async function loadTraceFor(schedName, scenario, seed) {
    return await apiCall('/api/trace', {
      scheduler: schedName,
      scenario: scenario,
      seed: parseInt(seed, 10) || 0,
    });
  }

  async function runSimulation() {
    const schedA = $('theatre-sched-a').value;
    const schedB = $('theatre-sched-b').value;
    const scenario = $('theatre-scenario').value;
    const seed = parseInt($('theatre-seed').value, 10) || 0;
    const btn = $('theatre-run-btn');
    const errBox = $('theatre-error');

    errBox.classList.remove('show');
    errBox.textContent = '';
    btn.disabled = true;
    btn.textContent = '⏳ Loading trace...';

    try {
      traceA = await loadTraceFor(schedA, scenario, seed);
      msgIndexA = buildMessageIndex(traceA);

      if (isCompare) {
        traceB = await loadTraceFor(schedB, scenario, seed);
        msgIndexB = buildMessageIndex(traceB);
      } else {
        traceB = null;
        msgIndexB = null;
      }

      currentSlot = 0;
      isPlaying = false;
      updatePlayButton();

      const nSlots = traceA.meta.n_slots;
      const scrubber = $('theatre-scrub');
      scrubber.min = 0;
      scrubber.max = nSlots;
      scrubber.value = 0;

      if ($('scene-a-sched-name')) {
        const optA = $('theatre-sched-a').selectedOptions[0];
        $('scene-a-sched-name').textContent = optA ? optA.text : schedA;
      }
      if ($('scene-b-sched-name')) {
        const optB = $('theatre-sched-b').selectedOptions[0];
        $('scene-b-sched-name').textContent = optB ? optB.text : schedB;
      }

      updateSceneVisibility();
      renderAll(0);

      // Auto-update reconciliation view if container was already opened and populated
      const recContainer = $('theatre-reconcile');
      if (recContainer && recContainer.dataset.initialized === 'true' && recContainer.querySelector('.theatre-reconcile-card') && typeof window.onRunFinished === 'function') {
        window.onRunFinished(traceA, traceB);
      }
    } catch (e) {
      errBox.textContent = `Simulation error: ${e.message}`;
      errBox.classList.add('show');
    } finally {
      btn.disabled = false;
      btn.textContent = '▶ Run Theater';
    }
  }

  // ---------------------------------------------------------------- Controls
  function togglePlay() {
    if (!traceA) return;
    isPlaying = !isPlaying;
    if (isPlaying && currentSlot >= traceA.meta.n_slots) {
      currentSlot = 0;
    }
    lastTime = performance.now();
    updatePlayButton();
  }

  function stepSlot(delta) {
    if (!traceA) return;
    isPlaying = false;
    updatePlayButton();
    const maxSlots = traceA.meta.n_slots;
    currentSlot = Math.max(0, Math.min(maxSlots, currentSlot + delta));
    $('theatre-scrub').value = currentSlot;
    renderAll(0);
  }

  function seekToSlot(slot, highlightBand = null) {
    if (!traceA) return;
    isPlaying = false;
    updatePlayButton();
    const maxSlots = traceA.meta.n_slots;
    currentSlot = Math.max(0, Math.min(maxSlots, slot));
    $('theatre-scrub').value = currentSlot;
    if (highlightBand !== null) {
      flashBandNode = highlightBand;
      flashBandUntil = performance.now() + 2500;
    }
    renderAll(0);
    if (typeof window.theatreCaptionTick === 'function') {
      window.theatreCaptionTick(currentSlot);
    }
    const stage = $('theatre-stage');
    if (stage) {
      stage.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  function setTraces(tA, tB = null, isCompareMode = false) {
    traceA = tA;
    msgIndexA = buildMessageIndex(traceA);
    traceB = tB;
    msgIndexB = traceB ? buildMessageIndex(traceB) : null;
    isCompare = Boolean(isCompareMode && traceB);
    currentSlot = 0;
    isPlaying = false;
    updatePlayButton();
    const nSlots = traceA.meta.n_slots;
    const scrubber = $('theatre-scrub');
    if (scrubber) {
      scrubber.min = 0;
      scrubber.max = nSlots;
      scrubber.value = 0;
    }
    if ($('theatre-compare-toggle')) {
      $('theatre-compare-toggle').checked = isCompare;
    }
    if ($('scene-a-sched-name')) {
      $('scene-a-sched-name').textContent = traceA.meta.scheduler.replace('_', ' ');
    }
    if ($('scene-b-sched-name') && traceB) {
      $('scene-b-sched-name').textContent = traceB.meta.scheduler.replace('_', ' ');
    }
    updateSceneVisibility();
    renderAll(0);
  }

  function play() {
    if (!traceA) return;
    if (currentSlot >= traceA.meta.n_slots) currentSlot = 0;
    isPlaying = true;
    lastTime = performance.now();
    updatePlayButton();
  }

  function pause() {
    isPlaying = false;
    updatePlayButton();
  }

  function setSpeed(newSpeed) {
    speed = newSpeed;
    if ($('theatre-speed')) $('theatre-speed').value = newSpeed;
    if ($('theatre-speed-val')) $('theatre-speed-val').textContent = `${newSpeed}x`;
  }

  function reset() {
    isPlaying = false;
    currentSlot = 0;
    updatePlayButton();
    if ($('theatre-scrub')) $('theatre-scrub').value = 0;
    beamAngleA = -Math.PI / 2;
    beamAngleB = -Math.PI / 2;
    renderAll(0);
    if (typeof window.theatreCaptionTick === 'function') {
      window.theatreCaptionTick(0);
    }
  }

  function updatePlayButton() {
    const btn = $('theatre-play-btn');
    btn.innerHTML = isPlaying ? '⏸' : '▶';
    btn.title = isPlaying ? 'Pause (Space)' : 'Play (Space)';
  }

  function updateSceneVisibility() {
    const stage = $('theatre-stage');
    const sceneB = $('theatre-scene-b');
    const schedBWrap = $('theatre-sched-b-wrap');

    if (isCompare) {
      stage.classList.add('compare');
      sceneB.classList.remove('hidden');
      schedBWrap.classList.remove('hidden');
    } else {
      stage.classList.remove('compare');
      sceneB.classList.add('hidden');
      schedBWrap.classList.add('hidden');
    }
  }

  // ---------------------------------------------------------------- Rendering
  // View 1: Network View (Circular Ring & Central Sweeping Antenna)
  function renderNetworkRing(canvas, trace, indexData, slot, beamAngleRef) {
    const fit = fitCanvas(canvas);
    if (!fit) return beamAngleRef;
    const { ctx, w, h } = fit;

    ctx.clearRect(0, 0, w, h);

    const N = trace.bands.length;
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(cx, cy) * 0.72;
    const rxRadius = 22;
    const nodeRadius = 14;

    const curInt = Math.min(trace.meta.n_slots - 1, Math.max(0, Math.floor(slot)));
    const targetBand = trace.dwell[curInt];
    const targetAngle = -Math.PI / 2 + (targetBand / N) * Math.PI * 2;

    // Smooth beam angle tracking
    const newBeamAngle = smoothAngle(beamAngleRef, targetAngle, 0.016, 20.0);

    // 1. Dark ring guide
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(71, 85, 105, 0.25)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 2. Fading trail of recent visits (last 30 dwells)
    const TRAIL_LEN = 30;
    for (let k = TRAIL_LEN; k >= 0; k--) {
      const t = curInt - k;
      if (t >= 0 && t < trace.dwell.length) {
        const b = trace.dwell[t];
        const theta = -Math.PI / 2 + (b / N) * Math.PI * 2;
        const nx = cx + R * Math.cos(theta);
        const ny = cy + R * Math.sin(theta);
        const alpha = ((TRAIL_LEN - k) / TRAIL_LEN) * 0.45;

        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(nx, ny);
        ctx.strokeStyle = `rgba(56, 189, 248, ${alpha})`;
        ctx.lineWidth = k === 0 ? 2.5 : 1.2;
        ctx.stroke();
      }
    }

    // 3. Central Antenna Beam Wedge
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    const wedgeHalf = 0.16; // radians (~9 degrees)
    ctx.arc(cx, cy, R * 1.05, newBeamAngle - wedgeHalf, newBeamAngle + wedgeHalf);
    ctx.closePath();
    const beamGrad = ctx.createRadialGradient(cx, cy, rxRadius, cx, cy, R);
    beamGrad.addColorStop(0, 'rgba(56, 189, 248, 0.55)');
    beamGrad.addColorStop(1, 'rgba(56, 189, 248, 0.0)');
    ctx.fillStyle = beamGrad;
    ctx.fill();

    // Direct needle beam
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + R * 0.96 * Math.cos(newBeamAngle), cy + R * 0.96 * Math.sin(newBeamAngle));
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.9)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    // 4. Center Receiver Node
    ctx.beginPath();
    ctx.arc(cx, cy, rxRadius, 0, Math.PI * 2);
    ctx.fillStyle = '#0f172a';
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = targetBand !== undefined ? '#38bdf8' : '#475569';
    ctx.stroke();

    // Concentric inner radar circle
    ctx.beginPath();
    ctx.arc(cx, cy, rxRadius * 0.45, 0, Math.PI * 2);
    ctx.fillStyle = '#38bdf8';
    ctx.fill();

    // Receiver Label
    ctx.fillStyle = '#94a3b8';
    ctx.font = '600 10px "IBM Plex Sans", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('ES RX', cx, cy + rxRadius + 4);

    // 5. Band Nodes on Ring
    for (let b = 0; b < N; b++) {
      const theta = -Math.PI / 2 + (b / N) * Math.PI * 2;
      const nx = cx + R * Math.cos(theta);
      const ny = cy + R * Math.sin(theta);
      const isTarget = b === targetBand;

      // Check active emitter transmissions right now
      const activeMsgs = (indexData?.byBand[b] || []).filter(
        (m) => m.start_slot <= curInt && curInt <= m.end_slot
      );
      const hasActive = activeMsgs.length > 0;

      // Pulse expanding shockwave rings if transmitting
      if (hasActive) {
        const emColor = PALETTE[activeMsgs[0].color_key] || '#e0523f';
        const pulsePhase = (slot * 1.8) % 1.0;
        const pulseR = nodeRadius + pulsePhase * 16;
        const pulseAlpha = (1.0 - pulsePhase) * 0.75;

        ctx.beginPath();
        ctx.arc(nx, ny, pulseR, 0, Math.PI * 2);
        ctx.strokeStyle = emColor;
        ctx.lineWidth = 2;
        ctx.globalAlpha = pulseAlpha;
        ctx.stroke();
        ctx.globalAlpha = 1.0;
      }

      // Node background circle
      ctx.beginPath();
      ctx.arc(nx, ny, nodeRadius, 0, Math.PI * 2);
      ctx.fillStyle = isTarget ? '#1e293b' : '#0b1120';
      ctx.fill();
      ctx.lineWidth = isTarget ? 2.5 : 1.5;
      ctx.strokeStyle = isTarget ? '#38bdf8' : '#475569';
      ctx.stroke();

      // Flashing highlight if this band was clicked from a reconciliation chip
      if (flashBandNode === b && performance.now() < flashBandUntil) {
        const flashAlpha = 0.5 + 0.5 * Math.sin(performance.now() * 0.015);
        ctx.beginPath();
        ctx.arc(nx, ny, nodeRadius + 8, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(245, 158, 11, ${flashAlpha})`;
        ctx.lineWidth = 3.5;
        ctx.stroke();
      }

      // Band text badge (e.g. B00)
      ctx.fillStyle = isTarget ? '#38bdf8' : '#e2e8f0';
      ctx.font = '700 10px "IBM Plex Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`B${b < 10 ? '0' + b : b}`, nx, ny);

      // Small frequency annotation outside node
      const fDist = R + nodeRadius + 14;
      const fx = cx + fDist * Math.cos(theta);
      const fy = cy + fDist * Math.sin(theta);
      const bInfo = trace.bands[b];
      ctx.fillStyle = isTarget ? '#f8fafc' : '#64748b';
      ctx.font = '500 9px "IBM Plex Sans", sans-serif';
      ctx.fillText(`${bInfo.f_lo_ghz}-${bInfo.f_hi_ghz}G`, fx, fy);
    }

    // 6. Flying Packets and Outcome Labels (Pure function of slot)
    // Inspect bursts that started in [slot - 20, slot]
    if (indexData?.messages) {
      const activeWindow = indexData.messages.filter(
        (m) => m.start_slot <= slot && slot <= m.start_slot + 24
      );

      activeWindow.forEach((m) => {
        const theta = -Math.PI / 2 + (m.band / N) * Math.PI * 2;
        const nx = cx + R * Math.cos(theta);
        const ny = cy + R * Math.sin(theta);
        const color = PALETTE[m.color_key] || '#e0523f';
        const outcome = m.outcome || (trace.outcomes && trace.outcomes[m.id]) || { status: 'MISSED_NOT_LISTENING' };
        const flightSlots = 7.0; // transit duration
        const age = slot - m.start_slot;

        if (age <= flightSlots) {
          // In-transit packet dot
          const p = age / flightSlots;
          const px = (1 - p) * nx + p * cx;
          const py = (1 - p) * ny + p * cy;

          ctx.beginPath();
          ctx.arc(px, py, 4.5, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = '#ffffff';
          ctx.stroke();
        } else {
          // Arrival effect & floating status
          const fadeProgress = (age - flightSlots) / 17.0; // 0 to 1
          if (fadeProgress <= 1.0) {
            const alpha = 1.0 - fadeProgress;

            if (outcome.status === 'INTERCEPTED' || outcome.status === 'PARTIAL') {
              // Green Absorption Flash at center
              const flashR = rxRadius + fadeProgress * 20;
              ctx.beginPath();
              ctx.arc(cx, cy, flashR, 0, Math.PI * 2);
              ctx.strokeStyle = STATUS_COLOR.hit;
              ctx.lineWidth = 2.5;
              ctx.globalAlpha = alpha;
              ctx.stroke();

              // Floating checkmark
              ctx.fillStyle = STATUS_COLOR.hit;
              ctx.font = '700 13px "IBM Plex Sans", sans-serif';
              ctx.textAlign = 'center';
              ctx.fillText('✔ caught', cx, cy - rxRadius - 8 - fadeProgress * 14);
              ctx.globalAlpha = 1.0;
            } else {
              // Missed Floating Label near band node
              ctx.save();
              ctx.globalAlpha = alpha;
              ctx.fillStyle = STATUS_COLOR.miss;
              ctx.font = '600 10.5px "IBM Plex Sans", sans-serif';
              ctx.textAlign = 'center';
              ctx.fillText(`✖ missed · B${m.band < 10 ? '0' + m.band : m.band}`, nx, ny - nodeRadius - 6 - fadeProgress * 12);
              ctx.restore();
            }
          }
        }
      });
    }

    return newBeamAngle;
  }

  // View 2: Time-Frequency Strip View (Visual Reference: explanation.png)
  function renderStrip(canvas, trace, indexData, slot, reveal) {
    const fit = fitCanvas(canvas);
    if (!fit) return;
    const { ctx, w, h } = fit;

    ctx.clearRect(0, 0, w, h);

    const N = trace.bands.length;
    const gutterW = 68; // Width for band labels
    const plotW = w - gutterW;
    const bandH = h / N;
    const WINDOW_SLOTS = 110; // ~1.1s window

    // Playhead sits at ~70% across the plot area
    const startSlot = Math.max(0, slot - 0.7 * WINDOW_SLOTS);
    const endSlot = startSlot + WINDOW_SLOTS;

    function xFromSlot(s) {
      return gutterW + ((s - startSlot) / WINDOW_SLOTS) * plotW;
    }

    // 1. Horizontal band stripes & labels
    for (let b = 0; b < N; b++) {
      const y = (N - 1 - b) * bandH; // Band 0 at bottom, Band N-1 at top
      ctx.fillStyle = b % 2 === 0 ? '#0f172a' : '#131d33';
      ctx.fillRect(gutterW, y, plotW, bandH);

      // Gutter band label
      ctx.fillStyle = '#64748b';
      ctx.font = '500 10px "IBM Plex Mono", monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(`B${b < 10 ? '0' + b : b}`, gutterW - 8, y + bandH / 2);

      // Divider line
      ctx.strokeStyle = 'rgba(71, 85, 105, 0.2)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(gutterW, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // 2. Vertical time gridlines (every 10 slots / 100 ms and 50 slots / 500 ms)
    const firstGrid = Math.ceil(startSlot / 10) * 10;
    for (let s = firstGrid; s <= endSlot; s += 10) {
      const gx = xFromSlot(s);
      const isMajor = s % 50 === 0;

      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, h);
      ctx.strokeStyle = isMajor ? 'rgba(148, 163, 184, 0.25)' : 'rgba(71, 85, 105, 0.12)';
      ctx.lineWidth = isMajor ? 1.5 : 1;
      ctx.stroke();

      if (isMajor) {
        ctx.fillStyle = '#94a3b8';
        ctx.font = '500 9px "IBM Plex Mono", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const secVal = (s * trace.meta.slot_duration_s).toFixed(1);
        ctx.fillText(`${secVal}s`, gx, 3);
      }
    }

    // 3. Emitter Transmission Bursts
    if (indexData?.messages) {
      const visibleMsgs = indexData.messages.filter(
        (m) => m.start_slot <= endSlot && m.end_slot >= startSlot
      );

      visibleMsgs.forEach((m) => {
        const bx1 = Math.max(gutterW, xFromSlot(m.start_slot));
        const bx2 = Math.min(w, xFromSlot(m.end_slot + 1));
        const bw = Math.max(2, bx2 - bx1);
        const by = (N - 1 - m.band) * bandH + 2;
        const bh = bandH - 4;
        const color = PALETTE[m.color_key] || '#e0523f';
        const outcome = m.outcome || (trace.outcomes && trace.outcomes[m.id]) || { status: 'MISSED_NOT_LISTENING' };

        const isPast = m.end_slot <= slot;
        const isCurrent = m.start_slot <= slot && slot <= m.end_slot;
        const isFuture = m.start_slot > slot;

        if (isFuture && !reveal) {
          return; // Skip drawing future burst if reveal is disabled
        }

        ctx.save();
        if (isFuture) {
          ctx.globalAlpha = 0.22; // Ghosted future burst
        }

        // Fill colored burst body
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(bx1, by, bw, bh, 3) : ctx.rect(bx1, by, bw, bh);
        ctx.fill();

        // Border decoration matching explanation.png:
        // - Green solid border for successful detection
        // - Red dashed border for missed transmission
        if (isPast || isCurrent) {
          if (outcome.status === 'INTERCEPTED' || outcome.status === 'PARTIAL') {
            ctx.strokeStyle = STATUS_COLOR.hit;
            ctx.lineWidth = 2.5;
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.roundRect ? ctx.roundRect(bx1 - 1, by - 1, bw + 2, bh + 2, 4) : ctx.rect(bx1 - 1, by - 1, bw + 2, bh + 2);
            ctx.stroke();
          } else {
            ctx.strokeStyle = STATUS_COLOR.miss;
            ctx.lineWidth = 2.0;
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            ctx.roundRect ? ctx.roundRect(bx1 - 1, by - 1, bw + 2, bh + 2, 4) : ctx.rect(bx1 - 1, by - 1, bw + 2, bh + 2);
            ctx.stroke();
          }
        }
        ctx.restore();
      });
    }

    // 4. Receiver Dwell Path (Sawtooth Scan Trajectory)
    const minDwellSlot = Math.max(0, Math.floor(startSlot));
    const maxDwellSlot = Math.min(trace.meta.n_slots - 1, Math.floor(slot));

    ctx.save();
    ctx.beginPath();
    let started = false;
    for (let t = minDwellSlot; t <= maxDwellSlot; t++) {
      const dx = xFromSlot(t + 0.5);
      const dy = (N - 1 - trace.dwell[t] + 0.5) * bandH;
      if (!started) {
        ctx.moveTo(dx, dy);
        started = true;
      } else {
        ctx.lineTo(dx, dy);
      }
    }
    // High-contrast scan line (white/cyan)
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.8;
    ctx.stroke();

    // Dwell markers (dots with detection ring)
    for (let t = minDwellSlot; t <= maxDwellSlot; t++) {
      const dx = xFromSlot(t + 0.5);
      const dy = (N - 1 - trace.dwell[t] + 0.5) * bandH;
      const detected = trace.detect[t];

      ctx.beginPath();
      ctx.arc(dx, dy, detected ? 3.5 : 2.0, 0, Math.PI * 2);
      ctx.fillStyle = detected ? STATUS_COLOR.hit : '#0f172a';
      ctx.fill();
      ctx.strokeStyle = detected ? '#ffffff' : '#38bdf8';
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    ctx.restore();

    // 5. Vertical Playhead Line
    const playheadX = xFromSlot(slot);
    if (playheadX >= gutterW && playheadX <= w) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, h);
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2.5;
      ctx.stroke();

      // Top playhead triangle marker
      ctx.fillStyle = '#38bdf8';
      ctx.beginPath();
      ctx.moveTo(playheadX - 6, 0);
      ctx.lineTo(playheadX + 6, 0);
      ctx.lineTo(playheadX, 10);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  // View 3: Visiting Pattern Stepped Chart & Dwell Count Heat Bar
  function renderPatternChart(canvas, trace, slot) {
    if (!canvas || !trace) return;
    try {
      const fit = fitCanvas(canvas);
      if (!fit) return;
      const { ctx, w, h } = fit;

      ctx.clearRect(0, 0, w, h);

      // Dark cockpit background fill
      ctx.fillStyle = '#070d19';
      ctx.fillRect(0, 0, w, h);

      const N = (trace.bands && trace.bands.length) ? trace.bands.length : 16;
      const maxSlots = trace.meta?.n_slots || 1000;
      const curInt = Math.min(maxSlots - 1, Math.max(0, Math.floor(slot)));

      // Y-axis padding for band labels
      const padLeft = 32;
      const padRight = 10;
      const padTop = 10;
      const padBottom = 16;
      const plotW = Math.max(10, w - padLeft - padRight);
      const plotH = Math.max(10, h - padTop - padBottom);

      // Gridlines & Band Labels (e.g. B15, B10, B05, B00)
      ctx.strokeStyle = 'rgba(71, 85, 105, 0.2)';
      ctx.lineWidth = 1;
      ctx.font = '600 9px "IBM Plex Mono", monospace';
      ctx.fillStyle = '#64748b';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';

      const gridBands = [0, Math.floor(N * 0.33), Math.floor(N * 0.66), N - 1];
      gridBands.forEach((b) => {
        const gy = padTop + (1 - b / Math.max(1, N - 1)) * plotH;
        ctx.beginPath();
        ctx.moveTo(padLeft, gy);
        ctx.lineTo(w - padRight, gy);
        ctx.stroke();

        ctx.fillText(`B${b < 10 ? '0' + b : b}`, padLeft - 4, gy);
      });

      // Stepped Dwell Line
      if (trace.dwell && trace.dwell.length > 0) {
        ctx.save();
        ctx.beginPath();
        let started = false;
        for (let t = 0; t <= curInt; t++) {
          const rawB = trace.dwell[t];
          if (rawB === undefined || isNaN(rawB)) continue;
          const b = Math.max(0, Math.min(N - 1, rawB));
          const x = padLeft + (t / maxSlots) * plotW;
          const y = padTop + (1 - b / Math.max(1, N - 1)) * plotH;

          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            const prevRawB = trace.dwell[t - 1];
            const prevB = (prevRawB !== undefined && !isNaN(prevRawB)) ? Math.max(0, Math.min(N - 1, prevRawB)) : b;
            const prevY = padTop + (1 - prevB / Math.max(1, N - 1)) * plotH;
            ctx.lineTo(x, prevY);
            ctx.lineTo(x, y);
          }
        }
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 1.8;
        ctx.stroke();

        // Current position dot
        if (curInt >= 0 && trace.dwell[curInt] !== undefined) {
          const curB = Math.max(0, Math.min(N - 1, trace.dwell[curInt]));
          const px = padLeft + (curInt / maxSlots) * plotW;
          const py = padTop + (1 - curB / Math.max(1, N - 1)) * plotH;
          ctx.beginPath();
          ctx.arc(px, py, 4, 0, Math.PI * 2);
          ctx.fillStyle = '#10b981';
          ctx.fill();
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        ctx.restore();
      }

      // Time axis label at bottom right
      ctx.fillStyle = '#64748b';
      ctx.font = '500 8.5px "IBM Plex Sans", sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`t = ${curInt}/${maxSlots}`, w - padRight, h - 2);

    } catch (err) {
      console.error('Error in renderPatternChart:', err);
    }
  }

  function renderHeatBar(canvas, trace, slot) {
    if (!canvas || !trace) return;
    try {
      const fit = fitCanvas(canvas);
      if (!fit) return;
      const { ctx, w, h } = fit;

      ctx.clearRect(0, 0, w, h);

      const N = (trace.bands && trace.bands.length) ? trace.bands.length : 16;
      const maxSlots = trace.meta?.n_slots || 1000;
      const curInt = Math.min(maxSlots - 1, Math.max(0, Math.floor(slot)));

      // Calculate dwell histogram up to slot
      const counts = new Array(N).fill(0);
      if (trace.dwell) {
        for (let t = 0; t <= curInt; t++) {
          const b = trace.dwell[t];
          if (b !== undefined && b >= 0 && b < N) {
            counts[b]++;
          }
        }
      }
      const maxCount = Math.max(1, ...counts);
      const curBand = trace.dwell ? trace.dwell[curInt] : -1;

      const gap = 2;
      const barW = Math.max(2, (w - (N - 1) * gap) / N);
      const labelH = 12;
      const chartH = Math.max(4, h - labelH - 2);

      for (let b = 0; b < N; b++) {
        const x = b * (barW + gap);
        const frac = counts[b] / maxCount;
        const barH = Math.max(2, frac * chartH);
        const y = chartH - barH;
        const isCur = b === curBand;

        // Dwell bar
        ctx.fillStyle = isCur ? '#38bdf8' : (counts[b] > 0 ? 'rgba(56, 189, 248, 0.45)' : 'rgba(51, 65, 85, 0.3)');
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(x, y, barW, barH, [2, 2, 0, 0]) : ctx.fillRect(x, y, barW, barH);
        ctx.fill();

        if (isCur) {
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1;
          ctx.stroke();
        }

        // Band number label
        ctx.fillStyle = isCur ? '#38bdf8' : '#64748b';
        ctx.font = isCur ? '700 8.5px "IBM Plex Mono", monospace' : '500 8px "IBM Plex Mono", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`${b}`, x + barW / 2, h);
      }
    } catch (err) {
      console.error('Error in renderHeatBar:', err);
    }
  }

  // Ticker and Phase Badge Update
  function updateTickerAndPhase(scenePrefix, trace, indexData, slot) {
    const curInt = Math.min(trace.meta.n_slots - 1, Math.max(0, Math.floor(slot)));
    const curBand = trace.dwell[curInt];
    const bInfo = trace.bands[curBand];

    // Compute running intercepts up to slot
    const pastMsgs = (indexData?.messages || []).filter((m) => m.end_slot <= curInt);
    const caught = pastMsgs.filter((m) => {
      const st = m.outcome?.status || (trace.outcomes && trace.outcomes[m.id]?.status);
      return st === 'INTERCEPTED' || st === 'PARTIAL';
    }).length;
    const missed = pastMsgs.length - caught;
    const irPct = pastMsgs.length ? ((caught / pastMsgs.length) * 100).toFixed(1) : '0.0';

    $(`${scenePrefix}-ticker-dwell`).textContent = `B${curBand < 10 ? '0' + curBand : curBand} (${bInfo.f_lo_ghz}-${bInfo.f_hi_ghz} GHz)`;
    $(`${scenePrefix}-ticker-hits`).textContent = caught;
    $(`${scenePrefix}-ticker-misses`).textContent = missed;
    $(`${scenePrefix}-ticker-ir`).textContent = `${irPct}%`;

    // Phase mode badge
    const badge = $(`${scenePrefix}-phase-badge`);
    if (trace.phase && trace.phase.length > curInt) {
      const mode = trace.phase[curInt];
      badge.classList.remove('hidden');
      badge.className = `theatre-phase-badge ${mode}`;

      const icon = mode === 'tracking' ? '🎯' : mode === 'acquisition' ? '🔍' : '🛡️';
      const label = mode === 'tracking' ? 'Timed Interrupt' : mode === 'acquisition' ? 'Period Acquisition' : 'Coverage Sweep';
      badge.innerHTML = `<span>${icon}</span> <span>${label}</span>`;

      // Trigger pulse animation on transition
      if (scenePrefix === 'scene-a' && mode !== lastPhaseA) {
        lastPhaseA = mode;
      } else if (scenePrefix === 'scene-b' && mode !== lastPhaseB) {
        lastPhaseB = mode;
      }
    } else {
      badge.classList.add('hidden');
    }
  }

  function renderAll(dt) {
    if (!traceA) return;

    // Update scrubber label and playhead input
    $('theatre-scrub').value = currentSlot;
    const secElapsed = (currentSlot * traceA.meta.slot_duration_s).toFixed(2);
    const totalSec = (traceA.meta.n_slots * traceA.meta.slot_duration_s).toFixed(1);
    $('theatre-time-label').textContent = `Slot ${Math.floor(currentSlot)} / ${traceA.meta.n_slots} (${secElapsed}s / ${totalSec}s)`;

    // Render Scene A
    beamAngleA = renderNetworkRing($('canvas-ring-a'), traceA, msgIndexA, currentSlot, beamAngleA);
    renderStrip($('canvas-strip-a'), traceA, msgIndexA, currentSlot, revealFuture);
    renderPatternChart($('canvas-pattern-a'), traceA, currentSlot);
    renderHeatBar($('canvas-heat-a'), traceA, currentSlot);
    updateTickerAndPhase('scene-a', traceA, msgIndexA, currentSlot);

    // Render Scene B (if compare mode active)
    if (isCompare && traceB) {
      beamAngleB = renderNetworkRing($('canvas-ring-b'), traceB, msgIndexB, currentSlot, beamAngleB);
      renderStrip($('canvas-strip-b'), traceB, msgIndexB, currentSlot, revealFuture);
      renderPatternChart($('canvas-pattern-b'), traceB, currentSlot);
      renderHeatBar($('canvas-heat-b'), traceB, currentSlot);
      updateTickerAndPhase('scene-b', traceB, msgIndexB, currentSlot);
    }
  }

  // ---------------------------------------------------------------- Animation Loop
  function animationLoop(timestamp) {
    if (!lastTime) lastTime = timestamp;
    const dt = (timestamp - lastTime) / 1000.0;
    lastTime = timestamp;

    if (tabActive && isPlaying && traceA) {
      const dwellDurationS = traceA.meta.slot_duration_s || 0.01;
      const slotsPerSec = (1.0 / dwellDurationS) * speed;
      currentSlot += slotsPerSec * dt;

      if (currentSlot >= traceA.meta.n_slots) {
        currentSlot = traceA.meta.n_slots;
        isPlaying = false;
        updatePlayButton();

        // Phase 3 Hook invocation
        if (typeof window.onRunFinished === 'function') {
          window.onRunFinished(traceA, traceB);
        }
      }
      renderAll(dt);
      if (typeof window.theatreCaptionTick === 'function') {
        window.theatreCaptionTick(currentSlot);
      }
    }

    if (tabActive) {
      animId = requestAnimationFrame(animationLoop);
    }
  }

  // ---------------------------------------------------------------- Initialization
  function initTheatre(infoData) {
    INFO = infoData;

    // Populate Schedulers
    const schedSelA = $('theatre-sched-a');
    const schedSelB = $('theatre-sched-b');
    schedSelA.innerHTML = '';
    schedSelB.innerHTML = '';

    INFO.schedulers.forEach((s) => {
      const optA = new Option(s.label, s.name);
      optA.disabled = !s.available;
      schedSelA.add(optA);

      const optB = new Option(s.label, s.name);
      optB.disabled = !s.available;
      schedSelB.add(optB);
    });

    schedSelA.value = 'round_robin';
    schedSelB.value = 'model_based';

    // Populate Scenarios
    const scenSel = $('theatre-scenario');
    scenSel.innerHTML = '';
    Object.keys(INFO.presets).forEach((p) => {
      scenSel.add(new Option(p.replace('_', ' '), p));
    });
    scenSel.add(new Option('random laydown', 'random'));
    scenSel.value = 'air_defence';

    // Event Listeners
    $('theatre-run-btn').addEventListener('click', runSimulation);
    $('theatre-play-btn').addEventListener('click', togglePlay);
    $('theatre-step-back').addEventListener('click', () => stepSlot(-1));
    $('theatre-step-fwd').addEventListener('click', () => stepSlot(+1));

    const showReconcileBtn = $('theatre-show-reconcile-btn');
    if (showReconcileBtn) {
      showReconcileBtn.addEventListener('click', () => {
        if (traceA && typeof window.onRunFinished === 'function') {
          window.onRunFinished(traceA, traceB);
        }
        const rec = $('theatre-reconcile');
        if (rec) rec.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }

    const scrub = $('theatre-scrub');
    scrub.addEventListener('input', (e) => {
      isPlaying = false;
      updatePlayButton();
      currentSlot = parseFloat(e.target.value);
      renderAll(0);
      if (typeof window.theatreCaptionTick === 'function') {
        window.theatreCaptionTick(currentSlot);
      }
    });

    const speedRange = $('theatre-speed');
    const speedLabel = $('theatre-speed-val');
    speedRange.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      speed = val;
      speedLabel.textContent = `${val}x`;
    });

    $('theatre-reveal-future').addEventListener('change', (e) => {
      revealFuture = e.target.checked;
      renderAll(0);
    });

    $('theatre-compare-toggle').addEventListener('change', (e) => {
      isCompare = e.target.checked;
      updateSceneVisibility();
      if (isCompare && !traceB && traceA) {
        runSimulation();
      } else {
        renderAll(0);
      }
    });

    // Keyboard Shortcuts (Space = play/pause, Left/Right = step)
    window.addEventListener('keydown', (e) => {
      if (!tabActive) return;
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      const wrap = document.querySelector('.theatre-wrap');
      if (!wrap || wrap.offsetParent === null) return;

      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        stepSlot(-1);
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        stepSlot(+1);
      }
    });

    window.addEventListener('resize', () => {
      if (tabActive) renderAll(0);
    });

    // Guard all theatre canvases against GPU context crashes
    const canvasIds = [
      'canvas-ring-a', 'canvas-pattern-a', 'canvas-heat-a', 'canvas-strip-a',
      'canvas-ring-b', 'canvas-pattern-b', 'canvas-heat-b', 'canvas-strip-b'
    ];
    canvasIds.forEach((id) => {
      const c = $(id);
      if (c) {
        c.addEventListener('contextlost', (e) => {
          e.preventDefault();
          console.warn(`[Theatre] Canvas context lost on ${id}, preventing crash.`);
        });
        c.addEventListener('contextrestored', () => {
          console.info(`[Theatre] Canvas context restored on ${id}.`);
          if (tabActive) renderAll(0);
        });
      }
    });

    // Auto-run initial scene once DOM is ready
    runSimulation();
  }

  // Lifecycle tab hooks called from app.js
  window.onTheatreTabActive = function () {
    tabActive = true;
    lastTime = performance.now();
    cancelAnimationFrame(animId);
    animId = requestAnimationFrame(animationLoop);
    renderAll(0);
  };

  window.onTheatreTabInactive = function () {
    tabActive = false;
    cancelAnimationFrame(animId);
  };

  window.initTheatre = initTheatre;
  window.theatre = {
    seekToSlot,
    getTraceA: () => traceA,
    getTraceB: () => traceB,
    isCompare: () => isCompare,
    renderAll: () => renderAll(0),
    getCurrentSlot: () => currentSlot,
    setTraces,
    play,
    pause,
    setSpeed,
    reset,
    runSimulation,
  };
  window.onRunFinished = window.onRunFinished || function (traceA, traceB) {
    /* Phase 3 placeholder */
  };
})();
