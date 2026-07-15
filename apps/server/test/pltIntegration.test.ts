import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { VM_SESSION_INPUT_CATEGORY, VM_SESSION_OUTPUT_CATEGORIES } from "@sentaurus-agent/shared";
import Fastify from "fastify";
import { vmAgentRoutes } from "../src/routes/vmAgent.js";
import { remoteAgentScript } from "../src/services/vmAgent.js";
import {
  executeSshCommandWithInputDownload,
  scheduleSsh,
  type SshLocalCommandRunner,
} from "../src/services/sshClient.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const goldenInputDir = path.join(repoRoot, "apps/server/data/runs/run_20260626163724_rDsE4Q/input");

function generatedRemoteSources(): { control: string; worker: string } {
  const control = remoteAgentScript({ operation: "status" });
  const match = control.match(/WORKER_SOURCE_B64 = "([A-Za-z0-9+/=]+)"/);
  assert.ok(match, "generated control script should contain embedded worker source");
  return {
    control,
    worker: Buffer.from(match[1], "base64").toString("utf8")
  };
}

function runWorkerAction(action: Record<string, unknown>, prepare?: (tempDir: string) => void): any {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "plt-worker-test-"));
  try {
    const { worker } = generatedRemoteSources();
    const workerPath = path.join(tempDir, "worker.py");
    const actionPath = path.join(tempDir, "action.json");
    const harnessPath = path.join(tempDir, "harness.py");
    fs.writeFileSync(workerPath, worker, "utf8");
    fs.writeFileSync(actionPath, JSON.stringify(action), "utf8");
    fs.writeFileSync(harnessPath, [
      "from __future__ import print_function",
      "import json",
      "import sys",
      "worker_path = sys.argv[1]",
      "action_path = sys.argv[2]",
      "namespace = {'__name__': 'worker_test', '__file__': worker_path}",
      "with open(worker_path, 'rb') as handle:",
      "    source = handle.read()",
      "exec(compile(source, worker_path, 'exec'), namespace)",
      "with open(action_path, 'r') as handle:",
      "    action = json.load(handle)",
      "kind = action.get('kind')",
      "if kind == 'normalize':",
      "    try:",
      "        value = namespace['normalize_dfise_postprocess'](action.get('spec'))",
      "        result = {'ok': True, 'value': value}",
      "    except Exception as exc:",
      "        result = {'ok': False, 'errorType': exc.__class__.__name__, 'error': str(exc)}",
      "elif kind == 'semantic':",
      "    namespace['DFISE_EXTRACTOR_PATH'] = action.get('extractorPath')",
      "    namespace['DFISE_EXTRACTOR_SHA256'] = action.get('extractorSha256')",
      "    result = namespace['run_dfise_postprocess'](action.get('runDir'), '', action.get('spec'), 1)",
      "elif kind == 'attachments':",
      "    result = namespace['display_attachments_for_artifacts']('run_test', action.get('artifacts'))",
      "else:",
      "    raise ValueError('unknown action')",
      "print(json.dumps(result, ensure_ascii=True, sort_keys=True))"
    ].join("\n"), "utf8");
    prepare?.(tempDir);
    const result = spawnSync("python", [harnessPath, workerPath, actionPath], {
      encoding: "utf8",
      env: { ...process.env, HOME: tempDir, USERPROFILE: tempDir }
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) || "{}");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function okResult() {
  return { ok: true, stdout: "{}", stderr: "" };
}

test("typed postprocess rejects arbitrary parser or script fields", () => {
  const result = runWorkerAction({
    kind: "normalize",
    spec: {
      kind: "dfise-idvg-v1",
      lowInput: "idvg_low.plt",
      highInput: "idvg_high.plt",
      outputPrefix: "idvg_test",
      script: "import os; os.system('arbitrary')"
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorType, "ValueError");
  assert.match(result.error, /unsupported field/);
});

test("typed postprocess preserves two-point SS and an independent DIBL current", () => {
  const result = runWorkerAction({
    kind: "normalize",
    spec: {
      kind: "dfise-idvg-v1",
      lowInput: "idvg_low.plt",
      highInput: "idvg_high.plt",
      ssMethod: "two-point-log-interpolation-v1",
      ssCurrentMinAperUm: 1e-9,
      ssCurrentMaxAperUm: 1e-8,
      vthCurrentAperUm: 1e-6,
      diblCurrentAperUm: 1e-7,
      outputPrefix: "idvg_custom"
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.ssMethod, "two-point-log-interpolation-v1");
  assert.equal(result.value.ssCurrentMinAperUm, 1e-9);
  assert.equal(result.value.ssCurrentMaxAperUm, 1e-8);
  assert.equal(result.value.vthCurrentAperUm, 1e-6);
  assert.equal(result.value.diblCurrentAperUm, 1e-7);
});

test("runner rejects exit-zero payloads whose declared outputs are missing", () => {
  const action: Record<string, unknown> = {};
  const result = runWorkerAction(action, (tempDir) => {
    const runDir = path.join(tempDir, "run");
    fs.mkdirSync(path.join(runDir, "artifacts"), { recursive: true });
    fs.copyFileSync(path.join(goldenInputDir, "idvg_low.plt"), path.join(runDir, "idvg_low.plt"));
    fs.copyFileSync(path.join(goldenInputDir, "idvg_high.plt"), path.join(runDir, "idvg_high.plt"));
    const extractorPath = path.join(tempDir, "fake_extractor.py");
    fs.writeFileSync(extractorPath, [
      "from __future__ import print_function",
      "import hashlib",
      "import json",
      "import sys",
      "if '--version' in sys.argv:",
      "    print('dfise-idvg-extract/1')",
      "    sys.exit(0)",
      "def arg(name):",
      "    return sys.argv[sys.argv.index(name) + 1]",
      "def digest(path):",
      "    value = hashlib.sha256()",
      "    with open(path, 'rb') as handle:",
      "        value.update(handle.read())",
      "    return value.hexdigest()",
      "low = arg('--low')",
      "high = arg('--high')",
      "prefix = arg('--output-prefix')",
      "payload = {",
      "    'status': 'ok',",
      "    'metricProfile': 'tcad-idvg-v1',",
      "    'extractorVersion': 'dfise-idvg-extract/1',",
      "    'methods': {'ss': 'max-adjacent-slope-v1'},",
      "    'inputs': {",
      "        'low': {'sha256': digest(low), 'actualVd': 0.05, 'validPointCount': 20},",
      "        'high': {'sha256': digest(high), 'actualVd': 0.8, 'validPointCount': 20},",
      "    },",
      "    'metrics': {'vthLowV': 0.2, 'vthHighV': 0.1, 'ssLowMvPerDec': 70.0, 'ssHighMvPerDec': 75.0, 'diblMvPerV': 133.333333333, 'vgLowAtDiblCurrentV': 0.2, 'vgHighAtDiblCurrentV': 0.1, 'ssLowWindowPointCount': 7, 'ssHighWindowPointCount': 7, 'ssLowAdjacentPairCount': 6, 'ssHighAdjacentPairCount': 6},",
      "    'outputs': {",
      "        'csv': prefix + '_extracted.csv',",
      "        'metricsJson': prefix + '_metrics.json',",
      "        'metricsDat': prefix + '_metrics.dat',",
      "        'report': prefix + '_report.txt',",
      "        'plot': prefix + '_plot.png',",
      "    },",
      "}",
      "print(json.dumps(payload, sort_keys=True))"
    ].join("\n"), "utf8");
    Object.assign(action, {
      kind: "semantic",
      runDir,
      extractorPath,
      extractorSha256: createHash("sha256").update(fs.readFileSync(extractorPath)).digest("hex"),
      spec: {
        kind: "dfise-idvg-v1",
        lowInput: "idvg_low.plt",
        highInput: "idvg_high.plt",
        expectedLowVd: 0.05,
        expectedHighVd: 0.8,
        minimumPointCount: 20,
        outputPrefix: "idvg_test"
      }
    });
    fs.writeFileSync(path.join(tempDir, "action.json"), JSON.stringify(action), "utf8");
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "OUTPUT_MISSING");
});

test("runner maps sparse finite SS support to structured incomplete", () => {
  const action: Record<string, unknown> = {};
  const result = runWorkerAction(action, (tempDir) => {
    const runDir = path.join(tempDir, "run");
    fs.mkdirSync(path.join(runDir, "artifacts"), { recursive: true });
    fs.copyFileSync(path.join(goldenInputDir, "idvg_low.plt"), path.join(runDir, "idvg_low.plt"));
    fs.copyFileSync(path.join(goldenInputDir, "idvg_high.plt"), path.join(runDir, "idvg_high.plt"));
    const extractorPath = path.join(tempDir, "fake_sparse_ss_extractor.py");
    fs.writeFileSync(extractorPath, [
      "from __future__ import print_function",
      "import hashlib",
      "import json",
      "import sys",
      "if '--version' in sys.argv:",
      "    print('dfise-idvg-extract/1')",
      "    sys.exit(0)",
      "def arg(name):",
      "    return sys.argv[sys.argv.index(name) + 1]",
      "def digest(path):",
      "    value = hashlib.sha256()",
      "    with open(path, 'rb') as handle:",
      "        value.update(handle.read())",
      "    return value.hexdigest()",
      "low = arg('--low')",
      "high = arg('--high')",
      "prefix = arg('--output-prefix')",
      "payload = {",
      "    'status': 'ok',",
      "    'metricProfile': 'tcad-idvg-v1',",
      "    'extractorVersion': 'dfise-idvg-extract/1',",
      "    'methods': {'ss': 'max-adjacent-slope-v1'},",
      "    'inputs': {",
      "        'low': {'sha256': digest(low), 'actualVd': 0.05, 'validPointCount': 20},",
      "        'high': {'sha256': digest(high), 'actualVd': 0.8, 'validPointCount': 20},",
      "    },",
      "    'metrics': {'vthLowV': 0.2, 'vthHighV': 0.1, 'ssLowMvPerDec': 70.0, 'ssHighMvPerDec': 94.0, 'diblMvPerV': 133.333333333, 'vgLowAtDiblCurrentV': 0.2, 'vgHighAtDiblCurrentV': 0.1, 'ssLowWindowPointCount': 23, 'ssHighWindowPointCount': 4, 'ssLowAdjacentPairCount': 22, 'ssHighAdjacentPairCount': 3},",
      "    'outputs': {",
      "        'csv': prefix + '_extracted.csv',",
      "        'metricsJson': prefix + '_metrics.json',",
      "        'metricsDat': prefix + '_metrics.dat',",
      "        'report': prefix + '_report.txt',",
      "        'plot': prefix + '_plot.png',",
      "    },",
      "}",
      "print(json.dumps(payload, sort_keys=True))"
    ].join("\n"), "utf8");
    Object.assign(action, {
      kind: "semantic",
      runDir,
      extractorPath,
      extractorSha256: createHash("sha256").update(fs.readFileSync(extractorPath)).digest("hex"),
      spec: {
        kind: "dfise-idvg-v1",
        lowInput: "idvg_low.plt",
        highInput: "idvg_high.plt",
        expectedLowVd: 0.05,
        expectedHighVd: 0.8,
        minimumPointCount: 20,
        outputPrefix: "idvg_test"
      }
    });
    fs.writeFileSync(path.join(tempDir, "action.json"), JSON.stringify(action), "utf8");
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.status, "incomplete");
  assert.equal(result.errorCode, "SS_WINDOW_NOT_COVERED");
  assert.equal(result.metrics.ssHighWindowPointCount, 4);
  assert.equal(result.metrics.ssHighAdjacentPairCount, 3);
});

test("capability and fixed worker context persist together", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "plt-capability-test-"));
  try {
    const { control } = generatedRemoteSources();
    const dispatchMarker = "\ntry:\n    emit_payload(handle(load_json_b64(REQUEST_B64)))";
    const dispatchIndex = control.lastIndexOf(dispatchMarker);
    assert.ok(dispatchIndex > 0, "control script dispatch marker should exist");
    const harnessPath = path.join(tempDir, "control_harness.py");
    fs.writeFileSync(harnessPath, `${control.slice(0, dispatchIndex)}\nwrite_worker_files()\n`, "utf8");
    const execution = spawnSync("python", [harnessPath], {
      encoding: "utf8",
      env: { ...process.env, HOME: tempDir, USERPROFILE: tempDir }
    });
    assert.equal(execution.status, 0, execution.stderr || execution.stdout);
    const root = path.join(tempDir, ".sentaurus-web-agent", "vm-agent");
    const capabilityPath = path.join(root, "capabilities", "dfise-plt-postprocess-v1.json");
    const workerPath = path.join(root, "agent_worker.py");
    const extractorPath = path.join(root, "dfise_idvg_extract.py");
    const capability = JSON.parse(fs.readFileSync(capabilityPath, "utf8"));
    const worker = fs.readFileSync(workerPath, "utf8");
    assert.equal(capability.ruleId, "dfise-plt-postprocess-v1");
    assert.equal(capability.extractorVersion, "dfise-idvg-extract/1");
    assert.equal(capability.metricProfile, "tcad-idvg-v1");
    assert.equal(capability.extractorSha256, createHash("sha256").update(fs.readFileSync(extractorPath)).digest("hex"));
    assert.match(worker, /Capability rule dfise-plt-postprocess-v1/);
    assert.match(worker, /do not generate Inspect cv_\* extraction or dynamic Tcl\/Python parsers/i);
    assert.match(worker, /user_text = unicode_text\(user_text, 1000000\)/);
    assert.match(worker, /system = unicode_text\(system, 1000000\)/);
    assert.equal((worker.match(/json\.dumps\((?:payload|request_payload), ensure_ascii=True\)/g) || []).length, 2);
    assert.match(worker, /unicode_text\(recent_session_context, 400000\)/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("artifact attachments keep general files separate from image previews", () => {
  const result = runWorkerAction({
    kind: "attachments",
    artifacts: [
      { path: "artifacts/result.csv", size: 10 },
      { path: "artifacts/result.plt", size: 20 },
      { path: "artifacts/plot.png", size: 30 }
    ]
  });
  assert.deepEqual(result.map((item: Record<string, unknown>) => [item.name, item.kind]), [
    ["plot.png", "image"],
    ["result.csv", "file"],
    ["result.plt", "file"]
  ]);
});

test("SCP artifact download retries once and verifies size and SHA-256", async () => {
  const remotePath = "/tmp/sentaurus-web-artifact-123456789012-abcdef123456";
  const content = Buffer.from("reliable artifact payload", "utf8");
  const metadata = {
    ok: true,
    path: "idvg_low.plt",
    fileName: "idvg_low.plt",
    size: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
  let downloadAttempts = 0;
  let cleanupCommand = "";
  const runner: SshLocalCommandRunner = async (command, args) => {
    const source = args.at(-2) || "";
    const destination = args.at(-1) || "";
    if (command === "scp" && destination.includes("sentaurus-web-agent-")) {
      return { ok: true, stdout: "", stderr: "", exitCode: 0 };
    }
    if (command === "ssh" && destination.includes("rm -f --") && destination.includes(remotePath)) {
      cleanupCommand = destination;
      return { ok: true, stdout: "", stderr: "", exitCode: 0 };
    }
    if (command === "ssh") {
      return { ok: true, stdout: JSON.stringify(metadata), stderr: "", exitCode: 0 };
    }
    if (command === "scp" && source.endsWith(remotePath)) {
      downloadAttempts += 1;
      if (downloadAttempts === 1) {
        return { ok: false, stdout: "", stderr: "Connection timed out", error: "Connection timed out" };
      }
      fs.writeFileSync(destination, content);
      return { ok: true, stdout: "", stderr: "", exitCode: 0 };
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };

  const result = await executeSshCommandWithInputDownload(
    "python",
    "print('stage')",
    remotePath,
    1024,
    5_000,
    undefined,
    runner,
  );

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.data, content);
  assert.equal(downloadAttempts, 2);
  assert.match(cleanupCommand, /sentaurus-web-agent-/);
  assert.match(cleanupCommand, /sentaurus-web-artifact-/);
});

test("SCP artifact download enforces the configured size limit before transfer", async () => {
  const remotePath = "/tmp/sentaurus-web-artifact-123456789012-limit123456";
  let downloadStarted = false;
  let cleanupCalled = false;
  const runner: SshLocalCommandRunner = async (command, args) => {
    const source = args.at(-2) || "";
    const destination = args.at(-1) || "";
    if (command === "scp" && destination.includes("sentaurus-web-agent-")) {
      return { ok: true, stdout: "", stderr: "", exitCode: 0 };
    }
    if (command === "ssh" && destination.includes("rm -f --") && destination.includes(remotePath)) {
      cleanupCalled = true;
      return { ok: true, stdout: "", stderr: "", exitCode: 0 };
    }
    if (command === "ssh") {
      return {
        ok: true,
        stdout: JSON.stringify({
          ok: true,
          path: "large.plt",
          fileName: "large.plt",
          size: 11,
          sha256: "a".repeat(64),
        }),
        stderr: "",
        exitCode: 0,
      };
    }
    if (command === "scp" && source.endsWith(remotePath)) {
      downloadStarted = true;
    }
    return { ok: false, stdout: "", stderr: "unexpected transfer" };
  };

  const result = await executeSshCommandWithInputDownload(
    "python",
    "print('stage')",
    remotePath,
    10,
    5_000,
    undefined,
    runner,
  );

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 413);
  assert.equal(downloadStarted, false);
  assert.equal(cleanupCalled, true);
});

test("cancelled SCP artifact download cleans remote staging files", async () => {
  const remotePath = "/tmp/sentaurus-web-artifact-123456789012-cancel12345";
  const content = Buffer.from("cancelled transfer", "utf8");
  const controller = new AbortController();
  let cleanupCommand = "";
  const runner: SshLocalCommandRunner = async (command, args, _timeoutMs, signal) => {
    const source = args.at(-2) || "";
    const destination = args.at(-1) || "";
    if (command === "scp" && destination.includes("sentaurus-web-agent-")) {
      return { ok: true, stdout: "", stderr: "", exitCode: 0 };
    }
    if (command === "ssh" && destination.includes("rm -f --") && destination.includes(remotePath)) {
      cleanupCommand = destination;
      return { ok: true, stdout: "", stderr: "", exitCode: 0 };
    }
    if (command === "ssh") {
      return {
        ok: true,
        stdout: JSON.stringify({
          ok: true,
          path: "idvg_low.plt",
          fileName: "idvg_low.plt",
          size: content.byteLength,
          sha256: createHash("sha256").update(content).digest("hex"),
        }),
        stderr: "",
        exitCode: 0,
      };
    }
    if (command === "scp" && source.endsWith(remotePath)) {
      return await new Promise((resolve) => {
        const abort = () => resolve({
          ok: false,
          stdout: "",
          stderr: "",
          error: "VM_SSH_ABORTED: SSH operation cancelled",
          errorCode: "VM_SSH_ABORTED",
        });
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };

  const pending = executeSshCommandWithInputDownload(
    "python",
    "print('stage')",
    remotePath,
    1024,
    5_000,
    controller.signal,
    runner,
  );
  setTimeout(() => controller.abort(), 20);
  const result = await pending;

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "VM_SSH_ABORTED");
  assert.match(cleanupCommand, /sentaurus-web-agent-/);
  assert.match(cleanupCommand, /sentaurus-web-artifact-/);
});

test("session input sync script hashes PLT files and deduplicates identical TXT input", () => {
  const sourcePath = path.join(repoRoot, "apps/server/src/services/vmSessionFiles.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const match = source.match(/const remoteSyncInputScript = String\.raw`([\s\S]*?)`;/);
  assert.ok(match, "remote sync input script should be present");

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "plt-input-sync-test-"));
  try {
    const content = fs.readFileSync(path.join(goldenInputDir, "idvg_low.plt"));
    const expectedSha256 = createHash("sha256").update(content).digest("hex");
    const runScript = (fileName: string) => {
      const request = {
        sessionId: "run_input_sync_test",
        category: VM_SESSION_INPUT_CATEGORY,
        fileName,
        categories: VM_SESSION_OUTPUT_CATEGORIES,
        allowedExtensions: [".plt", ".txt"],
        contentB64: content.toString("base64")
      };
      const script = match[1].replace("__REQUEST_B64__", Buffer.from(JSON.stringify(request)).toString("base64"));
      const scriptPath = path.join(tempDir, `${fileName}.py`);
      fs.writeFileSync(scriptPath, script, "utf8");
      const result = spawnSync("python", [scriptPath], {
        encoding: "utf8",
        env: { ...process.env, HOME: tempDir, USERPROFILE: tempDir }
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) || "{}");
    };

    const plt = runScript("idvg_low.plt");
    assert.equal(plt.ok, true);
    assert.equal(plt.sha256, expectedSha256);
    assert.equal(plt.deduplicated, false);

    const txt = runScript("idvg_low.txt");
    assert.equal(txt.ok, true);
    assert.equal(txt.sha256, expectedSha256);
    assert.equal(txt.path, "idvg_low.plt");
    assert.equal(txt.deduplicated, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("SSH queue deadlines skip expired work instead of running it later", async () => {
  let releaseBlocker!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const blocker = new Promise<void>((resolve) => { releaseBlocker = resolve; });
  const first = scheduleSsh(async () => {
    markStarted();
    await blocker;
    return okResult();
  }, { lane: "history", queueDeadlineMs: 1_000 });
  await started;
  let expiredRunCount = 0;
  const expired = await scheduleSsh(async () => {
    expiredRunCount += 1;
    return okResult();
  }, { lane: "history", queueDeadlineMs: 20 });
  assert.equal(expired.errorCode, "VM_SSH_QUEUE_TIMEOUT");
  releaseBlocker();
  await first;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(expiredRunCount, 0);
});

test("SSH single-flight keeps shared work until every consumer cancels", async () => {
  const firstController = new AbortController();
  const secondController = new AbortController();
  let runCount = 0;
  let underlyingAborted = false;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const run = (signal: AbortSignal) => new Promise<ReturnType<typeof okResult>>((resolve) => {
    runCount += 1;
    markStarted();
    signal.addEventListener("abort", () => {
      underlyingAborted = true;
      resolve({ ok: false, stdout: "", stderr: "", error: "aborted" });
    }, { once: true });
  });
  const first = scheduleSsh(run, {
    lane: "files",
    queueDeadlineMs: 1_000,
    dedupeKey: "shared-cancel",
    signal: firstController.signal
  });
  const second = scheduleSsh(run, {
    lane: "files",
    queueDeadlineMs: 1_000,
    dedupeKey: "shared-cancel",
    signal: secondController.signal
  });
  await started;
  firstController.abort();
  assert.equal((await first).errorCode, "VM_SSH_ABORTED");
  assert.equal(underlyingAborted, false);
  secondController.abort();
  assert.equal((await second).errorCode, "VM_SSH_ABORTED");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runCount, 1);
  assert.equal(underlyingAborted, true);
});

test("SSE disconnect aborts its SSH history consumer", async () => {
  const app = Fastify();
  let observedSignal: AbortSignal | undefined;
  let signalAborted!: () => void;
  const aborted = new Promise<void>((resolve) => { signalAborted = resolve; });
  await vmAgentRoutes(app, {
    getVmAgentMessages: async (_after, _limit, _sessionId, signal) => {
      observedSignal = signal;
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => {
          signalAborted();
          resolve();
        }, { once: true });
      });
      return {
        status: {
          ok: true,
          connected: true,
          checkedAt: new Date().toISOString(),
          sshTarget: "test",
          hostTime: new Date().toISOString(),
          hostEpochMs: Date.now()
        },
        messages: [],
        cursor: 0
      };
    }
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  let response: http.IncomingMessage | undefined;
  let request: http.ClientRequest | undefined;
  try {
    response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      request = http.get(
        `${address}/api/vm/agent/messages/stream?token=${encodeURIComponent(process.env.AUTH_TOKEN || "")}`,
        { agent: false },
        resolve
      );
      request.on("error", reject);
    });
    assert.match(String(response.headers["content-type"] || ""), /text\/event-stream/);
    assert.equal(observedSignal?.aborted, false);
    response.destroy();
    await Promise.race([
      aborted,
      new Promise((_, reject) => setTimeout(() => reject(new Error("SSE abort did not reach SSH consumer")), 1_000))
    ]);
    assert.equal(observedSignal?.aborted, true);
  } finally {
    request?.destroy();
    response?.destroy();
    app.server.closeAllConnections?.();
    await app.close();
  }
});


test("VM context budget constants and compression guard persist", () => {
  const source = fs.readFileSync(path.join(repoRoot, "apps/server/src/services/vmAgent.ts"), "utf8");
  assert.match(source, /VM_CONTEXT_WINDOW_TOKENS = 1000000/);
  assert.match(source, /VM_CONTEXT_TARGET_TOKENS = 850000/);
  assert.ok(source.includes("context_tokens = estimate_context_tokens(system) + estimate_context_tokens(user_text)"));
  assert.match(source, /Same-session context compressed to fit the 1.0M-token model window/);
});
