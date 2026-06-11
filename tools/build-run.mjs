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
const corporaRegistryPath = path.join(root, "registry", "corpora.json");
const experimentsRegistryPath = path.join(root, "registry", "experiments.json");
const fixtureSemanticsPath = path.join(root, "corpus", "fixtures", "m1_fixture_semantics.json");
const goldExpectationsPath = path.join(root, "corpus", "gold", "m1_expected.json");
const realGuidelineRegistryPath = path.join(root, "corpus", "real_guidelines", "japanese_guidelines.json");
const realGuidelineRawManifestPath = path.join(root, "corpus", "raw", "real-guidelines", "manifest.json");
const verifyMode = process.argv.includes("--verify");
const recordedModel = process.argv.includes("--recorded-model");
const liveModel = process.argv.includes("--live-model") || !recordedModel;
const llamaCliPath = process.env.CKC_LLAMA_CLI ?? path.join(root, ".local", "bin", "llama-cli");
const modelPath = process.env.CKC_MODEL_PATH ?? path.join(root, ".local", "models", "qwen2.5-0.5b-instruct-q2_k.gguf");
const modelName = process.env.CKC_MODEL_NAME ?? "Qwen2.5-0.5B-Instruct-Q2_K";
const modelTimeoutMs = Number(process.env.CKC_MODEL_TIMEOUT_MS ?? "120000");

let fixtureRegistry = [];
let m1Groups = [];
let groups = [];
let routeIds = ["route.direct_smt", "route.single_ir"];
let sampleSeeds = [11, 22, 33];
let m1InputRefs = null;

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

function sha256Text(value) {
  return sha256Bytes(Buffer.from(String(value), "utf8"));
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

function cloneData(value) {
  return JSON.parse(JSON.stringify(value));
}

async function readJsonArtifact(absolutePath) {
  return JSON.parse(await readFile(absolutePath, "utf8"));
}

function expectUniqueById(entries, label) {
  const byId = new Map();
  for (const entry of entries ?? []) {
    if (!entry?.id) throw new Error(`${label} entry missing id`);
    if (byId.has(entry.id)) throw new Error(`${label} duplicate id: ${entry.id}`);
    byId.set(entry.id, entry);
  }
  return byId;
}

async function loadM1FixtureInputs() {
  const corporaRegistry = await readJsonArtifact(corporaRegistryPath);
  const fixtureSemantics = await readJsonArtifact(fixtureSemanticsPath);
  const experimentsRegistry = await readJsonArtifact(experimentsRegistryPath);
  const goldExpectations = await readJsonArtifact(goldExpectationsPath);
  const corpusFixturesById = expectUniqueById(corporaRegistry.fixtures, "corpus fixture");
  const semanticsById = expectUniqueById(fixtureSemantics.fixtures, "fixture semantics");

  fixtureRegistry = (corporaRegistry.fixtures ?? []).map((corpusFixture) => {
    const semantics = semanticsById.get(corpusFixture.id);
    if (!semantics) throw new Error(`fixture semantics missing: ${corpusFixture.id}`);
    return {
      ...cloneData(corpusFixture),
      key: semantics.key,
      source_label: semantics.source_label,
      title: semantics.title,
      report_primary_region_ids: cloneData(semantics.report_primary_region_ids ?? []),
      regions: cloneData(semantics.regions ?? []),
      terminology_bindings: cloneData(semantics.terminology_bindings ?? []),
      clinical_statements: cloneData(semantics.clinical_statements ?? []),
      rules: cloneData(semantics.rules ?? [])
    };
  });

  for (const semanticFixture of fixtureSemantics.fixtures ?? []) {
    if (!corpusFixturesById.has(semanticFixture.id)) {
      throw new Error(`fixture semantics references unknown corpus fixture: ${semanticFixture.id}`);
    }
  }

  const experimentsById = expectUniqueById(experimentsRegistry.experiments, "experiment");
  const m1Experiment = experimentsById.get("exp.m1_spine");
  const m2Experiment = experimentsById.get("exp.m2_lift");
  if (!m1Experiment) throw new Error("experiment missing: exp.m1_spine");
  if (!m2Experiment) throw new Error("experiment missing: exp.m2_lift");

  const goldByGroup = new Map((goldExpectations ?? []).map((entry) => [entry.group_id, entry]));
  function loadGroupSpec(group, label) {
    const gold = goldByGroup.get(group.id);
    if (!gold) throw new Error(`gold expectation missing: ${group.id}`);
    for (const fixtureId of group.fixtures ?? []) {
      if (!corpusFixturesById.has(fixtureId)) throw new Error(`${label} ${group.id} references unknown fixture: ${fixtureId}`);
    }
    return {
      id: group.id,
      fixtures: cloneData(group.fixtures),
      measurementRole: group.measurement_role ?? (group.id.startsWith("group.m2") ? "holdout_mutation" : "locked_m1_fixture"),
      mutationNote: group.mutation_note ?? null,
      expectedOutcome: gold.expected_outcome,
      expectedConflictKind: gold.expected_conflict_kind ?? null,
      expectedCore: cloneData(gold.expected_core ?? []),
      expectedNullResult: Boolean(gold.expected_null_result)
    };
  }

  m1Groups = (m1Experiment.fixture_groups ?? []).map((group) => loadGroupSpec(group, "M1 group"));
  const m2EvaluationGroups = m2Experiment.evaluation_groups ?? m1Experiment.fixture_groups ?? [];
  groups = m2EvaluationGroups.map((group) => loadGroupSpec(group, "M2 evaluation group"));

  routeIds = cloneData(m2Experiment.routes ?? routeIds);
  sampleSeeds = cloneData(m2Experiment.sample_seeds ?? sampleSeeds);
  m1InputRefs = {
    corpora_registry_path: path.relative(root, corporaRegistryPath),
    corpora_registry_hash: sha256(corporaRegistry),
    fixture_semantics_path: path.relative(root, fixtureSemanticsPath),
    fixture_semantics_hash: sha256(fixtureSemantics),
    experiments_registry_path: path.relative(root, experimentsRegistryPath),
    experiments_registry_hash: sha256(experimentsRegistry),
    gold_expectations_path: path.relative(root, goldExpectationsPath),
    gold_expectations_hash: sha256(goldExpectations)
  };
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

const realSourceScope = "source_intake_candidate_only";
const realRouteSchemaId = "schema.real_source_route_rule_candidate.v0";
const realCertaintyMap = {
  A: "high",
  B: "moderate",
  C: "low",
  D: "very_low"
};

function sourceHashForRealGuideline(source, rawArtifacts) {
  return sha256({
    id: source.id,
    title_ja: source.title_ja,
    title_en: source.title_en,
    source_family: source.source_family,
    guideline_relation: source.guideline_relation,
    publisher: source.publisher,
    journal: source.journal,
    publication: source.publication,
    access: source.access,
    raw_artifacts: rawArtifacts.map((artifact) => ({
      artifact_id: artifact.artifact_id,
      kind: artifact.kind,
      url: artifact.url,
      path: artifact.path,
      sha256: artifact.sha256
    })),
    candidate_spans: source.candidate_spans.map((span) => ({
      region_id: span.region_id,
      locator: span.locator,
      cq_id: span.cq_id,
      quote_hash: sha256Bytes(Buffer.from(span.quote)),
      machine_hint: span.machine_hint
    }))
  });
}

function permissionHashForRealGuideline(source) {
  return sha256({
    id: source.id,
    access: source.access,
    license: source.license,
    raw_artifacts: source.raw_artifacts.map((artifact) => ({
      artifact_id: artifact.artifact_id,
      kind: artifact.kind,
      url: artifact.url,
      path: artifact.path
    }))
  });
}

function realArtifactPath(sourceId, artifactName) {
  return `real_guidelines/artifacts/${sourceId}/${artifactName}.json`;
}

function residualId(sourceId, spanId, code, field = null) {
  return [
    "residual",
    sourceId,
    spanId ?? "source",
    code,
    field
  ].filter(Boolean).join(".");
}

function realCandidateResidual({ sourceId, spanId = null, stage, code, outcome, reason, field = null, value = null, blocksCandidateRule = false, blocksPromotion = true }) {
  return {
    residual_id: residualId(sourceId, spanId, code, field),
    admission_scope: realSourceScope,
    scoring_scope: "not_in_locked_m1_m2_measurement",
    source_id: sourceId,
    region_id: spanId,
    stage,
    code,
    outcome,
    field,
    value,
    reason,
    blocks_candidate_rule: blocksCandidateRule,
    blocks_promotion: blocksPromotion
  };
}

function normalizeCandidateCertainty(value) {
  return realCertaintyMap[value] ?? null;
}

function isSupportedCandidateDirection(value) {
  return ["for", "against", "contraindicate", "require", "permit", "avoid"].includes(value);
}

function isSupportedCandidateStrength(value) {
  return ["strong", "weak"].includes(value);
}

function candidateActionKey(value) {
  if (!value || /_or_|cross_guideline|by_context/.test(value)) return null;
  return `real.action.${value}`;
}

function candidateContextKey(value) {
  if (!value) return null;
  return `real.context.${value}`;
}

function realCandidateRouteRule(source, span, index, ruleId) {
  const hint = span.machine_hint ?? {};
  return {
    rule_id: ruleId,
    source_id: source.id,
    region_id: span.region_id,
    cq_id: span.cq_id,
    scope: realSourceScope,
    direction: hint.direction,
    action_key: candidateActionKey(hint.action),
    strength: hint.strength,
    certainty: normalizeCandidateCertainty(hint.certainty),
    context: {
      population_key: candidateContextKey(hint.population),
      condition_key: candidateContextKey(hint.condition)
    },
    source_region_ids: [span.region_id],
    machine_hint_hash: sha256(hint),
    candidate_order: index + 1
  };
}

function assessRealCandidateSpan(source, span, index, sourceLevelResiduals) {
  const hint = span.machine_hint ?? {};
  const requiredFields = ["population", "condition", "action", "direction", "strength", "certainty"];
  const residuals = [
    realCandidateResidual({
      sourceId: source.id,
      spanId: span.region_id,
      stage: "extract",
      code: "span_grounding_missing",
      outcome: "residual",
      reason: "Candidate quote is grounded to the committed registry locator, but raw-document byte offsets are not established by an extractor.",
      blocksCandidateRule: false
    }),
    realCandidateResidual({
      sourceId: source.id,
      spanId: span.region_id,
      stage: "normalize",
      code: "author_provided_machine_hint",
      outcome: "residual",
      reason: "Normalization fields come from registry machine_hint values rather than an admitted extractor or model route.",
      field: "machine_hint",
      value: Object.keys(hint).sort(),
      blocksCandidateRule: false
    })
  ];

  for (const field of requiredFields) {
    if (hint[field] === undefined || hint[field] === null || hint[field] === "") {
      residuals.push(realCandidateResidual({
        sourceId: source.id,
        spanId: span.region_id,
        stage: "normalize",
        code: "semantic_slot_missing",
        outcome: "residual",
        field,
        reason: `Required candidate field ${field} is missing from machine_hint.`,
        blocksCandidateRule: true
      }));
    }
  }

  if (hint.direction && !isSupportedCandidateDirection(hint.direction)) {
    residuals.push(realCandidateResidual({
      sourceId: source.id,
      spanId: span.region_id,
      stage: "normalize",
      code: "unsupported_ir_fragment",
      outcome: "unsupported",
      field: "direction",
      value: hint.direction,
      reason: "Direction is outside the route-rule candidate enum.",
      blocksCandidateRule: true
    }));
  }

  if (hint.strength && !isSupportedCandidateStrength(hint.strength)) {
    residuals.push(realCandidateResidual({
      sourceId: source.id,
      spanId: span.region_id,
      stage: "normalize",
      code: "unsupported_ir_fragment",
      outcome: "unsupported",
      field: "strength",
      value: hint.strength,
      reason: "The toy route-rule schema only admits strong or weak recommendation strength.",
      blocksCandidateRule: true
    }));
  }

  if (hint.certainty && !normalizeCandidateCertainty(hint.certainty)) {
    residuals.push(realCandidateResidual({
      sourceId: source.id,
      spanId: span.region_id,
      stage: "normalize",
      code: hint.certainty === "not_extracted" ? "semantic_slot_missing" : "unsupported_ir_fragment",
      outcome: hint.certainty === "not_extracted" ? "residual" : "unsupported",
      field: "certainty",
      value: hint.certainty,
      reason: "Certainty is not mapped to high/moderate/low/very_low for candidate ClinicalStatement rows.",
      blocksCandidateRule: true
    }));
  }

  if (hint.action && !candidateActionKey(hint.action)) {
    residuals.push(realCandidateResidual({
      sourceId: source.id,
      spanId: span.region_id,
      stage: "normalize",
      code: /_or_/.test(hint.action) ? "terminology_ambiguous" : "unsupported_ir_fragment",
      outcome: /_or_/.test(hint.action) ? "ambiguity" : "unsupported",
      field: "action",
      value: hint.action,
      reason: "The toy route-rule schema admits one normalized action key per candidate rule.",
      blocksCandidateRule: true
    }));
  }

  const blockingResiduals = residuals.filter((residual) => residual.blocks_candidate_rule);
  const ruleId = `real.rule.${source.id}.${index + 1}`;
  const rule = blockingResiduals.length === 0
    ? realCandidateRouteRule(source, span, index, ruleId)
    : null;

  return {
    span: {
      ...span,
      span_id: `span.${span.region_id}`,
      quote_hash: sha256Bytes(Buffer.from(span.quote)),
      quote_chars: [...span.quote].length,
      machine_hint_hash: sha256(hint),
      candidate_rule_status: rule ? "candidate_rule_admitted" : "candidate_rule_rejected",
      route_rule_id: rule?.rule_id ?? null,
      residual_ids: residuals.map((residual) => residual.residual_id),
      blocking_residual_ids: blockingResiduals.map((residual) => residual.residual_id)
    },
    rule,
    residuals: [...sourceLevelResiduals, ...residuals]
  };
}

function buildRealGuidelineArtifacts(source, rawArtifacts) {
  const sourceHash = sourceHashForRealGuideline(source, rawArtifacts);
  const permissionHash = permissionHashForRealGuideline(source);
  const sourceLevelResiduals = rawArtifacts.every((artifact) => artifact.cache_status === "fetched")
    ? []
    : [
        realCandidateResidual({
          sourceId: source.id,
          stage: "extract",
          code: "source_raw_cache_missing",
          outcome: "residual",
          reason: "At least one raw source artifact is not present in corpus/raw; candidate artifacts use committed registry spans only.",
          blocksCandidateRule: false
        })
      ];
  const assessed = source.candidate_spans.map((span, index) => assessRealCandidateSpan(source, span, index, sourceLevelResiduals));
  const candidateSpans = assessed.map((entry) => entry.span);
  const residualsById = new Map();
  for (const residual of assessed.flatMap((entry) => entry.residuals)) residualsById.set(residual.residual_id, residual);
  for (const residual of sourceLevelResiduals) residualsById.set(residual.residual_id, residual);
  const residuals = [...residualsById.values()].sort((left, right) => left.residual_id.localeCompare(right.residual_id));
  const admittedRules = assessed.map((entry) => entry.rule).filter(Boolean);
  const rejectedResiduals = residuals.filter((residual) => residual.blocks_candidate_rule);
  const sourceGraph = {
    artifact_id: `artifact.${source.id}.source_graph_candidate`,
    artifact_kind: "SourceGraph",
    schema_version: "source_graph_candidate.v0",
    doc_id: source.id,
    title_ja: source.title_ja,
    title_en: source.title_en,
    source_family: source.source_family,
    provenance: "public_registry_candidate",
    admission_scope: realSourceScope,
    scoring_scope: "not_in_locked_m1_m2_measurement",
    source_hash: sourceHash,
    permission_hash: permissionHash,
    nodes: [
      {
        node_id: `node.${source.id}.document`,
        kind: "document",
        title_ja: source.title_ja
      },
      ...candidateSpans.map((span, index) => ({
        node_id: `node.${source.id}.candidate.${index + 1}`,
        kind: "recommendation_candidate",
        parent_id: `node.${source.id}.document`,
        locator: span.locator,
        cq_id: span.cq_id
      }))
    ],
    spans: candidateSpans.map((span, index) => ({
      span_id: span.span_id,
      node_id: `node.${source.id}.candidate.${index + 1}`,
      region_id: span.region_id,
      raw_text: span.quote,
      nfkc_text: span.quote.normalize("NFKC"),
      search_text: span.quote.normalize("NFKC").toLowerCase(),
      byte_start: null,
      byte_end: null,
      char_start: 0,
      char_end: span.quote_chars,
      reading_order: index + 1,
      text_hash: span.quote_hash,
      locator: span.locator
    })),
    regions: candidateSpans.map((span) => ({
      region_id: span.region_id,
      role: "candidate_recommendation",
      span_ids: [span.span_id],
      quote_hash: span.quote_hash,
      quote: span.quote,
      locator: span.locator,
      permission_scope: source.license.redistribution_mode
    })),
    residuals: residuals.filter((residual) => residual.stage === "extract")
  };
  const segments = {
    artifact_id: `artifact.${source.id}.segments_candidate`,
    artifact_kind: "ClinicalSegments",
    schema_version: "segments_candidate.v0",
    doc_id: source.id,
    admission_scope: realSourceScope,
    scoring_scope: "not_in_locked_m1_m2_measurement",
    source_graph_hash: sha256(sourceGraph),
    segments: candidateSpans.map((span, index) => ({
      segment_id: `segment.${source.id}.${index + 1}`,
      region_id: span.region_id,
      span_id: span.span_id,
      kind: "recommendation_candidate",
      text_hash: span.quote_hash,
      text: span.quote,
      machine_hint_hash: span.machine_hint_hash,
      candidate_rule_status: span.candidate_rule_status
    })),
    residuals: residuals.filter((residual) => residual.stage === "segment")
  };
  const terminologyBindings = candidateSpans.flatMap((span) => {
    const hint = span.machine_hint ?? {};
    return ["population", "condition", "action"].filter((field) => hint[field]).map((field) => ({
      binding_id: `binding.${span.region_id}.${field}`,
      mention: hint[field],
      system: "machine_hint",
      code: hint[field],
      status: "unmapped",
      field,
      source_region_ids: [span.region_id],
      evidence_status: "author_provided_hint"
    }));
  });
  const clinicalStatements = candidateSpans.map((span, index) => {
    const hint = span.machine_hint ?? {};
    return {
      statement_id: `statement.${source.id}.${index + 1}`,
      source_region_ids: [span.region_id],
      population: hint.population ?? null,
      condition: hint.condition ?? null,
      action: hint.action ?? null,
      direction: hint.direction ?? null,
      strength: isSupportedCandidateStrength(hint.strength) ? hint.strength : null,
      certainty: normalizeCandidateCertainty(hint.certainty),
      evidence_status: "author_provided_machine_hint",
      candidate_rule_status: span.candidate_rule_status,
      residual_ids: span.residual_ids
    };
  });
  const normalization = {
    artifact_id: `artifact.${source.id}.normalization_candidate`,
    artifact_kind: "Normalization",
    schema_version: "normalization_candidate.v0",
    doc_id: source.id,
    admission_scope: realSourceScope,
    scoring_scope: "not_in_locked_m1_m2_measurement",
    source_graph_hash: sha256(sourceGraph),
    segments_hash: sha256(segments),
    terminology_bindings: terminologyBindings,
    clinical_statements: clinicalStatements,
    rules: admittedRules,
    residuals: residuals.filter((residual) => residual.stage === "normalize")
  };
  const routeRuleIr = {
    artifact_id: `artifact.${source.id}.route_rule_ir_candidate`,
    artifact_kind: "RouteRuleIR",
    schema_id: realRouteSchemaId,
    schema_version: "real_source_route_rule_candidate.v0",
    route_id: "route.real_guideline_candidate_ir",
    doc_id: source.id,
    admission_scope: realSourceScope,
    scoring_scope: "not_in_locked_m1_m2_measurement",
    clinical_claim_scope: "none",
    normalization_hash: sha256(normalization),
    candidate_span_count: candidateSpans.length,
    admitted_candidate_rule_count: admittedRules.length,
    rejected_candidate_span_count: new Set(rejectedResiduals.map((residual) => residual.region_id)).size,
    candidate_rules: admittedRules.map((rule) => ({
      source_id: rule.source_id,
      region_id: rule.region_id,
      rule_id: rule.rule_id,
      direction: rule.direction,
      action_key: rule.action_key,
      strength: rule.strength,
      certainty: rule.certainty,
      context: rule.context,
      source_region_ids: rule.source_region_ids,
      machine_hint_hash: rule.machine_hint_hash
    })),
    rejected_residuals: rejectedResiduals,
    nonblocking_residuals: residuals.filter((residual) => !residual.blocks_candidate_rule)
  };
  const artifacts = {
    source_graph: {
      path: realArtifactPath(source.id, "source_graph"),
      hash: sha256(sourceGraph)
    },
    segments: {
      path: realArtifactPath(source.id, "segments"),
      hash: sha256(segments)
    },
    normalization: {
      path: realArtifactPath(source.id, "normalization"),
      hash: sha256(normalization)
    },
    route_rule_ir: {
      path: realArtifactPath(source.id, "route_rule_ir"),
      hash: sha256(routeRuleIr)
    }
  };
  return {
    source_hash: sourceHash,
    permission_hash: permissionHash,
    candidate_spans: candidateSpans,
    admitted_candidate_rules: routeRuleIr.candidate_rules.map((rule) => ({
      ...rule,
      rule_hash: sha256(rule)
    })),
    residuals,
    rejected_residuals: rejectedResiduals,
    artifacts,
    artifact_payloads: {
      source_graph: sourceGraph,
      segments,
      normalization,
      route_rule_ir: routeRuleIr
    }
  };
}

async function buildRealGuidelineIntake() {
  const registry = JSON.parse(await readFile(realGuidelineRegistryPath, "utf8"));
  const rawManifest = await readOptionalJson(realGuidelineRawManifestPath);
  const rawManifestStable = stableRawManifest(rawManifest);
  const rawBySource = new Map((rawManifest?.sources ?? []).map((source) => [source.id, source]));
  const sources = [];
  for (const source of registry.sources) {
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
    const candidateArtifacts = buildRealGuidelineArtifacts(source, rawArtifacts);
    for (const [artifactName, payload] of Object.entries(candidateArtifacts.artifact_payloads)) {
      await writeJson(candidateArtifacts.artifacts[artifactName].path, payload);
    }
    sources.push({
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
      source_hash: candidateArtifacts.source_hash,
      permission_hash: candidateArtifacts.permission_hash,
      candidate_spans: candidateArtifacts.candidate_spans,
      admitted_candidate_rules: candidateArtifacts.admitted_candidate_rules,
      residuals: candidateArtifacts.residuals,
      rejected_residuals: candidateArtifacts.rejected_residuals,
      artifacts: candidateArtifacts.artifacts,
      admission_scope: realSourceScope,
      scoring_scope: "not_in_locked_m1_m2_measurement"
    });
  }
  const admittedCandidateRuleCount = sources.reduce((count, source) => count + source.admitted_candidate_rules.length, 0);
  const residualCount = sources.reduce((count, source) => count + source.residuals.length, 0);
  const blockingResidualCount = sources.reduce((count, source) => count + source.rejected_residuals.length, 0);
  return {
    artifact_id: "artifact.real_guidelines.source_intake",
    artifact_kind: "RealGuidelineSourceIntake",
    schema_version: "real_guideline_source_intake.v1",
    registry_path: path.relative(root, realGuidelineRegistryPath),
    raw_manifest_path: path.relative(root, realGuidelineRawManifestPath),
    registry_hash: sha256(registry),
    raw_manifest_hash: rawManifestStable ? sha256(rawManifestStable) : null,
    source_count: sources.length,
    candidate_span_count: sources.reduce((count, source) => count + source.candidate_spans.length, 0),
    admitted_candidate_rule_count: admittedCandidateRuleCount,
    residual_count: residualCount,
    blocking_residual_count: blockingResidualCount,
    rejected_candidate_span_count: sources.reduce((count, source) => (
      count + new Set(source.rejected_residuals.map((residual) => residual.region_id)).size
    ), 0),
    sources,
    route_rule_schema_id: realRouteSchemaId,
    admission_scope: realSourceScope,
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

function makeRule(fixture) {
  if ((fixture.rules ?? []).length !== 1) throw new Error(`expected one rule for ${fixture.id}`);
  return cloneData(fixture.rules[0]);
}

function makeStatement(fixture, rule) {
  const statement = (fixture.clinical_statements ?? [])[0];
  if (!statement) throw new Error(`clinical statement missing for ${fixture.id}`);
  return cloneData(statement);
}

function makeBindings(fixture) {
  return cloneData(fixture.terminology_bindings ?? []);
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

function makeSmtQueryTexts(left, right, overlap) {
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
    overlap: q1,
    ...(overlap.overlaps ? { deontic: polarity } : {})
  };
}

function makeSmt(groupId, left, right, overlap) {
  const queries = makeSmtQueryTexts(left, right, overlap);
  return {
    [`q.${groupId}.overlap.smt2`]: `${queries.overlap}\n`,
    ...(queries.deontic ? { [`q.${groupId}.deontic.smt2`]: `${queries.deontic}\n` } : {})
  };
}

function compileGroup(group, artifactsByDoc) {
  const [leftDoc, rightDoc] = group.fixtures.map((fixtureId) => artifactsByDoc.get(fixtureId));
  if (!leftDoc || !rightDoc) throw new Error(`group requires two known fixtures: ${group.id}`);
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
  return { group, compiled, verifier, smt, left, right, leftDoc, rightDoc, overlap, conflict };
}

function sourceQuote(docArtifacts, regionId) {
  return docArtifacts.source_graph.regions.find((region) => region.region_id === regionId)?.quote ?? "";
}

function sourceQuoteAcrossDocs(artifactsByDoc, regionId) {
  for (const docArtifacts of artifactsByDoc.values()) {
    const quote = sourceQuote(docArtifacts, regionId);
    if (quote) return quote;
  }
  return "";
}

function buildFinding(groupResult, artifactsByDoc) {
  if (!groupResult.conflict) return null;
  const assertionCore = groupResult.verifier.results.find((entry) => entry.unsat_core)?.unsat_core ?? [];
  const regionIds = [...new Set([...groupResult.left.source_region_ids, ...groupResult.right.source_region_ids])];
  return {
    finding_id: `finding.${groupResult.compiled.group_id}.1`,
    group_id: groupResult.compiled.group_id,
    classification: "candidate",
    conflict_kind: groupResult.group.expectedConflictKind ?? "deontic_direction_conflict",
    claim_tier: "s1_admitted",
    rules: [groupResult.left.rule_id, groupResult.right.rule_id],
    region_ids: regionIds,
    quoted_spans: regionIds.map((regionId) => ({ region_id: regionId, text: sourceQuoteAcrossDocs(artifactsByDoc, regionId) })),
    assertion_core: assertionCore,
    verifier_status: "semantic_contradiction",
    wording_scope: "synthetic fixture measurement"
  };
}

function buildNullResult(groupResult, artifactsByDoc) {
  const regionIds = groupResult.compiled.fixture_ids.flatMap((fixtureId) => (
    artifactsByDoc.get(fixtureId)?.fixture.report_primary_region_ids ?? []
  ));
  return {
    null_result_id: `null.${groupResult.compiled.group_id}.1`,
    group_id: groupResult.compiled.group_id,
    classification: "documented_null_result",
    claim_tier: "s1_admitted",
    rules: [groupResult.left.rule_id, groupResult.right.rule_id],
    reason: groupResult.overlap.reasons.find((entry) => entry.endsWith("_disjoint") || entry.endsWith("_incompatible"))
      ?? groupResult.overlap.reasons[0]
      ?? "semantic_no_conflict",
    region_ids: regionIds,
    quoted_spans: regionIds.map((regionId) => ({ region_id: regionId, text: sourceQuoteAcrossDocs(artifactsByDoc, regionId) })),
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
    target_syntax_valid: false,
    model_output_syntax_valid: false,
    admitted: false,
    verdict: "replay_identity_unsupported",
    diagnostics: ["replay_identity_unsupported"],
    response: "recorded-model mode intentionally does not fabricate M2 route output; use --live-model for measurement"
  };
}

function modelCaseForGroup(groupId) {
  const group = groups.find((entry) => entry.id === groupId);
  if (!group) throw new Error(`unknown group: ${groupId}`);
  const fixtures = group.fixtures.map((fixtureId) => {
    const fixture = fixtureRegistry.find((entry) => entry.id === fixtureId);
    if (!fixture) throw new Error(`unknown fixture in group ${groupId}: ${fixtureId}`);
    return fixture;
  });
  const labels = fixtures.map((fixture) => fixture.source_label);
  const lines = fixtures.flatMap((fixture) => {
    const primary = primaryRegion(fixture);
    const exception = fixture.regions.find((region) => region.role === "exception");
    return [
      `source ${fixture.source_label}:`,
      primary.quote,
      ...(exception ? [`${fixture.source_label} exception:`, exception.quote] : [])
    ];
  });
  return {
    case_id: `pair.${labels.join("").toLowerCase()}`,
    labels,
    lines
  };
}

function primaryRegion(fixture) {
  const primaryRegionIds = fixture.report_primary_region_ids ?? [];
  const region = fixture.regions.find((entry) => primaryRegionIds.includes(entry.id))
    ?? fixture.regions.find((entry) => entry.role === "recommendation" || entry.role === "contraindication");
  if (!region) throw new Error(`primary source region missing for fixture: ${fixture.id}`);
  return region;
}

function sourceCaseForLabel(label) {
  const fixture = fixtureRegistry.find((entry) => entry.source_label === label);
  if (!fixture) throw new Error(`unknown source label: ${label}`);
  const primary = primaryRegion(fixture).quote;
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

function sourceCuesForLabel(label) {
  const sourceCase = sourceCaseForLabel(label);
  const primary = sourceCase.primary;
  const exception = sourceCase.exception ?? "";
  return {
    source_label: label,
    cue_extractor: "lexical_cue_v1",
    primary_quote: primary,
    exception_quote: sourceCase.exception,
    direction_cue: primaryDirectionCue(primary),
    age_cue: /小児|18歳未満/.test(primary)
      ? "小児_or_18歳未満"
      : /成人|18歳以上/.test(primary)
        ? "成人_or_18歳以上"
        : "unknown",
    sepsis_cue: /敗血症/.test(primary) ? "present" : "absent",
    pregnancy_cue: /妊娠中/.test(primary) ? "present" : "absent",
    renal_exception_cue: /重度腎機能障害/.test(exception) && /除く/.test(exception) ? "has_exception" : "no_exception",
    action_abx_a_cue: /抗菌薬A/.test(primary) ? "present" : "absent"
  };
}

function cueGuideLines() {
  return [
    "Field mapping guide:",
    "- direction: source wording containing 推奨する => for; 投与しないこと or 禁忌 => contraindicate; otherwise unknown.",
    "- action_abx_a: source wording containing 抗菌薬A => present; otherwise absent.",
    "- age: 成人 or 18歳以上 => adult; 小児 or 18歳未満 => child; otherwise unknown.",
    "- sepsis: source wording containing 敗血症 => present; otherwise absent.",
    "- pregnancy: source wording containing 妊娠中 => present; otherwise absent.",
    "- renal_exception: an exception sentence with 重度腎機能障害 and 除く => yes; otherwise no.",
    "Use unknown only when the excerpt and exception sentence do not support a listed value."
  ];
}

function sourceCueEvidenceLines(groupId) {
  const modelCase = modelCaseForGroup(groupId);
  return modelCase.labels.flatMap((label) => {
    const sourceCase = sourceCaseForLabel(label);
    return [
      `source ${label} primary excerpt: ${sourceCase.primary}`,
      ...(sourceCase.exception ? [`source ${label} exception excerpt: ${sourceCase.exception}`] : [])
    ];
  });
}

const cueFieldSpecs = {
  direction: {
    cueKey: "direction_cue",
    mapping: "投与しないこと=>contraindicate. 禁忌=>contraindicate. 推奨する=>for. none=>unknown.",
    property: { enum: ["contraindicate", "for", "unknown"] }
  },
  action_abx_a: {
    cueKey: "action_abx_a_cue",
    mapping: "present=>present. absent=>absent.",
    property: { enum: ["present", "absent", "unknown"] }
  },
  age: {
    cueKey: "age_cue",
    mapping: "成人_or_18歳以上=>adult. 小児_or_18歳未満=>child. unknown=>unknown.",
    property: { enum: ["adult", "child", "unknown"] }
  },
  sepsis: {
    cueKey: "sepsis_cue",
    mapping: "present=>present. absent=>absent.",
    property: { enum: ["present", "absent", "unknown"] }
  },
  pregnancy: {
    cueKey: "pregnancy_cue",
    mapping: "present=>present. absent=>absent.",
    property: { enum: ["present", "absent", "unknown"] }
  },
  renal_exception: {
    cueKey: "renal_exception_cue",
    mapping: "has_exception=>yes. no_exception=>no.",
    property: { enum: ["yes", "no", "unknown"] }
  }
};

function expectedCueFields(label) {
  const cues = sourceCuesForLabel(label);
  return {
    direction: cues.direction_cue === "推奨する"
      ? "for"
      : cues.direction_cue === "投与しないこと" || cues.direction_cue === "禁忌"
        ? "contraindicate"
        : "unknown",
    action_abx_a: cues.action_abx_a_cue,
    age: cues.age_cue === "成人_or_18歳以上" ? "adult" : cues.age_cue === "小児_or_18歳未満" ? "child" : "unknown",
    sepsis: cues.sepsis_cue,
    pregnancy: cues.pregnancy_cue,
    renal_exception: cues.renal_exception_cue === "has_exception" ? "yes" : cues.renal_exception_cue === "no_exception" ? "no" : "unknown"
  };
}

function irRuleJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(cueFieldSpecs),
    properties: Object.fromEntries(Object.entries(cueFieldSpecs).map(([field, spec]) => [field, spec.property]))
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

function promptForSingleIrPair(groupId) {
  const modelCase = modelCaseForGroup(groupId);
  const schema = JSON.stringify(JSON.parse(jsonSchemaForRoute("route.single_ir", groupId)), null, 2);
  return [
    "You are preparing an import payload for a hospital CDS knowledge-base maintenance queue.",
    "The excerpts are guideline-derived content for rules-engine review, not a patient-specific recommendation.",
    "Derive the bounded JSON fields from the quoted excerpts and the mapping guide.",
    "Keep source labels unchanged. Use only the listed enum tokens and fields. Return JSON only, with no prose.",
    `maintenance ticket: ${modelCase.case_id}`,
    `source labels: ${modelCase.labels.join(", ")}`,
    ...sourceCueEvidenceLines(groupId),
    ...cueGuideLines(),
    "Required output schema:",
    schema
  ].join("\n");
}

function promptFor(routeId, groupId, seed) {
  const modelCase = modelCaseForGroup(groupId);
  const common = [
    "You are assisting a hospital CDS knowledge-base maintenance team.",
    "Process only the guideline excerpts in this import ticket.",
    "This is rules-engine maintenance, not patient-specific care advice.",
    `maintenance ticket: ${modelCase.case_id}`,
    "guideline excerpts:",
    ...modelCase.lines
  ];
  if (routeId === "route.direct_smt") {
    const directSourceLines = [
      `maintenance ticket: ${modelCase.case_id}`,
      ...modelCase.labels.flatMap((label) => {
        const sourceCase = sourceCaseForLabel(label);
        return [
          `guideline excerpt ${label}: ${sourceCase.primary}`,
          ...(sourceCase.exception ? [`exception note ${label}: ${sourceCase.exception}`] : [])
        ];
      })
    ];
    return [
      "You are preparing a formal consistency-check script for a hospital CDS rules repository.",
      "The ticket is guideline-derived content for knowledge-base QA, not patient-specific care advice.",
      "Output one self-contained SMT-LIB 2 program only. No prose, no Markdown, no JSON, no verdict word.",
      "",
      "Use only source facts supported by the excerpts and this mapping guide.",
      ...cueGuideLines(),
      "",
      "Allowed SMT symbols for the repository checker:",
      "(declare-const |q.age_years| Real)",
      "(declare-const |cond.sepsis| Bool)",
      "(declare-const |cond.renal_severe| Bool)",
      "(declare-const |cond.pregnancy| Bool)",
      "(declare-const |pos:act.administer:drug.abx_a| Bool)",
      "",
      "Emit declarations before assertions. Use named assertions for each source when possible.",
      "Use (assert |pos:act.administer:drug.abx_a|) for positive action and (assert (not |pos:act.administer:drug.abx_a|)) for negative action.",
      "Use (assert (>= |q.age_years| 18)) for adult and (assert (< |q.age_years| 18)) for child.",
      "End with exactly one (check-sat).",
      "",
      ...directSourceLines
    ].join("\n");
  }
  return [
    ...common,
    `Fill one CDS import JSON object for each source label: ${modelCase.labels.join(", ")}.`,
    "Do not decide whether the excerpts conflict; emit only the import object.",
    "Output only JSON. Do not use Markdown.",
    ...cueGuideLines(),
    "Use only source facts supported by the excerpts; downstream repository checks handle formal consistency."
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
    ? ["-n", "220", "--ctx-size", "2048", "--temp", "0", "--top-k", "1"]
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
  const fencedMatches = [...cleaned.matchAll(/```(?:smt2?|json)?\s*([\s\S]*?)```/gi)];
  if (fencedMatches.length > 0) cleaned = fencedMatches.at(-1)[1];
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

const diagnosticCategoryDefinitions = {
  syntax: ["target_parse_error", "ai_schema_violation"],
  grounding: ["ai_hallucinated_source", "semantic_slot_missing"],
  unsupported_schema: ["unsupported_ir_fragment"],
  wrong_verdict: ["false_positive_conflict", "false_negative_conflict"],
  process: ["process_crash", "solver_execution_failure"]
};

function diagnosticCategories(codes) {
  const codeSet = new Set(codes ?? []);
  return Object.entries(diagnosticCategoryDefinitions)
    .filter(([, categoryCodes]) => categoryCodes.some((code) => codeSet.has(code)))
    .map(([category]) => category);
}

function directSmtFeatures(text) {
  return {
    has_positive_action: /\(assert\s+(?:\(!\s+)?\|?pos[:\w.-]*act\.administer:drug\.abx_a\|?|\(assert\s+(?:\(!\s+)?\|positive_abx_a\|/.test(text),
    has_negative_action: /\(assert\s+(?:\(!\s+)?\(not\s+\|?pos[:\w.-]*act\.administer:drug\.abx_a\|?\)|\(assert\s+(?:\(!\s+)?\(not\s+\|positive_abx_a\|\)/.test(text),
    has_adult_age: />=\s+\|q\.age_years\|\s+18|>=\s+18/.test(text),
    has_child_age: /<\s+\|q\.age_years\|\s+18|<\s+18/.test(text),
    asserts_sepsis: /\(assert[\s\S]{0,120}\|cond\.sepsis\|/.test(text),
    asserts_pregnancy: /\(assert[\s\S]{0,120}\|cond\.pregnancy\|/.test(text),
    asserts_renal_exception: /\(assert[\s\S]{0,160}\(not\s+\|cond\.renal_severe\|\)/.test(text),
    negates_sepsis: /\(assert\s+\(not\s+\|cond\.sepsis\|\)\)/.test(text),
    has_named_assertion: /:named/.test(text)
  };
}

function directGroundingDiagnostics(features, groupId) {
  const diagnostics = [];
  const expectedRows = modelCaseForGroup(groupId).labels.map((label) => expectedCueFields(label));
  if (features.negates_sepsis) diagnostics.push("ai_hallucinated_source");
  if (expectedRows.some((row) => row.sepsis === "present") && !features.asserts_sepsis) diagnostics.push("semantic_slot_missing");
  if (expectedRows.some((row) => row.pregnancy === "present") && !features.asserts_pregnancy) diagnostics.push("semantic_slot_missing");
  if (expectedRows.some((row) => row.renal_exception === "yes") && !features.asserts_renal_exception) diagnostics.push("semantic_slot_missing");
  return diagnostics;
}

function verdictDiagnostics(verdict, expected) {
  const diagnostics = [];
  if (verdict === "semantic_contradiction" && expected === "semantic_no_conflict") diagnostics.push("false_positive_conflict");
  if (verdict === "semantic_no_conflict" && expected === "semantic_contradiction") diagnostics.push("false_negative_conflict");
  return diagnostics;
}

function classifyDirectSmt(output, groupId, expected) {
  const text = cleanModelText(output);
  const diagnostics = [];
  const syntax_valid = text.includes("(check-sat)") && balancedParens(text);
  if (!syntax_valid) diagnostics.push("target_parse_error", "ai_schema_violation");

  const hallucinated = /\b(creatinine|renal|腎|dose|死亡|mortality)\b/i.test(text)
    && !text.includes("cond.renal_severe");
  if (hallucinated) diagnostics.push("ai_hallucinated_source");

  let verdict = "unknown";
  const features = directSmtFeatures(text);
  if (syntax_valid) {
    if (features.has_positive_action && features.has_negative_action && features.has_adult_age && features.has_child_age) {
      verdict = "semantic_no_conflict";
    } else if (features.has_positive_action && features.has_negative_action) {
      verdict = "semantic_contradiction";
    } else if (features.has_adult_age && features.has_child_age) {
      verdict = "semantic_no_conflict";
    }
    diagnostics.push(...directGroundingDiagnostics(features, groupId));
  }

  if (syntax_valid && verdict === "unknown") diagnostics.push("unsupported_ir_fragment");
  diagnostics.push(...verdictDiagnostics(verdict, expected));

  return {
    syntax_valid,
    admitted: syntax_valid && verdict !== "unknown" && !hallucinated && diagnostics.every((code) => !blocksAdmission(code)),
    verdict: syntax_valid ? verdict : "target_syntax_failure",
    diagnostics: [...new Set(diagnostics)],
    parsed: { evaluator_features: features }
  };
}

function validIrRow(row) {
  return row
    && (row.direction === "for" || row.direction === "contraindicate" || row.direction === "unknown")
    && (row.action_abx_a === "present" || row.action_abx_a === "absent" || row.action_abx_a === "unknown")
    && (row.age === "adult" || row.age === "child" || row.age === "unknown")
    && (row.sepsis === "present" || row.sepsis === "absent" || row.sepsis === "unknown")
    && (row.pregnancy === "present" || row.pregnancy === "absent" || row.pregnancy === "unknown")
    && (row.renal_exception === "yes" || row.renal_exception === "no" || row.renal_exception === "unknown");
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
    const expected = expectedCueFields(label);
    if (!validIrRow(row)) continue;
    for (const field of ["direction", "age", "action_abx_a", "sepsis", "pregnancy", "renal_exception"]) {
      if (row[field] === "unknown") diagnostics.push("semantic_slot_missing");
      else if (row[field] !== expected[field]) {
        const missing = (expected[field] === "present" && row[field] === "absent")
          || (expected[field] === "yes" && row[field] === "no");
        diagnostics.push(missing ? "semantic_slot_missing" : "ai_hallucinated_source");
      }
    }
  }
  return [...new Set(diagnostics)];
}

function ruleFromIrRow(label, row) {
  const required = [];
  if (row.sepsis === "present") required.push("cond.sepsis");
  if (row.pregnancy === "present") required.push("cond.pregnancy");
  const context = {
    age_years: row.age === "adult" ? { ge: 18 } : row.age === "child" ? { lt: 18 } : {},
    required,
    prohibited: row.renal_exception === "yes" ? ["cond.renal_severe"] : []
  };
  return {
    rule_id: `route.rule.${String(label).toLowerCase()}`,
    direction: row.direction,
    action_key: row.action_abx_a === "present" ? "act.administer:drug.abx_a" : "unknown",
    context
  };
}

function routeRuleIrFromRows(parsed, groupId) {
  const labels = modelCaseForGroup(groupId).labels;
  const rules = labels
    .filter((label) => validIrRow(parsed?.[label]))
    .map((label) => ({
      source_label: label,
      cue_row: parsed[label],
      rule: ruleFromIrRow(label, parsed[label])
    }));
  return {
    artifact_kind: "RouteRuleIR",
    schema_id: "schema.route_rule_ir.v0",
    description: "Contrived fixture-scale IR: one source-local cue row compiles to one NormRule-like route rule.",
    route_id: "route.single_ir",
    group_id: groupId,
    labels,
    rows: labels.map((label) => ({ source_label: label, cue_row: parsed?.[label] ?? null })),
    rules
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

function compileRouteIrToSmt(routeIr, groupId, seed, expected) {
  const rules = routeIr.rules.map((entry) => entry.rule);
  const complete = rules.length === 2
    && rules.every((rule) => (
      rule.action_key !== "unknown"
      && rule.direction !== "unknown"
      && Object.keys(rule.context.age_years).length > 0
    ));
  if (!complete) {
    return {
      artifact_kind: "RouteCompiledTarget",
      route_id: routeIr.route_id,
      group_id: groupId,
      seed,
      compiler_id: "route_rule_ir_v0_to_smt_v0",
      source_ir_schema_id: routeIr.schema_id,
      target_profile: "smt-lib-2",
      syntax_valid: false,
      admitted: false,
      verdict: "unknown",
      diagnostics: ["unsupported_ir_fragment"],
      smt_files: [],
      assertion_map: []
    };
  }

  const [left, right] = rules;
  const overlap = contextsOverlap(left.context, right.context);
  const sameAction = left.action_key === right.action_key;
  const opposed = opposedDirections(left, right);
  const conflict = sameAction && opposed && overlap.overlaps;
  const queryTexts = makeSmtQueryTexts(left, right, overlap);
  const baseDir = `route_targets/${routeIr.route_id}/${groupId}/seed-${seed}/smt`;
  const smtFiles = [
    {
      query_id: `q.${routeIr.route_id}.${groupId}.seed-${seed}.overlap`,
      kind: "context_overlap",
      file: `${baseDir}/q.overlap.smt2`,
      logic: "QF_LRA",
      text: `${queryTexts.overlap}\n`
    },
    ...(queryTexts.deontic ? [
      {
        query_id: `q.${routeIr.route_id}.${groupId}.seed-${seed}.deontic`,
        kind: "deontic_consistency",
        file: `${baseDir}/q.deontic.smt2`,
        logic: "QF_UF",
        text: `${queryTexts.deontic}\n`
      }
    ] : [])
  ].map((entry) => ({
    ...entry,
    sha256: sha256Bytes(Buffer.from(entry.text))
  }));
  const assertionMap = [...makeAssertions(left), ...makeAssertions(right)];
  const verdict = conflict ? "semantic_contradiction" : "semantic_no_conflict";
  const diagnostics = [];
  if (verdict === "semantic_contradiction" && expected === "semantic_no_conflict") diagnostics.push("false_positive_conflict");
  if (verdict === "semantic_no_conflict" && expected === "semantic_contradiction") diagnostics.push("false_negative_conflict");

  return {
    artifact_kind: "RouteCompiledTarget",
    route_id: routeIr.route_id,
    group_id: groupId,
    seed,
    compiler_id: "route_rule_ir_v0_to_smt_v0",
    source_ir_schema_id: routeIr.schema_id,
    target_profile: "smt-lib-2",
    input_ir_hash: sha256(routeIr),
    target_hash: sha256(smtFiles.map((entry) => ({
      query_id: entry.query_id,
      kind: entry.kind,
      file: entry.file,
      logic: entry.logic,
      sha256: entry.sha256,
      text: entry.text
    }))),
    syntax_valid: smtFiles.every((entry) => entry.text.includes("(check-sat)") && balancedParens(entry.text)),
    admitted: diagnostics.every((code) => !blocksAdmission(code)),
    verdict,
    diagnostics,
    eligibility: {
      same_action: sameAction,
      opposed_directions: opposed,
      context_overlap: overlap
    },
    verifier: {
      solver_identity: "one-shot-js-symbolic-verifier",
      results: [
        {
          query_id: smtFiles[0].query_id,
          status: overlap.overlaps ? "sat" : "unsat",
          category: overlap.overlaps ? "semantic_overlap" : "semantic_no_conflict",
          model: overlap.witness
        },
        ...(conflict ? [
          {
            query_id: smtFiles.find((entry) => entry.kind === "deontic_consistency").query_id,
            status: "unsat",
            category: "semantic_contradiction",
            unsat_core: assertionMap.map((entry) => entry.assertion_id).sort()
          }
        ] : [])
      ],
      outcome: verdict
    },
    smt_files: smtFiles,
    assertion_map: assertionMap
  };
}

function blocksAdmission(code) {
  return code !== "false_positive_conflict" && code !== "false_negative_conflict";
}

function classifySingleIr(output, groupId, expected) {
  return classifySingleIrCandidate(extractJsonObject(output), groupId, expected, "candidate");
}

function classifySingleIrCandidate(extracted, groupId, expected, seed) {
  const diagnostics = [];
  const parsed = extracted?.value;
  const model_output_syntax_valid = Boolean(parsed);
  if (!model_output_syntax_valid) diagnostics.push("ai_schema_violation");

  const schemaDiagnostics = model_output_syntax_valid ? irSchemaDiagnostics(parsed, groupId) : [];
  const groundingDiagnostics = schemaDiagnostics.length === 0 ? irGroundingDiagnostics(parsed, groupId) : [];
  diagnostics.push(...schemaDiagnostics, ...groundingDiagnostics);

  const routeIr = model_output_syntax_valid ? routeRuleIrFromRows(parsed, groupId) : null;
  const evaluated = model_output_syntax_valid ? evaluateIrRows(parsed, groupId) : { verdict: "target_syntax_failure", route_ir_rules: [], overlap: null };
  const compiledTarget = routeIr ? compileRouteIrToSmt(routeIr, groupId, seed, expected) : null;
  const target_syntax_valid = Boolean(compiledTarget?.syntax_valid);
  const verdict = compiledTarget?.verdict ?? evaluated.verdict;
  if (model_output_syntax_valid && verdict === "unknown") diagnostics.push("unsupported_ir_fragment");
  if (compiledTarget) diagnostics.push(...compiledTarget.diagnostics);
  if (verdict === "semantic_contradiction" && expected === "semantic_no_conflict") diagnostics.push("false_positive_conflict");
  if (verdict === "semantic_no_conflict" && expected === "semantic_contradiction") diagnostics.push("false_negative_conflict");
  const uniqueDiagnostics = [...new Set(diagnostics)];

  return {
    syntax_valid: target_syntax_valid,
    target_syntax_valid,
    model_output_syntax_valid,
    admitted: target_syntax_valid && uniqueDiagnostics.every((code) => !blocksAdmission(code)),
    verdict: target_syntax_valid ? verdict : "target_syntax_failure",
    diagnostics: uniqueDiagnostics,
    parsed: model_output_syntax_valid ? {
      candidate: parsed,
      route_ir: routeIr,
      deterministic_bridge: evaluated
    } : null,
    compiled_target: compiledTarget,
    candidate_text: extracted?.text ?? ""
  };
}

function extractSmtCandidateText(output) {
  const cleaned = cleanModelText(output);
  const start = cleaned.indexOf("(set-logic");
  if (start >= 0) return cleaned.slice(start).trim();
  const firstForm = ["(declare-", "(assert", "(check-sat)"]
    .map((needle) => cleaned.indexOf(needle))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)
    .at(0);
  if (firstForm !== undefined) return cleaned.slice(firstForm).trim();
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
  const classified = classifyDirectSmt(output, groupId, expected);
  const processDiagnostics = [];
  if (subprocess.exit_status !== 0 || subprocess.signal || subprocess.error) processDiagnostics.push("process_crash");
  return {
    route_id: routeId,
    group_id: groupId,
    seed,
    syntax_valid: classified.syntax_valid,
    target_syntax_valid: classified.syntax_valid,
    model_output_syntax_valid: classified.syntax_valid,
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
  const processDiagnostics = [];
  const prompt = promptForSingleIrPair(groupId);
  const subprocess = runLlama(prompt, seed, "route.single_ir", groupId);
  const rawOutput = cleanModelText(subprocess.stdout, prompt);
  const extracted = extractJsonObject(rawOutput);
  const candidate = extracted?.value && typeof extracted.value === "object" && !Array.isArray(extracted.value)
    ? extracted.value
    : {};
  if (!extracted?.value) processDiagnostics.push("ai_schema_violation");
  if (subprocess.exit_status !== 0 || subprocess.signal || subprocess.error) processDiagnostics.push("process_crash");
  const candidateText = JSON.stringify(stable(candidate), null, 2);
  const classified = classifySingleIrCandidate({ value: candidate, text: candidateText }, groupId, expected, seed);
  const routeCall = {
    granularity: "source_pair",
    labels,
    cue_inputs: Object.fromEntries(labels.map((label) => [label, sourceCuesForLabel(label)])),
    prompt,
    prompt_hash: sha256Text(prompt),
    response: extracted?.text ?? rawOutput,
    parsed_response: extracted?.value ?? null,
    response_hash: sha256(extracted?.text ?? rawOutput),
    subprocess
  };
  const aggregateSubprocess = {
    exit_status: subprocess.exit_status,
    signal: subprocess.signal,
    error: subprocess.error,
    timed_out: subprocess.timed_out,
    command: {
      executable: path.relative(root, llamaCliPath),
      args: ["<source-pair-json-call>"]
    },
    calls: [{
      labels,
      granularity: routeCall.granularity,
      command: subprocess.command,
      exit_status: subprocess.exit_status,
      signal: subprocess.signal,
      error: subprocess.error,
      timed_out: subprocess.timed_out
    }]
  };
  return {
    route_id: "route.single_ir",
    group_id: groupId,
    seed,
    syntax_valid: classified.syntax_valid,
    target_syntax_valid: classified.target_syntax_valid,
    model_output_syntax_valid: classified.model_output_syntax_valid,
    admitted: classified.admitted && processDiagnostics.every((code) => code !== "process_crash"),
    verdict: processDiagnostics.includes("process_crash") ? "solver_execution_failure" : classified.verdict,
    diagnostics: [...new Set([...classified.diagnostics, ...processDiagnostics])],
    prompt,
    response: classified.candidate_text,
    parsed_response: classified.parsed ?? null,
    compiled_target: classified.compiled_target ?? null,
    subprocess: aggregateSubprocess,
    route_call: routeCall,
    source_calls: null,
    live_call_count: 1
  };
}

function scoreRows() {
  const routes = routeIds;
  const seeds = sampleSeeds;
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
        const prompt = simulated.prompt ?? promptFor(routeId, group.id, seed);
        const row = {
          route_id: routeId,
          group_id: group.id,
          measurement_role: group.measurementRole,
          seed,
          syntax_valid: simulated.syntax_valid,
          target_syntax_valid: simulated.target_syntax_valid ?? simulated.syntax_valid,
          model_output_syntax_valid: simulated.model_output_syntax_valid ?? simulated.syntax_valid,
          admitted: simulated.admitted,
          verdict: simulated.verdict,
          expected,
          verdict_correct,
          candidate_verdict_correct,
          diagnostics: simulated.diagnostics,
          diagnostic_categories: diagnosticCategories(simulated.diagnostics),
          evaluator_id: "source_derived_route_pair_evaluator.v2"
        };
        rawRows.push(row);
        ioRecords.push({
          record_id: `io.${routeId}.${group.id}.${seed}`.replaceAll(".", "_"),
          route_id: routeId,
          group_id: group.id,
          seed,
          prompt,
          prompt_hash: sha256Text(prompt),
          response: simulated.response,
          parsed_response: simulated.parsed_response ?? null,
          compiled_target: simulated.compiled_target ?? null,
          route_call: simulated.route_call ?? null,
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
      model_output_syntax_validity: ratio(rows.filter((row) => row.model_output_syntax_valid).length, total),
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

function buildSourceCueLayer() {
  const labels = [...new Set(groups.flatMap((group) => modelCaseForGroup(group.id).labels))].sort();
  return {
    artifact_kind: "SourceCueLayer",
    extractor_id: "lexical_cue_v1",
    scope: "shared_route_input",
    fairness_note: "Both M2 routes are evaluated against the same deterministic source-derived cue rows. R3 prompts no longer include the filled single_ir answer object; route.direct_smt composes SMT-LIB directly from source excerpts, while route.single_ir derives bounded JSON rows under cue definitions before deterministic route_rule_ir.v0 to SMT-LIB compilation.",
    cues: Object.fromEntries(labels.map((label) => [label, {
      ...sourceCuesForLabel(label),
      resolved_fields: expectedCueFields(label)
    }]))
  };
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
    interpretation: "Direct SMT receives the same source cue layer as single_ir, but must still compose SMT-LIB directly. This audit records whether failed direct outputs collapsed to fixture-like templates or missed trace naming; it is not used to admit rows."
  };
}

function buildRouteTargetSummary(ioRecords) {
  const targetRecords = ioRecords.filter((record) => record.compiled_target);
  const smtFiles = targetRecords.flatMap((record) => record.compiled_target.smt_files.map(({ text, ...metadata }) => ({
    route_id: record.route_id,
    group_id: record.group_id,
    seed: record.seed,
    ...metadata
  })));
  return {
    artifact_kind: "RouteTargetSummary",
    route_id: "route.single_ir",
    source_ir_schema_id: "schema.route_rule_ir.v0",
    target_profile: "smt-lib-2",
    compiler_id: "route_rule_ir_v0_to_smt_v0",
    compiled_row_count: targetRecords.length,
    smt_file_count: smtFiles.length,
    smt_files: smtFiles
  };
}

function buildRouteEvaluation(rawRows) {
  const evaluationGroups = groups.map((group) => ({
    group_id: group.id,
    fixture_ids: group.fixtures,
    source_labels: modelCaseForGroup(group.id).labels,
    measurement_role: group.measurementRole,
    mutation_note: group.mutationNote,
    expected_outcome: group.expectedOutcome
  }));
  const routeCategoryCounts = Object.fromEntries(routeIds.map((routeId) => {
    const routeRows = rawRows.filter((row) => row.route_id === routeId);
    return [routeId, Object.fromEntries(Object.keys(diagnosticCategoryDefinitions).map((category) => [
      category,
      routeRows.filter((row) => row.diagnostic_categories.includes(category)).length
    ]))];
  }));
  return {
    artifact_kind: "RouteEvaluationAudit",
    schema_version: "route_evaluation_audit.v0",
    evaluator_id: "source_derived_route_pair_evaluator.v2",
    scope: "Both M2 routes are scored over the same source-derived expected cue rows and group verdicts.",
    evaluation_strength: "scaffolded_cue_translation_test",
    evaluation_strength_note: "R3 removes exact filled JSON payloads from route.single_ir prompts and adds a holdout mutation group. The prompt still supplies schema and cue definitions, so this remains a scaffolded cue-translation test rather than raw Japanese guideline understanding.",
    diagnostic_categories: diagnosticCategoryDefinitions,
    evaluation_groups: evaluationGroups,
    holdout_group_ids: evaluationGroups
      .filter((group) => group.measurement_role.includes("holdout") || group.measurement_role.includes("mutation"))
      .map((group) => group.group_id),
    route_category_counts: routeCategoryCounts,
    raw_row_count: rawRows.length
  };
}

function buildRealismAudit({ realGuidelineIntake, sourceCueLayer, promptCatalog }) {
  const surfaces = [
    {
      surface_id: "fixture_html_sources",
      stage: "input",
      classification: "fixture_authored",
      evidence_paths: fixtureRegistry.map((fixture) => fixture.path),
      note: "Synthetic Japanese HTML fixtures remain authored PoC inputs."
    },
    {
      surface_id: "fixture_regions",
      stage: "extract",
      classification: "data_driven",
      evidence_paths: [m1InputRefs.fixture_semantics_path],
      note: "Region IDs, roles, and exact quoted spans are read from committed fixture semantics JSON."
    },
    {
      surface_id: "fixture_groups",
      stage: "experiment",
      classification: "data_driven",
      evidence_paths: [m1InputRefs.experiments_registry_path],
      note: "M1 fixture group membership is read from the experiment registry."
    },
    {
      surface_id: "m2_evaluation_groups",
      stage: "m2_route_evaluation",
      classification: "data_driven",
      evidence_paths: [m1InputRefs.experiments_registry_path, m1InputRefs.gold_expectations_path],
      note: "M2 route scoring groups, including holdout mutation roles, are read from the experiment registry and gold artifact."
    },
    {
      surface_id: "expected_outcomes",
      stage: "evaluation",
      classification: "data_driven",
      evidence_paths: [m1InputRefs.gold_expectations_path],
      note: "Expected group outcomes and expected cores are read from the gold artifact."
    },
    {
      surface_id: "terminology_bindings",
      stage: "normalize",
      classification: "data_driven",
      evidence_paths: [m1InputRefs.fixture_semantics_path],
      note: "Terminology binding rows are loaded per fixture instead of constructed from fixture keys."
    },
    {
      surface_id: "norm_rule_specs",
      stage: "normalize",
      classification: "data_driven",
      evidence_paths: [m1InputRefs.fixture_semantics_path],
      note: "NormRule-like direction, action, context, and source-region fields are loaded per fixture."
    },
    {
      surface_id: "segment_generation",
      stage: "segment",
      classification: "data_driven",
      evidence_paths: [m1InputRefs.fixture_semantics_path],
      note: "Segments are generated from loaded region rows and source offsets."
    },
    {
      surface_id: "context_overlap_and_smt_encoding",
      stage: "compile",
      classification: "hardcoded",
      evidence_paths: ["tools/build-run.mjs"],
      note: "The toy interval/concept overlap logic and SMT-LIB emitter are still one-shot harness code."
    },
    {
      surface_id: "symbolic_verifier",
      stage: "verify",
      classification: "hardcoded",
      evidence_paths: ["tools/build-run.mjs"],
      note: "The one-shot symbolic verifier simulates the M1 solver result for fixture-scale evidence."
    },
    {
      surface_id: "source_cue_layer",
      stage: "m2_route_input",
      classification: "prompt_scaffolded",
      evidence_paths: ["metrics/source_cues.json"],
      note: `Shared cue layer ${sourceCueLayer.extractor_id} is deterministic, but exists to scaffold M2 route prompts.`
    },
    {
      surface_id: "llm_prompt_templates",
      stage: "m2_route_prompt",
      classification: "prompt_scaffolded",
      evidence_paths: ["prompts/catalog.json", ...promptCatalog.entries.map((entry) => entry.prompt_path)],
      note: "Prompt templates are explicit experiment scaffolding and are cataloged byte-for-byte."
    },
    {
      surface_id: "real_guideline_intake",
      stage: "source_intake",
      classification: "data_driven",
      evidence_paths: [
        realGuidelineIntake.registry_path,
        realGuidelineIntake.raw_manifest_path,
        ...realGuidelineIntake.sources.flatMap((source) => Object.values(source.artifacts).map((artifact) => artifact.path))
      ],
      note: "Real guideline source metadata, candidate spans, machine-hint normalization, and candidate route-rule IR are registry-driven and remain outside locked M1/M2 scoring."
    },
    {
      surface_id: "report_renderer",
      stage: "report",
      classification: "hardcoded",
      evidence_paths: ["tools/build-run.mjs", "runs/m2-one-shot/report.json", "runs/m2-one-shot/report.md", "runs/m2-one-shot/report.ja.md"],
      note: "Report artifacts are deterministic renderer outputs over canonical run artifacts; browser UI rendering is out of scope."
    }
  ];
  const summary = Object.fromEntries(["data_driven", "fixture_authored", "prompt_scaffolded", "hardcoded"].map((classification) => [
    classification,
    surfaces.filter((surface) => surface.classification === classification).length
  ]));
  return {
    artifact_kind: "RealismAudit",
    schema_version: "realism_audit.v1",
    run_id: runId,
    scope: "Fixture-scale realism audit for the one-shot M1-M2 research harness.",
    clinical_claim_scope: "none",
    classification_values: ["data_driven", "fixture_authored", "prompt_scaffolded", "hardcoded"],
    input_artifacts: m1InputRefs,
    summary,
    surface_count: surfaces.length,
    surfaces
  };
}

function promptTemplateId(routeId, granularity) {
  if (routeId === "route.direct_smt") return "prompt.route_direct_smt.cds_ticket_smt_target.v3";
  if (routeId === "route.single_ir" && granularity === "source_pair") return "prompt.route_single_ir.cds_ticket_pair_json.v3";
  if (routeId === "route.single_ir") return "prompt.route_single_ir.cds_ticket_generic_json.v3";
  return `prompt.${routeId.replaceAll(".", "_")}.${granularity}.v3`;
}

function promptOutputContract(routeId, granularity) {
  if (routeId === "route.direct_smt") return "self-contained SMT-LIB 2 program";
  if (routeId === "route.single_ir" && granularity === "source_pair") {
    return "CDS import JSON object keyed by source label; constrained by llama.cpp JSON schema";
  }
  if (routeId === "route.single_ir") return "CDS import JSON object";
  return "route-specific model output";
}

function promptCatalogPath(routeId, groupId, promptHash) {
  return `prompts/${routeId}/${groupId}/prompt-${promptHash.slice(0, 12)}.txt`;
}

function buildPromptCatalog(ioRecords) {
  const calls = ioRecords.map((record) => {
    const routeCall = record.route_call;
    const granularity = routeCall?.granularity ?? "route";
    const promptText = routeCall?.prompt ?? record.prompt;
    const promptHash = sha256Text(promptText);
    return {
      call_id: `${record.record_id}.${granularity}`,
      model_io_record_id: record.record_id,
      route_id: record.route_id,
      group_id: record.group_id,
      seed: record.seed,
      granularity,
      prompt_template_id: promptTemplateId(record.route_id, granularity),
      output_contract: promptOutputContract(record.route_id, granularity),
      prompt_hash: promptHash,
      response_hash: routeCall?.response_hash ?? record.response_hash
    };
  }).sort((left, right) => [
    left.route_id,
    left.group_id,
    String(left.seed),
    left.call_id
  ].join("|").localeCompare([
    right.route_id,
    right.group_id,
    String(right.seed),
    right.call_id
  ].join("|")));

  const byHash = new Map();
  for (const call of calls) {
    const record = ioRecords.find((entry) => entry.record_id === call.model_io_record_id);
    const promptText = record.route_call?.prompt ?? record.prompt;
    if (!byHash.has(call.prompt_hash)) {
      byHash.set(call.prompt_hash, {
        prompt_hash: call.prompt_hash,
        prompt_text: promptText,
        prompt_template_id: call.prompt_template_id,
        output_contract: call.output_contract,
        granularity: call.granularity,
        route_ids: new Set(),
        group_ids: new Set(),
        seeds: new Set(),
        calls: []
      });
    }
    const entry = byHash.get(call.prompt_hash);
    entry.route_ids.add(call.route_id);
    entry.group_ids.add(call.group_id);
    entry.seeds.add(call.seed);
    entry.calls.push(call);
  }

  const entries = [...byHash.values()].map((entry) => {
    const routeIds = [...entry.route_ids].sort();
    const groupIds = [...entry.group_ids].sort();
    const seeds = [...entry.seeds].sort((left, right) => left - right);
    const callsForPrompt = entry.calls.sort((left, right) => left.call_id.localeCompare(right.call_id));
    const promptPath = promptCatalogPath(routeIds[0], groupIds[0], entry.prompt_hash);
    return {
      prompt_id: `${entry.prompt_template_id}.${groupIds.join("_").replaceAll(".", "_")}`,
      prompt_template_id: entry.prompt_template_id,
      prompt_path: promptPath,
      prompt_hash: entry.prompt_hash,
      prompt_chars: [...entry.prompt_text].length,
      route_ids: routeIds,
      group_ids: groupIds,
      seeds,
      granularity: entry.granularity,
      output_contract: entry.output_contract,
      call_count: callsForPrompt.length,
      calls: callsForPrompt,
      prompt_text: entry.prompt_text
    };
  }).sort((left, right) => left.prompt_path.localeCompare(right.prompt_path));

  return {
    artifact_kind: "PromptCatalog",
    schema_version: "prompt_catalog.v0",
    scope: "Exact prompt bytes passed to the local llama.cpp process through the -p argument for M2 route calls.",
    prompt_hash_method: "sha256(utf8(prompt_text))",
    prompt_count: entries.length,
    call_count: calls.length,
    entries
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
    for (const source of realGuidelineIntake.sources ?? []) {
      const sourceGraphId = `artifact.${source.id}.source_graph_candidate`;
      const segmentsId = `artifact.${source.id}.segments_candidate`;
      const normalizationId = `artifact.${source.id}.normalization_candidate`;
      const routeRuleIrId = `artifact.${source.id}.route_rule_ir_candidate`;
      nodes.push(
        { id: sourceGraphId, kind: "real_source_graph_candidate" },
        { id: segmentsId, kind: "real_segments_candidate" },
        { id: normalizationId, kind: "real_normalization_candidate" },
        { id: routeRuleIrId, kind: "real_route_rule_ir_candidate" }
      );
      edges.push(
        { from: realGuidelineIntake.artifact_id, to: sourceGraphId, op: "extract_candidate_spans" },
        { from: sourceGraphId, to: segmentsId, op: "segment_candidate_spans" },
        { from: segmentsId, to: normalizationId, op: "normalize_machine_hints" },
        { from: normalizationId, to: routeRuleIrId, op: "emit_candidate_route_rule_ir" },
        { from: routeRuleIrId, to: "artifact.report.json", op: "render_source_intake_candidate_ir" }
      );
    }
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

function markdownFence(text) {
  const fence = String(text).includes("```") ? "````" : "```";
  return `${fence}text\n${text}\n${fence}`;
}

function promptCatalogMarkdown(promptCatalog) {
  const promptRows = promptCatalog.entries.map((entry) => `| \`${entry.prompt_id}\` | ${entry.route_ids.map((id) => `\`${id}\``).join(", ")} | ${entry.group_ids.map((id) => `\`${id}\``).join(", ")} | ${entry.seeds.join(", ")} | ${entry.call_count} | \`${entry.prompt_hash}\` | \`${entry.prompt_path}\` |`).join("\n");
  const promptBlocks = promptCatalog.entries.map((entry) => [
    `### ${entry.prompt_id}`,
    "",
    `- Template: \`${entry.prompt_template_id}\``,
    `- Output contract: ${entry.output_contract}`,
    `- Prompt hash: \`${entry.prompt_hash}\``,
    `- Calls: ${entry.call_count}`,
    "",
    markdownFence(entry.prompt_text)
  ].join("\n")).join("\n\n");
  return `## LLM prompts

Prompt hash method: \`${promptCatalog.prompt_hash_method}\`. These are the exact prompt texts passed to llama.cpp through \`-p\`; per-call responses remain in \`model_io/**\`.

| Prompt | Route | Groups | Seeds | Calls | SHA-256 | Path |
| --- | --- | --- | --- | ---: | --- | --- |
${promptRows}

${promptBlocks}`;
}

function promptCatalogJapaneseMarkdown(promptCatalog) {
  const promptRows = promptCatalog.entries.map((entry) => `| \`${entry.prompt_id}\` | ${entry.route_ids.map((id) => `\`${id}\``).join(", ")} | ${entry.group_ids.map((id) => `\`${id}\``).join(", ")} | ${entry.seeds.join(", ")} | ${entry.call_count} | \`${entry.prompt_hash}\` | \`${entry.prompt_path}\` |`).join("\n");
  const promptBlocks = promptCatalog.entries.map((entry) => [
    `### ${entry.prompt_id}`,
    "",
    `- template: \`${entry.prompt_template_id}\``,
    `- output contract: ${entry.output_contract}`,
    `- prompt hash: \`${entry.prompt_hash}\``,
    `- calls: ${entry.call_count}`,
    "",
    markdownFence(entry.prompt_text)
  ].join("\n")).join("\n\n");
  return `## LLM prompts

hash method: \`${promptCatalog.prompt_hash_method}\`。以下は llama.cpp の \`-p\` に渡した exact prompt text。call ごとの response は \`model_io/**\` に残す。

| prompt | route | groups | seeds | calls | SHA-256 | path |
| --- | --- | --- | --- | ---: | --- | --- |
${promptRows}

${promptBlocks}`;
}

function realismAuditMarkdown(realismAudit) {
  const summary = Object.entries(realismAudit.summary).map(([classification, count]) => `${classification}: ${count}`).join("; ");
  const rows = realismAudit.surfaces.map((surface) => `| \`${surface.surface_id}\` | ${surface.stage} | ${surface.classification} | ${surface.evidence_paths.map((entry) => `\`${entry}\``).join("<br>")} | ${surface.note} |`).join("\n");
  return `## Realism audit

Scope: one-shot fixture realism audit; no clinical, patient-care, deployment, or regulatory claim. Summary: ${summary}.

| Surface | Stage | Classification | Evidence | Note |
| --- | --- | --- | --- | --- |
${rows}`;
}

function realismAuditJapaneseMarkdown(realismAudit) {
  const summary = Object.entries(realismAudit.summary).map(([classification, count]) => `${classification}: ${count}`).join("; ");
  const rows = realismAudit.surfaces.map((surface) => `| \`${surface.surface_id}\` | ${surface.stage} | ${surface.classification} | ${surface.evidence_paths.map((entry) => `\`${entry}\``).join("<br>")} | ${surface.note} |`).join("\n");
  return `## Realism audit

範囲: one-shot fixture realism audit。臨床、患者ケア、導入、規制上の主張はしない。summary: ${summary}.

| surface | stage | classification | evidence | note |
| --- | --- | --- | --- | --- |
${rows}`;
}

function shortHash(value) {
  return value ? String(value).slice(0, 12) : "missing";
}

function realGuidelineCoverageMarkdown(intake) {
  const sourceRows = intake.sources.map((source) => `| \`${source.id}\` | \`${shortHash(source.source_hash)}\` | \`${shortHash(source.permission_hash)}\` | ${source.candidate_span_count} | ${source.admitted_candidate_rule_count} | ${source.rejected_residual_count} | ${source.raw_cache_status} |`).join("\n");
  const spanRows = intake.candidate_span_rows.map((span) => `| \`${span.source_id}\` | \`${span.region_id}\` | ${span.cq_id} | ${span.candidate_rule_status} | ${span.direction ?? "missing"} | ${span.strength ?? "missing"} | ${span.certainty ?? "missing"} | \`${shortHash(span.quote_hash)}\` |`).join("\n");
  const ruleRows = intake.admitted_candidate_rules.map((rule) => `| \`${rule.rule_id}\` | \`${rule.source_id}\` | \`${rule.region_id}\` | ${rule.direction} | \`${rule.action_key}\` | ${rule.strength} | ${rule.certainty} | \`${shortHash(rule.rule_hash)}\` |`).join("\n") || "| none | none | none | none | none | none | none | none |";
  const residualRows = intake.rejected_residuals.map((residual) => `| \`${residual.residual_id}\` | \`${residual.source_id}\` | \`${residual.region_id ?? "source"}\` | ${residual.code} | ${residual.outcome} | ${residual.field ?? "source"} | ${residual.reason} |`).join("\n") || "| none | none | none | none | none | none | none |";
  const artifactRows = intake.sources.map((source) => `| \`${source.id}\` | \`${source.artifacts.source_graph.path}\` | \`${source.artifacts.segments.path}\` | \`${source.artifacts.normalization.path}\` | \`${source.artifacts.route_rule_ir.path}\` |`).join("\n");
  return `### Real-source candidate coverage

All rows below are \`${intake.admission_scope}\`; scoring scope is \`${intake.scoring_scope}\`.

| Source | Source hash | Permission hash | Spans | Candidate rules | Rejected residuals | Raw cache |
| --- | --- | --- | ---: | ---: | ---: | --- |
${sourceRows}

| Source | Candidate span | CQ | Status | Direction | Strength | Certainty | Quote hash |
| --- | --- | --- | --- | --- | --- | --- | --- |
${spanRows}

### Admitted Candidate Rules

| Rule | Source | Span | Direction | Action | Strength | Certainty | Rule hash |
| --- | --- | --- | --- | --- | --- | --- | --- |
${ruleRows}

### Rejected Residuals

| Residual | Source | Span | Code | Outcome | Field | Reason |
| --- | --- | --- | --- | --- | --- | --- |
${residualRows}

### Real-source Candidate Artifacts

| Source | SourceGraph | Segments | Normalization | Route-rule IR |
| --- | --- | --- | --- | --- |
${artifactRows}`;
}

function markdownReport(report) {
  const liftRows = report.metrics.lift_table.map((row) => `| ${row.metric} | ${row.baseline.exact} | ${row.lifted.exact} | ${row.delta.exact} |`).join("\n");
  const rawRows = report.metrics.raw_rows.map((row) => `| ${row.route_id} | ${row.group_id} | ${row.measurement_role} | ${row.seed} | ${row.model_output_syntax_valid} | ${row.target_syntax_valid} | ${row.admitted} | ${row.verdict} | ${row.verdict_correct} | ${row.candidate_verdict_correct} | ${row.diagnostic_categories.join(", ") || "none"} |`).join("\n");
  const groupRows = report.m2_evaluation.evaluation_groups.map((group) => `| \`${group.group_id}\` | ${group.measurement_role} | ${group.source_labels.join(", ")} | ${group.expected_outcome} | ${group.mutation_note ?? "none"} |`).join("\n");
  const diagnosticCategoryRows = Object.entries(report.m2_evaluation.diagnostic_categories).map(([category, codes]) => `| ${category} | ${codes.map((code) => `\`${code}\``).join(", ")} |`).join("\n");
  const diagnostics = Object.entries(report.diagnostics_summary).map(([code, count]) => `- ${code}: ${count}`).join("\n") || "- none: 0";
  const directMetric = report.metrics.route_metrics.find((entry) => entry.route_id === "route.direct_smt");
  const irMetric = report.metrics.route_metrics.find((entry) => entry.route_id === "route.single_ir");
  const irConclusion = irMetric.admission_rate.numerator > 0
    ? `The IR route produced ${irMetric.admission_rate.exact} admitted rows; admitted verdict accuracy is ${irMetric.admitted_verdict_accuracy.exact}.`
    : `The IR route produced no admitted rows in this live run; candidate verdicts are reported only as rejected model outputs.`;
  const comparisonConclusion = directMetric.admitted_verdict_accuracy.numerator >= irMetric.admitted_verdict_accuracy.numerator
    ? `Direct SMT reached ${directMetric.target_syntax_validity.exact} target syntax validity, ${directMetric.admission_rate.exact} admission, and ${directMetric.admitted_verdict_accuracy.exact} admitted verdict accuracy on this locked fixture. This live run does not demonstrate an IR lift over direct SMT.`
    : `With the shared source-cue layer and the small local model, direct SMT remains below the IR route on admitted verdict accuracy for this locked fixture.`;
  const directAudit = report.direct_smt_audit;
  const directAuditConclusion = `Direct SMT residual audit: exact template matches ${directAudit.exact_template_match_rate.exact}; rows without named assertions ${directAudit.missing_named_assertion_rate.exact}; rows asserting negated sepsis ${directAudit.negated_sepsis_assertion_rate.exact}. This audit is non-admission evidence for malformed direct target composition under the shared cue layer.`;
  const realGuidelineRows = report.real_guideline_intake.sources.map((source) => `| ${source.id} | ${source.license_label} | ${source.raw_cache_status} | ${source.candidate_span_count} | ${source.admitted_candidate_rule_count} | ${source.rejected_residual_count} | ${source.guideline_relation} |`).join("\n");
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

| Source | License | Raw cache | Candidate spans | Candidate rules | Rejected residuals | Relation |
| --- | --- | --- | ---: | ---: | ---: | --- |
${realGuidelineRows}

${realGuidelineCoverageMarkdown(report.real_guideline_intake)}

${realismAuditMarkdown(report.realism_audit)}

## M2 lift table

Shared route input: \`${report.source_cue_layer.extractor_id}\` / cue hash \`${report.source_cue_layer.cue_hash}\`. Both routes finish at SMT-LIB: direct SMT asks the model for target text, while single IR asks the model to derive bounded JSON rows from source excerpts under cue definitions, then compiles \`route_rule_ir.v0\` deterministically to SMT-LIB before verifier scoring.

Evaluation strength: \`${report.m2_evaluation.evaluation_strength}\`. ${report.m2_evaluation.evaluation_strength_note}

| Group | Role | Source labels | Expected | Note |
| --- | --- | --- | --- | --- |
${groupRows}

| Metric | direct_smt | single_ir | delta |
| --- | ---: | ---: | ---: |
${liftRows}

${comparisonConclusion}

${directAuditConclusion}

${irConclusion}

${promptCatalogMarkdown(report.prompt_catalog)}

## route.single_ir compiled SMT target

- IR schema: \`${report.route_target_summary.source_ir_schema_id}\`
- Compiler: \`${report.route_target_summary.compiler_id}\`
- Compiled rows: ${report.route_target_summary.compiled_row_count}
- SMT files: ${report.route_target_summary.smt_file_count}

## Raw route rows

| Route | Group | Role | Seed | Model syntax valid | Target syntax valid | Admitted | Verdict | Admitted correct | Candidate correct | Diagnostic categories |
| --- | --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- |
${rawRows}

## Route evaluator diagnostics

Evaluator: \`${report.m2_evaluation.evaluator_id}\`.

| Category | Codes |
| --- | --- |
${diagnosticCategoryRows}

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
  const groupRows = report.m2_evaluation.evaluation_groups.map((group) => `| \`${group.group_id}\` | ${group.measurement_role} | ${group.source_labels.join(", ")} | ${group.expected_outcome} | ${group.mutation_note ?? "none"} |`).join("\n");
  const directMetric = report.metrics.route_metrics.find((entry) => entry.route_id === "route.direct_smt");
  const irMetric = report.metrics.route_metrics.find((entry) => entry.route_id === "route.single_ir");
  const irConclusion = irMetric.admission_rate.numerator > 0
    ? `IR route は ${irMetric.admission_rate.exact} 行を admitted とした。admitted verdict accuracy は ${irMetric.admitted_verdict_accuracy.exact}。`
    : "この live run では IR route の admitted 行は 0。candidate verdict は rejected model output の監査情報としてのみ扱う。";
  const comparisonConclusion = directMetric.admitted_verdict_accuracy.numerator >= irMetric.admitted_verdict_accuracy.numerator
    ? `direct SMT はこの locked fixture で target syntax ${directMetric.target_syntax_validity.exact}、admission ${directMetric.admission_rate.exact}、admitted verdict accuracy ${directMetric.admitted_verdict_accuracy.exact} に達した。この live run は direct SMT に対する IR lift を示さない。`
    : "shared source-cue layer と小さい local model の条件で、direct SMT baseline はこの locked fixture の admitted verdict accuracy で IR route を下回った。";
  const directAudit = report.direct_smt_audit;
  const directAuditConclusion = `Direct SMT residual audit: exact template match ${directAudit.exact_template_match_rate.exact}、named assertion なし ${directAudit.missing_named_assertion_rate.exact}、negated sepsis assertion ${directAudit.negated_sepsis_assertion_rate.exact}。これは admission 判定外の監査情報であり、shared cue layer 下で direct target composition が malformed になることを記録する。`;
  const realGuidelineRows = report.real_guideline_intake.sources.map((source) => `| ${source.id} | ${source.license_label} | ${source.raw_cache_status} | ${source.candidate_span_count} | ${source.admitted_candidate_rule_count} | ${source.rejected_residual_count} |`).join("\n");
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

| source | license | raw cache | candidate spans | candidate rules | rejected residuals |
| --- | --- | --- | ---: | ---: | ---: |
${realGuidelineRows}

${realGuidelineCoverageMarkdown(report.real_guideline_intake)}

${realismAuditJapaneseMarkdown(report.realism_audit)}

## M2 lift table

shared route input: \`${report.source_cue_layer.extractor_id}\` / cue hash \`${report.source_cue_layer.cue_hash}\`。両 route は SMT-LIB を final target とする。direct SMT は model が target text を直接構成し、single IR は source excerpt と cue definition から bounded JSON row を導出し、\`route_rule_ir.v0\` から deterministic compiler で SMT-LIB に変換して verifier で score する。

evaluation strength: \`${report.m2_evaluation.evaluation_strength}\`。${report.m2_evaluation.evaluation_strength_note}

| group | role | source labels | expected | note |
| --- | --- | --- | --- | --- |
${groupRows}

| metric | direct_smt | single_ir | delta |
| --- | ---: | ---: | ---: |
${liftRows}

${comparisonConclusion}

${directAuditConclusion}

${irConclusion}

${promptCatalogJapaneseMarkdown(report.prompt_catalog)}

## route.single_ir compiled SMT target

- IR schema: \`${report.route_target_summary.source_ir_schema_id}\`
- compiler: \`${report.route_target_summary.compiler_id}\`
- compiled rows: ${report.route_target_summary.compiled_row_count}
- SMT files: ${report.route_target_summary.smt_file_count}
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
  await loadM1FixtureInputs();
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
      terminology_bindings: makeBindings(fixture),
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
  for (const group of m1Groups) {
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

  const conflictGroupResult = groupResults.find((entry) => entry.conflict);
  const nullGroupResult = groupResults.find((entry) => entry.group.expectedNullResult || entry.verifier.outcome === "semantic_no_conflict");
  if (!conflictGroupResult) throw new Error("expected conflict group missing");
  if (!nullGroupResult) throw new Error("expected null-result group missing");
  const finding = buildFinding(conflictGroupResult, artifactsByDoc);
  const nullResult = buildNullResult(nullGroupResult, artifactsByDoc);
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
  const sourceCueLayer = buildSourceCueLayer();
  const directSmtAudit = buildDirectSmtAudit(metrics.ioRecords);
  const routeTargetSummary = buildRouteTargetSummary(metrics.ioRecords);
  const routeEvaluation = buildRouteEvaluation(metrics.rawRows);
  const promptCatalog = buildPromptCatalog(metrics.ioRecords);
  const realismAudit = buildRealismAudit({ realGuidelineIntake, sourceCueLayer, promptCatalog });
  const realismAuditHash = sha256(realismAudit);
  const modelMeta = await modelMetadata(metrics.liveCalls);
  for (const record of metrics.ioRecords) {
    await writeJson(`model_io/${record.route_id}/${record.group_id}/seed-${record.seed}.json`, record);
    for (const smtFile of record.compiled_target?.smt_files ?? []) {
      await writeText(smtFile.file, smtFile.text);
    }
  }
  for (const entry of promptCatalog.entries) {
    await writeText(entry.prompt_path, entry.prompt_text);
  }
  await writeJson("prompts/catalog.json", promptCatalog);
  await writeJson("metrics/raw_rows.json", metrics.rawRows);
  await writeJson("metrics/route_metrics.json", metrics.routeMetrics);
  await writeJson("metrics/lift_table.json", metrics.liftTable);
  await writeJson("metrics/direct_smt_audit.json", directSmtAudit);
  await writeJson("metrics/source_cues.json", sourceCueLayer);
  await writeJson("metrics/route_targets.json", routeTargetSummary);
  await writeJson("metrics/route_evaluation.json", routeEvaluation);
  await writeJson("metrics/realism_audit.json", realismAudit);

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
      fixture_semantics: m1InputRefs.fixture_semantics_hash,
      experiment_registry: m1InputRefs.experiments_registry_hash,
      gold_expectations: m1InputRefs.gold_expectations_hash,
      real_guidelines: realGuidelineIntake.registry_hash
    }),
    lexicon_hash: sha256([...new Set(fixtureRegistry.flatMap((fixture) => (
      fixture.terminology_bindings ?? []
    ).map((binding) => binding.code)))].sort()),
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
    route_target_summary: routeTargetSummary,
    route_evaluation: routeEvaluation,
    prompt_catalog: {
      artifact_kind: promptCatalog.artifact_kind,
      schema_version: promptCatalog.schema_version,
      scope: promptCatalog.scope,
      prompt_hash_method: promptCatalog.prompt_hash_method,
      prompt_count: promptCatalog.prompt_count,
      call_count: promptCatalog.call_count,
      catalog_hash: sha256(promptCatalog),
      entries: promptCatalog.entries
    },
    source_cue_layer: {
      artifact_kind: sourceCueLayer.artifact_kind,
      extractor_id: sourceCueLayer.extractor_id,
      scope: sourceCueLayer.scope,
      fairness_note: sourceCueLayer.fairness_note,
      cue_hash: sha256(sourceCueLayer)
    },
    m2_evaluation: {
      evaluator_id: routeEvaluation.evaluator_id,
      evaluation_strength: routeEvaluation.evaluation_strength,
      evaluation_strength_note: routeEvaluation.evaluation_strength_note,
      evaluation_groups: routeEvaluation.evaluation_groups,
      holdout_group_ids: routeEvaluation.holdout_group_ids,
      diagnostic_categories: routeEvaluation.diagnostic_categories
    },
    realism_audit: {
      ...realismAudit,
      audit_hash: realismAuditHash
    },
    real_guideline_intake: {
      artifact_id: realGuidelineIntake.artifact_id,
      registry_path: realGuidelineIntake.registry_path,
      registry_hash: realGuidelineIntake.registry_hash,
      raw_manifest_path: realGuidelineIntake.raw_manifest_path,
      raw_manifest_hash: realGuidelineIntake.raw_manifest_hash,
      source_count: realGuidelineIntake.source_count,
      candidate_span_count: realGuidelineIntake.candidate_span_count,
      admitted_candidate_rule_count: realGuidelineIntake.admitted_candidate_rule_count,
      rejected_candidate_span_count: realGuidelineIntake.rejected_candidate_span_count,
      residual_count: realGuidelineIntake.residual_count,
      blocking_residual_count: realGuidelineIntake.blocking_residual_count,
      route_rule_schema_id: realGuidelineIntake.route_rule_schema_id,
      admission_scope: realGuidelineIntake.admission_scope,
      scoring_scope: realGuidelineIntake.scoring_scope,
      clinical_claim_scope: realGuidelineIntake.clinical_claim_scope,
      sources: realGuidelineIntake.sources.map((source) => ({
        id: source.id,
        title_ja: source.title_ja,
        license_label: source.license.label,
        license_url: source.license.url,
        raw_cache_status: source.raw_cache_status,
        source_hash: source.source_hash,
        permission_hash: source.permission_hash,
        candidate_span_count: source.candidate_spans.length,
        admitted_candidate_rule_count: source.admitted_candidate_rules.length,
        rejected_residual_count: source.rejected_residuals.length,
        artifacts: source.artifacts,
        guideline_relation: source.guideline_relation,
        landing_url: source.access.landing_url,
        doi: source.access.doi
      })),
      candidate_span_rows: realGuidelineIntake.sources.flatMap((source) => source.candidate_spans.map((span) => ({
        source_id: source.id,
        region_id: span.region_id,
        cq_id: span.cq_id,
        candidate_rule_status: span.candidate_rule_status,
        direction: span.machine_hint?.direction ?? null,
        strength: span.machine_hint?.strength ?? null,
        certainty: span.machine_hint?.certainty ?? null,
        quote_hash: span.quote_hash,
        machine_hint_hash: span.machine_hint_hash,
        route_rule_id: span.route_rule_id,
        blocking_residual_ids: span.blocking_residual_ids
      }))),
      admitted_candidate_rules: realGuidelineIntake.sources.flatMap((source) => source.admitted_candidate_rules),
      rejected_residuals: realGuidelineIntake.sources.flatMap((source) => source.rejected_residuals)
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
    source_cue_layer_hash: sha256(sourceCueLayer),
    route_target_summary_hash: sha256(routeTargetSummary),
    route_evaluation_hash: sha256(routeEvaluation),
    realism_audit_hash: realismAuditHash,
    prompt_catalog_hash: sha256(promptCatalog),
    prompt_template_hashes: Object.fromEntries(promptCatalog.entries.map((entry) => [entry.prompt_id, entry.prompt_hash])),
    route_ids: routeIds,
    report_hash: sha256(report)
  };
  await writeJson("manifest.json", manifest);

  const events = [
    { event: "run_started", run_id: runId },
    {
      event: "real_guideline_intake_completed",
      outcome: "ok",
      sources: realGuidelineIntake.source_count,
      candidate_spans: realGuidelineIntake.candidate_span_count,
      admitted_candidate_rules: realGuidelineIntake.admitted_candidate_rule_count,
      blocking_residuals: realGuidelineIntake.blocking_residual_count
    },
    { event: "m1_spine_completed", outcome: "ok" },
    { event: "m2_lift_completed", outcome: "ok", model_mode: modelMeta.model_mode, live_model_calls: modelMeta.live_model_calls },
    { event: "run_completed", outcome: "ok" }
  ];
  await writeText("logs/events.jsonl", events.map((entry) => JSON.stringify(stable(entry))).join("\n"));
  const diagnostics = [
    ...metrics.rawRows.flatMap((row) => row.diagnostics.map((code) => ({
      code,
      outcome: code === "false_positive_conflict" ? "incoherence" : "invalid",
      route_id: row.route_id,
      group_id: row.group_id,
      seed: row.seed
    }))),
    ...realGuidelineIntake.sources.flatMap((source) => source.residuals.map((residual) => ({
      code: residual.code,
      outcome: residual.outcome,
      residual_id: residual.residual_id,
      source_id: residual.source_id,
      region_id: residual.region_id,
      stage: residual.stage,
      admission_scope: residual.admission_scope,
      scoring_scope: residual.scoring_scope,
      blocks_candidate_rule: residual.blocks_candidate_rule
    })))
  ];
  await writeText("logs/diagnostics.jsonl", diagnostics.map((entry) => JSON.stringify(stable(entry))).join("\n"));

  const replayManifest = await buildReplayManifest();
  await writeJson("replay_manifest.json", replayManifest);

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
      ...realGuidelineIntake.sources.flatMap((source) => Object.values(source.artifacts).map((artifact) => artifact.path)),
      "metrics/raw_rows.json",
      "metrics/direct_smt_audit.json",
      "metrics/source_cues.json",
      "metrics/route_targets.json",
      "metrics/route_evaluation.json",
      "metrics/realism_audit.json",
      "prompts/catalog.json",
      ...promptCatalog.entries.map((entry) => entry.prompt_path),
      ...(liveModel ? [`route_targets/route.single_ir/${conflictGroupResult.compiled.group_id}/seed-${sampleSeeds[0]}/smt/q.overlap.smt2`] : []),
      `model_io/route.direct_smt/${conflictGroupResult.compiled.group_id}/seed-${sampleSeeds[0]}.json`
    ];
    const commonAssertions = [
      finding?.conflict_kind === "deontic_direction_conflict",
      nullResult?.classification === "documented_null_result",
      direct.samples === groups.length * sampleSeeds.length,
      single.samples === groups.length * sampleSeeds.length,
      metrics.rawRows.length === routeIds.length * groups.length * sampleSeeds.length,
      metrics.ioRecords.length === metrics.rawRows.length,
      routeEvaluation.raw_row_count === metrics.rawRows.length,
      routeEvaluation.holdout_group_ids.includes("group.m2_holdout_conflict"),
      routeEvaluation.evaluation_groups.some((group) => group.group_id === "group.m2_holdout_conflict" && group.measurement_role === "holdout_mutation_conflict"),
      metrics.rawRows.some((row) => row.group_id === "group.m2_holdout_conflict"),
      metrics.rawRows.every((row) => row.evaluator_id === routeEvaluation.evaluator_id),
      metrics.rawRows.every((row) => Array.isArray(row.diagnostic_categories)),
      realGuidelineIntake.source_count >= 2,
      realGuidelineIntake.candidate_span_count >= 6,
      realGuidelineIntake.admitted_candidate_rule_count >= 4,
      realGuidelineIntake.blocking_residual_count >= 2,
      realGuidelineIntake.sources.every((source) => source.admission_scope === realSourceScope),
      realGuidelineIntake.sources.every((source) => source.scoring_scope === "not_in_locked_m1_m2_measurement"),
      realGuidelineIntake.sources.every((source) => source.source_hash?.length === 64 && source.permission_hash?.length === 64),
      realGuidelineIntake.sources.every((source) => Object.values(source.artifacts).every((artifact) => artifact.path && artifact.hash?.length === 64)),
      realGuidelineIntake.sources.flatMap((source) => source.candidate_spans).every((span) => span.machine_hint_hash?.length === 64),
      report.real_guideline_intake.admitted_candidate_rule_count === realGuidelineIntake.admitted_candidate_rule_count,
      report.real_guideline_intake.rejected_residuals.length === realGuidelineIntake.blocking_residual_count,
      report.real_guideline_intake.scoring_scope === "not_in_locked_m1_m2_measurement",
      promptCatalog.prompt_count === routeIds.length * groups.length,
      promptCatalog.call_count === metrics.ioRecords.length,
      promptCatalog.entries.every((entry) => !/Import payload:\n\{/.test(entry.prompt_text)),
      promptCatalog.entries.every((entry) => !/normalized fields for /.test(entry.prompt_text)),
      report.prompt_catalog.catalog_hash === sha256(promptCatalog),
      report.m2_evaluation.evaluation_strength === "scaffolded_cue_translation_test",
      report.m2_evaluation.holdout_group_ids.includes("group.m2_holdout_conflict"),
      report.realism_audit.audit_hash === realismAuditHash,
      realismAudit.surfaces.some((surface) => surface.surface_id === "fixture_regions" && surface.classification === "data_driven"),
      realismAudit.surfaces.some((surface) => surface.surface_id === "context_overlap_and_smt_encoding" && surface.classification === "hardcoded"),
      realismAudit.surfaces.some((surface) => surface.surface_id === "llm_prompt_templates" && surface.classification === "prompt_scaffolded"),
      realismAudit.surfaces.some((surface) => surface.surface_id === "report_renderer" && surface.evidence_paths.every((entry) => entry !== "index.html")),
      metrics.ioRecords.every((record) => record.prompt_hash === sha256Text(record.prompt)),
      metrics.ioRecords.every((record) => !record.route_call || record.route_call.prompt_hash === sha256Text(record.route_call.prompt)),
      ...requiredFiles.map((relative) => existsSync(path.join(runDir, relative)))
    ];
    const modelAssertions = liveModel
      ? [
          report.model_mode === "live_local_llama_cpp",
          report.live_model_calls === metrics.liveCalls,
          report.live_model_calls === routeIds.length * groups.length * sampleSeeds.length,
          report.model_identity.startsWith("Qwen2.5-0.5B-Instruct-Q2_K:"),
          report.source_cue_layer.extractor_id === "lexical_cue_v1",
          report.route_target_summary.compiled_row_count === metrics.ioRecords.filter((record) => record.route_id === "route.single_ir" && record.compiled_target).length,
          report.route_target_summary.smt_file_count === metrics.ioRecords
            .filter((record) => record.route_id === "route.single_ir")
            .flatMap((record) => record.compiled_target?.smt_files ?? []).length,
          metrics.ioRecords.filter((record) => record.route_id === "route.single_ir").every((record) => record.compiled_target?.target_profile === "smt-lib-2"),
          metrics.ioRecords.every((record) => record.subprocess?.exit_status === 0),
          metrics.ioRecords.every((record) => record.response_hash && record.response_hash.length === 64),
          direct.target_syntax_validity.denominator === direct.samples,
          single.target_syntax_validity.denominator === single.samples,
          report.direct_smt_audit.exact_template_match_rate.denominator === direct.samples,
          report.direct_smt_audit.missing_named_assertion_rate.denominator === direct.samples,
          report.direct_smt_audit.negated_sepsis_assertion_rate.denominator === direct.samples,
          single.k_sample_stability.denominator === groups.length
        ]
      : [
          report.model_mode === "recorded_unsupported",
          report.live_model_calls === 0,
          direct.target_syntax_validity.exact === `0/${direct.samples}`,
          direct.admission_rate.exact === `0/${direct.samples}`,
          direct.admitted_verdict_accuracy.exact === `0/${direct.samples}`,
          single.target_syntax_validity.exact === `0/${single.samples}`,
          single.admission_rate.exact === `0/${single.samples}`,
          single.admitted_verdict_accuracy.exact === `0/${single.samples}`
        ];
    const assertions = [...commonAssertions, ...modelAssertions];
    if (assertions.some((entry) => !entry)) {
      throw new Error("one-shot verification failed");
    }
  }

  console.log(JSON.stringify({
    run_dir: path.relative(root, runDir),
    report: path.relative(root, path.join(runDir, "report.json")),
    manuscript_figures: "figures/manuscript",
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
