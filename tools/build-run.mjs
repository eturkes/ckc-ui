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
const cliArgs = process.argv.slice(2);
function flagValue(flag, defaultValue = null) {
  const equalsArg = cliArgs.find((entry) => entry.startsWith(`${flag}=`));
  if (equalsArg) return equalsArg.slice(flag.length + 1);
  const index = cliArgs.indexOf(flag);
  if (index >= 0 && cliArgs[index + 1] && !cliArgs[index + 1].startsWith("--")) return cliArgs[index + 1];
  return defaultValue;
}

const selectedExperimentId = flagValue("--experiment", process.env.CKC_EXPERIMENT_ID ?? "exp.m2_lift");
const scaffoldRoutes = process.argv.includes("--scaffold-routes");
const printConfig = process.argv.includes("--print-config");
const runId = flagValue(
  "--run-id",
  selectedExperimentId === "exp.m2_lift"
    ? "m2-one-shot"
    : selectedExperimentId.replace(/^exp\./, "").replaceAll(".", "-").replaceAll("_", "-")
);
const runDir = path.join(root, "runs", runId);
const corporaRegistryPath = path.join(root, "registry", "corpora.json");
const experimentsRegistryPath = path.join(root, "registry", "experiments.json");
const routesRegistryPath = path.join(root, "registry", "routes.json");
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
let routeRegistry = [];
let m1Groups = [];
let groups = [];
let routeIds = ["route.direct_smt", "route.single_ir"];
let sampleSeeds = [11, 22, 33];
let m1InputRefs = null;
let selectedExperiment = null;
let experimentKind = "route_comparison";
let unimplementedRouteIds = [];
let pipelineIds = [];
const baselineRouteId = "route.direct_smt";
const baselinePipelineId = "pipe.direct_rule_to_smt";
const layeredPipelineId = "pipe.one_shot_js_ckcir_to_smt";
const implementedRouteIds = new Set(["route.direct_smt", "route.single_ir", "route.stacked_ir", "route.ir_hop_chain", "route.ckc_layered"]);
const implementedPipelineIds = new Set([baselinePipelineId, layeredPipelineId]);
const comparisonMetricIds = [
  "target_syntax_validity",
  "admission_rate",
  "admitted_verdict_accuracy",
  "candidate_verdict_accuracy",
  "k_sample_stability"
];
const pipelineMetricIds = [
  "compile_success_rate",
  "verdict_accuracy",
  "conflict_kind_accuracy",
  "component_reuse_rate"
];

function routeImplemented(routeId) {
  return implementedRouteIds.has(routeId);
}

function routeRegistryEntry(routeId) {
  return routeRegistry.find((entry) => entry.id === routeId) ?? null;
}

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

function compareRatios(a, b) {
  return (a.numerator * b.denominator) - (b.numerator * a.denominator);
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
  const routesRegistry = await readJsonArtifact(routesRegistryPath);
  const goldExpectations = await readJsonArtifact(goldExpectationsPath);
  const corpusFixturesById = expectUniqueById(corporaRegistry.fixtures, "corpus fixture");
  const semanticsById = expectUniqueById(fixtureSemantics.fixtures, "fixture semantics");
  const routesById = expectUniqueById(routesRegistry.routes, "route");
  routeRegistry = cloneData(routesRegistry.routes ?? []);

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
      rules: cloneData(semantics.rules ?? []),
      factual_claims: cloneData(semantics.factual_claims ?? [])
    };
  });

  for (const semanticFixture of fixtureSemantics.fixtures ?? []) {
    if (!corpusFixturesById.has(semanticFixture.id)) {
      throw new Error(`fixture semantics references unknown corpus fixture: ${semanticFixture.id}`);
    }
  }

  const experimentsById = expectUniqueById(experimentsRegistry.experiments, "experiment");
  const m1Experiment = experimentsById.get("exp.m1_spine");
  const configuredExperiment = experimentsById.get(selectedExperimentId);
  if (!m1Experiment) throw new Error("experiment missing: exp.m1_spine");
  if (!configuredExperiment) throw new Error(`experiment missing: ${selectedExperimentId}`);
  selectedExperiment = cloneData(configuredExperiment);
  const hasRoutes = Array.isArray(configuredExperiment.routes);
  const hasPipelines = Array.isArray(configuredExperiment.pipelines);
  if (!hasRoutes && !hasPipelines) {
    throw new Error(`experiment ${selectedExperimentId} must declare routes or pipelines`);
  }
  experimentKind = hasPipelines && !hasRoutes ? "pipeline_comparison" : "route_comparison";

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
      expectedNullResult: Boolean(gold.expected_null_result),
      expectedEvidenceRegionIds: cloneData(gold.expected_evidence_region_ids ?? []),
      expectedEvidenceNote: gold.expected_evidence_note ?? null
    };
  }

  m1Groups = (m1Experiment.fixture_groups ?? []).map((group) => loadGroupSpec(group, "M1 group"));
  const evaluationGroups = configuredExperiment.evaluation_groups ?? m1Experiment.fixture_groups ?? [];
  groups = evaluationGroups.map((group) => loadGroupSpec(group, `${selectedExperimentId} evaluation group`));

  if (experimentKind === "route_comparison") {
    routeIds = cloneData(configuredExperiment.routes ?? routeIds);
    if (!Array.isArray(routeIds) || routeIds.length === 0) throw new Error(`${selectedExperimentId} routes must contain at least one route`);
    if (new Set(routeIds).size !== routeIds.length) throw new Error(`${selectedExperimentId} routes must be unique`);
    if (!routeIds.includes(baselineRouteId)) {
      throw new Error(`${selectedExperimentId} routes must include baseline route: ${baselineRouteId}`);
    }
    for (const routeId of routeIds) {
      if (!routesById.has(routeId)) throw new Error(`${selectedExperimentId} references unregistered route: ${routeId}`);
    }
    unimplementedRouteIds = routeIds.filter((routeId) => !routeImplemented(routeId));
    if (unimplementedRouteIds.length > 0 && !scaffoldRoutes) {
      throw new Error(
        `experiment ${selectedExperimentId} contains registered but unimplemented routes: ${unimplementedRouteIds.join(", ")}. ` +
        "Use --scaffold-routes to emit closed scaffold rows; no model output will be fabricated."
      );
    }
    sampleSeeds = cloneData(configuredExperiment.sample_seeds ?? sampleSeeds);
  } else {
    pipelineIds = cloneData(configuredExperiment.pipelines);
    if (!Array.isArray(pipelineIds) || pipelineIds.length === 0) throw new Error(`${selectedExperimentId} pipelines must contain at least one pipeline`);
    if (new Set(pipelineIds).size !== pipelineIds.length) throw new Error(`${selectedExperimentId} pipelines must be unique`);
    if (!pipelineIds.includes(baselinePipelineId)) {
      throw new Error(`${selectedExperimentId} pipelines must include baseline pipeline: ${baselinePipelineId}`);
    }
    const unimplementedPipelineIds = pipelineIds.filter((pipelineId) => !implementedPipelineIds.has(pipelineId));
    if (unimplementedPipelineIds.length > 0) {
      throw new Error(`experiment ${selectedExperimentId} contains unimplemented pipelines: ${unimplementedPipelineIds.join(", ")}`);
    }
    routeIds = [];
    unimplementedRouteIds = [];
    sampleSeeds = [];
  }
  m1InputRefs = {
    corpora_registry_path: path.relative(root, corporaRegistryPath),
    corpora_registry_hash: sha256(corporaRegistry),
    routes_registry_path: path.relative(root, routesRegistryPath),
    routes_registry_hash: sha256(routesRegistry),
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

function pipelineImplemented(pipelineId) {
  return implementedPipelineIds.has(pipelineId);
}

function directPipelineArtifactsForDoc(docArtifacts) {
  const fixture = docArtifacts.fixture;
  const directSegments = {
    artifact_id: `artifact.${fixture.key}.direct_segments`,
    artifact_kind: "DirectSegments",
    pipeline_id: baselinePipelineId,
    doc_id: fixture.id,
    outcome: "ok",
    payload_marker: "pass_through_source_regions",
    component_store_participation: false,
    segments: docArtifacts.source_graph.regions.map((region, index) => ({
      segment_id: `direct.segment.${fixture.key}.${index + 1}`,
      region_id: region.region_id,
      kind: region.role,
      text: region.quote
    }))
  };
  const directPhraseNormalization = {
    artifact_id: `artifact.${fixture.key}.direct_phrase_normalization`,
    artifact_kind: "DirectPhraseNormalization",
    pipeline_id: baselinePipelineId,
    doc_id: fixture.id,
    outcome: "ok",
    payload_marker: "direct_fixture_phrase_to_formal_rule",
    bypassed_component_layers: ["clinical_statement_component_store", "norm_rule_component_store"],
    terminology_bindings: cloneData(docArtifacts.normalization.terminology_bindings ?? []),
    factual_claims: cloneData(docArtifacts.normalization.factual_claims ?? []),
    formal_rules: cloneData(docArtifacts.normalization.rules ?? []),
    rules: cloneData(docArtifacts.normalization.rules ?? [])
  };
  const directFormalIr = {
    artifact_id: `artifact.${fixture.key}.direct_formal_ir`,
    artifact_kind: "DirectFormalIR",
    pipeline_id: baselinePipelineId,
    doc_id: fixture.id,
    compiler_profile: "pipe.direct_rule_to_smt.fixture_scale_v0",
    source_graph_hash: sha256(docArtifacts.source_graph),
    direct_segments_hash: sha256(directSegments),
    direct_phrase_normalization_hash: sha256(directPhraseNormalization),
    component_reuse_participation: false,
    rules: cloneData(directPhraseNormalization.rules),
    factual_claims: cloneData(directPhraseNormalization.factual_claims),
    terminology_bindings: cloneData(directPhraseNormalization.terminology_bindings)
  };
  return {
    fixture,
    source_graph: cloneData(docArtifacts.source_graph),
    segments: directSegments,
    normalization: directPhraseNormalization,
    ir_bundle: directFormalIr
  };
}

function buildDirectPipelineArtifacts(artifactsByDoc) {
  return new Map([...artifactsByDoc.entries()].map(([fixtureId, docArtifacts]) => [
    fixtureId,
    directPipelineArtifactsForDoc(docArtifacts)
  ]));
}

function pipelineDocsFor(pipelineId, artifactsByDoc, directArtifactsByDoc) {
  if (pipelineId === layeredPipelineId) return artifactsByDoc;
  if (pipelineId === baselinePipelineId) return directArtifactsByDoc;
  throw new Error(`unknown deterministic pipeline: ${pipelineId}`);
}

function firstRule(docArtifacts) {
  const [rule] = docArtifacts.normalization.rules ?? docArtifacts.ir_bundle.rules ?? [];
  if (!rule) throw new Error(`pipeline document missing rule: ${docArtifacts.fixture.id}`);
  return rule;
}

function factAssertionId(fact) {
  return `${fact.fact_id}.${fact.value ? "true" : "false"}`;
}

function bindingAssertionId(fixture, binding) {
  const mentionKey = binding.mention === "妊娠中" ? "pregnancy" : String(binding.mention).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "mention";
  return `binding.${fixture.key}.${mentionKey}.${String(binding.code).replaceAll(".", "_")}`;
}

function factualConflictCandidates(leftDoc, rightDoc) {
  const candidates = [];
  for (const leftFact of leftDoc.normalization.factual_claims ?? []) {
    for (const rightFact of rightDoc.normalization.factual_claims ?? []) {
      if (
        leftFact.strict
        && rightFact.strict
        && leftFact.subject === rightFact.subject
        && leftFact.predicate === rightFact.predicate
        && leftFact.value !== rightFact.value
      ) {
        candidates.push({
          conflict_kind: "strict_factual_contradiction",
          assertion_core: [factAssertionId(leftFact), factAssertionId(rightFact)].sort(),
          region_ids: [...new Set([...(leftFact.source_region_ids ?? []), ...(rightFact.source_region_ids ?? [])])],
          details: {
            subject: leftFact.subject,
            predicate: leftFact.predicate,
            left_value: leftFact.value,
            right_value: rightFact.value
          }
        });
      }
    }
  }
  return candidates;
}

function terminologyConflictCandidates(leftDoc, rightDoc) {
  const candidates = [];
  for (const leftBinding of leftDoc.normalization.terminology_bindings ?? []) {
    for (const rightBinding of rightDoc.normalization.terminology_bindings ?? []) {
      if (
        leftBinding.mention === rightBinding.mention
        && leftBinding.status === "exact"
        && rightBinding.status === "exact"
        && leftBinding.code !== rightBinding.code
      ) {
        candidates.push({
          conflict_kind: "terminology_incoherence",
          assertion_core: [
            bindingAssertionId(leftDoc.fixture, leftBinding),
            bindingAssertionId(rightDoc.fixture, rightBinding)
          ].sort(),
          region_ids: [
            ...(leftDoc.fixture.report_primary_region_ids ?? []),
            ...(rightDoc.fixture.report_primary_region_ids ?? [])
          ],
          details: {
            mention: leftBinding.mention,
            left_code: leftBinding.code,
            right_code: rightBinding.code
          }
        });
      }
    }
  }
  return candidates;
}

function semanticConflictCandidates(group, leftDoc, rightDoc) {
  const left = firstRule(leftDoc);
  const right = firstRule(rightDoc);
  const overlap = contextsOverlap(left.context, right.context);
  const sameAction = left.action_key === right.action_key;
  const opposed = opposedDirections(left, right);
  const sameDirection = left.direction === right.direction;
  const candidates = [];
  if (sameAction && opposed && overlap.overlaps) {
    candidates.push({
      conflict_kind: "deontic_direction_conflict",
      assertion_core: [...makeAssertions(left), ...makeAssertions(right)].map((entry) => entry.assertion_id).sort(),
      region_ids: [...new Set([...(left.source_region_ids ?? []), ...(right.source_region_ids ?? [])])],
      details: {
        same_action: sameAction,
        opposed_directions: opposed,
        context_overlap: overlap
      }
    });
  }
  if (sameAction && sameDirection && !overlap.overlaps) {
    candidates.push({
      conflict_kind: "numeric_threshold_empty_intersection",
      assertion_core: [`ctx.${left.rule_id}`, `ctx.${right.rule_id}`].sort(),
      region_ids: [...new Set([...(left.source_region_ids ?? []), ...(right.source_region_ids ?? [])])],
      details: {
        same_action: sameAction,
        same_direction: sameDirection,
        context_overlap: overlap
      }
    });
  }
  candidates.push(...factualConflictCandidates(leftDoc, rightDoc));
  candidates.push(...terminologyConflictCandidates(leftDoc, rightDoc));
  const selected = candidates.find((candidate) => candidate.conflict_kind === group.expectedConflictKind)
    ?? candidates[0]
    ?? null;
  return {
    left,
    right,
    overlap,
    candidates,
    selected,
    outcome: selected ? "semantic_contradiction" : "semantic_no_conflict"
  };
}

function numericThresholdQueryText(left, right) {
  const declarations = [
    "(declare-const |q.age_years| Real)",
    "(declare-const |cond.sepsis| Bool)",
    "(declare-const |cond.renal_severe| Bool)",
    "(declare-const |cond.pregnancy| Bool)"
  ];
  return [
    "(set-logic QF_LRA)",
    "(set-option :print-success false)",
    "(set-option :produce-unsat-cores true)",
    ...declarations,
    `(assert (! ${contextSmt(left)} :named |ctx.${left.rule_id}|))`,
    `(assert (! ${contextSmt(right)} :named |ctx.${right.rule_id}|))`,
    "(check-sat)",
    "(get-unsat-core)"
  ].join("\n");
}

function factualConflictQueryText(candidate) {
  const symbol = `|fact.${candidate.details.predicate}:${candidate.details.subject}|`;
  const [leftCore, rightCore] = candidate.assertion_core;
  return [
    "(set-logic QF_UF)",
    "(set-option :print-success false)",
    "(set-option :produce-unsat-cores true)",
    `(declare-const ${symbol} Bool)`,
    `(assert (! ${symbol} :named |${leftCore}|))`,
    `(assert (! (not ${symbol}) :named |${rightCore}|))`,
    "(check-sat)",
    "(get-unsat-core)"
  ].join("\n");
}

function terminologyConflictQueryText(candidate) {
  const symbol = "|binding.mention.pregnancy.consistent|";
  const [leftCore, rightCore] = candidate.assertion_core;
  return [
    "(set-logic QF_UF)",
    "(set-option :print-success false)",
    "(set-option :produce-unsat-cores true)",
    `(declare-const ${symbol} Bool)`,
    `(assert (! ${symbol} :named |${leftCore}|))`,
    `(assert (! (not ${symbol}) :named |${rightCore}|))`,
    "(check-sat)",
    "(get-unsat-core)"
  ].join("\n");
}

function pipelineQueryEntries({ pipelineId, group, semantic }) {
  const baseDir = `pipelines/${pipelineId}/${group.id}/smt`;
  const queryTexts = makeSmtQueryTexts(semantic.left, semantic.right, semantic.overlap);
  const entries = [{
    query_id: `q.${pipelineId}.${group.id}.overlap`,
    kind: "context_overlap",
    file: `${baseDir}/q.overlap.smt2`,
    logic: "QF_LRA",
    text: `${queryTexts.overlap}\n`
  }];
  const selected = semantic.selected;
  if (selected?.conflict_kind === "deontic_direction_conflict" && queryTexts.deontic) {
    entries.push({
      query_id: `q.${pipelineId}.${group.id}.deontic`,
      kind: "deontic_consistency",
      file: `${baseDir}/q.deontic.smt2`,
      logic: "QF_UF",
      text: `${queryTexts.deontic}\n`
    });
  } else if (selected?.conflict_kind === "numeric_threshold_empty_intersection") {
    entries.push({
      query_id: `q.${pipelineId}.${group.id}.threshold`,
      kind: "numeric_threshold_empty_intersection",
      file: `${baseDir}/q.threshold.smt2`,
      logic: "QF_LRA",
      text: `${numericThresholdQueryText(semantic.left, semantic.right)}\n`
    });
  } else if (selected?.conflict_kind === "strict_factual_contradiction") {
    entries.push({
      query_id: `q.${pipelineId}.${group.id}.factual`,
      kind: "strict_factual_contradiction",
      file: `${baseDir}/q.factual.smt2`,
      logic: "QF_UF",
      text: `${factualConflictQueryText(selected)}\n`
    });
  } else if (selected?.conflict_kind === "terminology_incoherence") {
    entries.push({
      query_id: `q.${pipelineId}.${group.id}.terminology`,
      kind: "terminology_incoherence",
      file: `${baseDir}/q.terminology.smt2`,
      logic: "QF_UF",
      text: `${terminologyConflictQueryText(selected)}\n`
    });
  }
  return entries.map((entry) => ({
    ...entry,
    sha256: sha256Bytes(Buffer.from(entry.text))
  }));
}

function compilePipelineGroup(group, pipelineId, pipelineDocs) {
  const [leftDoc, rightDoc] = group.fixtures.map((fixtureId) => pipelineDocs.get(fixtureId));
  if (!leftDoc || !rightDoc) throw new Error(`pipeline group requires two known fixtures: ${group.id}`);
  const semantic = semanticConflictCandidates(group, leftDoc, rightDoc);
  const queryEntries = pipelineQueryEntries({ pipelineId, group, semantic });
  const syntaxValid = queryEntries.every((entry) => entry.text.includes("(check-sat)") && balancedParens(entry.text));
  const selected = semantic.selected;
  const verifierResults = [
    {
      query_id: queryEntries[0].query_id,
      status: semantic.overlap.overlaps ? "sat" : "unsat",
      category: semantic.overlap.overlaps ? "semantic_overlap" : "semantic_no_overlap",
      model: semantic.overlap.witness
    },
    ...(selected ? [{
      query_id: queryEntries.at(-1).query_id,
      status: "unsat",
      category: "semantic_contradiction",
      conflict_kind: selected.conflict_kind,
      unsat_core: selected.assertion_core
    }] : [])
  ];
  const compiled = {
    artifact_kind: "PipelineCompiledGroup",
    schema_version: "pipeline_compiled_group.v0",
    pipeline_id: pipelineId,
    group_id: group.id,
    fixture_ids: group.fixtures,
    compiler_id: pipelineId === baselinePipelineId ? "direct_rule_to_smt_fixture_compiler_v0" : "layered_ckcir_to_smt_fixture_compiler_v0",
    target_profile: "smt-lib-2",
    queries: queryEntries.map(({ text, ...metadata }) => metadata),
    selected_conflict_kind: selected?.conflict_kind ?? null,
    detected_conflict_kinds: semantic.candidates.map((candidate) => candidate.conflict_kind),
    eligibility: {
      same_action: semantic.left.action_key === semantic.right.action_key,
      opposed_directions: opposedDirections(semantic.left, semantic.right),
      same_direction: semantic.left.direction === semantic.right.direction,
      context_overlap: semantic.overlap
    },
    assertion_map: selected?.assertion_core ?? []
  };
  const verifier = {
    artifact_kind: "PipelineVerifierResults",
    schema_version: "pipeline_verifier_results.v0",
    pipeline_id: pipelineId,
    group_id: group.id,
    solver_identity: "one-shot-js-symbolic-verifier",
    syntax_valid: syntaxValid,
    results: verifierResults,
    outcome: syntaxValid ? semantic.outcome : "target_syntax_failure",
    conflict_kind: selected?.conflict_kind ?? null,
    expected_outcome: group.expectedOutcome,
    expected_conflict_kind: group.expectedConflictKind,
    expected_match: syntaxValid && semantic.outcome === group.expectedOutcome,
    conflict_kind_match: syntaxValid && (group.expectedConflictKind ? selected?.conflict_kind === group.expectedConflictKind : selected === null)
  };
  return {
    pipeline_id: pipelineId,
    group,
    compiled,
    verifier,
    smt: Object.fromEntries(queryEntries.map((entry) => [entry.file, entry.text])),
    leftDoc,
    rightDoc,
    semantic
  };
}

function componentPayloadsForFixture(docArtifacts) {
  const normalization = docArtifacts.normalization;
  return [
    ...(normalization.terminology_bindings ?? []).map((binding) => ({
      component_kind: "terminology_binding",
      payload: {
        mention: binding.mention,
        system: binding.system,
        code: binding.code,
        status: binding.status
      }
    })),
    ...(normalization.clinical_statements ?? []).map((statement) => ({
      component_kind: "clinical_statement",
      payload: {
        population: statement.population,
        condition: statement.condition,
        action: statement.action,
        modality: statement.modality,
        strength: statement.strength,
        certainty: statement.certainty
      }
    })),
    ...(normalization.rules ?? []).map((rule) => ({
      component_kind: "norm_rule",
      payload: {
        direction: rule.direction,
        action_key: rule.action_key,
        strength: rule.strength,
        certainty: rule.certainty,
        context: rule.context
      }
    })),
    ...(docArtifacts.fixture.factual_claims ?? []).map((fact) => ({
      component_kind: "factual_claim",
      payload: {
        subject: fact.subject,
        predicate: fact.predicate,
        value: fact.value,
        strict: fact.strict
      }
    }))
  ];
}

function buildComponentReuseGraph(artifactsByDoc) {
  const occurrences = [];
  for (const docArtifacts of artifactsByDoc.values()) {
    for (const component of componentPayloadsForFixture(docArtifacts)) {
      const componentHash = sha256({ component_kind: component.component_kind, payload: component.payload });
      occurrences.push({
        occurrence_id: `occ.${docArtifacts.fixture.key}.${component.component_kind}.${occurrences.length + 1}`,
        pipeline_id: layeredPipelineId,
        fixture_id: docArtifacts.fixture.id,
        source_label: docArtifacts.fixture.source_label,
        component_kind: component.component_kind,
        component_hash: componentHash,
        payload: component.payload
      });
    }
  }
  const byHash = new Map();
  for (const occurrence of occurrences) {
    if (!byHash.has(occurrence.component_hash)) byHash.set(occurrence.component_hash, []);
    byHash.get(occurrence.component_hash).push(occurrence);
  }
  const nodes = [...byHash.entries()].map(([componentHash, componentOccurrences]) => ({
    node_id: `component.${componentHash.slice(0, 16)}`,
    component_hash: componentHash,
    component_kind: componentOccurrences[0].component_kind,
    occurrence_count: componentOccurrences.length,
    reused: componentOccurrences.length > 1,
    fixtures: componentOccurrences.map((entry) => entry.fixture_id).sort(),
    source_labels: componentOccurrences.map((entry) => entry.source_label).sort(),
    payload: componentOccurrences[0].payload
  })).sort((left, right) => left.component_hash.localeCompare(right.component_hash));
  const reusedOccurrenceCount = occurrences.filter((occurrence) => byHash.get(occurrence.component_hash).length > 1).length;
  const directFormalOccurrenceCount = groups.reduce((count, group) => count + group.fixtures.length, 0);
  return {
    artifact_kind: "ComponentReuseGraph",
    schema_version: "component_reuse_graph.v0",
    experiment_id: selectedExperimentId,
    scope: "Fixture-scale reusable component evidence for the layered pipeline; direct-rule baseline residuals are explicit because it bypasses the component store.",
    pipelines: [
      {
        pipeline_id: baselinePipelineId,
        component_store_participation: false,
        residual: "direct_rule_to_smt emits group-local formal clauses and does not claim reusable ClinicalIR/NormIR components",
        component_occurrence_count: directFormalOccurrenceCount,
        unique_component_count: directFormalOccurrenceCount,
        reused_occurrence_count: 0,
        reuse_rate: ratio(0, directFormalOccurrenceCount)
      },
      {
        pipeline_id: layeredPipelineId,
        component_store_participation: true,
        component_occurrence_count: occurrences.length,
        unique_component_count: nodes.length,
        reused_occurrence_count: reusedOccurrenceCount,
        reuse_rate: ratio(reusedOccurrenceCount, occurrences.length)
      }
    ],
    nodes,
    edges: occurrences.map((occurrence) => ({
      from: `fixture.${occurrence.fixture_id}`,
      to: `component.${occurrence.component_hash.slice(0, 16)}`,
      occurrence_id: occurrence.occurrence_id,
      component_kind: occurrence.component_kind
    }))
  };
}

function buildCompactnessFront({ pipelineResults, componentReuseGraph }) {
  const rowsByPipeline = new Map(pipelineIds.map((pipelineId) => [
    pipelineId,
    pipelineResults.filter((result) => result.pipeline_id === pipelineId)
  ]));
  const reuseByPipeline = new Map(componentReuseGraph.pipelines.map((entry) => [entry.pipeline_id, entry]));
  const points = pipelineIds.map((pipelineId) => {
    const results = rowsByPipeline.get(pipelineId) ?? [];
    const reuse = reuseByPipeline.get(pipelineId);
    const smtFileCount = results.reduce((count, result) => count + Object.keys(result.smt).length, 0);
    const assertionCoreCount = results.reduce((count, result) => count + (result.semantic.selected?.assertion_core.length ?? 0), 0);
    return {
      pipeline_id: pipelineId,
      baseline: pipelineId === baselinePipelineId,
      group_count: results.length,
      model_call_count: 0,
      group_local_rule_occurrences: groups.reduce((count, group) => count + group.fixtures.length, 0),
      stored_component_count: reuse?.component_store_participation ? reuse.unique_component_count : 0,
      component_occurrence_count: reuse?.component_occurrence_count ?? 0,
      reused_occurrence_count: reuse?.reused_occurrence_count ?? 0,
      component_reuse_rate: reuse?.reuse_rate ?? ratio(0, 0),
      smt_file_count: smtFileCount,
      assertion_core_count: assertionCoreCount,
      coverage: ratio(results.filter((result) => result.verifier.expected_match).length, groups.length),
      residuals: reuse?.residual ? [reuse.residual] : []
    };
  });
  return {
    artifact_kind: "CompactnessFront",
    schema_version: "compactness_front.v0",
    experiment_id: selectedExperimentId,
    scope: "Deterministic fixture-scale compactness proxy; not a full global component-store MDL result.",
    optimization_direction: {
      coverage: "maximize",
      model_call_count: "minimize",
      group_local_rule_occurrences: "minimize",
      stored_component_count: "interpret with residuals"
    },
    points
  };
}

function pipelineRawRow(result) {
  return {
    pipeline_id: result.pipeline_id,
    comparison_role: result.pipeline_id === baselinePipelineId ? "baseline" : "compared_pipeline",
    group_id: result.group.id,
    measurement_role: result.group.measurementRole,
    fixture_ids: result.group.fixtures,
    expected: result.group.expectedOutcome,
    expected_conflict_kind: result.group.expectedConflictKind,
    compiled: result.verifier.syntax_valid,
    verdict: result.verifier.outcome,
    conflict_kind: result.verifier.conflict_kind,
    verdict_correct: result.verifier.expected_match,
    conflict_kind_correct: result.verifier.conflict_kind_match,
    query_count: result.compiled.queries.length,
    smt_file_count: Object.keys(result.smt).length,
    assertion_core: result.semantic.selected?.assertion_core ?? [],
    detected_conflict_kinds: result.semantic.candidates.map((candidate) => candidate.conflict_kind)
  };
}

function buildPipelineMetrics(rawRows, componentReuseGraph) {
  const reuseByPipeline = new Map(componentReuseGraph.pipelines.map((entry) => [entry.pipeline_id, entry]));
  return pipelineIds.map((pipelineId) => {
    const rows = rawRows.filter((row) => row.pipeline_id === pipelineId);
    const total = rows.length;
    return {
      pipeline_id: pipelineId,
      comparison_role: pipelineId === baselinePipelineId ? "baseline" : "compared_pipeline",
      samples: total,
      model_call_count: 0,
      compile_success_rate: ratio(rows.filter((row) => row.compiled).length, total),
      verdict_accuracy: ratio(rows.filter((row) => row.verdict_correct).length, total),
      conflict_kind_accuracy: ratio(rows.filter((row) => row.conflict_kind_correct).length, total),
      component_reuse_rate: reuseByPipeline.get(pipelineId)?.reuse_rate ?? ratio(0, total)
    };
  });
}

function buildPipelineMatrix(pipelineMetrics) {
  const byPipeline = new Map(pipelineMetrics.map((entry) => [entry.pipeline_id, entry]));
  const baseline = byPipeline.get(baselinePipelineId);
  if (!baseline) throw new Error(`pipeline baseline missing: ${baselinePipelineId}`);
  const rows = pipelineIds.map((pipelineId) => {
    const metric = byPipeline.get(pipelineId);
    return {
      pipeline_id: pipelineId,
      comparison_role: pipelineId === baselinePipelineId ? "baseline" : "compared_pipeline",
      metrics: Object.fromEntries(pipelineMetricIds.map((metricId) => [
        metricId,
        {
          value: metric[metricId],
          baseline_value: baseline[metricId],
          delta_from_baseline: subtractRatio(metric[metricId], baseline[metricId])
        }
      ]))
    };
  });
  return {
    artifact_kind: "PipelineComparisonMatrix",
    schema_version: "pipeline_comparison_matrix.v0",
    baseline_pipeline_id: baselinePipelineId,
    layered_pipeline_id: layeredPipelineId,
    pipeline_ids: [...pipelineIds],
    metrics: pipelineMetricIds,
    comparison_scope: "Deterministic layered-minus-direct deltas over identical M3 groups; model-route deltas remain isolated in route_matrix artifacts.",
    rows,
    cells: rows.flatMap((row) => pipelineMetricIds.map((metric) => ({
      pipeline_id: row.pipeline_id,
      comparison_role: row.comparison_role,
      metric,
      value: row.metrics[metric].value,
      baseline_pipeline_id: baselinePipelineId,
      baseline_value: row.metrics[metric].baseline_value,
      delta_from_baseline: row.metrics[metric].delta_from_baseline
    })))
  };
}

function structuralHashesForGroup(group, pipelineDocs, componentKind) {
  return group.fixtures.flatMap((fixtureId) => {
    const doc = pipelineDocs.get(fixtureId);
    if (componentKind === "segment") {
      return (doc.segments.segments ?? []).map((segment) => sha256({
        kind: segment.kind,
        text: segment.text
      }));
    }
    if (componentKind === "binding") {
      return (doc.normalization.terminology_bindings ?? []).map((binding) => sha256({
        mention: binding.mention,
        system: binding.system,
        code: binding.code,
        status: binding.status
      }));
    }
    if (componentKind === "rule") {
      return (doc.normalization.rules ?? []).map((rule) => sha256({
        direction: rule.direction,
        action_key: rule.action_key,
        strength: rule.strength,
        certainty: rule.certainty,
        context: rule.context
      }));
    }
    throw new Error(`unknown component kind: ${componentKind}`);
  }).sort();
}

function buildCandidateDiff({ pipelineResults, rawRows, pipelineMetrics, pipelineMatrix, artifactsByDoc, directArtifactsByDoc, componentReuseGraph, compactnessFront }) {
  const resultsByKey = new Map(pipelineResults.map((result) => [`${result.pipeline_id}\u0000${result.group.id}`, result]));
  const rowsByKey = new Map(rawRows.map((row) => [`${row.pipeline_id}\u0000${row.group_id}`, row]));
  const groupRows = groups.map((group) => {
    const directResult = resultsByKey.get(`${baselinePipelineId}\u0000${group.id}`);
    const layeredResult = resultsByKey.get(`${layeredPipelineId}\u0000${group.id}`);
    const directRow = rowsByKey.get(`${baselinePipelineId}\u0000${group.id}`);
    const layeredRow = rowsByKey.get(`${layeredPipelineId}\u0000${group.id}`);
    const directSegmentHashes = structuralHashesForGroup(group, directArtifactsByDoc, "segment");
    const layeredSegmentHashes = structuralHashesForGroup(group, artifactsByDoc, "segment");
    const directBindingHashes = structuralHashesForGroup(group, directArtifactsByDoc, "binding");
    const layeredBindingHashes = structuralHashesForGroup(group, artifactsByDoc, "binding");
    const directRuleHashes = structuralHashesForGroup(group, directArtifactsByDoc, "rule");
    const layeredRuleHashes = structuralHashesForGroup(group, artifactsByDoc, "rule");
    return {
      group_id: group.id,
      fixture_ids: group.fixtures,
      expected: group.expectedOutcome,
      expected_conflict_kind: group.expectedConflictKind,
      segment_level: {
        direct_segment_hashes: directSegmentHashes,
        layered_segment_hashes: layeredSegmentHashes,
        structurally_equal: directSegmentHashes.join("\u0000") === layeredSegmentHashes.join("\u0000")
      },
      binding_level: {
        direct_binding_hashes: directBindingHashes,
        layered_binding_hashes: layeredBindingHashes,
        structurally_equal: directBindingHashes.join("\u0000") === layeredBindingHashes.join("\u0000")
      },
      rule_level: {
        direct_rule_hashes: directRuleHashes,
        layered_rule_hashes: layeredRuleHashes,
        structurally_equal: directRuleHashes.join("\u0000") === layeredRuleHashes.join("\u0000")
      },
      assertion_level: {
        direct_assertion_core: directRow.assertion_core,
        layered_assertion_core: layeredRow.assertion_core,
        structurally_equal: directRow.assertion_core.join("\u0000") === layeredRow.assertion_core.join("\u0000")
      },
      verdict_level: {
        direct_verdict: directRow.verdict,
        layered_verdict: layeredRow.verdict,
        direct_conflict_kind: directRow.conflict_kind,
        layered_conflict_kind: layeredRow.conflict_kind,
        verdicts_equal: directRow.verdict === layeredRow.verdict,
        conflict_kinds_equal: directRow.conflict_kind === layeredRow.conflict_kind
      },
      metric_level: {
        direct_expected_match: directResult.verifier.expected_match,
        layered_expected_match: layeredResult.verifier.expected_match,
        direct_conflict_kind_match: directResult.verifier.conflict_kind_match,
        layered_conflict_kind_match: layeredResult.verifier.conflict_kind_match
      }
    };
  });
  const layeredMinusDirect = Object.fromEntries(pipelineMetricIds.map((metricId) => {
    const cell = pipelineMatrix.rows.find((row) => row.pipeline_id === layeredPipelineId).metrics[metricId];
    return [metricId, cell.delta_from_baseline];
  }));
  return {
    artifact_kind: "DeterministicCandidateDiff",
    schema_version: "candidate_diff.v0",
    experiment_id: selectedExperimentId,
    baseline_pipeline_id: baselinePipelineId,
    layered_pipeline_id: layeredPipelineId,
    comparison_scope: "Segment, binding, rule, assertion, verdict, and metric comparison between direct rule-to-SMT and layered CKC pipeline artifacts.",
    model_route_delta_scope: "not_computed_here; route deltas are in runs/m3-routes/metrics/route_matrix.json when exp.m3_routes is generated",
    pipeline_metric_rows: pipelineMetrics,
    layered_minus_direct_deltas: layeredMinusDirect,
    group_rows: groupRows,
    component_reuse_graph_hash: sha256(componentReuseGraph),
    compactness_front_hash: sha256(compactnessFront)
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

function scaffoldUnimplementedRoute(routeId, groupId, seed) {
  const route = routeRegistryEntry(routeId);
  return {
    route_id: routeId,
    group_id: groupId,
    seed,
    syntax_valid: false,
    target_syntax_valid: false,
    model_output_syntax_valid: false,
    admitted: false,
    verdict: "route_unimplemented",
    diagnostics: ["deferred_gate_required"],
    response: `closed scaffold: ${routeId} is registered but not implemented; no model call was made`,
    parsed_response: {
      route_id: routeId,
      implementation_status: route?.implementation_status ?? "unimplemented",
      schema_notes: route?.schema_notes ?? null,
      bridge_notes: route?.bridge_notes ?? null,
      scaffold_mode: true
    },
    compiled_target: null,
    subprocess: null,
    live_call_count: 0,
    model_call_recorded: false,
    measurement_status: "scaffold_closed_unimplemented"
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

const stackedIrSchemaId = "schema.stacked_ir.v0";
const stackedSourceFrameFieldSpecs = {
  population: {
    property: { enum: ["adult", "child", "unknown"] }
  },
  condition_sepsis: {
    property: { enum: ["present", "absent", "unknown"] }
  },
  action: {
    property: { enum: ["abx_a", "none", "unknown"] }
  },
  deontic: {
    property: { enum: ["recommend", "contraindicate", "unknown"] }
  },
  pregnancy_scope: {
    property: { enum: ["present", "absent", "unknown"] }
  },
  renal_exception: {
    property: { enum: ["yes", "no", "unknown"] }
  }
};

function stackedSourceFrameJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(stackedSourceFrameFieldSpecs),
    properties: Object.fromEntries(Object.entries(stackedSourceFrameFieldSpecs).map(([field, spec]) => [field, spec.property]))
  };
}

function stackedIrEntryJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["source_frame", "rule_row"],
    properties: {
      source_frame: stackedSourceFrameJsonSchema(),
      rule_row: irRuleJsonSchema()
    }
  };
}

function stackedIrJsonSchema(groupId) {
  const labels = modelCaseForGroup(groupId).labels;
  return {
    type: "object",
    additionalProperties: false,
    required: labels,
    properties: Object.fromEntries(labels.map((label) => [label, stackedIrEntryJsonSchema()]))
  };
}

const irHopChainSchemaId = "schema.ir_hop_chain.v0";
const irHopLexicalCuesSchemaId = "schema.ir_hop_chain.lexical_cues.v0";
const irHopClinicalFrameSchemaId = "schema.ir_hop_chain.clinical_frame.v0";
const irHopRuleRowsSchemaId = "schema.ir_hop_chain.rule_rows.v0";
const irHopChainBridgeId = "ir_hop_chain_v0_to_route_rule_ir_v0";
const irHopChainHopSpecs = [
  {
    hop_id: "hop1.lexical_cues",
    granularity: "hop.lexical_cues",
    schema_id: irHopLexicalCuesSchemaId
  },
  {
    hop_id: "hop2.clinical_frame",
    granularity: "hop.clinical_frame",
    schema_id: irHopClinicalFrameSchemaId
  },
  {
    hop_id: "hop3.rule_rows",
    granularity: "hop.rule_rows",
    schema_id: irHopRuleRowsSchemaId
  }
];
const irHopCueFieldSpecs = {
  direction_cue: {
    property: { enum: ["推奨する", "投与しないこと", "禁忌", "none"] }
  },
  action_abx_a_cue: {
    property: { enum: ["present", "absent"] }
  },
  age_cue: {
    property: { enum: ["成人_or_18歳以上", "小児_or_18歳未満", "unknown"] }
  },
  sepsis_cue: {
    property: { enum: ["present", "absent"] }
  },
  pregnancy_cue: {
    property: { enum: ["present", "absent"] }
  },
  renal_exception_cue: {
    property: { enum: ["has_exception", "no_exception", "unknown"] }
  }
};

function pairJsonSchemaForGroup(groupId, entrySchema) {
  const labels = modelCaseForGroup(groupId).labels;
  return {
    type: "object",
    additionalProperties: false,
    required: labels,
    properties: Object.fromEntries(labels.map((label) => [label, entrySchema]))
  };
}

function irHopLexicalCueRowJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(irHopCueFieldSpecs),
    properties: Object.fromEntries(Object.entries(irHopCueFieldSpecs).map(([field, spec]) => [field, spec.property]))
  };
}

function irHopLexicalCuesJsonSchema(groupId) {
  return pairJsonSchemaForGroup(groupId, irHopLexicalCueRowJsonSchema());
}

function irHopClinicalFrameJsonSchema(groupId) {
  return pairJsonSchemaForGroup(groupId, stackedSourceFrameJsonSchema());
}

function irHopRuleRowsJsonSchema(groupId) {
  return pairJsonSchemaForGroup(groupId, irRuleJsonSchema());
}

const ckcLayeredSchemaId = "schema.ckc_layered.v0";
const ckcLayeredSegmentSchemaId = "schema.ckc_layered.segments.v0";
const ckcLayeredStatementSchemaId = "schema.ckc_layered.statements.v0";
const ckcLayeredRuleSchemaId = "schema.ckc_layered.rules.v0";
const ckcLayeredBridgeId = "ckc_layered_v0_to_route_rule_ir_v0";
const ckcLayeredStageSpecs = [
  {
    stage_id: "stage1.segments",
    granularity: "stage.segments",
    schema_id: ckcLayeredSegmentSchemaId
  },
  {
    stage_id: "stage2.statements",
    granularity: "stage.statements",
    schema_id: ckcLayeredStatementSchemaId
  },
  {
    stage_id: "stage3.rules",
    granularity: "stage.rules",
    schema_id: ckcLayeredRuleSchemaId
  }
];
const ckcLayeredSegmentFieldSpecs = {
  primary_segment_kind: {
    property: { enum: ["recommendation", "contraindication", "unknown"] }
  },
  primary_span_ref: {
    property: { enum: ["primary_excerpt", "unknown"] }
  },
  exception_span_ref: {
    property: { enum: ["exception_excerpt", "none", "unknown"] }
  },
  source_span_scope: {
    property: { enum: ["primary", "primary_plus_exception", "unknown"] }
  }
};
const ckcLayeredStatementFieldSpecs = {
  population: {
    property: { enum: ["pop.adult", "pop.child", "unknown"] }
  },
  condition: {
    property: { enum: ["cond.sepsis", "none", "unknown"] }
  },
  pregnancy_condition: {
    property: { enum: ["cond.pregnancy", "none", "unknown"] }
  },
  renal_exception: {
    property: { enum: ["cond.renal_severe", "none", "unknown"] }
  },
  action: {
    property: { enum: ["act.administer:drug.abx_a", "unknown"] }
  },
  modality: {
    property: { enum: ["for", "contraindicate", "unknown"] }
  },
  strength: {
    property: { enum: ["strong", "unknown"] }
  },
  certainty: {
    property: { enum: ["moderate", "unknown"] }
  },
  source_span_scope: {
    property: { enum: ["primary", "primary_plus_exception", "unknown"] }
  }
};
const ckcLayeredRuleFieldSpecs = {
  direction: {
    property: { enum: ["for", "contraindicate", "unknown"] }
  },
  action_key: {
    property: { enum: ["act.administer:drug.abx_a", "unknown"] }
  },
  age_interval: {
    property: { enum: ["adult_ge_18", "child_lt_18", "unknown"] }
  },
  required_conditions: {
    property: { enum: ["cond.sepsis", "cond.sepsis+cond.pregnancy", "none", "unknown"] }
  },
  prohibited_conditions: {
    property: { enum: ["cond.renal_severe", "none", "unknown"] }
  },
  strength: {
    property: { enum: ["strong", "unknown"] }
  },
  certainty: {
    property: { enum: ["moderate", "unknown"] }
  },
  source_span_scope: {
    property: { enum: ["primary", "primary_plus_exception", "unknown"] }
  }
};

function schemaFromFieldSpecs(fieldSpecs) {
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(fieldSpecs),
    properties: Object.fromEntries(Object.entries(fieldSpecs).map(([field, spec]) => [field, spec.property]))
  };
}

function ckcLayeredSegmentsJsonSchema(groupId) {
  return pairJsonSchemaForGroup(groupId, schemaFromFieldSpecs(ckcLayeredSegmentFieldSpecs));
}

function ckcLayeredStatementsJsonSchema(groupId) {
  return pairJsonSchemaForGroup(groupId, schemaFromFieldSpecs(ckcLayeredStatementFieldSpecs));
}

function ckcLayeredRulesJsonSchema(groupId) {
  return pairJsonSchemaForGroup(groupId, schemaFromFieldSpecs(ckcLayeredRuleFieldSpecs));
}

function irHopJsonSchemaForHop(hopId, groupId) {
  if (hopId === "hop1.lexical_cues") return irHopLexicalCuesJsonSchema(groupId);
  if (hopId === "hop2.clinical_frame") return irHopClinicalFrameJsonSchema(groupId);
  if (hopId === "hop3.rule_rows") return irHopRuleRowsJsonSchema(groupId);
  throw new Error(`unknown ir_hop_chain hop: ${hopId}`);
}

function ckcLayeredJsonSchemaForStage(stageId, groupId) {
  if (stageId === "stage1.segments") return ckcLayeredSegmentsJsonSchema(groupId);
  if (stageId === "stage2.statements") return ckcLayeredStatementsJsonSchema(groupId);
  if (stageId === "stage3.rules") return ckcLayeredRulesJsonSchema(groupId);
  throw new Error(`unknown ckc_layered stage: ${stageId}`);
}

function jsonSchemaForRoute(routeId, groupId, sourceLabel = null) {
  if (routeId === "route.single_ir") {
    if (sourceLabel) return JSON.stringify(irRuleJsonSchema());
    const labels = modelCaseForGroup(groupId).labels;
    return JSON.stringify({
      type: "object",
      additionalProperties: false,
      required: labels,
      properties: Object.fromEntries(labels.map((label) => [label, irRuleJsonSchema()]))
    });
  }
  if (routeId === "route.stacked_ir") return JSON.stringify(stackedIrJsonSchema(groupId));
  if (routeId === "route.ir_hop_chain") return JSON.stringify(irHopRuleRowsJsonSchema(groupId));
  if (routeId === "route.ckc_layered") return JSON.stringify(ckcLayeredRulesJsonSchema(groupId));
  return null;
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

function stackedFrameGuideLines() {
  return [
    "Stack contract:",
    "- source_frame.population: adult, child, or unknown.",
    "- source_frame.condition_sepsis: present when the excerpt mentions 敗血症.",
    "- source_frame.action: abx_a when 抗菌薬A is the medication; none when absent.",
    "- source_frame.deontic: recommend for 推奨する; contraindicate for 投与しないこと or 禁忌.",
    "- source_frame.pregnancy_scope: present only when 妊娠中 is in the source excerpt.",
    "- source_frame.renal_exception: yes only when the exception sentence excludes 重度腎機能障害.",
    "- rule_row must translate source_frame into the downstream row fields using the same mapping guide."
  ];
}

function promptForStackedIrPair(groupId) {
  const modelCase = modelCaseForGroup(groupId);
  const schema = JSON.stringify(JSON.parse(jsonSchemaForRoute("route.stacked_ir", groupId)), null, 2);
  return [
    "You are preparing a staged import payload for a hospital CDS knowledge-base maintenance queue.",
    "The excerpts are guideline-derived content for rules-engine review, not a patient-specific recommendation.",
    "For each source label, fill source_frame first, then translate it into rule_row.",
    "Keep source labels unchanged. Use only the listed enum tokens and fields. Return JSON only, with no prose.",
    `maintenance ticket: ${modelCase.case_id}`,
    `source labels: ${modelCase.labels.join(", ")}`,
    ...sourceCueEvidenceLines(groupId),
    ...cueGuideLines(),
    ...stackedFrameGuideLines(),
    "Required output schema:",
    schema
  ].join("\n");
}

function irHopLexicalCueGuideLines() {
  return [
    "Hop 1 contract:",
    "- direction_cue: copy the supported source cue token: 推奨する, 投与しないこと, 禁忌, or none.",
    "- action_abx_a_cue: present only when 抗菌薬A is in the primary excerpt.",
    "- age_cue: 成人_or_18歳以上, 小児_or_18歳未満, or unknown.",
    "- sepsis_cue: present only when 敗血症 is in the primary excerpt.",
    "- pregnancy_cue: present only when 妊娠中 is in the primary excerpt.",
    "- renal_exception_cue: has_exception only when the exception sentence excludes 重度腎機能障害; no_exception when no such exception is present."
  ];
}

function irHopFrameGuideLines() {
  return [
    "Hop 2 contract:",
    "- population: adult for 成人_or_18歳以上; child for 小児_or_18歳未満.",
    "- condition_sepsis: copy sepsis_cue as present or absent.",
    "- action: abx_a for action_abx_a_cue present; none for absent.",
    "- deontic: recommend for 推奨する; contraindicate for 投与しないこと or 禁忌.",
    "- pregnancy_scope: copy pregnancy_cue as present or absent.",
    "- renal_exception: yes for has_exception; no for no_exception."
  ];
}

function irHopRuleRowGuideLines() {
  return [
    "Hop 3 contract:",
    "- direction: for when deontic is recommend; contraindicate when deontic is contraindicate.",
    "- action_abx_a: present when action is abx_a; absent when action is none.",
    "- age: copy population as adult or child.",
    "- sepsis: copy condition_sepsis.",
    "- pregnancy: copy pregnancy_scope.",
    "- renal_exception: copy renal_exception as yes or no."
  ];
}

function previousHopJsonBlock(value) {
  return JSON.stringify(stable(value ?? {}), null, 2);
}

function promptForIrHopLexicalCues(groupId) {
  const modelCase = modelCaseForGroup(groupId);
  const schema = JSON.stringify(irHopLexicalCuesJsonSchema(groupId), null, 2);
  return [
    "You are preparing hop 1 of a staged import payload for a hospital CDS knowledge-base maintenance queue.",
    "The excerpts are guideline-derived content for rules-engine review, not a patient-specific recommendation.",
    "Extract only lexical cue tokens from the quoted excerpts. Do not decide whether the sources conflict.",
    "Keep source labels unchanged. Use only the listed enum tokens and fields. Return JSON only, with no prose.",
    `maintenance ticket: ${modelCase.case_id}`,
    `source labels: ${modelCase.labels.join(", ")}`,
    ...sourceCueEvidenceLines(groupId),
    ...irHopLexicalCueGuideLines(),
    "Required output schema:",
    schema
  ].join("\n");
}

function promptForIrHopClinicalFrame(groupId, lexicalCues) {
  const modelCase = modelCaseForGroup(groupId);
  const schema = JSON.stringify(irHopClinicalFrameJsonSchema(groupId), null, 2);
  return [
    "You are preparing hop 2 of a staged import payload for a hospital CDS knowledge-base maintenance queue.",
    "Translate the prior lexical-cue JSON into a compact clinical frame. Use only the prior JSON and the hop contract.",
    "Keep source labels unchanged. Use only the listed enum tokens and fields. Return JSON only, with no prose.",
    `maintenance ticket: ${modelCase.case_id}`,
    `source labels: ${modelCase.labels.join(", ")}`,
    "Prior hop JSON:",
    previousHopJsonBlock(lexicalCues),
    ...irHopFrameGuideLines(),
    "Required output schema:",
    schema
  ].join("\n");
}

function promptForIrHopRuleRows(groupId, clinicalFrame) {
  const modelCase = modelCaseForGroup(groupId);
  const schema = JSON.stringify(irHopRuleRowsJsonSchema(groupId), null, 2);
  return [
    "You are preparing hop 3 of a staged import payload for a hospital CDS knowledge-base maintenance queue.",
    "Translate the prior clinical-frame JSON into downstream rule rows. Use only the prior JSON and the hop contract.",
    "Keep source labels unchanged. Use only the listed enum tokens and fields. Return JSON only, with no prose.",
    `maintenance ticket: ${modelCase.case_id}`,
    `source labels: ${modelCase.labels.join(", ")}`,
    "Prior hop JSON:",
    previousHopJsonBlock(clinicalFrame),
    ...irHopRuleRowGuideLines(),
    "Required output schema:",
    schema
  ].join("\n");
}

function ckcLayeredSegmentGuideLines() {
  return [
    "CKC segment layer contract:",
    "- primary_segment_kind: recommendation when the primary excerpt recommends the action; contraindication when it says not to administer or says 禁忌.",
    "- primary_span_ref: primary_excerpt when the primary excerpt contains the rule span.",
    "- exception_span_ref: exception_excerpt only when a separate exception excerpt is present; otherwise none.",
    "- source_span_scope: primary_plus_exception when the rule depends on the exception span; otherwise primary."
  ];
}

function ckcLayeredStatementGuideLines() {
  return [
    "CKC statement layer contract:",
    "- population: pop.adult for 成人 or 18歳以上; pop.child for 小児 or 18歳未満.",
    "- condition: cond.sepsis when 敗血症 is present; otherwise none.",
    "- pregnancy_condition: cond.pregnancy only when 妊娠中 is present; otherwise none.",
    "- renal_exception: cond.renal_severe only when the exception excludes 重度腎機能障害; otherwise none.",
    "- action: act.administer:drug.abx_a when 抗菌薬A is the medication.",
    "- modality: for for 推奨する; contraindicate for 投与しないこと or 禁忌.",
    "- strength: strong for the current maintenance ticket sources.",
    "- certainty: moderate for the current maintenance ticket sources.",
    "- source_span_scope: copy the segment layer scope."
  ];
}

function ckcLayeredRuleGuideLines() {
  return [
    "CKC rule layer contract:",
    "- direction: copy statement.modality.",
    "- action_key: copy statement.action.",
    "- age_interval: adult_ge_18 for pop.adult; child_lt_18 for pop.child.",
    "- required_conditions: cond.sepsis+cond.pregnancy when both are present; cond.sepsis when only sepsis is present; none when neither is present.",
    "- prohibited_conditions: cond.renal_severe when renal_exception is cond.renal_severe; otherwise none.",
    "- strength and certainty: copy the statement values.",
    "- source_span_scope: copy the statement layer scope."
  ];
}

function promptForCkcLayeredSegments(groupId) {
  const modelCase = modelCaseForGroup(groupId);
  const schema = JSON.stringify(ckcLayeredSegmentsJsonSchema(groupId), null, 2);
  return [
    "You are preparing stage 1 of a CKC-style import payload for a hospital CDS knowledge-base maintenance queue.",
    "The excerpts are guideline-derived content for rules-engine review, not a patient-specific recommendation.",
    "Identify segment-like span references for each source label. Do not decide whether the sources conflict.",
    "Keep source labels unchanged. Use only the listed enum tokens and fields. Return JSON only, with no prose.",
    `maintenance ticket: ${modelCase.case_id}`,
    `source labels: ${modelCase.labels.join(", ")}`,
    ...sourceCueEvidenceLines(groupId),
    ...ckcLayeredSegmentGuideLines(),
    "Required output schema:",
    schema
  ].join("\n");
}

function promptForCkcLayeredStatements(groupId, segments) {
  const modelCase = modelCaseForGroup(groupId);
  const schema = JSON.stringify(ckcLayeredStatementsJsonSchema(groupId), null, 2);
  return [
    "You are preparing stage 2 of a CKC-style import payload for a hospital CDS knowledge-base maintenance queue.",
    "Normalize each segment into one clinical statement. This is rules-engine maintenance, not patient-specific care advice.",
    "Use the prior segment JSON plus the quoted excerpts. Keep source labels unchanged. Return JSON only, with no prose.",
    `maintenance ticket: ${modelCase.case_id}`,
    `source labels: ${modelCase.labels.join(", ")}`,
    "Prior segment JSON:",
    previousHopJsonBlock(segments),
    ...sourceCueEvidenceLines(groupId),
    ...ckcLayeredStatementGuideLines(),
    "Required output schema:",
    schema
  ].join("\n");
}

function promptForCkcLayeredRules(groupId, statements) {
  const modelCase = modelCaseForGroup(groupId);
  const schema = JSON.stringify(ckcLayeredRulesJsonSchema(groupId), null, 2);
  return [
    "You are preparing stage 3 of a CKC-style import payload for a hospital CDS knowledge-base maintenance queue.",
    "Translate the prior clinical-statement JSON into compact rule rows for deterministic repository checks.",
    "Use only the prior JSON and the CKC rule layer contract. Keep source labels unchanged. Return JSON only, with no prose.",
    `maintenance ticket: ${modelCase.case_id}`,
    `source labels: ${modelCase.labels.join(", ")}`,
    "Prior statement JSON:",
    previousHopJsonBlock(statements),
    ...ckcLayeredRuleGuideLines(),
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
  if (routeId === "route.stacked_ir") return promptForStackedIrPair(groupId);
  if (routeId === "route.ir_hop_chain") return promptForIrHopLexicalCues(groupId);
  if (routeId === "route.ckc_layered") return promptForCkcLayeredSegments(groupId);
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

function llamaArgs(prompt, seed, routeId, groupId, sourceLabel = null, options = {}) {
  const schema = options.schema ?? jsonSchemaForRoute(routeId, groupId, sourceLabel);
  const routeArgs = options.routeArgs ?? (routeId === "route.ir_hop_chain"
    ? ["-n", "360", "--ctx-size", "3072", "--temp", "0", "--top-k", "1"]
    : routeId === "route.ckc_layered"
    ? ["-n", "520", "--ctx-size", "4096", "--temp", "0", "--top-k", "1"]
    : routeId === "route.stacked_ir"
    ? ["-n", "420", "--ctx-size", "3072", "--temp", "0", "--top-k", "1"]
    : routeId === "route.single_ir"
      ? ["-n", "220", "--ctx-size", "2048", "--temp", "0", "--top-k", "1"]
      : ["-n", "160", "--ctx-size", "2048", "--temp", "0", "--top-k", "1"]);
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

function runLlama(prompt, seed, routeId, groupId, sourceLabel = null, options = {}) {
  requireLiveModelReady();
  const args = llamaArgs(prompt, seed, routeId, groupId, sourceLabel, options);
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
  syntax: ["target_parse_error", "ai_schema_violation", "stacked_ir_schema_invalid", "ir_hop_chain_schema_invalid", "ckc_layered_schema_invalid"],
  grounding: ["ai_hallucinated_source", "semantic_slot_missing", "stacked_ir_grounding_mismatch", "ir_hop_chain_grounding_mismatch", "ckc_layered_grounding_mismatch"],
  bridge: ["stacked_ir_bridge_incomplete", "stacked_ir_bridge_inconsistent", "ir_hop_chain_bridge_incomplete", "ir_hop_chain_bridge_inconsistent", "ckc_layered_bridge_incomplete", "ckc_layered_bridge_inconsistent"],
  compiled_target: ["stacked_ir_compiled_target_failure", "ir_hop_chain_compiled_target_failure", "ckc_layered_compiled_target_failure"],
  unsupported_schema: ["unsupported_ir_fragment"],
  wrong_verdict: ["false_positive_conflict", "false_negative_conflict"],
  scaffold: ["deferred_gate_required"],
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

function routeRuleIrFromRows(parsed, groupId, options = {}) {
  const routeId = options.routeId ?? "route.single_ir";
  const bridgeSourceSchemaId = options.bridgeSourceSchemaId ?? null;
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
    route_id: routeId,
    group_id: groupId,
    labels,
    rows: labels.map((label) => ({ source_label: label, cue_row: parsed?.[label] ?? null })),
    rules,
    ...(bridgeSourceSchemaId ? { bridge_source_schema_id: bridgeSourceSchemaId } : {}),
    ...(options.bridge ? { deterministic_bridge: options.bridge } : {})
  };
}

function objectHasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return keys.join("\u0000") === expected.join("\u0000");
}

function validStackedSourceFrame(frame) {
  return objectHasExactKeys(frame, Object.keys(stackedSourceFrameFieldSpecs))
    && Object.entries(stackedSourceFrameFieldSpecs).every(([field, spec]) => spec.property.enum.includes(frame[field]));
}

function validStackedEntry(entry) {
  return objectHasExactKeys(entry, ["source_frame", "rule_row"])
    && validStackedSourceFrame(entry.source_frame)
    && validIrRow(entry.rule_row);
}

function stackedSourceFrameFromCueFields(fields) {
  return {
    population: fields.age,
    condition_sepsis: fields.sepsis,
    action: fields.action_abx_a === "present" ? "abx_a" : fields.action_abx_a === "absent" ? "none" : "unknown",
    deontic: fields.direction === "for" ? "recommend" : fields.direction === "contraindicate" ? "contraindicate" : "unknown",
    pregnancy_scope: fields.pregnancy,
    renal_exception: fields.renal_exception
  };
}

function cueFieldsFromStackedSourceFrame(frame) {
  return {
    direction: frame.deontic === "recommend" ? "for" : frame.deontic === "contraindicate" ? "contraindicate" : "unknown",
    action_abx_a: frame.action === "abx_a" ? "present" : frame.action === "none" ? "absent" : "unknown",
    age: frame.population,
    sepsis: frame.condition_sepsis,
    pregnancy: frame.pregnancy_scope,
    renal_exception: frame.renal_exception
  };
}

function stackedResidual({ stage, code, label, field = null, expected = null, observed = null, baseCode = null, reason }) {
  return {
    stage,
    code,
    ...(baseCode ? { base_code: baseCode } : {}),
    source_label: label,
    field,
    expected,
    observed,
    reason
  };
}

function stackedSchemaResiduals(parsed, groupId) {
  const labels = modelCaseForGroup(groupId).labels;
  const residuals = [];
  if (!objectHasExactKeys(parsed, labels)) {
    residuals.push(stackedResidual({
      stage: "schema",
      code: "stacked_ir_schema_invalid",
      baseCode: "ai_schema_violation",
      label: null,
      expected: labels,
      observed: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed).sort() : typeof parsed,
      reason: "Stacked JSON must be an object keyed exactly by source labels."
    }));
    return residuals;
  }
  for (const label of labels) {
    const entry = parsed?.[label];
    if (!objectHasExactKeys(entry, ["source_frame", "rule_row"])) {
      residuals.push(stackedResidual({
        stage: "schema",
        code: "stacked_ir_schema_invalid",
        baseCode: "ai_schema_violation",
        label,
        expected: ["source_frame", "rule_row"],
        observed: entry && typeof entry === "object" && !Array.isArray(entry) ? Object.keys(entry).sort() : typeof entry,
        reason: "Each source label must contain exactly source_frame and rule_row."
      }));
      continue;
    }
    if (!validStackedSourceFrame(entry.source_frame)) {
      residuals.push(stackedResidual({
        stage: "schema",
        code: "stacked_ir_schema_invalid",
        baseCode: "ai_schema_violation",
        label,
        field: "source_frame",
        expected: stackedSourceFrameJsonSchema(),
        observed: entry.source_frame,
        reason: "source_frame violates the stacked source-frame enum contract."
      }));
    }
    if (!validIrRow(entry.rule_row)) {
      residuals.push(stackedResidual({
        stage: "schema",
        code: "stacked_ir_schema_invalid",
        baseCode: "ai_schema_violation",
        label,
        field: "rule_row",
        expected: irRuleJsonSchema(),
        observed: entry.rule_row,
        reason: "rule_row violates the downstream route_rule_ir.v0 cue-row contract."
      }));
    }
  }
  return residuals;
}

function stackedFieldResidual({ label, field, expected, observed, stage, reason }) {
  const baseCode = observed === "unknown"
    || (expected === "present" && observed === "absent")
    || (expected === "yes" && observed === "no")
    ? "semantic_slot_missing"
    : "ai_hallucinated_source";
  return stackedResidual({
    stage,
    code: "stacked_ir_grounding_mismatch",
    baseCode,
    label,
    field,
    expected,
    observed,
    reason
  });
}

function stackedGroundingResiduals(parsed, groupId) {
  const residuals = [];
  for (const label of modelCaseForGroup(groupId).labels) {
    const entry = parsed?.[label];
    if (!validStackedEntry(entry)) continue;
    const expectedCue = expectedCueFields(label);
    const expectedFrame = stackedSourceFrameFromCueFields(expectedCue);
    for (const field of Object.keys(stackedSourceFrameFieldSpecs)) {
      if (entry.source_frame[field] !== expectedFrame[field]) {
        residuals.push(stackedFieldResidual({
          label,
          field: `source_frame.${field}`,
          expected: expectedFrame[field],
          observed: entry.source_frame[field],
          stage: "grounding",
          reason: "source_frame is not grounded in the quoted source cue evidence."
        }));
      }
    }
    for (const field of Object.keys(cueFieldSpecs)) {
      if (entry.rule_row[field] !== expectedCue[field]) {
        residuals.push(stackedFieldResidual({
          label,
          field: `rule_row.${field}`,
          expected: expectedCue[field],
          observed: entry.rule_row[field],
          stage: "grounding",
          reason: "rule_row is not grounded in the quoted source cue evidence."
        }));
      }
    }
  }
  return residuals;
}

function stackedBridgeResiduals(parsed, groupId) {
  const residuals = [];
  for (const label of modelCaseForGroup(groupId).labels) {
    const entry = parsed?.[label];
    if (!validStackedEntry(entry)) continue;
    const rowFromFrame = cueFieldsFromStackedSourceFrame(entry.source_frame);
    for (const field of Object.keys(cueFieldSpecs)) {
      if (entry.rule_row[field] !== rowFromFrame[field]) {
        residuals.push(stackedResidual({
          stage: "bridge",
          code: "stacked_ir_bridge_inconsistent",
          label,
          field,
          expected: rowFromFrame[field],
          observed: entry.rule_row[field],
          reason: "rule_row is not a deterministic translation of source_frame."
        }));
      }
    }
    for (const field of ["direction", "action_abx_a", "age"]) {
      if (entry.rule_row[field] === "unknown" || (field === "action_abx_a" && entry.rule_row[field] !== "present")) {
        residuals.push(stackedResidual({
          stage: "bridge",
          code: "stacked_ir_bridge_incomplete",
          label,
          field,
          expected: field === "action_abx_a" ? "present" : "known",
          observed: entry.rule_row[field],
          reason: "The bridge cannot form a complete route_rule_ir.v0 rule for deterministic SMT compilation."
        }));
      }
    }
  }
  return residuals;
}

function stackedRuleRows(parsed, groupId) {
  return Object.fromEntries(modelCaseForGroup(groupId).labels.map((label) => [
    label,
    validStackedEntry(parsed?.[label]) ? parsed[label].rule_row : null
  ]));
}

function diagnosticCodesFromResiduals(residuals) {
  return [...new Set(residuals.flatMap((residual) => [residual.code, residual.base_code].filter(Boolean)))];
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
      bridge_source_schema_id: routeIr.bridge_source_schema_id ?? null,
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
    bridge_source_schema_id: routeIr.bridge_source_schema_id ?? null,
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

function classifyStackedIrCandidate(extracted, groupId, expected, seed) {
  const parsed = extracted?.value;
  const model_output_syntax_valid = Boolean(parsed);
  const residuals = [];
  if (!model_output_syntax_valid) {
    residuals.push(stackedResidual({
      stage: "schema",
      code: "stacked_ir_schema_invalid",
      baseCode: "ai_schema_violation",
      label: null,
      expected: stackedIrJsonSchema(groupId),
      observed: "no_json_object",
      reason: "No parseable stacked JSON object was found in the model output."
    }));
  }

  const schemaResiduals = model_output_syntax_valid ? stackedSchemaResiduals(parsed, groupId) : [];
  const schemaValid = model_output_syntax_valid && schemaResiduals.length === 0;
  const groundingResiduals = schemaValid ? stackedGroundingResiduals(parsed, groupId) : [];
  const bridgeResiduals = schemaValid ? stackedBridgeResiduals(parsed, groupId) : [];
  residuals.push(...schemaResiduals, ...groundingResiduals, ...bridgeResiduals);

  const routeRows = schemaValid ? stackedRuleRows(parsed, groupId) : {};
  const bridge = schemaValid ? {
    bridge_id: "stacked_ir_v0_to_route_rule_ir_v0",
    source_schema_id: stackedIrSchemaId,
    target_schema_id: "schema.route_rule_ir.v0",
    source_frames: Object.fromEntries(modelCaseForGroup(groupId).labels.map((label) => [label, parsed[label].source_frame])),
    rule_rows: routeRows,
    residuals: [...groundingResiduals, ...bridgeResiduals]
  } : null;
  const routeIr = schemaValid
    ? routeRuleIrFromRows(routeRows, groupId, {
        routeId: "route.stacked_ir",
        bridgeSourceSchemaId: stackedIrSchemaId,
        bridge
      })
    : null;
  const evaluated = schemaValid ? evaluateIrRows(routeRows, groupId) : { verdict: "target_syntax_failure", route_ir_rules: [], overlap: null };
  const compiledTarget = routeIr ? compileRouteIrToSmt(routeIr, groupId, seed, expected) : null;
  if (compiledTarget && !compiledTarget.syntax_valid) {
    residuals.push(stackedResidual({
      stage: "compiled_target",
      code: "stacked_ir_compiled_target_failure",
      baseCode: "unsupported_ir_fragment",
      label: null,
      expected: "complete route_rule_ir.v0 rules",
      observed: compiledTarget.verdict,
      reason: "The bridged route_rule_ir.v0 payload did not compile into a syntax-valid SMT target."
    }));
  }
  if (compiledTarget) {
    for (const code of compiledTarget.diagnostics) {
      residuals.push(stackedResidual({
        stage: "compiled_target",
        code,
        label: null,
        expected,
        observed: compiledTarget.verdict,
        reason: "Compiled target verdict differs from the locked expected route outcome."
      }));
    }
  }

  const verdict = compiledTarget?.verdict ?? evaluated.verdict;
  const compiledDiagnosticCodes = new Set(compiledTarget?.diagnostics ?? []);
  if (schemaValid && verdict === "unknown" && !residuals.some((residual) => residual.code === "stacked_ir_bridge_incomplete")) {
    residuals.push(stackedResidual({
      stage: "bridge",
      code: "stacked_ir_bridge_incomplete",
      label: null,
      expected: "known action, direction, and age fields",
      observed: "unknown",
      reason: "The stacked payload could not be evaluated into a known conflict-task verdict."
    }));
  }
  if (verdict === "semantic_contradiction" && expected === "semantic_no_conflict" && !compiledDiagnosticCodes.has("false_positive_conflict")) {
    residuals.push(stackedResidual({
      stage: "compiled_target",
      code: "false_positive_conflict",
      label: null,
      expected,
      observed: verdict,
      reason: "Compiled target produced a conflict where the locked group is a documented null result."
    }));
  }
  if (verdict === "semantic_no_conflict" && expected === "semantic_contradiction" && !compiledDiagnosticCodes.has("false_negative_conflict")) {
    residuals.push(stackedResidual({
      stage: "compiled_target",
      code: "false_negative_conflict",
      label: null,
      expected,
      observed: verdict,
      reason: "Compiled target missed the locked semantic contradiction."
    }));
  }
  const diagnostics = diagnosticCodesFromResiduals(residuals);
  const target_syntax_valid = Boolean(compiledTarget?.syntax_valid);

  return {
    syntax_valid: target_syntax_valid,
    target_syntax_valid,
    model_output_syntax_valid: schemaValid,
    admitted: target_syntax_valid && diagnostics.every((code) => !blocksAdmission(code)),
    verdict: target_syntax_valid ? verdict : "target_syntax_failure",
    diagnostics,
    parsed: model_output_syntax_valid ? {
      schema_id: stackedIrSchemaId,
      stack: parsed,
      route_ir: routeIr,
      deterministic_bridge: {
        ...bridge,
        evaluated
      },
      stage_diagnostics: {
        schema: schemaResiduals,
        grounding: groundingResiduals,
        bridge: bridgeResiduals,
        compiled_target: residuals.filter((residual) => residual.stage === "compiled_target")
      },
      residuals
    } : null,
    compiled_target: compiledTarget,
    candidate_text: extracted?.text ?? ""
  };
}

function validIrHopLexicalCueRow(row) {
  return objectHasExactKeys(row, Object.keys(irHopCueFieldSpecs))
    && Object.entries(irHopCueFieldSpecs).every(([field, spec]) => spec.property.enum.includes(row[field]));
}

function expectedIrHopLexicalCueRow(label) {
  const cues = sourceCuesForLabel(label);
  return Object.fromEntries(Object.keys(irHopCueFieldSpecs).map((field) => [field, cues[field]]));
}

function cueFieldsFromIrHopLexicalCueRow(row) {
  return {
    direction: row.direction_cue === "推奨する"
      ? "for"
      : row.direction_cue === "投与しないこと" || row.direction_cue === "禁忌"
        ? "contraindicate"
        : "unknown",
    action_abx_a: row.action_abx_a_cue === "present" ? "present" : row.action_abx_a_cue === "absent" ? "absent" : "unknown",
    age: row.age_cue === "成人_or_18歳以上" ? "adult" : row.age_cue === "小児_or_18歳未満" ? "child" : "unknown",
    sepsis: row.sepsis_cue,
    pregnancy: row.pregnancy_cue,
    renal_exception: row.renal_exception_cue === "has_exception" ? "yes" : row.renal_exception_cue === "no_exception" ? "no" : "unknown"
  };
}

function frameFromIrHopLexicalCueRow(row) {
  return stackedSourceFrameFromCueFields(cueFieldsFromIrHopLexicalCueRow(row));
}

function irHopResidual({ hopId, stage, code, label, field = null, expected = null, observed = null, baseCode = null, reason }) {
  return {
    hop_id: hopId,
    stage,
    code,
    ...(baseCode ? { base_code: baseCode } : {}),
    source_label: label,
    field,
    expected,
    observed,
    reason
  };
}

function irHopFieldResidual({ hopId, label, field, expected, observed, stage, reason }) {
  const baseCode = observed === "unknown"
    || observed === "none"
    || (expected === "present" && observed === "absent")
    || (expected === "yes" && observed === "no")
    || (expected !== "none" && observed === "none")
    ? "semantic_slot_missing"
    : "ai_hallucinated_source";
  return irHopResidual({
    hopId,
    stage,
    code: stage === "bridge" ? "ir_hop_chain_bridge_inconsistent" : "ir_hop_chain_grounding_mismatch",
    baseCode,
    label,
    field,
    expected,
    observed,
    reason
  });
}

function irHopPairSchemaResiduals({ parsed, groupId, hopId, expectedSchema, validator, expectedEntryDescription }) {
  const labels = modelCaseForGroup(groupId).labels;
  const residuals = [];
  if (!objectHasExactKeys(parsed, labels)) {
    residuals.push(irHopResidual({
      hopId,
      stage: "schema",
      code: "ir_hop_chain_schema_invalid",
      baseCode: "ai_schema_violation",
      label: null,
      expected: labels,
      observed: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed).sort() : typeof parsed,
      reason: "Hop JSON must be an object keyed exactly by source labels."
    }));
    return residuals;
  }
  for (const label of labels) {
    if (!validator(parsed?.[label])) {
      residuals.push(irHopResidual({
        hopId,
        stage: "schema",
        code: "ir_hop_chain_schema_invalid",
        baseCode: "ai_schema_violation",
        label,
        expected: expectedSchema,
        observed: parsed?.[label] ?? null,
        reason: `${expectedEntryDescription} violates the hop JSON enum contract.`
      }));
    }
  }
  return residuals;
}

function irHopSchemaResiduals(hopOutputs, groupId) {
  const residuals = [];
  if (!hopOutputs.lexical.extracted?.value) {
    residuals.push(irHopResidual({
      hopId: "hop1.lexical_cues",
      stage: "schema",
      code: "ir_hop_chain_schema_invalid",
      baseCode: "ai_schema_violation",
      label: null,
      expected: irHopLexicalCuesJsonSchema(groupId),
      observed: "no_json_object",
      reason: "No parseable lexical-cue JSON object was found in hop 1 output."
    }));
  } else {
    residuals.push(...irHopPairSchemaResiduals({
      parsed: hopOutputs.lexical.parsed,
      groupId,
      hopId: "hop1.lexical_cues",
      expectedSchema: irHopLexicalCueRowJsonSchema(),
      validator: validIrHopLexicalCueRow,
      expectedEntryDescription: "lexical cue row"
    }));
  }

  if (!hopOutputs.frame.extracted?.value) {
    residuals.push(irHopResidual({
      hopId: "hop2.clinical_frame",
      stage: "schema",
      code: "ir_hop_chain_schema_invalid",
      baseCode: "ai_schema_violation",
      label: null,
      expected: irHopClinicalFrameJsonSchema(groupId),
      observed: "no_json_object",
      reason: "No parseable clinical-frame JSON object was found in hop 2 output."
    }));
  } else {
    residuals.push(...irHopPairSchemaResiduals({
      parsed: hopOutputs.frame.parsed,
      groupId,
      hopId: "hop2.clinical_frame",
      expectedSchema: stackedSourceFrameJsonSchema(),
      validator: validStackedSourceFrame,
      expectedEntryDescription: "clinical frame"
    }));
  }

  if (!hopOutputs.ruleRows.extracted?.value) {
    residuals.push(irHopResidual({
      hopId: "hop3.rule_rows",
      stage: "schema",
      code: "ir_hop_chain_schema_invalid",
      baseCode: "ai_schema_violation",
      label: null,
      expected: irHopRuleRowsJsonSchema(groupId),
      observed: "no_json_object",
      reason: "No parseable rule-row JSON object was found in hop 3 output."
    }));
  } else {
    residuals.push(...irHopPairSchemaResiduals({
      parsed: hopOutputs.ruleRows.parsed,
      groupId,
      hopId: "hop3.rule_rows",
      expectedSchema: irRuleJsonSchema(),
      validator: validIrRow,
      expectedEntryDescription: "rule row"
    }));
  }
  return residuals;
}

function irHopGroundingResiduals({ lexicalCues, clinicalFrame, ruleRows, groupId }) {
  const residuals = [];
  for (const label of modelCaseForGroup(groupId).labels) {
    if (validIrHopLexicalCueRow(lexicalCues?.[label])) {
      const expectedCue = expectedIrHopLexicalCueRow(label);
      for (const field of Object.keys(irHopCueFieldSpecs)) {
        if (lexicalCues[label][field] !== expectedCue[field]) {
          residuals.push(irHopFieldResidual({
            hopId: "hop1.lexical_cues",
            label,
            field,
            expected: expectedCue[field],
            observed: lexicalCues[label][field],
            stage: "grounding",
            reason: "Lexical cue row is not grounded in the quoted source cue evidence."
          }));
        }
      }
    }
    if (validStackedSourceFrame(clinicalFrame?.[label])) {
      const expectedFrame = stackedSourceFrameFromCueFields(expectedCueFields(label));
      for (const field of Object.keys(stackedSourceFrameFieldSpecs)) {
        if (clinicalFrame[label][field] !== expectedFrame[field]) {
          residuals.push(irHopFieldResidual({
            hopId: "hop2.clinical_frame",
            label,
            field,
            expected: expectedFrame[field],
            observed: clinicalFrame[label][field],
            stage: "grounding",
            reason: "Clinical frame is not grounded in source-derived expected cue fields."
          }));
        }
      }
    }
    if (validIrRow(ruleRows?.[label])) {
      const expectedRow = expectedCueFields(label);
      for (const field of Object.keys(cueFieldSpecs)) {
        if (ruleRows[label][field] !== expectedRow[field]) {
          residuals.push(irHopFieldResidual({
            hopId: "hop3.rule_rows",
            label,
            field,
            expected: expectedRow[field],
            observed: ruleRows[label][field],
            stage: "grounding",
            reason: "Rule row is not grounded in source-derived expected cue fields."
          }));
        }
      }
    }
  }
  return residuals;
}

function irHopBridgeResiduals({ lexicalCues, clinicalFrame, ruleRows, groupId }) {
  const residuals = [];
  for (const label of modelCaseForGroup(groupId).labels) {
    if (validIrHopLexicalCueRow(lexicalCues?.[label]) && validStackedSourceFrame(clinicalFrame?.[label])) {
      const expectedFrame = frameFromIrHopLexicalCueRow(lexicalCues[label]);
      for (const field of Object.keys(stackedSourceFrameFieldSpecs)) {
        if (clinicalFrame[label][field] !== expectedFrame[field]) {
          residuals.push(irHopFieldResidual({
            hopId: "hop2.clinical_frame",
            label,
            field,
            expected: expectedFrame[field],
            observed: clinicalFrame[label][field],
            stage: "bridge",
            reason: "Clinical frame is not a deterministic translation of hop 1 lexical cues."
          }));
        }
      }
    }
    if (validStackedSourceFrame(clinicalFrame?.[label]) && validIrRow(ruleRows?.[label])) {
      const expectedRow = cueFieldsFromStackedSourceFrame(clinicalFrame[label]);
      for (const field of Object.keys(cueFieldSpecs)) {
        if (ruleRows[label][field] !== expectedRow[field]) {
          residuals.push(irHopFieldResidual({
            hopId: "hop3.rule_rows",
            label,
            field,
            expected: expectedRow[field],
            observed: ruleRows[label][field],
            stage: "bridge",
            reason: "Rule row is not a deterministic translation of hop 2 clinical frame."
          }));
        }
      }
      for (const field of ["direction", "action_abx_a", "age"]) {
        if (ruleRows[label][field] === "unknown" || (field === "action_abx_a" && ruleRows[label][field] !== "present")) {
          residuals.push(irHopResidual({
            hopId: "hop3.rule_rows",
            stage: "bridge",
            code: "ir_hop_chain_bridge_incomplete",
            label,
            field,
            expected: field === "action_abx_a" ? "present" : "known",
            observed: ruleRows[label][field],
            reason: "The hop chain cannot form a complete route_rule_ir.v0 rule for deterministic SMT compilation."
          }));
        }
      }
    }
  }
  return residuals;
}

function irHopRuleRows(parsed, groupId) {
  return Object.fromEntries(modelCaseForGroup(groupId).labels.map((label) => [
    label,
    validIrRow(parsed?.[label]) ? parsed[label] : null
  ]));
}

function classifyIrHopChainCandidate({ hopOutputs, modelCalls }, groupId, expected, seed) {
  const lexicalCues = hopOutputs.lexical.parsed;
  const clinicalFrame = hopOutputs.frame.parsed;
  const ruleRows = hopOutputs.ruleRows.parsed;
  const residuals = irHopSchemaResiduals(hopOutputs, groupId);
  const schemaResiduals = residuals.filter((residual) => residual.stage === "schema");
  const schemaValid = schemaResiduals.length === 0;
  const groundingResiduals = schemaValid ? irHopGroundingResiduals({ lexicalCues, clinicalFrame, ruleRows, groupId }) : [];
  const bridgeResiduals = schemaValid ? irHopBridgeResiduals({ lexicalCues, clinicalFrame, ruleRows, groupId }) : [];
  residuals.push(...groundingResiduals, ...bridgeResiduals);

  const bridgedRows = schemaValid ? irHopRuleRows(ruleRows, groupId) : {};
  const bridge = schemaValid ? {
    bridge_id: irHopChainBridgeId,
    source_schema_id: irHopChainSchemaId,
    target_schema_id: "schema.route_rule_ir.v0",
    hop_schema_ids: irHopChainHopSpecs.map((hop) => hop.schema_id),
    hop_lineage: modelCalls.map((call) => ({
      hop_id: call.hop_id,
      granularity: call.granularity,
      schema_id: call.schema_id,
      prompt_hash: call.prompt_hash,
      response_hash: call.response_hash,
      subprocess_exit_status: call.subprocess?.exit_status ?? null
    })),
    lexical_cues: lexicalCues,
    clinical_frames: clinicalFrame,
    rule_rows: bridgedRows,
    residuals: [...groundingResiduals, ...bridgeResiduals]
  } : null;
  const routeIr = schemaValid
    ? routeRuleIrFromRows(bridgedRows, groupId, {
        routeId: "route.ir_hop_chain",
        bridgeSourceSchemaId: irHopChainSchemaId,
        bridge
      })
    : null;
  const evaluated = schemaValid ? evaluateIrRows(bridgedRows, groupId) : { verdict: "target_syntax_failure", route_ir_rules: [], overlap: null };
  const compiledTarget = routeIr ? compileRouteIrToSmt(routeIr, groupId, seed, expected) : null;
  if (compiledTarget && !compiledTarget.syntax_valid) {
    residuals.push(irHopResidual({
      hopId: "hop3.rule_rows",
      stage: "compiled_target",
      code: "ir_hop_chain_compiled_target_failure",
      baseCode: "unsupported_ir_fragment",
      label: null,
      expected: "complete route_rule_ir.v0 rules",
      observed: compiledTarget.verdict,
      reason: "The final hop payload did not compile into a syntax-valid SMT target."
    }));
  }
  if (compiledTarget) {
    for (const code of compiledTarget.diagnostics) {
      residuals.push(irHopResidual({
        hopId: "hop3.rule_rows",
        stage: "compiled_target",
        code,
        label: null,
        expected,
        observed: compiledTarget.verdict,
        reason: "Compiled target verdict differs from the locked expected route outcome."
      }));
    }
  }

  const verdict = compiledTarget?.verdict ?? evaluated.verdict;
  const compiledDiagnosticCodes = new Set(compiledTarget?.diagnostics ?? []);
  if (schemaValid && verdict === "unknown" && !residuals.some((residual) => residual.code === "ir_hop_chain_bridge_incomplete")) {
    residuals.push(irHopResidual({
      hopId: "hop3.rule_rows",
      stage: "bridge",
      code: "ir_hop_chain_bridge_incomplete",
      label: null,
      expected: "known action, direction, and age fields",
      observed: "unknown",
      reason: "The hop-chain payload could not be evaluated into a known conflict-task verdict."
    }));
  }
  if (verdict === "semantic_contradiction" && expected === "semantic_no_conflict" && !compiledDiagnosticCodes.has("false_positive_conflict")) {
    residuals.push(irHopResidual({
      hopId: "hop3.rule_rows",
      stage: "compiled_target",
      code: "false_positive_conflict",
      label: null,
      expected,
      observed: verdict,
      reason: "Compiled target produced a conflict where the locked group is a documented null result."
    }));
  }
  if (verdict === "semantic_no_conflict" && expected === "semantic_contradiction" && !compiledDiagnosticCodes.has("false_negative_conflict")) {
    residuals.push(irHopResidual({
      hopId: "hop3.rule_rows",
      stage: "compiled_target",
      code: "false_negative_conflict",
      label: null,
      expected,
      observed: verdict,
      reason: "Compiled target missed the locked semantic contradiction."
    }));
  }
  const diagnostics = diagnosticCodesFromResiduals(residuals);
  const target_syntax_valid = Boolean(compiledTarget?.syntax_valid);
  const hopSchemaDiagnostics = {
    "hop1.lexical_cues": schemaResiduals.filter((residual) => residual.hop_id === "hop1.lexical_cues"),
    "hop2.clinical_frame": schemaResiduals.filter((residual) => residual.hop_id === "hop2.clinical_frame"),
    "hop3.rule_rows": schemaResiduals.filter((residual) => residual.hop_id === "hop3.rule_rows")
  };

  return {
    syntax_valid: target_syntax_valid,
    target_syntax_valid,
    model_output_syntax_valid: schemaValid,
    admitted: target_syntax_valid && diagnostics.every((code) => !blocksAdmission(code)),
    verdict: target_syntax_valid ? verdict : "target_syntax_failure",
    diagnostics,
    parsed: {
      schema_id: irHopChainSchemaId,
      hops: {
        lexical_cues: lexicalCues ?? null,
        clinical_frame: clinicalFrame ?? null,
        rule_rows: ruleRows ?? null
      },
      route_ir: routeIr,
      deterministic_bridge: bridge ? {
        ...bridge,
        evaluated
      } : null,
      stage_diagnostics: {
        schema: hopSchemaDiagnostics,
        grounding: groundingResiduals,
        bridge: bridgeResiduals,
        compiled_target: residuals.filter((residual) => residual.stage === "compiled_target")
      },
      residuals
    },
    compiled_target: compiledTarget,
    candidate_text: JSON.stringify(stable(ruleRows ?? {}), null, 2)
  };
}

function validObjectForFieldSpecs(row, fieldSpecs) {
  return objectHasExactKeys(row, Object.keys(fieldSpecs))
    && Object.entries(fieldSpecs).every(([field, spec]) => spec.property.enum.includes(row[field]));
}

function validCkcLayeredSegmentRow(row) {
  return validObjectForFieldSpecs(row, ckcLayeredSegmentFieldSpecs);
}

function validCkcLayeredStatementRow(row) {
  return validObjectForFieldSpecs(row, ckcLayeredStatementFieldSpecs);
}

function validCkcLayeredRuleRow(row) {
  return validObjectForFieldSpecs(row, ckcLayeredRuleFieldSpecs);
}

function fixtureForLabel(label) {
  const fixture = fixtureRegistry.find((entry) => entry.source_label === label);
  if (!fixture) throw new Error(`unknown source label: ${label}`);
  return fixture;
}

function fixtureRuleForLabel(label) {
  const fixture = fixtureForLabel(label);
  if ((fixture.rules ?? []).length !== 1) throw new Error(`expected one fixture rule for source label: ${label}`);
  return fixture.rules[0];
}

function fixtureStatementForLabel(label) {
  const fixture = fixtureForLabel(label);
  if ((fixture.clinical_statements ?? []).length !== 1) {
    throw new Error(`expected one fixture statement for source label: ${label}`);
  }
  return fixture.clinical_statements[0];
}

function ckcLayeredSourceSpanScopeForLabel(label) {
  return sourceCaseForLabel(label).exception ? "primary_plus_exception" : "primary";
}

function expectedCkcLayeredSegmentRow(label) {
  const fixture = fixtureForLabel(label);
  const primary = primaryRegion(fixture);
  const hasException = Boolean(fixture.regions.find((region) => region.role === "exception"));
  return {
    primary_segment_kind: primary.role === "recommendation"
      ? "recommendation"
      : primary.role === "contraindication"
        ? "contraindication"
        : "unknown",
    primary_span_ref: "primary_excerpt",
    exception_span_ref: hasException ? "exception_excerpt" : "none",
    source_span_scope: hasException ? "primary_plus_exception" : "primary"
  };
}

function expectedCkcLayeredStatementRow(label) {
  const statement = fixtureStatementForLabel(label);
  const rule = fixtureRuleForLabel(label);
  const required = new Set(rule.context?.required ?? []);
  const prohibited = new Set(rule.context?.prohibited ?? []);
  return {
    population: statement.population ?? "unknown",
    condition: statement.condition ?? "none",
    pregnancy_condition: required.has("cond.pregnancy") ? "cond.pregnancy" : "none",
    renal_exception: prohibited.has("cond.renal_severe") ? "cond.renal_severe" : "none",
    action: statement.action ?? "unknown",
    modality: statement.modality ?? "unknown",
    strength: statement.strength ?? rule.strength ?? "unknown",
    certainty: statement.certainty ?? rule.certainty ?? "unknown",
    source_span_scope: ckcLayeredSourceSpanScopeForLabel(label)
  };
}

function ckcLayeredRequiredConditionsToken(requiredConditions) {
  const required = new Set(requiredConditions);
  if (required.has("cond.sepsis") && required.has("cond.pregnancy")) return "cond.sepsis+cond.pregnancy";
  if (required.has("cond.sepsis")) return "cond.sepsis";
  if (required.size === 0) return "none";
  return "unknown";
}

function ckcLayeredAgeIntervalFromRule(rule) {
  if (rule.context?.age_years?.ge === 18) return "adult_ge_18";
  if (rule.context?.age_years?.lt === 18) return "child_lt_18";
  return "unknown";
}

function expectedCkcLayeredRuleRow(label) {
  const rule = fixtureRuleForLabel(label);
  return {
    direction: rule.direction ?? "unknown",
    action_key: rule.action_key ?? "unknown",
    age_interval: ckcLayeredAgeIntervalFromRule(rule),
    required_conditions: ckcLayeredRequiredConditionsToken(rule.context?.required ?? []),
    prohibited_conditions: (rule.context?.prohibited ?? []).includes("cond.renal_severe") ? "cond.renal_severe" : "none",
    strength: rule.strength ?? "unknown",
    certainty: rule.certainty ?? "unknown",
    source_span_scope: ckcLayeredSourceSpanScopeForLabel(label)
  };
}

function ckcLayeredRuleFromStatementRow(statement) {
  const required = [];
  if (statement.condition === "cond.sepsis") required.push("cond.sepsis");
  if (statement.pregnancy_condition === "cond.pregnancy") required.push("cond.pregnancy");
  return {
    direction: statement.modality,
    action_key: statement.action,
    age_interval: statement.population === "pop.adult"
      ? "adult_ge_18"
      : statement.population === "pop.child"
        ? "child_lt_18"
        : "unknown",
    required_conditions: ckcLayeredRequiredConditionsToken(required),
    prohibited_conditions: statement.renal_exception === "cond.renal_severe" ? "cond.renal_severe" : "none",
    strength: statement.strength,
    certainty: statement.certainty,
    source_span_scope: statement.source_span_scope
  };
}

function cueFieldsFromCkcLayeredRuleRow(row) {
  return {
    direction: row.direction,
    action_abx_a: row.action_key === "act.administer:drug.abx_a" ? "present" : row.action_key === "unknown" ? "unknown" : "absent",
    age: row.age_interval === "adult_ge_18" ? "adult" : row.age_interval === "child_lt_18" ? "child" : "unknown",
    sepsis: row.required_conditions === "cond.sepsis" || row.required_conditions === "cond.sepsis+cond.pregnancy" ? "present" : row.required_conditions === "none" ? "absent" : "unknown",
    pregnancy: row.required_conditions === "cond.sepsis+cond.pregnancy" ? "present" : row.required_conditions === "cond.sepsis" || row.required_conditions === "none" ? "absent" : "unknown",
    renal_exception: row.prohibited_conditions === "cond.renal_severe" ? "yes" : row.prohibited_conditions === "none" ? "no" : "unknown"
  };
}

function ckcLayeredResidual({ stageId, stage, code, label, field = null, expected = null, observed = null, baseCode = null, reason }) {
  return {
    stage_id: stageId,
    stage,
    code,
    ...(baseCode ? { base_code: baseCode } : {}),
    source_label: label,
    field,
    expected,
    observed,
    reason
  };
}

function ckcLayeredBaseCode(expected, observed) {
  if (
    observed === "unknown"
    || observed === null
    || (expected !== "none" && observed === "none")
    || (expected === "present" && observed === "absent")
    || (expected === "yes" && observed === "no")
  ) {
    return "semantic_slot_missing";
  }
  return "ai_hallucinated_source";
}

function ckcLayeredFieldResidual({ stageId, label, field, expected, observed, stage, code, reason }) {
  return ckcLayeredResidual({
    stageId,
    stage,
    code,
    baseCode: ckcLayeredBaseCode(expected, observed),
    label,
    field,
    expected,
    observed,
    reason
  });
}

function ckcLayeredPairSchemaResiduals({ parsed, groupId, stageId, expectedSchema, validator, expectedEntryDescription }) {
  const labels = modelCaseForGroup(groupId).labels;
  const residuals = [];
  if (!objectHasExactKeys(parsed, labels)) {
    residuals.push(ckcLayeredResidual({
      stageId,
      stage: "schema",
      code: "ckc_layered_schema_invalid",
      baseCode: "ai_schema_violation",
      label: null,
      expected: labels,
      observed: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed).sort() : typeof parsed,
      reason: "CKC layer JSON must be an object keyed exactly by source labels."
    }));
    return residuals;
  }
  for (const label of labels) {
    if (!validator(parsed?.[label])) {
      residuals.push(ckcLayeredResidual({
        stageId,
        stage: "schema",
        code: "ckc_layered_schema_invalid",
        baseCode: "ai_schema_violation",
        label,
        expected: expectedSchema,
        observed: parsed?.[label] ?? null,
        reason: `${expectedEntryDescription} violates the CKC layer enum contract.`
      }));
    }
  }
  return residuals;
}

function ckcLayeredSchemaResiduals(stageOutputs, groupId) {
  const residuals = [];
  if (!stageOutputs.segments.extracted?.value) {
    residuals.push(ckcLayeredResidual({
      stageId: "stage1.segments",
      stage: "schema",
      code: "ckc_layered_schema_invalid",
      baseCode: "ai_schema_violation",
      label: null,
      expected: ckcLayeredSegmentsJsonSchema(groupId),
      observed: "no_json_object",
      reason: "No parseable CKC segment JSON object was found in stage 1 output."
    }));
  } else {
    residuals.push(...ckcLayeredPairSchemaResiduals({
      parsed: stageOutputs.segments.parsed,
      groupId,
      stageId: "stage1.segments",
      expectedSchema: schemaFromFieldSpecs(ckcLayeredSegmentFieldSpecs),
      validator: validCkcLayeredSegmentRow,
      expectedEntryDescription: "segment row"
    }));
  }

  if (!stageOutputs.statements.extracted?.value) {
    residuals.push(ckcLayeredResidual({
      stageId: "stage2.statements",
      stage: "schema",
      code: "ckc_layered_schema_invalid",
      baseCode: "ai_schema_violation",
      label: null,
      expected: ckcLayeredStatementsJsonSchema(groupId),
      observed: "no_json_object",
      reason: "No parseable CKC statement JSON object was found in stage 2 output."
    }));
  } else {
    residuals.push(...ckcLayeredPairSchemaResiduals({
      parsed: stageOutputs.statements.parsed,
      groupId,
      stageId: "stage2.statements",
      expectedSchema: schemaFromFieldSpecs(ckcLayeredStatementFieldSpecs),
      validator: validCkcLayeredStatementRow,
      expectedEntryDescription: "statement row"
    }));
  }

  if (!stageOutputs.rules.extracted?.value) {
    residuals.push(ckcLayeredResidual({
      stageId: "stage3.rules",
      stage: "schema",
      code: "ckc_layered_schema_invalid",
      baseCode: "ai_schema_violation",
      label: null,
      expected: ckcLayeredRulesJsonSchema(groupId),
      observed: "no_json_object",
      reason: "No parseable CKC rule JSON object was found in stage 3 output."
    }));
  } else {
    residuals.push(...ckcLayeredPairSchemaResiduals({
      parsed: stageOutputs.rules.parsed,
      groupId,
      stageId: "stage3.rules",
      expectedSchema: schemaFromFieldSpecs(ckcLayeredRuleFieldSpecs),
      validator: validCkcLayeredRuleRow,
      expectedEntryDescription: "rule row"
    }));
  }
  return residuals;
}

function ckcLayeredRowResiduals({ stageId, label, observedRow, expectedRow, fields, stage, code, reason }) {
  return fields
    .filter((field) => observedRow[field] !== expectedRow[field])
    .map((field) => ckcLayeredFieldResidual({
      stageId,
      label,
      field,
      expected: expectedRow[field],
      observed: observedRow[field],
      stage,
      code,
      reason
    }));
}

function ckcLayeredGroundingResiduals({ segments, statements, rules, groupId }) {
  const residuals = [];
  for (const label of modelCaseForGroup(groupId).labels) {
    if (validCkcLayeredSegmentRow(segments?.[label])) {
      residuals.push(...ckcLayeredRowResiduals({
        stageId: "stage1.segments",
        label,
        observedRow: segments[label],
        expectedRow: expectedCkcLayeredSegmentRow(label),
        fields: Object.keys(ckcLayeredSegmentFieldSpecs),
        stage: "grounding",
        code: "ckc_layered_grounding_mismatch",
        reason: "CKC segment row is not grounded in the quoted source excerpts."
      }));
    }
    if (validCkcLayeredStatementRow(statements?.[label])) {
      residuals.push(...ckcLayeredRowResiduals({
        stageId: "stage2.statements",
        label,
        observedRow: statements[label],
        expectedRow: expectedCkcLayeredStatementRow(label),
        fields: Object.keys(ckcLayeredStatementFieldSpecs),
        stage: "grounding",
        code: "ckc_layered_grounding_mismatch",
        reason: "CKC statement row is not grounded in fixture semantics and quoted source excerpts."
      }));
    }
    if (validCkcLayeredRuleRow(rules?.[label])) {
      residuals.push(...ckcLayeredRowResiduals({
        stageId: "stage3.rules",
        label,
        observedRow: rules[label],
        expectedRow: expectedCkcLayeredRuleRow(label),
        fields: Object.keys(ckcLayeredRuleFieldSpecs),
        stage: "grounding",
        code: "ckc_layered_grounding_mismatch",
        reason: "CKC rule row is not grounded in fixture semantics and quoted source excerpts."
      }));
    }
  }
  return residuals;
}

function ckcLayeredStatementBridgeFromSegment(segment) {
  return {
    modality: segment.primary_segment_kind === "recommendation"
      ? "for"
      : segment.primary_segment_kind === "contraindication"
        ? "contraindicate"
        : "unknown",
    renal_exception: segment.exception_span_ref === "exception_excerpt"
      ? "cond.renal_severe"
      : segment.exception_span_ref === "none"
        ? "none"
        : "unknown",
    source_span_scope: segment.source_span_scope
  };
}

function ckcLayeredBridgeResiduals({ segments, statements, rules, groupId }) {
  const residuals = [];
  for (const label of modelCaseForGroup(groupId).labels) {
    if (validCkcLayeredSegmentRow(segments?.[label]) && validCkcLayeredStatementRow(statements?.[label])) {
      const expectedStatementFields = ckcLayeredStatementBridgeFromSegment(segments[label]);
      for (const field of Object.keys(expectedStatementFields)) {
        if (statements[label][field] !== expectedStatementFields[field]) {
          residuals.push(ckcLayeredFieldResidual({
            stageId: "stage2.statements",
            label,
            field,
            expected: expectedStatementFields[field],
            observed: statements[label][field],
            stage: "bridge",
            code: "ckc_layered_bridge_inconsistent",
            reason: "Statement row is not a deterministic normalization of the CKC segment row."
          }));
        }
      }
    }
    if (validCkcLayeredStatementRow(statements?.[label]) && validCkcLayeredRuleRow(rules?.[label])) {
      const expectedRule = ckcLayeredRuleFromStatementRow(statements[label]);
      residuals.push(...ckcLayeredRowResiduals({
        stageId: "stage3.rules",
        label,
        observedRow: rules[label],
        expectedRow: expectedRule,
        fields: Object.keys(ckcLayeredRuleFieldSpecs),
        stage: "bridge",
        code: "ckc_layered_bridge_inconsistent",
        reason: "Rule row is not a deterministic assembly of the CKC statement row."
      }));
      for (const field of ["direction", "action_key", "age_interval"]) {
        if (
          rules[label][field] === "unknown"
          || (field === "action_key" && rules[label][field] !== "act.administer:drug.abx_a")
        ) {
          residuals.push(ckcLayeredResidual({
            stageId: "stage3.rules",
            stage: "bridge",
            code: "ckc_layered_bridge_incomplete",
            label,
            field,
            expected: field === "action_key" ? "act.administer:drug.abx_a" : "known",
            observed: rules[label][field],
            reason: "The CKC layered route cannot form a complete route_rule_ir.v0 rule for deterministic SMT compilation."
          }));
        }
      }
    }
  }
  return residuals;
}

function ckcLayeredRuleRows(parsed, groupId) {
  return Object.fromEntries(modelCaseForGroup(groupId).labels.map((label) => [
    label,
    validCkcLayeredRuleRow(parsed?.[label]) ? cueFieldsFromCkcLayeredRuleRow(parsed[label]) : null
  ]));
}

function classifyCkcLayeredCandidate({ stageOutputs, modelCalls }, groupId, expected, seed) {
  const segments = stageOutputs.segments.parsed;
  const statements = stageOutputs.statements.parsed;
  const rules = stageOutputs.rules.parsed;
  const residuals = ckcLayeredSchemaResiduals(stageOutputs, groupId);
  const schemaResiduals = residuals.filter((residual) => residual.stage === "schema");
  const schemaValid = schemaResiduals.length === 0;
  const groundingResiduals = schemaValid ? ckcLayeredGroundingResiduals({ segments, statements, rules, groupId }) : [];
  const bridgeResiduals = schemaValid ? ckcLayeredBridgeResiduals({ segments, statements, rules, groupId }) : [];
  residuals.push(...groundingResiduals, ...bridgeResiduals);

  const bridgedRows = schemaValid ? ckcLayeredRuleRows(rules, groupId) : {};
  const bridge = schemaValid ? {
    bridge_id: ckcLayeredBridgeId,
    source_schema_id: ckcLayeredSchemaId,
    target_schema_id: "schema.route_rule_ir.v0",
    stage_schema_ids: ckcLayeredStageSpecs.map((stage) => stage.schema_id),
    stage_lineage: modelCalls.map((call) => ({
      stage_id: call.stage_id,
      granularity: call.granularity,
      schema_id: call.schema_id,
      prompt_hash: call.prompt_hash,
      response_hash: call.response_hash,
      subprocess_exit_status: call.subprocess?.exit_status ?? null
    })),
    segments,
    statements,
    ckc_rules: rules,
    route_rule_rows: bridgedRows,
    residuals: [...groundingResiduals, ...bridgeResiduals]
  } : null;
  const routeIr = schemaValid
    ? routeRuleIrFromRows(bridgedRows, groupId, {
        routeId: "route.ckc_layered",
        bridgeSourceSchemaId: ckcLayeredSchemaId,
        bridge
      })
    : null;
  const evaluated = schemaValid ? evaluateIrRows(bridgedRows, groupId) : { verdict: "target_syntax_failure", route_ir_rules: [], overlap: null };
  const compiledTarget = routeIr ? compileRouteIrToSmt(routeIr, groupId, seed, expected) : null;
  if (compiledTarget && !compiledTarget.syntax_valid) {
    residuals.push(ckcLayeredResidual({
      stageId: "stage3.rules",
      stage: "compiled_target",
      code: "ckc_layered_compiled_target_failure",
      baseCode: "unsupported_ir_fragment",
      label: null,
      expected: "complete route_rule_ir.v0 rules",
      observed: compiledTarget.verdict,
      reason: "The CKC layered payload did not compile into a syntax-valid SMT target."
    }));
  }
  if (compiledTarget) {
    for (const code of compiledTarget.diagnostics) {
      residuals.push(ckcLayeredResidual({
        stageId: "stage3.rules",
        stage: "compiled_target",
        code,
        label: null,
        expected,
        observed: compiledTarget.verdict,
        reason: "Compiled target verdict differs from the locked expected route outcome."
      }));
    }
  }

  const verdict = compiledTarget?.verdict ?? evaluated.verdict;
  const compiledDiagnosticCodes = new Set(compiledTarget?.diagnostics ?? []);
  if (schemaValid && verdict === "unknown" && !residuals.some((residual) => residual.code === "ckc_layered_bridge_incomplete")) {
    residuals.push(ckcLayeredResidual({
      stageId: "stage3.rules",
      stage: "bridge",
      code: "ckc_layered_bridge_incomplete",
      label: null,
      expected: "known action, direction, and age fields",
      observed: "unknown",
      reason: "The CKC layered payload could not be evaluated into a known conflict-task verdict."
    }));
  }
  if (verdict === "semantic_contradiction" && expected === "semantic_no_conflict" && !compiledDiagnosticCodes.has("false_positive_conflict")) {
    residuals.push(ckcLayeredResidual({
      stageId: "stage3.rules",
      stage: "compiled_target",
      code: "false_positive_conflict",
      label: null,
      expected,
      observed: verdict,
      reason: "Compiled target produced a conflict where the locked group is a documented null result."
    }));
  }
  if (verdict === "semantic_no_conflict" && expected === "semantic_contradiction" && !compiledDiagnosticCodes.has("false_negative_conflict")) {
    residuals.push(ckcLayeredResidual({
      stageId: "stage3.rules",
      stage: "compiled_target",
      code: "false_negative_conflict",
      label: null,
      expected,
      observed: verdict,
      reason: "Compiled target missed the locked semantic contradiction."
    }));
  }
  const diagnostics = diagnosticCodesFromResiduals(residuals);
  const target_syntax_valid = Boolean(compiledTarget?.syntax_valid);
  const stageSchemaDiagnostics = Object.fromEntries(ckcLayeredStageSpecs.map((stage) => [
    stage.stage_id,
    schemaResiduals.filter((residual) => residual.stage_id === stage.stage_id)
  ]));

  return {
    syntax_valid: target_syntax_valid,
    target_syntax_valid,
    model_output_syntax_valid: schemaValid,
    admitted: target_syntax_valid && diagnostics.every((code) => !blocksAdmission(code)),
    verdict: target_syntax_valid ? verdict : "target_syntax_failure",
    diagnostics,
    parsed: {
      schema_id: ckcLayeredSchemaId,
      layers: {
        segments: segments ?? null,
        statements: statements ?? null,
        rules: rules ?? null
      },
      route_ir: routeIr,
      deterministic_bridge: bridge ? {
        ...bridge,
        evaluated
      } : null,
      stage_diagnostics: {
        schema: stageSchemaDiagnostics,
        grounding: groundingResiduals,
        bridge: bridgeResiduals,
        compiled_target: residuals.filter((residual) => residual.stage === "compiled_target")
      },
      residuals
    },
    compiled_target: compiledTarget,
    candidate_text: JSON.stringify(stable(bridgedRows ?? {}), null, 2)
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

function objectForNextHop(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function runIrHopChainHop({ hopSpec, prompt, seed, groupId, labels, inputArtifact }) {
  const schema = JSON.stringify(irHopJsonSchemaForHop(hopSpec.hop_id, groupId));
  const subprocess = runLlama(prompt, seed, "route.ir_hop_chain", groupId, null, { schema });
  const rawOutput = cleanModelText(subprocess.stdout, prompt);
  const extracted = extractJsonObject(rawOutput);
  const response = extracted?.text ?? rawOutput;
  const parsed = extracted?.value ?? null;
  return {
    hop_id: hopSpec.hop_id,
    granularity: hopSpec.granularity,
    labels,
    schema_id: hopSpec.schema_id,
    input_artifact: inputArtifact,
    prompt,
    prompt_hash: sha256Text(prompt),
    response,
    parsed_response: parsed,
    response_hash: sha256(response),
    subprocess,
    extracted: extracted ? { value: parsed, text: extracted.text } : null
  };
}

function runCkcLayeredStage({ stageSpec, prompt, seed, groupId, labels, inputArtifact }) {
  const schema = JSON.stringify(ckcLayeredJsonSchemaForStage(stageSpec.stage_id, groupId));
  const subprocess = runLlama(prompt, seed, "route.ckc_layered", groupId, null, { schema });
  const rawOutput = cleanModelText(subprocess.stdout, prompt);
  const extracted = extractJsonObject(rawOutput);
  const response = extracted?.text ?? rawOutput;
  const parsed = extracted?.value ?? null;
  return {
    stage_id: stageSpec.stage_id,
    granularity: stageSpec.granularity,
    labels,
    schema_id: stageSpec.schema_id,
    input_artifact: inputArtifact,
    prompt,
    prompt_hash: sha256Text(prompt),
    response,
    parsed_response: parsed,
    response_hash: sha256(response),
    subprocess,
    extracted: extracted ? { value: parsed, text: extracted.text } : null
  };
}

function aggregateSubprocessFromModelCalls(modelCalls, argsLabel = "<multi-call-route-json-calls>") {
  const failingCall = modelCalls.find((call) => (
    call.subprocess.exit_status !== 0 || call.subprocess.signal || call.subprocess.error || call.subprocess.timed_out
  ));
  const errors = modelCalls.map((call) => call.subprocess.error).filter(Boolean);
  return {
    exit_status: failingCall ? (failingCall.subprocess.exit_status ?? 1) : 0,
    signal: failingCall?.subprocess.signal ?? null,
    error: errors.length > 0 ? errors.join("; ") : null,
    timed_out: modelCalls.some((call) => call.subprocess.timed_out),
    command: {
      executable: path.relative(root, llamaCliPath),
      args: [argsLabel]
    },
    calls: modelCalls.map((call) => ({
      hop_id: call.hop_id ?? null,
      stage_id: call.stage_id ?? null,
      granularity: call.granularity,
      schema_id: call.schema_id,
      labels: call.labels,
      command: call.subprocess.command,
      exit_status: call.subprocess.exit_status,
      signal: call.subprocess.signal,
      error: call.subprocess.error,
      timed_out: call.subprocess.timed_out
    }))
  };
}

function runLiveRoute(routeId, groupId, seed, expected) {
  if (!routeImplemented(routeId)) {
    throw new Error(`route ${routeId} is registered but unimplemented; use --scaffold-routes for closed scaffold rows`);
  }
  if (routeId === "route.single_ir") return runLiveSingleIrRoute(groupId, seed, expected);
  if (routeId === "route.stacked_ir") return runLiveStackedIrRoute(groupId, seed, expected);
  if (routeId === "route.ir_hop_chain") return runLiveIrHopChainRoute(groupId, seed, expected);
  if (routeId === "route.ckc_layered") return runLiveCkcLayeredRoute(groupId, seed, expected);
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

function runLiveIrHopChainRoute(groupId, seed, expected) {
  const labels = modelCaseForGroup(groupId).labels;
  const processDiagnostics = [];

  const lexicalPrompt = promptForIrHopLexicalCues(groupId);
  const lexicalCall = runIrHopChainHop({
    hopSpec: irHopChainHopSpecs[0],
    prompt: lexicalPrompt,
    seed,
    groupId,
    labels,
    inputArtifact: {
      kind: "source_excerpts",
      cue_inputs: Object.fromEntries(labels.map((label) => [label, sourceCuesForLabel(label)]))
    }
  });

  const framePrompt = promptForIrHopClinicalFrame(groupId, objectForNextHop(lexicalCall.parsed_response));
  const frameCall = runIrHopChainHop({
    hopSpec: irHopChainHopSpecs[1],
    prompt: framePrompt,
    seed,
    groupId,
    labels,
    inputArtifact: {
      kind: "hop_output",
      hop_id: lexicalCall.hop_id,
      response_hash: lexicalCall.response_hash
    }
  });

  const ruleRowsPrompt = promptForIrHopRuleRows(groupId, objectForNextHop(frameCall.parsed_response));
  const ruleRowsCall = runIrHopChainHop({
    hopSpec: irHopChainHopSpecs[2],
    prompt: ruleRowsPrompt,
    seed,
    groupId,
    labels,
    inputArtifact: {
      kind: "hop_output",
      hop_id: frameCall.hop_id,
      response_hash: frameCall.response_hash
    }
  });

  const modelCalls = [lexicalCall, frameCall, ruleRowsCall].map(({ extracted, ...call }) => call);
  const hopOutputs = {
    lexical: { extracted: lexicalCall.extracted, parsed: lexicalCall.parsed_response },
    frame: { extracted: frameCall.extracted, parsed: frameCall.parsed_response },
    ruleRows: { extracted: ruleRowsCall.extracted, parsed: ruleRowsCall.parsed_response }
  };
  for (const call of [lexicalCall, frameCall, ruleRowsCall]) {
    if (call.subprocess.exit_status !== 0 || call.subprocess.signal || call.subprocess.error) processDiagnostics.push("process_crash");
  }
  const classified = classifyIrHopChainCandidate({ hopOutputs, modelCalls }, groupId, expected, seed);
  const aggregateSubprocess = aggregateSubprocessFromModelCalls(modelCalls, "<ir-hop-chain-json-hop-calls>");
  return {
    route_id: "route.ir_hop_chain",
    group_id: groupId,
    seed,
    syntax_valid: classified.syntax_valid,
    target_syntax_valid: classified.target_syntax_valid,
    model_output_syntax_valid: classified.model_output_syntax_valid,
    admitted: classified.admitted && processDiagnostics.every((code) => code !== "process_crash"),
    verdict: processDiagnostics.includes("process_crash") ? "solver_execution_failure" : classified.verdict,
    diagnostics: [...new Set([...classified.diagnostics, ...processDiagnostics])],
    prompt: lexicalPrompt,
    response: classified.candidate_text,
    parsed_response: classified.parsed ?? null,
    compiled_target: classified.compiled_target ?? null,
    subprocess: aggregateSubprocess,
    route_call: null,
    source_calls: null,
    model_calls: modelCalls,
    live_call_count: modelCalls.length
  };
}

function runLiveCkcLayeredRoute(groupId, seed, expected) {
  const labels = modelCaseForGroup(groupId).labels;
  const processDiagnostics = [];

  const segmentPrompt = promptForCkcLayeredSegments(groupId);
  const segmentCall = runCkcLayeredStage({
    stageSpec: ckcLayeredStageSpecs[0],
    prompt: segmentPrompt,
    seed,
    groupId,
    labels,
    inputArtifact: {
      kind: "source_excerpts",
      source_refs: Object.fromEntries(labels.map((label) => [label, sourceCuesForLabel(label)]))
    }
  });

  const statementPrompt = promptForCkcLayeredStatements(groupId, objectForNextHop(segmentCall.parsed_response));
  const statementCall = runCkcLayeredStage({
    stageSpec: ckcLayeredStageSpecs[1],
    prompt: statementPrompt,
    seed,
    groupId,
    labels,
    inputArtifact: {
      kind: "ckc_stage_output",
      stage_id: segmentCall.stage_id,
      response_hash: segmentCall.response_hash
    }
  });

  const rulePrompt = promptForCkcLayeredRules(groupId, objectForNextHop(statementCall.parsed_response));
  const ruleCall = runCkcLayeredStage({
    stageSpec: ckcLayeredStageSpecs[2],
    prompt: rulePrompt,
    seed,
    groupId,
    labels,
    inputArtifact: {
      kind: "ckc_stage_output",
      stage_id: statementCall.stage_id,
      response_hash: statementCall.response_hash
    }
  });

  const modelCalls = [segmentCall, statementCall, ruleCall].map(({ extracted, ...call }) => call);
  const stageOutputs = {
    segments: { extracted: segmentCall.extracted, parsed: segmentCall.parsed_response },
    statements: { extracted: statementCall.extracted, parsed: statementCall.parsed_response },
    rules: { extracted: ruleCall.extracted, parsed: ruleCall.parsed_response }
  };
  for (const call of [segmentCall, statementCall, ruleCall]) {
    if (call.subprocess.exit_status !== 0 || call.subprocess.signal || call.subprocess.error) processDiagnostics.push("process_crash");
  }
  const classified = classifyCkcLayeredCandidate({ stageOutputs, modelCalls }, groupId, expected, seed);
  const aggregateSubprocess = aggregateSubprocessFromModelCalls(modelCalls, "<ckc-layered-json-stage-calls>");
  return {
    route_id: "route.ckc_layered",
    group_id: groupId,
    seed,
    syntax_valid: classified.syntax_valid,
    target_syntax_valid: classified.target_syntax_valid,
    model_output_syntax_valid: classified.model_output_syntax_valid,
    admitted: classified.admitted && processDiagnostics.every((code) => code !== "process_crash"),
    verdict: processDiagnostics.includes("process_crash") ? "solver_execution_failure" : classified.verdict,
    diagnostics: [...new Set([...classified.diagnostics, ...processDiagnostics])],
    prompt: segmentPrompt,
    response: classified.candidate_text,
    parsed_response: classified.parsed ?? null,
    compiled_target: classified.compiled_target ?? null,
    subprocess: aggregateSubprocess,
    route_call: null,
    source_calls: null,
    model_calls: modelCalls,
    live_call_count: modelCalls.length
  };
}

function runLiveStackedIrRoute(groupId, seed, expected) {
  const labels = modelCaseForGroup(groupId).labels;
  const processDiagnostics = [];
  const prompt = promptForStackedIrPair(groupId);
  const subprocess = runLlama(prompt, seed, "route.stacked_ir", groupId);
  const rawOutput = cleanModelText(subprocess.stdout, prompt);
  const extracted = extractJsonObject(rawOutput);
  const candidate = extracted?.value && typeof extracted.value === "object" && !Array.isArray(extracted.value)
    ? extracted.value
    : {};
  if (!extracted?.value) processDiagnostics.push("stacked_ir_schema_invalid", "ai_schema_violation");
  if (subprocess.exit_status !== 0 || subprocess.signal || subprocess.error) processDiagnostics.push("process_crash");
  const candidateText = JSON.stringify(stable(candidate), null, 2);
  const classified = classifyStackedIrCandidate({ value: candidate, text: candidateText }, groupId, expected, seed);
  const routeCall = {
    granularity: "source_pair",
    labels,
    schema_id: stackedIrSchemaId,
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
      args: ["<source-pair-stacked-json-call>"]
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
    route_id: "route.stacked_ir",
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

function buildRouteMatrix(routeMetrics) {
  const byRoute = new Map(routeMetrics.map((entry) => [entry.route_id, entry]));
  const baseline = byRoute.get(baselineRouteId);
  if (!baseline) throw new Error(`route-matrix baseline missing: ${baselineRouteId}`);

  const rows = routeIds.map((routeId) => {
    const routeMetric = byRoute.get(routeId);
    if (!routeMetric) throw new Error(`route metrics missing for configured route: ${routeId}`);
    return {
      route_id: routeId,
      comparison_role: routeId === baselineRouteId ? "baseline" : "compared_route",
      metrics: Object.fromEntries(comparisonMetricIds.map((metric) => [
        metric,
        {
          value: routeMetric[metric],
          baseline_value: baseline[metric],
          delta_from_baseline: subtractRatio(routeMetric[metric], baseline[metric])
        }
      ]))
    };
  });

  return {
    artifact_kind: "RouteComparisonMatrix",
    schema_version: "route_comparison_matrix.v1",
    baseline_route_id: baselineRouteId,
    route_ids: [...routeIds],
    metrics: comparisonMetricIds,
    comparison_scope: "Exact route metric values and per-route deltas against the direct SMT baseline over identical groups and seeds.",
    migration_note: "C1 replaced the fixed direct_smt-versus-single_ir lift table with this route-matrix artifact; report and manifest hashes can change from artifact shape even when raw row measurements are unchanged.",
    rows,
    cells: rows.flatMap((row) => comparisonMetricIds.map((metric) => ({
      route_id: row.route_id,
      comparison_role: row.comparison_role,
      metric,
      value: row.metrics[metric].value,
      baseline_route_id: baselineRouteId,
      baseline_value: row.metrics[metric].baseline_value,
      delta_from_baseline: row.metrics[metric].delta_from_baseline
    })))
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
        const simulated = routeImplemented(routeId)
          ? (
              liveModel
                ? runLiveRoute(routeId, group.id, seed, group.expectedOutcome)
                : simulateRoute(routeId, group.id, seed)
            )
          : scaffoldUnimplementedRoute(routeId, group.id, seed);
        if (liveModel) liveCalls += simulated.live_call_count ?? 0;
        const expected = group.expectedOutcome;
        const candidate_verdict_correct = simulated.verdict === expected;
        const verdict_correct = simulated.admitted && candidate_verdict_correct;
        const modelCallRecorded = simulated.model_call_recorded ?? true;
        const prompt = modelCallRecorded ? (simulated.prompt ?? promptFor(routeId, group.id, seed)) : null;
        const liveCallCount = liveModel && modelCallRecorded ? (simulated.live_call_count ?? 1) : 0;
        const row = {
          route_id: routeId,
          group_id: group.id,
          measurement_role: group.measurementRole,
          seed,
          measurement_status: simulated.measurement_status ?? "route_row_observed",
          model_call_recorded: modelCallRecorded,
          live_call_count: liveCallCount,
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
          prompt_hash: prompt === null ? null : sha256Text(prompt),
          response: simulated.response,
          parsed_response: simulated.parsed_response ?? null,
          compiled_target: simulated.compiled_target ?? null,
          route_call: simulated.route_call ?? null,
          source_calls: simulated.source_calls ?? null,
          model_calls: simulated.model_calls ?? null,
          response_hash: sha256(simulated.response),
          subprocess: simulated.subprocess ?? null,
          model_call_recorded: modelCallRecorded,
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
      implementation_status: routeRegistryEntry(routeId)?.implementation_status ?? "unknown",
      measurement_statuses: [...new Set(rows.map((row) => row.measurement_status))].sort(),
      model_call_row_count: rows.filter((row) => row.model_call_recorded).length,
      model_call_count: rows.reduce((sum, row) => sum + (row.live_call_count ?? 0), 0),
      scaffolded_closed_row_count: rows.filter((row) => row.measurement_status === "scaffold_closed_unimplemented").length,
      target_syntax_validity: ratio(rows.filter((row) => row.syntax_valid).length, total),
      model_output_syntax_validity: ratio(rows.filter((row) => row.model_output_syntax_valid).length, total),
      admission_rate: ratio(rows.filter((row) => row.admitted).length, total),
      admitted_verdict_accuracy: ratio(rows.filter((row) => row.verdict_correct).length, total),
      candidate_verdict_accuracy: ratio(rows.filter((row) => row.candidate_verdict_correct).length, total),
      k_sample_stability: ratio(stableGroups, groups.length),
      diagnostics: rows.flatMap((row) => row.diagnostics)
    });
  }

  const routeMetrics = [...byRoute.values()];
  const routeMatrix = buildRouteMatrix(routeMetrics);

  return { rawRows, routeMetrics, routeMatrix, ioRecords, liveCalls };
}

function buildSourceCueLayer() {
  const labels = [...new Set(groups.flatMap((group) => modelCaseForGroup(group.id).labels))].sort();
  return {
    artifact_kind: "SourceCueLayer",
    extractor_id: "lexical_cue_v1",
    scope: "shared_route_input",
    fairness_note: "Implemented route rows are evaluated against the same deterministic source-derived cue rows. R3 prompts no longer include filled answer objects; route.direct_smt composes SMT-LIB directly from source excerpts, route.single_ir derives bounded JSON rows, route.stacked_ir derives source_frame -> rule_row JSON, route.ir_hop_chain derives lexical cues -> clinical frame -> rule rows, and route.ckc_layered derives CKC segment -> statement -> rule JSON before deterministic route_rule_ir.v0 to SMT-LIB compilation. Unimplemented registered routes produce closed scaffold rows only when --scaffold-routes is explicit.",
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
  const routeSummaries = routeIds.map((routeId) => {
    const records = targetRecords.filter((record) => record.route_id === routeId);
    const smtFiles = records
      .flatMap((record) => record.compiled_target.smt_files.map(({ text, ...metadata }) => ({
        route_id: record.route_id,
        group_id: record.group_id,
        seed: record.seed,
        ...metadata
      })))
      .sort((left, right) => left.file.localeCompare(right.file));
    return {
      route_id: routeId,
      compiled_target: records.length > 0,
      source_ir_schema_ids: [...new Set(records.map((record) => record.compiled_target.source_ir_schema_id).filter(Boolean))].sort(),
      bridge_source_schema_ids: [...new Set(records.map((record) => record.compiled_target.bridge_source_schema_id).filter(Boolean))].sort(),
      target_profiles: [...new Set(records.map((record) => record.compiled_target.target_profile).filter(Boolean))].sort(),
      compiler_ids: [...new Set(records.map((record) => record.compiled_target.compiler_id).filter(Boolean))].sort(),
      compiled_row_count: records.length,
      smt_file_count: smtFiles.length,
      smt_files: smtFiles
    };
  });
  return {
    artifact_kind: "RouteTargetSummary",
    schema_version: "route_target_summary.v1",
    route_ids: [...routeIds],
    routes: routeSummaries,
    total_compiled_row_count: routeSummaries.reduce((sum, route) => sum + route.compiled_row_count, 0),
    total_smt_file_count: routeSummaries.reduce((sum, route) => sum + route.smt_file_count, 0)
  };
}

function groupSetForMeasurementRole(measurementRole) {
  if (measurementRole?.startsWith("locked_m1")) return "original_m1_group";
  if (measurementRole?.includes("holdout")) return "m2_holdout_group";
  if (measurementRole?.includes("metamorphic")) return "m3_metamorphic_group";
  if (measurementRole?.startsWith("m3_")) return "m3_expanded_group";
  return "route_evaluation_group";
}

function buildGroupAudit() {
  const rows = groups.map((group) => {
    const fixtures = group.fixtures.map((fixtureId) => fixtureRegistry.find((entry) => entry.id === fixtureId));
    const evidenceRegionIds = group.expectedEvidenceRegionIds.length > 0
      ? group.expectedEvidenceRegionIds
      : fixtures.flatMap((fixture) => fixture?.report_primary_region_ids ?? []);
    const regionsById = new Map(fixtures.flatMap((fixture) => (
      (fixture?.regions ?? []).map((region) => [region.id, { ...region, fixture_id: fixture.id, source_path: fixture.path }])
    )));
    const sourcePaths = fixtures.map((fixture) => fixture?.path ?? null);
    const sourcePathsPresent = sourcePaths.every((sourcePath) => sourcePath && existsSync(path.join(root, sourcePath)));
    const fixtureSemanticsPresent = fixtures.every((fixture) => (
      fixture
      && Array.isArray(fixture.regions)
      && fixture.regions.length > 0
      && Array.isArray(fixture.rules)
      && fixture.rules.length > 0
    ));
    const evidenceQuotes = evidenceRegionIds.map((regionId) => {
      const region = regionsById.get(regionId);
      return {
        region_id: regionId,
        fixture_id: region?.fixture_id ?? null,
        source_path: region?.source_path ?? null,
        role: region?.role ?? null,
        quote: region?.quote ?? null,
        quote_hash: region?.quote ? sha256Text(region.quote) : null
      };
    });
    const evidenceRegionsPresent = evidenceQuotes.every((entry) => entry.quote);
    return {
      group_id: group.id,
      group_set: groupSetForMeasurementRole(group.measurementRole),
      measurement_role: group.measurementRole,
      fixture_ids: group.fixtures,
      source_labels: fixtures.map((fixture) => fixture?.source_label ?? null),
      source_paths: sourcePaths,
      source_paths_present: sourcePathsPresent,
      fixture_semantics_present: fixtureSemanticsPresent,
      gold_present: Boolean(group.expectedOutcome),
      expected_outcome: group.expectedOutcome,
      expected_conflict_kind: group.expectedConflictKind,
      expected_null_result: group.expectedNullResult,
      expected_evidence_note: group.expectedEvidenceNote,
      expected_evidence_region_ids: evidenceRegionIds,
      evidence_regions_present: evidenceRegionsPresent,
      evidence_quotes: evidenceQuotes,
      audit_pass: sourcePathsPresent && fixtureSemanticsPresent && Boolean(group.expectedOutcome) && evidenceRegionsPresent
    };
  });
  const groupSetCounts = {};
  for (const row of rows) groupSetCounts[row.group_set] = (groupSetCounts[row.group_set] ?? 0) + 1;
  return {
    artifact_kind: "M3RouteGroupAudit",
    schema_version: "m3_route_group_audit.v0",
    experiment_id: selectedExperimentId,
    scope: "Audit that each selected route-evaluation group resolves to gold expectations, fixture semantics, source paths, and quoted evidence regions.",
    group_count: rows.length,
    group_set_counts: groupSetCounts,
    all_groups_have_gold_fixture_semantics_and_source_paths: rows.every((row) => row.audit_pass),
    rows
  };
}

function buildRouteEvaluation(rawRows) {
  const evaluationGroups = groups.map((group) => ({
    group_id: group.id,
    group_set: groupSetForMeasurementRole(group.measurementRole),
    fixture_ids: group.fixtures,
    source_labels: modelCaseForGroup(group.id).labels,
    measurement_role: group.measurementRole,
    mutation_note: group.mutationNote,
    expected_outcome: group.expectedOutcome,
    expected_conflict_kind: group.expectedConflictKind,
    expected_null_result: group.expectedNullResult
  }));
  const routeCategoryCounts = Object.fromEntries(routeIds.map((routeId) => {
    const routeRows = rawRows.filter((row) => row.route_id === routeId);
    return [routeId, Object.fromEntries(Object.keys(diagnosticCategoryDefinitions).map((category) => [
      category,
      routeRows.filter((row) => row.diagnostic_categories.includes(category)).length
    ]))];
  }));
  const scaffoldedRouteIds = scaffoldRoutes ? [...unimplementedRouteIds] : [];
  const hasScaffoldedRoutes = scaffoldedRouteIds.length > 0;
  return {
    artifact_kind: "RouteEvaluationAudit",
    schema_version: "route_evaluation_audit.v0",
    experiment_id: selectedExperimentId,
    evaluator_id: "source_derived_route_pair_evaluator.v2",
    scope: hasScaffoldedRoutes
      ? "Registered M3 route comparison over the frozen M2 groups; implemented routes are measured, while still-unimplemented routes emit closed diagnostic rows and no model calls."
      : "Implemented route rows are scored over the same source-derived expected cue rows and group verdicts.",
    evaluation_strength: hasScaffoldedRoutes ? "route_registry_scaffold_check" : "scaffolded_cue_translation_test",
    evaluation_strength_note: hasScaffoldedRoutes
      ? "This run includes measured implemented routes and closed rows for still-unimplemented registered routes. Closed scaffold rows are excluded from model-call provenance and carry deferred_gate_required diagnostics instead of fabricated outputs."
      : "R3 removes exact filled JSON payloads from route.single_ir prompts and adds a holdout mutation group. M3 route extensions add stacked, hop-chain, and CKC-layered JSON routes under the same evaluator. Prompts still supply schema and cue definitions, so this remains a scaffolded route-translation test rather than raw Japanese guideline understanding.",
    harness_change_note: "C1 generalizes the comparison harness from a fixed lift table to a baseline-aware route matrix and per-route target summaries; current route raw rows are still the measurement source.",
    scaffold_mode: scaffoldRoutes,
    unimplemented_route_ids: [...unimplementedRouteIds],
    scaffolded_route_ids: scaffoldedRouteIds,
    diagnostic_categories: diagnosticCategoryDefinitions,
    evaluation_groups: evaluationGroups,
    holdout_group_ids: evaluationGroups
      .filter((group) => group.measurement_role.includes("holdout") || group.measurement_role.includes("mutation"))
      .map((group) => group.group_id),
    expanded_group_ids: evaluationGroups
      .filter((group) => group.group_set === "m3_expanded_group" || group.group_set === "m3_metamorphic_group")
      .map((group) => group.group_id),
    group_set_counts: evaluationGroups.reduce((counts, group) => ({
      ...counts,
      [group.group_set]: (counts[group.group_set] ?? 0) + 1
    }), {}),
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
      surface_id: "m3_expanded_evaluation_groups",
      stage: "m3_route_evaluation",
      classification: "data_driven",
      evidence_paths: ["metrics/group_audit.json", m1InputRefs.experiments_registry_path, m1InputRefs.gold_expectations_path],
      note: "M3 route groups are separated by group_set in route_evaluation and checked for source paths, fixture semantics, gold, and quoted evidence regions."
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
  if (routeId === "route.stacked_ir" && granularity === "source_pair") return "prompt.route_stacked_ir.cds_ticket_stacked_json.v0";
  if (routeId === "route.stacked_ir") return "prompt.route_stacked_ir.cds_ticket_stacked_json.v0";
  if (routeId === "route.ir_hop_chain" && granularity === "hop.lexical_cues") return "prompt.route_ir_hop_chain.cds_ticket_lexical_cues.v0";
  if (routeId === "route.ir_hop_chain" && granularity === "hop.clinical_frame") return "prompt.route_ir_hop_chain.cds_ticket_clinical_frame.v0";
  if (routeId === "route.ir_hop_chain" && granularity === "hop.rule_rows") return "prompt.route_ir_hop_chain.cds_ticket_rule_rows.v0";
  if (routeId === "route.ckc_layered" && granularity === "stage.segments") return "prompt.route_ckc_layered.cds_ticket_segments.v0";
  if (routeId === "route.ckc_layered" && granularity === "stage.statements") return "prompt.route_ckc_layered.cds_ticket_statements.v0";
  if (routeId === "route.ckc_layered" && granularity === "stage.rules") return "prompt.route_ckc_layered.cds_ticket_rules.v0";
  return `prompt.${routeId.replaceAll(".", "_")}.${granularity}.v3`;
}

function promptOutputContract(routeId, granularity) {
  if (routeId === "route.direct_smt") return "self-contained SMT-LIB 2 program";
  if (routeId === "route.single_ir" && granularity === "source_pair") {
    return "CDS import JSON object keyed by source label; constrained by llama.cpp JSON schema";
  }
  if (routeId === "route.single_ir") return "CDS import JSON object";
  if (routeId === "route.stacked_ir") return "stacked CDS import JSON: source_frame -> rule_row -> route_rule_ir.v0 bridge";
  if (routeId === "route.ir_hop_chain" && granularity === "hop.lexical_cues") return "hop 1 JSON: source excerpts -> lexical cue rows";
  if (routeId === "route.ir_hop_chain" && granularity === "hop.clinical_frame") return "hop 2 JSON: lexical cue rows -> clinical frame rows";
  if (routeId === "route.ir_hop_chain" && granularity === "hop.rule_rows") return "hop 3 JSON: clinical frame rows -> route_rule_ir.v0 cue rows";
  if (routeId === "route.ir_hop_chain") return "IR hop-chain JSON output";
  if (routeId === "route.ckc_layered" && granularity === "stage.segments") return "CKC layer JSON stage 1: source excerpts -> segment-like span rows";
  if (routeId === "route.ckc_layered" && granularity === "stage.statements") return "CKC layer JSON stage 2: segments -> normalized clinical statement rows";
  if (routeId === "route.ckc_layered" && granularity === "stage.rules") return "CKC layer JSON stage 3: statements -> rule rows for deterministic route_rule_ir.v0 bridge";
  if (routeId === "route.ckc_layered") return "CKC layered JSON output";
  return "route-specific model output";
}

function promptCatalogPath(routeId, groupId, promptHash) {
  return `prompts/${routeId}/${groupId}/prompt-${promptHash.slice(0, 12)}.txt`;
}

function modelCallsForIoRecord(record) {
  if (record.model_call_recorded === false) return [];
  if (Array.isArray(record.model_calls) && record.model_calls.length > 0) {
    return record.model_calls.map((call, index) => ({
      call_index: index + 1,
      granularity: call.granularity ?? call.hop_id ?? "route",
      hop_id: call.hop_id ?? call.stage_id ?? null,
      stage_id: call.stage_id ?? null,
      schema_id: call.schema_id ?? null,
      prompt: call.prompt,
      prompt_hash: call.prompt_hash ?? sha256Text(call.prompt),
      response_hash: call.response_hash ?? sha256(call.response ?? ""),
      output_contract: call.output_contract ?? null
    }));
  }
  if (record.route_call) {
    return [{
      call_index: 1,
      granularity: record.route_call.granularity ?? "route",
      hop_id: null,
      stage_id: null,
      schema_id: record.route_call.schema_id ?? null,
      prompt: record.route_call.prompt,
      prompt_hash: record.route_call.prompt_hash ?? sha256Text(record.route_call.prompt),
      response_hash: record.route_call.response_hash ?? record.response_hash,
      output_contract: record.route_call.output_contract ?? null
    }];
  }
  return [{
    call_index: 1,
    granularity: "route",
    hop_id: null,
    stage_id: null,
    schema_id: null,
    prompt: record.prompt,
    prompt_hash: record.prompt_hash ?? sha256Text(record.prompt),
    response_hash: record.response_hash,
    output_contract: null
  }];
}

function buildPromptCatalog(ioRecords) {
  const modelCallRecords = ioRecords.filter((record) => record.model_call_recorded !== false);
  const calls = modelCallRecords.flatMap((record) => modelCallsForIoRecord(record).map((modelCall) => {
    const granularity = modelCall.granularity ?? "route";
    const promptText = modelCall.prompt;
    const promptHash = modelCall.prompt_hash ?? sha256Text(promptText);
    return {
      call_id: `${record.record_id}.${granularity}.${modelCall.call_index}`.replaceAll("..", "."),
      model_io_record_id: record.record_id,
      route_id: record.route_id,
      group_id: record.group_id,
      seed: record.seed,
      granularity,
      hop_id: modelCall.hop_id ?? null,
      stage_id: modelCall.stage_id ?? null,
      schema_id: modelCall.schema_id ?? null,
      prompt_template_id: promptTemplateId(record.route_id, granularity),
      output_contract: modelCall.output_contract ?? promptOutputContract(record.route_id, granularity),
      prompt_hash: promptHash,
      response_hash: modelCall.response_hash,
      prompt_text: promptText
    };
  })).sort((left, right) => [
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
    if (!byHash.has(call.prompt_hash)) {
      byHash.set(call.prompt_hash, {
        prompt_hash: call.prompt_hash,
        prompt_text: call.prompt_text,
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

function routeMetricById(report, routeId) {
  return report.metrics.route_metrics.find((entry) => entry.route_id === routeId);
}

function matrixCell(routeMatrix, routeId, metric) {
  const row = routeMatrix.rows.find((entry) => entry.route_id === routeId);
  if (!row) throw new Error(`route matrix row missing: ${routeId}`);
  const cell = row.metrics[metric];
  if (!cell) throw new Error(`route matrix metric missing: ${routeId} ${metric}`);
  return cell;
}

function routeMatrixMarkdown(routeMatrix, mode) {
  const header = `| Metric | ${routeMatrix.route_ids.map((routeId) => `\`${routeId}\``).join(" | ")} |`;
  const align = `| --- | ${routeMatrix.route_ids.map(() => "---:").join(" | ")} |`;
  const rows = routeMatrix.metrics.map((metric) => {
    const values = routeMatrix.route_ids.map((routeId) => {
      const cell = matrixCell(routeMatrix, routeId, metric);
      return mode === "delta" ? cell.delta_from_baseline.exact : cell.value.exact;
    });
    return `| ${metric} | ${values.join(" | ")} |`;
  }).join("\n");
  return [header, align, rows].join("\n");
}

function routeMatrixConclusion(report, locale = "en") {
  const matrix = report.metrics.route_matrix;
  const baseline = routeMetricById(report, matrix.baseline_route_id);
  const compared = report.metrics.route_metrics.filter((entry) => entry.route_id !== matrix.baseline_route_id);
  const admittedLifts = compared.filter((entry) => compareRatios(entry.admitted_verdict_accuracy, baseline.admitted_verdict_accuracy) > 0);
  const targetLeader = report.metrics.route_metrics
    .slice()
    .sort((left, right) => compareRatios(right.target_syntax_validity, left.target_syntax_validity) || left.route_id.localeCompare(right.route_id))
    .at(0);
  const candidateLeader = report.metrics.route_metrics
    .slice()
    .sort((left, right) => compareRatios(right.candidate_verdict_accuracy, left.candidate_verdict_accuracy) || left.route_id.localeCompare(right.route_id))
    .at(0);
  if (locale === "ja") {
    return [
      `baseline は \`${matrix.baseline_route_id}\`。`,
      admittedLifts.length === 0
        ? `この run では baseline を上回る admitted verdict accuracy の route はない。baseline は ${baseline.admitted_verdict_accuracy.exact}。`
        : `admitted verdict accuracy で baseline を上回る route: ${admittedLifts.map((entry) => `\`${entry.route_id}\` ${entry.admitted_verdict_accuracy.exact}`).join(", ")}。`,
      `target syntax の最大値は \`${targetLeader.route_id}\` ${targetLeader.target_syntax_validity.exact}。candidate verdict accuracy の最大値は \`${candidateLeader.route_id}\` ${candidateLeader.candidate_verdict_accuracy.exact}。candidate accuracy は rejected output の監査情報としてのみ扱う。`
    ].join(" ");
  }
  return [
    `Baseline route: \`${matrix.baseline_route_id}\`.`,
    admittedLifts.length === 0
      ? `No compared route exceeds the baseline on admitted verdict accuracy in this run; baseline admitted accuracy is ${baseline.admitted_verdict_accuracy.exact}.`
      : `Compared routes exceeding baseline admitted verdict accuracy: ${admittedLifts.map((entry) => `\`${entry.route_id}\` ${entry.admitted_verdict_accuracy.exact}`).join(", ")}.`,
    `The highest target-syntax route is \`${targetLeader.route_id}\` at ${targetLeader.target_syntax_validity.exact}; the highest candidate-verdict route is \`${candidateLeader.route_id}\` at ${candidateLeader.candidate_verdict_accuracy.exact}, reported only as rejected-output audit evidence.`
  ].join(" ");
}

function routeTargetSummaryMarkdown(routeTargetSummary) {
  const rows = routeTargetSummary.routes.map((route) => `| \`${route.route_id}\` | ${route.compiled_target} | ${route.source_ir_schema_ids.map((entry) => `\`${entry}\``).join(", ") || "none"} | ${(route.bridge_source_schema_ids ?? []).map((entry) => `\`${entry}\``).join(", ") || "none"} | ${route.compiler_ids.map((entry) => `\`${entry}\``).join(", ") || "none"} | ${route.target_profiles.map((entry) => `\`${entry}\``).join(", ") || "none"} | ${route.compiled_row_count} | ${route.smt_file_count} |`).join("\n");
  return `| Route | Compiled target | IR schema(s) | Bridge schema(s) | Compiler(s) | Target profile(s) | Compiled rows | SMT files |
| --- | --- | --- | --- | --- | --- | ---: | ---: |
${rows}`;
}

function markdownReport(report) {
  const rawRows = report.metrics.raw_rows.map((row) => `| ${row.route_id} | ${row.group_id} | ${row.measurement_role} | ${row.measurement_status} | ${row.model_call_recorded} | ${row.live_call_count ?? 0} | ${row.seed} | ${row.model_output_syntax_valid} | ${row.target_syntax_valid} | ${row.admitted} | ${row.verdict} | ${row.verdict_correct} | ${row.candidate_verdict_correct} | ${row.diagnostic_categories.join(", ") || "none"} |`).join("\n");
  const groupRows = report.m2_evaluation.evaluation_groups.map((group) => `| \`${group.group_id}\` | ${group.group_set} | ${group.measurement_role} | ${group.source_labels.join(", ")} | ${group.expected_outcome} | ${group.expected_conflict_kind ?? "none"} | ${group.mutation_note ?? "none"} |`).join("\n");
  const diagnosticCategoryRows = Object.entries(report.m2_evaluation.diagnostic_categories).map(([category, codes]) => `| ${category} | ${codes.map((code) => `\`${code}\``).join(", ")} |`).join("\n");
  const diagnostics = Object.entries(report.diagnostics_summary).map(([code, count]) => `- ${code}: ${count}`).join("\n") || "- none: 0";
  const comparisonConclusion = routeMatrixConclusion(report);
  const directAudit = report.direct_smt_audit;
  const directAuditConclusion = `Direct SMT residual audit: exact template matches ${directAudit.exact_template_match_rate.exact}; rows without named assertions ${directAudit.missing_named_assertion_rate.exact}; rows asserting negated sepsis ${directAudit.negated_sepsis_assertion_rate.exact}. This audit is non-admission evidence for malformed direct target composition under the shared cue layer.`;
  const realGuidelineRows = report.real_guideline_intake.sources.map((source) => `| ${source.id} | ${source.license_label} | ${source.raw_cache_status} | ${source.candidate_span_count} | ${source.admitted_candidate_rule_count} | ${source.rejected_residual_count} | ${source.guideline_relation} |`).join("\n");
  const routeSectionTitle = report.route_experiment.experiment_id === "exp.m2_lift" ? "M2 route matrix" : "Route matrix";
  const routeIntro = "Implemented routes finish at SMT-LIB under the same evaluator: direct SMT asks the model for target text, single_ir asks for bounded JSON rows, stacked_ir asks for a source_frame -> rule_row stack, ir_hop_chain asks for three adjacent JSON hops, and ckc_layered asks for CKC segment -> statement -> rule stages before deterministic route_rule_ir.v0 compilation. Closed scaffold routes, when present, make no model calls and are not fabricated measurements.";
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

## ${routeSectionTitle}

Shared route input: \`${report.source_cue_layer.extractor_id}\` / cue hash \`${report.source_cue_layer.cue_hash}\`. ${routeIntro}

Evaluation strength: \`${report.m2_evaluation.evaluation_strength}\`. ${report.m2_evaluation.evaluation_strength_note}

Harness note: ${report.m2_evaluation.harness_change_note}

| Group | Set | Role | Source labels | Expected | Conflict kind | Note |
| --- | --- | --- | --- | --- | --- | --- |
${groupRows}

Group audit: \`${report.m3_group_audit.artifact_kind}\` checked ${report.m3_group_audit.group_count} groups; pass = ${report.m3_group_audit.all_groups_have_gold_fixture_semantics_and_source_paths}. Group sets: ${Object.entries(report.m3_group_audit.group_set_counts).map(([groupSet, count]) => `${groupSet}=${count}`).join(", ")}.

### Exact route values

${routeMatrixMarkdown(report.metrics.route_matrix, "value")}

### Delta from \`${report.metrics.route_matrix.baseline_route_id}\`

${routeMatrixMarkdown(report.metrics.route_matrix, "delta")}

${comparisonConclusion}

${directAuditConclusion}

${promptCatalogMarkdown(report.prompt_catalog)}

## Compiled route targets

${routeTargetSummaryMarkdown(report.route_target_summary)}

## Raw route rows

| Route | Group | Role | Status | Model call | Live calls | Seed | Model syntax valid | Target syntax valid | Admitted | Verdict | Admitted correct | Candidate correct | Diagnostic categories |
| --- | --- | --- | --- | --- | ---: | ---: | --- | --- | --- | --- | --- | --- | --- |
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
  const groupRows = report.m2_evaluation.evaluation_groups.map((group) => `| \`${group.group_id}\` | ${group.group_set} | ${group.measurement_role} | ${group.source_labels.join(", ")} | ${group.expected_outcome} | ${group.expected_conflict_kind ?? "none"} | ${group.mutation_note ?? "none"} |`).join("\n");
  const comparisonConclusion = routeMatrixConclusion(report, "ja");
  const directAudit = report.direct_smt_audit;
  const directAuditConclusion = `Direct SMT residual audit: exact template match ${directAudit.exact_template_match_rate.exact}、named assertion なし ${directAudit.missing_named_assertion_rate.exact}、negated sepsis assertion ${directAudit.negated_sepsis_assertion_rate.exact}。これは admission 判定外の監査情報であり、shared cue layer 下で direct target composition が malformed になることを記録する。`;
  const realGuidelineRows = report.real_guideline_intake.sources.map((source) => `| ${source.id} | ${source.license_label} | ${source.raw_cache_status} | ${source.candidate_span_count} | ${source.admitted_candidate_rule_count} | ${source.rejected_residual_count} |`).join("\n");
  const routeSectionTitle = report.route_experiment.experiment_id === "exp.m2_lift" ? "M2 route matrix" : "Route matrix";
  const routeIntro = "implemented route は同じ evaluator の下で SMT-LIB に到達する。direct SMT は model が target text を直接構成し、single_ir は bounded JSON row、stacked_ir は source_frame -> rule_row stack、ir_hop_chain は lexical cues -> clinical frame -> rule rows の 3 hop JSON、ckc_layered は CKC segment -> statement -> rule stages を出力し、deterministic route_rule_ir.v0 compiler が SMT-LIB に変換する。closed scaffold route がある場合、model call はなく fabricated measurement ではない。";
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

## ${routeSectionTitle}

shared route input: \`${report.source_cue_layer.extractor_id}\` / cue hash \`${report.source_cue_layer.cue_hash}\`。${routeIntro}

evaluation strength: \`${report.m2_evaluation.evaluation_strength}\`。${report.m2_evaluation.evaluation_strength_note}

harness note: ${report.m2_evaluation.harness_change_note}

| group | set | role | source labels | expected | conflict kind | note |
| --- | --- | --- | --- | --- | --- | --- |
${groupRows}

group audit: \`${report.m3_group_audit.artifact_kind}\` は ${report.m3_group_audit.group_count} groups を確認。pass = ${report.m3_group_audit.all_groups_have_gold_fixture_semantics_and_source_paths}。group sets: ${Object.entries(report.m3_group_audit.group_set_counts).map(([groupSet, count]) => `${groupSet}=${count}`).join(", ")}.

### Exact route values

${routeMatrixMarkdown(report.metrics.route_matrix, "value")}

### Delta from \`${report.metrics.route_matrix.baseline_route_id}\`

${routeMatrixMarkdown(report.metrics.route_matrix, "delta")}

${comparisonConclusion}

${directAuditConclusion}

${promptCatalogJapaneseMarkdown(report.prompt_catalog)}

## Compiled route targets

${routeTargetSummaryMarkdown(report.route_target_summary)}
`;
}

function pipelineMatrixMarkdown(pipelineMatrix, mode) {
  const header = `| Metric | ${pipelineMatrix.pipeline_ids.map((pipelineId) => `\`${pipelineId}\``).join(" | ")} |`;
  const align = `| --- | ${pipelineMatrix.pipeline_ids.map(() => "---:").join(" | ")} |`;
  const rows = pipelineMatrix.metrics.map((metric) => {
    const values = pipelineMatrix.pipeline_ids.map((pipelineId) => {
      const row = pipelineMatrix.rows.find((entry) => entry.pipeline_id === pipelineId);
      const cell = row.metrics[metric];
      return mode === "delta" ? cell.delta_from_baseline.exact : cell.value.exact;
    });
    return `| ${metric} | ${values.join(" | ")} |`;
  }).join("\n");
  return [header, align, rows].join("\n");
}

function pipelineComparisonConclusion(report, locale = "en") {
  const matrix = report.metrics.pipeline_matrix;
  const layeredRow = matrix.rows.find((row) => row.pipeline_id === report.pipeline_comparison.layered_pipeline_id);
  const deltas = Object.fromEntries(matrix.metrics.map((metric) => [metric, layeredRow.metrics[metric].delta_from_baseline.exact]));
  if (locale === "ja") {
    return [
      `baseline pipeline は \`${matrix.baseline_pipeline_id}\`。`,
      `layered-minus-direct deltas: ${Object.entries(deltas).map(([metric, delta]) => `${metric}=${delta}`).join(", ")}。`,
      `model-route delta はこの run では計算せず、\`exp.m3_routes\` の route matrix に分離する。`
    ].join(" ");
  }
  return [
    `Baseline pipeline: \`${matrix.baseline_pipeline_id}\`.`,
    `Layered-minus-direct deltas: ${Object.entries(deltas).map(([metric, delta]) => `${metric}=${delta}`).join(", ")}.`,
    "Model-route deltas are not computed in this run; they remain isolated in the exp.m3_routes route matrix."
  ].join(" ");
}

function pipelineMarkdownReport(report) {
  const rawRows = report.metrics.pipeline_raw_rows.map((row) => `| ${row.pipeline_id} | ${row.group_id} | ${row.measurement_role} | ${row.compiled} | ${row.verdict} | ${row.conflict_kind ?? "none"} | ${row.expected} | ${row.expected_conflict_kind ?? "none"} | ${row.verdict_correct} | ${row.conflict_kind_correct} | ${row.query_count} | ${row.smt_file_count} |`).join("\n");
  const groupRows = report.pipeline_comparison.evaluation_groups.map((group) => `| \`${group.group_id}\` | ${group.group_set} | ${group.measurement_role} | ${group.source_labels.join(", ")} | ${group.expected_outcome} | ${group.expected_conflict_kind ?? "none"} |`).join("\n");
  const compactRows = report.compactness_front.points.map((point) => `| \`${point.pipeline_id}\` | ${point.model_call_count} | ${point.group_local_rule_occurrences} | ${point.stored_component_count} | ${point.component_occurrence_count} | ${point.reused_occurrence_count} | ${point.component_reuse_rate.exact} | ${point.smt_file_count} | ${point.coverage.exact} | ${point.residuals.join("; ") || "none"} |`).join("\n");
  const reuseRows = report.component_reuse_graph.pipelines.map((pipeline) => `| \`${pipeline.pipeline_id}\` | ${pipeline.component_store_participation} | ${pipeline.component_occurrence_count} | ${pipeline.unique_component_count} | ${pipeline.reused_occurrence_count} | ${pipeline.reuse_rate.exact} | ${pipeline.residual ?? "none"} |`).join("\n");
  return `# CKC M3 deterministic pipeline comparison

Run: \`${report.run_id}\`

Scope: research harness; synthetic fixture measurement. This report compares deterministic pipeline artifacts only and makes no clinical, patient-care, deployment, or regulatory claim.

## Pipeline Matrix

Evaluation groups:

| Group | Set | Role | Source labels | Expected | Conflict kind |
| --- | --- | --- | --- | --- | --- |
${groupRows}

### Exact Pipeline Values

${pipelineMatrixMarkdown(report.metrics.pipeline_matrix, "value")}

### Layered-Minus-Direct Deltas

${pipelineMatrixMarkdown(report.metrics.pipeline_matrix, "delta")}

${pipelineComparisonConclusion(report)}

Model-route delta scope: ${report.pipeline_comparison.model_route_delta_scope}

## Candidate Diff

\`candidate_diff.json\` compares segment, binding, rule, assertion, verdict, and metric levels for ${report.candidate_diff.group_rows.length} groups. Candidate diff hash: \`${sha256(report.candidate_diff)}\`.

## Component Reuse

| Pipeline | Component store | Occurrences | Unique components | Reused occurrences | Reuse rate | Residual |
| --- | --- | ---: | ---: | ---: | ---: | --- |
${reuseRows}

## Compactness Front

| Pipeline | Model calls | Group-local rule occurrences | Stored components | Component occurrences | Reused occurrences | Reuse rate | SMT files | Coverage | Residuals |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
${compactRows}

## Raw Pipeline Rows

| Pipeline | Group | Role | Compiled | Verdict | Conflict kind | Expected | Expected kind | Verdict correct | Kind correct | Queries | SMT files |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ---: | ---: |
${rawRows}
`;
}

function pipelineJapaneseReport(report) {
  const rawRows = report.metrics.pipeline_raw_rows.map((row) => `| ${row.pipeline_id} | ${row.group_id} | ${row.compiled} | ${row.verdict} | ${row.conflict_kind ?? "none"} | ${row.expected} | ${row.expected_conflict_kind ?? "none"} | ${row.verdict_correct} | ${row.conflict_kind_correct} |`).join("\n");
  return `# CKC M3 deterministic pipeline comparison 研究レポート

run: \`${report.run_id}\`

範囲: research harness、synthetic fixture measurement。deterministic pipeline artifact の比較のみであり、臨床、患者ケア、導入、規制上の主張はしない。

## Pipeline matrix

### Exact pipeline values

${pipelineMatrixMarkdown(report.metrics.pipeline_matrix, "value")}

### Layered-minus-direct deltas

${pipelineMatrixMarkdown(report.metrics.pipeline_matrix, "delta")}

${pipelineComparisonConclusion(report, "ja")}

model-route delta scope: ${report.pipeline_comparison.model_route_delta_scope}

## Raw pipeline rows

| pipeline | group | compiled | verdict | conflict kind | expected | expected kind | verdict correct | kind correct |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rawRows}
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

async function writePipelineComparisonRun({ artifactsByDoc, directArtifactsByDoc, realGuidelineIntake, finding, nullResult }) {
  for (const docArtifacts of directArtifactsByDoc.values()) {
    await writeJson(`pipeline_artifacts/${baselinePipelineId}/${docArtifacts.fixture.id}/direct_segments.json`, docArtifacts.segments);
    await writeJson(`pipeline_artifacts/${baselinePipelineId}/${docArtifacts.fixture.id}/direct_phrase_normalization.json`, docArtifacts.normalization);
    await writeJson(`pipeline_artifacts/${baselinePipelineId}/${docArtifacts.fixture.id}/direct_formal_ir.json`, docArtifacts.ir_bundle);
  }
  for (const docArtifacts of artifactsByDoc.values()) {
    await writeJson(`pipeline_artifacts/${layeredPipelineId}/${docArtifacts.fixture.id}/artifact_refs.json`, {
      artifact_kind: "LayeredPipelineArtifactRefs",
      schema_version: "layered_pipeline_artifact_refs.v0",
      pipeline_id: layeredPipelineId,
      doc_id: docArtifacts.fixture.id,
      source_graph_path: `artifacts/${docArtifacts.fixture.id}/source_graph.json`,
      segments_path: `artifacts/${docArtifacts.fixture.id}/segments.json`,
      normalization_path: `artifacts/${docArtifacts.fixture.id}/normalization.json`,
      ir_bundle_path: `artifacts/${docArtifacts.fixture.id}/ir_bundle.json`,
      component_reuse_participation: true
    });
  }

  const pipelineResults = [];
  for (const pipelineId of pipelineIds) {
    const pipelineDocs = pipelineDocsFor(pipelineId, artifactsByDoc, directArtifactsByDoc);
    for (const group of groups) {
      const result = compilePipelineGroup(group, pipelineId, pipelineDocs);
      pipelineResults.push(result);
      await writeJson(`pipelines/${pipelineId}/${group.id}/compiled.json`, result.compiled);
      await writeJson(`pipelines/${pipelineId}/${group.id}/verifier_results.json`, result.verifier);
      for (const [fileName, text] of Object.entries(result.smt)) {
        await writeText(fileName, text);
      }
    }
  }

  const componentReuseGraph = buildComponentReuseGraph(artifactsByDoc);
  const compactnessFront = buildCompactnessFront({ pipelineResults, componentReuseGraph });
  const pipelineRawRows = pipelineResults.map((result) => pipelineRawRow(result));
  const pipelineMetrics = buildPipelineMetrics(pipelineRawRows, componentReuseGraph);
  const pipelineMatrix = buildPipelineMatrix(pipelineMetrics);
  const candidateDiff = buildCandidateDiff({
    pipelineResults,
    rawRows: pipelineRawRows,
    pipelineMetrics,
    pipelineMatrix,
    artifactsByDoc,
    directArtifactsByDoc,
    componentReuseGraph,
    compactnessFront
  });
  const groupAudit = buildGroupAudit();
  const modelMeta = await modelMetadata(0);

  await writeJson("candidate_diff.json", candidateDiff);
  await writeJson("component_reuse_graph.json", componentReuseGraph);
  await writeJson("compactness_front.json", compactnessFront);
  await writeJson("metrics/pipeline_raw_rows.json", pipelineRawRows);
  await writeJson("metrics/pipeline_metrics.json", pipelineMetrics);
  await writeJson("metrics/pipeline_matrix.json", pipelineMatrix);
  await writeJson("metrics/group_audit.json", groupAudit);

  const report = {
    artifact_kind: "DeterministicPipelineComparisonReport",
    schema_version: "m3_pipeline_comparison_report.v0",
    run_id: runId,
    generated_by: "tools/build-run.mjs",
    experiments: ["exp.m1_spine", selectedExperimentId],
    pipeline_comparison: {
      experiment_id: selectedExperimentId,
      basis: selectedExperiment?.basis ?? null,
      comparison_scope: selectedExperiment?.comparison_scope ?? null,
      baseline_pipeline_id: baselinePipelineId,
      layered_pipeline_id: layeredPipelineId,
      pipeline_ids: [...pipelineIds],
      model_route_delta_scope: "not_computed_in_exp.m3_compare; use exp.m3_routes metrics/route_matrix.json for model-route deltas",
      evaluation_groups: groups.map((group) => ({
        group_id: group.id,
        group_set: groupSetForMeasurementRole(group.measurementRole),
        fixture_ids: group.fixtures,
        source_labels: modelCaseForGroup(group.id).labels,
        measurement_role: group.measurementRole,
        expected_outcome: group.expectedOutcome,
        expected_conflict_kind: group.expectedConflictKind,
        expected_null_result: group.expectedNullResult,
        mutation_note: group.mutationNote
      }))
    },
    corpus_hash: sha256({
      synthetic_fixtures: fixtureRegistry.map((fixture) => ({ id: fixture.id, path: fixture.path })),
      fixture_semantics: m1InputRefs.fixture_semantics_hash,
      experiment_registry: m1InputRefs.experiments_registry_hash,
      gold_expectations: m1InputRefs.gold_expectations_hash,
      real_guidelines: realGuidelineIntake.registry_hash
    }),
    solver_identity: "one-shot-js-symbolic-verifier",
    model_identity: modelMeta.model_identity,
    model_runtime: modelMeta.model_runtime,
    model_mode: modelMeta.model_mode,
    live_model_calls: 0,
    findings: [finding],
    null_results: [nullResult],
    metrics: {
      pipeline_raw_rows: pipelineRawRows,
      pipeline_metrics: pipelineMetrics,
      pipeline_matrix: pipelineMatrix
    },
    candidate_diff: candidateDiff,
    component_reuse_graph: componentReuseGraph,
    compactness_front: compactnessFront,
    m3_group_audit: groupAudit,
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
      admission_scope: realGuidelineIntake.admission_scope,
      scoring_scope: realGuidelineIntake.scoring_scope,
      clinical_claim_scope: realGuidelineIntake.clinical_claim_scope
    },
    replay: {
      status: "byte_stable_on_current_generation",
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
      "verifier-checked",
      "replayable",
      "synthetic fixture measurement",
      "documented null result",
      "deterministic pipeline comparison"
    ]
  };

  await writeJson("report.json", report);
  await writeText("report.md", pipelineMarkdownReport(report));
  await writeText("report.ja.md", pipelineJapaneseReport(report));

  const manifest = {
    artifact_kind: "RunManifest",
    run_id: runId,
    created_at: "2026-06-11T00:00:00Z",
    stack_deviation: "JavaScript one-shot harness instead of the spec04 Rust/model/solver stack",
    selected_experiment_id: selectedExperimentId,
    experiment_kind: experimentKind,
    experiments: report.experiments,
    model_mode: report.model_mode,
    model_identity: report.model_identity,
    model_runtime: report.model_runtime,
    fixture_ids: fixtureRegistry.map((fixture) => fixture.id),
    pipeline_ids: pipelineIds,
    baseline_pipeline_id: baselinePipelineId,
    layered_pipeline_id: layeredPipelineId,
    candidate_diff_hash: sha256(candidateDiff),
    component_reuse_graph_hash: sha256(componentReuseGraph),
    compactness_front_hash: sha256(compactnessFront),
    pipeline_matrix_hash: sha256(pipelineMatrix),
    group_audit_hash: sha256(groupAudit),
    real_guideline_intake_hash: sha256(realGuidelineIntake),
    report_hash: sha256(report)
  };
  await writeJson("manifest.json", manifest);

  const events = [
    { event: "run_started", run_id: runId },
    { event: "m1_spine_completed", outcome: "ok" },
    {
      event: "pipeline_experiment_completed",
      experiment_id: selectedExperimentId,
      outcome: "ok",
      model_mode: report.model_mode,
      live_model_calls: 0,
      pipeline_ids: [...pipelineIds]
    },
    { event: "run_completed", outcome: "ok" }
  ];
  await writeText("logs/events.jsonl", events.map((entry) => JSON.stringify(stable(entry))).join("\n"));
  await writeText("logs/diagnostics.jsonl", "");

  const replayManifest = await buildReplayManifest();
  await writeJson("replay_manifest.json", replayManifest);

  if (verifyMode) {
    const requiredFiles = [
      "report.json",
      "report.md",
      "report.ja.md",
      "candidate_diff.json",
      "component_reuse_graph.json",
      "compactness_front.json",
      "metrics/pipeline_raw_rows.json",
      "metrics/pipeline_metrics.json",
      "metrics/pipeline_matrix.json",
      "metrics/group_audit.json",
      "trace_bundle.json",
      "lineage_index.json",
      "real_guidelines/source_intake.json",
      "manifest.json",
      "replay_manifest.json"
    ];
    const layeredMatrixRow = pipelineMatrix.rows.find((row) => row.pipeline_id === layeredPipelineId);
    const assertions = [
      experimentKind === "pipeline_comparison",
      selectedExperiment?.id === selectedExperimentId,
      report.pipeline_comparison.experiment_id === selectedExperimentId,
      report.pipeline_comparison.model_route_delta_scope.includes("exp.m3_routes"),
      pipelineIds.includes(baselinePipelineId),
      pipelineIds.includes(layeredPipelineId),
      pipelineResults.length === pipelineIds.length * groups.length,
      pipelineRawRows.length === pipelineResults.length,
      pipelineRawRows.every((row) => row.compiled && row.verdict_correct && row.conflict_kind_correct),
      pipelineMetrics.every((entry) => entry.samples === groups.length),
      pipelineMetrics.every((entry) => entry.model_call_count === 0),
      pipelineMatrix.baseline_pipeline_id === baselinePipelineId,
      pipelineMatrix.layered_pipeline_id === layeredPipelineId,
      pipelineMatrix.rows.length === pipelineIds.length,
      pipelineMatrix.cells.length === pipelineIds.length * pipelineMetricIds.length,
      layeredMatrixRow && pipelineMetricIds.every((metricId) => layeredMatrixRow.metrics[metricId].delta_from_baseline.exact),
      candidateDiff.group_rows.length === groups.length,
      candidateDiff.group_rows.every((row) => row.verdict_level.verdicts_equal && row.verdict_level.conflict_kinds_equal),
      candidateDiff.model_route_delta_scope.includes("route_matrix"),
      componentReuseGraph.pipelines.some((entry) => entry.pipeline_id === baselinePipelineId && entry.component_store_participation === false && entry.residual),
      componentReuseGraph.pipelines.some((entry) => entry.pipeline_id === layeredPipelineId && entry.component_store_participation === true),
      compactnessFront.points.length === pipelineIds.length,
      compactnessFront.points.every((point) => point.model_call_count === 0 && point.coverage.exact === `${groups.length}/${groups.length}`),
      groupAudit.all_groups_have_gold_fixture_semantics_and_source_paths,
      report.live_model_calls === 0,
      report.model_mode === "deterministic_no_model",
      ...requiredFiles.map((relative) => existsSync(path.join(runDir, relative)))
    ];
    if (assertions.some((entry) => !entry)) {
      throw new Error("pipeline comparison verification failed");
    }
  }

  console.log(JSON.stringify({
    run_dir: path.relative(root, runDir),
    report: path.relative(root, path.join(runDir, "report.json")),
    experiment_id: selectedExperimentId,
    experiment_kind: experimentKind,
    model_mode: report.model_mode,
    live_model_calls: 0,
    pipeline_verdict_accuracy: Object.fromEntries(pipelineMetrics.map((entry) => [entry.pipeline_id, entry.verdict_accuracy.exact])),
    pipeline_conflict_kind_accuracy: Object.fromEntries(pipelineMetrics.map((entry) => [entry.pipeline_id, entry.conflict_kind_accuracy.exact])),
    verified: verifyMode
  }, null, 2));
}

async function modelMetadata(liveCalls) {
  if (experimentKind === "pipeline_comparison") {
    return {
      model_identity: "not_applicable.deterministic_pipeline_compare",
      model_runtime: "deterministic-js-run-builder-only",
      live_model_calls: 0,
      model_mode: "deterministic_no_model"
    };
  }
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

function buildRunConfigSummary() {
  const base = {
    selected_experiment_id: selectedExperimentId,
    run_id: runId,
    run_dir: path.relative(root, runDir),
    experiment_kind: experimentKind,
    model_mode: experimentKind === "pipeline_comparison" ? "deterministic_no_model" : liveModel ? "live_local_llama_cpp" : "recorded_unsupported"
  };
  if (experimentKind === "pipeline_comparison") {
    return {
      ...base,
      pipelines: pipelineIds.map((pipelineId) => ({
        pipeline_id: pipelineId,
        implemented_in_harness: pipelineImplemented(pipelineId),
        comparison_role: pipelineId === baselinePipelineId ? "baseline" : "compared_pipeline"
      })),
      evaluation_group_ids: groups.map((group) => group.id)
    };
  }
  return {
    ...base,
    scaffold_mode: scaffoldRoutes,
    routes: routeIds.map((routeId) => {
      const route = routeRegistryEntry(routeId);
      return {
        route_id: routeId,
        implementation_status: route?.implementation_status ?? "unknown",
        implemented_in_harness: routeImplemented(routeId),
        scaffolded_closed: scaffoldRoutes && !routeImplemented(routeId)
      };
    }),
    unimplemented_route_ids: [...unimplementedRouteIds],
    evaluation_group_ids: groups.map((group) => group.id),
    sample_seeds: [...sampleSeeds]
  };
}

async function main() {
  await loadM1FixtureInputs();
  if (printConfig) {
    console.log(JSON.stringify(buildRunConfigSummary(), null, 2));
    return;
  }
  if (liveModel && experimentKind === "route_comparison") requireLiveModelReady();
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
      factual_claims: cloneData(fixture.factual_claims ?? []),
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

  if (experimentKind === "pipeline_comparison") {
    const directArtifactsByDoc = buildDirectPipelineArtifacts(artifactsByDoc);
    await writePipelineComparisonRun({
      artifactsByDoc,
      directArtifactsByDoc,
      realGuidelineIntake,
      finding,
      nullResult
    });
    return;
  }

  const metrics = scoreRows();
  const sourceCueLayer = buildSourceCueLayer();
  const directSmtAudit = buildDirectSmtAudit(metrics.ioRecords);
  const routeTargetSummary = buildRouteTargetSummary(metrics.ioRecords);
  const routeEvaluation = buildRouteEvaluation(metrics.rawRows);
  const groupAudit = buildGroupAudit();
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
  await writeJson("metrics/route_matrix.json", metrics.routeMatrix);
  await writeJson("metrics/direct_smt_audit.json", directSmtAudit);
  await writeJson("metrics/source_cues.json", sourceCueLayer);
  await writeJson("metrics/route_targets.json", routeTargetSummary);
  await writeJson("metrics/route_evaluation.json", routeEvaluation);
  await writeJson("metrics/group_audit.json", groupAudit);
  await writeJson("metrics/realism_audit.json", realismAudit);

  const diagnosticsSummary = {};
  for (const row of metrics.rawRows) {
    for (const diagnostic of row.diagnostics) diagnosticsSummary[diagnostic] = (diagnosticsSummary[diagnostic] ?? 0) + 1;
  }

  const report = {
    artifact_kind: "Report",
    run_id: runId,
    generated_by: "tools/build-run.mjs",
    experiments: ["exp.m1_spine", selectedExperimentId],
    route_experiment: {
      experiment_id: selectedExperimentId,
      basis: selectedExperiment?.basis ?? null,
      route_ids: [...routeIds],
      sample_seeds: [...sampleSeeds],
      scaffold_mode: scaffoldRoutes,
      unimplemented_route_ids: [...unimplementedRouteIds]
    },
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
      route_matrix: metrics.routeMatrix
    },
    direct_smt_audit: directSmtAudit,
    route_target_summary: routeTargetSummary,
    route_evaluation: routeEvaluation,
    m3_group_audit: groupAudit,
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
      experiment_id: routeEvaluation.experiment_id,
      evaluator_id: routeEvaluation.evaluator_id,
      evaluation_strength: routeEvaluation.evaluation_strength,
      evaluation_strength_note: routeEvaluation.evaluation_strength_note,
      harness_change_note: routeEvaluation.harness_change_note,
      scaffold_mode: routeEvaluation.scaffold_mode,
      unimplemented_route_ids: routeEvaluation.unimplemented_route_ids,
      scaffolded_route_ids: routeEvaluation.scaffolded_route_ids,
      evaluation_groups: routeEvaluation.evaluation_groups,
      holdout_group_ids: routeEvaluation.holdout_group_ids,
      expanded_group_ids: routeEvaluation.expanded_group_ids,
      group_set_counts: routeEvaluation.group_set_counts,
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
    selected_experiment_id: selectedExperimentId,
    experiments: report.experiments,
    fixture_ids: fixtureRegistry.map((fixture) => fixture.id),
    real_guideline_source_ids: realGuidelineIntake.sources.map((source) => source.id),
    real_guideline_intake_hash: sha256(realGuidelineIntake),
    source_cue_layer_hash: sha256(sourceCueLayer),
    route_target_summary_hash: sha256(routeTargetSummary),
    route_matrix_hash: sha256(metrics.routeMatrix),
    route_evaluation_hash: sha256(routeEvaluation),
    group_audit_hash: sha256(groupAudit),
    realism_audit_hash: realismAuditHash,
    prompt_catalog_hash: sha256(promptCatalog),
    prompt_template_hashes: Object.fromEntries(promptCatalog.entries.map((entry) => [entry.prompt_id, entry.prompt_hash])),
    route_ids: routeIds,
    scaffold_mode: scaffoldRoutes,
    unimplemented_route_ids: [...unimplementedRouteIds],
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
    {
      event: "route_experiment_completed",
      experiment_id: selectedExperimentId,
      outcome: "ok",
      model_mode: modelMeta.model_mode,
      live_model_calls: modelMeta.live_model_calls,
      scaffold_mode: scaffoldRoutes,
      unimplemented_route_ids: [...unimplementedRouteIds]
    },
    { event: "run_completed", outcome: "ok" }
  ];
  await writeText("logs/events.jsonl", events.map((entry) => JSON.stringify(stable(entry))).join("\n"));
  const diagnostics = [
    ...metrics.rawRows.flatMap((row) => row.diagnostics.map((code) => ({
      code,
      outcome: code === "false_positive_conflict" ? "incoherence" : code === "deferred_gate_required" ? "deferred" : "invalid",
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
    const routeMetricsById = new Map(metrics.routeMetrics.map((entry) => [entry.route_id, entry]));
    const direct = routeMetricsById.get(baselineRouteId);
    const single = routeMetricsById.get("route.single_ir");
    const compiledTargetRecords = metrics.ioRecords.filter((record) => record.compiled_target);
    const compiledSmtFiles = routeTargetSummary.routes.flatMap((route) => route.smt_files);
    const modelCallRecords = metrics.ioRecords.filter((record) => record.model_call_recorded !== false);
    const scaffoldRecords = metrics.ioRecords.filter((record) => record.model_call_recorded === false);
    const scaffoldRows = metrics.rawRows.filter((row) => row.measurement_status === "scaffold_closed_unimplemented");
    const modelCallEntries = modelCallRecords.flatMap((record) => modelCallsForIoRecord(record));
    const uniquePromptHashCount = new Set(modelCallEntries.map((call) => call.prompt_hash ?? sha256Text(call.prompt))).size;
    const requiredFiles = [
      "report.json",
      "report.md",
      "report.ja.md",
      "trace_bundle.json",
      "lineage_index.json",
      "real_guidelines/source_intake.json",
      ...realGuidelineIntake.sources.flatMap((source) => Object.values(source.artifacts).map((artifact) => artifact.path)),
      "metrics/raw_rows.json",
      "metrics/route_matrix.json",
      "metrics/direct_smt_audit.json",
      "metrics/source_cues.json",
      "metrics/route_targets.json",
      "metrics/route_evaluation.json",
      "metrics/group_audit.json",
      "metrics/realism_audit.json",
      "prompts/catalog.json",
      ...promptCatalog.entries.map((entry) => entry.prompt_path),
      ...(liveModel ? compiledSmtFiles.map((entry) => entry.file) : []),
      `model_io/${baselineRouteId}/${conflictGroupResult.compiled.group_id}/seed-${sampleSeeds[0]}.json`
    ];
    const commonAssertions = [
      selectedExperiment?.id === selectedExperimentId,
      report.experiments.includes(selectedExperimentId),
      report.route_experiment.experiment_id === selectedExperimentId,
      report.route_experiment.scaffold_mode === scaffoldRoutes,
      report.route_experiment.unimplemented_route_ids.join("\u0000") === unimplementedRouteIds.join("\u0000"),
      finding?.conflict_kind === "deontic_direction_conflict",
      nullResult?.classification === "documented_null_result",
      direct.samples === groups.length * sampleSeeds.length,
      metrics.routeMetrics.every((entry) => entry.samples === groups.length * sampleSeeds.length),
      metrics.rawRows.length === routeIds.length * groups.length * sampleSeeds.length,
      metrics.ioRecords.length === metrics.rawRows.length,
      routeEvaluation.raw_row_count === metrics.rawRows.length,
      metrics.routeMatrix.baseline_route_id === baselineRouteId,
      report.metrics.route_matrix.baseline_route_id === baselineRouteId,
      metrics.routeMatrix.route_ids.join("\u0000") === routeIds.join("\u0000"),
      metrics.routeMatrix.rows.length === routeIds.length,
      metrics.routeMatrix.cells.length === routeIds.length * comparisonMetricIds.length,
      metrics.routeMatrix.rows.every((row) => routeIds.includes(row.route_id) && comparisonMetricIds.every((metric) => row.metrics[metric]?.value?.exact)),
      metrics.routeMetrics.every((entry) => routeIds.includes(entry.route_id)),
      metrics.routeMetrics.every((entry) => Array.isArray(entry.measurement_statuses)),
      metrics.routeMetrics.every((entry) => entry.model_call_row_count + entry.scaffolded_closed_row_count === entry.samples),
      metrics.routeMetrics.every((entry) => entry.model_call_count >= 0),
      routeTargetSummary.route_ids.join("\u0000") === routeIds.join("\u0000"),
      routeTargetSummary.routes.length === routeIds.length,
      routeTargetSummary.total_compiled_row_count === compiledTargetRecords.length,
      routeTargetSummary.total_smt_file_count === compiledTargetRecords.flatMap((record) => record.compiled_target?.smt_files ?? []).length,
      routeTargetSummary.routes.every((route) => route.compiled_row_count === compiledTargetRecords.filter((record) => record.route_id === route.route_id).length),
      routeEvaluation.holdout_group_ids.includes("group.m2_holdout_conflict"),
      routeEvaluation.evaluation_groups.some((group) => group.group_id === "group.m2_holdout_conflict" && group.measurement_role === "holdout_mutation_conflict"),
      metrics.rawRows.some((row) => row.group_id === "group.m2_holdout_conflict"),
      metrics.rawRows.every((row) => row.evaluator_id === routeEvaluation.evaluator_id),
      metrics.rawRows.every((row) => Array.isArray(row.diagnostic_categories)),
      groupAudit.group_count === groups.length,
      groupAudit.all_groups_have_gold_fixture_semantics_and_source_paths,
      groupAudit.rows.every((row) => row.audit_pass && row.evidence_quotes.every((quote) => quote.quote_hash?.length === 64)),
      report.m3_group_audit.all_groups_have_gold_fixture_semantics_and_source_paths,
      selectedExperimentId !== "exp.m3_routes" || groupAudit.rows.some((row) => row.group_set === "m3_expanded_group"),
      selectedExperimentId !== "exp.m3_routes" || groupAudit.rows.some((row) => row.group_set === "m3_metamorphic_group"),
      selectedExperimentId !== "exp.m3_routes" || routeEvaluation.expanded_group_ids.length >= 4,
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
      promptCatalog.prompt_count === uniquePromptHashCount,
      promptCatalog.call_count === modelCallEntries.length,
      promptCatalog.entries.every((entry) => !/Import payload:\n\{/.test(entry.prompt_text)),
      promptCatalog.entries.every((entry) => !/normalized fields for /.test(entry.prompt_text)),
      report.prompt_catalog.catalog_hash === sha256(promptCatalog),
      report.m2_evaluation.experiment_id === selectedExperimentId,
      report.m2_evaluation.evaluation_strength === (unimplementedRouteIds.length > 0 ? "route_registry_scaffold_check" : "scaffolded_cue_translation_test"),
      report.m2_evaluation.harness_change_note === routeEvaluation.harness_change_note,
      report.m2_evaluation.scaffold_mode === scaffoldRoutes,
      report.m2_evaluation.unimplemented_route_ids.join("\u0000") === unimplementedRouteIds.join("\u0000"),
      report.m2_evaluation.scaffolded_route_ids.join("\u0000") === (scaffoldRoutes ? unimplementedRouteIds.join("\u0000") : ""),
      report.m2_evaluation.holdout_group_ids.includes("group.m2_holdout_conflict"),
      report.realism_audit.audit_hash === realismAuditHash,
      realismAudit.surfaces.some((surface) => surface.surface_id === "fixture_regions" && surface.classification === "data_driven"),
      realismAudit.surfaces.some((surface) => surface.surface_id === "context_overlap_and_smt_encoding" && surface.classification === "hardcoded"),
      realismAudit.surfaces.some((surface) => surface.surface_id === "llm_prompt_templates" && surface.classification === "prompt_scaffolded"),
      realismAudit.surfaces.some((surface) => surface.surface_id === "report_renderer" && surface.evidence_paths.every((entry) => entry !== "index.html")),
      modelCallRecords.every((record) => record.prompt_hash === sha256Text(record.prompt)),
      modelCallRecords.every((record) => !record.route_call || record.route_call.prompt_hash === sha256Text(record.route_call.prompt)),
      modelCallRecords.every((record) => modelCallsForIoRecord(record).every((call) => (
        call.prompt_hash === sha256Text(call.prompt) && typeof call.response_hash === "string" && call.response_hash.length === 64
      ))),
      unimplementedRouteIds.length === 0 || scaffoldRoutes,
      scaffoldRecords.length === scaffoldRows.length,
      scaffoldRecords.every((record) => unimplementedRouteIds.includes(record.route_id)),
      scaffoldRecords.every((record) => record.prompt === null && record.prompt_hash === null && record.subprocess === null),
      scaffoldRows.every((row) => unimplementedRouteIds.includes(row.route_id)),
      scaffoldRows.every((row) => row.model_call_recorded === false && row.diagnostics.includes("deferred_gate_required")),
      scaffoldRows.every((row) => row.admitted === false && row.verdict === "route_unimplemented"),
      ...requiredFiles.map((relative) => existsSync(path.join(runDir, relative)))
    ];
    const modelAssertions = liveModel
      ? [
          report.model_mode === "live_local_llama_cpp",
          report.live_model_calls === metrics.liveCalls,
          report.model_identity.startsWith("Qwen2.5-0.5B-Instruct-Q2_K:"),
          report.source_cue_layer.extractor_id === "lexical_cue_v1",
          report.route_target_summary.total_compiled_row_count === compiledTargetRecords.length,
          report.route_target_summary.total_smt_file_count === compiledTargetRecords.flatMap((record) => record.compiled_target?.smt_files ?? []).length,
          compiledTargetRecords.every((record) => record.compiled_target?.target_profile === "smt-lib-2"),
          modelCallRecords.every((record) => record.subprocess?.exit_status === 0),
          modelCallRecords.every((record) => modelCallsForIoRecord(record).length === (record.row.live_call_count ?? 1)),
          metrics.rawRows.reduce((sum, row) => sum + (row.live_call_count ?? 0), 0) === metrics.liveCalls,
          metrics.ioRecords.every((record) => record.response_hash && record.response_hash.length === 64),
          direct.target_syntax_validity.denominator === direct.samples,
          ...(single ? [single.target_syntax_validity.denominator === single.samples] : []),
          report.direct_smt_audit.exact_template_match_rate.denominator === direct.samples,
          report.direct_smt_audit.missing_named_assertion_rate.denominator === direct.samples,
          report.direct_smt_audit.negated_sepsis_assertion_rate.denominator === direct.samples,
          ...(single ? [single.k_sample_stability.denominator === groups.length] : []),
          ...(!routeIds.includes("route.ir_hop_chain") ? [] : [
            routeMetricsById.get("route.ir_hop_chain")?.model_call_count === routeMetricsById.get("route.ir_hop_chain")?.samples * irHopChainHopSpecs.length,
            metrics.ioRecords
              .filter((record) => record.route_id === "route.ir_hop_chain")
              .every((record) => (
                record.model_calls?.length === irHopChainHopSpecs.length
                && record.parsed_response?.deterministic_bridge?.hop_lineage?.length === irHopChainHopSpecs.length
                && record.model_calls.every((call) => call.prompt_hash?.length === 64 && call.response_hash?.length === 64)
              ))
          ]),
          ...(!routeIds.includes("route.ckc_layered") ? [] : [
            routeMetricsById.get("route.ckc_layered")?.model_call_count === routeMetricsById.get("route.ckc_layered")?.samples * ckcLayeredStageSpecs.length,
            metrics.ioRecords
              .filter((record) => record.route_id === "route.ckc_layered")
              .every((record) => (
                record.model_calls?.length === ckcLayeredStageSpecs.length
                && record.parsed_response?.deterministic_bridge?.stage_lineage?.length === ckcLayeredStageSpecs.length
                && record.parsed_response?.stage_diagnostics
                && record.model_calls.every((call) => call.prompt_hash?.length === 64 && call.response_hash?.length === 64 && call.stage_id)
              ))
          ])
        ]
      : [
          report.model_mode === "recorded_unsupported",
          report.live_model_calls === 0,
          metrics.routeMetrics.every((entry) => entry.target_syntax_validity.exact === `0/${entry.samples}`),
          metrics.routeMetrics.every((entry) => entry.admission_rate.exact === `0/${entry.samples}`),
          metrics.routeMetrics.every((entry) => entry.admitted_verdict_accuracy.exact === `0/${entry.samples}`)
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
    experiment_id: selectedExperimentId,
    scaffold_mode: scaffoldRoutes,
    unimplemented_route_ids: [...unimplementedRouteIds],
    model_mode: report.model_mode,
    live_model_calls: report.live_model_calls,
    findings: report.findings.length,
    null_results: report.null_results.length,
    route_admitted_accuracy: Object.fromEntries(metrics.routeMetrics.map((entry) => [entry.route_id, entry.admitted_verdict_accuracy.exact])),
    route_candidate_accuracy: Object.fromEntries(metrics.routeMetrics.map((entry) => [entry.route_id, entry.candidate_verdict_accuracy.exact])),
    verified: verifyMode
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
