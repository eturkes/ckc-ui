import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultReportPath = path.join(root, "runs", "m2-one-shot", "report.json");
const defaultOutDir = path.join(root, "figures", "manuscript");
const args = process.argv.slice(2);
const verifyMode = args.includes("--verify");

function argValue(flag, fallback) {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? path.resolve(root, args[index + 1]) : fallback;
}

const reportPath = argValue("--report", defaultReportPath);
const outDir = argValue("--out", defaultOutDir);

const colors = {
  ink: "#111827",
  muted: "#596273",
  faint: "#f5f7fa",
  panel: "#ffffff",
  line: "#c8d0da",
  grid: "#e5e9ef",
  direct: "#b45c37",
  ir: "#1f6f8b",
  det: "#2f6b4f",
  warn: "#8a5b00",
  bad: "#9d3b3b",
  blue: "#355c9a",
  purple: "#6f4b8b",
  gray: "#737982"
};

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, stable(entry)])
    );
  }
  return value;
}

function canonical(value) {
  return JSON.stringify(stable(value));
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256(value) {
  return sha256Bytes(Buffer.from(typeof value === "string" ? value : canonical(value), "utf8"));
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function escapePdfText(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)");
}

function hexToRgb01(hex) {
  const text = String(hex ?? "#000000").replace("#", "");
  const full = text.length === 3 ? text.split("").map((char) => char + char).join("") : text;
  const int = Number.parseInt(full, 16);
  return [
    ((int >> 16) & 255) / 255,
    ((int >> 8) & 255) / 255,
    (int & 255) / 255
  ];
}

function pdfColor(hex, op) {
  const [r, g, b] = hexToRgb01(hex);
  return `${fmt(r)} ${fmt(g)} ${fmt(b)} ${op}`;
}

function fmt(number) {
  return Number(number).toFixed(3).replace(/\.?0+$/, "") || "0";
}

function ratioValue(ratio) {
  if (!ratio || Number(ratio.denominator) === 0) return 0;
  return Number(ratio.numerator) / Number(ratio.denominator);
}

function ratioExact(ratio) {
  return ratio?.exact ?? "0/0";
}

function percentLabel(ratio) {
  return `${Math.round(ratioValue(ratio) * 100)}%`;
}

function textWidth(text, size, family = "sans") {
  const multiplier = family === "mono" ? 0.61 : 0.54;
  return String(text).length * size * multiplier;
}

function wrapText(text, maxWidth, size = 22, family = "sans") {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (textWidth(candidate, size, family) <= maxWidth || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function addText(shapes, text, x, y, options = {}) {
  shapes.push({
    kind: "text",
    text,
    x,
    y,
    size: options.size ?? 22,
    fill: options.fill ?? colors.ink,
    weight: options.weight ?? "normal",
    anchor: options.anchor ?? "start",
    family: options.family ?? "sans"
  });
}

function addWrappedText(shapes, text, x, y, maxWidth, options = {}) {
  const size = options.size ?? 22;
  const lineHeight = options.lineHeight ?? Math.round(size * 1.3);
  const lines = wrapText(text, maxWidth, size, options.family ?? "sans");
  lines.forEach((line, index) => addText(shapes, line, x, y + index * lineHeight, options));
  return lines.length * lineHeight;
}

function addRect(shapes, x, y, w, h, options = {}) {
  shapes.push({
    kind: "rect",
    x,
    y,
    w,
    h,
    rx: options.rx ?? 8,
    fill: options.fill ?? colors.panel,
    stroke: options.stroke ?? colors.line,
    strokeWidth: options.strokeWidth ?? 2
  });
}

function addLine(shapes, x1, y1, x2, y2, options = {}) {
  shapes.push({
    kind: "line",
    x1,
    y1,
    x2,
    y2,
    stroke: options.stroke ?? colors.line,
    strokeWidth: options.strokeWidth ?? 2,
    dash: options.dash ?? null
  });
}

function addArrow(shapes, x1, y1, x2, y2, options = {}) {
  const stroke = options.stroke ?? colors.muted;
  addLine(shapes, x1, y1, x2, y2, { stroke, strokeWidth: options.strokeWidth ?? 2 });
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const size = options.size ?? 12;
  const points = [
    [x2, y2],
    [x2 - size * Math.cos(angle - Math.PI / 6), y2 - size * Math.sin(angle - Math.PI / 6)],
    [x2 - size * Math.cos(angle + Math.PI / 6), y2 - size * Math.sin(angle + Math.PI / 6)]
  ];
  shapes.push({ kind: "poly", points, fill: stroke, stroke: "none" });
}

function addBadge(shapes, label, x, y, options = {}) {
  const size = options.size ?? 16;
  const w = textWidth(label, size, options.family ?? "sans") + 24;
  const h = size + 12;
  addRect(shapes, x, y, w, h, {
    rx: 12,
    fill: options.fill ?? colors.faint,
    stroke: options.stroke ?? colors.line,
    strokeWidth: 1
  });
  addText(shapes, label, x + 12, y + size + 3, {
    size,
    fill: options.textFill ?? colors.ink,
    weight: "bold",
    family: options.family ?? "sans"
  });
  return w;
}

function addNode(shapes, { x, y, w, h, title, lines = [], accent = colors.line, badge = null }) {
  addRect(shapes, x, y, w, h, { fill: colors.panel, stroke: accent, strokeWidth: 3, rx: 8 });
  addText(shapes, title, x + 18, y + 32, { size: 22, weight: "bold" });
  if (badge) addBadge(shapes, badge.label, x + w - badge.w, y + 14, badge);
  let offset = y + 66;
  for (const line of lines) {
    offset += addWrappedText(shapes, line, x + 18, offset, w - 36, {
      size: 17,
      fill: colors.muted,
      lineHeight: 23
    });
  }
}

function addTitle(shapes, title, subtitle, meta = null) {
  addText(shapes, title, 54, 58, { size: 32, weight: "bold" });
  addText(shapes, subtitle, 54, 92, { size: 19, fill: colors.muted });
  if (meta) addText(shapes, meta, 1546, 58, { size: 16, fill: colors.muted, anchor: "end" });
}

function addFootnote(shapes, text, y = 868) {
  addLine(shapes, 54, y - 24, 1546, y - 24, { stroke: colors.grid, strokeWidth: 1 });
  addWrappedText(shapes, text, 54, y, 1492, { size: 15, fill: colors.muted, lineHeight: 20 });
}

function scene(id, title, caption, width, height, shapes) {
  return { id, title, caption, width, height, shapes };
}

function routeMetric(report, routeId) {
  return report.metrics.route_metrics.find((entry) => entry.route_id === routeId);
}

function metricRows(report) {
  const direct = routeMetric(report, "route.direct_smt");
  const ir = routeMetric(report, "route.single_ir");
  return [
    ["Target syntax", direct.target_syntax_validity, ir.target_syntax_validity],
    ["Admission", direct.admission_rate, ir.admission_rate],
    ["Admitted accuracy", direct.admitted_verdict_accuracy, ir.admitted_verdict_accuracy],
    ["Candidate accuracy", direct.candidate_verdict_accuracy, ir.candidate_verdict_accuracy],
    ["Seed stability", direct.k_sample_stability, ir.k_sample_stability]
  ];
}

function buildRouteMechanicsFigure(report) {
  const shapes = [];
  const direct = routeMetric(report, "route.direct_smt");
  const ir = routeMetric(report, "route.single_ir");
  addTitle(
    shapes,
    "Route mechanics and evidence boundaries",
    "M2 compares direct SMT emission with a bounded IR hop over identical fixture groups.",
    `run ${report.run_id}`
  );

  addNode(shapes, {
    x: 70,
    y: 150,
    w: 285,
    h: 170,
    title: "Fixture evidence",
    accent: colors.blue,
    lines: [
      "Groups: conflict, null, holdout conflict.",
      "Gold verdicts and source spans remain fixed."
    ],
    badge: { label: "input", w: 82, fill: "#eef3fb", stroke: "#b8c8e6", textFill: colors.blue }
  });
  addNode(shapes, {
    x: 455,
    y: 150,
    w: 285,
    h: 170,
    title: "Shared cue layer",
    accent: colors.det,
    lines: [
      `${report.source_cue_layer.extractor_id} derives source cues for evaluator grounding.`,
      "The cue layer is experiment scaffolding."
    ],
    badge: { label: "det", w: 74, fill: "#eaf4ee", stroke: "#b9d6c5", textFill: colors.det }
  });
  addArrow(shapes, 355, 235, 455, 235);

  addNode(shapes, {
    x: 845,
    y: 120,
    w: 310,
    h: 190,
    title: "Direct route",
    accent: colors.direct,
    lines: [
      "The model emits one SMT-LIB target.",
      `Target syntax: ${ratioExact(direct.target_syntax_validity)}.`,
      `Admission: ${ratioExact(direct.admission_rate)}.`
    ],
    badge: { label: "LLM", w: 76, fill: "#fff0e8", stroke: "#e5b69d", textFill: colors.direct }
  });
  addNode(shapes, {
    x: 845,
    y: 390,
    w: 310,
    h: 205,
    title: "IR route",
    accent: colors.ir,
    lines: [
      "The model emits bounded pair JSON.",
      "A deterministic bridge constructs route_rule_ir.v0.",
      `Target syntax: ${ratioExact(ir.target_syntax_validity)}.`
    ],
    badge: { label: "LLM + det", w: 118, fill: "#e8f5f8", stroke: "#a9cfda", textFill: colors.ir }
  });
  addArrow(shapes, 740, 235, 845, 212);
  addArrow(shapes, 740, 235, 845, 492);

  addNode(shapes, {
    x: 1260,
    y: 120,
    w: 270,
    h: 190,
    title: "Target checks",
    accent: colors.line,
    lines: [
      "Syntactic target checks and route admission run before accuracy claims.",
      `Admitted accuracy: ${ratioExact(direct.admitted_verdict_accuracy)}.`
    ],
    badge: { label: "gate", w: 78, fill: colors.faint, stroke: colors.line, textFill: colors.muted }
  });
  addNode(shapes, {
    x: 1260,
    y: 390,
    w: 270,
    h: 205,
    title: "Compiler gate",
    accent: colors.det,
    lines: [
      "Complete IR rows compile to SMT-LIB and are scored by the same evaluator.",
      `Admission: ${ratioExact(ir.admission_rate)}.`
    ],
    badge: { label: "det", w: 74, fill: "#eaf4ee", stroke: "#b9d6c5", textFill: colors.det }
  });
  addArrow(shapes, 1155, 212, 1260, 212);
  addArrow(shapes, 1155, 492, 1260, 492);

  addRect(shapes, 70, 665, 1460, 110, { fill: "#fbfcfd", stroke: colors.grid, strokeWidth: 2, rx: 8 });
  addText(shapes, "Current R3 result", 96, 705, { size: 22, weight: "bold" });
  addWrappedText(
    shapes,
    `The run shows a target-syntax lift (${ratioExact(direct.target_syntax_validity)} -> ${ratioExact(ir.target_syntax_validity)}) but no admitted lift: both routes have ${ratioExact(ir.admission_rate)} admission and ${ratioExact(ir.admitted_verdict_accuracy)} admitted verdict accuracy. Candidate verdict accuracy for single_ir is ${ratioExact(ir.candidate_verdict_accuracy)} and remains rejected evidence.`,
    96,
    735,
    1370,
    { size: 18, fill: colors.ink, lineHeight: 25 }
  );
  addFootnote(
    shapes,
    `Scope: ${report.wording_scope}; ${report.m2_evaluation.evaluation_strength}. This figure makes no clinical, patient-care, deployment, or regulatory claim.`
  );
  return scene(
    "fig01_route_mechanics",
    "Route mechanics and evidence boundaries",
    "M2 route mechanics. Both routes consume the same fixture groups and are scored by the same evaluator; the current run shows target-syntax lift only, not admitted verdict lift.",
    1600,
    900,
    shapes
  );
}

function buildRouteMetricsFigure(report) {
  const shapes = [];
  addTitle(
    shapes,
    "M2 route metrics",
    "Exact-ratio measurements over three groups and three seeds per route.",
    "n = 9 rows per route"
  );
  const rows = metricRows(report);
  const chart = { x: 120, y: 170, w: 1180, h: 520 };
  for (let tick = 0; tick <= 4; tick += 1) {
    const value = tick / 4;
    const y = chart.y + chart.h - value * chart.h;
    addLine(shapes, chart.x, y, chart.x + chart.w, y, { stroke: colors.grid, strokeWidth: 1 });
    addText(shapes, `${Math.round(value * 100)}%`, chart.x - 18, y + 6, {
      size: 15,
      fill: colors.muted,
      anchor: "end"
    });
  }
  addLine(shapes, chart.x, chart.y, chart.x, chart.y + chart.h, { stroke: colors.line, strokeWidth: 2 });
  addLine(shapes, chart.x, chart.y + chart.h, chart.x + chart.w, chart.y + chart.h, { stroke: colors.line, strokeWidth: 2 });
  const groupW = chart.w / rows.length;
  const barW = 54;
  rows.forEach(([label, directRatio, irRatio], index) => {
    const center = chart.x + groupW * index + groupW / 2;
    const directH = ratioValue(directRatio) * chart.h;
    const irH = ratioValue(irRatio) * chart.h;
    const directX = center - barW - 7;
    const irX = center + 7;
    addRect(shapes, directX, chart.y + chart.h - directH, barW, directH, {
      fill: colors.direct,
      stroke: colors.direct,
      strokeWidth: 1,
      rx: 3
    });
    addRect(shapes, irX, chart.y + chart.h - irH, barW, irH, {
      fill: colors.ir,
      stroke: colors.ir,
      strokeWidth: 1,
      rx: 3
    });
    addText(shapes, ratioExact(directRatio), directX + barW / 2, chart.y + chart.h - directH - 10, {
      size: 15,
      fill: colors.direct,
      anchor: "middle",
      weight: "bold"
    });
    addText(shapes, ratioExact(irRatio), irX + barW / 2, chart.y + chart.h - irH - 10, {
      size: 15,
      fill: colors.ir,
      anchor: "middle",
      weight: "bold"
    });
    addWrappedText(shapes, label, center - 78, chart.y + chart.h + 34, 156, {
      size: 16,
      fill: colors.ink,
      anchor: "middle",
      lineHeight: 20
    });
  });
  addBadge(shapes, "direct_smt", 1360, 180, { fill: "#fff0e8", stroke: "#e5b69d", textFill: colors.direct, size: 17 });
  addBadge(shapes, "single_ir", 1360, 222, { fill: "#e8f5f8", stroke: "#a9cfda", textFill: colors.ir, size: 17 });
  addRect(shapes, 1340, 300, 205, 300, { fill: "#fbfcfd", stroke: colors.grid, strokeWidth: 2, rx: 8 });
  addText(shapes, "Interpretation", 1360, 338, { size: 21, weight: "bold" });
  addWrappedText(
    shapes,
    "The IR route preserves machine-readable target syntax, but grounding checks reject all rows in this run. Candidate accuracy is shown only for rejected outputs.",
    1360,
    372,
    160,
    { size: 16, fill: colors.muted, lineHeight: 22 }
  );
  addFootnote(
    shapes,
    `Evaluator: ${report.m2_evaluation.evaluator_id}. Metric labels use exact numerator/denominator values from report.json.`
  );
  return scene(
    "fig02_route_metrics",
    "M2 route metrics",
    "Route metrics from the current M2 run. Single-IR reaches 9/9 target syntax and 3/9 candidate verdict accuracy, but admission and admitted verdict accuracy remain 0/9.",
    1600,
    900,
    shapes
  );
}

function buildFailureTaxonomyFigure(report) {
  const shapes = [];
  addTitle(
    shapes,
    "Failure taxonomy by route",
    "Diagnostic categories are non-exclusive row hits over nine route rows.",
    "row-category hits"
  );
  const counts = report.route_evaluation.route_category_counts;
  const categories = [
    ["syntax", colors.direct],
    ["grounding", colors.ir],
    ["unsupported_schema", colors.warn],
    ["wrong_verdict", colors.bad],
    ["process", colors.gray]
  ];
  const chart = { x: 150, y: 170, w: 1120, h: 520 };
  for (let tick = 0; tick <= 3; tick += 1) {
    const value = tick * 3;
    const y = chart.y + chart.h - (value / 9) * chart.h;
    addLine(shapes, chart.x, y, chart.x + chart.w, y, { stroke: colors.grid, strokeWidth: 1 });
    addText(shapes, String(value), chart.x - 18, y + 6, { size: 15, fill: colors.muted, anchor: "end" });
  }
  addText(shapes, "row hits", chart.x - 86, chart.y - 20, { size: 16, fill: colors.muted });
  addLine(shapes, chart.x, chart.y, chart.x, chart.y + chart.h, { stroke: colors.line, strokeWidth: 2 });
  addLine(shapes, chart.x, chart.y + chart.h, chart.x + chart.w, chart.y + chart.h, { stroke: colors.line, strokeWidth: 2 });
  const groupW = chart.w / categories.length;
  const barW = 54;
  categories.forEach(([category, color], index) => {
    const center = chart.x + groupW * index + groupW / 2;
    const directCount = counts["route.direct_smt"][category] ?? 0;
    const irCount = counts["route.single_ir"][category] ?? 0;
    const directH = (directCount / 9) * chart.h;
    const irH = (irCount / 9) * chart.h;
    const directX = center - barW - 7;
    const irX = center + 7;
    addRect(shapes, directX, chart.y + chart.h - directH, barW, directH, {
      fill: colors.direct,
      stroke: colors.direct,
      strokeWidth: 1,
      rx: 3
    });
    addRect(shapes, irX, chart.y + chart.h - irH, barW, irH, {
      fill: colors.ir,
      stroke: colors.ir,
      strokeWidth: 1,
      rx: 3
    });
    addText(shapes, `${directCount}/9`, directX + barW / 2, chart.y + chart.h - directH - 10, {
      size: 15,
      fill: colors.direct,
      anchor: "middle",
      weight: "bold"
    });
    addText(shapes, `${irCount}/9`, irX + barW / 2, chart.y + chart.h - irH - 10, {
      size: 15,
      fill: colors.ir,
      anchor: "middle",
      weight: "bold"
    });
    addWrappedText(shapes, category.replace("_", " "), center - 86, chart.y + chart.h + 34, 172, {
      size: 16,
      fill: colors.ink,
      anchor: "middle",
      lineHeight: 20
    });
  });
  addBadge(shapes, "direct_smt", 1330, 178, { fill: "#fff0e8", stroke: "#e5b69d", textFill: colors.direct, size: 17 });
  addBadge(shapes, "single_ir", 1330, 220, { fill: "#e8f5f8", stroke: "#a9cfda", textFill: colors.ir, size: 17 });
  addRect(shapes, 1310, 300, 230, 238, { fill: "#fbfcfd", stroke: colors.grid, strokeWidth: 2, rx: 8 });
  addText(shapes, "Residual audit", 1330, 338, { size: 21, weight: "bold" });
  addWrappedText(
    shapes,
    `Direct SMT: ${ratioExact(report.direct_smt_audit.missing_named_assertion_rate)} rows lacked named assertions; exact template matches ${ratioExact(report.direct_smt_audit.exact_template_match_rate)}.`,
    1330,
    372,
    180,
    { size: 16, fill: colors.muted, lineHeight: 22 }
  );
  addFootnote(
    shapes,
    "Counts come from route_evaluation.route_category_counts. Categories can co-occur in one row, so columns are diagnostic burden rather than a partition of samples."
  );
  return scene(
    "fig03_failure_taxonomy",
    "Failure taxonomy by route",
    "Diagnostic row-category hits show direct SMT failing mainly at target syntax, while single-IR produces syntactic targets that are rejected by grounding and wrong-verdict checks.",
    1600,
    900,
    shapes
  );
}

function buildRealSourceFigure(report) {
  const shapes = [];
  const intake = report.real_guideline_intake;
  addTitle(
    shapes,
    "Real guideline intake scope",
    "Public-source rows are candidate-only artifacts outside locked M1/M2 scoring.",
    "no clinical claim"
  );
  const cards = [
    ["Sources", intake.source_count, colors.blue],
    ["Candidate spans", intake.candidate_span_count, colors.ir],
    ["Candidate rules", intake.admitted_candidate_rule_count, colors.det],
    ["Rejected spans", intake.rejected_candidate_span_count, colors.direct],
    ["Residuals", intake.residual_count, colors.warn],
    ["Blocking residuals", intake.blocking_residual_count, colors.bad]
  ];
  cards.forEach(([label, value, color], index) => {
    const x = 70 + index * 246;
    addRect(shapes, x, 150, 210, 130, { fill: colors.panel, stroke: color, strokeWidth: 3, rx: 8 });
    addText(shapes, String(value), x + 24, 210, { size: 42, weight: "bold", fill: color });
    addWrappedText(shapes, label, x + 24, 244, 160, { size: 18, fill: colors.ink, lineHeight: 22 });
  });

  const flowY = 390;
  addNode(shapes, {
    x: 130,
    y: flowY,
    w: 260,
    h: 155,
    title: "Registry",
    accent: colors.blue,
    lines: [
      `${intake.source_count} public source records.`,
      "Source and permission hashes are retained."
    ]
  });
  addNode(shapes, {
    x: 520,
    y: flowY,
    w: 260,
    h: 155,
    title: "Candidate spans",
    accent: colors.ir,
    lines: [
      `${intake.candidate_span_count} quoted candidate regions.`,
      "Machine hints seed provisional rows."
    ]
  });
  addNode(shapes, {
    x: 910,
    y: flowY,
    w: 260,
    h: 155,
    title: "Candidate IR",
    accent: colors.det,
    lines: [
      `${intake.admitted_candidate_rule_count} candidate route-rule rows.`,
      "Rows are not solver-score evidence."
    ]
  });
  addNode(shapes, {
    x: 1300,
    y: flowY,
    w: 230,
    h: 155,
    title: "Gate",
    accent: colors.bad,
    lines: [
      `${intake.blocking_residual_count} blocking residuals.`,
      `Scope: ${intake.clinical_claim_scope}.`
    ]
  });
  addArrow(shapes, 390, flowY + 78, 520, flowY + 78);
  addArrow(shapes, 780, flowY + 78, 910, flowY + 78);
  addArrow(shapes, 1170, flowY + 78, 1300, flowY + 78);

  const tableX = 135;
  const tableY = 640;
  addRect(shapes, tableX, tableY, 1330, 130, { fill: "#fbfcfd", stroke: colors.grid, strokeWidth: 2, rx: 8 });
  addText(shapes, "Per-source candidate coverage", tableX + 24, tableY + 38, { size: 22, weight: "bold" });
  const headers = ["source", "spans", "rules", "rejected", "raw cache"];
  const colX = [tableX + 24, tableX + 790, tableX + 930, tableX + 1070, tableX + 1210];
  headers.forEach((header, index) => addText(shapes, header, colX[index], tableY + 70, {
    size: 15,
    fill: colors.muted,
    weight: "bold"
  }));
  intake.sources.forEach((source, index) => {
    const y = tableY + 98 + index * 28;
    addText(shapes, source.id, colX[0], y, { size: 14, family: "mono", fill: colors.ink });
    addText(shapes, String(source.candidate_span_count), colX[1], y, { size: 16, fill: colors.ink });
    addText(shapes, String(source.admitted_candidate_rule_count), colX[2], y, { size: 16, fill: colors.ink });
    addText(shapes, String(source.rejected_residual_count), colX[3], y, { size: 16, fill: colors.ink });
    addText(shapes, source.raw_cache_status, colX[4], y, { size: 16, fill: colors.ink });
  });
  addFootnote(
    shapes,
    `Scoring scope: ${intake.scoring_scope}. These rows are source-intake candidate evidence only and are excluded from M1/M2 route metrics.`
  );
  return scene(
    "fig04_real_source_intake",
    "Real guideline intake scope",
    "Real Japanese guideline sources are represented as candidate-only source-intake artifacts with source and permission hashes, but they remain outside locked M1/M2 scoring and carry no clinical claim.",
    1600,
    900,
    shapes
  );
}

function renderSvg(figure) {
  const body = figure.shapes.map((shape) => {
    if (shape.kind === "rect") {
      return `<rect x="${fmt(shape.x)}" y="${fmt(shape.y)}" width="${fmt(shape.w)}" height="${fmt(shape.h)}" rx="${fmt(shape.rx ?? 0)}" fill="${escapeXml(shape.fill)}" stroke="${escapeXml(shape.stroke ?? "none")}" stroke-width="${fmt(shape.strokeWidth ?? 0)}"/>`;
    }
    if (shape.kind === "line") {
      const dash = shape.dash ? ` stroke-dasharray="${escapeXml(shape.dash)}"` : "";
      return `<line x1="${fmt(shape.x1)}" y1="${fmt(shape.y1)}" x2="${fmt(shape.x2)}" y2="${fmt(shape.y2)}" stroke="${escapeXml(shape.stroke)}" stroke-width="${fmt(shape.strokeWidth ?? 1)}"${dash}/>`;
    }
    if (shape.kind === "poly") {
      const points = shape.points.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(" ");
      return `<polygon points="${points}" fill="${escapeXml(shape.fill ?? "none")}" stroke="${escapeXml(shape.stroke ?? "none")}"/>`;
    }
    if (shape.kind === "text") {
      const weight = shape.weight === "bold" ? "700" : "400";
      const family = shape.family === "mono"
        ? "SFMono-Regular, Consolas, Liberation Mono, monospace"
        : "Arial, Helvetica, sans-serif";
      return `<text x="${fmt(shape.x)}" y="${fmt(shape.y)}" font-family="${escapeXml(family)}" font-size="${fmt(shape.size)}" font-weight="${weight}" fill="${escapeXml(shape.fill)}" text-anchor="${shape.anchor ?? "start"}">${escapeXml(shape.text)}</text>`;
    }
    throw new Error(`unknown svg shape: ${shape.kind}`);
  }).join("\n  ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${figure.width}" height="${figure.height}" viewBox="0 0 ${figure.width} ${figure.height}" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(figure.title)}</title>
  <desc id="desc">${escapeXml(figure.caption)}</desc>
  <rect width="${figure.width}" height="${figure.height}" fill="#ffffff"/>
  ${body}
</svg>
`;
}

function renderPdf(figure) {
  const content = [];
  function y(value) {
    return figure.height - value;
  }
  for (const shape of figure.shapes) {
    if (shape.kind === "rect") {
      const fill = shape.fill && shape.fill !== "none";
      const stroke = shape.stroke && shape.stroke !== "none" && (shape.strokeWidth ?? 0) > 0;
      if (!fill && !stroke) continue;
      if (fill) content.push(pdfColor(shape.fill, "rg"));
      if (stroke) {
        content.push(pdfColor(shape.stroke, "RG"));
        content.push(`${fmt(shape.strokeWidth ?? 1)} w`);
      }
      content.push(`${fmt(shape.x)} ${fmt(y(shape.y + shape.h))} ${fmt(shape.w)} ${fmt(shape.h)} re`);
      content.push(fill && stroke ? "B" : fill ? "f" : "S");
      continue;
    }
    if (shape.kind === "line") {
      content.push(pdfColor(shape.stroke, "RG"));
      content.push(`${fmt(shape.strokeWidth ?? 1)} w`);
      if (shape.dash) content.push(`[${shape.dash.split(/[,\s]+/).filter(Boolean).map(fmt).join(" ")}] 0 d`);
      content.push(`${fmt(shape.x1)} ${fmt(y(shape.y1))} m ${fmt(shape.x2)} ${fmt(y(shape.y2))} l S`);
      if (shape.dash) content.push("[] 0 d");
      continue;
    }
    if (shape.kind === "poly") {
      if (!shape.points.length) continue;
      content.push(pdfColor(shape.fill ?? shape.stroke ?? colors.ink, "rg"));
      content.push(pdfColor(shape.stroke ?? shape.fill ?? colors.ink, "RG"));
      const [[firstX, firstY], ...rest] = shape.points;
      content.push(`${fmt(firstX)} ${fmt(y(firstY))} m`);
      for (const [px, py] of rest) content.push(`${fmt(px)} ${fmt(y(py))} l`);
      content.push("h f");
      continue;
    }
    if (shape.kind === "text") {
      const font = shape.family === "mono" ? "/F3" : shape.weight === "bold" ? "/F2" : "/F1";
      const size = shape.size;
      let x = shape.x;
      if (shape.anchor === "middle") x -= textWidth(shape.text, size, shape.family) / 2;
      if (shape.anchor === "end") x -= textWidth(shape.text, size, shape.family);
      content.push(pdfColor(shape.fill, "rg"));
      content.push(`BT ${font} ${fmt(size)} Tf ${fmt(x)} ${fmt(y(shape.y))} Td (${escapePdfText(shape.text)}) Tj ET`);
      continue;
    }
    throw new Error(`unknown pdf shape: ${shape.kind}`);
  }
  const stream = `${content.join("\n")}\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${figure.width} ${figure.height}] /Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>"
  ];
  let pdf = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "binary"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, "binary");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "binary");
}

function latexEscape(value) {
  return String(value)
    .replaceAll("\\", "\\textbackslash{}")
    .replaceAll("&", "\\&")
    .replaceAll("%", "\\%")
    .replaceAll("$", "\\$")
    .replaceAll("#", "\\#")
    .replaceAll("_", "\\_")
    .replaceAll("{", "\\{")
    .replaceAll("}", "\\}")
    .replaceAll("~", "\\textasciitilde{}")
    .replaceAll("^", "\\textasciicircum{}");
}

function figureTex(figures) {
  return `% Generated by tools/build-figures.mjs from runs/m2-one-shot/report.json.
% Include with \\input{figures/manuscript/figures.tex} or copy individual figure blocks.

${figures.map((figure) => `\\begin{figure}[t]
  \\centering
  \\includegraphics[width=\\linewidth]{figures/manuscript/${figure.id}.pdf}
  \\caption{${latexEscape(figure.caption)}}
  \\label{fig:${figure.id.replace(/^fig[0-9]+_/, "").replaceAll("_", "-")}}
\\end{figure}`).join("\n\n")}
`;
}

function captionsMarkdown(figures, report, reportHash) {
  return `# Manuscript Figures

Generated by \`tools/build-figures.mjs\` from \`${path.relative(root, reportPath)}\`.

- Source report hash: \`${reportHash}\`
- Run: \`${report.run_id}\`
- Scope: \`${report.wording_scope}\`
- Evaluation strength: \`${report.m2_evaluation.evaluation_strength}\`
- Clinical claim scope: \`${report.real_guideline_intake.clinical_claim_scope}\`

ArXiv note: the PDF exports are the manuscript-ready targets for PDFLaTeX. arXiv requires figures to already be in a compatible format and does not perform figure conversion during submission: <https://info.arxiv.org/help/submit_tex.html>.

${figures.map((figure, index) => `## Figure ${index + 1}: ${figure.title}

Files: \`${figure.id}.svg\`, \`${figure.id}.pdf\`

${figure.caption}`).join("\n\n")}
`;
}

function manifestJson(figures, reportHash) {
  return {
    artifact_kind: "ManuscriptFigureManifest",
    schema_version: "manuscript_figures.v0",
    generated_by: "tools/build-figures.mjs",
    source_report_path: path.relative(root, reportPath),
    source_report_hash: reportHash,
    output_dir: path.relative(root, outDir),
    figure_count: figures.length,
    figures: figures.map((figure) => ({
      figure_id: figure.id,
      title: figure.title,
      caption: figure.caption,
      svg_path: `${figure.id}.svg`,
      pdf_path: `${figure.id}.pdf`,
      svg_hash: sha256(renderSvg(figure)),
      pdf_export: "deterministic_pdf_writer_v0"
    }))
  };
}

async function writeStableJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(stable(value), null, 2)}\n`);
}

async function main() {
  if (!existsSync(reportPath)) {
    throw new Error(`report not found: ${path.relative(root, reportPath)}`);
  }
  const reportText = await readFile(reportPath, "utf8");
  const report = JSON.parse(reportText);
  const reportHash = sha256Bytes(Buffer.from(reportText, "utf8"));
  const figures = [
    buildRouteMechanicsFigure(report),
    buildRouteMetricsFigure(report),
    buildFailureTaxonomyFigure(report),
    buildRealSourceFigure(report)
  ];

  await mkdir(outDir, { recursive: true });
  for (const figure of figures) {
    const svg = renderSvg(figure);
    const pdf = renderPdf(figure);
    await writeFile(path.join(outDir, `${figure.id}.svg`), svg);
    await writeFile(path.join(outDir, `${figure.id}.pdf`), pdf);
  }
  await writeFile(path.join(outDir, "figures.tex"), figureTex(figures));
  await writeFile(path.join(outDir, "README.md"), captionsMarkdown(figures, report, reportHash));
  await writeStableJson(path.join(outDir, "manifest.json"), manifestJson(figures, reportHash));

  if (verifyMode) {
    for (const figure of figures) {
      const svgPath = path.join(outDir, `${figure.id}.svg`);
      const pdfPath = path.join(outDir, `${figure.id}.pdf`);
      const svg = await readFile(svgPath, "utf8");
      const pdf = await readFile(pdfPath);
      if (!svg.includes("<svg") || !svg.includes(escapeXml(figure.title))) {
        throw new Error(`invalid svg export: ${path.relative(root, svgPath)}`);
      }
      if (!pdf.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
        throw new Error(`invalid pdf export: ${path.relative(root, pdfPath)}`);
      }
    }
  }

  const relOut = path.relative(root, outDir);
  console.log(JSON.stringify({
    output_dir: relOut,
    figure_count: figures.length,
    source_report_hash: reportHash,
    verify: verifyMode ? "ok" : "not_requested"
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
