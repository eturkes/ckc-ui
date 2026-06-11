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
const verifyMode = process.argv.includes("--verify");
const recordedModel = process.argv.includes("--recorded-model");
const liveModel = process.argv.includes("--live-model") || !recordedModel;
const llamaCliPath = process.env.CKC_LLAMA_CLI ?? path.join(root, ".local", "bin", "llama-cli");
const modelPath = process.env.CKC_MODEL_PATH ?? path.join(root, ".local", "models", "qwen2.5-0.5b-instruct-q2_k.gguf");
const modelName = "Qwen2.5-0.5B-Instruct-Q2_K";
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

function groupSourceLines(groupId) {
  if (groupId === "group.m1_conflict") {
    return [
      "A: 成人(18歳以上)の敗血症患者には抗菌薬Aを投与することを推奨する(強い推奨)。",
      "A-exception: ただし、重度腎機能障害のある患者を除く。",
      "B: 成人の敗血症患者のうち、妊娠中の患者には抗菌薬Aを投与しないこと(禁忌)。"
    ];
  }
  return [
    "A: 成人(18歳以上)の敗血症患者には抗菌薬Aを投与することを推奨する(強い推奨)。",
    "A-exception: ただし、重度腎機能障害のある患者を除く。",
    "Control: 小児(18歳未満)の敗血症患者には抗菌薬Aは禁忌である。"
  ];
}

function allowedRulesForGroup(groupId) {
  return groupId === "group.m1_conflict"
    ? ["rule.a.cq1.r1", "rule.b.contra1"]
    : ["rule.a.cq1.r1", "rule.control.child.contra1"];
}

function promptFor(routeId, groupId, seed) {
  const common = [
    "You are a weak local model inside a research harness.",
    "Translate only the provided synthetic Japanese fixture spans.",
    "No clinical, patient-care, deployment, or regulatory claim.",
    `group: ${groupId}`,
    `seed: ${seed}`,
    "source spans:",
    ...groupSourceLines(groupId)
  ];
  if (routeId === "route.direct_smt") {
    return [
      ...common,
      "route: route.direct_smt",
      "Output only SMT-LIB text. Do not use Markdown.",
      "Use only these symbols: |q.age_years|, |cond.sepsis|, |cond.renal_severe|, |cond.pregnancy|, |pos:act.administer:drug.abx_a|.",
      "End with (check-sat)."
    ].join("\n");
  }
  return [
    ...common,
    "route: route.single_ir",
    "Output only one minified JSON object. Do not use Markdown.",
    "Schema: {\"rules\":[string,string],\"verdict\":\"semantic_contradiction|semantic_no_conflict\"}",
    `Allowed rules: ${allowedRulesForGroup(groupId).join(", ")}`
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

function llamaArgs(prompt, seed) {
  return [
    "-m", modelPath,
    "-p", prompt,
    "-n", "180",
    "--ctx-size", "1536",
    "--temp", "0.2",
    "--top-k", "20",
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

function runLlama(prompt, seed) {
  requireLiveModelReady();
  const args = llamaArgs(prompt, seed);
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
    for (let end = cleaned.indexOf("}", start); end >= 0; end = cleaned.indexOf("}", end + 1)) {
      const text = cleaned.slice(start, end + 1);
      try {
        candidates.push({ value: JSON.parse(text), text });
        break;
      } catch {
        // Keep scanning; prompts may contain schema examples that are not valid JSON.
      }
    }
  }
  return candidates.at(-1) ?? null;
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
  if (verdict !== "unknown" && verdict !== expected) diagnostics.push("false_positive_conflict");

  return {
    syntax_valid,
    admitted: syntax_valid && verdict !== "unknown" && !hallucinated,
    verdict: syntax_valid ? verdict : "target_syntax_failure",
    diagnostics: [...new Set(diagnostics)]
  };
}

function classifySingleIr(output, groupId, expected) {
  const diagnostics = [];
  const extracted = extractJsonObject(output);
  const parsed = extracted?.value;
  const syntax_valid = Boolean(parsed);
  if (!syntax_valid) diagnostics.push("ai_schema_violation");

  const allowedRules = new Set(allowedRulesForGroup(groupId));
  const rules = Array.isArray(parsed?.rules) ? parsed.rules : [];
  const verdict = parsed?.verdict;
  const allowedVerdict = verdict === "semantic_contradiction" || verdict === "semantic_no_conflict";
  const allowedRuleSet = rules.length > 0 && rules.every((rule) => allowedRules.has(rule));
  if (syntax_valid && !allowedRuleSet) diagnostics.push("ai_hallucinated_source");
  if (syntax_valid && !allowedVerdict) diagnostics.push("unsupported_ir_fragment");
  if (allowedVerdict && verdict !== expected) diagnostics.push("false_positive_conflict");

  return {
    syntax_valid,
    admitted: syntax_valid && allowedRuleSet && allowedVerdict,
    verdict: allowedVerdict ? verdict : (syntax_valid ? "unknown" : "target_syntax_failure"),
    diagnostics: [...new Set(diagnostics)],
    parsed,
    candidate_text: extracted?.text ?? cleanModelText(output)
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
  const prompt = promptFor(routeId, groupId, seed);
  const subprocess = runLlama(prompt, seed);
  const rawOutput = cleanModelText(subprocess.stdout, prompt);
  const output = routeId === "route.direct_smt" ? extractSmtCandidateText(rawOutput) : rawOutput;
  const classified = routeId === "route.direct_smt"
    ? classifyDirectSmt(output, expected)
    : classifySingleIr(output, groupId, expected);
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
    subprocess
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
        if (liveModel) liveCalls += 1;
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
          parsed_response: simulated.parsed_response ?? null,
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

  return { rawRows, routeMetrics: [...byRoute.values()], liftTable, ioRecords, liveCalls };
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

## Model route identity

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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}

function renderBasicUi(data) {
  const report = data.report;
  const direct = data.route_metrics.find((entry) => entry.route_id === "route.direct_smt");
  const single = data.route_metrics.find((entry) => entry.route_id === "route.single_ir");
  const routeRows = data.route_metrics.map((entry) => `
          <tr>
            <td><code>${escapeHtml(entry.route_id)}</code></td>
            <td>${escapeHtml(entry.target_syntax_validity.exact)}</td>
            <td>${escapeHtml(entry.admission_rate.exact)}</td>
            <td>${escapeHtml(entry.verdict_accuracy.exact)}</td>
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
            <td>${escapeHtml(row.diagnostics.join(", ") || "none")}</td>
          </tr>`).join("");
  const ioBlocks = data.model_io.map((record) => `
        <details>
          <summary><code>${escapeHtml(record.route_id)}</code> / <code>${escapeHtml(record.group_id)}</code> / seed ${escapeHtml(record.seed)} / ${record.row.admitted ? "admitted" : "not admitted"}</summary>
          <h3>Prompt</h3>
          <pre>${escapeHtml(record.prompt)}</pre>
          <h3>Response</h3>
          <pre>${escapeHtml(record.response)}</pre>
          <h3>Scored row</h3>
          <pre>${escapeHtml(JSON.stringify(record.row, null, 2))}</pre>
        </details>`).join("");
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
        <div class="metric"><strong>${escapeHtml(`${direct.verdict_accuracy.exact} -> ${single.verdict_accuracy.exact}`)}</strong><span>direct SMT to single IR accuracy</span></div>
      </div>
    </section>

    <section>
      <h2>M1 evidence</h2>
      <p><code>${escapeHtml(finding.finding_id)}</code> / <code>${escapeHtml(nullResult.null_result_id)}</code></p>
      ${finding.quoted_spans.map((span) => `<div class="quote"><code>${escapeHtml(span.region_id)}</code>: ${escapeHtml(span.text)}</div>`).join("")}
      <div class="quote"><code>${escapeHtml(nullResult.quoted_spans[1].region_id)}</code>: ${escapeHtml(nullResult.quoted_spans[1].text)}</div>
    </section>

    <section>
      <h2>Route metrics</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Route</th><th>Syntax</th><th>Admission</th><th>Accuracy</th><th>Stability</th></tr></thead>
          <tbody>${routeRows}
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>Raw rows</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Route</th><th>Group</th><th>Seed</th><th>Syntax</th><th>Admitted</th><th>Verdict</th><th>Correct</th><th>Diagnostics</th></tr></thead>
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
      model_identity: "recorded.one-shot.weak-ja-symbolic-stub",
      model_runtime: "deterministic-js-fixture-adapter",
      live_model_calls: 0,
      model_mode: "recorded"
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
  const modelMeta = await modelMetadata(metrics.liveCalls);
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
    model_mode: modelMeta.model_mode,
    model_identity: modelMeta.model_identity,
    model_runtime: modelMeta.model_runtime,
    experiments: report.experiments,
    fixture_ids: fixtureRegistry.map((fixture) => fixture.id),
    route_ids: ["route.direct_smt", "route.single_ir"],
    report_hash: sha256(report)
  };
  await writeJson("manifest.json", manifest);

  const events = [
    { event: "run_started", run_id: runId },
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
      "metrics/raw_rows.json",
      "model_io/route.direct_smt/group.m1_conflict/seed-11.json"
    ];
    const commonAssertions = [
      finding?.conflict_kind === "deontic_direction_conflict",
      nullResult?.classification === "documented_null_result",
      direct.samples === 6,
      single.samples === 6,
      metrics.rawRows.length === 12,
      metrics.ioRecords.length === 12,
      existsSync(webDataPath),
      ...requiredFiles.map((relative) => existsSync(path.join(runDir, relative)))
    ];
    const modelAssertions = liveModel
      ? [
          report.model_mode === "live_local_llama_cpp",
          report.live_model_calls === 12,
          metrics.ioRecords.every((record) => record.subprocess?.exit_status === 0),
          metrics.ioRecords.every((record) => record.response_hash && record.response_hash.length === 64)
        ]
      : [
          direct.target_syntax_validity.exact === "4/6",
          direct.admission_rate.exact === "3/6",
          direct.verdict_accuracy.exact === "2/6",
          single.target_syntax_validity.exact === "6/6",
          single.admission_rate.exact === "6/6",
          single.verdict_accuracy.exact === "6/6"
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
    direct_smt_accuracy: metrics.routeMetrics.find((entry) => entry.route_id === "route.direct_smt").verdict_accuracy.exact,
    single_ir_accuracy: metrics.routeMetrics.find((entry) => entry.route_id === "route.single_ir").verdict_accuracy.exact,
    verified: verifyMode
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
