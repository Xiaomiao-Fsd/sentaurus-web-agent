import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import type { RunSummary } from "@sentaurus-agent/shared";
import { config } from "../config.js";
import { assertInsideBase } from "../security/pathSafe.js";

const manifestName = "manifest.json";

async function ensureBase(): Promise<void> {
  await fs.mkdir(config.LOCAL_RUN_BASE_ABS, { recursive: true });
}

async function writeManifest(run: RunSummary): Promise<void> {
  const manifestPath = assertInsideBase(config.LOCAL_RUN_BASE_ABS, path.join(run.localDir, manifestName));
  await fs.writeFile(manifestPath, JSON.stringify(run, null, 2), "utf8");
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
  return run;
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
      runs.push(parsed);
    } catch {
      // Ignore incomplete directories.
    }
  }
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
