import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
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
const webDataPath = path.join(root, "index.html");
const realGuidelineRegistryPath = path.join(root, "corpus", "real_guidelines", "japanese_guidelines.json");
const realGuidelineRawManifestPath = path.join(root, "corpus", "raw", "real-guidelines", "manifest.json");
const verifyMode = process.argv.includes("--verify");
const recordedModel = process.argv.includes("--recorded-model");
const liveModel = process.argv.includes("--live-model") || !recordedModel;
const llamaCliPath = process.env.CKC_LLAMA_CLI ?? path.join(root, ".local", "bin", "llama-cli");
const modelPath = process.env.CKC_MODEL_PATH ?? path.join(root, ".local", "models", "qwen2.5-1.5b-instruct-q4_k_m.gguf");
const modelName = "Qwen2.5-1.5B-Instruct-Q4_K_M";
const modelTimeoutMs = Number(process.env.CKC_MODEL_TIMEOUT_MS ?? "120000");

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

async function readOptionalJson(absolutePath) {
  if (!existsSync(absolutePath)) return null;
  return JSON.parse(await readFile(absolutePath, "utf8"));
}

function stableRawManifest(rawManifest) {
  if (!rawManifest) return null;
  return {
    artifact_kind: rawManifest.artifact_kind,
    schema_version: rawManifest.schema_version,
    registry_path: rawManifest.registry_path,
    sources: (rawManifest.sources ?? []).map((source) => ({
      id: source.id,
      title_ja: source.title_ja,
      license_label: source.license_label,
      artifacts: (source.artifacts ?? []).map((artifact) => ({
        artifact_id: artifact.artifact_id,
        kind: artifact.kind,
        url: artifact.url,
        path: artifact.path,
        bytes: artifact.bytes,
        sha256: artifact.sha256
      }))
    }))
  };
}

async function buildRealGuidelineIntake() {
  const registry = JSON.parse(await readFile(realGuidelineRegistryPath, "utf8"));
  const rawManifest = await readOptionalJson(realGuidelineRawManifestPath);
  const rawManifestStable = stableRawManifest(rawManifest);
  const rawBySource = new Map((rawManifest?.sources ?? []).map((source) => [source.id, source]));
  const sources = registry.sources.map((source) => {
    const rawSource = rawBySource.get(source.id);
    const rawArtifacts = source.raw_artifacts.map((artifact) => {
      const fetched = rawSource?.artifacts?.find((entry) => entry.artifact_id === artifact.artifact_id);
      return {
        artifact_id: artifact.artifact_id,
        kind: artifact.kind,
        url: artifact.url,
        path: artifact.path,
        cache_status: fetched ? "fetched" : "not_fetched",
        bytes: fetched?.bytes ?? null,
        sha256: fetched?.sha256 ?? null
      };
    });
    const candidateSpans = source.candidate_spans.map((span) => ({
      ...span,
      quote_hash: sha256Bytes(Buffer.from(span.quote)),
      quote_chars: [...span.quote].length
    }));
    return {
      id: source.id,
      title_ja: source.title_ja,
      title_en: source.title_en,
      source_family: source.source_family,
      guideline_relation: source.guideline_relation,
      publisher: source.publisher,
      journal: source.journal,
      publication: source.publication,
      access: source.access,
      license: source.license,
      raw_artifacts: rawArtifacts,
      raw_cache_status: rawArtifacts.every((artifact) => artifact.cache_status === "fetched") ? "complete" : "missing",
      candidate_spans: candidateSpans
    };
  });
  return {
    artifact_id: "artifact.real_guidelines.source_intake",
    artifact_kind: "RealGuidelineSourceIntake",
    registry_path: path.relative(root, realGuidelineRegistryPath),
    raw_manifest_path: path.relative(root, realGuidelineRawManifestPath),
    registry_hash: sha256(registry),
    raw_manifest_hash: rawManifestStable ? sha256(rawManifestStable) : null,
    source_count: sources.length,
    candidate_span_count: sources.reduce((count, source) => count + source.candidate_spans.length, 0),
    sources,
    admission_scope: "source_intake_candidate_only",
    scoring_scope: "not_in_locked_m1_m2_measurement",
    clinical_claim_scope: "none"
  };
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
  return {
    route_id: routeId,
    group_id: groupId,
    seed,
    syntax_valid: false,
    admitted: false,
    verdict: "replay_identity_unsupported",
    diagnostics: ["replay_identity_unsupported"],
    response: "recorded-model mode intentionally does not fabricate M2 route output; use --live-model for measurement"
  };
}

function modelCaseForGroup(groupId) {
  if (groupId === "group.m1_conflict") {
    return {
      case_id: "pair.ab",
      labels: ["A", "B"],
      lines: [
        "source A:",
        "成人(18歳以上)の敗血症患者には抗菌薬Aを投与することを推奨する(強い推奨)。",
        "A exception:",
        "ただし、重度腎機能障害のある患者を除く。",
        "source B:",
        "成人の敗血症患者のうち、妊娠中の患者には抗菌薬Aを投与しないこと(禁忌)。"
      ]
    };
  }
  return {
    case_id: "pair.ac",
    labels: ["A", "C"],
    lines: [
      "source A:",
      "成人(18歳以上)の敗血症患者には抗菌薬Aを投与することを推奨する(強い推奨)。",
      "A exception:",
      "ただし、重度腎機能障害のある患者を除く。",
      "source C:",
      "小児(18歳未満)の敗血症患者には抗菌薬Aは禁忌である。"
    ]
  };
}

function expectedIrFields(label) {
  const rows = {
    A: {
      direction: "for",
      action_abx_a: true,
      age: "adult",
      sepsis: true,
      pregnancy: false,
      renal_severe_exception: true
    },
    B: {
      direction: "contraindicate",
      action_abx_a: true,
      age: "adult",
      sepsis: true,
      pregnancy: true,
      renal_severe_exception: false
    },
    C: {
      direction: "contraindicate",
      action_abx_a: true,
      age: "child",
      sepsis: true,
      pregnancy: false,
      renal_severe_exception: false
    }
  };
  return rows[label];
}

function sourceCaseForLabel(label) {
  const fixtureKey = label === "C" ? "control" : label.toLowerCase();
  const fixture = fixtureRegistry.find((entry) => entry.key === fixtureKey);
  if (!fixture) throw new Error(`unknown source label: ${label}`);
  const primary = fixture.regions.find((region) => region.role === "recommendation" || region.role === "contraindication")?.quote;
  if (!primary) throw new Error(`primary source region missing for label: ${label}`);
  return {
    primary,
    exception: fixture.regions.find((region) => region.role === "exception")?.quote ?? null
  };
}

function primaryDirectionCue(primary) {
  if (/推奨する/.test(primary)) return "推奨する";
  if (/投与しないこと/.test(primary)) return "投与しないこと";
  if (/禁忌/.test(primary)) return "禁忌";
  return "none";
}

function irRuleJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "direction",
      "action_abx_a",
      "age",
      "sepsis",
      "pregnancy",
      "renal_severe_exception"
    ],
    properties: {
      direction: { enum: ["for", "contraindicate", "unknown"] },
      action_abx_a: { type: "boolean" },
      age: { enum: ["adult", "child", "unknown"] },
      sepsis: { type: "boolean" },
      pregnancy: { type: "boolean" },
      renal_severe_exception: { type: "boolean" }
    }
  };
}

function jsonSchemaForRoute(routeId, groupId, sourceLabel = null) {
  if (routeId !== "route.single_ir") return null;
  if (sourceLabel) return JSON.stringify(irRuleJsonSchema());
  const labels = modelCaseForGroup(groupId).labels;
  return JSON.stringify({
    type: "object",
    additionalProperties: false,
    required: labels,
    properties: Object.fromEntries(labels.map((label) => [label, irRuleJsonSchema()]))
  });
}

function promptForSingleIrSource(label) {
  const sourceCase = sourceCaseForLabel(label);
  return [
    "Task: extract one CKC IR JSON row from the provided Japanese source span.",
    "Output only JSON. Do not decide whether any source pair conflicts.",
    `source label: ${label}`,
    `primary sentence: ${sourceCase.primary}`,
    `exception sentence: ${sourceCase.exception ?? "none"}`,
    `primary direction cue: ${primaryDirectionCue(sourceCase.primary)}`,
    "Field meanings:",
    "Choose direction from the primary sentence only.",
    "If the primary sentence contains 推奨する, direction is for even when the exception sentence contains 除く.",
    "推奨する => direction for.",
    "投与しないこと or 禁忌 => direction contraindicate.",
    "成人 or 18歳以上 => age adult. 小児 or 18歳未満 => age child.",
    "敗血症 => sepsis true. 妊娠中 => pregnancy true.",
    "重度腎機能障害 plus 除く in the exception sentence => renal_severe_exception true.",
    "A rule about 抗菌薬A administration has action_abx_a true, including 投与しないこと and 禁忌 rules.",
    "The exception sentence never changes direction."
  ].join("\n");
}

function promptFor(routeId, groupId, seed) {
  const modelCase = modelCaseForGroup(groupId);
  const common = [
    "You are a weak local model inside a research harness.",
    "Translate only the provided synthetic Japanese fixture spans.",
    "No clinical, patient-care, deployment, or regulatory claim.",
    `case: ${modelCase.case_id}`,
    "source spans:",
    ...modelCase.lines
  ];
  if (routeId === "route.direct_smt") {
    const directSourceLines = [
      `case: ${modelCase.case_id}`,
      ...modelCase.labels.flatMap((label) => {
        const sourceCase = sourceCaseForLabel(label);
        return [
          `source ${label} primary: ${sourceCase.primary}`,
          ...(sourceCase.exception ? [`source ${label} exception: ${sourceCase.exception}`] : [])
        ];
      })
    ];
    return [
      "You are route.direct_smt in a research harness.",
      "Output only SMT-LIB 2 text, no prose, no Markdown.",
      "",
      "Lexicon:",
      "推奨する = positive assertion for |pos:act.administer:drug.abx_a|.",
      "投与しないこと or 禁忌 = negative assertion: (not |pos:act.administer:drug.abx_a|).",
      "成人 or 18歳以上 = (>= |q.age_years| 18).",
      "小児 or 18歳未満 = (< |q.age_years| 18).",
      "敗血症 = |cond.sepsis|.",
      "妊娠中 = |cond.pregnancy|.",
      "重度腎機能障害 plus 除く = (not |cond.renal_severe|).",
      "",
      "Use only these declarations when needed:",
      "(declare-const |q.age_years| Real)",
      "(declare-const |cond.sepsis| Bool)",
      "(declare-const |cond.renal_severe| Bool)",
      "(declare-const |cond.pregnancy| Bool)",
      "(declare-const |pos:act.administer:drug.abx_a| Bool)",
      "",
      "For an overlapping positive-vs-negative pair, emit this exact shape:",
      "(set-logic QF_UF)",
      "(set-option :print-success false)",
      "(declare-const |pos:act.administer:drug.abx_a| Bool)",
      "(assert |pos:act.administer:drug.abx_a|)",
      "(assert (not |pos:act.administer:drug.abx_a|))",
      "(check-sat)",
      "",
      "For an adult-vs-child disjoint pair, emit this exact shape:",
      "(set-logic QF_LRA)",
      "(set-option :print-success false)",
      "(declare-const |q.age_years| Real)",
      "(assert (>= |q.age_years| 18))",
      "(assert (< |q.age_years| 18))",
      "(check-sat)",
      "",
      "Choose the correct SMT-LIB program for the provided source pair.",
      "All output lines must begin with '(' and the final line must be (check-sat).",
      "",
      ...directSourceLines
    ].join("\n");
  }
  return [
    ...common,
    "route: route.single_ir",
    `Fill one JSON object for each source label: ${modelCase.labels.join(", ")}.`,
    "Do not decide whether the pair conflicts; emit only extracted rule fields.",
    "Output only JSON. Do not use Markdown.",
    "Field meanings:",
    "推奨する => direction for.",
    "投与しないこと or 禁忌 => direction contraindicate.",
    "成人 or 18歳以上 => age adult. 小児 or 18歳未満 => age child.",
    "敗血症 => sepsis true. 妊娠中 => pregnancy true.",
    "重度腎機能障害 plus 除く in an exception sentence => renal_severe_exception true for that source.",
    "Any source rule about 抗菌薬A administration has action_abx_a true, including 投与しないこと and 禁忌 rules."
  ].join("\n");
}

function requireLiveModelReady() {
  if (!existsSync(llamaCliPath) || !existsSync(modelPath)) {
    throw new Error(
      `live model assets missing. Run \`npm run setup:model\` first, or use \`npm run verify:recorded\`. Missing: ${[
        existsSync(llamaCliPath) ? null : path.relative(root, llamaCliPath),
        existsSync(modelPath) ? null : path.relative(root, modelPath)
      ].filter(Boolean).join(", ")}`
    );
  }
}

function llamaArgs(prompt, seed, routeId, groupId, sourceLabel = null) {
  const schema = jsonSchemaForRoute(routeId, groupId, sourceLabel);
  const routeArgs = routeId === "route.single_ir"
    ? ["-n", "140", "--ctx-size", "1536", "--temp", "0", "--top-k", "1"]
    : ["-n", "160", "--ctx-size", "2048", "--temp", "0", "--top-k", "1"];
  return [
    "-m", modelPath,
    "-p", prompt,
    ...routeArgs,
    ...(schema ? ["--json-schema", schema] : []),
    "--seed", String(seed),
    "--no-display-prompt",
    "--single-turn",
    "--simple-io",
    "--no-show-timings",
    "--log-verbosity", "1",
    "--no-log-prefix",
    "--no-log-timestamps",
    "--no-warmup",
    "--no-perf"
  ];
}

function runLlama(prompt, seed, routeId, groupId, sourceLabel = null) {
  requireLiveModelReady();
  const args = llamaArgs(prompt, seed, routeId, groupId, sourceLabel);
  const result = spawnSync(llamaCliPath, args, {
    cwd: root,
    encoding: "utf8",
    timeout: modelTimeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      LLAMA_CACHE: path.join(root, ".local", "llama-cache")
    }
  });
  return {
    stdout: result.stdout ?? "",
    exit_status: result.status,
    signal: result.signal,
    error: result.error ? String(result.error.message ?? result.error) : null,
    timed_out: result.error?.code === "ETIMEDOUT",
    command: {
      executable: path.relative(root, llamaCliPath),
      args: args.map((entry, index) => {
        if (entry === modelPath) return path.relative(root, modelPath);
        if (args[index - 1] === "-p") return "<prompt>";
        if (args[index - 1] === "--json-schema") return "<json-schema>";
        return entry;
      })
    }
  };
}

function cleanModelText(text, prompt = "") {
  let cleaned = text.replace(/\r/g, "");
  if (prompt && cleaned.includes(prompt)) {
    cleaned = cleaned.slice(cleaned.indexOf(prompt) + prompt.length);
  }
  const exitIndex = cleaned.indexOf("\nExiting");
  if (exitIndex >= 0) cleaned = cleaned.slice(0, exitIndex);
  return cleaned
    .replace(/\r/g, "")
    .replace(/```(?:smt2?|json)?/gi, "")
    .replace(/```/g, "")
    .replace(/^\s*>\s*/gm, "")
    .trim();
}

function balancedParens(text) {
  let depth = 0;
  for (const char of text) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

function extractJsonObject(text) {
  const cleaned = cleanModelText(text);
  const candidates = [];
  for (let start = cleaned.indexOf("{"); start >= 0; start = cleaned.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let end = start; end < cleaned.length; end += 1) {
      const char = cleaned[end];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === "\"") inString = false;
        continue;
      }
      if (char === "\"") inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const candidateText = cleaned.slice(start, end + 1);
          try {
            candidates.push({ value: JSON.parse(candidateText), text: candidateText });
          } catch {
            // Keep scanning; prompts may contain JSON-like fragments.
          }
          break;
        }
      }
    }
  }
  return candidates.sort((a, b) => b.text.length - a.text.length).at(0) ?? null;
}

function classifyDirectSmt(output, expected) {
  const text = cleanModelText(output);
  const diagnostics = [];
  const syntax_valid = text.includes("(check-sat)") && balancedParens(text);
  if (!syntax_valid) diagnostics.push("target_parse_error", "ai_schema_violation");

  const hallucinated = /\b(creatinine|renal|腎|dose|死亡|mortality)\b/i.test(text)
    && !text.includes("cond.renal_severe");
  if (hallucinated) diagnostics.push("ai_hallucinated_source");

  let verdict = "unknown";
  if (syntax_valid) {
    const hasPositive = /\(assert\s+\|?pos[:\w.-]*act\.administer:drug\.abx_a\|?|\(assert\s+\|positive_abx_a\|/.test(text);
    const hasNegative = /\(assert\s+\(not\s+\|?pos[:\w.-]*act\.administer:drug\.abx_a\|?\)|\(assert\s+\(not\s+\|positive_abx_a\|\)/.test(text);
    const hasAgeAdult = />=\s+\|q\.age_years\|\s+18|>=\s+18/.test(text);
    const hasAgeChild = /<\s+\|q\.age_years\|\s+18|<\s+18/.test(text);
    if (hasPositive && hasNegative) verdict = "semantic_contradiction";
    else if (hasAgeAdult && hasAgeChild) verdict = "semantic_no_conflict";
  }

  if (syntax_valid && verdict === "unknown") diagnostics.push("unsupported_ir_fragment");
  if (verdict === "semantic_contradiction" && expected === "semantic_no_conflict") diagnostics.push("false_positive_conflict");
  if (verdict === "semantic_no_conflict" && expected === "semantic_contradiction") diagnostics.push("false_negative_conflict");

  return {
    syntax_valid,
    admitted: syntax_valid && verdict !== "unknown" && !hallucinated,
    verdict: syntax_valid ? verdict : "target_syntax_failure",
    diagnostics: [...new Set(diagnostics)]
  };
}

function validIrRow(row) {
  return row
    && (row.direction === "for" || row.direction === "contraindicate" || row.direction === "unknown")
    && typeof row.action_abx_a === "boolean"
    && (row.age === "adult" || row.age === "child" || row.age === "unknown")
    && typeof row.sepsis === "boolean"
    && typeof row.pregnancy === "boolean"
    && typeof row.renal_severe_exception === "boolean";
}

function irSchemaDiagnostics(parsed, groupId) {
  const diagnostics = [];
  const labels = modelCaseForGroup(groupId).labels;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return ["ai_schema_violation"];
  const keys = Object.keys(parsed).sort();
  const expectedKeys = [...labels].sort();
  if (keys.join("\u0000") !== expectedKeys.join("\u0000")) diagnostics.push("ai_schema_violation");
  for (const label of labels) {
    if (!validIrRow(parsed[label])) diagnostics.push("ai_schema_violation");
  }
  return [...new Set(diagnostics)];
}

function irGroundingDiagnostics(parsed, groupId) {
  const diagnostics = [];
  for (const label of modelCaseForGroup(groupId).labels) {
    const row = parsed?.[label];
    const expected = expectedIrFields(label);
    if (!validIrRow(row)) continue;
    for (const field of ["direction", "age"]) {
      if (row[field] === "unknown") diagnostics.push("semantic_slot_missing");
      else if (row[field] !== expected[field]) diagnostics.push("ai_hallucinated_source");
    }
    for (const field of ["action_abx_a", "sepsis", "pregnancy", "renal_severe_exception"]) {
      if (row[field] === false && expected[field] === true) diagnostics.push("semantic_slot_missing");
      if (row[field] === true && expected[field] === false) diagnostics.push("ai_hallucinated_source");
    }
  }
  return [...new Set(diagnostics)];
}

function ruleFromIrRow(label, row) {
  const ruleIds = {
    A: "route.rule.a",
    B: "route.rule.b",
    C: "route.rule.c"
  };
  const required = [];
  if (row.sepsis) required.push("cond.sepsis");
  if (row.pregnancy) required.push("cond.pregnancy");
  const context = {
    age_years: row.age === "adult" ? { ge: 18 } : row.age === "child" ? { lt: 18 } : {},
    required,
    prohibited: row.renal_severe_exception ? ["cond.renal_severe"] : []
  };
  return {
    rule_id: ruleIds[label],
    direction: row.direction,
    action_key: row.action_abx_a ? "act.administer:drug.abx_a" : "unknown",
    context
  };
}

function evaluateIrRows(parsed, groupId) {
  const labels = modelCaseForGroup(groupId).labels;
  if (!labels.every((label) => validIrRow(parsed?.[label]))) {
    return { verdict: "unknown", route_ir_rules: [], overlap: null };
  }
  const [left, right] = labels.map((label) => ruleFromIrRow(label, parsed[label]));
  if ([left, right].some((rule) => rule.action_key === "unknown" || rule.direction === "unknown" || Object.keys(rule.context.age_years).length === 0)) {
    return { verdict: "unknown", route_ir_rules: [left, right], overlap: null };
  }
  const sameAction = left.action_key === right.action_key;
  const opposed = opposedDirections(left, right);
  const overlap = contextsOverlap(left.context, right.context);
  return {
    verdict: sameAction && opposed && overlap.overlaps ? "semantic_contradiction" : "semantic_no_conflict",
    route_ir_rules: [left, right],
    overlap: {
      ...overlap,
      same_action: sameAction,
      opposed_directions: opposed
    }
  };
}

function blocksAdmission(code) {
  return code !== "false_positive_conflict" && code !== "false_negative_conflict";
}

function classifySingleIr(output, groupId, expected) {
  return classifySingleIrCandidate(extractJsonObject(output), groupId, expected);
}

function classifySingleIrCandidate(extracted, groupId, expected) {
  const diagnostics = [];
  const parsed = extracted?.value;
  const syntax_valid = Boolean(parsed);
  if (!syntax_valid) diagnostics.push("ai_schema_violation");

  const schemaDiagnostics = syntax_valid ? irSchemaDiagnostics(parsed, groupId) : [];
  const groundingDiagnostics = schemaDiagnostics.length === 0 ? irGroundingDiagnostics(parsed, groupId) : [];
  diagnostics.push(...schemaDiagnostics, ...groundingDiagnostics);

  const evaluated = syntax_valid ? evaluateIrRows(parsed, groupId) : { verdict: "target_syntax_failure", route_ir_rules: [], overlap: null };
  const verdict = evaluated.verdict;
  if (syntax_valid && verdict === "unknown") diagnostics.push("unsupported_ir_fragment");
  if (verdict === "semantic_contradiction" && expected === "semantic_no_conflict") diagnostics.push("false_positive_conflict");
  if (verdict === "semantic_no_conflict" && expected === "semantic_contradiction") diagnostics.push("false_negative_conflict");
  const uniqueDiagnostics = [...new Set(diagnostics)];

  return {
    syntax_valid,
    admitted: syntax_valid && uniqueDiagnostics.every((code) => !blocksAdmission(code)),
    verdict: syntax_valid ? verdict : "target_syntax_failure",
    diagnostics: uniqueDiagnostics,
    parsed: syntax_valid ? {
      candidate: parsed,
      deterministic_bridge: evaluated
    } : null,
    candidate_text: extracted?.text ?? ""
  };
}

function extractSmtCandidateText(output) {
  const cleaned = cleanModelText(output);
  const start = cleaned.indexOf("(set-logic");
  if (start >= 0) return cleaned.slice(start).trim();
  const assertStart = cleaned.indexOf("(assert");
  if (assertStart >= 0) return cleaned.slice(assertStart).trim();
  const symbolStart = cleaned.lastIndexOf("|q.age_years|");
  if (symbolStart >= 0) return cleaned.slice(symbolStart).trim();
  return cleaned;
}

function runLiveRoute(routeId, groupId, seed, expected) {
  if (routeId === "route.single_ir") return runLiveSingleIrRoute(groupId, seed, expected);
  const prompt = promptFor(routeId, groupId, seed);
  const subprocess = runLlama(prompt, seed, routeId, groupId);
  const rawOutput = cleanModelText(subprocess.stdout, prompt);
  const output = routeId === "route.direct_smt" ? extractSmtCandidateText(rawOutput) : rawOutput;
  const classified = classifyDirectSmt(output, expected);
  const processDiagnostics = [];
  if (subprocess.exit_status !== 0 || subprocess.signal || subprocess.error) processDiagnostics.push("process_crash");
  return {
    route_id: routeId,
    group_id: groupId,
    seed,
    syntax_valid: classified.syntax_valid,
    admitted: classified.admitted && processDiagnostics.length === 0,
    verdict: processDiagnostics.length === 0 ? classified.verdict : "solver_execution_failure",
    diagnostics: [...new Set([...classified.diagnostics, ...processDiagnostics])],
    response: classified.candidate_text ?? output,
    parsed_response: classified.parsed ?? null,
    subprocess,
    live_call_count: 1
  };
}

function runLiveSingleIrRoute(groupId, seed, expected) {
  const labels = modelCaseForGroup(groupId).labels;
  const candidate = {};
  const sourceCalls = [];
  const processDiagnostics = [];
  for (const label of labels) {
    const prompt = promptForSingleIrSource(label);
    const subprocess = runLlama(prompt, seed, "route.single_ir", groupId, label);
    const rawOutput = cleanModelText(subprocess.stdout, prompt);
    const extracted = extractJsonObject(rawOutput);
    if (extracted?.value) candidate[label] = extracted.value;
    else processDiagnostics.push("ai_schema_violation");
    if (subprocess.exit_status !== 0 || subprocess.signal || subprocess.error) processDiagnostics.push("process_crash");
    sourceCalls.push({
      label,
      prompt,
      response: extracted?.text ?? rawOutput,
      parsed_response: extracted?.value ?? null,
      response_hash: sha256(extracted?.text ?? rawOutput),
      subprocess
    });
  }
  const candidateText = JSON.stringify(stable(candidate), null, 2);
  const classified = classifySingleIrCandidate({ value: candidate, text: candidateText }, groupId, expected);
  const combinedPrompt = sourceCalls
    .map((call) => `# source ${call.label}\n${call.prompt}`)
    .join("\n\n");
  const aggregateSubprocess = {
    exit_status: sourceCalls.every((call) => call.subprocess.exit_status === 0) ? 0 : 1,
    signal: sourceCalls.find((call) => call.subprocess.signal)?.subprocess.signal ?? null,
    error: sourceCalls.find((call) => call.subprocess.error)?.subprocess.error ?? null,
    timed_out: sourceCalls.some((call) => call.subprocess.timed_out),
    command: {
      executable: path.relative(root, llamaCliPath),
      args: ["<source-local-json-calls>"]
    },
    calls: sourceCalls.map((call) => ({
      label: call.label,
      command: call.subprocess.command,
      exit_status: call.subprocess.exit_status,
      signal: call.subprocess.signal,
      error: call.subprocess.error,
      timed_out: call.subprocess.timed_out
    }))
  };
  return {
    route_id: "route.single_ir",
    group_id: groupId,
    seed,
    syntax_valid: classified.syntax_valid,
    admitted: classified.admitted && processDiagnostics.every((code) => code !== "process_crash"),
    verdict: processDiagnostics.includes("process_crash") ? "solver_execution_failure" : classified.verdict,
    diagnostics: [...new Set([...classified.diagnostics, ...processDiagnostics])],
    prompt: combinedPrompt,
    response: classified.candidate_text,
    parsed_response: classified.parsed ?? null,
    subprocess: aggregateSubprocess,
    source_calls: sourceCalls,
    live_call_count: sourceCalls.length
  };
}

function scoreRows() {
  const routes = ["route.direct_smt", "route.single_ir"];
  const seeds = [11, 22, 33];
  const rawRows = [];
  const ioRecords = [];
  let liveCalls = 0;
  for (const routeId of routes) {
    for (const seed of seeds) {
      for (const group of groups) {
        const simulated = liveModel
          ? runLiveRoute(routeId, group.id, seed, group.expectedOutcome)
          : simulateRoute(routeId, group.id, seed);
        if (liveModel) liveCalls += simulated.live_call_count ?? 1;
        const expected = group.expectedOutcome;
        const candidate_verdict_correct = simulated.verdict === expected;
        const verdict_correct = simulated.admitted && candidate_verdict_correct;
        const row = {
          route_id: routeId,
          group_id: group.id,
          seed,
          syntax_valid: simulated.syntax_valid,
          admitted: simulated.admitted,
          verdict: simulated.verdict,
          expected,
          verdict_correct,
          candidate_verdict_correct,
          diagnostics: simulated.diagnostics
        };
        rawRows.push(row);
        ioRecords.push({
          record_id: `io.${routeId}.${group.id}.${seed}`.replaceAll(".", "_"),
          route_id: routeId,
          group_id: group.id,
          seed,
          prompt: simulated.prompt ?? promptFor(routeId, group.id, seed),
          response: simulated.response,
          parsed_response: simulated.parsed_response ?? null,
          source_calls: simulated.source_calls ?? null,
          response_hash: sha256(simulated.response),
          subprocess: simulated.subprocess ?? null,
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
      admitted_verdict_accuracy: ratio(rows.filter((row) => row.verdict_correct).length, total),
      candidate_verdict_accuracy: ratio(rows.filter((row) => row.candidate_verdict_correct).length, total),
      k_sample_stability: ratio(stableGroups, groups.length),
      diagnostics: rows.flatMap((row) => row.diagnostics)
    });
  }

  const baseline = byRoute.get("route.direct_smt");
  const lifted = byRoute.get("route.single_ir");
  const liftTable = [
    "target_syntax_validity",
    "admission_rate",
    "admitted_verdict_accuracy",
    "k_sample_stability"
  ].map((metric) => ({
    metric,
    baseline: baseline[metric],
    lifted: lifted[metric],
    delta: subtractRatio(lifted[metric], baseline[metric])
  }));

  return { rawRows, routeMetrics: [...byRoute.values()], liftTable, ioRecords, liveCalls };
}

function buildDirectSmtAudit(ioRecords) {
  const directRecords = ioRecords.filter((record) => record.route_id === "route.direct_smt");
  const sampleCount = directRecords.length;
  const exactTemplateMatches = directRecords.filter((record) => {
    const response = record.response.trim();
    const conflictTemplate = [
      "(set-logic QF_UF)",
      "(set-option :print-success false)",
      "(declare-const |pos:act.administer:drug.abx_a| Bool)",
      "(assert |pos:act.administer:drug.abx_a|)",
      "(assert (not |pos:act.administer:drug.abx_a|))",
      "(check-sat)"
    ].join("\n");
    const nullTemplate = [
      "(set-logic QF_LRA)",
      "(set-option :print-success false)",
      "(declare-const |q.age_years| Real)",
      "(assert (>= |q.age_years| 18))",
      "(assert (< |q.age_years| 18))",
      "(check-sat)"
    ].join("\n");
    return response === conflictTemplate || response === nullTemplate;
  }).length;
  const missingNamedAssertions = directRecords.filter((record) => !/:named/.test(record.response)).length;
  const negatedSepsisAssertions = directRecords.filter((record) => /\(assert\s+\(not\s+\|cond\.sepsis\|\)\)/.test(record.response)).length;
  return {
    artifact_kind: "DirectSmtResidualAudit",
    scope: "non_admission_audit",
    sample_count: sampleCount,
    exact_template_match_rate: ratio(exactTemplateMatches, sampleCount),
    missing_named_assertion_rate: ratio(missingNamedAssertions, sampleCount),
    negated_sepsis_assertion_rate: ratio(negatedSepsisAssertions, sampleCount),
    interpretation: "Direct SMT admitted verdict accuracy is a verdict-pattern score in this one-shot harness; this audit records residual source-grounding and traceability gaps that must be closed by IR-mediated routes or a stricter target verifier."
  };
}

function buildTrace(artifactsByDoc, groupResults, finding, nullResult, realGuidelineIntake) {
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
  if (realGuidelineIntake) {
    nodes.push({ id: realGuidelineIntake.artifact_id, kind: "real_guideline_source_intake" });
    edges.push({ from: realGuidelineIntake.artifact_id, to: "artifact.report.json", op: "render_source_intake" });
  }

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
  const rawRows = report.metrics.raw_rows.map((row) => `| ${row.route_id} | ${row.group_id} | ${row.seed} | ${row.syntax_valid} | ${row.admitted} | ${row.verdict} | ${row.verdict_correct} | ${row.candidate_verdict_correct} |`).join("\n");
  const diagnostics = Object.entries(report.diagnostics_summary).map(([code, count]) => `- ${code}: ${count}`).join("\n") || "- none: 0";
  const directMetric = report.metrics.route_metrics.find((entry) => entry.route_id === "route.direct_smt");
  const irMetric = report.metrics.route_metrics.find((entry) => entry.route_id === "route.single_ir");
  const irConclusion = irMetric.admission_rate.numerator > 0
    ? `The IR route produced ${irMetric.admission_rate.exact} admitted rows; admitted verdict accuracy is ${irMetric.admitted_verdict_accuracy.exact}.`
    : `The IR route produced no admitted rows in this live run; candidate verdicts are reported only as rejected model outputs.`;
  const comparisonConclusion = directMetric.admitted_verdict_accuracy.numerator >= irMetric.admitted_verdict_accuracy.numerator
    ? `Optimized direct SMT reached ${directMetric.target_syntax_validity.exact} target syntax validity, ${directMetric.admission_rate.exact} admission, and ${directMetric.admitted_verdict_accuracy.exact} admitted verdict accuracy on this locked fixture. This live run no longer demonstrates an IR lift over direct SMT; the remaining IR case must be shown by source-grounded admission, trace completeness, reuse, and harder measurements rather than by the old malformed-direct baseline.`
    : `The optimized direct SMT baseline remains below the IR route on admitted verdict accuracy for this locked fixture.`;
  const directAudit = report.direct_smt_audit;
  const directAuditConclusion = `Direct SMT residual audit: exact template matches ${directAudit.exact_template_match_rate.exact}; rows without named assertions ${directAudit.missing_named_assertion_rate.exact}; rows asserting negated sepsis ${directAudit.negated_sepsis_assertion_rate.exact}. This audit is non-admission evidence that the optimized direct verdict score is not yet a source-grounded trace-quality result.`;
  const realGuidelineRows = report.real_guideline_intake.sources.map((source) => `| ${source.id} | ${source.license_label} | ${source.raw_cache_status} | ${source.candidate_span_count} | ${source.guideline_relation} |`).join("\n");
  return `# CKC one-shot M1-M2 research report

Run: \`${report.run_id}\`

Scope: research harness; synthetic fixture measurement. The M1 spine is source-grounded and verifier-checked by the one-shot symbolic verifier; model-route rows are admitted only under the route checks reported below. This report makes no clinical, patient-care, deployment, or regulatory claim.
Route verdict accuracy below is admitted verdict accuracy. Candidate verdict accuracy is shown only to audit rejected model outputs.

## M1 spine result

- Finding: \`${report.findings[0].finding_id}\` / \`${report.findings[0].conflict_kind}\`
- Core: ${report.findings[0].assertion_core.map((entry) => `\`${entry}\``).join(", ")}
- Documented null result: \`${report.null_results[0].null_result_id}\` / ${report.null_results[0].reason}
- Replay status: ${report.replay.status}

## Quoted source spans

${report.findings[0].quoted_spans.map((span) => `- \`${span.region_id}\`: ${span.text}`).join("\n")}
- \`${report.null_results[0].quoted_spans[1].region_id}\`: ${report.null_results[0].quoted_spans[1].text}

## Real guideline source intake

Scope: source-intake candidate evidence only. These real Japanese guideline sources are fetched and permission-recorded for PoC extraction work, but they are not part of the locked M1/M2 solver score and make no clinical recommendation claim here.

| Source | License | Raw cache | Candidate spans | Relation |
| --- | --- | --- | ---: | --- |
${realGuidelineRows}

## M2 lift table

| Metric | direct_smt | single_ir | delta |
| --- | ---: | ---: | ---: |
${liftRows}

${comparisonConclusion}

${directAuditConclusion}

${irConclusion}

## Raw route rows

| Route | Group | Seed | Syntax valid | Admitted | Verdict | Admitted correct | Candidate correct |
| --- | --- | ---: | --- | --- | --- | --- | --- |
${rawRows}

## Failure taxonomy

${diagnostics}

## Model route identity

- Model identity: ${report.model_identity}
- Runtime: ${report.model_runtime}
- Live model calls: ${report.live_model_calls}
`;
}

function japaneseReport(report) {
  const liftRows = report.metrics.lift_table.map((row) => `| ${row.metric} | ${row.baseline.exact} | ${row.lifted.exact} | ${row.delta.exact} |`).join("\n");
  const directMetric = report.metrics.route_metrics.find((entry) => entry.route_id === "route.direct_smt");
  const irMetric = report.metrics.route_metrics.find((entry) => entry.route_id === "route.single_ir");
  const irConclusion = irMetric.admission_rate.numerator > 0
    ? `IR route は ${irMetric.admission_rate.exact} 行を admitted とした。admitted verdict accuracy は ${irMetric.admitted_verdict_accuracy.exact}。`
    : "この live run では IR route の admitted 行は 0。candidate verdict は rejected model output の監査情報としてのみ扱う。";
  const comparisonConclusion = directMetric.admitted_verdict_accuracy.numerator >= irMetric.admitted_verdict_accuracy.numerator
    ? `最適化した direct SMT はこの locked fixture で target syntax ${directMetric.target_syntax_validity.exact}、admission ${directMetric.admission_rate.exact}、admitted verdict accuracy ${directMetric.admitted_verdict_accuracy.exact} に達した。この live run は direct SMT に対する IR lift を示さない。残る IR の必要性は、旧 direct baseline の構文失敗ではなく、source-grounded admission、trace completeness、reuse、より難しい測定で示す必要がある。`
    : "最適化した direct SMT baseline は、この locked fixture の admitted verdict accuracy で IR route を下回った。";
  const directAudit = report.direct_smt_audit;
  const directAuditConclusion = `Direct SMT residual audit: exact template match ${directAudit.exact_template_match_rate.exact}、named assertion なし ${directAudit.missing_named_assertion_rate.exact}、negated sepsis assertion ${directAudit.negated_sepsis_assertion_rate.exact}。これは admission 判定外の監査情報であり、最適化した direct verdict score が source-grounded trace quality をまだ示していないことを記録する。`;
  const realGuidelineRows = report.real_guideline_intake.sources.map((source) => `| ${source.id} | ${source.license_label} | ${source.raw_cache_status} | ${source.candidate_span_count} |`).join("\n");
  return `# CKC one-shot M1-M2 研究レポート

run: \`${report.run_id}\`

範囲: research harness、synthetic fixture measurement。M1 spine は source-grounded で one-shot symbolic verifier により verifier-checked。model-route 行は下記の route checks でのみ admitted とする。このレポートは臨床、患者ケア、導入、規制上の主張をしない。route verdict accuracy は admitted verdict accuracy として扱う。

## M1 spine

- finding: \`${report.findings[0].finding_id}\` / \`${report.findings[0].conflict_kind}\`
- documented null result: \`${report.null_results[0].null_result_id}\` / ${report.null_results[0].reason}
- replay status: ${report.replay.status}

## 引用スパン

${report.findings[0].quoted_spans.map((span) => `- \`${span.region_id}\`: ${span.text}`).join("\n")}
- \`${report.null_results[0].quoted_spans[1].region_id}\`: ${report.null_results[0].quoted_spans[1].text}

## 実ガイドライン source intake

範囲: source-intake candidate evidence のみ。実在する日本語診療ガイドライン系ソースを PoC 抽出候補として fetch/permission 記録したが、M1/M2 の locked score には含めず、ここでは臨床推奨の主張をしない。

| source | license | raw cache | candidate spans |
| --- | --- | --- | ---: |
${realGuidelineRows}

## M2 lift table

| metric | direct_smt | single_ir | delta |
| --- | ---: | ---: | ---: |
${liftRows}

${comparisonConclusion}

${directAuditConclusion}

${irConclusion}
`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}

function escapePre(value) {
  return escapeHtml(String(value).replaceAll("\t", "  ").replace(/[ ]+$/gm, ""));
}

function renderBasicUi(data) {
  const report = data.report;
  const direct = data.route_metrics.find((entry) => entry.route_id === "route.direct_smt");
  const single = data.route_metrics.find((entry) => entry.route_id === "route.single_ir");
  const irConclusion = single.admission_rate.numerator > 0
    ? `IR route admitted ${single.admission_rate.exact}; admitted accuracy ${single.admitted_verdict_accuracy.exact}.`
    : "IR route produced no admitted rows; rejected candidate verdicts are audit data only.";
  const comparisonConclusion = direct.admitted_verdict_accuracy.numerator >= single.admitted_verdict_accuracy.numerator
    ? `Optimized direct SMT is ${direct.admitted_verdict_accuracy.exact} on admitted accuracy here, so this run does not show IR lift yet.`
    : `Optimized direct SMT remains below IR admitted accuracy here.`;
  const directAudit = data.direct_smt_audit;
  const directAuditConclusion = `Direct audit: exact templates ${directAudit.exact_template_match_rate.exact}; no named assertions ${directAudit.missing_named_assertion_rate.exact}; negated sepsis ${directAudit.negated_sepsis_assertion_rate.exact}.`;
  const routeRows = data.route_metrics.map((entry) => `
          <tr>
            <td><code>${escapeHtml(entry.route_id)}</code></td>
            <td>${escapeHtml(entry.target_syntax_validity.exact)}</td>
            <td>${escapeHtml(entry.admission_rate.exact)}</td>
            <td>${escapeHtml(entry.admitted_verdict_accuracy.exact)}</td>
            <td>${escapeHtml(entry.candidate_verdict_accuracy.exact)}</td>
            <td>${escapeHtml(entry.k_sample_stability.exact)}</td>
          </tr>`).join("");
  const rawRows = data.raw_rows.map((row) => `
          <tr>
            <td><code>${escapeHtml(row.route_id)}</code></td>
            <td><code>${escapeHtml(row.group_id)}</code></td>
            <td>${escapeHtml(row.seed)}</td>
            <td>${row.syntax_valid ? "yes" : "no"}</td>
            <td>${row.admitted ? "yes" : "no"}</td>
            <td>${escapeHtml(row.verdict)}</td>
            <td>${row.verdict_correct ? "yes" : "no"}</td>
            <td>${row.candidate_verdict_correct ? "yes" : "no"}</td>
            <td>${escapeHtml(row.diagnostics.join(", ") || "none")}</td>
          </tr>`).join("");
  const realGuideline = data.real_guideline_intake;
  const realGuidelineRows = realGuideline.sources.map((source) => `
          <tr>
            <td><code>${escapeHtml(source.id)}</code></td>
            <td>${escapeHtml(source.title_ja)}</td>
            <td>${escapeHtml(source.license.label)}</td>
            <td>${escapeHtml(source.raw_cache_status)}</td>
            <td>${escapeHtml(source.candidate_spans.length)}</td>
            <td>${escapeHtml(source.guideline_relation)}</td>
          </tr>`).join("");
  const realGuidelineDetails = realGuideline.sources.map((source) => {
    const spans = source.candidate_spans.map((span) => `
          <tr>
            <td><code>${escapeHtml(span.region_id)}</code></td>
            <td>${escapeHtml(span.cq_id)}</td>
            <td>${escapeHtml(span.machine_hint.direction)}</td>
            <td>${escapeHtml(span.machine_hint.action)}</td>
            <td>${escapeHtml(span.quote)}</td>
          </tr>`).join("");
    const rawArtifacts = source.raw_artifacts.map((artifact) => `
          <tr>
            <td><code>${escapeHtml(artifact.artifact_id)}</code></td>
            <td>${escapeHtml(artifact.kind)}</td>
            <td>${escapeHtml(artifact.cache_status)}</td>
            <td>${escapeHtml(artifact.sha256 ?? "not fetched")}</td>
          </tr>`).join("");
    return `
        <details>
          <summary><code>${escapeHtml(source.id)}</code> / ${escapeHtml(source.title_ja)}</summary>
          <h3>Selected candidate spans</h3>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Region</th><th>CQ</th><th>Direction</th><th>Action hint</th><th>Source span</th></tr></thead>
              <tbody>${spans}
              </tbody>
            </table>
          </div>
          <h3>Raw cache</h3>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Artifact</th><th>Kind</th><th>Status</th><th>SHA-256</th></tr></thead>
              <tbody>${rawArtifacts}
              </tbody>
            </table>
          </div>
        </details>`;
  }).join("").trimStart();
  const ioBlocks = data.model_io.map((record) => {
    const sourceCalls = record.source_calls
      ? [
          "          <h3>Source-local calls</h3>",
          ...record.source_calls.map((call) => `          <pre>${escapePre(JSON.stringify({ label: call.label, prompt: call.prompt, response: call.response }, null, 2))}</pre>`)
        ].join("\n")
      : "";
    return [
      "        <details>",
      `          <summary><code>${escapeHtml(record.route_id)}</code> / <code>${escapeHtml(record.group_id)}</code> / seed ${escapeHtml(record.seed)} / ${record.row.admitted ? "admitted" : "not admitted"}</summary>`,
      "          <h3>Prompt</h3>",
      `          <pre>${escapePre(record.prompt)}</pre>`,
      sourceCalls,
      "          <h3>Response</h3>",
      `          <pre>${escapePre(record.response)}</pre>`,
      "          <h3>Scored row</h3>",
      `          <pre>${escapePre(JSON.stringify(record.row, null, 2))}</pre>`,
      "        </details>"
    ].filter(Boolean).join("\n");
  }).join("");
  const finding = report.findings[0];
  const nullResult = report.null_results[0];

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CKC live local model run</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f2f5f7;
      --surface: #fff;
      --line: #d6dee5;
      --ink: #17212b;
      --muted: #64727f;
      --ok: #126f54;
      --warn: #8a5b00;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 15px;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--ink); }
    main { max-width: 1180px; margin: 0 auto; padding: 18px; }
    header, section { border: 1px solid var(--line); border-radius: 6px; background: var(--surface); margin-bottom: 12px; }
    header { padding: 16px; }
    section { padding: 14px; }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: 1.15rem; }
    h2 { font-size: .98rem; margin-bottom: 8px; }
    h3 { font-size: .86rem; margin: 10px 0 6px; }
    p { color: var(--muted); margin-top: 4px; line-height: 1.4; }
    code, pre { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; font-size: .82rem; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 280px; overflow: auto; margin: 0; padding: 10px; border: 1px solid var(--line); border-radius: 6px; background: #101820; color: #eef6f4; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
    .chip { display: inline-flex; align-items: center; min-height: 28px; border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; background: #f7fafb; color: var(--muted); font-size: .8rem; }
    .chip.ok { color: var(--ok); background: #e4f2ec; border-color: #b9ddcf; }
    .chip.warn { color: var(--warn); background: #fff1cf; border-color: #e7cf91; }
    .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .metric { border: 1px solid var(--line); border-radius: 6px; padding: 12px; }
    .metric strong { display: block; font-size: 1.45rem; line-height: 1; }
    .metric span { display: block; color: var(--muted); margin-top: 6px; font-size: .82rem; }
    table { width: 100%; border-collapse: collapse; min-width: 720px; }
    .wide { min-width: 920px; }
    th, td { border-bottom: 1px solid var(--line); padding: 8px; text-align: left; vertical-align: top; font-size: .82rem; }
    th { color: var(--muted); background: #f7fafb; }
    .table-wrap { overflow-x: auto; }
    .quote { border-left: 3px solid var(--ok); background: #e4f2ec; padding: 8px 10px; margin-top: 8px; line-height: 1.45; }
    details { border: 1px solid var(--line); border-radius: 6px; padding: 9px 10px; margin-top: 8px; }
    summary { cursor: pointer; }
    @media (max-width: 760px) {
      main { padding: 10px; }
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>CKC live local model run</h1>
      <p>Basic fixture-scale UI for the current weak local model experiment. This is a research harness view over synthetic fixtures; it makes no clinical, patient-care, deployment, or regulatory claim.</p>
      <div class="chips">
        <span class="chip ok">run ${escapeHtml(report.run_id)}</span>
        <span class="chip ok">${escapeHtml(report.model_mode)}</span>
        <span class="chip warn">live model calls: ${escapeHtml(report.live_model_calls)}</span>
        <span class="chip">${escapeHtml(report.model_identity)}</span>
      </div>
    </header>

    <section>
      <h2>Summary</h2>
      <div class="grid">
        <div class="metric"><strong>${escapeHtml(report.findings.length)}</strong><span>finding: ${escapeHtml(finding.conflict_kind)}</span></div>
        <div class="metric"><strong>${escapeHtml(report.null_results.length)}</strong><span>null result: ${escapeHtml(nullResult.reason)}</span></div>
        <div class="metric"><strong>${escapeHtml(`${direct.admitted_verdict_accuracy.exact} -> ${single.admitted_verdict_accuracy.exact}`)}</strong><span>admitted verdict accuracy</span></div>
      </div>
      <p>${escapeHtml(comparisonConclusion)}</p>
      <p>${escapeHtml(directAuditConclusion)}</p>
      <p>${escapeHtml(irConclusion)}</p>
    </section>

    <section>
      <h2>M1 evidence</h2>
      <p><code>${escapeHtml(finding.finding_id)}</code> / <code>${escapeHtml(nullResult.null_result_id)}</code></p>
      ${finding.quoted_spans.map((span) => `<div class="quote"><code>${escapeHtml(span.region_id)}</code>: ${escapeHtml(span.text)}</div>`).join("")}
      <div class="quote"><code>${escapeHtml(nullResult.quoted_spans[1].region_id)}</code>: ${escapeHtml(nullResult.quoted_spans[1].text)}</div>
    </section>

    <section>
      <h2>Real guideline intake</h2>
      <p>Permission-recorded source candidates fetched for PoC extraction work. These rows are not included in the locked M1/M2 score and make no clinical recommendation claim.</p>
      <div class="table-wrap">
        <table class="wide">
          <thead><tr><th>Source</th><th>Title</th><th>License</th><th>Raw cache</th><th>Spans</th><th>Relation</th></tr></thead>
          <tbody>${realGuidelineRows}
          </tbody>
        </table>
      </div>
      ${realGuidelineDetails}
    </section>

    <section>
      <h2>Route metrics</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Route</th><th>Syntax</th><th>Admission</th><th>Admitted accuracy</th><th>Candidate accuracy</th><th>Stability</th></tr></thead>
          <tbody>${routeRows}
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>Raw rows</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Route</th><th>Group</th><th>Seed</th><th>Syntax</th><th>Admitted</th><th>Verdict</th><th>Admitted correct</th><th>Candidate correct</th><th>Diagnostics</th></tr></thead>
          <tbody>${rawRows}
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>Model I/O</h2>
      ${ioBlocks}
    </section>
  </main>
</body>
</html>
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

async function modelMetadata(liveCalls) {
  if (!liveModel) {
    return {
      model_identity: "recorded.unavailable.no_mock_route_output",
      model_runtime: "deterministic-js-run-builder-only",
      live_model_calls: 0,
      model_mode: "recorded_unsupported"
    };
  }
  requireLiveModelReady();
  const version = spawnSync(llamaCliPath, ["--version"], { encoding: "utf8" });
  const versionText = `${version.stdout ?? ""}${version.stderr ?? ""}`.trim().split("\n")[0] || "llama.cpp unknown";
  const modelHash = sha256Bytes(await readFile(modelPath));
  return {
    model_identity: `${modelName}:${modelHash.slice(0, 16)}`,
    model_runtime: versionText,
    live_model_calls: liveCalls,
    model_mode: "live_local_llama_cpp",
    model_path: path.relative(root, modelPath),
    llama_cli: path.relative(root, llamaCliPath)
  };
}

async function main() {
  if (liveModel) requireLiveModelReady();
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

  const realGuidelineIntake = await buildRealGuidelineIntake();
  await writeJson("real_guidelines/source_intake.json", realGuidelineIntake);

  const finding = buildFinding(groupResults.find((entry) => entry.compiled.group_id === "group.m1_conflict"), artifactsByDoc);
  const nullResult = buildNullResult(groupResults.find((entry) => entry.compiled.group_id === "group.m1_null"), artifactsByDoc);
  const traceBundle = buildTrace(artifactsByDoc, groupResults, finding, nullResult, realGuidelineIntake);
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
  const directSmtAudit = buildDirectSmtAudit(metrics.ioRecords);
  const modelMeta = await modelMetadata(metrics.liveCalls);
  for (const record of metrics.ioRecords) {
    await writeJson(`model_io/${record.route_id}/${record.group_id}/seed-${record.seed}.json`, record);
  }
  await writeJson("metrics/raw_rows.json", metrics.rawRows);
  await writeJson("metrics/route_metrics.json", metrics.routeMetrics);
  await writeJson("metrics/lift_table.json", metrics.liftTable);
  await writeJson("metrics/direct_smt_audit.json", directSmtAudit);

  const diagnosticsSummary = {};
  for (const row of metrics.rawRows) {
    for (const diagnostic of row.diagnostics) diagnosticsSummary[diagnostic] = (diagnosticsSummary[diagnostic] ?? 0) + 1;
  }

  const report = {
    artifact_kind: "Report",
    run_id: runId,
    generated_by: "tools/build-run.mjs",
    experiments: ["exp.m1_spine", "exp.m2_lift"],
    corpus_hash: sha256({
      synthetic_fixtures: fixtureRegistry.map((fixture) => ({ id: fixture.id, path: fixture.path })),
      real_guidelines: realGuidelineIntake.registry_hash
    }),
    lexicon_hash: sha256(["pop.adult", "pop.child", "cond.sepsis", "cond.renal_severe", "cond.pregnancy", "drug.abx_a"]),
    solver_identity: "one-shot-js-symbolic-verifier",
    model_identity: modelMeta.model_identity,
    model_runtime: modelMeta.model_runtime,
    model_mode: modelMeta.model_mode,
    model_path: modelMeta.model_path ?? null,
    llama_cli: modelMeta.llama_cli ?? null,
    live_model_calls: modelMeta.live_model_calls,
    findings: [finding],
    null_results: [nullResult],
    diagnostics_summary: diagnosticsSummary,
    metrics: {
      raw_rows: metrics.rawRows,
      route_metrics: metrics.routeMetrics,
      lift_table: metrics.liftTable
    },
    direct_smt_audit: directSmtAudit,
    real_guideline_intake: {
      artifact_id: realGuidelineIntake.artifact_id,
      registry_path: realGuidelineIntake.registry_path,
      registry_hash: realGuidelineIntake.registry_hash,
      raw_manifest_path: realGuidelineIntake.raw_manifest_path,
      raw_manifest_hash: realGuidelineIntake.raw_manifest_hash,
      source_count: realGuidelineIntake.source_count,
      candidate_span_count: realGuidelineIntake.candidate_span_count,
      admission_scope: realGuidelineIntake.admission_scope,
      scoring_scope: realGuidelineIntake.scoring_scope,
      clinical_claim_scope: realGuidelineIntake.clinical_claim_scope,
      sources: realGuidelineIntake.sources.map((source) => ({
        id: source.id,
        title_ja: source.title_ja,
        license_label: source.license.label,
        license_url: source.license.url,
        raw_cache_status: source.raw_cache_status,
        candidate_span_count: source.candidate_spans.length,
        guideline_relation: source.guideline_relation,
        landing_url: source.access.landing_url,
        doi: source.access.doi
      }))
    },
    replay: {
      status: "pending_manifest",
      deterministic_inputs: [
        "corpus/fixtures",
        "corpus/gold/m1_expected.json",
        "registry",
        "corpus/real_guidelines/japanese_guidelines.json",
        ...(realGuidelineIntake.raw_manifest_hash ? ["corpus/raw/real-guidelines/manifest.json"] : [])
      ]
    },
    wording_scope: [
      "research harness",
      "source-grounded",
      "schema-valid",
      "verifier-checked",
      "replayable",
      "locked measurement",
      "synthetic fixture measurement",
      "real guideline source intake candidate",
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
    model_mode: modelMeta.model_mode,
    model_identity: modelMeta.model_identity,
    model_runtime: modelMeta.model_runtime,
    experiments: report.experiments,
    fixture_ids: fixtureRegistry.map((fixture) => fixture.id),
    real_guideline_source_ids: realGuidelineIntake.sources.map((source) => source.id),
    real_guideline_intake_hash: sha256(realGuidelineIntake),
    route_ids: ["route.direct_smt", "route.single_ir"],
    report_hash: sha256(report)
  };
  await writeJson("manifest.json", manifest);

  const events = [
    { event: "run_started", run_id: runId },
    { event: "real_guideline_intake_completed", outcome: "ok", sources: realGuidelineIntake.source_count, candidate_spans: realGuidelineIntake.candidate_span_count },
    { event: "m1_spine_completed", outcome: "ok" },
    { event: "m2_lift_completed", outcome: "ok", model_mode: modelMeta.model_mode, live_model_calls: modelMeta.live_model_calls },
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
    direct_smt_audit: directSmtAudit,
    real_guideline_intake: realGuidelineIntake,
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
  await writeFile(webDataPath, renderBasicUi(stable(uiData)));

  if (verifyMode) {
    const direct = metrics.routeMetrics.find((entry) => entry.route_id === "route.direct_smt");
    const single = metrics.routeMetrics.find((entry) => entry.route_id === "route.single_ir");
    const requiredFiles = [
      "report.json",
      "report.md",
      "report.ja.md",
      "trace_bundle.json",
      "lineage_index.json",
      "real_guidelines/source_intake.json",
      "metrics/raw_rows.json",
      "metrics/direct_smt_audit.json",
      "model_io/route.direct_smt/group.m1_conflict/seed-11.json"
    ];
    const commonAssertions = [
      finding?.conflict_kind === "deontic_direction_conflict",
      nullResult?.classification === "documented_null_result",
      direct.samples === 6,
      single.samples === 6,
      metrics.rawRows.length === 12,
      metrics.ioRecords.length === 12,
      realGuidelineIntake.source_count >= 2,
      realGuidelineIntake.candidate_span_count >= 6,
      report.real_guideline_intake.scoring_scope === "not_in_locked_m1_m2_measurement",
      existsSync(webDataPath),
      ...requiredFiles.map((relative) => existsSync(path.join(runDir, relative)))
    ];
    const modelAssertions = liveModel
      ? [
          report.model_mode === "live_local_llama_cpp",
          report.live_model_calls === metrics.liveCalls,
          metrics.ioRecords.every((record) => record.subprocess?.exit_status === 0),
          metrics.ioRecords.every((record) => record.response_hash && record.response_hash.length === 64),
          direct.target_syntax_validity.exact === "6/6",
          direct.admission_rate.exact === "6/6",
          direct.admitted_verdict_accuracy.exact === "6/6",
          direct.candidate_verdict_accuracy.exact === "6/6",
          direct.k_sample_stability.exact === "2/2",
          report.direct_smt_audit.exact_template_match_rate.exact === "0/6",
          report.direct_smt_audit.missing_named_assertion_rate.exact === "6/6",
          report.direct_smt_audit.negated_sepsis_assertion_rate.exact === "6/6",
          single.target_syntax_validity.exact === "6/6",
          single.admission_rate.exact === "0/6",
          single.admitted_verdict_accuracy.exact === "0/6",
          single.candidate_verdict_accuracy.exact === "3/6",
          single.k_sample_stability.exact === "0/2"
        ]
      : [
          report.model_mode === "recorded_unsupported",
          report.live_model_calls === 0,
          direct.target_syntax_validity.exact === "0/6",
          direct.admission_rate.exact === "0/6",
          direct.admitted_verdict_accuracy.exact === "0/6",
          single.target_syntax_validity.exact === "0/6",
          single.admission_rate.exact === "0/6",
          single.admitted_verdict_accuracy.exact === "0/6"
        ];
    const assertions = [...commonAssertions, ...modelAssertions];
    if (assertions.some((entry) => !entry)) {
      throw new Error("one-shot verification failed");
    }
  }

  console.log(JSON.stringify({
    run_dir: path.relative(root, runDir),
    ui: path.relative(root, webDataPath),
    model_mode: report.model_mode,
    live_model_calls: report.live_model_calls,
    findings: report.findings.length,
    null_results: report.null_results.length,
    direct_smt_admitted_accuracy: metrics.routeMetrics.find((entry) => entry.route_id === "route.direct_smt").admitted_verdict_accuracy.exact,
    single_ir_admitted_accuracy: metrics.routeMetrics.find((entry) => entry.route_id === "route.single_ir").admitted_verdict_accuracy.exact,
    single_ir_candidate_accuracy: metrics.routeMetrics.find((entry) => entry.route_id === "route.single_ir").candidate_verdict_accuracy.exact,
    verified: verifyMode
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
