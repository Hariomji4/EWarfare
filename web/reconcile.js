/* Live Intercept Theatre - Post-Run Reconciliation View Engine */

(function () {
  'use strict';

  // State
  let traceA = null;
  let traceB = null;
  let isCompare = false;

  let activeFilters = {
    status: 'ALL',
    band: 'ALL',
    type: 'ALL',
    missedOnly: false,
    search: '',
    diff: 'ALL', // 'ALL', 'ONLY_B', 'ONLY_A'
  };

  let activeViewMode = 'stream'; // 'stream' (aligned rows) or 'flow' (inline chips)
  let bandChartInstance = null;
  let isSyncingScroll = false;
  let activeSelectedMsgId = null;

  // Virtualization constants
  const ROW_HEIGHT = 44; // px per row (chip height + gap)
  const BUFFER_ROWS = 12; // overscan rows above and below

  function $(id) {
    return document.getElementById(id);
  }

  // ---------------------------------------------------------------- Outcome Helpers
  const STATUS_ICONS = {
    INTERCEPTED: '✔',
    PARTIAL: '◐',
    MISSED_NOT_LISTENING: '✖',
    MISSED_NOT_DETECTED: '⊗',
    FALSE_ALARM: '!',
  };

  const STATUS_CLASS = {
    INTERCEPTED: 'status-intercepted',
    PARTIAL: 'status-partial',
    MISSED_NOT_LISTENING: 'status-missed-listening',
    MISSED_NOT_DETECTED: 'status-missed-detected',
    FALSE_ALARM: 'status-fa',
  };

  function getEmitterName(msg, trace) {
    if (msg.emitter_name) return msg.emitter_name;
    if (trace && trace.emitters && trace.emitters[msg.emitter_id]) {
      return trace.emitters[msg.emitter_id].name;
    }
    return msg.type || 'Emitter';
  }

  function getMessageReason(msg, outcome, trace) {
    if (!outcome) return 'No outcome recorded.';
    const bandLabel = trace?.bands?.[msg.band]?.label || `Band ${msg.band}`;

    if (outcome.status === 'MISSED_NOT_LISTENING') {
      const listened = outcome.listened_bands_during || [];
      if (listened.length === 0) {
        return `Receiver did not record dwell during slots ${msg.start_slot}–${msg.end_slot}.`;
      }
      const bNames = listened.map((b) => `B${b < 10 ? '0' + b : b}`).join(', ');
      return `Receiver dwelled on [${bNames}] during slots ${msg.start_slot}–${msg.end_slot}, never ${bandLabel}.`;
    }

    if (outcome.status === 'MISSED_NOT_DETECTED') {
      return `Receiver tuned to ${bandLabel} during ${outcome.n_listen_slots} slot(s), but signal power (${msg.power_dbm} dBm) was below detection threshold / noise fluctuation.`;
    }

    if (outcome.status === 'PARTIAL') {
      const burstLen = msg.end_slot - msg.start_slot + 1;
      return `Partial interception: detector fired in ${outcome.n_hit_slots} of ${burstLen} transmission slot(s) (dwelled in ${outcome.n_listen_slots} slots).`;
    }

    if (outcome.status === 'INTERCEPTED') {
      return `Successfully intercepted on ${bandLabel} (first detected at slot ${outcome.first_hit_slot}, ${outcome.n_hit_slots} detection slots).`;
    }

    return 'Normal transmission.';
  }

  // ---------------------------------------------------------------- DOM Construction
  function ensureReconcileContainer() {
    const container = $('theatre-reconcile');
    if (!container) return null;

    if (!container.dataset.initialized) {
      container.dataset.initialized = 'true';
      container.innerHTML = `
        <div class="theatre-reconcile-card">
          <!-- Header -->
          <div class="reconcile-header">
            <div class="reconcile-title-wrap">
              <span class="reconcile-title">
                <span>📋</span> Post-Run Reconciliation: Transmitted vs Decoded
              </span>
              <span id="reconcile-subtitle" class="reconcile-subtitle"></span>
            </div>
            <div class="reconcile-actions">
              <button id="reconcile-export-csv" class="reconcile-btn" title="Download Reconciliation CSV">
                <span>📥</span> Export CSV
              </button>
              <button id="reconcile-export-json" class="reconcile-btn" title="Download Reconciliation JSON">
                <span>📥</span> Export JSON
              </button>
            </div>
          </div>

          <!-- Summary Metric Cards -->
          <div id="reconcile-summary-grid" class="reconcile-summary-grid"></div>

          <!-- Consistency Banner -->
          <div id="reconcile-consistency-banner" class="reconcile-consistency-banner"></div>

          <!-- Compare Mode Diff Banner (hidden by default) -->
          <div id="reconcile-diff-banner" class="reconcile-diff-banner hidden">
            <div>
              <div id="reconcile-diff-headline" class="reconcile-diff-headline"></div>
              <div id="reconcile-diff-sub" class="reconcile-diff-sub"></div>
            </div>
            <div class="reconcile-diff-toggles">
              <button id="diff-filter-all" class="reconcile-diff-btn active">All Messages</button>
              <button id="diff-filter-b" class="reconcile-diff-btn">Caught by B Only</button>
              <button id="diff-filter-a" class="reconcile-diff-btn">Caught by A Only</button>
            </div>
          </div>

          <!-- Filter Toolbar -->
          <div class="reconcile-filters">
            <div class="reconcile-filter-group">
              <label for="reconcile-filter-status">Status:</label>
              <select id="reconcile-filter-status">
                <option value="ALL">All Outcomes</option>
                <option value="INTERCEPTED">Intercepted (100%)</option>
                <option value="PARTIAL">Partial</option>
                <option value="MISSED_NOT_LISTENING">Missed (Not Listening)</option>
                <option value="MISSED_NOT_DETECTED">Missed (Not Detected)</option>
                <option value="FALSE_ALARM">False Alarms Only</option>
              </select>
            </div>

            <div class="reconcile-filter-group">
              <label for="reconcile-filter-band">Band:</label>
              <select id="reconcile-filter-band">
                <option value="ALL">All Bands</option>
              </select>
            </div>

            <div class="reconcile-filter-group">
              <label for="reconcile-filter-type">Emitter:</label>
              <select id="reconcile-filter-type">
                <option value="ALL">All Types</option>
              </select>
            </div>

            <label class="reconcile-filter-checkbox">
              <input id="reconcile-filter-missed-only" type="checkbox">
              <span>Show only missed</span>
            </label>

            <div class="reconcile-filter-group">
              <label for="reconcile-search">Search:</label>
              <input id="reconcile-search" type="text" placeholder="Payload, emitter, band..." autocomplete="off">
            </div>

            <div id="reconcile-results-count" class="reconcile-results-count"></div>
          </div>

          <!-- Two (or Three) Side-by-Side Paragraph Panes -->
          <div id="reconcile-panes-container" class="reconcile-panes-container">
            <!-- Left: Transmitted (Truth) -->
            <div class="reconcile-pane">
              <div class="reconcile-pane-header">
                <span class="reconcile-pane-title">
                  <span>📡</span> 1. Transmitted (Ground Truth)
                </span>
                <span id="reconcile-badge-sent" class="reconcile-pane-badge">0 bursts</span>
              </div>
              <div id="reconcile-scroll-truth" class="reconcile-pane-scroll" tabindex="0">
                <div id="reconcile-spacer-truth" style="position:relative; width:100%;">
                  <div id="reconcile-content-truth" class="reconcile-stream-list" style="position:absolute; top:0; left:0; right:0;"></div>
                </div>
              </div>
            </div>

            <!-- Right: Receiver Decoded -->
            <div class="reconcile-pane">
              <div class="reconcile-pane-header">
                <span class="reconcile-pane-title">
                  <span>🎯</span> <span id="reconcile-rx-a-title">2. Receiver Decoded</span>
                </span>
                <span id="reconcile-badge-rx-a" class="reconcile-pane-badge">0 caught</span>
              </div>
              <div id="reconcile-scroll-rx-a" class="reconcile-pane-scroll" tabindex="0">
                <div id="reconcile-spacer-rx-a" style="position:relative; width:100%;">
                  <div id="reconcile-content-rx-a" class="reconcile-stream-list" style="position:absolute; top:0; left:0; right:0;"></div>
                </div>
              </div>
            </div>

            <!-- Compare Mode: Receiver B Decoded -->
            <div id="reconcile-pane-rx-b" class="reconcile-pane hidden">
              <div class="reconcile-pane-header">
                <span class="reconcile-pane-title">
                  <span>🤖</span> <span id="reconcile-rx-b-title">3. Receiver B Decoded</span>
                </span>
                <span id="reconcile-badge-rx-b" class="reconcile-pane-badge">0 caught</span>
              </div>
              <div id="reconcile-scroll-rx-b" class="reconcile-pane-scroll" tabindex="0">
                <div id="reconcile-spacer-rx-b" style="position:relative; width:100%;">
                  <div id="reconcile-content-rx-b" class="reconcile-stream-list" style="position:absolute; top:0; left:0; right:0;"></div>
                </div>
              </div>
            </div>
          </div>

          <!-- Charts and Analytics Section -->
          <div class="reconcile-analytics-grid">
            <!-- Per-Band Stacked Bar Chart -->
            <div class="reconcile-chart-box">
              <div class="reconcile-chart-header">
                <span class="reconcile-chart-title">Interception Distribution by Band (Click bar to filter)</span>
                <span class="small muted">Stacked Outcomes</span>
              </div>
              <div class="reconcile-canvas-container">
                <canvas id="reconcile-chart-bands"></canvas>
              </div>
            </div>

            <!-- Per-Emitter-Type Summary Table -->
            <div class="reconcile-chart-box">
              <div class="reconcile-chart-header">
                <span class="reconcile-chart-title">Performance by Emitter Classification</span>
                <span class="small muted">Threat & Ratio Breakdown</span>
              </div>
              <div class="reconcile-table-wrap">
                <table class="reconcile-table">
                  <thead>
                    <tr>
                      <th>Emitter Type</th>
                      <th>Sent</th>
                      <th>Intercepted</th>
                      <th>Partial</th>
                      <th>Missed</th>
                      <th>Ratio</th>
                    </tr>
                  </thead>
                  <tbody id="reconcile-emitter-tbody"></tbody>
                </table>
              </div>
            </div>
          </div>

        </div>

        <!-- Custom Tooltip -->
        <div id="reconcile-tooltip" class="reconcile-tooltip"></div>
      `;

      attachReconcileEvents();
    }

    return container;
  }

  // ---------------------------------------------------------------- Event Listeners
  function attachReconcileEvents() {
    // Filter controls
    $('reconcile-filter-status').addEventListener('change', (e) => {
      activeFilters.status = e.target.value;
      renderVirtualizedPanes();
    });

    $('reconcile-filter-band').addEventListener('change', (e) => {
      activeFilters.band = e.target.value;
      renderVirtualizedPanes();
    });

    $('reconcile-filter-type').addEventListener('change', (e) => {
      activeFilters.type = e.target.value;
      renderVirtualizedPanes();
    });

    $('reconcile-filter-missed-only').addEventListener('change', (e) => {
      activeFilters.missedOnly = e.target.checked;
      renderVirtualizedPanes();
    });

    $('reconcile-search').addEventListener('input', (e) => {
      activeFilters.search = e.target.value.trim().toLowerCase();
      renderVirtualizedPanes();
    });

    // Compare diff buttons
    $('diff-filter-all').addEventListener('click', () => setDiffFilter('ALL'));
    $('diff-filter-b').addEventListener('click', () => setDiffFilter('ONLY_B'));
    $('diff-filter-a').addEventListener('click', () => setDiffFilter('ONLY_A'));

    // Export buttons
    $('reconcile-export-csv').addEventListener('click', exportCSV);
    $('reconcile-export-json').addEventListener('click', exportJSON);

    // Synchronized scroll listeners
    const scrolls = [
      $('reconcile-scroll-truth'),
      $('reconcile-scroll-rx-a'),
      $('reconcile-scroll-rx-b'),
    ].filter(Boolean);

    scrolls.forEach((elem) => {
      elem.addEventListener('scroll', () => {
        if (isSyncingScroll) return;
        isSyncingScroll = true;
        const top = elem.scrollTop;
        scrolls.forEach((other) => {
          if (other !== elem && Math.abs(other.scrollTop - top) > 1) {
            other.scrollTop = top;
          }
        });
        renderVirtualizedPanes();
        isSyncingScroll = false;
      });
    });

    // Tooltip hide on mouseleave
    document.addEventListener('mousemove', (e) => {
      const tooltip = $('reconcile-tooltip');
      if (tooltip && !e.target.closest('.reconcile-chip')) {
        tooltip.classList.remove('show');
      }
    });
  }

  function setDiffFilter(mode) {
    activeFilters.diff = mode;
    $('diff-filter-all').classList.toggle('active', mode === 'ALL');
    $('diff-filter-b').classList.toggle('active', mode === 'ONLY_B');
    $('diff-filter-a').classList.toggle('active', mode === 'ONLY_A');
    renderVirtualizedPanes();
  }

  // ---------------------------------------------------------------- Filter Pipeline
  function getFilteredStreamItems() {
    if (!traceA) return [];

    const msgs = traceA.messages || [];
    const outcomesA = traceA.outcomes || [];
    const outcomesB = traceB ? traceB.outcomes : null;
    const fas = traceA.false_alarms || [];

    const items = [];

    // 1. Process Messages (if status filter is not exclusively FALSE_ALARM)
    if (activeFilters.status !== 'FALSE_ALARM') {
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        const oA = outcomesA[i];
        const oB = outcomesB ? outcomesB[i] : null;

        const statusA = oA.status;
        const isMissedA = statusA === 'MISSED_NOT_LISTENING' || statusA === 'MISSED_NOT_DETECTED';

        if (activeFilters.status !== 'ALL' && statusA !== activeFilters.status) {
          continue;
        }

        if (activeFilters.missedOnly && !isMissedA) {
          continue;
        }

        if (activeFilters.band !== 'ALL' && m.band !== parseInt(activeFilters.band, 10)) {
          continue;
        }

        if (activeFilters.type !== 'ALL' && m.type !== activeFilters.type) {
          continue;
        }

        if (isCompare && oB) {
          const hitA = statusA === 'INTERCEPTED' || statusA === 'PARTIAL';
          const hitB = oB.status === 'INTERCEPTED' || oB.status === 'PARTIAL';

          if (activeFilters.diff === 'ONLY_B' && !(hitB && !hitA)) {
            continue;
          }
          if (activeFilters.diff === 'ONLY_A' && !(hitA && !hitB)) {
            continue;
          }
        }

        if (activeFilters.search) {
          const query = activeFilters.search;
          const emName = getEmitterName(m, traceA).toLowerCase();
          const payload = (m.payload || '').toLowerCase();
          const bandStr = `b${m.band < 10 ? '0' + m.band : m.band}`;
          const typeStr = (m.type || '').toLowerCase();

          if (
            !payload.includes(query) &&
            !emName.includes(query) &&
            !bandStr.includes(query) &&
            !typeStr.includes(query)
          ) {
            continue;
          }
        }

        items.push({ kind: 'MSG', idx: i, slot: m.start_slot, band: m.band });
      }
    }

    // 2. Process False Alarms (when status is ALL or FALSE_ALARM, and not missed-only)
    if (!activeFilters.missedOnly && (activeFilters.status === 'ALL' || activeFilters.status === 'FALSE_ALARM')) {
      if (activeFilters.type === 'ALL' && activeFilters.diff === 'ALL') {
        for (let j = 0; j < fas.length; j++) {
          const fa = fas[j];
          if (activeFilters.band !== 'ALL' && fa.band !== parseInt(activeFilters.band, 10)) {
            continue;
          }
          if (activeFilters.search) {
            const query = activeFilters.search;
            const bandStr = `b${fa.band < 10 ? '0' + fa.band : fa.band}`;
            if (!query.includes('false') && !query.includes('alarm') && !bandStr.includes(query)) {
              continue;
            }
          }
          items.push({ kind: 'FA', idx: j, slot: fa.slot, band: fa.band });
        }
      }
    }

    // Stable sort by time slot, then band
    items.sort((a, b) => a.slot - b.slot || a.band - b.band);
    return items;
  }

  // ---------------------------------------------------------------- Virtualized Panes
  function renderVirtualizedPanes() {
    if (!traceA) return;

    const streamItems = getFilteredStreamItems();
    const countElem = $('reconcile-results-count');
    const totalMsgs = traceA.messages.length;
    countElem.textContent = `Showing ${streamItems.length} items (${totalMsgs} bursts, ${traceA.false_alarms?.length || 0} false alarms)`;

    const scrollContainer = $('reconcile-scroll-truth');
    const scrollTop = scrollContainer.scrollTop || 0;
    const viewHeight = scrollContainer.clientHeight || 500;

    const totalRows = streamItems.length;
    const totalHeight = totalRows * ROW_HEIGHT;

    // Set height of spacer elements
    ['reconcile-spacer-truth', 'reconcile-spacer-rx-a', 'reconcile-spacer-rx-b'].forEach((id) => {
      const el = $(id);
      if (el) el.style.height = `${totalHeight}px`;
    });

    // Compute window slice
    const startRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER_ROWS);
    const endRow = Math.min(totalRows, Math.ceil((scrollTop + viewHeight) / ROW_HEIGHT) + BUFFER_ROWS);
    const offsetY = startRow * ROW_HEIGHT;

    const sliceItems = streamItems.slice(startRow, endRow);

    // Render Slice for Truth
    const contentTruth = $('reconcile-content-truth');
    contentTruth.style.transform = `translateY(${offsetY}px)`;
    contentTruth.innerHTML = sliceItems.map((item) => createTruthChipHTML(item)).join('');

    // Render Slice for Receiver A
    const contentRxA = $('reconcile-content-rx-a');
    contentRxA.style.transform = `translateY(${offsetY}px)`;
    contentRxA.innerHTML = sliceItems.map((item) => createDecodedChipHTML(item, traceA)).join('');

    // Render Slice for Receiver B (if compare active)
    if (isCompare && traceB) {
      const contentRxB = $('reconcile-content-rx-b');
      if (contentRxB) {
        contentRxB.style.transform = `translateY(${offsetY}px)`;
        contentRxB.innerHTML = sliceItems.map((item) => createDecodedChipHTML(item, traceB)).join('');
      }
    }

    // Attach click and tooltip events to newly created chips in DOM
    attachChipInteractions(sliceItems);
  }

  function createTruthChipHTML(item) {
    if (item.kind === 'FA') {
      const fa = traceA.false_alarms[item.idx];
      const bLabel = `B${fa.band < 10 ? '0' + fa.band : fa.band}`;
      return `
        <div class="reconcile-chip" style="background:rgba(30, 41, 59, 0.4); border:1px dashed #475569; color:#94a3b8; font-style:italic;" data-item-kind="FA" data-item-idx="${item.idx}" data-slot="${fa.slot}" data-band="${fa.band}">
          <div class="reconcile-chip-left">
            <span class="reconcile-chip-icon" style="color:#64748b;">—</span>
            <span class="reconcile-chip-text">[Silent on ${bLabel} · No transmission]</span>
          </div>
          <div class="reconcile-chip-right">
            <span>slot ${fa.slot}</span>
          </div>
        </div>
      `;
    }

    const m = traceA.messages[item.idx];
    const bInfo = traceA.bands[m.band];
    const bLabel = `B${m.band < 10 ? '0' + m.band : m.band}`;
    const emName = getEmitterName(m, traceA);
    const activeClass = activeSelectedMsgId === m.id ? 'active-seek' : '';

    return `
      <div class="reconcile-chip truth-chip ${activeClass}" data-item-kind="MSG" data-item-idx="${item.idx}" data-slot="${m.start_slot}" data-band="${m.band}">
        <div class="reconcile-chip-left">
          <span class="reconcile-chip-icon">📡</span>
          <span class="reconcile-chip-text">${m.payload || `${emName} ${bLabel} t=${m.start_slot}`}</span>
        </div>
        <div class="reconcile-chip-right">
          <span>${bLabel} (${bInfo.f_lo_ghz}-${bInfo.f_hi_ghz}G)</span>
          <span>slots ${m.start_slot}-${m.end_slot}</span>
        </div>
      </div>
    `;
  }

  function createDecodedChipHTML(item, trace) {
    if (item.kind === 'FA') {
      const fa = traceA.false_alarms[item.idx];
      const bInfo = traceA.bands[fa.band];
      const bLabel = `B${fa.band < 10 ? '0' + fa.band : fa.band}`;
      return `
        <div class="reconcile-chip status-fa" data-item-kind="FA" data-item-idx="${item.idx}" data-slot="${fa.slot}" data-band="${fa.band}">
          <div class="reconcile-chip-left">
            <span class="reconcile-chip-icon">!</span>
            <span class="reconcile-chip-text">FALSE ALARM · Band ${fa.band} (${bInfo.f_lo_ghz}-${bInfo.f_hi_ghz} GHz) · slot ${fa.slot} (nothing was transmitted)</span>
          </div>
          <div class="reconcile-chip-right">
            <span>${bLabel}</span>
            <span>slot ${fa.slot}</span>
          </div>
        </div>
      `;
    }

    const m = trace.messages[item.idx];
    const o = trace.outcomes[item.idx];
    const bInfo = trace.bands[m.band];
    const bLabel = `B${m.band < 10 ? '0' + m.band : m.band}`;
    const emName = getEmitterName(m, trace);
    const status = o.status;
    const icon = STATUS_ICONS[status] || '•';
    const cls = STATUS_CLASS[status] || 'status-intercepted';
    const activeClass = activeSelectedMsgId === m.id ? 'active-seek' : '';

    if (status === 'INTERCEPTED' || status === 'PARTIAL') {
      const hitText = status === 'INTERCEPTED' ? m.payload : `[PARTIAL ${o.n_hit_slots}/${m.end_slot - m.start_slot + 1}] ${m.payload}`;
      return `
        <div class="reconcile-chip ${cls} ${activeClass}" data-item-kind="MSG" data-item-idx="${item.idx}" data-slot="${m.start_slot}" data-band="${m.band}">
          <div class="reconcile-chip-left">
            <span class="reconcile-chip-icon">${icon}</span>
            <span class="reconcile-chip-text">${hitText}</span>
          </div>
          <div class="reconcile-chip-right">
            <span>${bLabel}</span>
            <span>hit t=${o.first_hit_slot ?? m.start_slot}</span>
          </div>
        </div>
      `;
    } else {
      // Missed Gaps (Red or Orange)
      const missLabel = status === 'MISSED_NOT_LISTENING' ? 'NOT RECEIVED' : 'NOT DETECTED';
      const gapText = `${missLabel} · should come from Band ${m.band} (${bInfo.f_lo_ghz}-${bInfo.f_hi_ghz} GHz) · ${emName} · slots ${m.start_slot}-${m.end_slot}`;

      return `
        <div class="reconcile-chip ${cls} ${activeClass}" data-item-kind="MSG" data-item-idx="${item.idx}" data-slot="${m.start_slot}" data-band="${m.band}">
          <div class="reconcile-chip-left">
            <span class="reconcile-chip-icon">${icon}</span>
            <span class="reconcile-chip-text">${gapText}</span>
          </div>
          <div class="reconcile-chip-right">
            <span>${status === 'MISSED_NOT_LISTENING' ? 'Not listening' : 'Low SNR/Pd'}</span>
          </div>
        </div>
      `;
    }
  }

  // ---------------------------------------------------------------- Chip Interaction (Seek & Tooltip)
  function attachChipInteractions() {
    const chips = document.querySelectorAll('.reconcile-chip');
    chips.forEach((chip) => {
      chip.addEventListener('click', (e) => {
        const kind = chip.dataset.itemKind;
        const idx = parseInt(chip.dataset.itemIdx, 10);
        const slot = parseInt(chip.dataset.slot, 10);
        const band = parseInt(chip.dataset.band, 10);

        if (kind === 'MSG' && traceA?.messages?.[idx]) {
          activeSelectedMsgId = traceA.messages[idx].id;
        } else {
          activeSelectedMsgId = null;
        }

        // Visual active ring on chip
        document.querySelectorAll('.reconcile-chip.active-seek').forEach((c) => c.classList.remove('active-seek'));
        chip.classList.add('active-seek');

        // Seek animation scene & flash band
        if (window.theatre && typeof window.theatre.seekToSlot === 'function') {
          window.theatre.seekToSlot(slot, band);
        }
      });

      chip.addEventListener('mouseenter', (e) => {
        const kind = chip.dataset.itemKind;
        const idx = parseInt(chip.dataset.itemIdx, 10);
        showTooltip(e, kind, idx);
      });

      chip.addEventListener('mousemove', (e) => {
        positionTooltip(e);
      });
    });
  }

  function showTooltip(evt, kind, idx) {
    if (!traceA) return;
    const tooltip = $('reconcile-tooltip');
    if (!tooltip) return;

    if (kind === 'FA') {
      const fa = traceA.false_alarms[idx];
      const bInfo = traceA.bands[fa.band];
      const bLabel = `B${fa.band < 10 ? '0' + fa.band : fa.band}`;
      tooltip.innerHTML = `
        <div class="reconcile-tooltip-header">
          <span style="color:#c084fc;">FALSE ALARM (${bLabel})</span>
          <span style="font-size:11px; color:#cbd5e1;">Thermal Noise Trip</span>
        </div>
        <div class="reconcile-tooltip-row">
          <span class="label">Band & Freq:</span>
          <span class="val">${bLabel} (${bInfo.f_lo_ghz}-${bInfo.f_hi_ghz} GHz)</span>
        </div>
        <div class="reconcile-tooltip-row">
          <span class="label">Timing:</span>
          <span class="val">Slot ${fa.slot} (${(fa.slot * (traceA.meta.slot_duration_ms || 10)).toFixed(0)} ms)</span>
        </div>
        <div class="reconcile-tooltip-reason" style="color:#d8b4fe; border-color:#a855f7;">
          Noise floor or clutter fluctuation randomly crossed detection threshold (design Pfa = ${traceA.summary?.metrics?.pfa?.toFixed(4) || '1e-4'}). No ground-truth signal was transmitting.
        </div>
      `;
      tooltip.classList.add('show');
      positionTooltip(evt);
      return;
    }

    const m = traceA.messages[idx];
    const oA = traceA.outcomes[idx];
    const oB = traceB ? traceB.outcomes[idx] : null;
    const bInfo = traceA.bands[m.band];
    const emName = getEmitterName(m, traceA);
    const durationMs = ((m.end_slot - m.start_slot + 1) * (traceA.meta.slot_duration_ms || 10)).toFixed(0);

    const reasonA = getMessageReason(m, oA, traceA);
    let compareHtml = '';

    if (isCompare && oB) {
      const reasonB = getMessageReason(m, oB, traceB);
      compareHtml = `
        <div class="reconcile-tooltip-reason" style="color:#7dd3fc; border-color:#0284c7; margin-top:6px;">
          <b>${traceB.meta.scheduler} (${oB.status}):</b> ${reasonB}
        </div>
      `;
    }

    tooltip.innerHTML = `
      <div class="reconcile-tooltip-header">
        <span>${emName} (#${m.id})</span>
        <span style="font-size:11px; color:#cbd5e1;">${m.type}</span>
      </div>
      <div class="reconcile-tooltip-row">
        <span class="label">Band & Freq:</span>
        <span class="val">B${m.band < 10 ? '0' + m.band : m.band} (${bInfo.f_lo_ghz}-${bInfo.f_hi_ghz} GHz)</span>
      </div>
      <div class="reconcile-tooltip-row">
        <span class="label">Timing:</span>
        <span class="val">Slots ${m.start_slot}–${m.end_slot} (${durationMs} ms)</span>
      </div>
      <div class="reconcile-tooltip-row">
        <span class="label">Power & Threat:</span>
        <span class="val">${m.power_dbm} dBm · Threat ${m.threat}</span>
      </div>
      <div class="reconcile-tooltip-row">
        <span class="label">Outcome Status:</span>
        <span class="val" style="color:${oA.status === 'INTERCEPTED' ? '#34d399' : '#f87171'}">${oA.status}</span>
      </div>
      <div class="reconcile-tooltip-reason">
        <b>${traceA.meta.scheduler}:</b> ${reasonA}
      </div>
      ${compareHtml}
    `;

    tooltip.classList.add('show');
    positionTooltip(evt);
  }

  function positionTooltip(evt) {
    const tooltip = $('reconcile-tooltip');
    if (!tooltip || !tooltip.classList.contains('show')) return;

    const x = evt.clientX + 14;
    const y = evt.clientY + 14;
    const pad = 12;

    const maxX = window.innerWidth - tooltip.offsetWidth - pad;
    const maxY = window.innerHeight - tooltip.offsetHeight - pad;

    tooltip.style.left = `${Math.min(x, maxX)}px`;
    tooltip.style.top = `${Math.min(y, maxY)}px`;
  }

  // ---------------------------------------------------------------- Summary Cards & Consistency
  function updateSummaryCards() {
    if (!traceA) return;
    const summary = traceA.summary;
    const metrics = summary.metrics || {};
    const consistency = summary.consistency || {};
    const grid = $('reconcile-summary-grid');

    const pIntercepted = summary.status_percentages.INTERCEPTED ?? 0;
    const pMissedListen = summary.status_percentages.MISSED_NOT_LISTENING ?? 0;
    const pMissedDetect = summary.status_percentages.MISSED_NOT_DETECTED ?? 0;
    const pPartial = summary.status_percentages.PARTIAL ?? 0;
    const faCount = traceA.false_alarms ? traceA.false_alarms.length : 0;
    const twIR = metrics.threat_weighted_ir !== undefined ? (metrics.threat_weighted_ir * 100).toFixed(1) : '—';
    const backendIR = metrics.intercept_ratio !== undefined ? (metrics.intercept_ratio * 100).toFixed(1) : '—';

    grid.innerHTML = `
      <div class="reconcile-card intercepted">
        <span class="reconcile-card-label">Intercepted</span>
        <span class="reconcile-card-val">${pIntercepted}%</span>
        <span class="reconcile-card-sub">${summary.status_counts.INTERCEPTED} bursts (100% hits)</span>
      </div>

      <div class="reconcile-card missed-listen">
        <span class="reconcile-card-label">Missed (Not Listening)</span>
        <span class="reconcile-card-val">${pMissedListen}%</span>
        <span class="reconcile-card-sub">${summary.status_counts.MISSED_NOT_LISTENING} bursts (never dwelled)</span>
      </div>

      <div class="reconcile-card missed-detect">
        <span class="reconcile-card-label">Missed (Not Detected)</span>
        <span class="reconcile-card-val">${pMissedDetect}%</span>
        <span class="reconcile-card-sub">${summary.status_counts.MISSED_NOT_DETECTED} bursts (low SNR/Pd)</span>
      </div>

      <div class="reconcile-card partial">
        <span class="reconcile-card-label">Partial Bursts</span>
        <span class="reconcile-card-val">${pPartial}%</span>
        <span class="reconcile-card-sub">${summary.status_counts.PARTIAL} bursts (partial slots)</span>
      </div>

      <div class="reconcile-card fa">
        <span class="reconcile-card-label">False Alarms</span>
        <span class="reconcile-card-val">${faCount}</span>
        <span class="reconcile-card-sub">Pfa = ${metrics.pfa !== undefined ? metrics.pfa.toFixed(4) : '—'}</span>
      </div>

      <div class="reconcile-card tw-ir">
        <span class="reconcile-card-label">Threat-Weighted IR</span>
        <span class="reconcile-card-val">${twIR}%</span>
        <span class="reconcile-card-sub">Backend IR: ${backendIR}%</span>
      </div>
    `;

    // Agreement with compute_metrics check
    const banner = $('reconcile-consistency-banner');
    const diff = consistency.diff_vs_metrics || 0;
    const isAgree = diff <= 0.001;

    banner.className = `reconcile-consistency-banner ${isAgree ? '' : 'warn'}`;
    if (isAgree) {
      banner.innerHTML = `
        <span>✔</span>
        <span><b>Interception ratio verified:</b> Reconciled bursts interception ratio (${(consistency.trace_ir_any * 100).toFixed(1)}%) matches backend <code>compute_metrics</code> exactly.</span>
      `;
    } else {
      banner.innerHTML = `
        <span>⚠️</span>
        <span><b>Interception ratio note:</b> Trace caught ratio is ${(consistency.trace_ir_any * 100).toFixed(1)}% vs compute_metrics ${backendIR}% (diff: ${diff}). ${consistency.definition_note || ''}</span>
      `;
    }

    // Subtitle information
    $('reconcile-subtitle').textContent = `Scenario: ${traceA.meta.scenario} · Scheduler: ${traceA.meta.scheduler} · Seed ${traceA.meta.seed} · ${traceA.meta.n_slots} slots (${(traceA.meta.n_slots * traceA.meta.slot_duration_s).toFixed(1)}s)`;

    // Badges
    $('reconcile-badge-sent').textContent = `${traceA.messages.length} transmitted`;
    $('reconcile-badge-rx-a').textContent = `${summary.status_counts.INTERCEPTED + summary.status_counts.PARTIAL} intercepted`;
  }

  // ---------------------------------------------------------------- Compare Diff Banner
  function updateCompareMode() {
    const diffBanner = $('reconcile-diff-banner');
    const rxBPane = $('reconcile-pane-rx-b');
    const panesGrid = $('reconcile-panes-container');

    if (!isCompare || !traceB) {
      diffBanner.classList.add('hidden');
      rxBPane.classList.add('hidden');
      panesGrid.classList.remove('compare-three');
      return;
    }

    diffBanner.classList.remove('hidden');
    rxBPane.classList.remove('hidden');
    panesGrid.classList.add('compare-three');

    $('reconcile-rx-a-title').textContent = `${traceA.meta.scheduler} Decoded`;
    $('reconcile-rx-b-title').textContent = `${traceB.meta.scheduler} Decoded`;

    const msgs = traceA.messages;
    const oA = traceA.outcomes;
    const oB = traceB.outcomes;

    let caughtA = 0;
    let caughtB = 0;
    let onlyA = 0;
    let onlyB = 0;

    for (let i = 0; i < msgs.length; i++) {
      const hitA = oA[i].status === 'INTERCEPTED' || oA[i].status === 'PARTIAL';
      const hitB = oB[i].status === 'INTERCEPTED' || oB[i].status === 'PARTIAL';

      if (hitA) caughtA++;
      if (hitB) caughtB++;
      if (hitA && !hitB) onlyA++;
      if (hitB && !hitA) onlyB++;
    }

    $('reconcile-badge-rx-b').textContent = `${caughtB} intercepted`;

    const schedA = traceA.meta.scheduler.replace('_', ' ');
    const schedB = traceB.meta.scheduler.replace('_', ' ');
    const netDiff = caughtB - caughtA;

    const headlineElem = $('reconcile-diff-headline');
    const subElem = $('reconcile-diff-sub');

    if (netDiff > 0) {
      headlineElem.innerHTML = `🏆 <span style="color:#38bdf8;">${schedB}</span> caught <b>${netDiff} more messages</b> than <span style="color:#94a3b8;">${schedA}</span>!`;
    } else if (netDiff < 0) {
      headlineElem.innerHTML = `🏆 <span style="color:#38bdf8;">${schedA}</span> caught <b>${Math.abs(netDiff)} more messages</b> than <span style="color:#94a3b8;">${schedB}</span>.`;
    } else {
      headlineElem.innerHTML = `🤝 Both schedulers intercepted the same number of messages (${caughtA}).`;
    }

    subElem.textContent = `${schedB}: ${caughtB} caught (${onlyB} unique) vs ${schedA}: ${caughtA} caught (${onlyA} unique). Click diff tabs on the right to inspect exclusive captures.`;

    $('diff-filter-b').textContent = `Caught by ${schedB} Only (${onlyB})`;
    $('diff-filter-a').textContent = `Caught by ${schedA} Only (${onlyA})`;
  }

  // ---------------------------------------------------------------- Stacked Bar Chart & Table
  function updateChartsAndTables() {
    if (!traceA) return;

    // 1. Populate Band Dropdown Filter options
    const bandSel = $('reconcile-filter-band');
    bandSel.innerHTML = '<option value="ALL">All Bands</option>';
    traceA.bands.forEach((b, idx) => {
      bandSel.add(new Option(`B${idx < 10 ? '0' + idx : idx} · ${b.f_lo_ghz}-${b.f_hi_ghz} GHz`, idx));
    });

    // 2. Populate Emitter Type Dropdown Filter options
    const typeSel = $('reconcile-filter-type');
    typeSel.innerHTML = '<option value="ALL">All Types</option>';
    const distinctTypes = Object.keys(traceA.summary.per_emitter_type || {});
    distinctTypes.forEach((t) => {
      typeSel.add(new Option(t.replace('_', ' '), t));
    });

    // 3. Render Chart.js Stacked Bar Chart
    renderBandStackedChart();

    // 4. Render Emitter Classification Table
    renderEmitterStatsTable();
  }

  function renderBandStackedChart() {
    const canvas = $('reconcile-chart-bands');
    if (!canvas || typeof Chart === 'undefined') return;

    const perBand = traceA.summary.per_band || {};
    const N = traceA.bands.length;

    const labels = traceA.bands.map((b, i) => `B${i < 10 ? '0' + i : i} (${b.f_lo_ghz}-${b.f_hi_ghz}G)`);
    const dataIntercepted = [];
    const dataPartial = [];
    const dataMissedListen = [];
    const dataMissedDetect = [];

    for (let b = 0; b < N; b++) {
      const info = perBand[b] || { intercepted: 0, partial: 0, missed_not_listening: 0, missed_not_detected: 0 };
      dataIntercepted.push(info.intercepted);
      dataPartial.push(info.partial);
      dataMissedListen.push(info.missed_not_listening);
      dataMissedDetect.push(info.missed_not_detected);
    }

    if (bandChartInstance) {
      bandChartInstance.destroy();
    }

    bandChartInstance = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Intercepted (100%)',
            data: dataIntercepted,
            backgroundColor: '#10b981',
            stack: 'Stack 0',
          },
          {
            label: 'Partial',
            data: dataPartial,
            backgroundColor: '#eab308',
            stack: 'Stack 0',
          },
          {
            label: 'Missed (Not Listening)',
            data: dataMissedListen,
            backgroundColor: '#ef4444',
            stack: 'Stack 0',
          },
          {
            label: 'Missed (Not Detected)',
            data: dataMissedDetect,
            backgroundColor: '#f97316',
            stack: 'Stack 0',
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        onClick: (event, elements) => {
          if (elements && elements.length > 0) {
            const bandIdx = elements[0].index;
            activeFilters.band = String(bandIdx);
            $('reconcile-filter-band').value = String(bandIdx);
            renderVirtualizedPanes();
          }
        },
        scales: {
          x: {
            stacked: true,
            ticks: {
              color: '#94a3b8',
              font: { family: '"IBM Plex Mono", monospace', size: 9 },
            },
            grid: { color: 'rgba(51, 65, 85, 0.4)' },
          },
          y: {
            stacked: true,
            ticks: { color: '#94a3b8' },
            grid: { color: 'rgba(51, 65, 85, 0.4)' },
          },
        },
        plugins: {
          legend: {
            labels: { color: '#cbd5e1', boxWidth: 10, font: { size: 11 } },
          },
          tooltip: {
            mode: 'index',
            intersect: false,
          },
        },
      },
    });
  }

  function renderEmitterStatsTable() {
    const tbody = $('reconcile-emitter-tbody');
    if (!tbody || !traceA) return;

    const perType = traceA.summary.per_emitter_type || {};
    const types = Object.keys(perType);

    tbody.innerHTML = types
      .map((t) => {
        const d = perType[t];
        const caught = d.intercepted + d.partial;
        const ratio = d.sent > 0 ? ((caught / d.sent) * 100).toFixed(1) : '0.0';
        const missed = d.missed_not_listening + d.missed_not_detected;

        return `
          <tr>
            <td><b>${t.replace('_', ' ')}</b></td>
            <td>${d.sent}</td>
            <td style="color:#34d399;">${d.intercepted}</td>
            <td style="color:#facc15;">${d.partial}</td>
            <td style="color:#f87171;">${missed}</td>
            <td><b style="color:${parseFloat(ratio) >= 70 ? '#34d399' : '#f87171'}">${ratio}%</b></td>
          </tr>
        `;
      })
      .join('');
  }

  // ---------------------------------------------------------------- Export Functions
  function exportCSV() {
    if (!traceA || !traceA.messages) return;

    const msgs = traceA.messages;
    const outcomes = traceA.outcomes;
    const bands = traceA.bands;

    const headers = [
      'id',
      'emitter_name',
      'type',
      'band',
      'ghz_range',
      'start_slot',
      'end_slot',
      'power_dbm',
      'threat',
      'status',
      'first_hit_slot',
      'n_hit_slots',
      'n_listen_slots',
      'reason',
    ];

    const rows = msgs.map((m, idx) => {
      const o = outcomes[idx];
      const bInfo = bands[m.band];
      const ghz = `${bInfo.f_lo_ghz}-${bInfo.f_hi_ghz} GHz`;
      const emName = getEmitterName(m, traceA);
      const reason = getMessageReason(m, o, traceA);

      return [
        m.id,
        `"${emName.replace(/"/g, '""')}"`,
        m.type,
        m.band,
        `"${ghz}"`,
        m.start_slot,
        m.end_slot,
        m.power_dbm,
        m.threat,
        o.status,
        o.first_hit_slot ?? '',
        o.n_hit_slots,
        o.n_listen_slots,
        `"${reason.replace(/"/g, '""')}"`,
      ].join(',');
    });

    const csvContent = [headers.join(','), ...rows].join('\n');
    downloadBlob(
      csvContent,
      `reconciliation_${traceA.meta.scenario}_${traceA.meta.scheduler}_seed${traceA.meta.seed}.csv`,
      'text/csv;charset=utf-8;'
    );
  }

  function exportJSON() {
    if (!traceA) return;
    const exportData = {
      meta: traceA.meta,
      summary: traceA.summary,
      bands: traceA.bands,
      emitters: traceA.emitters,
      messages: traceA.messages,
      outcomes: traceA.outcomes,
      false_alarms: traceA.false_alarms,
    };
    if (traceB) {
      exportData.compare = {
        meta: traceB.meta,
        summary: traceB.summary,
        outcomes: traceB.outcomes,
      };
    }

    const jsonStr = JSON.stringify(exportData, null, 2);
    downloadBlob(
      jsonStr,
      `reconciliation_${traceA.meta.scenario}_${traceA.meta.scheduler}_seed${traceA.meta.seed}.json`,
      'application/json;charset=utf-8;'
    );
  }

  function downloadBlob(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ---------------------------------------------------------------- Main Render Entry
  function renderReconciliation(newTraceA, newTraceB) {
    if (!newTraceA) return;

    traceA = newTraceA;
    traceB = newTraceB || null;
    isCompare = Boolean(traceB && window.theatre && window.theatre.isCompare());

    ensureReconcileContainer();
    updateSummaryCards();
    updateCompareMode();
    updateChartsAndTables();
    renderVirtualizedPanes();
  }

  // Hook invoked by theatre.js when a run finishes or on user request
  window.onRunFinished = function (finishedTraceA, finishedTraceB) {
    renderReconciliation(finishedTraceA, finishedTraceB);
  };

  // Expose API
  window.reconcile = {
    render: renderReconciliation,
    exportCSV,
    exportJSON,
    setFilter: (key, val) => {
      activeFilters[key] = val;
      renderVirtualizedPanes();
    },
  };
})();
