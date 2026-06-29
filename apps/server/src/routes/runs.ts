import type { FastifyInstance } from "fastify";
import { VM_SESSION_INPUT_CATEGORY } from "@sentaurus-agent/shared";
import type { RunFile, RunSummary, SimulationSetup, VmSessionFileSyncStatus } from "@sentaurus-agent/shared";
import { config } from "../config.js";
import { requireAuth } from "../security/auth.js";
import { prepareRemoteRun } from "../services/sentaurusRunner.js";
import {
  appendRunLog,
  createRun,
  deleteRun,
  getPublicRun,
  getRun,
  getRunDetail,
  listRuns,
  listRunFiles,
  readRunLog,
  resolveRunFile,
  saveSimulationSetup,
  saveInputFile,
  setRunStatus,
  streamRunFile,
  updateRun
} from "../services/runStore.js";
import { contentTypeForName, syncInputFileToVmSession } from "../services/vmSessionFiles.js";

type RunParams = { id: string };
type FileParams = RunParams & { name: string };
type UploadRunFileResponse = {
  file: RunFile;
  run: RunSummary;
  vmSync: VmSessionFileSyncStatus;
};

function authTokenFromQuery(query: unknown): string | undefined {
  if (!query || typeof query !== "object") return undefined;
  const value = (query as { token?: unknown }).token;
  return typeof value === "string" ? value : undefined;
}

export async function runRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/runs", async (request) => {
    requireAuth(request);
    return { runs: await listRuns() };
  });

  app.post<{ Body: { title?: string } }>("/api/runs", async (request) => {
    requireAuth(request);
    return { run: await createRun(request.body?.title) };
  });

  app.get<{ Params: RunParams }>("/api/runs/:id", async (request) => {
    requireAuth(request);
    return await getRunDetail(request.params.id);
  });

  app.patch<{ Params: RunParams; Body: { title?: string } }>("/api/runs/:id", async (request) => {
    requireAuth(request);
    const title = request.body?.title?.trim();
    if (!title) {
      const error = new Error("title is required") as Error & { statusCode?: number };
      error.statusCode = 400;
      throw error;
    }
    if (title.length > 120) {
      const error = new Error("title is too long") as Error & { statusCode?: number };
      error.statusCode = 400;
      throw error;
    }
    return { run: await updateRun(request.params.id, { title }) };
  });

  app.patch<{ Params: RunParams; Body: Partial<SimulationSetup> }>("/api/runs/:id/simulation-setup", async (request) => {
    requireAuth(request);
    return { run: await saveSimulationSetup(request.params.id, request.body || {}) };
  });

  app.delete<{ Params: RunParams }>("/api/runs/:id", async (request) => {
    requireAuth(request);
    await deleteRun(request.params.id);
    return { ok: true };
  });

  app.get<{ Params: RunParams }>("/api/runs/:id/files", async (request) => {
    requireAuth(request);
    return { files: await listRunFiles(request.params.id, "input") };
  });

  app.post<{ Params: RunParams; Reply: UploadRunFileResponse }>("/api/runs/:id/files", async (request) => {
    requireAuth(request);
    const file = await request.file();
    if (!file) {
      const error = new Error("file is required") as Error & { statusCode?: number };
      error.statusCode = 400;
      throw error;
    }
    const saved = await saveInputFile(request.params.id, file.filename, file.file);
    await appendRunLog(request.params.id, "job.log", `[${new Date().toISOString()}] uploaded input/${saved.name}`);
    let vmSync: VmSessionFileSyncStatus = { ok: false };
    try {
      const localPath = await resolveRunFile(request.params.id, "input", saved.name);
      await syncInputFileToVmSession(request.params.id, saved.name, localPath);
      vmSync = { ok: true, category: VM_SESSION_INPUT_CATEGORY, path: saved.name };
      await appendRunLog(request.params.id, "job.log", `[${new Date().toISOString()}] synced input/${saved.name} to VM output/我的输入`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      vmSync = { ok: false, error: detail };
      await appendRunLog(request.params.id, "job.log", `[${new Date().toISOString()}] VM input sync failed for ${saved.name}: ${detail}`);
    }
    return { file: saved, run: await getPublicRun(request.params.id), vmSync };
  });

  app.get<{ Params: FileParams }>("/api/runs/:id/files/:name", async (request, reply) => {
    requireAuth(request);
    const filePath = await resolveRunFile(request.params.id, "input", request.params.name);
    reply.header("content-type", contentTypeForName(request.params.name));
    return reply.send(streamRunFile(filePath));
  });

  app.get<{ Params: RunParams }>("/api/runs/:id/artifacts", async (request) => {
    requireAuth(request);
    return { artifacts: await listRunFiles(request.params.id, "artifacts") };
  });

  app.get<{ Params: FileParams }>("/api/runs/:id/logs/:name", async (request, reply) => {
    requireAuth(request);
    const filePath = await resolveRunFile(request.params.id, "logs", request.params.name);
    return reply.send(streamRunFile(filePath));
  });

  app.get<{ Params: FileParams }>("/api/runs/:id/artifacts/:name", async (request, reply) => {
    requireAuth(request);
    const filePath = await resolveRunFile(request.params.id, "artifacts", request.params.name);
    return reply.send(streamRunFile(filePath));
  });

  app.post<{ Params: RunParams }>("/api/runs/:id/prepare-remote", async (request) => {
    requireAuth(request);
    const run = await getRun(request.params.id);
    if (!run.remoteDir) throw new Error("Run has no remoteDir configured");
    const result = await prepareRemoteRun(run.remoteDir);
    const line = `[${new Date().toISOString()}] prepare-remote ${result.ok ? "ok" : "failed"}: ${result.message}`;
    await appendRunLog(run.id, "prepare-remote.log", line);
    await appendRunLog(run.id, "job.log", line);
    const updated = result.ok
      ? await updateRun(run.id, { remotePreparedAt: new Date().toISOString(), lastError: undefined })
      : await updateRun(run.id, { lastError: result.message });
    return { ok: result.ok, message: result.message, run: updated };
  });

  app.post<{ Params: RunParams }>("/api/runs/:id/jobs", async (request, reply) => {
    requireAuth(request);
    await appendRunLog(request.params.id, "job.log", `[${new Date().toISOString()}] job submit requested`);
    return reply.status(409).send({
      ok: false,
      run: await getPublicRun(request.params.id),
      message: "Real Sentaurus jobs are not implemented/enabled yet. Keep ENABLE_REAL_JOBS=0 until command allowlists and cancellation are reviewed."
    });
  });

  app.post<{ Params: RunParams }>("/api/runs/:id/cancel", async (request) => {
    requireAuth(request);
    await appendRunLog(request.params.id, "job.log", `[${new Date().toISOString()}] cancel requested`);
    return { ok: true, run: await setRunStatus(request.params.id, "cancelled") };
  });

  app.get<{ Params: RunParams; Querystring: { token?: string } }>("/api/runs/:id/logs/stream", async (request, reply) => {
    const token = authTokenFromQuery(request.query);
    if (token) request.headers.authorization = `Bearer ${token}`;
    requireAuth(request);
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "access-control-allow-origin": config.CORS_ORIGIN,
      vary: "origin",
      connection: "keep-alive"
    });
    let offset = 0;
    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    const tick = async () => {
      const content = await readRunLog(request.params.id, "job.log");
      if (content.length > offset) {
        send("log", { chunk: content.slice(offset) });
        offset = content.length;
      } else {
        send("ping", { time: new Date().toISOString() });
      }
    };
    await tick();
    const interval = setInterval(() => void tick().catch((err) => send("error", { message: String(err) })), 1500);
    request.raw.on("close", () => clearInterval(interval));
  });
}
