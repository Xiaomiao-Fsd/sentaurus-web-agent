import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { nanoid } from "nanoid";
import type { RunDetail, RunFile, RunFileKind, RunStatus, RunSummary, SimulationSetup } from "@sentaurus-agent/shared";
import { config } from "../config.js";
import { assertInsideBase, safeFileName, safeRunId } from "../security/pathSafe.js";

const manifestName = "manifest.json";
const setupTextLimit = 500;

async function ensureBase(): Promise<void> {
  await fs.mkdir(config.LOCAL_RUN_BASE_ABS, { recursive: true });
}

async function writeManifest(run: RunSummary): Promise<void> {
  if (!run.localDir) throw new Error("Run manifest is missing localDir");
  const manifestPath = assertInsideBase(config.LOCAL_RUN_BASE_ABS, path.join(run.localDir, manifestName));
  await fs.writeFile(manifestPath, JSON.stringify(run, null, 2), "utf8");
}

function publicRun(run: RunSummary): RunSummary {
  const { localDir: _localDir, ...rest } = run;
  return rest;
}

function areaDir(run: RunSummary, kind: RunFileKind): string {
  if (!run.localDir) throw new Error("Run manifest is missing localDir");
  return assertInsideBase(config.LOCAL_RUN_BASE_ABS, path.join(run.localDir, kind));
}

function runDir(id: string): string {
  return assertInsideBase(config.LOCAL_RUN_BASE_ABS, path.join(config.LOCAL_RUN_BASE_ABS, safeRunId(id)));
}

function setupText(value: unknown, limit = setupTextLimit): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit) : undefined;
}

function normalizeSimulationSetup(input: Partial<SimulationSetup> | undefined): SimulationSetup {
  const source = input || {};
  const expectedOutputs = Array.isArray(source.expectedOutputs)
    ? source.expectedOutputs.flatMap((item) => {
      const value = setupText(item, 220);
      return value ? [value] : [];
    }).slice(0, 24)
    : undefined;
  const updatedBy = source.updatedBy === "user" || source.updatedBy === "system" ? source.updatedBy : "vm-agent";
  return {
    deviceType: setupText(source.deviceType),
    gateBias: setupText(source.gateBias),
    drainBias: setupText(source.drainBias),
    sourceBulk: setupText(source.sourceBulk),
    geometry: setupText(source.geometry),
    dopingOrImplant: setupText(source.dopingOrImplant),
    physicsModels: setupText(source.physicsModels),
    mesh: setupText(source.mesh),
    temperature: setupText(source.temperature),
    simulationGoals: setupText(source.simulationGoals, 800),
    expectedOutputs,
    notes: setupText(source.notes, 1000),
    updatedAt: setupText(source.updatedAt, 80) || new Date().toISOString(),
    updatedBy
  };
}

export async function createRun(title?: string): Promise<RunSummary> {
  await ensureBase();
  const id = `run_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${nanoid(6)}`;
  const localDir = assertInsideBase(config.LOCAL_RUN_BASE_ABS, path.join(config.LOCAL_RUN_BASE_ABS, id));
  await fs.mkdir(path.join(localDir, "input"), { recursive: true });
  await fs.mkdir(path.join(localDir, "logs"), { recursive: true });
  await fs.mkdir(path.join(localDir, "artifacts"), { recursive: true });
  const now = new Date().toISOString();
  const run: RunSummary = {
    id,
    status: "created",
    title: title || "Untitled Sentaurus run",
    createdAt: now,
    updatedAt: now,
    localDir,
    remoteDir: `${config.SENTAURUS_REMOTE_BASE}/${id}`
  };
  await writeManifest(run);
  return publicRun(run);
}

export async function listRuns(): Promise<RunSummary[]> {
  await ensureBase();
  const entries = await fs.readdir(config.LOCAL_RUN_BASE_ABS, { withFileTypes: true });
  const runs: RunSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("run_")) continue;
    const manifestPath = path.join(config.LOCAL_RUN_BASE_ABS, entry.name, manifestName);
    try {
      const parsed = JSON.parse(await fs.readFile(manifestPath, "utf8")) as RunSummary;
      runs.push(publicRun(parsed));
    } catch {
      // Ignore incomplete directories.
    }
  }
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getRun(id: string): Promise<RunSummary> {
  await ensureBase();
  const manifestPath = path.join(runDir(id), manifestName);
  try {
    return JSON.parse(await fs.readFile(manifestPath, "utf8")) as RunSummary;
  } catch (err) {
    const error = new Error(`Run not found: ${id}`) as Error & { statusCode?: number };
    error.statusCode = 404;
    throw error;
  }
}

export async function getPublicRun(id: string): Promise<RunSummary> {
  return publicRun(await getRun(id));
}

export async function updateRun(id: string, patch: Partial<RunSummary>): Promise<RunSummary> {
  const run = await getRun(id);
  const updated: RunSummary = {
    ...run,
    ...patch,
    id: run.id,
    localDir: run.localDir,
    updatedAt: new Date().toISOString()
  };
  await writeManifest(updated);
  return publicRun(updated);
}

export async function deleteRun(id: string): Promise<void> {
  await ensureBase();
  await fs.rm(runDir(id), { recursive: true, force: true });
}

export async function setRunStatus(id: string, status: RunStatus, lastError?: string): Promise<RunSummary> {
  return updateRun(id, { status, lastError });
}

export async function saveSimulationSetup(id: string, setup: Partial<SimulationSetup>): Promise<RunSummary> {
  return updateRun(id, { simulationSetup: normalizeSimulationSetup(setup) });
}

async function listArea(run: RunSummary, kind: RunFileKind): Promise<RunFile[]> {
  const dir = areaDir(run, kind);
  await fs.mkdir(dir, { recursive: true });
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: RunFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fullPath = assertInsideBase(dir, path.join(dir, entry.name));
    const stat = await fs.stat(fullPath);
    files.push({ name: entry.name, kind, size: stat.size, modifiedAt: stat.mtime.toISOString() });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getRunDetail(id: string): Promise<RunDetail> {
  const run = await getRun(id);
  return {
    run: publicRun(run),
    files: await listArea(run, "input"),
    logs: await listArea(run, "logs"),
    artifacts: await listArea(run, "artifacts")
  };
}

export async function listRunFiles(id: string, kind: RunFileKind): Promise<RunFile[]> {
  return listArea(await getRun(id), kind);
}

export async function resolveRunFile(id: string, kind: RunFileKind, name: string): Promise<string> {
  const run = await getRun(id);
  const dir = areaDir(run, kind);
  return assertInsideBase(dir, path.join(dir, safeFileName(name)));
}

export async function saveInputFile(id: string, filename: string, stream: NodeJS.ReadableStream): Promise<RunFile> {
  const run = await getRun(id);
  const dir = areaDir(run, "input");
  await fs.mkdir(dir, { recursive: true });
  const target = assertInsideBase(dir, path.join(dir, safeFileName(filename)));
  await pipeline(stream, await fs.open(target, "w").then((handle) => handle.createWriteStream()));
  const stat = await fs.stat(target);
  return { name: path.basename(target), kind: "input", size: stat.size, modifiedAt: stat.mtime.toISOString() };
}

export async function appendRunLog(id: string, fileName: string, message: string): Promise<void> {
  const run = await getRun(id);
  const dir = areaDir(run, "logs");
  await fs.mkdir(dir, { recursive: true });
  const target = assertInsideBase(dir, path.join(dir, safeFileName(fileName)));
  await fs.appendFile(target, message.endsWith("\n") ? message : `${message}\n`, "utf8");
}

export async function readRunLog(id: string, fileName: string): Promise<string> {
  const filePath = await resolveRunFile(id, "logs", fileName);
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

export function streamRunFile(filePath: string) {
  return createReadStream(filePath);
}
