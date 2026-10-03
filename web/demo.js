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
  function saveSceneSnapshot() {
    if (!window.theatre) return;
    const traceA = window.theatre.getTraceA();
    if (!traceA) {
      alert('No active simulation to snapshot. Run a scenario first.');
      return;
    }

    const traceB = window.theatre.getTraceB();
    const isCompare = window.theatre.isCompare();
    const curSlot = Math.floor(window.theatre.getCurrentSlot ? window.theatre.getCurrentSlot() : 0);

    const canvasRingA = $('canvas-ring-a');
    const canvasStripA = $('canvas-strip-a');
    const canvasPatternA = $('canvas-pattern-a');

    if (!canvasRingA || !canvasStripA) return;

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

  function exportReconciliationReport() {
    if (!window.theatre) return;
    const traceA = window.theatre.getTraceA();
    if (!traceA) {
      alert('Run a simulation first to export a reconciliation report.');
      return;
    }

    // Ensure reconciliation view is populated
    if (typeof window.onRunFinished === 'function') {
      window.onRunFinished(traceA, window.theatre.getTraceB());
    }

    // Trigger print dialog (styled via @media print)
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
    if (rec) rec.innerHTML = '';
  }

  // ---------------------------------------------------------------- DOM Initialization
  function initDemoUI() {
    // 1. Insert Demo, Presentation, Reset, Snapshot, and Help controls into header/playbar
    const controls = document.querySelector('.theatre-controls');
    if (controls && !$('theatre-run-demo-btn')) {
      const demoBtn = document.createElement('button');
      demoBtn.id = 'theatre-run-demo-btn';
      demoBtn.className = 'demo-btn';
      demoBtn.innerHTML = '<span>⚡</span> ▶ Run Demo';
      demoBtn.addEventListener('click', runDemo);
      controls.insertBefore(demoBtn, $('theatre-run-btn'));

      const resetBtn = document.createElement('button');
      resetBtn.id = 'theatre-reset-btn';
      resetBtn.className = 'reset-btn';
      resetBtn.innerHTML = '↺ Reset';
      resetBtn.addEventListener('click', resetScene);
      controls.appendChild(resetBtn);

      const presBtn = document.createElement('button');
      presBtn.id = 'theatre-pres-btn';
      presBtn.className = 'pres-btn';
      presBtn.innerHTML = '🖥 Presentation';
      presBtn.title = 'Presentation Mode (Key P)';
      presBtn.addEventListener('click', togglePresentationMode);
      controls.appendChild(presBtn);

      const helpBtn = document.createElement('button');
      helpBtn.id = 'theatre-help-btn';
      helpBtn.className = 'help-btn';
      helpBtn.innerHTML = '❓ Help';
      helpBtn.title = 'Shortcuts & System Help (Key ?)';
      helpBtn.addEventListener('click', () => toggleHelpModal(true));
      controls.appendChild(helpBtn);

      // Offline badge
      const badge = document.createElement('span');
      badge.id = 'theatre-demo-badge';
      badge.className = 'theatre-demo-badge hidden';
      badge.innerHTML = '📦 Using saved demo data';
      controls.appendChild(badge);
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
      repBtn.title = 'Print / Save Reconciliation PDF';
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

    // 4. Insert Presentation Mode Exit Button
    if (!document.querySelector('.theatre-pres-exit-btn')) {
      const exitBtn = document.createElement('button');
      exitBtn.className = 'theatre-pres-exit-btn';
      exitBtn.innerHTML = '✕ Exit Presentation (Esc)';
      exitBtn.addEventListener('click', exitPresentationMode);
      document.body.appendChild(exitBtn);
    }

    // 5. Insert Loading Skeleton Overlay
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

    // 6. Insert Help Overlay Modal
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
                <div class="theatre-help-key"><kbd>P</kbd> <span>Toggle Presentation Mode</span></div>
                <div class="theatre-help-key"><kbd>?</kbd> <span>Open / Close Help</span></div>
                <div class="theatre-help-key"><kbd>Esc</kbd> <span>Close Modal / Exit Fullscreen</span></div>
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

    // 7. Global Keyboard Shortcuts (P, ?, Esc)
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

      if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        togglePresentationMode();
      } else if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        e.preventDefault();
        toggleHelpModal();
      } else if (e.key === 'Escape') {
        const modal = $('theatre-help-modal');
        if (modal && !modal.classList.contains('hidden')) {
          toggleHelpModal(false);
        } else if (document.body.classList.contains('presentation-mode')) {
          exitPresentationMode();
        }
      }
    });

    // 8. Fullscreenchange listener
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && document.body.classList.contains('presentation-mode')) {
        exitPresentationMode();
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
