from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak,
    KeepTogether,
)


ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "output" / "pdf" / "smart_scan_requirements_audit.pdf"
OUT.parent.mkdir(parents=True, exist_ok=True)

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(
    name="AuditTitle", parent=styles["Title"], fontName="Helvetica-Bold",
    fontSize=22, leading=27, textColor=colors.HexColor("#123047"), alignment=TA_CENTER,
    spaceAfter=12,
))
styles.add(ParagraphStyle(
    name="AuditSub", parent=styles["Normal"], fontName="Helvetica", fontSize=10,
    leading=14, textColor=colors.HexColor("#536575"), alignment=TA_CENTER, spaceAfter=18,
))
styles.add(ParagraphStyle(
    name="H1A", parent=styles["Heading1"], fontName="Helvetica-Bold", fontSize=15,
    leading=19, textColor=colors.HexColor("#123047"), spaceBefore=8, spaceAfter=8,
))
styles.add(ParagraphStyle(
    name="H2A", parent=styles["Heading2"], fontName="Helvetica-Bold", fontSize=11,
    leading=14, textColor=colors.HexColor("#1F5874"), spaceBefore=7, spaceAfter=4,
))
styles.add(ParagraphStyle(
    name="BodyA", parent=styles["BodyText"], fontName="Helvetica", fontSize=9,
    leading=13, spaceAfter=5,
))
styles.add(ParagraphStyle(
    name="SmallA", parent=styles["BodyText"], fontName="Helvetica", fontSize=7.5,
    leading=10, spaceAfter=2,
))
styles.add(ParagraphStyle(
    name="Callout", parent=styles["BodyText"], fontName="Helvetica-Bold", fontSize=10,
    leading=14, textColor=colors.HexColor("#123047"), spaceAfter=0,
))


def p(text, style="BodyA"):
    return Paragraph(text, styles[style])


def status_cell(status):
    palette = {
        "Implemented": ("#DDF2E3", "#1B6B39"),
        "Partial": ("#FFF0C9", "#7A5300"),
        "Missing": ("#F8DDDD", "#8A2525"),
    }
    bg, fg = palette[status]
    return Paragraph(f'<font color="{fg}"><b>{status}</b></font>', styles["SmallA"]), colors.HexColor(bg)


def audit_table(rows, widths=(47 * mm, 27 * mm, 96 * mm)):
    data = [[p("Requirement", "SmallA"), p("Status", "SmallA"), p("Audit evidence / gap", "SmallA")]]
    bgs = []
    for i, (requirement, status, evidence) in enumerate(rows, start=1):
        cell, bg = status_cell(status)
        data.append([p(requirement, "SmallA"), cell, p(evidence, "SmallA")])
        bgs.append(("BACKGROUND", (1, i), (1, i), bg))
    table = Table(data, colWidths=widths, repeatRows=1, hAlign="LEFT")
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#123047")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#B9C7D1")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ] + bgs))
    return table


def bullet(text):
    return Paragraph("&bull; " + text, styles["BodyA"])


def footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(colors.HexColor("#B9C7D1"))
    canvas.line(20 * mm, 14 * mm, 190 * mm, 14 * mm)
    canvas.setFont("Helvetica", 7.5)
    canvas.setFillColor(colors.HexColor("#536575"))
    canvas.drawString(20 * mm, 9 * mm, "Smart Scan requirements audit | Software evidence review | 04 Oct 2026")
    canvas.drawRightString(190 * mm, 9 * mm, f"Page {doc.page}")
    canvas.restoreState()


story = []
story += [
    Spacer(1, 28 * mm),
    p("SMART SCAN STRATEGY", "AuditTitle"),
    p("Requirements compliance assessment and implementation roadmap", "AuditSub"),
    Spacer(1, 5 * mm),
]
callout = Table([[p("VERDICT: The application is a strong simulation and ML scheduling prototype that addresses most core software requirements. It is not yet a field-ready Electronic Support receiver scheduler because it has no live RF/SDR integration, operational data-validation pipeline, or sufficient reproducible test evidence.", "Callout")]], colWidths=[165 * mm])
callout.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#E2F0F6")),
    ("BOX", (0, 0), (-1, -1), 0.8, colors.HexColor("#1F5874")),
    ("LEFTPADDING", (0, 0), (-1, -1), 10), ("RIGHTPADDING", (0, 0), (-1, -1), 10),
    ("TOPPADDING", (0, 0), (-1, -1), 10), ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
]))
story += [callout, Spacer(1, 12 * mm)]
story += [p("Scope and evidence reviewed", "H1A")]
story += [bullet("Source and design documents in EW_SIH-/: README, TECHNICAL_REPORT, METHODOLOGIES, IMPLEMENTATION_PLAN, reports, Python engine, FastAPI service, dashboard, saved models, and test file."),
          bullet("This is a source-and-artifact audit, not an independent RF trial or safety certification."),
          bullet("Repository evidence shows saved benchmark results generated 03 Oct 2026. The current reports use only two unseen random scenarios, despite older documentation claiming 30; this inconsistency is a validation gap."),
          Spacer(1, 8 * mm),
          p("Status key", "H2A"),
          p("Implemented = present in source and supported by recorded artifacts. Partial = present in a simulation/prototype form but incomplete for the stated outcome. Missing = not evidenced in the application.", "BodyA")]
story.append(PageBreak())

story += [p("1. Requirement-by-requirement assessment", "H1A")]
rows = [
    ("Wide-spectrum scan with narrower instantaneous bandwidth", "Implemented", "ReceiverConfig models 2-18 GHz as 16 bands with 1 GHz instantaneous bandwidth and 10 ms dwell; schedulers choose one band per dwell."),
    ("No reliable prior emitter intelligence", "Partial", "Randomized scenario generation and online hit/miss learning reduce dependence on a fixed EOB. However, models are trained/evaluated only on synthetic, known-generator distributions; there is no live unknown-signal ingestion or drift handling."),
    ("Truth per band and time slot", "Implemented", "RFEnvironment precomputes activity, strongest emitter, received power, Pd, and deterministic detection outcomes for every band/slot."),
    ("Spatially scanning and frequency-agile emitters", "Implemented", "ScanningRadar, TrackingRadar, AgileRadar, communications emitters and beacon classes are modeled; scanning visibility is represented as temporal beam illumination."),
    ("Receiver system model", "Implemented", "Noise floor, free-space received power, SNR, energy detector threshold, Pd, Pfa, sensitivity, dwell, and bands are implemented."),
    ("Figures of merit", "Implemented", "Metrics compute Pd, Pfa, sensitivity, hit/intercept rates, raw/threat-weighted interception ratio, discovery, information age, reward, prediction accuracy, and intercept-time error."),
    ("ML scheduler minimizing intercept time and maximizing interception", "Implemented", "A GRU predictor scheduler and Double-DQN scheduler exist alongside model-based and open-loop baselines. DQN includes a coverage safety shield."),
    ("Training from hits and misses", "Partial", "Online observations feed tracker/predictor features and DQN rewards. Offline training labels and signal outcomes still originate from simulator truth; no labelled/unlabelled real receiver data workflow is supplied."),
    ("Predict interception time and interception ratio", "Implemented", "Exact phase-lattice periodic model and agile analytic model predict intercept time, interception ratio and lock-out; validation report compares them to simulation."),
    ("Optimal periodic scan interception", "Implemented", "gcd lock-out analysis, optimal_revisit / robust_revisit, and acquisition/tracking phases in ModelBasedScheduler are implemented."),
    ("Deliverable scheduler software", "Implemented", "Python package, trained model artifacts, FastAPI endpoints, browser dashboard, trace/reconciliation UI and demo assets are present."),
]
story += [audit_table(rows), Spacer(1, 7 * mm), p("Important interpretation", "H2A"),
          p("The system meets the expected solution as a research/simulation software package. It does not demonstrate deployment on an actual ES receiver, nor prove performance against classified or measured RF data. Those are material requirements for operational acceptance, even if they were not explicit in the original problem statement.", "BodyA")]
story.append(PageBreak())

story += [p("2. What has been implemented", "H1A")]
implemented = [
    ("Simulation foundation", "16-band RF environment; signal power/noise/detection model; temporal ground truth; comparable pre-drawn detection outcomes across schedulers."),
    ("Threat behavior", "Rotating/scanning radar, continuous tracking radar, cyclic/random frequency agility, bursty communications, beacons, pop-up start times, threat weights and randomized laydowns."),
    ("Adaptive decision layer", "Round-robin/random baselines, Thompson bandit, interpretable model-based acquisition/tracking scheduler, GRU activity predictor, and Double-DQN with replay/target network."),
    ("Periodic-scan reasoning", "Exact phase-lattice analysis identifies harmonic lock-out; revisit-period optimization supplies a principled alternative to a fixed sweep."),
    ("Evaluation and presentation", "Benchmark JSON/plots, theory-validation report, API endpoints, live trace/reconciliation dashboard and offline demo trace."),
]
t = Table([[p("Area", "SmallA"), p("Implemented evidence", "SmallA")]] + [[p(a, "SmallA"), p(b, "SmallA")] for a,b in implemented], colWidths=[45*mm,125*mm], repeatRows=1)
t.setStyle(TableStyle([
    ("BACKGROUND", (0,0), (-1,0), colors.HexColor("#123047")), ("TEXTCOLOR", (0,0), (-1,0), colors.white),
    ("GRID", (0,0), (-1,-1), .25, colors.HexColor("#B9C7D1")), ("VALIGN", (0,0), (-1,-1), "TOP"),
    ("LEFTPADDING", (0,0), (-1,-1), 5), ("RIGHTPADDING", (0,0), (-1,-1), 5), ("TOPPADDING", (0,0), (-1,-1), 5), ("BOTTOMPADDING", (0,0), (-1,-1), 5),
]))
story += [t, Spacer(1, 8*mm), p("Saved benchmark evidence", "H2A"),
          p("The latest saved results (n=2 unseen random scenarios) report GRU intercept ratio 0.437 and DQN 0.380, versus round-robin 0.264. They also report theory-vs-simulation mean absolute intercept-time error of 8.7 slots (12.8%) and interception-ratio error of 0.007. Treat these as preliminary: n=2 is not enough for confidence bounds or a robust operational claim.", "BodyA"),
          p("The README and technical report cite different, more favorable 30-scenario figures. The report must be regenerated and versioned before using any performance headline in a proposal or demonstration.", "BodyA")]
story.append(PageBreak())

story += [p("3. What still needs to be implemented", "H1A")]
gaps = [
    ("Live RF acquisition interface", "Missing", "Add SDR/receiver adapter for IQ or detector observations, timestamp discipline, tuning-control command interface, calibration, and safe fallback to deterministic sweep."),
    ("Real signal processing chain", "Missing", "Add channelization/energy detection from sampled IQ, pulse/burst extraction, emitter deinterleaving/classification, confidence estimates, and handling of overlapping/co-channel signals."),
    ("Spatial measurement model", "Partial", "Current 'spatial scan' is a time-visibility model. Add angle-of-arrival/DF, platform motion, antenna pattern, geometry, multipath/terrain and track association if spatial claims are required."),
    ("Operationally robust learning", "Partial", "Implement online-safe adaptation, uncertainty/OOD detection, model versioning, drift alarms, conservative policy fallback, and adversarial/jamming robustness."),
    ("Verification and reproducibility", "Partial", "Provide locked dependency environment, automated tests/CI, deterministic seeds, dataset manifests, run scripts, confidence intervals and ablation studies. Current test execution was blocked here because the supplied runtime lacks pytest/httpx."),
    ("Benchmark integrity", "Missing", "Regenerate one authoritative report with a declared train/test split, >=30-100 held-out seeds, mean/standard deviation/CI, and no conflicting numbers across README, report and dashboard."),
    ("Hardware-in-the-loop acceptance", "Missing", "Test tune latency, dwell timing, false-alarm performance, sensitivity, CPU timing, dropped frames and recovery using SDR/FPGA or receiver-in-loop equipment."),
    ("Multi-receiver / multi-IBW scale", "Missing", "Generalize scheduler action space from one receiver/one band to several receivers, different IBWs, cooperative coverage and resource constraints."),
]
story += [audit_table(gaps), Spacer(1, 7*mm), p("Priority distinction", "H2A"),
          p("Items above are not cosmetic enhancements. Live observation integration, signal processing, validation, and hardware-in-the-loop testing are the minimum bridge between a credible simulator and a deployable ES scheduling capability.", "BodyA")]
story.append(PageBreak())

story += [p("4. Recommended implementation roadmap", "H1A")]
roadmap = [
    ("0 - Baseline control", "1-2 weeks", "Freeze code/model versions; create one reproducible environment; repair/install test dependencies; run and archive unit/API tests; regenerate a single benchmark report with 30+ held-out seeds and CIs.", "A trustworthy baseline and evidence pack."),
    ("1 - Receiver data contract", "2-4 weeks", "Define an adapter API for IQ/detector data, tune commands, timestamps, calibration metadata and truth/annotation capture. Replay recorded data through the current scheduler before controlling hardware.", "Offline replay against real recordings."),
    ("2 - RF processing and tracking", "4-8 weeks", "Implement detection/channelization, pulse/burst descriptors, interference flags, emitter clustering/deinterleaving, track confidence and unknown-class handling.", "Reliable observations replacing simulator truth."),
    ("3 - Safe adaptive scheduler", "3-6 weeks", "Add uncertainty-aware policy selection, calibrated reward/threat policy, online adaptation guardrails, drift/OOD detection, audit logs and fixed-sweep fallback.", "Safe closed-loop recommendations."),
    ("4 - HIL and field validation", "6-12 weeks", "Connect SDR/FPGA; characterize tuning/detection latencies; evaluate across fading, jamming, pop-up and agile scenarios; quantify Pd/Pfa and intercept gains with confidence intervals.", "Evidence for operational transition."),
]
rt = Table([[p("Phase", "SmallA"), p("Indicative effort", "SmallA"), p("Work", "SmallA"), p("Exit criterion", "SmallA")]] + [[p(a,"SmallA"),p(b,"SmallA"),p(c,"SmallA"),p(d,"SmallA")] for a,b,c,d in roadmap], colWidths=[27*mm,28*mm,78*mm,37*mm], repeatRows=1)
rt.setStyle(TableStyle([
    ("BACKGROUND", (0,0), (-1,0), colors.HexColor("#123047")), ("TEXTCOLOR", (0,0), (-1,0), colors.white),
    ("GRID", (0,0), (-1,-1), .25, colors.HexColor("#B9C7D1")), ("VALIGN", (0,0), (-1,-1), "TOP"),
    ("LEFTPADDING", (0,0), (-1,-1), 4), ("RIGHTPADDING", (0,0), (-1,-1), 4), ("TOPPADDING", (0,0), (-1,-1), 5), ("BOTTOMPADDING", (0,0), (-1,-1), 5),
]))
story += [rt, Spacer(1, 7*mm), p("Implementation order", "H2A"),
          p("Do Phase 0 before asserting performance claims. Complete the replay-based integration in Phase 1 before letting ML choose live tuner actions. Introduce control authority only after Phase 2 and Phase 3 safety gates are passed.", "BodyA")]
story.append(PageBreak())

story += [p("5. Final answer", "H1A"),
          p("Yes - your application fulfills the main academic/software aspects of the stated problem: it simulates the scanning environment, has a receiver model and required metrics, models scanning/agile emitters, learns from hit/miss observations, supplies GRU and DQN schedulers, and includes an optimal periodic-intercept approach.", "BodyA"),
          p("But it fulfills them as a validated-in-simulation prototype, not as a fully operational Electronic Support receiver scheduler. The decisive remaining work is integration with real receiver/SDR data, a production signal-processing and emitter-tracking chain, safety/uncertainty controls, rigorous reproducible benchmark evidence, and HIL testing.", "BodyA"),
          Spacer(1, 5*mm), p("Immediate next three actions", "H2A"),
          bullet("Regenerate and reconcile all benchmark reports from one command and one held-out evaluation protocol; remove the conflicting n=2 versus n=30 claims."),
          bullet("Define and implement a replay-first SDR/receiver adapter so the existing scheduler sees real timestamped observations without yet controlling hardware."),
          bullet("Build a small HIL test campaign with timing, sensitivity, Pd/Pfa, jitter, agile-hop and periodic-scan acceptance criteria."),
          Spacer(1, 8*mm), p("Audit limitations", "H2A"),
          p("The code was inspected and the report artifacts were reviewed. Automated tests were not run successfully in this environment because the supplied Python runtime has no pytest or httpx. No live transmitter, SDR, receiver hardware or measured RF data was available to inspect.", "BodyA")]

doc = SimpleDocTemplate(str(OUT), pagesize=A4, rightMargin=20*mm, leftMargin=20*mm, topMargin=17*mm, bottomMargin=20*mm, title="Smart Scan Requirements Audit")
doc.build(story, onFirstPage=footer, onLaterPages=footer)
print(OUT)
