# Smart Scan - User Manual

## 1. Purpose and scope

Smart Scan is a **simulation-based Electronic Support (ES) receiver scheduler**. It compares scan strategies when a receiver can listen to only one frequency band at each 10 ms dwell, while multiple radar and communications emitters may be active across a wider spectrum.

Use it to:

- compare conventional and smart scan schedulers under the same RF scenario;
- observe how a receiver's selected band affects detection and missed bursts;
- inspect burst-level outcomes and emitter performance;
- study periodic-radar lock-out and revisit-period selection;
- review saved benchmark and ML-training results; and
- export a theatre snapshot or a print-to-PDF evaluation report.

> **Important:** The application models simulated RF truth, emitters, and receiver detections. It is not connected to live RF/SDR hardware.

## 2. Start the software

From the `EW_SIH-` directory:

```powershell
py -m pip install -r requirements.txt
py run_server.py
```

Open `http://127.0.0.1:8000` in a browser.

The learned GRU and DQN options need their model files in `models/`. If a trained model is unavailable, the dashboard marks that scheduler as unavailable; open-loop and model-based methods can still be used.

## 3. Core concepts

| Term | Meaning |
|---|---|
| **Band B00-B15** | One 1 GHz portion of the 2-18 GHz simulated spectrum. |
| **Slot / dwell** | One 10 ms receiver tuning decision. |
| **Burst** | A contiguous simulated transmission by one emitter in one band. |
| **Hit** | The receiver was on the burst's band and its detector fired during at least one slot. |
| **Burst Interception Ratio (Any Hit)** | `(full-burst captures + partial interceptions) / transmitted bursts`. This is the main detection/interception measure. |
| **Full-burst capture** | Every slot of a burst was detected. This is stricter than the main any-hit metric. |
| **Partial interception** | One or more, but not every, transmission slot was detected. |
| **Missed - not listening** | The receiver never tuned to that burst's band while it was active. |
| **Missed - not detected** | The receiver tuned to the correct band but no detector hit occurred, for example because of low SNR. |

## 4. Navigation and view modes

The top navigation provides six workspaces:

1. **Live scan** - run and replay an RF scenario.
2. **2D/3D Projections** - inspect time-frequency and signal-power visualisations.
3. **Charts** - view cumulative catches, per-emitter catches, and full figures of merit.
4. **Benchmark** - compare schedulers across saved evaluation sets.
5. **Periodic intercept** - analyse periodic radar scan timing and lock-out.
6. **Training** - inspect GRU and DQN learning histories.

### Simple and Detailed views

- **Simple view** presents a plain-language explanation and the main operational takeaway.
- **Detailed view** reveals technical controls, charts, tables, and engineering metrics.

Live Scan has its switch in the navigation bar. Charts, Benchmark, Periodic Intercept, and Training each have their own page-level **Simple view / Detailed view** switch at the top of that workspace. The selected view is remembered for the current browser session.

## 5. Live Scan

### 5.1 Select a fair comparison

Choose:

- **Scenario**: a predefined scenario such as `air_defence`, `agile_threat`, `dense_comms`, or `popup_threats`; or a random laydown when available.
- **Noise seed / Seed**: controls the repeatable simulated noise/detection outcome.
- **Receiver A**: normally use `Round-robin sweep` as the conventional baseline.
- **Receiver B**: choose a smart method, such as Model-based, GRU predictor, or RL (DQN).

For a fair A/B comparison, keep the same scenario and seed. Both schedulers then face the same emissions and pre-drawn detector outcomes.

### 5.2 Simple view

Click **Run simulation**, then use Play, Restart, the time slider, and Speed. The simple view reports how many enemy transmissions each receiver has caught so far. A green slot means the receiver detected a transmission; a grey slot means no detection.

### 5.3 Detailed Live Intercept Theatre

In Detailed view, choose the theatre scenario, seed, Receiver A, and optionally enable **Compare Schedulers** for Receiver B. Click **Run Theater**.

Use the theatre controls to:

- play/pause the replay;
- step backward or forward by one 10 ms slot;
- scrub to an exact slot;
- adjust replay speed;
- toggle future burst visibility; and
- open **Show reconciliation** after or during a run.

#### How to read the theatre

- **Network view**: the central node is the ES receiver and the surrounding circles are bands. The highlighted band is the current dwell.
- **Visiting pattern and dwell distribution**: shows which band is selected over time and how receiver attention was distributed across bands. A regular staircase indicates round-robin scanning; an irregular path indicates adaptive selection.
- **Time-frequency strip**: vertical position is band, horizontal position is time, and the cyan line is the receiver dwell path. Green outlines indicate caught burst activity; dashed red outlines indicate missed activity.

## 6. Reconciliation: transmitted versus decoded

Open **Show reconciliation** in the theatre to compare RF ground truth with each receiver's decoded burst stream.

### Summary cards

- **Burst Interception Ratio (Any Hit)** is the primary outcome. It counts every burst for which at least one transmission slot was detected.
- **Partial Interception** shows bursts hit in some but not all active slots.
- **Missed (Not Listening)** identifies scheduling/tuning misses.
- **Missed (Not Detected)** identifies detector/SNR misses after the receiver tuned correctly.
- **False Alarms** shows detector hits when no truth transmission was present.
- **Threat-Weighted IR** gives more importance to higher-threat emitters.

### Lists and filters

The left pane is the full transmitted ground truth. The receiver panes show what each scheduler decoded. Use Status, Band, Emitter, text search, and the "Show only missed" option to narrow the list. In compare mode, use the tabs to view bursts caught only by one scheduler.

`[PARTIAL 1/5] DATALINK#00 B00` means the burst lasted five slots (50 ms) in B00 and the receiver detected it in one slot (10 ms).

### Band chart and emitter table

The **Interception Distribution by Band** graph shows partial interceptions and the two missed categories. It intentionally does **not** plot the strict full-burst-capture series, to keep focus on the main scheduling outcomes.

The **Performance by Emitter Classification** table shows Sent, Partial, Missed, and **Burst IR (Any Hit)**. Strict full-burst capture remains available as a filter and in individual burst details but is not a table column.

## 7. Charts

Open **Charts** after running a simulation.

- **Enemy transmissions caught over time** compares cumulative catches by receiver with total enemy transmissions.
- **Share of each emitter's transmissions caught** shows per-emitter capture percentage.
- **Figures of merit** reports Pd, Pfa, sensitivity, intercept rate, raw and threat-weighted interception ratio, emitter discovery, intercept time, information age, reward, prediction accuracy, and intercept-time prediction error.

Interpret charts only after the simulation reaches the desired endpoint. A partial run reports values only for the played portion of the scenario.

## 8. Benchmark

The Benchmark page reads saved results from `reports/benchmark.json`.

In Detailed view:

1. Select the **Test set**: unseen random scenarios or a named preset.
2. Select a **Metric**.
3. Inspect the scheduler comparison bar chart, gain over round-robin, and all-metrics table.

For metrics marked "lower is better," smaller values are preferred: mean intercept time, information age, false-alarm rate, and intercept-time prediction error.

Benchmark data is precomputed. To refresh it after changing models or scenarios, run:

```powershell
py evaluate.py
```

## 9. Periodic Intercept

This page analyses a rotating/scanning radar that illuminates the receiver only during a short beam dwell.

Set:

- **Emitter scan period (Ts)**: time between radar beam returns.
- **Beam dwell (tau-s)**: how long the radar illuminates the receiver per scan.
- **Receiver dwell (tau-r)**: receiver look duration.
- **Min revisit**: shortest receiver revisit period considered.

Click **Compute optimal revisit**.

Detailed view shows mean and worst-case intercept time, lock-out probability, an optimal revisit choice, and model-versus-Monte-Carlo validation.

**Lock-out** occurs when a fixed receiver revisit rhythm repeatedly falls between the radar's illumination windows. The recommended revisit period changes the relative timing so that receiver looks eventually overlap the beam.

## 10. Training

The Training page reads history stored in the saved GRU and DQN model files.

- **GRU activity predictor**: decreasing train/validation loss indicates better activity prediction; balanced accuracy is included to avoid misleading results from mostly silent bands.
- **DQN scheduler**: validation reward and interception ratio should improve as the policy learns better dwell choices.

To retrain:

```powershell
py train.py predictor
py train.py rl
```

Training can take time on CPU. Reopen or refresh the Training page when it completes.

## 11. Snapshot and PDF report

In the detailed theatre playbar:

- **Snapshot** downloads a PNG of the current theatre display and current slot.
- **Report PDF** opens the browser print dialog. Choose **Save as PDF** to save the report.

The PDF includes the evaluation scorecard, emitter classification, band/dwell allocation, and a **Live Intercept Theatre Snapshot**. The snapshot in the PDF is generated from the same current theatre canvas used by the Snapshot button. The old tactical sample-log section is not included.

## 12. Scheduler selection guide

| Scheduler | Recommended use |
|---|---|
| Round-robin sweep | Conventional baseline; equal, fixed coverage of all bands. |
| Randomised sweep | Baseline that disrupts fixed timing lock-out. |
| Random dwell | Simple stochastic comparison baseline. |
| Thompson bandit | Demonstrates hit-rate-focused learning; may over-focus on busy bands. |
| Model-based smart scan | Interpretable closed-loop method; a strong fallback when learned models are unavailable. |
| GRU predictor | Uses predicted band activity from hit/miss history. |
| RL (DQN) | Learns a reward-based dwell policy with coverage protection. |

## 13. Recommended demonstration workflow

1. Open **Live scan** and choose **Detailed view**.
2. Set Receiver A to `Round-robin sweep`, Receiver B to `Smart scan: RL (DQN)`, scenario to `air_defence`, and seed to `1`.
3. Enable Compare Schedulers and click **Run Theater**.
4. Play to the end or scrub to a key burst.
5. Open **Show reconciliation** and compare Burst IR (Any Hit), partial interceptions, and missed-not-listening counts.
6. Use the band chart and emitter table to identify where the adaptive scheduler improves coverage.
7. Click **Snapshot** for a visual record and **Report PDF** to save a print report.

## 14. Troubleshooting

| Issue | Action |
|---|---|
| Page shows an older chart/table label after an update | Refresh with `Ctrl + F5` once to reload the latest static scripts. |
| GRU or DQN is unavailable | Train the model or confirm `models/predictor.pt` and `models/dqn.pt` exist. |
| Benchmark is unavailable | Run `py evaluate.py` to create the report JSON. |
| Training page says not trained | Run the applicable `py train.py` command. |
| Report contains no theatre image | Run the theatre first, wait for it to render, then click Report PDF. |
| A partial burst seems different from a full capture | Partial means one or more, but not all, slots were detected; it still contributes to Burst IR (Any Hit). |

## 15. Safe interpretation of results

Use the software to compare algorithms under controlled simulated conditions. Do not treat a single run, one seed, or a visual theatre result as an operational performance claim. Use held-out scenarios, multiple seeds, saved benchmark results, and hardware-in-the-loop validation before making deployment decisions.
