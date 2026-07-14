import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";
import test from "node:test";
import Fastify from "fastify";
import { assertSecureAuthConfig, config, isLoopbackHost } from "../src/config.js";
import { vmAgentRoutes } from "../src/routes/vmAgent.js";
import {
  normalizeMessages,
  parseRemoteJson,
  remoteAgentScript,
  VmAgentHistoryError
} from "../src/services/vmAgent.js";
import { terminateProcessTree } from "../src/services/sshClient.js";

const execFileAsync = promisify(execFile);

function status(error?: string) {
  return {
    ok: !error,
    agent: "sentaurus-vm-agent",
    version: "0.5.0",
    hostname: "test-vm",
    user: "tester",
    connected: !error,
    error
  };
}

async function withHistoryFixture(
  messages: unknown[],
  request: Parameters<typeof remoteAgentScript>[0]
): Promise<{ stdout: string; payload: ReturnType<typeof parseRemoteJson> }> {
  const home = await mkdtemp(path.join(tmpdir(), "sentaurus-history-test-"));
  try {
    const root = path.join(home, ".sentaurus-web-agent", "vm-agent");
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, "messages.jsonl"),
      `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
      "utf8"
    );
    const scriptPath = path.join(home, "history.py");
    const script = remoteAgentScript(request).replace(
      "    status = build_status(cursor)\n",
      "    status = {\"ok\": True, \"agent\": AGENT_NAME, \"version\": AGENT_VERSION, \"hostname\": \"test-vm\", \"user\": \"tester\", \"connected\": True}\n"
    );
    await writeFile(scriptPath, script, "utf8");
    const { stdout } = await execFileAsync("python", [scriptPath], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true
    });
    return { stdout, payload: parseRemoteJson(stdout) };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("unpacks a zlib-base64 history envelope", () => {
  const payload = {
    ok: true,
    cursor: 42,
    messages: [{ id: "message-1", role: "agent", content: "done" }],
    historyCompacted: true
  };
  const raw = Buffer.from(JSON.stringify(payload), "utf8");
  const compressed = deflateSync(raw);
  const decoded = parseRemoteJson(JSON.stringify({
    ok: true,
    transportEncoding: "zlib-base64-json",
    payloadB64: compressed.toString("base64"),
    compressedBytes: compressed.byteLength,
    uncompressedBytes: raw.byteLength
  }));

  assert.equal(decoded.cursor, 42);
  assert.deepEqual(decoded.messages, payload.messages);
  assert.equal(decoded.transportCompressedBytes, compressed.byteLength);
  assert.equal(decoded.transportUncompressedBytes, raw.byteLength);
});

test("legacy private bind stays compatible while other non-loopback listeners require strong tokens", () => {
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("10.6.22.1"), false);
  assert.doesNotThrow(
    () => assertSecureAuthConfig("10.6.22.1", "change-me-local-only"),
  );
  assert.doesNotThrow(
    () => assertSecureAuthConfig("10.6.22.1", "too-short"),
  );
  assert.throws(
    () => assertSecureAuthConfig("192.168.1.10", "change-me-local-only"),
    /default AUTH_TOKEN/
  );
  assert.throws(
    () => assertSecureAuthConfig("0.0.0.0", "too-short"),
    /at least 24 characters/
  );
  assert.doesNotThrow(
    () => assertSecureAuthConfig("10.6.22.1", "a-secure-random-token-with-32-chars")
  );
});

test("Windows timeout cleanup terminates the spawned process tree", {
  skip: process.platform !== "win32"
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sentaurus-process-tree-test-"));
  const childPidPath = path.join(root, "child.pid");
  const parentScript = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });",
    `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
    "setTimeout(() => {}, 60000);"
  ].join("\n");
  const parent = spawn(process.execPath, [
    "-e",
    parentScript
  ], {
    stdio: "ignore",
    windowsHide: true
  });

  let childPid = 0;
  try {
    const deadline = Date.now() + 10_000;
    while (!childPid && Date.now() < deadline) {
      try {
        childPid = Number.parseInt((await readFile(childPidPath, "utf8")).trim(), 10);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.ok(Number.isInteger(childPid) && childPid > 0);

    terminateProcessTree(parent);
    await new Promise((resolve) => setTimeout(resolve, 250));

    const childCheck = spawnSync("powershell", [
      "-NoProfile",
      "-Command",
      `if (Get-Process -Id ${childPid} -ErrorAction SilentlyContinue) { exit 1 }`
    ], { windowsHide: true });
    assert.equal(childCheck.status, 0);
  } finally {
    terminateProcessTree(parent);
    if (childPid > 0) {
      spawnSync("taskkill", ["/PID", String(childPid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("selected full history compacts streams before the envelope without losing metadata", async () => {
  const sessionId = "run_history_compaction";
  const otherSessionId = "run_other";
  const messages = [
    {
      id: "user-1",
      role: "user",
      content: "simulate",
      createdAt: "2026-07-10T00:00:00Z",
      meta: { sessionId, turnId: "turn-1", kind: "user_message", simulationSetupJson: "{\"goal\":\"Id-Vg\"}" }
    },
    {
      id: "delta-1",
      role: "agent",
      content: "Hello ",
      createdAt: "2026-07-10T00:00:01Z",
      meta: { sessionId, turnId: "turn-1", targetMessageId: "assistant-1", kind: "agent_response_delta", append: true }
    },
    {
      id: "progress-1",
      role: "agent",
      content: "running",
      createdAt: "2026-07-10T00:00:02Z",
      meta: { sessionId, turnId: "turn-1", kind: "progress", runId: "vm-run-1", outputCategory: "simulation data" }
    },
    {
      id: "done-1",
      role: "agent",
      content: "Hello world",
      createdAt: "2026-07-10T00:00:03Z",
      attachments: [{
        id: "artifact-1",
        kind: "file",
        name: "result.plt",
        size: 123,
        source: "vm-run-artifact",
        path: "result.plt",
        runId: "vm-run-1"
      }],
      meta: {
        sessionId,
        turnId: "turn-1",
        targetMessageId: "assistant-1",
        kind: "agent_response_done",
        done: true,
        vmRunArtifactsJson: "[{\"path\":\"result.plt\"}]"
      }
    },
    {
      id: "other-1",
      role: "user",
      content: "not selected",
      createdAt: "2026-07-10T00:00:04Z",
      meta: { sessionId: otherSessionId, turnId: "turn-2" }
    }
  ];

  const { stdout, payload } = await withHistoryFixture(messages, {
    operation: "history",
    after: 0,
    limit: 5000,
    sessionId,
    responseByteBudget: 1024 * 1024
  });
  const envelopeLine = stdout.split(/\r?\n/).find((line) => line.includes("\"transportEncoding\""));
  assert.ok(envelopeLine);
  assert.equal(JSON.parse(envelopeLine).transportEncoding, "zlib-base64-json");
  assert.equal(payload.historyCompacted, true);
  assert.equal(payload.rawCount, 4);
  assert.equal(payload.compactedCount, 3);
  assert.equal(payload.cursor, 5);

  const returned = payload.messages as Array<Record<string, any>>;
  assert.equal(returned.length, 3);
  assert.equal(returned.some((message) => message.meta.sessionId === otherSessionId), false);
  const progress = returned.find((message) => message.meta.kind === "progress");
  assert.equal(progress?.meta.runId, "vm-run-1");
  assert.equal(progress?.meta.outputCategory, "simulation data");
  const assistant = returned.find((message) => message.id === "assistant-1");
  assert.equal(assistant?.content, "Hello world");
  assert.equal(assistant?.meta.vmRunArtifactsJson, "[{\"path\":\"result.plt\"}]");
  assert.equal(assistant?.attachments?.[0]?.path, "result.plt");

  const normalized = normalizeMessages(payload.messages, payload);
  const normalizedProgress = normalized.find((message) => message.meta?.kind === "progress");
  assert.equal(normalizedProgress?.meta?.sessionId, sessionId);
  assert.equal(normalizedProgress?.meta?.runId, "vm-run-1");
  assert.equal(normalizedProgress?.meta?.outputCategory, "simulation data");
  const normalizedAssistant = normalized.find((message) => message.id === "assistant-1");
  assert.equal(normalizedAssistant?.meta?.vmRunArtifactsJson, "[{\"path\":\"result.plt\"}]");
  assert.equal(normalizedAssistant?.attachments?.[0]?.source, "vm-run-artifact");
  assert.equal(normalizedAssistant?.attachments?.[0]?.runId, "vm-run-1");
});

test("after>0 returns the first raw page and advances only to the last returned sequence", async () => {
  const sessionId = "run_incremental";
  const messages = [
    { id: "m1", role: "user", content: "one", meta: { sessionId, kind: "user_message" } },
    { id: "m2", role: "agent", content: "progress", meta: { sessionId, kind: "progress" } },
    { id: "m3", role: "agent", content: "delta", meta: { sessionId, kind: "agent_response_delta", append: true, targetMessageId: "a1" } },
    { id: "m4", role: "agent", content: "worklog", meta: { sessionId, kind: "worklog_summary" } },
    { id: "m5", role: "agent", content: "done", meta: { sessionId, kind: "agent_response_done", done: true, targetMessageId: "a1" } }
  ];

  const first = await withHistoryFixture(messages, {
    operation: "history",
    after: 1,
    limit: 2,
    sessionId
  });
  assert.equal(first.stdout.includes("\"transportEncoding\""), false);
  assert.equal(first.payload.historyCompacted, undefined);
  assert.equal(first.payload.cursor, 3);
  assert.deepEqual(
    (first.payload.messages as Array<Record<string, any>>).map((message) => [message.sequence, message.meta.kind]),
    [[2, "progress"], [3, "agent_response_delta"]]
  );

  const second = await withHistoryFixture(messages, {
    operation: "history",
    after: 3,
    limit: 2,
    sessionId
  });
  assert.equal(second.payload.cursor, 5);
  assert.deepEqual(
    (second.payload.messages as Array<Record<string, any>>).map((message) => [message.sequence, message.meta.kind]),
    [[4, "worklog_summary"], [5, "agent_response_done"]]
  );
});

for (const scenario of [
  { code: "VM_HISTORY_TIMEOUT" as const, httpStatus: 504 as const },
  { code: "VM_HISTORY_BRIDGE_FAILED" as const, httpStatus: 502 as const }
]) {
  test(`history route returns structured HTTP ${scenario.httpStatus}`, async () => {
    const app = Fastify();
    await app.register(vmAgentRoutes, {
      getVmAgentMessages: async () => {
        throw new VmAgentHistoryError(
          scenario.code,
          scenario.code === "VM_HISTORY_TIMEOUT" ? "history timed out" : "bridge failed",
          scenario.httpStatus,
          77,
          status("bridge unavailable"),
          true
        );
      }
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/vm/agent/messages?after=12&limit=50&sessionId=run_test",
      headers: { authorization: `Bearer ${config.AUTH_TOKEN}` }
    });
    await app.close();

    assert.equal(response.statusCode, scenario.httpStatus);
    assert.deepEqual(response.json(), {
      ok: false,
      error: scenario.code,
      message: scenario.code === "VM_HISTORY_TIMEOUT" ? "history timed out" : "bridge failed",
      retryable: true,
      cursor: 77,
      status: status("bridge unavailable"),
      messages: []
    });
  });
}
