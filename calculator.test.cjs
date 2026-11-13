const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const A = require("./azure-sizing.js");
const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const engine = html.match(/<script id="eic-calc">([\s\S]*?)<\/script>/)[1];
const context = { module: { exports: {} } };
vm.runInNewContext(engine, context);
const E = context.module.exports;
const plain = value => JSON.parse(JSON.stringify(value));
const zero = () => plain(E.emptyInputs());
const estimate = (scenario = {}, inputs = zero()) => A.compute(E.compute(inputs), scenario, inputs);

test("workbook cached zero fixture and fixed allowances remain intact", () => {
  const f = E.compute(zero()).final;
  assert.equal(f.totalReqPerSec, 0);
  assert.deepEqual(plain(f.worker), { saps: 0, memoryGb: 0 });
  assert.deepEqual(plain(f.policyEngine), { saps: 0, memoryGb: 0, diskGib: 0 });
  assert.deepEqual(plain(f.messageService), { saps: 2800, memoryGb: 6.5, diskGib: 100 });
  assert.equal(f.prometheus.diskGib, 20);
  assert.equal(f.sharedStorage.diskGib, 51);
});

test("workbook synchronous 3096 / 4192 and async final-row exclusion are preserved", () => {
  const inputs = zero();
  inputs.sync.simple[6] = 1;
  inputs.sync.simple[7] = 1;
  inputs.async[8] = 1;
  const r = E.compute(inputs);
  assert.equal(r.sync.simpleSaps[6], 912);
  assert.equal(r.sync.simpleSaps[7], 1204);
  assert.equal(r.sync.worker.saps, 2800);
  assert.equal(r.async.totalCpuTime, 0);
  assert.equal(r.async.totalSaps, 1500);
  assert.equal(r.async.cpuTime[8], 1.0693);
  assert.equal(r.final.worker.saps, 4300);
  assert.equal(r.final.worker.memoryGb, 16);
});

test("mixed and fractional workbook inputs retain rounding and policy thresholds", () => {
  const inputs = zero();
  inputs.sync.simple[0] = 3;
  inputs.sync.complex[0] = 7;
  inputs.async[0] = 10;
  const r = E.compute(inputs);
  assert.equal(r.sync.totalWorkerSaps, 3004);
  assert.equal(r.async.worker.saps, 950);
  assert.deepEqual(plain(r.final.worker), { saps: 5150, memoryGb: 16 });
  assert.deepEqual(plain(r.final.policyEngine), { saps: 1400, memoryGb: 1, diskGib: 1 });
  inputs.async[0] = 10.01;
  assert.equal(E.compute(inputs).final.policyEngine.saps, 2800);
  assert.equal(E.roundUp(2.0000000000000004), 2);
  assert.equal(E.roundUp(-2.01), -3);
  inputs.sync.simple[0] = 0.1;
  assert.equal(E.compute(inputs).sync.simpleSaps[0], 12);
});

test("zero workload applies aggregate floors rather than adding them to components", () => {
  const r = estimate({ reservePercent: 0, headroomPercent: 0 });
  assert.deepEqual(r.demand, { saps: 16423, cpu: 10, memory: 32, pods: 40, ephemeral: 10 });
  assert.equal(r.nodes, 2);
  assert.equal(r.persistent, 101);
  assert.equal(r.components.saps, 8400);
  assert.equal(estimate({ otherSaps: 0 }).demand.saps, 16423);
  assert.equal(estimate({ otherSaps: 50000 }).demand.saps, 50000);
  assert.equal(r.bom.find(b => b.resource.includes("PostgreSQL")).quantity, "SKU / storage / HA TBD");
});

test("HA broker triples limits but only doubles data disks plus 3 GiB monitor", () => {
  const r = estimate({ mode: "ha", failure: "node", reservePercent: 0, headroomPercent: 0 });
  assert.deepEqual(r.broker, { pods: 3, cpu: 6, memory: 19.5, disk: 203 });
  assert.equal(r.floor.cpu, 20);
  assert.equal(r.floor.memory, 64);
  assert.equal(r.floor.saps, 32846);
  assert.equal(r.persistent, 204);
  assert.equal(r.nodes, 4);
  assert.equal(r.survivingNodes, 3);
  assert.equal(r.demand.cpu, 20); // No floor + broker double count or extra guide HA multiplier.
  const large = estimate({ mode: "ha", tier: "1K" });
  assert.equal(large.broker.disk, 703);
  assert.equal(large.persistent, 703);
  assert.equal(estimate({ tier: "10K", sku: "Standard_E8s_v6" }).broker.memory, 13.9);
});

test("node and balanced-zone loss reserve full configured aggregate demand", () => {
  for (const failure of ["none", "node", "zone"]) {
    const r = estimate({ mode: "ha", failure });
    assert.equal(r.survivingNodes, failure === "node" ? r.nodes - 1 : failure === "zone" ? r.nodes - Math.ceil(r.nodes / 3) : r.nodes);
    for (const key of Object.keys(r.demand)) assert.ok(r.survivorCapacity[key] + 1e-8 >= r.demand[key] * 1.2);
    assert.ok(r.survivingNodes >= 3);
    if (failure === "zone") assert.equal(r.nodes % 3, 0);
  }
});

test("CPU, SAPS, memory, pod slots and ephemeral can each bind independently", () => {
  const shared = { reservePercent: 0, headroomPercent: 0, maxPods: 250, ephemeralPerNode: 1000, sku: "Standard_E8s_v6" };
  assert.ok(estimate({ ...shared, platformCpu: 80 }).bottlenecks.includes("cpu"));
  assert.ok(estimate({ ...shared, platformMemory: 1000 }).bottlenecks.includes("memory"));
  assert.ok(estimate({ ...shared, extraPods: 1000, maxPods: 10 }).bottlenecks.includes("pods"));
  const raw = plain(E.compute(zero()));
  raw.final.worker.saps = 100000;
  const saps = A.compute(raw, { ...shared, workerPodSaps: 16000, workerPodCpu: 0.01, workerPodMemory: 0.01 });
  assert.ok(saps.bottlenecks.includes("saps"));
  assert.equal(saps.status, "preliminary");
  assert.equal(A.compute(raw, { ...shared, workerPodSaps: 100000 }).status, "blocked");
  raw.final.worker.saps = 14000;
  const disk = A.compute(raw, { ...shared, ephemeralPerNode: 10 });
  assert.ok(disk.bottlenecks.includes("ephemeral"));
});

test("largest pod CPU or memory exceeding usable node capacity blocks the BOM", () => {
  for (const options of [{ workerPodCpu: 8 }, { workerPodMemory: 40 }, { tier: "10K", sku: "Standard_D4s_v6" }, { ephemeralPerNode: 1 }]) {
    const r = estimate(options);
    assert.equal(r.status, "blocked");
    assert.equal(r.nodes, null);
    assert.equal(r.bom.length, 0);
    assert.match(r.errors.join(" "), /Adding nodes cannot fix/);
  }
});

test("single-node maxPods rule, reserve and headroom are applied explicitly", () => {
  const options = { sku: "Standard_D16s_v6", reservePercent: 0, headroomPercent: 0 };
  assert.equal(estimate({ ...options, maxPods: 50 }).nodes, 1);
  assert.equal(estimate({ ...options, maxPods: 49 }).nodes, 2);
  const r = estimate({ ...options, reservePercent: 25, headroomPercent: 20 });
  assert.equal(r.perNode.cpu, 12);
  assert.equal(r.requiredBy.cpu, 1);
  assert.equal(r.perNode.pods, 50);
  assert.equal(r.requiredBy.pods, 1);
  assert.equal(estimate({ ...options, headroomPercent: 100 }).requiredBy.cpu, 2);
});

test("invalid, blank, nonfinite, incompatible and huge scenarios do not become plausible estimates", () => {
  for (const options of [{ headroomPercent: null }, { maxPods: 1.5 }, { reservePercent: 100 }, { sku: "arm" }, { tier: "__proto__" }, { workerPodSaps: 0 }, { ephemeralPerNode: "" }, { platformCpu: Infinity }, { region: "<img>" }, { mode: "nonha", failure: "node" }]) {
    assert.throws(() => estimate(options));
  }
  const inputs = zero();
  inputs.async[0] = -1;
  assert.throws(() => estimate({}, inputs), /non-negative/);
  assert.equal(E.compute(inputs).final.totalReqPerSec, -1);
  inputs.async[0] = 1e9;
  const huge = estimate({}, inputs);
  assert.equal(huge.status, "blocked");
  assert.equal(huge.nodes, null);
  assert.match(huge.errors.join(" "), /10,000/);
  inputs.async[0] = 1e10;
  assert.throws(() => estimate({}, inputs), /1,000,000,000/);
});

test("legacy exports and raw persisted inputs import; new exports round-trip scenario and source metadata", () => {
  const inputs = zero();
  inputs.sync.simple[0] = 10;
  for (const legacy of [inputs, { tool: "EIC Sizing Calculator v3+1", inputs, results: {} }]) {
    const imported = A.readDocument(legacy);
    assert.deepEqual(imported.inputs, inputs);
    assert.equal(imported.azure.sku, A.DEFAULTS.sku);
  }
  const s = { ...A.DEFAULTS, mode: "ha", failure: "zone", region: "eastus", tier: "1K" };
  const exported = A.exportDocument(inputs, E.compute(inputs), s);
  const imported = A.readDocument(JSON.parse(JSON.stringify(exported)));
  assert.deepEqual(imported, { inputs, azure: s });
  assert.equal(exported.azure.sources.vm.version, 199);
  assert.equal(exported.azure.sources.prerequisites.version, 96);
  assert.equal(exported.azure.catalogVersion, A.CATALOG_VERSION);
  assert.equal(exported.results.final.totalReqPerSec, 10);
  exported.azure.results.nodes = 9999;
  assert.notEqual(estimate(imported.azure, imported.inputs).nodes, 9999);
  imported.inputs.sync.simple[0] = 999;
  assert.equal(inputs.sync.simple[0], 10);
});

test("malformed imports reject atomically instead of replacing missing or invalid values with zeros", () => {
  const inputs = zero();
  for (const data of [{}, { inputs: {} }, { inputs, schemaVersion: 999 }, { inputs, azure: null }, { inputs, azure: { scenario: null } }, { inputs: { ...inputs, async: [0] } }, { inputs: { ...inputs, async: Array(9).fill("1") } }]) {
    assert.throws(() => A.readDocument(data));
    assert.equal(inputs.async[0], 0);
  }
  const negative = zero();
  negative.async[8] = -1;
  const document = A.exportDocument(negative, E.compute(negative), {});
  assert.equal(document.azure.results.status, "blocked");
  assert.equal(document.inputs.async[8], -1);
});

test("mapping and export never mutate workbook results or throughput inputs", () => {
  const inputs = zero();
  inputs.sync.complex[8] = 10;
  const results = E.compute(inputs);
  const before = JSON.stringify({ inputs, results });
  A.compute(results, { mode: "ha", tier: "1K", failure: "zone" }, inputs);
  A.exportDocument(inputs, results, {});
  assert.equal(JSON.stringify({ inputs, results }), before);
});
