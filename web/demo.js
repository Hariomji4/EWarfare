/* Live Intercept Theatre - Demo, Presentation Mode & Polish Engine */

(function () {
  'use strict';

  // State
  let captionsEnabled = true;
  let activeCaptionTimer = null;
  let queuedCaptions = [];
  let triggeredCaptionIds = new Set();
  let presentationAutoHideTimer = null;
  let isUsingSavedDemoData = false;

  function $(id) {
    return document.getElementById(id);
  }

  // ---------------------------------------------------------------- Narration Captions
  function precomputeCaptions(traceA, traceB) {
    queuedCaptions = [];
    triggeredCaptionIds.clear();

    if (!traceA) return;

    // 1. Start Caption (Slot 0)
    queuedCaptions.push({
      id: 'start',
      slot: 0,
      text: 'Left: fixed round-robin sweep. Right: Smart Scan learning from hits and misses.',
      icon: '📡',
    });

    // 2. First missed burst where receiver just left the band
    const dwellRR = traceA.dwell || [];
    let firstMissedJustLeft = null;

    for (let i = 0; i < traceA.messages.length; i++) {
      const m = traceA.messages[i];
      const o = traceA.outcomes[i];
      if (o.status === 'MISSED_NOT_LISTENING') {
        const s = m.start_slot;
        const b = m.band;
        if (s > 0 && (dwellRR[s - 1] === b || (s > 1 && dwellRR[s - 2] === b))) {
          firstMissedJustLeft = { slot: s, band: b, name: m.emitter_name || traceA.emitters[m.emitter_id]?.name || 'Emitter' };
          break;
        }
      }
    }

    if (firstMissedJustLeft) {
      queuedCaptions.push({
        id: 'missed_just_left',
        slot: firstMissedJustLeft.slot,
        text: 'Missed: the receiver was on another band when this was sent.',
        icon: '⚠️',
      });
    }

    // 3. First time smart scheduler's mode changes (phase[] transition)
    if (traceB && traceB.phase && traceB.phase.length > 0) {
      const phase = traceB.phase;
      for (let t = 1; t < phase.length; t++) {
        if (phase[t] !== 'coverage' && phase[t - 1] === 'coverage') {
          queuedCaptions.push({
            id: 'mode_change',
            slot: t,
            text: "Smart Scan has locked onto the emitter's period and now revisits at predicted times.",
            icon: '🎯',
          });
          break;
        }
      }
    }

    // 4. First time smart scan intercepts a burst round-robin missed
    if (traceB && traceB.outcomes) {
      for (let i = 0; i < traceA.messages.length; i++) {
        const m = traceA.messages[i];
        const oA = traceA.outcomes[i];
        const oB = traceB.outcomes[i];

        const hitA = oA.status === 'INTERCEPTED' || oA.status === 'PARTIAL';
        const hitB = oB.status === 'INTERCEPTED' || oB.status === 'PARTIAL';

        if (!hitA && hitB) {
          const emName = m.emitter_name || traceA.emitters[m.emitter_id]?.name || 'Emitter';
          queuedCaptions.push({
            id: 'first_smart_hit',
            slot: m.start_slot,
            text: `Smart intercept! Smart Scan caught a burst from ${emName} on Band ${m.band} that Round-robin missed.`,
            icon: '⚡',
          });
          break;
        }
      }
    }

    // 5. End summary caption with exact comparative numbers
    if (traceB) {
      const sA = traceA.summary.status_counts;
      const sB = traceB.summary.status_counts;
      const countA = sA.INTERCEPTED + sA.PARTIAL;
      const countB = sB.INTERCEPTED + sB.PARTIAL;
      const diff = countB - countA;
      const pct = Math.round((diff / Math.max(1, countA)) * 100);

      queuedCaptions.push({
        id: 'end_summary',
        slot: traceA.meta.n_slots - 1,
        text: `Smart Scan intercepted ${diff} more transmissions (+${pct}%).`,
        icon: '🏆',
      });
    }

    // Sort captions by slot
    queuedCaptions.sort((a, b) => a.slot - b.slot);
  }

  function handleCaptionTick(currentSlot) {
    if (!captionsEnabled) return;

    for (const c of queuedCaptions) {
      if (!triggeredCaptionIds.has(c.id) && currentSlot >= c.slot && currentSlot <= c.slot + 40) {
        triggeredCaptionIds.add(c.id);
        displayCaption(c.text, c.icon);
        break;
      }
    }
  }

  function displayCaption(text, icon = '🎙') {
    const bar = $('theatre-caption-bar');
    const textEl = $('theatre-caption-text');
    const iconEl = $('theatre-caption-icon');
    const progressEl = $('theatre-caption-progress');

    if (!bar || !textEl) return;

    if (activeCaptionTimer) {
      clearTimeout(activeCaptionTimer);
    }

    textEl.textContent = text;
    if (iconEl) iconEl.textContent = icon;

    bar.classList.remove('hidden');

    // Animate progress bar across 4 seconds
    if (progressEl) {
      progressEl.style.transition = 'none';
      progressEl.style.transform = 'scaleX(1)';
      void progressEl.offsetWidth; // force reflow
      progressEl.style.transition = 'transform 4s linear';
      progressEl.style.transform = 'scaleX(0)';
    }

    activeCaptionTimer = setTimeout(() => {
      bar.classList.add('hidden');
      activeCaptionTimer = null;
    }, 4000);
  }

  // Hook into theatre animation tick
  window.theatreCaptionTick = function (slot) {
    handleCaptionTick(slot);
  };

  // ---------------------------------------------------------------- One-Click Demo Runner
  async function runDemo() {
    const demoBtn = $('theatre-run-demo-btn');
    const overlay = $('theatre-loading-overlay');
    const loadingText = $('theatre-loading-text');

    if (demoBtn) demoBtn.disabled = true;
    if (overlay) {
      overlay.classList.remove('hidden');
      if (loadingText) loadingText.textContent = 'Preparing Tactical Air Defence Demo...';
    }

    // Pick best available scheduler: dqn > gru_predictor > model_based
    const schedSelA = $('theatre-sched-a');
    const schedSelB = $('theatre-sched-b');
    let bestSched = 'model_based';

    if (schedSelB) {
      const opts = [...schedSelB.options];
      const hasDQN = opts.some((o) => o.value === 'dqn' && !o.disabled);
      const hasGRU = opts.some((o) => o.value === 'gru_predictor' && !o.disabled);

      if (hasDQN) bestSched = 'dqn';
      else if (hasGRU) bestSched = 'gru_predictor';
      else bestSched = 'model_based';
    }

    const scenario = 'air_defence';
    const seed = 1;

    // Set UI dropdowns
    if (schedSelA) schedSelA.value = 'round_robin';
    if (schedSelB) schedSelB.value = bestSched;
    if ($('theatre-scenario')) $('theatre-scenario').value = scenario;
    if ($('theatre-seed')) $('theatre-seed').value = seed;
    if ($('theatre-compare-toggle')) $('theatre-compare-toggle').checked = true;

    let traceA = null;
    let traceB = null;
    isUsingSavedDemoData = false;

    try {
      // 1. Attempt live API trace generation
      const resA = await fetch('/api/trace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduler: 'round_robin', scenario, seed }),
      });
      if (!resA.ok) throw new Error('Live trace A failed');
      traceA = await resA.json();

      const resB = await fetch('/api/trace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduler: bestSched, scenario, seed }),
      });
      if (!resB.ok) throw new Error('Live trace B failed');
      traceB = await resB.json();
    } catch (e) {
      // 2. Fallback to offline pre-computed trace
      console.warn('Live API trace failed; falling back to precomputed demo trace:', e.message);
      try {
        const fallbackRes = await fetch('/static/demo_traces/demo_compare.json');
        if (!fallbackRes.ok) throw new Error('Offline demo trace file missing');
        const bundle = await fallbackRes.json();
        traceA = bundle.traceA;
        traceB = bundle.traceB;
        isUsingSavedDemoData = true;
      } catch (errFallback) {
        alert('Failed to load demo trace: ' + errFallback.message);
        if (overlay) overlay.classList.add('hidden');
        if (demoBtn) demoBtn.disabled = false;
        return;
      }
    }

    // Toggle offline badge
    const badge = $('theatre-demo-badge');
    if (badge) {
      badge.classList.toggle('hidden', !isUsingSavedDemoData);
    }

    // Load traces into theatre engine
    if (window.theatre && typeof window.theatre.setTraces === 'function') {
      window.theatre.setTraces(traceA, traceB, true);
      window.theatre.setSpeed(2.0); // 2.0x sensible demo speed
    }

    // Precompute narration captions
    precomputeCaptions(traceA, traceB);

    if (overlay) overlay.classList.add('hidden');
    if (demoBtn) demoBtn.disabled = false;

    // Start playback
    if (window.theatre && typeof window.theatre.play === 'function') {
      window.theatre.play();
    }
  }

  // ---------------------------------------------------------------- Presentation Mode
  function togglePresentationMode() {
    const isPres = document.body.classList.contains('presentation-mode');

    if (!isPres) {
      document.body.classList.add('presentation-mode');
      if (document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().catch(() => {});
      }
      displayCaption('Presentation Mode active · Press Esc or P to exit', '🖥');
      initPresentationAutoHide();
    } else {
      exitPresentationMode();
    }
  }

  function exitPresentationMode() {
    document.body.classList.remove('presentation-mode');
    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }
    const playbar = document.querySelector('.theatre-playbar');
    if (playbar) playbar.classList.remove('autohide');
    if (presentationAutoHideTimer) {
      clearTimeout(presentationAutoHideTimer);
    }
  }

  function initPresentationAutoHide() {
    const playbar = document.querySelector('.theatre-playbar');
    if (!playbar) return;

    const resetTimer = () => {
      playbar.classList.remove('autohide');
      clearTimeout(presentationAutoHideTimer);
      if (document.body.classList.contains('presentation-mode')) {
        presentationAutoHideTimer = setTimeout(() => {
          playbar.classList.add('autohide');
        }, 2500);
      }
    };

    window.addEventListener('mousemove', resetTimer);
    resetTimer();
  }

  // ---------------------------------------------------------------- Snapshots & Export
  function buildSceneSnapshotCanvas() {
    if (!window.theatre) return;
    const traceA = window.theatre.getTraceA();
    if (!traceA) {
      return null;
    }

    const traceB = window.theatre.getTraceB();
    const isCompare = window.theatre.isCompare();
    const curSlot = Math.floor(window.theatre.getCurrentSlot ? window.theatre.getCurrentSlot() : 0);

    const canvasRingA = $('canvas-ring-a');
    const canvasStripA = $('canvas-strip-a');
    const canvasPatternA = $('canvas-pattern-a');

    if (!canvasRingA || !canvasStripA) return null;

    // Create offscreen composite canvas
    const comp = document.createElement('canvas');
    const W = isCompare ? 1920 : 1280;
    const H = 960;
    comp.width = W;
    comp.height = H;
    const ctx = comp.getContext('2d');

    // Background
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, W, H);

    // Title Header
    ctx.fillStyle = '#0284c7';
    ctx.fillRect(0, 0, W, 48);

    ctx.fillStyle = '#ffffff';
    ctx.font = '700 16px "IBM Plex Sans", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('SMART SCAN // LIVE INTERCEPT THEATRE', 24, 30);

    ctx.fillStyle = '#cbd5e1';
    ctx.font = '500 13px "IBM Plex Sans", sans-serif';
    ctx.textAlign = 'right';
    const schedStr = isCompare && traceB ? `${traceA.meta.scheduler} vs ${traceB.meta.scheduler}` : traceA.meta.scheduler;
    ctx.fillText(`Scenario: ${traceA.meta.scenario} | ${schedStr} | Slot ${curSlot}/${traceA.meta.n_slots} | Seed ${traceA.meta.seed}`, W - 24, 30);

    // Draw Canvases
    if (!isCompare) {
      // Single Scene Layout
      ctx.drawImage(canvasRingA, 24, 64, 600, 420);
      ctx.drawImage(canvasPatternA, 640, 64, 616, 420);
      ctx.drawImage(canvasStripA, 24, 500, 1232, 430);
    } else {
      // Dual Compare Layout
      const canvasRingB = $('canvas-ring-b');
      const canvasStripB = $('canvas-strip-b');

      ctx.drawImage(canvasRingA, 24, 64, 440, 380);
      if (canvasRingB) ctx.drawImage(canvasRingB, 480, 64, 440, 380);
      ctx.drawImage(canvasStripA, 24, 460, 920, 220);
      if (canvasStripB) ctx.drawImage(canvasStripB, 24, 700, 920, 220);

      // Info summary box on right
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(980, 64, 916, 860);
      ctx.strokeStyle = '#334155';
      ctx.strokeRect(980, 64, 916, 860);

      ctx.fillStyle = '#38bdf8';
      ctx.font = '700 18px "IBM Plex Sans", sans-serif';
      ctx.fillText('COMPARE RUNTIME ANALYSIS', 1010, 100);
    }

    return { comp, traceA, traceB, isCompare, curSlot, schedStr };
  }

  function saveSceneSnapshot() {
    const snapshot = buildSceneSnapshotCanvas();
    if (!snapshot) {
      alert('No active simulation to snapshot. Run a scenario first.');
      return;
    }

    const { comp, traceA, schedStr, curSlot } = snapshot;
    // Trigger download
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    comp.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `snapshot_${traceA.meta.scenario}_${schedStr.replace(/ /g, '_')}_seed${traceA.meta.seed}_t${curSlot}_${ts}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
  }

  // ---------------------------------------------------------------- High-Quality PDF Report Generator
  function buildPrintReport(traceA, traceB, isCompare) {
    let report = $('theatre-print-report');
    if (!report) {
      report = document.createElement('div');
      report.id = 'theatre-print-report';
      report.className = 'theatre-print-report';
      document.body.appendChild(report);
    }

    const metaA = traceA.meta || {};
    const sumA = traceA.summary || {};
    const countsA = sumA.status_counts || {};
    const pctA = sumA.status_percentages || {};
    const metricsA = sumA.metrics || {};
    const bands = traceA.bands || [];
    const emitters = traceA.emitters || [];
    const msgs = traceA.messages || [];

    const metaB = isCompare && traceB ? traceB.meta || {} : null;
    const sumB = isCompare && traceB ? traceB.summary || {} : null;
    const countsB = sumB ? sumB.status_counts || {} : null;
    const pctB = sumB ? sumB.status_percentages || {} : null;
    const metricsB = sumB ? sumB.metrics || {} : null;

    const schedNameA = (metaA.scheduler || 'Receiver A').replace(/_/g, ' ');
    const schedNameB = metaB ? (metaB.scheduler || 'Receiver B').replace(/_/g, ' ') : '';

    const formatKind = (k) => (k || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const nowStr = new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'medium' });

    const durationSec = (metaA.n_slots * (metaA.slot_duration_s || 0.01)).toFixed(1);
    const totalBursts = msgs.length;

    const perEmA = metricsA.per_emitter || [];
    const perEmB = (metricsB && metricsB.per_emitter) || [];

    const caughtA = (countsA.INTERCEPTED || 0) + (countsA.PARTIAL || 0);
    const caughtB = countsB ? (countsB.INTERCEPTED || 0) + (countsB.PARTIAL || 0) : 0;
    const netDiff = caughtB - caughtA;
    const pctGain = caughtA > 0 ? Math.round((netDiff / caughtA) * 100) : 0;
    const snapshot = buildSceneSnapshotCanvas();
    const snapshotUrl = snapshot ? snapshot.comp.toDataURL('image/png') : '';
    const snapshotCaption = snapshot
      ? `Live Intercept Theatre snapshot - slot ${snapshot.curSlot}/${metaA.n_slots}, scenario ${(metaA.scenario || 'Default').replace(/_/g, ' ')}, ${isCompare ? `${schedNameA} vs ${schedNameB}` : schedNameA}.`
      : 'Live Intercept Theatre snapshot unavailable. Run the theatre before generating the report.';

    report.innerHTML = `
      <div class="print-header">
        <div class="print-header-top">
          <div>
            <span class="print-badge-tag">DEFENCE ELECTRONIC WARFARE // TELEMETRY & RECONCILIATION</span>
            <h1 class="print-doc-title">SMART SCAN · RECEIVER EVALUATION REPORT</h1>
            <div class="print-doc-sub">Tactical Interception Telemetry, Emitter Dwell Reconciliation & Performance Figures of Merit</div>
          </div>
          <div class="print-meta-box">
            <div><b>Classification:</b> UNCLASSIFIED / EVALUATION</div>
            <div><b>Generated:</b> ${nowStr}</div>
            <div><b>Engine:</b> Smart Scan Tactical Core v2.0</div>
          </div>
        </div>

        <div class="print-meta-grid">
          <div class="print-meta-item">
            <span class="label">Scenario</span>
            <span class="val">${(metaA.scenario || 'Default').replace(/_/g, ' ').toUpperCase()}</span>
          </div>
          <div class="print-meta-item">
            <span class="label">Battlefield Seed</span>
            <span class="val">${metaA.seed ?? 0}</span>
          </div>
          <div class="print-meta-item">
            <span class="label">Duration & Resolution</span>
            <span class="val">${durationSec} s (${metaA.n_slots} slots @ 10 ms)</span>
          </div>
          <div class="print-meta-item">
            <span class="label">RF Band Coverage</span>
            <span class="val">${bands.length} Bands (${bands[0]?.f_lo_ghz ?? 2}–${bands.at(-1)?.f_hi_ghz ?? 18} GHz)</span>
          </div>
          <div class="print-meta-item">
            <span class="label">Evaluation Mode</span>
            <span class="val">${isCompare ? `${schedNameA} vs ${schedNameB}` : schedNameA}</span>
          </div>
        </div>
      </div>

      <!-- SECTION 1: EXECUTIVE PERFORMANCE SCORECARD -->
      <div class="print-section">
        <h2 class="print-section-title">1. Executive Performance Scorecard</h2>
        ${isCompare && netDiff > 0 ? `
          <div class="print-callout">
            <b>KEY OPERATIONAL ASSESSMENT:</b> Candidate <b>${schedNameB}</b> outperformed baseline <b>${schedNameA}</b> by intercepting <b>${netDiff} more transmissions (+${pctGain}%)</b>, raising Threat-Weighted Interception Ratio from <b>${((metricsA.threat_weighted_ir || 0) * 100).toFixed(1)}%</b> to <b>${((metricsB.threat_weighted_ir || 0) * 100).toFixed(1)}%</b>. Adaptive dwell scheduling eliminated beam lock-out cycles against rotating search radars.
          </div>
        ` : ''}

        <table class="print-table">
          <thead>
            <tr>
              <th>Performance Metric</th>
              <th>${schedNameA} ${isCompare ? '(Baseline)' : ''}</th>
              ${isCompare ? `<th>${schedNameB} (Candidate)</th><th>Operational Delta</th>` : ''}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><b>Total Bursts Transmitted</b></td>
              <td>${totalBursts} bursts</td>
              ${isCompare ? `<td>${totalBursts} bursts</td><td>Identical Environment</td>` : ''}
            </tr>
            <tr>
              <td><b>Full-Burst Captures (100% Coverage)</b></td>
              <td><b>${countsA.INTERCEPTED || 0}</b> (${pctA.INTERCEPTED ?? 0}%)</td>
              ${isCompare ? `
                <td><b>${countsB.INTERCEPTED || 0}</b> (${pctB.INTERCEPTED ?? 0}%)</td>
                <td><b class="${(countsB.INTERCEPTED || 0) >= (countsA.INTERCEPTED || 0) ? 'text-good' : ''}">${(countsB.INTERCEPTED || 0) - (countsA.INTERCEPTED || 0) >= 0 ? '+' : ''}${(countsB.INTERCEPTED || 0) - (countsA.INTERCEPTED || 0)} bursts</b></td>
              ` : ''}
            </tr>
            <tr>
              <td><b>Partial Interceptions</b></td>
              <td>${countsA.PARTIAL || 0} (${pctA.PARTIAL ?? 0}%)</td>
              ${isCompare ? `
                <td>${countsB.PARTIAL || 0} (${pctB.PARTIAL ?? 0}%)</td>
                <td>${(countsB.PARTIAL || 0) - (countsA.PARTIAL || 0) >= 0 ? '+' : ''}${(countsB.PARTIAL || 0) - (countsA.PARTIAL || 0)} bursts</td>
              ` : ''}
            </tr>
            <tr>
              <td><b>Burst Interception Ratio (Any Hit)</b></td>
              <td><b>${caughtA}</b> (${totalBursts ? ((caughtA / totalBursts) * 100).toFixed(1) : 0}%)</td>
              ${isCompare ? `
                <td><b>${caughtB}</b> (${totalBursts ? ((caughtB / totalBursts) * 100).toFixed(1) : 0}%)</td>
                <td><b class="${netDiff >= 0 ? 'text-good' : ''}">${netDiff >= 0 ? '+' : ''}${netDiff} bursts (${pctGain >= 0 ? '+' : ''}${pctGain}%)</b></td>
              ` : ''}
            </tr>
            <tr>
              <td><b>Raw Burst IR (Any Hit)</b></td>
              <td>${((metricsA.intercept_ratio || 0) * 100).toFixed(1)}%</td>
              ${isCompare ? `
                <td><b>${((metricsB.intercept_ratio || 0) * 100).toFixed(1)}%</b></td>
                <td><b>${(((metricsB.intercept_ratio || 0) - (metricsA.intercept_ratio || 0)) * 100) >= 0 ? '+' : ''}${(((metricsB.intercept_ratio || 0) - (metricsA.intercept_ratio || 0)) * 100).toFixed(1)}%</b></td>
              ` : ''}
            </tr>
            <tr>
              <td><b>Threat-Weighted IR</b></td>
              <td>${((metricsA.threat_weighted_ir || 0) * 100).toFixed(1)}%</td>
              ${isCompare ? `
                <td><b>${((metricsB.threat_weighted_ir || 0) * 100).toFixed(1)}%</b></td>
                <td><b>${(((metricsB.threat_weighted_ir || 0) - (metricsA.threat_weighted_ir || 0)) * 100) >= 0 ? '+' : ''}${(((metricsB.threat_weighted_ir || 0) - (metricsA.threat_weighted_ir || 0)) * 100).toFixed(1)}%</b></td>
              ` : ''}
            </tr>
            <tr>
              <td><b>Missed: Scanning Away (Not Listening)</b></td>
              <td>${countsA.MISSED_NOT_LISTENING || 0} (${pctA.MISSED_NOT_LISTENING ?? 0}%)</td>
              ${isCompare ? `
                <td>${countsB.MISSED_NOT_LISTENING || 0} (${pctB.MISSED_NOT_LISTENING ?? 0}%)</td>
                <td>${(countsB.MISSED_NOT_LISTENING || 0) - (countsA.MISSED_NOT_LISTENING || 0)} bursts</td>
              ` : ''}
            </tr>
            <tr>
              <td><b>Missed: Low SNR / Below Sensitivity</b></td>
              <td>${countsA.MISSED_NOT_DETECTED || 0} (${pctA.MISSED_NOT_DETECTED ?? 0}%)</td>
              ${isCompare ? `
                <td>${countsB.MISSED_NOT_DETECTED || 0} (${pctB.MISSED_NOT_DETECTED ?? 0}%)</td>
                <td>${(countsB.MISSED_NOT_DETECTED || 0) - (countsA.MISSED_NOT_DETECTED || 0)} bursts</td>
              ` : ''}
            </tr>
            <tr>
              <td><b>Emitters Found (% of Fleet)</b></td>
              <td>${((metricsA.emitters_found || 0) * 100).toFixed(0)}% (${Math.round((metricsA.emitters_found || 0) * emitters.length)}/${emitters.length})</td>
              ${isCompare ? `
                <td>${((metricsB.emitters_found || 0) * 100).toFixed(0)}% (${Math.round((metricsB.emitters_found || 0) * emitters.length)}/${emitters.length})</td>
                <td>${Math.round(((metricsB.emitters_found || 0) - (metricsA.emitters_found || 0)) * emitters.length)} emitters</td>
              ` : ''}
            </tr>
            <tr>
              <td><b>False Alarm Count & Pfa</b></td>
              <td>${traceA.false_alarms?.length || 0} (Pfa = ${(metricsA.pfa || 0).toFixed(4)})</td>
              ${isCompare ? `
                <td>${traceB.false_alarms?.length || 0} (Pfa = ${(metricsB.pfa || 0).toFixed(4)})</td>
                <td>${(traceB.false_alarms?.length || 0) - (traceA.false_alarms?.length || 0)}</td>
              ` : ''}
            </tr>
          </tbody>
        </table>
      </div>

      <!-- SECTION 2: PERFORMANCE BY EMITTER CLASSIFICATION -->
      <div class="print-section">
        <h2 class="print-section-title">2. Performance by Emitter Classification</h2>
        <table class="print-table">
          <thead>
            <tr>
              <th>Emitter Name</th>
              <th>Classification</th>
              <th>Threat Weight</th>
              <th>Assigned Bands</th>
              <th>Bursts Sent</th>
              <th>Caught (${schedNameA})</th>
              ${isCompare ? `<th>Caught (${schedNameB})</th>` : ''}
              <th>Ratio %</th>
              <th>First Intercept Time</th>
            </tr>
          </thead>
          <tbody>
            ${emitters.map((em) => {
              const statA = perEmA.find((p) => p.name === em.name) || {};
              const statB = perEmB.find((p) => p.name === em.name) || {};
              const sent = statA.events || 0;
              const hitA = statA.intercepted || 0;
              const hitB = statB.intercepted || 0;
              const ratioA = sent ? ((hitA / sent) * 100).toFixed(1) + '%' : '—';
              const ratioB = sent ? ((hitB / sent) * 100).toFixed(1) + '%' : '—';
              const timeA = statA.first_intercept_slot !== null && statA.first_intercept_slot !== undefined
                ? (statA.first_intercept_slot * 0.01).toFixed(2) + ' s'
                : 'Never';
              const timeB = statB.first_intercept_slot !== null && statB.first_intercept_slot !== undefined
                ? (statB.first_intercept_slot * 0.01).toFixed(2) + ' s'
                : 'Never';
              const bLabels = (em.bands || []).map((b) => 'B' + (b < 10 ? '0' + b : b)).join(', ');

              return `
                <tr>
                  <td><b>${em.name}</b></td>
                  <td>${formatKind(em.type)}</td>
                  <td>${em.threat || 1.0}</td>
                  <td>${bLabels || '—'}</td>
                  <td>${sent}</td>
                  <td>${hitA} (${ratioA})</td>
                  ${isCompare ? `<td><b>${hitB}</b> (${ratioB})</td>` : ''}
                  <td>${isCompare ? `${ratioB}` : ratioA}</td>
                  <td>${isCompare ? `${timeA} / <b>${timeB}</b>` : timeA}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>

      <!-- SECTION 3: FREQUENCY BAND & SCAN ALLOCATION -->
      <div class="print-section">
        <h2 class="print-section-title">3. Frequency Band & Receiver Scan Dwell Allocation</h2>
        <table class="print-table">
          <thead>
            <tr>
              <th>Band</th>
              <th>Frequency Range</th>
              <th>Active Emitters</th>
              <th>Bursts Sent</th>
              <th>Intercepts (${schedNameA})</th>
              ${isCompare ? `<th>Intercepts (${schedNameB})</th>` : ''}
              <th>${schedNameA} Dwells (% time)</th>
              ${isCompare ? `<th>${schedNameB} Dwells (% time)</th>` : ''}
            </tr>
          </thead>
          <tbody>
            ${bands.map((b, idx) => {
              const pbA = (sumA.per_band && sumA.per_band[idx]) || {};
              const pbB = (sumB && sumB.per_band && sumB.per_band[idx]) || {};
              const bEms = emitters.filter((e) => (e.bands || []).includes(idx)).map((e) => e.name).join(', ') || '—';
              const sent = pbA.n_transmitted || 0;
              const hitA = (pbA.n_intercepted || 0) + (pbA.n_partial || 0);
              const hitB = (pbB.n_intercepted || 0) + (pbB.n_partial || 0);
              const dwellSlotsA = traceA.dwell.filter((d) => d === idx).length;
              const dwellSlotsB = traceB ? traceB.dwell.filter((d) => d === idx).length : 0;
              const dwellPctA = ((dwellSlotsA / metaA.n_slots) * 100).toFixed(1) + '%';
              const dwellPctB = ((dwellSlotsB / metaA.n_slots) * 100).toFixed(1) + '%';

              return `
                <tr>
                  <td><b>B${idx < 10 ? '0' + idx : idx}</b></td>
                  <td>${b.f_lo_ghz}–${b.f_hi_ghz} GHz</td>
                  <td>${bEms}</td>
                  <td>${sent}</td>
                  <td>${hitA}</td>
                  ${isCompare ? `<td><b>${hitB}</b></td>` : ''}
                  <td>${dwellSlotsA} (${dwellPctA})</td>
                  ${isCompare ? `<td><b>${dwellSlotsB} (${dwellPctB})</b></td>` : ''}
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>

      <!-- SECTION 4: LIVE THEATRE SNAPSHOT -->
      <div class="print-section print-snapshot-section">
        <h2 class="print-section-title">4. Live Intercept Theatre Snapshot</h2>
        ${snapshotUrl
          ? `<figure class="print-snapshot-figure"><img src="${snapshotUrl}" alt="${snapshotCaption}"><figcaption>${snapshotCaption}</figcaption></figure>`
          : `<p class="print-snapshot-unavailable">${snapshotCaption}</p>`}
      </div>

      <div class="print-footer">
        <div><b>SMART SCAN DEFENCE SYSTEMS</b> · AUTOMATED POST-MISSION TELEMETRY REPORT</div>
        <div>CONFIDENTIAL // DEFENCE RESEARCH EVALUATION · VERIFIED VIA GROUND TRUTH</div>
      </div>
    `;
  }

  function exportReconciliationReport() {
    if (!window.theatre) return;
    const traceA = window.theatre.getTraceA();
    if (!traceA) {
      alert('Run a simulation first in the Theatre to export a reconciliation report.');
      return;
    }
    const traceB = window.theatre.getTraceB();
    const isCompare = Boolean(traceB && window.theatre.isCompare());

    // Ensure reconciliation view is populated on screen as well
    if (typeof window.onRunFinished === 'function') {
      window.onRunFinished(traceA, traceB);
    }

    // Build the high-quality printable report
    buildPrintReport(traceA, traceB, isCompare);

    // Trigger print dialog
    window.print();
  }

  // ---------------------------------------------------------------- Help Modal & Reset
  function toggleHelpModal(show) {
    const modal = $('theatre-help-modal');
    if (!modal) return;
    if (show === undefined) {
      modal.classList.toggle('hidden');
    } else {
      modal.classList.toggle('hidden', !show);
    }
  }

  function resetScene() {
    if (window.theatre && typeof window.theatre.reset === 'function') {
      window.theatre.reset();
    }
    const capBar = $('theatre-caption-bar');
    if (capBar) capBar.classList.add('hidden');
    triggeredCaptionIds.clear();

    const rec = $('theatre-reconcile');
    if (rec) {
      rec.innerHTML = '';
      delete rec.dataset.initialized;
    }
    const errBox = $('theatre-error');
    if (errBox) {
      errBox.classList.remove('show');
      errBox.textContent = '';
    }
  }

  // ---------------------------------------------------------------- DOM Initialization
  function initDemoUI() {
    // 1. Insert Reset and Help controls into header
    const controls = document.querySelector('.theatre-controls');
    if (controls && !$('theatre-reset-btn')) {
      const resetBtn = document.createElement('button');
      resetBtn.id = 'theatre-reset-btn';
      resetBtn.className = 'reset-btn';
      resetBtn.innerHTML = '↺ Reset';
      resetBtn.addEventListener('click', resetScene);
      controls.appendChild(resetBtn);

      const helpBtn = document.createElement('button');
      helpBtn.id = 'theatre-help-btn';
      helpBtn.className = 'help-btn';
      helpBtn.innerHTML = '❓ Help';
      helpBtn.title = 'Shortcuts & System Help (Key ?)';
      helpBtn.addEventListener('click', () => toggleHelpModal(true));
      controls.appendChild(helpBtn);
    }

    // 2. Insert Snapshots & Captions toggle into Playbar
    const playbar = document.querySelector('.theatre-playbar');
    if (playbar && !$('theatre-captions-toggle')) {
      const capLabel = document.createElement('label');
      capLabel.className = 'inline small';
      capLabel.style.marginLeft = '8px';
      capLabel.innerHTML = '<input id="theatre-captions-toggle" type="checkbox" checked> Captions';
      capLabel.querySelector('input').addEventListener('change', (e) => {
        captionsEnabled = e.target.checked;
        if (!captionsEnabled) {
          const capBar = $('theatre-caption-bar');
          if (capBar) capBar.classList.add('hidden');
        }
      });
      playbar.appendChild(capLabel);

      const snapBtn = document.createElement('button');
      snapBtn.id = 'theatre-snap-scene-btn';
      snapBtn.className = 'reconcile-btn';
      snapBtn.style.marginLeft = '6px';
      snapBtn.innerHTML = '📷 Snapshot';
      snapBtn.title = 'Save Canvas Snapshot as PNG';
      snapBtn.addEventListener('click', saveSceneSnapshot);
      playbar.appendChild(snapBtn);

      const repBtn = document.createElement('button');
      repBtn.id = 'theatre-snap-rec-btn';
      repBtn.className = 'reconcile-btn';
      repBtn.style.marginLeft = '6px';
      repBtn.innerHTML = '📄 Report PDF';
      repBtn.title = 'Print / Save Reconciliation PDF Report';
      repBtn.addEventListener('click', exportReconciliationReport);
      playbar.appendChild(repBtn);
    }

    // 3. Insert Caption Bar directly below playbar
    if (playbar && !$('theatre-caption-bar')) {
      const capBar = document.createElement('div');
      capBar.id = 'theatre-caption-bar';
      capBar.className = 'theatre-caption-bar hidden';
      capBar.innerHTML = `
        <div class="theatre-caption-content">
          <span id="theatre-caption-icon" class="theatre-caption-icon">🎙</span>
          <span id="theatre-caption-text" class="theatre-caption-text"></span>
        </div>
        <div class="theatre-caption-progress-wrap">
          <div id="theatre-caption-progress" class="theatre-caption-progress"></div>
        </div>
      `;
      playbar.parentNode.insertBefore(capBar, playbar.nextSibling);
    }

    // 4. Insert Loading Skeleton Overlay
    const stage = $('theatre-stage');
    if (stage && !$('theatre-loading-overlay')) {
      const overlay = document.createElement('div');
      overlay.id = 'theatre-loading-overlay';
      overlay.className = 'theatre-loading-overlay hidden';
      overlay.innerHTML = `
        <div class="theatre-spinner"></div>
        <div id="theatre-loading-text" class="theatre-loading-text">Loading trace...</div>
      `;
      stage.style.position = 'relative';
      stage.appendChild(overlay);
    }

    // 5. Insert Help Overlay Modal
    if (!$('theatre-help-modal')) {
      const helpModal = document.createElement('div');
      helpModal.id = 'theatre-help-modal';
      helpModal.className = 'theatre-help-modal hidden';
      helpModal.innerHTML = `
        <div class="theatre-help-card">
          <div class="theatre-help-header">
            <h3><span>ℹ️</span> Live Intercept Theatre Reference & Help</h3>
            <button class="theatre-help-close" id="theatre-help-close-btn">&times;</button>
          </div>
          <div class="theatre-help-body">
            <div class="theatre-help-section">
              <h4>⌨️ Keyboard Shortcuts</h4>
              <div class="theatre-help-grid">
                <div class="theatre-help-key"><kbd>Space</kbd> <span>Play / Pause</span></div>
                <div class="theatre-help-key"><kbd>&larr;</kbd> <kbd>&rarr;</kbd> <span>Step &plusmn;1 slot</span></div>
                <div class="theatre-help-key"><kbd>?</kbd> <span>Open / Close Help</span></div>
                <div class="theatre-help-key"><kbd>Esc</kbd> <span>Close Modal</span></div>
              </div>
            </div>

            <div class="theatre-help-section">
              <h4>📡 The Three Synchronized Views</h4>
              <p><b>1. Network View (Cockpit Radar):</b> Central ES receiver with an eased antenna beam pointing to the current dwell band. Transmitting nodes pulse expanding shockwaves. Packets travel inward: absorbed with green checkmark on detection, or turn red with dashed outline on miss.</p>
              <p><b>2. Time-Frequency Strip:</b> 2D time-frequency spectrogram. Colored blocks indicate ground-truth bursts; solid green boxes mark successful detections; red dashed boxes mark missed bursts. Connected dark line displays the receiver's scan path.</p>
              <p><b>3. Visiting Pattern & Heat Bar:</b> Live stepped line chart of dwell band index vs time slot, dwell histogram bar by band, and operational mode badge (Coverage sweep, Period acquisition, Timed interrupt).</p>
            </div>

            <div class="theatre-help-section">
              <h4>📋 Post-Run Reconciliation</h4>
              <p>When playback finishes or on clicking "Show reconciliation", the system compares transmitted ground truth against decoded signals. Unintercepted bursts appear as explicit gap chips labeled with the band, frequency range, emitter, and exact slots.</p>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(helpModal);
      $('theatre-help-close-btn').addEventListener('click', () => toggleHelpModal(false));
      helpModal.addEventListener('click', (e) => {
        if (e.target === helpModal) toggleHelpModal(false);
      });
    }

    // 6. Global Keyboard Shortcuts (?, Esc)
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

      // Only handle shortcuts when Theatre is visible (Live scan Detailed view)
      const theatreWrap = document.querySelector('.theatre-wrap');
      const isTheatreVisible = theatreWrap && (theatreWrap.offsetParent !== null || theatreWrap.offsetWidth > 0);
      if (!isTheatreVisible) return;

      if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        e.preventDefault();
        toggleHelpModal();
      } else if (e.key === 'Escape') {
        const modal = $('theatre-help-modal');
        if (modal && !modal.classList.contains('hidden')) {
          toggleHelpModal(false);
        }
      }
    });
  }

  // Initialize once DOM is ready or after brief deferral
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDemoUI);
  } else {
    initDemoUI();
  }

  window.demo = {
    runDemo,
    togglePresentationMode,
    saveSceneSnapshot,
    exportReconciliationReport,
    resetScene,
    toggleHelpModal,
  };
})();
