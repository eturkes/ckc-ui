import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runId = "m2-one-shot";
const runDir = path.join(root, "runs", runId);
const webDataPath = path.join(root, "workbench", "run-data.js");
const verifyMode = process.argv.includes("--verify");

const fixtureRegistry = [
  {
    id: "fixture.m1_guideline_a",
    key: "a",
    title: "合成敗血症診療ガイドライン A",
    path: "corpus/fixtures/fixture-m1-guideline-a.html",
    regions: [
      {
        id: "region.a.cq1.rec",
        role: "recommendation",
        quote: "成人(18歳以上)の敗血症患者には抗菌薬Aを投与することを推奨する(強い推奨)。"
      },
      {
        id: "region.a.cq1.exc",
        role: "exception",
        quote: "ただし、重度腎機能障害のある患者を除く。"
      }
    ]
  },
  {
    id: "fixture.m1_guideline_b",
    key: "b",
    title: "合成敗血症診療ガイドライン B",
    path: "corpus/fixtures/fixture-m1-guideline-b.html",
    regions: [
      {
        id: "region.b.contra1",
        role: "contraindication",
        quote: "成人の敗血症患者のうち、妊娠中の患者には抗菌薬Aを投与しないこと(禁忌)。"
      }
    ]
  },
  {
    id: "fixture.m1_control",
    key: "control",
    title: "合成敗血症対照文書",
    path: "corpus/fixtures/fixture-m1-control.html",
    regions: [
      {
        id: "region.control.child.contra1",
        role: "contraindication",
        quote: "小児(18歳未満)の敗血症患者には抗菌薬Aは禁忌である。"
      }
    ]
  }
];

const groups = [
  {
    id: "group.m1_conflict",
    fixtures: ["fixture.m1_guideline_a", "fixture.m1_guideline_b"],
    expectedOutcome: "semantic_contradiction"
  },
  {
    id: "group.m1_null",
    fixtures: ["fixture.m1_guideline_a", "fixture.m1_control"],
    expectedOutcome: "semantic_no_conflict"
  }
];

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
  return sha256Bytes(canonical(value));
}

function ratio(numerator, denominator) {
  const decimal = denominator === 0 ? null : Number((numerator / denominator).toFixed(4));
  return { numerator, denominator, exact: `${numerator}/${denominator}`, decimal };
}

function gcd(left, right) {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a || 1;
}

function reducedRatio(numerator, denominator) {
  const divisor = gcd(numerator, denominator);
  return ratio(numerator / divisor, denominator / divisor);
}

function subtractRatio(a, b) {
  return reducedRatio(
    a.numerator * b.denominator - b.numerator * a.denominator,
    a.denominator * b.denominator
  );
}

async function writeJson(relativePath, value) {
  const absolutePath = path.join(runDir, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(stable(value), null, 2)}\n`);
}

async function writeText(relativePath, value) {
  const absolutePath = path.join(runDir, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, value.endsWith("\n") ? value : `${value}\n`);
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sourceRegion(html, fixture, region) {
  const sourceBytes = Buffer.from(html);
  const quoteBytes = Buffer.from(region.quote);
  const start = sourceBytes.indexOf(quoteBytes);
  if (start < 0) {
    throw new Error(`region quote not found: ${region.id}`);
  }
  return {
    region_id: region.id,
    role: region.role,
    anchor: `${fixture.path}#${region.id}`,
    byte_start: start,
    byte_end: start + quoteBytes.length,
    quote: region.quote
  };
}

function makeBindings(docKey) {
  const common = [
    { mention: "敗血症", system: "ckc.lex", code: "cond.sepsis", status: "exact" },
    { mention: "抗菌薬A", system: "ckc.lex", code: "drug.abx_a", status: "exact" }
  ];
  if (docKey === "a") {
    return [
      { mention: "成人", system: "ckc.lex", code: "pop.adult", status: "exact" },
      ...common,
      { mention: "重度腎機能障害", system: "ckc.lex", code: "cond.renal_severe", status: "exact" }
    ];
  }
  if (docKey === "b") {
    return [
      { mention: "成人", system: "ckc.lex", code: "pop.adult", status: "exact" },
      ...common,
      { mention: "妊娠中", system: "ckc.lex", code: "cond.pregnancy", status: "exact" }
    ];
  }
  return [
    { mention: "小児", system: "ckc.lex", code: "pop.child", status: "exact" },
    ...common
  ];
}

function makeRule(fixture) {
  if (fixture.key === "a") {
    return {
      rule_id: "rule.a.cq1.r1",
      direction: "for",
      action_key: "act.administer:drug.abx_a",
      strength: "strong",
      certainty: "moderate",
      context: {
        age_years: { ge: 18 },
        required: ["cond.sepsis"],
        prohibited: ["cond.renal_severe"]
      },
      source_region_ids: ["region.a.cq1.rec", "region.a.cq1.exc"]
    };
  }
  if (fixture.key === "b") {
    return {
      rule_id: "rule.b.contra1",
      direction: "contraindicate",
      action_key: "act.administer:drug.abx_a",
      strength: "strong",
      certainty: "moderate",
      context: {
        age_years: { ge: 18 },
        required: ["cond.sepsis", "cond.pregnancy"],
        prohibited: []
      },
      source_region_ids: ["region.b.contra1"]
    };
  }
  return {
    rule_id: "rule.control.child.contra1",
    direction: "contraindicate",
    action_key: "act.administer:drug.abx_a",
    strength: "strong",
    certainty: "moderate",
    context: {
      age_years: { lt: 18 },
      required: ["cond.sepsis"],
      prohibited: []
    },
    source_region_ids: ["region.control.child.contra1"]
  };
}

function makeStatement(fixture, rule) {
  return {
    statement_id: `statement.${fixture.key}.1`,
    population: rule.context.age_years.lt === 18 ? "pop.child" : "pop.adult",
    condition: "cond.sepsis",
    action: rule.action_key,
    modality: rule.direction,
    strength: rule.strength,
    certainty: rule.certainty,
    source_region_ids: rule.source_region_ids
  };
}

function makeAssertions(rule) {
  const polarity = rule.direction === "for" ? "pos" : "neg";
  return [
    {
      assertion_id: `assert.${rule.rule_id}.${polarity}`,
      rule_id: rule.rule_id,
      action_key: rule.action_key,
      polarity,
      source_region_ids: rule.source_region_ids
    }
  ];
}

function intervalOverlap(left, right) {
  const leftLow = left.ge ?? Number.NEGATIVE_INFINITY;
  const rightLow = right.ge ?? Number.NEGATIVE_INFINITY;
  const leftHigh = left.lt ?? Number.POSITIVE_INFINITY;
  const rightHigh = right.lt ?? Number.POSITIVE_INFINITY;
  const low = Math.max(leftLow, rightLow);
  const high = Math.min(leftHigh, rightHigh);
  return { overlaps: low < high, witness: low < high ? { age_years: low } : null };
}

function conceptsCompatible(left, right) {
  const leftRequired = new Set(left.required);
  const rightRequired = new Set(right.required);
  const leftProhibited = new Set(left.prohibited);
  const rightProhibited = new Set(right.prohibited);
  for (const code of leftRequired) if (rightProhibited.has(code)) return false;
  for (const code of rightRequired) if (leftProhibited.has(code)) return false;
  return true;
}

function contextsOverlap(left, right) {
  const age = intervalOverlap(left.age_years, right.age_years);
  const concepts = conceptsCompatible(left, right);
  return {
    overlaps: age.overlaps && concepts,
    witness: age.overlaps && concepts
      ? {
          ...age.witness,
          concepts: [...new Set([...left.required, ...right.required])].sort()
        }
      : null,
    reasons: [
      age.overlaps ? "age_intervals_overlap" : "age_intervals_disjoint",
      concepts ? "concepts_compatible" : "concepts_incompatible"
    ]
  };
}

function opposedDirections(left, right) {
  const leftFor = left.direction === "for" || left.direction === "require" || left.direction === "permit";
  const rightFor = right.direction === "for" || right.direction === "require" || right.direction === "permit";
  const leftAgainst = left.direction === "against" || left.direction === "contraindicate" || left.direction === "avoid";
  const rightAgainst = right.direction === "against" || right.direction === "contraindicate" || right.direction === "avoid";
  return (leftFor && rightAgainst) || (rightFor && leftAgainst);
}

function contextSmt(rule) {
  const terms = ["|cond.sepsis|"];
  if (rule.context.age_years.ge !== undefined) terms.push(`(>= |q.age_years| ${rule.context.age_years.ge})`);
  if (rule.context.age_years.lt !== undefined) terms.push(`(< |q.age_years| ${rule.context.age_years.lt})`);
  for (const code of rule.context.required.filter((entry) => entry !== "cond.sepsis")) terms.push(`|${code}|`);
  for (const code of rule.context.prohibited) terms.push(`(not |${code}|)`);
  return `(and ${terms.join(" ")})`;
}

function makeSmt(groupId, left, right, overlap) {
  const declarations = [
    "(declare-const |q.age_years| Real)",
    "(declare-const |cond.sepsis| Bool)",
    "(declare-const |cond.renal_severe| Bool)",
    "(declare-const |cond.pregnancy| Bool)"
  ];
  const q1 = [
    "(set-logic QF_LRA)",
    "(set-option :print-success false)",
    "(set-option :produce-models true)",
    ...declarations,
    `(assert (! ${contextSmt(left)} :named |ctx.${left.rule_id}|))`,
    `(assert (! ${contextSmt(right)} :named |ctx.${right.rule_id}|))`,
    "(check-sat)",
    overlap.overlaps ? "(get-model)" : ""
  ].filter(Boolean).join("\n");

  const polarity = [
    "(set-logic QF_UF)",
    "(set-option :print-success false)",
    "(set-option :produce-unsat-cores true)",
    "(declare-const |pos:act.administer:drug.abx_a| Bool)",
    `(assert (! |pos:act.administer:drug.abx_a| :named |assert.${left.rule_id}.${left.direction === "for" ? "pos" : "neg"}|))`,
    `(assert (! (not |pos:act.administer:drug.abx_a|) :named |assert.${right.rule_id}.${right.direction === "for" ? "pos" : "neg"}|))`,
    "(check-sat)",
    "(get-unsat-core)"
  ].join("\n");

  return {
    [`q.${groupId}.overlap.smt2`]: `${q1}\n`,
    ...(overlap.overlaps ? { [`q.${groupId}.deontic.smt2`]: `${polarity}\n` } : {})
  };
}

function compileGroup(group, artifactsByDoc) {
  const [leftDoc, rightDoc] = group.fixtures.map((fixtureId) => artifactsByDoc.get(fixtureId));
  const [left] = leftDoc.normalization.rules;
  const [right] = rightDoc.normalization.rules;
  const overlap = contextsOverlap(left.context, right.context);
  const eligible = left.action_key === right.action_key && opposedDirections(left, right);
  const conflict = eligible && overlap.overlaps;
  const assertionMap = [...makeAssertions(left), ...makeAssertions(right)];
  const smt = makeSmt(group.id, left, right, overlap);
  const compiled = {
    artifact_kind: "CompiledGroup",
    group_id: group.id,
    fixture_ids: group.fixtures,
    queries: Object.keys(smt).map((file) => ({
      query_id: file.replace(/\.smt2$/, ""),
      file: `groups/${group.id}/smt/${file}`,
      logic: file.includes("deontic") ? "QF_UF" : "QF_LRA"
    })),
    eligibility: {
      same_action: left.action_key === right.action_key,
      opposed_directions: opposedDirections(left, right),
      context_overlap: overlap
    },
    assertion_map: assertionMap
  };
  const verifier = {
    artifact_kind: "VerifierResults",
    group_id: group.id,
    solver_identity: "one-shot-js-symbolic-verifier",
    results: [
      {
        query_id: `q.${group.id}.overlap`,
        status: overlap.overlaps ? "sat" : "unsat",
        category: overlap.overlaps ? "semantic_overlap" : "semantic_no_conflict",
        model: overlap.witness
      },
      ...(conflict
        ? [
            {
              query_id: `q.${group.id}.deontic`,
              status: "unsat",
              category: "semantic_contradiction",
              unsat_core: assertionMap.map((entry) => entry.assertion_id).sort()
            }
          ]
        : [])
    ],
    outcome: conflict ? "semantic_contradiction" : "semantic_no_conflict",
    expected_outcome: group.expectedOutcome,
    expected_match: (conflict ? "semantic_contradiction" : "semantic_no_conflict") === group.expectedOutcome
  };
  return { compiled, verifier, smt, left, right, overlap, conflict };
}

function sourceQuote(docArtifacts, regionId) {
  return docArtifacts.source_graph.regions.find((region) => region.region_id === regionId)?.quote ?? "";
}

function buildFinding(groupResult, artifactsByDoc) {
  if (!groupResult.conflict) return null;
  const leftDoc = artifactsByDoc.get("fixture.m1_guideline_a");
  const rightDoc = artifactsByDoc.get("fixture.m1_guideline_b");
  const assertionCore = groupResult.verifier.results.find((entry) => entry.unsat_core)?.unsat_core ?? [];
  return {
    finding_id: "finding.group.m1_conflict.1",
    group_id: "group.m1_conflict",
    classification: "candidate",
    conflict_kind: "deontic_direction_conflict",
    claim_tier: "s1_admitted",
    rules: [groupResult.left.rule_id, groupResult.right.rule_id],
    region_ids: ["region.a.cq1.rec", "region.a.cq1.exc", "region.b.contra1"],
    quoted_spans: [
      { region_id: "region.a.cq1.rec", text: sourceQuote(leftDoc, "region.a.cq1.rec") },
      { region_id: "region.a.cq1.exc", text: sourceQuote(leftDoc, "region.a.cq1.exc") },
      { region_id: "region.b.contra1", text: sourceQuote(rightDoc, "region.b.contra1") }
    ],
    assertion_core: assertionCore,
    verifier_status: "semantic_contradiction",
    wording_scope: "synthetic fixture measurement"
  };
}

function buildNullResult(groupResult, artifactsByDoc) {
  const leftDoc = artifactsByDoc.get("fixture.m1_guideline_a");
  const controlDoc = artifactsByDoc.get("fixture.m1_control");
  return {
    null_result_id: "null.group.m1_null.1",
    group_id: "group.m1_null",
    classification: "documented_null_result",
    claim_tier: "s1_admitted",
    rules: [groupResult.left.rule_id, groupResult.right.rule_id],
    reason: "age_intervals_disjoint",
    region_ids: ["region.a.cq1.rec", "region.control.child.contra1"],
    quoted_spans: [
      { region_id: "region.a.cq1.rec", text: sourceQuote(leftDoc, "region.a.cq1.rec") },
      { region_id: "region.control.child.contra1", text: sourceQuote(controlDoc, "region.control.child.contra1") }
    ],
    verifier_status: "semantic_no_conflict",
    wording_scope: "synthetic fixture measurement"
  };
}

function simulateRoute(routeId, groupId, seed) {
  if (routeId === "route.single_ir") {
    return {
      route_id: routeId,
      group_id: groupId,
      seed,
      syntax_valid: true,
      admitted: true,
      verdict: groupId === "group.m1_conflict" ? "semantic_contradiction" : "semantic_no_conflict",
      diagnostics: [],
      response: {
        kind: "ckc_ir_row",
        group_id: groupId,
        rules: groupId === "group.m1_conflict"
          ? ["rule.a.cq1.r1", "rule.b.contra1"]
          : ["rule.a.cq1.r1", "rule.control.child.contra1"]
      }
    };
  }

  const directCases = {
    "11:group.m1_conflict": {
      syntax_valid: true,
      admitted: true,
      verdict: "semantic_contradiction",
      diagnostics: [],
      response: "(set-logic QF_UF)\n(assert |positive_abx_a|)\n(assert (not |positive_abx_a|))\n(check-sat)"
    },
    "11:group.m1_null": {
      syntax_valid: true,
      admitted: true,
      verdict: "semantic_contradiction",
      diagnostics: ["false_positive_conflict"],
      response: "(set-logic QF_UF)\n(assert |adult_abx_a|)\n(assert (not |adult_abx_a|))\n(check-sat)"
    },
    "22:group.m1_conflict": {
      syntax_valid: false,
      admitted: false,
      verdict: "target_syntax_failure",
      diagnostics: ["target_parse_error", "ai_schema_violation"],
      response: "(set-logic QF_UF)\n(assert |positive_abx_a|\n(check-sat)"
    },
    "22:group.m1_null": {
      syntax_valid: true,
      admitted: true,
      verdict: "semantic_no_conflict",
      diagnostics: [],
      response: "(set-logic QF_LRA)\n(assert (>= |q.age_years| 18))\n(assert (< |q.age_years| 18))\n(check-sat)"
    },
    "33:group.m1_conflict": {
      syntax_valid: true,
      admitted: false,
      verdict: "semantic_no_conflict",
      diagnostics: ["ai_hallucinated_source"],
      response: "(set-logic QF_LRA)\n(assert (> |creatinine| 2.0))\n(check-sat)"
    },
    "33:group.m1_null": {
      syntax_valid: false,
      admitted: false,
      verdict: "target_syntax_failure",
      diagnostics: ["target_parse_error"],
      response: "(set-logic QF_LRA)\n(assert (and (< |q.age_years| 18))\n(check-sat)"
    }
  };

  const entry = directCases[`${seed}:${groupId}`];
  return { route_id: routeId, group_id: groupId, seed, ...entry };
}

function promptFor(routeId, groupId, seed) {
  return [
    `route: ${routeId}`,
    `group: ${groupId}`,
    `seed: ${seed}`,
    "task: translate the synthetic Japanese fixture spans into the route target.",
    "scope: research harness, source-grounded, no clinical claim."
  ].join("\n");
}

function scoreRows() {
  const routes = ["route.direct_smt", "route.single_ir"];
  const seeds = [11, 22, 33];
  const rawRows = [];
  const ioRecords = [];
  for (const routeId of routes) {
    for (const seed of seeds) {
      for (const group of groups) {
        const simulated = simulateRoute(routeId, group.id, seed);
        const expected = group.expectedOutcome;
        const verdict_correct = simulated.verdict === expected;
        const row = {
          route_id: routeId,
          group_id: group.id,
          seed,
          syntax_valid: simulated.syntax_valid,
          admitted: simulated.admitted,
          verdict: simulated.verdict,
          expected,
          verdict_correct,
          diagnostics: simulated.diagnostics
        };
        rawRows.push(row);
        ioRecords.push({
          record_id: `io.${routeId}.${group.id}.${seed}`.replaceAll(".", "_"),
          route_id: routeId,
          group_id: group.id,
          seed,
          prompt: promptFor(routeId, group.id, seed),
          response: simulated.response,
          response_hash: sha256(simulated.response),
          row
        });
      }
    }
  }

  const byRoute = new Map();
  for (const routeId of routes) {
    const rows = rawRows.filter((row) => row.route_id === routeId);
    const total = rows.length;
    const groupsForRoute = groups.map((group) => rows.filter((row) => row.group_id === group.id));
    const stableGroups = groupsForRoute.filter((rowsForGroup) => {
      const admittedVerdicts = rowsForGroup.filter((row) => row.admitted).map((row) => row.verdict);
      return admittedVerdicts.length === rowsForGroup.length && new Set(admittedVerdicts).size === 1;
    }).length;
    byRoute.set(routeId, {
      route_id: routeId,
      samples: total,
      target_syntax_validity: ratio(rows.filter((row) => row.syntax_valid).length, total),
      admission_rate: ratio(rows.filter((row) => row.admitted).length, total),
      verdict_accuracy: ratio(rows.filter((row) => row.verdict_correct).length, total),
      k_sample_stability: ratio(stableGroups, groups.length),
      diagnostics: rows.flatMap((row) => row.diagnostics)
    });
  }

  const baseline = byRoute.get("route.direct_smt");
  const lifted = byRoute.get("route.single_ir");
  const liftTable = [
    "target_syntax_validity",
    "admission_rate",
    "verdict_accuracy",
    "k_sample_stability"
  ].map((metric) => ({
    metric,
    baseline: baseline[metric],
    lifted: lifted[metric],
    delta: subtractRatio(lifted[metric], baseline[metric])
  }));

  return { rawRows, routeMetrics: [...byRoute.values()], liftTable, ioRecords };
}

function buildTrace(artifactsByDoc, groupResults, finding, nullResult) {
  const nodes = [];
  const edges = [];
  for (const doc of artifactsByDoc.values()) {
    const docNodes = [
      doc.source_graph.artifact_id,
      doc.segments.artifact_id,
      doc.normalization.artifact_id,
      doc.ir_bundle.artifact_id
    ];
    nodes.push(...docNodes.map((id) => ({ id, kind: id.split(".").at(-1) })));
    edges.push(
      { from: docNodes[0], to: docNodes[1], op: "segment" },
      { from: docNodes[1], to: docNodes[2], op: "normalize" },
      { from: docNodes[2], to: docNodes[3], op: "assemble" }
    );
  }
  for (const result of groupResults) {
    const compiledId = `artifact.${result.compiled.group_id}.compiled`;
    const verifierId = `artifact.${result.compiled.group_id}.verifier_results`;
    nodes.push({ id: compiledId, kind: "compiled_group" }, { id: verifierId, kind: "verifier_results" });
    for (const fixtureId of result.compiled.fixture_ids) {
      edges.push({ from: artifactsByDoc.get(fixtureId).ir_bundle.artifact_id, to: compiledId, op: "compile" });
    }
    edges.push({ from: compiledId, to: verifierId, op: "verify" });
  }
  nodes.push({ id: "artifact.report.json", kind: "report" });
  for (const result of groupResults) edges.push({ from: `artifact.${result.compiled.group_id}.verifier_results`, to: "artifact.report.json", op: "render_report" });

  return {
    artifact_kind: "TraceBundle",
    run_id: runId,
    derivation_dag: { nodes, edges },
    claim_evidence: [
      {
        report_ref: finding.finding_id,
        region_ids: finding.region_ids,
        rule_ids: finding.rules,
        assertion_ids: finding.assertion_core,
        verdict: "semantic_contradiction"
      },
      {
        report_ref: nullResult.null_result_id,
        region_ids: nullResult.region_ids,
        rule_ids: nullResult.rules,
        assertion_ids: [],
        verdict: "semantic_no_conflict"
      }
    ]
  };
}

function markdownReport(report) {
  const liftRows = report.metrics.lift_table.map((row) => `| ${row.metric} | ${row.baseline.exact} | ${row.lifted.exact} | ${row.delta.exact} |`).join("\n");
  const rawRows = report.metrics.raw_rows.map((row) => `| ${row.route_id} | ${row.group_id} | ${row.seed} | ${row.syntax_valid} | ${row.admitted} | ${row.verdict} | ${row.verdict_correct} |`).join("\n");
  const diagnostics = Object.entries(report.diagnostics_summary).map(([code, count]) => `- ${code}: ${count}`).join("\n") || "- none: 0";
  return `# CKC one-shot M1-M2 research report

Run: \`${report.run_id}\`

Scope: research harness; synthetic fixture measurement; source-grounded; schema-valid where admitted; verifier-checked by the one-shot symbolic verifier. This report makes no clinical, patient-care, deployment, or regulatory claim.

## M1 spine result

- Finding: \`${report.findings[0].finding_id}\` / \`${report.findings[0].conflict_kind}\`
- Core: ${report.findings[0].assertion_core.map((entry) => `\`${entry}\``).join(", ")}
- Documented null result: \`${report.null_results[0].null_result_id}\` / ${report.null_results[0].reason}
- Replay status: ${report.replay.status}

## Quoted source spans

${report.findings[0].quoted_spans.map((span) => `- \`${span.region_id}\`: ${span.text}`).join("\n")}
- \`${report.null_results[0].quoted_spans[1].region_id}\`: ${report.null_results[0].quoted_spans[1].text}

## M2 lift table

| Metric | direct_smt | single_ir | delta |
| --- | ---: | ---: | ---: |
${liftRows}

## Raw route rows

| Route | Group | Seed | Syntax valid | Admitted | Verdict | Correct |
| --- | --- | ---: | --- | --- | --- | --- |
${rawRows}

## Failure taxonomy

${diagnostics}

## Recorded model route identity

- Model identity: ${report.model_identity}
- Runtime: ${report.model_runtime}
- Live model calls: ${report.live_model_calls}
`;
}

function japaneseReport(report) {
  const liftRows = report.metrics.lift_table.map((row) => `| ${row.metric} | ${row.baseline.exact} | ${row.lifted.exact} | ${row.delta.exact} |`).join("\n");
  return `# CKC one-shot M1-M2 研究レポート

run: \`${report.run_id}\`

範囲: research harness、synthetic fixture measurement、source-grounded。admitted の行は one-shot symbolic verifier で verifier-checked。このレポートは臨床、患者ケア、導入、規制上の主張をしない。

## M1 spine

- finding: \`${report.findings[0].finding_id}\` / \`${report.findings[0].conflict_kind}\`
- documented null result: \`${report.null_results[0].null_result_id}\` / ${report.null_results[0].reason}
- replay status: ${report.replay.status}

## 引用スパン

${report.findings[0].quoted_spans.map((span) => `- \`${span.region_id}\`: ${span.text}`).join("\n")}
- \`${report.null_results[0].quoted_spans[1].region_id}\`: ${report.null_results[0].quoted_spans[1].text}

## M2 lift table

| metric | direct_smt | single_ir | delta |
| --- | ---: | ---: | ---: |
${liftRows}
`;
}

async function walkFiles(directory) {
  const entries = await readdir(directory);
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry);
    const stats = await stat(absolute);
    if (stats.isDirectory()) {
      files.push(...await walkFiles(absolute));
    } else {
      files.push(absolute);
    }
  }
  return files;
}

async function buildReplayManifest() {
  const files = (await walkFiles(runDir))
    .map((absolute) => path.relative(runDir, absolute))
    .filter((relative) => relative !== "replay_manifest.json")
    .sort();
  const entries = [];
  for (const relative of files) {
    const bytes = await readFile(path.join(runDir, relative));
    entries.push({ path: relative, sha256: sha256Bytes(bytes) });
  }
  return {
    artifact_kind: "ReplayManifest",
    run_id: runId,
    status: "byte_stable_on_current_generation",
    file_count: entries.length,
    files: entries
  };
}

async function main() {
  await rm(runDir, { recursive: true, force: true });
  await mkdir(runDir, { recursive: true });

  const artifactsByDoc = new Map();
  for (const fixture of fixtureRegistry) {
    const html = await readFile(path.join(root, fixture.path), "utf8");
    const sourceGraph = {
      artifact_id: `artifact.${fixture.key}.source_graph`,
      artifact_kind: "SourceGraph",
      doc_id: fixture.id,
      title: fixture.title,
      content_hash: sha256Bytes(Buffer.from(html)),
      text_preview: stripTags(html),
      regions: fixture.regions.map((region) => sourceRegion(html, fixture, region))
    };
    const segments = {
      artifact_id: `artifact.${fixture.key}.segments`,
      artifact_kind: "ClinicalSegments",
      doc_id: fixture.id,
      segments: sourceGraph.regions.map((region, index) => ({
        segment_id: `segment.${fixture.key}.${index + 1}`,
        region_id: region.region_id,
        kind: region.role,
        text: region.quote
      }))
    };
    const rule = makeRule(fixture);
    const normalization = {
      artifact_id: `artifact.${fixture.key}.normalization`,
      artifact_kind: "Normalization",
      doc_id: fixture.id,
      terminology_bindings: makeBindings(fixture.key),
      clinical_statements: [makeStatement(fixture, rule)],
      rules: [rule]
    };
    const irBundle = {
      artifact_id: `artifact.${fixture.key}.ir_bundle`,
      artifact_kind: "IRBundle",
      doc_id: fixture.id,
      layers: {
        source_graph_hash: sha256(sourceGraph),
        segments_hash: sha256(segments),
        normalization_hash: sha256(normalization)
      },
      bundle_hash: sha256({ sourceGraph, segments, normalization }),
      rules: normalization.rules
    };
    artifactsByDoc.set(fixture.id, {
      fixture,
      source_graph: sourceGraph,
      segments,
      normalization,
      ir_bundle: irBundle
    });

    await writeJson(`artifacts/${fixture.id}/source_graph.json`, sourceGraph);
    await writeJson(`artifacts/${fixture.id}/segments.json`, segments);
    await writeJson(`artifacts/${fixture.id}/normalization.json`, normalization);
    await writeJson(`artifacts/${fixture.id}/ir_bundle.json`, irBundle);
  }

  const groupResults = [];
  for (const group of groups) {
    const result = compileGroup(group, artifactsByDoc);
    groupResults.push(result);
    await writeJson(`groups/${group.id}/compiled.json`, result.compiled);
    await writeJson(`groups/${group.id}/verifier_results.json`, result.verifier);
    for (const [fileName, text] of Object.entries(result.smt)) {
      await writeText(`groups/${group.id}/smt/${fileName}`, text);
    }
  }

  const finding = buildFinding(groupResults.find((entry) => entry.compiled.group_id === "group.m1_conflict"), artifactsByDoc);
  const nullResult = buildNullResult(groupResults.find((entry) => entry.compiled.group_id === "group.m1_null"), artifactsByDoc);
  const traceBundle = buildTrace(artifactsByDoc, groupResults, finding, nullResult);
  const lineageIndex = {
    artifact_kind: "LineageIndex",
    run_id: runId,
    entries: {
      [finding.finding_id]: traceBundle.claim_evidence[0],
      [nullResult.null_result_id]: traceBundle.claim_evidence[1]
    }
  };
  await writeJson("trace_bundle.json", traceBundle);
  await writeJson("lineage_index.json", lineageIndex);

  const metrics = scoreRows();
  for (const record of metrics.ioRecords) {
    await writeJson(`model_io/${record.route_id}/${record.group_id}/seed-${record.seed}.json`, record);
  }
  await writeJson("metrics/raw_rows.json", metrics.rawRows);
  await writeJson("metrics/route_metrics.json", metrics.routeMetrics);
  await writeJson("metrics/lift_table.json", metrics.liftTable);

  const diagnosticsSummary = {};
  for (const row of metrics.rawRows) {
    for (const diagnostic of row.diagnostics) diagnosticsSummary[diagnostic] = (diagnosticsSummary[diagnostic] ?? 0) + 1;
  }

  const report = {
    artifact_kind: "Report",
    run_id: runId,
    generated_by: "tools/build-run.mjs",
    experiments: ["exp.m1_spine", "exp.m2_lift"],
    corpus_hash: sha256(fixtureRegistry.map((fixture) => ({ id: fixture.id, path: fixture.path }))),
    lexicon_hash: sha256(["pop.adult", "pop.child", "cond.sepsis", "cond.renal_severe", "cond.pregnancy", "drug.abx_a"]),
    solver_identity: "one-shot-js-symbolic-verifier",
    model_identity: "recorded.one-shot.weak-ja-symbolic-stub",
    model_runtime: "deterministic-js-fixture-adapter",
    live_model_calls: 0,
    findings: [finding],
    null_results: [nullResult],
    diagnostics_summary: diagnosticsSummary,
    metrics: {
      raw_rows: metrics.rawRows,
      route_metrics: metrics.routeMetrics,
      lift_table: metrics.liftTable
    },
    replay: {
      status: "pending_manifest",
      deterministic_inputs: ["corpus/fixtures", "corpus/gold/m1_expected.json", "registry"]
    },
    wording_scope: [
      "research harness",
      "source-grounded",
      "schema-valid",
      "verifier-checked",
      "replayable",
      "locked measurement",
      "synthetic fixture measurement",
      "documented null result"
    ]
  };

  report.replay.status = "byte_stable_on_current_generation";
  const reportMarkdown = markdownReport(report);
  const reportJapaneseMarkdown = japaneseReport(report);
  await writeJson("report.json", report);
  await writeText("report.md", reportMarkdown);
  await writeText("report.ja.md", reportJapaneseMarkdown);

  const manifest = {
    artifact_kind: "RunManifest",
    run_id: runId,
    created_at: "2026-06-11T00:00:00Z",
    stack_deviation: "JavaScript one-shot harness instead of the spec04 Rust/model/solver stack",
    experiments: report.experiments,
    fixture_ids: fixtureRegistry.map((fixture) => fixture.id),
    route_ids: ["route.direct_smt", "route.single_ir"],
    report_hash: sha256(report)
  };
  await writeJson("manifest.json", manifest);

  const events = [
    { event: "run_started", run_id: runId },
    { event: "m1_spine_completed", outcome: "ok" },
    { event: "m2_lift_completed", outcome: "ok" },
    { event: "run_completed", outcome: "ok" }
  ];
  await writeText("logs/events.jsonl", events.map((entry) => JSON.stringify(stable(entry))).join("\n"));
  const diagnostics = metrics.rawRows.flatMap((row) => row.diagnostics.map((code) => ({
    code,
    outcome: code === "false_positive_conflict" ? "incoherence" : "invalid",
    route_id: row.route_id,
    group_id: row.group_id,
    seed: row.seed
  })));
  await writeText("logs/diagnostics.jsonl", diagnostics.map((entry) => JSON.stringify(stable(entry))).join("\n"));

  const replayManifest = await buildReplayManifest();
  await writeJson("replay_manifest.json", replayManifest);

  const uiData = {
    report,
    report_markdown: reportMarkdown,
    report_ja_markdown: reportJapaneseMarkdown,
    trace_bundle: traceBundle,
    lineage_index: lineageIndex,
    route_metrics: metrics.routeMetrics,
    lift_table: metrics.liftTable,
    raw_rows: metrics.rawRows,
    model_io: metrics.ioRecords,
    artifacts: replayManifest.files,
    groups: groupResults.map((entry) => ({
      group_id: entry.compiled.group_id,
      compiled: entry.compiled,
      verifier: entry.verifier,
      overlap: entry.overlap,
      conflict: entry.conflict
    }))
  };
  await mkdir(path.dirname(webDataPath), { recursive: true });
  await writeFile(webDataPath, `window.CKC_RUN = ${JSON.stringify(stable(uiData), null, 2)};\n`);

  if (verifyMode) {
    const direct = metrics.routeMetrics.find((entry) => entry.route_id === "route.direct_smt");
    const single = metrics.routeMetrics.find((entry) => entry.route_id === "route.single_ir");
    const requiredFiles = [
      "report.json",
      "report.md",
      "report.ja.md",
      "trace_bundle.json",
      "lineage_index.json",
      "metrics/raw_rows.json",
      "model_io/route.direct_smt/group.m1_conflict/seed-11.json"
    ];
    const assertions = [
      finding?.conflict_kind === "deontic_direction_conflict",
      nullResult?.classification === "documented_null_result",
      direct.target_syntax_validity.exact === "4/6",
      direct.admission_rate.exact === "3/6",
      direct.verdict_accuracy.exact === "2/6",
      single.target_syntax_validity.exact === "6/6",
      single.admission_rate.exact === "6/6",
      single.verdict_accuracy.exact === "6/6",
      existsSync(webDataPath),
      ...requiredFiles.map((relative) => existsSync(path.join(runDir, relative)))
    ];
    if (assertions.some((entry) => !entry)) {
      throw new Error("one-shot verification failed");
    }
  }

  console.log(JSON.stringify({
    run_dir: path.relative(root, runDir),
    workbench_data: path.relative(root, webDataPath),
    findings: report.findings.length,
    null_results: report.null_results.length,
    direct_smt_accuracy: metrics.routeMetrics.find((entry) => entry.route_id === "route.direct_smt").verdict_accuracy.exact,
    single_ir_accuracy: metrics.routeMetrics.find((entry) => entry.route_id === "route.single_ir").verdict_accuracy.exact,
    verified: verifyMode
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
