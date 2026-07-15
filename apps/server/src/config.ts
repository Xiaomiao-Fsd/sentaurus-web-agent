import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(serverDir, "../../..");
const repoRootEnv = path.resolve(repoRoot, ".env");
dotenv.config({ path: repoRootEnv });
dotenv.config();

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost"
    || normalized === "::1"
    || normalized === "0:0:0:0:0:0:0:1"
    || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function isLegacyPrivateBindHost(host: string): boolean {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, "") === "10.6.22.1";
}

export function assertSecureAuthConfig(host: string, authToken: string): void {
  if (isLoopbackHost(host) || isLegacyPrivateBindHost(host)) return;
  if (authToken === "change-me-local-only") {
    throw new Error("Refusing non-loopback access with the default AUTH_TOKEN. Set a strong token in .env first.");
  }
  if (authToken.length < 24) {
    throw new Error("AUTH_TOKEN must be at least 24 characters for non-loopback access.");
  }
}

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(5175),
  HOST: z.string().default("::1"),
  CORS_ORIGIN: z.string().default("http://[::1]:5174"),
  AUTH_TOKEN: z.string().min(8).default("change-me-local-only"),
  LLM_API_BASE: z.string().url().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default("gpt-5.5"),
  SENTAURUS_SSH_TARGET: z.string().default("sentaurus-centos7"),
  SENTAURUS_REMOTE_BASE: z.string().default("/home/TCAD2022/STDB/web-agent-runs"),
  LOCAL_RUN_BASE: z.string().default("./data/runs"),
  VM_AGENT_HISTORY_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(180_000).default(45_000),
  VM_AGENT_HISTORY_MAX_RESPONSE_BYTES: z.coerce.number().int().min(64 * 1024).max(16 * 1024 * 1024).default(12 * 1024 * 1024),
  MAX_UPLOAD_MB: z.coerce.number().int().positive().default(200),
  ENABLE_REAL_JOBS: z.coerce.number().int().min(0).max(1).default(0)
});

const parsed = schema.parse(process.env);

assertSecureAuthConfig(parsed.HOST, parsed.AUTH_TOKEN);

export const config = {
  ...parsed,
  REPO_ROOT_ABS: repoRoot,
  LOCAL_RUN_BASE_ABS: path.isAbsolute(parsed.LOCAL_RUN_BASE)
    ? path.normalize(parsed.LOCAL_RUN_BASE)
    : path.resolve(repoRoot, parsed.LOCAL_RUN_BASE),
  realJobsEnabled: parsed.ENABLE_REAL_JOBS === 1
};
