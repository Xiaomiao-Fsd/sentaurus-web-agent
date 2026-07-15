import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const parserPath = path.join(repoRoot, "apps/server/remote/dfise_idvg_extract.py");
const goldenInputDir = path.join(repoRoot, "apps/server/data/runs/run_20260626163724_rDsE4Q/input");
const lowPath = path.join(goldenInputDir, "idvg_low.plt");
const highPath = path.join(goldenInputDir, "idvg_high.plt");

function runExtractor(expectedHighVd = 0.8) {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "dfise-idvg-test-"));
  const outputPrefix = path.join(outputDir, "idvg_step0005");
  const result = spawnSync("python", [
    parserPath,
    "--low", lowPath,
    "--high", highPath,
    "--expected-low-vd", "0.05",
    "--expected-high-vd", String(expectedHighVd),
    "--output-prefix", outputPrefix,
    "--stdout-json"
  ], { encoding: "utf8" });
  const stdoutLine = result.stdout.trim().split(/\r?\n/).at(-1) || "{}";
  return {
    result,
    payload: JSON.parse(stdoutLine) as Record<string, any>,
    outputDir,
    outputPrefix
  };
}

function writeDfise(filePath: string, datasets: string[] | null, blocks: number[][][], functions: string[] | null = null): void {
  const datasetLine = datasets ? `datasets = [ ${datasets.map((name) => JSON.stringify(name)).join(" ")} ]\n` : "";
  const functionLine = functions ? `functions = [ ${functions.join(" ")} ]\n` : "";
  const dataBlocks = blocks.map((rows) => `Data {\n${rows.map((row) => row.map((value) => value.toExponential(12)).join(" ")).join("\n")}\n}`).join("\n");
  fs.writeFileSync(filePath, `Info {\n${datasetLine}${functionLine}}\n${dataBlocks}\n`, "utf8");
}

function syntheticRows(vd: number, order = ["gate OuterVoltage", "drain OuterVoltage", "drain TotalCurrent"]): number[][] {
  const points = [
    [0.0, 1e-12],
    [0.1, 1e-11],
    [0.2, 1e-10],
    [0.3, 1e-9],
    [0.4, 1e-8],
    [0.5, 1e-7],
    [0.6, 1e-6],
    [0.7, 1e-5]
  ];
  return points.map(([vg, current]) => {
    const values: Record<string, number> = {
      "gate OuterVoltage": vg,
      "drain OuterVoltage": vd,
      "drain TotalCurrent": current
    };
    return order.map((name) => values[name]);
  });
}

function runSynthetic(lowPathname: string, highPathname: string, outputDir: string, extraArgs: string[] = []) {
  const result = spawnSync("python", [
    parserPath,
    "--low", lowPathname,
    "--high", highPathname,
    "--expected-low-vd", "0.05",
    "--expected-high-vd", "0.8",
    "--min-points", "8",
    "--output-prefix", path.join(outputDir, "idvg_synthetic"),
    "--stdout-json",
    ...extraArgs
  ], { encoding: "utf8" });
  return {
    result,
    payload: JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) || "{}") as Record<string, any>
  };
}

test("tcad-idvg-v1 reproduces the 28nm golden metrics", () => {
  const { result, payload, outputDir, outputPrefix } = runExtractor();
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(payload.status, "ok");
    assert.equal(payload.metricProfile, "tcad-idvg-v1");
    assert.equal(payload.extractorVersion, "dfise-idvg-extract/1");
    assert.deepEqual(payload.units, {
      gateVoltage: "V",
      drainVoltage: "V",
      drainCurrent: "A/um",
      vth: "V",
      ss: "mV/dec",
      dibl: "mV/V"
    });
    assert.equal(payload.inputs.low.columnResolution, "dataset-name");
    assert.equal(payload.inputs.low.datasetCount, 33);
    assert.equal(payload.inputs.high.datasetCount, 33);
    assert.equal(payload.inputs.low.validPointCount, 108);
    assert.equal(payload.inputs.high.validPointCount, 109);
    assert.ok(Math.abs(payload.inputs.low.actualVd - 0.05) <= 1e-12);
    assert.ok(Math.abs(payload.inputs.high.actualVd - 0.8) <= 1e-12);
    assert.ok(Math.abs(payload.metrics.vthLowV - 0.1783295491) <= 1e-6);
    assert.ok(Math.abs(payload.metrics.vthHighV - 0.1499588910) <= 1e-6);
    assert.ok(Math.abs(payload.metrics.ssLowMvPerDec - 71.56688061) <= 0.01);
    assert.ok(Math.abs(payload.metrics.ssHighMvPerDec - 74.78974888) <= 0.01);
    assert.ok(Math.abs(payload.metrics.diblMvPerV - 37.82754417) <= 0.01);

    const metricsPrefix = path.join(path.dirname(outputPrefix), path.basename(outputPrefix).replace("idvg", "ss_dibl"));
    const outputFiles = [
      `${outputPrefix}_extracted.csv`,
      `${metricsPrefix}_metrics.json`,
      `${metricsPrefix}_metrics.dat`,
      `${metricsPrefix}_report.txt`,
      `${outputPrefix}_plot.png`
    ];
    for (const file of outputFiles) {
      assert.ok(fs.statSync(file).size > 0, `${file} should be non-empty`);
    }
    assert.match(fs.readFileSync(`${outputPrefix}_extracted.csv`, "utf8").split(/\r?\n/, 1)[0], /^Vg_V,Id_low_A_per_um,Id_high_A_per_um,Vd_low_V,Vd_high_V$/);
    assert.deepEqual(fs.readFileSync(`${outputPrefix}_plot.png`).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test("tcad-idvg-v1 rejects expected 1.05V when the real high curve is 0.80V", () => {
  const { result, payload, outputDir } = runExtractor(1.05);
  try {
    assert.equal(result.status, 3);
    assert.equal(payload.status, "invalid-input");
    assert.equal(payload.error.code, "BIAS_MISMATCH");
    assert.equal(payload.error.details.expectedVd, 1.05);
    assert.equal(payload.error.details.actualVd, 0.8);
    assert.equal(payload.metrics, undefined);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test("parser normalizes Fortran D exponents", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dfise-d-exp-"));
  try {
    const source = fs.readFileSync(lowPath, "utf8").replace(/E([+-]\d+)/g, "D$1");
    const dPath = path.join(tempDir, "low-d.plt");
    fs.writeFileSync(dPath, source, "utf8");
    const prefix = path.join(tempDir, "idvg_d");
    const output = execFileSync("python", [
      parserPath,
      "--low", dPath,
      "--high", highPath,
      "--expected-low-vd", "0.05",
      "--expected-high-vd", "0.8",
      "--output-prefix", prefix
    ], { encoding: "utf8" });
    const payload = JSON.parse(output.trim().split(/\r?\n/).at(-1) || "{}");
    assert.equal(payload.status, "ok");
    assert.ok(Math.abs(payload.metrics.vthLowV - 0.1783295491) <= 1e-6);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("parser resolves reordered datasets by name", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dfise-reordered-"));
  try {
    const order = ["drain TotalCurrent", "gate OuterVoltage", "drain OuterVoltage"];
    const low = path.join(tempDir, "low.plt");
    const high = path.join(tempDir, "high.plt");
    writeDfise(low, order, [syntheticRows(0.05, order)]);
    writeDfise(high, order, [syntheticRows(0.8, order)]);
    const { result, payload } = runSynthetic(low, high, tempDir);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(payload.status, "ok");
    assert.equal(payload.inputs.low.actualVd, 0.05);
    assert.equal(payload.inputs.high.actualVd, 0.8);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("two-point SS and an independent DIBL current use log-current interpolation", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dfise-two-point-"));
  try {
    const datasets = ["gate OuterVoltage", "drain OuterVoltage", "drain TotalCurrent"];
    const low = path.join(tempDir, "low.plt");
    const high = path.join(tempDir, "high.plt");
    writeDfise(low, datasets, [syntheticRows(0.05)]);
    writeDfise(high, datasets, [syntheticRows(0.8).map(([vg, vd, current]) => [vg, vd, current * 10])]);
    const { result, payload } = runSynthetic(low, high, tempDir, [
      "--ss-method", "two-point-log-interpolation-v1",
      "--ss-current-min", "1e-9",
      "--ss-current-max", "1e-8",
      "--vth-current", "1e-6",
      "--dibl-current", "1e-7"
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(payload.methods.ss, "two-point-log-interpolation-v1");
    assert.equal(payload.parameters.diblCurrentAperUm, 1e-7);
    assert.equal(payload.parameters.vthCurrentAperUm, 1e-6);
    assert.ok(Math.abs(payload.metrics.ssLowMvPerDec - 100) <= 1e-9);
    assert.ok(Math.abs(payload.metrics.ssHighMvPerDec - 100) <= 1e-9);
    assert.ok(Math.abs(payload.metrics.vgLowAtSsMinV - 0.3) <= 1e-12);
    assert.ok(Math.abs(payload.metrics.vgLowAtSsMaxV - 0.4) <= 1e-12);
    assert.ok(Math.abs(payload.metrics.vgLowAtDiblCurrentV - 0.5) <= 1e-12);
    assert.ok(Math.abs(payload.metrics.vgHighAtDiblCurrentV - 0.4) <= 1e-12);
    assert.ok(Math.abs(payload.metrics.diblMvPerV - (100 / 0.75)) <= 1e-9);
    assert.match(fs.readFileSync(payload.outputs.report, "utf8"), /SS_method=two-point-log-interpolation-v1/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("parser uses controlled 33-column fallback with a warning", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dfise-fallback-"));
  try {
    const fallbackRows = (vd: number) => syntheticRows(vd).map(([vg, , current]) => {
      const row = Array.from({ length: 33 }, () => 0);
      row[9] = vg;
      row[25] = vd;
      row[31] = current;
      return row;
    });
    const low = path.join(tempDir, "low.plt");
    const high = path.join(tempDir, "high.plt");
    const terminalFunctions = [
      "OuterVoltage", "InnerVoltage", "QuasiFermiPotential", "DisplacementCurrent",
      "eCurrent", "hCurrent", "TotalCurrent", "Charge"
    ];
    const functions = ["Time", ...terminalFunctions, ...terminalFunctions, ...terminalFunctions, ...terminalFunctions];
    writeDfise(low, null, [fallbackRows(0.05)], functions);
    writeDfise(high, null, [fallbackRows(0.8)], functions);
    const { result, payload } = runSynthetic(low, high, tempDir);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(payload.inputs.low.columnResolution, "function-signature-fallback");
    assert.match(payload.warnings.join("\n"), /function-signature fallback/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("parser rejects unsigned 33-column fallback data", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dfise-unsigned-fallback-"));
  try {
    const fallbackRows = (vd: number) => syntheticRows(vd).map(([vg, , current]) => {
      const row = Array.from({ length: 33 }, () => 0);
      row[9] = vg;
      row[25] = vd;
      row[31] = current;
      return row;
    });
    const low = path.join(tempDir, "low.plt");
    const high = path.join(tempDir, "high.plt");
    writeDfise(low, null, [fallbackRows(0.05)]);
    writeDfise(high, null, [fallbackRows(0.8)]);
    const { result, payload } = runSynthetic(low, high, tempDir);
    assert.equal(result.status, 3);
    assert.equal(payload.status, "invalid-input");
    assert.equal(payload.error.code, "DATASET_NOT_FOUND");
    assert.equal(payload.error.details.fallbackSignatureValid, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("parser rejects malformed Data block widths", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dfise-malformed-"));
  try {
    const datasets = ["gate OuterVoltage", "drain OuterVoltage", "drain TotalCurrent"];
    const low = path.join(tempDir, "low.plt");
    const high = path.join(tempDir, "high.plt");
    writeDfise(low, datasets, [[[0, 0.05, 1e-12, 99]]]);
    writeDfise(high, datasets, [syntheticRows(0.8)]);
    const { result, payload } = runSynthetic(low, high, tempDir);
    assert.notEqual(result.status, 0);
    assert.equal(payload.status, "invalid-input");
    assert.equal(payload.error.code, "MALFORMED_DATA_BLOCK");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("parser keeps maximum absolute current for duplicate Vg", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dfise-duplicate-"));
  try {
    const datasets = ["gate OuterVoltage", "drain OuterVoltage", "drain TotalCurrent"];
    const lowRows = syntheticRows(0.05);
    lowRows.splice(4, 0, [0.3, 0.05, -5e-9]);
    const low = path.join(tempDir, "low.plt");
    const high = path.join(tempDir, "high.plt");
    writeDfise(low, datasets, [lowRows]);
    writeDfise(high, datasets, [syntheticRows(0.8)]);
    const { result, payload } = runSynthetic(low, high, tempDir);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(payload.inputs.low.duplicateCount, 1);
    const csv = fs.readFileSync(payload.outputs.csv, "utf8");
    assert.match(csv, /^0\.3,5e-09,/m);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("parser reports Vth and SS coverage failures without extrapolation", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dfise-coverage-"));
  try {
    const datasets = ["gate OuterVoltage", "drain OuterVoltage", "drain TotalCurrent"];
    const high = path.join(tempDir, "high.plt");
    writeDfise(high, datasets, [syntheticRows(0.8)]);

    const noVth = path.join(tempDir, "no-vth.plt");
    writeDfise(noVth, datasets, [syntheticRows(0.05).map(([vg, vd], index) => [vg, vd, 1e-14 * (index + 1)])]);
    const vthFailure = runSynthetic(noVth, high, path.join(tempDir, "vth"));
    assert.equal(vthFailure.payload.status, "incomplete");
    assert.equal(vthFailure.payload.error.code, "VTH_NOT_COVERED");

    const noSs = path.join(tempDir, "no-ss.plt");
    const sparseCurrents = [1e-14, 2e-14, 3e-14, 4e-14, 5e-14, 1e-8, 1e-6, 1e-5];
    writeDfise(noSs, datasets, [syntheticRows(0.05).map(([vg, vd], index) => [vg, vd, sparseCurrents[index]])]);
    const ssFailure = runSynthetic(noSs, high, path.join(tempDir, "ss"));
    assert.equal(ssFailure.payload.status, "incomplete");
    assert.equal(ssFailure.payload.error.code, "SS_WINDOW_NOT_COVERED");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("parser selects the valid Data block with the most usable points", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dfise-blocks-"));
  try {
    const datasets = ["gate OuterVoltage", "drain OuterVoltage", "drain TotalCurrent"];
    const low = path.join(tempDir, "low.plt");
    const high = path.join(tempDir, "high.plt");
    writeDfise(low, datasets, [syntheticRows(0.05).slice(0, 3), syntheticRows(0.05)]);
    writeDfise(high, datasets, [syntheticRows(0.8).slice(0, 4), syntheticRows(0.8)]);
    const { result, payload } = runSynthetic(low, high, tempDir);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(payload.inputs.low.selectedDataBlock, 1);
    assert.equal(payload.inputs.high.selectedDataBlock, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("parser rejects invalid numeric boundaries as invalid-input", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dfise-invalid-args-"));
  try {
    const result = spawnSync("python", [
      parserPath,
      "--low", lowPath,
      "--high", highPath,
      "--bias-tolerance", "0",
      "--output-prefix", path.join(tempDir, "idvg_invalid"),
      "--stdout-json"
    ], { encoding: "utf8" });
    const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) || "{}");
    assert.equal(result.status, 2);
    assert.equal(payload.status, "invalid-input");
    assert.equal(payload.error.code, "INVALID_ARGUMENT");
    assert.match(payload.error.message, /bias-tolerance/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("parser classifies unsupported profiles and internal failures distinctly", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dfise-status-"));
  try {
    const unsupported = spawnSync("python", [
      parserPath,
      "--low", lowPath,
      "--high", highPath,
      "--metric-profile", "arbitrary-script-v1",
      "--output-prefix", path.join(tempDir, "idvg_unsupported"),
      "--stdout-json"
    ], { encoding: "utf8" });
    const unsupportedPayload = JSON.parse(unsupported.stdout.trim().split(/\r?\n/).at(-1) || "{}");
    assert.equal(unsupported.status, 2);
    assert.equal(unsupportedPayload.status, "invalid-input");
    assert.equal(unsupportedPayload.error.code, "UNSUPPORTED_METRIC_PROFILE");

    const missingDirectory = spawnSync("python", [
      parserPath,
      "--low", lowPath,
      "--high", highPath,
      "--output-prefix", path.join(tempDir, "missing", "idvg_internal"),
      "--stdout-json"
    ], { encoding: "utf8" });
    const missingPayload = JSON.parse(missingDirectory.stdout.trim().split(/\r?\n/).at(-1) || "{}");
    assert.equal(missingDirectory.status, 4);
    assert.equal(missingPayload.status, "failed");
    assert.equal(missingPayload.error.code, "EXTRACTOR_INTERNAL_ERROR");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
