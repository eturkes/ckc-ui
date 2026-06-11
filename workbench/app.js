(function () {
  const data = window.CKC_RUN;
  const main = document.querySelector("#main");
  const subtitle = document.querySelector("#run-subtitle");
  const statusStrip = document.querySelector("#status-strip");
  let activeIo = 0;
  let activeReport = "en";

  if (!data) {
    main.innerHTML = "<section class=\"section\"><div class=\"panel\"><div class=\"panel-body\">Missing run data.</div></div></section>";
    return;
  }

  const report = data.report;
  subtitle.textContent = `${report.run_id} / ${report.experiments.join(" + ")} / ${report.wording_scope.at(-2)}`;
  statusStrip.innerHTML = [
    chip("M1 ok", "ok"),
    chip("M2 ok", "ok"),
    chip(report.replay.status, "info"),
    chip("live model calls: 0", "warn")
  ].join("");

  document.querySelectorAll(".rail-item").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".rail-item").forEach((entry) => entry.classList.remove("is-active"));
      button.classList.add("is-active");
      render(button.dataset.section);
      main.focus({ preventScroll: true });
    });
  });

  function chip(label, kind = "") {
    return `<span class="chip ${kind}">${escapeHtml(label)}</span>`;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll("\"", "&quot;")
      .replaceAll("'", "&#039;");
  }

  function code(value) {
    return `<code>${escapeHtml(value)}</code>`;
  }

  function panel(title, body, meta = "") {
    return `<section class="panel">
      <div class="panel-head">
        <h2>${escapeHtml(title)}</h2>
        ${meta ? `<span class="chip alt">${escapeHtml(meta)}</span>` : ""}
      </div>
      <div class="panel-body">${body}</div>
    </section>`;
  }

  function metric(label, value, meta = "") {
    return `<div class="panel metric">
      <div class="panel-body">
        <div class="metric-value">${escapeHtml(value)}</div>
        <div class="metric-label">${escapeHtml(label)}</div>
        ${meta ? `<div class="soft mono">${escapeHtml(meta)}</div>` : ""}
      </div>
    </div>`;
  }

  function table(headers, rows) {
    return `<div class="table-wrap"><table>
      <thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody>
    </table></div>`;
  }

  function overview() {
    const direct = data.route_metrics.find((entry) => entry.route_id === "route.direct_smt");
    const single = data.route_metrics.find((entry) => entry.route_id === "route.single_ir");
    main.innerHTML = `<section class="section">
      <div class="section-head">
        <div>
          <h2>Run evidence</h2>
          <p>Research harness output over synthetic Japanese fixtures.</p>
        </div>
        ${chip("no clinical claim", "warn")}
      </div>
      <div class="grid three">
        ${metric("Findings", String(report.findings.length), report.findings[0].conflict_kind)}
        ${metric("Documented null results", String(report.null_results.length), report.null_results[0].reason)}
        ${metric("Route lift", `${direct.verdict_accuracy.exact} -> ${single.verdict_accuracy.exact}`, "verdict accuracy")}
      </div>
    </section>
    <section class="section grid two">
      ${panel("M1 finding", `<p>${code(report.findings[0].finding_id)} ${escapeHtml(report.findings[0].conflict_kind)}</p>
        <div class="quote">${escapeHtml(report.findings[0].quoted_spans[0].text)}</div>
        <div class="quote">${escapeHtml(report.findings[0].quoted_spans[2].text)}</div>`, report.findings[0].claim_tier)}
      ${panel("M1 null result", `<p>${code(report.null_results[0].null_result_id)} ${escapeHtml(report.null_results[0].reason)}</p>
        <div class="quote">${escapeHtml(report.null_results[0].quoted_spans[0].text)}</div>
        <div class="quote">${escapeHtml(report.null_results[0].quoted_spans[1].text)}</div>`, report.null_results[0].claim_tier)}
    </section>`;
  }

  function spine() {
    const steps = ["extract", "segment", "normalize", "assemble", "compile", "verify", "trace", "report"];
    const groupRows = data.groups.map((group) => [
      code(group.group_id),
      escapeHtml(group.verifier.outcome),
      escapeHtml(group.overlap.reasons.join(", ")),
      group.conflict ? chip("contradiction", "warn") : chip("null result", "info")
    ]);
    main.innerHTML = `<section class="section">
      <div class="section-head">
        <div>
          <h2>M1 spine</h2>
          <p>Fixture-scale pipeline with exact source spans and deterministic symbolic checks.</p>
        </div>
        ${chip(report.solver_identity, "info")}
      </div>
      ${panel("Pipeline", `<div class="flow">${steps.map((step, index) => `<div class="flow-step"><strong>${index + 1}. ${escapeHtml(step)}</strong><span>artifact emitted</span></div>`).join("")}</div>`)}
    </section>
    <section class="section">
      ${panel("Group verifier results", table(["Group", "Outcome", "Context result", "Report"], groupRows))}
    </section>`;
  }

  function trace() {
    const rows = data.trace_bundle.derivation_dag.edges.slice(0, 18).map((edge) => `
      <div class="trace-row">
        <div class="trace-node mono">${escapeHtml(edge.from)}</div>
        <div class="trace-op">${escapeHtml(edge.op)}</div>
        <div class="trace-node mono">${escapeHtml(edge.to)}</div>
      </div>`).join("");
    const claimRows = data.trace_bundle.claim_evidence.map((entry) => [
      code(entry.report_ref),
      escapeHtml(entry.verdict),
      escapeHtml(entry.rule_ids.join(", ")),
      escapeHtml(entry.assertion_ids.join(", ") || "none")
    ]);
    main.innerHTML = `<section class="section grid two">
      ${panel("Derivation DAG", `<div class="trace-list">${rows}</div>`, `${data.trace_bundle.derivation_dag.nodes.length} nodes`)}
      ${panel("Claim evidence index", table(["Report ref", "Verdict", "Rules", "Assertions"], claimRows))}
    </section>`;
  }

  function lift() {
    const routeRows = data.route_metrics.map((entry) => [
      code(entry.route_id),
      escapeHtml(entry.target_syntax_validity.exact),
      escapeHtml(entry.admission_rate.exact),
      escapeHtml(entry.verdict_accuracy.exact),
      escapeHtml(entry.k_sample_stability.exact)
    ]);
    const liftRows = data.lift_table.map((entry) => [
      escapeHtml(entry.metric),
      escapeHtml(entry.baseline.exact),
      escapeHtml(entry.lifted.exact),
      escapeHtml(entry.delta.exact)
    ]);
    const rawRows = data.raw_rows.map((row) => [
      code(row.route_id),
      code(row.group_id),
      escapeHtml(row.seed),
      row.syntax_valid ? chip("yes", "ok") : chip("no", "warn"),
      row.admitted ? chip("yes", "ok") : chip("no", "warn"),
      escapeHtml(row.verdict),
      row.verdict_correct ? chip("yes", "ok") : chip("no", "warn")
    ]);
    main.innerHTML = `<section class="section grid two">
      ${panel("Route metrics", table(["Route", "Syntax", "Admission", "Accuracy", "Stability"], routeRows))}
      ${panel("Lift table", table(["Metric", "direct_smt", "single_ir", "delta"], liftRows))}
    </section>
    <section class="section">${panel("Raw rows", table(["Route", "Group", "Seed", "Syntax", "Admitted", "Verdict", "Correct"], rawRows))}</section>`;
  }

  function io() {
    const records = data.model_io;
    const selected = records[activeIo] ?? records[0];
    const buttons = records.map((record, index) => `<button class="io-button ${index === activeIo ? "is-active" : ""}" data-io="${index}">
      <div class="mono">${escapeHtml(record.route_id)}</div>
      <div>${escapeHtml(record.group_id)} / seed ${escapeHtml(record.seed)}</div>
    </button>`).join("");
    main.innerHTML = `<section class="section">
      <div class="io-layout">
        <div class="select-list">${buttons}</div>
        ${panel("Recorded route I/O", `<pre>${escapeHtml(JSON.stringify(selected, null, 2))}</pre>`, selected.row.admitted ? "admitted" : "not admitted")}
      </div>
    </section>`;
    document.querySelectorAll("[data-io]").forEach((button) => {
      button.addEventListener("click", () => {
        activeIo = Number(button.dataset.io);
        io();
      });
    });
  }

  function reports() {
    const en = data.report_markdown;
    const ja = data.report_ja_markdown;
    const text = activeReport === "en" ? en : ja;
    main.innerHTML = `<section class="section">
      <div class="report-tabs">
        <button class="tab ${activeReport === "en" ? "is-active" : ""}" data-report="en">English</button>
        <button class="tab ${activeReport === "ja" ? "is-active" : ""}" data-report="ja">日本語</button>
      </div>
      ${panel(activeReport === "en" ? "report.md" : "report.ja.md", `<pre>${escapeHtml(text)}</pre>`)}
    </section>`;
    document.querySelectorAll("[data-report]").forEach((button) => {
      button.addEventListener("click", () => {
        activeReport = button.dataset.report;
        reports();
      });
    });
  }

  function artifacts() {
    const rows = data.artifacts.map((entry) => [
      code(entry.path),
      `<span class="mono">${escapeHtml(entry.sha256.slice(0, 16))}</span>`
    ]);
    main.innerHTML = `<section class="section">${panel("Replay manifest files", table(["Path", "sha256 prefix"], rows), `${data.artifacts.length} files`)}</section>`;
  }

  function render(section) {
    if (section === "spine") spine();
    else if (section === "trace") trace();
    else if (section === "lift") lift();
    else if (section === "io") io();
    else if (section === "reports") reports();
    else if (section === "artifacts") artifacts();
    else overview();
  }

  render("overview");
})();
