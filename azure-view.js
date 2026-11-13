"use strict";
const AzureView = (() => {
  const A = AzureSizing;
  const escape = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = value => typeof value === "number" ? value.toLocaleString("en-US", { maximumFractionDigits: 2 }) : value;
  const fields = [
    ["reservePercent", "Per-node CPU / memory / SAPS reserve (%)", 0, 80],
    ["headroomPercent", "Additional demand headroom (%)", 0, 200],
    ["maxPods", "Configured maxPods per node", 1, 250, 1],
    ["extraPods", "Other pods (total, excluding modelled pods)", 0, 100000, 1],
    ["workerPodSaps", "SAPS per assumed worker pod", 1, 1e9],
    ["workerPodCpu", "CPU per assumed worker pod", 0.01, 1000],
    ["workerPodMemory", "GiB per assumed worker pod", 0.01, 10000],
    ["policyPodCpu", "CPU per assumed policy pod (1,400 SAPS)", 0.01, 1000],
    ["policyPodMemory", "GiB per assumed policy pod", 0.01, 10000],
    ["platformCpu", "Other in-cluster component CPU (total)", 0, 1e6],
    ["platformMemory", "Other in-cluster component memory (GiB total)", 0, 1e6],
    ["otherSaps", "Other in-cluster SAPS (guide proxy; reconcile)", 0, 1e12],
    ["largestPlatformCpu", "Largest other pod CPU", 0.01, 1000],
    ["largestPlatformMemory", "Largest other pod memory (GiB)", 0.01, 10000],
    ["ephemeralPerNode", "Usable ephemeral storage per node (GiB)", 1, 1e6]
  ];
  const select = (key, label, options, s) => `<label for="az-${key}">${label}<select id="az-${key}" data-azure="${key}">${options.map(([value, text]) => `<option value="${value}"${s[key] === value ? " selected" : ""}>${escape(text)}</option>`).join("")}</select></label>`;
  function build(s) {
    document.getElementById("azure-controls").innerHTML = `
      <label for="az-region">Planning region (not verified)<input id="az-region" data-azure="region" value="${escape(s.region)}" maxlength="50" required></label>
      ${select("mode", "Component availability", [["nonha", "Non-HA"], ["ha", "HA (three broker pods)"]], s)}
      ${select("failure", "Infrastructure survivor model", [["none", "No node / zone loss"], ["node", "Loss of any one node"], ["zone", "Loss of largest of 3 balanced zones"]], s)}
      ${select("sku", "Node family / SKU", A.CATALOG.map(v => [v.sku, `${v.sku} - ${v.cpu} CPU / ${v.memory} GiB`]), s)}
      ${select("tier", "Solace broker tier", Object.keys(A.TIERS).map(k => [k, k]), s)}`;
    document.getElementById("azure-assumption-controls").innerHTML = fields.map(([key, label, min, max, step]) =>
      `<label for="az-${key}">${label}<input type="number" id="az-${key}" data-azure="${key}" value="${s[key]}" min="${min}" max="${max}" step="${step || "any"}" required></label>`).join("");
    document.getElementById("azure-catalog").innerHTML = A.CATALOG.map(v =>
      `<tr><td class="left">${v.sku}</td><td>${v.cpu}</td><td>${v.memory}</td><td>${fmt(v.saps)}</td><td>${v.page}</td></tr>`).join("");
  }
  function render(workbook, scenario, inputs, inputError) {
    const target = document.getElementById("azure-results");
    try {
      if (inputError) throw new Error(inputError);
      const r = A.compute(workbook, scenario, inputs);
      const s = r.scenario;
      const rows = [
        ["saps", "SAPS"], ["cpu", "CPU"], ["memory", "Memory (GiB)"], ["pods", "Pod slots"], ["ephemeral", "Ephemeral (GiB)"]
      ];
      const status = document.getElementById("azure-status");
      status.textContent = r.errors.length ? "Estimate blocked: individual pod fit or planning limit failed." : `Preliminary estimate: ${r.nodes} nodes; ${r.survivingNodes} after modelled failure. Binding aggregate constraints: ${r.bottlenecks.join(", ")}.`;
      status.className = `strip ${r.errors.length ? "warn" : "info"}`;
      target.innerHTML = `
        ${r.errors.length ? `<div class="strip warn" role="alert">${r.errors.map(escape).join("<br>")}</div>` : ""}
        <div class="card"><div class="card-header"><h2>Capacity accounting</h2><span class="hint">Workload and baseline are compared, not added</span></div>
          <div class="scroll"><table><thead><tr><th class="left">Constraint</th><th>Modelled components</th><th>Baseline floor</th><th>Demand before headroom</th><th>Usable / node</th><th>Survivor nodes needed</th><th>Normal capacity</th><th>Survivor capacity</th></tr></thead>
          <tbody>${rows.map(([key, title]) => `<tr><td class="left">${title}</td><td>${fmt(r.components[key])}</td><td>${fmt(r.floor[key] ?? 0)}</td><td>${fmt(r.demand[key])}</td><td>${fmt(r.perNode[key])}</td><td>${fmt(r.requiredBy[key])}</td><td>${r.nodes ? fmt(r.normalCapacity[key]) : "Not issued"}</td><td>${r.nodes ? fmt(r.survivorCapacity[key]) : "Not issued"}</td></tr>`).join("")}</tbody></table></div>
          <div class="card-body"><p>Workbook workload: <b>${fmt(workbook.final.worker.saps)} worker SAPS / ${fmt(workbook.final.worker.memoryGb)} GB</b>, <b>${fmt(workbook.final.policyEngine.saps)} policy SAPS / ${fmt(workbook.final.policyEngine.memoryGb)} GB</b>. Workbook GB numbers are conservatively budgeted as GiB here without changing the workbook outputs.</p>
          <p>Assumed pods: <b>${fmt(r.workerPods)} workers + ${fmt(r.policyPods)} policy + ${r.broker.pods} broker</b>, plus ${s.extraPods} other pods, compared against the ${r.floor.pods}-pod baseline. Largest assumed pod requirements: ${fmt(r.largest.saps)} workload SAPS, ${fmt(r.largest.cpu)} CPU, ${fmt(r.largest.memory)} GiB, 10 GiB ephemeral (maxima may belong to different pods).</p>
          <p>${s.reservePercent}% of gross CPU, memory and SAPS is reserved per node; ${s.headroomPercent}% headroom is applied once to each demand constraint, including pods and ephemeral storage. These are editable planning allowances, not measured AKS allocatable values. Raw VM: ${r.vm.cpu} CPU / ${r.vm.memory} GiB / ${fmt(r.vm.saps)} SAPS.</p>
          <p>Minimum ${s.mode === "ha" ? "3 surviving nodes for three assumed separate broker placements" : "1 node"}; a single-node estimate requires maxPods &gt;= 50. ${s.failure === "zone" ? "Nodes are assumed evenly distributed over three zones; survivors = N - ceil(N/3)." : s.failure === "node" ? "Survivors = N - 1." : "Survivors = N (no infrastructure loss modelled)."} Full configured aggregate demand is retained after failure; topology and broker quorum remain unverified.</p></div></div>
        <div class="card"><div class="card-header"><h2>Resource bill of materials</h2><span class="hint">Unpriced planning inventory; no deployment generated</span></div>
          ${r.errors.length ? '<div class="card-body">No BOM issued until the blocking constraints are resolved.</div>' :
            `<div class="scroll"><table><thead><tr><th class="left">Resource</th><th class="left">Quantity / status</th><th class="left">Scope and requirements</th></tr></thead><tbody>${r.bom.map(b => `<tr><td class="left">${escape(b.resource)}</td><td class="left">${escape(b.quantity)}</td><td class="left">${escape(b.detail)}</td></tr>`).join("")}</tbody></table></div>`}</div>
        <div class="card"><div class="card-header"><h2>Limitations and deployment validation</h2></div><div class="card-body"><ul class="validation-list">${r.warnings.map(w => `<li>${escape(w)}</li>`).join("")}</ul></div></div>`;
    } catch (error) {
      document.getElementById("azure-status").textContent = `Azure estimate unavailable: ${error.message}`;
      document.getElementById("azure-status").className = "strip warn";
      target.replaceChildren();
    }
  }
  return { build, render };
})();
