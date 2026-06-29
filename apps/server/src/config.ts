import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const repoRootEnv = path.resolve(serverDir, "../../../.env");
dotenv.config({ path: repoRootEnv });
dotenv.config();

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(5175),
  HOST: z.string().default("10.6.22.1"),
  CORS_ORIGIN: z.string().default("http://10.6.22.1:5174"),
  AUTH_TOKEN: z.string().min(8).default("change-me-local-only"),
  LLM_API_BASE: z.string().url().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default("gpt-5.5"),
  SENTAURUS_SSH_TARGET: z.string().default("sentaurus-centos7"),
  SENTAURUS_REMOTE_BASE: z.string().default("/home/TCAD2022/STDB/web-agent-runs"),
  LOCAL_RUN_BASE: z.string().default("./data/runs"),
  MAX_UPLOAD_MB: z.coerce.number().int().positive().default(200),
  ENABLE_REAL_JOBS: z.coerce.number().int().min(0).max(1).default(0)
});

const parsed = schema.parse(process.env);

if (parsed.HOST === "0.0.0.0" && parsed.AUTH_TOKEN === "change-me-local-only") {
  throw new Error("Refusing to listen on 0.0.0.0 with the default AUTH_TOKEN. Set a strong token in .env first.");
}

if (parsed.HOST === "0.0.0.0" && parsed.AUTH_TOKEN.length < 24) {
  throw new Error("AUTH_TOKEN must be at least 24 characters when HOST=0.0.0.0.");
}

export const config = {
  ...parsed,
  LOCAL_RUN_BASE_ABS: path.resolve(process.cwd(), parsed.LOCAL_RUN_BASE),
  realJobsEnabled: parsed.ENABLE_REAL_JOBS === 1
};
