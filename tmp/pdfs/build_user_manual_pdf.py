from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    Image as RLImage, KeepTogether, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle,
)


ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "output" / "pdf" / "smart_scan_user_manual.pdf"
OUT.parent.mkdir(parents=True, exist_ok=True)

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name="ManualTitle", parent=styles["Title"], fontName="Helvetica-Bold", fontSize=24, leading=29,
                          textColor=colors.HexColor("#173d73"), alignment=TA_CENTER, spaceAfter=7))
styles.add(ParagraphStyle(name="ManualSub", parent=styles["Normal"], fontName="Helvetica", fontSize=10.5, leading=14,
                          textColor=colors.HexColor("#5d6c82"), alignment=TA_CENTER, spaceAfter=17))
styles.add(ParagraphStyle(name="H1Manual", parent=styles["Heading1"], fontName="Helvetica-Bold", fontSize=15, leading=19,
                          textColor=colors.HexColor("#173d73"), spaceBefore=11, spaceAfter=7))
styles.add(ParagraphStyle(name="H2Manual", parent=styles["Heading2"], fontName="Helvetica-Bold", fontSize=11, leading=14,
                          textColor=colors.HexColor("#155e8b"), spaceBefore=7, spaceAfter=4))
styles.add(ParagraphStyle(name="BodyManual", parent=styles["BodyText"], fontName="Helvetica", fontSize=9, leading=13,
                          spaceAfter=4))
styles.add(ParagraphStyle(name="SmallManual", parent=styles["BodyText"], fontName="Helvetica", fontSize=7.6, leading=10,
                          spaceAfter=1))
styles.add(ParagraphStyle(name="CodeManual", parent=styles["Code"], fontName="Courier", fontSize=8, leading=11,
                          backColor=colors.HexColor("#eef2f7"), borderColor=colors.HexColor("#cbd5e1"), borderWidth=.4,
                          borderPadding=6, spaceBefore=3, spaceAfter=6))


def p(text, style="BodyManual"):
    return Paragraph(text, styles[style])


def bullets(items):
    return Paragraph("<br/>".join("&bull; " + x for x in items), styles["BodyManual"])


def table(rows, widths):
    data = [[p(x, "SmallManual") for x in rows[0]]]
    data += [[p(x, "SmallManual") for x in row] for row in rows[1:]]
    t = Table(data, colWidths=widths, repeatRows=1, hAlign="LEFT")
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#173d73")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("GRID", (0, 0), (-1, -1), .25, colors.HexColor("#cbd5e1")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f8fafc")]),
    ]))
    return t


def callout(text):
    t = Table([[p(text, "BodyManual")]], colWidths=[170 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#e0f2fe")),
        ("BOX", (0, 0), (-1, -1), .7, colors.HexColor("#0284c7")),
        ("LEFTPADDING", (0, 0), (-1, -1), 9), ("RIGHTPADDING", (0, 0), (-1, -1), 9),
        ("TOPPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    return t


def figure(path, caption, max_width=170 * mm, max_height=100 * mm):
    image = RLImage(str(path))
    image._restrictSize(max_width, max_height)
    return KeepTogether([image, Spacer(1, 2 * mm), Paragraph("<b>Figure:</b> " + caption, styles["SmallManual"]), Spacer(1, 5 * mm)])


def footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(colors.HexColor("#cbd5e1"))
    canvas.line(20 * mm, 14 * mm, 190 * mm, 14 * mm)
    canvas.setFont("Helvetica", 7.5)
    canvas.setFillColor(colors.HexColor("#5d6c82"))
    canvas.drawString(20 * mm, 9 * mm, "Smart Scan - ML-based ES Receiver Scheduler | User Manual")
    canvas.drawRightString(190 * mm, 9 * mm, f"Page {doc.page}")
    canvas.restoreState()


story = [Spacer(1, 25 * mm), p("SMART SCAN", "ManualTitle"), p("ML-based Electronic Support Receiver Scheduler - User Manual", "ManualSub")]
story += [callout("<b>Purpose:</b> Smart Scan is a simulation-based Electronic Support (ES) receiver scheduler. It compares scan strategies when a receiver can listen to one frequency band per 10 ms dwell while radar and communications emitters are active across a wider spectrum."), Spacer(1, 10 * mm)]
story += [p("What this software helps you do", "H1Manual")]
story.append(bullets([
    "Compare conventional and adaptive scan schedulers under the same simulated RF environment.",
    "Observe receiver dwell decisions, burst detections, and missed transmissions.",
    "Analyse periodic-radar lock-out and choose an improved revisit period.",
    "Review benchmark, ML-training, reconciliation, snapshot, and print-to-PDF outputs.",
]))
story += [p("Scope notice", "H2Manual"), callout("The software models simulated RF truth, emitters, receiver detections, and scheduling. It is not connected to live RF, SDR, or ES receiver hardware."), PageBreak()]

story += [p("1. Start the software", "H1Manual"), p("Open PowerShell in the <b>EW_SIH-</b> folder and run:"),
         p("py -m pip install -r requirements.txt<br/>py run_server.py", "CodeManual"),
         p("Open <b>http://127.0.0.1:8000</b> in a browser. GRU and DQN options require the trained files in the models folder. If a model is missing, open-loop and model-based schedulers remain usable."),
         p("2. Core terms", "H1Manual")]
terms = [
    ["Term", "Meaning"],
    ["Band B00-B15", "One 1 GHz part of the 2-18 GHz simulated spectrum."],
    ["Slot / dwell", "One 10 ms receiver tuning decision."],
    ["Burst", "A contiguous simulated transmission by one emitter in one band."],
    ["Hit", "The receiver was on the burst band and its detector fired in at least one slot."],
    ["Burst Interception Ratio (Any Hit)", "(Full-burst captures + partial interceptions) / transmitted bursts. This is the primary detection measure."],
    ["Full-burst capture", "Every active slot in a burst was detected; a stricter measure than Any Hit."],
    ["Partial interception", "One or more, but not every, active burst slot was detected."],
    ["Missed - not listening", "The receiver never tuned to the burst band while it was active."],
    ["Missed - not detected", "The receiver tuned correctly, but no detector hit occurred, for example at low SNR."],
]
story += [table(terms, [52 * mm, 118 * mm]), Spacer(1, 5 * mm), p("3. Navigation and view modes", "H1Manual"),
          p("The six workspaces are Live Scan, 2D/3D Projections, Charts, Benchmark, Periodic Intercept, and Training. Simple view gives a plain-language operational explanation; Detailed view exposes engineering controls, charts, and tables. Live Scan has its switch in the navigation bar. Charts, Benchmark, Periodic Intercept, and Training have their own page-level view switch.")]
story.append(PageBreak())

story += [p("4. Live Scan", "H1Manual"), p("Select a scenario, a seed, Receiver A, and Receiver B. For a fair comparison, hold scenario and seed constant: both schedulers then face the same emissions and pre-drawn detection outcomes."),
          p("Recommended first comparison", "H2Manual"),
          bullets(["Receiver A: <b>Round-robin sweep</b>.", "Receiver B: <b>Smart scan: RL (DQN)</b>.", "Scenario: <b>air_defence</b>; Seed: <b>1</b>."]),
          p("Simple view", "H2Manual"), p("Click Run simulation and use Play, Restart, the time slider, and Speed. Green slots represent receiver detections; grey slots indicate no detection."),
          p("Detailed Live Intercept Theatre", "H2Manual"), p("Set theatre Receiver A, optional Receiver B, scenario, seed, and Compare Schedulers. Click Run Theater. Use play/pause, one-slot steps, scrubber, playback speed, and Reveal future bursts."),
          p("How to read the theatre", "H2Manual")]
theatre = [
    ["Panel", "Meaning"],
    ["Network view", "The centre is the ES receiver; surrounding circles are bands. The highlighted band is the current dwell."],
    ["Visiting pattern", "Shows the chosen band over time. A regular staircase is round-robin; irregular jumps are adaptive selection."],
    ["Dwell distribution", "Shows how often each band was selected."],
    ["Time-frequency strip", "Vertical position is band, horizontal position is time, and the cyan line is receiver dwell. Green outlines are catches; dashed red outlines are misses."],
]
story += [table(theatre, [46 * mm, 124 * mm]), Spacer(1, 6 * mm), p("5. Reconciliation: transmitted versus decoded", "H1Manual"),
          p("Select Show reconciliation from the theatre. The left pane contains the full transmitted ground truth. Receiver panes show what each scheduler decoded. Filter by status, band, emitter type, text, or missed-only; compare mode also shows bursts captured by only one receiver.")]
story.append(PageBreak())

story += [p("Reconciliation metrics", "H2Manual"),
          bullets([
              "<b>Burst Interception Ratio (Any Hit)</b> is the primary result: a burst counts when at least one slot was detected.",
              "<b>Partial Interception</b> is a burst detected in some but not all active slots.",
              "<b>Missed (Not Listening)</b> identifies scheduling/tuning misses.",
              "<b>Missed (Not Detected)</b> identifies detection/SNR misses after correct tuning.",
              "<b>Threat-Weighted IR</b> gives greater importance to higher-threat emitters.",
          ]),
          p("Example", "H2Manual"), callout("[PARTIAL 1/5] DATALINK#00 B00 means a datalink burst transmitted for five slots (50 ms) in B00 and the receiver detected it in one slot (10 ms)."),
          p("Band chart and emitter table", "H2Manual"), p("The Interception Distribution by Band graph displays partial interceptions and missed categories. It intentionally omits the strict full-burst-capture series to focus on scheduling outcomes. The emitter table shows Sent, Partial, Missed, and Burst IR (Any Hit). Full-burst capture remains in the status filter and individual burst detail."),
          p("6. Charts", "H1Manual"),
          bullets(["Enemy transmissions caught over time compares cumulative catches with total enemy transmissions.", "Share of each emitter's transmissions caught shows per-emitter capture percentage.", "Figures of merit reports Pd, Pfa, sensitivity, intercept rate, raw and threat-weighted interception ratio, discovery, intercept time, information age, reward, prediction accuracy, and intercept-time prediction error."]),
          p("Run the scenario to the desired endpoint before interpreting these values; a partial replay reports only the played portion."),
          p("7. Benchmark", "H1Manual"), p("Benchmark reads saved results from reports/benchmark.json. In Detailed view, choose a test set and a metric, then inspect the scheduler bar chart, gain over round-robin, and all-metrics table. Lower is better for Pfa, intercept time, information age, and intercept-time prediction error."),
          p("To regenerate saved benchmark data: ", "BodyManual"), p("py evaluate.py", "CodeManual")]
story.append(PageBreak())

story += [p("8. Periodic Intercept", "H1Manual"), p("This page studies a rotating radar that illuminates the receiver only for a short beam dwell. Set the emitter scan period (Ts), beam dwell (tau-s), receiver dwell (tau-r), and minimum revisit period, then click Compute optimal revisit."),
          p("Detailed view shows mean/worst-case intercept time, lock-out probability, the recommended revisit choice, and model-versus-Monte-Carlo validation."),
          callout("<b>Lock-out:</b> a fixed receiver revisit rhythm can repeatedly fall between the radar illumination windows. A revised revisit period shifts the timing so a look eventually overlaps the beam."),
          p("9. Training", "H1Manual"), p("The Training page reads history from the saved GRU and DQN model files. Decreasing GRU train/validation loss indicates improved activity prediction; balanced accuracy helps prevent silent bands from dominating the result. DQN validation reward and interception ratio should improve as its dwell policy improves."),
          p("To retrain:", "BodyManual"), p("py train.py predictor<br/>py train.py rl", "CodeManual"),
          p("10. Snapshot and PDF report", "H1Manual"), p("In the detailed theatre playbar, Snapshot downloads a PNG of the current theatre state. Report PDF opens the browser print dialog; choose Save as PDF to keep the report. The report contains the scorecard, emitter classification, band/dwell allocation, and a Live Intercept Theatre Snapshot generated from the same current canvas as the Snapshot button."),
          p("11. Scheduler selection guide", "H1Manual")]
sched = [
    ["Scheduler", "Recommended use"],
    ["Round-robin sweep", "Conventional baseline with equal fixed coverage across all bands."],
    ["Randomised sweep", "Baseline that disrupts periodic timing lock-out."],
    ["Random dwell", "Simple stochastic comparison baseline."],
    ["Thompson bandit", "Hit-rate learner that can over-focus on busy bands."],
    ["Model-based smart scan", "Interpretable closed-loop fallback when learned models are unavailable."],
    ["GRU predictor", "Uses predicted activity from hit/miss history."],
    ["RL (DQN)", "Learns a reward-based dwell policy with coverage protection."],
]
story += [table(sched, [52 * mm, 118 * mm])]
story.append(PageBreak())

story += [p("12. Recommended demonstration workflow", "H1Manual")]
steps = [
    "Open Live Scan and select Detailed view.",
    "Set Receiver A to Round-robin sweep, Receiver B to Smart scan: RL (DQN), scenario to air_defence, and seed to 1.",
    "Enable Compare Schedulers and click Run Theater.",
    "Play to the end or scrub to a meaningful burst event.",
    "Open Show reconciliation and compare Burst IR (Any Hit), partial interceptions, and missed-not-listening counts.",
    "Use the band chart and emitter table to find where adaptive dwell selection improves results.",
    "Use Snapshot for a visual record and Report PDF to create a print report.",
]
story += [Paragraph(f"{i + 1}. {item}", styles["BodyManual"]) for i, item in enumerate(steps)]
story += [p("13. Troubleshooting", "H1Manual")]
trouble = [
    ["Issue", "Action"],
    ["Older chart/table label is visible", "Press Ctrl + F5 once to reload current static assets."],
    ["GRU or DQN unavailable", "Train it, or confirm models/predictor.pt and models/dqn.pt exist."],
    ["Benchmark unavailable", "Run py evaluate.py to create reports/benchmark.json."],
    ["Training says not trained", "Run the relevant py train.py command."],
    ["Report has no theatre image", "Run the theatre, wait for it to render, then choose Report PDF."],
    ["Partial versus full capture", "Partial is one or more, but not all, slots. It still contributes to Burst IR (Any Hit)."],
]
story += [table(trouble, [55 * mm, 115 * mm]), p("14. Safe interpretation", "H1Manual"),
          callout("Use Smart Scan to compare algorithms under controlled simulated conditions. Do not treat one seed, one theatre replay, or a single displayed result as an operational claim. Use held-out scenarios, multiple seeds, saved benchmarks, and hardware-in-the-loop validation before deployment decisions.")]

story += [PageBreak(), p("Appendix A. Visual reference guide", "H1Manual"),
          p("These project figures provide visual examples of the principal screens and analyses described in this manual. Use the captions to connect each figure to the relevant dashboard workflow.")]
story += [figure(ROOT / "explanation.png", "Live scan interpretation graphic. It illustrates the relationship between the band-versus-time environment, the receiver dwell decision, a detection, and a missed transmission.")]
story += [figure(ROOT / "reports" / "benchmark.png", "Benchmark comparison. Use this type of figure to compare scheduler performance across the saved evaluation set; higher bars are better except for metrics explicitly marked as lower-is-better.")]
story += [PageBreak(), p("Appendix B. Periodic and learning visual references", "H1Manual")]
story += [figure(ROOT / "reports" / "periodic_intercept.png", "Periodic-intercept analysis. The figure illustrates how receiver revisit timing changes intercept opportunity and helps identify lock-out risk.")]
story += [figure(ROOT / "reports" / "training_predictor.png", "GRU predictor training history. Falling training and validation loss generally indicates improving activity prediction; use the validation trace to watch for overfitting.")]
story += [figure(ROOT / "reports" / "training_dqn.png", "DQN scheduler training history. Review validation reward and interception-ratio trends before relying on a saved RL policy.")]

doc = SimpleDocTemplate(str(OUT), pagesize=A4, leftMargin=20 * mm, rightMargin=20 * mm, topMargin=17 * mm, bottomMargin=20 * mm,
                        title="Smart Scan User Manual", author="Smart Scan")
doc.build(story, onFirstPage=footer, onLaterPages=footer)
print(OUT)
