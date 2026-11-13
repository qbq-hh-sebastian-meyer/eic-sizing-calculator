(function (root) {
  "use strict";
  const SOURCES = {
    prerequisites: { note: "3247839", version: 96, released: "2026-11-03", pages: "1-4", url: "https://me.sap.com/notes/3247839" },
    vm: { note: "1928533", version: 199, released: "2026-11-04", pages: "4, 5, 8", url: "https://me.sap.com/notes/1928533" },
    guide: { title: "Sizing Guide for Edge Integration Cell", dated: "2026-10-13", pages: "7-8, 26" },
    azure: { checked: "2026-11-13", urls: [
      "https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/general-purpose/dsv6-series",
      "https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/memory-optimized/esv6-series",
      "https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/general-purpose/dsv5-series"
    ] }
  };
  const CATALOG_VERSION = "2026-11-04-note1928533-v199";
  const CATALOG = [
    { sku: "Standard_D4s_v6", cpu: 4, memory: 16, saps: 8211, page: 4 },
    { sku: "Standard_D8s_v6", cpu: 8, memory: 32, saps: 16423, page: 4 },
    { sku: "Standard_D16s_v6", cpu: 16, memory: 64, saps: 32846, page: 4 },
    { sku: "Standard_E4s_v6", cpu: 4, memory: 32, saps: 8211, page: 8 },
    { sku: "Standard_E8s_v6", cpu: 8, memory: 64, saps: 16423, page: 8 },
    { sku: "Standard_E16s_v6", cpu: 16, memory: 128, saps: 32846, page: 8 },
    { sku: "Standard_D8s_v5", cpu: 8, memory: 32, saps: 13621, page: 5 }
  ];
  const TIERS = {
    "100": { cpu: 2, memory: 3.4, disk: 100 },
    "250": { cpu: 2, memory: 6.5, disk: 100 },
    "1K": { cpu: 2, memory: 6.5, disk: 350 },
    "10K": { cpu: 4, memory: 13.9, disk: 350 }
  };
  const DEFAULTS = {
    region: "westeurope", mode: "nonha", failure: "none", sku: "Standard_D8s_v6", tier: "250",
    reservePercent: 15, headroomPercent: 20, maxPods: 50, extraPods: 10,
    workerPodSaps: 1400, workerPodCpu: 1, workerPodMemory: 4,
    policyPodCpu: 1, policyPodMemory: 1, platformCpu: 2, platformMemory: 8, otherSaps: 8400,
    largestPlatformCpu: 2, largestPlatformMemory: 8, ephemeralPerNode: 60
  };
  const BOUNDS = {
    reservePercent: [0, 80], headroomPercent: [0, 200], maxPods: [1, 250, true],
    extraPods: [0, 100000, true], workerPodSaps: [1, 1e9],
    workerPodCpu: [0.01, 1000], workerPodMemory: [0.01, 10000],
    policyPodCpu: [0.01, 1000], policyPodMemory: [0.01, 10000],
    platformCpu: [0, 1e6], platformMemory: [0, 1e6], otherSaps: [0, 1e12],
    largestPlatformCpu: [0.01, 1000], largestPlatformMemory: [0.01, 10000],
    ephemeralPerNode: [1, 1e6]
  };
  function scenario(raw = {}) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Azure scenario must be an object.");
    const s = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
      if (Object.hasOwn(raw, key)) s[key] = raw[key];
    }
    if (typeof s.region !== "string" || !/^[a-z0-9-]{2,50}$/.test(s.region)) throw new Error("Region must be an Azure region identifier (2-50 lowercase letters, digits or hyphens).");
    if (!["nonha", "ha"].includes(s.mode) || !["none", "node", "zone"].includes(s.failure)) throw new Error("Invalid availability or failure model.");
    if (s.mode === "nonha" && s.failure !== "none") throw new Error("Select HA before modelling node or zone loss.");
    if (!CATALOG.some(v => v.sku === s.sku)) throw new Error("VM SKU is not in the verified catalog.");
    if (typeof s.tier !== "string" || !Object.hasOwn(TIERS, s.tier)) throw new Error("Unknown Solace tier.");
    for (const [key, [min, max, integer]] of Object.entries(BOUNDS)) {
      if (typeof s[key] !== "number" || !Number.isFinite(s[key]) || s[key] < min || s[key] > max || (integer && !Number.isInteger(s[key]))) {
        throw new Error(`${key} must be ${integer ? "an integer" : "a number"} between ${min} and ${max}.`);
      }
    }
    return s;
  }
  function validateInputs(raw) {
    const arrays = [raw?.sync?.simple, raw?.sync?.complex, raw?.async];
    if (arrays.some(a => !Array.isArray(a) || a.length !== 9)) throw new Error("Throughput requires three arrays of exactly nine numbers.");
    if (arrays.some(a => a.some(v => typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 1e9))) {
      throw new Error("Throughput values must be finite numbers with magnitude no greater than 1,000,000,000.");
    }
    return { sync: { simple: [...arrays[0]], complex: [...arrays[1]] }, async: [...arrays[2]] };
  }
  function readDocument(data) {
    if (!data || typeof data !== "object") throw new Error("Expected a calculator JSON object.");
    if (data.schemaVersion !== undefined && ![1, 2].includes(data.schemaVersion)) throw new Error("Unsupported export schema version.");
    if (data.azure !== undefined && (!data.azure || typeof data.azure !== "object" || !Object.hasOwn(data.azure, "scenario"))) {
      throw new Error("Azure export must contain a scenario object.");
    }
    return { inputs: validateInputs(data.inputs ?? data), azure: scenario(data.azure === undefined ? {} : data.azure.scenario) };
  }
  function compute(results, rawScenario, inputs) {
    const s = scenario(rawScenario);
    if (inputs) {
      const i = validateInputs(inputs);
      if ([...i.sync.simple, ...i.sync.complex, ...i.async].some(v => v < 0)) throw new Error("Azure sizing requires non-negative throughput. Workbook results still retain Excel's negative-input behavior.");
    }
    const f = results?.final;
    const values = [f?.totalReqPerSec, f?.worker?.saps, f?.worker?.memoryGb, f?.policyEngine?.saps, f?.policyEngine?.memoryGb, f?.policyEngine?.diskGib];
    if (values.some(v => typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1e16)) throw new Error("Workbook results are invalid or exceed the supported Azure estimation range.");
    const ha = s.mode === "ha";
    const vm = CATALOG.find(v => v.sku === s.sku);
    const tier = TIERS[s.tier];
    const broker = { pods: ha ? 3 : 1, cpu: tier.cpu * (ha ? 3 : 1), memory: tier.memory * (ha ? 3 : 1), disk: tier.disk * (ha ? 2 : 1) + (ha ? 3 : 0) };
    const workerPods = Math.max(ha ? 2 : 1, Math.ceil(f.worker.saps / s.workerPodSaps), Math.ceil(f.worker.memoryGb / s.workerPodMemory));
    const policyPods = Math.max(ha ? 2 : 1, Math.ceil(f.policyEngine.saps / 1400), Math.ceil(f.policyEngine.memoryGb / s.policyPodMemory));
    const components = {
      saps: f.worker.saps + f.policyEngine.saps + s.otherSaps,
      cpu: workerPods * s.workerPodCpu + policyPods * s.policyPodCpu + broker.cpu + s.platformCpu,
      memory: workerPods * s.workerPodMemory + policyPods * s.policyPodMemory + broker.memory + s.platformMemory,
      pods: workerPods + policyPods + broker.pods + s.extraPods,
      ephemeral: workerPods * 10
    };
    const floor = { saps: ha ? 32846 : 16423, cpu: ha ? 20 : 10, memory: ha ? 64 : 32, pods: ha ? 90 : 40, persistent: ha ? 204 : 101 };
    const demand = Object.fromEntries(["saps", "cpu", "memory", "pods"].map(k => [k, Math.max(floor[k], components[k])]));
    demand.ephemeral = components.ephemeral;
    const factor = 1 + s.headroomPercent / 100;
    const usable = 1 - s.reservePercent / 100;
    const perNode = { saps: vm.saps * usable, cpu: vm.cpu * usable, memory: vm.memory * usable, pods: s.maxPods, ephemeral: s.ephemeralPerNode };
    const largest = {
      saps: Math.max(Math.min(f.worker.saps, s.workerPodSaps), Math.min(f.policyEngine.saps, 1400)),
      cpu: Math.max(s.workerPodCpu, s.policyPodCpu, tier.cpu, s.largestPlatformCpu),
      memory: Math.max(s.workerPodMemory, s.policyPodMemory, tier.memory, s.largestPlatformMemory),
      ephemeral: 10
    };
    const errors = [];
    for (const k of ["saps", "cpu", "memory", "ephemeral"]) {
      if (largest[k] > perNode[k]) errors.push(`An assumed individual pod needs ${largest[k]} ${k}, exceeding one node's usable ${perNode[k].toFixed(2)}. Adding nodes cannot fix this.`);
    }
    const requiredBy = Object.fromEntries(Object.keys(demand).map(k => [k, Math.ceil(demand[k] * factor / perNode[k])]));
    const requiredSurvivors = Math.max(ha ? 3 : 1, ...Object.values(requiredBy));
    const survivors = n => s.failure === "node" ? n - 1 : s.failure === "zone" ? n - Math.ceil(n / 3) : n;
    let nodes = requiredSurvivors;
    if (s.failure === "node") nodes++;
    if (s.failure === "zone") nodes = Math.ceil(requiredSurvivors * 1.5);
    if (nodes === 1 && s.maxPods < 50) nodes = 2;
    if (!Number.isSafeInteger(nodes) || nodes > 10000) errors.push("Estimate exceeds the calculator planning limit of 10,000 nodes; no node count or BOM is issued.");
    const bottlenecks = Object.keys(requiredBy).filter(k => requiredBy[k] === Math.max(...Object.values(requiredBy)));
    const warnings = [
      "Preliminary capacity estimate only: actual requests/limits, replica topology, affinity, PDBs, disk attachment limits, networking and placement must be validated.",
      `Region ${s.region}: availability, zones, quota, AKS SKU support and prices have NOT been checked.`,
      "SAPS are general SAP VM capacity references, not AKS/EIC certification or measured allocatable performance. No managed-service SAPS are assigned.",
      "Worker and policy pods are modelling assumptions, not a reconstruction of actual deployment requests. Broker values are limits, not verified requests.",
      "All pools share one aggregate budget here (system and workload combined); do not add another system pool without revising accounting.",
      "These VM sizes have no local temporary disk. The usable ephemeral budget assumes separately provisioned OS-backed storage; verify image usage and stream-cache demand.",
      `Baseline reconciliation is unresolved: max(baseline, worker SAPS + policy SAPS + ${s.otherSaps} other-component SAPS) is an app rule, not SAP-approved accounting. The default 8,400 guide proxy has an unclear composition; replace it with a cluster-only allowance excluding external DB/cache. It covers broker within this model, with no additional workbook broker SAPS or verified tier conversion.`,
      "HA uses the doubled documented floor, not the guide's additional 30%. Configured replicas and the chosen survivor model are separate from configurable headroom."
    ];
    if (s.tier === "100") warnings.push("Solace tier 100 is not recommended for production; consider tier 250 or higher.");
    if (!ha && s.failure === "none") warnings.push("Non-HA: no node or zone failure capacity is reserved.");
    if (ha && s.failure === "none") warnings.push("HA components selected, but no infrastructure failure reserve is modelled.");
    const persistent = Math.max(floor.persistent, broker.disk + f.policyEngine.diskGib);
    const normalCapacity = Object.fromEntries(Object.keys(perNode).map(k => [k, perNode[k] * nodes]));
    const survivorCapacity = Object.fromEntries(Object.keys(perNode).map(k => [k, perNode[k] * survivors(nodes)]));
    const bom = errors.length ? [] : [
      { resource: "AKS Linux amd64 node allocation", quantity: `${nodes} x ${vm.sku}`, detail: `${s.failure === "zone" ? "Balanced across 3 zones; " : ""}${survivors(nodes)} survivors modelled; combined system/workload budget. AKS Kubernetes 1.32-1.35 per source snapshot.` },
      { resource: "Node OS disks", quantity: `${nodes} x at least 128 GB`, detail: "Managed OS disks assumed for no-local-temp SKUs. SAP floor 80 GB; selected VM source specifies 128 GB base VHD. Verify AKS image constraints; prefer ephemeral OS only where supported." },
      { resource: "Solace broker block volumes", quantity: ha ? `2 x ${tier.disk} GiB + 1 x 3 GiB` : `1 x ${tier.disk} GiB`, detail: `Tier ${s.tier}; XFS, >=1,000 IOPS per disk, expansion enabled, no NFS. Broker CPU ${broker.cpu}, memory ${broker.memory.toFixed(1)} GiB across ${broker.pods} pods. Not Azure Service Bus.` },
      { resource: "Core persistent storage allowance", quantity: `${persistent} GiB minimum`, detail: `INCLUDES broker ${broker.disk} GiB and workbook policy ${f.policyEngine.diskGib} GiB; max(${floor.persistent} source floor, broker + policy). Not an additional disk or complete PVC inventory.` },
      { resource: "Prometheus / Azure Files SMB", quantity: `${f.prometheus.diskGib} GiB block + ${f.sharedStorage.diskGib} GiB RWX`, detail: "Separate optional workbook allowances (20 + 51). Shared storage: Immediate binding, expansion. Actual provisioned capacities and performance may be higher." },
      { resource: "Azure Database for PostgreSQL (external)", quantity: "SKU / storage / HA TBD", detail: "PostgreSQL 15; minimum 1 CPU / 2 GiB. PostgreSQL authentication only, no Entra tokens. Need message throughput, retention, payload and HA/backup requirements. Excluded from AKS." },
      { resource: "Azure Managed Redis (external)", quantity: "SKU / capacity / HA TBD", detail: "Minimum 1 CPU / 1 GiB. Access keys only; production enterprise clustering recommended, EIC Redis mode Standalone. Need artifact/policy counts, cache size and HA requirements. Excluded from AKS." },
      { resource: "Other infrastructure / costs", quantity: "Unpriced; not sized", detail: "AKS tier, load balancer/ingress, networking/IPs, egress, DNS/TLS, registry, secrets, monitoring, backups/DR, licenses and disk performance tiers require separate design. All BOM items unpriced." }
    ];
    return { status: errors.length ? "blocked" : "preliminary", scenario: s, catalogVersion: CATALOG_VERSION, vm, broker, workerPods, policyPods, components, floor, demand, perNode, largest, requiredBy, bottlenecks, nodes: errors.length ? null : nodes, survivingNodes: errors.length ? null : survivors(nodes), normalCapacity, survivorCapacity, persistent, errors, warnings, bom };
  }
  function exportDocument(inputs, results, azureScenario) {
    const validInputs = validateInputs(inputs);
    const s = scenario(azureScenario);
    let azureResults;
    try { azureResults = compute(results, s, validInputs); }
    catch (error) { azureResults = { status: "blocked", errors: [error.message] }; }
    return { schemaVersion: 2, tool: "EIC Sizing Calculator v3+1", exportedAt: new Date().toISOString(), inputs: validInputs, results, azure: { scenario: s, results: azureResults, catalogVersion: CATALOG_VERSION, sources: SOURCES } };
  }
  const api = { SOURCES, CATALOG_VERSION, CATALOG, TIERS, DEFAULTS, scenario, validateInputs, readDocument, compute, exportDocument };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AzureSizing = api;
})(globalThis);
